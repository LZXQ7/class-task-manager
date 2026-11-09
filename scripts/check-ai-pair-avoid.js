/**
 * 门禁：AI 排班「X 号和 Y 号不安排在同一节课」硬约束
 * ------------------------------------------------------------
 * 2026-11-08 用户反馈：「我说了从 x 号开始，x 号和 x 号不安排在同一个值日，
 * 例如 1 号 2 号不安排在同一节课的值日，但是还是会把 1 号 2 号安排在一起」。
 *
 * 根因：AI 提示词的输出结构只有 assignments / unchanged / skipSeqs / notes，
 *   没有承载「两人不能同课次」的字段；而 assignments 明确**不采信**（validatePlan
 *   一律按「课次先后 + 序号从小到大」重新配对）。全体课取全局最小两号时，
 *   1、2 必然同课次。修法 = 本地确定性解析（parseAvoidPairs）+ 取人时硬过滤
 *   （pickBySeq 的 pairAvoid / sectionTaken），预览与落库各解析一次。
 *
 * 本脚本直接 require 真源码（不抄副本），并做**源码级变异自证**：
 *   把 round-robin.js 里的 `!blockedByPair(m.seq)` 去掉 / 把 validatePlan 的
 *   pairAvoid 传参去掉，症状断言必须翻红 —— 否则说明测试没承重。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FILE_RR = path.join(ROOT, 'cloudfunctions/common/round-robin.js');
const FILE_CORE = path.join(ROOT, 'cloudfunctions/common/schedule-core.js');
const FILE_SCHEDULE = path.join(ROOT, 'cloudfunctions/schedule/index.js');

const core = require(FILE_CORE);
const { buildState } = require(FILE_RR);
const validatePlan = core.validatePlan;
const parseStartSeqs = core.parseStartSeqs;
const applyStartFrom = core.applyStartFrom;
const parseAvoidPairs = core.parseAvoidPairs;

let fail = 0;
function check(label, cond, extra) {
  const okFlag = !!cond;
  if (!okFlag) fail++;
  console.log((okFlag ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   -> ' + extra : ''));
}

/** 12 人小名册：奇 A / 偶 B；3 个全体课次每节 2 人；游标从 0 开始。
 *  ⚠️ 必须是全体课（groupScope=null）——真实班级里 1、2 号分属 A/B 组，
 *  全体课取「全局序号最小两人」时才会把 1、2 排进同一节课（用户截图症状）。 */
function buildCtx(mut) {
  const roster = [];
  const idBySeq = new Map();
  for (let seq = 1; seq <= 12; seq++) {
    idBySeq.set(seq, 100 + seq);
    roster.push({ seq, name: '学生' + seq, group: seq % 2 === 1 ? 'A' : 'B' });
  }
  const sessions = [
    { sessionId: 1, date: '2026-11-09', dayText: '周一', period: 1, course: '课1', room: '410', groupScope: null, dutyCount: 2, existingDutySeqs: mut === 'keep' ? [1] : [], busySameDaySeqs: [] },
    { sessionId: 2, date: '2026-11-09', dayText: '周一', period: 2, course: '课2', room: '410', groupScope: null, dutyCount: 2, existingDutySeqs: [], busySameDaySeqs: [] },
    { sessionId: 3, date: '2026-11-10', dayText: '周二', period: 1, course: '课3', room: '410', groupScope: null, dutyCount: 2, existingDutySeqs: [], busySameDaySeqs: [] }
  ];
  return {
    roster, sessions,
    ctx: {
      cfg: {}, roster, sessions, idBySeq, weekStart: '2026-11-09',
      state: buildState(roster, { A: 0, B: 0 }),
      startCursors: { A: 0, B: 0 },
      avoidSameDay: false
    }
  };
}
const seqs = buildCtx().roster.map(r => r.seq);
const hasPair = (plan, a, b) => plan.some(p => p.memberSeqs.indexOf(a) >= 0 && p.memberSeqs.indexOf(b) >= 0);
const runPlan = (vp, text, raw, subMap, mut) => {
  const { ctx, roster, sessions } = buildCtx(mut);
  const pairs = parseAvoidPairs(text, roster.map(r => r.seq));
  applyStartFrom(ctx, parseStartSeqs(text, roster));
  return { v: vp(ctx, raw, subMap || {}, pairs), pairs, sessions };
};

/* ================= ① 自然语言解析 ================= */
console.log('\n=== ① parseAvoidPairs：各种口语写法 ===');
const positives = [
  ['1号和2号不安排在同一节课的值日', [[1, 2]]],
  ['1号2号不要排一起', [[1, 2]]],
  ['1号、2号不能同时值日', [[1, 2]]],
  ['5号和6号分开', [[5, 6]]],
  ['1号跟2号不排一节', [[1, 2]]],
  ['3号和4号不要排在一起', [[3, 4]]]
];
positives.forEach(([t, want]) => {
  const got = parseAvoidPairs(t, seqs);
  check('识别「' + t + '」', want.every(w => got.some(p => p[0] === w[0] && p[1] === w[1])), JSON.stringify(got));
});
const multi = parseAvoidPairs('1号和2号、3号和4号不要排一起', seqs);
check('一句里两对互斥只产生 2 对（不过度两两组合）', multi.length === 2, JSON.stringify(multi));
const negatives = [
  'A组从53开始，b组从52开始',
  '1号替换9号',
  '5号这周不值日',
  '从1号开始往后排',
  '3号请假',
  'A组23号之前全部排过了'
];
negatives.forEach(t => check('不误判「' + t + '」', parseAvoidPairs(t, seqs).length === 0,
  JSON.stringify(parseAvoidPairs(t, seqs))));
check('名册外的序号被丢弃', parseAvoidPairs('1号和99号不要排一起', seqs).length === 0);

/* ================= ② 用户症状（主回归） ================= */
console.log('\n=== ② 用户症状：1 号 2 号不得同课次 ===');
const TEXT = '从1号开始，1号和2号不安排在同一节课的值日';
const main = runPlan(validatePlan, TEXT, { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
console.log('  计划: ' + main.v.plan.map(p => '#' + p.sessionId + '[' + p.memberSeqs.join(',') + ']').join(' '));
check('USER SYMPTOM：没有任何课次同时排 1 号和 2 号', !hasPair(main.v.plan, 1, 2));
const flat = main.v.plan.reduce((a, p) => a.concat(p.memberSeqs), []);
check('1 号、2 号仍都排上值日（没被当成 skip）', flat.indexOf(1) >= 0 && flat.indexOf(2) >= 0);
check('每个课次人数仍等于 dutyCount（约束不造成缺人）',
  main.v.plan.every(p => p.memberSeqs.length === p.dutyCount));
check('计划覆盖全部 3 个课次', main.v.plan.length === main.sessions.length);
check('warnings 里明确告知已分开', main.v.warnings.some(w => /分开/.test(w)), main.v.warnings.join(' | '));

/* ③ 旧行为回归对照：不传约束时必须仍按序号连续取号（不破坏轮转） */
const baseline = runPlan(validatePlan, '', { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
check('不传约束时行为不变：第一节仍是 [1,2]（连续取号）',
  JSON.stringify(baseline.v.plan[0].memberSeqs) === JSON.stringify([1, 2]));

/* ④ 模型误把 2 号写进 skipSeqs（prompt 里已禁止，仍需兜底） */
const skipCase = runPlan(validatePlan, TEXT,
  { assignments: [], unchanged: [], skipSeqs: [2], notes: '' });
check('模型误写 skipSeqs=[2] 时，2 号仍被排上', skipCase.v.plan.some(p => p.memberSeqs.indexOf(2) >= 0));
check('误写 skip 时仍不违反互斥', !hasPair(skipCase.v.plan, 1, 2));

/* ⑤ 已有值日 keep=[1] 时，补空缺不能把 2 号补进来 */
const keepCase = runPlan(validatePlan, TEXT,
  { assignments: [], unchanged: [], skipSeqs: [], notes: '' }, {}, 'keep');
check('keep=[1] 的课次补人时避开其互斥伙伴 2 号', !hasPair(keepCase.v.plan, 1, 2),
  JSON.stringify(keepCase.v.plan[0].memberSeqs));

/* ⑥ 多对互斥同时生效 */
const pairsCase = runPlan(validatePlan, '1号和2号、3号和4号不要排一起',
  { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
check('两对互斥都不被违反', !hasPair(pairsCase.v.plan, 1, 2) && !hasPair(pairsCase.v.plan, 3, 4),
  pairsCase.v.plan.map(p => p.memberSeqs.join(',')).join(' | '));

/* ⑦ 替班替换不得破坏硬约束（宁可让替班不生效） */
const subCase = runPlan(validatePlan, TEXT,
  { assignments: [], unchanged: [], skipSeqs: [], notes: '' }, { 3: 2 });
check('替班把 2 号换进来时不会与 1 号同课次', !hasPair(subCase.v.plan, 1, 2),
  subCase.v.plan.map(p => p.memberSeqs.join(',')).join(' | '));

/* ================= ⑧ 预览 / 落库都重放约束 ================= */
console.log('\n=== ③ 预览与落库同源 ===');
const schedSrc = fs.readFileSync(FILE_SCHEDULE, 'utf8');
const vpCalls = schedSrc.match(/validatePlan\([\s\S]*?\);/g) || [];
check('aiPlan 与 aiApply 两处 validatePlan 都传入 avoidPairs',
  vpCalls.filter(c => /avoidPairs/.test(c)).length >= 2, 'calls=' + vpCalls.length);
check('aiApply 也把 subMap 传给 validatePlan（原来漏传，落库与预览不一致）',
  vpCalls.some(c => /subMap, avoidPairs/.test(c)));
check('两处都从原始 text 解析 avoidPairs',
  (schedSrc.match(/parseAvoidPairs\(text, seqs\)/g) || []).length >= 2);
check('AI 提示词明确禁止把互斥两人写进 skipSeqs',
  /不要.*skipSeqs|不要.*写进 skipSeqs/.test(schedSrc) && /规则 8/.test(schedSrc));

/* ================= ⑨ 源码级变异自证 ================= */
console.log('\n=== ④ 变异自证（去掉承重代码必须翻红） ===');
function loadCoreWith(rrSrc, coreSrc) {
  const rr = new Module(FILE_RR, module);
  rr.filename = FILE_RR;
  rr.paths = Module._nodeModulePaths(path.dirname(FILE_RR));
  rr._compile(rrSrc, FILE_RR);
  const cached = require.cache[FILE_RR];
  require.cache[FILE_RR] = rr;
  try {
    delete require.cache[FILE_CORE];
    const cm = new Module(FILE_CORE, module);
    cm.filename = FILE_CORE;
    cm.paths = Module._nodeModulePaths(path.dirname(FILE_CORE));
    cm._compile(coreSrc, FILE_CORE);
    return cm.exports;
  } finally {
    if (cached) require.cache[FILE_RR] = cached; else delete require.cache[FILE_RR];
    delete require.cache[FILE_CORE];
  }
}
const rrSrc = fs.readFileSync(FILE_RR, 'utf8');
const coreSrc = fs.readFileSync(FILE_CORE, 'utf8');
const mutRR = rrSrc.replace('&& !blockedByPair(m.seq)', '');
check('变异 A 确实改到了源码', mutRR !== rrSrc);
const mutCoreA = loadCoreWith(mutRR, coreSrc);
const mA = runPlan(mutCoreA.validatePlan, TEXT, { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
check('变异 A：去掉 pickBySeq 的互斥过滤 → 症状重现（断言承重）', hasPair(mA.v.plan, 1, 2));

const mutCoreSrc = coreSrc.replace('pairAvoid, sectionTaken: new Set(keep)', '');
check('变异 B 确实改到了源码', mutCoreSrc !== coreSrc);
const mutCoreB = loadCoreWith(rrSrc, mutCoreSrc);
const mB = runPlan(mutCoreB.validatePlan, TEXT, { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
check('变异 B：去掉 validatePlan 的约束传参 → 症状重现（断言承重）', hasPair(mB.v.plan, 1, 2));

console.log('\n=== ' + (fail ? 'RED: ' + fail + ' 项失败' : 'GREEN: 全部通过') + ' ===');
process.exit(fail ? 1 : 0);
