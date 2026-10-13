/**
 * 门禁：xlsx-lite 解析器（零依赖）
 * ------------------------------------------------------------
 * 直接 require cloudfunctions/member/xlsx-lite.js（与生产同源），用真实 xlsx 校验：
 *   · 若存在 scripts/fixtures/roster-mini.xlsx → 校验表头与单元格
 *   · 若存在环境变量 ROSTER_XLSX 指向的文件（或桌面「学生信息表.xlsx」）→ 校验整表行数与分组
 * 退出码 0 = 通过。
 */
const fs = require('fs');
const path = require('path');
const { parseXlsx, sheetToText } = require('../cloudfunctions/member/xlsx-lite');

const ROOT = path.resolve(__dirname, '..');
let bad = 0;
const ok = (cond, msg) => { if (cond) console.log('PASS  ' + msg); else { console.log('FAIL  ' + msg); bad++; } };

/* ---------- ① 仓库内置小样本 ---------- */
const fixture = path.join(ROOT, 'scripts/fixtures/roster-mini.xlsx');
console.log('--- ① 内置样本 ---');
if (!fs.existsSync(fixture)) {
  console.log('SKIP  未找到 ' + fixture);
} else {
  const sheets = parseXlsx(fs.readFileSync(fixture));
  ok(sheets.length === 1, '解析出 1 个工作表（实际 ' + sheets.length + '）');
  const rows = sheets[0].rows;
  ok(rows.length === 5, '共 5 行（实际 ' + rows.length + '）');
  ok(rows[0].join(',') === '专业班级,学号,姓名,性别,指导员', '表头正确：' + rows[0].join(','));
  ok(rows[1][1] === '209901030301' && rows[1][2] === '示例成员60', '第 2 行学号/姓名正确（t="s" 共享字符串）');
  ok(rows[3][2] === '内联姓名', '第 4 行取到 inlineStr 文本');
  const text = sheetToText(sheets[0]);
  ok(text.split('\n').length === 5, 'sheetToText 输出 5 行');
}

/* ---------- ② 真实名单（可选） ---------- */
console.log('\n--- ② 真实名单（可选） ---');
const realPath = process.env.ROSTER_XLSX || 'C:/Users/PC/Desktop/学生信息表.xlsx';
if (!fs.existsSync(realPath)) {
  console.log('SKIP  未找到 ' + realPath);
} else {
  const sheets = parseXlsx(fs.readFileSync(realPath));
  ok(sheets.length >= 1, '解析出工作表（实际 ' + sheets.length + '）');
  const rows = sheets[0].rows;
  ok(rows.length === 200, '共 200 行（表头 + 199 条，实际 ' + rows.length + '）');
  ok(rows[0].join(',') === '专业班级,学号,姓名,性别,指导员', '表头正确：' + rows[0].join(','));
  const text = sheetToText(sheets[0]);
  const lines = text.split('\n');
  ok(lines.length === 200, 'sheetToText 输出 200 行（实际 ' + lines.length + '）');
  const bucket = new Map();
  lines.slice(1).forEach((l) => {
    const k = l.split('\t')[0];
    bucket.set(k, (bucket.get(k) || 0) + 1);
  });
  ok(bucket.size === 5, '分成 5 个班级标签（实际 ' + bucket.size + '）');
  ok(bucket.get('示例专业B1班') === 57, '示例专业B1班 = 57 人（实际 ' + (bucket.get('示例专业B1班') || 0) + '）');
  ok(bucket.get('示例专业A2班') === 56, '小学教育示例班级B = 56 人（实际 ' + (bucket.get('示例专业A2班') || 0) + '）');
  ok(bucket.get('示例专业A1班') === 56, '小学教育示例班级A = 56 人（实际 ' + (bucket.get('示例专业A1班') || 0) + '）');
}

console.log('\n' + (bad === 0 ? '✅ xlsx 解析门禁全部通过' : '❌ ' + bad + ' 项不通过'));
process.exitCode = bad === 0 ? 0 : 1;
