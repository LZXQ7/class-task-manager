/**
 * 门禁：源码坏字节体检（2026-11-14 立）
 * ============================================================
 * 起因：用户报「打不开了」—— 开发者工具整页白屏 +「编译 WXSS 交…控制台查看更详细信息」。
 * 真因：源码注释里混进了 **U+FFFD 替换字符**（UTF-8 多字节汉字被写入时截断的产物）。
 * 为什么门禁没抓住：本地 wcsc **能容忍**它（落在注释里就跳过），
 *   而 **IDE 的编译器在词法阶段就报 unexpected ''** ⇒ 整页白屏。
 *   ⇒ 「本地编译通过」不等于「IDE 能打开」。
 *
 * 体检三项：
 * ① **U+FFFD 替换字符**（含非法 UTF-8 字节）—— 编译器高危
 * ② **UTF-8 BOM 夹在文件中间**（原文件开头被顶到第 2 行就会出现）—— 编译器高危
 * ③ **CRLF 行尾** —— 本机编辑器写出来的，变异锚点会匹配失败（已有 normalize-eol 处理，
 *    这里只做提醒不判死，避免和 normalize-eol.js 的职责重叠）
 *
 * 扫描范围：**只扫会被编译/打包的目录**（miniprogram/、cloudfunctions/、根配置），
 * 跳过 .workbuddy/backups（历史备份，不参与编译）、node_modules、.git。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT = new Set(['.wxml', '.wxss', '.js', '.json', '.wxs', '.ts', '.html', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.wb_tmp', 'miniprogram_npm', 'backups', '_dbg_room']);
/** 只扫这些前缀（会被编译/打包的路径） */
const SCAN_ROOTS = ['miniprogram', 'cloudfunctions', 'admin-web', 'scripts'];

function walk(dir, out) {
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const n of names) {
    const full = path.join(dir, n.name);
    if (n.isDirectory()) {
      if (SKIP_DIRS.has(n.name)) continue;
      walk(full, out);
    } else if (EXT.has(path.extname(n.name))) {
      out.push(full);
    }
  }
}

const files = [];
for (const r of SCAN_ROOTS) {
  const p = path.join(ROOT, r);
  if (fs.existsSync(p)) walk(p, files);
}
// 根配置文件
['project.config.json', 'project.private.config.json'].forEach(f => {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
});

const problems = [];
let crlf = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const buf = fs.readFileSync(f);
  const s = buf.toString('utf8');

  // ① U+FFFD / 非法 UTF-8
  const badBytes = Buffer.from(s, 'utf8').compare(buf) !== 0;
  const hasFffd = s.indexOf('\uFFFD') >= 0;
  if (badBytes || hasFffd) {
    const lines = s.split('\n');
    const where = [];
    lines.forEach((line, i) => {
      if (line.indexOf('\uFFFD') >= 0) where.push('第 ' + (i + 1) + ' 行');
    });
    problems.push(rel + ' :: 含 U+FFFD/非法 UTF-8 字节' + (where.length ? '（' + where.slice(0, 3).join('、') + '）' : ''));
  }

  // ② BOM 夹在中间
  const firstBOM = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (!firstBOM && s.indexOf('\uFEFF') >= 0) {
    problems.push(rel + ' :: 文件中间夹了 BOM（开头 BOM 被挤到中间）');
  }

  // ③ CRLF（提醒级）
  if (s.indexOf('\r\n') >= 0) crlf++;
}

console.log('扫描 ' + files.length + ' 个会被编译的文本文件（miniprogram / cloudfunctions / admin-web / scripts + 根配置）');
if (problems.length) {
  console.log('\n✗ 发现 ' + problems.length + ' 个含坏字节的文件（**IDE 会白屏**）：');
  problems.forEach(p => console.log('   ' + p));
  console.log('\n修复办法：用 Node 脚本按上下文替换（Edit 工具匹配不上 U+FFFD）。');
  process.exit(1);
}
if (crlf) {
  console.log('ℹ ' + crlf + ' 个文件是 CRLF 行尾 —— 跑 `node scripts/normalize-eol.js` 修正（否则门禁变异锚点会静默失效）');
}
console.log('\n✓ 源码字节体检通过：无 U+FFFD / 无非法 UTF-8 / 无中间 BOM');
