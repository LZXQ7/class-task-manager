// 跨周调课落地核对：直接用生产库数据 + 生产源码算出「第9周 / 第11周」B 组课表。
//   node scripts/_verify_crossweek.js
// 只读，不改库。
const { spawnSync } = require('child_process');
const fs = require('fs');
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

const sessions = q("SELECT s.id, s.day_of_week, s.period, s.group_scope, s.weeks, s.week_rule, IFNULL(c.name,'-') AS name FROM session s LEFT JOIN course c ON c.id=s.course_id WHERE s.class_id=3 AND s.kind<>'CLEAN' ORDER BY s.day_of_week, s.period");
const shiftRows = q("SELECT session_id, week, kind, IFNULL(to_day,-1) AS to_day, IFNULL(to_period,-1) AS to_period, IFNULL(to_week,-1) AS to_week, IFNULL(note,'') AS note FROM session_shift WHERE class_id=3");

console.log('session_shift 现行记录：');
shiftRows.forEach(r => console.log('  sid=' + r.session_id + ' week=' + r.week + ' kind=' + r.kind
  + ' to=' + (r.to_day > 0 ? ('周' + r.to_day + '第' + r.to_period + '节') : '-')
  + (r.to_week > 0 ? (' 目标周=' + r.to_week) : ' 同周')
  + ' note=' + r.note));

const map = {};
shiftRows.forEach((r) => {
  map[week.shiftKey(r.session_id, r.week)] = {
    sessionId: Number(r.session_id), fromWeek: Number(r.week), kind: r.kind,
    toDay: r.to_day > 0 ? Number(r.to_day) : null,
    toPeriod: r.to_period > 0 ? Number(r.to_period) : null,
    toWeek: r.to_week > 0 ? Number(r.to_week) : null,
    note: r.note || ''
  };
});

const DAY = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
function render(wk, label) {
  console.log('\n=== ' + label + '（第 ' + wk + ' 周）===');
  const rows = [];
  sessions.forEach((s) => {
    if (!week.matchesWeeks(s.weeks, wk, s.week_rule)) return;
    const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, map);
    if (!slot) return;
    rows.push({
      day: slot.day, period: slot.period, name: s.name, group: s.group_scope || 'ALL',
      tag: slot.shifted ? '调课' : ''
    });
  });
  week.incomingOf(map, wk).forEach((ov) => {
    const s = sessions.find(x => Number(x.id) === Number(ov.sessionId));
    if (!s) return;
    rows.push({
      day: Number(ov.toDay) || Number(s.day_of_week),
      period: Number(ov.toPeriod) || Number(s.period),
      name: s.name, group: s.group_scope || 'ALL',
      tag: '第' + ov.fromWeek + '周补课'
    });
  });
  rows.sort((a, b) => (a.day - b.day) || (a.period - b.period));
  rows.filter(r => r.group === 'B' || r.group === 'ALL').forEach((r) => {
    console.log('  ' + (DAY[r.day] || ('周' + r.day)) + ' 第' + r.period + '节  ' + r.name
      + (r.group === 'B' ? '  [B组]' : '') + (r.tag ? '  ← ' + r.tag : ''));
  });
  return rows;
}

render(9, '源周');
render(11, '目标周');

/* 断言 */
const w9 = render(9, '第9周复查');
const w11 = render(11, '第11周复查');
const w9Has = w9.some(r => r.name === '微课设计与制作' && r.group === 'B');
const w11Makeup = w11.find(r => r.name === '微课设计与制作' && r.tag && r.day === 3 && r.period === 4);
const w11Home = w11.find(r => r.name === '微课设计与制作' && !r.tag && r.day === 1 && r.period === 4);
console.log('\n结论：');
console.log('  第9周 微课设计与制作 不上          : ' + (w9Has ? '✗ 仍在（错）' : '✓'));
console.log('  第11周 周三第4节 补课             : ' + (w11Makeup ? '✓ ' + w11Makeup.name : '✗ 缺失（错）'));
console.log('  第11周 周一第4节 常规课仍在        : ' + (w11Home ? '✓' : '✗ 缺失（错）'));
process.exit((!w9Has && w11Makeup && w11Home) ? 0 : 1);
