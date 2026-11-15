#!/usr/bin/env node
/**
 * 门禁：首页「本班请假」卡 → 详情的**容器共享元素转场**（v1.0.10.7）
 * ================================================================
 * 用户口径（2026-11-15）：
 *   「首页本班请假，也是点击直接从原本的框展开放大，也就是从卡片到详情页的
 *     共享元素转场（Shared Element Transition），背景与卡片容器做连续平滑缩放。」
 *
 * 与项目里已有的两种转场**不是一回事**，别混：
 *   · dialog 的 morphRect：胶囊 → 对话框，**等比近似** scale = sr.width / br.width；
 *   · shared-element：ghost 色块/头像**飞过去**，真实容器不动；
 *   · 本需求：真实 .sheet-panel 容器用**非等比 scale(sx,sy) + translate** 从源卡片
 *     矩形连续长成详情面板，遮罩与内容同拍同曲线 ⇒ 看起来是「一个框在放大」。
 *
 * 本门禁三段：
 *   ① 纯几何行为：vm 真加载 utils/morph.js，验终点矩形 / FLIP 闭环 / 非等比 /
 *      起点帧无过渡 / 终点帧 240ms 且无超调曲线；
 *   ② 静态契约：组件三件套 + 首页三件套的接线、两帧时序、守卫、降级；
 *   ③ 变异自证：内存里改坏 9 处，逐条要求对应探针**翻红**，且先验证锚点命中。
 *
 * ⚠️ 不写盘、不启开发者工具 —— 与用户「不操纵」纪律一致。
 * 用法：node scripts/check-leave-morph.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = p => fs.readFileSync(p, 'utf8');

const FILES = {
  morphJs: path.join(MINI, 'utils', 'morph.js'),
  bsJs: path.join(MINI, 'components', 'bottom-sheet', 'index.js'),
  bsWxml: path.join(MINI, 'components', 'bottom-sheet', 'index.wxml'),
  bsWxss: path.join(MINI, 'components', 'bottom-sheet', 'index.wxss'),
  homeJs: path.join(MINI, 'pages', 'home', 'index.js'),
  homeWxml: path.join(MINI, 'pages', 'home', 'index.wxml'),
  homeWxss: path.join(MINI, 'pages', 'home', 'index.wxss'),
  popupJs: path.join(MINI, 'components', 'popup-anim.js')
};
const SRC = {};
Object.keys(FILES).forEach(k => { SRC[k] = read(FILES[k]); });

let failed = 0;
const ok = m => console.log('  PASS  ' + m);
const bad = m => { failed++; console.log('  FAIL  ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));

/** 剥注释：门禁文档里写着反面示例，不剥会把自己的注释当成实现/反例 */
function strip(s, kind) {
  let t = s.replace(/\/\*[\s\S]*?\*\//g, '');
  if (kind === 'wxml') t = t.replace(/<!--[\s\S]*?-->/g, '');
  else t = t.replace(/^\s*\/\/.*$/gm, '');
  return t;
}
/** `transition: ... .24s ...` → 240（毫秒）；只抓 s 结尾，220ms 这类不参与 */
function transitionMs(css) {
  const out = [];
  const re = /transition:[^;]*(?:^|[^\d.])(\d*\.?\d+)s/g;
  let m;
  while ((m = re.exec(css))) out.push(Math.round(Number(m[1]) * 1000));
  return out;
}
/** 贝塞尔的第 2 / 第 4 控制点 y：>1 即超调，容器缩放会越出终态露边 */
function easeYMax(ease) {
  const m = /cubic-bezier\(([^)]+)\)/.exec(String(ease));
  if (!m) return 999;
  const p = m[1].split(',').map(Number);
  return Math.max(p[1], p[3]);
}
/** 从源码里抽一段方法体。bottom-sheet 的方法缩进是 **4 空格**，
 *  所以结束锚点必须是 `\n    }` —— 按 2 空格写会一路吞到后面的 _measureHeights /
 *  _measurePanelH，探针就变成「抽到了别人的代码」的假判据（第一版实踩）。 */
function bodyOf(src, name, arg) {
  const re = new RegExp('\\b' + name + '\\(' + arg + '\\)\\s*\\{([\\s\\S]*?)\\n    \\}');
  const m = re.exec(src);
  return m ? m[1] : null;
}
function loadMorph(src) {
  const box = { module: { exports: {} }, exports: {}, console };
  try { vm.runInNewContext(src, box); } catch (e) { return null; }
  return box.module.exports;
}

/* ============================================================
 * ① 纯几何行为（vm 真跑 utils/morph.js）
 * ============================================================ */
const WIN = { windowWidth: 375, windowHeight: 812 };
const SIZE = { width: 375, height: 600 };          // 面板布局尺寸（fields({size:true})）
const FROM = { left: 16, top: 300, width: 343, height: 120 }; // 首页请假卡
const eq = (a, b) => Math.abs(a - b) < 1e-6;

function behavior(src) {
  const m = loadMorph(src);
  if (!m || !m.sheetTargetRect || !m.flipFromTo || !m.morphInline) return null;
  const to = m.sheetTargetRect(WIN, SIZE);
  const g = m.flipFromTo(FROM, to);
  const s0 = m.morphInline(g, true, false, m.MORPH_MS, m.MORPH_EASE, '24rpx', '24rpx 24rpx 0 0');
  const s1 = m.morphInline(g, false, true, m.MORPH_MS, m.MORPH_EASE, '24rpx', '24rpx 24rpx 0 0');
  const popupDur = Number((/const\s+DURATION\s*=\s*(\d+)/.exec(SRC.popupJs) || [])[1]);
  return {
    dur240: m.MORPH_MS === 240 && m.MORPH_MS === popupDur,
    noOvershoot: easeYMax(m.MORPH_EASE) <= 1.0001,
    target: !!to && to.left === 0 && to.top === 212 && to.width === 375 && to.height === 600,
    targetInvalid: m.sheetTargetRect({ windowWidth: 0, windowHeight: 812 }, SIZE) === null
      && m.sheetTargetRect(WIN, { width: 0, height: 600 }) === null
      && m.sheetTargetRect(null, SIZE) === null,
    geo: !!g && eq(g.dx, 16) && eq(g.dy, 88) && eq(g.sx, 343 / 375) && eq(g.sy, 0.2),
    nonUniform: !!g && Math.abs(g.sx - g.sy) > 0.1,
    geoInvalid: m.flipFromTo(null, to) === null
      && m.flipFromTo(FROM, { left: 0, top: 0, width: 0, height: 0 }) === null,
    roundTrip: !!g && !!to
      && eq(to.left + g.dx, FROM.left) && eq(to.top + g.dy, FROM.top)
      && eq(to.width * g.sx, FROM.width) && eq(to.height * g.sy, FROM.height),
    startFrame: /transform-origin:0 0;/.test(s0) && /transition:none;/.test(s0)
      && /translate\(16\.00px,88\.00px\)/.test(s0) && /scale\(0\.9147,0\.2000\)/.test(s0)
      && /border-radius:24rpx;/.test(s0),
    endFrame: /transform:translate\(0px,0px\) scale\(1,1\);/.test(s1)
      && /transition:transform 240ms cubic-bezier\(\.22,\.61,\.36,1\)/.test(s1)
      && /border-radius:24rpx 24rpx 0 0;/.test(s1)
      && !/1\.12/.test(s1),
    emptyInline: m.morphInline(null, true, false) === ''
  };
}

/* ============================================================
 * ② 静态契约
 * ============================================================ */
function statics(s) {
  const js = strip(s.bsJs, 'js');
  const w = strip(s.bsWxml, 'wxml');
  const css = strip(s.bsWxss, 'css');
  const hj = strip(s.homeJs, 'js');
  const hw = strip(s.homeWxml, 'wxml');
  const hc = strip(s.homeWxss, 'css');
  const prep = bodyOf(s.bsJs, '_morphPrepare', '') || '';
  const durs = transitionMs(css);

  /* 全仓只有首页请假弹层传了 origin-rect —— 其它弹层零影响的硬证据 */
  function countWiring(dir) {
    let n = 0;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) n += countWiring(f);
      else if (e.name.endsWith('.wxml')) n += (read(f).match(/origin-rect=/g) || []).length;
    });
    return n;
  }

  return {
    // ---- utils/morph.js：几何真源与导出 ----
    exportsAll: /flipFromTo, morphInline, faceInline, sheetTargetRect, MORPH_MS, MORPH_EASE/.test(s.morphJs),
    origin00: /return 'transform-origin:0 0;transform:translate\(/.test(s.morphJs),

    // ---- bottom-sheet/index.js：可选能力、两帧时序、守卫 ----
    propOptional: /originRect:\s*\{\s*type:\s*Object,\s*value:\s*null\s*\}/.test(js),
    dataFields: /morphStyle:\s*''/.test(js) && /morphCls:\s*''/.test(js),
    guardedDefault: /if \(!r \|\| !\(Number\(r\.width\) > 0\) \|\| !\(Number\(r\.height\) > 0\)\) return false;/.test(js),
    sharedFlag: /!motion\.on\('shared'\)/.test(js),
    reducedMotion: /if \(theme\.prefersReducedMotion && theme\.prefersReducedMotion\(\)\) return false;/.test(js),
    mountedObserver: /observers:\s*\{[\s\S]{0,500}?mounted\(v\)\s*\{[\s\S]{0,200}?_morphPrepare\(\)[\s\S]{0,200}?_morphReset\(\)/.test(js),
    noSyncWindowApi: !/wx\.getWindowInfo\(|wx\.getSystemInfoSync\(/.test(js)
      && /const m = \(app\.navMetrics && app\.navMetrics\(\)\) \|\| \{\};/.test(js),
    showUntouched: /show:\s*\{[^}]*observer\s*\(\s*nv\s*\)\s*\{\s*this\.animSync\(nv\);\s*\}\s*\}/.test(js),
    prepValid: prep.length > 100 && /_morphTimer/.test(prep) && !/_morphReset\s*\(\)/.test(prep),
    layoutSize: /q\.select\('\.sheet-panel'\)\.fields\(\{\s*size:\s*true\s*\}/.test(prep),
    noVisualRect: !/boundingClientRect/.test(prep),
    threeBeats: /morphCls:\s*'morph'/.test(js)
      && /morphCls:\s*'morph morph-show'/.test(js)
      && /self\.setData\(\{\s*morphStyle:\s*'',\s*morphCls:\s*'',\s*morphFaceStyle:\s*''\s*\}\);/.test(js),
    startNoTransition: /morph\.morphInline\(g, true, false,/.test(js),
    endWithTransition: /morph\.morphInline\(g, false, true,/.test(js),
    closeShrink: /if \(!v && this\._morphGeo && !this\.data\.dragStyle\)/.test(js)
      && /morph\.morphInline\(this\._morphGeo, true, true,/.test(js),
    dragGuard: /if \(this\.data\.morphStyle\) return;/.test(js),
    resetClean: /_morphReset\(\)\s*\{[\s\S]{0,400}?this\._morphGeo = null/.test(js),
    timerCleanup: /detached\(\)[\s\S]{0,1400}?if \(this\._morphTimer\)/.test(js),

    // ---- bottom-sheet/index.wxml：真实节点接线 ----
    rootCls: /class="sheet-root[^"]*\{\{morphCls\}\}"/.test(w),
    panelStyle: /;\{\{morphStyle\}\}"\s*>/.test(w),
    noDoubleGt: !/\{\{morphStyle\}\}"\s*>>/.test(w),
    capStyleJoin: /;\{\{capStyle\}\}/.test(w),

    // ---- bottom-sheet/index.wxss：遮罩 + 内容同拍同曲线、双向过渡 ----
    maskStart: /\.sheet-root\.morph \.sheet-mask\s*\{[^}]*opacity:\s*0[^}]*transition:\s*opacity \.24s/.test(css),
    maskEnd: /\.sheet-root\.morph\.morph-show \.sheet-mask\s*\{[^}]*opacity:\s*1[^}]*transition:\s*opacity \.24s/.test(css),
    contentStart: /\.sheet-root\.morph \.sheet-drag[\s\S]{0,220}?opacity:\s*0;[\s\S]{0,120}?transition:\s*opacity \.24s/.test(css),
    contentEnd: /\.sheet-root\.morph\.morph-show \.sheet-drag[\s\S]{0,260}?opacity:\s*1;[\s\S]{0,120}?transition:\s*opacity \.24s/.test(css),
    reducedCss: /prefers-reduced-motion[\s\S]{0,600}?\.sheet-root\.morph \.sheet-mask[\s\S]{0,400}?transition:\s*none/.test(css),
    allDur240: durs.length > 0 && durs.every(d => d === 240),

    // ---- 首页：源矩形 + 同批下发 + 转场期隐藏 + 关闭恢复 ----
    dataInit: /leaveHomeOriginRect:\s*null/.test(hj) && /leaveHomeCardHidden:\s*false/.test(hj),
    openHelper: /_openLeaveSheet\(patch\)\s*\{/.test(hj),
    captureRect: /q\.select\('#leave-home-card'\)\.boundingClientRect\(/.test(hj),
    sameBatch: /setData\(Object\.assign\(\{[\s\S]{0,320}?leaveHomeOriginRect:\s*r,[\s\S]{0,220}?leaveHomeShow:\s*true/.test(hj),
    hiddenOnOpen: /leaveHomeCardHidden:\s*!!r/.test(hj),
    bothEntries: (hj.match(/_openLeaveSheet\(/g) || []).length >= 3,
    closeRestore: /onLeaveHomeClose\(\)\s*\{[\s\S]{0,320}?leaveHomeCardHidden:\s*false/.test(hj),
    cardId: /id="leave-home-card"/.test(hw),
    originAttr: /origin-rect="\{\{leaveHomeOriginRect\}\}"/.test(hw),
    wrapper: /class="lh-src-box \{\{leaveHomeCardHidden \? 'lh-src-hidden' : ''\}\}"/.test(hw),
    srcBoxCss: /\.lh-src-box\s*\{/.test(hc),
    visibilityCss: /\.lh-src-hidden\s*\{\s*visibility:\s*hidden;\s*\}/.test(hc),
    onlyOneWiring: countWiring(path.join(MINI, 'pages')) + countWiring(path.join(MINI, 'components')) === 1
  };
}

const B = behavior(SRC.morphJs);
const S = statics(SRC);

console.log('── ① 纯几何行为（vm 真跑 utils/morph.js）');
if (!B) { console.log('  FAIL  没能加载 utils/morph.js 的几何函数'); process.exit(1); }
check(B.dur240, 'MORPH_MS=240，与 popup-anim.js 的 DURATION 对齐（遮罩/容器不脱拍）');
check(B.noOvershoot, '曲线两个 y 控制点都 <=1（容器缩放禁止超调露边）');
check(B.target, 'sheetTargetRect：贴底面板终态 = {left:0, top:H-h, width:w, height:h}');
check(B.targetInvalid, '窗口/面板尺寸非法时返回 null（调用方安全降级）');
check(B.geo, 'flipFromTo：dx=16 / dy=88 / sx=343/375 / sy=0.2');
check(B.nonUniform, '宽高比例不同 ⇒ 非等比 scale(sx,sy)，不是等比近似');
check(B.geoInvalid, '源/目标矩形非法时返回 null');
check(B.roundTrip, '几何闭环：把 g 应用到终态矩形能精确还原源卡片矩形');
check(B.startFrame, '起点帧：transform-origin:0 0 + translate/scale 到源卡 + transition:none');
check(B.endFrame, '终点帧：归零 + 240ms EASE.out + 终态圆角，且无 fluid 超调');
check(B.emptyInline, '几何为空时返回空样式串（绝不写坏内联 style）');

console.log('\n── ② 静态契约：组件（可选能力 / 两帧时序 / 守卫）');
check(S.exportsAll && S.origin00, 'morph.js 导出全部几何函数，且 transform-origin 固定 0 0');
check(S.propOptional && S.dataFields, 'originRect 默认 null + morphStyle/morphCls 数据字段');
check(S.guardedDefault, '_morphEnabled 对源矩形判空（不传 ⇒ 其它弹层零影响）');
check(S.sharedFlag, 'motion.on(\'shared\') 远程开关守着（可一键关掉）');
check(S.reducedMotion, '系统「减弱动效」时整段不播');
check(S.mountedObserver, 'mounted observer 负责 _morphPrepare / _morphReset');
check(S.noSyncWindowApi, '窗口尺寸走 app 缓存，组件里没有同步跨线程度量（check-perf R2）');
check(S.showUntouched, 'show observer 保持只调 animSync()（check-popup-anim 的硬约束）');
check(S.prepValid && S.layoutSize && S.noVisualRect, '终态用 fields({size:true}) 量布局尺寸，绝不用 boundingClientRect（且方法体抽取有效）');
check(S.threeBeats && S.startNoTransition && S.endWithTransition, '三拍：起点无过渡 → 终点带过渡 → 收尾交还 class');
check(S.closeShrink, '关闭时反向缩回源矩形；拖拽关闭不叠加 morph');
check(S.dragGuard, '转场期禁用拖拽（内联 transform 不与 dragStyle 抢）');
check(S.resetClean && S.timerCleanup, '卸载清 _morphGeo / morphStyle，detached 清定时器');

console.log('\n── ③ 静态契约：WXML / WXSS（真实节点 + 同拍同曲线）');
check(S.rootCls && S.panelStyle && S.capStyleJoin, 'root 挂 morphCls、panel 内联 morphStyle，且 capStyle 分隔符未破');
check(S.noDoubleGt, 'sheet-panel 标签尾没有多余的 >（曾写成 >> 会多出文本字符）');
check(S.maskStart && S.maskEnd, '遮罩由 morphCls 接管：起点 0 / 终点 1，双向各写 .24s');
check(S.contentStart && S.contentEnd, '内容交叉淡出/淡入：两条方向各自的过渡都写全');
check(S.reducedCss, 'prefers-reduced-motion 段显式关掉 morph 过渡');
check(S.allDur240, '全文件 transition 时长统一 .24s（check-popup-anim 判据）');

console.log('\n── ④ 静态契约：首页接线');
check(S.dataInit && S.openHelper && S.captureRect, '源矩形数据字段 + _openLeaveSheet + #leave-home-card 量取');
check(S.sameBatch && S.hiddenOnOpen, 'originRect 与 show **同批**下发，并同时隐藏源卡（不同批会静默降级）');
check(S.bothEntries, '班委「本班请假」与辅导员「各班请假」两个入口都走同一 helper');
check(S.closeRestore, '关闭恢复源卡显示（缩回有落点，不会缩到一片空白）');
check(S.cardId && S.originAttr && S.wrapper, '卡片 id / origin-rect 属性 / 隐藏容器三件齐全');
check(S.srcBoxCss && S.visibilityCss, 'visibility:hidden 而非 opacity（.st-item 入场动画会写 opacity）');
check(S.onlyOneWiring, '全仓只有首页请假弹层传 origin-rect（其它弹层零影响）');

/* ============================================================
 * ③ 变异自证：改坏 → 对应探针必须翻红
 * ============================================================ */
console.log('\n── ⑤ 变异自证（锚点命中 + 逐条翻红）');
const MUT = [
  { name: '删掉首页 origin-rect 接线', file: 'homeWxml', probe: 'originAttr',
    from: ' origin-rect="{{leaveHomeOriginRect}}"', to: '' },
  { name: '终态改用 boundingClientRect 量（会被 transform 污染）', file: 'bsJs', probe: 'noVisualRect',
    from: "q.select('.sheet-panel').fields({ size: true }, function () {})",
    to: "q.select('.sheet-panel').boundingClientRect()" },
  { name: '删掉 fields({size:true})', file: 'bsJs', probe: 'layoutSize',
    from: "q.select('.sheet-panel').fields({ size: true }, function () {})",
    to: "q.select('.sheet-panel').boundingClientRect()" },
  { name: '删掉 shared 远程开关', file: 'bsJs', probe: 'sharedFlag',
    from: "if (typeof motion.on === 'function' && !motion.on('shared')) return false;", to: '' },
  { name: '组件里自己同步取窗口信息（进页面会卡）', file: 'bsJs', probe: 'noSyncWindowApi',
    from: 'const m = (app.navMetrics && app.navMetrics()) || {};', to: 'const m = wx.getWindowInfo();' },
  { name: '删掉减弱动效守卫', file: 'bsJs', probe: 'reducedMotion',
    from: 'if (theme.prefersReducedMotion && theme.prefersReducedMotion()) return false;', to: '' },
  { name: '转场时长改成 380ms（与遮罩脱拍）', file: 'morphJs', probe: 'dur240', behavior: true,
    from: 'const MORPH_MS = 240;', to: 'const MORPH_MS = 380;' },
  { name: '退化成等比 scale（宽高对不上源卡）', file: 'morphJs', probe: 'nonUniform', behavior: true,
    from: 'const sx = fw / tw, sy = fh / th;', to: 'const sx = fw / tw, sy = sx;' },
  { name: 'transform-origin 改成 center（起点矩形会挪走）', file: 'morphJs', probe: 'startFrame', behavior: true,
    from: "return 'transform-origin:0 0;transform:translate('", to: "return 'transform-origin:center center;transform:translate('" },
  { name: '删掉 morph-show 的遮罩淡入', file: 'bsWxss', probe: 'maskEnd',
    from: '.sheet-root.morph.morph-show .sheet-mask {', to: '.sheet-root.morph.morph-show .sheet-mask-off {' },
  { name: '关闭时不恢复源卡', file: 'homeJs', probe: 'closeRestore',
    from: 'leaveHomeCardHidden: false\n    });', to: 'leaveHomeCardHidden: true\n    });' },
  { name: '恢复源卡用 opacity（会被入场动画覆盖）', file: 'homeWxss', probe: 'visibilityCss',
    from: '.lh-src-hidden { visibility: hidden; }', to: '.lh-src-hidden { opacity: 0; }' }
];

MUT.forEach(mu => {
  const before = SRC[mu.file];
  if (!before.includes(mu.from)) { bad('变异「' + mu.name + '」锚点没命中 —— 自证会假通过'); return; }
  const next = Object.assign({}, SRC);
  next[mu.file] = before.replace(mu.from, mu.to);
  if (next[mu.file] === before) { bad('变异「' + mu.name + '」替换没生效 —— 自证会假通过'); return; }
  let caught;
  if (mu.behavior) {
    const b = behavior(next.morphJs);
    caught = !b || b[mu.probe] === false;
    // 几何类变异还要顺带确认 roundTrip 真的被破坏（证明探针不是摆设）
    if (mu.probe === 'nonUniform' && b && b.roundTrip !== false) {
      bad('变异「' + mu.name + '」等比化后 roundTrip 仍为真 —— 闭环断言失效');
      return;
    }
  } else {
    const p = statics(next);
    caught = p[mu.probe] === false;
  }
  check(caught, '变异被抓：' + mu.name);
});

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
}
console.log('✅ 容器共享元素转场（卡片 → 详情）检查全部通过');
