#!/usr/bin/env node
/**
 * 门禁：班级下拉选择器（components/class-picker，2026-11-14）
 * ============================================================
 * 为什么要一道门禁：这个组件被班费 / 课表 / 值日 / 班级信息四个页面共用，
 * 它的错误形态全都是**静默**的 —— 写错了不报错，只是「点了没反应」「勾不显示」
 * 「切了班数据不更新」。静态正则看不出来，必须把组件定义真加载起来跑一遍。
 *
 * 锁住五件事：
 *   ① 选一个非当前项 → 收起 + 回填 + 抛 change（detail.id 是数字）
 *   ② 点当前项 → 仍收起，但**不抛** change（否则每个页面都会重复拉一次数据）
 *   ③ list 里 id 是字符串时也能正确回填 / 打勾（各页接口返回值类型不统一）
 *   ④ 空 list 点字段不展开（避免弹出一个空浮层）
 *   ⑤ 收起发生在抛事件之前（调用方 setData 不会把浮层又撑开）
 *
 * 末尾两组变异自证（内存字符串，绝不写盘）：
 *   · 把「记住旧 curId」挪到 setData 之后 → ① 必须翻红（本轮真踩过这个 bug）
 *   · onPick 不再 triggerEvent → ① 必须翻红
 *
 * 用法：node scripts/check-class-picker.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'miniprogram/components/class-picker/index.js');
const SRC = fs.readFileSync(FILE, 'utf8');

/** 用一份组件源码构造可调用的实例（Component 只取定义，不依赖小程序运行时） */
function makeInst(src, props) {
  let captured = null;
  /* eslint-disable no-new-func */
  new Function('Component', src)((obj) => { captured = obj; });
  if (!captured) throw new Error('组件源码没有调用 Component()');
  const events = [];
  const inst = Object.assign({}, captured.methods);
  inst.data = Object.assign({}, JSON.parse(JSON.stringify(captured.data)), props || {});
  inst.setData = function (patch) { Object.assign(this.data, patch); };
  inst.triggerEvent = function (name, detail) { events.push({ name, detail }); };
  return { inst, events };
}

function runAll(src, quiet) {
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
    const { inst, events } = makeInst(src, { list: LIST, value: 3 });
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
    const { inst, events } = makeInst(src, { list: LIST, value: 3 });
    inst._sync();
    inst.setData({ open: true });
    inst.onPick({ currentTarget: { dataset: { id: 3 } } });
    ok(inst.data.open === false, '② 点当前项也收起（用户点它是「确认」）');
    ok(events.length === 0, '② 点当前项不抛 change（否则每页重复拉一次数据）');
  }

  // ③ 字符串 id
  {
    const strList = [{ id: '3', name: 'A班' }, { id: '7', name: 'B班' }];
    const { inst, events } = makeInst(src, { list: strList, value: '3' });
    inst._sync();
    ok(inst.data.curName === 'A班', '③ 字符串 id 也能回填（=== 比对不会因类型丢失）');
    ok(inst.data.curId === 3, '③ curId 规范化为数字');
    inst.onPick({ currentTarget: { dataset: { id: '7' } } });
    ok(events.length === 1 && events[0].detail.id === 7, '③ 字符串 id 选中后抛数字 7');
  }

  // ④ 空列表
  {
    const { inst } = makeInst(src, { list: [], value: 0 });
    inst._sync();
    inst.onToggle();
    ok(inst.data.open === false, '④ 空 list 点字段不展开（不弹空浮层）');
  }

  // ⑤ 收起先于抛事件
  {
    const { inst, events } = makeInst(src, { list: LIST, value: 3 });
    inst._sync();
    inst.setData({ open: true });
    let openWhenFired = null;
    const orig = inst.triggerEvent;
    inst.triggerEvent = function (n, d) { openWhenFired = inst.data.open; orig.call(inst, n, d); };
    inst.onPick({ currentTarget: { dataset: { id: 9 } } });
    ok(openWhenFired === false, '⑤ 抛事件时浮层已经收起（调用方 setData 不会把它撑开）');
  }

  return { probs, checks };
}

console.log('── class-picker 行为体检');
const { probs, checks } = runAll(SRC, false);
probs.forEach(p => console.log('  ✗ ' + p));

console.log('\n── 变异自证（改坏一处必须翻红）');
const MUTANTS = [
  {
    name: '「是不是点当前项」改用回填后的 this.data.curId 比较（恒等 → 永不抛事件）',
    from: '      if (id === prev) return;   // 点当前项 = 确认，不重复抛事件',
    to: '      if (id === Number(this.data.curId)) return;   // 点当前项 = 确认，不重复抛事件'
  },
  {
    name: 'onPick 不再抛 change（四个页面切班全部失效）',
    from: "      this.triggerEvent('change', { id: id });",
    to: '      /* noop */'
  }
];
let mFail = 0;
for (const mu of MUTANTS) {
  const bad = SRC.split(mu.from).join(mu.to);
  if (bad === SRC) { mFail++; console.log('  ✗ 变异样本没命中源码：' + mu.name); continue; }
  const { probs: p } = runAll(bad, true);
  if (p.length) console.log('  ✓ 抓住 → ' + mu.name + '（翻红 ' + p.length + ' 项）');
  else { mFail++; console.log('  ✗ 漏放 → ' + mu.name); }
}

const fail = probs.length + mFail;
console.log('\n通过=' + ((checks - probs.length) + (MUTANTS.length - mFail)) + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
