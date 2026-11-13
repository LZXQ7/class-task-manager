#!/usr/bin/env node
/**
 * 页面级回访入场动画 · 改前/改后定格对比（v1.0.8.37 第 ⑧ 轮）
 * ------------------------------------------------------------
 * 用户「切换页面会闪一下」：真机上每切一次 Tab，`play()` 轮换 pa-lite-a/b 重播入场，
 * 旧 lite keyframes 带 opacity: 0→1 ⇒ 整页内容从透明重新淡入一次（「白一下」）。
 * 本轮去掉回访的透明淡入，只留 5px 上浮；首次 paInFull 的淡入保留。
 *
 * 这张图用「负 animation-delay + paused」把动画定格在 t=0 / t=140ms：
 *   · 改前 t=0：卡片 opacity=0（看不见 = 白一下）
 *   · 改后 t=0：卡片完整可见，只比终态低 5px
 * CSS 从真源 app.wxss 提取（改前 = git HEAD，改后 = 工作区），不重写样式。
 *
 * 用法：node scripts/gen-page-anim-preview.js
 * 产物：preview/page-anim-compare.html / preview/page-anim-compare.png
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PREVIEW = path.join(ROOT, 'preview');
const APP = 'miniprogram/app.wxss';
const workCss = fs.readFileSync(path.join(ROOT, APP), 'utf8');
const headCss = execFileSync('git', ['show', 'HEAD:' + APP], { cwd: ROOT, encoding: 'utf8' });

/** 只取「回访」这一条动画链：lite keyframes + 基档 animation 规则 */
function paCss(src) {
  const kf = (src.match(/@keyframes\s+paInLiteA\s*\{[\s\S]*?\n\}/) || [])[0] || '';
  const base = (src.match(/\.pa-lite-a\s+\.st-item\s*\{[^}]*animation:[^}]*\}/) || [])[0] || '';
  if (!kf || !base) throw new Error('提取入场 CSS 失败（keyframes / 基档规则缺失）');
  return kf + '\n' + base;
}

/** delay：0 = 停在首帧；-0.14 = 停在末帧（lite 单块 .14s） */
function frameHtml(src, delay) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${paCss(src)}
html, body { margin: 0; height: 100%; }
body { background: #eef3fb; display: flex; align-items: center; justify-content: center; }
.st-item {
  width: 200px; height: 64px; border-radius: 14px; background: #3370ff; color: #fff;
  font: 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 18px rgba(51,112,255,.22);
}
</style></head><body class="pa-lite-a">
<div class="st-item st-1" style="animation-delay:${delay}s;animation-play-state:paused">内容卡片</div>
</body></html>`;
}

const CASES = [
  { key: 'before', label: '改前 1.0.8.36 · 回访会重新淡入', css: headCss },
  { key: 'after', label: '改后（本轮）· 回访只留 5px 上浮', css: workCss }
];
const TIMES = [{ t: 0, d: 0 }, { t: 140, d: -0.14 }];

const frames = {};
CASES.forEach(c => TIMES.forEach(x => { frames[c.key + '-' + x.t] = frameHtml(c.css, x.d); }));
const framesJson = JSON.stringify(frames).replace(/<\/script/gi, '<\\/script');

const rows = CASES.map(c => `<div class="row">
  <div class="lbl">${c.label}</div>
  ${TIMES.map(x => `<div class="cell"><div class="t">t = ${x.t} ms</div>
    <iframe id="f-${c.key}-${x.t}"></iframe></div>`).join('')}
</div>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>页面级回访动画 · 改前/改后定格对比</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px 20px 20px; background: #11151c; color: #e8edf6;
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { margin: 0 0 3px; font-size: 17px; font-weight: 600; }
  .sub { color: #8d99ad; font-size: 11px; margin-bottom: 14px; }
  .row { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
  .lbl { writing-mode: vertical-rl; width: 20px; color: #a9b6c9; font-size: 11px;
    letter-spacing: .5px; padding-top: 4px; }
  .cell { background: #171d27; border: 1px solid #28313f; border-radius: 12px; padding: 8px; }
  .t { color: #7fb0ff; font-size: 11px; margin: 0 0 6px 3px; font-variant-numeric: tabular-nums; }
  iframe { display: block; width: 280px; height: 132px; border: 0; border-radius: 8px; background: #eef3fb; }
  .note { margin-top: 8px; color: #7f8ca1; font-size: 11px; line-height: 1.8; }
  .note b { color: #e8b86a; font-weight: 600; }
</style></head><body>
<h1>「切页闪一下」· 页面级回访动画定格对比</h1>
<div class="sub">每格把 @keyframes paInLiteA 用负 delay + paused 定格在对应时刻。CSS 直接读自 app.wxss（改前 = git HEAD，改后 = 工作区）。</div>
${rows}
<div class="note">
  改前 t=0：卡片 <b>opacity=0 看不见</b> → 每次切 Tab 整页内容重新淡入一次，就是「白一下」。<br>
  改后 t=0：卡片<b>已完整可见</b>，只比终态低 5px；<b>首次进入</b>的淡入保留（pa-hold 数据门控 → 页面首次出现的柔和过渡，只播一次）。
</div>
<script>
const FRAMES = ${framesJson};
Object.keys(FRAMES).forEach(k => {
  const d = document.getElementById('f-' + k).contentDocument;
  d.open(); d.write(FRAMES[k]); d.close();
});
</script>
</body></html>`;

if (!fs.existsSync(PREVIEW)) fs.mkdirSync(PREVIEW, { recursive: true });
const htmlPath = path.join(PREVIEW, 'page-anim-compare.html');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('HTML  ' + htmlPath);

const PW = 'C:/Users/PC/.dsh/skills/dashi-ppt/project/node_modules/playwright-core';
const MP = 'C:/Users/PC/AppData/Local/ms-playwright';
function findChrome() {
  if (!fs.existsSync(MP)) return null;
  const dirs = fs.readdirSync(MP)
    .filter(n => /^chromium_headless_shell-\d+/.test(n) || /^chromium-\d+/.test(n))
    .sort().reverse();
  for (const d of dirs) {
    for (const c of [
      path.join(MP, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      path.join(MP, d, 'chrome-win', 'chrome.exe')
    ]) if (fs.existsSync(c)) return c;
  }
  return null;
}

(async () => {
  const chrome = findChrome();
  if (!chrome || !fs.existsSync(PW)) {
    console.log('SKIP  截图：未找到无头浏览器（HTML 已生成）');
    return;
  }
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 690, height: 470 }, deviceScaleFactor: 2 });
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForTimeout(450);
  const png = path.join(PREVIEW, 'page-anim-compare.png');
  await page.screenshot({ path: png, fullPage: true });
  console.log('PNG   ' + png);
  await browser.close();
})().catch(e => { console.error('截图失败：' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
