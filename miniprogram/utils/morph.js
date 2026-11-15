/**
 * 形态变换源矩形（v1.0.9.0 · #1）
 * ============================================================
 * 胶囊按钮 → 对话框 的 FLIP 形态变换需要「起始矩形」（按钮在屏幕上的位置/尺寸）。
 * 调用方在点击触发按钮时量出它的 rect，存到这里；打开 dialog 时把同一份 rect
 * 通过 `morphRect` 属性传进去，dialog 据此从胶囊位置/尺寸长开到对话框。
 *
 * 用模块级单例存（一次只可能有一个弹层在变形），不进 storage、不跨页。
 *
 * 🔴 v1.0.8.40：首页「本班请假」的容器共享元素转场已按用户要求整体回退
 * （恢复为标准贴底抽屉、从底部升起）。原先加在这里的 sheetTargetRect /
 * flipFromTo / morphInline / faceInline / MORPH_MS / MORPH_EASE 一并删除，
 * 本文件只保留 dialog 那套单例，不再承担任何容器 FLIP 职责。
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

module.exports = {
  setSource, getSource, clearSource, captureFromEvent
};
