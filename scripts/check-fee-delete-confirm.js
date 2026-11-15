#!/usr/bin/env node
/**
 * 离线自检：班费「删除消费记录」必须经过二次确认（2026-11-15 立规）
 * --------------------------------------------------------------------------------
 * 为什么必须是弹窗确认，而不是「长按圆环」：
 *
 *   `fee.deleteRecord` 是**真删**（`DELETE FROM class_fund_record` + `cloud.deleteFile`
 *   删凭证图），没有软删、没有回收站、没有文件备份。删掉之后只能靠日志 + 截图
 *   手工重建，而且**凭证图片救不回来**（2026-11-15 已真实发生过一次）。
 *
 *   长按 700ms（hold-confirm 的默认圆环）看起来「更难误触」，实际相反：
 *   ① 它是**按住即进度**，手指压着不动就会走完，没有「看一眼文案再决定」的环节；
 *   ② 圆环把「删除」做成一个视觉很重的红色圆钮，反而更容易被点到；
 *   ③ 一旦误触就是不可恢复的删除。
 *
 *   所以这里钉死：点击 → 站内 <dialog> 二次确认 → 才调 feeDeleteRecord。
 *   ⚠️ 用站内 dialog 而不是 wx.showModal：原生弹窗颜色由微信客户端决定，
 *      深色模式下必然是纯白面板（1.0.8.42 已全站替换过同类问题）。
 *
 * 用法：node scripts/check-fee-delete-confirm.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  wxml: 'miniprogram/pages/fee/index.wxml',
  js: 'miniprogram/pages/fee/index.js',
  json: 'miniprogram/pages/fee/index.json'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

/** 纯函数契约评估（变异自证复用） */
function evalAll(s) {
  const w = stripXml(s.wxml);
  const j = stripJs(s.js);
  /* 取 onFeeDeleteConfirm 的方法体：从方法名到下一个顶层方法（两空格缩进 + 名字 + ( ) */
  const body = (() => {
    const i = j.indexOf('onFeeDeleteConfirm(');
    if (i < 0) return '';
    const rest = j.slice(i);
    const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*\(/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  })();
  return {
    // ① 点删除只负责开弹窗，不直接删
    tapOpensDialog: /bindtap="onFeeDeleteTap"/.test(w)
      && /onFeeDeleteTap\s*\([\s\S]{0,300}?delShow:\s*true/.test(j),
    tapNoDirectDelete: !/onFeeDeleteTap\s*\([\s\S]{0,300}?feeDeleteRecord/.test(j),
    // ② 真有确认框，且是站内 dialog
    hasDialog: /<dialog[\s>]/.test(w) && /bind:confirm="onFeeDeleteConfirm"/.test(w),
    dialogRegistered: /"dialog"\s*:\s*"[^"]*components\/dialog\/index"/.test(s.json),
    // ③ 真正删除只发生在确认回调里
    confirmDeletes: /api\.feeDeleteRecord\(/.test(body),
    // ④ 反向：页面上不许再用 hold-confirm（长按圆环）
    noHoldConfirm: !/<hold-confirm[\s>]/.test(w)
  };
}

const S = evalAll(SRC);

console.log('── ① 「删除」= 点击 → 弹窗确认 → 才删');
check(S.tapOpensDialog, '点「删除」只是打开确认框（onFeeDeleteTap → delShow: true）');
check(S.tapNoDirectDelete, 'onFeeDeleteTap 里**没有**直接调 feeDeleteRecord');
check(S.confirmDeletes, '真正的 api.feeDeleteRecord 只出现在 onFeeDeleteConfirm 里');
check(S.hasDialog, '页面有 <dialog> 且绑定 bind:confirm="onFeeDeleteConfirm"');
check(S.dialogRegistered, 'index.json 注册了 dialog 组件（站内弹窗，深色不会变纯白）');
check(S.noHoldConfirm, '页面上没有 <hold-confirm>（那个长按圆环已按用户要求移除）');

console.log('\n── ② 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '删除按钮改回「点一下直接删」', probe: 'tapNoDirectDelete',
    from: 'this.setData({ delId: id, delShow: true });',
    to: 'api.feeDeleteRecord({ type: this.data.feeType, id });' },
  { name: '删掉确认框、删除恢复成 hold-confirm 长按', probe: 'noHoldConfirm', file: 'wxml',
    from: '<dialog\n    show="{{delShow}}"',
    to: '<hold-confirm label="删除" bind:confirm="onFeeDeleteConfirm"></hold-confirm>\n  <dialog\n    show="{{delShow}}"' },
  { name: '确认回调里不删（只剩 toast）', probe: 'confirmDeletes',
    from: 'api.feeDeleteRecord({ type: this.data.feeType, id })',
    to: 'util.toast(\'x\')' }
];
MUT.forEach((mu) => {
  const before = SRC[mu.file || 'js'] || SRC.js;
  const file = mu.file || 'js';
  const src = SRC[file];
  if (src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [file]: src.replace(mu.from, mu.to) });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 班费删除二次确认检查全部通过'));
process.exit(failed ? 1 : 0);
