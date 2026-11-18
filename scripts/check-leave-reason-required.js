#!/usr/bin/env node
/**
 * 请假事由门禁（2026-11-18 需求1）
 * =============================================================
 * 守三件事：
 *  ① 提交请假申请（leave 页）+ 后端 leaveApply：选「其他」必须填事由说明（前端拦 + 后端双拦）。
 *  ② 请假登记（roster 页）+ 后端 addLeave：新增事由四选项；选「其他」必填说明；payload 带 reason。
 *  ③ 后端 leaveBoard/leaveSummary 下发 reason（课堂情况按公假/请假分列要用）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const leaveJs = read('miniprogram/pages/leave/index.js');
const leaveWxml = read('miniprogram/pages/leave/index.wxml');
const rosterJs = read('miniprogram/pages/roster/index.js');
const rosterWxml = read('miniprogram/pages/roster/index.wxml');
const adjust = read('cloudfunctions/adjust/index.js');
const adjustCode = strip(adjust);

console.log('── ① 提交请假申请：选「其他」必填事由说明');
// 前端：REASON_OPTS 四选项 + 提交校验
chk(/\{ key: 'PUBLIC', text: '公假' \}/.test(leaveJs) && /\{ key: 'OTHER', text: '其他' \}/.test(leaveJs),
  'leave 页事由四选项（公假/病假/事假/其他）齐全');
const submitFn = /onSubmitApply\(\)\s*\{([\s\S]*?)\n  \},/.exec(leaveJs);
chk(!!submitFn, '能定位 onSubmitApply');
if (submitFn) {
  const b = submitFn[1];
  chk(/reason === 'OTHER' && !note/.test(b) && /请填写事由说明/.test(b),
    '⚠️⚠️ leave 页提交时拦「其他」空说明（前端第一道闸）');
}
chk(/请填写具体事由（必填/.test(leaveWxml), 'leave 页输入框 placeholder 写「必填」（不再是选填）');
// 后端：leaveApply 双拦
const applyFn = /leaveApply: \{([\s\S]*?)\n  \},/.exec(adjust);
chk(!!applyFn, '能定位后端 leaveApply');
if (applyFn) {
  const b = applyFn[1];
  chk(/reason === 'OTHER' && !reasonNote/.test(b) && /请填写事由说明/.test(b),
    '⚠️⚠️ 后端 leaveApply 拦「其他」空说明（绕过界面直调也挡住）');
}

console.log('');
console.log('── ② 请假登记：新增事由 + 选「其他」必填');
chk(/const REASON_OPTS = \[/.test(rosterJs) && /\{ key: 'PUBLIC', text: '公假' \}/.test(rosterJs),
  'roster 页有与申请页同口径的事由四选项');
chk(/leaveReasonOpts: REASON_OPTS/.test(rosterJs) && /leaveReasonIndex: 0/.test(rosterJs),
  'roster data 有事由状态（默认公假）');
const pickFn = /onLeavePick\(e\)\s*\{([\s\S]*?)\n  \},/.exec(rosterJs);
chk(!!pickFn, '能定位 onLeavePick');
if (pickFn) {
  const b = pickFn[1];
  chk(/reason === 'OTHER' && !reasonNote/.test(b) && /请填写事由说明/.test(b),
    '⚠️⚠️ 登记提交时拦「其他」空说明（前端第一道闸）');
  chk(/reason,/.test(b) && /reasonNote/.test(b), '登记 payload 带 reason 与 reasonNote');
}
const reasonChange = /onLeaveReasonChange\(e\)\s*\{([\s\S]*?)\n  \},/.exec(rosterJs);
chk(!!reasonChange && /REASON_OPTS\[idx\]/.test(reasonChange[1]), 'roster 有事由变更 handler（读 picker 下标）');
chk(/bindchange="onLeaveReasonChange"/.test(rosterWxml) && /leaveReasonIsOther/.test(rosterWxml),
  'roster wxml 有事由 picker + 「其他」手填框');
// 后端 addLeave
const addFn = /addLeave: \{([\s\S]*?)\n  \},/.exec(adjust);
chk(!!addFn, '能定位后端 addLeave');
if (addFn) {
  const b = addFn[1];
  chk(/LEAVE_REASONS\.includes\(payload\.reason\)/.test(b), '后端 addLeave 事由过白名单');
  chk(/reason === 'OTHER' && !reasonNote/.test(b) && /请填写事由说明/.test(b),
    '⚠️⚠️ 后端 addLeave 拦「其他」空说明（第二道闸）');
  chk(/source, reason, reason_note\)/.test(b) && /reasonNote \|\| null/.test(b),
    '后端 addLeave 把 reason/reason_note 落库');
}

console.log('');
console.log('── ③ 后端下发 reason（课堂情况分列要用到）');
const reasonSelect = (adjust.match(/l\.start_time, l\.end_time, l\.periods, l\.leave_image, l\.reason,/g) || []).length;
chk(reasonSelect >= 2, 'leaveBoard 与 leaveSummary 两处 SQL 都 SELECT 了 l.reason');
const reasonMap = (adjust.match(/reason: r\.reason \|\| '',/g) || []).length;
chk(reasonMap >= 2, '两处 list 映射都回 reason 字段');

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 请假事由（必填 + 登记 + 下发）体检全部通过');
