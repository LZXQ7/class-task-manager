#!/usr/bin/env node
/**
 * 门禁：首页「本班请假」必须是标准贴底抽屉，禁止再接回共享元素转场
 * ============================================================
 * 起因（2026-11-15，v1.0.8.40）：1.0.10.7 → 1.0.8.38 → 1.0.8.39 连改三版，
 * 真机始终是「源卡还在 + 下面又冒出一张卡」/ 被底栏压住。用户明确要求：
 *   「要不改回去吧，还是原来的从底部出来。」
 * 于是整套容器 FLIP（originRect / .sheet-face / sheetTargetRect / 三个专守门禁）
 * 全部删除，恢复标准 bottom-sheet 贴底抽屉。
 *
 * 本门禁是**反向守卫**：不是「转场实现得对不对」，而是「不许再出现转场的任何零件」。
 * 静态断言与变异自证共用同一份 probes() 实现（改坏必红，不许出现假通过）。
 *
 * 用法：node scripts/check-leave-no-morph.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (f) => path.join(ROOT, f);
const SRC = {
  hw: 'miniprogram/pages/home/index.wxml',
  hj: 'miniprogram/pages/home/index.js',
  hc: 'miniprogram/pages/home/index.wxss',
  bj: 'miniprogram/components/bottom-sheet/index.js',
  bw: 'miniprogram/components/bottom-sheet/index.wxml',
  bc: 'miniprogram/components/bottom-sheet/index.wxss',
  mj: 'miniprogram/utils/morph.js'
};
const OLD_GATES = [
  'scripts/check-leave-morph.js',
  'scripts/check-leave-face.js',
  'scripts/check-morph-align.js'
];

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

/** 剥注释：历史注释里会提到 morph，不能让它污染「源码里有没有转场零件」的判定 */
function strip(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
function oldGatesExist() {
  return OLD_GATES.some((f) => fs.existsSync(R(f)));
}

/** 全部判据：true = 符合「已回退」口径 */
function probes(files, gatesExist) {
  const hw = strip(files.hw), hj = strip(files.hj), hc = strip(files.hc);
  const bj = strip(files.bj), bw = strip(files.bw), bc = strip(files.bc), mj = strip(files.mj);
  // 只取方法体本身（不能用「下一个方法名」当终点：块注释被 strip 后那些锚点会消失）
  const openBody = (hj.match(/_openLeaveSheet\(patch\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  const closeBody = (hj.match(/onLeaveHomeClose\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  return {
    // ① 首页不得再传源矩形，组件不得再声明 originRect
    noOriginProp: !/origin-rect\s*=/.test(hw) && !/originRect/.test(bj),
    // ② 卡面层（WXML 节点 + WXSS 规则 + 具名 slot）全清
    noFaceSlot: !/slot="face"/.test(hw) && !/class="sheet-face"/.test(bw)
      && !/\.sheet-face\s*\{/.test(bc) && !/lh-face-card/.test(hc),
    // ③ 不再隐藏源卡（可见性类 / data 标志全清）
    noHiddenSource: !/lh-src-hidden/.test(hw) && !/lh-src-hidden/.test(hc)
      && !/lh-src-box/.test(hw) && !/lh-src-box/.test(hc)
      && !/leaveHomeCardHidden/.test(hj),
    // ④ 共享卡面的 template 真源已删（内联回源卡）
    noTemplate: !/<template name="lhFace">/.test(hw) && !/is="lhFace"/.test(hw),
    // ⑤ 组件里 morph 类 / 内联样式 / 数据字段 / 方法全清
    noMorphCss: !/\.sheet-root\.morph/.test(bc) && !/morph-show/.test(bc),
    noMorphWxml: !/morphCls/.test(bw) && !/morphStyle/.test(bw) && !/morphFaceStyle/.test(bw),
    noMorphData: !/morphStyle|morphCls|morphFaceStyle|_morphPrepare|_morphReset|_morphGeo|_morphTo|_morphTimer/.test(bj),
    // ⑥ utils/morph.js 只保留 dialog 单例，容器几何函数不许回来
    noMorphGeom: !/sheetTargetRect|flipFromTo|morphInline|faceInline|MORPH_MS|MORPH_EASE/.test(mj),
    dialogKept: /setSource/.test(mj) && /getSource/.test(mj) && /clearSource/.test(mj)
      && /captureFromEvent/.test(mj) && /module\.exports/.test(mj),
    // ⑦ 请假弹层就是默认贴底抽屉（无 variant=float），绑定不变
    sheetDrawer: /<bottom-sheet show="\{\{leaveHomeShow\}\}" title="\{\{leaveHomeViewTitle\}\}" bind:close="onLeaveHomeClose">/.test(hw)
      && !/variant="float"/.test(hw),
    // ⑧ 打开 / 关闭都是一步 setData，不再量矩形
    simpleOpen: /_openLeaveSheet\(patch\)\s*\{[\s\S]{0,220}?leaveHomeShow:\s*true/.test(hj)
      && !/boundingClientRect/.test(openBody),
    simpleClose: /onLeaveHomeClose\(\)\s*\{[\s\S]{0,220}?leaveHomeShow:\s*false/.test(hj)
      && !/boundingClientRect/.test(closeBody),
    // ⑨ 既有页面约定不能顺手弄丢
    pageMetaOk: /page-meta[^>]*leaveHomeShow/.test(hw),
    tiltCardOk: /<tilt-card wx:if="\{\{showLeaveHome\}\}">/.test(hw),
    stItemOk: /id="leave-home-card" class="card mt16 leave-home st-item st-5"/.test(hw),
    // ⑩ 三个旧门禁不许复活
    noOldGates: !gatesExist
  };
}

const files = {};
Object.keys(SRC).forEach((k) => { files[k] = fs.readFileSync(R(SRC[k]), 'utf8'); });
const P = probes(files, oldGatesExist());

console.log('── ① 静态契约（共享元素转场必须彻底回退）');
const LABEL = {
  noOriginProp: '首页不传 origin-rect，组件不声明 originRect',
  noFaceSlot: '卡面层 .sheet-face / slot=face / lh-face-card 全清',
  noHiddenSource: '源卡不再隐藏（lh-src-box / leaveHomeCardHidden 全清）',
  noTemplate: 'lhFace template 已内联回源卡',
  noMorphCss: 'WXSS 无 .sheet-root.morph / morph-show 规则',
  noMorphWxml: 'WXML 无 morphCls / morphStyle / morphFaceStyle 绑定',
  noMorphData: '组件 JS 无 morph 数据字段与 _morph* 方法',
  noMorphGeom: 'utils/morph.js 无容器 FLIP 几何函数',
  dialogKept: 'dialog 所需的 setSource/getSource/clearSource/captureFromEvent 仍在',
  sheetDrawer: '请假弹层是默认贴底抽屉（非 float），绑定未变',
  simpleOpen: '_openLeaveSheet 一步 setData，不量矩形',
  simpleClose: 'onLeaveHomeClose 一步 setData，不量矩形',
  pageMetaOk: 'page-meta 滚动锁仍含 leaveHomeShow',
  tiltCardOk: 'tilt-card 的 wx:if 判据未丢',
  stItemOk: '源卡 st-item st-5 档位未丢',
  noOldGates: '三个旧转场门禁已删除且未复活'
};
Object.keys(P).forEach((k) => { P[k] ? ok(LABEL[k]) : fail(LABEL[k]); });

/* ---------------- ② 变异自证（改坏一处，对应判据必须翻红） ---------------- */
console.log('\n── ② 变异自证（内存改坏，不改磁盘）');
const SHEET_LINE = '  <bottom-sheet show="{{leaveHomeShow}}" title="{{leaveHomeViewTitle}}" bind:close="onLeaveHomeClose">';
const MUTATIONS = [
  { name: '把 origin-rect 接回请假弹层', file: 'hw', probe: 'noOriginProp',
    from: SHEET_LINE, to: SHEET_LINE.replace(' bind:close', ' origin-rect="{{leaveHomeOriginRect}}" bind:close') },
  { name: '把 face slot 卡面层接回来', file: 'hw', probe: 'noFaceSlot',
    from: SHEET_LINE, to: SHEET_LINE + '\n    <view slot="face" class="card leave-home lh-face-card"></view>' },
  { name: '把源卡隐藏容器接回来', file: 'hw', probe: 'noHiddenSource',
    from: '      <tilt-card wx:if="{{showLeaveHome}}">',
    to: '      <view class="lh-src-box {{leaveHomeCardHidden ? \'lh-src-hidden\' : \'\'}}">\n      <tilt-card wx:if="{{showLeaveHome}}">' },
  { name: '把 lhFace template 定义接回来', file: 'hw', probe: 'noTemplate',
    from: '\n<view class="page home ', to: '\n<template name="lhFace"></template>\n<view class="page home ' },
  { name: '把 morphStyle 数据字段接回组件', file: 'bj', probe: 'noMorphData',
    from: "    safeBottom: 0, tabbarPx: 49, capStyle: '', bodyMaxH: '',",
    to: "    safeBottom: 0, tabbarPx: 49, capStyle: '', bodyMaxH: '',\n    morphStyle: ''," },
  { name: '把 .sheet-root.morph 层级规则接回 WXSS', file: 'bc', probe: 'noMorphCss',
    from: '.sheet-footer {\n  flex-shrink: 0;',
    to: '.sheet-root.morph { z-index: 1200; }\n.sheet-footer {\n  flex-shrink: 0;' },
  { name: '把 morphCls 绑定接回 WXML', file: 'bw', probe: 'noMorphWxml',
    from: 'class="sheet-root {{variant === \'float\' ? \'float\' : \'\'}}">',
    to: 'class="sheet-root {{variant === \'float\' ? \'float\' : \'\'}} {{morphCls}}">' },
  { name: '把容器几何函数接回 morph.js', file: 'mj', probe: 'noMorphGeom',
    from: 'module.exports = {', to: 'function sheetTargetRect() { return null; }\nmodule.exports = {' },
  { name: '把请假弹层改成 float 居中卡', file: 'hw', probe: 'sheetDrawer',
    from: SHEET_LINE, to: SHEET_LINE.replace(' bind:close', ' variant="float" bind:close') },
  { name: '打开时又去量源卡矩形', file: 'hj', probe: 'simpleOpen',
    from: '  _openLeaveSheet(patch) {\n    this.setData(Object.assign({ leaveHomeShow: true }, patch));',
    to: "  _openLeaveSheet(patch) {\n    wx.createSelectorQuery().select('#leave-home-card').boundingClientRect(function () {});\n    this.setData(Object.assign({ leaveHomeShow: true }, patch));" },
  { name: '关闭时又去量源卡矩形', file: 'hj', probe: 'simpleClose',
    from: '  onLeaveHomeClose() {\n    this.setData({',
    to: "  onLeaveHomeClose() {\n    wx.createSelectorQuery().select('#leave-home-card').boundingClientRect(function () {});\n    this.setData({" },
  { name: 'page-meta 漏掉 leaveHomeShow', file: 'hw', probe: 'pageMetaOk',
    from: 'leaveHomeShow || courseInfoShow', to: 'courseInfoShow' },
  { name: 'tilt-card 的 wx:if 被挪走', file: 'hw', probe: 'tiltCardOk',
    from: '<tilt-card wx:if="{{showLeaveHome}}">', to: '<tilt-card>' },
  { name: '源卡丢掉 st-item 档位', file: 'hw', probe: 'stItemOk',
    from: 'class="card mt16 leave-home st-item st-5"', to: 'class="card mt16 leave-home"' }
];

MUTATIONS.forEach((m) => {
  const original = files[m.file];
  const n = original.split(m.from).length - 1;
  if (n !== 1) { fail('变异锚点失配（命中 ' + n + ' 次）：' + m.name); return; }
  if (P[m.probe] !== true) { fail('好样本该项本就未通过，自证无意义：' + m.name); return; }
  const next = Object.assign({}, files);
  next[m.file] = original.replace(m.from, m.to);
  probes(next, false)[m.probe] === false
    ? ok(m.name + ' → ' + m.probe + ' 翻红')
    : fail(m.name + ' → 判据没抓到（假通过）');
});

// 旧门禁复活单独验一条（无法用字符串变异表达）
if (P.noOldGates === true && probes(files, true).noOldGates === false) {
  ok('旧门禁文件复活 → noOldGates 翻红');
} else {
  fail('旧门禁复活的判据没抓到');
}

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 首页本班请假仍是标准贴底抽屉，共享元素转场未回归');
