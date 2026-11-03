#!/usr/bin/env node
/**
 * 离线自检：页面 / 组件 wxss 不得再写死「浅色裸 hex 表面」
 * ============================================================
 * 背景（P0 优化，2026-11-03）：
 *   原页面 / 组件 wxss 有 300+ 处写死浅色背景（#FFFFFF / #F7F8FA / #F0F5FF /
 *   各语义 tint 等），与 app.wxss 里早已存在的令牌**同值却重复写死**。深色模式
 *   下这些写死值不会跟随令牌翻成深底 ⇒ 一整片「白岛」，正是 config.DARK_MODE_ENABLED
 *   一直关着的主因（见 check-dark-mode.js ⑨ 注释「1000+ 处硬编码浅色没迁移」）。
 *
 *   已用 scripts/migrate-surface-tokens.mjs 把这些都替换成令牌（浅色值逐一等于令牌
 *   的 light 取值，故浅色观感零变化；深色下自动翻深底）。本门禁负责**守门**：
 *   以后谁再往 background / border* 里写「亮度 > 0.82 的裸 hex」就直接判红，
 *   防止白岛倒退。
 *
 * 判据：
 *   · 只扫 pages/ components/ custom-tab-bar 的 .wxss，**排除 app.wxss**（令牌源，
 *     里面 intentionally 写死大量浅色作兜底 / 极光渐变，不算倒退）。
 *   · background / background-color / border(-color/-top/...)：
 *       - 纯 hex 声明（background: #fff;）且亮度 > 0.82 → 违规；
 *       - border 简写（border: 1rpx solid #fff;）抽出的 hex 亮度 > 0.82 → 违规。
 *   · 已迁移残留的 #000000 / #1c2027（本身深色）与 #86909c（中灰，非白岛）亮度 < 0.82，
 *     放行。
 *   · 渐变 / rgba / var() / url 不算（值不是裸 hex）。
 *
 * 末尾带变异自证：好样本不误报、坏样本必被抓。
 * 用法：node scripts/check-surface-tokens.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed += 1; console.log('  ✗ ' + m); };
const chk = (cond, m) => (cond ? ok(m) : bad(m));

/* 亮度（0~1）。>0.82 视为「浅色表面」（白岛风险）。 */
function lum(hex) {
  const h = /^#?([0-9a-f]{3,8})$/i.exec(hex);
  if (!h) return null;
  let v = h[1];
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  if (v.length === 8) v = v.slice(0, 6); // 忽略 alpha
  const n = parseInt(v, 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
const HEXPAT = '#[0-9a-fA-F]{3,8}\\b';
const SURF_PROPS = ['background', 'background-color', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right', 'border-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color'];

/** 剥注释（与 check-dark-mode 同口径，避免注释里的字面量假失败） */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * 审一段 wxss 文本，返回违规项数组（字符串：行号 + hex）。
 * @param {string} text  已剥注释的 wxss
 */
function audit(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    for (const prop of SURF_PROPS) {
      // 纯 hex 声明：background: #fff;
      let re = new RegExp('(^|[^\\w-])(' + prop.replace(/-/g, '\\-') + ')\\s*:\\s*(' + HEXPAT + ')(\\s*!important)?\\s*;', 'i');
      let m = re.exec(line);
      if (m) {
        const h = m[3].toLowerCase();
        const L = lum(h);
        if (L !== null && L > 0.82) out.push((idx + 1) + ': ' + prop + ':' + h + ' (lum=' + L.toFixed(2) + ')');
        continue;
      }
      // border 简写：border: 1rpx solid #fff; —— 抽出 hex 判亮度
      if (/^border(-(top|bottom|left|right))?$/.test(prop)) {
        re = new RegExp('(^|[^\\w-])(' + prop.replace(/-/g, '\\-') + ')\\s*:\\s*[^;]*?(' + HEXPAT + ')[^;]*;', 'i');
        m = re.exec(line);
        if (m) {
          const h = m[3].toLowerCase();
          const L = lum(h);
          if (L !== null && L > 0.82) out.push((idx + 1) + ': ' + prop + ':' + h + ' (lum=' + L.toFixed(2) + ')');
        }
      }
    }
  });
  return out;
}

/* 文本中性色：浅色中性文字色必须走 --text-N，否则深色下「黑字压深底」看不清 */
const TEXT_HEX = ['#1d2129', '#4e5969', '#86909c', '#c9cdd4'];
function auditText(text) {
  const out = [];
  text.split('\n').forEach((line, idx) => {
    const m = /(^|[;\s{])color\s*:\s*(#[0-9a-fA-F]{6})\b/.exec(line);
    if (!m) return;
    const h = m[2].toLowerCase();
    if (TEXT_HEX.indexOf(h) >= 0) out.push((idx + 1) + ': color:' + h);
  });
  return out;
}

console.log('── 表面令牌守门（禁止页面级浅色裸 hex 倒退）');
// 收集目标文件（排除 app.wxss）
const TARGETS = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.wxss')) {
      const rel = path.relative(MINI, p).replace(/\\/g, '/');
      if (rel === 'app.wxss') continue;
      TARGETS.push(rel);
    }
  }
}
walk(path.join(MINI, 'pages'));
walk(path.join(MINI, 'components'));
walk(path.join(MINI, 'custom-tab-bar'));

let violations = 0;
for (const rel of TARGETS) {
  const raw = fs.readFileSync(path.join(MINI, rel), 'utf8');
  const v = audit(stripComments(raw));
  if (v.length) {
    bad(rel + ' 仍有浅色裸 hex 表面：\n      ' + v.join('\n      '));
    violations += v.length;
  }
}
if (!violations) ok('全部 ' + TARGETS.length + ' 个页面 / 组件 wxss 已无浅色裸 hex 表面（白岛不再倒退）');

/* ── 文本中性色守门：写死 #1D2129/#4E5969/#86909C/#C9CDD4 在深色下必看不清 ── */
let textViolations = 0;
for (const rel of TARGETS) {
  const raw = fs.readFileSync(path.join(MINI, rel), 'utf8');
  const v = auditText(stripComments(raw));
  if (v.length) {
    bad(rel + ' 仍有写死的中性文字色（深色下黑字压深底）：\n      ' + v.join('\n      '));
    textViolations += v.length;
  }
}
if (!textViolations) ok('文本中性色全部走 --text-N 令牌（深色下自动反色）');

/* ───────── 变异自证 ───────── */
console.log('\n── 变异自证');
{
  // 坏样本：写死白底必须被抓
  const badSrc = '.foo {\n  background: #FFFFFF;\n}';
  const bv = audit(stripComments(badSrc));
  chk(bv.length > 0, '坏样本：background: #FFFFFF 被抓到（' + (bv[0] || '') + '）');

  // 好样本 1：令牌写法不误报
  const good1 = '.foo {\n  background: var(--bg-card);\n}';
  chk(audit(stripComments(good1)).length === 0, '好样本：background: var(--bg-card) 不误报');

  // 好样本 2：本身深色的写死不误报（如 #1c2027 深色卡）
  const good2 = '.foo {\n  background: #1C2027;\n}';
  chk(audit(stripComments(good2)).length === 0, '好样本：深色写死 #1C2027 不误报（本身非白岛）');

  // 好样本 3：渐变里的浅色 stop 不误报（值不是裸 hex 声明）
  const good3 = '.foo {\n  background: linear-gradient(135deg, #FFFFFF, #3370FF);\n}';
  chk(audit(stripComments(good3)).length === 0, '好样本：渐变里的浅色 stop 不误报（非裸 hex 声明）');

  // 文本色：坏样本必抓、令牌 / 彩底白字不误报
  chk(auditText('.foo {\n  color: #1D2129;\n}').length > 0, '文本坏样本：color:#1D2129 被抓到');
  chk(auditText('.foo {\n  color: var(--text-1);\n}').length === 0, '文本好样本：color: var(--text-1) 不误报');
  chk(auditText('.foo {\n  color: #FFFFFF;\n}').length === 0, '文本好样本：彩底白字 color:#FFFFFF 不误报');
}

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 表面 / 文本令牌守门全部通过'));
process.exit(failed ? 1 : 0);
