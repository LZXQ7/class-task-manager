#!/usr/bin/env node
/**
 * 门禁：值日详情弹层「双向对调」（1.0.8.70）
 * ------------------------------------------------------------------
 * 用户口径：值日页点开「值日详情」后，底部操作区也能跟本周其它场次已排的同学
 * 直接互换课次（A 去 B 的课、B 去 A 的课），沿用 1.0.8.69 的 schedule.dutySwap。
 *
 * 真源：
 *   入口/候选渲染   components/duty-sheet/index.wxml
 *   候选过滤/调用   components/duty-sheet/index.js  (_dualCandidates / onAdjust / onSubmitAdjust)
 *   候选下发       pages/duty/index.js _paint -> wxml 的 swap-candidates
 *
 * 判据不只看「有没有这几个字」：候选过滤、页面下发、对调调用、关弹层都真扫代码，
 * 并做 8 组变异自证（改坏一处必须翻红），防止「加了按钮但点了没反应」。
 * 用法：node scripts/check-duty-detail-swap.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  sheetJs: 'miniprogram/components/duty-sheet/index.js',
  sheetWxml: 'miniprogram/components/duty-sheet/index.wxml',
  dutyJs: 'miniprogram/pages/duty/index.js',
  dutyWxml: 'miniprogram/pages/duty/index.wxml',
  api: 'miniprogram/utils/api.js'
};
const SRC = {};
Object.keys(F).forEach(k => { SRC[k] = fs.readFileSync(path.join(ROOT, F[k]), 'utf8'); });

function stripJs(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); }
function stripWxml(s) { return s.replace(/<!--[\s\S]*?-->/g, ''); }
function method(src, sig) {
  const a = src.indexOf(sig);
  if (a < 0) return '';
  const b = src.indexOf('\n  },', a);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}
function between(s, a, b) {
  const i = s.indexOf(a), j = s.indexOf(b);
  return (i >= 0 && j > i) ? s.slice(i, j) : '';
}
/** 从最后一次出现的标记处截一小段（onSubmitAdjust 里有两处 type === 'DUAL'） */
function lastSlice(s, marker, len) {
  const i = s.lastIndexOf(marker);
  return i < 0 ? '' : s.slice(i, i + len);
}

function judge(S) {
  const js = stripJs(S.sheetJs);
  const wx = stripWxml(S.sheetWxml);
  const dj = stripJs(S.dutyJs);
  const dw = stripWxml(S.dutyWxml);
  const ap = stripJs(S.api);

  const dualBlock = method(js, '\n    _dualCandidates() {');
  const submitBody = method(js, '\n    onSubmitAdjust() {');
  const adjustBody = method(js, '\n    onAdjust(e) {');
  const dualOpen = between(adjustBody, "if (type === 'DUAL')", "if (type === 'SWAP'");
  const dualDone = lastSlice(submitBody, "if (type === 'DUAL')", 260);
  const paintBody = method(dj, '\n  _paint(r) {');
  const superFooter = between(wx, 'wx:if="{{isSuper}}"', 'wx:elif="{{mineActs}}"');

  return {
    /* ① 入口 */
    entry: /data-type="DUAL"[^>]*>\s*双向对调\s*<\/view>/.test(wx),
    entryGated: /wx:if="\{\{swapCandidates\.length\}\}"[^>]*data-type="DUAL"/.test(wx),
    entrySuper: /data-type="DUAL"/.test(superFooter),
    /* ② 候选渲染 / 文案 */
    candList: /wx:if="\{\{adjusting === 'DUAL'\}\}"/.test(wx) && /\{\{item\.where\}\}/.test(wx),
    noReason: (wx.match(/wx:if="\{\{adjusting !== 'DUAL'\}\}"/g) || []).length >= 2,
    labels: /\{\{adjustTitle\}\}/.test(wx) && /\{\{submitLabel\}\}/.test(wx)
      && /DUAL:\s*'确认对调'/.test(js) && /DUAL:\s*'跟哪位同学对调/.test(js),
    noDeepTernary: !/adjusting === 'DUAL' \?/.test(wx),
    /* ③ 页面下发 */
    passed: /swap-candidates="\{\{swapCandidates\}\}"/.test(dw),
    paintPush: /swapCandidates\.push\(/.test(paintBody),
    paintFields: /dutyId:\s*x\.id/.test(paintBody) && /sessionScope:\s*x\.groupScope/.test(paintBody)
      && /groupTag:\s*x\.groupTag/.test(paintBody) && /where:/.test(paintBody)
      && /seenMember\[x\.memberId\]/.test(paintBody),
    paintSet: /setData\(\{[\s\S]*?\bpastDays,\s*swapCandidates\s*\}/.test(paintBody),
    /* ④ 组件过滤 + 调用 */
    prop: /swapCandidates:\s*\{\s*type:\s*Array,\s*value:\s*\[\]\s*\}/.test(js)
      && !/swapCandidates:[\s\S]{0,80}=>\[\]/.test(js),
    filterSelf: /x\.dutyId === d\.id/.test(dualBlock) && /x\.id === d\.memberId/.test(dualBlock),
    filterGroup: /x\.groupTag && d\.groupScope/.test(dualBlock) && /d\.groupTag && x\.sessionScope/.test(dualBlock),
    filterDedupe: /seen\[x\.id\]/.test(dualBlock),
    openLocal: /_dualCandidates\(\)/.test(dualOpen) && !/api\./.test(dualOpen),
    swapCall: /type === 'DUAL'[\s\S]{0,400}api\.scheduleSwap\(\{\s*dutyIdA:\s*d\.id,\s*dutyIdB:\s*other\.dutyId\s*\}\)/.test(submitBody)
      && !/type === 'DUAL'[\s\S]{0,400}api\.applySwap/.test(submitBody),
    apiMap: /scheduleSwap:\s*C\('schedule',\s*'dutySwap'\)/.test(ap),
    /* ⑤ 成功后关弹层并重拉整周（这条 duty 已经换成别人了，详情不能留着） */
    closeAfter: /triggerEvent\('changed'\);[\s\S]{0,120}triggerEvent\('close'\)/.test(dualDone),
    /* ⑥ 双主题：详情弹层不能出现原生弹窗 */
    noNative: !/wx\.showActionSheet|wx\.showModal/.test(js)
  };
}

const R = judge(SRC);
let failed = 0;
function check(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; }

console.log('── ① 值日详情底部有「双向对调」入口（仅超管、且本周有已排他人）');
check(R.entry, 'duty-sheet 底部有 data-type="DUAL" 的「双向对调」按钮');
check(R.entryGated, '按钮按 swapCandidates.length 门控（首页复用本弹层不显示）');
check(R.entrySuper, '按钮在超管操作区（不是本人请假/申请换班区）');

console.log('\n── ② 选人弹层与文案（WXML 不做 4 层三元）');
check(R.candList, 'DUAL 模式独立候选列表，副信息显示 {{item.where}} 场次');
check(R.noReason, '对调不走换班申请：原因区被 wx:if 排除');
check(R.labels, '标题 / 提交按钮文案在 JS 里算好（确认对调）');
check(R.noDeepTernary, 'WXML 无 4 层嵌套三元（wcc 会编译失败）');
check(R.noNative, '未引入无法跟随深色的原生弹窗');

console.log('\n── ③ 值日页下发整周候选');
check(R.passed, 'duty 页把 swapCandidates 传给 duty-sheet');
check(R.paintPush && R.paintSet, '_paint 构造 swapCandidates 并随整周名单一起 setData');
check(R.paintFields, '候选带 dutyId / groupTag / sessionScope / where 且按人去重');

console.log('\n── ④ 组件过滤 + 真调对调接口');
check(R.prop, 'properties.swapCandidates 默认值是 []（不是 () => [] 工厂函数）');
check(R.filterSelf && R.filterGroup && R.filterDedupe, '过滤本人/当前值日/分组不符/重复成员');
check(R.openLocal, '点入口用本地整周名单，不再发请求');
check(R.swapCall && R.apiMap, 'DUAL 走 api.scheduleSwap → schedule.dutySwap（不是申请换班）');
check(R.closeAfter, '对调成功后 changed 重拉 + close 关掉失效详情');

/* ---------------- 变异自证：坏一处必须翻红 ---------------- */
console.log('\n── ⑤ 变异自证');
const MUT = [
  { name: '删掉底部「双向对调」按钮', file: 'sheetWxml', probe: 'entry',
    apply: s => s.replace(/<view[^>]*data-type="DUAL"[^>]*>双向对调<\/view>/, '') },
  { name: '去掉候选门控（首页也显示空按钮）', file: 'sheetWxml', probe: 'entryGated',
    apply: s => s.replace('wx:if="{{swapCandidates.length}}" ', '') },
  { name: '候选列表退回换人模式（不显示场次）', file: 'sheetWxml', probe: 'candList',
    apply: s => s.replace('{{item.where}}', '{{item.dutyCount}}') },
  { name: '对调也弹「原因（选填）」', file: 'sheetWxml', probe: 'noReason',
    apply: s => s.replace(/wx:if="\{\{adjusting !== 'DUAL'\}\}" /g, '') },
  { name: '提交文案退回旧三元（4 层）', file: 'sheetWxml', probe: 'noDeepTernary',
    apply: s => s.replace('{{submitLabel}}', "{{submitting ? '处理中' : (adjusting === 'DUAL' ? '确认对调' : '提交申请')}}") },
  { name: '页面不再下发候选', file: 'dutyWxml', probe: 'passed',
    apply: s => s.replace('    swap-candidates="{{swapCandidates}}"\n', '') },
  { name: '_paint 构造候选时丢掉 dutyId', file: 'dutyJs', probe: 'paintFields',
    apply: s => s.replace('dutyId: x.id,', 'dutyId: 0,') },
  { name: '_paint 不再 setData 候选', file: 'dutyJs', probe: 'paintSet',
    apply: s => s.replace('      pastDays,\n      swapCandidates\n', '      pastDays\n') },
  { name: '组件默认值改成 () => [] 工厂函数', file: 'sheetJs', probe: 'prop',
    apply: s => s.replace('swapCandidates: { type: Array, value: [] }', 'swapCandidates: { type: Array, value: () => [] }') },
  { name: '候选过滤去掉「排除当前这条值日」', file: 'sheetJs', probe: 'filterSelf',
    apply: s => s.replace('x.dutyId === d.id || ', '') },
  { name: '候选过滤丢掉分组双向校验', file: 'sheetJs', probe: 'filterGroup',
    apply: s => s.replace("if (d.groupTag && x.sessionScope && d.groupTag !== x.sessionScope) return false;", '') },
  { name: '对调错调成申请换班接口', file: 'sheetJs', probe: 'swapCall',
    apply: s => s.replace('api.scheduleSwap({ dutyIdA: d.id, dutyIdB: other.dutyId })',
      'api.applySwap({ dutyId: d.id, toMemberId: other.id, reason: "OTHER" })') },
  { name: '成功后不关详情（详情已换成别人）', file: 'sheetJs', probe: 'closeAfter',
    apply: s => s.replace("          this.triggerEvent('close');\n          return;", '          return;') }
];
MUT.forEach(mu => {
  const next = mu.apply(SRC[mu.file]);
  if (next === SRC[mu.file]) { console.log('  ✗ 变异「' + mu.name + '」锚点没命中'); failed++; return; }
  const over = Object.assign({}, SRC); over[mu.file] = next;
  check(judge(over)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 值日详情双向对调门禁全部通过'));
process.exit(failed ? 1 : 0);
