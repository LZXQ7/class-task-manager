/**
 * 门禁：深色模式首帧 / 状态栏白块 / detents 崩溃（1.0.8.32）
 * ============================================================
 * 三个真机问题，一个共同点：都是「默认态/首帧」没配对。
 *   ① 无缓存冷启动切新页面先浅后深 —— tClass 靠 onLoad 的异步 setData 才挂上；
 *      修法：每个页面 data 初始值同步写 tClass: theme.rootClass() + app.wxss 深色媒体兜底。
 *   ② 深色模式状态栏一整条银白渐变 —— .nav-edge 的白色 background 没被关掉；
 *      修法（2026-11-15 收口）：改由 **令牌** `--nav-edge-fill: none` 关闭
 *      （`.t-dark .nav-edge` 这种组件内后代选择器跨组件边界不命中，之前那版等于没修）。
 *      浅色段的 104rpx 锚点必须保留。
 *   ③ 拖拽松手报 ds.forEach is not a function —— detents 默认值写成 () => []，
 *      基础库把函数当值；修法：value: [] + 四处 Array.isArray 守卫。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(ok, name) {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) failed++;
}
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); }

const F = {
  themeJs: 'miniprogram/utils/theme.js',
  appWxss: 'miniprogram/app.wxss',
  navWxss: 'miniprogram/components/nav-bar/index.wxss',
  bsJs: 'miniprogram/components/bottom-sheet/index.js'
};
const SRC = {};
Object.keys(F).forEach(k => { SRC[k] = read(F[k]); });

/* 所有挂了主题 mount 的页面（排除 utils/theme.js 自身的文档注释） */
function mountedPages() {
  const out = [];
  function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(e => {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js') && /theme\.mount\(this\)/.test(read(rel))) out.push(rel);
    });
  }
  walk('miniprogram/pages');
  const tab = 'miniprogram/custom-tab-bar/index.js';
  if (/theme\.mount\(this\)/.test(read(tab))) out.push(tab);
  return out;
}
const PAGES = mountedPages();
const PAGE_SRC = {};
PAGES.forEach(p => { PAGE_SRC[p] = read(p); });

function statics(s, pages) {
  const tj = strip(s.themeJs), aw = strip(s.appWxss);
  const nw = strip(s.navWxss), bj = strip(s.bsJs);
  const missing = Object.keys(pages).filter(p => !/tClass:\s*theme\.rootClass\(\)/.test(pages[p]));
  return {
    // ① 首帧主题
    allPagesSynced: Object.keys(pages).length >= 15 && missing.length === 0,
    missing,
    rootClassInit: /function rootClass\(\)\s*\{[\s\S]{0,400}?if \(!inited\)/.test(tj),
    rootClassExport: /module\.exports[\s\S]*rootClass/.test(tj),
    noMediaTheme: !/@media \(prefers-color-scheme/.test(aw),
    lightFallbackKept: /background-color:\s*#F1F4F9;/.test(aw),
    // ② 状态栏白块：必须走**主题令牌**（组件内的 `.t-dark .nav-edge` 跨组件不命中，
    //    2026-11-15 实测：那条 104rpx 银白渐变因此一直没被关掉）
    darkEdgeNoGradient: /--nav-edge-fill:\s*none;/.test(aw)
      && /background:\s*var\(--nav-edge-fill/.test(nw)
      && !/\.t-dark \.nav-edge/.test(nw),
    edgeAnchorKept: /104rpx\)/.test(nw) && /linear-gradient\(180deg/.test(nw),
    // ③ detents 崩溃
    detentsLiteral: /detents:\s*\{\s*type:\s*Array,\s*value:\s*\[\s*\]\s*\}/.test(bj),
    detentsNoFactory: !/detents:\s*\{\s*type:\s*Array,\s*value:\s*\(\)\s*=>/.test(bj),
    guardCount: (bj.match(/Array\.isArray\(this\.properties\.detents\)/g) || []).length >= 4
  };
}

const S = statics(SRC, PAGE_SRC);
console.log('=== 1.0.8.32 深色首帧 / 状态栏白块 / detents 门禁 ===');
console.log('\n── ① 首帧主题（' + Object.keys(PAGE_SRC).length + ' 个页面）');
check(S.allPagesSynced, '所有挂 theme.mount 的页面 data 初始值都同步注入 tClass'
  + (S.missing.length ? '（漏：' + S.missing.join(', ') + '）' : ''));
check(S.rootClassInit && S.rootClassExport, 'rootClass 自己兜底 init()，早于 app.onLaunch 也不会算错');
check(S.noMediaTheme && S.lightFallbackKept, '主题只由 JS class 决定（不用 prefers-color-scheme 主方案），浅色 page{} 兜底仍在');

console.log('\n── ② 状态栏白块');
check(S.darkEdgeNoGradient, '深色靠令牌关掉 .nav-edge 白色渐变（不许再写 .t-dark .nav-edge 那种跨组件不命中的选择器）');
check(S.edgeAnchorKept, '浅色 .nav-edge 的 104rpx 渐变锚点仍在（check-nav-glass 变异自证依赖）');

console.log('\n── ③ detents 崩溃');
check(S.detentsLiteral && S.detentsNoFactory, 'detents 默认值是字面空数组，不是工厂函数');
check(S.guardCount, '四处读取都有 Array.isArray 守卫（_restYs / _autoDetent / onHeadEnd / 初始档）');

/* ---------- 变异自证 ---------- */
const MUT = [
  { name: '某个页面漏掉同步 tClass', file: 'homePage', probe: 'allPagesSynced',
    from: '    tClass: theme.rootClass(),\n', to: '' },
  { name: 'rootClass 不兜底 init（模块早加载会算成浅色）', file: 'themeJs', probe: 'rootClassInit',
    from: "  if (!inited) { try { init(); } catch (e) { /* ignore */ } }\n", to: '' },
  { name: '又把 prefers-color-scheme 媒体查询放回来（主题双真源）', file: 'appWxss', probe: 'noMediaTheme',
    from: '  -webkit-font-smoothing: antialiased;\n}',
    to: '  -webkit-font-smoothing: antialiased;\n}\n@media (prefers-color-scheme: dark) { page { background: #0B0E13; } }' },
  { name: '深色 --nav-edge-fill 令牌又把白渐变放回来', file: 'appWxss', probe: 'darkEdgeNoGradient',
    from: '  --nav-edge-fill: none;',
    to: '  --nav-edge-fill: linear-gradient(180deg, rgba(255, 255, 255, 0.9) 0rpx, rgba(255, 255, 255, 0) 104rpx);' },
  { name: 'nav-edge 不走令牌、写死浅色渐变（深色又露白条）', file: 'navWxss', probe: 'darkEdgeNoGradient',
    from: 'background: var(--nav-edge-fill, linear-gradient(180deg,',
    to: 'background: linear-gradient(180deg,' },
  { name: 'detents 改回工厂函数（真机 ds.forEach 崩溃）', file: 'bsJs', probe: 'detentsLiteral',
    from: 'detents: { type: Array, value: [] },', to: 'detents: { type: Array, value: () => [] },' },
  { name: '删掉全部 Array.isArray 守卫', file: 'bsJs', probe: 'guardCount',
    from: 'Array.isArray(this.properties.detents)', to: 'this.properties.detents' }
];

console.log('\n── ④ 变异自证（改坏 → 探针必须翻红）');
const HOME = 'miniprogram/pages/home/index.js';
MUT.forEach(mu => {
  let next;
  if (mu.file === 'homePage') {
    const before = PAGE_SRC[HOME];
    if (!before.includes(mu.from)) { console.log('  FAIL  变异「' + mu.name + '」锚点没命中'); failed++; return; }
    next = { s: Object.assign({}, SRC), p: Object.assign({}, PAGE_SRC, { [HOME]: before.replace(mu.from, mu.to) }) };
  } else {
    const before = SRC[mu.file];
    if (!before.includes(mu.from)) { console.log('  FAIL  变异「' + mu.name + '」锚点没命中'); failed++; return; }
    next = { s: Object.assign({}, SRC, { [mu.file]: before.replace(mu.from, mu.to) }), p: PAGE_SRC };
  }
  check(statics(next.s, next.p)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '❌ ' + failed + ' 项不通过' : '✅ 深色首帧 / 状态栏白块 / detents 检查全部通过'));
process.exit(failed ? 1 : 0);
