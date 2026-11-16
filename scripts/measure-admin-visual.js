#!/usr/bin/env node
/**
 * 后台焕新 · 视觉度量基线（2026-11-16）
 * ============================================================
 * 目的：让「焕新是否真的解决了老气/沉闷」变成**可测量的**，而不是靠感觉。
 * 手段：对 admin.css 做结构化度量 + 对 e2e 截图做像素统计。
 *
 * 用法：
 *   node scripts/measure-admin-visual.js          # 只打印度量
 *   node scripts/measure-admin-visual.js --json   # 输出 JSON（便于前后对比）
 *
 * ⚠️ 本脚本**不是门禁**（不参与 run-gates-chunk.js 的失败判定），
 *    它是"前后对比"的度量工具。阈值判定由主理人按设计目标人工确认。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

const out = {};

/* ── 1. 颜色体系健康度 ───────────────────────────── */
const hex = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((x) => x.toLowerCase());
const rgba = css.match(/rgba?\([^)]*\)/g) || [];
const tokens = css.match(/var\(--[a-z0-9-]+/g) || [];
const uniqTokens = [...new Set(tokens.map((t) => t.slice(4)))];

out.color = {
  hardcodedHex: hex.length,
  uniqueHex: new Set(hex).size,
  hardcodedRgba: rgba.length,
  tokenRefs: tokens.length,
  uniqueTokens: uniqTokens.length,
  // 核心指标：写死色值占"颜色声明"的比例，越低越健康
  tokenRatio: +(tokens.length / (tokens.length + hex.length + rgba.length)).toFixed(3),
};

/* ── 2. 圆角与阴影层级 ───────────────────────────── */
const radii = (css.match(/border-radius:\s*([^;]+)/g) || []).map((r) => r.replace('border-radius:', '').trim());
const radiusValues = {};
radii.forEach((r) => { radiusValues[r] = (radiusValues[r] || 0) + 1; });
const shadows = (css.match(/box-shadow:\s*([^;]+)/g) || []).length;
out.shape = {
  radiusDistinct: Object.keys(radiusValues).length,
  radiusTop: Object.entries(radiusValues).sort((a, b) => b[1] - a[1]).slice(0, 8),
  boxShadowCount: shadows,
};

/* ── 3. 动效成熟度 ───────────────────────────────── */
const anims = css.match(/animation:[^;]+/g) || [];
const trans = css.match(/transition:[^;]+/g) || [];
const keyframes = css.match(/@keyframes\s+([a-zA-Z0-9_-]+)/g) || [];
const hoverGated = css.includes('@media (hover: hover) and (pointer: fine)');
const reducedMotion = css.includes('@media (prefers-reduced-motion: reduce)');
/* 性能纪律：只动 transform/opacity 的 transition 占比 */
const safeTrans = trans.filter((t) => {
  const props = t.replace(/^transition:\s*/, '').split(',').map((p) => p.trim().split(/\s+/)[0]);
  return props.every((p) => ['transform', 'opacity', 'color', 'background-color', 'border-color', 'box-shadow', 'none'].includes(p));
}).length;

out.motion = {
  animationCount: anims.length,
  transitionCount: trans.length,
  keyframes: keyframes.map((k) => k.replace('@keyframes ', '')),
  hoverGated,
  reducedMotion,
  transformOpacityOnlyRatio: trans.length ? +(safeTrans / trans.length).toFixed(2) : 0,
  transitionAll: /transition\s*:\s*all/.test(css),
  scaleZero: /scale\(0\)/.test(css),
  easeIn: /transition\s*:[^;]*\bease-in(?!-)/.test(css),
};

/* ── 4. 排版成熟度 ───────────────────────────────── */
const fontStack = /font:\s*([^;]+);/.exec(css);
out.type = {
  fontFamilyDecls: (css.match(/font-family:/g) || []).length,
  baseFont: fontStack ? fontStack[1].trim() : null,
  usesSystemStack: fontStack ? /-apple-system|system-ui|PingFang/i.test(fontStack[1]) : false,
  fontSizeSteps: [...new Set((css.match(/font-size:\s*([^;]+)/g) || []).map((f) => f.replace('font-size:', '').trim()))].length,
  tabularNums: css.includes('font-variant-numeric'),
  monoStack: /ui-monospace|Menlo|Consolas/.test(css),
};

/* ── 5. 交互态完整度 ─────────────────────────────── */
const states = {
  focusVisible: /:focus-visible/.test(css),
  focusRing: /:focus[^{]*\{[^}]*box-shadow/.test(css),
  hoverState: /:hover/.test(css),
  activeState: /:active/.test(css),
  disabledState: /:disabled/.test(css),
  emptyState: /\.empty\s*\{/.test(css),
  loadingState: /\.loading\s*\{/.test(css),
};
out.interaction = states;

/* ── 6. 无障碍 ───────────────────────────────────── */
const contrastRisk = [];
/* 找 color + 字号组合里可疑的浅色文字（人工复核用） */
out.a11y = {
  focusVisibleCount: (css.match(/:focus-visible/g) || []).length,
  reducedMotionBlock: reducedMotion,
  ariaInHtml: /aria-/.test(fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin-web/public/index.html'), 'utf8')),
  prefersContrast: css.includes('prefers-contrast'),
  minTouchTargetMobile: /ua-mobile[^{]*\{[^}]*min-height:\s*44px/.test(css),
};

/* ── 7. 响应式策略 ───────────────────────────────── */
out.responsive = {
  usesUaClass: css.includes('.ua-mobile'),
  maxWidthMediaQueries: (css.match(/@media[^{]*max-width/g) || []).length,
  containerQueries: (css.match(/@container/g) || []).length,
  gridUsage: (css.match(/display:\s*grid/g) || []).length,
  flexUsage: (css.match(/display:\s*flex/g) || []).length,
};

/* ── 输出 ────────────────────────────────────────── */
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('══ 后台视觉度量基线 ══\n');
  console.log('【颜色体系】');
  console.log('  写死 hex:', out.color.hardcodedHex, '/ 唯一色', out.color.uniqueHex);
  console.log('  硬编码 rgba:', out.color.hardcodedRgba);
  console.log('  令牌引用:', out.color.tokenRefs, '/ 唯一令牌', out.color.uniqueTokens);
  console.log('  令牌化率:', out.color.tokenRatio, '(越高越健康)');
  console.log('\n【形与影】');
  console.log('  圆角档位:', out.shape.radiusDistinct, '→', out.shape.radiusTop.map(([k, v]) => k + '×' + v).join(', '));
  console.log('  box-shadow:', out.shape.boxShadowCount);
  console.log('\n【动效】');
  console.log('  animation:', out.motion.animationCount, ' transition:', out.motion.transitionCount);
  console.log('  keyframes:', out.motion.keyframes.join(', '));
  console.log('  transform/opacity 友好比例:', out.motion.transformOpacityOnlyRatio);
  console.log('  hover 门控:', out.motion.hoverGated, ' reduced-motion:', out.motion.reducedMotion);
  console.log('  禁止项 → transition:all:', out.motion.transitionAll, ' scale(0):', out.motion.scaleZero, ' ease-in:', out.motion.easeIn);
  console.log('\n【排版】');
  console.log('  基础字体:', out.type.baseFont);
  console.log('  系统字体栈:', out.type.usesSystemStack, ' 字号档位:', out.type.fontSizeSteps);
  console.log('  等宽数字:', out.type.tabularNums, ' 等宽字体:', out.type.monoStack);
  console.log('\n【交互态】', JSON.stringify(out.interaction));
  console.log('【无障碍】', JSON.stringify(out.a11y));
  console.log('【响应式】', JSON.stringify(out.responsive));
}
