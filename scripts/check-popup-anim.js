#!/usr/bin/env node
/**
 * 离线自检：弹层开合动画（mounted / active 两帧机制）
 * ------------------------------------------------------------
 * 起因（2026-09-25 用户反馈）：「这种弹出式小窗现在都是瞬间打开，太僵硬了，需要添加展开动画」。
 *
 * 根因是一个**只要写错就完全静默**的坑：
 *   <view wx:if="{{show}}">
 *     <view class="mask {{show ? 'in' : ''}}">
 * wx:if 在 show 变 true 时才创建节点，而创建时动画类已经在 class 里了 ——
 * 浏览器只看到「元素从不存在 → 直接是终态」，没有起始态，CSS transition 根本不执行。
 * 不报错、不警告、编译通过，只是「啪」地一下出现。
 *
 * 正确写法（见 components/popup-anim.js）：
 *   wx:if 用 mounted（先挂载、处在起始态）→ 下一帧 active 加动画类。
 *
 * 本脚本查三件事：
 *   ① 组件用 behaviors: [popupAnim]，且 show 的 observer 调 animSync（observer 必须留在组件里）；
 *   ② wxml 的 wx:if 是 mounted、动画类是 active，**不得**再出现 `wx:if="{{show}}"`；
 *   ③ wxss 的过渡时长与 popup-anim.js 的 DURATION 一致（不一致会导致「还没滑到位就被卸载」或反之）。
 * 末尾带自证：造一个 `wx:if="{{show}}"` 的样本，必须被抓到。
 *
 * 用法：node scripts/check-popup-anim.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const COMP = path.join(MINI, 'components');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * 去掉注释再匹配。
 * ⚠️ 必须去：这些文件的**注释里就写着反面示例**（「直接写 wx:if="{{show}}" 会瞬间打开」），
 * 不剥离注释的话检查器会把自己的文档判成 bug（本脚本第一版就踩了这个）。
 */
function stripComments(src, kind) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');        // /* */ 块注释
  if (kind === 'wxml') s = s.replace(/<!--[\s\S]*?-->/g, ''); // <!-- --> 
  else s = s.replace(/^\s*\/\/.*$/gm, '');             // // 行注释（js/css 通用近似）
  return s;
}

/** `transition: ... .24s ...` → 240（毫秒）。注意 .24s 的前导点是小数点，不能写成 \.(\d+)s */
function transitionMs(css) {
  const out = [];
  const re = /transition:[^;]*(?:^|[^\d.])(\d*\.?\d+)s/g;
  let m;
  while ((m = re.exec(css))) out.push(Math.round(Number(m[1]) * 1000));
  return out;
}

/* ---------- ① popup-anim.js 本身 ---------- */
console.log('--- ① components/popup-anim.js ---');
const animPath = path.join(COMP, 'popup-anim.js');
if (!fs.existsSync(animPath)) {
  bad('components/popup-anim.js 不存在（三个弹层的动画都靠它）');
  process.exit(1);
}
const animSrc = stripComments(read(animPath), 'js');
const durM = /const\s+DURATION\s*=\s*(\d+)/.exec(animSrc);
if (!durM) bad('popup-anim.js 里找不到 `const DURATION = <数字>`');
else ok('DURATION = ' + durM[1] + 'ms');
const DURATION = durM ? Number(durM[1]) : 240;

const checksAnim = [
  [/module\.exports\s*=\s*Behavior\(/, '以 Behavior 形式导出'],
  [/animSync\s*\(\s*show\s*\)/, '提供 animSync(show) 方法'],
  [/data:\s*\{[\s\S]{0,120}mounted:[^,]*,[\s\S]{0,120}active:/, 'data 里同时有 mounted 与 active']
];
checksAnim.forEach(([re, desc]) => {
  if (re.test(animSrc)) ok('popup-anim.js ' + desc);
  else bad('popup-anim.js ' + desc + ' —— 没找到');
});
// 反面断言：behavior 里**不能**自己声明 show（组件那份会覆盖掉它 → observer 失效）
if (!/\bproperties\s*:/.test(animSrc)) {
  ok('popup-anim.js 没有自己声明 properties（show 的 observer 必须留在各组件里）');
} else {
  bad('popup-anim.js 声明了 properties —— 若其中含 show，组件的同名声明会覆盖掉 observer，动画静默失效');
}

/* ---------- ② / ③ 三个弹层组件 ---------- */
const TARGETS = [
  { name: 'bottom-sheet', root: 'sheet-root', mask: 'sheet-mask', panel: 'sheet-panel', cls: 'in', panelCls: 'up' },
  { name: 'dialog', root: 'dlg-root', mask: 'dlg-mask', panel: 'dlg-box', cls: 'in', panelCls: 'in' },
  // v0.7.32：duty-sheet 已**并入 bottom-sheet**（改成薄封装）——不再自带一套外壳与开合动画。
  // 判据随之改为「确实把 show 透传给 <bottom-sheet>，且自己没有重复实现」，
  // 而不是继续要求它写着 ds-root/ds-mask/ds-panel（那会锁死实现、阻碍合并）。
  { name: 'duty-sheet', delegate: 'bottom-sheet' }
];

/** 抽出动画类所在的选择器块，便于判 pointer-events */
function blockOf(css, selector) {
  const re = new RegExp('\\' + selector.replace(/^\./, '') === selector ? '' : '');
  const i = css.indexOf(selector + ' {');
  const i2 = css.indexOf(selector + '{');
  const at = i >= 0 ? i : i2;
  if (at < 0) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return close < 0 ? css.slice(open) : css.slice(open + 1, close);
}

for (const t of TARGETS) {
  console.log('\n--- ② ' + t.name + ' ---');
  const jsPath = path.join(COMP, t.name, 'index.js');
  const wxmlPath = path.join(COMP, t.name, 'index.wxml');
  const wxssPath = path.join(COMP, t.name, 'index.wxss');

  const js = read(jsPath);
  const rawW = read(wxmlPath);
  const wxml = stripComments(rawW, 'wxml');
  const wxss = stripComments(read(wxssPath), 'css');

  /* ⚠️ 未闭合的 `<!--` 会把**后面所有节点**一起当成注释吞掉（2026-09-29 实踩：
     bottom-sheet 里一句注释的收尾写错（把 `--` + `>` 写成了别的符号），
     于是 .sheet-drag 整块被吞、页面只是「少了元素」，极难发现）。
     这里先断言注释成对，避免后续所有结构断言建立在被吞掉的文本上。 */
  {
    const op = (rawW.match(/<!--/g) || []).length;
    const cl = (rawW.match(/-->/g) || []).length;
    if (op === cl) ok(t.name + '/index.wxml 注释成对（' + op + ' 组）');
    else bad(t.name + '/index.wxml 有 ' + op + ' 个 `<!--` 但只有 ' + cl + ' 个 `-->` —— 未闭合注释会吞掉后续节点');
  }

  /* 委派型（外壳交给共享弹层）：只断言「真的委派了」「没有重复实现」 */
  if (t.delegate) {
    if (new RegExp('<' + t.delegate + '\\b').test(wxml)) ok(t.name + '/index.wxml 渲染 <' + t.delegate + '>（外壳交给共享组件）');
    else bad(t.name + '/index.wxml 没有渲染 <' + t.delegate + '>');
    if (/show\s*=\s*"\{\{\s*show\s*\}\}"/.test(wxml)) ok(t.name + ' 把 show 透传给 ' + t.delegate);
    else bad(t.name + ' 没有把 show 透传给 ' + t.delegate);
    if (!/require\(\s*['"]\.\.\/popup-anim['"]\s*\)/.test(js) && !/behaviors:\s*\[\s*popupAnim\s*\]/.test(js)) {
      ok(t.name + '/index.js 不再自带 popup-anim（不重复实现开合动画）');
    } else bad(t.name + '/index.js 还自带 popup-anim —— 与共享弹层重复');
    if (!/\.ds-root\s*\{/.test(wxss) && !/\.ds-panel\s*\{/.test(wxss) && !/\.ds-mask\s*\{/.test(wxss)) {
      ok(t.name + '/index.wxss 不再自带外壳样式（ds-root / ds-mask / ds-panel）');
    } else bad(t.name + '/index.wxss 还留着外壳样式 —— 会出现两套遮罩/面板');
    if (/wx:if\s*=\s*"\{\{show\}\}"/.test(wxml)) bad(t.name + '/index.wxml 用 wx:if="{{show}}" 自建了弹层');
    continue;
  }

  /* js */
  const jsOk = [
    [/behaviors:\s*\[\s*popupAnim\s*\]/, 'behaviors: [popupAnim]'],
    [/require\(\s*['"]\.\.\/popup-anim['"]\s*\)/, 'require 了 ../popup-anim'],
    [/show:\s*\{[^}]*observer\s*\(\s*\w+\s*\)\s*\{\s*this\.animSync\(/, 'show 的 observer 调 this.animSync()']
  ];
  jsOk.forEach(([re, desc]) => {
    if (re.test(js)) ok(t.name + '/index.js ' + desc);
    else bad(t.name + '/index.js ' + desc + ' —— 没找到');
  });

  /* wxml */
  if (/wx:if\s*=\s*"\{\{show\}\}"/.test(wxml)) {
    bad(t.name + '/index.wxml 仍在用 wx:if="{{show}}" —— 节点是「带终态类」创建的，动画不会执行（这就是瞬间打开的根因）');
  } else {
    ok(t.name + '/index.wxml 没有 wx:if="{{show}}"');
  }
  if (/wx:if\s*=\s*"\{\{mounted\}\}"/.test(wxml)) ok(t.name + '/index.wxml 用 wx:if="{{mounted}}"');
  else bad(t.name + '/index.wxml 没有 wx:if="{{mounted}}"');
  if (/\{\{\s*active\s*\?\s*'in'\s*:\s*''\s*\}\}/.test(wxml)) ok(t.name + '/index.wxml 动画类绑 active');
  else bad(t.name + '/index.wxml 动画类没绑 active（还是绑 show 就没有动画）');

  /* wxss：过渡时长一致 + pointer-events 门控 */
  const durs = transitionMs(wxss);
  if (durs.length && durs.every(d => d === DURATION)) {
    ok(t.name + '/index.wxss 过渡时长 ' + durs[0] + 'ms 与 DURATION 一致');
  } else {
    bad(t.name + '/index.wxss 过渡时长 [' + durs.join(', ') + ']ms 与 popup-anim.js 的 DURATION=' + DURATION + ' 不一致'
      + '（CSS 更长 → 动画没播完就被卸载；更短 → 提前到位白等）');
  }
  const rootBody = blockOf(wxss, '.' + t.root);
  if (/pointer-events\s*:\s*none/.test(rootBody)) {
    ok(t.name + '/index.wxss .' + t.root + ' 关闭期 pointer-events:none（空壳不吞点击）');
  } else {
    bad(t.name + '/index.wxss .' + t.root + ' 没置 pointer-events:none —— 关闭动画的 240ms 里会吞掉页面点击');
  }
  // pointer-events 是可继承属性，终态必须显式拿回来
  const restoreMask = new RegExp('\\.' + t.mask + '\\.' + t.cls + '\\s*\\{[^}]*pointer-events\\s*:\\s*auto');
  const restorePanel = new RegExp('\\.' + t.panel + '\\.' + t.panelCls + '\\s*\\{[^}]*pointer-events\\s*:\\s*auto');
  if (restoreMask.test(wxss) && restorePanel.test(wxss)) {
    ok(t.name + '/index.wxss 终态把 pointer-events 拿回来了（遮罩 + 面板）');
  } else {
    bad(t.name + '/index.wxss 终态没把 pointer-events 拿回来（它可继承，不拿回来弹层里点不动）');
  }
}

/* ---------------------------------------------------------------- */
/* ③ 页面入场动画（Tab 切换）                                         */
/* ---------------------------------------------------------------- */
console.log('\n--- ③ Tab 页入场动画 ---');
const appWxss = stripComments(read(path.join(MINI, 'app.wxss')), 'css');
const pageAnimSrc = read(path.join(MINI, 'utils', 'page-anim.js'));

/*
 * v0.7.12 起机制换了：不再是「整页淡入」，改成**内容分块依次上浮**
 * （首次 .pa-first 完整版 / 回访 .pa-lite-a ↔ .pa-lite-b 轮换轻量版）。
 * v0.7.14 进一步合并为**单一整体节拍**：去掉 .st-1/.st-2/.st-3 错峰档，
 * 三档（pa-first / pa-lite-a / pa-lite-b）都直接挂在 .st-item 上整体就位；
 * keyframes 由 stIn* 改名为 paIn*（stInFull→paInFull / stInLiteA→paInLiteA / stInLiteB→paInLiteB）。
 * 旧的 .page-anim-1 / -2 与 pageInA / pageInB 已删除；细则由 scripts/check-tab-enter.js 守。
 */
if (/\.pa-first\s+\.st-item\s*\{/.test(appWxss)
  && /\.pa-lite-a\s+\.st-item\s*\{/.test(appWxss)
  && /\.pa-lite-b\s+\.st-item\s*\{/.test(appWxss)) {
  ok('app.wxss 定义了 .pa-first / .pa-lite-a / .pa-lite-b（入场动画三档）');
} else {
  bad('app.wxss 缺入场动画 class（.pa-first / .pa-lite-a / .pa-lite-b 之一）');
}
if (/@keyframes\s+paInFull/.test(appWxss)
  && /@keyframes\s+paInLiteA/.test(appWxss)
  && /@keyframes\s+paInLiteB/.test(appWxss)) {
  ok('app.wxss 有 paInFull / paInLiteA / paInLiteB 三组 keyframes');
} else {
  bad('app.wxss 缺入场 keyframes（两套 lite 只留一套的话回访不会重播）');
}

/**
 * ⚠️ 反面断言：入场动画里**不得**出现 filter / perspective / 布局属性。
 * .st-item 只加在普通内容块上，transform 会创建包含块，绝不能落在 position:fixed
 * 的元素及其祖先上（课表页「临时调课」FAB 会被摆到内容盒底部而非屏幕底部）。
 * 这条由 scripts/check-tab-enter.js 逐页断言（fixed 类名从 wxss 动态提取后扫 wxml）。
 */
const kfBody = (appWxss.match(/@keyframes\s+paIn\w*\s*\{[\s\S]*?\n\}/g) || []).join('\n');
if (!kfBody) {
  bad('取不到入场 keyframes 内容，无法确认是否用了安全属性');
} else if (/filter\s*:|perspective\s*:|(^|[^-\w])(width|height|margin|padding|top|left|right|bottom)\s*:/.test(kfBody)) {
  bad('入场 keyframes 用了 filter / perspective / 布局属性 —— 会触发重排或破坏 fixed 定位，'
    + '入场动画只允许动 transform + opacity');
} else {
  ok('入场 keyframes 只动 transform + opacity（不触发重排）');
}

if (/function\s+play\s*\(/.test(pageAnimSrc) && /play\s*[,}]/.test(pageAnimSrc.slice(pageAnimSrc.lastIndexOf('module.exports')))) {
  ok('utils/page-anim.js 导出 play()');
} else {
  bad('utils/page-anim.js 没有导出 play()');
}

const TABS = ['home', 'timetable', 'duty', 'mine'];
for (const p of TABS) {
  const wxml = stripComments(read(path.join(MINI, 'pages', p, 'index.wxml')), 'wxml');
  const js = read(path.join(MINI, 'pages', p, 'index.js'));
  // v0.7.31：根节点多一个 pa-hold（就绪前透明），页面入口由 play(this) 改为 playReady(this, app)
  const hasThree = /'pa-first'/.test(wxml) && /'pa-lite-a'/.test(wxml) && /'pa-lite-b'/.test(wxml) && /'pa-hold'/.test(wxml);
  const noInterp = !/pa-\{\{/.test(wxml);
  const hasSeq = /animSeq:\s*0/.test(js);
  const callsPlay = /pageAnim\.(?:play|playReady)\(this/.test(js);
  if (hasThree && noInterp && hasSeq && callsPlay) {
    ok('pages/' + p + ' 入场动画接线完整（animSeq:0 + onShow 调 play/playReady + 四元完整类名）');
  } else {
    bad('pages/' + p + ' 入场动画接线不全：'
      + [hasThree ? '' : '缺 pa-hold / pa-first / pa-lite-a / pa-lite-b', noInterp ? '' : '用了 pa-{{}} 插值（check-wxss 无法静态校验）',
        hasSeq ? '' : '缺 animSeq: 0', callsPlay ? '' : 'onShow 未调 pageAnim.play/playReady(this, …)'].filter(Boolean).join('；'));
  }
}

/* ---------------------------------------------------------------- */
/* 自证                                                              */
/* ---------------------------------------------------------------- */
const badWxml = '<view wx:if="{{show}}" class="x-root"><view class="mask {{show ? \'in\' : \'\'}}"></view></view>';
const badHit = /wx:if\s*=\s*"\{\{show\}\}"/.test(badWxml) && /\{\{\s*show\s*\?\s*'in'\s*:\s*''\s*\}\}/.test(badWxml);
if (badHit) ok('自证：wx:if="{{show}}" + 动画类绑 show 的样本会被判为问题');
else bad('自证失败：写错的样本没被识别');

const goodWxml = '<view wx:if="{{mounted}}" class="x-root"><view class="mask {{active ? \'in\' : \'\'}}"></view></view>';
const goodOk = /wx:if\s*=\s*"\{\{mounted\}\}"/.test(goodWxml)
  && !/wx:if\s*=\s*"\{\{show\}\}"/.test(goodWxml)
  && /\{\{\s*active\s*\?\s*'in'\s*:\s*''\s*\}\}/.test(goodWxml);
if (goodOk) ok('自证：mounted / active 的正确样本判为正常');
else bad('自证失败：正确样本没被识别');

/* ---------------------------------------------------------------- */
/* ⑤ 下拉关闭（v0.7.32 用户口径第 1~6 条）                            */
/* ---------------------------------------------------------------- */
console.log('\n--- ⑤ bottom-sheet 下拉关闭 ---');
const bsJs = read(path.join(COMP, 'bottom-sheet', 'index.js'));
const bsW = stripComments(read(path.join(COMP, 'bottom-sheet', 'index.wxml')), 'wxml');
const bsC = stripComments(read(path.join(COMP, 'bottom-sheet', 'index.wxss')), 'css');

if (/draggable:\s*\{\s*type:\s*Boolean/.test(bsJs)) ok('① draggable 开关存在（表单类弹层可关掉拖拽）'); else bad('① 缺 draggable 开关');
if (/class="sheet-grab"/.test(bsW) && /\.sheet-grab::after/.test(bsC)) ok('① 有 grabber 指示条'); else bad('① 缺 grabber 指示条');
if (/class="sheet-drag"[\s\S]{0,260}?bindtouchstart="onHeadStart"/.test(bsW)
  && /class="sheet-drag"[\s\S]{0,320}?catchtouchmove="onHeadMove"/.test(bsW)) {
  ok('①⑥ 拖动感应区 = .sheet-drag（grabber + 整条标题栏），且自己 catchtouchmove');
} else bad('①⑥ .sheet-drag 没同时接住 touchstart 与 catchtouchmove');
if (!/<scroll-view[^>]*(bindtouchstart|bindtouchmove|catchtouchmove)/.test(bsW)) ok('⑥ 内容区 scroll-view 不接拖动手势（滚动不触发拖动）');
else bad('⑥ 内容区 scroll-view 挂了拖动手势 —— 会把列表滑动误当拖动');
if (/style="\{\{maskStyle\}\}"/.test(bsW)) ok('④ 遮罩透明度由 maskStyle 驱动（跟手减淡）'); else bad('④ 遮罩没有跟手的内联透明度');
if (/RUBBER_MAX/.test(bsJs) && /rubber\s*\(/.test(bsJs)) ok('② 向上拖有 rubber-banding（指数衰减、渐近 RUBBER_MAX）'); else bad('② 缺 rubber-banding');
if (/FLICK_V/.test(bsJs) && /y\s*>\s*h\s*\/\s*2/.test(bsJs)) ok('③ 关闭判定 = 位移过半 **或** 速度（FLICK_V）'); else bad('③ 关闭判定不是「位移 + 速度」双判据');
if (/dur\s*=\s*Math\.round\(clamp\(/.test(bsJs)) ok('③ 回弹/关闭时长由松手速度算出（不是固定时长）'); else bad('③ 时长写死了 —— 没有把速度带进动画');
if (/_freeze\(\)/.test(bsJs) && /_curOffset\(\)/.test(bsJs)) ok('⑤ 可打断：接住当前位移 + 速度继续拖'); else bad('⑤ 缺打断（_freeze / _curOffset）');
if (/triggerEvent\('close'\)[\s\S]{0,80}?\}\)/.test(bsJs) && /_anim\s*=\s*\{\s*t0/.test(bsJs)) ok('关闭：先播滑出动画再通知关闭（不立即销毁节点）'); else bad('关闭：没有「先动画后卸载」');
/* 只动 transform / opacity：拖动期不许出现宽高/边距等布局属性 */
const dragStyleBits = (bsJs.match(/dragStyle|maskStyle/g) || []).length;
const layoutWrite = /(dragStyle|maskStyle)\s*=\s*'[^']*(width|height|margin|padding|top|left|right|bottom)\s*:/i.test(bsJs);
if (dragStyleBits > 0 && !layoutWrite) ok('拖动只改 transform / opacity（不重排、不闪）');
else bad('拖动样式里出现了布局属性 —— 会重排/闪烁');

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
}
console.log('✅ 弹层开合动画机制检查全部通过');
