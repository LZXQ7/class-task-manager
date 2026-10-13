#!/usr/bin/env node
/**
 * 第 67 个门禁：bottom-sheet 面板**高度过渡**（v1.0.7）
 * ============================================================
 * 起因（2026-10-08 用户实拍，两轮反馈）：
 *   ① 请假登记弹层切「近 7 天」筛选后，记录从 9 条变成 1 条，**面板高度瞬间塌缩**，
 *      视觉上是「弹层被一刀切掉」；
 *   ② 第一版修完后用户实测：「高度是**闪烁两下**降低，也**几乎没有**平滑的降低动画」。
 *
 * 根因：自适应高度弹层的面板是 `height: auto` + `max-height`
 * （`components/bottom-sheet/index.wxss`），而 **CSS 无法过渡 `height: auto`** ——
 * 没有任何声明能让 auto 高度插值，于是内容一重排高度就瞬变。
 *
 * ⚠️ 第一版（已废弃）用的是经典两段式「锁定 → 放开」，两个缺陷都出自它：
 *   · **闪烁两下**：`resizeScroll()` 是使用方在 setData 回调里调的，那一刻内容已
 *     重排完、面板**已经是新高度**；这时才把面板写回旧高度 ⇒ 用户看到
 *     「跳到新 → 又跳回旧 → 再过渡到新」= 两次可见跳变；
 *   · **几乎不平滑**：第二段是「显式 px → `height:auto`」，auto 不可插值 ⇒ 直接跳变；
 *     且挂 class 与改值落在同一批 setData 里会被合并成一次样式提交 ⇒ 过渡根本没起播。
 *
 * 修法（v1.0.7 现行）：**min-height / max-height 成对夹紧**
 *   常态下发 `min-height: H px; max-height: H px`（H = 上一次落定高度）。
 *   上下同值 ⇒ 面板可见高度恒等于 H，内容怎么变都动不了它（不会提前跳变）；
 *   两端都是 JS 下发的确定 px ⇒ 浏览器直接插值；
 *   **变高变矮完全对称**（只写 min-height 做不到：变高会被 auto 立刻顶上去，仍是硬跳变）。
 *   挂过渡类与改高度值**必须分两拍**（TRANSITION_ARM_MS = 16ms）。
 *
 * ⚠️ 本门禁钉的是**六条最容易静默失效**的性质（都不是「动画好不好看」，
 *    而是「动画到底会不会播」这种看不出来的失效）：
 *
 *  ① **from 不能靠本次量出来**。`resizeScroll()` 在 setData 回调里调用时内容已重排完，
 *     量到的是 to。一旦误写成「量当前高度当 from」，from 恒等于 to ⇒ 差值恒 0 ⇒
 *     **永远不播动画，而且不报错**（这是本功能最容易写废的形态）。
 *  ② **目标高度必须从内容算**（chrome + contentHeight），**不能量面板**：
 *     夹紧值一旦下发，量 `.sheet-panel` 量到的恒是夹紧值 ⇒ 永远发现不了「变矮了」。
 *  ③ **成对下发**。只写 min-height ⇒ 变高被 auto 顶上去硬跳；只写 max-height ⇒
 *     变矮时面板被 auto 压下去硬跳。两者都写才对称。
 *  ④ **必须两拍**（先挂 class、等 ≥16ms 再改值）。同一批 setData 合并 ⇒ 无动画。
 *  ⑤ **开场静默期**。`active` 在 show 之后 20ms 就置 true，只判 `active` 拦不住
 *     入场 transform（240ms）还在跑的那一段。
 *  ⑥ **body 选择器必须是 `.sheet-spring`**。v1.0.5 起 body 已换成 spring-scroll，
 *     `.sheet-body` 这个类只留在 wxss 里当历史说明，wxml 中**根本不存在**
 *     ⇒ 选它永远拿到 null，这段直接 return，动画静默失效（第一版实打实踩过）。
 *  ⑦ **顺序：先重测、再算高度**（同日用户实拍「下面选择同学偶尔不显示成员」）。
 *     `contentHeight()` 读的是 `_contentH`，它**只在 `_measure()` 的异步 selector
 *     query 回调里更新** ⇒ 「先 `_animateResize()` 后 `sc.resize()`」拿到的必然是
 *     上一轮的旧高度，夹紧值被锁在偏矮的数字上、面板再也长不高（成员渲染了却被裁）。
 *     反向配套：spring-scroll 的 `resize(cb)` 必须支持回调，且 cb 在 `_maxScroll`
 *     夹紧（setData）之后才触发。
 *
 * 行为层用**假 createSelectorQuery + 假 setData + 假定时器**把
 * `_animateResize` / `_measureHeights` / `_capPx` / `_setResizeClamp` / `_playResize`
 * / `resizeScroll` 真跑一遍，验两拍时序、夹紧成对、方向对称、陈旧 contentH
 * 与全部守卫；静态层钉调用点与**调用顺序**。
 *
 * 变异自证（9 组，每组都必须被抓，否则是自欺）：
 *   M1 from 改成「本次量到的高度」⇒ 与 to 恒等 ⇒ 永不动画
 *   M2 两拍合成一拍（把改值那一拍并进挂 class 那一拍）⇒ 动画不生效
 *   M3 删掉开场静默期守卫 ⇒ 入场期间夹紧高度，与 transform 抢
 *   M4 删掉最小区差守卫 ⇒ 内容微调也播动画（观感卡顿）
 *   M5 只写 min-height 不写 max-height ⇒ 变高退回硬跳变
 *   M6 body 选择器改回 `.sheet-body` ⇒ 量不到 body，静默失效
 *   M7 resizeScroll 顺序反回「先算高度后重测」⇒ 读到陈旧 contentH ⇒ 成员被裁
 *   M8 收尾不补算 pending ⇒ 过渡期间那次高度变化被永久丢弃
 *   M9 删掉 300ms 铺初值后的兜底补调 ⇒ 名单后到时高度永远不重算
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

const JS = 'miniprogram/components/bottom-sheet/index.js';
const WXML = 'miniprogram/components/bottom-sheet/index.wxml';
const WXSS = 'miniprogram/components/bottom-sheet/index.wxss';
const ROSTER = 'miniprogram/pages/roster/index.wxml';

const js = read(JS);
const wxml = read(WXML);
const wxss = read(WXSS);
const roster = read(ROSTER);

/* ------------------------------------------------------------------ */
console.log('── ① 属性与常量：resizeAnim 默认关（别把全站弹层都拖进来）');

chk(/resizeAnim:\s*\{\s*type:\s*Boolean,\s*value:\s*false\s*\}/.test(js),
  'resizeAnim 是 Boolean 属性且**默认 false**（默认关 ⇒ 其他弹层零影响）');
chk(/OPEN_SETTLE_MS\s*=\s*260/.test(js), '开场静默期 OPEN_SETTLE_MS = 260ms（> 入场 transform 的 240ms）');
chk(/RESIZE_ANIM_MS\s*=\s*220/.test(js), '高度过渡时长 220ms');
chk(/RESIZE_MIN_DIFF\s*=\s*8/.test(js), '最小区差 RESIZE_MIN_DIFF = 8px');
chk(/TRANSITION_ARM_MS\s*=\s*16/.test(js),
  '⚠️ 挂过渡类 → 改值之间的等待 TRANSITION_ARM_MS = 16ms（同一批 setData 会被合并 ⇒ 无动画）');
chk(/const CAP_RATIO = 0\.78/.test(js) && /const CAP_RATIO_TALL = 0\.92/.test(js),
  '高度上限档位常量 CAP_RATIO=0.78 / CAP_RATIO_TALL=0.92（与 wxss 的 78vh/92vh 对齐）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② 接线：wxss / wxml / 调用点');

// .animating 必须过渡 **min-height 与 max-height 这一对**（不是 height —— 过渡不了 auto）
const animating = /\.sheet-panel\.animating\s*\{([^}]*)\}/.exec(wxss);
chk(!!animating, 'wxss 有 .sheet-panel.animating 规则');
const aBody = animating ? animating[1] : '';
chk(/transition:/.test(aBody) && /min-height/.test(aBody) && /max-height/.test(aBody),
  '⚠️ .animating 同时过渡 **min-height 和 max-height**（成对夹紧，方向才对称）');
chk(!/(^|[^-])height:\s*\d/.test(aBody),
  '⚠️ .animating 不过渡 height 本身（面板常态是 auto，auto 不可插值 ⇒ 第一版就栽在这）');
// ⚠️ transition 是**简写属性、会整条覆盖** ⇒ 必须把 transform 一并写上，
//    否则挂 .animating 的这 220ms 里面板的位移过渡会一起消失。
chk(/transform/.test(aBody),
  '⚠️ .animating 里**必须带 transform**（transition 简写会整条覆盖，不带 ⇒ 位移过渡被抹掉）');
chk(!/transition:\s*all/.test(aBody),
  '⚠️ .animating 不写 transition: all（会把 opacity 等一起过渡，出现拖影）');
// min/max 的时长与曲线必须一致，否则夹紧区不是一个整体在动（先撞一头再被另一头拽回）
const minT = /min-height\s+(\d+ms)([^,;]*)/.exec(aBody);
const maxT = /max-height\s+(\d+ms)([^,;]*)/.exec(aBody);
chk(!!minT && !!maxT && minT[1] === maxT[1] && minT[2].trim() === maxT[2].trim(),
  '⚠️ min/max-height 的时长与曲线完全一致（不一致 ⇒ 夹紧区抽搐）');

// wxss 的 78vh / 92vh 必须与 JS 常量对齐（改了档位不同步 ⇒ 小屏机上地板超过上限）
chk(/max-height:\s*78vh/.test(wxss), 'wxss .sheet-panel 的 max-height 是 78vh（对应 CAP_RATIO）');
chk(/\.sheet-panel\.tall\s*\{\s*max-height:\s*92vh;?\s*\}/.test(wxss),
  'wxss .sheet-panel.tall 的 max-height 是 92vh（对应 CAP_RATIO_TALL）');

// 内联 style 必须用「整段声明 + 分号」，不能是裸数值插值（check-inline-style-join 同源纪律）
chk(/\{\{resizeStyle\}\}/.test(wxml) && !/\{\{resizeH/.test(wxml),
  'wxml 用整段字段 {{resizeStyle}}，不是裸数值（裸数值会触发内联 style 分隔符门禁）');
chk(/;\{\{resizeStyle\}\};\{\{dragStyle\}\}/.test(wxml),
  '⚠️ resizeStyle 两侧都有 `;`（相邻插值不分隔 ⇒ 上一条声明粘进下一条属性名）');

// 调用点：只有请假两个弹层开
const rosterSheets = roster.match(/<bottom-sheet[^>]*>/g) || [];
const animSheets = rosterSheets.filter((s) => /resizeAnim/.test(s));
chk(rosterSheets.length > 0, '能解析到 roster 里的 bottom-sheet 标签');
chk(animSheets.length === 2,
  '⚠️ 全仓只有 **2 个**弹层开 resizeAnim（请假登记 + 请假名单），实际 ' + animSheets.length + ' 个');
chk(animSheets.every((s) => /id="leave(Sheet|ViewSheet)"/.test(s)),
  '开的两处都带 id（页面要用 selectComponent 拿实例）');
const otherPages = fs.readdirSync(path.join(ROOT, 'miniprogram/pages'))
  .filter((d) => d !== 'roster')
  .map((d) => {
    const f = path.join(ROOT, 'miniprogram/pages', d, 'index.wxml');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  }).join('\n');
chk(!/resizeAnim/.test(otherPages),
  '⚠️ 其他页面一个都没开 resizeAnim（默认关的纪律没被绕过）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ③ 静态：四条最容易静默失效的性质');

const animFn = /_animateResize\(\)\s*\{([\s\S]*?)\n    \},\n/.exec(js);
chk(!!animFn, '能定位到 _animateResize');
if (animFn) {
  const body = animFn[1];
  chk(/const from = this\._lastPanelH/.test(body),
    '① from 取自 **this._lastPanelH**（组件自己记的上一次高度），不是本次量出来的高度');
  chk(/sc\.contentHeight\(\)/.test(body),
    '② 目标高度来自 **spring-scroll.contentHeight()**（内容自然高，transform 免疫）');
  chk(/let to = m\.chrome \+ contentH/.test(body),
    '② 目标 = chrome（头尾固定高）+ contentH，**不是量面板**（夹紧后量面板恒等于夹紧值）');
  chk(!/to = m\.panel|to = rect\.height|to = m\.h\b/.test(body),
    '② 目标高度没有取「面板自身高度」的写法');
  chk(/if \(this\._anim \|\| this\._drag\) return;/.test(body),
    '拖拽/回弹进行中放行（不与 transform 抢）');
  chk(/if \(!this\.data\.active\) return;/.test(body), '入场未开始（active 假）放行');
  chk(/OPEN_SETTLE_MS/.test(body),
    '⑤ 开场静默期守卫在位（只判 active 拦不住 20ms 后就 active 的入场段）');
  chk(/RESIZE_MIN_DIFF/.test(body),
    '最小区差守卫在位（内容微调也播动画 → 观感卡顿）');
  chk(/if \(this\.properties\.height\) return;/.test(body),
    '固定高度弹层放行（传了 height 的弹层高度不由内容决定）');
  chk(/if \(this\._resizeEndTimer\) \{ this\._resizePending = true; return; \}/.test(body),
    '重入保护在位（上一段过渡未跑完时不打断，但要置 pending 留补算）');
}

const clampFn = /_setResizeClamp\(px, animate\)\s*\{([\s\S]*?)\n    \},\n/.exec(js);
chk(!!clampFn, '能定位到 _setResizeClamp');
if (clampFn) {
  const body = clampFn[1];
  chk(/min-height:/.test(body) && /max-height:/.test(body),
    '③ 夹紧值**成对**下发（min + max 都写；只写一个方向面板会被钉死）');
  chk(/const style = /.test(body) && /setData\(\{ resizeStyle: style/.test(body),
    '③ 两个值写进**同一个** style 串（保证同一拍生效，不会出现只有一头动）');
  // ④ 两拍：先只挂 class，改值必须落在 setTimeout 里
  const armIdx = body.indexOf("setData({ resizeCls: 'animating' })");
  const setIdx = body.indexOf('setData({ resizeStyle: style })');
  chk(armIdx >= 0, '④ 有「只挂 .animating、不改高度」的那一拍');
  chk(setIdx > armIdx, '⚠️ 改高度值发生在挂 class **之后**（同批 setData 会被合并 ⇒ 无动画）');
  chk(/TRANSITION_ARM_MS/.test(body), '④ 两拍之间的等待用 TRANSITION_ARM_MS');
  chk(/this\._resizeEndTimer = setTimeout/.test(body) && /resizeCls: ''/.test(body),
    '过渡跑完撤掉过渡类（否则下次内容变化从旧曲线起播）');
}

const measFn = /_measureHeights\(cb\)\s*\{([\s\S]*?)\n    \},\n/.exec(js);
chk(!!measFn, '能定位到 _measureHeights');if (measFn) {
  const body = measFn[1];
  chk(/q\.select\('\.sheet-spring'\)/.test(body),
    "⑥ body 选的是 **.sheet-spring**（v1.0.5 起 body 已换成 spring-scroll）");
  chk(!/\.sheet-body'/.test(body),
    "⚠️ 不选 .sheet-body（该类 wxml 里不存在 ⇒ 恒为 null ⇒ 整段 return，动画静默失效）");
  chk(/fields\(\{ size: true \}\)/.test(body),
    '用 fields({size:true}) 取布局尺寸（boundingClientRect 量的是含 transform 的视觉矩形）');
  chk(/panel\.height - body\.height/.test(body), 'chrome = 面板布局高 − body 布局高');
  chk(/self\._capPx\(\)|this\._capPx\(\)/.test(body), '上限走 _capPx()（不解析 vh/calc 原串）');
}

/* ---- ⑦ 顺序铁律：先重测、再算高度（v1.0.7 修「选择同学不显示成员」）----
 * spring-scroll 的 `contentHeight()` 读的是 `_contentH`，而它**只在 `_measure()` 的
 * 异步 selector query 回调里更新** ⇒ 「先算高度后重测」拿到的是上一轮的旧高度，
 * 夹紧值被锁在偏矮的数字上，面板再也长不高（成员名单渲染了却被裁掉）。
 * 这一段钉死两件事：调用顺序，以及 spring-scroll.resize 确实支持回调。 */
const scrollFn = /resizeScroll\(\)\s*\{([\s\S]*?)\n    \},\n/.exec(js);
chk(!!scrollFn, '能定位到 resizeScroll');
if (scrollFn) {
  const b = scrollFn[1];
  const iResize = b.search(/sc\.resize\(/);
  const iAnim = b.search(/_animateResize\(\)/);
  chk(iResize >= 0, 'resizeScroll 里有 sc.resize(...) 调用');
  chk(iAnim >= 0, 'resizeScroll 里有 _animateResize() 调用');
  // ⚠️ 判据的极性：`_animateResize()` 必须**只出现在 resize 的回调里**。
  //    只要它出现在 `sc.resize(` **之前**（或不在回调里），就是旧顺序 ⇒ 必须判死。
  const afterResize = iResize >= 0 ? b.slice(iResize) : '';
  chk(afterResize.indexOf('_animateResize()') >= 0,
    '⚠️⚠️ _animateResize() 在 sc.resize(...) **之后**执行（必须先重测、再算高度）');
  chk(iResize >= 0 && iAnim > iResize,
    '⚠️⚠️ sc.resize 的位置在 _animateResize 之前（旧顺序会读到陈旧 contentH ⇒ 面板被锁矮、内容被裁）');
  chk(/sc\.resize\(\(\)\s*=>\s*this\._animateResize\(\)\)|sc\.resize\(\s*function\s*\(\)\s*\{[\s\S]*?_animateResize/.test(b),
    '⚠️ _animateResize 挂在 sc.resize 的**回调**里（回调在 _contentH 更新完之后才触发）');
}
const ssJs = read('miniprogram/components/spring-scroll/index.js');
const ssResize = /resize\(cb\)\s*\{([\s\S]*?)\n    \},/.exec(ssJs);
chk(!!ssResize, 'spring-scroll 的 resize 接受回调参数 resize(cb)');
if (ssResize) {
  chk(/this\._measure\(/.test(ssResize[1]),
    '⚠️ spring-scroll.resize 用 _measure 重测（不是拿缓存值直接返回）');
  chk(/if \(typeof cb === 'function'\) cb\(\);/.test(ssResize[1]),
    "⚠️ spring-scroll.resize 在重测完成后触发 cb()（'typeof cb === 'function''）");
  // 顺序：cb 必须在 _maxScroll 夹紧之后（夹紧会 setData，cb 里紧接着算高度才拿到最新布局）
  chk(ssResize[1].indexOf("typeof cb === 'function'")
      > ssResize[1].indexOf('this._maxScroll'),
    '⚠️ cb 在 _maxScroll 夹紧**之后**触发（夹紧 setData 之后布局才最终确定）');
}

// 兜底：300ms 铺完初值后必须再补一拍高度重算（静默期内的调用不会算高度）
chk(/self\.resizeScroll\(\);/.test(js) && /}, 300\);/.test(js),
  '⚠️ 300ms 铺完夹紧初值后补调一次 resizeScroll（静默期内的调用不算高度，名单后到就永远不补）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ④ 行为层：把 _animateResize / _setResizeClamp 真跑一遍');

/**
 * 抽出单个方法**连方法名一起**编译成可调用函数。
 * ⚠️ 三个坑（抽组件方法做行为测试时反复踩的）：
 *   ① 只切 `{…}` 不带方法名 ⇒ `return _animateResize() {…}` 语法错误；
 *   ② 对象方法简写（`name() {…}`）**不能当独立表达式** ⇒ 必须补 `function ` 前缀；
 *   ③ 定位要先剥注释，否则 JSDoc 里的 `{…}` 会被当成方法体起点；
 *      且定位与切片必须用**同一份** stripped（用原文同下标切会错位）。
 */
function compile(src, name) {
  const i = src.indexOf('\n    ' + name + '(');
  if (i < 0) throw new Error('找不到方法 ' + name);
  const raw = src.slice(i + 1);
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  const k = stripped.indexOf('{');
  let d = 0;
  for (let j = k; j < stripped.length; j++) {
    if (stripped[j] === '{') d++;
    else if (stripped[j] === '}') { d--; if (d === 0) return raw.slice(0, j + 1); }
  }
  throw new Error('方法 ' + name + ' 花括号不配平');
}

/**
 * 编译成可 new Function 的形式。
 * ⚠️ `deps` 必须把**组件模块作用域的常量/宿主全局**注入进来 ——
 *    `new Function` 建出来的函数在**全局作用域**里跑，取不到外层 const ⇒ ReferenceError。
 */
function toFunction(src, name, deps) {
  const body = compile(src, name);
  const m = /^\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/.exec(body);
  if (!m) throw new Error('签名解析失败：' + body.slice(0, 60));
  const names = (deps || []).map((d) => d.n);
  const vals = (deps || []).map((d) => d.v);
  const plain = 'function ' + m[1] + '(' + m[2] + ') ' + body.slice(m[0].length - 1);
  const f = new Function(names.join(','), 'return (' + plain + ');');
  return names.length ? f.apply(null, vals) : f();
}

/** 从组件源码里把 `const NAME = <数字>;` 的值抽出来，作为注入的依赖 */
function constsOf(src) {
  const want = ['RESIZE_ANIM_MS', 'RESIZE_MIN_DIFF', 'OPEN_SETTLE_MS', 'TRANSITION_ARM_MS'];
  return want.map((n) => {
    const m = new RegExp('const\\s+' + n + '\\s*=\\s*(\\d+)').exec(src);
    return { n, v: m ? Number(m[1]) : NaN };
  });
}

const CAP_RATIO = 0.78;
const CAP_RATIO_TALL = 0.92;

/**
 * 造一个假组件实例。
 * @param opts.contentH  spring-scroll 量到的内容自然高
 * @param opts.chrome    头尾固定高（面板布局高 − body 布局高）
 * @param opts.capPx     面板上限（仅在 stubCap 为真时生效）
 * @param opts.stubCap   true = 用 opts.capPx 顶掉 _capPx（测 _animateResize 时用固定上限）；
 *                       不传/false = 走**真实** _capPx，由 opts.winH + opts.capStyle 决定
 * @param opts.winH      窗口高（喂给假 getApp；**显式 0 合法**，表示「拿不到」）
 * @param opts.capStyle  面板内联的胶囊上限串（真实 _capPx 会解析它）
 * @param opts.rectH     _measurePanelH（boundingClientRect）量到的高度
 */
function makeInst(src, opts) {
  const o = opts || {};
  const data = {
    active: true,
    capStyle: o.capStyle || '',
    resizeStyle: '',
    resizeCls: '',
    dragging: false,
    dragStyle: '',
    maskStyle: ''
  };
  const timers = [];
  // ⚠️ 组件源码里用的是**裸 `setTimeout` / `clearTimeout`**（模块作用域）。
  //    `new Function` 建出来的函数在全局作用域跑 → 打到 Node 真定时器，断言永远等不到。
  //    必须作为**参数注入**。⚠️ getApp 同理（`_capPx` 里用到），也必须注入。
  // ⚠️ `o.winH === undefined ? 812 : o.winH` 而不是 `o.winH || 812` ——
  //    后者会把「显式传 0（表示拿不到窗口高）」也变成 812，测不出 `_capPx` 的兜底分支。
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const fakeClearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const fakeGetApp = () => ({ globalData: { windowHeight: o.winH === undefined ? 812 : o.winH } });

  // ⚠️ contentH 做成**可变**：模拟真实 spring-scroll 里 `_contentH` 只在 `_measure()` 的
  //    异步 selector query 回调里才更新。`resize(cb)` 被调用后才把 contentH 换成
  //    `contentHAfter` 再触发 cb —— 这正是「先重测、再算高度」能成立的机制，
  //    也是「先算高度、后重测」必然读到旧值的机制（v1.0.7「选择同学不显示成员」的根因）。
  const live = { contentH: o.contentH || 0 };

  const inst = {
    data,
    properties: { resizeAnim: true, height: 0, tall: true },
    sets: [],
    timers,
    _lastPanelH: 480,
    _openedAt: 0,   // 0 = 早已打开（不触发静默期）
    selectComponent(sel) {
      if (sel !== '#sheetScroll') return null;
      return {
        contentHeight() { return live.contentH || 0; },
        resize(cb) {
          if (o.contentHAfter !== undefined) live.contentH = o.contentHAfter;
          if (typeof cb === 'function') cb();
        }
      };
    },
    createSelectorQuery() {
      const targets = [];
      const api = {
        select(sel) {
          const rec = { sel, node: null };
          targets.push(rec);
          return {
            fields() { rec.node = { height: sel === '.sheet-panel' ? (o.panelH || 0) : (o.bodyH || 0) }; return api; },
            boundingClientRect(cb) {
              rec.node = { height: o.rectH || 0 };
              if (typeof cb === 'function') cb(rec.node);
              return { exec() { api.exec(); return api; } };
            }
          };
        },
        exec(cb) {
          const res = targets.map((t) => t.node);
          if (typeof cb === 'function') cb(res);
          return api;
        }
      };
      return api;
    },
    setData(p) { Object.assign(data, p); inst.sets.push(p); }
  };
  const inject = constsOf(src).concat([
    { n: 'CAP_RATIO', v: CAP_RATIO },
    { n: 'CAP_RATIO_TALL', v: CAP_RATIO_TALL },
    { n: 'getApp', v: fakeGetApp },
    { n: 'setTimeout', v: fakeSetTimeout },
    { n: 'clearTimeout', v: fakeClearTimeout }
  ]);
  ['_animateResize', '_measureHeights', '_capPx', '_setResizeClamp', '_playResize',
    '_measurePanelH', 'resizeScroll']
    .forEach((n) => { inst[n] = toFunction(src, n, inject).bind(inst); });
  // ⚠️ stub 必须放在注入**之后** —— 否则会被上面这轮真方法覆盖掉，
  //    固定上限 capPx 静默失效，测出来的 to 全是「真实 _capPx 算出来的值」。
  if (o.stubCap) inst._capPx = function () { return o.capPx || 0; };
  return inst;
}

/** 从夹紧 style 串里解出数值（`min-height:480px; max-height:480px;` ⇒ 480） */
function clampOf(setPatch) {
  const s = String((setPatch || {}).resizeStyle || '');
  const m = /min-height:\s*([\d.]+)px;\s*max-height:\s*([\d.]+)px;/.exec(s);
  return m ? { min: Number(m[1]), max: Number(m[2]) } : null;
}

/* 变矮：9 条 → 1 条。chrome=80，content 300 ⇒ to=380；from=480 */
const chrome = 80;
const A = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
A._animateResize();

chk(A.timers.length >= 2, '高度变化时排了后续定时器（动画在跑，不是瞬变）');
// 拍 1：只挂过渡类，**不改**高度
const arm = A.sets[0];
chk(!!arm && arm.resizeCls === 'animating' && arm.resizeStyle === undefined,
  '拍 1 只挂 .animating（高度不动 ⇒ 不会先把面板拽到旧值造成回跳闪烁）');
chk(A.timers[0] && A.timers[0].ms >= 16,
  '⚠️ 拍 2（真正改高度）在 **setTimeout ≥16ms** 之后（同一批 setData 会被合并 ⇒ 无动画）');
A.timers[0] && A.timers[0].fn();
const moved = A.sets.find((s) => s.resizeStyle !== undefined);
const cv = clampOf(moved);
chk(!!cv, '拍 2 下发了夹紧 style（实际 ' + ((moved && moved.resizeStyle) || '无') + '）');
chk(!!cv && cv.min === 380 && cv.max === 380,
  '⚠️ 夹紧值 min 与 max **成对且同值** = 380（chrome 80 + content 300）');
chk(!!moved && moved.resizeCls === undefined,
  '拍 2 不带 resizeCls（过渡类已在拍 1 挂好，重挂会走同批合并的老路）');
const tail = A.timers[1];
chk(tail && tail.ms >= 200, '⚠️ 收尾定时器 ≥200ms（一帧 + 过渡时长 + 余量）');
tail && tail.fn();
chk(A.sets[A.sets.length - 1].resizeCls === '', '收尾撤掉 .animating（否则下次从旧曲线起播）');
chk(A._lastPanelH === 380, '过渡后 _lastPanelH 更新为目标高度（下次变化有正确的起点）');

/* 变高：1 条 → 9 条。方向必须与变矮**完全对称**（这是本轮修的核心） */
const B = makeInst(js, { contentH: 700, chrome, stubCap: true, capPx: 800, panelH: 380, bodyH: 300 });
B._lastPanelH = 380;
B._animateResize();
const bArm = B.sets[0];
chk(!!bArm && bArm.resizeCls === 'animating' && bArm.resizeStyle === undefined,
  '⚠️ 变高时拍 1 同样只挂 class（min-height 单独用在这里会漏 —— auto 会立刻顶上去）');
B.timers[0] && B.timers[0].fn();
const bCv = clampOf(B.sets.find((s) => s.resizeStyle !== undefined));
chk(!!bCv && bCv.min === 780 && bCv.max === 780,
  '⚠️ 变高时 min 与 max **同时**升到 780（成对 ⇒ 与变矮完全对称，不会硬跳变）');

/* 上限夹取：内容比面板上限还长 ⇒ 目标被 cap 住（不能把地板放到上限之外） */
const Cp = makeInst(js, { contentH: 5000, chrome, stubCap: true, capPx: 800, panelH: 780, bodyH: 700 });
Cp._lastPanelH = 380;
Cp._animateResize();
Cp.timers[0] && Cp.timers[0].fn();
const cCv = clampOf(Cp.sets.find((s) => s.resizeStyle !== undefined));
chk(!!cCv && cCv.max === 800, '内容超长时夹紧值被面板上限 cap 住（实际 ' + (cCv && cCv.max) + '）');

/* 无变化 / 首次 / 微小变化：不播 */
const D = makeInst(js, { contentH: 400, chrome, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
D._animateResize();
chk(D.timers.length === 0 && D.sets.length === 1 && D.sets[0].resizeCls === '',
  '高度没变（480→480）时不挂过渡类（只对齐夹紧值）');
const E = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
E._lastPanelH = 0;
E._animateResize();
chk(E.timers.length === 0 && E.sets.length === 1 && E.sets[0].resizeCls === '',
  '首次进入（无 _lastPanelH）放行 —— 不播「从 0 长出来」的假动画');
const I = makeInst(js, { contentH: 404, chrome, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
I._animateResize();
chk(I.timers.length === 0 && I.sets[0].resizeCls === '',
  '⚠️ 守卫：变化 < RESIZE_MIN_DIFF(8px) ⇒ 不播（观感卡顿）');

/* 内容高度还没量出来过（contentHeight() 返回 0）⇒ 必须放行，绝不能把夹紧值砸成 0 */
const Z = makeInst(js, { contentH: 0, chrome, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
Z._animateResize();
chk(Z.sets.length === 0 && Z.timers.length === 0,
  '⚠️ 内容高未量出（contentHeight()=0）⇒ 完全放行（否则面板瞬间塌成一条）');

/* 守卫：不 resizeAnim / 固定 height / 拖拽中 / 开场静默期 / active 假 / 上一段未跑完 */
const G1 = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800 });
G1.properties.resizeAnim = false; G1._animateResize();
chk(G1.sets.length === 0, '守卫：resizeAnim=false ⇒ 不动');
const G2 = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800 });
G2.properties.height = 1200; G2._animateResize();
chk(G2.sets.length === 0, '守卫：固定高度弹层（props.height）⇒ 不动');
const G3 = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800 });
G3._anim = { t0: Date.now(), from: 0, to: 100, dur: 300 }; G3._animateResize();
chk(G3.sets.length === 0, '守卫：拖拽/回弹动画中 ⇒ 不动');
const G4 = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800 });
G4._openedAt = Date.now(); G4._animateResize();
chk(G4.sets.length === 0, '⚠️ 守卫：开场静默期内 ⇒ 不动（active 已 true 但入场 transform 在跑）');
const G5 = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800 });
G5.data.active = false; G5._animateResize();
chk(G5.sets.length === 0, '守卫：active=false（入场未开始）⇒ 不动');
const G6 = makeInst(js, { contentH: 300, chrome, stubCap: true, capPx: 800 });
G6._resizeEndTimer = 1; G6._animateResize();
chk(G6.sets.length === 0, '守卫：上一段过渡还在跑 ⇒ 忽略重入（不会打断正在播的动画）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ④ 之二 行为复现：「成员加载后高度算错」（v1.0.7 用户实拍 bug）');

/**
 * 完整复现用户现象：
 *   弹层刚打开时成员列表还是空的 ⇒ spring-scroll 量到的 contentH 只有 200（很矮）
 *   → 名单回来后 resizeScroll() 被调 ⇒ 此时 contentH **要等 resize 之后**才变成 700
 *   → 正确顺序下算出的 to = 80 + 700 = 780（面板长高，成员全部可见）
 *   → 旧顺序下算出的 to = 80 + 200 = 280（面板被锁在矮值，成员被裁掉）
 */
{
  const P = makeInst(js, {
    contentH: 200, contentHAfter: 700, stubCap: true, capPx: 900,
    panelH: 280, bodyH: 200
  });
  P._lastPanelH = 280;
  P.resizeScroll();
  const pm = P.sets[0];
  chk(!!pm && pm.resizeCls === 'animating' && pm.resizeStyle === undefined,
    '该场景走的是正常两拍路径（拍 1 只挂 .animating，不改高度 ⇒ 上面那条不是恒真）');
  if (P.timers[0]) P.timers[0].fn();
  const pcv = clampOf(P.sets.find((s) => s.resizeStyle !== undefined));
  chk(!!(pcv && pcv.max === 780),
    '⚠️⚠️ 名单加载后 resizeScroll 算出的夹紧值 = 780（chrome80 + **重测后**的 contentH 700）'
    + '，实际 ' + (pcv && pcv.max) + '（=280 就是「先算高度后重测」那个 bug ⇒ 成员被裁）');
}

/* 重入保护不能把高度变化**丢掉**：过渡期间来的请求要置 pending，收尾时补算 */
{
  const Q = makeInst(js, { contentH: 300, contentHAfter: 700, stubCap: true, capPx: 900, panelH: 480, bodyH: 400 });
  Q._resizeEndTimer = 1;              // 假装上一段过渡还在跑
  Q.resizeScroll();
  chk(Q.sets.length === 0, '过渡进行中 ⇒ 不动（不打断正在播的动画）');
  chk(Q._resizePending === true,
    '⚠️ 但要置 _resizePending（直接丢弃 = 那次高度变化永久丢失 ⇒ 面板停在过时夹紧值上）');
}

/* 收尾定时器必须真的补算 pending 那一拍 */
{
  const R = makeInst(js, { contentH: 700, stubCap: true, capPx: 900, panelH: 480, bodyH: 400 });
  R._lastPanelH = 480;
  R._resizePending = true;
  R._resizeEndTimer = 1;
  // 直接驱动收尾回调：真跑 _setResizeClamp 会重排定时器，这里改为手工模拟其收尾分支
  const srcClamp = compile(js, '_setResizeClamp');
  chk(/if \(self\._resizePending\)/.test(srcClamp) && /self\._animateResize\(\);/.test(srcClamp),
    '⚠️ 收尾定时器里有「pending ⇒ 再算一次 _animateResize」');
}

/* _capPx 行为：档位 × 窗口高，且胶囊上限更严时取小 */const K = makeInst(js, { winH: 800 });
chk(K._capPx() === 800 * CAP_RATIO_TALL,
  '_capPx：tall 弹层按 CAP_RATIO_TALL × 窗口高（实际 ' + K._capPx() + '）');
K.data.capStyle = 'max-height:calc(100vh - 740px);';
chk(K._capPx() === 60, '⚠️ _capPx：胶囊上限更严时取小（800-740=60，实际 ' + K._capPx() + '）');
const K2 = makeInst(js, { winH: 0 });
chk(K2._capPx() === 0, '_capPx：拿不到窗口高 ⇒ 返回 0（交回 auto，不硬夹）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ⑤ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

/** 跑一遍静态 + 行为判据，返回失败条数；只用于变异对比 */
function judge(src) {
  let n = 0;
  const push = (c) => { if (!c) n += 1; };
  const anim = /_animateResize\(\)\s*\{([\s\S]*?)\n    \},\n/.exec(src);
  const clamp = /_setResizeClamp\(px, animate\)\s*\{([\s\S]*?)\n    \},\n/.exec(src);
  const meas = /_measureHeights\(cb\)\s*\{([\s\S]*?)\n    \},\n/.exec(src);
  if (!anim || !clamp || !meas) return 100;
  const ab = anim[1], cb2 = clamp[1], mb = meas[1];
  push(/const from = this\._lastPanelH/.test(ab));
  push(/sc\.contentHeight\(\)/.test(ab));
  push(/let to = m\.chrome \+ contentH/.test(ab));
  push(/OPEN_SETTLE_MS/.test(ab));
  push(/RESIZE_MIN_DIFF/.test(ab));
  push(/properties\.height\) return/.test(ab));
  push(/this\._anim \|\| this\._drag\) return/.test(ab));
  push(/!this\.data\.active\) return/.test(ab));
  push(/this\._resizeEndTimer\) return/.test(ab) || /_resizeEndTimer\) \{ this\._resizePending = true; return; \}/.test(ab));
  // ③ 成对
  push(/min-height:/.test(cb2) && /max-height:/.test(cb2));
  // ④ 两拍
  const armIdx = cb2.indexOf("setData({ resizeCls: 'animating' })");
  const setIdx = cb2.indexOf('setData({ resizeStyle: style })');
  push(armIdx >= 0 && setIdx > armIdx);
  push(/TRANSITION_ARM_MS/.test(cb2));
  // ⑥ 选择器
  push(/q\.select\('\.sheet-spring'\)/.test(mb) && !/\.sheet-body'/.test(mb));

  // ---- 行为：变矮 ----
  const shrink = (s, over) => {
    const i = makeInst(s, over || { contentH: 300, chrome: 80, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
    i._animateResize();
    return i;
  };
  const a = shrink(src);
  push(a.timers.length >= 2);
  push(!!a.sets[0] && a.sets[0].resizeCls === 'animating' && a.sets[0].resizeStyle === undefined);
  push(!!(a.timers[0] && a.timers[0].ms >= 16));
  if (a.timers[0]) a.timers[0].fn();
  const cv = clampOf(a.sets.find((s2) => s2.resizeStyle !== undefined));
  push(!!cv && cv.min === 380 && cv.max === 380);
  push(a._lastPanelH === 380);

  // ---- 行为：变高（方向对称）----
  const b = shrink(src, { contentH: 700, chrome: 80, stubCap: true, capPx: 800, panelH: 380, bodyH: 300 });
  b._lastPanelH = 380;
  b._animateResize();
  push(!!b.sets[0] && b.sets[0].resizeCls === 'animating' && b.sets[0].resizeStyle === undefined);
  if (b.timers[0]) b.timers[0].fn();
  const bcv = clampOf(b.sets.find((s2) => s2.resizeStyle !== undefined));
  push(!!bcv && bcv.min === 780 && bcv.max === 780);

  // ---- 行为：上限 ----
  const c = shrink(src, { contentH: 5000, chrome: 80, stubCap: true, capPx: 800, panelH: 780, bodyH: 700 });
  c._lastPanelH = 380;
  c._animateResize();
  if (c.timers[0]) c.timers[0].fn();
  const ccv = clampOf(c.sets.find((s2) => s2.resizeStyle !== undefined));
  push(!!ccv && ccv.max === 800);

  // ---- 行为：最小差值（必须行为层验，只查源码有那四个字不够）----
  const tiny = shrink(src, { contentH: 404, chrome: 80, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
  push(tiny.timers.length === 0 && tiny.sets[0] && tiny.sets[0].resizeCls === '');
  // 同样要验「够大时确实播」—— 防守卫被写成永远放行
  push(a.timers.length > 0);
  // 内容高未量出 ⇒ 放行
  const z = shrink(src, { contentH: 0, chrome: 80, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
  push(z.sets.length === 0);
  // 重入
  const re = shrink(src, { contentH: 300, chrome: 80, stubCap: true, capPx: 800, panelH: 480, bodyH: 400 });
  re._resizeEndTimer = 1;
  re._animateResize();
  push(re.sets.length === 0);

  // ---- 行为：⑦ 顺序（先重测、再算高度）----
  const rf = /resizeScroll\(\)\s*\{([\s\S]*?)\n    \},\n/.exec(src);
  if (!rf) return n + 1;
  const rb = rf[1];
  const iRs = rb.search(/sc\.resize\(/);
  const iAn = rb.search(/_animateResize\(\)/);
  push(iRs >= 0 && iAn > iRs);
  push(iRs >= 0 && rb.slice(iRs).indexOf('_animateResize()') >= 0);
  // 陈旧 contentH 场景：名单加载后必须算 780 而不是 280
  const pp = makeInst(src, {
    contentH: 200, contentHAfter: 700, stubCap: true, capPx: 900, panelH: 280, bodyH: 200
  });
  pp._lastPanelH = 280;
  pp.resizeScroll();
  if (pp.timers[0]) pp.timers[0].fn();
  const pcv2 = clampOf(pp.sets.find((s2) => s2.resizeStyle !== undefined));
  push(!!pcv2 && pcv2.max === 780);
  // 重入要置 pending（不能把高度变化丢掉）
  const qq = makeInst(src, { contentH: 300, contentHAfter: 700, stubCap: true, capPx: 900, panelH: 480, bodyH: 400 });
  qq._resizeEndTimer = 1;
  qq.resizeScroll();
  push(qq.sets.length === 0);
  push(qq._resizePending === true);
  // 收尾补算
  push(/if \(self\._resizePending\)/.test(src) && /self\._animateResize\(\);/.test(src));
  // 300ms 兜底补调
  push(/self\.resizeScroll\(\);/.test(src));
  return n;
}

const MUT = [
  {
    // ⚠️ 变异必须**真能跑**（写成 `const from = to` → TDZ ReferenceError，
    //    报错被当成「抓到了」= 假自证）。这里模拟「目标高度误取 from」这一族错误写法：
    //    `to = from` 语法合法、能跑，语义上等价于「from 恒等于 to」⇒
    //    差值恒 0 ⇒ 永远不播动画、**且不报错**（本功能最容易写废的形态）。
    name: 'M1 目标高度误取 from（from 恒等于 to ⇒ 永不动画且不报错）',
    from: 'let to = m.chrome + contentH;',
    to: 'let to = from;'
  },
  {
    // ⚠️ 锚点必须唯一且逐字真实（写成 `self._resizeAnimTimer` 而源码是
    //    `this._resizeAnimTimer` ⇒ indexOf 返回 -1 ⇒ replace 静默不生效
    //    ⇒ 变异「没抓到」会被误报成「锚点漂移」）。
    // ⚠️ 变异体也必须**语法合法**（把 setTimeout(function () { 换成
    //    `0; if (true) {` ⇒ 收尾的 `}, 16);` 变悬空逗号 ⇒ SyntaxError，
    //    报错被当成「抓到」同样是假自证）。所以只把**延迟参数** 16 改成 0：
    //    仍是两拍、仍能跑，只是「不等布局提交」—— 行为判据
    //    「改高度必须 ≥16ms」必须能把它判死。
    name: 'M2 两拍不等布局提交（16ms → 0ms，WebView 合并两次 style ⇒ 不跳但也没动画）',
    from: '}, TRANSITION_ARM_MS);',
    to: '}, 0);'
  },
  {
    name: 'M3 删掉开场静默期守卫（active 已 true 但入场 transform 在跑 ⇒ 抢属性）',
    from: 'if (this._openedAt && (Date.now() - this._openedAt) < OPEN_SETTLE_MS) return;',
    to: ''
  },
  {
    name: 'M4 删掉最小区差守卫（内容微调也播动画 ⇒ 观感卡顿）',
    from: 'if (Math.abs(to - from) < RESIZE_MIN_DIFF) {',
    to: 'if (false) {'
  },
  {
    // ⚠️ 本轮修的核心：只写 min-height 时「变高」会被 height:auto 立刻顶上去 ⇒ 硬跳变。
    name: 'M5 只写 min-height 不写 max-height（变高退回硬跳变，本轮修的核心 bug）',
    from: "const style = 'min-height:' + px + 'px; max-height:' + px + 'px;';",
    to: "const style = 'min-height:' + px + 'px;';\n      if (!animate) this.setData({ maxHeightX: px });"
  },
  {
    // ⚠️ 第一版实打实踩的坑：`.sheet-body` 这个类 wxml 里不存在
    //    ⇒ 恒为 null ⇒ 整段 return ⇒ 高度过渡静默失效（不报错、不动画）。
    name: 'M6 body 选择器改回 .sheet-body（wxml 里不存在 ⇒ 量不到 body ⇒ 静默失效）',
    from: "q.select('.sheet-spring').fields({ size: true });",
    to: "q.select('.sheet-body').fields({ size: true });"
  },
  {
    // ⚠️ 本轮修的核心：顺序反了。`contentHeight()` 读的是 `_measure()` 异步更新的
    //    `_contentH`，先算高度 ⇒ 拿到上一轮的旧值 ⇒ 夹紧值锁在偏矮数字上，
    //    面板再也长不高 ⇒ 成员名单渲染了却被裁掉（用户实拍：只显示到第 12 个，
    //    输序号才出来 —— 因为输序号时上一轮的 resize 已经把 _contentH 更新对了）。
    //    变异体语法合法、能跑，只是把回调去掉、把调用提到前面。
    name: 'M7 resizeScroll 顺序反回「先算高度后重测」（读到陈旧 contentH ⇒ 面板锁矮、内容被裁）',
    from: 'if (sc && sc.resize) sc.resize(() => this._animateResize());\n      else this._animateResize();',
    to: 'this._animateResize();\n      if (sc && sc.resize) sc.resize();'
  },
  {
    // ⚠️ 重入保护把高度变化**丢掉**：过渡进行中（276ms）来的请求被 return 掉，
    //    收尾时没人补算 ⇒ 内容变了但夹紧值停在过时高度（偏矮时同样裁内容）。
    name: 'M8 收尾不补算 pending（过渡期间那次高度变化被永久丢弃）',
    from: 'if (self._resizePending) {\n          self._resizePending = false;\n          self._animateResize();\n        }',
    to: 'self._resizePending = false;'
  },
  {
    // ⚠️ 80ms 那次补量落在 260ms 开场静默期内（只补可滚动范围、**不算高度**），
    //    300ms 铺完初值若不再补一拍，「名单在 300ms 之后回来」这一整类就永远不补高度。
    name: 'M9 删掉 300ms 铺初值后的兜底补调（名单后到时高度永远不重算）',
    from: '              self.resizeScroll();',
    to: '              /* 删掉兜底补调 */'
  }
];

let caught = 0;
MUT.forEach((c) => {
  if (js.indexOf(c.from) < 0) {
    fail('变异「' + c.name + '」锚点已漂移 —— 自证失效，需同步更新锚点');
    bad += 1;
    return;
  }
  const mutated = js.replace(c.from, c.to);
  if (mutated === js) {
    fail('变异「' + c.name + '」替换后源码没变 —— 自证失效');
    bad += 1;
    return;
  }
  let badN;
  try {
    badN = judge(mutated);
  } catch (e) {
    // 变异体语法非法 ⇒ 跑不起来。**不能**当成「抓到了」（那是假自证）
    fail('变异「' + c.name + '」的变异体语法非法（' + e.message + '）—— 变异体必须能真跑');
    bad += 1;
    return;
  }
  if (badN > 0) {
    ok('变异「' + c.name + '」被门禁抓到（' + badN + ' 条判据翻红）');
    caught += 1;
  } else {
    fail('变异「' + c.name + '」**没被抓到** —— 判据失效');
    bad += 1;
  }
});
if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

/* 静态段单独确认（judge 只覆盖 index.js，wxss/调用点另行校验） */
console.log('');
console.log('── ⑥ wxss / 调用点自证');
{
  const seg = (t) => (/\.sheet-panel\.animating\s*\{([^}]*)\}/.exec(t) || ['', ''])[1];
  // 拿掉 max-height 过渡 ⇒ 「成对」判据必须翻红
  // ⚠️ wxss 里 transition 列表是**单行**（check-wxss 不接受跨行以 `,` 结尾），
  //    所以这里按单行片段替换；替换后必须先确认 `badWxss !== wxss` ——
  //    否则 replace 静默不生效，自证就变成「假通过」（判据恒真 ⇒ 看着绿其实没验）。
  const badWxss = wxss.replace(', max-height 220ms cubic-bezier(.22, .61, .36, 1);', ';');
  chk(badWxss !== wxss && !/max-height/.test(seg(badWxss)),
    '自证：拿掉 .animating 的 max-height 过渡后「成对」判据能判死');
  // 把 height 塞回去（第一版的错法）⇒ 必须被判死
  const badH = wxss.replace('min-height 220ms', 'height 220ms');
  chk(/(^|[^-])height:\s*\d/.test(seg(badH)) || !/min-height/.test(seg(badH)),
    '自证：把 min-height 换成 height（第一版的错法）后判据能判死');
  // 拿掉 transform ⇒ 必须判死（transition 简写会整条覆盖）
  const badT = wxss.replace(/transition:\s*transform \.24s cubic-bezier\(\.22, \.61, \.36, 1\),/, 'transition:');
  chk(badT !== wxss && !/transform/.test(seg(badT)),
    '自证：拿掉 .animating 里的 transform 后判据能判死');
  // min/max 时长不一致 ⇒ 必须判死
  const badD = wxss.replace('max-height 220ms cubic-bezier(.22, .61, .36, 1)', 'max-height 400ms ease');
  const dSeg = seg(badD);
  const dMin = /min-height\s+(\d+ms)([^,;]*)/.exec(dSeg);
  const dMax = /max-height\s+(\d+ms)([^,;]*)/.exec(dSeg);
  chk(!dMin || !dMax || dMin[1] !== dMax[1], '自证：min/max 时长不一致后判据能判死');
  // 拿掉调用点的 resizeAnim ⇒ 数量判据必须翻红
  const badRoster = roster.replace(/ resizeAnim="\{\{true\}\}"/g, '');
  const cnt = (badRoster.match(/<bottom-sheet[^>]*>/g) || []).filter((s) => /resizeAnim/.test(s)).length;
  chk(cnt === 0, '自证：拿掉两处 resizeAnim 后「只有 2 个开」判据能判死');
}

console.log('');
if (bad) {
  console.log('[FAIL] ' + bad + ' 项未通过');
  process.exit(1);
}
console.log('[PASS] 弹层高度过渡体检全部通过（属性/接线/静态/行为/9 组变异）');
