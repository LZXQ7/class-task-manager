/**
 * 门禁：首页「本班请假」卡 → 详情的**卡面层**（1.0.8.32）
 * ============================================================
 * 1.0.10.7 翻车点：源卡被藏掉、真实面板从源矩形长开，但面板是近白玻璃底 +
 * 内容全淡出 ⇒ 用户实拍判为「加了一个矩形，不是从卡片展开的」。
 *
 * 本门禁钉死修正方案的三件事：
 *   ① 卡面层与源卡**共用同一份 WXML template**（不是另画一张相似的白板）；
 *   ② 卡面层用 counter-scale 抵消面板的非等比 scale(sx,sy)，几何闭环可验；
 *   ③ 转场期面板底色透明、卡面瞬间显形 / 同拍淡出（不能先空一拍）。
 *
 * 断言分两层：vm 真跑 utils/morph.js 的几何函数 + 静态契约；
 * 再用「改坏 → 对应探针必须翻红」做变异自证，防止判据变成摆设。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const F = {
  morphJs: 'miniprogram/utils/morph.js',
  bsJs: 'miniprogram/components/bottom-sheet/index.js',
  bsWxml: 'miniprogram/components/bottom-sheet/index.wxml',
  bsWxss: 'miniprogram/components/bottom-sheet/index.wxss',
  homeWxml: 'miniprogram/pages/home/index.wxml',
  homeWxss: 'miniprogram/pages/home/index.wxss'
};
const SRC = {};
Object.keys(F).forEach(k => { SRC[k] = fs.readFileSync(path.join(ROOT, F[k]), 'utf8'); });

let failed = 0;
function check(ok, name) {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) failed++;
}
function bad(msg) { console.log('  FAIL  ' + msg); failed++; }
function strip(s, kind) {
  if (kind === 'wxml') return s.replace(/<!--[\s\S]*?-->/g, '');
  if (kind === 'css') return s.replace(/\/\*[\s\S]*?\*\//g, '');
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function eq(a, b, tol) { return Math.abs(Number(a) - Number(b)) < (tol || 0.02); }

/* ---------- ① 几何行为：vm 真跑 morph.js ---------- */
function loadMorph(src) {
  const box = { module: { exports: {} }, Math, Number, isFinite, JSON, console };
  try { vm.runInNewContext(src, box, { filename: 'morph.js' }); } catch (e) { return null; }
  return box.module.exports;
}
const WIN = { windowWidth: 375, windowHeight: 812 };
const SIZE = { width: 375, height: 600 };
const FROM = { left: 16, top: 300, width: 343, height: 120 };

function behavior(morphJs) {
  const m = loadMorph(morphJs);
  if (!m || typeof m.faceInline !== 'function' || !m.flipFromTo || !m.sheetTargetRect) return null;
  const to = m.sheetTargetRect(WIN, SIZE);
  const g = m.flipFromTo(FROM, to);
  const f = m.faceInline(g, FROM);
  const w = Number((/width:([\d.]+)px/.exec(f) || [])[1]);
  const h = Number((/height:([\d.]+)px/.exec(f) || [])[1]);
  const sc = /transform:scale\(([\d.]+),([\d.]+)\)/.exec(f);
  const ix = sc ? Number(sc[1]) : 0, iy = sc ? Number(sc[2]) : 0;
  return {
    origin00: /transform-origin:0 0;/.test(f),
    sizeMatches: eq(w, FROM.width) && eq(h, FROM.height),
    inverseX: eq(ix, 1 / g.sx) && eq(iy, 1 / g.sy),
    fillsTarget: eq(w * ix, to.width) && eq(h * iy, to.height),
    // 闭环：卡面按源卡尺寸排版 → 自身反缩放铺满终态盒 → 被面板 scale 压回源卡
    roundTrip: eq(w * ix * g.sx, FROM.width) && eq(h * iy * g.sy, FROM.height),
    invalid: m.faceInline(null, FROM) === '' && m.faceInline(g, null) === ''
      && m.faceInline({ sx: 0, sy: 1 }, FROM) === '',
    noNaN: !/NaN|Infinity/.test(f)
  };
}

/* ---------- ② 静态契约 ---------- */
function statics(s) {
  const mj = strip(s.morphJs, 'js'), js = strip(s.bsJs, 'js');
  const w = strip(s.bsWxml, 'wxml'), css = strip(s.bsWxss, 'css');
  const hw = strip(s.homeWxml, 'wxml'), hc = strip(s.homeWxss, 'css');
  const faces = hw.match(/data="\{\{leaveHomeMode,[^}]*\}\}"/g) || [];
  return {
    exported: /faceInline/.test(mj) && /module\.exports[\s\S]*faceInline/.test(mj),
    dataField: /morphFaceStyle:\s*''/.test(js),
    startWire: /morphFaceStyle:\s*morph\.faceInline\(g,\s*from\)/.test(js),
    closeWire: /morphFaceStyle:\s*morph\.faceInline\(this\._morphGeo,\s*this\.properties\.originRect\)/.test(js),
    resetWire: (js.match(/morphFaceStyle:\s*''/g) || []).length >= 1,
    faceNode: /class="sheet-face" style="\{\{morphFaceStyle\}\}"/.test(w)
      && /<slot name="face"\s*\/>/.test(w),
    multipleSlots: /multipleSlots:\s*true/.test(js),
    /* ⚠️ 块内匹配一律用 `[^}]*`，不能用 `[\s\S]*?` —— 后者会跨出当前规则块，
       把后面某条规则的 background 算进本块（判据假红）。 */
    faceDefault: /\.sheet-face\s*\{[^}]*opacity:\s*0;[^}]*\}/.test(css)
      && /\.sheet-face\s*\{[^}]*pointer-events:\s*none;[^}]*\}/.test(css),
    faceStart: /\.sheet-root\.morph \.sheet-face\s*\{[^}]*opacity:\s*1;[^}]*transition:\s*none;/.test(css),
    faceEnd: /\.sheet-root\.morph\.morph-show \.sheet-face\s*\{[^}]*opacity:\s*0;[^}]*transition:\s*opacity \.24s/.test(css),
    panelTransparent: /\.sheet-root\.morph \.sheet-panel\s*\{[^}]*background:\s*transparent;/.test(css),
    panelRestore: /\.sheet-root\.morph\.morph-show \.sheet-panel\s*\{[^}]*var\(--sheet-bg/.test(css),
    reducedFace: /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sheet-root\.morph \.sheet-face,/.test(css),
    sharedTemplate: /<template name="lhFace">/.test(hw)
      && (hw.match(/is="lhFace"/g) || []).length === 2,
    sameFields: faces.length === 2 && faces[0] === faces[1],
    faceSlotHome: /<view slot="face" class="card leave-home lh-face-card">/.test(hw),
    pageMetaFirst: hw.indexOf('<page-meta') >= 0
      && hw.indexOf('<page-meta') < hw.indexOf('<template'),
    faceFill: /\.lh-face-card\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/.test(hc),
    noBareHex: !/\.lh-face-card\s*\{[^}]*background:\s*#[0-9a-fA-F]{3,8}\s*;/.test(hc)
  };
}

/* ---------- ③ 变异自证 ---------- */
const MUT = [
  { name: '删掉卡面层 slot（卡面永远不渲染）', file: 'bsWxml', probe: 'faceNode',
    from: '<slot name="face" />', to: '' },
  { name: '起点帧不下发 counter-scale', file: 'bsJs', probe: 'startWire',
    from: 'morphFaceStyle: morph.faceInline(g, from)', to: "morphFaceStyle: ''" },
  { name: '关闭帧不重算 counter-scale', file: 'bsJs', probe: 'closeWire',
    from: 'morphFaceStyle: morph.faceInline(this._morphGeo, this.properties.originRect)', to: "morphFaceStyle: ''" },
  { name: 'counter-scale 退化成 scale(1,1)（内容被拉扁）', file: 'morphJs', probe: 'inverseX', behavior: true,
    from: 'const ix = Number((1 / g.sx).toFixed(4)), iy = Number((1 / g.sy).toFixed(4));',
    to: 'const ix = Number((1).toFixed(4)), iy = Number((1).toFixed(4));' },
  { name: '卡面 transform-origin 改成 center（起点矩形挪走）', file: 'morphJs', probe: 'origin00', behavior: true,
    from: "return 'width:' + w.toFixed(2) + 'px;height:' + h.toFixed(2) + 'px;'\n    + 'transform-origin:0 0;transform:scale('",
    to: "return 'width:' + w.toFixed(2) + 'px;height:' + h.toFixed(2) + 'px;'\n    + 'transform-origin:center center;transform:scale('" },
  { name: '源卡不再共用 template（又变成两张卡）', file: 'homeWxml', probe: 'sharedTemplate',
    from: '<template is="lhFace"', to: '<template is="lhFaceOld"' },
  { name: '两个调用点字段串不一致', file: 'homeWxml', probe: 'sameFields',
    from: 'leaveHomeLeaveB, leaveHomeClasses}}" />', to: 'leaveHomeLeaveB}}" />' },
  { name: '起点帧卡面不瞬间显形（先空一拍）', file: 'bsWxss', probe: 'faceStart',
    from: '.sheet-root.morph .sheet-face {\n  opacity: 1;', to: '.sheet-root.morph .sheet-face {\n  opacity: 0;' },
  { name: '转场期面板底色不透明（又露出白板）', file: 'bsWxss', probe: 'panelTransparent',
    from: '.sheet-root.morph .sheet-panel {\n  background: transparent;',
    to: '.sheet-root.morph .sheet-panel {\n  background: #FFFFFF;' },
  { name: '卡面层不铺满容器', file: 'homeWxss', probe: 'faceFill',
    from: '.lh-face-card {\n  width: 100%;', to: '.lh-face-card {\n  width: 50%;' },
  { name: '减弱动效段漏掉卡面层', file: 'bsWxss', probe: 'reducedFace',
    from: '.sheet-root.morph .sheet-face,', to: '.sheet-root.morph .sheet-face-off,' }
];

console.log('=== 1.0.8.32 卡面层（共享元素转场起点帧）门禁 ===');
const B = behavior(SRC.morphJs);
console.log('\n── ① 几何行为（vm 真跑 utils/morph.js）');
if (!B) { bad('morph.js 无法在 vm 中加载 / 缺 faceInline'); }
else {
  check(B.origin00, '卡面 transform-origin 固定 0 0（counter-scale 不偏移）');
  check(B.sizeMatches, '卡面按**源卡尺寸**排版，不是按终态面板尺寸');
  check(B.inverseX, '卡面 scale = 1/sx, 1/sy（精确抵消面板非等比缩放）');
  check(B.fillsTarget, '反缩放后卡面恰好铺满面板终态布局盒');
  check(B.roundTrip, '几何闭环：卡面 → 反缩放 → 面板缩放 = 精确还原源卡矩形');
  check(B.invalid, '源矩形/几何非法时返回空串（安全降级）');
  check(B.noNaN, '内联样式不含 NaN / Infinity');
}

const S = statics(SRC);
console.log('\n── ② 静态契约（真实节点 + 同一份 WXML + 同一拍）');
check(S.exported, 'morph.js 导出 faceInline');
check(S.dataField && S.resetWire, '组件 data 有 morphFaceStyle，收尾/卸载会清空');
check(S.startWire && S.closeWire, '起点帧下发、关闭帧重算 counter-scale');
check(S.faceNode && S.multipleSlots, '.sheet-face 真实节点 + 具名 slot + multipleSlots 已开');
check(S.faceDefault && S.faceStart && S.faceEnd, '卡面三态齐备：默认隐藏 / 起点瞬间显形 / 终点 240ms 淡出');
check(S.panelTransparent && S.panelRestore, '转场期面板底色透明，终点帧长回 sheet 材质');
check(S.reducedFace, 'prefers-reduced-motion 段显式覆盖卡面层');
check(S.sharedTemplate && S.sameFields, '源卡与卡面层共用同一 template，且 data 字段串完全一致');
check(S.faceSlotHome && S.faceFill && S.noBareHex, '首页 face slot 接好、卡面铺满、无裸浅色 hex');
check(S.pageMetaFirst, 'template 定义在 page-meta 之后（check-scroll-lock 要求）');

console.log('\n── ③ 变异自证（改坏 → 探针必须翻红）');
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
  } else {
    caught = statics(next)[mu.probe] === false;
  }
  check(caught, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '❌ ' + failed + ' 项不通过' : '✅ 卡面层（共享元素转场起点帧）检查全部通过'));
process.exit(failed ? 1 : 0);
