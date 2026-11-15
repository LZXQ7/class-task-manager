#!/usr/bin/env node
/**
 * 门禁：容器共享元素转场的「像素级对齐」与关闭反向 FLIP（v1.0.8.39）
 * ============================================================
 * 起因（用户拿 Gemini 方案来问，实测后定位到的真根因）：
 *   截图里「凭空多出一张一模一样的卡、下面那张向下错位」。逐条核对源码后：
 *     · 源卡隐身、两帧分离、两方向各写 transition **本来就已实现**，不用改；
 *     · 真根因是 `sheetTargetRect()` 用 `windowHeight`（微信「可用窗口高」）推
 *       `top = H − h`，而 `.sheet-root` 是 position:fixed 覆盖自定义导航下的整个
 *       WebView（含状态栏区）⇒ 两者差一个状态栏，dy 偏大 ⇒ 首帧卡面向下错开。
 *   修法 = 量**无 transform 的 `.sheet-root`** 的 rect，用 `root.bottom − 面板布局高`
 *   推 to.top；源卡 from 也是页面节点的 boundingClientRect ⇒ 同视口坐标系，<1px 对齐。
 *
 * 本脚本钉死：
 *   ① 几何：rootRect 分支真的按 root.bottom 推 top，非法 rootRect 安全回落旧算法；
 *   ② 只量 root 的 rect，绝不量带 inline transform 的 `.sheet-panel`；
 *   ③ 关闭时按首页重新下发的最新 originRect 重算 FLIP，不沿用打开时的缓存；
 *   ④ 卡面/详情淡入淡出错开（longhand delay，不破坏全文件 .24s 判据）；
 *   ⑤ morph 期层级高于自定义 tabBar；
 *   ⑥ 源卡仍然用 visibility 隐藏（不能被 .st-item 入场动画的 opacity 覆盖）。
 *
 * 用法：node scripts/check-morph-align.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const F = {
  morphJs: 'miniprogram/utils/morph.js',
  bsJs: 'miniprogram/components/bottom-sheet/index.js',
  bsWxss: 'miniprogram/components/bottom-sheet/index.wxss',
  homeJs: 'miniprogram/pages/home/index.js',
  homeWxss: 'miniprogram/pages/home/index.wxss'
};
const SRC = {};
Object.keys(F).forEach(k => { SRC[k] = fs.readFileSync(path.join(ROOT, F[k]), 'utf8'); });

let failed = 0;
function check(ok, name) {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) failed++;
}
function strip(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
/** ⚠️ 结束锚点必须按文件真实的缩进传：组件方法是 4 空格、Page 方法是 2 空格。
 *   用错会抽到跨方法的长片段 ⇒ 探针拿别人的代码当证据（本项目踩过同款假通过）。 */
function bodyOf(src, name, pad) {
  const re = new RegExp('\\b' + name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n' + pad + '\\}');
  const m = re.exec(src);
  return m ? m[1] : '';
}
function loadMorph(src) {
  try {
    const sandbox = { module: { exports: {} }, exports: {}, require: () => ({}) };
    vm.runInNewContext(src, sandbox, { filename: 'morph.js' });
    return sandbox.module.exports;
  } catch (e) { return null; }
}

/* ---------------- ① 几何行为（vm 真跑 utils/morph.js） ---------------- */
const WIN = { windowWidth: 375, windowHeight: 812 };
const SIZE = { width: 375, height: 600 };
// 自定义导航下 WebView 比可用窗口高出一个状态栏（44px）
const ROOT_RECT = { left: 0, top: 0, width: 375, height: 856 };
const FROM = { left: 16, top: 300, width: 343, height: 120 };

function behavior(m) {
  if (!m || typeof m.sheetTargetRect !== 'function' || typeof m.flipFromTo !== 'function') return null;
  const fallback = m.sheetTargetRect(WIN, SIZE);
  const aligned = m.sheetTargetRect(WIN, SIZE, ROOT_RECT);
  const bad = m.sheetTargetRect(WIN, SIZE, { left: NaN, top: 0, height: 856 });
  const g = m.flipFromTo(FROM, aligned);
  const gOld = m.flipFromTo(FROM, fallback);
  const eq = (a, b) => Math.abs(a - b) < 0.001;
  return {
    fallbackKept: !!fallback && fallback.left === 0 && fallback.top === 212
      && fallback.width === 375 && fallback.height === 600,
    rootAligned: !!aligned && aligned.left === 0 && aligned.top === 256
      && aligned.width === 375 && aligned.height === 600,
    fixesOffset: !!aligned && !!fallback && (aligned.top - fallback.top) === 44,
    sameCoord: !!aligned && !!g && eq(aligned.left + g.dx, FROM.left)
      && eq(aligned.top + g.dy, FROM.top),
    oldWouldDrift: !!gOld && !!g && (gOld.dy - g.dy) === 44,
    badRootFallback: !!bad && bad.top === 212,
    invalidStillNull: m.sheetTargetRect(null, SIZE, ROOT_RECT) === null
      && m.sheetTargetRect(WIN, { width: 0, height: 600 }, ROOT_RECT) === null
  };
}
const B = behavior(loadMorph(SRC.morphJs));

/* ---------------- ② 静态契约 ---------------- */
function statics(s) {
  const mj = strip(s.morphJs);
  const js = strip(s.bsJs);
  const css = strip(s.bsWxss);
  const hj = strip(s.homeJs);
  const hc = strip(s.homeWxss);
  const prep = bodyOf(js, '_morphPrepare', '    ');
  const close = bodyOf(hj, 'onLeaveHomeClose', '  ');
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  const durs = [];
  const re = /transition:[^;]*(?:^|[^\d.])(\d*\.?\d+)s/g;
  let mm;
  while ((mm = re.exec(css))) durs.push(Math.round(Number(mm[1]) * 1000));
  return {
    rootArg: /function\s+sheetTargetRect\(win,\s*size,\s*rootRect\)/.test(mj)
      && /rootRect\.(top|height)/.test(mj),
    passesRoot: /morph\.sheetTargetRect\(win,\s*size,\s*rootRect\)/.test(prep),
    rootQuery: /q\.select\('\.sheet-root'\)\.boundingClientRect\(/.test(prep),
    panelLayoutSize: /q\.select\('\.sheet-panel'\)\.fields\(\{\s*size:\s*true\s*\}/.test(prep),
    noPanelVisualRect: !/q\.select\('\.sheet-panel'\)[^;]{0,120}boundingClientRect/.test(prep),
    savesTo: /self\._morphTo\s*=\s*to;/.test(js),
    clearsTo: /this\._morphTo\s*=\s*null;/.test(js),
    closeRecalc: /morph\.flipFromTo\(this\.properties\.originRect,\s*this\._morphTo\)/.test(js),
    /* 抽取有效性自检：抽到空串或跨方法长片段时，下面的判据会静默假通过。 */
    closeValid: close.length > 80 && /leaveHomeShow:\s*false/.test(close)
      && !/_openLeaveSheet/.test(close) && !/onLeaveHomeOpen/.test(close),
    closeRemeasure: /q\.select\('#leave-home-card'\)\.boundingClientRect\(/.test(close)
      && /leaveHomeOriginRect:\s*r\s*\|\|\s*this\.data\.leaveHomeOriginRect/.test(close)
      && /leaveHomeShow:\s*false/.test(close),
    stillVisibility: /\.lh-src-hidden\s*\{\s*visibility:\s*hidden;\s*\}/.test(hc)
      && !/\.lh-src-hidden\s*\{[^}]*opacity/.test(hc),
    zIndex: /\.sheet-root\.morph\s*\{\s*z-index:\s*1200;\s*\}/.test(css),
    delayLonghand: /transition-delay:\s*\.08s;/.test(css)
      && !/transition:\s*opacity\s*\.12s/.test(css),
    reducedDelay: !!reduced && /transition-delay:\s*0s;/.test(reduced[1]),
    allDur240: durs.length > 0 && durs.every(d => d === 240)
  };
}
const S = statics(SRC);

console.log('=== 1.0.8.39 转场像素级对齐 / 反向 FLIP 门禁 ===');
console.log('\n── ① 几何行为（vm 真跑 utils/morph.js）');
if (!B) { console.log('  FAIL  morph.js 无法在 vm 中加载'); process.exit(1); }
check(B.fallbackKept, '不传 rootRect 时保持旧算法 top=H-h（安全降级 / 旧门禁兼容）');
check(B.rootAligned, '传 rootRect 时 top=root.top+root.height-h（856-600=256）');
check(B.fixesOffset && B.oldWouldDrift, '恰好消掉 44px 状态栏差；旧算法会向下错位 44px');
check(B.sameCoord, 'to + dx/dy 精确还原源卡左上角（同一视口坐标系）');
check(B.badRootFallback && B.invalidStillNull, 'rootRect 非法回落旧算法；空窗口 / 零尺寸仍返回 null');

console.log('\n── ② 源码接线契约');
check(S.rootArg && S.passesRoot, 'sheetTargetRect 收第三参数，组件把 rootRect 传进去');
check(S.rootQuery && S.panelLayoutSize && S.noPanelVisualRect,
  '量 .sheet-root 的 rect + 面板只取 fields(size)；绝不量面板 boundingClientRect');
check(S.savesTo && S.clearsTo, '打开时保存终态矩形 _morphTo，卸载时清空');
check(S.closeValid, 'onLeaveHomeClose 方法体抽取有效（2 空格缩进，未串到别的方法）');
check(S.closeRecalc && S.closeRemeasure, '关闭：首页重新量源卡并同批下发，组件据此重算 FLIP');
check(S.stillVisibility, '源卡仍用 visibility:hidden（不用会被入场动画覆盖的 opacity）');
check(S.zIndex, 'morph 期 z-index 抬到 1200，兜住独立渲染树的自定义 tabBar');
check(S.delayLonghand && S.reducedDelay && S.allDur240,
  '详情淡入 delay .08s 走 longhand、减弱动效归零、全文件 transition 仍恒为 .24s');

/* ---------------- ③ 变异自证 ---------------- */
const MUT = [
  { name: '组件不传 rootRect（退回偏差算法）', file: 'bsJs', probe: 'passesRoot',
    from: 'morph.sheetTargetRect(win, size, rootRect)', to: 'morph.sheetTargetRect(win, size)' },
  { name: '不量 .sheet-root', file: 'bsJs', probe: 'rootQuery',
    from: "q.select('.sheet-root').boundingClientRect(function () {});", to: '' },
  { name: '面板改成 boundingClientRect（视觉矩形污染）', file: 'bsJs', probe: 'noPanelVisualRect',
    from: "q.select('.sheet-panel').fields({ size: true }, function () {});",
    to: "q.select('.sheet-panel').boundingClientRect(function () {});" },
  { name: '不保存终态矩形（关闭没法重算）', file: 'bsJs', probe: 'savesTo',
    from: 'self._morphTo = to;', to: '' },
  { name: '关闭沿用缓存几何', file: 'bsJs', probe: 'closeRecalc',
    from: 'morph.flipFromTo(this.properties.originRect, this._morphTo)', to: 'null' },
  /* ⚠️ 锚点必须带 `leaveHomeOriginRect: r || ...`：`_openLeaveSheet` 里有一模一样的
     `q.select('#leave-home-card').boundingClientRect((rect) => {`，用短锚点会命中前面
     那处、变异根本没改到关闭逻辑 ⇒ 自证假通过（本门禁第一版就踩了）。 */
  { name: '关闭时丢弃重新量到的源卡矩形（仍用打开时旧值）', file: 'homeJs', probe: 'closeRemeasure',
    from: 'leaveHomeOriginRect: r || this.data.leaveHomeOriginRect',
    to: 'leaveHomeOriginRect: this.data.leaveHomeOriginRect' },
  { name: '源卡改用 opacity 隐藏', file: 'homeWxss', probe: 'stillVisibility',
    from: '.lh-src-hidden { visibility: hidden; }', to: '.lh-src-hidden { opacity: 0; }' },
  { name: '去掉 morph 期层级', file: 'bsWxss', probe: 'zIndex',
    from: '.sheet-root.morph { z-index: 1200; }', to: '' },
  { name: 'delay 写成 .12s 简写（破坏全站 .24s 判据）', file: 'bsWxss', probe: 'delayLonghand',
    from: 'transition-delay: .08s;', to: 'transition: opacity .12s ease;' },
  { name: '减弱动效段不归零 delay', file: 'bsWxss', probe: 'reducedDelay',
    from: '.sheet-root.morph.morph-show .sheet-footer { transition-delay: 0s; }', to: '' },
  { name: 'morph.js 的 rootRect 分支退回 H-h', file: 'morphJs', probe: 'rootAligned', behavior: true,
    from: 'return { left: rl, top: rt + rh - h, width: w, height: h };',
    to: 'return { left: rl, top: Number(win.windowHeight) - h, width: w, height: h };' }
];

console.log('\n── ③ 变异自证（改坏 → 探针必须翻红）');
MUT.forEach(mu => {
  const before = SRC[mu.file];
  if (!before.includes(mu.from)) { check(false, '变异「' + mu.name + '」锚点没命中 —— 自证会假通过'); return; }
  const next = Object.assign({}, SRC);
  next[mu.file] = before.replace(mu.from, mu.to);
  if (next[mu.file] === before) { check(false, '变异「' + mu.name + '」替换没生效 —— 自证会假通过'); return; }
  let caught;
  if (mu.behavior) {
    const b = behavior(loadMorph(next.morphJs));
    caught = !b || b[mu.probe] === false;
  } else {
    caught = statics(next)[mu.probe] === false;
  }
  check(caught, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '❌ ' + failed + ' 项不通过' : '✅ 转场对齐检查全部通过'));
process.exit(failed ? 1 : 0);
