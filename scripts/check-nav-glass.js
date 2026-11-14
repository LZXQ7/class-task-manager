/**
 * 门禁：#7 导航栏液态玻璃（v1.0.10.1）
 * ============================================================
 * 锁住 2026-11-14 真机实测踩出来的 5 个硬约束，防止以后改回「看不见」的状态：
 *
 * ① **CSS 有规则 ≠ WXML 有节点**：.nav-edge / .nav-sheen 必须是**真实节点**
 *    （本轮前几版把边缘画在 ::before/::after 上，组件 wxss 里伪元素整段不命中）。
 * ② **组件 wxss 里 inset box-shadow 不渲染** ⇒ 边缘折射只能用 border / 纯色 background。
 * ③ **组件 wxss 里 linear-gradient 的色标不能用百分比** ⇒ 用百分比的那几版整条不渲染；
 *    必须写成 rpx/px 位置（本轮实测：rpx 色标立刻生效）。
 * ④ **多层 background + background-size/position 多值会被丢弃** ⇒ 只能单层。
 * ⑤ **镜面扫光的位移量必须真的横穿导航栏**：光带宽 W、位移区间 [a%, b%]，
 *    亮带中心 = 0.5W + t*W（t 为 translateX 百分比），必须存在某一帧落在 (0, 100%) 内，
 *    且起点在左外、终点在右外。
 *
 * 结构：契约评估函数 evalContract() 对「一份源码」给出一组断言结果；
 * 每条变异把源码改成坏写法，再跑同一个 evalContract —— 只要断言翻红就算被抓。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = {
  wxml: read('miniprogram/components/nav-bar/index.wxml'),
  wxss: read('miniprogram/components/nav-bar/index.wxss'),
  js: read('miniprogram/components/nav-bar/index.js')
};

/** 剥注释：wxss 注释里大量出现选择器名，直接 indexOf 会取到错的声明体 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取某条规则的声明体（第一个 { 到配对的 }） */
function rule(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return '';
  const s = css.indexOf('{', i);
  if (s < 0) return '';
  let depth = 0;
  for (let k = s; k < css.length; k++) {
    if (css[k] === '{') depth++;
    else if (css[k] === '}') { depth--; if (depth === 0) return css.slice(s + 1, k); }
  }
  return '';
}

/** 契约评估：返回 [{ id, ok, msg }] */
function evalContract(src) {
  const CSS = stripComments(src.wxss);
  const out = [];
  const add = (id, ok, msg) => out.push({ id, ok: !!ok, msg });

  // ① 真实节点
  add('node-edge', /class="nav-edge"/.test(src.wxml), 'wxml 里有 .nav-edge 真实节点（边缘折射）');
  add('node-sheen', /class="nav-sheen"/.test(src.wxml), 'wxml 里有 .nav-sheen 真实节点（镜面扫光）');
  const edgeRule = rule(CSS, '.nav-edge');
  const sheenRule = rule(CSS, '.nav-sheen');
  add('no-pseudo', !/::(before|after)/.test(edgeRule) && !/::(before|after)/.test(sheenRule),
    '玻璃两层没有用 ::before/::after 伪元素（组件 wxss 里伪元素不命中）');

  // ② 边缘折射只用 border / 纯色
  add('edge-border', /border-(top|bottom)/.test(edgeRule), '.nav-edge 用 border 画亮暗边');
  add('edge-no-shadow', !/box-shadow/.test(edgeRule), '.nav-edge 不用 box-shadow（组件 wxss 里不渲染）');

  // ③ 渐变色标必须 rpx/px
  const stops = (edgeRule.match(/rgba\([^)]*\)\s+[^;]*?\d+%[^;]*/g) || [])
    .concat(sheenRule.match(/rgba\([^)]*\)\s+[^;]*?\d+%[^;]*/g) || []);
  add('grad-no-percent', stops.length === 0, '组件 wxss 里的渐变没有用百分比色标（必须 rpx/px）');

  // ④ 单层 background（多层 + size/position 多值会被丢弃）
  const multiBg = (edgeRule.match(/background-image/g) || []).length > 1
    || (edgeRule.match(/background-size/g) || []).length > 0
    || (edgeRule.match(/background-position/g) || []).length > 0;
  add('single-bg', !multiBg, '.nav-edge 用单层 background（多层会被丢弃）');

  // ⑤ 扫光位移要真的横穿
  const kf = rule(CSS, '@keyframes glassSheen');
  const wm = /width:\s*([\d.]+)%/.exec(sheenRule);
  const txs = (kf.match(/translateX\((-?[\d.]+)%\)/g) || [])
    .map(s => parseFloat(/(-?[\d.]+)/.exec(s)[1]));
  add('sheen-width', !!wm && txs.length >= 2, '.nav-sheen 有宽度且 keyframes 给了起止位移');
  if (wm && txs.length >= 2) {
    const W = parseFloat(wm[1]) / 100;
    const centers = txs.map(t => 0.5 * W + (t / 100) * W);
    add('sheen-cross', centers.some(c => c > 0.02 && c < 0.98),
      '扫光亮带中心能落在导航栏内（位移量算对了）');
    add('sheen-span', Math.min(...txs) <= -100 && Math.max(...txs) >= 100,
      '扫光起点在左外、终点在右外（能完整扫过）');
  } else {
    add('sheen-cross', false, '扫光亮带中心能落在导航栏内（位移量算对了）');
    add('sheen-span', false, '扫光起点在左外、终点在右外（能完整扫过）');
  }

  // flag 类由组件自己算（组件作用域，祖先类穿不透）
  add('self-flag', /motion\.flagClass\('glass'\)/.test(src.js), 'nav-bar 自己算 m-glass');
  add('flag-on-root', /glassClass/.test(src.wxml), 'nav-bar 根节点带上 glassClass');

  return out;
}

/* ---------------- 真实源码评估 ---------------- */
const base = evalContract(SRC);
console.log('真实源码断言：');
let failed = 0;
base.forEach(a => {
  console.log('  ' + (a.ok ? '✓' : '✗') + ' ' + a.msg);
  if (!a.ok) failed++;
});

/* ---------------- 变异自证 ---------------- */
function mutate(src, from, to) {
  const i = src.indexOf(from);
  if (i < 0) return null;
  return src.slice(0, i) + to + src.slice(i + from.length);
}
const MUT = [
  {
    name: 'wxml 删掉 .nav-edge 节点（CSS 有规则但节点不存在 ⇒ 折射从未渲染）',
    apply: (s) => {
      const w = mutate(s.wxml, 'class="nav-edge"', 'class="nav-edge-removed"');
      return w ? Object.assign({}, s, { wxml: w }) : null;
    }
  },
  {
    name: '把边缘折射改回 inset box-shadow（组件 wxss 里不渲染）',
    apply: (s) => {
      const w = mutate(s.wxss, 'border-top: 4rpx solid rgba(255, 255, 255, 0.9);', 'box-shadow: inset 0 3rpx 0 rgba(255,255,255,.9);');
      return w ? Object.assign({}, s, { wxss: w }) : null;
    }
  },
  {
    name: '把渐变色标改回百分比（组件 wxss 里整条不渲染）',
    apply: (s) => {
      const w = mutate(s.wxss, '136rpx', '50%');
      return w ? Object.assign({}, s, { wxss: w }) : null;
    }
  },
  {
    name: '把扫光改回旧版（光带宽 190% + 位移 ±52% ⇒ 亮带全程在视口外，永远看不见）',
    apply: (s) => {
      let w = mutate(s.wxss, 'width: 26%', 'width: 190%');
      if (!w) return null;
      w = mutate(w, 'translateX(150%)', 'translateX(52%)');
      if (!w) return null;
      w = mutate(w, 'translateX(420%)', 'translateX(52%)');
      return w ? Object.assign({}, s, { wxss: w }) : null;
    }
  },
  {
    name: '把玻璃两层改回 ::before/::after 伪元素',
    apply: (s) => {
      const w = mutate(s.wxml, 'class="nav-edge"', 'class="nav-edge-ps"');
      if (!w) return null;
      const w2 = mutate(s.wxss, '.nav-edge {', '.nav-edge::before {');
      return w2 ? Object.assign({}, s, { wxml: w, wxss: w2 }) : null;
    }
  },
  {
    name: 'nav-bar 不再自己算 flag 类（改回靠页面根节点的类 ⇒ 组件作用域拿不到）',
    apply: (s) => {
      const w = mutate(s.js, "motion.flagClass('glass')", "''");
      return w ? Object.assign({}, s, { js: w }) : null;
    }
  }
];

console.log('\n变异自证（每条都必须让契约翻红）：');
let mutFail = 0;
MUT.forEach(m => {
  const bad = m.apply(SRC);
  if (!bad) {
    console.log('  ✗ ' + m.name + ' —— 锚点没命中（变异没生效 ⇒ 自证无效）');
    mutFail++;
    return;
  }
  const res = evalContract(bad);
  const basePass = base.filter(a => a.ok).length;
  const badPass = res.filter(a => a.ok).length;
  if (badPass < basePass) console.log('  ✓ ' + m.name);
  else {
    console.log('  ✗ ' + m.name + ' —— 未被抓');
    mutFail++;
  }
});

if (failed || mutFail) {
  console.log('\n✗ 导航栏液态玻璃门禁未通过（断言失败 ' + failed + ' 项，变异漏抓 ' + mutFail + ' 项）');
  process.exit(1);
}
console.log('\n✓ 导航栏液态玻璃门禁通过（' + base.length + ' 组断言 + ' + MUT.length + ' 条变异自证）');
