const fs = require('fs');
const path = require('path');
const XLSX = require(path.resolve('cloudfunctions/course/node_modules/xlsx'));
const { expandMerges } = require('../cloudfunctions/course/import-parse');

const buf = fs.readFileSync(path.resolve(__dirname, 'fixtures/timetable-示例班级A.xlsx'));
const wb = XLSX.read(buf, { type: 'buffer', cellHTML: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
const grid = expandMerges(raw, ws['!merges'] || []).map(row => row.map(c => String(c == null ? '' : c).trim()));

const row2 = grid[2];
console.log('grid[2] length', row2.length);
row2.forEach((c, i) => {
  const codes = Array.from(c).map(ch => ch.codePointAt(0).toString(16)).join(',');
  console.log(i, JSON.stringify(c), 'codes=[' + codes + ']');
});
console.log('includes 星期一 ?', row2.includes('星期一'));
console.log('indexOf 星期一 =', row2.indexOf('星期一'));
