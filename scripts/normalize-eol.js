// 把仓库内**文本文件**的行尾统一成 LF（一次性 / 可重复跑）。
//   node scripts/_normalize-eol.js
// 背景：编辑器/工具在本机写文件时会落成 CRLF，而入库一直是 LF；
//   部分门禁按 `\n` 拼多行锚点做变异自证，CRLF 会让锚点匹配失败
//   ⇒ 门禁假红（「锚点不存在」），掩盖真实覆盖。
// 只处理 git 跟踪的文本扩展名，跳过 node_modules / _online / 二进制。
const fs = require('fs');
const path = require('path');
const cf = require('./lib/changed-files');

const ROOT = path.resolve(__dirname, '..');
/* ⚠️ .css 必须包含（2026-11-16 补）：网页后台的 admin.css 有 1700+ 行，
   多行正则锚点极多；一旦被写成 CRLF，check-admin-css-tokens 的变异/匹配
   会静默失配 ⇒ 门禁假绿。设计顾问实测踩过这个坑。 */
const EXTS = ['.js', '.wxs', '.json', '.wxml', '.wxss', '.md', '.sql', '.sh', '.mjs', '.cjs', '.yml', '.yaml', '.css', '.html'];

/* ⚠️ 必须同时吃下**未跟踪**文件（2026-11-16 补，11-27 抽共享原语）：
   git ls-files 只看已入库文件，新建的门禁脚本/outputs 在 git add 之前没有 EOL 保护。
   文件集统一走 scripts/lib/changed-files.js 的 sourceFiles()——三处门禁同一实现，
   新增信号形态只改一处（M1 同源多点漏改防线）。 */
const files = cf.sourceFiles(ROOT)
  .filter(f => EXTS.includes(path.extname(f).toLowerCase()))
  .filter(f => !f.startsWith('node_modules/') && !f.includes('/node_modules/') && !f.startsWith('_online/'));

let changed = 0;
const touched = [];
for (const rel of files) {
  const p = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { continue; }
  const s = buf.toString('utf8');
  if (s.indexOf('\r\n') < 0) continue;
  fs.writeFileSync(p, s.replace(/\r\n/g, '\n'));
  changed++;
  touched.push(rel);
}

console.log('扫描 ' + files.length + ' 个文本文件，修正 ' + changed + ' 个 CRLF → LF');
touched.slice(0, 40).forEach(f => console.log('  · ' + f));
if (touched.length > 40) console.log('  … 其余 ' + (touched.length - 40) + ' 个略');
