#!/usr/bin/env node
/**
 * 门禁：调课后 5 秒重排提醒条 + 一次性动作通知（2026-11-28）
 * ================================================================
 * 用户口径：
 *   ① 调课应用后 5 秒提醒条，点击才同步更新值日与课前演讲；
 *   ② 重排范围 = 源周 + 目标周；目标周只有「前一周已排班」才继续按序号轮转；
 *   ③ 强制按当前游标重排（不是同周幂等起点），名单后移是预期；
 *   ④ 通知复用 notice_msg + notice_msg_target 双记录；动作通知按能力位定向；
 *   ⑤ 动作一次消费：后端以 notice_msg_read 作 claim，失败回滚 claim，防双击/并发重复排号。
 *
 * seam：静态源码契约 + 纯函数 `resyncWeekPlan` 真实行为回放（目标周前置条件）。
 * 用法：node scripts/check-shift-resync.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const SRC = {
  course: read(path.join(ROOT, 'cloudfunctions/course/index.js')),
  schedule: read(path.join(ROOT, 'cloudfunctions/schedule/index.js')),
  notice: read(path.join(ROOT, 'cloudfunctions/common/system-notice.js')),
  api: read(path.join(ROOT, 'miniprogram/utils/api.js')),
  noticeJs: read(path.join(ROOT, 'miniprogram/pages/notice/index.js')),
  noticeUtil: read(path.join(ROOT, 'miniprogram/utils/notice.js')),
  noticeWxml: read(path.join(ROOT, 'miniprogram/pages/notice/index.wxml')),
  ttJs: read(path.join(ROOT, 'miniprogram/pages/timetable/index.js')),
  ttWxml: read(path.join(ROOT, 'miniprogram/pages/timetable/index.wxml'))
};

const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');

/** 真跑共享纯函数：resyncWeekPlan(weeks, src, hasPrevWeek) */
function weekPlanBehavior(scheduleSource) {
  const src = stripJs(scheduleSource);
  const m = /function resyncWeekPlan\(weeks, srcWeek, hasPrev\)\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!m) return false;
  let fn;
  try { fn = new Function('hasPrev', 'return function(weeks, srcWeek){' + m[1] + '};')(() => true); }
  catch (e) { return false; }
  // 该函数接收第三个参数 hasPrev；包装时把它固定到闭包，这里用注入版本重造
  try {
    fn = new Function('return function(weeks, srcWeek, hasPrev){' + m[1] + '};')();
  } catch (e) { return false; }
  const cases = [
    { weeks: [8, 13], src: 8, prev: () => true, want: [8, 13] },
    { weeks: [8, 13], src: 8, prev: () => false, want: [8] },
    { weeks: [8, 13], src: 13, prev: () => true, want: [13, 8] },
    { weeks: [8, 9, 10], src: 8, prev: w => w !== 9, want: [8, 9] }
  ];
  return cases.every(c => {
    const got = fn(c.weeks, c.src, c.prev) || [];
    return JSON.stringify(got) === JSON.stringify(c.want);
  });
}

function buildProbes(S) {
  const course = stripJs(S.course);
  const schedule = stripJs(S.schedule);
  const notice = stripJs(S.notice);
  const ttJs = stripJs(S.ttJs);
  const ttWxml = stripHtml(S.ttWxml);
  const nJs = stripJs(S.noticeJs);
  const nWxml = stripHtml(S.noticeWxml);

  const p = {};
  p.noticeHelper = /INSERT INTO notice_msg\s*\(/.test(notice) &&
    /INSERT IGNORE INTO notice_msg_target/.test(notice) &&
    /module\.exports\s*=\s*\{\s*writeNotice/.test(notice);
  p.courseNotify = /async function notifyShiftChange/.test(course) &&
    /await notifyShiftChange\(pool, ctx, cfg/.test(course) &&
    /scope:\s*'ALL'/.test(course) &&
    /resync:duty\?/.test(course) && /resync:speech\?/.test(course) &&
    /guard\.isDutyAdmin/.test(course) && /guard\.canSpeech/.test(course) &&
    /m\.id !== me\.id/.test(course);
  p.noticeReturn = /resync:\s*\{/.test(course) &&
    /dutyNoticeId/.test(course) && /speechNoticeId/.test(course);
  p.resyncRoute = /resyncAfterShift:\s*\{/.test(schedule) &&
    /auth:\s*\{\s*needBind:\s*true\s*\}/.test(schedule) &&
    /guard\.requireScheduleAuth\(ctx\)/.test(schedule) &&
    /guard\.requireSpeechAuth\(ctx\)/.test(schedule) &&
    /INSERT IGNORE INTO notice_msg_read/.test(schedule) &&
    /resync:\(duty\|speech\)/.test(schedule);
  p.weekPlan = weekPlanBehavior(S.schedule);
  p.forceCurrent = /payload\.forceFromCurrent/.test(schedule) &&
    /loadCursors\(cfg\)/.test(schedule) &&
    /(start:\s*current|base:\s*current)/.test(schedule) &&
    /routes\.generate\.handler/.test(schedule) && /routes\.speechGenerate\.handler/.test(schedule);
  p.claimRollback = /claim\.affectedRows/.test(schedule) &&
    /DELETE FROM notice_msg_read WHERE notice_id = \? AND member_id = \?/.test(schedule);
  p.frontendApi = /scheduleResync:\s*C\('schedule',\s*'resyncAfterShift'\)/.test(S.api);
  p.fiveSecondBar = /_showResyncBar/.test(ttJs) &&
    /setTimeout/.test(ttJs) && /}, 5000\)/.test(ttJs) &&
    /resyncBar/.test(ttWxml) && /onResyncBar/.test(ttWxml) &&
    /api\.scheduleResync/.test(ttJs);
  p.noticeAction = /resync:(duty|speech)/.test(S.api + S.noticeUtil + nJs + nWxml) &&
    /resyncKind/.test(S.noticeUtil) && /resyncKind/.test(nWxml) &&
    /onResync\s*\(/.test(nJs) && /api\.scheduleResync/.test(nJs);
  return p;
}

const PROBES = buildProbes(SRC);
let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));

console.log('── ① 调课重排链路契约');
Object.keys(PROBES).forEach(k => check(PROBES[k], '契约 ' + k));

console.log('── ② 变异自证（关键判据必须有坏样本翻红）');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
const mutants = [
  {
    name: '通知助手不再写目标表（按能力位定向失效）',
    expect: 'noticeHelper', key: 'notice',
    build: () => mutate(SRC.notice, 'INSERT IGNORE INTO notice_msg_target', 'INSERT IGNORE INTO consumed_targets')
  },
  {
    name: '调课后不再写动作通知',
    expect: 'courseNotify', key: 'course',
    build: () => mutate(SRC.course, 'await notifyShiftChange(pool, ctx, cfg', 'await processShiftNoticeNoop(pool, ctx, cfg')
  },
  {
    name: '重排动作不再校验通知已消费（可重复消耗游标）',
    expect: 'resyncRoute', key: 'schedule',
    build: () => mutate(SRC.schedule, 'INSERT IGNORE INTO notice_msg_read', 'INSERT IGNORE INTO consumed_marker')
  },
  {
    name: '目标周前置条件被删（前一周没排也强行排）',
    expect: 'weekPlan', key: 'schedule',
    build: () => mutate(SRC.schedule, 'if (wk !== srcWeek && !hasPrev(wk - 1)) continue;', 'if (false) continue;')
  },
  {
    name: '重排又退回幂等起点（名单不后移）',
    expect: 'forceCurrent', key: 'schedule',
    build: () => mutate(SRC.schedule, 'payload.forceFromCurrent', 'payload.forceByWeekSnapshot')
  },
  {
    name: '5 秒提醒条消失',
    expect: 'fiveSecondBar', key: 'ttJs',
    build: () => mutate(SRC.ttJs, '_showResyncBar', 'showResyncTipV2')
  },
  {
    name: '通知页不再渲染重排动作按钮',
    expect: 'noticeAction', key: 'noticeUtil',
    build: () => mutate(SRC.noticeUtil, 'resyncKind', 'resyncTag')
  }
];

mutants.forEach(mt => {
  const badSrc = mt.build();
  if (badSrc === null) { bad('变异锚点没命中源码：' + mt.name); return; }
  const next = Object.assign({}, SRC);
  next[mt.key] = badSrc;
  const r = buildProbes(next);
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0
  ? '\nOK · 调课 5 秒重排提醒条 + 一次性动作通知门禁通过'
  : '\nFAIL · 调课重排门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
