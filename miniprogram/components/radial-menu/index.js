/**
 * 课程表弧形菜单（v1.0.9.0 · #10）
 * ============================================================
 * 长按课程表某格（或任意触发点）展开一个从触点放射性铺开的弧形菜单。
 * 菜单项沿一条圆弧排布（默认 -70°~+70° 的右半圆，可随需要调 span），
 * 从触点向外弹出（scale 0→1 + 位移），带轻微交错延迟。
 *
 * 用法（页面里）：
 *   <radial-menu show="{{rmShow}}" x="{{rmX}}" y="{{rmY}}" items="{{rmItems}}"
 *                bind:close="onRmClose" bind:select="onRmSelect" />
 * 注意：页面应只在 motion.on('radial') 为 true 时才让它可触发（FLAG 关掉就整体退化）。
 */
const motion = require('../../utils/motion');

const RADIUS = 120;     // 菜单展开半径（px，按页面坐标）
const SPAN = 140;       // 弧的总张角（度），从 -SPAN/2 到 +SPAN/2

Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false, observer(v) { if (v) this._open(); else this._close(); } },
    /** 触点（px，页面坐标系） */
    x: { type: Number, value: 0 },
    y: { type: Number, value: 0 },
    /** 菜单项：[{ key, label, icon? }] */
    items: { type: Array, value: () => [] },
    /** 展开半径（px） */
    radius: { type: Number, value: RADIUS },
    /**
     * 弧的张角范围（度）。**屏幕坐标 y 向下**：0 = 正右，-90 = 正上。
     * ⚠️ 触发点贴着屏幕边（如课表左下角那个按钮）时，必须把范围收进**右上象限**
     *   （如 -105 ~ 5），否则靠下的菜单项会落到 tabBar 底下被遮住（用户实锤）。
     *   默认仍是旧的 -70 ~ +70（居中偏右半圆）。
     */
    spanStart: { type: Number, value: -SPAN / 2 },
    spanEnd: { type: Number, value: SPAN / 2 }
  },
  data: {
    visible: false,   // 节点是否在 DOM（开合留出过渡时间）
    open: false,      // 是否到终态（决定 .in）
    arranged: []      // 算好 dx/dy/delay 的菜单项
  },
  lifetimes: {
    detached() {
      if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    }
  },
  methods: {
    _open() {
      const r = this.properties.radius || RADIUS;
      const items = this.properties.items || [];
      const n = items.length;
      const start = typeof this.properties.spanStart === 'number' ? this.properties.spanStart : -SPAN / 2;
      const end = typeof this.properties.spanEnd === 'number' ? this.properties.spanEnd : SPAN / 2;
      /* 🔴 2026-11-14 真机实测：触发点贴着屏幕边（左下角那个按钮）时，
       *   弧上的菜单项会被推到屏幕外（用户实锤「全部」被裁掉一半）。
       *   ⇒ 算完 dx/dy 后把**菜单项中心**夹进视口（留出菜单项自身的一半宽高）。
       *   视口尺寸取 wx.getSystemInfoSync（拿不到就用 375x667 兜底）。 */
      let vw = 375, vh = 667;
      try {
        const s = wx.getSystemInfoSync ? wx.getSystemInfoSync() : null;
        if (s && s.windowWidth) { vw = s.windowWidth; vh = s.windowHeight; }
      } catch (e) {
        console.error('[radial-menu] 取不到视口尺寸，菜单项可能被裁', e);
      }
      const HALF = 40;    // 菜单项半宽/半高（120rpx ≈ 64px，留余量）
      const MARGIN = 6;   // 距屏幕边至少留一点
      const cx = Number(this.properties.x) || 0;
      const cy = Number(this.properties.y) || 0;
      const minX = MARGIN + HALF - cx, maxX = vw - MARGIN - HALF - cx;
      const minY = MARGIN + HALF - cy, maxY = vh - MARGIN - HALF - cy;
      const arranged = items.map((it, i) => {
        const t = n <= 1 ? 0.5 : i / (n - 1);
        const ang = (start + (end - start) * t) * Math.PI / 180;
        let dx = Math.cos(ang) * r;
        let dy = Math.sin(ang) * r;
        if (maxX >= minX) dx = Math.min(Math.max(dx, minX), maxX);
        if (maxY >= minY) dy = Math.min(Math.max(dy, minY), maxY);
        const o = Object.assign({}, it);
        o.dx = Math.round(dx);
        o.dy = Math.round(dy);
        o.delay = i * 32;     // 交错弹出
        return o;
      });
      // 先挂节点（起始态），下一帧再加 .in 触发过渡
      this.setData({ visible: true, open: false, arranged }, () => {
        if (this._openTimer) clearTimeout(this._openTimer);
        this._openTimer = setTimeout(() => {
          this._openTimer = null;
          this.setData({ open: true });
        }, 20);
      });
    },
    _close() {
      if (!this.data.visible) return;
      this.setData({ open: false });
      if (this._closeTimer) clearTimeout(this._closeTimer);
      // 等退场动画走完再卸节点（与 popup-anim 同思路）
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        this.setData({ visible: false });
      }, 260);
    },
    noop() {},
    onMask() { this.triggerEvent('close'); },
    onItem(e) {
      const key = e.currentTarget.dataset.key;
      this.triggerEvent('select', { key });
    }
  }
});
