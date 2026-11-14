/**
 * 弧形菜单（v1.0.9.0 · #10 → 2026-11-14 按用户口径重做）
 * ================================================================
 * 用户口径（2026-11-14）：
 *   ① **长按按住展示** —— 只有长按才展开，按住期间菜单一直在；
 *      轻点不展开（上一版轻点/长按都能开，轻点会开出一个"没人操作的菜单"）。
 *   ② **手指拖到某个按钮上松开 = 点了那个按钮**（跟 iOS 的 radial menu 一样）。
 *   ③ **按住展开后直接松手（没拖到按钮）→ 四个按钮收回**。
 *   ④ 按钮改成**圆形**、配色跟随整体（不要白色方块）；弧上**间距一致**。
 *
 * ⚠️ 为什么触摸跟踪放在**页面**、组件只负责命中判定：
 *   `bindlongpress` 触发时菜单组件才刚渲染出来，**后续的 touchmove/touchend
 *   的事件目标仍是长按的那个元素**，不会冒泡到组件 ⇒ 组件收不到「松手」事件。
 *   所以页面全程监听 touchstart/move/end，把坐标转发给组件（selectComponent 调方法）。
 *
 * ⚠️ 间距一致的做法：**整条弧平移**进屏幕（而不是逐个点夹取）——
 *   逐点夹取会把靠边的项挤到一起，间距就不一致了（用户实锤「间距保持一致」）。
 */
const motion = require('../../utils/motion');

const RADIUS = 120;     // 菜单展开半径（px，按页面坐标）
const SPAN = 140;       // 弧的总张角（度），从 -SPAN/2 到 +SPAN/2
const HIT = 52;         // 命中半径（px）：手指落在这个距离内就算命中该按钮

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
     */
    spanStart: { type: Number, value: -SPAN / 2 },
    spanEnd: { type: Number, value: SPAN / 2 }
  },
  data: {
    visible: false,   // 节点是否在 DOM（开合留出过渡时间）
    open: false,      // 是否到终态（决定 .in）
    arranged: [],     // 算好 dx/dy/delay 的菜单项
    hot: -1           // 当前手指悬停的项下标（-1 = 无）
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
      const cx = Number(this.properties.x) || 0;
      const cy = Number(this.properties.y) || 0;

      // 先按角度均匀取点（等角 ⇒ 弧上弦长一致 ⇒ 间距一致）
      const pts = items.map((it, i) => {
        const t = n <= 1 ? 0.5 : i / (n - 1);
        const ang = (start + (end - start) * t) * Math.PI / 180;
        return { dx: Math.cos(ang) * r, dy: Math.sin(ang) * r };
      });

      /* 🔴 整条弧**平移**进屏幕（而不是逐点夹取）：逐点夹会把靠边的项挤到一起、
         间距就不一致了（用户实锤「间距保持一致」）。 */
      let vw = 375, vh = 667;
      try {
        const s = wx.getSystemInfoSync ? wx.getSystemInfoSync() : null;
        if (s && s.windowWidth) { vw = s.windowWidth; vh = s.windowHeight; }
      } catch (e) {
        console.error('[radial-menu] 取不到视口尺寸，菜单可能被裁', e);
      }
      const HALF = 32;    // 圆形按钮半径（112rpx ≈ 60px）
      const MARGIN = 8;
      if (pts.length) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach(p => {
          minX = Math.min(minX, cx + p.dx); maxX = Math.max(maxX, cx + p.dx);
          minY = Math.min(minY, cy + p.dy); maxY = Math.max(maxY, cy + p.dy);
        });
        let shiftX = 0, shiftY = 0;
        if (minX - HALF < MARGIN) shiftX = MARGIN + HALF - minX;
        if (maxX + HALF > vw - MARGIN) shiftX = Math.min(shiftX, vw - MARGIN - HALF - maxX);
        if (minY - HALF < MARGIN) shiftY = MARGIN + HALF - minY;
        if (maxY + HALF > vh - MARGIN) shiftY = Math.min(shiftY, vh - MARGIN - HALF - maxY);
        pts.forEach(p => { p.dx += shiftX; p.dy += shiftY; });
      }

      this._pts = pts;

      const arranged = items.map((it, i) => {
        const o = Object.assign({}, it);
        o.dx = Math.round(pts[i].dx);
        o.dy = Math.round(pts[i].dy);
        o.delay = i * 32;       // 交错弹出
        o.long = String(it.label || '').length > 2;   // 四字项用小一号字
        return o;
      });
      this.setData({ visible: true, open: false, arranged, hot: -1 }, () => {
        if (this._openTimer) clearTimeout(this._openTimer);
        this._openTimer = setTimeout(() => {
          this._openTimer = null;
          this.setData({ open: true });
        }, 20);
      });
    },
    _close() {
      if (!this.data.visible) return;
      this.setData({ open: false, hot: -1 });
      if (this._closeTimer) clearTimeout(this._closeTimer);
      // 等退场动画走完再卸节点（与 popup-anim 同思路）
      this._closeTimer = setTimeout(() => {
        this._closeTimer = null;
        this.setData({ visible: false });
      }, 260);
    },

    /* ---------------- 触摸跟随（由页面转发进来） ---------------- */
    /** 手指移动到 (px,py)：更新高亮项 */
    moveTo(px, py) {
      if (!this.data.visible) return;
      const pts = this._pts;
      const ox = Number(this.properties.x) || 0;
      const oy = Number(this.properties.y) || 0;
      let best = -1, bestD = HIT;
      for (let i = 0; i < (pts || []).length; i++) {
        const p = pts[i];
        const dx = (ox + p.dx) - px;
        const dy = (oy + p.dy) - py;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best !== this.data.hot) this.setData({ hot: best });
    },
    /** 手指松开：命中则选中该项，否则整个菜单收回 */
    release() {
      if (!this.data.visible) return;
      const hot = this.data.hot;
      if (hot >= 0 && this.data.arranged[hot]) {
        const key = this.data.arranged[hot].key;
        this.triggerEvent('select', { key });
        return;
      }
      this.triggerEvent('close');
    },

    noop() {},
    onMask() { this.triggerEvent('close'); },
    onItem(e) {
      const key = e.currentTarget.dataset.key;
      this.triggerEvent('select', { key });
    }
  }
});
