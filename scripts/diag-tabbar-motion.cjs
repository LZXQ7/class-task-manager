#!/usr/bin/env node
/**
 * 诊断回路：底栏「切换页面闪一下 / 文字直接出来没有动画」
 * ------------------------------------------------------------
 * 背景：微信小程序自定义 tabBar 是**每个 Tab 页各一个实例**。
 *   旧预览用「同一个 DOM 里切 class」建模 —— 这是错的。真机 switchTab 是换一个
 *   全新实例，新实例首帧 wxml 渲染时 `active === index` 已成立，`.tab-text.on`
 *   一出生就挂着。CSS `transition` 需要「状态跃迁」才播；元素创建即终态 → 无跃迁
 *   → 不播。真机靠 `syncActive` 消费跨页交接时置的 `popIndex`（→ `.poping`）来起播，
 *   所以入场动画必须挂在 `.poping` 驱动的 `@keyframes` 上（创建/挂 class 即播）。
 *
 * 本回路测四件事（确定性、秒级、无需真机）：
 *   S1 同实例切 class（旧预览模型）：目标项文字 opacity 中间帧数 + 图标 x 漂移
 *   S2 跨页换实例（真机模型，带 .poping）：同上
 *   H2 落地实例首帧 active / indLeft 是否错位（JS 层，沙箱跑真实 index.js）
 *   H3 页面级入场动画是否会在回访重播（静态层）
 *
 * 判据（绿 = 三处症状全部消除）：
 *   S2 中间帧 > 0    → 跨页换实例也能播出入场动画（否则「文字直接出来」）
 *   图标 x 漂移 < 2px → 未选中项图标不随文字显隐左右重排（否则「闪一下」）
 *   H3 lite 无 opacity → 回访不再整页重新淡入（⑧ v1.0.8.37 修复）
 *
 * H2 只报告、不参与退出码：它是指示器跨页交接的既有设计（必须从起点格滑过来），
 * 已用「图标 off→on 交叉淡入」缓解首帧错位，但 active/indLeft 不同格本身是滑动的必要条件。
 *
 * 用法：node scripts/diag-tabbar-motion.cjs
 * 退出码：0 = 底栏侧无症状（绿）；1 = 复现用户症状（红）；2 = 回路自身异常
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(p, 'utf8');
const rpx2px = (css) => css.replace(/(-?\d+(?:\.\d+)?)rpx/g, (m, n) => (Number(n) / 2) + 'px');

/* ---------- ① 静态层：页面级入场动画是否会在回访重播 ---------- */
const pageAnim = read(path.join(MINI, 'utils/page-anim.js'));
const appWxssSrc = read(path.join(MINI, 'app.wxss'));
const tabPages = ['home', 'timetable', 'classinfo', 'duty', 'mine'];
const replayPages = [];
for (const p of tabPages) {
  const f = path.join(MINI, 'pages', p, 'index.wxml');
  const j = path.join(MINI, 'pages', p, 'index.js');
  if (!fs.existsSync(f) || !fs.existsSync(j)) continue;
  const wxml = read(f), js = read(j);
  if (/pa-lite-a/.test(wxml) && /playReady\s*\(/.test(js) && /\.st-item/.test(wxml)) replayPages.push(p);
}
/* H3 的判据是「回访是否会**重新淡入**」，不是「回访是否重播动画」：
   ⑧ 之后 lite 仍在轮换重播（保留 5px 上浮），但 keyframes 已不含 opacity，
   所以继续用「有没有 animation: paInLiteA」判断会假红。 */
const liteKf = (appWxssSrc.match(/@keyframes\s+paInLite[AB]\s*\{[\s\S]*?\n\}/g) || []).join('\n');
const liteHasOpacity = /\bopacity\s*:/.test(liteKf);
const pageFlash = replayPages.length > 0 &&
  /animSeq:\s*seq/.test(pageAnim) && liteHasOpacity;

/* H3b：浏览器逐帧对照 —— 拿 HEAD（改前）与工作区（改后）的 app.wxss 各渲染一个
   .st-item，挂上 pa-lite-a 触发「回访重播」，采样 opacity。改前应有 0→1 中间帧
   （整页重新淡入 = 白一下），改后应恒为 1。静态断言之外再给一条可跑的红/绿证据。 */
const { execFileSync } = require('child_process');
const APP_HEAD = execFileSync('git', ['show', 'HEAD:miniprogram/app.wxss'],
  { cwd: ROOT, encoding: 'utf8' });
function paCss(src) {
  const kf = (src.match(/@keyframes\s+paInLiteA\s*\{[\s\S]*?\n\}/) || [])[0] || '';
  const base = (src.match(/\.pa-lite-a\s+\.st-item\s*\{[^}]*animation:[^}]*\}/) || [])[0] || '';
  return kf + '\n' + base;
}
function paHtml(css) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${css}
body { margin: 0; background: #eef3fb; }
.st-item { width: 200px; height: 64px; margin: 24px; border-radius: 14px; background: #3370ff;
  color: #fff; font: 14px sans-serif; display: flex; align-items: center; justify-content: center; }
</style></head><body><div class="st-item st-1">内容卡片</div>
<script>
window.__sample = (ms) => new Promise((resolve) => {
  const el = document.querySelector('.st-item');
  document.body.classList.add('pa-lite-a');   // 此刻才挂 class，animation 从 0 起播
  const out = []; const t0 = performance.now();
  function tick() {
    out.push({ t: Math.round(performance.now() - t0), o: Number(getComputedStyle(el).opacity) });
    if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(out);
  }
  requestAnimationFrame(tick);
});
<\/script></body></html>`;
}

/* ---------- ② 行为层：落地实例首帧 active / indLeft 是否错位 ---------- */
const js = read(path.join(MINI, 'custom-tab-bar/index.js'));
let firstFrameMismatch = false;
let firstFrameDetail = '';
try {
  const timers = [];
  const sandbox = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    wx: { switchTab: () => {} }
  };
  const themeStub = { themeClass: () => 't-light', mount: () => {}, unmount: () => {} };
  const src = js
    .replace(/^\s*(?:const|let|var)\s+[^\n]*?=\s*require\([^\n]*\)\s*;?\s*$/gm, '')
    .replace(/\bsetTimeout\b/g, 'sandbox.setTimeout')
    .replace(/\bclearTimeout\b/g, 'sandbox.clearTimeout')
    .replace(/\bwx\./g, 'sandbox.wx.')
    + '\nsandbox.INSTANCES = INSTANCES;'
    + '\nsandbox.setHandoff = (h) => { HANDOFF = h; };';
  let def = null;
  const Component = (d) => { def = d; };
  new Function('sandbox', 'get', 'getApp', 'Component', 'theme',
    '"use strict";' + src)(sandbox, () => ({ data: '' }), () => null, Component, themeStub);

  const sideV = Number((/SIDE_RPX\s*=\s*(\d+)/.exec(js) || [])[1]);
  const cell = (750 - sideV * 2) / 5;
  const nL = (i) => Math.round(i * cell);
  const mk = (route) => {
    const inst = { data: JSON.parse(JSON.stringify(def.data)), sets: [], cbs: [], _route: route };
    inst.setData = (o, cb) => {
      Object.assign(inst.data, o);
      inst.sets.push(o);
      if (typeof cb === 'function') inst.cbs.push(cb);
    };
    ['_indMove', '_preplace', 'onChange', '_takeHandoff', '_syncActiveFromRoute', 'syncActive']
      .forEach(k => { inst[k] = def.methods[k]; });
    inst._currentRoute = () => route;
    return inst;
  };
  sandbox.setHandoff({ to: 4, from: 0, at: Date.now() });
  const landing = mk('/pages/mine/index');
  def.lifetimes.attached.call(landing);
  const a = landing.data.active, l = landing.data.indLeft;
  firstFrameMismatch = (a === 4 && l === nL(0));
  firstFrameDetail = '首帧 active=' + a + '（文字/图标已在第 ' + a + ' 格就位）'
    + '，indLeft=' + l + 'rpx（指示器第 ' + Math.round(l / cell) + ' 格）';
} catch (e) {
  firstFrameDetail = '沙箱异常：' + e.message;
}

/* ---------- ③ 视觉层：浏览器采样文字 opacity + 图标 x 坐标 ---------- */
const wxss = rpx2px(read(path.join(MINI, 'custom-tab-bar/index.wxss')));
function takeRule(sel) {
  const i = appWxssSrc.indexOf('\n' + sel + ' {');
  if (i < 0) return '';
  const j = appWxssSrc.indexOf('\n}', i);
  return appWxssSrc.slice(i + 1, j + 2);
}
const THEME = rpx2px([
  takeRule('page').replace(/^page\s*\{/m, 'body {'),
  takeRule('.t-light'), takeRule('.t-dark')
].join('\n'));
const GLUE = `
html,body { margin:0; height:100%; overflow:hidden; }
.tabbar-wrap { padding-bottom: 32px !important; }
.tab-icon { -webkit-user-drag: none; }
`;
const TEXTS = ['首页', '课程表', '信息', '值日', '我的'];

const PAGE_JS = `
const TEXTS = ${JSON.stringify(TEXTS)};
/** active=选中格；pop=是否给选中项挂 .poping（真机 syncActive 交接会置 popIndex） */
function barHtml(active, pop) {
  const items = TEXTS.map((t,i) => {
    const cls = 'tab-item' + (i===active?' on':'') + (pop && i===active?' poping':'');
    return '<div class="' + cls + '" data-i="' + i + '">' +
      '<div class="tab-icon-box"><span style="display:block;width:19px;height:19px;border-radius:5px;background:#9db4d8"></span></div>' +
      '<span class="tab-text' + (i===active?' on':'') + '">' + t + '</span></div>';
  }).join('');
  return '<div class="tabbar-wrap t-light"><div class="tabbar">' +
    '<div class="tab-ind" style="left:' + (active*58) + 'px;width:58px"></div>' + items + '</div></div>';
}
function paint(active) {
  document.querySelectorAll('.tab-item').forEach((el,k) => {
    const on = k === active;
    el.classList.toggle('on', on);
    el.classList.toggle('poping', on);       // popIndex 从旧格移到新格
    el.querySelector('.tab-text').classList.toggle('on', on);
  });
}
/** 各图标中心 x（用于抓「整排图标左右重排」＝闪一下） */
function iconXs() {
  return Array.from(document.querySelectorAll('.tab-icon-box')).map(el => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  });
}
function drift(before, after) {
  let mx = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    mx = Math.max(mx, Math.abs(before[i] - after[i]));
  }
  return mx;
}
function sample(index, ms) {
  return new Promise((resolve) => {
    const el = document.querySelectorAll('.tab-text')[index];
    if (!el) { resolve([]); return; }
    const out = []; const t0 = performance.now();
    function tick() {
      const cs = getComputedStyle(el);
      out.push({ t: Math.round(performance.now() - t0), o: Number(cs.opacity) });
      if (performance.now() - t0 < ms) requestAnimationFrame(tick);
      else resolve(out);
    }
    requestAnimationFrame(tick);
  });
}
const midFrames = (s) => s.filter(x => x.o > 0.05 && x.o < 0.95).length;
window.__test = {
  async sameInstance(target) {
    const before = iconXs();
    paint(target);
    const after = iconXs();
    const s = await sample(target, 340);
    return { mid: midFrames(s), drift: drift(before, after), series: s };
  },
  async newInstance(target) {
    const before = iconXs();
    // 真机：目标页实例是**全新**的，首帧 wxml 渲染时 .on/.poping 已经挂着
    document.getElementById('host').innerHTML = barHtml(target, true);
    const after = iconXs();
    const s = await sample(target, 340);
    return { mid: midFrames(s), drift: drift(before, after), series: s };
  },
  reset() { document.getElementById('host').innerHTML = barHtml(0, false); }
};
`;
const initBar = `<div class="tabbar-wrap t-light"><div class="tabbar">
    <div class="tab-ind" style="left:0px;width:58px"></div>
    ${TEXTS.map((t, i) => `<div class="tab-item${i === 0 ? ' on' : ''}" data-i="${i}">
      <div class="tab-icon-box"><span style="display:block;width:19px;height:19px;border-radius:5px;background:#9db4d8"></span></div>
      <span class="tab-text${i === 0 ? ' on' : ''}">${t}</span></div>`).join('')}
  </div></div>`;
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${THEME}
${wxss}
${GLUE}
</style></head><body class="t-light">
<div id="host">${initBar}</div>
<script>${PAGE_JS}<\/script>
</body></html>`;

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
  console.log('══════ 底栏切换动效 · 诊断回路 ══════\n');
  console.log('【H3 页面级回访淡入】（⑧ 本轮已修）');
  console.log('  onShow 会轮换 lite 类名重播的 Tab 页：' + (replayPages.join('、') || '无'));
  console.log('  两套 lite keyframes 含 opacity：' + (liteHasOpacity ? '是' : '否')
    + '（仍保留 5px 上浮，只是不再透明淡入）');
  console.log('  判定：' + (pageFlash
    ? '🔴 红 → 每切一次 Tab 整页内容重新淡入（"闪一下"）'
    : '🟢 绿 → 回访内容始终可见，只有极轻上浮'));

  console.log('\n【H2 落地实例首帧错位】（只报告，属指示器跨页交接既有设计）');
  console.log('  ' + firstFrameDetail);
  console.log('  判定：' + (firstFrameMismatch
    ? '存在 → 文字已在新格、指示器还在起点格（随后两拍滑过去）' : '未发现'));

  const chrome = findChrome();
  if (!chrome || !fs.existsSync(PW)) {
    console.log('\n[SKIP] 无头浏览器不可用，H1/H4 未测');
    process.exit(0);
  }
  const { chromium } = require(PW);
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(450);

  const s1 = await page.evaluate(() => window.__test.sameInstance(1));
  await page.waitForTimeout(450);
  await page.evaluate(() => window.__test.reset());
  await page.waitForTimeout(450);
  const s2 = await page.evaluate(() => window.__test.newInstance(1));

  // H3b：改前(HEAD) / 改后(工作区) 的回访 opacity 逐帧对照
  const samplePa = async (src) => {
    const p = await browser.newPage({ viewport: { width: 300, height: 140 } });
    await p.setContent(paHtml(paCss(src)), { waitUntil: 'load' });
    await p.waitForTimeout(120);
    const s = await p.evaluate(() => window.__sample(300));
    await p.close();
    return s;
  };
  const headPa = await samplePa(APP_HEAD);
  const workPa = await samplePa(appWxssSrc);
  await browser.close();

  const midOf = (s) => s.filter(x => x.o > 0.05 && x.o < 0.95).length;
  const headMid = midOf(headPa), workMid = midOf(workPa);
  const paExtractOk = /@keyframes/.test(paCss(APP_HEAD)) && /@keyframes/.test(paCss(appWxssSrc));

  const brief = (s) => s.series.filter((_, i) => i % 4 === 0)
    .map(x => x.t + 'ms:' + x.o.toFixed(2)).join('  ');
  console.log('\n【H1 文字入场动画 · 目标「课程表」】');
  console.log('  S1 同实例切 class（旧预览模型）：中间帧 ' + s1.mid + ' 帧');
  console.log('     ' + brief(s1));
  console.log('  S2 跨页换实例（真机模型）    ：中间帧 ' + s2.mid + ' 帧');
  console.log('     ' + brief(s2));
  console.log('\n【H4 图标横向重排（"闪一下"）】');
  console.log('  S1 最大 x 漂移 ' + s1.drift.toFixed(2) + 'px ／ S2 最大 x 漂移 ' + s2.drift.toFixed(2) + 'px');
  console.log('\n【H3b 页面级回访淡入 · 浏览器逐帧对照】');
  console.log('  改前 HEAD   .st-item opacity 中间帧 ' + headMid + ' 帧（0→1 = 整页重新淡入 = "白一下"）');
  console.log('  改后工作区 .st-item opacity 中间帧 ' + workMid + ' 帧（恒为 1 = 内容始终可见）');
  console.log('  CSS 片段提取：' + (paExtractOk ? '成功' : '⚠️ 失败，H3b 不参与判定'));

  const noTextAnim = (s2.mid === 0);
  const reflow = (Math.max(s1.drift, s2.drift) > 2);
  const h3bGreen = !paExtractOk || (headMid > 0 && workMid === 0);
  const green = !noTextAnim && !reflow && !pageFlash && h3bGreen;
  console.log('\n────── 结论 ──────');
  if (green) {
    console.log('  🟢 绿：跨页换实例也能播出入场动画；图标 x 恒定；回访不再整页淡入。');
  } else {
    if (noTextAnim) console.log('  🔴 红：跨页换实例后文字「生来就在」→ 直接出来、没有动画。');
    if (reflow) console.log('  🔴 红：切换时图标发生横向重排 → 整排跳一下（"闪"）。');
    if (pageFlash) console.log('  🔴 红：回访 lite keyframes 带 opacity → 每切一次 Tab 整页重新淡入。');
    if (!h3bGreen) console.log('  🔴 红：H3b 浏览器对照不符（改前应有淡入中间帧、改后应恒为 1）。');
    console.log('     修复方向：入场用 @keyframes + .poping（创建即播）；文字绝对定位不占位；回访去掉透明淡入。');
  }
  console.log('  H2=' + (firstFrameMismatch ? '存在（既有跨页交接设计，已用图标交叉淡入缓解）' : '无')
    + '  H3=' + (pageFlash ? '红' : '绿'));
  process.exit(green ? 0 : 1);
})().catch((e) => { console.error('回路异常：' + (e && e.stack ? e.stack : e)); process.exit(2); });
