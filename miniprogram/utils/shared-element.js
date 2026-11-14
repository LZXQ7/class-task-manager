/**
 * 共享元素转场（v1.0.9.0 · #2）源数据暂存
 * ============================================================
 * 源页（列表里的卡片）点击时量出自己的矩形 + 主题色 + 标签，存到这里；
 * 目标页（详情）onReady 量出 hero 矩形的位置后，用 shared-element 组件把「源矩形」
 * FLIP 到「目标矩形」，观感是「卡片飞进详情页」。
 *
 * 用模块级单例（一次只可能有一个转场在飞），不进 storage、不跨会话。
 */
let _pending = null;

/**
 * @param {Object} hero { rect:{left,top,width,height}(px,视口坐标), color, label }
 */
function setHero(hero) {
  if (hero && hero.rect && hero.rect.width) _pending = hero;
  else _pending = null;
}
/** 取出并清空（取走即消费，避免回退后再误用） */
function takeHero() {
  const h = _pending;
  _pending = null;
  return h;
}
function peekHero() {
  return _pending;
}

module.exports = { setHero, takeHero, peekHero };
