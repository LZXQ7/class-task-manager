// 把仓库内**文本文件**的行尾统一成 LF（一次性 / 可重复跑）。
//   node scripts/_normalize-eol.js
// 背景：编辑器/工具在本机写文件时会落成 CRLF，而入库一直是 LF；
//   部分门禁按 `\n` 拼多行锚点做变异自证，CRLF 会让锚点匹配失败
//   ⇒ 门禁假红（「锚点不存在」），掩盖真实覆盖。
// 只处理 git 跟踪的文本扩展名，跳过 node_modules / _online / 二进制。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXTS = ['.js', '.wxs', '.json', '.wxml', '.wxss', '.md', '.sql', '.sh', '.mjs', '.cjs', '.yml', '.yaml'];

const files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean)
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
