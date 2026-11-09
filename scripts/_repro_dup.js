/**
 * 复现/验证：一键生成（按序号轮转）出现「同一人重复」
 *
 * 用法：node scripts/_dump_data.js 9 && node scripts/_repro_dup.js 9
 * 纯离线：读 scripts/_dump_w9.json（生产库只读快照），不改任何数据。
 * 按 schedule/index.js 的 generate 主循环逐课次模拟取人，打印每人本周出现次数与重复名单。
 *
 * 目的：修复前必须能复现 33/38 的重复（红），修复后必须 0 重复（绿）。
 */
const fs = require('fs');
const path = require('path');

const CF = path.join(__dirname, '../cloudfunctions/common');
const week = require(path.join(CF, 'week.js'));
const core = require(path.join(CF, 'schedule-core.js'));
const rr = require(path.join(CF, 'round-robin.js'));

const WEEK = Number(process.argv[2]) || 9;
const DUMP = path.join(__dirname, '_dump_w' + WEEK + '.json');
const dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));

const klass = dump.klass[0] || {};
const cfg = {
  termStart: String(klass.term_start || '').slice(0, 10),
  totalWeeks: Number(klass.total_weeks) || 20,
  cursorA: Number(klass.round_cursor_a) || 0,
  cursorB: Number(klass.round_cursor_b) || 0
};
const rules = dump.rules[0] || {};
const avoidSameDay = !!Number(rules.avoid_same_day);

// ── 名册 ──
const roster = dump.members.map(m => ({ id: Number(m.id), group: m.group_tag, seq: week.seqOf(m.student_no) }));
roster.sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
const seqById = new Map(roster.map(r => [r.id, r.seq]));
const seqGroupOf = new Map(roster.map(r => [r.seq, r.group === 'B' ? 'B' : 'A']));
const labelOf = new Map(dump.members.map(m => [week.seqOf(m.student_no), String(m.student_no).slice(-3) + '/' + m.group_tag]));

// ── 课次 / 槽 ──
const sessions = dump.sessions.filter(s => week.matchesWeeks(s.weeks, WEEK, s.week_rule));
const slots = dump.slots.map(r => ({
  id: Number(r.id), weekday: Number(r.weekday),
  period: r.period === null ? null : Number(r.period),
  needN: Math.max(1, Number(r.need_n) || 1),
  fixedSeq: r.fixed_seq === null ? null : Number(r.fixed_seq),
  kind: r.kind === 'CLEAN' ? 'CLEAN' : 'NORMAL',
  sortOrder: Number(r.sort_order) || 0
}));
const cleanMode = slots.some(x => x.kind === 'CLEAN');

// ── 日历 / 调课 ──
const cal = { off: new Set(), shiftFrom: {} };
dump.holidays.forEach(h => { if (h.kind === 'OFF') cal.off.add(String(h.holiday_date).slice(0, 10)); });
dump.dayshift.forEach(s => { cal.shiftFrom[String(s.from_date).slice(0, 10)] = String(s.to_date).slice(0, 10); });
const shifts = {};
dump.sessshift.forEach(r => {
  shifts[r.session_id + '#' + r.week] = {
    kind: r.kind,
    toDay: r.to_day === null ? null : Number(r.to_day),
    toPeriod: r.to_period === null ? null : Number(r.to_period)
  };
});

// ── 游标起点（与 loadWeekCursors 同口径：本周快照优先）──
const wc = dump.weekcur[0];
const curStart = wc ? { A: Number(wc.start_a) || 0, B: Number(wc.start_b) || 0 } : { A: cfg.cursorA, B: cfg.cursorB };
const state = rr.buildState(roster, curStart);
console.log('时段：week=' + WEEK, 'termStart=' + cfg.termStart);
console.log('roster=' + roster.length, 'A=' + roster.filter(r => r.group !== 'B').length, 'B=' + roster.filter(r => r.group === 'B').length);
console.log('start cursor A/B=' + curStart.A + '/' + curStart.B, 'avoidSameDay=' + avoidSameDay, 'slots=' + slots.length, 'sessions=' + sessions.length);

// ── 手动行（生成前已存在；同 generate：算本周已排 + 本轮已排）──
const assignedByDate = {};
const assignedWeek = new Set();
const manualFilled = {};
const manualBySession = {};
dump.manual.forEach(m => {
  const date = String(m.class_date).slice(0, 10);
  const id = Number(m.member_id);
  (assignedByDate[date] = assignedByDate[date] || new Set()).add(id);
  assignedWeek.add(id);
  const sid = Number(m.session_id);
  (manualFilled[sid] = manualFilled[sid] || new Set()).add(id);
  (manualBySession[sid] = manualBySession[sid] || []).push(id);
  const q = seqById.get(id);
  if (q) state.used[seqGroupOf.get(q) || 'A'].add(q);
});
console.log('manual rows=' + dump.manual.length);

// ── 课次实际日期 + 排序（照抄 generate）──
const rotatePlan = [];
for (const s of sessions) {
  const ov = shifts[s.id + '#' + WEEK];
  let slot;
  if (ov) {
    if (ov.kind === 'OFF') continue;
    slot = { day: ov.toDay || Number(s.day_of_week), period: ov.toPeriod || Number(s.period), shifted: true };
  } else {
    slot = { day: Number(s.day_of_week), period: Number(s.period), shifted: false };
  }
  const base = week.getDateOfWeekDay(cfg.termStart, WEEK, slot.day);
  const classDate = cal.shiftFrom[base] || (cal.off.has(base) ? null : base);
  if (!classDate) continue;
  rotatePlan.push({ s, slot, classDate });
}
rotatePlan.sort((a, b) => (
  a.classDate < b.classDate ? -1
    : a.classDate > b.classDate ? 1
      : (Number(a.slot.period) - Number(b.slot.period))
        || ((a.s.kind === 'CLEAN') ? 1 : 0) - ((b.s.kind === 'CLEAN') ? 1 : 0)
        || (a.s.id - b.s.id)
));

// ── 主循环（照抄 generate）──
const slotCache = new Map();
const out = [];
const busyByDate = {};
dump.manual.forEach(m => {
  const d = String(m.class_date).slice(0, 10);
  (busyByDate[d] = busyByDate[d] || new Set()).add(Number(m.member_id));
});

for (const { s, slot, classDate } of rotatePlan) {
  const alreadyFilled = (manualFilled[Number(s.id)] || new Set()).size;
  const slotRec = slots.length ? core.slotOf(slots, slot.day, slot.period, s.kind) : null;
  if (s.kind === 'CLEAN' && cleanMode && (!slotRec || slotRec.kind !== 'CLEAN')) continue;
  const n = core.resolveNeed(s, slots, alreadyFilled, slot.day, slot.period, s.kind);
  if (n <= 0) continue;

  const busy = busyByDate[classDate] || new Set();
  const inBatch = assignedByDate[classDate] || new Set();
  const chosen = [];
  const trace = [];
  if (slotRec) {
    /* 与 schedule/index.js 逐字同构（2026-11-09 修复后版本） */
    const reuseAllDay = slotRec.period === null;
    const ck = classDate + '|' + slotRec.id;
    let people = reuseAllDay ? slotCache.get(ck) : null;
    if (people) trace.push('CACHE_HIT');
    if (!people) {
      if (slotRec.fixedSeq) {
        const fm = roster.find(r => Number(r.seq) === Number(slotRec.fixedSeq));
        people = fm ? [fm] : [];
      } else {
        const wantN = reuseAllDay ? slotRec.needN : Math.max(0, n - chosen.length);
        if (wantN > 0) {
          if (process.env.DBG) {
            const g = s.group_scope || 'ALL';
            console.log('  [dbg-slot] s' + s.id + ' scope=' + g + ' want=' + wantN + ' cur=' + state.cursors.A + '/' + state.cursors.B
              + ' soft=' + [...core.toSeqSet(assignedWeek, seqById)].join(',')
              + ' usedB=' + [...state.used.B].join(','));
          }
          const p = rr.pickBySeq(roster, s.group_scope, wantN, state, {
            avoidSeqs: new Set(),
            busySeqs: core.toSeqSet(busy, seqById),
            inBatchSeqs: core.toSeqSet(inBatch, seqById),
            avoidSameDay: avoidSameDay,
            softSeqs: core.toSeqSet(assignedWeek, seqById)
          });
          people = p.chosen;
        } else {
          people = [];
        }
      }
      if (reuseAllDay) slotCache.set(ck, people);
    }
    const add = people
      .filter(m => !chosen.some(x => x.id === m.id))
      .filter(m => !(manualFilled[Number(s.id)] || new Set()).has(m.id))
      .slice(0, Math.max(0, n - chosen.length));
    add.forEach(m => chosen.push(m));
  } else if (chosen.length < n) {
    if (process.env.DBG) {
      const g = s.group_scope || 'ALL';
      console.log('  [dbg] s' + s.id + ' scope=' + g + ' cur=' + state.cursors.A + '/' + state.cursors.B
        + ' soft=' + [...core.toSeqSet(assignedWeek, seqById)].join(',')
        + ' usedB=' + [...state.used.B].join(','));
    }
    const p = rr.pickBySeq(roster, s.group_scope, n - chosen.length, state, {
      avoidSeqs: new Set(),
      busySeqs: core.toSeqSet(busy, seqById),
      inBatchSeqs: core.toSeqSet(inBatch, seqById),
      avoidSameDay: avoidSameDay,
      softSeqs: core.toSeqSet(assignedWeek, seqById)
    });
    p.chosen.forEach(m => chosen.push(m));
  }

  chosen.forEach(m => {
    assignedWeek.add(m.id);
    (assignedByDate[classDate] = assignedByDate[classDate] || new Set()).add(m.id);
    (busyByDate[classDate] = busyByDate[classDate] || new Set()).add(m.id);
    out.push({ date: classDate, sid: Number(s.id), seq: m.seq, group: m.group, src: 'AUTO', note: trace.join(',') });
  });
  (manualBySession[Number(s.id)] || []).forEach(id => {
    const q = seqById.get(id);
    if (q) out.push({ date: classDate, sid: Number(s.id), seq: q, group: seqGroupOf.get(q), src: 'MANUAL', note: '' });
  });
}

out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.sid - b.sid) || (a.seq - b.seq)));
console.log('\n── 逐课次 ──');
out.forEach(o => console.log(`${o.date} s${String(o.sid).padStart(3, '0')}  ${String(o.seq).padStart(2, ' ')}号(${o.group}) ${o.src}${o.note ? ' [' + o.note + ']' : ''}`));

const cnt = new Map();
out.forEach(o => cnt.set(o.seq, (cnt.get(o.seq) || 0) + 1));
const dups = [...cnt.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
console.log('\n总名额=' + out.length, '涉及人数=' + cnt.size, '重复人数=' + dups.length);
dups.forEach(([seq, c]) => {
  const rows = out.filter(o => o.seq === seq).map(o => o.date + '/s' + o.sid + '/' + o.src);
  console.log('  ✗ ' + seq + '号(' + labelOf.get(seq) + ') × ' + c + '  ' + rows.join(' , '));
});
if (!dups.length) console.log('  ✓ 无重复');
