/**
 * 回归门禁：切换 A/B 组时，课表网格几何（列数 / 横向滚动提示）与黄色提醒条文案必须稳定。
 *
 * 背景（2026-10-10 报障）：普通成员切 A/B 组时，「下面的黄色提醒位置不一样」。
 * 根因在 pages/timetable/index.js 的 _build：hasWeekend / wkCourses 之前用「已按 viewGroup
 * 过滤的 visible」判定，当某一组有周末（周六/日）课、另一组没有时，切换 A/B 会让网格在
 * 5↔7 列跳变、横向滚动提示忽隐忽现，连带把黄条顶上顶下。修复：这两个判定改回「整周全部
 * 课次 courses」，与 onMenuGroup 的 FLIP 设计（换组只改哪些格子有内容、不改行列几何）一致。
 *
 * 本门禁直接调用真实 _build（离线桩跑页面），断言：
 *   ① 某一组有周末课、另一组没有时，A 视图与 B 视图的 showScrollHint / dateWidth 必须相等
 *      （几何稳定；回退成 visible.some 会令 B 视图 showScrollHint=false 而 A=true → 判死）；
 *   ② A 视图含 A 的周末课、不含 B 的课；B 视图反之（分组过滤仍生效）；
 *   ③ 两视图的 tip 文案必须相等（wkCourses 也改回 courses 口径，避免黄条高度随组跳动）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'miniprogram');

/* ---------- wx / App / Page 桩（与 check-pages-runtime.js 同款） ---------- */
const storage = {};
const wxStub = {
  getStorageSync: k => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: k => { delete storage[k]; },
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 812, screenHeight: 812, safeArea: { bottom: 812 } }),
  getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, right: 320, width: 87, bottom: 80, left: 233 }),
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  setClipboardData: () => {},
  cloud: { init: () => {}, callFunction: () => ({}) },
  switchTab: () => {}, navigateTo: () => {}, reLaunch: () => {}, redirectTo: () => {},
  request: () => {}, setNavigationBarTitle: () => {},
  createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: cb => cb && cb([]) }) }), in: () => ({ select: () => ({ fields: () => ({ exec: cb => cb && cb([]) }) }) }) }),
  canIUse: () => true
};
const appStub = {
  globalData: {
    envId: 'x', statusBarHeight: 20, navBarHeight: 44, tabBarHeight: 50, safeBottom: 0,
    windowWidth: 375, windowHeight: 812,
    openid: '', bound: true,
    profile: { id: 13, name: '示例成员01', role: 'ADMIN', isSuper: true, groupTag: 'A' },
    config: { termStart: '2026-09-14', totalWeeks: 16, currentWeek: 2, periodTime: [] },
    authChecked: true
  },
  isAdmin: () => true, isSuper: () => true,
  ready: () => Promise.resolve(appStub.globalData),
  refreshAuth: () => Promise.resolve(appStub.globalData),
  setTabBar: () => {}
};

const modules = new Map();
const pageRegistry = new Map();
function makeSetData(obj) {
  obj.data = obj.data || {};
  return function (patch, cb) { Object.assign(obj.data, patch); if (cb) cb(); };
}
function loadModule(file) {
  const abs = path.resolve(file);
  if (modules.has(abs)) return modules.get(abs);
  const code = fs.readFileSync(abs, 'utf8');
  const exportsObj = {};
  const sandboxRequire = (rel) => {
    if (typeof rel !== 'string') return {};
    const base = path.resolve(path.dirname(abs), rel);
    const cands = [base, base + '.js', path.join(base, 'index.js')];
    for (const c of cands) { if (fs.existsSync(c) && fs.statSync(c).isFile()) return loadModule(c); }
    return {};
  };
  const sandbox = {
    module: { exports: exportsObj }, exports: exportsObj, require: sandboxRequire,
    wx: wxStub, getApp: () => appStub,
    Page: (o) => { const p = Object.assign({}, o); p.setData = makeSetData(p); p.getTabBar = () => ({ setData: () => {} }); p.selectComponent = () => null; pageRegistry.set(abs, p); return p; },
    Component: o => o, Behavior: o => o,
    getCurrentPages: () => [], console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Number, String, Object, Array, Boolean, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(code, sandbox, { filename: abs }); }
  catch (e) { console.log('  [模块执行异常] ' + path.relative(ROOT, abs) + ' → ' + e.message); }
  modules.set(abs, sandbox.module.exports);
  return sandbox.module.exports;
}

/* ---------- 加载课表页 ---------- */
const ttFile = path.resolve(ROOT, 'pages/timetable/index.js');
loadModule(ttFile);
const page = pageRegistry.get(ttFile);
if (!page) { console.log('✗ 未拿到课表页实例'); process.exit(1); }

/* 先跑一次 load() 把 _holidays / _shifts / termStart / week 等基础数据备好 */
page.data = Object.assign({}, page.data || {}, { termStart: '2026-09-14', week: 2, totalWeeks: 16, viewGroup: 'A' });
page.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: cb => cb && cb(null) }), exec: () => {} });
try { page.load(); } catch (e) { console.log('✗ load() 抛错: ' + e.message); process.exit(1); }

/* ---------- 构造合成课次 ---------- */
// 全体工作日课 + A 组周六课 + B 组仅工作日课（制造「A 有周末课、B 没有」的不对称）
function mk(o) {
  return {
    sessionId: o.id, name: o.name || '课', room: 'R', teacher: 'T',
    weekRule: '', weeks: '', groupScope: o.group || null, dutyCount: 2,
    classDate: '2026-09-21', shifted: false, isHoliday: false, holidayName: '',
    movedOut: false, movedIn: false, shiftToText: '', shiftFromText: '',
    dayOfWeek: o.day, period: o.period, courseId: o.id
  };
}
const courses = [
  mk({ id: 1, name: '全体1', day: 1, period: 1, group: null }),
  mk({ id: 2, name: 'A周六', day: 6, period: 1, group: 'A' }),   // 仅 A 组有周末课
  mk({ id: 3, name: 'B工三', day: 3, period: 2, group: 'B' })    // B 组只有工作日课
];

function gridHas(page, sid) {
  return (page.data.grid || []).some(row => (row || []).some(c => (c.courses || []).some(co => Number(co.sessionId) === sid)));
}
function buildFor(group) {
  page.data.viewGroup = group;
  page._build(courses.slice(), false);   // 非动画路径，直接落地 setData
  return {
    showScrollHint: page.data.showScrollHint,
    dateWidth: page.data.dateWidth,
    cols: page.data.dates.length,
    tip: page.data.tip,
    hasA: gridHas(page, 2),
    hasB: gridHas(page, 3),
    hasAll: gridHas(page, 1)
  };
}

/* ---------- 断言 ---------- */
let bad = 0;
const ok = (cond, msg) => { if (cond) console.log('  PASS  ' + msg); else { console.log('  ✗  ' + msg); bad++; } };

const A = buildFor('A');
const B = buildFor('B');

console.log('── 场景：A 组有周六课、B 组无周末课');
ok(A.showScrollHint === B.showScrollHint, '切换 A/B 时 showScrollHint 一致（A=' + A.showScrollHint + ' / B=' + B.showScrollHint + '）');
ok(A.dateWidth === B.dateWidth, '切换 A/B 时 dateWidth 一致（A=' + A.dateWidth + ' / B=' + B.dateWidth + '）');
ok(A.cols === B.cols, '切换 A/B 时显示列数一致（A=' + A.cols + ' / B=' + B.cols + '）');
ok(A.tip === B.tip, '切换 A/B 时黄条文案一致');
ok(A.hasA && !A.hasB, 'A 视图含 A 周六课、不含 B 课');
ok(B.hasB && !B.hasA, 'B 视图含 B 课、不含 A 周六课');
ok(A.hasAll && B.hasAll, '两视图都含全体课');
ok(A.cols === 7 && A.showScrollHint === true, 'A 有周末课时整周显示 7 列 + 滚动提示（几何稳定锚点）');

/* 控制场景：整周没有任何周末课时，A/B 都应是 5 列、无滚动提示（稳定，且不为假绿） */
const noWeekend = [
  mk({ id: 11, name: '全体1', day: 1, period: 1, group: null }),
  mk({ id: 12, name: 'A工二', day: 2, period: 1, group: 'A' }),
  mk({ id: 13, name: 'B工三', day: 3, period: 1, group: 'B' })
];
const NA = (() => { page.data.viewGroup = 'A'; page._build(noWeekend.slice(), false); return { cols: page.data.dates.length, s: page.data.showScrollHint }; })();
const NB = (() => { page.data.viewGroup = 'B'; page._build(noWeekend.slice(), false); return { cols: page.data.dates.length, s: page.data.showScrollHint }; })();
console.log('── 控制场景：整周无周末课');
ok(NA.cols === 5 && NA.s === false && NB.cols === 5 && NB.s === false, '无周末课时 A/B 均为 5 列、无滚动提示');

if (bad) { console.log('\n✗ 未通过 ' + bad + ' 项'); process.exit(1); }
console.log('\n全部通过 ✅');
