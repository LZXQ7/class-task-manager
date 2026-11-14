const motion = require('../../utils/motion');

const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));
const caf = (id) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

Component({
  options: { addGlobalClass: true },
  properties: {
    label: { type: String, value: '删除' },
    duration: { type: Number, value: 700 },   // 与 motion.DUR.hold 对齐
    disabled: { type: Boolean, value: false },
    /**
     * 业务主键（如请假记录 id）：长按确认触发时**原样回传**给 confirm 事件的 detail。
     * 🔴 为什么需要：自定义组件内部的 <view> 上拿不到外层的 data-id
     *    （currentTarget 是组件内部的节点，dataset 是空的），
     *    所以业务 id 必须由页面显式传进来，否则页面无法知道确认的是哪一条。
     */
    id: { type: String, value: '' },
    /**
     * 裸模式：只借用「长按计时 + 进度条」，**不画圆形按钮外壳**。
     * 用途：把页面里已有的小按钮（撤销/删除等文字按钮）升级成长按确认，
     *      但保持它原本的视觉（不套一个 160rpx 的圆壳）。
     */
    bare: { type: Boolean, value: false }
  },
  data: { p: 0, holding: false, confirmed: false },
  lifetimes: {
    detached() { this._stop(); }
  },
  methods: {
    _stop() {
      if (this._raf) { caf(this._raf); this._raf = null; }
      if (this._raf2) { caf(this._raf2); this._raf2 = null; }
    },
    onStart(e) {
      if (this.data.disabled || this.data.confirmed) return;
      if (e && e.preventDefault) e.preventDefault();
      if (!motion.on('holdConfirm')) {           // 关掉时退化为普通点击：直接触发
        this.triggerEvent('confirm', { id: this.properties.id });
        return;
      }
      this._stop();
      this._start = Date.now();
      this.setData({ holding: true, p: 0 });
      this._tick();
    },
    _tick() {
      const dur = this.properties.duration || 700;
      const p = Math.min(100, (Date.now() - this._start) / dur * 100);
      this.setData({ p: p.toFixed(1) });
      if (p >= 100) {
        this._raf = null;
        this.setData({ holding: false, confirmed: true });
        this.triggerEvent('confirm', { id: this.properties.id });
        return;
      }
      this._raf = raf(() => this._tick());
    },
    onEnd() {
      if (this.data.confirmed) return;
      if (!this.data.holding) return;
      this._stop();
      // 平滑回退：从当前值线性回 0（不满松手不触发）
      const startP = parseFloat(this.data.p) || 0;
      const t0 = Date.now();
      const retract = () => {
        const k = Math.min(1, (Date.now() - t0) / 200);
        const v = startP * (1 - k);
        this.setData({ p: v.toFixed(1) });
        if (k < 1) this._raf2 = raf(retract);
        else this.setData({ holding: false });
      };
      retract();
    }
  }
});
