// 复核「第11周 B 组周一第4节（微课设计与制作）」在端上是否可见。
//   node scripts/_verify_week11.js
// 用生产库真实课次 + 生产端源码（miniprogram/data/timetable.js）离线渲染第 11 周：
//   场景A：本机还留着误操作写下的「第11周不上」缓存（老版本用户就是这个状态）
//   场景B：课表页同步云端 allSessions 后（1.0.8.26 起 replaceSessShifts 整体覆盖本地）
// 只读，不改库。
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TCBJS = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';

/* ---------------- wx.Storage 桩 ---------------- */
const store = {};
global.wx = {
  getStorageSync: k => (k in store ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  removeStorageSync: k => { delete store[k]; },
  getApp: () => null
};

/* 模式②：模拟「老版本用户手机里残留着一条幽灵调课」，验证一次性清理生效 */
if (process.argv[2] === 'purge') {
  store.timetable_sess_shifts_v1 = [
    { sessionId: 356, week: 11, kind: 'OFF', toDay: null, toPeriod: null, note: '多周次调课' }
  ];
  const tt0 = require(path.join(ROOT, 'miniprogram/data/timetable.js'));
  const left = tt0.sessShifts().length;
  const flag = store.timetable_sess_shifts_purged_v1 ? '已置位' : '未置位';
  console.log('【一次性清理】残留清空后本地调课条数 = ' + left + '（期望 0）'
    + ' · 迁移标记 ' + flag);
  const ok = left === 0 && !!store.timetable_sess_shifts_purged_v1;
  // 只清一次：再塞一条正常调课，重新加载模块不应被抹掉
  store.timetable_sess_shifts_v1 = [
    { sessionId: 356, week: 9, kind: 'MOVE', toDay: 3, toPeriod: 4, toWeek: 11, note: '跨周' }
  ];
  delete require.cache[require.resolve(path.join(ROOT, 'miniprogram/data/timetable.js'))];
  const tt1 = require(path.join(ROOT, 'miniprogram/data/timetable.js'));
  const keep = tt1.sessShifts().length;
  console.log('【只清一次】重载后本地调课条数 = ' + keep + '（期望 1，不许反复抹）');
  const ok2 = keep === 1;
  console.log(ok && ok2 ? '清理自检通过 ✓' : '清理自检失败 ✗');
  process.exit(ok && ok2 ? 0 : 1);
}

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

/* ---------------- 生产库快照 ---------------- */
const rows = q(`SELECT s.id, s.day_of_week, s.period, IFNULL(s.group_scope,'') AS g, IFNULL(s.weeks,'') AS w,
                       IFNULL(s.week_rule,'ALL') AS wr, s.duty_count, IFNULL(s.note,'') AS note,
                       c.name, IFNULL(c.teacher,'') AS teacher, IFNULL(c.room,'') AS room
                  FROM session s LEFT JOIN course c ON c.id = s.course_id
                 WHERE s.class_id = 3 AND s.kind <> 'CLEAN'
                 ORDER BY s.day_of_week, s.period, s.id`);
const shiftRows = q(`SELECT session_id, week, kind, IFNULL(to_day,-1) AS to_day,
                            IFNULL(to_period,-1) AS to_period, IFNULL(to_week,-1) AS to_week,
                            IFNULL(note,'') AS note
                       FROM session_shift WHERE class_id = 3 ORDER BY id`);

const sessions = rows.map(r => ({
  id: Number(r.id),
  cid: 0,
  name: r.name || '',
  teacher: r.teacher || '',
  room: r.room || '',
  day: Number(r.day_of_week),
  period: Number(r.period),
  weeks: r.w || '',
  weekRule: r.wr || 'ALL',
  group: r.g || null,
  dutyCount: (r.duty_count === 0 || r.duty_count) ? Number(r.duty_count) : 2,
  note: r.note || ''
}));

const serverShifts = shiftRows.map(r => ({
  sessionId: Number(r.session_id),
  week: Number(r.week),
  kind: r.kind,
  toDay: r.to_day > 0 ? Number(r.to_day) : null,
  toPeriod: r.to_period > 0 ? Number(r.to_period) : null,
  toWeek: r.to_week > 0 ? Number(r.to_week) : null,
  note: r.note || ''
}));

const tt = require(path.join(ROOT, 'miniprogram/data/timetable.js'));
tt.setPeriods(null);
tt.replaceSessions(sessions);

const WEEK = 11;
const TARGET = 356;   // 微课设计与制作 · B 组 · 周一第4节

function pick(wk, sid) {
  return tt.sessionsOfWeek(wk).filter(x => Number(x.sessionId) === Number(sid));
}

function report(tag) {
  const all = tt.sessionsOfWeek(WEEK);
  const hit = pick(WEEK, TARGET);
  const mon4 = all.filter(x => x.dayOfWeek === 1 && x.period === 4);
  console.log('\n=== ' + tag + ' ===');
  console.log('  第' + WEEK + '周 周一第4节 共 ' + mon4.length + ' 项：');
  mon4.forEach(x => console.log('    s' + x.sessionId + ' ' + x.name
    + ' 组=' + (x.groupScope || 'ALL') + ' kind=' + x.shiftKind));
  console.log('  → 包含 s356 微课设计：' + (hit.length > 0 ? '是 ✓' : '否 ✗'));
  return hit.length > 0;
}

/* 场景A：本机残留误操作的「第11周不上」 */
tt.saveSessShifts([{ sessionId: TARGET, week: WEEK, kind: 'OFF', toDay: null, toPeriod: null, toWeek: null, note: '多周次调课' }]);
const a = report('场景A 本地还留着「第11周不上」（老版本 / 未同步）');

/* 场景B：课表页 _syncFromCloud → replaceSessShifts(云端为准) */
tt.replaceSessShifts(serverShifts);
const b = report('场景B 课表页同步云端后（1.0.8.26 起）');

console.log('\n云端 session_shift 记录数 = ' + serverShifts.length
  + '（含 s356 第11周的 OFF 条数 = '
  + serverShifts.filter(x => x.sessionId === TARGET && x.week === WEEK).length + '）');
console.log('第9周 是否还有 s356：' + (pick(9, TARGET).length > 0 ? '有 ✗' : '无 ✓'));
console.log('第11周 周三第4节 补课：' + tt.sessionsOfWeek(WEEK)
  .filter(x => x.dayOfWeek === 3 && x.period === 4 && x.shiftKind === 'WEEK_IN')
  .map(x => 's' + x.sessionId + ' ' + x.name).join(' / ') || '(无)');

console.log('\n结论：' + (b ? '云端数据已恢复，端上同步后可见 ✓' : '仍有问题 ✗')
  + (a ? '' : '（场景A 说明：只有清掉本地残留或升到 1.0.8.26 才会显示）'));
process.exit(b ? 0 : 1);
