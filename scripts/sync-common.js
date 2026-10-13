/**
 * 部署前置：把 cloudfunctions/common 复制进每个函数目录（附录 A sync.js）
 * 用法：node scripts/sync-common.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'cloudfunctions');
const commonDir = path.join(root, 'common');
// ai-proxy 是无依赖的纯转发函数（不连库、不用微信上下文），不需要 common，跳过以保持包体最小
const SKIP = ['ai-proxy'];
const fns = fs.readdirSync(root).filter(f => {
  const p = path.join(root, f);
  return fs.statSync(p).isDirectory() && f !== 'common' && !f.startsWith('.') && SKIP.indexOf(f) < 0;
});

for (const fn of fns) {
  const dest = path.join(root, fn, 'common');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(commonDir)) {
    fs.copyFileSync(path.join(commonDir, f), path.join(dest, f));
  }
  console.log('synced common ->', fn);
}
console.log('done:', fns.length, 'functions');
