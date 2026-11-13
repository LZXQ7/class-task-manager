#!/usr/bin/env node
/**
 * 底栏「选中项展开文字 + 内缩小胶囊」改前/改后对比预览（1.0.8.36 试验态）
 * ------------------------------------------------------------
 * 沿用 gen-anim-preview.js 的铁律：**CSS 从源文件读，不在这里重写一份** ——
 *   · 改后 = 工作区 miniprogram/custom-tab-bar/index.wxss
 *   · 改前 = git HEAD 里同一份文件
 *   · 主题令牌 = app.wxss 的 page / .t-light / .t-dark 规则块
 *   · 图标 = utils/icons.js 里的真实内联 base64
 * 本文件只做 rpx→px（÷2，375px 视口）换算 + 浏览器 glue，
 * 预览与真机样式不会漂移。两个 iframe 各自隔离，避免两份 CSS 互相污染。
 *
 * 用法：node scripts/gen-tabbar-preview.js
 * 产物：preview/tabbar-expand.html
 *       preview/tabbar-compare-light.png / preview/tabbar-compare-dark.png
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const PREVIEW = path.join(ROOT, 'preview');
const read = (p) => fs.readFileSync(p, 'utf8');
const rpx2px = (css) => css.replace(/(-?\d+(?:\.\d+)?)rpx/g, (m, n) => (Number(n) / 2) + 'px');

/* ---------------- ① 真源 CSS ---------------- */
const AFTER = rpx2px(read(path.join(MINI, 'custom-tab-bar/index.wxss')));
const BEFORE = rpx2px(execFileSync(
  'git', ['show', 'HEAD:miniprogram/custom-tab-bar/index.wxss'],
  { cwd: ROOT, encoding: 'utf8' }
));

const appWxss = read(path.join(MINI, 'app.wxss'));
function takeRule(sel) {
  const i = appWxss.indexOf('\n' + sel + ' {');
  if (i < 0) throw new Error('app.wxss 找不到规则块：' + sel);
  const j = appWxss.indexOf('\n}', i);
  return appWxss.slice(i + 1, j + 2);
}
const THEME = rpx2px([
  takeRule('page').replace(/^page\s*\{/m, 'body {'),
  takeRule('.t-light'),
  takeRule('.t-dark')
].join('\n'));

/* ---------------- ② 真实图标 + tab 结构（对齐 index.wxml） ---------------- */
const { get } = require(path.join(MINI, 'utils/icons.js'));
const TABS = [
  { key: 'home', text: '首页', icon: 'tab-home' },
  { key: 'timetable', text: '课程表', icon: 'tab-timetable' },
  { key: 'classinfo', text: '信息', icon: 'tab-classinfo' },
  { key: 'duty', text: '值日', icon: 'tab-duty' },
  { key: 'mine', text: '我的', icon: 'tab-mine' }
];
const ITEMS = TABS.map((t, i) => {
  const off = (get(t.icon, 'off') || {}).data || '';
  const on = (get(t.icon, 'on') || {}).data || '';
  return `<div class="tab-item${i === 0 ? ' on' : ''}" data-i="${i}">
      <div class="tab-icon-box">
        <img class="tab-icon tab-icon-off${i === 0 ? ' off' : ''}" src="${off}" draggable="false">
        <img class="tab-icon tab-icon-on${i === 0 ? ' on' : ''}" src="${on}" draggable="false">
      </div>
      <span class="tab-text${i === 0 ? ' on' : ''}">${t.text}</span>
    </div>`;
}).join('\n    ');

/* ---------------- ③ iframe 内容 ---------------- */
const GLUE = `
/* —— 浏览器 glue：模拟页面内容，让液态玻璃有东西可透 —— */
html, body { margin: 0; height: 100%; }
body { overflow: hidden; -webkit-font-smoothing: antialiased; }
.page-glass { position: absolute; inset: 0; }
.mock { position: absolute; left: 18px; right: 18px; top: 18px; }
.mock-line { height: 9px; border-radius: 5px; background: rgba(255,255,255,.45); margin-bottom: 9px; }
.mock-line.w1 { width: 42%; }
.mock-line.w2 { width: 68%; height: 7px; opacity: .65; }
.mock-card { height: 46px; border-radius: 12px; background: rgba(255,255,255,.38);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,.5); margin-top: 16px; }
.tabbar-wrap { padding-bottom: 32px !important; } /* 安卓无安全区兜底 TABBAR_LIFT_PX */
.tab-item { cursor: pointer; }
.tab-icon { -webkit-user-drag: none; }
`;

const FRAME_JS = `
const CELL = 58, OVER = 7, IND_MS = 140;   // 116/14 rpx ÷2，与 index.js 常量对应
let active = 0, timer = null;
const ind = document.querySelector('.tab-ind');
const items = Array.from(document.querySelectorAll('.tab-item'));
function paint() {
  items.forEach((el, k) => {
    const on = k === active;
    el.classList.toggle('on', on);
    el.querySelector('.tab-text').classList.toggle('on', on);
    el.querySelector('.tab-icon-off').classList.toggle('off', on);
    el.querySelector('.tab-icon-on').classList.toggle('on', on);
  });
}
function select(i) {
  if (i === active) return;
  const from = active;
  active = i;
  paint();
  if (timer) clearTimeout(timer);
  ind.className = 'tab-ind stretch';
  ind.style.left = (i * CELL + (i >= from ? OVER : -OVER)) + 'px';
  ind.style.width = CELL + 'px';
  timer = setTimeout(() => {
    ind.className = 'tab-ind settle';
    ind.style.left = (i * CELL) + 'px';
    ind.style.width = CELL + 'px';
  }, IND_MS);
}
items.forEach((el) => el.addEventListener('click', () => select(Number(el.dataset.i))));
window.previewSelect = select;
window.previewTheme = (dark) => {
  const add = dark ? 't-dark' : 't-light';
  const del = dark ? 't-light' : 't-dark';
  document.body.classList.remove(del); document.body.classList.add(add);
  const w = document.querySelector('.tabbar-wrap');
  w.classList.remove(del); w.classList.add(add);
};
`;

function frameHtml(css) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${THEME}
${css}
${GLUE}
</style></head><body class="t-light">
<div class="page-glass"></div>
<div class="mock">
  <div class="mock-line w1"></div><div class="mock-line w2"></div>
  <div class="mock-card"></div><div class="mock-line w2"></div>
</div>
<div class="tabbar-wrap t-light">
  <div class="tabbar">
    <div class="tab-ind" style="left:0px;width:58px"></div>
    ${ITEMS}
  </div>
</div>
<script>${FRAME_JS}<\/script>
</body></html>`;
}

/* ---------------- ④ 父页面 ---------------- */
// JSON.stringify 后把 </script 折成 <\/script，避免提前闭合父页面的 script 块
const framesJson = JSON.stringify({ before: frameHtml(BEFORE), after: frameHtml(AFTER) })
  .replace(/<\/script/gi, '<\\/script');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>底部导航栏 · 改前 / 改后对比</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 26px 30px 30px; background: #11151c; color: #e8edf6;
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600; letter-spacing: .3px; }
  .sub { color: #8d99ad; font-size: 12px; margin-bottom: 16px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
  button { background: #1d2430; color: #dbe4f2; border: 1px solid #313c4d;
    border-radius: 8px; padding: 6px 13px; font-size: 12px; cursor: pointer; }
  button:hover { background: #273246; border-color: #4a5a74; }
  button.on { background: #2a4372; border-color: #4d8bff; color: #fff; }
  .sep { width: 12px; }
  .grid { display: flex; gap: 22px; flex-wrap: wrap; }
  .panel { background: #171d27; border: 1px solid #28313f; border-radius: 14px; padding: 14px; }
  .cap { font-size: 12px; color: #a9b6c9; margin: 0 0 10px 4px; letter-spacing: .2px; }
  .cap b { color: #7fb0ff; font-weight: 600; }
  iframe { display: block; width: 375px; height: 220px; border: 0; border-radius: 12px;
    background: #eaf1ff; }
  .note { margin-top: 18px; color: #7f8ca1; font-size: 12px; line-height: 1.9; }
  .note code { color: #9cc2ff; background: #1b2230; padding: 1px 5px; border-radius: 4px; }
</style></head><body>
<h1>底部导航栏 · 选中展开文字 + 内缩小胶囊（试验态）</h1>
<div class="sub">左右两份 CSS 均直接读自源码；点击底栏任意项可看背景块滑动 + 文字展开</div>
<div class="toolbar">
  <button id="b-light" class="on" onclick="setTheme(false)">浅色</button>
  <button id="b-dark" onclick="setTheme(true)">深色</button>
  <span class="sep"></span>
  <button onclick="pick(0)">首页</button>
  <button onclick="pick(1)">课程表（3 字）</button>
  <button onclick="pick(2)">信息</button>
  <button onclick="pick(3)">值日</button>
  <button onclick="pick(4)">我的（末格）</button>
</div>
<div class="grid">
  <div class="panel"><div class="cap">改前 · <b>五项文字常显</b> · 蓝色块满格贴边</div><iframe id="f-before"></iframe></div>
  <div class="panel"><div class="cap">改后 · <b>仅选中项展开文字</b> · 背景块内缩成小胶囊</div><iframe id="f-after"></iframe></div>
</div>
<div class="note">
  改后：<code>.tab-item</code> 竖排改横排，未选中项文字 <code>max-width:0 + opacity:0</code> 完全不占位，图标仍精确居中；<br>
  背景块由 <code>.tab-ind::after</code> 画成格内 100×76rpx 圆角胶囊（四周各 8rpx 留白），JS 的等分几何与两拍滑动一行未动。
</div>
<script>
const FRAMES = ${framesJson};
function mount(id, html) {
  const d = document.getElementById(id).contentDocument;
  d.open(); d.write(html); d.close();
}
mount('f-before', FRAMES.before);
mount('f-after', FRAMES.after);
function setTheme(dark) {
  ['f-before', 'f-after'].forEach((id) => document.getElementById(id).contentWindow.previewTheme(dark));
  document.getElementById('b-light').classList.toggle('on', !dark);
  document.getElementById('b-dark').classList.toggle('on', dark);
}
function pick(i) {
  ['f-before', 'f-after'].forEach((id) => document.getElementById(id).contentWindow.previewSelect(i));
}
</script>
</body></html>`;

if (!fs.existsSync(PREVIEW)) fs.mkdirSync(PREVIEW, { recursive: true });
const htmlPath = path.join(PREVIEW, 'tabbar-expand.html');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log('HTML  ' + htmlPath);

/* ---------------- ⑤ Chrome 无头截图 ---------------- */
const PW = 'C:/Users/PC/.dsh/skills/dashi-ppt/project/node_modules/playwright-core';
const MP = 'C:/Users/PC/AppData/Local/ms-playwright';
function findChrome() {
  const dirs = fs.readdirSync(MP)
    .filter((n) => /^chromium_headless_shell-\d+/.test(n) || /^chromium-\d+/.test(n))
    .sort().reverse();
  for (const d of dirs) {
    const cands = [
      path.join(MP, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      path.join(MP, d, 'chrome-win', 'chrome.exe')
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
  }
  return null;
}

(async () => {
  const chrome = findChrome();
  if (!chrome || !fs.existsSync(PW)) {
    console.log('SKIP  截图：未找到 playwright-core 或 chrome-headless-shell（HTML 已生成）');
    return;
  }
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 380 }, deviceScaleFactor: 2 });
  const url = 'file:///' + htmlPath.replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(700);
  const light = path.join(PREVIEW, 'tabbar-compare-light.png');
  await page.screenshot({ path: light, fullPage: true });
  console.log('PNG   ' + light);

  // 放大特写：单独新建一个 4× 像素密度的页，选「课程表」（最长的 3 字标签），
  // 只截改后那一根底栏，用来判断文字是否被胶囊裁切 / 挤压。
  const detailPage = await browser.newPage({ viewport: { width: 960, height: 380 }, deviceScaleFactor: 4 });
  await detailPage.goto(url, { waitUntil: 'load' });
  await detailPage.waitForTimeout(500);
  await detailPage.evaluate(() => { pick(1); });
  await detailPage.waitForTimeout(500);
  const detail = path.join(PREVIEW, 'tabbar-detail.png');
  await detailPage.frameLocator('#f-after').locator('.tabbar').screenshot({ path: detail });
  console.log('PNG   ' + detail);
  await detailPage.close();

  await page.evaluate(() => { setTheme(true); pick(1); });
  await page.waitForTimeout(700);
  const dark = path.join(PREVIEW, 'tabbar-compare-dark.png');
  await page.screenshot({ path: dark, fullPage: true });
  console.log('PNG   ' + dark);
  await browser.close();
})().catch((e) => { console.error('截图失败：' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
