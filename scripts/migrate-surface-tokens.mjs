#!/usr/bin/env node
/**
 * 深色模式「白岛」修复：把页面 / 组件 wxss 里写死的浅色裸 hex
 * （background / color / border* 三个维度）按映射表替换为既有设计令牌。
 *
 * 设计原则：
 *  · 只替换「声明值恰好是一个 hex」的写法；渐变 / rgba / var / url / 多值一律不动。
 *  · 只作用于 background(-color) / color / border(-color/-top/...)。
 *  · 颜色令牌（--text-1/2/3/4、--brand、--success/warning/danger/purple 等）两套主题都定义了
 *    正确值，所以即便把 `color:#1d2129` 换成 `var(--text-1)`，深色下也会自动翻成浅色字 ⇒
 *    顺带修掉了「深色下黑字压深底」的隐形可读性 bug。
 *  · `--bg-card / --bg-fill / --bg-page / --brand-light / *-bg` 等表面令牌同理，深色下变深底。
 *  · 幂等：跑过一次后值已是 `var(--x)`，再跑无变化。可反复执行做校验。
 *  · 不改 app.wxss（令牌源），只动 pages / components / custom-tab-bar。
 *
 * 用法：
 *   node scripts/migrate-surface-tokens.mjs            # 试运行（只打印，不写盘）
 *   node scripts/migrate-surface-tokens.mjs --apply    # 真正写盘
 */
import fs from 'fs';
import path from 'path';

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(process.cwd());
const MINI = path.join(ROOT, 'miniprogram');

// hex(小写) -> 令牌。背景 / 描边共用同一张；文字单列（#fff 文字不动）。
const SURFACE = {
  '#ffffff': '--bg-card',
  '#fbfcfe': '--bg-card',
  '#f5f6f8': '--bg-page',
  '#f2f3f5': '--bg-fill',
  '#f7f8fa': '--fill-soft',
  '#f0f5ff': '--brand-light',
  '#dce8ff': '--brand-light-hover',
  '#e8f0ff': '--brand-light',
  '#d6e0ff': '--brand-light',
  '#e3edff': '--brand-light',
  '#eaf1ff': '--brand-light',
  '#c9d3e6': '--brand-light',
  '#d6e4ff': '--brand-light',
  '#d6f5c8': '--success-bg',
  '#eef0f3': '--bg-fill',
  '#f3f0ff': '--purple-bg',
  '#fff7e8': '--warning-bg',
  '#fff3e8': '--warning-bg',
  '#ffefd1': '--warning-bg',
  '#fff3c2': '--warning-bg',
  '#ffe7c2': '--warning-bg',
  '#ffece8': '--danger-bg',
  '#fff3f3': '--danger-bg',
  '#ffd9d5': '--danger-bg',
  '#e8ffea': '--success-bg',
  '#e8fffb': '--success-bg',
  '#f6ffed': '--success-bg',
  '#e6f7f0': '--success-bg',
  '#c9cdd4': '--bg-fill',
  '#e5e6eb': '--line-1',
  '#3370ff': '--brand',
  '#245bdb': '--brand-press',
  '#a8c1ff': '--brand-disable',
  '#f53f3f': '--danger',
  '#00b42a': '--success',
  '#ff7d00': '--warning',
  '#7c5cff': '--purple',
};
const TEXT = {
  '#1d2129': '--text-1',
  '#4e5969': '--text-2',
  '#86909c': '--text-3',
  '#c9cdd4': '--text-4',
  '#3370ff': '--brand',
  '#245bdb': '--brand-press',
  '#a8c1ff': '--brand-disable',
  '#f53f3f': '--danger',
  '#00b42a': '--success',
  '#ff7d00': '--warning',
  '#7c5cff': '--purple',
  '#d46b08': '--warning-strong',
  // #ffffff 作为文字 → 两主题都该是白，不做替换（避免误伤彩色按钮上的白字）
};

// 已经是深色 / 纯黑的元素（如写死的深色卡 #1C2027、阴影 #000000）一律不动
const isSkipHex = (hex) => {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!h) return true;
  const v = parseInt(h[1], 16);
  const lum = (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return lum < 0.2; // 本来就暗，不是白岛
};

const HEXPAT = '#[0-9a-fA-F]{3,8}\\b';
const STRICT = ['background', 'background-color', 'color', 'border-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color'];
const BORDER_SHORT = ['border', 'border-top', 'border-bottom', 'border-left', 'border-right'];

function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function migrateFile(rel, raw) {
  const src = stripComments(raw);
  let out = raw;
  const seen = new Set();          // 本次命中的 (prop,hex)
  const unmapped = new Set();      // 目标属性里出现、但不在映射表、也不是跳过的裸 hex

  const lines = out.split('\n');
  const newLines = lines.map((line) => {
    let changed = false;
    let L = line;

    // ---- 严格：声明值恰好一个 hex ----
    for (const prop of STRICT) {
      const map = prop === 'color' ? TEXT : SURFACE;
      const re = new RegExp('(^|[^\\w-])(' + prop.replace(/-/g, '\\-') + ')\\s*:\\s*(' + HEXPAT + ')(\\s*!important)?\\s*;', 'gi');
      L = L.replace(re, (m, pre, p, hex, imp) => {
        const key = hex.toLowerCase();
        if (isSkipHex(key)) return m;
        if (!map[key]) { unmapped.add(key); return m; }
        seen.add(p + ':' + key);
        changed = true;
        return pre + p + ': var(' + map[key] + ')' + (imp ? imp : '') + ';';
      });
    }

    // ---- border 简写：border: 1rpx solid #hex ----
    for (const prop of BORDER_SHORT) {
      const re = new RegExp('(^|[^\\w-])(' + prop.replace(/-/g, '\\-') + ')\\s*:\\s*([^;]*?)(' + HEXPAT + ')([^;]*?);', 'gi');
      L = L.replace(re, (m, pre, p, before, hex, after) => {
        const key = hex.toLowerCase();
        if (isSkipHex(key)) return m;
        if (!SURFACE[key]) { unmapped.add(key); return m; }
        seen.add(p + ':' + key);
        changed = true;
        return pre + p + ': ' + before + 'var(' + SURFACE[key] + ')' + after + ';';
      });
    }
    return changed ? L : line;
  });
  return { text: newLines.join('\n'), seen, unmapped };
}

// 收集目标文件
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

let totalChanges = 0;
const perFile = [];
const allUnmapped = new Map(); // hex -> count
for (const rel of TARGETS) {
  const full = path.join(MINI, rel);
  const raw = fs.readFileSync(full, 'utf8');
  const { text, seen, unmapped } = migrateFile(rel, raw);
  if (seen.size) {
    const n = seen.size;
    totalChanges += n;
    perFile.push({ rel, n, keys: [...seen].sort() });
    if (APPLY) fs.writeFileSync(full, text, 'utf8');
  }
  for (const h of unmapped) allUnmapped.set(h, (allUnmapped.get(h) || 0) + 1);
}

console.log((APPLY ? '【已写盘】' : '【试运行】') + ' 扫描 ' + TARGETS.length + ' 个 wxss\n');
perFile.sort((a, b) => b.n - a.n);
for (const f of perFile) {
  console.log('  ' + f.rel + '  +' + f.n + '  [' + f.keys.join(', ') + ']');
}
console.log('\n替换总数：' + totalChanges);
if (allUnmapped.size) {
  console.log('\n未映射（留在原样，多为特性页自定义强调色，非白岛）：');
  for (const [h, c] of [...allUnmapped.entries()].sort((a, b) => b[1] - a[1]))
    console.log('  ' + h + '  ×' + c);
}
if (!APPLY) console.log('\n（试运行未写盘。加 --apply 真正修改文件。）');
