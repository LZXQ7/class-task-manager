#!/usr/bin/env node
/**
 * 门禁：课表弧形菜单（#10，2026-11-14 按用户口径重做）
 * ================================================================
 * 用户口径：
 *   ① **长按才展开**，按住期间菜单一直在；轻点不展开。
 *   ② **手指拖到某个按钮上松开 = 点了那个按钮**。
 *   ③ **按住展开后直接松手（没拖到按钮）⇒ 四个按钮收回**。
 *   ④ 按钮是**圆形**、配色跟随整体；弧上**间距一致**、不出屏。
 *   ⑤ 手指滑上/移开都要**弹一下**（放大、缩回双向 overshoot），减弱动效时不弹。
 *
 * 为什么不能只做静态正则：
 *   · 把 release() 的命中判定删掉 → 松手永远不选中，菜单也不收回（用户实锤）；
 *   · 命中半径写成 5px → 手指根本对不准，永远选不中；
 *   · 逐点夹取代替整弧平移 → 靠边的项被挤到一起，间距不一致（用户实锤）；
 *   · 又加回 bindtap → 轻点也会弹出一个"没人操作的菜单"。
 * 所以这里用 vm 真加载组件 index.js，造一个假实例逐个调方法做行为断言。
 *
 * 末尾的变异自证全部在内存字符串里替换、绝不写盘；每组要求对应探针翻红，
 * 且先断言「锚点命中 + 替换生效」，防止拿好样本当坏样本的自欺式假绿。
 *
 * 用法：node scripts/check-radial-menu.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'miniprogram', 'components', 'radial-menu');
const TT_WXML = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.wxml');
const TT_JS = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.js');
const read = p => fs.readFileSync(p, 'utf8');

const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WXML = stripHtml(read(path.join(DIR, 'index.wxml')));
const WXSS = stripJs(read(path.join(DIR, 'index.wxss')));
const JS = stripJs(read(path.join(DIR, 'index.js')));
const TT_WXML_RAW = read(TT_WXML);
const TT_JS_RAW = read(TT_JS);

const VW = 402, VH = 874;

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/* ============================================================
 * ① 真加载组件（源码是 ES5 CommonJS，vm 里可直接跑）
 * ============================================================ */
function loadComponent(src) {
  const desc = {};
  const sandbox = {
    module: { exports: {} },
    require: (p) => (p.indexOf('motion') >= 0 ? { on: () => true } : {}),
    Component: (d) => { Object.assign(desc, d); },
    wx: { getSystemInfoSync: () => ({ windowWidth: VW, windowHeight: VH }) },
    console, Math, Object, Array, Number, String, JSON, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'radial-menu/index.js' });
  return desc;
}

function makeInst(desc, props) {
  const inst = {
    data: JSON.parse(JSON.stringify(desc.data || {})),
    properties: Object.assign({}, desc.properties, props),
    events: [],
    setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb(); },
    triggerEvent(name, detail) { this.events.push({ name, detail: detail || {} }); }
  };
  Object.keys(desc.methods || {}).forEach(k => {
    inst[k] = desc.methods[k].bind(inst);
  });
  return inst;
}

const ITEMS = [
  { key: 'ALL', label: '全部' },
  { key: 'A', label: 'A 组' },
  { key: 'B', label: 'B 组' },
  { key: 'SHIFT', label: '临时调课' }
];

/* ============================================================
 * ② 行为探针
 * ============================================================ */
function behaviorProbes() {
  const desc = loadComponent(JS);
  const out = {};

  // 开在左下角（课表 FAB 的位置）
  const inst = makeInst(desc, {
    x: 61, y: 715, items: ITEMS, radius: 140, spanStart: -105, spanEnd: 5
  });
  inst._open();

  const arr = inst.data.arranged || [];
  out.count = arr.length === ITEMS.length;
  out.keys = arr.every((a, i) => a.key === ITEMS[i].key);

  // 间距一致：相邻项之间的**弦长**必须相等（等角 ⇒ 弦长相等）
  let chords = [];
  for (let i = 1; i < arr.length; i++) {
    const dx = arr[i].dx - arr[i - 1].dx;
    const dy = arr[i].dy - arr[i - 1].dy;
    chords.push(Math.sqrt(dx * dx + dy * dy));
  }
  out.evenSpacing = chords.length > 0 && chords.every(c => Math.abs(c - chords[0]) < 1.5);

  // 不出屏：每个项的中心（含按钮半径）都要在视口内
  out.inScreen = arr.every(a => {
    const cx = inst.properties.x + a.dx, cy = inst.properties.y + a.dy;
    return cx - 32 >= 0 && cx + 32 <= VW && cy - 32 >= 0 && cy + 32 <= VH;
  });

  // 悬停命中：手指放到第 2 项正中心 ⇒ hot = 1
  const t1 = { x: inst.properties.x + arr[1].dx, y: inst.properties.y + arr[1].dy };
  inst.moveTo(t1.x, t1.y);
  out.hitHot = inst.data.hot === 1;

  // 手指移开 ⇒ hot = -1
  inst.moveTo(5, 5);
  out.missHot = inst.data.hot === -1;

  // 松手且命中 ⇒ 触发 select（key 正确）
  inst.moveTo(t1.x, t1.y);
  inst.release();
  const sel = inst.events.filter(e => e.name === 'select');
  out.selectOnHot = sel.length === 1 && sel[0].detail.key === 'A';

  // 松手且没命中 ⇒ 触发 close（菜单收回）
  const inst2 = makeInst(desc, {
    x: 61, y: 715, items: ITEMS, radius: 140, spanStart: -105, spanEnd: 5
  });
  inst2._open();
  inst2.moveTo(5, 5);
  inst2.release();
  out.closeOnMiss = inst2.events.filter(e => e.name === 'close').length === 1 &&
    inst2.events.filter(e => e.name === 'select').length === 0;

  // 命中的容差：手指落在按钮中心 30px 内也算命中（不能要求像素级精确）
  const inst3 = makeInst(desc, {
    x: 61, y: 715, items: ITEMS, radius: 140, spanStart: -105, spanEnd: 5
  });
  inst3._open();
  const a3 = inst3.data.arranged;
  inst3.moveTo(inst3.properties.x + a3[2].dx + 18, inst3.properties.y + a3[2].dy + 18);
  out.hitTolerance = inst3.data.hot === 2;

  return out;
}

/* ============================================================
 * ③ 静态契约
 * ============================================================ */
/** 从 wxss 里算出「双向弹性」与「减弱动效去弹性」两个探针。
 *  静态断言和变异自证共用这一份实现，避免两处判定逻辑漂移。
 *  🔴 背景：只在 .hot 写死 scale(1.14)、默认态没有 transition ⇒ 加类瞬间跳变，
 *     用户实锤「生硬扩大」。所以两个方向都必须有 overshoot 贝塞尔。 */
function springProbes(wxss) {
  const btn = (/\.rm-btn\s*\{([^}]*)\}/.exec(wxss) || ['', ''])[1];
  const hot = (/\.rm-item\.hot\s+\.rm-btn\s*\{([^}]*)\}/.exec(wxss) || ['', ''])[1];
  // 必须是一条 transform 过渡，且贝塞尔 y1 > 1 ⇒ 有 overshoot（弹性）
  const springOn = body => {
    const m = /transition:\s*transform\s+[\d.]+ms\s+cubic-bezier\(\s*[\d.]+\s*,\s*([\d.]+)\s*,/.exec(body);
    return !!m && Number(m[1]) > 1.05;
  };
  const at = wxss.indexOf('@media (prefers-reduced-motion: reduce)');
  const reduced = at >= 0 ? wxss.slice(at) : '';
  return {
    // 放大（.hot 目标态）与缩回（默认态）各要弹一下
    hotSpring: springOn(btn) && springOn(hot) && /transform:\s*scale\(/.test(hot),
    // 减弱动效：去掉 overshoot，只留短光效；hot 不再缩放
    reducedNoBounce: /\n\s*\.rm-btn\s*\{[^}]*transition:/.test(reduced) &&
      !/cubic-bezier/.test(reduced) &&
      /\.rm-item\.hot\s+\.rm-btn\s*\{[^}]*transform:\s*none/.test(reduced)
  };
}

function staticProbes() {
  const sp = springProbes(WXSS);
  return {
    // 圆形 + 品牌色（不要白色方块）
    roundBtn: /\.rm-btn\s*\{[^}]*border-radius:\s*50%/.test(WXSS) &&
              /\.rm-btn\s*\{[^}]*width:\s*\d+rpx/.test(WXSS) &&
              /\.rm-btn\s*\{[^}]*height:\s*\d+rpx/.test(WXSS) &&
              /var\(--brand/.test(WXSS),
    // 高亮态存在（要能看出该松在哪）
    hotStyle: /\.rm-item\.hot/.test(WXSS),
    // 只有长按触发：按钮上**不能**再有 bindtap
    longPressOnly: /bindlongpress="onFabRadial"/.test(TT_WXML_RAW) &&
      !/bindtap="onFabRadial"/.test(TT_WXML_RAW),
    // 页面要转发触摸给组件（组件收不到 touchend）。touchmove 用 catch 只是
    // 额外拦冒泡给 page，不影响 handler 内部转发给组件，故 bind|catch 都认。
    touchForward: /(?:bind|catch)touchmove="onFabTouchMove"/.test(TT_WXML_RAW) &&
      /bindtouchend="onFabTouchEnd"/.test(TT_WXML_RAW) &&
      /selectComponent\('#rm-fab'\)/.test(TT_JS_RAW) &&
      /comp\.moveTo/.test(TT_JS_RAW) && /comp\.release/.test(TT_JS_RAW),
    /* 🔴 2026-11-16 真机复报：长按 FAB 展开菜单后拖动，后面的课程表跟着上下滑。
       根因：课表页无 spring-scroll 是原生 page 滚动，FAB 的 touchmove 用 bind
       ⇒ 冒泡给 page。长按手势的 target 在 touchstart 就锁定为 FAB，radial-menu
       后渲染的 mask（catchtouchmove）拦不住**这次正在进行的手势**。
       修法：FAB 的 touchmove 必须 catch，杜绝冒泡；转发给组件由 handler 内部做，
       与 catch 不冲突（catch 只拦冒泡，不影响自身 handler 执行）。 */
    noScrollBubble: /catchtouchmove="onFabTouchMove"/.test(TT_WXML_RAW) &&
      !/bindtouchmove="onFabTouchMove"/.test(TT_WXML_RAW),
    // 组件要有 id（页面 selectComponent 要按 id 找）
    compId: /id="rm-fab"/.test(TT_WXML_RAW),
    // 组件方法齐
    methods: /moveTo\s*\(/.test(JS) && /release\s*\(/.test(JS),
    // 手指滑上/移开都要「弹一下」，且减弱动效时不弹
    hotSpring: sp.hotSpring,
    reducedNoBounce: sp.reducedNoBounce,
    /* 🔴 2026-11-28「长按格子后的按钮没作用」：.rm-root 设 pointer-events:none，
       pointer-events 继承 ⇒ 按钮 .rm-item 也变 none，bindtap 收不到点击。
       FAB 靠 touch 转发掩盖了这点，长按格子菜单只有 bindtap ⇒ 彻底点不动。 */
    itemClickable: /\.rm-item\s*\{[^}]*pointer-events:\s*auto/.test(WXSS),
    /* 遮罩不再带 press-shrink / data-pressable（按压缩放露出灰色矩形边缘，
       1.0.8.72 已在 bottom-sheet 修过、本组件漏同步 —— 2026-11-28 用户截图实锤）。 */
    maskNoPress: !/hover-class="press-shrink"/.test((WXML.match(/class="rm-mask[^"]*"[^>]*>/) || [''])[0])
      && !/data-pressable/.test((WXML.match(/<view[^>]*class="rm-mask[^>]*>/) || [''])[0]),
    // 遮罩改柔和径向渐变；色标用 rpx（组件 wxss 百分比色标真机整条丢弃）
    maskRadial: /\.rm-mask\s*\{[^}]*radial-gradient/.test(WXSS) &&
      /--bg-mask-soft/.test(WXSS) && /0rpx/.test(WXSS) && /1000rpx/.test(WXSS),
    /* 🔴 2026-11-28 用户口径：「课程长按也要跟左下角按钮一样（按住滑到选项松手即选中），
       不是现在长按后再点按钮」。FAB 那条已靠 touch 转发实现；课程格子菜单缺三件：
       ① 组件要有 id="rm-cell" 才能 selectComponent；②有课格 + 空格子都要绑 touchstart/move/end；
       ③页面 handler 要调该组件的 moveTo/release。缺任一 ⇒ 只有 onItem 的 bindtap 生效。
       另：touchmove 必须 catch（原生 page 滚动会把课程表带着滑，与 FAB 同坑），
       且菜单展开时 page-meta 要锁 overflow（防穿透）。 */
    cellTouchForward: /id="rm-cell"/.test(TT_WXML_RAW) &&
      /bindtouchstart="onCellTouchStart"/.test(TT_WXML_RAW) &&
      /catchtouchmove="onCellTouchMove"/.test(TT_WXML_RAW) &&
      /bindtouchend="onCellTouchEnd"/.test(TT_WXML_RAW) &&
      /bindtouchcancel="onCellTouchEnd"/.test(TT_WXML_RAW) &&
      /onCellTouchMove/.test(TT_WXML_RAW) && /onCellLongPress/.test(TT_WXML_RAW) &&
      /selectComponent\('#rm-cell'\)/.test(TT_JS_RAW) &&
      /onCellTouchMove\s*\(/.test(TT_JS_RAW) && /onCellTouchEnd\s*\(/.test(TT_JS_RAW) &&
      /comp\.moveTo/.test(TT_JS_RAW) && /comp\.release/.test(TT_JS_RAW) &&
      /rmShow\s*\|\|/.test((TT_WXML_RAW.match(/<page-meta[^>]*>/) || [''])[0])
  };
}

/* ============================================================
 * ④ 逐条断言
 * ============================================================ */
console.log('── ① 组件结构与外观');
const sp = staticProbes();
Object.keys(sp).forEach(k => check(sp[k], '静态契约 ' + k));

console.log('── ② 行为（vm 真加载组件）');
const bp = behaviorProbes();
check(bp.count, '展开出 4 个菜单项');
check(bp.keys, '菜单项 key 与传入一致');
check(bp.evenSpacing, '弧上间距一致（相邻弦长相等）');
check(bp.inScreen, '所有菜单项都在屏幕内（不出屏、不被 tabBar 压住）');
check(bp.hitHot, '手指移到某项上会高亮该项');
check(bp.hitTolerance, '手指落在按钮中心 30px 内也算命中');
check(bp.missHot, '手指移开则取消高亮');
check(bp.selectOnHot, '松手且命中 ⇒ 触发 select（key 正确）');
check(bp.closeOnMiss, '松手且没命中 ⇒ 触发 close（菜单收回）');

/* ============================================================
 * ⑤ 变异自证（好样本必须能被改成坏样本并翻红）
 * ============================================================ */
console.log('── ③ 变异自证');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
const mutants = [
  {
    name: 'release() 不做命中判定（松手永远不选中、菜单也不收回）',
    scope: 'js', expect: 'selectOnHot',
    build: () => {
      const m = mutate(JS, "if (hot >= 0 && this.data.arranged[hot]) {", "if (false) {");
      return m === null ? null : { js: m };
    }
  },
  {
    name: '命中半径缩到 2px（手指对不准，永远选不中）',
    scope: 'js', expect: 'hitTolerance',
    build: () => {
      const m = mutate(JS, 'const HIT = 52;', 'const HIT = 2;');
      return m === null ? null : { js: m };
    }
  },
  {
    name: '整弧平移改成逐点夹取（间距被挤乱）',
    scope: 'js', expect: 'evenSpacing',
    build: () => {
      const m = mutate(JS, 'pts.forEach(p => { p.dx += shiftX; p.dy += shiftY; });',
        'pts.forEach(p => { p.dx = Math.max(p.dx, 40 - 61); });');
      return m === null ? null : { js: m };
    }
  },
  {
    name: '按钮退回白色方块（border-radius 取消 + 去掉品牌色）',
    scope: 'wxss', expect: 'roundBtn',
    build: () => {
      const m = mutate(WXSS, 'border-radius: 50%;', 'border-radius: 24rpx;');
      return m === null ? null : { wxss: m };
    }
  },
  {
    name: '按钮又加回 bindtap（轻点也会弹出没人操作的菜单）',
    scope: 'ttwxml', expect: 'longPressOnly',
    build: () => {
      const m = mutate(TT_WXML_RAW, 'bindlongpress="onFabRadial"', 'bindlongpress="onFabRadial" bindtap="onFabRadial"');
      return m === null ? null : { ttwxml: m };
    }
  },
  {
    name: '页面不再转发触摸（组件收不到松手，菜单永远不收回）',
    scope: 'ttjs', expect: 'touchForward',
    build: () => {
      const m = mutate(TT_JS_RAW, 'if (comp && comp.release) comp.release();', '');
      return m === null ? null : { ttjs: m };
    }
  },
  {
    /* 2026-11-16：touchmove 退回 bind（冒泡给原生 page 滚动）⇒ 长按拖动菜单
       会带着课程表一起上下滑。noScrollBubble 必须翻红。 */
    name: 'FAB touchmove 退回 bind（长按拖动穿透滚动课程表）',
    scope: 'ttwxml', expect: 'noScrollBubble',
    build: () => {
      const m = mutate(TT_WXML_RAW, 'catchtouchmove="onFabTouchMove"', 'bindtouchmove="onFabTouchMove"');
      return m === null ? null : { ttwxml: m };
    }
  },
  {
    name: '默认态删掉 transition（又变回「生硬扩大 / 生硬缩回」）',
    scope: 'wxss', expect: 'hotSpring',
    build: () => {
      const m = mutate(WXSS,
        'transition: transform 300ms cubic-bezier(.34, 1.7, .64, 1), box-shadow 300ms ease, filter 300ms ease;',
        'transition: none;');
      return m === null ? null : { wxss: m };
    }
  },
  {
    name: '弹性曲线换成 ease-out（没有 overshoot，只是平滑放大）',
    scope: 'wxss', expect: 'hotSpring',
    build: () => {
      const m = mutate(WXSS, 'cubic-bezier(.34, 1.7, .64, 1)', 'ease-out');
      return m === null ? null : { wxss: m };
    }
  },
  {
    name: '减弱动效下仍保留弹性（reduced-motion 未去 overshoot）',
    scope: 'wxss', expect: 'reducedNoBounce',
    build: () => {
      const m = mutate(WXSS, '.rm-btn { transition: box-shadow .12s ease, filter .12s ease; }', '');
      return m === null ? null : { wxss: m };
    }
  },
  {
    /* 2026-11-28：删掉 .rm-item 的 pointer-events:auto ⇒ 按钮又点不动（长按格子菜单失效） */
    name: '按钮 pointer-events 恢复被删（长按格子按钮又点不动）',
    scope: 'wxss', expect: 'itemClickable',
    build: () => {
      const m = mutate(WXSS, '  pointer-events: auto;', '  /* pointer-events removed */');
      return m === null ? null : { wxss: m };
    }
  },
  {
    /* 2026-11-28：遮罩又加回 press-shrink/data-pressable（灰矩形边缘回来） */
    name: '遮罩按压态回来（灰矩形边缘）',
    scope: 'wxml', expect: 'maskNoPress',
    build: () => {
      const m = mutate(WXML, '<view class="rm-mask" bindtap="onMask"',
        '<view hover-class="press-shrink" data-pressable class="rm-mask" bindtap="onMask"');
      return m === null ? null : { wxml: m };
    }
  },
  {
    /* 2026-11-28：遮罩退回纯色（死板一整块灰） */
    name: '遮罩退回纯色径向渐变被删',
    scope: 'wxss', expect: 'maskRadial',
    build: () => {
      const m = mutate(WXSS,
        'background: radial-gradient(ellipse 160% 110% at 50% 40%, var(--bg-mask-soft, rgba(0,0,0,0.26)) 0rpx, var(--bg-mask, rgba(0,0,0,0.45)) 1000rpx);',
        'background: var(--bg-mask, rgba(0,0,0,0.45));');
      return m === null ? null : { wxss: m };
    }
  },
  {
    /* 2026-11-28：课程长按菜单删 id ⇒ 页面拿不到组件，退回答「长按后再点」 */
    name: '课程菜单删 id（页面转发不到，退回长按后再点）',
    scope: 'ttwxml', expect: 'cellTouchForward',
    build: () => {
      const m = mutate(TT_WXML_RAW, 'id="rm-cell"', '');
      return m === null ? null : { ttwxml: m };
    }
  },
  {
    /* 2026-11-28：页面不再转发课程格子的 touch ⇒ release 收不到，松手不选中 */
    name: '页面不转发课程 touch（松手不选中）',
    scope: 'ttjs', expect: 'cellTouchForward',
    build: () => {
      const m = mutate(TT_JS_RAW, "selectComponent('#rm-cell')", "selectComponent('#rm-none')");
      return m === null ? null : { ttjs: m };
    }
  },
  {
    /* 2026-11-28：课程格子 touchmove 退回 bind ⇒ 长按拖动带着课程表一起滑 */
    name: '课程 touchmove 退回 bind（拖动穿透滚动）',
    scope: 'ttwxml', expect: 'cellTouchForward',
    build: () => {
      const m = mutate(TT_WXML_RAW, 'catchtouchmove="onCellTouchMove"', 'bindtouchmove="onCellTouchMove"');
      return m === null ? null : { ttwxml: m };
    }
  }
];

function runWith(over) {
  const js = over.js || JS;
  const wxss = over.wxss || WXSS;
  const wxml = over.wxml || WXML;
  const ttwxml = over.ttwxml || TT_WXML_RAW;
  const ttjs = over.ttjs || TT_JS_RAW;
  const desc = loadComponent(js);
  const res = {};
  // 静态
  res.roundBtn = /\.rm-btn\s*\{[^}]*border-radius:\s*50%/.test(wxss) &&
    /\.rm-btn\s*\{[^}]*width:\s*\d+rpx/.test(wxss) &&
    /\.rm-btn\s*\{[^}]*height:\s*\d+rpx/.test(wxss) && /var\(--brand/.test(wxss);
  res.longPressOnly = /bindlongpress="onFabRadial"/.test(ttwxml) && !/bindtap="onFabRadial"/.test(ttwxml);
  res.itemClickable = /\.rm-item\s*\{[^}]*pointer-events:\s*auto/.test(wxss);
  res.maskNoPress = !/hover-class="press-shrink"/.test((wxml.match(/class="rm-mask[^"]*"[^>]*>/) || [''])[0])
    && !/data-pressable/.test((wxml.match(/<view[^>]*class="rm-mask[^>]*>/) || [''])[0]);
  res.maskRadial = /\.rm-mask\s*\{[^}]*radial-gradient/.test(wxss) &&
    /--bg-mask-soft/.test(wxss) && /0rpx/.test(wxss) && /1000rpx/.test(wxss);
  res.touchForward = /(?:bind|catch)touchmove="onFabTouchMove"/.test(ttwxml) &&
    /bindtouchend="onFabTouchEnd"/.test(ttwxml) &&
    /selectComponent\('#rm-fab'\)/.test(ttjs) && /comp\.moveTo/.test(ttjs) && /comp\.release/.test(ttjs);
  res.noScrollBubble = /catchtouchmove="onFabTouchMove"/.test(ttwxml) &&
    !/bindtouchmove="onFabTouchMove"/.test(ttwxml);
  res.cellTouchForward = /id="rm-cell"/.test(ttwxml) &&
    /bindtouchstart="onCellTouchStart"/.test(ttwxml) &&
    /catchtouchmove="onCellTouchMove"/.test(ttwxml) &&
    /bindtouchend="onCellTouchEnd"/.test(ttwxml) &&
    /bindtouchcancel="onCellTouchEnd"/.test(ttwxml) &&
    /onCellTouchMove/.test(ttwxml) && /onCellLongPress/.test(ttwxml) &&
    /selectComponent\('#rm-cell'\)/.test(ttjs) &&
    /onCellTouchMove\s*\(/.test(ttjs) && /onCellTouchEnd\s*\(/.test(ttjs) &&
    /comp\.moveTo/.test(ttjs) && /comp\.release/.test(ttjs) &&
    /rmShow\s*\|\|/.test((ttwxml.match(/<page-meta[^>]*>/) || [''])[0]);
  const sp = springProbes(wxss);
  res.hotSpring = sp.hotSpring;
  res.reducedNoBounce = sp.reducedNoBounce;
  // 行为
  const inst = makeInst(desc, { x: 61, y: 715, items: ITEMS, radius: 140, spanStart: -105, spanEnd: 5 });
  inst._open();
  const arr = inst.data.arranged || [];
  let chords = [];
  for (let i = 1; i < arr.length; i++) {
    const dx = arr[i].dx - arr[i - 1].dx, dy = arr[i].dy - arr[i - 1].dy;
    chords.push(Math.sqrt(dx * dx + dy * dy));
  }
  res.evenSpacing = chords.length > 0 && chords.every(c => Math.abs(c - chords[0]) < 1.5);
  const t1 = { x: inst.properties.x + arr[1].dx, y: inst.properties.y + arr[1].dy };
  inst.moveTo(t1.x, t1.y);
  const t3 = { x: inst.properties.x + arr[2].dx + 18, y: inst.properties.y + arr[2].dy + 18 };
  inst.moveTo(t3.x, t3.y);
  res.hitTolerance = inst.data.hot === 2;
  inst.moveTo(t1.x, t1.y);
  inst.release();
  res.selectOnHot = inst.events.filter(e => e.name === 'select').length === 1 &&
    inst.events.filter(e => e.name === 'select')[0].detail.key === 'A';
  return res;
}

mutants.forEach(mt => {
  const over = mt.build();
  if (!over) { bad('变异锚点没命中源码：' + mt.name); return; }
  const BASES = { js: JS, wxss: WXSS, wxml: WXML, ttwxml: TT_WXML_RAW, ttjs: TT_JS_RAW };
  const changed = Object.keys(over).some(k => over[k] !== BASES[k]);
  if (!changed) { bad('变异替换没生效：' + mt.name); return; }
  const r = runWith(over);
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0 ? '\nOK · 弧形菜单（长按展示 / 拖到按钮松手即选中 / 松手收回 / 圆形 / 间距一致 / 悬停双向弹性）门禁全部通过'
  : '\nFAIL · 弧形菜单门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
