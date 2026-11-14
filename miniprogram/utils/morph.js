/**
 * 形态变换源矩形（v1.0.9.0 · #1）
 * ============================================================
 * 胶囊按钮 → 对话框 的 FLIP 形态变换需要「起始矩形」（按钮在屏幕上的位置/尺寸）。
 * 调用方在点击触发按钮时量出它的 rect，存到这里；打开 dialog 时把同一份 rect
 * 通过 `morphRect` 属性传进去，dialog 据此从胶囊位置/尺寸长开到对话框。
 *
 * 用模块级单例存（一次只可能有一个弹层在变形），不进 storage、不跨页。
 */
let _src = null;

/** 记录源矩形（px，视口坐标）。rect = { left, top, width, height }；非法值忽略。 */
function setSource(rect) {
  if (rect && rect.width && rect.height) _src = rect;
  else _src = null;
}
/** 取出源矩形（取后不清除，允许「打开失败重试」仍能用同一份） */
function getSource() {
  return _src;
}
function clearSource() {
  _src = null;
}

/**
 * 从一次 tap 事件的 currentTarget 量出矩形并存入。
 * @param {Object} e 小程序 tap 事件（e.currentTarget 是触发元素）
 * @returns {Object|null} 量到的 rect，量不到返回 null
 */
function captureFromEvent(e) {
  const t = e && (e.currentTarget || (e.detail && e.detail.target));
  if (!t || !t.dataset) return null;
  // 优先用 precomputed rect（页面可提前量好存进 dataset），否则发起一次查询（异步，不阻塞）
  if (t.dataset.rect) {
    try { setSource(JSON.parse(t.dataset.rect)); return _src; } catch (err) { /* ignore */ }
  }
  return null;
}

/* ============================================================
 * 容器共享元素转场（v1.0.10.7 · 首页本班请假）
 * ------------------------------------------------------------
 * 与 #1「胶囊 → 对话框」的区别：那次是**固定比例**缩放（只按宽度比），
 * 这次要的是「卡片容器本身」从源矩形**连续平滑**长成详情面板 —— 位置、宽、高
 * 三个维度都要精确对齐源卡片，所以必须用 **非等比 scale(sx, sy)** + translate，
 * 且 transform-origin 固定 0 0（否则中心缩放会把起点矩形挪走）。
 *
 * 两个纯函数（不依赖 wx / 组件实例），门禁用 vm 真跑几何闭环与变异自证：
 *   flipFromTo(from,to)  只算几何；非法矩形返回 null ⇒ 调用方安全降级到默认升起
 *   morphInline(g,...)   把几何翻成 WXML 内联样式字符串
 *
 * ⚠️ 非等比 scale 会把文字拉伸变形 ⇒ 容器变换期间内容必须**交叉淡出**（.morph-fade），
 *    落定后再淡入。这是 container transform 的标准做法，不是可选项。
 * ============================================================ */
const MORPH_MS = 240;                                 // 与 popup-anim DURATION / .sheet-mask .24s 严格对齐
/* 用 EASE.out 而不是 fluid：容器缩放不允许超调（面板会越出终态再回弹 ⇒ 露边/抖动），
   且与 .sheet-panel 既有 transform 曲线、.sheet-mask 曲线完全一致 ⇒ 背景与容器真正同步。 */
const MORPH_EASE = 'cubic-bezier(.22,.61,.36,1)';

/**
 * 由「窗口尺寸 + 面板布局尺寸」推导面板终态矩形（px，视口坐标）。
 * ⚠️ 刻意**不用** boundingClientRect 量终态：面板此刻带 .up / inline transform，
 *    boundingClientRect 给的是**视觉矩形**（含 transform）⇒ 会量到入场中途的位置，
 *    这正是 1.0.10.4 头像转场「落点偏移」踩过的坑。fields({size:true}) 给的是
 *    布局尺寸、与 transform 无关（见 bottom-sheet/_measurePanelH 注释），
 *    而 sheet 变体的面板是 left:0;right:0;bottom:0 ⇒ left=0、top=窗口高−面板高。
 * @returns {Object|null} { left, top, width, height }；尺寸非法返回 null（调用方降级不播）
 */
function sheetTargetRect(win, size) {
  if (!win || !size) return null;
  const W = Number(win.windowWidth), H = Number(win.windowHeight);
  const w = Number(size.width), h = Number(size.height);
  if (!(W > 0) || !(H > 0) || !(w > 0) || !(h > 0)) return null;
  return { left: 0, top: H - h, width: w, height: h };
}

/** 算 FLIP 几何：把 to 矩形「钉」回 from 矩形所需的位移与缩放。 */
function flipFromTo(from, to) {
  if (!from || !to) return null;
  const fw = Number(from.width), fh = Number(from.height);
  const tw = Number(to.width), th = Number(to.height);
  if (!(fw > 0) || !(fh > 0) || !(tw > 0) || !(th > 0)) return null;
  const dx = Number(from.left) - Number(to.left);
  const dy = Number(from.top) - Number(to.top);
  const sx = fw / tw, sy = fh / th;
  if (!isFinite(dx) || !isFinite(dy) || !isFinite(sx) || !isFinite(sy)) return null;
  return { dx: dx, dy: dy, sx: sx, sy: sy };
}

/**
 * 生成面板内联样式。
 * @param {Object} g       flipFromTo 的结果
 * @param {boolean} atStart true=起点（源矩形）；false=终点（面板终态）
 * @param {boolean} animate 起点帧必须 false（瞬间定位，不能先播一段回退动画）；
 *                          终点帧与「关闭缩回」必须 true（带过渡）
 * @param {string} radiusStart 源卡片圆角 CSS（如 '32rpx'）
 * @param {string} radiusEnd   面板终态圆角 CSS（如 '24rpx 24rpx 0 0'）
 */
function morphInline(g, atStart, animate, ms, ease, radiusStart, radiusEnd) {
  if (!g) return '';
  const tx = atStart ? g.dx.toFixed(2) + 'px' : '0px';
  const ty = atStart ? g.dy.toFixed(2) + 'px' : '0px';
  const sx = atStart ? g.sx.toFixed(4) : '1';
  const sy = atStart ? g.sy.toFixed(4) : '1';
  const tr = animate
    ? 'transition:transform ' + (ms || MORPH_MS) + 'ms ' + (ease || MORPH_EASE)
      + ', border-radius ' + (ms || MORPH_MS) + 'ms ' + (ease || MORPH_EASE) + ';'
    : 'transition:none;';
  const r = atStart ? (radiusStart || '32rpx') : (radiusEnd || '24rpx 24rpx 0 0');
  return 'transform-origin:0 0;transform:translate(' + tx + ',' + ty + ') scale(' + sx + ',' + sy + ');'
    + 'border-radius:' + r + ';' + tr;
}

module.exports = {
  setSource, getSource, clearSource, captureFromEvent,
  flipFromTo, morphInline, sheetTargetRect, MORPH_MS, MORPH_EASE
};
