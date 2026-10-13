// 生产库只读查询助手：node run_query.js <tag> "<SQL>"
// 结果以 UTF-8 写入 scripts/_q_<tag>.txt（避开 bash 控制台 GBK 编码问题）
const { execSync } = require('child_process');
const fs = require('fs');

const TCBJS = "C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb";
const ENV = "<YOUR_ENV_ID>";

const tag = process.argv[2];
const sql = process.argv.slice(3).join(' ');
if (!tag || !sql) { console.error('usage: node run_query.js <tag> "<sql>"'); process.exit(2); }
const OUT = __dirname + "/_q_" + tag + ".txt";

function syncSleep(ms){ const t=Date.now(); while(Date.now()-t<ms){} }

try { execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai --read-only -s "SELECT 1"', { encoding:'utf8', maxBuffer:32*1024*1024, stdio:['ignore','pipe','pipe'] }); }
catch (e) { /* ignore warmup */ }

let lastErr = '';
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const out = execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai --read-only -s "' + sql + '"',
      { encoding:'utf8', maxBuffer:32*1024*1024, stdio:['ignore','pipe','pipe'] });
    fs.writeFileSync(OUT, out || '(empty)', { encoding:'utf8' });
    process.stdout.write(out);
    process.exit(0);
  } catch (e) {
    lastErr = String(e.stdout || '') + '\n' + String(e.stderr || '');
    if (attempt < 3) syncSleep(1500);
  }
}
fs.writeFileSync(OUT, 'QUERY FAILED:\n' + lastErr, { encoding:'utf8' });
process.stderr.write(lastErr);
process.exit(1);
