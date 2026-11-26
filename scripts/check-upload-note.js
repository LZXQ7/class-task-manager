#!/usr/bin/env node
/**
 * 门禁：mp 后台「项目备注」= 简短更新说明（2026-11-19 用户口径）
 * ------------------------------------------------------------------
 * 备注只取 outputs/v<版本>-更新说明.md 的「## 一句话」+「## 改了什么」表格，
 * 转成纯文本；不再转录「需求口径 / 前端 / 门禁 / 生效条件」长文（旧版 500 字被截断）。
 *
 * 判据分三层：
 *   A. 真跑解析器：拿 1.0.8.69 / 1.0.8.70 真实更新说明，检查输出内容 + 无内部长文 / markdown 残留；
 *   B. 接线检查：upload.mjs 导入并优先调用 readShortNote，版本 B 只作兜底；
 *   C. 变异自证：改坏解析器的 5 处 + 改坏 upload.mjs 接线 1 处，必须翻红。
 * 用法：node scripts/check-upload-note.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PARSER = path.join(ROOT, 'scripts/wx-upload/note-parser.mjs');
const UPLOAD = path.join(ROOT, 'scripts/wx-upload/upload.mjs');
const parserSrc = fs.readFileSync(PARSER, 'utf8');
const uploadSrc = fs.readFileSync(UPLOAD, 'utf8');

function loadParser(src) {
  // 纯函数模块：去掉 export 后在内存里求值，不改盘、不落临时文件
  return new Function(src.replace(/\bexport\s+/g, '') + '\nreturn parseShortNote;')();
}
const parse = loadParser(parserSrc);

function note(ver) {
  const f = path.join(ROOT, 'outputs', `v${ver}-更新说明.md`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
const n70 = note('1.0.8.70') || '';
const n69 = note('1.0.8.69') || '';
const out70 = parse(n70) || '';
const out69 = parse(n69) || '';
const n86 = note('1.0.8.86') || '';
const out86 = parse(n86) || '';

let failed = 0;
function check(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; }

console.log('── ① 真跑解析器：只留一句话 + 改了什么');
check(!!n70 && !!n69, '1.0.8.69 / 1.0.8.70 更新说明都在');
check(/双向对调/.test(out70) && /值日详情/.test(out70), '1.0.8.70 备注含一句话要点');
check((out70.match(/\n/g) || []).length >= 2, '1.0.8.70 备注含「改了什么」多行改动');
check(!/需求口径|###|升级后生效条件|版本 A|版本 B/.test(out70), '不含需求口径 / 前端 / 门禁 / 版本 A/B 长文');
check(!/\|/.test(out70) && !/`|\*\*/.test(out70), 'markdown 表格线与加粗符号已清掉');
check(/双向对调/.test(out69) && !/需求口径/.test(out69), '旧版 1.0.8.69 同样走简短说明');
check(/export const NOTE_MAX = 200/.test(parserSrc), '解析器硬上限 = 200 字（2026-11-26 用户口径）');
check(/const DESC_MAX = NOTE_MAX/.test(uploadSrc), 'upload.mjs 上限直接引用 NOTE_MAX，防止两处漂移');
check(out70.length > 0 && out70.length <= 200, '1.0.8.70 备注在 200 字上限内');
check(out86.length > 0 && out86.length <= 200, '1.0.8.86 备注在 200 字上限内（实测 ' + out86.length + ' 字）');
check(/…$/.test(out86) && /课前演讲/.test(out86), '1.0.8.86 超长时在句读边界收尾、保留一句话要点');
check(parse('## 版本 B（面向开发者）\n- 只有公告版') === null, '老说明只有版本 B → 返回 null 交给调用方兜底');
check(parse('') === null && parse(null) === null, '空输入返回 null');

console.log('\n── ② upload.mjs 接线：简短说明优先，版本 B 仅兜底');
check(/import\s*\{\s*parseShortNote(?:\s*,\s*NOTE_MAX)?\s*\}\s*from\s*'\.\/note-parser\.mjs'/.test(uploadSrc),
  'upload.mjs 导入纯解析函数');
check(/function readShortNote\(ver\)/.test(uploadSrc) && /parseShortNote\(fs\.readFileSync/.test(uploadSrc),
  'upload.mjs 有 readShortNote 读文件并解析');
const shortAt = uploadSrc.indexOf('desc = readShortNote(version)');
const legacyAt = uploadSrc.indexOf('desc = readAnnouncement(version)');
check(shortAt > 0 && legacyAt > shortAt, '先取简短说明，取不到才回退版本 B');
check(/简短更新说明/.test(uploadSrc) && /版本 B 公告版兜底/.test(uploadSrc), '来源提示写明新口径与兜底');

/* ---------------- ③ 变异自证 ---------------- */
console.log('\n── ③ 变异自证');
const MD = '# 1.0.9.9 更新说明\n\n## 一句话\n修好 **按钮** 的 `点击`。\n\n## 改了什么\n\n| 位置 | 改前 | 改后 |\n|---|---|---|\n| A页 | 坏的 | 好的 |\n';
const MUT = [
  { name: '解析器丢掉「一句话」', target: 'parser', probe: 'missOne',
    apply: s => s.replace(/const one = section\(lines, \/\^##\\s\*一句话\/\).*?\.join\('\\n'\);/s, "const one = '';"),
    judge: s => { const p = loadParser(s); return /修好/.test(p(MD)); } },
  { name: '解析器不再收表格行（把 | 开头全丢掉）', target: 'parser', probe: 'missRows',
    apply: s => s.replace("if (!line.startsWith('|')) return;", "if (line.startsWith('|')) return;"),
    judge: s => { const p = loadParser(s); return /A页：坏的 → 好的/.test(p(MD)); } },
  { name: '表头行漏进备注', target: 'parser', probe: 'header',
    apply: s => s.replace("cells[0] === '位置' || (cells[1] === '改前' && cells[2] === '改后') || ", ''),
    judge: s => { const p = loadParser(s); return !/位置：改前 → 改后/.test(p(MD)); } },
  { name: '不清 markdown 符号', target: 'parser', probe: 'markdown',
    apply: s => s.replace(/function clean\(s\) \{[\s\S]*?\n\}/, 'function clean(s) { return String(s || "").trim(); }'),
    judge: s => { const p = loadParser(s); return !/`|\*\*/.test(p(MD)); } },
  { name: '两个节都没有时仍硬造空备注', target: 'parser', probe: 'empty',
    apply: s => s.replace('if (!one && !changes.length) return null;', 'if (false) return null;'),
    judge: s => { const p = loadParser(s); return p('随便一段文本') === null; } },
  { name: '去掉 200 字安全截断（备注重新超长）', target: 'parser', probe: 'clamp',
    apply: s => s.replace('return clampNote(full, max);', 'return full;'),
    judge: s => { const p = loadParser(s); return p(n86).length <= 200; } },
  { name: 'upload.mjs 退回版本 B 优先', target: 'upload', probe: 'wire',
    apply: s => s.replace('desc = readShortNote(version)', 'desc = readAnnouncement(version)'),
    judge: s => { const a = s.indexOf('desc = readShortNote(version)'), b = s.indexOf('desc = readAnnouncement(version)'); return a > 0 && b > a; } }
];
MUT.forEach(mu => {
  const src = mu.target === 'parser' ? parserSrc : uploadSrc;
  const next = mu.apply(src);
  if (next === src) { console.log('  ✗ 变异「' + mu.name + '」锚点没命中'); failed++; return; }
  check(mu.judge(next) === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 项目备注门禁全部通过'));
process.exit(failed ? 1 : 0);
