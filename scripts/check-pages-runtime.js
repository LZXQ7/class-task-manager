/**
 * 离线仿真：把 6 个页面的 onLoad / onShow 跑一遍，抓运行时异常。
 * 目的：用户反馈「无法切换其他页面」，先确认是不是某页 onShow 抛错导致界面卡死。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'miniprogram');

/**
 * 离线环境没有后端，任何真实请求都不会有回调。这里把「意外的 Promise 没有 catch」
 * 降级成一行警告 —— 否则 request.js 里被忽略的 rejected promise 会变成
 * unhandledRejection，让整个自检脚本以非零码崩掉，掩盖真正的页面异常。
 */
process.on('unhandledRejection', (e) => {
  console.log('  [未捕获的 Promise 拒绝，已忽略] ' + ((e && e.message) || e));
});

/* ---------- wx 桩 ---------- */
const storage = {};
const wxStub = {
  getStorageSync: k => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: k => { delete storage[k]; },
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 812, screenHeight: 812, safeArea: { bottom: 812 } }),
  getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, right: 320, width: 87, bottom: 80, left: 233 }),
  showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
  setClipboardData: () => {},
  // 返回一个「不带 then 的对象」：request.js 只挂 success/fail 回调，
  // 既不会触发 success 也不会触发 fail，正合离线仿真的语义。
  cloud: { init: () => {}, callFunction: () => ({}) },
  switchTab: () => {}, navigateTo: () => {}, reLaunch: () => {}, redirectTo: () => {},
  request: () => {}, setNavigationBarTitle: () => {},
  createSelectorQuery: () => ({ select: () => ({ fields: () => ({ exec: cb => cb && cb([]) }) }), in: () => ({ select: () => ({ fields: () => ({ exec: cb => cb && cb([]) }) }) }) }),
  canIUse: () => true
};

/* ---------- 全局 App 桩 ---------- */
const appStub = {
  globalData: {
    envId: 'x', statusBarHeight: 20, navBarHeight: 44, tabBarHeight: 50, safeBottom: 0,
    windowWidth: 375, windowHeight: 812,
    openid: '', bound: true,
    profile: { id: 13, name: '示例成员01', role: 'ADMIN', isSuper: true, groupTag: 'A' },
    config: { termStart: '2026-09-14', totalWeeks: 16, currentWeek: 2, periodTime: [] },
    authChecked: true
  },
  isAdmin: () => true,
  isSuper: () => true,
  ready: () => Promise.resolve(appStub.globalData),
  refreshAuth: () => Promise.resolve(appStub.globalData),
  setTabBar: () => {}
};

/* ---------- 简易 Page / Component / getApp ---------- */
let currentPage = null;
const modules = new Map();

function makeSetData(obj) {
  obj.data = obj.data || {};
  return function (patch, cb) {
    Object.assign(obj.data, patch);
    if (cb) cb();
  };
}

/* Page(opts) 本身不导出，用注册表把 opts 抓出来 */
const pageRegistry = new Map();
function Page(opts) {
  const p = Object.assign({}, opts);
  p.setData = makeSetData(p);
  p.getTabBar = () => ({ setData: () => {} });
  p.selectComponent = () => null;
  p.__page = true;
  return p;
}
function Component(opts) { return opts; }
function Behavior(o) { return o; }

function loadModule(file) {
  const abs = path.resolve(file);
  if (modules.has(abs)) return modules.get(abs);
  const code = fs.readFileSync(abs, 'utf8');
  const exportsObj = {};
  const sandboxRequire = (rel) => {
    if (typeof rel !== 'string') return {};
    let base = path.resolve(path.dirname(abs), rel);
    const cands = [base, base + '.js', path.join(base, 'index.js')];
    for (const c of cands) { if (fs.existsSync(c) && fs.statSync(c).isFile()) return loadModule(c); }
    return {};
  };
  const sandbox = {
    module: { exports: exportsObj }, exports: exportsObj, require: sandboxRequire,
    wx: wxStub, getApp: () => appStub,
    Page: (o) => { const p = Page(o); pageRegistry.set(abs, p); return p; },
    Component, Behavior,
    getCurrentPages: () => (currentPage ? [currentPage] : []),
    console, setTimeout, clearTimeout, Promise, Date, Math, JSON, Set, Map, Number, String, Object, Array, Boolean, Error
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  try { vm.runInContext(code, sandbox, { filename: abs }); }
  catch (e) { console.log('  [模块执行异常] ' + path.relative(ROOT, abs) + ' → ' + e.message); }
  modules.set(abs, sandbox.module.exports);
  return sandbox.module.exports;
}

const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pages = app.pages || [];
let bad = 0;
pages.forEach(p => {
  const file = path.join(ROOT, p + '.js');
  console.log('── ' + p);
  let mod;
  try { loadModule(file); } catch (e) { console.log('  require 失败: ' + e.message); bad++; return; }
  const inst = pageRegistry.get(path.resolve(file));
  if (!inst) { console.log('  (未注册 Page，跳过生命周期)'); return; }
  currentPage = inst;
  ['onLoad', 'onShow', 'onReady', 'onHide', 'onUnload'].forEach(hook => {
    if (typeof inst[hook] !== 'function') return;
    try { inst[hook]({}); }
    catch (e) { console.log('  ✗ ' + hook + ' 抛错: ' + e.message); bad++; }
  });
  // 关键渲染字段
  const d = inst.data || {};
  const keys = Object.keys(d).filter(k => /grid|days|loading|failed|list|members|cards|courses/.test(k));
  console.log('  data 关键字段: ' + keys.map(k => k + '=' + (Array.isArray(d[k]) ? '[' + d[k].length + ']' : JSON.stringify(d[k]))).join(', ').slice(0, 200));
});

/* ---------- 课表网格：5 行（节次）× N 列（动态，默认周一 ~ 周五） ----------
 * §43：列数不再固定 7 —— 周末没课只显示周一~周五（并铺满屏宽），
 * 周末有课（含调课调入）才补上周六 / 周日。列宽由 JS 按显示天数算出、列用 flex 等分。
 * 这里校验「行数恒为 5、每行列数与表头一致、dow 与表头对齐、dateWidth = 列数 × colW」，
 * 免得以后表头与格子错位、或 dateWidth 与列宽脱钩。 */
console.log('── 课表网格动态列校验（第 1–16 周）');
const ttFile = path.resolve(path.join(ROOT, 'pages/timetable/index.js'));
const ttInst = pageRegistry.get(ttFile);
if (!ttInst) {
  console.log('  ✗ 未拿到课表页实例');
  bad++;
} else {
  const DAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'];
  const badGrid = [];
  const colCounts = new Set();
  for (let wk = 1; wk <= 16; wk++) {
    ttInst.setData({ week: wk });
    ttInst.load();
    const d = ttInst.data;
    const cols = d.dates.length;
    colCounts.add(cols);
    if (cols !== 5 && cols !== 7) badGrid.push('第' + wk + '周 表头列数=' + cols + '（应为 5 或 7）');
    if (cols !== d.grid[0].length) badGrid.push('第' + wk + '周 表头列数(' + cols + ') 与首行列数(' + d.grid[0].length + ') 不一致');
    if (d.dateWidth !== cols * d.colW) badGrid.push('第' + wk + '周 dateWidth=' + d.dateWidth + ' 应为 ' + (cols * d.colW));
    if (d.showScrollHint !== (cols > 5)) badGrid.push('第' + wk + '周 showScrollHint 与列数不匹配');
    if (d.grid.length !== 5) badGrid.push('第' + wk + '周 行数=' + d.grid.length);
    d.grid.forEach((row, r) => {
      if (row.length !== cols) badGrid.push('第' + wk + '周 第' + (r + 1) + '行 列数=' + row.length);
      row.forEach((cell, c) => {
        // 一格多课：单元格本身带 dow/period，courses 里每节课再校验落位
        if (Number(cell.dow) !== Number(d.dates[c].dow)) badGrid.push('第' + wk + '周 r' + r + 'c' + c + ' 的 dow=' + cell.dow);
        if (Number(cell.period) !== r + 1) badGrid.push('第' + wk + '周 r' + r + 'c' + c + ' 的 period=' + cell.period);
        (cell.courses || []).forEach((co) => {
          if (Number(co.dayOfWeek) !== Number(d.dates[c].dow)) badGrid.push('第' + wk + '周 r' + r + 'c' + c + ' 课 dayOfWeek=' + co.dayOfWeek);
          if (Number(co.period) !== r + 1) badGrid.push('第' + wk + '周 r' + r + 'c' + c + ' 课 period=' + co.period);
        });
      });
    });
    // 表头 dow 必须与文案对齐（周一…周日），且按升序、不含周末或含全部周末
    d.dates.forEach((x, i) => {
      if (String(x.short) !== DAY_SHORT[x.dow - 1]) {
        badGrid.push('第' + wk + '周 表头第' + i + '列 文案=' + x.short);
      }
      if (i > 0 && Number(d.dates[i - 1].dow) >= Number(x.dow)) {
        badGrid.push('第' + wk + '周 表头 dow 非升序 @' + i);
      }
    });
  }
  if (badGrid.length) { badGrid.slice(0, 8).forEach(x => console.log('  ✗ ' + x)); bad++; }
  else console.log('  ✓ 16 周 × 5 行，列数 ∈ {' + Array.from(colCounts).join(',') + '}，dow/文案/dateWidth 全部对齐');
}

console.log('\n结果：' + (bad === 0 ? '全部页面生命周期无异常' : bad + ' 处异常'));
process.exitCode = bad === 0 ? 0 : 1;
