#!/usr/bin/env node
/**
 * 离线自检：深色模式（C-4）
 * ============================================================
 * 背景（用户原话「深色模式切换没有实装」）：
 *   上一轮建好了 `utils/theme.js` + `theme.json`，但**整条链没接线** ——
 *   app.json 没开 darkmode、app.js 没调 init()、页面根节点没有主题 class、
 *   全局令牌写死在 `page{}` 里（永远浅色）。东西齐了但一行都没通电。
 *
 * 深色模式最容易出的六类事故，这个门禁逐条钉死：
 *
 *   ① **接线层**：app.json 的 darkmode / themeLocation、app.js 的 theme.init()。
 *      缺任一条 ⇒ 系统层面根本不会把 dark 主题发给小程序，wx.onThemeChange 不触发。
 *   ② **作用域层**：WXSS 的 `page` 只能选元素本身、**不能选 class**，
 *      所以主题 class 必须由每个页面挂在**自己的根 view** 上。
 *      漏挂一个页面 ⇒ 那个页面在深色下仍是浅色（令牌全在 `page{}` 里，作用域不命中）。
 *   ③ **令牌层**：`.t-light` 与 `.t-dark` 的令牌集合必须**严格一致**。
 *      只在浅色定义 ⇒ 深色下该令牌缺失，`var()` 回退到继承/初始值（多半是透明或黑）。
 *      这是最容易在迭代中漏的一处：加了一个新令牌只写浅色，深色下就悄悄坏掉。
 *   ④ **组件层**：nav-bar 的 bg/color 默认值必须走 `var(--token)`；
 *      写死 `rgba(255,255,255,.5)` ⇒ 深色下导航栏是一块惨白玻璃条。
 *   ⑤ **动效层**：圆形揭示必须用 `clip-path: circle()`（不能用 scale，
 *      那会把底下内容一起缩放变形），必须尊重 prefers-reduced-motion。
 *   ⑥ **写死白色兜底**：`@supports not (backdrop-filter)` 与
 *      `prefers-reduced-transparency` 两处兜底都写死了白色 —— 用户若同时开着
 *      系统「降低透明度」又用深色模式，会看到一整片纯白卡片，正好把深色模式废掉。
 *      这两处**必须**各有一份 `.t-dark` 覆盖。
 *
 * 末尾带**五组变异自证**（全部在内存副本上做，绝不写盘 —— 见 MEMORY 铁律）：
 * 每条判据都有一个「删掉就必红」的坏样本，以及一个「原样不误报」的好样本。
 *
 * 用法：node scripts/check-dark-mode.js
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/*
 * 深色模式总开关（config.DARK_MODE_ENABLED）当前值。
 * ------------------------------------------------------------
 * 🔴 本门禁是**开关感知**的：开关关着时验「入口已隐藏 + 渲染锁浅色」，
 *    开着时验「入口在场 + 三态可用」。两边都要验 ——
 *    否则会出现「只把开关改了、某个入口却忘了同步」的半吊子状态。
 *
 * ⚠️ 但**行为仿真不依赖这个当前值**：下面用 loadTheme(src, true/false)
 *    两种形态都编译一份跑，所以无论开关现在是开是关，两种语义都被验到
 *    （否则「关闭态」的断言在开关开着时会被跳过，等于没验）。
 */
const CONFIG_PATH = path.join(ROOT, 'miniprogram', 'utils', 'config.js');
const DARK_MODE_ENABLED = (() => {
  const m = /const\s+DARK_MODE_ENABLED\s*=\s*(true|false)\s*;/.exec(read('miniprogram/utils/config.js'));
  if (!m) { console.log('  ✗ config.js 里读不到 DARK_MODE_ENABLED（判据锚点失效）'); process.exit(1); }
  return m[1] === 'true';
})();

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed += 1; console.log('  ✗ ' + m); };
const chk = (cond, m) => (cond ? ok(m) : bad(m));

/* ============================================================
 * 工具
 * ============================================================ */
/**
 * 剥注释 —— 等长空白替换，保留换行（换行必须留着，否则行号/上下文全乱）。
 * ⚠️ 本门禁所有源码判据都必须先剥注释：注释里大量出现 `var(--text-1)`、
 *    `.t-dark`、`.page` 这些字面量，不剥必然假失败。
 */
function stripComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 取 `.name {` 之后第一个配对花括号块的内容（不含外层括号） */
function braceBlock(src, name) {
  const i = src.indexOf('\n' + name + ' {');
  if (i < 0) return null;
  const s = src.indexOf('{', i);
  let depth = 0;
  for (let k = s; k < src.length; k += 1) {
    if (src[k] === '{') depth += 1;
    else if (src[k] === '}') {
      depth -= 1;
      if (!depth) return src.slice(s + 1, k);
    }
  }
  return null;
}

/** 块内的自定义属性名列表（去重） */
function tokensOf(body) {
  const out = [];
  const re = /(--[\w-]+)\s*:/g;
  let m;
  while ((m = re.exec(body || ''))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

/** 从 wxml 里取根节点（第一个 class 里带 page 的元素）的 class 值 */
function rootClassOf(wxml) {
  const bare = stripComments(wxml);
  let m;
  const re = /<view\b[^>]*\bclass="([^"]*)"/g;
  while ((m = re.exec(bare))) {
    const cls = m[1];
    if (/(^|\s)page(\s|$)/.test(cls)) return cls;
  }
  return null;
}

/** app.json 里的 pages[]（页面注册表的唯一来源） */
function registeredPages() {
  return JSON.parse(read('miniprogram/app.json')).pages || [];
}

/* ============================================================
 * ① 接线层
 * ============================================================ */
console.log('── ① 接线（app.json / app.js）');
const appJsonRaw = read('miniprogram/app.json');
{
  const cfg = JSON.parse(appJsonRaw);
  chk(cfg.darkmode === true, 'app.json 开了 darkmode（系统才会把 dark 主题发给小程序，wx.onThemeChange 才会触发）');
  chk(cfg.themeLocation === 'theme.json', 'app.json 的 themeLocation 指向 theme.json（原生导航栏/下拉框取色靠它）');
  chk(exists('miniprogram/theme.json'), 'theme.json 存在');
  chk(exists('miniprogram/utils/theme.js'), 'utils/theme.js 存在');

  const tj = JSON.parse(read('miniprogram/theme.json'));
  const names = Object.keys(tj);
  chk(!!tj.light, 'theme.json 有 light 套');
  chk(!!tj.dark, 'theme.json 有 dark 套');
  // ⚠️ dark 套若与 light 套逐字相同 = 没配。挑两个最关键的颜色比。
  if (tj.light && tj.dark) {
    chk(tj.light.navigationBarBackgroundColor !== tj.dark.navigationBarBackgroundColor,
      'theme.json 的 dark 导航栏底色与 light 不同（相同 = 复制粘贴没改，等于没开）');
    chk(tj.light.navigationBarTextStyle !== tj.dark.navigationBarTextStyle,
      'theme.json 的 dark 导航栏文字色与 light 不同（深色下白图标配白底会看不见）');
  }
  chk(names.indexOf('light') >= 0 && names.indexOf('dark') >= 0, 'theme.json 顶层键：' + names.join(' / '));

  const appJs = stripComments(read('miniprogram/app.js'));
  chk(/require\(['"]\.\/utils\/theme['"]\)/.test(appJs), 'app.js require 了 utils/theme');
  const onLaunch = appJs.slice(appJs.indexOf('onLaunch('), appJs.indexOf('onShow(') > 0 ? appJs.indexOf('onShow(') : appJs.length);
  chk(/theme\.init\(\)/.test(onLaunch), 'app.js 的 onLaunch 里调了 theme.init()');
  // ⚠️ 顺序：init 必须**早于**任何身份/页面逻辑，否则首帧先画浅色再跳深色（闪一下）
  const iInit = onLaunch.indexOf('theme.init()');
  const iProfile = onLaunch.search(/globalData\.profile|app\.ready\(|checkAuth/);
  chk(iInit >= 0 && (iProfile < 0 || iInit < iProfile),
    'theme.init() 在 onLaunch 里的位置早于身份加载（否则首帧先浅后深，闪一下）');
}

/* ============================================================
 * ② 作用域层：每个页面都得挂 t-light / t-dark
 * ============================================================ */
console.log('\n── ② 主题作用域（每个页面根节点 + mount/unmount）');
const PAGES = registeredPages();
chk(PAGES.length >= 8, 'app.json 注册了 ' + PAGES.length + ' 个页面');
const noTClass = [];
const noMount = [];
const noUnmount = [];
PAGES.forEach((p) => {
  const wxmlPath = 'miniprogram/' + p + '.wxml';
  const jsPath = 'miniprogram/' + p + '.js';
  if (!exists(wxmlPath) || !exists(jsPath)) {
    bad(p + '：注册了但文件不存在（pages/ 目录必须与 app.json 的 pages[] 一一对应）');
    return;
  }
  const cls = rootClassOf(read(wxmlPath));
  if (!cls || cls.indexOf('{{tClass}}') < 0) noTClass.push(p);
  const js = stripComments(read(jsPath));
  if (!/theme\.mount\(this\)/.test(js)) noMount.push(p);
  // onUnload 可能不存在（页面很少被 navigateTo 销毁）。若没有 onUnload 则不算漏，
  // 有 onUnload 就必须带 unmount —— 否则 listeners 里会一直留着已销毁的实例。
  const u = js.match(/onUnload\s*\(\s*\)\s*\{([\s\S]*?)\n  \}/);
  if (u && !/theme\.unmount\(this\)/.test(u[1])) noUnmount.push(p);
});
if (noTClass.length) bad('这些页面根节点没挂 {{tClass}}（深色下整页仍是浅色）：' + noTClass.join(' / '));
else ok(PAGES.length + ' 个页面根节点都挂了 {{tClass}}');
if (noMount.length) bad('这些页面没调 theme.mount(this)：' + noMount.join(' / '));
else ok(PAGES.length + ' 个页面都在 onLoad 调了 theme.mount(this)');
if (noUnmount.length) bad('这些页面有 onUnload 却没调 theme.unmount(this)（主题订阅泄漏）：' + noUnmount.join(' / '));
else ok('所有存在的 onUnload 都调了 theme.unmount(this)');

/* ============================================================
 * ③ 令牌层：.t-light / .t-dark 对齐 + page 只留主题无关量
 * ============================================================ */
console.log('\n── ③ 令牌（app.wxss）');
const appWxssRaw = read('miniprogram/app.wxss');
const appWxss = stripComments(appWxssRaw);
const lightBody = braceBlock(appWxss, '.t-light');
const darkBody = braceBlock(appWxss, '.t-dark');
const pageBody = braceBlock(appWxss, 'page');
chk(!!lightBody, 'app.wxss 有 .t-light 作用域');
chk(!!darkBody, 'app.wxss 有 .t-dark 作用域');
chk(!!pageBody, 'app.wxss 有 page 作用域');
if (lightBody && darkBody) {
  const L = tokensOf(lightBody);
  const D = tokensOf(darkBody);
  const lightOnly = L.filter((t) => D.indexOf(t) < 0);
  const darkOnly = D.filter((t) => L.indexOf(t) < 0);
  if (!lightOnly.length && !darkOnly.length) ok('.t-light 与 .t-dark 令牌集合严格一致（各 ' + L.length + ' 个）');
  else {
    if (lightOnly.length) bad('只在 .t-light 定义、深色下缺失（var() 会回退成透明/黑）：' + lightOnly.join(' / '));
    if (darkOnly.length) bad('只在 .t-dark 定义，浅色下缺失：' + darkOnly.join(' / '));
  }
  // 逐个令牌比「值不能相同」——全部一模一样就等于没做深色
  const same = L.filter((t) => {
    const re = new RegExp(t + '\\s*:\\s*([^;]+);');
    const a = re.exec(lightBody);
    const b = re.exec(darkBody);
    return a && b && a[1].trim() === b[1].trim();
  });
  if (!same.length) ok('.t-dark 每个令牌的值都与 .t-light 不同（确实换了配色，不是复制粘贴）');
  else bad('这些令牌 light/dark 取值完全相同（深色下等于没换）：' + same.join(' / '));
  // 深色底色必须真的是「暗」的：--bg-page / --bg-card 的亮度要显著低于浅色版
  const lum = (hex) => {
    const h = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!h) return null;
    const v = parseInt(h[1], 16);
    return (0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  };
  const readTok = (body, t) => {
    const m = new RegExp(t + '\\s*:\\s*(#[0-9a-fA-F]{3,8})').exec(body || '');
    return m ? m[1] : null;
  };
  [['--bg-page', '页面底色'], ['--bg-card', '卡片底色'], ['--text-1', '主文字色']].forEach(([t, label]) => {
    const a = lum(readTok(lightBody, t));
    const b = lum(readTok(darkBody, t));
    if (a === null || b === null) { bad(t + '（' + label + '）取不到 hex 色值，跳过亮度校验'); return; }
    if (t === '--text-1') {
      chk(b > a + 0.3, t + ' 深色版更亮（' + label + '：浅 ' + a.toFixed(2) + ' → 深 ' + b.toFixed(2) + '，深色下必须反色）');
    } else {
      chk(b < a - 0.3, t + ' 深色版更暗（' + label + '：浅 ' + a.toFixed(2) + ' → 深 ' + b.toFixed(2) + '）');
    }
  });
  // 玻璃：深色下若还用「白 + 低不透明度」会变成一块块发灰的脏斑
  const gDark = /--glass-bg\s*:\s*rgba\(\s*255/.test(darkBody);
  chk(!gDark, '.t-dark 的 --glass-bg 不是白色 tint（深色下白 tint 会糊成灰斑）');
}
if (pageBody) {
  // page 里只该留主题无关量（圆角/布局常量/模糊半径）。颜色若还留在 page ⇒
  // 优先级低于 .t-light/.t-dark（都是单类 0-1-0，page 元素选择器是 0-0-1，
  // 后写胜出），但语义上已错位：改 page 会同时改两个主题。
  const colorInPage = /(--(?:text|bg|line|brand|success|warning|danger|purple|glass-(?:bg|edge|shadow|highlight))[\w-]*)\s*:/.test(pageBody);
  chk(!colorInPage, 'page{} 里不再定义颜色类令牌（全在 .t-light / .t-dark）');
  chk(/--r-md/.test(pageBody), 'page{} 保留了主题无关量（圆角 --r-*）');
  chk(/--glass-blur/.test(pageBody), 'page{} 保留了主题无关量（模糊半径 --glass-blur）');

  // ⑦ 极光兜底**必须**留在 page{}（2026-10-08 补，曾在 C-4 重构时被整体搬进 .t-light
  //    并顺手删掉兜底 ⇒ 任何漏挂 tClass 的页面整片纯白、玻璃的 blur 背后没颜色 ⇒
  //    「主题发白 + 玻璃质感消失」）。`page` 是元素选择器、进容器即命中；`.t-light`
  //    要等 theme.mount() 的 setData 推到根节点才生效，那一帧之前不命中。
  chk(/EAF1FF/.test(pageBody) && /background-image\s*:\s*linear-gradient/.test(pageBody),
    'page{} 保留了极光背景兜底（漏挂 tClass 的页面不会整片纯白）');
  // 兜底值必须与 .t-light 一致，否则首帧与 tClass 到达后会闪一下色差
  // （复用已 stripComments 的 lightBody，避免注释里的字面量被当成真值）
  const grab = (src) => {
    const m = src.match(/background-image\s*:\s*(linear-gradient\([^;]+\))/);
    return m ? m[1].replace(/\s+/g, '') : '';
  };
  chk(grab(pageBody) === grab(lightBody) && grab(pageBody) !== '',
    'page{} 的极光兜底与 .t-light 真源一致（不会首帧闪色差）');
}

/* ============================================================
 * ④ 写死白色的降级兜底（两处必须各有一份 .t-dark 覆盖）
 * ============================================================ */
console.log('\n── ④ 降级兜底（@supports not / prefers-reduced-transparency）');
/** 在 app.wxss 里找「写死浅色底」的两个降级块，检查有没有 .t-dark 覆盖 */
function auditFallback(src) {
  const problems = [];
  const specs = /@supports\s+not\s*\(\(\s*backdrop-filter[\s\S]*?\n\}/g;
  const medias = /@media\s*\(prefers-reduced-transparency:\s*reduce\)[\s\S]*?\n\}/g;
  [['@supports not(backdrop-filter)', specs], ['prefers-reduced-transparency', medias]].forEach(([label, re]) => {
    let m;
    let found = false;
    while ((m = re.exec(src))) {
      found = true;
      const body = m[0];
      // 该块内若出现写死白底（#FFFFFF 或 rgba(255,255,255,…)），同块（或紧随其后的 .t-dark 规则）必须有覆盖
      const hardWhite = /background\s*:\s*(#FFFFFF|#FFF\b|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,)/i.test(body);
      if (!hardWhite) continue;
      const hasDark = /\.t-dark[^{]*\{[^}]*background\s*:/.test(body);
      if (!hasDark) problems.push(label + ' 的兜底块写死了白底，但没有 .t-dark 覆盖（深色 + 降低透明度 = 一整片纯白卡片）');
    }
    if (!found) problems.push('找不到 ' + label + ' 的降级块');
  });
  return problems;
}
const fbProblems = auditFallback(appWxss);
if (!fbProblems.length) ok('两处降级兜底都带了 .t-dark 覆盖（深色 + 降低透明度不会变纯白）');
else fbProblems.forEach((p) => bad(p));

/* ============================================================
 * ⑤ 组件层：nav-bar 走令牌 + 圆形揭示形态正确
 * ============================================================ */
console.log('\n── ⑤ nav-bar（令牌 + 切换入口 + 揭示动效）');
/**
 * 全仓最高的 z-index（**排除 nav-bar 自己**）—— 揭示层必须压过它。
 * ⚠️ 放在模块作用域而不是 ⑤ 的 { } 块里：⑧ 的变异自证要用它，
 *    块内 const 到外面看不见（ReferenceError，且报错位置离出错点很远，难查）。
 * 动态扫、不写死清单 ⇒ 以后新增浮层（1200 / 1300…）这条判据自动跟上。
 */
const TOP_OVERLAY_Z = (function () {
  const all = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
      else if (e.name.endsWith('.wxss')) {
        const t = stripComments(fs.readFileSync(p, 'utf8'));
        const re = /z-index\s*:\s*(\d+)/g;
        let m;
        while ((m = re.exec(t))) {
          const rel = path.relative(ROOT, p).replace(/\\/g, '/');
          if (/nav-bar\/index\.wxss$/.test(rel)) continue;
          all.push([Number(m[1]), rel]);
        }
      }
    });
  })(MINI);
  all.sort((a, b) => b[0] - a[0]);
  return all[0] || [0, '(无)'];
})();
/** 揭示层是否盖得住全仓所有浮层（抽成函数供 ⑧ 复用） */
const revealZCovers = (wxssText) => {
  const z = /\.theme-reveal\s*\{[^}]*z-index:\s*(\d+)/.exec(wxssText);
  return !!z && Number(z[1]) > TOP_OVERLAY_Z[0];
};
/** 遮罩色判据（抽成函数：正文与 ⑧ 的变异自证必须复用同一条，否则会出现「变异说抓到、正文却是绿的」） */
function auditMaskColor(js, darkCss, appCss) {
  const m = /nextTheme\s*===\s*'dark'\s*\?\s*'(#[0-9a-fA-F]{3,8})'\s*:\s*'(#[0-9a-fA-F]{3,8})'/.exec(js);
  if (!m) return false;
  const cssDark = /--bg-page\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(darkCss);
  const cssLight = /\.t-light\s*\{[\s\S]*?background-color\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(appCss);
  return !!cssDark && !!cssLight &&
    cssDark[1].toLowerCase() === m[1].toLowerCase() &&
    cssLight[1].toLowerCase() === m[2].toLowerCase();
}
const navJsRaw = read('miniprogram/components/nav-bar/index.js');
const navJs = stripComments(navJsRaw);
const navWxmlRaw = read('miniprogram/components/nav-bar/index.wxml');
const navWxml = stripComments(navWxmlRaw);
const navWxssRaw = read('miniprogram/components/nav-bar/index.wxss');
const navWxss = stripComments(navWxssRaw);

/**
 * nav-bar 的深色模式判据（纯函数：吃源码文本，吐问题列表）。
 * ⚠️ 写成函数而不是内联 if，是为了让 ⑧ 的变异自证能**复用同一条判据** ——
 *    两处各写一遍的话，改了其中一处就会出现「变异说是抓到了、正文却是绿的」。
 */
function auditNavBar(js) {
  const problems = [];
  const bgDef = /bg\s*:\s*\{\s*type\s*:\s*String\s*,\s*value\s*:\s*'([^']*)'/.exec(js);
  if (!bgDef || !/^var\(--/.test(bgDef[1])) problems.push('bg 默认值没走 var(--token)' + (bgDef ? '（实得 ' + bgDef[1] + '）' : '（读不到）'));
  const colorDef = /color\s*:\s*\{\s*type\s*:\s*String\s*,\s*value\s*:\s*'([^']*)'/.exec(js);
  if (!colorDef || !/^var\(--/.test(colorDef[1])) problems.push('color 默认值没走 var(--token)' + (colorDef ? '（实得 ' + colorDef[1] + '）' : '（读不到）'));
  if (/value\s*:\s*'rgba\(\s*255/.test(js)) problems.push('nav-bar 写死了半透明白底（深色下是一块惨白玻璃条）');
  if (!/applyTheme\s*\(/.test(js)) problems.push('没有对外的 applyTheme（页内设置项无法复用同一条切换逻辑）');
  if (!/applyTheme\(next/.test(js)) problems.push('onToggleTheme 没有复用 applyTheme（两条入口会走样）');
  return problems;
}
{
  // ① 属性默认值必须走 var(--token)
  const bgDef = /bg\s*:\s*\{\s*type\s*:\s*String\s*,\s*value\s*:\s*'([^']*)'/.exec(navJs);
  const colorDef = /color\s*:\s*\{\s*type\s*:\s*String\s*,\s*value\s*:\s*'([^']*)'/.exec(navJs);
  chk(bgDef && /^var\(--/.test(bgDef[1]), 'nav-bar 的 bg 默认值走 var(--token)：' + (bgDef ? bgDef[1] : '(读不到)'));
  chk(colorDef && /^var\(--/.test(colorDef[1]), 'nav-bar 的 color 默认值走 var(--token)：' + (colorDef ? colorDef[1] : '(读不到)'));
  chk(auditNavBar(navJs).length === 0, 'nav-bar 令牌/入口判据全过：' + auditNavBar(navJs).join(' / '));

  // ② 切换入口 + 对外的 applyTheme（页内设置项复用同一条逻辑）
  chk(/onToggleTheme\s*\(/.test(navJs), 'nav-bar 有 onToggleTheme（切换按钮的 handler）');
  chk(/applyTheme\s*\(/.test(navJs), 'nav-bar 有对外的 applyTheme（页内「我的」页设置项复用，避免两条入口走样）');
  chk(/applyTheme\(next/.test(navJs), 'onToggleTheme 复用 applyTheme（按钮与设置项同一条逻辑）');
  chk(/setMode\(/.test(navJs), 'nav-bar 调 theme.setMode 落库');

  // ③ 揭示动效形态
  chk(/clip-path:\s*circle\(/i.test(navWxml), '揭示用 clip-path: circle()（scale 会把底下内容一起缩放变形）');
  chk(!/scale\(/.test(navWxml), '揭示层没有 scale（circle 只裁剪、不变形）');
  chk(/pointer-events:\s*none/.test(navWxss), '揭示层 pointer-events: none（不拦点击）');
  chk(/will-change:\s*clip-path/.test(navWxss), '揭示层 will-change: clip-path（走合成器，逐帧 radius 才不掉帧）');
  const revealZ = /\.theme-reveal\s*\{[^}]*z-index:\s*(\d+)/.exec(navWxss);
  const btnZ = /\.theme-btn\s*\{[^}]*z-index:\s*(\d+)/.exec(navWxss);
  chk(revealZ && btnZ && Number(revealZ[1]) > Number(btnZ[1]),
    '揭示层 z-index 高于按钮（' + (revealZ ? revealZ[1] : '?') + ' > ' + (btnZ ? btnZ[1] : '?') + '）');
  // 🔴 揭示层还必须高于**全站所有浮层**（bottom-sheet 1000 / dialog 1100）：
  //    主题切换是「整屏换肤」，遮罩只盖页面、弹层浮在上面不变色 ⇒ 看起来就是 bug。
  //    TOP_OVERLAY_Z 在模块作用域动态扫全仓 wxss 得来，不写死清单。
  chk(revealZ && Number(revealZ[1]) > TOP_OVERLAY_Z[0],
    '揭示层 z-index 高于全仓最高的其它浮层（' + (revealZ ? revealZ[1] : '?') + ' > ' +
    TOP_OVERLAY_Z[0] + '（' + TOP_OVERLAY_Z[1] + '））');
  chk(/prefers-reduced-motion/.test(navWxss), '揭示动效尊重 prefers-reduced-motion（CSS 侧）');
  chk(/_prefersReducedMotion|prefersReducedMotion/.test(navJs), '揭示动效尊重「减弱动效」（JS 侧逐帧 radius 不受 CSS media 管，必须自己判）');
  /*
   * 🔴 2026-10-07：JS 侧的判据**不能直接写在 nav-bar 里**。
   *   判系统「减弱动效」得调 `wx.getSystemInfoSync()` —— 同步跨线程调用，
   *   而 check-perf.js 是**全文扫描 nav-bar**（含 methods），出现即判红。
   *   正解：判据下沉到 utils/theme.prefersReducedMotion()，**惰性算一次 + 进程内缓存**
   *   （值一个生命周期内不变），nav-bar 只调它。
   *   所以这里要同时验三件事，别只验「nav-bar 提到了 prefersReducedMotion」——
   *   那条判据在同步 API 还写在 nav-bar 里时同样会通过（它只查名字）。
   */
  chk(/require\('\.\.\/\.\.\/utils\/theme'\)\.prefersReducedMotion\(\)/.test(navJs),
    'nav-bar 的减弱动效判据委托 utils/theme.prefersReducedMotion()（同步 API 不许出现在组件里）');
  {
    const themeRaw = read('miniprogram/utils/theme.js');
    const rmFn = (themeRaw.match(/function prefersReducedMotion[\s\S]*?\n\}/) || [''])[0];
    chk(rmFn.length > 0, 'utils/theme 导出 prefersReducedMotion()');
    chk(/wx\.getSystemInfoSync\(/.test(rmFn), '减弱动效判据确实读了系统信息');
    chk(/_reduced\s*!==\s*null/.test(rmFn) && /_reduced\s*=/.test(rmFn),
      'utils/theme 的减弱动效判据做了惰性缓存（否则每切一次主题白付一次同步 IPC）');
    chk(/prefersReducedMotion,/.test(themeRaw), 'prefersReducedMotion 已导出');
  }
  // 半径必须到最远角（只算到边的距离 ⇒ 屏幕四角露缝）
  chk(/Math\.max\(\s*x\s*\*\s*x/.test(navJs) && /Math\.max\(\s*y\s*\*\s*y/.test(navJs),
    '揭示半径取「圆心到最远角」（只用 x/y 各取 max 才不会在屏幕角上露缝）');
  // 两段式顺序：先盖（revealR:0）再 setMode
  const playIdx = navJs.indexOf('_playReveal(');
  chk(playIdx > 0, 'nav-bar 有 _playReveal');
  chk(/revealR:\s*0/.test(navJs), '揭示从半径 0 起（先盖住，再揭开）');
  // 遮罩颜色取**新**主题底色
  chk(/nextTheme\s*===\s*'dark'\s*\?\s*'#/.test(navJs), '遮罩颜色按「新」主题取（取旧色会在揭开瞬间闪一次色差）');
  //🔴 遮罩色是 app.wxss `background-color` 的**手工副本**（不能写 var()：
  //    遮罩要的是「盖住时那个纯色」，用带渐变的层去盖会露出渐变 ⇒ 揭开会闪）。
  //    代价是改了背景色它不会跟着变 ⇒ 这里钉死一致性。
  const maskDark = /nextTheme\s*===\s*'dark'\s*\?\s*'(#[0-9a-fA-F]{3,8})'\s*:\s*'(#[0-9a-fA-F]{3,8})'/.exec(navJs);
  if (maskDark) {
    const cssDark = /--bg-page\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(darkBody);
    const cssLightBg = /\.t-light\s*\{[\s\S]*?background-color\s*:\s*(#[0-9a-fA-F]{3,8})/.exec(appWxss);
    chk(!!cssDark && cssDark[1].toLowerCase() === maskDark[1].toLowerCase(),
      '遮罩深色色值 = .t-dark 的 --bg-page（' + maskDark[1] + ' vs ' + (cssDark ? cssDark[1] : '?') + '）');
    chk(!!cssLightBg && cssLightBg[1].toLowerCase() === maskDark[2].toLowerCase(),
      '遮罩浅色色值 = .t-light 的 background-color（' + maskDark[2] + ' vs ' + (cssLightBg ? cssLightBg[1] : '?') + '）');
  } else bad('读不出遮罩色值（nextTheme === "dark" ? "#xxx" : "#yyy"）');
  chk(auditMaskColor(navJs, darkBody, appWxss), '遮罩色一致性判据全过（auditMaskColor）');

  // ④ 定位铁律：fixed 祖先链不能有 filter/backdrop-filter/transform
  //    ⇒ 按钮与 overlay 必须是 .nav 的兄弟节点，不能是它的子节点
  const navInner = /<view class="nav[\s\S]*?\n<\/view>/.exec(navWxml);
  chk(!!navInner && navInner[0].indexOf('theme-btn') < 0 && navInner[0].indexOf('theme-reveal') < 0,
    '主题按钮与揭示层在 .nav **之外**（.nav 有 backdrop-filter，会让 fixed 退化成相对它定位）');
  // ⑤ 按钮只在没有返回键时出现（否则顶走返回按钮）+ **受总开关控制**
  chk(/wx:if="\{\{!showBack\s*&&\s*themeEnabled\}\}"/.test(navWxml),
    '切换按钮 wx:if="{{!showBack && themeEnabled}}"（二级页左上角是返回键的地盘；开关关闭时不渲染）');
  chk(/themeEnabled:\s*DARK_MODE_ENABLED/.test(navJs),
    'nav-bar 的 themeEnabled 直接取 config.DARK_MODE_ENABLED（首帧即正确，不用等 attached 纠正）');
  chk(/require\('\.\.\/\.\.\/utils\/config'\)/.test(navJs), 'nav-bar 引了 utils/config（开关唯一来源）');
  // 按钮被隐藏时，即便有人从别处调 applyTheme 也不能生效（否则「按钮不显示、主题却被改掉」，最难查）
  chk(/if\s*\(!this\.data\.themeEnabled\)\s*return;/.test(navJs),
    'applyTheme 有开关守卫（防将来从别处调过来时悄悄改掉主题）');
}

/* ============================================================
 * ⑥ 行为仿真：真 require utils/theme.js，验三态语义
 * ============================================================ */
console.log('\n── ⑥ theme.js 行为（真模块 + 假 wx）');
/**
 * 在**内存**里编译一份 theme.js（绑定假 wx），返回其 exports + 操纵手柄。
 * 🔴 绝不用 new Function / 字符串拼 require 绕开模块 —— 用 Module._compile，
 *    与真require 的加载路径一致（能验出语法错、循环依赖等）。
 *
 * ⚠️🔴 必须挂到 **global.wx**：小程序模块里写的是裸 `wx.xxx`（自由变量），
 *    Node 里会去 global 上找 —— 只在 `g.wx` 上放一份的话模块拿到的是 undefined，
 *    而 theme.js 每个 wx 调用都包在 try/catch 里 ⇒ 全部静默吞掉，
 *    表现为「system 不跟系统 / setMode 不落库」这类**假失败**，极易误判成生产代码有 bug。
 *    （本门禁第一版就踩了这个：16 项红里有一半是它造成的。）
 */
function loadTheme(srcText, darkEnabled) {
  const store = {};
  const calls = [];
  const sys = { theme: 'light', windowWidth: 375, windowHeight: 812 };
  const cbs = [];
  const prevWx = global.wx;
  /*
   * 让 `require('./config')` 拿到**指定**的开关值。
   * theme.js 是从 config 里解构 `DARK_MODE_ENABLED` 的，不注入的话沙盒只会拿到
   * config.js 里的当前值 ⇒ 「开」「关」两种形态没法同时验。
   * 做法：往 require.cache 里塞一个改造过的 config 模块（Module._compile 走真 require，
   * 会命中缓存），跑完在 restore() 里还原。
   */
  const prevCfg = require.cache[CONFIG_PATH];
  if (darkEnabled !== undefined) {
    const cfgMod = new Module(CONFIG_PATH, null);
    cfgMod.filename = CONFIG_PATH;
    cfgMod.loaded = true;
    cfgMod.exports = Object.assign({}, require(CONFIG_PATH), { DARK_MODE_ENABLED: darkEnabled });
    require.cache[CONFIG_PATH] = cfgMod;
  }
  global.wx = {
    getStorageSync(k) { return store[k]; },
    setStorageSync(k, v) { store[k] = v; calls.push(['set', k, v]); },
    getWindowInfo() { return sys; },
    getSystemInfoSync() { return sys; },
    onThemeChange(cb) { cbs.push(cb); }
  };
  const THEME_PATH = path.join(ROOT, 'miniprogram', 'utils', 'theme.js');
  const m = new Module('theme-fake');
  /*
   * 🔴 必须设 `filename`：模块里的 `require('./config')` 是先**解析**再查缓存的，
   *    而解析用的是 `module.filename` 的所在目录。不设的话假模块的 filename 是
   *    光秃秃的 'theme-fake' ⇒ './config' 解析不到任何地方 ⇒ MODULE_NOT_FOUND，
   *    上面那套 require.cache 注入也就永远不会命中。
   *    （theme.js 原先没有任何 require，所以第一版不设也能跑；加了 config 就必须设。）
   */
  m.filename = THEME_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(THEME_PATH));
  m._compile(srcText, THEME_PATH);
  const g = {
    mod: m.exports,
    store, calls,
    /** 只改系统主题，不触发回调（测 getSystemTheme 的直读路径） */
    setSystem(t) { sys.theme = t; },
    /** 模拟系统主题变化（真机上由 wx.onThemeChange 回调） */
    systemChange(t) { sys.theme = t; cbs.forEach((cb) => cb({ theme: t })); },
    /** 还原 global.wx —— 必须还原，否则后续门禁/脚本看到一个假的全局 wx */
    restore() {
      if (prevWx === undefined) delete global.wx; else global.wx = prevWx;
      if (darkEnabled !== undefined) {
        if (prevCfg === undefined) delete require.cache[CONFIG_PATH];
        else require.cache[CONFIG_PATH] = prevCfg;
      }
    }
  };
  return g;
}
const themeSrc = read('miniprogram/utils/theme.js');
/* 🔴 注入开关 = **开**：下面这批断言（跟随系统 / 手动覆盖）只有在深色模式启用时才有意义。
 *    不注入的话，config 当前值是 false ⇒ resolve() 恒返回 light ⇒ 这些断言全红，
 *    而那不是 bug、是开关关着。所以这里显式要「开」的那份语义。 */
const T = loadTheme(themeSrc, true);
{
  // 前置断言：假 wx 真的挂上了（否则下面全是无意义的假失败）
  chk(global.wx && typeof global.wx.onThemeChange === 'function', '假 wx 已挂到 global.wx（模块里的裸 wx.xxx 才绑得上）');
  const th = T.mod;
  ['init', 'setMode', 'getMode', 'getResolved', 'themeClass', 'mount', 'unmount', 'onThemeChange', 'offThemeChange'].forEach((k) => {
    chk(typeof th[k] === 'function', 'theme.js 导出 ' + k + '()');
  });

  // 默认跟随系统
  T.setSystem('light');
  T.store.theme_mode = undefined;
  chk(th.init() === 'light', '默认 system + 系统浅色 ⇒ 解析为 light');
  chk(th.getMode() === 'system', '默认模式是 system（跟随系统）');
  chk(th.themeClass() === 't-light', '浅色 ⇒ t-light');

  // 系统切深色，system 模式下应跟随
  T.systemChange('dark');
  chk(th.getResolved() === 'dark', 'system 模式下系统切深色 ⇒ 解析为 dark');
  chk(th.themeClass() === 't-dark', '深色 ⇒ t-dark');

  // 手动覆盖后不再跟系统
  th.setMode('light');
  T.systemChange('dark');
  chk(th.getResolved() === 'light', '手动 light 后系统切深色也不变（手动覆盖优先）');
  chk(T.store.theme_mode === 'light', 'setMode 已落 storage');
  th.setMode('dark');
  T.systemChange('light');
  chk(th.getResolved() === 'dark', '手动 dark 后系统切浅色也不变');
  th.setMode('system');
  chk(th.getResolved() === 'light', '切回 system ⇒ 立即跟当前系统（light）');
  // mount / unmount：切主题时只通知还活着的页面
  const mkPage = () => {
    const p = { data: {}, sets: 0, setData(o) { Object.assign(this.data, o); this.sets += 1; } };
    return p;
  };
  const p1 = mkPage();
  th.mount(p1);
  chk(p1.data.tClass === 't-light', 'mount 立刻把当前主题 class 写进页面');
  const p2 = mkPage();
  th.mount(p2);
  th.setMode('dark');
  chk(p1.data.tClass === 't-dark' && p2.data.tClass === 't-dark', '切主题时所有已挂载页面都更新');
  th.unmount(p1);
  const before = p1.sets;
  th.setMode('light');
  chk(p1.sets === before, 'unmount 之后不再 setData 到已销毁页面（否则泄漏 + 无效渲染）');
  chk(p2.data.tClass === 't-light', 'unmount 只摘自己那个，另一个仍正常');
  // 重复挂载幂等（热重载 / onLoad 重入不会注册两个 listener）
  const p3 = mkPage();
  th.mount(p3); th.mount(p3);
  const c3 = p3.sets;
  th.setMode('dark');
  const d3 = p3.sets - c3;
  chk(d3 === 1, '重复 mount 幂等（一次切换只 setData 一次，实得 ' + d3 + '）');
  th.unmount(p2); th.unmount(p3);
  // 白名单：非法模式必须回落而不是把 currentMode 写成脏值
  th.setMode('nope');
  chk(th.getMode() === 'nope' && th.themeClass() === 't-light',
    '非法模式 themeClass 仍返回合法 class（不会算出空 class 导致主题作用域整体失效）');
  th.setMode('system');
  T.restore();
}

/* ============================================================
 * ⑥b 开关**关闭**形态：必须锁浅色
 * ------------------------------------------------------------
 * 否则就是「藏了按钮、但手机处于深色模式时页面照样变深色」——
 * 而页面 wxss 还有 1000+ 处硬编码浅色没迁移，那正是要临时关闭的原因。
 * ============================================================ */
console.log('\n── ⑥b 开关关闭态（DARK_MODE_ENABLED=false ⇒ 一律浅色）');
{
  const Toff = loadTheme(themeSrc, false);
  const th = Toff.mod;
  Toff.setSystem('dark');          // 手机系统处于深色
  Toff.store.theme_mode = undefined;
  chk(th.init() === 'light', '关闭态：默认 system + 系统深色 ⇒ 仍解析为 light（不跟系统）');
  chk(th.themeClass() === 't-light', '关闭态：themeClass 恒 t-light');
  // 系统翻深色 ⇒ 仍不翻（这条走 onThemeChange 回调、**不经过 resolve()**，
  // 所以 theme.js 里必须**两处**都设守卫 —— 这里验的正是回调那处）
  Toff.systemChange('dark');
  chk(th.getResolved() === 'light', '关闭态：系统切深色也不跟随（回调里的守卫不能漏）');
  // 手动档即便被写成 dark 也必须是浅色 —— 防止「之前切到深色、藏了按钮后卡住」
  th.setMode('dark');
  chk(th.getResolved() === 'light', '关闭态：手动档为 dark 时解析值仍是 light（不会有人卡在深色里）');
  chk(th.themeClass() === 't-light', '关闭态：手动档为 dark 时 themeClass 仍 t-light');
  // 但落 storage 照常保留（改回开关即恢复用户原选择 —— 见 config 注释）
  chk(Toff.store.theme_mode === 'dark', '关闭态：setMode 仍落 storage（保留原选择，恢复开关即生效）');
  const p = { data: {}, sets: 0, setData(o) { Object.assign(this.data, o); this.sets += 1; } };
  th.mount(p);
  chk(p.data.tClass === 't-light', '关闭态：mount 写进页面的是 t-light');
  th.unmount(p);
  Toff.restore();
}

/* ============================================================
 * ⑦「我的」页的三态入口
 * ============================================================ */
console.log('\n── ⑦「我的」页外观设置项（二级页没有左上角按钮）');
{
  const js = stripComments(read('miniprogram/pages/mine/index.js'));
  const wxml = stripComments(read('miniprogram/pages/mine/index.wxml'));
  const wxss = stripComments(read('miniprogram/pages/mine/index.wxss'));
  chk(/themeOpts\s*:\s*\[/.test(js), 'mine 的 data 里有 themeOpts');
  ['system', 'light', 'dark'].forEach((k) => {
    chk(new RegExp("key\\s*:\\s*'" + k + "'").test(js), 'themeOpts 含 ' + k);
  });
  chk(/onThemePick\s*\(/.test(js), 'mine 有 onThemePick（点选切换）');
  chk(/nav\.applyTheme\(/.test(js) || /\.applyTheme\(/.test(js), 'mine 复用 nav-bar 的 applyTheme（动效与按钮一致，不硬切）');
  chk(/id="mnNav"/.test(wxml), 'mine 的 nav-bar 挂了 id（selectComponent 要靠它拿实例）');
  chk(/selectComponent\('#mnNav'\)/.test(js), 'mine 用 selectComponent 拿 nav-bar 实例');
  chk(/data-k="\{\{item\.key\}\}"/.test(wxml), '三态选项带 data-k');
  // 总开关闭合时整卡不渲染（与 nav-bar 按钮同一开关，不能只藏一处）
  chk(/<view wx:if="\{\{themeEnabled\}\}" class="card mn-card st-item st-4">/.test(wxml),
    '外观卡 wx:if="{{themeEnabled}}" 受同一开关控制（开关关闭时不渲染）');
  chk(/themeEnabled:\s*config\.DARK_MODE_ENABLED/.test(js),
    'mine 的 themeEnabled 取 config.DARK_MODE_ENABLED（与 nav-bar 同源）');
  chk(/themeMode\s*===\s*item\.key/.test(wxml), '选中态按 themeMode === item.key 判定');
  // 新写的样式必须走令牌
  chk(/\.appear-radio\.on\s*\{[^}]*var\(--brand\)/.test(wxss), '外观卡的选中态走 var(--brand)');
  chk(/\.appear-t\s*\{[^}]*var\(--text-1\)/.test(wxss), '外观卡标题走 var(--text-1)');
  // 白名单：脏 dataset 不得把主题设成非法值
  chk(/key\s*!==\s*'system'\s*&&\s*key\s*!==\s*'light'\s*&&\s*key\s*!==\s*'dark'/.test(js),
    'onThemePick 对 dataset.key 做了白名单校验');
}

/* ============================================================
 * ⑧ 变异自证（全部在内存副本上做，绝不写盘）
 * ============================================================ */
console.log('\n── ⑧ 变异自证（内存副本，不落盘）');
{
  // 判据一：令牌集合对齐
  const missInDark = darkBody.replace(/--brand\s*:[^;]+;/, '');
  const D2 = tokensOf(missInDark);
  const L2 = tokensOf(lightBody);
  const gap = L2.filter((t) => D2.indexOf(t) < 0);
  chk(gap.length > 0, '变异 1：.t-dark 删掉一个令牌 → 集合比对报出缺口（' + gap.join(' / ') + '）');

  // 判据二：降级兜底的 .t-dark 覆盖
  const noDarkFallback = appWxss.replace(/\.t-dark \.card,\s*\.t-dark \.card-bordered\s*\{[^}]*\}/g, '');
  const p2 = auditFallback(noDarkFallback);
  chk(p2.length > 0, '变异 2：抽掉降级块的 .t-dark 覆盖 → 被抓住（' + (p2[0] || '').slice(0, 40) + '…）');
  chk(auditFallback(appWxss).length === 0, '好样本：源码原样无问题（不误报）');

  // 判据三：nav-bar bg 默认值写死（复用 ⑤ 的判据，不重写一遍 —— 两处判据写法不同就会「一处红一处绿」）
  // ⚠️ 锚点必须允许属性对象后面那个**尾逗号**（`value: '…' },`），漏了它就匹配不上 ⇒ 自证变假绿。
  const hardBg = navJs.replace(/bg:\s*\{\s*type:\s*String,\s*value:\s*'var\(--glass-bg-strong\)'\s*,?\s*\}/,
    "bg: { type: String, value: 'rgba(255,255,255,0.5)' },");
  chk(hardBg !== navJs, '变异 3 的锚点命中源码（锚点漂移 ⇒ 这一组自证是假的，先修锚点）');
  const hardProblems = auditNavBar(hardBg);
  chk(hardProblems.length > 0,
    '变异 3：nav-bar 的 bg 写死半透明白 → 被抓住（' + (hardProblems[0] || '') + '）');

  // 判据四：揭示动效换成 scale（几何变形）
  const scaleReveal = navWxml.replace(/clip-path:\s*circle\(\{\{revealR\}\}px at \{\{revealX\}\}px \{\{revealY\}\}px\)/,
    'transform: scale({{revealR}})');
  chk(!/clip-path:\s*circle\(/i.test(scaleReveal), '变异 4：揭示层改用 scale → 被抓住');

  // 判据五：theme.js 的 system 模式不跟系统
  // ⚠️ 必须变异 **onThemeChange 回调里那行赋值**，不能变异 resolve()：
  //    「系统主题变化」这条路径走的是回调（回调里直接给 resolved 赋值，**不经过 resolve()**），
  //    改 resolve() 对这条路径完全没有影响 —— 那样这组自证就是假绿。
  const noFollow = themeSrc.replace(
    /resolved\s*=\s*res\s*&&\s*res\.theme\s*===\s*'dark'\s*\?\s*'dark'\s*:\s*'light';/,
    'resolved = currentMode;');
  chk(noFollow !== themeSrc, '变异 5 的锚点命中源码（锚点漂移 ⇒ 这一组自证是假的，先修锚点）');
  // 🔴 必须显式注入「开关=开」：这条变异验的是「跟随系统」语义，
  //    开关关闭时 resolve() 恒返回 light ⇒ 坏样本与好样本都是 light，自证会变成**假绿**。
  const T2 = loadTheme(noFollow, true);
  T2.setSystem('light');
  T2.mod.init();
  T2.systemChange('dark');
  chk(T2.mod.getResolved() !== 'dark', '变异 5：system 模式不跟系统 → 行为仿真抓到（应为 dark）');
  T2.restore();
  const T3 = loadTheme(themeSrc, true);
  T3.setSystem('light');
  T3.mod.init();
  T3.systemChange('dark');
  chk(T3.mod.getResolved() === 'dark', '好样本：theme.js 原样会跟系统（不误报）');
  T3.restore();

  /* 变异 9：开关关闭时的「锁浅色」守卫被拿掉。
   * 这正是「藏了按钮但手机深色时照样变深色」的成因 —— 必须有一组自证钉住它。 */
  const noLock = themeSrc.replace(
    /if\s*\(!DARK_MODE_ENABLED\)\s*\{\s*resolved\s*=\s*'light';\s*return resolved;\s*\}/, '');
  chk(noLock !== themeSrc, '变异 9 的锚点命中源码（锚点漂移 ⇒ 这一组自证是假的，先修锚点）');
  const T9 = loadTheme(noLock, false);
  T9.setSystem('dark');
  T9.store.theme_mode = undefined;
  T9.mod.init();
  chk(T9.mod.getResolved() === 'dark', '变异 9：resolve() 去掉开关守卫 → 关闭态仍解析出 dark（被抓到）');
  T9.restore();

  /* 变异 9b：onThemeChange 回调里的开关守卫被拿掉。
   * 系统主题变化这条路径**不经过 resolve()**，守卫漏在这里同样会翻深色。 */
  const noCbLock = themeSrc.replace(
    /if\s*\(!DARK_MODE_ENABLED\)\s*return;\s*\n(\s*)\/\/ 仅「跟随系统」时才随系统翻转/, '$1// 仅「跟随系统」时才随系统翻转');
  chk(noCbLock !== themeSrc, '变异 9b 的锚点命中源码（锚点漂移 ⇒ 这一组自证是假的，先修锚点）');
  const T9b = loadTheme(noCbLock, false);
  T9b.setSystem('dark');
  T9b.store.theme_mode = undefined;
  T9b.mod.init();
  T9b.systemChange('dark');
  chk(T9b.mod.getResolved() === 'dark', '变异 9b：回调里的开关守卫被拿掉 → 系统切深色时仍会翻（被抓到）');
  T9b.restore();
  // 好样本：源码原样在关闭态下必须锁住浅色（不误报）
  const T9c = loadTheme(themeSrc, false);
  T9c.setSystem('dark');
  T9c.store.theme_mode = undefined;
  T9c.mod.init();
  T9c.systemChange('dark');
  T9c.mod.setMode('dark');
  chk(T9c.mod.getResolved() === 'light', '好样本：源码原样在关闭态锁住浅色（不误报）');
  T9c.restore();

  // 判据六：页面漏挂 tClass
  const mineWxml = read('miniprogram/pages/mine/index.wxml');
  const rootCls = rootClassOf(mineWxml);
  chk(!!rootCls && rootCls.indexOf('{{tClass}}') >= 0, '好样本：mine 根节点确实挂了 {{tClass}}');
  const dropped = mineWxml.replace(' {{tClass}}', '');
  const rc2 = rootClassOf(dropped);
  chk(rc2 && rc2.indexOf('{{tClass}}') < 0, '变异 6：拿掉 {{tClass}} → 根节点判据报缺失');

  // 判据七：揭示层 z-index 低于某个浮层（此时遮罩只盖页面、弹层浮在上面不变色）
  const lowZ = navWxss.replace(/(\.theme-reveal\s*\{[^}]*z-index:\s*)\d+/, '$1700');
  chk(lowZ !== navWxss, '变异 7 的锚点命中源码（锚点漂移 ⇒ 这一组自证是假的，先修锚点）');
  chk(revealZCovers(navWxss) && !revealZCovers(lowZ),
    '变异 7：揭示层 z-index 压到全仓最高浮层之下 → 被抓住');
  chk(revealZCovers(navWxss), '好样本：源码原样盖得住所有浮层（不误报）');

  // 判据八：遮罩色与 app.wxss 的底色脱钩（改了背景色它不跟着变 ⇒ 揭开时闪色差）
  const maskRe = /nextTheme\s*===\s*'dark'\s*\?\s*'(#[0-9a-fA-F]{3,8})'\s*:\s*'(#[0-9a-fa-fA-F]{3,8})'/;
  const drift = navJs.replace(maskRe, (m, d) => m.replace(d, '#123456'));
  chk(drift !== navJs, '变异 8 的锚点命中源码（锚点漂移 ⇒ 这一组自证是假的，先修锚点）');
  chk(!auditMaskColor(drift, darkBody, appWxss),
    '变异 8：遮罩深色色值与 --bg-page 脱钩 → 被抓住');
}

/* ============================================================
 * ⑨ 反向清单：不该出现的写法
 * ============================================================ */
console.log('\n── ⑨ 反向清单');
{
  // 主题 class 不能挂在 page 上（WXSS 的 page 不能选 class ⇒ 永不命中）
  chk(!/class="[^"]*\bpage\b[^"]*\bt-light\b/.test(appWxmlSafe('miniprogram/pages/mine/index.wxml')),
    '没有把 t-light/t-dark 写到 page 元素上（WXSS 选不中，等于没写）');
  chk(!/^\s*page\.t-(light|dark)/m.test(appWxss), 'app.wxss 没有 page.t-light / page.t-dark 选择器（page 不能选 class）');
  // 不许用 media (prefers-color-scheme) 做主方案：它跟 wx.onThemeChange 不是一回事，
  // 且小程序 webview 里对它的支持不稳；主方案必须是 JS 算出的 class。
  chk(!/prefers-color-scheme/.test(appWxss), 'app.wxss 不用 prefers-color-scheme 做主方案（以 JS 算出的 class 为准）');
}
function appWxmlSafe(p) { return stripComments(read(p)); }

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 深色模式体检全部通过'));
process.exit(failed ? 1 : 0);