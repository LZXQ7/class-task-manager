/**
 * 只读导出生产库数据 → scripts/_dump_w9.json（供 _repro_dup.js 离线复现）
 * 本机连不上 TDSQL（VPC 内），所以只能借 tcb db execute 取数。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TCB = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';
const CLASS_ID = 3;
const WEEK = Number(process.argv[2]) || 9;
const OUT = path.join(__dirname, '_dump_w' + WEEK + '.json');

const SQLS = {
  members: `SELECT id, student_no, group_tag, duty_count FROM member WHERE class_id=${CLASS_ID} AND status='ACTIVE' AND student_no NOT LIKE '0000000000%' AND group_tag<>'X' AND duty_off=0 ORDER BY student_no`,
  sessions: `SELECT id, week_rule, weeks, day_of_week, period, group_scope, duty_count, kind FROM session WHERE class_id=${CLASS_ID} ORDER BY day_of_week, period, id`,
  slots: `SELECT id, weekday, period, need_n, fixed_seq, kind, sort_order FROM duty_slot WHERE class_id=${CLASS_ID} ORDER BY sort_order, weekday, period`,
  manual: `SELECT session_id, class_date, member_id FROM duty WHERE class_id=${CLASS_ID} AND week=${WEEK} AND source='MANUAL' AND status<>'SWAPPED_OUT' ORDER BY session_id`,
  klass: `SELECT id, name, term_start, total_weeks, round_cursor_a, round_cursor_b FROM class WHERE id=${CLASS_ID}`,
  weekcur: `SELECT start_a, start_b, end_a, end_b FROM duty_week_cursor WHERE class_id=${CLASS_ID} AND week=${WEEK}`,
  holidays: `SELECT holiday_date, kind FROM holiday ORDER BY holiday_date`,
  dayshift: `SELECT id, week, from_date, to_date FROM day_shift ORDER BY from_date`,
  sessshift: `SELECT session_id, week, kind, to_day, to_period FROM session_shift WHERE class_id=${CLASS_ID}`,
  rules: `SELECT avoid_same_day, sort_by_count FROM schedule_rules WHERE class_id=${CLASS_ID} ORDER BY id LIMIT 1`
};

function q(sql) {
  const r = spawnSync('node', [TCB, 'db', 'execute', '-e', ENV, '-r', 'ap-shanghai', '--read-only', '--json', '-s', sql], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = String(r.stdout || '');
  const i = out.indexOf('{');
  if (i < 0) throw new Error('no json: ' + out.slice(0, 300) + ' | ' + String(r.stderr || '').slice(0, 300));
  const j = JSON.parse(out.slice(i));
  const items = j && j.data && j.data.items;
  if (!Array.isArray(items)) throw new Error('unexpected json: ' + JSON.stringify(j).slice(0, 300));
  return items;
}

const dump = {};
for (const k of Object.keys(SQLS)) {
  dump[k] = q(SQLS[k]);
  console.log(k, dump[k].length);
}
fs.writeFileSync(OUT, JSON.stringify(dump, null, 2), 'utf8');
console.log('→', OUT);
