#!/usr/bin/env node
/**
 * 离线自检：液态玻璃材质（v0.7.17 需求②③）
 * ------------------------------------------------------------
 * 为什么要有这个门禁 —— 玻璃是**依赖运行时能力**的写法，和「`~` 选择器」是同一类坑：
 *   · `backdrop-filter` 在部分安卓 WebView 上**完全不支持**。此时底色仍是我们写的
 *     半透明白（0.34~0.66），模糊没有发生 → **正文从卡片下透上来，字压在字上**。
 *     这种故障在 iOS 真机 / 开发者工具上永远复现不了，只能靠「必须写降级」这条纪律拦住。
 *   · 系统「降低透明度」（无障碍）开着时同样必须退成不透明。
 *   · 玻璃的前提是「背后有东西可模糊」。页面若是纯白底，blur 的结果还是纯白 ——
 *     玻璃和白卡长得一模一样（用户反馈过「不像玻璃」，根因一半在这里）。
 *     所以额外断言 app.wxss 的 `page` 必须垫了环境色晕。
 *
 * 自证（双向）：删掉兜底 → 必被抓；源码原样 → 不得误报。
 *
 * 用法：node scripts/check-glass.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function chk(cond, msg) { if (cond) ok(msg); else bad(msg); }

/* ============================================================
 * 一、单文件审计（纯函数：吃源码文本，吐问题列表）—— 变异自证要复用它
 * ============================================================ */
/**
 * 取出 `from` 之后第一个 `{` 起的**配对花括号块**内容（不含外层括号）。
 * ⚠️ 不能用「往后截 400 字符」那种近似：兜底块后面紧跟着
 *    `@media (prefers-reduced-transparency)` 段，它里面也有 `background:`——
 *    近似窗口会把下一个块的属性算进来，于是「兜底被掏空」永远查不出来
 *    （本门禁的变异 3 就是这么先假通过一次的）。
 */
function braceBlock(src, from) {
  const s = src.indexOf('{', from);
  if (s < 0) return null;
  let depth = 0;
  for (let i = s; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (!depth) return src.slice(s + 1, i);
    }
  }
  return null;
}

function auditGlass(src) {
  const problems = [];
  if (!/backdrop-filter\s*:/.test(src)) return problems;   // 这个文件没用玻璃材质 → 无要求

  // ① 不支持模糊的机型：必须把底色加厚到接近实心
  const iSup = src.search(/@supports\s+not\s*\(\(\s*(-webkit-)?backdrop-filter/);
  if (iSup < 0) {
    problems.push('用了 backdrop-filter 却没有 `@supports not (backdrop-filter …)` 兜底：不支持模糊的机型上底色仍是半透明，正文会透上来');
  } else {
    const body = braceBlock(src, iSup);
    if (!body || !/background\s*:/.test(body)) {
      problems.push('`@supports not` 兜底块里没有改 background（空兜底 = 没兜底）');
    }
  }

  // ② 系统「降低透明度」：必须退成不透明、关掉模糊
  if (!/prefers-reduced-transparency/.test(src)) {
    problems.push('用了 backdrop-filter 却没有 `prefers-reduced-transparency` 分支：系统开了「降低透明度」时仍会做模糊');
  }
  return problems;
}

/** 递归收集所有 wxss */
function walkWxss(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') return;
      walkWxss(p, out);
    } else if (e.name.endsWith('.wxss')) {
      out.push(p);
    }
  });
  return out;
}

console.log('── ① 每条玻璃配方都必须带两条降级路径（不支持模糊 / 系统降低透明度）');
const files = walkWxss(MINI, []);
let glassFiles = 0;
files.forEach((f) => {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const src = fs.readFileSync(f, 'utf8');
  const problems = auditGlass(src);
  if (/backdrop-filter\s*:/.test(src)) glassFiles += 1;
  if (problems.length) {
    bad(rel);
    problems.forEach((p) => console.log('        · ' + p));
  }
});
if (glassFiles < 4) bad(`只扫到 ${glassFiles} 个玻璃文件（预期 ≥4：卡片/弹层/导航/底栏），检查扫描器`);
else ok(`${glassFiles} 个玻璃文件全部带 `+"`@supports not` 兜底 + `prefers-reduced-transparency`");

console.log('\n── ② 玻璃令牌与环境色晕（app.wxss）');
const appWxss = read('miniprogram/app.wxss');
['--glass-bg', '--glass-blur', '--glass-edge', '--glass-shadow', '--glass-highlight'].forEach((t) => {
  chk(new RegExp('\\' + t + '\\s*:').test(appWxss), `玻璃令牌已定义 ${t}`);
});
chk(/background-image\s*:/.test(appWxss), '`page` 垫了环境色晕（background-image）—— 没有它，blur 的结果还是纯色，玻璃会和白卡一样');
chk(/\.card\s*\{[\s\S]{0,400}?backdrop-filter/.test(appWxss), '`.card` 已换成玻璃材质（全站卡片的主力表面）');
chk(/\.page\s*\{[\s\S]{0,120}?background:\s*transparent/.test(appWxss), '`.page` 透明，环境色晕才透得上来（否则被整层底色盖住）');

console.log('\n── ③ 底栏「更透明」但不牺牲可读性');
const tabWxss = read('miniprogram/custom-tab-bar/index.wxss');
{
  const m = /\.tabbar\s*\{([\s\S]*?)\n\}/.exec(tabWxss);
  const body = m ? m[1] : '';
  const alpha = /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/.exec(body);
  const a = alpha ? Number(alpha[1]) : null;
  chk(a !== null && a <= 0.4, `底栏底色是真的半透明（实测 alpha=${a}，≤0.4）`);
  chk(/backdrop-filter/.test(body), '底栏仍带背景模糊（透明的那一半靠模糊撑住，不是纯降 alpha）');
}

/* ============================================================
 * 二、自证：删掉兜底必须被抓到（否则本门禁只是摆设）
 * ============================================================ */
console.log('\n── 自证：降级路径缺失必被抓（变异必抓 + 好样本不误报）');
{
  const dialog = read('miniprogram/components/dialog/index.wxss');
  const good = auditGlass(dialog);
  chk(good.length === 0, '好样本：dialog 现有写法无任何问题（不误报）');

  const noSupports = dialog.replace(/@supports not \(\(backdrop-filter[\s\S]*?\n\}\n/, '');
  chk(noSupports !== dialog && auditGlass(noSupports).length > 0, '变异 1：删掉 `@supports not` 兜底 → 被抓住');

  const noTransparency = dialog.replace(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*?\n\}\n/, '');
  chk(noTransparency !== dialog && auditGlass(noTransparency).length > 0, '变异 2：删掉 `prefers-reduced-transparency` 分支 → 被抓住');

  const emptySupports = dialog.replace('background: rgba(255, 255, 255, 0.95);', '');
  chk(emptySupports !== dialog && auditGlass(emptySupports).length > 0, '变异 3：兜底块被掏空（不写 background）→ 被抓住');
}

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 液态玻璃材质体检全部通过'));
process.exit(failed ? 1 : 0);
