// 生产库通用 SQL 执行器（写/读）。用 spawnSync 传参数组，彻底避开 shell 引号/反斜杠转义层。
//   写：  node scripts/_sql.js "UPDATE ..."
//   读：  node scripts/_sql.js --ro "SELECT ..."
// 输出同时写 scripts/_q_<标题>.txt（避开 GBK 控制台乱码）并打印到 stdout。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TCBJS = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';

const argv = process.argv.slice(2);
const ro = argv[0] === '--ro';
const sql = (ro ? argv.slice(1) : argv).join(' ');
if (!sql) { console.error('usage: node scripts/_sql.js [--ro] "<sql>"'); process.exit(2); }

function run(sqlText, readOnly) {
  const args = [TCBJS, 'db', 'execute', '-e', ENV, '-r', 'ap-shanghai'];
  if (readOnly) args.push('--read-only');
  args.push('-s', sqlText);
  let last = null;
  for (let i = 0; i < 4; i++) {
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return { ok: true, out: r.stdout || '' };
    last = (r.stdout || '') + '\n' + (r.stderr || '');
    const t = Date.now(); while (Date.now() - t < 1200) { /* 同步重试间隔 */ }
  }
  return { ok: false, out: last || '(no output)' };
}

const r = run(sql, ro);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(__dirname, '_q_sql_' + stamp + '.txt');
fs.writeFileSync(file, (ro ? '[RO] ' : '[RW] ') + sql + '\n\n' + r.out, 'utf8');
process.stdout.write(r.out);
if (!r.ok) process.exit(1);
