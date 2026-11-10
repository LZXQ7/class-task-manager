/**
 * 2026-11-11「调课后值日同步」生产库**只读**等价验证。
 * 用生产库真值 + 生产源码（common/week.js）复算：
 *   ① 现行 session_shift 到底是不是跨周；
 *   ② 用户例子里那两条值日是什么状态（能不能被新逻辑搬走）；
 *   ③ 按新口径整批搬移后，值日页会显示在哪一格、星期/节次对不对；
 *   ④ 目标格有没有 uq_duty 撞车风险（不改库，只 SELECT 探测）。
 * 用法：node scripts/_verify_shift_duty_20261111.js
 * ⚠️ 全程 --read-only，绝不写生产库。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TCBJS = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';
const week = require(path.join(ROOT, 'cloudfunctions/common/week.js'));

function q(sql) {
  const r = spawnSync(process.execPath,
    [TCBJS, 'db', 'execute', '-e', ENV, '-r', 'ap-shanghai', '--read-only', '--json', '-s', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = String(r.stdout || '');
  const i = out.indexOf('{');
  if (i < 0) throw new Error('no json: ' + out.slice(0, 400) + ' | ' + String(r.stderr || '').slice(0, 300));
  const j = JSON.parse(out.slice(i));
  const items = j && j.data && j.data.items;
  if (!Array.isArray(items)) throw new Error('unexpected json: ' + JSON.stringify(j).slice(0, 300));
  return items;
}

const DAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const dstr = (v) => String(v == null ? '' : v).slice(0, 10);

const cls = q('SELECT term_start, total_weeks FROM class WHERE id=3')[0];
const TERM = dstr(cls.term_start);
console.log('学期起始=' + TERM + '  总周次=' + cls.total_weeks);

const shifts = q('SELECT id, session_id, week, kind, to_day, to_period, to_week, note FROM session_shift WHERE class_id=3 ORDER BY id');
console.log('\n=== ① 生产库现行调课记录 ===');
shifts.forEach(r => {
  const cross = r.to_week !== null && Number(r.to_week) !== Number(r.week);
  console.log('  id=' + r.id + ' sid=' + r.session_id + ' 第' + r.week + '周 ' + r.kind
    + ' → ' + (r.kind === 'MOVE' ? DAY[Number(r.to_day)] + '第' + r.to_period + '节' : '不上')
    + '  to_week=' + (r.to_week === null ? 'NULL（同周）' : r.to_week + (cross ? '（跨周）' : ''))
    + '  note=' + (r.note || ''));
});

const SID = 356;
const duties = q(
  'SELECT d.id, d.session_id, d.week, d.class_date, d.member_id, d.status, d.source, '
  + 'm.student_no, s.day_of_week, s.period, IFNULL(c.name, "-") AS course_name '
  + 'FROM duty d JOIN session s ON s.id=d.session_id LEFT JOIN course c ON c.id=s.course_id '
  + 'JOIN member m ON m.id=d.member_id '
  + 'WHERE d.class_id=3 AND d.session_id=' + SID + ' ORDER BY d.week, d.id'
);
console.log('\n=== ② session 356 的全部值日行 ===');
duties.forEach(d => {
  console.log('  duty=' + d.id + ' 第' + d.week + '周 ' + dstr(d.class_date)
    + ' (' + DAY[week.weekdayOf(dstr(d.class_date))] + '第' + d.period + '节)'
    + ' 学号=' + d.student_no + ' status=' + d.status + ' source=' + d.source
    + ' 课=' + d.course_name);
});

const map = {};
shifts.forEach(r => {
  map[week.shiftKey(r.session_id, r.week)] = {
    sessionId: Number(r.session_id), fromWeek: Number(r.week), kind: String(r.kind),
    toDay: r.to_day === null ? null : Number(r.to_day),
    toPeriod: r.to_period === null ? null : Number(r.to_period),
    toWeek: r.to_week === null ? null : Number(r.to_week),
    note: r.note || ''
  };
});

console.log('\n=== ③ 新口径「整批搬到目标格」等价复算（纯内存，不改库）===');
const sh = map[week.shiftKey(SID, 9)] || map[week.shiftKey(SID, 11)];
if (!sh) {
  console.log('  （session 356 当前无调课记录，跳过搬移复算）');
} else {
  const effWk = Number(sh.toWeek) || Number(sh.fromWeek);
  const toDay = sh.toDay || 1;
  const toPeriod = sh.toPeriod || 4;
  const targetDate = week.getDateOfWeekDay(TERM, effWk, toDay);
  const movable = duties.filter(d => Number(d.week) === Number(sh.fromWeek)
    && ['PENDING', 'ONGOING'].indexOf(String(d.status).toUpperCase()) >= 0);
  const kept = duties.filter(d => movable.indexOf(d) < 0);
  console.log('  源周=' + sh.fromWeek + '  目标=第' + effWk + '周 ' + DAY[toDay]
    + '第' + toPeriod + '节  日期=' + targetDate);
  console.log('  → 会被搬走（PENDING/ONGOING）：' + (movable.length
    ? movable.map(d => d.id + '/' + d.student_no).join(', ') : '（无）'));
  console.log('  → 按用户选择保留不动（历史 / 已值日）：' + (kept.length
    ? kept.map(d => d.id + '/' + d.student_no + '/' + d.status).join(', ') : '（无）'));

  // 搬移后的行用真 dutySlotOf 解析，值日页显示的星期/节次必须对
  const movedRow = {
    session_id: SID, day_of_week: Number(duties[0] ? duties[0].day_of_week : 1),
    period: Number(duties[0] ? duties[0].period : 4),
    week: effWk, class_date: targetDate
  };
  const slot = week.dutySlotOf(movedRow, map, effWk);
  console.log('  → 值日页显示：按 class_date 分组 = ' + targetDate + '（'
    + DAY[week.weekdayOf(targetDate)] + '），节次 = ' + (slot ? slot.period : '?')
    + '，星期 = ' + (slot ? DAY[slot.day] : '?'));

  // uq_duty 撞车只读探测：目标周同一课次是否已有这批人的行
  const memIds = duties.map(d => Number(d.member_id));
  if (memIds.length) {
    const clash = q('SELECT id, member_id, class_date, status FROM duty '
      + 'WHERE class_id=3 AND week=' + effWk + ' AND session_id=' + SID
      + ' AND member_id IN (' + memIds.join(',') + ')');
    console.log('  → 目标周同课次同人的既有行（会被新逻辑先删，避免 1062）：'
      + (clash.length ? clash.map(x => x.id + '/' + x.member_id + '/' + x.status).join(', ') : '（无）'));
  }
}

console.log('\n=== ④ 结论 ===');
console.log('  历史行按用户口径「保留不动」；新逻辑只对 PENDING/ONGOING 的未值日行生效。');
console.log('  同周 MOVE 与跨周 MOVE 现在统一「整批随课搬移、人不变」。');
