const popupAnim = require('../popup-anim');
const motion = require('../../utils/motion');

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  behaviors: [popupAnim],
  properties: {
    // observer 必须留在组件里（见 popup-anim.js 顶部说明）
    show: { type: Boolean, value: false, observer(nv) { this.animSync(nv); } },
    title: { type: String, value: '提示' },
    content: { type: String, value: '' },
    icon: { type: String, value: '' },        // warn | info | 空
    iconVariant: { type: String, value: 'orange' },
    cancelText: { type: String, value: '取消' },
    confirmText: { type: String, value: '确定' },
    confirmColor: { type: String, value: '#3370FF' },
    showCancel: { type: Boolean, value: true },
    maskClose: { type: Boolean, value: false },
    /**
     * #1 形态变换：胶囊按钮的起始矩形（px，视口坐标 { left, top, width, height }）。
     * 传了它且 m-morph 开启时，对话框从胶囊位置/尺寸 FLIP 长开（详见 _playMorph）。
     * 不传 / FLAG 关 → 走普通缩放淡入。
     */
    morphRect: { type: Object, value: null }
  },
  data: {
    morphStyle: ''   // 形态变换期间覆盖 .dlg-box 的内联 transform / 圆角
  },
  observers: {
    /** active 由 popup-anim 在节点挂载后一帧置 true（弹层到终态）。
     *  · 变 true 且有 morphRect → 播形态变换；
     *  · 变 false（关闭）→ 清掉内联样式，下次普通打开不受影响。 */
    active(v) {
      if (!v) { this.setData({ morphStyle: '' }); return; }
      if (this.properties.morphRect && motion.on('morph')) this._playMorph();
    }
  },
  methods: {
    /** FLIP：先量出对话框终态矩形，反推「缩到胶囊大小 + 移到源位置 + 胶囊圆角」作为起点，
     *  再下一帧过渡到终态 —— 观感是「胶囊长成对话框」。仅 transform / opacity / 圆角，不碰布局。 */
    _playMorph() {
      const sr = this.properties.morphRect;
      if (!sr || !sr.width) return;
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (!q) return;
      const self = this;
      q.select('.dlg-box').boundingClientRect((br) => {
        if (!br || !br.width) return;
        const sx = br.left + br.width / 2, sy = br.top + br.height / 2;
        const tx = sr.left + sr.width / 2, ty = sr.top + sr.height / 2;
        const scale = Math.max(0.05, sr.width / br.width);
        const dx = tx - sx, dy = ty - sy;
        // 起点：缩到胶囊尺寸、移到源中心、胶囊圆角、略透明
        const from = 'transition: transform .38s cubic-bezier(.2,1.12,.32,1), opacity .3s ease, border-radius .38s ease;'
          + ' transform: translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + scale.toFixed(3) + ');'
          + ' border-radius: 999rpx; opacity: .92;';
        self.setData({ morphStyle: from }, () => {
          if (self._morphTimer) clearTimeout(self._morphTimer);
          self._morphTimer = setTimeout(function () {
            self._morphTimer = null;
            // 终态：归位、圆角回到对话框 40rpx、完全不透明（transition 沿用 from 里的声明）
            self.setData({ morphStyle: 'transform: translate(0,0) scale(1); border-radius: 40rpx; opacity: 1;' });
          }, 30);
        });
      }).exec();
    },
    onMask() {
      if (this.data.maskClose) this.triggerEvent('close');
    },
    onCancel() {
      this.triggerEvent('cancel');
      this.triggerEvent('close');
    },
    onConfirm() {
      this.triggerEvent('confirm');
    },
    noop() {}
  }
});
