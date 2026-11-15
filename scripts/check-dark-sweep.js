#!/usr/bin/env node
/**
 * 离线自检：深色模式「全量适配」+ 班级名简称（2026-11-15）
 * --------------------------------------------------------------------------------
 * 用户口径：①「班级管理下面两个按钮在深色模式还是浅色；**检查整个小程序，还有哪个地方
 *            是深色模式没有适配的，全部完成适配**」；② 班级名简称规则。
 *
 * ① 的难点是「全部」—— 人工扫一遍会漏，而且每次加页面又会漏。
 *    这里把「本轮实际漏掉的三类写法」钉成反向断言，以后谁再写就当场判红：
 *      a. `background: rgba(255, 255, 255, 0.5x)` —— 半透明白软面板（classes/bind/doc 共 8 处）；
 *      b. `background: #F7F8FA / #F2F3F5 / #F5F6F8 / #FFFFFF` —— 写死浅底
 *         （app.wxss 的 `.np-*` 公共皮肤、`.np-panel` 都栽在这）；
 *      c. `color: #1D2129 / #4E5969 / #86909C` —— 写死深色文字（深色下黑字压深底）。
 *    `app.wxss` 的 `.t-light` / `.t-dark` / `page{}` 是**令牌定义本身**，天然要写这些值，
 *    所以对 app.wxss 只查 ①c 的 `.np-*` 段落之外的写法 —— 实现上直接查全文件但不豁免，
 *    因为定义处写的是 `--token: #xxx`（以 `--` 开头），不匹配 `background:` / `color:`。
 *
 * ② 简称规则直接 **vm 真跑** util.shortClassLabel，用例即用户原话里的四个例子。
 *
 * 用法：node scripts/check-dark-sweep.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

function stripCss(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

function walk(dir, ext, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, ext, out); }
    else if (e.name.endsWith(ext)) out.push(p);
  });
  return out;
}

/* ============================================================
 * 一、深色适配：三类「写死浅色」反向断言
 * ============================================================ */
const RULES = [
  {
    id: 'softWhite',
    /* 半透明白色软面板。⚠️ 只认「冒号后直接就是 rgba」的写法：
       `var(--sheet-bg, rgba(255,255,255,.72))` 这种**令牌兜底**是正当写法（深色由令牌换值），
       第一版把兜底也算进来 ⇒ 13 个文件全被判红、全是误报。
       阈值 ≥0.5：hero 上那种 0.20 的胶囊在深色下也成立，不拦。 */
    re: /background(?:-color)?\s*:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*0?\.(?:[5-9]\d*|5)\s*\)/g,
    msg: '没有写死「半透明白软面板」（深色下会变成一块浅灰板）',
    scope: 'pages'
  },
  {
    id: 'lightBg',
    re: /background(?:-color)?\s*:\s*#(?:F7F8FA|F2F3F5|F5F6F8|FFFFFF|F1F4F9)\b/gi,
    msg: '没有写死浅色背景（一律走 --fill-soft / --bg-card / --bg-fill 等令牌）',
    scope: 'pages'
  },
  {
    id: 'darkText',
    re: /(?<![\w-])color\s*:\s*#(?:1D2129|4E5969|86909C)\b/gi,
    msg: '没有写死深色文字（一律走 --text-1 / --text-2 / --text-3）',
    scope: 'all'
  }
];

/**
 * 允许名单：写法**本身正确**、不是漏适配。
 * ⚠️ 加条目必须写清「为什么这里是对的」，否则下次有人照抄就没人看得懂了。
 */
const ALLOW = {
  // 课表左下角视图菜单是「玻璃叠玻璃」：本色 .5 / .62 + @supports 兜底 .93 / .95，
  // 深色由**页面级** `.t-dark .fab-menu-btn` / `.t-dark .fab-menu-item` 覆盖（页面作用域，命中）。
  softWhite: ['miniprogram/pages/timetable/index.wxss']
};

/* app.wxss 是令牌与浅色兜底的**真源**（`page{}` 极光、`--glass-*` 令牌、@supports 兜底），
   本来就该写浅色值；它的深色份由 `.t-dark` 提供，而 app.wxss 是**页面级**样式表，
   页面级 `.t-dark .xxx` 是能命中的（只有组件 wxss 才跨不过去）。
   所以软色/浅底两条只查 pages/ 与 components/；写死深色文字那条仍然全查（那次 .np-* 就是栽在它上面）。 */
const CSS_FILES = walk(MINI, '.wxss', []);
console.log('── ① 深色适配反向断言（' + CSS_FILES.length + ' 个 wxss）');

/** 纯函数：返回违规列表；变异自证复用同一份判据 */
function scanLight(files) {
  const out = [];
  files.forEach((f) => {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    const body = stripCss(fs.readFileSync(f, 'utf8'));
    const isApp = /miniprogram\/app\.wxss$/.test(rel);
    RULES.forEach((r) => {
      if (r.scope === 'pages' && isApp) return;
      if ((ALLOW[r.id] || []).indexOf(rel) >= 0) return;
      r.re.lastIndex = 0;
      const m = body.match(r.re);
      if (m) out.push({ file: rel, rule: r.id, hit: m.slice(0, 3) });
    });
  });
  return out;
}

const BAD = scanLight(CSS_FILES);
BAD.forEach((b) => console.log('    · [' + b.rule + '] ' + b.file + '  →  ' + b.hit.join(' , ')));
RULES.forEach((r) => {
  const n = BAD.filter((b) => b.rule === r.id).length;
  check(n === 0, r.msg + (n ? '（' + n + ' 个文件违规）' : ''));
});

/* ============================================================
 * 二、状态色必须走令牌（JS 里写死 hex 会让内联 style 在深色下永远是浅底）
 * ============================================================ */
console.log('\n── ② 状态色常量（内联渲染）走主题令牌');
const UTIL = read('miniprogram/utils/util.js');
const MINE = read('miniprogram/pages/mine/index.js');
function blockOf(src, name) {
  const i = src.indexOf('const ' + name + ' = {');
  if (i < 0) return '';
  const s = src.indexOf('{', i);
  let d = 0;
  for (let k = s; k < src.length; k += 1) {
    if (src[k] === '{') d += 1;
    else if (src[k] === '}') { d -= 1; if (!d) return src.slice(s, k + 1); }
  }
  return '';
}
const DUTY = blockOf(UTIL, 'DUTY_STATUS');
const SWAP = blockOf(MINE, 'SWAP_STATUS');
/** 「裸 hex」= 引号紧跟着 #，如 `bg: '#F2F3F5'`；`var(--x, #F2F3F5)` 里的 hex 是兜底，不算 */
const BARE_HEX = /['"](?:#[0-9A-Fa-f]{3,8})['"]/;
check(!!DUTY && !BARE_HEX.test(DUTY), 'DUTY_STATUS 的色值全是 var(--token)（无裸 hex）');
check(!!SWAP && !BARE_HEX.test(SWAP), 'SWAP_STATUS 的色值全是 var(--token)（无裸 hex）');
check(/color:\s*'var\(--text-3/.test(DUTY) && /bg:\s*'var\(--bg-fill/.test(DUTY),
  'DUTY_STATUS 的「待值日 / 已结束」用 --text-3 + --bg-fill');

/* ============================================================
 * 三、班级名简称（vm 真跑真实源码，不抄副本）
 * ============================================================ */
console.log('\n── ③ 班级名简称 shortClassLabel（真跑 util.js）');
const vm = require('vm');
const utilSrc = read('miniprogram/utils/util.js');
const sandbox = {
  module: { exports: {} },
  require: () => ({}),
  console,
  wx: { getStorageSync: () => null, setStorageSync: () => {}, getSystemInfoSync: () => ({}) },
  getApp: () => ({}),
  getCurrentPages: () => [],
  Date, Math, Number, String, Object, Array, JSON, RegExp, isFinite, parseInt, parseFloat
};
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
try {
  vm.runInContext(utilSrc, sandbox, { filename: 'utils/util.js' });
} catch (e) {
  console.log('    （vm 加载失败：' + e.message + ' —— 判据退化为静态检查）');
}
const shortFn = sandbox.module.exports && sandbox.module.exports.shortClassLabel;

const CASES = [
  ['示例专业B1班', '示例班级C'],
  ['小学教育（本）示例班级C', '小教（本）示例班级C'],
  ['小学教育（本科）示例班级C', '小教（本）示例班级C'],
  ['小学教育本科示例班级C', '小教（本）示例班级C'],
  ['' , '']
];
if (typeof shortFn === 'function') {
  CASES.forEach(([input, want]) => {
    const got = shortFn(input);
    check(got === want, '「' + input + '」→「' + got + '」' + (got === want ? '' : '（应为「' + want + '」）'));
  });
} else {
  check(false, 'util.shortClassLabel 没导出（vm 里拿不到）—— 页面调用会拿到 undefined');
}
check(/shortClassLabel/.test(utilSrc.slice(utilSrc.indexOf('module.exports'))),
  'shortClassLabel 已同步进 module.exports');
check(/shortClassLabel\(x\.className\)/.test(read('miniprogram/pages/home/index.js')),
  '首页关注的学生用 shortClassLabel 算简称');
check(/\{\{item\.clsShort \|\| item\.className\}\}/.test(read('miniprogram/pages/home/index.wxml')),
  'wxml 优先显示 clsShort，取不到才回落全名');

/* ============================================================
 * 四、原生窗口底色：页面 json 不许写死 backgroundColor
 *    那一层是 webview 背后的原生底，CSS 改不到；写死 #F5F6F8 后
 *    「系统深色 + 切页」仍会闪一条浅色（app.json 的 @backgroundColor 被页面级覆盖）。
 * ============================================================ */
console.log('\n── ④ 原生窗口底色跟随主题（页面 json 不写死 backgroundColor）');
const appJson = read('miniprogram/app.json');
const themeJson = read('miniprogram/theme.json');
const pageJsons = walk(path.join(MINI, 'pages'), '.json', []);
const hardBgc = pageJsons.filter((f) => /"backgroundColor"\s*:/.test(fs.readFileSync(f, 'utf8')));
hardBgc.forEach((f) => console.log('    · ' + path.relative(ROOT, f).replace(/\\/g, '/')));
check(hardBgc.length === 0, '没有页面 json 写死 backgroundColor（共 ' + pageJsons.length + ' 个页面 json）');
check(/"darkmode"\s*:\s*true/.test(appJson) && /"themeLocation"/.test(appJson), 'app.json 开了 darkmode + themeLocation');
check(/"backgroundColor"\s*:\s*"@backgroundColor"/.test(appJson), 'app.window 的 backgroundColor 走 @backgroundColor 变量');
check(/"dark"[\s\S]{0,200}"backgroundColor"\s*:/.test(themeJson), 'theme.json 的 dark 段定义了 backgroundColor');

console.log('\n── ⑤ 变异自证（改坏 → 判据必须翻红）');
const TMP = path.join(ROOT, '.wb_mut');
fs.mkdirSync(TMP, { recursive: true });
const MUT = [
  { name: '页面又写回半透明白软面板', rule: 'softWhite',
    css: '.x { background: rgba(255, 255, 255, 0.55); }' },
  { name: '页面又写回浅色底', rule: 'lightBg',
    css: '.x { background: #F7F8FA; }' },
  { name: '页面又写回深色文字', rule: 'darkText',
    css: '.x { color: #1D2129; }' }
];
MUT.forEach((m) => {
  const f = path.join(TMP, 'mut.wxss');
  fs.writeFileSync(f, m.css);
  const hit = scanLight([f]).some((b) => b.rule === m.rule);
  check(hit, '变异被抓：' + m.name);
});
fs.writeFileSync(path.join(TMP, 'ok.wxss'), '.x { background: var(--fill-soft, #F7F8FA); color: var(--text-1); }');
check(scanLight([path.join(TMP, 'ok.wxss')]).length === 0, '好样本不误报：var() 兜底写法放行');
fs.unlinkSync(path.join(TMP, 'mut.wxss'));
fs.unlinkSync(path.join(TMP, 'ok.wxss'));
fs.rmdirSync(TMP);

/* 简称函数的变异：把专业简称表改坏 → 用例必须翻红。
   ⚠️ 别用「删掉 .replace(/专升本/g,'')」当变异 —— 括号那条替换(`[（(]专升本[）)]`) 仍然吃掉
   本例的「（专升本）」，结果照样是「示例班级C」⇒ 变异不生效、断言假失败（第一版就是这么写的）。 */
if (typeof shortFn === 'function') {
  const broken = utilSrc.replace("['小学教育', '小教']", "['小学教育', '小学教育']");
  const box2 = Object.assign({}, sandbox, { module: { exports: {} } });
  box2.exports = box2.module.exports;
  vm.createContext(box2);
  try { vm.runInContext(broken, box2, { filename: 'util-broken.js' }); } catch (e) { /* ignore */ }
  const f2 = box2.module.exports && box2.module.exports.shortClassLabel;
  const got = typeof f2 === 'function' ? f2('示例专业B1班') : null;
  check(got !== '示例班级C', '变异被抓：去掉「小学教育→小教」映射 → 简称不再被缩写（实测 ' + got + '）');
}

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 深色全量适配 / 班名简称检查全部通过'));
process.exit(failed ? 1 : 0);
