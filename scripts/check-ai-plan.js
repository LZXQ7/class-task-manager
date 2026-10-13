/**
 * 离线仿真 schedule.validatePlan
 * ------------------------------------------------------------
 * 为什么这么写：MCP 的 invokeFunction 没有 WX 上下文，auth 路由一律 40001，
 * 没法直接调 aiPlan 验证。而 validatePlan 是纯函数（只吃 ctx + raw），
 * 所以直接从源码里原样抽出函数体 eval，测的就是生产代码本身。
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
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/schedule/index.js'), 'utf8');

const RR_PATH = path.join(ROOT, 'cloudfunctions/common/round-robin.js');
const { pickBySeq: realPick, buildState: realBuild } = require(RR_PATH);

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  const end = SRC.indexOf('\n}', start);
  if (end < 0) throw new Error('找不到函数 ' + name + ' 的结尾');
  return SRC.slice(start, end + 2);
}

const factory = new Function('pickBySeq', 'buildState', extractFn('validatePlan') + '\n return validatePlan;');
const validatePlan = factory(realPick, realBuild);

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
function summarize(tag, ctx, raw) {
  const v = validatePlan(ctx, raw);
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

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
