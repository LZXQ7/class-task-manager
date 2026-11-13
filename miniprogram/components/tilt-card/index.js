/**
 * tilt-card —— 卡片 3D 触摸倾斜 / 径向反射流光 / 弹簧回正（2026-11-14 试点）
 * ============================================================
 * 逻辑层这里几乎什么都不做：手势、逐帧弹簧、setStyle 全在 index.wxs 的视图层闭环，
 * 组件 JS 只提供属性与一条降级上报通道。touchmove 期间**没有任何 setData**。
 *
 * 试点范围：首页「关注的学生」(st-1) 与「今日课次」(st-3) 两张主卡；
 * 全站 .card 基类不动 —— 玻璃模糊叠 3D 变换在低端安卓有掉帧风险，先看真机手感。
 *
 * enabled=false：页面可随时关掉效果，WXS 在 onStart 读 dataset 后直接返回。
 */
Component({
  properties: {
    /** 最大倾角（度），clamp 到 1~14，默认 9 —— 7° 配 perspective(800px) 肉眼几乎看不出，
     *  试到 600px + 9° 才刚好像「一块有厚度的玻璃」；再大就会抢内容 */
    maxTilt: { type: Number, value: 9 },
    enabled: { type: Boolean, value: true }
  },

  methods: {
    /**
     * WXS 拿不到 glare descriptor / getBoundingClientRect 时，通过 callMethod 落到这里。
     * 🔴 绝不静默：项目铁律「空 catch 是事故放大器」。静默降级会让
     *    「有倾斜、没流光」变成谁也查不出的玄学问题，必须留一条可检索的日志。
     */
    onTiltWarn(detail) {
      console.error('[tilt-card] 视图层降级：' + JSON.stringify(detail));
    }
  }
});
