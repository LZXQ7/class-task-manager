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
  },
  {
    /* 渐变里的浅色色标（骨架屏流光就是栽在这：`linear-gradient(90deg,#F2F3F5,…)`）。
       渐变不吃 `background` 的令牌，必须给色标单独定义变量。 */
    id: 'lightGradient',
    re: /background(?:-image)?\s*:[^;{}]*linear-gradient\([^;{}]*#(?:F2F3F5|F5F6F8|FFFFFF|E5E6EB|DCE8FF|EAF1FF|F3F0FF)/gi,
    msg: '渐变里没有写死浅色色标（走 --sk-base / --sk-shine 之类的令牌）',
    scope: 'pages',
    /* ⚠️ 先把 `var(--x, #fff)` 整段抹掉再匹配：兜底里的浅色是**正当**写法
       （第一版没抹，`var(--sk-base, #F2F3F5)` 直接被判红 —— 又是一次误报）。 */
    prep: (body) => body.replace(/var\([^)]*\)/g, '')
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
      const text = r.prep ? r.prep(body) : body;
      r.re.lastIndex = 0;
      const m = text.match(r.re);
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
 * 四、引用不到的 CSS 变量（1.0.8.44 班费页整页发白的根因）
 *    `background: var(--bg)` 而 `--bg` 从未定义 ⇒ 计算值阶段失效 ⇒ 等价 unset
 *    ⇒ 连 `.t-dark` 画在根节点上的暗色极光都被抹掉，只剩 `page{}` 的浅色极光。
 *    有兜底的（`var(--x, #fff)`）不致命，但兜底是浅色值 ⇒ 深色下永远是浅色，同样要报。
 * ============================================================ */
console.log('\n── ④ 引用的 CSS 变量必须真的定义过');
const TOKEN_SRC = stripCss(read('miniprogram/app.wxss'));
const DEFINED = new Set();
(TOKEN_SRC.match(/--[a-z0-9-]+\s*:/g) || []).forEach((m) => DEFINED.add(m.replace(/\s*:$/, '').trim()));
/** 由 JS / wxml 内联下发的变量，本来就不该在 app.wxss 里定义 */
const RUNTIME_VARS = new Set(['--dx', '--dy', '--p']);
/** 兜底本身就是主题令牌（`var(--line-soft, var(--fill-soft))`）或语义上两主题通用的 */
const SAFE_FALLBACK = { '--on-brand-fg': '品牌色面上的白字，两个主题都该是白', '--line-soft': '兜底是 var(--fill-soft)' };

function scanVars(files) {
  const fatal = [];
  const soft = [];
  (files || CSS_FILES).forEach((f) => {
    const body = stripCss(fs.readFileSync(f, 'utf8'));
    const re = /var\(\s*(--[a-z0-9-]+)\s*(,)?/g;
    let m;
    while ((m = re.exec(body))) {
      const name = m[1];
      if (DEFINED.has(name) || RUNTIME_VARS.has(name) || SAFE_FALLBACK[name]) continue;
      const item = path.relative(ROOT, f).replace(/\\/g, '/') + '  ' + name;
      if (m[2]) soft.push(item); else fatal.push(item);
    }
  });
  return { fatal: [...new Set(fatal)], soft: [...new Set(soft)] };
}
const VARS = scanVars();
VARS.fatal.forEach((x) => console.log('    · [无兜底] ' + x));
VARS.soft.forEach((x) => console.log('    · [只有浅色兜底] ' + x));
check(VARS.fatal.length === 0, '没有引用未定义且无兜底的变量（这类声明会整条失效，把主题底色打掉）');
check(VARS.soft.length === 0, '没有引用未定义的变量（只靠浅色兜底 ⇒ 深色下永远是浅色）');

/* ============================================================
 * 五、页面根节点不许自己写 background（会盖掉主题极光）
 *    `.page.fee-page`(0-2-0) 权重高于 `.t-dark`(0-1-0)，写了就盖；
 *    即使是 `var(--bg-page)` 这种合法值，`background` 简写也会把 background-image 重置。
 * ============================================================ */
console.log('\n── ⑤ 页面根节点不写 background（底色真源只有 .t-light / .t-dark）');
function scanRootBg(files) {
  const out = [];
  (files || walk(path.join(MINI, 'pages'), '.wxss', [])).forEach((f) => {
    const body = stripCss(fs.readFileSync(f, 'utf8'));
    const re = /^\.page(?:\.[\w-]+)?\s*\{[^}]*?background[^}]*?\}/gm;
    const m = body.match(re);
    if (m) out.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), hit: m[0].replace(/\s+/g, ' ').slice(0, 90) });
  });
  return out;
}
const ROOT_BG = scanRootBg();
ROOT_BG.forEach((b) => console.log('    · ' + b.file + '  →  ' + b.hit));
check(ROOT_BG.length === 0, '没有页面在根节点上写背景');

/* ============================================================
 * 六、`data` 里不许有重复的 tClass 键
 *    对象字面量后者覆盖前者 ⇒ 写成 `tClass: theme.rootClass(), tClass: ''`
 *    等于首帧没有主题（浅色）。check-dark-first-frame 只匹配前者，一直没发现。
 * ============================================================ */
console.log('\n── ⑥ data 里没有重复的 tClass 键');
function scanDupTClass(files) {
  const out = [];
  const list = files || walk(path.join(MINI, 'pages'), '.js', []).concat([path.join(MINI, 'custom-tab-bar/index.js')]);
  list.forEach((f) => {
    const s = stripCssless(fs.readFileSync(f, 'utf8'));
    const m = s.match(/^\s*tClass:/gm);
    if (m && m.length > 1) out.push(path.relative(ROOT, f).replace(/\\/g, '/') + '  ×' + m.length);
  });
  return out;
}
/** 只去块注释，保留行结构（不能用 stripCss —— 它会把注释里的文本一并吃掉，行号也乱） */
function stripCssless(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
const DUP = scanDupTClass();
DUP.forEach((x) => console.log('    · ' + x));
check(DUP.length === 0, '每个页面的 data 里只有一个 tClass 键');

console.log('\n── ⑦ 原生窗口底色跟随主题（页面 json 不写死 backgroundColor）');
const appJson = read('miniprogram/app.json');
const themeJson = read('miniprogram/theme.json');
const pageJsons = walk(path.join(MINI, 'pages'), '.json', []);
const hardBgc = pageJsons.filter((f) => /"backgroundColor"\s*:/.test(fs.readFileSync(f, 'utf8')));
hardBgc.forEach((f) => console.log('    · ' + path.relative(ROOT, f).replace(/\\/g, '/')));
check(hardBgc.length === 0, '没有页面 json 写死 backgroundColor（共 ' + pageJsons.length + ' 个页面 json）');
check(/"darkmode"\s*:\s*true/.test(appJson) && /"themeLocation"/.test(appJson), 'app.json 开了 darkmode + themeLocation');
check(/"backgroundColor"\s*:\s*"@backgroundColor"/.test(appJson), 'app.window 的 backgroundColor 走 @backgroundColor 变量');
check(/"dark"[\s\S]{0,200}"backgroundColor"\s*:/.test(themeJson), 'theme.json 的 dark 段定义了 backgroundColor');

console.log('\n── ⑧ 变异自证（改坏 → 判据必须翻红）');
const TMP = path.join(ROOT, '.wb_mut');
fs.mkdirSync(TMP, { recursive: true });
const MUT = [
  { name: '页面又写回半透明白软面板', rule: 'softWhite',
    css: '.x { background: rgba(255, 255, 255, 0.55); }' },
  { name: '页面又写回浅色底', rule: 'lightBg',
    css: '.x { background: #F7F8FA; }' },
  { name: '页面又写回深色文字', rule: 'darkText',
    css: '.x { color: #1D2129; }' },
  { name: '骨架屏流光又写死浅灰渐变', rule: 'lightGradient',
    css: '.x { background-image: linear-gradient(90deg, #F2F3F5 25%, #E5E6EB 37%); }' }
];
MUT.forEach((m) => {
  const f = path.join(TMP, 'mut.wxss');
  fs.writeFileSync(f, m.css);
  const hit = scanLight([f]).some((b) => b.rule === m.rule);
  check(hit, '变异被抓：' + m.name);
});
fs.writeFileSync(path.join(TMP, 'ok.wxss'), '.x { background: var(--fill-soft, #F7F8FA); color: var(--text-1); }');
check(scanLight([path.join(TMP, 'ok.wxss')]).length === 0, '好样本不误报：var() 兜底写法放行');

/* ④⑤⑥ 三条新判据各配一条变异（否则等于没守） */
fs.writeFileSync(path.join(TMP, 'v1.wxss'), '.page.fee-page { background: var(--nope); }');
check(scanVars([path.join(TMP, 'v1.wxss')]).fatal.length > 0, '变异被抓：引用不存在的变量（无兜底）→ 整条声明失效');
fs.writeFileSync(path.join(TMP, 'v2.wxss'), '.x { color: var(--nope2, #FFFFFF); }');
check(scanVars([path.join(TMP, 'v2.wxss')]).soft.length > 0, '变异被抓：引用不存在的变量（只靠浅色兜底）');
fs.writeFileSync(path.join(TMP, 'v3.wxss'), '.page.fee-page { background: var(--bg-page); }');
check(scanRootBg([path.join(TMP, 'v3.wxss')]).length > 0, '变异被抓：页面根节点又写 background（盖掉主题极光）');
fs.writeFileSync(path.join(TMP, 'v4.js'), 'Page({ data: {\n  tClass: theme.rootClass(),\n  tClass: \'\',\n} });');
check(scanDupTClass([path.join(TMP, 'v4.js')]).length > 0, '变异被抓：data 里又出现两个 tClass 键');
['v1.wxss', 'v2.wxss', 'v3.wxss', 'v4.js', 'mut.wxss', 'ok.wxss'].forEach((n) => {
  const f = path.join(TMP, n);
  if (fs.existsSync(f)) fs.unlinkSync(f);
});
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
