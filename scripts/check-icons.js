const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'miniprogram');
const icons = require(path.join(R, 'utils/icons.js'));
const keys = Object.keys(icons.ICONS || icons);
const used = new Set();

function walk(d) {
  fs.readdirSync(d).forEach((n) => {
    const p = path.join(d, n);
    const s = fs.statSync(p);
    if (s.isDirectory()) return walk(p);
    if (!/\.(wxml|js)$/.test(n)) return;
    const t = fs.readFileSync(p, 'utf8');
    let m;
    const re1 = /name="([a-z0-9-]+)"/g;
    while ((m = re1.exec(t))) used.add(m[1]);
    const re2 = /icon="([a-z0-9-]+)"/g;
    while ((m = re2.exec(t))) used.add(m[1]);
    const re3 = /icon:\s*'([a-z0-9-]+)'/g;
    while ((m = re3.exec(t))) used.add(m[1]);
    const re4 = /get\('([a-z0-9-]+)'/g;
    while ((m = re4.exec(t))) used.add(m[1]);
  });
}
walk(R);

const miss = [...used].filter((x) => !keys.includes(x));
console.log('icons defined:', keys.length, '| used:', used.size);
console.log('undefined icons:', miss.length ? miss : 'none');
console.log('unused icons:', keys.filter((k) => !used.has(k)).join(', ') || 'none');
