#!/usr/bin/env node
/**
 * 门禁：跨周调课的「调入侧（补课）」必须进入课前演讲场次（2026-11-28）
 * ================================================================
 * 用户原话：「把第八周 b 组下午第二节调到第十三周第一节了，课前演讲按序号轮转，
 *           第一节并没有安排」——课表能看到「自第8周调入」，演讲却没排那一场。
 *
 * 根因（M1 同源漏改）：演讲场次骨架三处（speechGenerate / speechAiParse /
 * loadSpeechSessions）都是内联构建，全用 week.resolveSlot —— 它只解析**源周调出**
 * （shiftKey(sid, 源周)），查不到「调到目标周」的记录；而课表端 course/index.js
 * 用 week.incomingOf(shifts, 目标周) 显式追加补课。缺了这一层 ⇒ 演讲漏排。
 * 第二层：补课课次的 weeks 只写了源周（如 '8'），即便追加也会被 buildSlots 的
 * matchesWeeks 在目标周(13)再过滤掉 ⇒ 必须把补课的 weeks 归一为「未指定」。
 *
 * 判据：
 *   ① 行为层：真实 week.js + 症状场景，验证 resolveSlot 漏/incomingOf 有/两层次都过；
 *   ② 接线层：新增的共享落位函数 speechSessionSlot / appendIncomingSpeechSessions
 *      在 loadSpeechSessions + speechGenerate + speechAiParse 三处都被调用，
 *      且三处不再内联 resolveSlot（否则将来又 drift）；
 *   ③ 变异自证：拿掉任一接线 / 去掉 weeks 归一 / 只改一处，对应判据必须翻红。
 *
 * 用法：node scripts/check-speech-crossweek-shift.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SCHEDULE = path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js');
const WEEK = path.join(ROOT, 'cloudfunctions', 'common', 'week.js');
const read = p => fs.readFileSync(p, 'utf8');
const stripJs = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, m) { console.log((cond ? '  ✓ ' : '  ✗ ') + m); if (!cond) failed++; }

const SCHEDULE_SRC = read(SCHEDULE);
const SCHEDULE_CODE = stripJs(SCHEDULE_SRC);

/* ============ ① 行为层：真实 week.js 复现 + 两层次验证 ============ */
const week = require(WEEK);

function behaviorProbes() {
  // 用户场景：第8周 B 组下午第2节(period=4) → 第13周第1节(period=1=AM)
  const session = { id: 901, day_of_week: 3, period: 4, group_scope: 'B', weeks: '8', week_rule: '' };
  const shifts = {
    [week.shiftKey(901, 8)]: {
      sessionId: 901, fromWeek: 8, kind: 'MOVE',
      toDay: 1, toPeriod: 1, toWeek: 13, note: '手动调课'
    }
  };
  const out = {};
  out.sourceOff = week.resolveSlot(901, 3, 4, 8, shifts) === null;          // 源周调出
  const inc = week.incomingOf(shifts, 13);
  out.targetIn = inc.length === 1 && inc[0].toDay === 1 && inc[0].toPeriod === 1; // 目标周调入选
  // 第二层次：源周 weeks 在目标周会被 matchesWeeks 挡掉 ⇒ 补课必须归一为空白
  out.weeksBlocked = !week.matchesWeeks(session.weeks, 13, session.week_rule);
  out.weeksNormalized = week.matchesWeeks('', 13, 'ALL') === true;         // 归一后必过
  return out;
}

/* ============ ② 接线层：抽函数验证三处同源 ============ */
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
function routeBody(js, name) {
  const anchor = '\n  ' + name + ': {';
  const i = js.indexOf(anchor);
  if (i < 0) return '';
  const rest = js.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const FNS = ['speechSessionSlot', 'appendIncomingSpeechSessions'];
const HELPER_SRC = FNS.map(n => fnSource(SCHEDULE_CODE, n)).join('\n');

/** vm 真跑共享落位函数 + 补课追加（注入 week 桩：用真实 week.js 行为） */
function runHelpers(src) {
  const ctx = {
    week: {
      resolveSlot: week.resolveSlot,
      matchesWeeks: week.matchesWeeks,
      classDateOf: () => '2026-12-07',
      incomingOf: week.incomingOf
    },
    speechCore: { AM_PERIOD: 1, PM_PERIOD: 3 },
    Object, Number, console
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.__slot = speechSessionSlot; this.__inc = appendIncomingSpeechSessions;', ctx);
  return ctx;
}

function wiringProbes(code) {
  const loadSess = fnSource(code, 'loadSpeechSessions');
  const gen = routeBody(code, 'speechGenerate');
  const ai = routeBody(code, 'speechAiParse');
  const out = {};
  out.helpersExist = FNS.every(n => !!fnSource(code, n));
  // 三处都调用了共享落位函数
  out.loadWired = /speechSessionSlot\s*\(/.test(loadSess) && /appendIncomingSpeechSessions\s*\(/.test(loadSess);
  out.genWired = /speechSessionSlot\s*\(/.test(gen) && /appendIncomingSpeechSessions\s*\(/.test(gen);
  out.aiWired = /speechSessionSlot\s*\(/.test(ai) && /appendIncomingSpeechSessions\s*\(/.test(ai);
  // 三处不再内联 resolveSlot（否则改造没落地，未来还会 drift）
  out.noInline = !/week\.resolveSlot\s*\(/.test(loadSess) &&
    !/week\.resolveSlot\s*\(/.test(gen) && !/week\.resolveSlot\s*\(/.test(ai);
  // 补课 weeks 归一为未指定（第二层次）
  out.weeksNorm = /weeks:\s*''[\s\S]{0,80}week_rule:\s*'ALL'/.test(fnSource(code, 'appendIncomingSpeechSessions'));
  return out;
}

/* ============ ③ 变异自证 ============ */
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
function runWiring(code) { return wiringProbes(code); }

console.log('── ① 行为层（真实 week.js · 用户症状场景）');
const bp = behaviorProbes();
check(bp.sourceOff, '源周第8周：resolveSlot 返回 null（调出）');
check(bp.targetIn, '目标周第13周：incomingOf 给出周一第1节补课');
check(bp.weeksBlocked, '第二层次：源周 weeks=8 在目标周13会被 matchesWeeks 挡掉');
check(bp.weeksNormalized, '归一 weeks="" + week_rule=ALL 后目标周必过');

console.log('── ② 共享函数行为（vm 真跑）');
const ctx = runHelpers(HELPER_SRC);
const sess = { id: 901, day_of_week: 3, period: 1, group_scope: 'B', weeks: '8', week_rule: '', courseName: '微课' };
const shifts = { [week.shiftKey(901, 8)]: { sessionId: 901, fromWeek: 8, kind: 'MOVE', toDay: 1, toPeriod: 1, toWeek: 13 } };
const incOut = [];
ctx.__inc(incOut, [sess], 13, {}, {}, shifts);
check(incOut.length === 1 && incOut[0].day_of_week === 1 && incOut[0].period === 1,
  'appendIncomingSpeechSessions 追加出周一第1节补课');
check(incOut.length === 1 && incOut[0].weeks === '' && incOut[0].week_rule === 'ALL',
  '补课 weeks 已归一为未指定（不会被 buildSlots 二次过滤）');
const normalItem = ctx.__slot({ id: 902, day_of_week: 5, period: 3, group_scope: 'A', weeks: '', week_rule: 'ALL' }, 13, {}, {}, {});
check(normalItem && normalItem.day_of_week === 5 && normalItem.period === 3,
  '常规课次照常落位（未破坏原行为）');
check(ctx.__slot({ id: 903, day_of_week: 1, period: 5, group_scope: 'ALL', weeks: '', week_rule: 'ALL' }, 13, {}, {}, {}) === null,
  '非演讲节次(第5节)仍被过滤');

console.log('── ③ 三处接线同源');
const wp = wiringProbes(SCHEDULE_CODE);
check(wp.helpersExist, '两个共享函数存在');
check(wp.loadWired, 'loadSpeechSessions 调用共享落位 + 补课追加');
check(wp.genWired, 'speechGenerate 调用共享落位 + 补课追加');
check(wp.aiWired, 'speechAiParse 调用共享落位 + 补课追加');
check(wp.noInline, '三处不再内联 resolveSlot（杜绝 M1 drift）');
check(wp.weeksNorm, '补课 weeks 归一逻辑在位');

console.log('── ④ 变异自证');
const mutants = [
  {
    name: 'speechGenerate 退回内联（只改一处 ⇒ 一键生成仍漏排补课）',
    expect: 'genWired',
    build: () => {
      const gen = routeBody(SCHEDULE_CODE, 'speechGenerate');
      if (!gen) return null;
      const broken = gen.replace(/appendIncomingSpeechSessions\(sessions, sessionRows, wk, cfg, cal, shifts\);/, '');
      if (broken === gen) return null;
      return SCHEDULE_CODE.replace(gen, broken);
    }
  },
  {
    name: '补课 weeks 归一被删（目标周被 matchesWeeks 二次挡掉）',
    expect: 'weeksNorm',
    build: () => mutate(SCHEDULE_CODE, "weeks: '', week_rule: 'ALL', class_date: classDate,", "weeks: s.weeks, week_rule: s.week_rule, class_date: classDate,")
  },
  {
    name: 'loadSpeechSessions 不再调用补课追加（设置页/排班板看不到补课）',
    expect: 'loadWired',
    build: () => mutate(SCHEDULE_CODE, 'appendIncomingSpeechSessions(out, rows, wk, cfg, cal, shifts);', '')
  },
  {
    name: 'speechAiParse 不再调用补课追加（智能排班预览漏补课）',
    expect: 'aiWired',
    build: () => mutate(SCHEDULE_CODE, 'appendIncomingSpeechSessions(sessions, sessionRows, wk, cfg, cal, shifts);', '')
  }
];
mutants.forEach(mt => {
  const code = mt.build();
  if (!code) { check(false, '变异锚点没命中：' + mt.name); return; }
  if (code === SCHEDULE_CODE) { check(false, '变异替换没生效：' + mt.name); return; }
  check(runWiring(code)[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0
  ? '\nOK · 跨周调课补课进入演讲场次门禁全部通过'
  : '\nFAIL · 跨周调课演讲门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
