/**
 * 门禁：弹层滚动穿透（页面滚动锁）
 * ------------------------------------------------------------
 * 背景（2026-09-26，v0.7.9 需求③）：
 *   「在『添加值日』里把选人列表滑到最下面，后面的页面会跟着一起滑。」
 *   这个坑在本项目已经修过多次（最常见的是 pages/duty），每次只修报的那一页，
 *   下一批新页面又漏 —— 所以这一版把它变成**结构性门禁**：
 *
 * 原理：
 *   bottom-sheet / duty-sheet 的面板里是 <scroll-view>，列表滑到下沿后，
 *   touchmove 会继续冒泡给 page（面板不能挂 catchtouchmove，否则会把列表的滑动一起吞掉）。
 *   页面级滚动必须由 <page-meta page-style="overflow:hidden"> 锁住。
 *   （dialog 不需要：它的根节点 .dlg-root 自带 catchtouchmove，且内部没有滚动区。）
 *
 * 校验规则（任一不满足即失败）：
 *   A. 页面若含 bottom-sheet / duty-sheet → 必须有且仅有一个 <page-meta>，
 *      且它出现在第一个 <view> 之前（page-meta 必须是页面第一个节点）。
 *   B. 该 page-meta 的 page-style 必须包含 overflow:hidden。
 *   C. **覆盖性**：每个弹层的 show 标志都必须出现在 page-style 的表达式里。
 *      例：roster 有 {{mDetailShow}}/{{addShow}}/{{importShow}}/{{posShow}}，
 *          page-style 里少写任何一个 → 报错。
 *   D. 组件侧兜底：bottom-sheet / duty-sheet 的 body 滚动容器必须能「防滚动穿透」。
 *      两种实现都允许：
 *        - 原生 <scroll-view> 必须 enhanced + bounces="{{false}}"；
 *        - 或 <spring-scroll>（自定义边界阻尼滚动），其组件内部的 viewport 必须有
 *          catchtouchmove 把手势收口在弹层内（duty-sheet 现改用此方案）。
 *      无论哪种，遮罩都必须有 catchtouchmove。
 *
 * 同时带**双向自证**：合成样例证明「漏标志必被抓到」「完整表达式必须放行」，
 * 避免门禁本身写错却永远绿灯。
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'miniprogram');
const PAGES = path.join(R, 'pages');
const COMPONENTS = path.join(R, 'components');

/* 这些组件内部有可滚动的 <scroll-view>，会引发滚动穿透 */
const SCROLL_MODALS = ['bottom-sheet', 'duty-sheet'];

let failed = 0;
function ok(msg) { console.log('  ✓ ' + msg); }
function bad(msg) { failed++; console.log('  ✗ ' + msg); }

/* ---------------- 覆盖性判断（纯函数，便于自证） ---------------- */
/**
 * 去掉 WXML 注释 —— 注释里常常「引用」组件与属性名（本项目里就有
 * 「不能挂 .ds-panel，它们是 <scroll-view> 的祖先」这类说明），
 * 不剥掉会被误当成真实标签，出现假失败。
 */
function stripComments(s) { return String(s || '').replace(/<!--[\s\S]*?-->/g, ''); }

/**
 * @param {string} styleExpr  page-style 的属性值（含 {{ }} 原样）
 * @param {string[]} flags    弹层的 show 标志名
 * @returns {string[]} 缺失的标志
 */
function missingFlags(styleExpr, flags) {
  const expr = String(styleExpr || '');
  const out = [];
  flags.forEach((f) => {
    if (!new RegExp('(^|[^A-Za-z0-9_$])' + f + '([^A-Za-z0-9_$]|$)').test(expr)) out.push(f);
  });
  return out;
}

/** 从 show="{{ ... }}" 的属性值里抽出用到的标识符 */
function flagsOf(attrValue) {
  const inner = String(attrValue || '');
  const ids = inner.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
  return ids.filter(x => x !== 'true' && x !== 'false');
}

/* ---------------- 双向自证 ---------------- */
console.log('── ⓞ 门禁自证（双向）');
(function selfTest() {
  const good = "{{(a || b) ? 'overflow:hidden' : ''}}";
  const bad = "{{a ? 'overflow:hidden' : ''}}";
  const noLock = "{{a ? '' : ''}}";

  if (missingFlags(good, ['a', 'b']).length === 0) ok('完整表达式放行');
  else bad('自证失败：完整表达式被误判为缺标志');

  const m1 = missingFlags(bad, ['a', 'b']);
  if (m1.length === 1 && m1[0] === 'b') ok('漏写的标志被抓到（b）');
  else bad('自证失败：漏写的标志没被抓到 → ' + JSON.stringify(m1));

  if (!/overflow:hidden/.test(noLock)) ok('未含 overflow:hidden 会被规则 B 拦下');
  else bad('自证失败：规则 B 失效');

  // 前缀误判保护：a 不应命中 ab
  if (missingFlags("{{(abFlag) ? 'overflow:hidden' : ''}}", ['abFlag']).length === 0
    && missingFlags("{{(abFlag) ? 'overflow:hidden' : ''}}", ['bFlag']).length === 1) {
    ok('标志名按整词匹配（abFlag 不命中 bFlag）');
  } else bad('自证失败：标志名整词匹配有误');
})();

/* spring-scroll 分支的双向自证：含 catchtouchmove 放行，缺的必被抓 */
(function selfTestSpring() {
  const withCT = '<view class="ss-viewport" catchtouchmove="onMove"><view class="ss-content"></view></view>';
  const noCT = '<view class="ss-viewport" bindtouchmove="onMove"><view class="ss-content"></view></view>';
  if (/catchtouchmove/.test(withCT)) ok('自证：spring-scroll 含 catchtouchmove 放行');
  else bad('自证失败：含 catchtouchmove 被误判');
  if (!/catchtouchmove/.test(noCT)) ok('自证：spring-scroll 缺 catchtouchmove 必被抓');
  else bad('自证失败：缺 catchtouchmove 没被抓到');
})();

/* ---------------- 真实页面扫描 ---------------- */
console.log('\n── ① 页面 page-meta 滚动锁（含弹层标志覆盖性）');

/** 扫描一个 wxml 文本，返回问题列表 */
function inspectPage(file, raw) {
  const problems = [];
  const text = stripComments(raw);

  // 收集所有滚动类弹层的 show 标志
  const flags = [];
  const modalRe = new RegExp('<(?:' + SCROLL_MODALS.join('|') + ')\\b([\\s\\S]*?)>', 'g');
  let m;
  while ((m = modalRe.exec(text))) {
    const tag = m[0].replace(/\s[\s\S]*$/, '');
    const showAttr = /show\s*=\s*"([^"]*)"/.exec(m[1]);
    if (!showAttr) problems.push('弹层 ' + tag + ' 没有 show 属性（无法锁定）');
    else flagsOf(showAttr[1]).forEach(f => { if (flags.indexOf(f) < 0) flags.push(f); });
  }
  if (!flags.length) return problems;   // 没有滚动弹层 → 不要求

  // A. page-meta 必须存在（且只能有一个），且在第一个 <view> 之前
  const pmCount = (text.match(/<page-meta\b/g) || []).length;
  const pmRe = /<page-meta\b([\s\S]*?)>/;
  const pm = pmRe.exec(text);
  if (!pm) {
    problems.push('含 ' + SCROLL_MODALS.join('/') + ' 但没有 <page-meta page-style="…overflow:hidden…">');
    return problems;
  }
  if (pmCount !== 1) problems.push('页面里有 ' + pmCount + ' 个 <page-meta>（小程序只允许一个）');
  const firstView = text.search(/<view\b/);
  if (firstView >= 0 && pm.index > firstView) {
    problems.push('<page-meta> 不是页面第一个节点（必须放在第一个 <view> 之前）');
  }

  // B. page-style 必须含 overflow:hidden
  const styleAttr = /page-style\s*=\s*"([^"]*)"/.exec(pm[1]);
  if (!styleAttr) {
    problems.push('<page-meta> 缺少 page-style');
  } else if (!/overflow\s*:\s*hidden/.test(styleAttr[1])) {
    problems.push('page-style 未包含 overflow:hidden');
  } else {
    // C. 覆盖性
    const miss = missingFlags(styleAttr[1], flags);
    if (miss.length) {
      problems.push('page-style 漏锁弹层标志：' + miss.join(', ')
        + '（弹层共 ' + flags.length + ' 个：' + flags.join(', ') + '）');
    }
  }
  return problems;
}

const pageDirs = fs.readdirSync(PAGES).filter(d => fs.statSync(path.join(PAGES, d)).isDirectory());
let locked = 0;
pageDirs.forEach((d) => {
  const f = path.join(PAGES, d, 'index.wxml');
  if (!fs.existsSync(f)) return;
  const text = stripComments(fs.readFileSync(f, 'utf8'));
  const problems = inspectPage(f, text);
  const hasModal = new RegExp('<(?:' + SCROLL_MODALS.join('|') + ')\\b').test(text);
  if (!hasModal) return;
  if (problems.length) problems.forEach(p => bad('pages/' + d + '/index.wxml: ' + p));
  else { locked++; ok('pages/' + d + '/index.wxml 已锁（' + (/page-style\s*=\s*"([^"]*)"/.exec(text)[1].trim()) + '）'); }
});

/* ---------------- 组件侧兜底 ---------------- */
console.log('\n── ② 弹层组件兜底（body 滚动容器防穿透 + 遮罩 catchtouchmove）');
SCROLL_MODALS.forEach((c) => {
  const f = path.join(COMPONENTS, c, 'index.wxml');
  if (!fs.existsSync(f)) { bad('找不到组件 ' + c); return; }
  const t = stripComments(fs.readFileSync(f, 'utf8'));
  // v0.7.32：duty-sheet 已并入 bottom-sheet（薄封装）——外壳与 body 滚动容器都在那边，
  // 这里只需断言「确实委派了」，不再要求它自带一套 scroll-view/spring-scroll。
  if (c === 'duty-sheet') {
    if (/<bottom-sheet\b/.test(t)) ok(c + ' 已并入 <bottom-sheet>（body 滚动容器由共享组件提供）');
    else bad(c + ' 既没有 body 滚动容器，也没有并入 <bottom-sheet>');
    return;
  }
  const usesSpring = /<spring-scroll\b/.test(t);
  const body = /<scroll-view\b([\s\S]*?)>/.exec(t);
  if (!body && !usesSpring) { bad(c + ' 没有找到 body <scroll-view> 或 <spring-scroll>'); return; }
  // 遮罩 catchtouchmove（点击遮罩外区域吞掉手势）
  if (!/class="[^"]*mask[^"]*"[\s\S]{0,80}?catchtouchmove/.test(t)
    && !/catchtouchmove[^>]*class="[^"]*mask[^"]*"/.test(t)) bad(c + ' 遮罩缺 catchtouchmove（点击遮罩外区域时应吞掉手势）');

  if (usesSpring) {
    // spring-scroll 把「防滚动穿透」收口在自己组件内部：viewport 必须 catchtouchmove
    const sc = path.join(COMPONENTS, 'spring-scroll', 'index.wxml');
    if (!fs.existsSync(sc)) { bad(c + ' 用了 <spring-scroll> 但找不到 spring-scroll 组件'); return; }
    const sct = stripComments(fs.readFileSync(sc, 'utf8'));
    if (!/catchtouchmove/.test(sct)) bad(c + ' 的 spring-scroll 缺 catchtouchmove（滚动穿透未收口）');
    else ok(c + ' 用 spring-scroll：滚动穿透在 spring-scroll viewport 收口（catchtouchmove）');
  } else {
    const attrs = body[1];
    if (!/enhanced\s*=\s*"\{\{\s*true\s*\}\}"/.test(attrs)) bad(c + ' body scroll-view 缺 enhanced="{{true}}"');
    if (!/bounces\s*=\s*"\{\{\s*false\s*\}\}"/.test(attrs)) bad(c + ' body scroll-view 缺 bounces="{{false}}"');
    if (!/enhanced/.test(attrs) || !/bounces/.test(attrs)) return;
    ok(c + ' 组件侧兜底完整（scroll-view + enhanced + bounces=false）');
  }
});

/* ---------------- 汇总 ---------------- */
console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 滚动穿透防护校验通过（已锁页面 ' + locked + ' 个）');
