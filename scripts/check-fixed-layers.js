/**
 * 列出小程序里所有 position:fixed 的规则及其层级 / 几何，
 * 用于排查「底部自定义 tabBar 点不动」——若某全屏固定层 z-index 高于 tabBar(900) 就会盖住它。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', 'miniprogram');

function walk(d, out = []) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) { if (f === 'node_modules') continue; walk(p, out); }
    else out.push(p);
  }
  return out;
}

const TABBAR_Z = 900;
const rows = [];
walk(ROOT).filter(f => f.endsWith('.wxss')).forEach(f => {
  const s = fs.readFileSync(f, 'utf8');
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(s))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    const body = m[2];
    if (!/position\s*:\s*fixed/.test(body)) continue;
    const geo = ['top', 'bottom', 'left', 'right']
      .map(k => { const x = new RegExp(k + '\\s*:\\s*([^;]+)').exec(body); return x ? k + '=' + x[1].trim() : null; })
      .filter(Boolean).join(' ');
    const zi = (/z-index\s*:\s*([^;]+)/.exec(body) || [])[1] || '-';
    rows.push({ file: path.relative(ROOT, f), sel, geo, zi: String(zi).trim() });
  }
});

rows.sort((a, b) => (parseInt(b.zi, 10) || 0) - (parseInt(a.zi, 10) || 0));
rows.forEach(r => {
  const n = parseInt(r.zi, 10);
  const flag = (!isNaN(n) && n > TABBAR_Z) ? '  ← 高于 tabBar(900)，会盖住' : '';
  const full = /top=0/.test(r.geo) && /bottom=0/.test(r.geo) && /left=0/.test(r.geo) && /right=0/.test(r.geo);
  console.log(
    r.file.padEnd(36) + ' | ' + r.sel.slice(0, 32).padEnd(34) +
    ' | z=' + r.zi.padEnd(5) + ' | ' + r.geo.padEnd(40) + (full ? '(全屏)' : '') + flag
  );
});
