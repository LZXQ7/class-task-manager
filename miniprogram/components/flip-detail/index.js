/**
 * 3D 翻转卡片（v1.0.9.0 · #8）
 * ============================================================
 * 辅导员首页学生卡片：点一下绕 Y 轴翻 180°，正面是基本信息、背面是详情。
 * 用法：
 *   <flip-detail flipped="{{item.flipped}}" bind:flip="onFlip">
 *     <view slot="front">…</view>
 *     <view slot="back">…</view>
 *   </flip-detail>
 * 低端机 / 关掉 m-flipDetail 时退化为「正面 ⇄ 背面 显隐切换」（无旋转，不卡）。
 */
const motion = require('../../utils/motion');

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    /** 受控翻转状态（true = 显示背面） */
    flipped: { type: Boolean, value: false, observer(v) { this.setData({ _flipped: !!v }); } }
  },
  data: { _flipped: false },
  methods: {
    onTap() {
      const f = !this.data._flipped;
      this.setData({ _flipped: f });
      this.triggerEvent('flip', { flipped: f });
    }
  }
});
