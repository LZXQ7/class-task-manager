#!/usr/bin/env node
/**
 * 门禁：班级下拉选择器（components/class-picker，2026-11-14）
 * ============================================================
 * 为什么要一道门禁：这个组件被班费 / 课表 / 值日 / 班级信息四个页面共用，
 * 它的错误形态全都是**静默**的 —— 写错了不报错，只是「点了没反应」「勾不显示」
 * 「切了班数据不更新」「展开位置不对」。静态正则看不出来，必须把组件定义真加载起来跑一遍。
 *
 * 锁住八件事：
 *   ① 选一个非当前项 → 收起 + 回填 + 抛 change（detail.id 是数字）
 *   ② 点当前项 → 仍收起，但**不抛** change（否则每个页面都会重复拉一次数据）
 *   ③ list 里 id 是字符串时也能正确回填 / 打勾（各页接口返回值类型不统一）
 *   ④ 空 list 点字段不展开（避免弹出一个空浮层）
 *   ⑤ 收起发生在抛事件之前（调用方 setData 不会把浮层又撑开）
 *   ⑥ 展开定位：列表以「当前选中项」为中心对齐字段；越界裁剪；长列表退化
 *      （纯函数 utils/class-picker-layout.js，逐项断言）
 *   ⑦ 四个使用页切班后都同步 value 真源 + 重新拉数（「相关内容同步更新」）
 *   ⑧ 组件真的调用定位函数并写回内联样式（防止「函数写了却没接上」）
 *
 * 末尾五组变异自证（内存字符串，绝不写盘）：
 *   · 「记住旧 curId」挪到 setData 之后 → ① 必须翻红（本轮真踩过这个 bug）
 *   · onPick 不再 triggerEvent → ① 必须翻红
 *   · 布局函数恒返回普通下拉 → ⑥ 必须翻红
 *   · onToggle 不调用 _openCentered → ⑧ 必须翻红
 *   · 删掉班费页的重新拉数 → ⑦ 必须翻红
 *
 * 用法：node scripts/check-class-picker.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'miniprogram/components/class-picker/index.js');
const WXML = path.join(ROOT, 'miniprogram/components/class-picker/index.wxml');
const LAYOUT_FILE = path.join(ROOT, 'miniprogram/utils/class-picker-layout.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const WXML_SRC = fs.readFileSync(WXML, 'utf8');
const LAYOUT_SRC = fs.readFileSync(LAYOUT_FILE, 'utf8');

/** 四个使用页：handler / 刷新调用 / value 真源同步语句（用于静态核对） */
const PAGES = [
  { key: 'fee', dir: 'pages/fee', handler: 'onFeeClassPick',
    refresh: 'this._loadFee(true);', sync: 'feeViewClassId: id', bodySync: 'feeViewClassId: id' },
  { key: 'timetable', dir: 'pages/timetable', handler: 'onTimetableClass',
    refresh: 'this._afterClassPicked();', sync: 'viewClassId: id', bodySync: 'viewClassId: id' },
  { key: 'duty', dir: 'pages/duty', handler: 'onDutyClass',
    refresh: 'this.load(true);', sync: 'viewClassId: id', bodySync: 'viewClassId: id' },
  /* 信息页的 setData 在 _applyClass 里（handler 只是转调），故 bodySync 留空、只查全文 */
  { key: 'classinfo', dir: 'pages/classinfo', handler: 'onClassPick',
    refresh: 'this._applyClass(id);', sync: 'viewClassId: Number(id) || 0', bodySync: '' }
];

/**
 * 取页面某个 change handler 的方法体。
 * ⚠️ 必须在**方法体内**查「重新拉数」，不能在全文查：同一个页面里 `_loadFee(true)`
 *    有 7 处，删掉 handler 里那一处后全文仍命中 → 静态断言会假绿（本轮变异自证实测）。
 */
function methodBody(js, name) {
  const start = js.indexOf(name + '(e)');
  if (start < 0) return '';
  const end = js.indexOf('\n  },', start);
  return end < 0 ? js.slice(start) : js.slice(start, end);
}

function readPages() {
  const out = {};
  for (const p of PAGES) {
    out[p.key] = {
      wxml: fs.readFileSync(path.join(ROOT, 'miniprogram', p.dir, 'index.wxml'), 'utf8'),
      js: fs.readFileSync(path.join(ROOT, 'miniprogram', p.dir, 'index.js'), 'utf8')
    };
  }
  return out;
}

/** 从源码里加载布局纯函数（变异自证时传改坏后的源码） */
function loadLayout(src) {
  const mod = { exports: {} };
  /* eslint-disable no-new-func */
  new Function('module', 'exports', src)(mod, mod.exports);
  if (typeof mod.exports.layoutPop !== 'function') throw new Error('布局模块没有导出 layoutPop');
  return mod.exports.layoutPop;
}

/** 用一份组件源码构造可调用的实例（Component 只取定义，不依赖小程序运行时） */
function makeInst(src, props, layoutFn) {
  let captured = null;
  /* 组件顶部的 require 走桩：Node 里没有小程序模块解析，也不该去读磁盘副本 */
  const fakeRequire = () => ({ layoutPop: layoutFn });
  /* eslint-disable no-new-func */
  new Function('Component', 'require', src)((obj) => { captured = obj; }, fakeRequire);
  if (!captured) throw new Error('组件源码没有调用 Component()');
  const events = [];
  const inst = Object.assign({}, captured.methods);
  inst.data = Object.assign({}, JSON.parse(JSON.stringify(captured.data)), props || {});
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  inst.triggerEvent = function (name, detail) { events.push({ name, detail }); };
  return { inst, events };
}

function runAll(src, layoutFn, pages, wxmlSrc, quiet) {
  const probs = [];
  let checks = 0;
  const ok = (cond, msg) => {
    checks += 1;
    if (!cond) probs.push(msg); else if (!quiet) console.log('  ✓ ' + msg);
  };

  const LIST = [
    { id: 3, name: '示例专业A1班' },
    { id: 1, name: '示例专业B1班' },
    { id: 9, name: '商务示例专业B2班' }
  ];

  // ① 选非当前项
  {
    const { inst, events } = makeInst(src, { list: LIST, value: 3 }, layoutFn);
    inst._sync();
    inst.setData({ open: true });
    inst.onPick({ currentTarget: { dataset: { id: 1 } } });
    ok(inst.data.open === false, '① 选完自动收起浮层');
    ok(inst.data.curName === '示例专业B1班', '① 字段回填成新班名');
    ok(inst.data.curId === 1, '① curId 跟着更新（勾会移到新项）');
    ok(events.length === 1 && events[0].name === 'change', '① 抛出 change 事件');
    ok(events[0] && events[0].detail && events[0].detail.id === 1, '① detail.id 是数字 1（不是字符串）');
  }

  // ② 点当前项
  {
    const { inst, events } = makeInst(src, { list: LIST, value: 3 }, layoutFn);
    inst._sync();
    inst.setData({ open: true });
    inst.onPick({ currentTarget: { dataset: { id: 3 } } });
    ok(inst.data.open === false, '② 点当前项也收起（用户点它是「确认」）');
    ok(events.length === 0, '② 点当前项不抛 change（否则每页重复拉一次数据）');
  }

  // ③ 字符串 id
  {
    const strList = [{ id: '3', name: 'A班' }, { id: '7', name: 'B班' }];
    const { inst, events } = makeInst(src, { list: strList, value: '3' }, layoutFn);
    inst._sync();
    ok(inst.data.curName === 'A班', '③ 字符串 id 也能回填（=== 比对不会因类型丢失）');
    ok(inst.data.curId === 3, '③ curId 规范化为数字');
    ok(inst.data.curIndex === 0, '③ curIndex 落在第 1 项（展开定位的锚点）');
    inst.onPick({ currentTarget: { dataset: { id: '7' } } });
    ok(events.length === 1 && events[0].detail.id === 7, '③ 字符串 id 选中后抛数字 7');
  }

  // ④ 空列表
  {
    const { inst } = makeInst(src, { list: [], value: 0 }, layoutFn);
    inst._sync();
    inst.onToggle();
    ok(inst.data.open === false, '④ 空 list 点字段不展开（不弹空浮层）');
  }

  // ⑤ 收起先于抛事件
  {
    const { inst } = makeInst(src, { list: LIST, value: 3 }, layoutFn);
    inst._sync();
    inst.setData({ open: true });
    let openWhenFired = null;
    const orig = inst.triggerEvent;
    inst.triggerEvent = function (n, d) { openWhenFired = inst.data.open; orig.call(inst, n, d); };
    inst.onPick({ currentTarget: { dataset: { id: 9 } } });
    ok(openWhenFired === false, '⑤ 抛事件时浮层已经收起（调用方 setData 不会把它撑开）');
  }

  // ⑥ 展开定位：以当前选中项为中心
  {
    const scale = 375 / 750;
    const base = { fieldTop: 300, fieldH: 60, winW: 375, winH: 800, count: 5, safeTop: 88, safeBottom: 16 };
    const r0 = layoutFn(Object.assign({}, base, { index: 0 }));
    const r2 = layoutFn(Object.assign({}, base, { index: 2 }));
    const r4 = layoutFn(Object.assign({}, base, { index: 4 }));
    ok(r0.centered === true && Math.abs(r0.centerOffset) <= 0.1, '⑥ 选中第 1 项：选中项中心与字段中心重合');
    ok(r2.centered === true && Math.abs(r2.centerOffset) <= 0.1, '⑥ 选中第 3 项：仍然精确居中');
    ok(r4.centered === true && Math.abs(r4.centerOffset) <= 0.1, '⑥ 选中第 5 项：仍然精确居中');
    ok(r2.top < r0.top && r4.top < r2.top, '⑥ 选中项越靠后，浮层越向上展开（列表围绕选中项）');
    ok(r0.top < 60 / scale + 10, '⑥ 不再是「整块从字段下方往下掉」的老位置');
    ok(r0.height === 16 + 5 * 72, '⑥ 浮层高度按选项数精确给出');

    const nearTop = layoutFn(Object.assign({}, base, { fieldTop: 95, index: 4 }));
    ok(nearTop.top >= (88 - 95) / scale - 0.1, '⑥ 字段贴近顶部时不钻进 nav-bar（上边界裁剪）');
    const nearBottom = layoutFn(Object.assign({}, base, { fieldTop: 760, index: 0 }));
    ok(nearBottom.top + nearBottom.height <= (800 - 16 - 760) / scale + 0.1,
      '⑥ 字段贴近底部时浮层不溢出屏幕（下边界裁剪）');
    const long = layoutFn(Object.assign({}, base, { count: 12, index: 9 }));
    ok(long.centered === false && long.height === 520, '⑥ 超过 7 个班时退化为普通下拉且高度受 520rpx 限制');
    const one = layoutFn(Object.assign({}, base, { count: 1, index: 0 }));
    ok(one.centered === true && one.height === 16 + 72, '⑥ 只有 1 个班也能正常展开');
  }

  // ⑦ 四个使用页：切班后同步 value 真源 + 重新拉数
  {
    for (const p of PAGES) {
      const f = pages[p.key] || { wxml: '', js: '' };
      ok(f.wxml.indexOf('<class-picker') >= 0, '⑦ ' + p.key + ' wxml 使用 class-picker');
      ok(f.wxml.indexOf('bind:change="' + p.handler + '"') >= 0, '⑦ ' + p.key + ' 绑定 change 事件');
      ok(/value="\{\{[^}]+\}\}"/.test(f.wxml), '⑦ ' + p.key + ' 回传当前班级 value（框内文字随页面真源同步）');
      ok(f.js.indexOf(p.handler + '(e)') >= 0, '⑦ ' + p.key + ' 存在 change handler');
      const body = methodBody(f.js, p.handler);
      ok(body.length > 0, '⑦ ' + p.key + ' handler 体可解析');
      ok(body.indexOf(p.refresh) >= 0, '⑦ ' + p.key + ' handler 内重新拉数（相关内容同步更新）');
      ok(!p.bodySync || body.indexOf(p.bodySync) >= 0, '⑦ ' + p.key + ' handler 内更新 value 真源');
      ok(f.js.indexOf(p.sync) >= 0, '⑦ ' + p.key + ' 页面存在 value 真源赋值');
    }
  }

  // ⑧ 组件确实接上了定位函数
  {
    ok(/this\._openCentered\(\)/.test(src), '⑧ onToggle 展开时调用定位函数');
    ok(src.indexOf('layout.layoutPop(') >= 0, '⑧ 定位算式来自 utils/class-picker-layout.js');
    ok(src.indexOf('margin-top:0rpx') >= 0, '⑧ 内联样式清掉普通下拉的 10rpx 间距（否则中心偏 10rpx）');
    ok(wxmlSrc.indexOf('style="{{popStyle}}"') >= 0, '⑧ wxml 把定位写进浮层 style');
    ok(wxmlSrc.indexOf('catchtap="onSelfClose"') >= 0, '⑧ 浮层空白处可收起（居中后会盖住字段）');
  }

  return { probs, checks };
}

console.log('── class-picker 行为体检');
const LAYOUT_FN = loadLayout(LAYOUT_SRC);
const PAGES_SRC = readPages();
const { probs, checks } = runAll(SRC, LAYOUT_FN, PAGES_SRC, WXML_SRC, false);
probs.forEach(p => console.log('  ✗ ' + p));

console.log('\n── 变异自证（改坏一处必须翻红）');
const MUTANTS = [
  {
    name: '「是不是点当前项」改用回填后的 this.data.curId 比较（恒等 → 永不抛事件）',
    from: '      if (id === prev) return;   // 点当前项 = 确认，不重复抛事件',
    to: '      if (id === Number(this.data.curId)) return;   // 点当前项 = 确认，不重复抛事件',
    scope: 'component'
  },
  {
    name: 'onPick 不再抛 change（四个页面切班全部失效）',
    from: "      this.triggerEvent('change', { id: id });",
    to: '      /* noop */',
    scope: 'component'
  },
  {
    name: '布局函数恒返回普通下拉（展开不再以选中项为中心）',
    from: '  const target = fieldHrpx / 2 - centerInPop;',
    to: '  const target = fieldHrpx + GAP;',
    scope: 'layout'
  },
  {
    name: 'onToggle 不调用定位函数（浮层永远从字段下方掉下来）',
    from: '      this._openCentered();',
    to: "      this.setData({ open: true, popStyle: '' });",
    scope: 'component'
  },
  {
    name: '班费页切班后不重新拉数（框内文字变了、余额还是上一个班）',
    from: '    this._loadFee(true);',
    to: '    /* 刷新被删 */',
    scope: 'page', page: 'fee', field: 'js'
  }
];
let mFail = 0;
for (const mu of MUTANTS) {
  let badC = SRC, badW = WXML_SRC, badL = LAYOUT_SRC, badP = PAGES_SRC;
  if (mu.scope === 'component') badC = SRC.split(mu.from).join(mu.to);
  if (mu.scope === 'layout') badL = LAYOUT_SRC.split(mu.from).join(mu.to);
  if (mu.scope === 'page') {
    const copy = {};
    for (const k of Object.keys(PAGES_SRC)) copy[k] = Object.assign({}, PAGES_SRC[k]);
    copy[mu.page][mu.field] = PAGES_SRC[mu.page][mu.field].split(mu.from).join(mu.to);
    badP = copy;
  }
  if ((mu.scope === 'component' && badC === SRC) ||
      (mu.scope === 'layout' && badL === LAYOUT_SRC) ||
      (mu.scope === 'page' && badP[mu.page][mu.field] === PAGES_SRC[mu.page][mu.field])) {
    mFail++; console.log('  ✗ 变异样本没命中源码：' + mu.name); continue;
  }
  let lf = LAYOUT_FN;
  try { lf = loadLayout(badL); } catch (e) { lf = () => ({ top: 0, height: 0, centerOffset: 999, centered: false }); }
  const { probs: p } = runAll(badC, lf, badP, badW, true);
  if (p.length) console.log('  ✓ 抓住 → ' + mu.name + '（翻红 ' + p.length + ' 项）');
  else { mFail++; console.log('  ✗ 漏放 → ' + mu.name); }
}

const fail = probs.length + mFail;
console.log('\n通过=' + ((checks - probs.length) + (MUTANTS.length - mFail)) + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
