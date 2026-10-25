// 门禁：inferStartFromPrevWeek 必须计入 MANUAL 排班（含手动保洁）
// 2026-10-23 复发根因：旧版只查 d.source='AUTO' 且排除 CLEAN，
// 「清空值日表→重生成」走反推链时会把手动 5/7 忘掉，下周又从 5/7 重排。
// 本门禁用内存数据集模拟真实 SQL 过滤 + MAX(id) GROUP BY，确保 MANUAL 被计入。
const path = require('path');
const core = require(path.resolve(__dirname, '../cloudfunctions/common/schedule-core.js'));

// 内存版 week6 排班：AUTO 课次 + 手动保洁(MANUAL/CLEAN)，手动行 id 更大（后插=轮转终点）
const WEEK6 = [
  { id: 2700, group_tag: 'A', student_no: '000000000355', source: 'AUTO',   kind: null },
  { id: 2701, group_tag: 'A', student_no: '000000000303', source: 'AUTO',   kind: null },
  { id: 2853, group_tag: 'A', student_no: '000000000305', source: 'MANUAL', kind: 'CLEAN' },
  { id: 2854, group_tag: 'A', student_no: '000000000307', source: 'MANUAL', kind: 'CLEAN' },
  { id: 2720, group_tag: 'B', student_no: '000000000304', source: 'AUTO',   kind: null },
  { id: 2721, group_tag: 'B', student_no: '000000000306', source: 'AUTO',   kind: null },
  { id: 2722, group_tag: 'B', student_no: '000000000310', source: 'AUTO',   kind: null }
];

function makeConn() {
  return {
    async query(sql, args) {
      if (/MAX\(week\)/.test(sql)) return [[{ pw: 6 }]];
      if (/FROM duty d JOIN member/.test(sql) && /GROUP BY m.group_tag/.test(sql)) {
        const rows = WEEK6.filter(r => {
          const autoOk = r.source === 'AUTO' && (r.kind === null || r.kind !== 'CLEAN');
          return autoOk || r.source === 'MANUAL';
        });
        const byG = {};
        for (const r of rows) if (!byG[r.group_tag] || r.id > byG[r.group_tag].id) byG[r.group_tag] = r;
        return [Object.keys(byG).map(g => ({ g, max_id: byG[g].id }))];
      }
      if (/WHERE d.id IN/.test(sql)) {
        const m = sql.match(/IN \(([^)]+)\)/);
        const ids = (m ? m[1] : '').split(',').map(s => Number(s.trim())).filter(Boolean);
        return [WEEK6.filter(r => ids.includes(r.id)).map(r => ({ g: r.group_tag, student_no: r.student_no }))];
      }
      return [[]];
    }
  };
}

(async () => {
  const cur = await core.inferStartFromPrevWeek(makeConn(), 3, 7);
  const fail = [];
  if (!cur || cur.A !== 7) fail.push('A 组结束游标应为 7（含手动7），实际 ' + (cur && cur.A));
  if (!cur || cur.B !== 10) fail.push('B 组结束游标应为 10，实际 ' + (cur && cur.B));
  if (fail.length) { console.error('FAIL:\n - ' + fail.join('\n - ')); process.exit(1); }
  console.log('PASS: inferStartFromPrevWeek 计入 MANUAL，week7 起点 = A7/B10（续排 9/11）');
})();
