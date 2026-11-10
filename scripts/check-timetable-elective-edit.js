#!/usr/bin/env node
/**
 * 门禁：课表页「已添加的个人选修课」必须点得开、能编辑（2026-11-11 用户报障）
 * ============================================================================
 * 用户原话：「课程表页添加选修课，点击添加的选修课无法修改」。
 *
 * 根因（2026-11-11 定位）：`pages/timetable/index.js` 的 `_build()` 在把课程塞进
 * 网格时**逐字段重建** course 对象，把 `_personalToCell()` 构造好的 `personal/pid/mine`
 * 三个身份字段整个丢掉，还把 `key` 改写成 `c.sessionId`（选修课恒为 0）、
 * 用 `courseColor()` 覆盖了选修课专属配色。于是 WXML 里：
 *     data-personal=""  data-pid=""  data-sid="0"
 * `onCell` 的 personal 分支进不去，`sid=0` 又命中「空格子静默 return」⇒ 点了没反应。
 * 编辑/删除选修课的函数（_openElectiveForm / _saveElective / onDeleteElective）其实全写好了，
 * 只是永远调用不到。
 *
 * 本门禁做**端到端仿真**（不是纯文本匹配）：
 *   ① 用真实 VM 桩加载课表页，把一门 personal 课喂进真实 `_build()`；
 *   ② 按 WXML 的 `data-*` 绑定规则，从 `_build` 产出的 co 构造 dataset；
 *   ③ 把 dataset 喂给真实 `onCell()`，断言它打开了「编辑选修课」表单。
 * 修复前第 ③ 步必然静默 return（opened === null）⇒ 精确复现用户症状。
 *
 * 附带守住：`_ensureDuties` 拉完值日名单重建网格时必须再 merge 一次选修课，
 * 否则点开任一普通课详情后选修课会整片消失（同一根因的第二条路径）。
 *
 * 变异自证：在**内存副本**上把身份透传抠掉，判据必须翻红（绝不写盘）。
 * 用法：node scripts/check-timetable-elective-edit.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const JS_PATH = path.resolve(ROOT, 'pages/timetable/index.js');
const WXML = fs.readFileSync(path.resolve(ROOT, 'pages/timetable/index.wxml'), 'utf8');

let pass = 0;
let fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}

/* ------------------------------------------------------------------
 * 真实页面加载桩（同 check-pages-runtime / check-timetable-group-geometry）
 * overrides 允许把某个文件替换成变异后的内存文本，用于变异自证。
 * ---------------------------------------------------------------- */
function loadPage(overrides) {
  overrides = overrides || {};
  const storage = {};
  const wxStub = {
    getStorageSync: k => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: k => { delete storage[k]; },
    getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375, windowHeight: 812, screenHeight: 812, safeArea: { bottom: 812 } }),
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, statusBarHeight: 20 }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, height: 32, right: 320, width: 87, bottom: 80, left: 233 }),
    showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
    setClipboardData: () => {},
    cloud: { init: () => {}, callFunction: () => ({}) },
    switchTab: () => {}, navigateTo: () => {}, reLaunch: () => {}, redirectTo: () => {},
    request: () => {}, setNavigationBarTitle: () => {}, canIUse: () => true,
    createSelectorQuery: () => ({
      select: () => ({ boundingClientRect: cb => cb && cb(null), fields: () => ({ exec: cb => cb && cb([]) }) }),
      in: () => ({ select: () => ({ boundingClientRect: cb => cb && cb(null), fields: () => ({ exec: cb => cb && cb([]) }) }) }),
      exec: () => {}
    })
  };
  const appStub = {
    globalData: {
      envId: 'x', statusBarHeight: 20, navBarHeight: 44, tabBarHeight: 50, safeBottom: 0,
      windowWidth: 375, windowHeight: 812, openid: '', bound: true,
      profile: { id: 13, name: 'tester', role: 'ADMIN', isSuper: true, groupTag: 'A' },
      config: { termStart: '2026-09-14', totalWeeks: 18, currentWeek: 9, periodTime: [] },
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
    const code = overrides[abs] !== undefined ? overrides[abs] : fs.readFileSync(abs, 'utf8');
    const exportsObj = {};
    const sandboxRequire = (rel) => {
      if (typeof rel !== 'string') return {};
      const base = path.resolve(path.dirname(abs), rel);
      const cands = [base, base + '.js', path.join(base, 'index.js')];
      for (const c of cands) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return loadModule(c);
      }
      return {};
    };
    const sandbox = {
      module: { exports: exportsObj }, exports: exportsObj, require: sandboxRequire,
      wx: wxStub, getApp: () => appStub,
      Page: (o) => {
        const p = Object.assign({}, o);
        p.setData = makeSetData(p);
        p.getTabBar = () => ({ setData: () => {} });
        p.selectComponent = () => null;
        p.createSelectorQuery = wxStub.createSelectorQuery;
        pageRegistry.set(abs, p);
        return p;
      },
      Component: o => o, Behavior: o => o,
      getCurrentPages: () => [], console, setTimeout, clearTimeout, Promise, Date, Math,
      JSON, Set, Map, Number, String, Object, Array, Boolean, Error
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    try { vm.runInContext(code, sandbox, { filename: abs }); }
    catch (e) { console.log('  [模块执行异常] ' + path.relative(ROOT, abs) + ' → ' + e.message); }
    modules.set(abs, sandbox.module.exports);
    return sandbox.module.exports;
  }
  loadModule(JS_PATH);
  const page = pageRegistry.get(JS_PATH);
  if (!page) return null;
  Object.assign(page.data, {
    termStart: '2026-09-14', week: 9, totalWeeks: 18, viewGroup: 'ALL',
    periods: [{ p: 1 }, { p: 2 }, { p: 3 }, { p: 4 }, { p: 5 }]
  });
  page._holidays = [];
  page._shifts = [];
  page._offDays = [];
  page._dutyMap = {};
  page._courses = [];
  page._personal = [];
  page.createSelectorQuery = wxStub.createSelectorQuery;
  return page;
}

/* ------------------------------------------------------------------
 * 合成一门个人选修课：身份字段用哨兵值，避免依赖具体配色常量
 * ---------------------------------------------------------------- */
const SENTINEL_BG = 'SENTINEL_PERSONAL_BG';
const SENTINEL_FG = 'SENTINEL_PERSONAL_FG';
function personalCourse() {
  return {
    key: 'p7', sessionId: 0, pid: 7,
    name: '摄影赏析', room: '艺术楼 301', teacher: '李老师',
    weekRule: 'ALL', weeks: '', weekText: '每周',
    groupScope: null, dutyCount: 0, duties: [],
    classDate: '', shifted: false, isHoliday: false, holidayName: '',
    movedOut: false, movedIn: false, shiftToText: '', shiftFromText: '',
    dowText: '周一', dayOfWeek: 1, period: 4,
    bg: SENTINEL_BG, fg: SENTINEL_FG, flip: '',
    personal: true, mine: true
  };
}

/** 完整仿真：_build 产出 co → 按 WXML 绑定构造 dataset → onCell */
function simulate(jsText) {
  const page = loadPage(jsText ? { [JS_PATH]: jsText } : null);
  if (!page) return { err: 'page not loaded' };
  page._personal = [{ id: 7, name: '摄影赏析', room: '艺术楼 301', teacher: '李老师', dayOfWeek: 1, period: 4, weeks: '' }];
  let opened = null;
  page._openElectiveForm = (p) => { opened = p; };
  page._ensureDuties = () => {};
  try { page._build([personalCourse()], false); }
  catch (e) { return { err: e.message }; }
  const grid = page.data.grid || [];
  let co = null;
  grid.forEach(row => (row || []).forEach(cell => (cell.courses || []).forEach(x => {
    if (x.name === '摄影赏析') co = x;
  })));
  if (!co) return { err: 'personal course not rendered', grid };
  // 严格照抄 index.wxml 的 data-* 绑定表达式
  const dataset = {
    r: 3, c: 0,
    sid: co.sessionId,
    personal: co.personal ? 1 : '',
    pid: co.personal ? co.pid : ''
  };
  try { page.onCell({ currentTarget: { dataset } }); }
  catch (e) { return { err: 'onCell threw: ' + e.message, co, dataset }; }
  return { co, dataset, opened };
}

const JS = fs.readFileSync(JS_PATH, 'utf8');

console.log('\n【1】WXML 绑定契约（选修课身份必须能传到事件）');
ok(/data-personal="\{\{co\.personal \? 1 : ''\}\}"/.test(WXML), '格子上有 data-personal 绑定');
ok(/data-pid="\{\{co\.personal \? co\.pid : ''\}\}"/.test(WXML), '格子上有 data-pid 绑定');
ok(/data-sid="\{\{co\.sessionId\}\}"/.test(WXML), '格子上有 data-sid 绑定');
ok(/bindtap="onCell"/.test(WXML), '格子点击仍走 onCell');

console.log('\n【2】端到端仿真：_build 透传身份 → onCell 打开编辑表单');
{
  const r = simulate();
  ok(!r.err, '仿真链路跑通（无异常）', r.err);
  if (!r.err) {
    ok(r.co.personal === true, '_build 保留了 co.personal（否则 WXML 渲染出空 data-personal）', r.co.personal);
    ok(Number(r.co.pid) === 7, '_build 保留了 co.pid', r.co.pid);
    ok(r.co.key === 'p7', "wx:key 用 'p'+pid（多门选修课不撞 key）", r.co.key);
    ok(r.co.bg === SENTINEL_BG && r.co.fg === SENTINEL_FG,
      '选修课专属配色未被 courseColor() 覆盖', { bg: r.co.bg, fg: r.co.fg });
    ok(r.co.mine === true, '_build 保留了 co.mine', r.co.mine);
    ok(r.dataset.personal === 1 && Number(r.dataset.pid) === 7,
      '按 WXML 绑定算出的 dataset 带 personal/pid', r.dataset);
    ok(!!r.opened && Number(r.opened.id) === 7,
      '点击选修课 ⇒ onCell 打开「编辑选修课」表单（用户症状：修复前 opened=null）',
      r.opened);
  }
}

console.log('\n【3】_ensureDuties 拉完值日名单后不得抹掉选修课');
{
  // 取方法体：从方法名到配平右花括号
  const def = /^  _ensureDuties\(/m.exec(JS);
  let src = '';
  if (def) {
    let i = JS.indexOf('{', def.index), d = 0;
    for (let j = i; j < JS.length; j++) {
      if (JS[j] === '{') d++;
      else if (JS[j] === '}') { d--; if (d === 0) { src = JS.slice(def.index, j + 1); break; } }
    }
  }
  ok(src.length > 50, '抽得到 _ensureDuties 方法体');
  ok(/this\._build\(this\._mergePersonal\(tt\.sessionsOfWeek\(wk\)\)\)/.test(src),
    '重建网格时先 _mergePersonal（否则点开普通课详情后选修课整片消失）',
    (src.match(/this\._build\([^\n]*/) || ['(未找到)'])[0]);
}

console.log('\n【4】变异自证（内存副本，不写盘）');
{
  // 变异 A：把 key 退回旧写法（丢掉选修课身份前缀）
  const mutA = JS.replace(
    /key: c\.personal \? \('p' \+ c\.pid\) : c\.sessionId/,
    'key: c.sessionId');
  ok(mutA !== JS, '变异 A 锚点命中源码（锚点漂移 ⇒ 自证是假绿）');
  const rA = simulate(mutA);
  ok(!rA.err && rA.co.key !== 'p7', "变异 A：key 退回 c.sessionId ⇒ 'p7' 判据翻红", rA.err || (rA.co && rA.co.key));

  // 变异 B：把选修课配色覆盖回去
  const mutB = JS.replace(/bg: c\.personal \? c\.bg : col\.bg/, 'bg: col.bg');
  ok(mutB !== JS, '变异 B 锚点命中源码');
  const rB = simulate(mutB);
  ok(!rB.err && rB.co.bg !== SENTINEL_BG, '变异 B：配色被 courseColor 覆盖 ⇒ 配色判据翻红', rB.err || (rB.co && rB.co.bg));

  // 变异 C：整段身份透传抠掉（模拟最初的事故形态：逐字段重建）
  const mutC = JS.replace(/cell\.courses\.push\(Object\.assign\(\{\}, c, \{/,
    'cell.courses.push(Object.assign({}, {');
  if (mutC !== JS) {
    const rC = simulate(mutC);
    ok(rC.err || !rC.co || rC.co.personal !== true || !rC.opened,
      '变异 C：身份字段整体丢失 ⇒ 点击再次无响应（端到端判据翻红）', rC.err || (rC.co && rC.co.personal));
  } else {
    // 若修复采用「显式补字段」而非 Object.assign，用补字段行做变异
    const mutC2 = JS.replace(/personal: !!c\.personal,/, 'personal: false,');
    ok(mutC2 !== JS, '变异 C 备用锚点命中源码');
    const rC2 = simulate(mutC2);
    ok(!rC2.err && !rC2.opened, '变异 C：personal 恒 false ⇒ 点击再次无响应（端到端判据翻红）', rC2.err);
  }
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 败');
process.exit(fail ? 1 : 0);
