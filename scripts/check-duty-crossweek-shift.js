#!/usr/bin/env node
/**
 * 门禁：跨周调课的补课必须进入值日生成链路（2026-11-28）
 * ================================================================
 * 用户诉求：值日一键生成 / AI 生成 / 每周自动生成，都要像课表那样认跨周调入的课。
 * 根因（M1 同源漏改）：三处值日生成都是 `for session: resolveSlot → classDateOf → push`，
 * resolveSlot 只解析源周调出（shiftKey(sid, 源周)），目标周查不到 ⇒ 退回原落位/被 weeks 挡。
 * 全项目只有 duty/index.js:260 读取端有 incomingOf。修法：抽共享纯函数 incomingDutyPlan
 * 到 common/schedule-core.js，三处 concat 进 rotatePlan 后统一排序。
 *
 * 判据：
 *   ① 行为层：vm 真跑 incomingDutyPlan + 真实 week.js，验证补课落位 + 放假跳过 + 脏数据跳过；
 *   ② 接线层：schedule.generate / schedule.buildAiContext / cron-weekly 三处都调用，且 common 副本无漂移；
 *   ③ 变异自证：拿掉任一接线 / 去掉补课 s 的 weeks 归一 / 改落位，对应判据翻红。
 *
 * 用法：node scripts/check-duty-crossweek-shift.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'cloudfunctions', 'common', 'schedule-core.js');
const SCHEDULE = path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js');
const CRON = path.join(ROOT, 'cloudfunctions', 'cron-weekly', 'index.js');
const WEEK = path.join(ROOT, 'cloudfunctions', 'common', 'week.js');
const read = p => fs.readFileSync(p, 'utf8');
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, m) { console.log((cond ? '  ✓ ' : '  ✗ ') + m); if (!cond) failed++; }

const CORE_SRC = read(CORE);
const CORE_CODE = stripJs(CORE_SRC);
const SCHED_CODE = stripJs(read(SCHEDULE));
const CRON_CODE = stripJs(read(CRON));
const week = require(WEEK);

/* ============ ① 行为层：vm 真跑共享纯函数 ============ */
function loadCore(src) {
  const box = { module: { exports: {} }, require: () => ({ pickBySeq: () => {}, inferCursor: () => {}, buildState: () => {} }), console };
  vm.createContext(box);
  vm.runInContext(src, box, { filename: 'schedule-core.js' });
  return box.module.exports.incomingDutyPlan;
}

function fnSource(js, name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let k = i; k < js.length; k++) {
    if (js[k] === '{') { d++; started = true; }
    else if (js[k] === '}') { d--; if (started && !d) return js.slice(i, k + 1); }
  }
  return '';
}

console.log('── ① 行为层（vm 真跑 incomingDutyPlan）');
const fn = loadCore(CORE_CODE);
check(typeof fn === 'function', '共享纯函数 incomingDutyPlan 存在且可加载');

// 症状场景：第8周B组周三第2节 → 第13周周一第1节
const sessions = [
  { id: 901, day_of_week: 3, period: 2, group_scope: 'B', kind: 'COURSE', weeks: '8', week_rule: '' },
  { id: 902, day_of_week: 5, period: 4, group_scope: 'A', kind: 'CLEAN', weeks: '', week_rule: 'ALL' }
];
const shifts = { [week.shiftKey(901, 8)]: { sessionId: 901, fromWeek: 8, kind: 'MOVE', toDay: 1, toPeriod: 1, toWeek: 13 } };
const weekStub = { incomingOf: week.incomingOf, classDateOf: () => '2026-12-07' };
const plan = fn(sessions, 13, {}, {}, shifts, weekStub);
check(plan.length === 1, '目标周13追加出 1 条补课（常规 resolveSlot 解析不到它）');
check(plan[0] && plan[0].slot.day === 1 && plan[0].slot.period === 1 && plan[0].slot.shifted === true,
  '补课落位用 toDay/toPeriod（周一第1节），带 shifted 标记');
check(plan[0] && plan[0].incoming === true, '条目带 incoming 标记（供调用方区分常规/补课）');
check(plan[0] && plan[0].s.weeks === '' && plan[0].s.week_rule === 'ALL',
  '补课 s 的 weeks 归一为未指定（避免 buildSlots 的 matchesWeeks 二次挡掉）');
check(plan[0] && plan[0].s.group_scope === 'B' && plan[0].s.kind === 'COURSE',
  '补课沿用原 session 的分组/类型（跟课走）');
// 放假跳过
const holPlan = fn(sessions, 13, {}, {}, shifts, { incomingOf: week.incomingOf, classDateOf: () => null });
check(holPlan.length === 0, '目标日放假 → 补课跳过（与常规课同一口径）');
// 脏数据跳过
const dirty = fn(sessions, 13, {}, {}, { [week.shiftKey(999, 8)]: { sessionId: 999, kind: 'MOVE', toDay: 1, toPeriod: 1, toWeek: 13 } }, weekStub);
check(dirty.length === 0, '补课课次不存在（脏数据）→ 跳过');
// 无 week 工具降级
check(fn(sessions, 13, {}, {}, shifts, null).length === 0, '无 week 工具注入 → 安全降级为空');

/* ============ ② 接线层：三处调用 + 副本无漂移 ============ */
function routeBody(js, name) {
  const anchor = '\n  ' + name + ': {';
  const i = js.indexOf(anchor);
  if (i < 0) return '';
  const rest = js.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function aiCtxBody(js) {
  const i = js.indexOf('async function buildAiContext');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let k = i; k < js.length; k++) {
    if (js[k] === '{') { d++; started = true; }
    else if (js[k] === '}') { d--; if (started && !d) return js.slice(i, k + 1); }
  }
  return '';
}
const genBody = routeBody(SCHED_CODE, 'generate');
const aiBody = aiCtxBody(SCHED_CODE);
const wired = {
  gen: /incomingDutyPlan\s*\(/.test(genBody),
  ai: /incomingDutyPlan\s*\(/.test(aiBody),
  cron: /incomingDutyPlan\s*\(/.test(CRON_CODE)
};
console.log('── ② 三处接线同源 + 副本无漂移');
check(wired.gen, 'schedule.generate（一键生成）调用 incomdingDutyPlan'.replace('incomding', 'incoming'));
check(wired.ai, 'schedule.buildAiContext（AI 生成）调用 incomingDutyPlan');
check(wired.cron, 'cron-weekly（每周自动生成）调用 incomingDutyPlan');
const copies = fs.readdirSync(path.join(ROOT, 'cloudfunctions'))
  .filter(d => fs.existsSync(path.join(ROOT, 'cloudfunctions', d, 'common', 'schedule-core.js')));
const drift = copies.filter(d => read(path.join(ROOT, 'cloudfunctions', d, 'common', 'schedule-core.js')).indexOf('incomingDutyPlan') < 0);
check(drift.length === 0, copies.length + ' 份 common 副本全部含 incomingDutyPlan（无漂移）' + (drift.length ? '：缺 ' + drift.join(',') : ''));

/* ============ ③ 变异自证 ============ */
console.log('── ③ 变异自证');
function runWiring(sched, cron) {
  const g = routeBody(sched, 'generate');
  const a = aiCtxBody(sched);
  return {
    gen: /incomingDutyPlan\s*\(/.test(g),
    ai: /incomingDutyPlan\s*\(/.test(a),
    cron: /incomingDutyPlan\s*\(/.test(cron)
  };
}
const mutants = [
  {
    name: '一键生成不再追加补课（手动生成漏排）', probe: 'gen',
    build: () => {
      const g = routeBody(SCHED_CODE, 'generate');
      const broken = g.replace(/incomingDutyPlan\(sessions, wk, cfg, cal, shifts, week\)\.forEach\([^\n]*\n/, '');
      return broken === g ? null : { sched: SCHED_CODE.replace(g, broken) };
    }
  },
  {
    name: 'AI 上下文不再追加补课（AI 生成漏排）', probe: 'ai',
    build: () => {
      const a = aiCtxBody(SCHED_CODE);
      const broken = a.replace(/incomingDutyPlan\(rawSessions, wk, cfg, cal, shifts, week\)\.forEach\([^\n]*\n/, '');
      return broken === a ? null : { sched: SCHED_CODE.replace(a, broken) };
    }
  },
  {
    name: 'cron 不再追加补课（每周自动草稿漏排）', probe: 'cron',
    build: () => {
      const next = CRON_CODE.replace(/incomingDutyPlan\(sessions, wk, cfg, cal, shifts, week\)\.forEach\([^\n]*\n/, '');
      return next === CRON_CODE ? null : { cron: next };
    }
  }
];
mutants.forEach(mt => {
  const over = mt.build();
  if (!over) { check(false, '变异锚点没命中：' + mt.name); return; }
  const r = runWiring(over.sched || SCHED_CODE, over.cron || CRON_CODE);
  check(r[mt.probe] === false, '变异被抓：' + mt.name);
});
// 核心函数变异：去掉 weeks 归一
const coreBroken = CORE_CODE.replace("weeks: '', week_rule: 'ALL'", "weeks: s.weeks, week_rule: s.week_rule");
if (coreBroken !== CORE_CODE) {
  const fn2 = loadCore(coreBroken);
  const p2 = fn2(sessions, 13, {}, {}, shifts, weekStub);
  check(p2[0] && p2[0].s.weeks !== '', '变异被抓：补课 weeks 归一被删');
} else check(false, '变异锚点没命中：补课 weeks 归一');

console.log(failed === 0
  ? '\nOK · 跨周调课补课进入值日生成链路门禁全部通过'
  : '\nFAIL · 值日跨周调课门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
