// 修复 class-3 轮转游标 + 重建正确的 week-5 值日表（高效幂等版）。
// 复刻 schedule.generate 取人顺序（已用 sim_week5.js 验证：从 A-21/B-18 接续）。
// 混合课次 scope=0（falsy → !scope 取全池 A+B）。
const { execSync } = require('child_process');
const fs = require('fs');

const TCBJS = "C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb";
const ENV = "<YOUR_ENV_ID>";
const OUT = __dirname + "/_apply_w5.txt";
const log = [];
function L(s) { log.push(s); }
function syncSleep(ms) { const t = Date.now(); while (Date.now() - t < ms) {} }
function exec(sql) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai -s "' + sql + '"',
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return;
    } catch (e) {
      if (attempt < 4) syncSleep(1500);
      else { const m = String(e.stdout || '') + '\n' + String(e.stderr || ''); fs.writeFileSync(OUT, 'FAILED SQL:\n' + sql + '\n\n' + m + '\n\nLOG:\n' + log.join('\n'), 'utf8'); throw new Error('tcb FAIL: ' + sql + '\n' + m); }
    }
  }
}
function q1(sql) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { return execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai --read-only -s "' + sql + '"', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (attempt < 4) syncSleep(1500); else throw e; }
  }
}

const ROSTER = {
  14: [2, 'B'], 15: [3, 'A'], 16: [4, 'B'], 17: [5, 'A'], 18: [6, 'B'], 19: [7, 'A'], 20: [8, 'B'],
  21: [9, 'A'], 22: [10, 'B'], 23: [11, 'A'], 24: [12, 'B'], 25: [13, 'A'], 26: [14, 'B'], 27: [15, 'A'], 28: [16, 'B'],
  29: [17, 'A'], 30: [18, 'B'], 31: [19, 'A'], 32: [20, 'B'], 33: [21, 'A'], 34: [22, 'B'], 35: [23, 'A'], 36: [24, 'B'],
  37: [25, 'A'], 38: [26, 'B'], 39: [27, 'A'], 40: [28, 'B'], 41: [29, 'A'], 42: [30, 'B'], 43: [31, 'A'], 44: [32, 'B'],
  45: [33, 'A'], 46: [34, 'B'], 47: [35, 'A'], 48: [36, 'B'], 49: [37, 'A'], 50: [38, 'B'], 51: [39, 'A'], 52: [40, 'B'],
  53: [41, 'A'], 54: [42, 'B'], 55: [43, 'A'], 56: [44, 'B'], 57: [45, 'A'], 58: [46, 'B'], 59: [47, 'A'], 60: [48, 'B'],
  61: [49, 'A'], 62: [50, 'B'], 63: [51, 'A'], 64: [52, 'B'], 65: [53, 'A'], 66: [54, 'B'], 67: [55, 'A'], 68: [56, 'B']
};
const POOL = Object.keys(ROSTER).map(Number);
function target(mid) { const s = ROSTER[mid]; if (s[1] === 'A') return (s[0] >= 3 && s[0] <= 19) ? 2 : 1; return (s[0] >= 2 && s[0] <= 16) ? 2 : 1; }
function rotationPick(roster, scope, n, blocks, avoidSameDay, inBatch, exclude, inWeek) {
  const ex = exclude || new Set(), week = inWeek || new Set();
  const ok = m => !ex.has(m.id) && (!scope || m.group === scope) && !blocks.onLeave.has(m.id) && (!avoidSameDay || (!blocks.busy.has(m.id) && !inBatch.has(m.id)));
  const byRound = (a, b) => (a.mark - b.mark) || (a.seq - b.seq);
  const pool = roster.filter(ok).sort(byRound);
  const fresh = pool.filter(m => m.mark === 0), used = pool.filter(m => m.mark > 0);
  const tiers = [fresh.filter(m => !week.has(m.id)), used.filter(m => !week.has(m.id)), fresh.filter(m => week.has(m.id)), used.filter(m => week.has(m.id))];
  const chosen = [], taken = new Set();
  for (let i = 0; i < tiers.length && chosen.length < n; i++) for (const m of tiers[i]) { if (chosen.length >= n) break; if (taken.has(m.id)) continue; taken.add(m.id); chosen.push(m); }
  chosen.forEach(m => { m.mark += 1; });
  return { chosen };
}
const A = 'A', B = 'B', MIX = 0;
const SESSIONS = [
  ['2026-10-12', 2, 35, A], ['2026-10-12', 3, 39, MIX], ['2026-10-12', 4, 26, MIX], ['2026-10-12', 4, 62, B],
  ['2026-10-13', 1, 32, A], ['2026-10-13', 2, 38, A], ['2026-10-13', 4, 30, MIX], ['2026-10-13', 5, 45, A],
  ['2026-10-14', 1, 48, B], ['2026-10-14', 2, 51, B], ['2026-10-14', 3, 40, MIX], ['2026-10-14', 4, 29, MIX], ['2026-10-14', 5, 46, A],
  ['2026-10-15', 1, 33, A], ['2026-10-15', 2, 54, B], ['2026-10-15', 3, 41, MIX], ['2026-10-15', 4, 27, MIX], ['2026-10-15', 5, 63, B],
  ['2026-10-16', 1, 34, A], ['2026-10-16', 1, 49, B], ['2026-10-16', 2, 53, B], ['2026-10-16', 3, 42, MIX], ['2026-10-16', 4, 28, MIX]
];
const N = 2, AVOID = true;
const roster = POOL.map(mid => ({ id: mid, seq: ROSTER[mid][0], group: ROSTER[mid][1], mark: target(mid) }));
roster.sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
const assignedWeek = new Set(), assignedByDate = {};
const picks = [];
for (const s of SESSIONS) {
  const date = s[0], sid = s[2], scope = s[3];
  const inBatch = assignedByDate[date] || new Set();
  const r = rotationPick(roster, scope, N, { onLeave: new Set(), busy: new Set() }, AVOID, inBatch, new Set(), assignedWeek);
  for (const m of r.chosen) { assignedWeek.add(m.id); (assignedByDate[date] = assignedByDate[date] || new Set()).add(m.id); picks.push({ date: date, sid: sid, mid: m.id, seq: m.seq, group: m.group }); }
}
const cnt = {}; for (const p of picks) cnt[p.mid] = (cnt[p.mid] || 0) + 1;
const finalDc = {}; for (const mid of POOL) finalDc[mid] = (target(mid)) + (cnt[mid] || 0);
L('picks=' + picks.length + '  finalDc=' + JSON.stringify(finalDc));

// 备份（仅当备份表为空时补，避免重复）
const bakDone = q1("SELECT COUNT(*) c FROM bak_duty_fix_w5_member");
L('bak_member count=' + bakDone);
if (!/1/.test(bakDone)) {
  exec("CREATE TABLE IF NOT EXISTS bak_duty_fix_w5_member LIKE member");
  exec("INSERT INTO bak_duty_fix_w5_member SELECT * FROM member WHERE class_id=3 AND id IN (" + POOL.join(',') + ")");
  exec("CREATE TABLE IF NOT EXISTS bak_duty_fix_w5_duty LIKE duty");
  exec("INSERT INTO bak_duty_fix_w5_duty SELECT * FROM duty WHERE class_id=3 AND week=5 AND source='AUTO'");
  L('backup done');
}

// 清掉 week5 AUTO（幂等：哪怕已有部分正确行也先清空再重插）
exec("DELETE FROM duty_log WHERE duty_id IN (SELECT id FROM duty WHERE class_id=3 AND week=5 AND source='AUTO')");
exec("UPDATE swap_request SET status='CANCELLED' WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id IN (SELECT id FROM duty WHERE class_id=3 AND week=5 AND source='AUTO')");
exec("DELETE FROM duty WHERE class_id=3 AND week=5 AND source='AUTO'");
L('cleared week5 AUTO');

// 一次性多行插入 46 条正确行
const vals = picks.map(p => "(3, " + p.sid + ", 5, '" + p.date + "', " + p.mid + ", 'PENDING', 'AUTO')").join(', ');
exec("INSERT IGNORE INTO duty (class_id, session_id, week, class_date, member_id, status, source) VALUES " + vals);
L('inserted ' + picks.length + ' rows');

// 回写 duty_count（最终值）与 last_duty_at（单行 CASE）
exec('UPDATE member SET duty_count = CASE id ' + POOL.map(mid => 'WHEN ' + mid + ' THEN ' + finalDc[mid]).join(' ') + ' END WHERE id IN (' + POOL.join(',') + ')');
const ld = [];
for (const p of picks) ld.push("WHEN " + p.mid + " THEN '" + p.date + "'");
exec('UPDATE member SET last_duty_at = CASE id ' + ld.join(' ') + ' END WHERE id IN (' + POOL.join(',') + ')');
L('duty_count + last_duty_at updated');

// 校验
const w5n = q1("SELECT COUNT(*) n, COUNT(DISTINCT member_id) m FROM duty WHERE class_id=3 AND week=5 AND source='AUTO'");
L('week5 after: ' + w5n);
const dup = q1("SELECT COUNT(*) c FROM (SELECT member_id FROM duty WHERE class_id=3 AND week=5 AND source='AUTO' GROUP BY member_id HAVING COUNT(*)>1) t");
L('dup rows: ' + dup);
const dc = q1("SELECT id, duty_count FROM member WHERE class_id=3 AND status='ACTIVE' AND group_tag<>'X' AND duty_off=0 ORDER BY id");
L('member duty_count after:\n' + dc);

fs.writeFileSync(OUT, log.join('\n'), 'utf8');
console.log(log.join('\n'));
