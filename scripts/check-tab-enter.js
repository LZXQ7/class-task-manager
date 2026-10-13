/**
 * 门禁：Tab 页入场动画（v0.7.14 第 3 次定案：分块淡入 + 轻微上浮）
 * ------------------------------------------------------------
 * 背景（六次迭代，别再走回头路）：
 *   ① 整页 opacity 0→1 每次 onShow 重播  → 反馈「切页面闪一下」
 *   ② 改成只播一次、回访完全静止         → 反馈「直接展示太生硬」
 *   ③ 内容分块依次上浮（错峰 / 位移都大）→ 反馈「错峰太碎」
 *   ④ 单一整体节拍（整页 14px 上浮）     → 反馈「展开动画不好看」
 *   ⑤ 极简 cross-fade（零位移）          → 反馈「看不见；点击首页应该有进入动画」
 *   ⑥ v0.7.14（用户明确选择）：**分块淡入 + 轻微上浮** —— 单块 180ms / 8px /
 *      块间 20ms（回访 140ms / 5px / 14ms），延迟封顶第 7 块。
 *   ⑦ v0.7.31（2026-09-29 用户反馈）：**「几乎一起出现」+「个别卡片晚出现」** ——
 *      错峰 20 → 36ms（回访 26ms），整段 300 → 396ms（导航预算放宽到 460ms）；
 *      新增 **pa-hold 就绪门控**：未就绪时根节点挂 pa-hold（`.st-item` 透明），
 *      等「身份 + 首屏数据」就绪（或 READY_MS 兜底）再统一开播，
 *      治「异步门控的卡（本班请假 / 本学期统计）首屏不在 DOM、独自晚出现」。
 *
 * 为什么值得上门禁（这一版比以往都危险）：
 *   · ⑤ 把位移删掉后，本门禁当时断言的是「零位移」；⑥ 又把位移加回来了，
 *     所以必须**反向**锁死：位移只能是 Y 轴、只能 8px/5px、不许顺手加 scale/rotate，
 *     也不许把值悄悄放大回第 ④ 版那种「整页 14px」的量级。
 *   · ⚠️⚠️ translateY 会创建包含块 —— **fixed 元素绝不能待在 .st-item 内部**，
 *     否则动画那 180ms 里它会改成相对该块定位而飞走。纯 opacity 时代这只是「约定」，
 *     现在它是硬正确性要求，必须逐页静态断言（肉眼很难发现，因为只错 180ms）。
 *   · 所有 .st-item 必须**互为兄弟**：一旦有人把一个 st-item 套进另一个里面，
 *     两层位移就叠加成 16px。
 *   · ⚠️⚠️ 错峰**必须用 wxml 档位类**（st-1~st-7，第 7 块起封顶），**不许用 CSS 兄弟选择器**：
 *     2026-09-26 真机编译报 `app.wxss(248:31): unexpected token ~` —— WXSS **不支持通用兄弟
 *     选择器 `~`**，整个 app.wxss 编译失败 → 全站样式丢失。
 *     ⚠️ **当时本门禁 32 项全绿却编不过**，因为离线门禁只做文本检查、跑不了真正的 WCSS
 *     编译器。「门禁绿」≠「能编译」—— 已补「wxss 禁用 ~ 选择器」断言作为直接防线。
 *     （`+` 相邻兄弟选择器项目里大量在用且线上正常，故只拦 `~`。）
 *   · 档位类必须**静态可校验**：第 N 个 .st-item 必须标 st-N，从 st-1 起连续、封顶 st-7。
 *   · 强度常量写在 JS（`utils/page-anim.js`）、数值写在 CSS（`app.wxss`），
 *     改一处忘另一处不会报错，只会「说好的 240ms 变成了别的」。
 *
 * 自证：① 直接 require `utils/page-anim.js`，用假 page 跑首次/回访的 class 轮换；
 *       ② CSS 时长 / 位移 / 错峰与 JS 常量逐项比对；
 *       ③ fixed 类名**从 wxss 里动态提取**（不是写死清单），再扫 wxml 的嵌套关系。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

/** 剥注释：注释里提到的类名/标签/数值不能算数（本项目踩过两次误报） */
const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** 从 wxss 里提取所有带 position:fixed 的类名（动态，不写死清单） */
function fixedClasses(cssText) {
  const out = new Set();
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(cssText))) {
    if (!/position:\s*fixed/.test(m[2])) continue;
    const cre = /\.([a-zA-Z][\w-]*)/g;
    let c;
    while ((c = cre.exec(m[1]))) out.add(c[1]);
  }
  return out;
}

/**
 * 扫描 wxml 的 st-item / fixed 嵌套关系。
 * `<block>` 是虚拟节点（不产生元素），不入栈 —— 页面里大量用 `<block wx:if>` 包内容块。
 *
 * ⚠️ 属性段必须**排除裸 `/`**（`[^>"'\/]`），否则贪婪匹配会把 `<x ... />` 的
 *    收尾斜杠也吞进 attrs，`(\/?)` 拿不到 `/` → 自闭合被判成开标签 → 栈白涨一层，
 *    后面所有元素都被误判成「待在更深的容器里」，`fixedInside` 集体假阳性。
 *    （本门禁第一次跑就踩了这个坑：`.fab-shift` / `.off-canvas` 全被误报。）
 *    属性值里出现的 `/`（如 `src="/a.png"`、`{{a / b}}`）都在引号内，
 *    由前两个分支（`"[^"]*"` / `'[^']*'`）整段吃掉，不受影响。
 */
const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'/])*)\s*(\/?)>/g;

function auditStructure(wxml, fixedSet) {
  const stack = [];   // { name, st }
  const out = { total: 0, nested: [], fixedInside: [], onFixed: [], depths: new Set(), selfCloseMismatch: [] };
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(wxml))) {
    const closing = m[1] === '/';
    const name = m[2];
    const attrs = m[3] || '';
    const selfClose = m[4] === '/';
    const virtual = name === 'block';
    // 自证：源码明明以 `/>` 收尾却不认自闭合 = 扫描器坏了，不是页面坏了
    if (!closing && /\/\s*>$/.test(m[0]) && !selfClose) out.selfCloseMismatch.push(name);
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { stack.length = i; break; }
      }
      continue;
    }
    const cls = (/class="([^"]*)"/.exec(attrs) || [])[1] || '';
    const hasSt = /\bst-item\b/.test(cls);
    const fixes = Array.from(fixedSet).filter(f => new RegExp('\\b' + f + '\\b').test(cls));
    const ancestorSt = stack.some(s => s.st);
    if (!virtual) {
      if (hasSt) {
        out.total++;
        out.depths.add(stack.length);
        if (ancestorSt) out.nested.push(name + '（.' + cls.trim() + '）');
        if (fixes.length) out.onFixed.push(fixes.join('/') + '（.' + cls.trim() + '）');
      } else if (fixes.length && ancestorSt) {
        out.fixedInside.push(fixes.join('/') + '（.' + cls.trim() + '）');
      }
    }
    if (!selfClose && !virtual) stack.push({ name, st: hasSt });
  }
  return out;
}

/** 取某个前缀（pa-first / pa-lite-a / pa-lite-b）下档位类 st-N 的 animation-delay（ms） */
function tierDelays(css, prefix) {
  const out = {};
  const re = new RegExp('\\.' + prefix + '\\s+\\.st-item\\.st-(\\d)\\s*\\{[^}]*animation-delay:\\s*(\\d+)ms', 'g');
  let m;
  while ((m = re.exec(css))) out[Number(m[1])] = Number(m[2]);
  return out;
}

/**
 * wxss 里的通用兄弟选择器 `~`（WXSS 不支持，真机编译 fatal）。
 * ⚠️ 只拦 `~`：`+` 相邻兄弟选择器项目里大量在用（doc/poster/roster/home/mine/classes/timetable）
 *    且线上正常，误拦会造成大面积假阳性。
 */
function siblingSquiggles(cssText) {
  const hits = [];
  cssText.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\s~\s/.test(code) && !/~=/.test(code)) hits.push((i + 1) + ': ' + line.trim());
  });
  return hits;
}

/** 按文档顺序读出所有 .st-item 的档位号（未标档位记 0） */
function tierSeq(wxml) {
  const seq = [];
  const tagScan = /<[a-zA-Z][\w-]*((?:"[^"]*"|'[^']*'|[^>"'/])*?)\s*\/?>/g;
  let m;
  while ((m = tagScan.exec(wxml))) {
    const cls = (/class="([^"]*)"/.exec(m[1]) || [])[1] || '';
    if (!/\bst-item\b/.test(cls)) continue;
    const t = /\bst-(\d)\b/.exec(cls);
    seq.push(t ? Number(t[1]) : 0);
  }
  return seq;
}

/** 期望档位序列：第 i 个（0-based）应为 min(i+1, ST_CAP) */
const wantTier = (i, cap) => Math.min(i + 1, cap);

/** 取 keyframes 里的 translateY 值（px） */
function kfYs(css, name) {
  const body = (new RegExp('@keyframes\\s+' + name + '\\s*\\{([\\s\\S]*?)\\n\\}').exec(css) || [])[1] || '';
  return Array.from(body.matchAll(/translateY\(([\d.]+)px\)/g)).map(x => Number(x[1]));
}

const TABS = ['home', 'timetable', 'duty', 'mine'];
const TAB_LABEL = { home: '首页', timetable: '课表页', duty: '值日页', mine: '我的页' };

/* ============================================================
 * ① utils/page-anim.js —— 首次 / 回访 的 class 轮换（真实行为自证）
 * ============================================================ */
console.log('── ① page-anim.js 行为自证');
const animPath = path.join(MINI, 'utils', 'page-anim.js');
let anim = null;
if (!exists('miniprogram/utils/page-anim.js')) bad('缺少 miniprogram/utils/page-anim.js');
else {
  anim = require(animPath);
  if (typeof anim.play === 'function') ok('导出 play()');
  else bad('page-anim.js 没有导出 play()');

  const fake = (seq) => {
    const p = { data: { animSeq: seq }, sets: [] };
    p.setData = (o) => { Object.assign(p.data, o); p.sets.push(o); };
    return p;
  };
  const p = fake(0);
  anim.play(p);
  if (p.sets.length === 0) ok('首次进入不 setData（元素创建时 CSS animation 已经开播，再设会打断）');
  else bad('首次进入不该 setData（会打断刚播几毫秒的动画），实得 ' + JSON.stringify(p.sets));
  const seqs = [];
  for (let i = 0; i < 3; i++) { anim.play(p); seqs.push(p.data.animSeq); }
  if (seqs.join(',') === '1,2,1') ok('回访在 1 / 2 之间轮换（换 class 名 = 重播动画）：' + seqs.join(' → '));
  else bad('回访 class 轮换不对：' + seqs.join(' → '));

  // playReady（v0.7.31）：页面入口。已就绪分支同步可验（不残留定时器）
  if (typeof anim.playReady === 'function') ok('导出 playReady()（就绪后统一播，页面用它替代 play(this)）');
  else bad('page-anim.js 没有导出 playReady()');
  const pr = { data: { animSeq: 0, paReady: true }, sets: [] };
  pr.setData = (o) => { Object.assign(pr.data, o); pr.sets.push(o); };
  pr._animPlayedOnce = true;
  anim.playReady(pr, null);
  if (pr.data.animSeq === 1) ok('playReady：已就绪(paReady=true)时直接轮换 class（animSeq 0→1，回访重播）');
  else bad('playReady 已就绪分支没轮换 class：' + JSON.stringify(pr.sets));

  const need = ['FULL_MS', 'LITE_MS', 'FULL_Y', 'LITE_Y', 'ST_STEP_MS', 'LITE_STEP_MS', 'ST_CAP', 'FULL_TOTAL_MS', 'LITE_TOTAL_MS', 'READY_MS'];
  const miss = need.filter(k => typeof anim[k] !== 'number');
  if (!miss.length) ok('导出强度常量：' + need.join(' / '));
  else bad('缺少强度常量：' + miss.join(' / '));
  if (!miss.length) {
    // 位移必须存在（⑥ 版的核心），但必须是「轻微」量级 —— 不许退回第 ④ 版的整页 14px
    if (anim.FULL_Y > 0 && anim.FULL_Y <= 12) ok('首次位移 ' + anim.FULL_Y + 'px（存在且 ≤12px，不退回「整页 14px」量级）');
    else bad('首次位移应在 1~12px 之间，实得 ' + anim.FULL_Y + 'px');
    if (anim.LITE_Y > 0 && anim.LITE_Y < anim.FULL_Y) ok('回访位移更轻（' + anim.LITE_Y + 'px < ' + anim.FULL_Y + 'px）');
    else bad('回访位移应大于 0 且小于首次，实得 ' + anim.LITE_Y + 'px');
    if (anim.FULL_MS > anim.LITE_MS) ok('首次单块时长大于回访（' + anim.FULL_MS + 'ms > ' + anim.LITE_MS + 'ms）');
    else bad('首次单块时长应大于回访');
    if (anim.LITE_STEP_MS > 0 && anim.LITE_STEP_MS < anim.ST_STEP_MS) ok('回访错峰比首次更紧（' + anim.LITE_STEP_MS + 'ms < ' + anim.ST_STEP_MS + 'ms）');
    else bad('回访错峰应大于 0 且小于首次，实得 ' + anim.LITE_STEP_MS + 'ms');
    // 错峰必须封顶（否则长页面尾巴越拉越长 = 又变回「错峰太碎」）
    if (anim.ST_CAP >= 2 && anim.ST_CAP <= 7) ok('错峰封顶第 ' + anim.ST_CAP + ' 块');
    else bad('ST_CAP 应在 2~5 之间，实得 ' + anim.ST_CAP);
    const fTotal = anim.FULL_MS + (anim.ST_CAP - 1) * anim.ST_STEP_MS;
    const lTotal = anim.LITE_MS + (anim.ST_CAP - 1) * anim.LITE_STEP_MS;
    if (anim.FULL_TOTAL_MS === fTotal && anim.LITE_TOTAL_MS === lTotal) ok('总时长自洽（首次 ' + fTotal + 'ms / 回访 ' + lTotal + 'ms）');
    else bad('总时长与「单块 + 错峰×档数」不自洽：' + anim.FULL_TOTAL_MS + ' / ' + anim.LITE_TOTAL_MS);
    // 预算：⑥ 定为 300ms（Apple 导航过渡口径）；⑦（v0.7.31）用户反馈「几乎一起出现、
    // 看不出递进」→ 错峰拉开到 36ms，整段 396ms，预算放宽到 460ms。
    if (anim.FULL_TOTAL_MS <= 460) ok('首次总时长在 460ms 预算内（' + anim.FULL_TOTAL_MS + 'ms）');
    else bad('首次总时长 ' + anim.FULL_TOTAL_MS + 'ms 超出 460ms 预算');
    // 就绪兜底：必须有值且不太长（否则空白太久），也不能为 0（等于不等待）
    if (anim.READY_MS > 0 && anim.READY_MS <= 600) ok('就绪兜底 READY_MS = ' + anim.READY_MS + 'ms（>0 且 ≤600）');
    else bad('READY_MS 应在 1~600ms 之间，实得 ' + anim.READY_MS);
  }
}

/* ============================================================
 * ② 四个 Tab 页：接线 + 标记 + 兄弟性 + fixed 撞车
 * ============================================================ */
console.log('\n── ② 四个 Tab 页接线');
const css = stripComments(read('miniprogram/app.wxss'));
const fixed = fixedClasses(css + '\n' + TABS.map(p => {
  const f = path.join(MINI, 'pages', p, 'index.wxss');
  return fs.existsSync(f) ? stripComments(fs.readFileSync(f, 'utf8')) : '';
}).join('\n'));
ok('从 wxss 提取到 ' + fixed.size + ' 个 fixed 类名：' + Array.from(fixed).join(' / '));

for (const p of TABS) {
  const wxml = stripComments(read('miniprogram/pages/' + p + '/index.wxml'));
  const js = read('miniprogram/pages/' + p + '/index.js');
  const label = TAB_LABEL[p];

  // 接线
  has(js, /animSeq:\s*0/, label + ' data 初始 animSeq: 0（首次播完整版）');
  has(js, /paReady:\s*false/, label + ' data 初始 paReady: false（就绪前根节点挂 pa-hold）');
  has(js, /pageAnim\.playReady\(this/, label + ' onShow 调 pageAnim.playReady(this, …)（就绪后统一播）');
  const four = /'pa-first'/.test(wxml) && /'pa-lite-a'/.test(wxml) && /'pa-lite-b'/.test(wxml) && /'pa-hold'/.test(wxml);
  if (four) ok(label + ' 根节点四元写全 pa-hold + 三个动画类名（插值会让 check-wxss 看不到）');
  else bad(label + ' 根节点没写全 pa-hold / pa-first / pa-lite-a / pa-lite-b');

  // 标记数
  const n = (wxml.match(/st-item/g) || []).length;
  if (n >= 2) ok(label + ' 至少 2 个入场块（实得 ' + n + '）');
  else bad(label + ' 入场块不足 2 个（实得 ' + n + '，等于没做入场）');

  // 错峰靠 wxml 档位类：第 N 个 .st-item 必须标 st-N，从 st-1 起连续、封顶 st-4
  const cap = (anim && anim.ST_CAP) || 4;
  const seq = tierSeq(wxml);
  const want = seq.map((_, i) => wantTier(i, cap));
  const firstBad = seq.findIndex((v, i) => v !== want[i]);
  if (!seq.length) bad(label + ' 读不到任何 .st-item 档位');
  else if (firstBad < 0) ok(label + ' 档位连续且封顶 st-' + cap + '（共 ' + seq.length + ' 块：' + seq.map(n => 'st-' + n).join(' ') + '）');
  else bad(label + ' 第 ' + (firstBad + 1) + ' 个 .st-item 档位应为 st-' + want[firstBad] + '，实得 ' +
    (seq[firstBad] ? 'st-' + seq[firstBad] : '无档位') + '（实测序列 ' + seq.join(',') + '）');

  // ⚠️ 关键：结构审计（兄弟性 + fixed 撞车）
  const aud = auditStructure(wxml, fixed);
  // 先验扫描器本身没坏：源码里以 `/>` 收尾的标签必须被判成自闭合
  if (!aud.selfCloseMismatch.length) ok(label + ' 自闭合标签解析正常（扫描器未被贪婪属性段骗到）');
  else bad(label + ' 扫描器把自闭合标签当成开标签：' + aud.selfCloseMismatch.join(' / ') + ' —— 先修 TAG_RE，别信后面的嵌套结论');
  if (!aud.nested.length) ok(label + ' 所有 .st-item 互为兄弟（' + aud.total + ' 个，无嵌套 → 位移不会叠加）');
  else bad(label + ' 有 .st-item 套在另一个 .st-item 里（位移会叠成两倍）：' + aud.nested.join('；'));
  if (!aud.onFixed.length) ok(label + ' 没有 .st-item 落在 fixed 元素上');
  else bad(label + ' .st-item 撞上 fixed 元素：' + aud.onFixed.join('；'));
  // ⚠️⚠️ translateY 会创建包含块 → fixed 元素绝不能待在 st-item 内部
  if (!aud.fixedInside.length) ok(label + ' 没有 fixed 元素待在 .st-item 内部（transform 建包含块不会让它飞）');
  else bad(label + ' fixed 元素被包在 .st-item 里，动画期间会飞走：' + aud.fixedInside.join('；'));

  // fixed 元素必须是根节点的直接子节点（= 不被任何带动画的容器包住）
  Array.from(fixed).forEach(f => {
    const re = new RegExp('^ {2}<[a-zA-Z][\\w-]*\\b[^>]*class="[^"]*\\b' + f + '\\b[^"]*"', 'm');
    const inPage = new RegExp('class="[^"]*\\b' + f + '\\b').test(wxml);
    if (inPage && !re.test(wxml)) bad(label + ' 的 .' + f + ' 不是根节点直接子节点（可能被动画容器包住，fixed 会失效）');
  });
}

/* ============================================================
 * ③ app.wxss：位移量级 / 错峰封顶 / keyframes / 与 JS 常量一致
 * ============================================================ */
console.log('\n── ③ app.wxss 动画定义');
[['paInFull', '首次完整版'], ['paInLiteA', '回访轻量 A'], ['paInLiteB', '回访轻量 B'], ['paReduce', 'reduced-motion 降级']].forEach(([kf, label]) => {
  has(css, new RegExp('@keyframes\\s+' + kf + '\\s*\\{'), '定义了 @keyframes ' + kf + '（' + label + '）');
});

// 位移只允许 Y 轴：出现 translateX / scale / rotate / skew / matrix 就说明动画形态跑偏了
const enterKf = (css.match(/@keyframes\s+(?:paIn\w*|paReduce)\s*\{[\s\S]*?\n\}/g) || []).join('\n');
if (!enterKf) bad('没解析到入场 keyframes');
else {
  const badFn = enterKf.match(/\b(?:translateX|translate3d|scale[XYZ]?|rotate|skew|matrix)\b/g);
  if (!badFn) ok('入场 keyframes 只有 Y 轴位移（无 translateX / scale / rotate / skew / matrix）');
  else bad('入场 keyframes 出现了 Y 轴以外的变换：' + Array.from(new Set(badFn)).join(' / '));
  if (!/\b(?:width|height|margin|padding|top|left|right|bottom|font-size)\s*:/.test(enterKf)) ok('入场 keyframes 不动布局属性（只动 opacity + transform，不触发重排）');
  else bad('入场 keyframes 动了布局属性，长列表会掉帧');
}
has(css, /\.pa-first\s+\.st-item\s*\{[^}]*animation:\s*paInFull/, '.pa-first .st-item 用 paInFull');
has(css, /\.pa-lite-a\s+\.st-item\s*\{[^}]*animation:\s*paInLiteA/, '.pa-lite-a .st-item 用 paInLiteA');
has(css, /\.pa-lite-b\s+\.st-item\s*\{[^}]*animation:\s*paInLiteB/, '.pa-lite-b .st-item 用 paInLiteB');
// 就绪门控（v0.7.31）：未就绪时 .st-item 必须透明，否则 pa-hold 期间内容已可见、「统一开播」落空
has(css, /\.pa-hold\s+\.st-item\s*\{[^}]*opacity:\s*0/, '.pa-hold .st-item 透明（未就绪不显示）');

// 基档（第 1 块）不得带 animation-delay —— 否则整段被整体推迟
// ⚠️ 取「含 animation: 的那条规则」：will-change 规则的选择器列表以 `.pa-lite-b .st-item {` 结尾，
//    用单次 exec 会先命中它、检查错对象（旧版就是这个问题，只是恰好也通过）。
['pa-first', 'pa-lite-a', 'pa-lite-b'].forEach(sel => {
  const all = Array.from(css.matchAll(new RegExp('\\.' + sel + '\\s+\\.st-item\\s*\\{([^}]*)\\}', 'g'))).map(m => m[1]);
  const base = all.find(b => /animation:/.test(b));
  if (base && !/animation-delay/.test(base)) ok('.' + sel + ' 基档无 animation-delay（第 1 块立即开始）');
  else bad('.' + sel + ' 基档带了 animation-delay 或找不到基档规则（整段会被整体推迟）');
});
// 档位延迟必须严格等于 step×(n-1)，覆盖 st-2..st-ST_CAP，且不得有更高档
if (anim) {
  [['pa-first', anim.ST_STEP_MS], ['pa-lite-a', anim.LITE_STEP_MS], ['pa-lite-b', anim.LITE_STEP_MS]].forEach(([sel, step]) => {
    const d = tierDelays(css, sel);
    const tiers = [];
    for (let n = 2; n <= anim.ST_CAP; n++) tiers.push(n);
    const missing = tiers.filter(n => d[n] === undefined);
    const wrong = tiers.filter(n => d[n] !== undefined && d[n] !== (n - 1) * step);
    const extra = Object.keys(d).map(Number).filter(n => n > anim.ST_CAP);
    if (!Object.keys(d).length) bad('.' + sel + ' 没有任何档位延迟规则（退化成整体节拍 = 第 ⑤ 版）');
    else if (!missing.length && !wrong.length && !extra.length) {
      ok('.' + sel + ' 档位错峰 = ' + tiers.map(n => d[n] + 'ms@st-' + n).join(' / ') + '，第 ' + (anim.ST_CAP + 1) + ' 块起封顶');
    } else bad('.' + sel + ' 档位错峰不对：实得 ' + JSON.stringify(d) +
      '（应 step=' + step + 'ms、覆盖 st-2..st-' + anim.ST_CAP + '、不得有更高档）');
  });
}
// ⚠️ wxss 绝不能出现通用兄弟选择器 `~`（真机编译 fatal，见文件头）
const squiggles = siblingSquiggles(css);
if (!squiggles.length) ok('app.wxss 无通用兄弟选择器 `~`（WXSS 不支持，真机会 fatal 编译失败）');
else bad('app.wxss 出现 `~` 选择器 —— WXSS 编译直接失败、全站样式丢失：' + squiggles.join(' | '));
// 档位规则必须绑 .st-item 提权（0-3-0 > 基档 0-2-0），否则书写顺序一颠倒就被 animation 简写重置
const bareTier = css.match(/\.(?:pa-first|pa-lite-a|pa-lite-b)\s+\.st-[1-9]\s*\{/g);
if (!bareTier) ok('档位规则都绑了 .st-item（权重 0-3-0 压过 animation 简写，不依赖书写顺序）');
else bad('档位规则裸写 .st-N（与基档同权重 0-2-0，简写会重置 animation-delay）：' + bareTier.join(' '));
// 三条动画必须带 backwards，否则低性能机可能先闪现一帧再开播
['pa-first', 'pa-lite-a', 'pa-lite-b'].forEach(sel => {
  has(css, new RegExp('\\.' + sel + '\\s+\\.st-item\\s*\\{[^}]*backwards'), '.' + sel + ' .st-item 带 fill-mode: backwards');
});

// 两套 lite 内容必须一致，只差名字（否则回访观感会一帧重一帧轻）
const liteA = (/@keyframes\s+paInLiteA\s*\{([\s\S]*?)\n\}/.exec(css) || [])[1] || '';
const liteB = (/@keyframes\s+paInLiteB\s*\{([\s\S]*?)\n\}/.exec(css) || [])[1] || '';
if (liteA && liteB && liteA.replace(/\s+/g, '') === liteB.replace(/\s+/g, '')) ok('两套 lite keyframes 内容一致（只差名字，用来重播）');
else bad('两套 lite keyframes 内容不一致（回访观感会一重一轻）');

if (anim) {
  // 时长 JS ↔ CSS
  const durOf = (sel) => {
    const m = new RegExp('\\.' + sel + '\\s+\\.st-item\\s*\\{[^}]*animation:\\s*\\w+\\s+\\.?([\\d.]+)s').exec(css);
    return m ? Math.round(parseFloat('0.' + String(m[1]).replace(/^0?\./, '')) * 1000) : null;
  };
  const fullDur = durOf('pa-first');
  const liteDur = durOf('pa-lite-a');
  if (fullDur === anim.FULL_MS) ok('首次单块时长 JS/CSS 一致（' + fullDur + 'ms）');
  else bad('首次单块时长不一致：JS ' + anim.FULL_MS + 'ms vs CSS ' + fullDur + 'ms');
  if (liteDur === anim.LITE_MS) ok('回访单块时长 JS/CSS 一致（' + liteDur + 'ms）');
  else bad('回访单块时长不一致：JS ' + anim.LITE_MS + 'ms vs CSS ' + liteDur + 'ms');
  const liteBDur = durOf('pa-lite-b');
  if (liteBDur === anim.LITE_MS) ok('pa-lite-b 时长与 a 一致（' + liteBDur + 'ms）');
  else bad('pa-lite-b 时长与 a 不一致：' + liteBDur + 'ms');

  // 位移 JS ↔ CSS（正反都要锁：既不能没有，也不能超标）
  const yFull = kfYs(css, 'paInFull');
  const yLite = kfYs(css, 'paInLiteA');
  const maxY = arr => (arr.length ? Math.max.apply(null, arr) : 0);
  if (maxY(yFull) === anim.FULL_Y) ok('首次位移 JS/CSS 一致（' + anim.FULL_Y + 'px）');
  else bad('首次位移不一致：JS ' + anim.FULL_Y + 'px vs CSS ' + maxY(yFull) + 'px');
  if (maxY(yLite) === anim.LITE_Y) ok('回访位移 JS/CSS 一致（' + anim.LITE_Y + 'px）');
  else bad('回访位移不一致：JS ' + anim.LITE_Y + 'px vs CSS ' + maxY(yLite) + 'px');
}
// reduced-motion 降级：去位移 + 去错峰，只留极短淡入
if (/prefers-reduced-motion[\s\S]{0,400}?\.pa-first\s+\.st-item/.test(css)) ok('尊重 prefers-reduced-motion');
else bad('入场动画没有 prefers-reduced-motion 兜底');
const rmBlock = (/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/.exec(css) || [])[0] || '';
if (rmBlock && /animation:\s*paReduce/.test(rmBlock)) ok('reduced-motion 降级为 paReduce（更轻而非直接关掉）');
else bad('reduced-motion 没有引用 paReduce 做降级');
const rmZero = rmBlock && /\.st-item\.st-2[\s\S]{0,400}?animation-delay:\s*0s/.test(rmBlock);
if (rmZero) ok('reduced-motion 显式清零档位延迟（档位权重 0-3-0 更高，不会被简写重置）');
else bad('reduced-motion 没有清零档位延迟 —— 档位规则权重更高，会绕过 .pa-first .st-item 的简写重置');
const rmYs = kfYs(css, 'paReduce');
if (!rmYs.length) ok('reduced-motion 关键帧零位移（只做淡入）');
else bad('reduced-motion 关键帧仍有位移：' + rmYs.join('/') + 'px');

/* ============================================================
 * ④ 范围：只做四个 Tab 页，二级页不得加 st-item
 * ============================================================ */
console.log('\n── ④ 范围（只 Tab 页）');
const pageDirs = fs.readdirSync(path.join(MINI, 'pages')).filter(d => fs.existsSync(path.join(MINI, 'pages', d, 'index.wxml')));
const leaked = [];
pageDirs.forEach(d => {
  if (TABS.indexOf(d) >= 0) return;
  const t = stripComments(read('miniprogram/pages/' + d + '/index.wxml'));
  if (/\bst-item\b/.test(t)) leaked.push(d);
});
if (!leaked.length) ok('二级页都没有加 st-item（navigateTo 自带系统转场，二级页走自己的进场动画）');
else bad('这些非 Tab 页加了 st-item：' + leaked.join(' / '));

/* ============================================================
 * ⑤ 自证：坏样本必须被抓，好样本不得误报
 * ============================================================ */
console.log('\n── ⑤ 双向自证');
const badSample = '<view class="fab st-item">+</view>';
const badHit = /\bst-item\b/.test(badSample) && /\bfab\b/.test(badSample);
if (badHit) ok('自证：fixed 元素带 st-item 的样本会被判为撞车');
else bad('自证失败：坏样本没被识别');
const goodSample = '<view class="card mt16 st-item">今日课次</view>';
const goodOk = /\bst-item\b/.test(goodSample) && !Array.from(fixed).some(f => new RegExp('\\b' + f + '\\b').test(goodSample));
if (goodOk) ok('自证：普通内容块带 st-item 的样本判为正常（不误报）');
else bad('自证失败：好样本被误判');
// 档位序列：连续合法 / 跳号必须被抓 / 封顶合法
const seqOk = tierSeq('<view class="card st-item st-1">a</view><view class="card st-item st-2">b</view>');
if (seqOk.join(',') === '1,2') ok('自证：档位连续样本读出正确序列（' + seqOk.join(',') + '）');
else bad('自证失败：档位序列读取不对（' + seqOk.join(',') + '）');
const seqBad = tierSeq('<view class="card st-item st-1">a</view><view class="card st-item st-3">b</view>');
if (seqBad[1] === 3 && seqBad[1] !== wantTier(1, 4)) ok('自证：档位跳号（st-1 → st-3）会被序列校验抓住');
else bad('自证失败：跳号样本没被识别');
const seqCap = tierSeq('<view class="st-item st-1">a</view><view class="st-item st-2">b</view><view class="st-item st-3">c</view><view class="st-item st-4">d</view><view class="st-item st-4">e</view>');
if (seqCap.join(',') === '1,2,3,4,4' && seqCap.every((v, i) => v === wantTier(i, 4))) ok('自证：第 5 块封顶 st-4 的样本合法（' + seqCap.join(',') + '）');
else bad('自证失败：封顶样本被判错（' + seqCap.join(',') + '）');
const seqNone = tierSeq('<view class="card st-item">a</view>');
if (seqNone.join(',') === '0') ok('自证：完全没标档位的样本会被判为 0（不等于期望的 st-1）');
else bad('自证失败：无档位样本没被识别（' + seqNone.join(',') + '）');
// ⚠️ 本门禁的最大盲区：`~` 在真机会 fatal，必须静态拦住
const squiggleSample = '.pa-first .st-item ~ .st-item { animation-delay: 20ms; }';
if (siblingSquiggles(squiggleSample).length === 1) ok('自证：`~` 选择器会被抓住（真机编译 fatal）');
else bad('自证失败：`~` 选择器没被识别');
const plusSample = '.ps-row + .ps-row::before { margin-top: 8rpx; }';
if (siblingSquiggles(plusSample).length === 0) ok('自证：`+` 选择器不误报（项目大量在用且线上正常）');
else bad('自证失败：`+` 被误报为 `~`');
const attrSample = '.a[data-x~="y"] { color: red; }';
if (siblingSquiggles(attrSample).length === 0) ok('自证：属性选择器 `~=` 不误报');
else bad('自证失败：`~=` 被误报为兄弟选择器');
// 新增：嵌套 + fixed 在 st-item 内，两种坏样本都必须被抓
const nestSample = '<block wx:if="{{ok}}"><view class="card st-item"><view class="hero st-item">x</view></view></block>';
const nestAud = auditStructure(nestSample, new Set());
if (nestAud.nested.length === 1 && nestAud.total === 2) ok('自证：st-item 嵌套样本会被抓住（位移会叠成两倍）');
else bad('自证失败：嵌套样本没被识别（nested=' + JSON.stringify(nestAud.nested) + '）');
const fixedInSample = '<block wx:else><view class="card st-item"><view class="fab">+</view></view></block>';
const fixedAud = auditStructure(fixedInSample, new Set(['fab']));
if (fixedAud.fixedInside.length === 1) ok('自证：fixed 待在 st-item 内的样本会被抓住（动画期间会飞走）');
else bad('自证失败：fixed-inside 样本没被识别');
const fixedSibling = '<view class="card st-item">a</view><view class="fab">+</view>';
const sibAud = auditStructure(fixedSibling, new Set(['fab']));
if (!sibAud.fixedInside.length && !sibAud.nested.length) ok('自证：fixed 与 st-item 平级的样本不误报');
else bad('自证失败：平级样本被误报');
// 本门禁第一次跑就踩的坑：自闭合组件被贪婪属性段吞掉 `/` → 栈白涨一层 → 假阳性遍地
const selfCloseSample = '<view class="card st-item">a</view>\n<app-icon size="{{36}}" />\n<view class="fab">+</view>';
const scAud = auditStructure(selfCloseSample, new Set(['fab']));
if (!scAud.selfCloseMismatch.length && !scAud.fixedInside.length && !scAud.nested.length) {
  ok('自证：`<app-icon ... />` 自闭合样本不误报（属性段不吃收尾斜杠）');
} else bad('自证失败：自闭合样本骗过了扫描器（mismatch=' + JSON.stringify(scAud.selfCloseMismatch) + '）');
// 引号内的 `/` 不能把标签提前截断（src / 目录路径 / 除法表达式）
const slashInAttr = '<view class="card st-item"><image src="/img/a.png" /><view class="x">{{a / b}}</view></view>';
const saAud = auditStructure(slashInAttr, new Set());
if (saAud.total === 1 && !saAud.nested.length) ok('自证：属性值内的 `/` 不影响标签解析（src / 表达式）');
else bad('自证失败：属性值内的 `/` 让解析跑偏（total=' + saAud.total + '）');

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · Tab 页入场动画（分块淡入 + 轻微上浮）校验通过');
