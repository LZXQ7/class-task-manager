#!/usr/bin/env node
/**
 * 门禁：课表弧形菜单（#10，2026-11-14 按用户口径重做）
 * ================================================================
 * 用户口径：
 *   ① **长按才展开**，按住期间菜单一直在；轻点不展开。
 *   ② **手指拖到某个按钮上松开 = 点了那个按钮**。
 *   ③ **按住展开后直接松手（没拖到按钮）⇒ 四个按钮收回**。
 *   ④ 按钮是**圆形**、配色跟随整体；弧上**间距一致**、不出屏。
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
function staticProbes() {
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
    // 页面要转发触摸给组件（组件收不到 touchend）
    touchForward: /bindtouchmove="onFabTouchMove"/.test(TT_WXML_RAW) &&
      /bindtouchend="onFabTouchEnd"/.test(TT_WXML_RAW) &&
      /selectComponent\('#rm-fab'\)/.test(TT_JS_RAW) &&
      /comp\.moveTo/.test(TT_JS_RAW) && /comp\.release/.test(TT_JS_RAW),
    // 组件要有 id（页面 selectComponent 要按 id 找）
    compId: /id="rm-fab"/.test(TT_WXML_RAW),
    // 组件方法齐
    methods: /moveTo\s*\(/.test(JS) && /release\s*\(/.test(JS)
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
  }
];

function runWith(over) {
  const js = over.js || JS;
  const wxss = over.wxss || WXSS;
  const ttwxml = over.ttwxml || TT_WXML_RAW;
  const ttjs = over.ttjs || TT_JS_RAW;
  const desc = loadComponent(js);
  const res = {};
  // 静态
  res.roundBtn = /\.rm-btn\s*\{[^}]*border-radius:\s*50%/.test(wxss) &&
    /\.rm-btn\s*\{[^}]*width:\s*\d+rpx/.test(wxss) &&
    /\.rm-btn\s*\{[^}]*height:\s*\d+rpx/.test(wxss) && /var\(--brand/.test(wxss);
  res.longPressOnly = /bindlongpress="onFabRadial"/.test(ttwxml) && !/bindtap="onFabRadial"/.test(ttwxml);
  res.touchForward = /bindtouchmove="onFabTouchMove"/.test(ttwxml) &&
    /bindtouchend="onFabTouchEnd"/.test(ttwxml) &&
    /selectComponent\('#rm-fab'\)/.test(ttjs) && /comp\.moveTo/.test(ttjs) && /comp\.release/.test(ttjs);
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
  const changed = Object.keys(over).some(k => over[k] !== (k === 'js' ? JS : k === 'wxss' ? WXSS : k === 'ttwxml' ? TT_WXML_RAW : TT_JS_RAW));
  if (!changed) { bad('变异替换没生效：' + mt.name); return; }
  const r = runWith(over);
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0 ? '\nOK · 弧形菜单（长按展示 / 拖到按钮松手即选中 / 松手收回 / 圆形 / 间距一致）门禁全部通过'
  : '\nFAIL · 弧形菜单门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
