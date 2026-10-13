/**
 * 一次性：生成「第 5 周从 09 号接续」的数据修复 SQL（v0.7.23）
 * ============================================================
 * 为什么需要手工生成：MCP 的 invokeFunction 没有 WX 上下文，业务 action 一律 40001，
 * 没法远程触发云函数的 generate；而数据修复又不能等用户手动点。
 * 所以这里**用生产源码本身**（common/schedule-core.js 的 rotationPick，正是
 * generate 与 cron-weekly 共用的那一份内核）在修复态名册上复跑一遍第 5 周，
 * 把结果直接编成 INSERT —— 复刻的每一步都由 scripts/check-round-robin.js
 * 第 6 部分校准过（清零态逐节课复现线上 46 行、修复态 = 清零态 +8）。
 *
 * 修复态名册 = 第 4 周结束时的真实状态：
 *   01~08 值了 2 次（第 1/2 周一次 + 第 4 周又一次），09~56 值了 1 次。
 * 期望输出：session 2 取 09/11（member 21/23），末节取 51/53（member 63/65）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE = fs.readFileSync(path.join(ROOT, 'cloudfunctions/common/schedule-core.js'), 'utf8');
function extractCoreFn(name) {
  const start = CORE.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('common/schedule-core.js 找不到函数 ' + name);
  const end = CORE.indexOf('\n}', start);
  return CORE.slice(start, end + 2);
}
const rotationPick = new Function(extractCoreFn('rotationPick') + '\n return rotationPick;')();

/** 第 5 周真实课次（查库反查得到；顺序 = generate 的 ORDER BY day_of_week, period） */
const SESSIONS = [
  { sessionId: 2, dayOfWeek: 1, period: 2, groupScope: 'A' },
  { sessionId: 5, dayOfWeek: 1, period: 3, groupScope: null },
  { sessionId: 3, dayOfWeek: 1, period: 4, groupScope: 'B' },
  { sessionId: 26, dayOfWeek: 1, period: 4, groupScope: null },
  { sessionId: 8, dayOfWeek: 2, period: 1, groupScope: 'A' },
  { sessionId: 25, dayOfWeek: 2, period: 2, groupScope: 'A' },
  { sessionId: 30, dayOfWeek: 2, period: 4, groupScope: null },
  { sessionId: 22, dayOfWeek: 2, period: 5, groupScope: 'A' },
  { sessionId: 9, dayOfWeek: 3, period: 1, groupScope: 'B' },
  { sessionId: 11, dayOfWeek: 3, period: 2, groupScope: 'B' },
  { sessionId: 12, dayOfWeek: 3, period: 3, groupScope: null },
  { sessionId: 29, dayOfWeek: 3, period: 4, groupScope: null },
  { sessionId: 15, dayOfWeek: 3, period: 5, groupScope: 'A' },
  { sessionId: 18, dayOfWeek: 4, period: 1, groupScope: 'A' },
  { sessionId: 19, dayOfWeek: 4, period: 2, groupScope: 'B' },
  { sessionId: 6, dayOfWeek: 4, period: 3, groupScope: null },
  { sessionId: 27, dayOfWeek: 4, period: 4, groupScope: null },
  { sessionId: 16, dayOfWeek: 4, period: 5, groupScope: 'B' },
  { sessionId: 20, dayOfWeek: 5, period: 1, groupScope: 'A' },
  { sessionId: 23, dayOfWeek: 5, period: 1, groupScope: 'B' },
  { sessionId: 21, dayOfWeek: 5, period: 2, groupScope: 'B' },
  { sessionId: 24, dayOfWeek: 5, period: 3, groupScope: null },
  { sessionId: 28, dayOfWeek: 5, period: 4, groupScope: null }
];
const DATE_OF_DAY = { 1: '2026-10-12', 2: '2026-10-13', 3: '2026-10-14', 4: '2026-10-15', 5: '2026-10-16' };

/** 第 4 周结束时的真实名册：01~08 = 2 次，09~56 = 1 次（全员 > 0，即跨轮态） */
const roster = [];
for (let seq = 1; seq <= 56; seq++) {
  roster.push({ id: 12 + seq, seq, group: seq % 2 === 1 ? 'A' : 'B', mark: seq <= 8 ? 2 : 1 });
}

const inWeek = new Set();
const rows = [];
SESSIONS.forEach(s => {
  const picked = rotationPick(roster, s.groupScope, 2,
    { busy: new Set(), onLeave: new Set() }, false, new Set(), new Set(), inWeek);
  if (picked.chosen.length !== 2) throw new Error('课次 ' + s.sessionId + ' 只选出 ' + picked.chosen.length + ' 人');
  picked.chosen.forEach(m => { inWeek.add(m.id); rows.push([s.sessionId, DATE_OF_DAY[s.dayOfWeek], m.id, m.seq]); });
});

const uniq = new Set(rows.map(r => r[3]));
console.log('-- 共 ' + rows.length + ' 行，覆盖序号 ' + Math.min.apply(null, rows.map(r => r[3]))
  + '~' + Math.max.apply(null, rows.map(r => r[3])) + '，去重后 ' + uniq.size + ' 人');
console.log('-- 首节(session 2)：' + rows.slice(0, 2).map(r => r[3]).join('/')
  + '   末节(session 28)：' + rows.slice(-2).map(r => r[3]).join('/'));
console.log('-- 第 5 周应为 46 行、序号 09~54、无重复：' +
  (rows.length === 46 && uniq.size === 46 && Math.min.apply(null, rows.map(r => r[3])) === 9
    && Math.max.apply(null, rows.map(r => r[3])) === 54 ? 'OK ✅' : '不符 ❌'));
if (!(rows.length === 46 && uniq.size === 46)) process.exit(1);

const values = rows.map(r => "(1, " + r[0] + ", 5, '" + r[1] + "', " + r[2] + ", 'PENDING', 'AUTO')").join(',\n');
const sql = 'INSERT INTO duty (class_id, session_id, week, class_date, member_id, status, source) VALUES\n' + values + ';';
fs.writeFileSync(path.join(ROOT, '.workbuddy', 'week5-fix.sql'), sql, 'utf8');
console.log('\n已写出 .workbuddy/week5-fix.sql');
