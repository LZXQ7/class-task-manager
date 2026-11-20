#!/usr/bin/env node
/**
 * 门禁：跨天请假的「连续时段」语义（v1.0.8.77，2026-11-20）
 * --------------------------------------------------------------------------------
 * 用户规则（grilling 六问定稿）：
 *   · 只改**跨天**（start_date≠end_date）；单日保持「当天时段、晚上回校」不变。
 *   · 跨天 = 连续区间：首日 clock >= start_time、末日 clock <= end_time、
 *     中间整天（含晚上）连续。
 *   · 跨天时 periods **不再权威**（用 start_time/end_time 当首末边界）；单日仍按 periods。
 *   · 跨天且只填一边时间（如示例成员05 start 空/end=20:00）⇒ 整条视为**整天假，两端都不卡**。
 *
 * 反馈回路：用 vm 加载**真源码**里的 normTime / segmentOf / inLeaveWindow（不写副本），
 * 喂生产库 6 条真实请假记录 + 指定时刻，断言 now 口径名单。改动前此门禁必须红。
 *
 * 用法：node scripts/check-leave-crossday.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ADJUST = fs.readFileSync(path.join(ROOT, 'cloudfunctions/adjust/index.js'), 'utf8');
const ROSTER = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/roster/index.js'), 'utf8');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/** 从指定真源码里抽顶层 function（花括号配对，不靠缩进） */
function fnOf(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let d = 0, started = false;
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '{') { d += 1; started = true; }
    else if (src[k] === '}') { d -= 1; if (started && !d) return src.slice(i, k + 1); }
  }
  throw new Error('函数未闭合 ' + name);
}
const fn = (name) => fnOf(ADJUST, name);

/** 把真源码函数拼进沙盒，导出 inLeaveWindow */
function buildInLeaveWindow() {
  const src = [
    'const TIME_RE = /^([01]\\d|2[0-3]):[0-5]\\d$/;',
    fn('normTime'), fn('segmentOf'), fn('inLeaveWindow'),
    'module.exports = inLeaveWindow;'
  ].join('\n');
  /* week.dateStr 与真实现等价（string 截前 10 位；见 common/week.js） */
  const weekStub = { dateStr: (v) => (!v ? '' : (typeof v === 'string' ? v.slice(0, 10) : String(v).slice(0, 10))) };
  const sandbox = { module: { exports: {} }, exports: {}, String, Array, Number, week: weekStub, console: { error() {} } };
  vm.runInNewContext(src, sandbox, { filename: 'adjust-inLeaveWindow.js' });
  return sandbox.module.exports;
}

/* 生产库 6 条真实请假记录（scripts/_q_leave-all-3.txt，只读查询） */
const ROWS = [
  { name: '示例成员05', groupTag: 'A', startDate: '2026-11-19', endDate: '2026-11-20', startTime: '', endTime: '20:00', periods: [] },
  { name: '示例成员14', groupTag: 'B', startDate: '2026-11-20', endDate: '2026-11-22', startTime: '', endTime: '', periods: [] },
  { name: '示例成员18', groupTag: 'B', startDate: '2026-11-20', endDate: '2026-11-22', startTime: '', endTime: '', periods: [] },
  { name: '示例成员19', groupTag: 'A', startDate: '2026-11-20', endDate: '2026-11-22', startTime: '08:00', endTime: '18:00', periods: ['am', 'pm'] },
  { name: '示例成员21', groupTag: 'A', startDate: '2026-11-16', endDate: '2026-11-20', startTime: '', endTime: '', periods: [] },
  { name: '示例成员46', groupTag: 'B', startDate: '2026-11-20', endDate: '2026-11-24', startTime: '', endTime: '', periods: [] }
];

const inLeaveWindow = buildInLeaveWindow();
/** 模拟 leaveBoard 的 nowList：SQL 已按 date 过滤日期，这里再按时段判定 */
function nowNames(clock, today) {
  return ROWS.filter(r => inLeaveWindow(r, clock, today)).map(r => r.name);
}
function assertNames(label, clock, today, expected) {
  const got = nowNames(clock, today);
  const ok = got.length === expected.length && expected.every(n => got.indexOf(n) >= 0);
  check(ok, label + '（got=' + got.join('/') + ' expected=' + expected.join('/') + '）');
}

console.log('── ① 跨天连续：示例成员19 11-20~11-22 上午+下午');
/* 首日 20 日：8 点前不算、8 点后算（哪怕晚上——跨天首日只卡下界） */
check(inLeaveWindow(ROWS[3], '07:59', '2026-11-20') === false, '首日 07:59 未到开始时刻 ⇒ 不算请假');
check(inLeaveWindow(ROWS[3], '08:00', '2026-11-20') === true, '首日 08:00 到点 ⇒ 算请假');
check(inLeaveWindow(ROWS[3], '20:52', '2026-11-20') === true, '首日晚上 20:52 ⇒ 仍算（跨天连续，不回校）');
/* 中间日 21 日：全天算，含凌晨与晚上 */
check(inLeaveWindow(ROWS[3], '03:00', '2026-11-21') === true, '中间日 03:00 ⇒ 整天连续算请假');
check(inLeaveWindow(ROWS[3], '20:52', '2026-11-21') === true, '中间日 20:52 ⇒ 整天连续算请假');
/* 末日 22 日：18 点后结束 */
check(inLeaveWindow(ROWS[3], '18:00', '2026-11-22') === true, '末日 18:00 到结束时刻 ⇒ 仍算');
check(inLeaveWindow(ROWS[3], '18:01', '2026-11-22') === false, '末日 18:01 越过结束 ⇒ 不算');

console.log('\n── ② 半边时间：示例成员05 start 空/end=20:00 ⇒ 整天假两端不卡');
check(inLeaveWindow(ROWS[0], '00:01', '2026-11-19') === true, '首日无开始时间 ⇒ 00:01 也算（不卡下界）');
check(inLeaveWindow(ROWS[0], '23:59', '2026-11-20') === true, '末日有 end=20:00 但 start 空 ⇒ 整条按整天假，23:59 仍算');

console.log('\n── ③ 单日不变：单日 am+pm 晚上回校');
const SINGLE = { name: '单日测试', startDate: '2026-11-20', endDate: '2026-11-20', startTime: '08:00', endTime: '18:00', periods: ['am', 'pm'] };
check(inLeaveWindow(SINGLE, '10:00', '2026-11-20') === true, '单日 am 时段 ⇒ 算');
check(inLeaveWindow(SINGLE, '20:52', '2026-11-20') === false, '单日晚上（eve 不在 am/pm）⇒ 回校、不算（旧语义保持）');

console.log('\n── ④ 用户场景复现：20:52 应 6 人全在假中（上一轮是 5）');
assertNames('20:52 today=11-20', '20:52', '2026-11-20', ROWS.map(r => r.name));
assertNames('白天 10:00 today=11-20', '10:00', '2026-11-20', ROWS.map(r => r.name));

console.log('\n── ⑤ 前端镜像（roster inLeaveWindowFront）与后端同构');
function buildFront() {
  const src = [
    fnOf(ROSTER, 'parsePeriodsFront'), fnOf(ROSTER, 'segmentOfFront'),
    fnOf(ROSTER, 'inLeaveWindowFront'), 'module.exports = inLeaveWindowFront;'
  ].join('\n');
  const sandbox = { module: { exports: {} }, exports: {}, String, Array, Number, console: { error() {} } };
  vm.runInNewContext(src, sandbox, { filename: 'roster-inLeaveWindowFront.js' });
  return sandbox.module.exports;
}
const front = buildFront();
check(typeof front === 'function', '从 roster 真源码抽出 inLeaveWindowFront');
/* 前端 row 字段与后端同形（startDate/endDate/startTime/endTime/periods） */
let frontMismatch = 0;
ROWS.concat([SINGLE]).forEach((row) => {
  ['07:59', '10:00', '18:01', '20:52'].forEach((clock) => {
    const day = row.startDate;
    if (inLeaveWindow(row, clock, day) !== front(row, clock, day)) frontMismatch += 1;
  });
});
check(frontMismatch === 0, '前后端对同一行/同一时刻判定一致（6条真实数据×4时刻，差异=' + frontMismatch + '）');
check(front(ROWS[3], '20:52', '2026-11-20') === true, '前端镜像：示例成员19跨天首日晚上算请假中');
check(front(SINGLE, '20:52', '2026-11-20') === false, '前端镜像：单日 am+pm 晚上回校（不变）');

console.log('\n── ⑥ 变异自证（改坏 → 判据必须翻红）');
/* 变异：把 inLeaveWindow 换成「旧版」（不看日期、periods 权威），应导致示例成员19晚上被剔除 */
const OLD_FN = [
  'function oldInLeaveWindow(row, clock) {',
  '  const per = row && row.periods ? row.periods : [];',
  '  if (!per.length) { const s = normTime(row.startTime), e = normTime(row.endTime);',
  '    if (!s || !e) return true; return clock >= s && clock <= e; }',
  '  return per.indexOf(segmentOf(clock)) >= 0;',
  '}'
].join('\n');
const sandbox2 = { module: { exports: {} }, exports: {}, String, Array, Number, console: { error() {} } };
vm.runInNewContext([
  'const TIME_RE = /^([01]\\d|2[0-3]):[0-5]\\d$/;',
  fn('normTime'), fn('segmentOf'), OLD_FN, 'module.exports = oldInLeaveWindow;'
].join('\n'), sandbox2, { filename: 'old.js' });
const oldFn = sandbox2.module.exports;
check(oldFn(ROWS[3], '20:52', '2026-11-20') === false,
  '变异被抓：退回旧版（periods 权威）后示例成员19晚上被剔除 ⇒ 新判据关键');

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 跨天请假连续时段检查全部通过'));
process.exit(failed ? 1 : 0);
