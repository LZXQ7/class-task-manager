#!/usr/bin/env node
/**
 * 文本色令牌迁移：把页面/组件 wxss 里写死的中性文字色，替换成 app.wxss 的 --text-N 令牌。
 *
 * 背景（2026-11-04）：
 *   深色模式下大量文字「看不清」——因为 color 全是写死的 #1D2129 / #4E5969 / #86909C
 *   （近黑），不会随主题翻色。背景/描边的「白岛」迁移（migrate-surface-tokens.mjs）
 *   只处理了 background / border，**没处理 color**，所以深底上压着黑字。
 *
 *   --text-N 的 light 取值与这些 hex **逐一相等** ⇒ 浅色观感零变化；深色下自动反色。
 *
 * 用法：
 *   node scripts/migrate-text-tokens.mjs --dry   # 只统计、不写盘
 *   node scripts/migrate-text-tokens.mjs         # 落盘（pages/components/custom-tab-bar）
 *   node scripts/migrate-text-tokens.mjs --app    # 连 app.wxss 一起（np-* 等共享样式）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINI = path.join(ROOT, 'miniprogram');
const DRY = process.argv.includes('--dry');
const INCLUDE_APP = process.argv.includes('--app');

// light 值 = 原 hex，故浅色不变、深色反色
const MAP = {
  '#1d2129': 'var(--text-1)',
  '#4e5969': 'var(--text-2)',
  '#86909c': 'var(--text-3)',
  '#c9cdd4': 'var(--text-4)'
};

const TARGETS = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.wxss')) TARGETS.push(p);
  }
}
walk(path.join(MINI, 'pages'));
walk(path.join(MINI, 'components'));
walk(path.join(MINI, 'custom-tab-bar'));
if (INCLUDE_APP) TARGETS.push(path.join(MINI, 'app.wxss'));

// 只匹配 `color: <hex>`；前置边界 (^|[;\s{]) 天然排除 background-color / border-color（其前一字符是 '-'）
const RE = /(^|[;\s{])color\s*:\s*(#[0-9a-fA-F]{6})\b/g;

let total = 0;
const mapped = {};
const unmapped = {};
for (const file of TARGETS) {
  let src = fs.readFileSync(file, 'utf8');
  const before = src;
  src = src.replace(RE, (m, pre, hex) => {
    const k = hex.toLowerCase();
    if (!MAP[k]) { unmapped[k] = (unmapped[k] || 0) + 1; return m; }
    mapped[k] = (mapped[k] || 0) + 1;
    total++;
    return pre + 'color: ' + MAP[k];
  });
  if (!DRY && src !== before) fs.writeFileSync(file, src, 'utf8');
}
console.log((DRY ? '[DRY] ' : '[APPLY] ') + 'files=' + TARGETS.length + '  color→token 替换 ' + total + ' 处');
console.log('  mapped  =', mapped);
console.log('  unmapped=', unmapped, ' ← 非中性文字色（强调/白色），未动，人工确认');
