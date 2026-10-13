/**
 * 回归门禁：值日页（Tab 3）周次必须与「当前周」同步，否则「已结束」入口经常失效、且默认显示第 1 周。
 *
 * 背景（2026-10-10 报障）：用户截图显示值日页「右上角的已结束经常失效（空白），须重启小程序才恢复；
 * 失效时进入值日页默认显示第 1 周而非当前周」。
 *
 * 根因：App.onLaunch 的 _bootstrap()（api.login）是异步的，globalData.config.currentWeek 要等网络
 * 回来才写入；而 Tab 页 onLoad 在它之前就跑了，于是 week/current 被兜底成 1，且只跑一次、onShow 从不
 * 重读 → 页面永久停在「week=1 而 current=真实周」。_paint 里 isCurrentWeek = (week===current) 恒为
 * false → pastDays=[] → 「已结束 N 天」入口（wxml: wx:if pastDays.length）整块消失；且显示的是第 1 周。
 *
 * 修复：新增 _syncWeek()，每次 onShow 把 current 纠回真实当前周；仅当未手动切周时把 week 也纠回当前周
 * 并强刷。本门禁直接调用真实 _syncWeek / _paint（离线桩跑页面），断言：
 *   ① config 未就绪时初始 week/current=1；config 就绪后 _syncWeek 把 week/current 纠回真实当前周，
 *      且（week===current 时）_paint 的 pastDays 非空 → 「已结束」正常显示；
 *   ② 用户手动切周后（_weekManual=true）_syncWeek 不强行拉回当前周，week 保留用户选择，current 仍纠正；
 *   ③ 配置就绪且 week 已等于当前周时，_syncWeek 返回 false（不会每次 onShow 都强刷）；
 *   ④ 静态断言 onShow 内含 this._syncWeek() 调用（防集成回归：有人把调用从 onShow 删掉）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'miniprogram');

/* ---------- wx / App / Page 桩（与 check-timetable-group-geometry.js 同款） ---------- */
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
    // config 由各场景动态注入：先置 null 模拟「onLoad 时登录未就绪」
    config: null,
    authChecked: true
  },
  isAdmin: () => true, isSuper: () => true, isCommittee: () => true,
  canSchedule: () => true, canRosterEdit: () => true, canGrantPosition: () => true, canLeave: () => true,
  ready: () => Promise.resolve(appStub.globalData),
  refreshAuth: () => Promise.resolve(appStub.globalData),
  recheckAuth: () => Promise.resolve(false),
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

/* ---------- 加载值日页 ---------- */
const dutyFile = path.resolve(ROOT, 'pages/duty/index.js');
loadModule(dutyFile);
const page = pageRegistry.get(dutyFile);
if (!page) { console.log('✗ 未拿到值日页实例'); process.exit(1); }
const util = require(path.resolve(ROOT, 'utils/util'));

/* 合成「早于今天 / 今天 / 晚于今天」三天的名单，用于验证 _paint 的 pastDays 折叠 */
function makeResponse() {
  const today = util.fmtDate(new Date());
  const past = util.fmtDate(new Date(Date.now() - 2 * 86400000));
  const future = util.fmtDate(new Date(Date.now() + 2 * 86400000));
  const day = (date) => ({ date, duties: [{ sessionId: 1, period: 1, kind: 'NORMAL', seq: 1, name: '学生', courseName: '课', room: 'R' }] });
  return { status: 'PUBLISHED', days: [day(past), day(today), day(future)] };
}

/* ---------- 断言 ---------- */
let bad = 0;
const ok = (cond, msg) => { if (cond) console.log('  PASS  ' + msg); else { console.log('  ✗  ' + msg); bad++; } };

/* 场景①：config 未就绪（onLoad 把 week/current 兜底成 1）→ config 就绪后 _syncWeek 必须纠回真实当前周，
 *         且（week===current 时）_paint 的 pastDays 非空 → 「已结束」正常显示。 */
console.log('── 场景①：onLoad 时 config 未就绪 → onShow 纠回真实当前周');
appStub.globalData.config = null;
page.data = Object.assign({}, page.data || {}, { week: 1, current: 1, totalWeeks: 18 });
page._weekManual = false;
ok(page.data.week === 1 && page.data.current === 1, 'config 未就绪时初始 week/current 均为 1（复现 bug 前态）');

appStub.globalData.config = { termStart: '2026-09-14', totalWeeks: 18, currentWeek: 4 };
const corrected = page._syncWeek();
ok(corrected === true, '_syncWeek 返回 true（week 被纠正，调用方应走 load(true) 强刷）');
ok(page.data.week === 4 && page.data.current === 4, '纠回后 week/current 均为真实当前周 4（不再停在第 1 周）');
ok(page.data.totalWeeks === 18, 'totalWeeks 同步为 config 的 18');

page._paint(makeResponse());
ok(page.data.pastDays.length === 1, 'week===current 时 pastDays 含「早于今天」的 1 天 → 「已结束」入口可见（修复点）');
ok(page.data.activeDays.length === 2, 'activeDays 仅含今天及以后 2 天');

/* 场景②：用户手动切周后（_weekManual=true），_syncWeek 不得强行拉回当前周，保留用户选择 */
console.log('── 场景②：用户手动切到其它周后，onShow 不应冲掉用户选择');
appStub.globalData.config = { termStart: '2026-09-14', totalWeeks: 18, currentWeek: 4 };
page.data = Object.assign({}, page.data || {}, { week: 2, current: 4, totalWeeks: 18 });
page._weekManual = true;   // 模拟用户手动切到「第 2 周」
const corrected2 = page._syncWeek();
ok(corrected2 === false, '_syncWeek 返回 false（未强刷）');
ok(page.data.week === 2, 'week 保留为用户选择的第 2 周（不被拉回 4）');
ok(page.data.current === 4, 'current 仍纠正为真实当前周 4（用于折叠判定）');
page._paint(makeResponse());
ok(page.data.pastDays.length === 0, '查看历史周(week=2≠current=4)时 pastDays 为空（历史周本就该全显示，符合预期）');

/* 场景③：config 就绪且 week 已等于当前周时，_syncWeek 返回 false（不会每次 onShow 都强刷闪烁） */
console.log('── 场景③：已停在真实当前周时，_syncWeek 不应产生多余强刷');
appStub.globalData.config = { termStart: '2026-09-14', totalWeeks: 18, currentWeek: 4 };
page.data = Object.assign({}, page.data || {}, { week: 4, current: 4, totalWeeks: 18 });
page._weekManual = false;
const corrected3 = page._syncWeek();
ok(corrected3 === false, '_syncWeek 返回 false（week 已=current，无需强刷）');
ok(page.data.week === 4, 'week 保持稳定为 4');

/* 场景④：静态断言 onShow 内含 this._syncWeek() 调用（防集成回归） */
console.log('── 场景④：onShow 必须调用 _syncWeek（防有人把修复从 onShow 删掉）');
const src = fs.readFileSync(dutyFile, 'utf8');
const onShowMatch = src.match(/onShow\s*\(\)\s*\{([\s\S]*?)\n  \},/);
const onShowBody = onShowMatch ? onShowMatch[1] : '';
ok(onShowBody.includes('this._syncWeek('), 'onShow 函数体内调用了 this._syncWeek()');

if (bad) { console.log('\n✗ 未通过 ' + bad + ' 项'); process.exit(1); }
console.log('\n全部通过 ✅');
