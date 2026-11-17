#!/usr/bin/env node
/**
 * 门禁：智能排班「点名到号」（2026-11-17）
 * ============================================================
 * 用户原话（截图实锤）：输入「从周三上午开始，b组12号14号，周三下午a组17号19号」，
 * 预览却给出 52/54、7/9 —— 因为 v2 的 AI 只解析「起点/某课人数」，
 * 号数根本没进选人逻辑（start_seq 也只是拿来做组别校验的摆设）。
 *
 * 本门禁锁死三件事：
 *   ① 内核：pins 命中的场次**就用指定的人**，并把该组游标搬到钉住的最大号，
 *      后续场次从它往后续排；钉住的人不再参与自动轮转（同一周不重复）。
 *   ② 云函数：提示词有 pins 字段、handler 真的把 pins 传给 assign、
 *      号不存在/组别不符/超 2 人/当天无课都给**红字原因**（不静默忽略）。
 *   ③ 不回归：不传 pins 时行为与 v2 完全一致（游标从 A=5/B=50 起）。
 * 末尾变异自证：把每条口径改坏，对应探针必须翻红。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'cloudfunctions', 'common', 'speech-core.js');
const SCH_PATH = path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js');
const DUTY_W = path.join(ROOT, 'miniprogram', 'pages', 'duty', 'index.wxml');

const read = (p) => fs.readFileSync(p, 'utf8');
const SRC = { core: read(CORE_PATH), sch: read(SCH_PATH), dutyW: read(DUTY_W) };

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed += 1; console.log('  ✗ ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));

/** 真加载（vm 包装）：变异样本也必须走同一份 round-robin */
function loadCore(src) {
  const Module = require('module');
  const m = new Module(CORE_PATH, module);
  m.filename = CORE_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(CORE_PATH));
  m._compile(src, CORE_PATH);
  return m.exports;
}

/** 名册夹具：1..56，单号 A / 双号 B（与线上 class 3 同构，B 组游标 50） */
function mkRoster(n) {
  const r = [];
  for (let i = 1; i <= n; i += 1) {
    r.push({ id: 1000 + i, seq: i, group: (i % 2 === 1 ? 'A' : 'B'), name: 'S' + i });
  }
  return r;
}
const ROSTER = mkRoster(56);
const CURS = { A: 5, B: 50 };   // 线上真实游标
const SLOTS = [
  { date: '2026-11-18', slot: 'AM', scope: 'B', day: 3 },
  { date: '2026-11-18', slot: 'PM', scope: 'A', day: 3 },
  { date: '2026-11-19', slot: 'AM', scope: 'A', day: 4 },
  { date: '2026-11-20', slot: 'AM', scope: 'B', day: 5 },
  { date: '2026-11-20', slot: 'PM', scope: 'ALL', day: 5 }
];
const PINS = [
  { day: 3, slot: 'AM', seqs: [12, 14] },
  { day: 3, slot: 'PM', seqs: [17, 19] }
];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const atOf = (plan, date, slot) => plan.rows.filter(r => r.date === date && r.slot === slot).map(r => r.seq);

function probes(C, S) {
  const out = {};

  /* ① 钉住的场次就用指定的人 */
  let plan;
  try { plan = C.assign(SLOTS, ROSTER, CURS, { pins: PINS }); } catch (e) { plan = { rows: [], cursors: {} }; }
  out.pinsHonored = eq(atOf(plan, '2026-11-18', 'AM'), [12, 14])
    && eq(atOf(plan, '2026-11-18', 'PM'), [17, 19]);
  out.pinsSource = plan.rows.filter(r => r.date === '2026-11-18').every(r => r.source === 'PIN');

  /* ② 游标搬到钉住的最大号 → 后续场次从 16/18、21/23 续排 */
  out.pinsAdvance = eq(atOf(plan, '2026-11-19', 'AM'), [21, 23])
    && eq(atOf(plan, '2026-11-20', 'AM'), [16, 18]);
  /* ②b 游标真的搬到钉住的号上（发布时落库的就是它）——钉完再排一场，游标应停在 16；
   *     若没搬（仍是 50），补漏通道虽然还能排出 16，但游标留在 50 ⇒ 下周直接从 52 起，
   *     16~50 这一圈人永远排不到。 */
  {
    const p5 = C.assign([
      { date: 'p1', slot: 'AM', scope: 'B', day: 3 },
      { date: 'p2', slot: 'AM', scope: 'B', day: 4 }
    ], ROSTER, { A: 5, B: 50 }, { pins: [{ day: 3, slot: 'AM', seqs: [12, 14] }] });
    out.pinsCursors = p5.cursors.B === 18 && eq(atOf(p5, 'p2', 'AM'), [16, 18]);
  }

  /* ③ 同一周不重复（钉住的人不再被自动轮转取走） */
  const all = plan.rows.map(r => r.seq);
  out.pinsNoDup = all.length > 0 && new Set(all).size === all.length;

  /* ④ 钉在后面的场次，也不能被前面的自动场先排掉 */
  {
    const s2 = [
      { date: 'd1', slot: 'AM', scope: 'A', day: 1 },
      { date: 'd2', slot: 'PM', scope: 'A', day: 3 }
    ];
    const p2 = C.assign(s2, ROSTER, { A: 5, B: 50 }, { pins: [{ day: 3, slot: 'PM', seqs: [9, 11] }] });
    const d1 = p2.rows.filter(r => r.date === 'd1').map(r => r.seq);
    const d2 = p2.rows.filter(r => r.date === 'd2').map(r => r.seq).sort((a, b) => a - b);
    out.pinsSkipAuto = d1.indexOf(9) < 0 && d1.indexOf(11) < 0 && eq(d2, [9, 11]);
  }

  /* ⑤ 全体课也能钉人（两组各落一次游标） */
  {
    const p3 = C.assign([{ date: 'x', slot: 'PM', scope: 'ALL', day: 3 }], ROSTER, { A: 5, B: 50 },
      { pins: [{ day: 3, slot: 'PM', seqs: [7, 8] }] });
    out.pinsAllScope = eq(p3.rows.map(r => r.seq).sort((a, b) => a - b), [7, 8])
      && p3.cursors.A >= 7 && p3.cursors.B >= 8;
  }

  /* ⑥ 不传 pins ⇒ 与 v2 完全一致（回归护栏：52/54、7/9） */
  {
    const p4 = C.assign(SLOTS, ROSTER, CURS, {});
    out.legacyNoPins = eq(atOf(p4, '2026-11-18', 'AM'), [52, 54])
      && eq(atOf(p4, '2026-11-18', 'PM'), [7, 9]);
  }

  /* ── 接线（静态）── */
  out.promptPins = S.sch.indexOf('"pins"') >= 0 && S.sch.indexOf('"seqs"') >= 0
    && S.sch.indexOf('学号后两位') >= 0;
  out.parsePins = S.sch.indexOf('cmd.pins') >= 0;
  out.assignPins = S.sch.indexOf('speechCore.assign(slots, roster, cursors, { pins })') >= 0;
  out.startSeqWired = S.sch.indexOf('Math.max(0, startSeq - 1)') >= 0;
  /* 红字要说明原因，不能静默忽略（用户原话：「返回红色错误并说明原因」） */
  out.errGroup = S.sch.indexOf('组别不匹配，不能排。') >= 0;
  out.errMissing = S.sch.indexOf('不在本班演讲名册') >= 0;
  out.errCap = S.sch.indexOf('最多排 2 人') >= 0;
  out.errNoClass = S.sch.indexOf('本周没有这节课') >= 0;
  out.uiPinTag = S.dutyW.indexOf("item.source === 'PIN'") >= 0;
  return out;
}

const P = probes(loadCore(SRC.core), SRC);

console.log('── ① 内核：钉人');
check(P.pinsHonored, '周三上午=12/14、周三下午=17/19（不再出 52/54、7/9）');
check(P.pinsSource, '钉住的场次 source=PIN（前端据此打「指定」标签）');
console.log('── ② 内核：游标落在钉住的最大号');
check(P.pinsAdvance, '其后按 21/23（A）、16/18（B）续排');
check(P.pinsCursors, '返回游标 A≥19 / B≥14（发布时落库）');
console.log('── ③ 内核：不重复 / 不越过');
check(P.pinsNoDup, '同一周内无重复的人');
check(P.pinsSkipAuto, '钉在后面的场次不会被前面的自动场先排掉');
check(P.pinsAllScope, '全体课也能钉人，两组各自落游标');
console.log('── ④ 回归');
check(P.legacyNoPins, '不传 pins 时行为不变（A=5/B=50 → 52/54、7/9）');
console.log('── ⑤ 云函数接线');
check(P.promptPins, '提示词含 pins/seqs 且说明「序号=学号后两位」');
check(P.parsePins, 'handler 解析 cmd.pins');
check(P.assignPins, 'assign 真的收到 { pins }');
check(P.startSeqWired, '「从第N号开始」把游标搬到 N-1（不再只是摆设）');
check(P.errGroup, '组别不符 → 红字「组别不匹配」');
check(P.errMissing, '号不在名册 → 红字说明');
check(P.errCap, '一场超 2 人 → 红字说明');
check(P.errNoClass, '当天无课 / 被起点筛掉 → 红字说明');
check(P.uiPinTag, '预览行对 PIN 打「指定」标签');

/* ============================================================
 * 变异自证
 * ============================================================ */
console.log('── ⑥ 变异自证');
const MUT = [
  { name: '内核：钉人分支失效', expect: 'pinsHonored', file: 'core',
    from: '    if (pin && pin.length) {', to: '    if (false) {' },
  { name: '内核：游标不搬到钉住的号', expect: 'pinsCursors', file: 'core',
    from: '        state.cursors[g] = maxBy[g];', to: '        /* 游标没搬 */' },
  { name: '内核：used 不按新游标重建', expect: 'pinsAdvance', file: 'core',
    from: '        state.used[g] = set;', to: '        /* used 没重建 */' },
  { name: '内核：不跳过钉住的人', expect: 'pinsSkipAuto', file: 'core',
    from: 'pinnedSeqs.size ? { skipSeqs: pinnedSeqs } : undefined', to: 'undefined' },
  { name: '云函数：assign 不传 pins', expect: 'assignPins', file: 'sch',
    from: 'speechCore.assign(slots, roster, cursors, { pins })', to: 'speechCore.assign(slots, roster, cursors, {})' },
  { name: '云函数：组别红字被抹掉', expect: 'errGroup', file: 'sch',
    from: '），组别不匹配，不能排。', to: '）。' },
  { name: '云函数：start_seq 不接线', expect: 'startSeqWired', file: 'sch',
    from: 'const from = Math.max(0, startSeq - 1);', to: 'const from = 0;' },
  { name: '前端：去掉「指定」标签', expect: 'uiPinTag', file: 'dutyW',
    from: "item.source === 'PIN'", to: 'false' }
];
const SCH = SRC.sch, DW = SRC.dutyW;

MUT.forEach((mu) => {
  const src = SRC[mu.file];
  if (src.indexOf(mu.from) < 0) { bad('变异锚点没命中：' + mu.name); return; }
  const next = Object.assign({}, SRC, { [mu.file]: src.replace(mu.from, mu.to) });
  if (next[mu.file] === SRC[mu.file]) { bad('变异替换未生效：' + mu.name); return; }
  let mp;
  try { mp = probes(loadCore(next.core), next); } catch (e) { ok('变异被抓（抛错）：' + mu.name + ' → ' + e.message); return; }
  if (mp[mu.expect] === false) ok('变异被抓：' + mu.name);
  else bad('变异未翻红（假绿）：' + mu.name + ' → ' + mu.expect);
});

void SCH; void DW;
console.log(failed ? '\nFAIL · 智能排班点名到号门禁 ' + failed + ' 项未通过'
  : '\nOK · 智能排班点名到号门禁全部通过');
process.exit(failed ? 1 : 0);
