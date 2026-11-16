/**
 * 关系表独立复核门禁（2026-11-16 由 outputs/关系表-独立复核.js 转正）
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么要单独一道门禁：
 *   `check-admin-css-tokens.js` 扫的是**样式里真实出现的组合**，它的口径是
 *   「如果 .x 用 --a 压 --b，那么这两者必须够」。但它**不知道设计规范里承诺过什么**。
 *   规范文档 `outputs/后台焕新-视觉规范.md` 里那张 CONTRAST_RULES 关系表（29 组）
 *   是「设计侧的合同」—— 合同与实现必须双向对得上：
 *     · 表里每一组实算值必须达标（否则设计规范自己就写错了）
 *     · CSS 里实际用到的前景令牌必须全被表覆盖（漏了 = 有组合从没被验过）
 *   这两条都不在 tokens 门禁的职责内，所以独立成门。
 *
 * 与 tokens 门禁的关系：互补，不是重复。
 *   · tokens 门禁 = 实现自洽（样式自身不违规）
 *   · 本门禁     = 实现 vs 合同（规范承诺的每组都真的达标，且没有漏项）
 *
 * 变异自证（防「扫描器形同虚设」）：
 *   如果解析器坏了（正则失配 ⇒ RULES 抽成 0 组），for 循环跑 0 次 ⇒ 永远全绿。
 *   这是上一轮真实踩过的坑（门禁命中 0 项却报绿）。所以本文件：
 *     ① 先卡数量下限（RULES ≥ 25 组、实算组合 ≥ 25、CSS 前景令牌 ≥ 8 个）；
 *     ② 再把 --brand-ink 故意改成浅灰重算一遍，必须翻出「不达标」；
 *        同时改一个不该影响关系的令牌，必须保持全绿。
 *   两条都对，才说明算式真的在算。
 *
 * 退出码：0 = 合同与实现一致；1 = 有不达标 / 漏覆盖 / 自证失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css');
const SPEC_PATH = path.join(ROOT, 'outputs/后台焕新-视觉规范.md');

if (!fs.existsSync(SPEC_PATH)) {
  console.log('✗ 找不到视觉规范：' + SPEC_PATH);
  console.log('  关系表是「设计侧合同」，缺了它这道门禁无从复核 —— 不要为了变绿而删表。');
  process.exit(1);
}
const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const SPEC = fs.readFileSync(SPEC_PATH, 'utf8');

let bad = 0;
function check(ok, msg) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) bad++;
}

/* ── 1. 取 :root 令牌 ── */
function parseTokens(cssText) {
  const rootBody = (cssText.match(/:root\s*\{([\s\S]*?)\n\}/) || [''])[0]
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const TOK = {};
  rootBody.split(';').forEach((chunk) => {
    const m = /(--[a-z0-9-]+)\s*:\s*([^;]+)/.exec(chunk);
    if (m) TOK[m[1]] = m[2].trim();
  });
  return TOK;
}
const TOK = parseTokens(CSS);

/* ── 2. 色彩换算 ── */
function hex2rgb(h) {
  h = String(h).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lum(rgb) {
  const a = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function ratio(r1, r2) {
  const l1 = lum(r1), l2 = lum(r2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/* alpha 色必须叠到下层再算，否则半透明黑会被当成纯黑（对比度虚高） */
function over(rgba, base) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(rgba);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  return [0, 1, 2].map((i) => Math.round(parseInt(m[i + 1]) * a + base[i] * (1 - a)));
}
/** 解析令牌名 → rgb（支持别名链 var(--a) → var(--b)，alpha 合成到白底） */
function resolve(tok, name, baseRgb, depth) {
  depth = depth || 0;
  if (depth > 6 || !tok[name]) return null;
  const v = tok[name];
  if (/^#[0-9a-fA-F]{3,6}$/.test(v)) return hex2rgb(v);
  if (/^rgba?\(/i.test(v)) return over(v, baseRgb || [255, 255, 255]);
  const m = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(v);
  if (m) return resolve(tok, m[1], baseRgb, depth + 1);
  return null;
}

/* ── 3. 抽规范里的 CONTRAST_RULES ── */
function parseRules(specText) {
  const block = (specText.match(/const CONTRAST_RULES = \[([\s\S]*?)\];/) || [])[1] || '';
  const out = [];
  block.split('\n').forEach((line) => {
    const m = /\{\s*fg:\s*'(--[a-z0-9-]+)',\s*bg:\s*'(--[a-z0-9-]+)',\s*min:\s*([\d.]+)/.exec(line);
    if (m) {
      out.push({
        fg: m[1], bg: m[2], min: parseFloat(m[3]),
        graphic: /graphic:\s*true/.test(line),
        doc: (function () {
          const c = /\/\/\s*([\d.]+)/.exec(line);
          return c ? parseFloat(c[1]) : null;
        })()
      });
    }
  });
  return out;
}
const RULES = parseRules(SPEC);

/* ── 4. 实算 ── */
function evaluate(tok, rules) {
  const res = { bad: [], missing: [], okc: 0, drift: [] };
  rules.forEach((r) => {
    const fgR = resolve(tok, r.fg, [255, 255, 255]);
    const bgR = resolve(tok, r.bg, [255, 255, 255]);
    if (!fgR || !bgR) { res.missing.push(r.fg + ' / ' + r.bg); return; }
    const rr = ratio(fgR, bgR);
    if (rr < r.min) res.bad.push(r.fg + ' on ' + r.bg + ' = ' + rr.toFixed(2) + '（需 ' + r.min + '）');
    else res.okc++;
    // 规范文档自己写的值若与实算漂移 > 0.02 ⇒ 说明有人改了令牌没同步文档
    if (r.doc !== null && Math.abs(r.doc - rr) > 0.02) {
      res.drift.push(r.fg + ' on ' + r.bg + '：文档 ' + r.doc + '，实算 ' + rr.toFixed(2));
    }
  });
  return res;
}

console.log('\n── ① 解析有效性（防「门禁命中 0 项却报绿」）');
check(!!(CSS.match(/:root\s*\{/) || []).length, 'admin.css 存在 :root 令牌块');
check(Object.keys(TOK).length >= 20, '解析到 ≥20 个令牌（实际 ' + Object.keys(TOK).length + ' 个）');
check(RULES.length >= 25, '从视觉规范解析到 ≥25 组关系（实际 ' + RULES.length + ' 组）');

console.log('\n── ② 合同与实现一致：每组实算都达标');
const base = evaluate(TOK, RULES);
check(base.missing.length === 0,
  '关系表里每组的前景/背景令牌都存在且可解析' +
  (base.missing.length ? '（缺：' + base.missing.join('，') + '）' : ''));
check(base.bad.length === 0,
  '关系表 ' + RULES.length + ' 组全部达标（通过 ' + base.okc + ' 组）' +
  (base.bad.length ? '\n      ' + base.bad.join('\n      ') : ''));
check(base.drift.length === 0,
  '规范文档标注的色值与实算一致（无漂移）' +
  (base.drift.length ? '\n      ' + base.drift.join('\n      ') : ''));

console.log('\n── ③ 覆盖度：CSS 真实用到的前景令牌必须全被关系表覆盖');
const noComment = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const usedFg = new Set();
noComment.split('\n').forEach((l) => {
  // (?<!-) 避免把 border-color / background-color 的 color 当文字色
  const m = /(?<!-)color\s*:\s*var\(\s*(--[a-z0-9-]+)/.exec(l);
  if (m) usedFg.add(m[1]);
});
const inTable = new Set(RULES.map((r) => r.fg));
const missingFg = [...usedFg].filter((k) => !inTable.has(k)).sort();
check(usedFg.size >= 8, 'CSS 里出现 ≥8 个前景令牌（实际 ' + usedFg.size + ' 个）');
check(missingFg.length === 0,
  '关系表已覆盖全部前景令牌' +
  (missingFg.length ? '（漏：' + missingFg.map((k) => k + '=' + TOK[k]).join('，') + '）' : ''));

console.log('\n── ④ 变异自证：算式必须真的在算');
/* ④-a 把品牌文字色改成浅灰 ⇒ 必须翻出不达标 */
const TOK_BAD = Object.assign({}, TOK, { '--brand-ink': '#EEEEEE' });
const mutBad = evaluate(TOK_BAD, RULES);
check(mutBad.bad.length > 0,
  '把 --brand-ink 改成 #EEEEEE 后必须翻红（实翻 ' + mutBad.bad.length + ' 组）' +
  (mutBad.bad.length ? '' : ' ← 算式没生效，本次全绿不可信'));
/* ④-b 改一个不参与任何关系的令牌 ⇒ 必须保持全绿（防误报） */
const TOK_BENIGN = Object.assign({}, TOK, { '--chart-grid': '#123456' });
const mutBenign = evaluate(TOK_BENIGN, RULES);
check(mutBenign.bad.length === 0 && mutBenign.missing.length === 0,
  '改 --chart-grid（不参与文字关系）后仍应全绿（误报 ' + mutBenign.bad.length + ' 组）');

console.log('\n' + (bad === 0
  ? '✓ 关系表与实现一致：' + RULES.length + ' 组达标，' + usedFg.size + ' 个前景令牌全覆盖'
  : '✗ 失败 ' + bad + ' 项'));
process.exit(bad === 0 ? 0 : 1);
