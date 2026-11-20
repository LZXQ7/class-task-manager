#!/usr/bin/env node
/**
 * 离线自检：班费页「列表 ↔ 记账表单」切换必须有过渡动画（v1.0.8.74，2026-11-20）
 * --------------------------------------------------------------------------------
 * 用户口径：「点增加消费跳到记账页面完全没有动画、硬切过去的，切回来也一样」。
 *
 * 定规：
 *   ① 两个视图（list / form）各包一层 .fee-vp wrapper，切换时播一次淡入上浮；
 *   ② feeViewAnim 首屏为空（不播，避免与页面入场叠加），切换时与 feeView 同一次
 *      setData 置 'vp-anim' —— 覆盖全部 4 条路径：进表单 / 返回 / 切经费 / 提交成功；
 *   ③ 动画只动 transform/opacity（合成层，不碰布局），位移 ≤16rpx 与全站同量级；
 *   ④ prefers-reduced-motion 下关闭动画（无障碍）。
 *
 * 用法：node scripts/check-fee-view-anim.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  wxml: 'miniprogram/pages/fee/index.wxml',
  js: 'miniprogram/pages/fee/index.js',
  wxss: 'miniprogram/pages/fee/index.wxss'
};
const S = {};
Object.keys(F).forEach((k) => { S[k] = fs.existsSync(path.join(ROOT, F[k])) ? read(F[k]) : ''; });

/** 抽 Page 里某个 method 的整段（花括号配对） */
function methodSrc(js, name) {
  const i = js.indexOf(name + '(');
  if (i < 0) return '';
  const open = js.indexOf('{', i);
  if (open < 0) return '';
  let d = 0;
  for (let k = open; k < js.length; k += 1) {
    if (js[k] === '{') d += 1;
    else if (js[k] === '}') { d -= 1; if (!d) return js.slice(i, k + 1); }
  }
  return '';
}

function evalAll(s) {
  const wxml = s.wxml;
  const js = stripJs(s.js);
  const wxss = s.wxss;

  /* ① 两个视图各包一层 .fee-vp wrapper */
  const vpWrappers = (wxml.match(/class="fee-vp \{\{feeViewAnim\}\}"/g) || []).length;
  const listBlock = (wxml.match(/<block wx:if="\{\{feeView === 'list'\}\}">[\s\S]*?<\/block>/) || [''])[0];
  const formBlock = (wxml.match(/<block wx:if="\{\{feeView === 'form'\}\}">[\s\S]*?<\/block>/) || [''])[0];

  /* ② 首屏为空 + 四条切换路径都设 vp-anim */
  const firstFrameEmpty = /feeViewAnim:\s*''/.test(js);
  const open = methodSrc(js, 'onFeeAddOpen');
  const back = methodSrc(js, 'onFeeFormBack');
  const typeSwitch = methodSrc(js, 'onTypeSwitch');
  /* 提交成功那条在 .then 里，按 feeViewAnim 与 feeBusy:false 同现判定 */
  const submitBlock = js.slice(js.indexOf('已登记消费'), js.indexOf('已登记消费') + 400);

  /* ③ 动画只动 transform/opacity，位移 ≤16rpx */
  const kf = (wxss.match(/@keyframes feeViewIn\s*\{[^}]*\{[^}]*\}[^}]*\}/) || [''])[0];
  const animRule = (wxss.match(/\.fee-vp\.vp-anim\s*\{[^}]*\}/) || [''])[0];
  const transformOnly = /transform:\s*translateY\(/.test(kf) && /opacity:/.test(kf)
    && !/translateX/.test(kf) && !/\b(width|height|margin|padding|top|left)\s*:/.test(kf);
  const shift = (kf.match(/translateY\((\d+)rpx\)/) || [])[1];
  const shiftOk = shift !== undefined && Number(shift) <= 16;

  /* ④ reduced-motion 关闭 */
  const motionOff = /@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.fee-vp\.vp-anim\s*\{\s*animation:\s*none/.test(wxss);

  return {
    vpWrappers: vpWrappers === 2,
    listWrapped: /class="fee-vp \{\{feeViewAnim\}\}"/.test(listBlock),
    formWrapped: /class="fee-vp \{\{feeViewAnim\}\}"/.test(formBlock),
    firstFrameEmpty,
    openAnim: /feeViewAnim:\s*'vp-anim'/.test(open),
    backAnim: /feeViewAnim:\s*'vp-anim'/.test(back),
    typeAnim: /feeViewAnim:\s*'vp-anim'/.test(typeSwitch),
    submitAnim: /feeViewAnim:\s*'vp-anim'/.test(submitBlock),
    animRule: /animation:\s*feeViewIn/.test(animRule),
    transformOnly, shiftOk, motionOff
  };
}

const R = evalAll(S);

console.log('── ① 两个视图 wrapper');
check(R.vpWrappers, 'list 与 form 两块各包一层 .fee-vp（共 2 处）');
check(R.listWrapped, '列表视图带 feeViewAnim 动画 class');
check(R.formWrapped, '表单视图带 feeViewAnim 动画 class');

console.log('\n── ② 首屏不播 + 四条切换路径都播');
check(R.firstFrameEmpty, 'feeViewAnim 首屏为空（不与页面入场动画叠加）');
check(R.openAnim, '进表单（onFeeAddOpen）设 vp-anim');
check(R.backAnim, '返回列表（onFeeFormBack）设 vp-anim（用户「切回来也一样」）');
check(R.typeAnim, '切换班费/团费（onTypeSwitch）设 vp-anim');
check(R.submitAnim, '提交成功回列表设 vp-anim');

console.log('\n── ③ 动画性质 + ④ 无障碍');
check(R.animRule, '.fee-vp.vp-anim 挂 feeViewIn 动画');
check(R.transformOnly, '动画只动 transform/opacity（合成层，不碰布局）');
check(R.shiftOk, '上浮位移 ≤16rpx（与全站入场同量级，不夸张）');
check(R.motionOff, 'prefers-reduced-motion 下关闭动画');

console.log('\n── ⑤ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '表单视图去掉动画 wrapper', probe: 'formWrapped', file: 'wxml',
    apply: (x) => x.replace('<block wx:if="{{feeView === \'form\'}}">\n       <view class="fee-vp {{feeViewAnim}}">', '<block wx:if="{{feeView === \'form\'}}">') },
  { name: '返回列表不带动画（切回来又硬切）', probe: 'backAnim', file: 'js',
    from: "this.setData({ feeView: 'list', feeViewAnim: 'vp-anim', feeAmount: '', feeNote: '', feeImages: [] });",
    to: "this.setData({ feeView: 'list', feeAmount: '', feeNote: '', feeImages: [] });" },
  { name: '首屏就播动画（与入场叠加）', probe: 'firstFrameEmpty', file: 'js',
    from: "feeViewAnim: '',", to: "feeViewAnim: 'vp-anim'," },
  { name: '动画改动 margin（触发布局重排）', probe: 'transformOnly', file: 'wxss',
    from: 'from { opacity: 0; transform: translateY(16rpx); }',
    to: 'from { opacity: 0; margin-top: 16rpx; }' },
  { name: '去掉 reduced-motion 关闭', probe: 'motionOff', file: 'wxss',
    apply: (x) => x.replace(/@media \(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.fee-vp\.vp-anim\s*\{\s*animation:\s*none;\s*\}\s*\}/, '') }
];

MUT.forEach((mu) => {
  const src = S[mu.file];
  const next = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (next === src) { console.log('  ✗ 变异「' + mu.name + '」锚点失配/未改变源码'); failed += 1; return; }
  check(evalAll(Object.assign({}, S, { [mu.file]: next }))[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 班费视图切换动画检查全部通过'));
process.exit(failed ? 1 : 0);
