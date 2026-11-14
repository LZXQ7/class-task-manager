/* 扫描所有 <app-icon name="X" variant="Y"> 用法，检查 X 的 Y 变体在 icons.js 里是否存在。
 * 变体不存在时 get() 会**静默回落到第一个变体** ⇒ 图标颜色悄悄变错（本次：check+brand → white）。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const icons = require(path.join(MINI, 'utils', 'icons.js'));

const uses = [];
function walk(d) {
  fs.readdirSync(d).forEach((n) => {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) return walk(p);
    if (!/\.(wxml|js)$/.test(n)) return;
    const t = fs.readFileSync(p, 'utf8');
    const re = /name="([a-z0-9-]+)"\s+variant="([a-z]+)"/g;
    let m;
    while ((m = re.exec(t))) {
      uses.push({ name: m[1], variant: m[2], file: path.relative(ROOT, p).replace(/\\/g, '/'), line: t.slice(0, m.index).split('\n').length });
    }
  });
}
walk(MINI);

const bad = [];
const seen = new Set();
uses.forEach(u => {
  const key = u.name + '|' + u.variant;
  if (seen.has(key)) return;
  seen.add(key);
  const item = icons.ICONS[u.name];
  if (!item) { bad.push({ ...u, why: '图标名不存在' }); return; }
  if (!item[u.variant]) {
    bad.push({ ...u, why: '变体不存在 ⇒ 回落成 ' + Object.keys(item)[0] });
  }
});
console.log('扫描到 ' + uses.length + ' 处 name+variant 用法（去重后 ' + seen.size + ' 组）');
if (!bad.length) console.log('✓ 全部变体都存在');
else {
  console.log('✗ ' + bad.length + ' 组变体缺失：');
  bad.forEach(b => console.log('  ' + b.file + ':' + b.line + '  ' + b.name + '/' + b.variant + '  → ' + b.why));
}
process.exit(bad.length ? 1 : 0);
