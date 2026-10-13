/**
 * 开发夹具生成器：把已解码的青果 HTML 课表（sheet001.htm，GB2312）渲染成
 * 真实 .xlsx（与用户在 Excel/WPS 里「另存为 .xlsx」得到的文件同构：同样的
 * 合并单元格布局），用于 import-parse.js 的开发与门禁自测。
 *
 * 运行：node scripts/make-fixture.js
 * 产物：scripts/fixtures/timetable-示例班级A.xlsx
 */
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const XLSX = require(path.resolve(__dirname, '../cloudfunctions/course/node_modules/xlsx'));

const SRC = 'D:/PC/Downloads/教学安排表.files/sheet001.htm';
const OUT = path.resolve(__dirname, 'fixtures/timetable-示例班级A.xlsx');

function decode(buf) {
  // Node 的 Buffer.toString 不支持 gb2312/gbk，必须用 TextDecoder（v22 自带完整 ICU）
  try { return new TextDecoder('gbk').decode(buf); } catch (e) { /* fallback */ }
  return buf.toString('utf-8');
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

/** 把 HTML <table> 渲染成 2D 网格（标准 HTML 表格布局：colspan/rowspan 占位），
 *  并记录合并信息。rowspan 占位的列在后续行中保留，模拟浏览器/Excel 的真实落位。 */
function renderTables(html) {
  const tables = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)]
    .map(m => m[1]);
  let best = null, bestRows = -1;
  for (const tbody of tables) {
    const rowEls = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    const grid = [];
    const merges = [];
    const reservations = []; // reservations[r] = 该行被历史 rowspan 占用的列号数组
    let r = 0;
    for (const rm of rowEls) {
      if (!grid[r]) grid[r] = [];
      const reservedHere = reservations[r] || [];
      let c = 0;
      while (reservedHere.includes(c)) { if (grid[r][c] === undefined) grid[r][c] = ''; c++; }
      const inner = rm[1];
      const cellEls = [...inner.matchAll(/<td\b([^>]*?)(?:\/>|>([\s\S]*?)<\/td>)/gi)];
      for (const ce of cellEls) {
        const attrs = ce[1] || '';
        const body = ce[2] || '';
        const cs = parseInt((/colspan\s*=\s*"?(\d+)/i.exec(attrs) || [])[1] || '1', 10);
        const rs = parseInt((/rowspan\s*=\s*"?(\d+)/i.exec(attrs) || [])[1] || '1', 10);
        while ((reservations[r] || []).includes(c)) { if (grid[r][c] === undefined) grid[r][c] = ''; c++; }
        const text = decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) {
          const rr = r + dr, cc = c + dc;
          if (!grid[rr]) grid[rr] = [];
          grid[rr][cc] = text;
        }
        if (rs > 1 || cs > 1) merges.push({ r, c, rs, cs });
        for (let dr = 1; dr < rs; dr++) {
          const rr = r + dr;
          if (!reservations[rr]) reservations[rr] = [];
          for (let dc = 0; dc < cs; dc++) reservations[rr].push(c + dc);
        }
        c += cs;
      }
      r++;
    }
    const maxC = grid.reduce((m, row) => Math.max(m, (row || []).length), 0);
    for (const row of grid) for (let i = 0; i < maxC; i++) if (row[i] === undefined) row[i] = '';
    if (grid.length > bestRows) { bestRows = grid.length; best = { grid, merges }; }
  }
  return best;
}

const html = decode(fs.readFileSync(SRC));
const { grid, merges } = renderTables(html);

console.log('=== 渲染网格（' + grid.length + ' 行 × ' + grid[0].length + ' 列，' + merges.length + ' 处合并）===');
grid.forEach((row, i) => console.log(String(i).padStart(2) + ': ' + row.map(c => (c || '·')).join(' | ')));

// 生成 .xlsx：仅写合并区左上角，其余留空（模拟 Excel 合并单元格行为，迫使解析器自己展开）
const covered = new Set();
for (const m of merges) {
  for (let dr = 0; dr < m.rs; dr++) for (let dc = 0; dc < m.cs; dc++) {
    if (dr || dc) covered.add((m.r + dr) + ',' + (m.c + dc));
  }
}
const ws = {};
const maxR = grid.length - 1, maxC = grid[0].length - 1;
for (let r = 0; r <= maxR; r++) {
  for (let c = 0; c <= maxC; c++) {
    const text = (grid[r] && grid[r][c]) || '';
    if (!text || covered.has(r + ',' + c)) continue; // 合并覆盖格留空
    ws[XLSX.utils.encode_cell({ r, c })] = { t: 's', v: text };
  }
}
ws['!merges'] = merges.map(m => ({ s: { r: m.r, c: m.c }, e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 } }));
ws['!ref'] = XLSX.utils.encode_range({ r: 0, c: 0 }, { r: maxR, c: maxC });

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, '教学安排表');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT);
console.log('\n写入夹具：' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');

/* ---- 回环校验：读回 .xlsx，展开合并，把网格 dump 成 UTF-8 文本供人工核对 ---- */
function expandMerges(rows, merges) {
  const out = rows.map(r => r.slice());
  for (const m of merges) {
    const top = out[m.r] && out[m.r][m.c];
    for (let dr = m.r; dr <= m.r + m.rs - 1; dr++) {
      for (let dc = m.c; dc <= m.c + m.cs - 1; dc++) {
        if (!out[dr]) out[dr] = [];
        if (out[dr][dc] === undefined || out[dr][dc] === '') out[dr][dc] = top;
      }
    }
  }
  return out;
}
const rb = XLSX.readFile(OUT);
const raw = XLSX.utils.sheet_to_json(rb.Sheets[rb.SheetNames[0]], { header: 1, defval: '' });
const merged = expandMerges(raw, rb.Sheets[rb.SheetNames[0]]['!merges'] || []);
const dump = merged.map((row, i) => String(i).padStart(2) + ': ' + row.map(c => (c || '·')).join(' | ')).join('\n');
fs.writeFileSync(path.resolve(__dirname, 'fixtures/_grid.txt'), dump, 'utf8');
console.log('回环网格已 dump 到 scripts/fixtures/_grid.txt');
