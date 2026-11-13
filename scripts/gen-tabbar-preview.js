#!/usr/bin/env node
/**
 * 底栏三版对比 + 逐帧时间线预览（v1.0.8.36 第 2 轮）
 * ------------------------------------------------------------
 * 🔴 与上一版的根本区别：**按真机建模**。
 *   微信小程序自定义 tabBar 是「每个 Tab 页各一个实例」，switchTab = 换实例。
 *   上一版预览用「同一个 DOM 里切 class」，CSS transition 有状态跃迁所以能看到
 *   文字展开动画 —— 真机上新实例首帧 .on 就挂着，transition 根本不播（用户反馈
 *   「文字直接出来，没有动画」）。诊断回路 scripts/diag-tabbar-motion.cjs 复现了这点。
 *   本预览默认「真机换实例」模型：点击 = 销毁重建 DOM、首帧即终态 + .poping，
 *   与真机一致；另留「同实例」开关做对照，可直观看到旧预览为什么骗人。
 *
 * CSS 一律从源码读（不重写样式，避免预览与真机漂移）：
 *   ① 改前  = git e41596a^（v1.0.8.36 之前的原始竖排常显版）
 *   ② 横排  = git HEAD（e41596a 已把横排版带进 1.0.8.36 发版包）
 *   ③ 本版  = 工作区 miniprogram/custom-tab-bar/index.wxss（试验态，未入库）
 *   图标 = utils/icons.js 的真实内联 base64；主题令牌 = app.wxss 的 page/.t-light/.t-dark
 *   只做 rpx→px（÷2，375px 视口）换算。
 *
 * 用法：node scripts/gen-tabbar-preview.js
 * 产物：preview/tabbar-expand.html        （三栏可交互）
 *       preview/tabbar-timeline.html      （切换后 0/70/140/220/320ms 逐帧定格）
 *       preview/tabbar-compare-light.png / -dark.png / tabbar-timeline.png / tabbar-detail.png
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const PREVIEW = path.join(ROOT, 'preview');
const read = (p) => fs.readFileSync(p, 'utf8');
const rpx2px = (css) => css.replace(/(-?\d+(?:\.\d+)?)rpx/g, (m, n) => (Number(n) / 2) + 'px');

/* ---------------- ① 三份真源 CSS ---------------- */
const TB = 'miniprogram/custom-tab-bar/index.wxss';
const show = (rev) => execFileSync('git', ['show', rev + ':' + TB], { cwd: ROOT, encoding: 'utf8' });
const AFTER = rpx2px(read(path.join(ROOT, TB)));
/* ⚠️ HEAD **不是**「改前」：commit e41596a（v1.0.8.36）把上一版「横排展开 +
   内缩胶囊」一并带进了入库发版包。真正的原始「五项文字常显」竖排版在它的父提交。
   所以三栏 = e41596a^（原始）/ HEAD（已入库横排）/ 工作区（本版试验态）。 */
let BEFORE, HORIZ;
try {
  BEFORE = rpx2px(show('e41596a^'));
  HORIZ = rpx2px(show('HEAD'));
} catch (e) {
  // 别的环境没有该 commit：退回 HEAD 当改前，并尝试本地快照当横排版
  BEFORE = rpx2px(show('HEAD'));
  const cand = [
    path.join(PREVIEW, 'fixtures/tabbar-horizontal.wxss'),
    path.join(ROOT, '.workbuddy/tmp/tabbar-horizontal.wxss')
  ].find(p => fs.existsSync(p));
  HORIZ = cand ? rpx2px(read(cand)) : null;
}

const appWxss = read(path.join(MINI, 'app.wxss'));
function takeRule(sel) {
  const i = appWxss.indexOf('\n' + sel + ' {');
  if (i < 0) throw new Error('app.wxss 找不到规则块：' + sel);
  const j = appWxss.indexOf('\n}', i);
  return appWxss.slice(i + 1, j + 2);
}
const THEME = rpx2px([
  takeRule('page').replace(/^page\s*\{/m, 'body {'),
  takeRule('.t-light'), takeRule('.t-dark')
].join('\n'));

/* ---------------- ② 真实图标 + 三版共用的 DOM 生成器 ----------------
 * BAR_FN 同时给 Node（生成初始 HTML）和 iframe（真机重建）用，避免两份逻辑漂移。 */
const { get } = require(path.join(MINI, 'utils/icons.js'));
const TABS = [
  { key: 'home', text: '首页', icon: 'tab-home' },
  { key: 'timetable', text: '课程表', icon: 'tab-timetable' },
  { key: 'classinfo', text: '信息', icon: 'tab-classinfo' },
  { key: 'duty', text: '值日', icon: 'tab-duty' },
  { key: 'mine', text: '我的', icon: 'tab-mine' }
];
const ICONS = TABS.map(t => ({
  off: (get(t.icon, 'off') || {}).data || '',
  on: (get(t.icon, 'on') || {}).data || ''
}));
const BAR_FN = `
const TEXTS = ${JSON.stringify(TABS.map(t => t.text))};
const ICONS = ${JSON.stringify(ICONS)};
/**
 * @param {number} active   选中格
 * @param {boolean} pop     是否给选中项挂 .poping（真机 syncActive 交接置 popIndex）
 * @param {number|null} freeze  非 null = 逐帧定格：把 keyframes 负 delay + paused 定在 t=freeze ms
 * @param {number|null} indLeft 指示器初始 left(px)；null = 直接画在目标格
 */
function barHtml(active, pop, freeze, indLeft) {
  const items = TEXTS.map((t, i) => {
    const on = i === active;
    const poping = pop && on;
    const cls = 'tab-item' + (on ? ' on' : '') + (poping ? ' poping' : '');
    let sIcon = '', sText = '', sImg = '';
    if (freeze !== null && poping) {
      // 负 delay = 已播到该时刻；各自要扣掉 CSS 里原本的正 delay。
      // 图标上浮 0 / 图标交叉淡入 .04s / 文字渐入 .06s。
      const dIcon = (-freeze / 1000) + 's';
      const dImg = (0.04 - freeze / 1000) + 's';
      const dText = (0.06 - freeze / 1000) + 's';
      const frozen = (d) => ' style="animation-delay:' + d + ';animation-play-state:paused"';
      sIcon = frozen(dIcon);
      sImg = frozen(dImg);
      sText = frozen(dText);
    }
    return '<div class="' + cls + '" data-i="' + i + '">' +
      '<div class="tab-icon-box"' + sIcon + '>' +
        '<img class="tab-icon tab-icon-off' + (on ? ' off' : '') + '" src="' + ICONS[i].off + '"' + sImg + ' draggable="false">' +
        '<img class="tab-icon tab-icon-on' + (on ? ' on' : '') + '" src="' + ICONS[i].on + '"' + sImg + ' draggable="false">' +
      '</div>' +
      '<span class="tab-text' + (on ? ' on' : '') + '"' + sText + '>' + t + '</span>' +
    '</div>';
  }).join('');
  const left = (indLeft === null || indLeft === undefined) ? (active * 58) : indLeft;
  return '<div class="tabbar-wrap t-light"><div class="tabbar">' +
    '<div class="tab-ind" style="left:' + left + 'px;width:58px"></div>' + items + '</div></div>';
}
`;
// Node 侧取到同一个函数
const barHtml = new Function(BAR_FN + '\nreturn barHtml;')();

/* 指示器两拍的近似位置（时间线定格用） */
const CELL = 58, OVER = 7, IND_MS = 140, SETTLE_MS = 240;
function indAt(t, from, to) {
  const nL = (i) => i * CELL;
  const sL = (i, f) => i * CELL + (i >= f ? OVER : -OVER);
  if (t <= 0) return nL(from);
  if (t < IND_MS) return nL(from) + (sL(to, from) - nL(from)) * (t / IND_MS);
  const p = Math.min(1, (t - IND_MS) / SETTLE_MS);
  return sL(to, from) + (nL(to) - sL(to, from)) * p;
}

/* ---------------- ③ iframe 内容 ---------------- */
const GLUE = `
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
.tl .mock, .tl .page-glass { display: none; }
.tl .tabbar-wrap { padding-bottom: 14px !important; }
`;

const FRAME_JS = `
${BAR_FN}
const CELL = 58, OVER = 7, IND_MS = 140;
let active = CFG.active, timer = null, MODEL = 'instance';
const host = document.getElementById('host');
function paint(i) {
  document.querySelectorAll('.tab-item').forEach((el, k) => {
    const on = k === i;
    el.classList.toggle('on', on);
    el.classList.toggle('poping', on);
    el.querySelector('.tab-text').classList.toggle('on', on);
    el.querySelector('.tab-icon-off').classList.toggle('off', on);
    el.querySelector('.tab-icon-on').classList.toggle('on', on);
  });
}
/** 真机：换实例（重建 DOM，首帧即终态 + .poping）；旧预览：同实例切 class */
function select(i) {
  if (i === active) return;
  const from = active;
  active = i;
  if (MODEL === 'instance') {
    host.innerHTML = barHtml(i, true, null, from * CELL);
  } else {
    paint(i);
  }
  const ind = document.querySelector('.tab-ind');
  if (!ind) return;
  if (timer) clearTimeout(timer);
  void ind.offsetWidth;                       // 强制 reflow：让初始 left 落地，过渡才起播
  ind.className = 'tab-ind stretch';
  ind.style.left = (i * CELL + (i >= from ? OVER : -OVER)) + 'px';
  ind.style.width = CELL + 'px';
  timer = setTimeout(() => {
    ind.className = 'tab-ind settle';
    ind.style.left = (i * CELL) + 'px';
    ind.style.width = CELL + 'px';
  }, IND_MS);
}
function setTheme(dark) {
  const add = dark ? 't-dark' : 't-light';
  const del = dark ? 't-light' : 't-dark';
  document.body.classList.remove(del); document.body.classList.add(add);
  const w = document.querySelector('.tabbar-wrap');
  if (w) { w.classList.remove(del); w.classList.add(add); }
}
function setModel(m) { MODEL = (m === 'same') ? 'same' : 'instance'; }
window.previewApi = { select, setTheme, setModel };
if (!CFG.timeline) {
  document.querySelectorAll('.tab-item').forEach(el =>
    el.addEventListener('click', () => select(Number(el.dataset.i))));
}
`;

function frameHtml(css, cfg) {
  const cfgJs = 'const CFG = ' + JSON.stringify(cfg) + ';';
  const bodyCls = cfg.timeline ? 't-light tl' : 't-light';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${THEME}
${css}
${GLUE}
</style></head><body class="${bodyCls}">
<div class="page-glass"></div>
<div class="mock">
  <div class="mock-line w1"></div><div class="mock-line w2"></div>
  <div class="mock-card"></div><div class="mock-line w2"></div>
</div>
<div id="host">${cfg.bar}</div>
<script>${cfgJs}\n${FRAME_JS}<\/script>
</body></html>`;
}

/* ---------------- ④ 三栏对比页 ---------------- */
const frames = {
  before: frameHtml(BEFORE, { active: 0, timeline: false, bar: barHtml(0, false, null, null) })
};
if (HORIZ) frames.horiz = frameHtml(HORIZ, { active: 0, timeline: false, bar: barHtml(0, false, null, null) });
frames.after = frameHtml(AFTER, { active: 0, timeline: false, bar: barHtml(0, false, null, null) });
const framesJson = JSON.stringify(frames).replace(/<\/script/gi, '<\\/script');

const panel = (id, cap) => `<div class="panel"><div class="cap">${cap}</div><iframe id="f-${id}"></iframe></div>`;
const panels = [
  panel('before', '① 改前（1.0.8.35 原始）· <b>五项文字常显</b> · 满格蓝块'),
  HORIZ ? panel('horiz', '② 已入库 1.0.8.36 · <b>横排展开</b> · 真机上文字无动画 / 图标左右重排') : '',
  panel('after', '③ 本版（工作区试验态）· <b>图标上浮 + 下方文字</b> · 文字渐入')
].join('\n  ');

const compareHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>底部导航栏 · 三版对比（真机换实例模型）</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 26px 26px; background: #11151c; color: #e8edf6;
    font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600; letter-spacing: .3px; }
  .sub { color: #8d99ad; font-size: 12px; margin-bottom: 14px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 16px; align-items: center; }
  button { background: #1d2430; color: #dbe4f2; border: 1px solid #313c4d;
    border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  button:hover { background: #273246; border-color: #4a5a74; }
  button.on { background: #2a4372; border-color: #4d8bff; color: #fff; }
  .sep { width: 10px; }
  .tag { color: #6f7d93; font-size: 11px; margin-left: 4px; }
  .grid { display: flex; gap: 18px; flex-wrap: nowrap; }
  .panel { background: #171d27; border: 1px solid #28313f; border-radius: 14px; padding: 12px; }
  .cap { font-size: 12px; color: #a9b6c9; margin: 0 0 9px 4px; letter-spacing: .2px; }
  .cap b { color: #7fb0ff; font-weight: 600; }
  iframe { display: block; width: 375px; height: 200px; border: 0; border-radius: 12px;
    background: #eaf1ff; }
  .note { margin-top: 16px; color: #7f8ca1; font-size: 12px; line-height: 1.9; }
  .note code { color: #9cc2ff; background: #1b2230; padding: 1px 5px; border-radius: 4px; }
  .warn { color: #e8b86a; }
</style></head><body>
<h1>底部导航栏 · 三版对比（真机「换实例」模型）</h1>
<div class="sub">点击底栏任意项即模拟一次 switchTab：销毁重建 DOM、首帧即终态。三份 CSS 均直接读自源码。</div>
<div class="toolbar">
  <button id="b-light" class="on" onclick="setTheme(false)">浅色</button>
  <button id="b-dark" onclick="setTheme(true)">深色</button>
  <span class="sep"></span>
  <button class="on" id="m-instance" onclick="setModel('instance')">真机换实例</button>
  <button id="m-same" onclick="setModel('same')">同实例（旧预览）</button>
  <span class="tag">← 切到「同实例」可看到旧预览为什么骗人</span>
  <span class="sep"></span>
  <button onclick="pick(0)">首页</button>
  <button onclick="pick(1)">课程表（3 字）</button>
  <button onclick="pick(2)">信息</button>
  <button onclick="pick(3)">值日</button>
  <button onclick="pick(4)">我的（末格）</button>
</div>
<div class="grid">
  ${panels}
</div>
<div class="note">
  ③ 本版：<code>.tab-text</code> 绝对定位不占位 → 图标 x 恒定、不再整排重排（根治「闪一下」）；<br>
  入场改 <code>@keyframes</code> + <code>.poping</code>（popIndex 驱动，创建即播）→ 跨页换实例也有 60ms 后渐入的 200ms 动画；<br>
  移除 <code>tabPop</code> 的 78%↔112% 缩放弹跳，改为图标纯 <code>translateY</code> 上浮；背景块两拍滑动与 JS 几何一行未动。<br>
  <span class="warn">注：H3「页面级 pa-lite 回访淡入」不在这份预览里，属另一处历史决策，需另行确认是否一并处理。</span>
</div>
<script>
const FRAMES = ${framesJson};
const IDS = Object.keys(FRAMES);
function mount(id, html) {
  const d = document.getElementById('f-' + id).contentDocument;
  d.open(); d.write(html); d.close();
}
IDS.forEach(id => mount(id, FRAMES[id]));
function each(fn) {
  IDS.forEach(id => {
    const w = document.getElementById('f-' + id).contentWindow;
    if (w && w.previewApi) fn(w.previewApi);
  });
}
function pick(i) { each(a => a.select(i)); }
function setTheme(dark) {
  each(a => a.setTheme(dark));
  document.getElementById('b-light').classList.toggle('on', !dark);
  document.getElementById('b-dark').classList.toggle('on', dark);
}
function setModel(m) {
  each(a => a.setModel(m));
  document.getElementById('m-instance').classList.toggle('on', m === 'instance');
  document.getElementById('m-same').classList.toggle('on', m === 'same');
}
</script>
</body></html>`;

/* ---------------- ⑤ 逐帧时间线页 ---------------- */
const T_STEPS = [0, 70, 140, 220, 320];
const timelineFrames = T_STEPS.map(t => frameHtml(AFTER, {
  active: 1, timeline: true,
  bar: barHtml(1, true, t, indAt(t, 0, 1))
}));
const timelineJson = JSON.stringify(timelineFrames).replace(/<\/script/gi, '<\\/script');
const timelineCells = T_STEPS.map((t, i) =>
  `<div class="cell"><div class="t">t = ${t} ms</div><iframe id="t-${i}"></iframe></div>`).join('\n  ');
const timelineHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>底栏切换 · 逐帧时间线</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px 18px 18px; background: #11151c; color: #e8edf6;
    font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  h1 { margin: 0 0 3px; font-size: 16px; font-weight: 600; }
  .sub { color: #8d99ad; font-size: 11px; margin-bottom: 12px; }
  /* 竖排：聊天窗口里每帧仍能保持 375px 宽、不被缩放糊掉 */
  .row { display: flex; flex-direction: column; gap: 8px; }
  .cell { background: #171d27; border: 1px solid #28313f; border-radius: 12px; padding: 8px; }
  .t { color: #7fb0ff; font-size: 11px; margin: 0 0 6px 3px; font-variant-numeric: tabular-nums; }
  iframe { display: block; width: 375px; height: 122px; border: 0; border-radius: 8px; background: #eaf1ff; }
</style></head><body>
<h1>本版 · 切换后逐帧（首页 → 课程表）</h1>
<div class="sub">每格把 @keyframes 用负 delay + paused 定格在对应时刻；蓝色块按两拍的近似位置画出。看图标上浮与文字从下方淡入是否连贯。</div>
<div class="row">${timelineCells}</div>
<script>
const FRAMES = ${timelineJson};
FRAMES.forEach((html, i) => {
  const d = document.getElementById('t-' + i).contentDocument;
  d.open(); d.write(html); d.close();
});
</script>
</body></html>`;

/* 独立单页（不用 iframe）：4 倍放大特写从这里截 .tabbar，
   避开 frameLocator 跨 iframe 取 bounding box 时截到父页面空白的问题。 */
const soloHtml = frameHtml(AFTER, { active: 1, timeline: false, bar: barHtml(1, true, null, 58) });

if (!fs.existsSync(PREVIEW)) fs.mkdirSync(PREVIEW, { recursive: true });
const htmlPath = path.join(PREVIEW, 'tabbar-expand.html');
const timelinePath = path.join(PREVIEW, 'tabbar-timeline.html');
const soloPath = path.join(PREVIEW, 'tabbar-solo.html');
fs.writeFileSync(htmlPath, compareHtml, 'utf8');
fs.writeFileSync(timelinePath, timelineHtml, 'utf8');
fs.writeFileSync(soloPath, soloHtml, 'utf8');
console.log('HTML  ' + htmlPath);
console.log('HTML  ' + timelinePath);
console.log('HTML  ' + soloPath);

/* ---------------- ⑥ Chrome 无头截图 ---------------- */
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
const W = HORIZ ? 1340 : 840;

(async () => {
  const chrome = findChrome();
  if (!chrome || !fs.existsSync(PW)) {
    console.log('SKIP  截图：未找到 playwright-core 或 chrome-headless-shell（HTML 已生成）');
    return;
  }
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const url = 'file:///' + htmlPath.replace(/\\/g, '/');
  const tlUrl = 'file:///' + timelinePath.replace(/\\/g, '/');
  const soloUrl = 'file:///' + soloPath.replace(/\\/g, '/');

  // 浅色三栏（选「课程表」，3 字最长，最能看出排版）
  const page = await browser.newPage({ viewport: { width: W, height: 420 }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.evaluate(() => { pick(1); });
  await page.waitForTimeout(700);
  const light = path.join(PREVIEW, 'tabbar-compare-light.png');
  await page.screenshot({ path: light, fullPage: true });
  console.log('PNG   ' + light);

  // 深色
  await page.evaluate(() => { setTheme(true); });
  await page.waitForTimeout(500);
  const dark = path.join(PREVIEW, 'tabbar-compare-dark.png');
  await page.screenshot({ path: dark, fullPage: true });
  console.log('PNG   ' + dark);
  await page.close();

  // 4 倍放大特写：独立单页，只截本版那一根底栏
  const detailPage = await browser.newPage({ viewport: { width: 420, height: 220 }, deviceScaleFactor: 4 });
  await detailPage.goto(soloUrl, { waitUntil: 'load' });
  await detailPage.waitForTimeout(650);
  const detail = path.join(PREVIEW, 'tabbar-detail.png');
  await detailPage.locator('.tabbar').screenshot({ path: detail });
  console.log('PNG   ' + detail);
  await detailPage.close();

  // 逐帧时间线（竖排，每帧保持 375px 宽）
  const tlPage = await browser.newPage({ viewport: { width: 440, height: 940 }, deviceScaleFactor: 2 });
  await tlPage.goto(tlUrl, { waitUntil: 'load' });
  await tlPage.waitForTimeout(600);
  const tlPng = path.join(PREVIEW, 'tabbar-timeline.png');
  await tlPage.screenshot({ path: tlPng, fullPage: true });
  console.log('PNG   ' + tlPng);
  await tlPage.close();

  await browser.close();
})().catch((e) => { console.error('截图失败：' + (e && e.stack ? e.stack : e)); process.exitCode = 1; });
