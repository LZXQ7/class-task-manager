/**
 * 离线仿真 schedule.validatePlan
 * ------------------------------------------------------------
 * 为什么这么写：MCP 的 invokeFunction 没有 WX 上下文，auth 路由一律 40001，
 * 没法直接调 aiPlan 验证。而 validatePlan 是纯函数（只吃 ctx + raw），且已收口到
 * common/schedule-core.js（单一真源），直接 require 真源码模块测的就是生产代码本身。
 *
 * 覆盖 5 类硬规则 + 3 条兜底路径：
 *   ① 分组课排了别组的人     → 必须被拒
 *   ② 请假的同学             → **照常被排**（2026-10-07 口径变更：值日先排、后知请假，
 *                                请假的人自己在小程序申请换班，排班不做任何自动调整。
 *                                本脚本不再注入「请假违规」，并在文末对 rotationPick 单独验一遍）
 *   ③ 同一人同一天排两次     → 必须被拒
 *   ④ 编造不存在的序号       → 必须被拒
 *   ⑤ 同一人跨天排多次       → 必须被拒（2026-09-24 线上事故，见下方 §回归）
 *   ⑥ 排了本轮已排过的人     → 必须被拒（「一直往后排」）
 *   ⑦ AI 漏排某个课次        → 必须按序号轮转补齐
 *   ⑧ 人不够                → 必须补足或给出候选人不足告警
 *
 * §回归（2026-09-24）：用户报「周一第三节示例成员29、周二第一节还是示例成员29，示例成员25和示例成员26也重复」。
 * 根因：AI 指派分支只查了「同一课次内重复」和「同一天重复」，**跨天重复直接放行**。
 * 本脚本的「正常覆盖」数据曾用「每天从 1 号重新开始挑」的写法生成，正好也是跨天重复的，
 * 所以当时测不出这个 bug —— 现已改为按序号连续取号（与生产者逻辑一致），并显式注入跨天重复。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 2026-10-31：validatePlan 已收口到 common/schedule-core.js（与 generate/cron 同处单一真源），
// 直接 require 真源码模块即可测到生产代码本身（含 fillByRotation 等依赖，无需再 eval 抽取）。
const CORE_PATH = path.join(ROOT, 'cloudfunctions/common/schedule-core.js');
const core = require(CORE_PATH);
const validatePlan = core.validatePlan;
const parseSubMap = core.parseSubMap;
const parseStartSeqs = core.parseStartSeqs;
const applyStartFrom = core.applyStartFrom;

const RR_PATH = path.join(ROOT, 'cloudfunctions/common/round-robin.js');
const { pickBySeq: realPick, buildState: realBuild } = require(RR_PATH);

/* ---------------- 造数据集：56 人 / seq 1..56 / 奇=A 偶=B ---------------- */
function buildCtx(roundUsedSeqs) {
  const used = new Set(roundUsedSeqs || []);
  // 新内核用「数字游标」表达轮转位置：本轮已排过的人 = 序号 ≤ 游标。
  // 把 roundUsedSeqs 折算成 A/B 两组各自的最大已排序号，作为游标初值。
  const rUsed = roundUsedSeqs || [];
  const aOdds = rUsed.filter(s => s % 2 === 1);
  const bEvens = rUsed.filter(s => s % 2 === 0);
  const cursorA = aOdds.length ? Math.max.apply(null, aOdds) : 0;
  const cursorB = bEvens.length ? Math.max.apply(null, bEvens) : 0;
  const roster = [];
  const idBySeq = new Map();
  for (let seq = 1; seq <= 56; seq++) {
    idBySeq.set(seq, 100 + seq);
    roster.push({
      seq,
      name: '学生' + seq,
      group: seq % 2 === 1 ? 'A' : 'B',
      dutyCountThisRound: used.has(seq) ? 1 : 0,
      lastDutyAt: null
    });
  }

  /* 本周课次：周一~周五，每天 4 节，其中两节是分组课 */
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
  const sessions = [];
  let sid = 1;
  dates.forEach((date, di) => {
    for (let p = 1; p <= 4; p++) {
      sessions.push({
        sessionId: sid,
        date,
        dayOfWeek: di + 1,
        dayText: '周' + '一二三四五'[di],
        period: p,
        course: '课程' + sid,
        room: '3号楼10' + p,
        groupScope: p <= 2 ? (p === 1 ? 'A' : 'B') : null,
        dutyCount: 2,
        existingDutySeqs: [],
        // 周三第 1 节（sid=9）预置 7 号已被占用，用来验证同日去重
        // ⚠️ 不再有 onLeaveSeqs：2026-10-07 起请假不参与排班（见下方 §请假口径）
        busySameDaySeqs: sid === 9 ? [7] : []
      });
      sid++;
    }
  });
  return {
    ctx: {
      cfg: {}, roster, sessions, seqById: new Map(), idBySeq, weekStart: dates[0],
      // 轮转内核依赖 ctx.state（游标 + 本轮已排集合）；由真实 round-robin.buildState 构建
      state: realBuild(roster, { A: cursorA, B: cursorB }),
      // 记录初始游标，供「二次校验幂等性」复位 state（validatePlan 会就地推进游标）
      _initCursors: { A: cursorA, B: cursorB }
    },
    roster, sessions
  };
}

/**
 * 造一份「正确的 AI 回答」：按序号连续取号，**全局不重复**（这才是模型该给的答案）。
 * 注意 usedSeqs 会跨课次累计 —— 上一版脚本每天从 1 号重新挑，本身就带着跨天重复，
 * 导致这个 bug 一直测不出来。
 */
function buildGoodAssignments(roster, sessions, roundUsedSeqs) {
  const blockedRound = new Set(roundUsedSeqs || []);
  const usedPlan = new Set();
  const usedSameDay = {};
  let ptr = 1;
  const nextSeq = (pred) => {
    for (let seq = ptr; seq <= 56; seq++) {
      const r = roster.find(x => x.seq === seq);
      if (!r || usedPlan.has(seq) || blockedRound.has(seq)) continue;
      if (pred && !pred(r)) continue;
      ptr = seq + 1;
      return seq;
    }
    return null;
  };
  return sessions.map(s => {
    const day = usedSameDay[s.date] = usedSameDay[s.date] || new Set(s.busySameDaySeqs);
    const picked = [];
    while (picked.length < s.dutyCount) {
      // 请假不再过滤（2026-10-07 口径）：这里也不再排除 onLeave
      const seq = nextSeq(r => (!s.groupScope || r.group === s.groupScope)
        && !day.has(r.seq));
      if (seq === null) break;                       // 本轮剩下的号不够 → 交给补齐路径
      picked.push(seq);
      usedPlan.add(seq);
      day.add(seq);
    }
    return { sessionId: s.sessionId, memberSeqs: picked, reason: '轮转' };
  });
}

/* ---------------- 跑 ---------------- */
let fail = 0;
function check(label, cond, extra) {
  const okFlag = !!cond;
  if (!okFlag) fail++;
  console.log((okFlag ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}
function summarize(tag, ctx, raw, subMap) {
  const v = validatePlan(ctx, raw, subMap);
  const dupAcrossPlan = [];
  const seen = new Set();
  v.plan.forEach(p => p.memberSeqs.forEach(q => { if (seen.has(q)) dupAcrossPlan.push(q); else seen.add(q); }));
  console.log('\n[' + tag + ']');
  console.log('  plan 条数:', v.plan.length);
  v.warnings.slice(0, 4).forEach(w => console.log('   ·', w));
  if (v.warnings.length > 4) console.log('   · …还有 ' + (v.warnings.length - 4) + ' 条');
  return { v, dupAcrossPlan };
}

/* ========== 场景 1：主场景（含 5 类违规注入） ========== */
console.log('=== 场景 1：正常覆盖 + 违规注入 ===');
const { ctx, roster, sessions } = buildCtx([]);
const byId = new Map(sessions.map(s => [s.sessionId, s]));
const assignments = buildGoodAssignments(roster, sessions, []);

// ① + ④ 跨组 / 不存在的序号
assignments.find(a => a.sessionId === 5).memberSeqs = [2, 999, 1];
// ② 请假（新口径：不再注入违规 —— 请假的同学本来就该被排上）
// ③ 同日重复（7 号当天已被占用）
assignments.find(a => a.sessionId === 9).memberSeqs = [7, 3];
// ⑤ skipSeqs 被写进指派
assignments.find(a => a.sessionId === 3).memberSeqs = [56, 3];
// ⑦ 漏排：删掉 sid=20
const missingIdx = assignments.findIndex(a => a.sessionId === 20);
assignments.splice(missingIdx, 1);

/**
 * ⚠️ 这一行必须在上面所有注入**之后**。
 * 旧版把 raw 建在注入之前（且 `{...a}` 只浅拷贝，memberSeqs 仍是同一份引用，
 * 后面又是整个替换属性），于是注入根本进不到 raw 里 —— 场景 1 名义上在测
 * 「5 类违规注入」，实际上跑的是没被污染的正确答案。
 * 修正后注入真实生效：现在断言的是「AI 无论写得多离谱，计划都不会违规」，
 * 因为 AI 的人选已完全不参与配对（2026-09-24 起配对顺序由本地决定）。
 */
const raw = { assignments: assignments.map(a => ({ sessionId: a.sessionId, memberSeqs: (a.memberSeqs || []).slice() })), skipSeqs: [56], notes: '测试用' };

const s1 = summarize('场景 1', ctx, raw);
const v = s1.v;
const get = id => v.plan.find(p => p.sessionId === id);

console.log('\n--- 断言 ---');
check('每个课次都出现在计划里', v.plan.length === 20 && v.plan.every(p => byId.has(p.sessionId)));
check('计划的课次无重复', new Set(v.plan.map(p => p.sessionId)).size === 20);
check('每人每个课次人数 ≤ dutyCount', v.plan.every(p => (p.memberSeqs || []).length <= p.dutyCount));
check('#5 非法序号 999 被剔除', !get(5).memberSeqs.includes(999));
check('#5 跨组学生 2 被剔除', !get(5).memberSeqs.includes(2), '成员=' + JSON.stringify(get(5).memberSeqs));
check('#13 仍补齐到 dutyCount（请假不再影响排班）', get(13).memberSeqs.length === byId.get(13).dutyCount,
  '成员=' + JSON.stringify(get(13).memberSeqs));
check('#9 当天已占用的 7 号未重复排', !get(9).memberSeqs.includes(7), '成员=' + JSON.stringify(get(9).memberSeqs));
check('#20 漏排已被补齐', !!get(20), get(20) ? '成员=' + JSON.stringify(get(20).memberSeqs) + ' reason=' + get(20).reason : '缺失');
check('#3 被跳过的 56 号不在 AI 指派里', !get(3).memberSeqs.includes(56), '成员=' + JSON.stringify(get(3).memberSeqs));
check('#3 剔除跳过号后仍补齐到 dutyCount', get(3).memberSeqs.length === 2, '成员=' + JSON.stringify(get(3).memberSeqs));

// 全局硬规则
const groupViolation = v.plan.filter(p => {
  const s = byId.get(p.sessionId);
  if (!s.groupScope) return false;
  return p.memberSeqs.some(seq => (roster.find(r => r.seq === seq) || {}).group !== s.groupScope);
});
check('无任何分组违规', groupViolation.length === 0, JSON.stringify(groupViolation.map(p => p.sessionId)));

const dayDup = [];
const used = {};
v.plan.forEach(p => {
  used[p.date] = used[p.date] || new Set();
  p.memberSeqs.forEach(seq => { if (used[p.date].has(seq)) dayDup.push(p.date + '#' + seq); used[p.date].add(seq); });
});
check('计划内无同日重复', dayDup.length === 0, JSON.stringify(dayDup));

/* ── §请假口径（2026-10-07 产品变更）─────────────────────────────────
 * 值日先排、之后才知道谁请假；请假的同学**照常被排上**，再由他自己找人换班
 * （小程序内「申请换班」）。新内核 pickBySeq 的 opt 里**根本没有 onLeave** 这个参数，
 * 物理上不可能因请假跳过任何人。
 *
 * 判据锁「意图」：**直接跑真源码 round-robin.js 的 pickBySeq**（不是复刻），
 * 并做双向自证 —— 好样本里请假者必须被选中；把过滤加回内核后他必须被跳过。 */
const RR_SRC = fs.readFileSync(RR_PATH, 'utf8');

/** 从源码字符串 eval 出一个 round-robin 模块（用于变异自证） */
function loadRR(src) {
  const module_ = { exports: {} };
  const fn = new Function('module', 'exports', src + '\n return module.exports;');
  return fn(module_, module_.exports);
}

const mkRoster = () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(seq => ({
  id: 100 + seq, seq, group: seq % 2 === 1 ? 'A' : 'B', mark: 0, name: '学生' + seq
}));

const LEAVE_SEQS = [1, 3];                          // 1 号、3 号当天请假（都是 A 组）
const pickedReal = realPick(mkRoster(), null, 4, realBuild(mkRoster(), { A: 0, B: 0 }), {})
  .chosen.map(m => m.seq);
check('请假的同学照常被排上（内核无 onLeave 过滤）',
  LEAVE_SEQS.every(s => pickedReal.indexOf(s) >= 0), '选中序号=' + JSON.stringify(pickedReal));

/* 代码卫生：内核源码里不得出现 onLeave（证明请假不被过滤） */
check('自证：源码卫生（round-robin.js 不含 onLeave 过滤）', !/onLeave/.test(RR_SRC));

/* 变异自证：把 onLeave 过滤加回内核 usable，请假的人必须被跳过 ⇒ 判据抓得住 */
const USABLE_ANCHOR = "const usable = (m) => !avoid.has(m.seq) && !localTaken.has(m.seq)";
check('自证：源码锚点存在（防漂移）', RR_SRC.indexOf(USABLE_ANCHOR) >= 0);
const MUTATED_SRC = RR_SRC.replace(USABLE_ANCHOR, USABLE_ANCHOR + " && !(o.onLeave && o.onLeave.has(m.seq))");
check('自证：变异真的发生了', MUTATED_SRC !== RR_SRC);
const mutRR = loadRR(MUTATED_SRC);
const stMut = mutRR.buildState(mkRoster(), { A: 0, B: 0 });
const pickedMutated = mutRR.pickBySeq(mkRoster(), null, 4, stMut, { onLeave: new Set(LEAVE_SEQS) })
  .chosen.map(m => m.seq);
check('自证：把 onLeave 过滤加回内核后，请假的人被跳过 ⇒ 判据抓得住',
  LEAVE_SEQS.every(s => pickedMutated.indexOf(s) < 0), '选中序号=' + JSON.stringify(pickedMutated));

check('skipSeqs 中的 56 号未被排', v.plan.every(p => !p.memberSeqs.includes(56)));

const short = v.plan.filter(p => p.memberSeqs.length < p.dutyCount).map(p => p.sessionId + ':' + p.memberSeqs.length + '/' + p.dutyCount);
check('除候选人不足外均已补齐', short.length === 0, JSON.stringify(short));

const badIds = v.plan.filter(p => p.memberIds.some((id, i) => id !== ctx.idBySeq.get(p.memberSeqs[i])));
check('memberIds 与 memberSeqs 一致', badIds.length === 0);

/* ========== 场景 2：回归 —— 同一人被 AI 排进两个不同日期（线上事故复现） ========== */
console.log('\n=== 场景 2：回归 · 跨天重复（线上事故复现） ===');
// 直接复刻截图：25/26 号（示例成员25/示例成员26）被塞进周一第2节、周二第2节、周三第3节
const c2 = buildCtx([]);
const a2 = buildGoodAssignments(c2.roster, c2.sessions, []);
a2.find(a => a.sessionId === 1).memberSeqs = [25, 27];   // 周一第2节 A组：25=示例成员25 27=示例成员27
a2.find(a => a.sessionId === 2).memberSeqs = [26, 28];   // 周一第4节 B组：26=示例成员26 28=示例成员28
a2.find(a => a.sessionId === 3).memberSeqs = [29, 30];   // 周一第3节 全体：29=示例成员29 30=示例成员30
a2.find(a => a.sessionId === 5).memberSeqs = [29, 31];   // 周二第1节 A组：29 重复！
a2.find(a => a.sessionId === 6).memberSeqs = [25, 26];   // 周二第2节 全体：25/26 重复！
a2.find(a => a.sessionId === 9).memberSeqs = [30, 32];   // 周三第1节 B组：30 重复！
a2.find(a => a.sessionId === 11).memberSeqs = [25, 26];  // 周三第3节 全体：25/26 再次重复！

const s2 = summarize('场景 2', c2.ctx, { assignments: a2, skipSeqs: [], notes: '跨天重复复现' });
const hits2 = (seq) => s2.v.plan.filter(p => p.memberSeqs.includes(seq)).length;
check('25 号（示例成员25）只被排 1 次', hits2(25) === 1, '实际 ' + hits2(25) + ' 次');
check('26 号（示例成员26）只被排 1 次', hits2(26) === 1, '实际 ' + hits2(26) + ' 次');
check('29 号（示例成员29）只被排 1 次', hits2(29) === 1, '实际 ' + hits2(29) + ' 次');
check('30 号（示例成员30）只被排 1 次', hits2(30) === 1, '实际 ' + hits2(30) + ' 次');
check('整份计划内没有任何序号出现两次', s2.dupAcrossPlan.length === 0, JSON.stringify(s2.dupAcrossPlan));
// 新模型下 AI 的人选不参与配对，不会再产生「被拒」告警；
// 改为直接断言结果性质：20 节 × 2 人 = 40 个名额，正好等于「连续取号 1~40」。
const s2seqs = Array.from(new Set(s2.v.plan.flatMap(p => p.memberSeqs))).sort((a, b) => a - b);
check('AI 的跨天重复方案未被采纳：计划正好是连续取号 1~40（无跳号、无重复）',
  String(s2seqs) === String(Array.from({ length: 40 }, (_, i) => i + 1)),
  '实际 ' + s2seqs.length + ' 人：' + JSON.stringify(s2seqs.slice(0, 12)) + '…');
check('所有课次仍补齐到 dutyCount', s2.v.plan.every(p => p.memberSeqs.length === p.dutyCount),
  JSON.stringify(s2.v.plan.filter(p => p.memberSeqs.length !== p.dutyCount).map(p => p.sessionId)));

/* ========== 场景 3：本轮已排过的人不该回头被点（「一直往后排」+ 排完开新一轮） ========== */
console.log('\n=== 场景 3：本轮已排过的人被 AI 重新点名 ===');
/**
 * 前 24 号本轮已排过 → 应拒掉并继续从 25 号往后排。
 * 本周 20 个课次 × 2 人 = 40 个名额，而「本轮未排」只剩 25~56 共 32 人：
 *   · 前 32 个名额 = 25~56（本轮没排过的先用完）
 *   · 剩下 8 个名额 → 本轮 56 人已轮完一遍 → **开新一轮**，从 1 号继续
 * 所以最终 1 号、3 号会再次出现，但必须是「新一轮」的连续小号，且全计划内不重复。
 * （上一版断言要求「1/3 号绝不出现」，是把 40 个名额错算成 18 个，属断言写错。）
 */
const roundUsed = [];
for (let i = 1; i <= 24; i++) roundUsed.push(i);
const c3 = buildCtx(roundUsed);
const a3 = buildGoodAssignments(c3.roster, c3.sessions, roundUsed);
// 1 号（本轮已排过）被错误重新点名；同时制造一处空缺让它去补
a3.find(a => a.sessionId === 1).memberSeqs = [1, 3];
const c3v = summarize('场景 3', c3.ctx, { assignments: a3, skipSeqs: [], notes: '本轮已排过' });
const c3plan = c3v.v.plan;
const c3seqs = Array.from(new Set(c3plan.flatMap(p => p.memberSeqs))).sort((a, b) => a - b);
const c3slots = c3plan.reduce((a, p) => a + p.memberSeqs.length, 0);
// 新模型下 AI 的人选不参与配对，不会再产生「被拒」告警。
// 改为直接断言语义：靠前的 32 个名额必须全部是「本轮未排过」的 25~56 号。
const c3chrono = c3plan.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
const c3first32 = [];
for (const p of c3chrono) { for (const q of p.memberSeqs) { if (c3first32.length < 32) c3first32.push(q); } }
check('前 32 个名额全是本轮未排过的 25~56 号（AI 回头点 1/3 号未被采纳）',
  c3first32.every(q => q >= 25), JSON.stringify(c3first32.filter(q => q < 25)));
check('40 个名额全部排满', c3slots === 40, '实际 ' + c3slots);
check('本轮未排的 25~56 号全部被排到（先用完没排过的）',
  Array.from({ length: 32 }, (_, i) => 25 + i).every(q => c3seqs.indexOf(q) >= 0),
  '缺失 ' + JSON.stringify(Array.from({ length: 32 }, (_, i) => 25 + i).filter(q => c3seqs.indexOf(q) < 0)));
check('告警写明已开新一轮', c3v.v.warnings.some(w => w.indexOf('新一轮') >= 0),
  JSON.stringify(c3v.v.warnings.filter(w => w.indexOf('新一轮') >= 0)));
check('新一轮只从最小序号开始补（1~8 号）',
  c3seqs.filter(q => q < 25).every(q => q <= 8), JSON.stringify(c3seqs.filter(q => q < 25)));
check('1 号只被排 1 次（没被重复安排）', c3plan.filter(p => p.memberSeqs.includes(1)).length === 1);
check('3 号只被排 1 次（没被重复安排）', c3plan.filter(p => p.memberSeqs.includes(3)).length === 1);
check('计划内仍无任何重复序号', c3v.dupAcrossPlan.length === 0, JSON.stringify(c3v.dupAcrossPlan));

/* ========== 场景 4：unchanged 的人也不能被其它课次再排 ========== */
console.log('\n=== 场景 4：保持原样的课次占住名额 ===');
const c4 = buildCtx([]);
const a4 = buildGoodAssignments(c4.roster, c4.sessions, []);
// 周一 4 节全部保持原样，原班人马 1,3 / 2,4 / 5,6 / 7,8
c4.sessions.filter(s => s.date === '2026-09-28').forEach(s => {
  s.existingDutySeqs = roster.filter(r => r.seq >= s.sessionId * 2 - 1 && r.seq <= s.sessionId * 2).map(r => r.seq);
});
a4.find(a => a.sessionId === 5).memberSeqs = [1, 5];   // 周二第1节 妄图再用周一的人
const c4v = summarize('场景 4', c4.ctx, {
  assignments: a4, unchanged: c4.sessions.filter(s => s.date === '2026-09-28').map(s => s.sessionId), notes: ''
});
check('unchanged 课次被原样保留', c4v.v.plan.filter(p => p.kept).length === 4);
check('unchanged 的人没有出现在其它课次', c4v.v.plan.filter(p => !p.kept)
  .every(p => p.memberSeqs.every(q => q > 8)), JSON.stringify(c4v.v.plan.filter(p => !p.kept).map(p => p.memberSeqs)));
check('计划内仍无任何重复序号', c4v.dupAcrossPlan.length === 0, JSON.stringify(c4v.dupAcrossPlan));

/* ========== 场景 5：幂等性 —— 预览的计划再校验一次必须一字不变 ========== */
/**
 * 为什么必须测：aiPlan 先本地校验一次给用户看，点「应用到本周」时
 * aiApply 会把这份计划再送到服务端校验一遍（客户端数据不可信）。
 * 如果第二次校验会改动人选，就出现「预览是一批人、落库是另一批人」的诡异现象。
 * 这里对场景 1（含违规注入 + 补齐）和场景 3（含开新一轮）各重跑一次校验。
 */
console.log('\n=== 场景 5：幂等性（预览 == 应用） ===');
function revalidate(tag, ctx, first) {
  // validatePlan 会就地推进 ctx.state（游标 + 本轮已排集合），必须复位到初始游标，
  // 否则第二次校验会从上一次推进后的游标继续取人，结果与首次不一致（破坏幂等性）。
  ctx.state = realBuild(ctx.roster, ctx._initCursors);
  const again = validatePlan(ctx, {
    assignments: first.plan.map(p => ({ sessionId: p.sessionId, memberSeqs: p.memberSeqs.slice() })),
    skipSeqs: first.skipSeqs,
    notes: ''
  });
  const before = new Map(first.plan.map(p => [p.sessionId, p.memberSeqs.slice().sort((a, b) => a - b).join(',')]));
  const diff = again.plan.filter(p => before.get(p.sessionId) !== p.memberSeqs.slice().sort((a, b) => a - b).join(','));
  check(tag + '：二次校验结果完全一致', diff.length === 0,
    JSON.stringify(diff.map(p => p.sessionId + ': ' + before.get(p.sessionId) + ' → ' + p.memberSeqs.join(',')).slice(0, 6)));
  check(tag + '：二次校验后仍无重复序号', again.plan.every(p => p.memberSeqs.length === p.dutyCount));
}
// 场景 1 的 ctx 被复用（validatePlan 只读 ctx，不改），直接用
revalidate('场景 1', ctx, v);
revalidate('场景 3', c3.ctx, c3v.v);

/* ========== 场景 6：回归 · 手动预排（existingDutySeqs）不能被 AI 又排一遍（2026-10-31 修复） ========== */
console.log('\n=== 场景 6：手动预排不被 AI 重复排 ===');
/**
 * 复现用户原话：本轮轮到 51/53 号、手动安排了 1/3 号 → 手动预排的 1/3 必须留在原课次，
 * 且「轮转绕回」时不能再把 1/3 又排进别的课次（旧版会出现 …55、1、3、5 这类重复）。
 * 根因：非「保持原样」课次里的 existingDutySeqs（手动值日）此前没并入去重集合，
 * 修复后所有 existingDutySeqs 都并入去重（seedUsedFromExisting）。
 * 注：本数据集 dutyCount=2，故「手动保留 + 补空缺」表现为 sid=1 保留 1 号并补 1 个轮转号。
 */
const roundUsed6 = [];
for (let i = 1; i <= 50; i++) roundUsed6.push(i);   // 本轮已排 1..50 → 游标落在 51/53
const c6 = buildCtx(roundUsed6);
// 周一第 1 节（sid=1，A 组，dutyCount=2）手动预排了 1 号；周一第 2 节（sid=2，B 组）手动预排了 2 号
c6.sessions.find(s => s.sessionId === 1).existingDutySeqs = [1];
c6.sessions.find(s => s.sessionId === 2).existingDutySeqs = [2];
// AI 没特别指定（assignments 留空，让本地按轮转补齐）
const a6 = c6.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s6 = summarize('场景 6', c6.ctx, { assignments: a6, skipSeqs: [], notes: '手动预排' });
const get6 = id => s6.v.plan.find(p => p.sessionId === id);
check('sid=1 保留了手动预排的 1 号', get6(1).memberSeqs.includes(1), '成员=' + JSON.stringify(get6(1).memberSeqs));
check('sid=1 补齐到 dutyCount=2', get6(1).memberSeqs.length === 2, '成员=' + JSON.stringify(get6(1).memberSeqs));
check('sid=2 保留了手动预排的 2 号', get6(2).memberSeqs.includes(2), '成员=' + JSON.stringify(get6(2).memberSeqs));
check('sid=2 补齐到 dutyCount=2', get6(2).memberSeqs.length === 2, '成员=' + JSON.stringify(get6(2).memberSeqs));
// 关键：手动预排的 1/2 不得出现在其它任何课次（绕回也不会再排）
const leak6 = s6.v.plan.filter(p => p.sessionId !== 1 && p.sessionId !== 2 && (p.memberSeqs.includes(1) || p.memberSeqs.includes(2)));
check('1/2 号未泄漏到其它课次（无重复排）', leak6.length === 0, JSON.stringify(leak6.map(p => p.sessionId + ':' + p.memberSeqs)));
check('全计划内 1 号只出现 1 次', s6.v.plan.filter(p => p.memberSeqs.includes(1)).length === 1);
check('全计划内 2 号只出现 1 次', s6.v.plan.filter(p => p.memberSeqs.includes(2)).length === 1);

/* ========== 场景 7：AI 指令「X号替换Y号」替班（9 本轮不值日、1 顶上） ========== */
console.log('\n=== 场景 7：替班指令「X号替换Y号」 ===');
// 先对 parseSubMap 做单测
check('parseSubMap 主动式 1号替换9号 → {9:1}',
  JSON.stringify(parseSubMap('1号替换9号', c6.roster.map(r => r.seq))) === JSON.stringify({ 9: 1 }));
check('parseSubMap 用2号换5号 → {5:2}',
  JSON.stringify(parseSubMap('用2号换5号', c6.roster.map(r => r.seq))) === JSON.stringify({ 5: 2 }));
check('parseSubMap 被动式 9号被1号替换 → {9:1}',
  JSON.stringify(parseSubMap('9号被1号替换', c6.roster.map(r => r.seq))) === JSON.stringify({ 9: 1 }));
check('parseSubMap 3号顶4号 → {4:3}',
  JSON.stringify(parseSubMap('3号顶4号', c6.roster.map(r => r.seq))) === JSON.stringify({ 4: 3 }));
check('parseSubMap 不在名册的序号被忽略',
  JSON.stringify(parseSubMap('99号替换100号', c6.roster.map(r => r.seq))) === JSON.stringify({}));
check('parseSubMap 自己替换自己被忽略',
  JSON.stringify(parseSubMap('1号替换1号', c6.roster.map(r => r.seq))) === JSON.stringify({}));

// 端到端：1号替换9号，9 本轮不值日、轮到 9 的位子由 1 顶上
const c7 = buildCtx([]);   // 游标 0，轮转从 1 开始，9 必然被排到
const subMap7 = parseSubMap('1号替换9号', c7.roster.map(r => r.seq));
check('subMap7 = {9:1}', JSON.stringify(subMap7) === JSON.stringify({ 9: 1 }));
const a7 = c7.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s7 = summarize('场景 7', c7.ctx, { assignments: a7, skipSeqs: [], notes: '1号替换9号' }, subMap7);
const hits7 = seq => s7.v.plan.filter(p => p.memberSeqs.includes(seq)).length;
check('9 号本轮完全不被排（替班生效：9 这一轮没有值日）', hits7(9) === 0, '9 出现 ' + hits7(9) + ' 次');
check('1 号至少值日两次（自己一轮 + 顶替 9 号）', hits7(1) >= 2, '1 出现 ' + hits7(1) + ' 次');
// 9 原本该在的位子如今是 1（即某课次里 1 顶替了 9）
check('存在「1 顶替 9」的课次（9 的位子被 1 占了）',
  s7.v.plan.some(p => p.memberSeqs.includes(1) && !p.memberSeqs.includes(9)) && hits7(1) >= 2);

/* ========== 场景 8：既有值日行「同一人重复」（示例成员56、示例成员56）必须去重 ========== */
console.log('\n=== 场景 8：同课次既有值日重复行必须去重 ===');
/**
 * 用户截图实锤：某课次 existingDutySeqs 里同一个人出现两次（历史脏数据/重复行），
 * 旧版 keep = existingDutySeqs.slice(0,dutyCount) 原样带出 →「示例成员56、示例成员56」。
 * 修复：keep 先去重再截断。
 */
const c8 = buildCtx([]);
c8.sessions.find(s => s.sessionId === 1).existingDutySeqs = [3, 3];  // 同一人两次（sid=1, dutyCount=2）
const a8 = c8.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s8 = summarize('场景 8', c8.ctx, { assignments: a8, skipSeqs: [], notes: '重复行' });
const get8 = id => s8.v.plan.find(p => p.sessionId === id);
const uniq8 = new Set(get8(1).memberSeqs);
check('sid=1 同课次内无重复人', uniq8.size === get8(1).memberSeqs.length,
  '成员=' + JSON.stringify(get8(1).memberSeqs));
check('sid=1 人数仍为 dutyCount=2（去重后补一个轮转号）',
  get8(1).memberSeqs.length === 2, '成员=' + JSON.stringify(get8(1).memberSeqs));
check('全计划不存在同课次重复',
  s8.v.plan.every(p => new Set(p.memberSeqs).size === p.memberSeqs.length));

/* ========== 场景 9：既有数据超名额塞满（旧脏数据/旧 AUTO）不得抽干候选池 ========== */
console.log('\n=== 场景 9：超名额的既有数据不得让其余课次「未排」 ===');
/**
 * 用户截图实锤：旧版 seedUsedFromExisting 把 existingDutySeqs **全量**并入去重集合
 * （不按 dutyCount 截断），旧脏数据在 5 个课次里塞了 50 人 → 候选池被抽干 →
 * 其余课次全部「未排 / 候选人不足」。修复：按 dutyCount 截断 + 去重。
 * 注：真实链路里 AUTO 已在 buildAiContext 被过滤，这里直接注入超量 existing 测 seed 截断兜底。
 */
const c9 = buildCtx([]);
[1, 2, 3, 4, 5].forEach((sid, i) => {
  c9.sessions.find(s => s.sessionId === sid).existingDutySeqs =
    Array.from({ length: 10 }, (_, k) => i * 10 + k + 1); // 每节塞 10 人（>> dutyCount=2）
});
const a9 = c9.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s9 = summarize('场景 9', c9.ctx, { assignments: a9, skipSeqs: [], notes: '超名额既有数据' });
check('所有课次都排上（无 0 人课次）', s9.v.plan.every(p => p.memberSeqs.length > 0),
  '未排=' + s9.v.plan.filter(p => !p.memberSeqs.length).map(p => p.sessionId).join(','));
check('没有任何「候选人不足」告警', !s9.v.warnings.some(w => w.indexOf('候选人不足') >= 0),
  s9.v.warnings.join(' | ').slice(0, 120));
check('每课次人数都不超过 dutyCount', s9.v.plan.every(p => p.memberSeqs.length <= p.dutyCount));

/* ========== 场景 10：AI 把「本轮已轮过」写进 skipSeqs 不得抽干候选池 ========== */
console.log('\n=== 场景 10：skipSeqs 里的「已轮过」冗余项必须被忽略 ===');
/**
 * 用户截图实锤（2026-10-31 16:17，第 9 周 11/9–11/15）：
 *   19 个课次里 16 个「未排 / 候选人不足」，告警刷出「本轮跳过 1、2、…、51 号」，
 *   且「56 号在本次计划里被排了多次」。
 * 根因：空文本点「智能排班」时，模型按提示词把 roster 里 dutyCountThisRound=1（本轮已轮过）
 *   的人写进 skipSeqs；而 pickBySeq 会把 skipSeqs 的人**从候选池物理删除** →
 *   A 组只剩 53/55 两人，剩余名额全部排不满。
 * 修复：validatePlan 剔除「本轮已排 / 已有值日」的冗余跳过项 + 可行性兜底。
 */
const roundUsed10 = [];
for (let i = 1; i <= 51; i++) roundUsed10.push(i);   // A 游标 51 / B 游标 50，与截图一致
const c10 = buildCtx(roundUsed10);
const skipAll10 = roundUsed10.slice();               // 模型原样把 1..51 写进 skipSeqs
const a10 = c10.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s10 = summarize('场景 10', c10.ctx, { assignments: a10, skipSeqs: skipAll10, notes: '空文本' });
check('所有课次都排上（无「未排」）', s10.v.plan.every(p => p.memberSeqs.length > 0),
  '未排=' + s10.v.plan.filter(p => !p.memberSeqs.length).map(p => p.sessionId).join(','));
check('没有任何「候选人不足」告警',
  !s10.v.warnings.some(w => w.indexOf('候选人不足') >= 0),
  s10.v.warnings.join(' | ').slice(0, 120));
check('每课次人数正好等于 dutyCount',
  s10.v.plan.every(p => p.memberSeqs.length === p.dutyCount));
check('同课次内无重复人',
  s10.v.plan.every(p => new Set(p.memberSeqs).size === p.memberSeqs.length));
const cnt10 = new Map();
s10.v.plan.forEach(p => p.memberSeqs.forEach(q => cnt10.set(q, (cnt10.get(q) || 0) + 1)));
check('全计划内没有任何人被排两次（不再出现「56 号被排了多次」）',
  Array.from(cnt10.values()).every(n => n === 1),
  '重复=' + Array.from(cnt10.entries()).filter(([, n]) => n > 1).map(([q]) => q).join(','));
check('告警说明了「已轮过的人无需再跳过」',
  s10.v.warnings.some(w => w.indexOf('无需再跳过') >= 0));

// 10b：跳过人数多到「真的排不满」时必须自动解禁，绝不留下空课次
const c10b = buildCtx([]);                            // 游标 0：1..51 都还没轮过，属「真跳过」
const a10b = c10b.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s10b = summarize('场景 10b', c10b.ctx, { assignments: a10b, skipSeqs: skipAll10, notes: '' });
check('跳过过多时自动解禁，仍然排满所有课次',
  s10b.v.plan.every(p => p.memberSeqs.length === p.dutyCount),
  '未排=' + s10b.v.plan.filter(p => p.memberSeqs.length !== p.dutyCount).map(p => p.sessionId).join(','));
check('解禁有明确告警', s10b.v.warnings.some(w => w.indexOf('重新纳入轮转') >= 0));

/* ========== 场景 11：「A组从53开始」= 起点指令，必须确定性生效 ========== */
console.log('\n=== 场景 11：起点指令「a组从53，b组从52开始」 ===');
/**
 * 用户原话（2026-10-31 16:26 截图，输入框可见）：**「a组从53，b组从52开始」**。
 * 模型按提示词把这句话理解成「A组 53 号之前都排过了」，写进 skipSeqs = 1…51，
 * 把候选池抽干 → 19 节课 16 节「未排」。
 * 修复：这句话本质是**轮转起点**，由 parseStartSeqs + applyStartFrom 确定性落到游标上，
 * 完全不过模型（与 DB 里的游标是否最新无关）。
 */
const roster11 = buildCtx([]).roster;
check('parseStartSeqs「a组从53，b组从52开始」→ {A:53,B:52}',
  JSON.stringify(parseStartSeqs('a组从53，b组从52开始', roster11)) === JSON.stringify({ A: 53, B: 52 }),
  JSON.stringify(parseStartSeqs('a组从53，b组从52开始', roster11)));
check('parseStartSeqs「A组53号开始」→ {A:53}',
  JSON.stringify(parseStartSeqs('A组53号开始', roster11)) === JSON.stringify({ A: 53 }));
check('parseStartSeqs「B组由12起」→ {B:12}',
  JSON.stringify(parseStartSeqs('B组由12起', roster11)) === JSON.stringify({ B: 12 }));
check('parseStartSeqs 不会把「A组5号请假」误判成起点',
  JSON.stringify(parseStartSeqs('A组5号请假', roster11)) === JSON.stringify({}),
  JSON.stringify(parseStartSeqs('A组5号请假', roster11)));
check('parseStartSeqs 不会把「A组23号之前全部排过了」误判成起点',
  JSON.stringify(parseStartSeqs('A组23号之前全部排过了', roster11)) === JSON.stringify({}),
  JSON.stringify(parseStartSeqs('A组23号之前全部排过了', roster11)));

// 11b：游标 0 的极端情况也要从 53 / 52 起排（不依赖 DB 游标是否最新）
const c11 = buildCtx([]);                                  // 游标 0
const bumped11 = applyStartFrom(c11.ctx, parseStartSeqs('a组从53，b组从52开始', c11.roster));
check('游标被推进到 A=52 / B=51', c11.ctx.state.cursors.A === 52 && c11.ctx.state.cursors.B === 51,
  'A=' + c11.ctx.state.cursors.A + ' B=' + c11.ctx.state.cursors.B);
check('生效回显为 A:53 / B:52', String(bumped11) === 'A:53,B:52', String(bumped11));
const a11 = c11.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s11 = summarize('场景 11b', c11.ctx, { assignments: a11, skipSeqs: [], notes: 'a组从53，b组从52开始' });
const firstA11 = s11.v.plan.find(p => p.groupScope === 'A');
const firstB11 = s11.v.plan.find(p => p.groupScope === 'B');
check('A 组第一个课次从 53 号起', firstA11.memberSeqs.every(q => q >= 53),
  '成员=' + JSON.stringify(firstA11.memberSeqs));
check('B 组第一个课次从 52 号起', firstB11.memberSeqs.every(q => q >= 52),
  '成员=' + JSON.stringify(firstB11.memberSeqs));
check('起点推进后仍然排满所有课次', s11.v.plan.every(p => p.memberSeqs.length === p.dutyCount));

// 11c：游标只前进不后退
const c11c = buildCtx([]);
applyStartFrom(c11c.ctx, { A: 10, B: 10 });
check('起点指令不会把游标往回拽（0 → 10 可以是前进；再给更小的值不变）',
  c11c.ctx.state.cursors.A === 9);
applyStartFrom(c11c.ctx, { A: 3, B: 3 });
check('更小的起点被忽略（游标不后退）', c11c.ctx.state.cursors.A === 9,
  'A=' + c11c.ctx.state.cursors.A);

// 11d：用户原话 + 模型仍误写 skipSeqs=1..51 → 仍须从 53/52 起排且排满
const c11d = buildCtx([]);
applyStartFrom(c11d.ctx, parseStartSeqs('a组从53，b组从52开始', c11d.roster));
const a11d = c11d.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s11d = summarize('场景 11d', c11d.ctx, { assignments: a11d, skipSeqs: skipAll10, notes: '' });
check('模型误写 skipSeqs 时依然排满（起点指令兜住）',
  s11d.v.plan.every(p => p.memberSeqs.length === p.dutyCount),
  '未排=' + s11d.v.plan.filter(p => p.memberSeqs.length !== p.dutyCount).map(p => p.sessionId).join(','));

/* ========== 场景 12：保洁（CLEAN）必须跟在当天课程后面，不许被甩到周尾 ========== */
console.log('\n=== 场景 12：保洁与课程走同一条轮转流 ===');
/**
 * 用户 2026-10-31 截图实锤：周二第 2 节 9、11，下午「打扫 410」却是 35、36。
 * 根因：AI 链路把保洁摘出 validatePlan，整周课程排完才用 buildCleaningPlan 补，
 * 只能捡周尾号。修复：ctx.cleanSessions 并入同一条 items 流（与 generate 的 rotatePlan 同口径）。
 */
const c12 = buildCtx([]);
const dates12 = Array.from(new Set(c12.sessions.map(s => s.date)));
c12.ctx.cleanSessions = dates12.map((d, i) => ({
  sessionId: 900 + i, date: d, dayOfWeek: i + 1, dayText: '周' + '一二三四五'[i],
  period: 4, course: '打扫410', room: '410', groupScope: 'ALL',
  dutyCount: 2, existingDutySeqs: [], busySameDaySeqs: []
}));
const a12 = c12.sessions.map(s => ({ sessionId: s.sessionId, memberSeqs: [] }));
const s12 = summarize('场景 12', c12.ctx, { assignments: a12, skipSeqs: [], notes: '' });
check('保洁被排上了（5 天各 2 人）', (s12.v.cleaningPlan || []).length === 5,
  '保洁课次=' + ((s12.v.cleaningPlan || []).length));
check('保洁按日期升序排列',
  (s12.v.cleaningPlan || []).every((p, i, arr) => i === 0 || arr[i - 1].date <= p.date));
const cleanSeqs12 = (s12.v.cleaningPlan || []).reduce((a, p) => a.concat(p.memberSeqs), []);
const courseSeqs12 = s12.v.plan.reduce((a, p) => a.concat(p.memberSeqs), []);
/* 旧实现（保洁整周课程排完才补）第一天就会用掉周尾号（实测 33、34），
 * 新实现紧跟在第一天课程之后（实测 9、10）。用「第一天最多用到当天课程+当天保洁+余量」来分辨。 */
const d012 = dates12[0];
const firstCourse12 = s12.v.plan.filter(p => p.date === d012).reduce((a, p) => a.concat(p.memberSeqs), []);
const firstClean12 = (s12.v.cleaningPlan || []).filter(p => p.date === d012).reduce((a, p) => a.concat(p.memberSeqs), []);
check('第一天的保洁紧跟在第一天课程之后（没有跳到周尾）',
  firstClean12.length > 0
  && Math.max.apply(null, firstClean12) <= firstCourse12.length + firstClean12.length + 4,
  '第一天课程=' + firstCourse12.join(',') + ' / 第一天保洁=' + firstClean12.join(','));
const all12 = s12.v.plan.concat(s12.v.cleaningPlan || []);
const cnt12 = new Map();
all12.forEach(p => p.memberSeqs.forEach(q => cnt12.set(q, (cnt12.get(q) || 0) + 1)));
check('课程 + 保洁合起来无重复（一轮一人一次）',
  Array.from(cnt12.values()).every(n => n === 1),
  '重复=' + Array.from(cnt12.entries()).filter(([, n]) => n > 1).map(([q]) => q).join(','));
check('保洁每节人数等于 dutyCount', (s12.v.cleaningPlan || []).every(p => p.memberSeqs.length === 2));

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
