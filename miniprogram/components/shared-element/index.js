/**
 * 共享元素 ghost（v1.0.9.0 · #2）
 * ============================================================
 * 一个 fixed 浮层：从 `from` 矩形 FLIP 到 `to` 矩形（位置 + 尺寸 + 圆角 + 透明度），
 * 落地后触发 bind:arrive，目标页借此把真实 hero 显形、把自己隐藏。
 * 仅 m-shared 开启时真正播动画；关掉 FLAG 时直接 arrive（无动画，不卡）。
 *
 * 用法（目标页 onReady 量好 hero 矩形后）：
 *   <shared-element show="{{seShow}}" from="{{seFrom}}" to="{{seTo}}"
 *                  color="{{seColor}}" label="{{seLabel}}" bind:arrive="onSeArrive" />
 */
const motion = require('../../utils/motion');

Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false, observer(v) { if (v) this._play(); else this._reset(); } },
    from: { type: Object, value: null },   // 源矩形（px, 视口坐标）
    to: { type: Object, value: null },     // 目标矩形（px）
    color: { type: String, value: '' },    // ghost 背景色（取自卡片主题色）
    label: { type: String, value: '' },
    /** ghost 形态：'block'（默认，色块 + 文字）| 'avatar'（圆形头像图片） */
    mode: { type: String, value: 'block' },
    /** mode='avatar' 时的头像图片地址 */
    avatar: { type: String, value: '' }
  },
  data: { visible: false, style: '' },
  lifetimes: {
    detached() {
      if (this._t1) { clearTimeout(this._t1); this._t1 = null; }
      if (this._t2) { clearTimeout(this._t2); this._t2 = null; }
    }
  },
  methods: {
    _play() {
      const f = this.properties.from, t = this.properties.to;
      // FLAG 关 / 缺矩形 → 直接到位，不播动画
      if (!f || !t || !motion.on('shared')) { this.triggerEvent('arrive'); return; }
      // 起点：钉在源矩形，缩到 0.96、透明，无过渡
      const fromR = this.properties.mode === 'avatar' ? '50%' : '24rpx';
      const toR = this.properties.mode === 'avatar' ? '50%' : '40rpx';
      const fromStyle = 'left:' + f.left + 'px;top:' + f.top + 'px;width:' + f.width + 'px;height:'
        + f.height + 'px;transform-origin:0 0;transform:translate(0,0) scale(0.96);opacity:0;'
        + 'border-radius:' + fromR + ';transition:none;';
      this.setData({ visible: true, style: fromStyle }, () => {
        const dx = t.left - f.left, dy = t.top - f.top;
        const sx = t.width / f.width, sy = t.height / f.height;
        const toStyle = 'left:' + f.left + 'px;top:' + f.top + 'px;width:' + f.width + 'px;height:'
          + f.height + 'px;transform-origin:0 0;transform:translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ');'
          + 'opacity:1;border-radius:' + toR + ';'
          + 'transition:transform .42s cubic-bezier(.22,.61,.36,1), opacity .3s ease, border-radius .42s ease;';
        if (this._t1) clearTimeout(this._t1);
        this._t1 = setTimeout(() => {
          this._t1 = null;
          this.setData({ style: toStyle }, () => {
            if (this._t2) clearTimeout(this._t2);
            this._t2 = setTimeout(() => {
              this._t2 = null;
              this.setData({ visible: false });
              this.triggerEvent('arrive');
            }, 440);
          });
        }, 30);
      });
    },
    _reset() { this.setData({ visible: false, style: '' }); }
  }
});
