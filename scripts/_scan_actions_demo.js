/**
 * 扫描所有云函数 routes 的 action 键，按前端同一套写类关键词分类。
 * 目的：为「演示班级后端只读闸」设计白名单，避免把只读功能误拦。
 * 只读扫描，不修改任何文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'cloudfunctions');
const WRITE_ACTION = /(add|save|set|update|remove|delete|clear|publish|unpublish|apply|import|revert|confirm|cancel|bind|unbind|toggle|move|append|copy|submit|upsert|generate|reassign|swap|handle|track|send|create|mark|reset|upload)/i;

function actionsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  // routes 对象里的键：形如 `  'leaveApply': {` 或 `  leaveApply: {`
  const out = new Set();
  const re = /^\s{2}'?([A-Za-z][\w.]*)'?\s*:\s*\{/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

const rows = [];
for (const fn of fs.readdirSync(ROOT)) {
  const f = path.join(ROOT, fn, 'index.js');
  if (!fs.existsSync(f)) continue;
  if (['common', 'admin-web', 'cron-weekly', 'audit-receiver'].includes(fn)) continue;
  const acts = actionsOf(f);
  const write = [...acts].filter(a => WRITE_ACTION.test(a)).sort();
  const read = [...acts].filter(a => !WRITE_ACTION.test(a)).sort();
  rows.push({ fn, total: acts.size, write, read });
}

for (const r of rows) {
  console.log(`\n===== ${r.fn} (${r.total} actions) =====`);
  console.log('  WRITE:', r.write.join(', ') || '(none)');
  console.log('  READ :', r.read.join(', ') || '(none)');
}
console.log('\n----- 汇总：写类 action 总数 -----');
console.log(rows.reduce((n, r) => n + r.write.length, 0));
