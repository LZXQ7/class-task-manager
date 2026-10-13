const { DARK_MODE_ENABLED } = require('../../utils/config');

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    title: { type: String, value: '' },
    showBack: { type: Boolean, value: false },
    showHome: { type: Boolean, value: false },
    /**
     * 2026-10-09：页面上**有弹层（bottom-sheet / duty-sheet）正在打开**。
     *
     * ⚠️ 为什么需要它（用户实拍「所有弹窗左上角都有个箭头」）：
     *    二级页的返回按钮（`.nav-btn` 里的 arrow-left）会被弹层左上角**穿透**出来 ——
     *    不是因为层级错（遮罩 z-index 1000 > nav 800，已经盖住它了），而是
     *    **遮罩是 rgba(0,0,0,0.45)，盖不暗一个亮色图标**；而面板本身是半透明玻璃
     *    （rgba(255,255,255,0.72) + blur），把面板上移过去也只是把箭头从「遮罩后」
     *    挪到「玻璃后」，**仍然隐约可见**。所以唯一可靠解法是**不渲染它**。
     *
     * 用法（各页面统一接自己 page-meta 里那个表达式，它已经列了全部弹层标志）：
     *   <nav-bar show-back="{{true}}" sheet-open="{{aShow || bShow || ...}}" />
     *   data 里存 sheetOpen，wxml 里 `wx:if="{{showBack && !sheetOpen}}"`。
     */
    sheetOpen: { type: Boolean, value: false },
    delta: { type: Number, value: 1 },
    customBack: { type: Boolean, value: false },   // true：交给页面 bind:back 处理
    /** 导航底色：默认是**半透明**的玻璃（v0.7.17），模糊与亮边由 .nav 的类承担
     *（inline style 只能给颜色，给不了 backdrop-filter）。需要实心底的页面仍可显式传值覆盖。
     * 🔴 深色模式：默认值必须走 `var(--glass-bg-strong)` 而不是写死 `rgba(255,255,255,.5)` ——
     *   inline style 里 `var()` 合法，且自定义属性会从页面根节点继承下来，
     *   所以主题一切换这里自动跟着变（写死色值则永远浅色）。 */
    bg: { type: String, value: 'var(--glass-bg-strong)' },
    /** 标题/图标色：同理走 --text-1，深色下自动变浅。
     *  ⚠️ app-icon 的 variant 由 `color === '#FFFFFF' ? 'white' : 'gray'` 决定，
     *    传 var() 后这个判断会落到 'gray' 分支 —— 深色下 gray 图标正好可读，故保留。 */
    color: { type: String, value: 'var(--text-1)' },
    border: { type: Boolean, value: false },
    /** 默认固定：所有页面顶栏不随内容滚动（2026-09-25 用户要求）。特殊页面可显式传 fixed="{{false}}" 关闭 */
    fixed: { type: Boolean, value: true },
    /**
     * 是否渲染「把正文顶下来」的占位块。
     * ⚠️ 只有 fixed=true 时才真的渲染（见 index.wxml）——fixed=false 时 nav 本来就在文档流里，
     * 再渲染占位块会让正文被顶两倍导航高度（notice/poster/bind 三页踩过）。
     */
    placeholder: { type: Boolean, value: true }
  },
  data: {
    statusBarHeight: 20,
    padRight: 0,            // 右侧插槽避让微信胶囊按钮的像素宽度
    /**
     * 主题切换按钮是否渲染 —— **总开关**（config.DARK_MODE_ENABLED）。
     * 直接从常量取默认值：这样首帧就是对的，不用等 attached 再 setData 纠正
     * （否则开关开着时会先渲染一帧没有按钮、再补上，看着像闪一下）。
     */
    themeEnabled: DARK_MODE_ENABLED,
    /** 主题按钮的垂直居中偏移（px）：导航行 88rpx、按钮 64rpx，差值 24rpx 的一半。
     *  🔴 必须**按屏宽换算成 px**，不能写死 12：24rpx 在 375 宽是 12px，
     *     在 iPad / 折叠屏（宽 500+）就是 16px+，写死会导致按钮偏离导航中线。 */
    themeTopPx: 12,
    /** 圆形揭示动画（深色模式 C-4）
     *  · revealShow  遮罩是否在（false 时节点不渲染，省一次合成层）
     *  · revealX/Y   圆心（px，页面坐标系）= 用户触点
     *  · revealR     当前半径（px）—— 由定时器逐帧增大
     *  · revealColor 遮罩颜色 = **新**主题的页面底色
     */
    revealShow: false,
    revealX: 0,
    revealY: 0,
    revealR: 0,
    revealColor: '#FFFFFF'
  },
  lifetimes: {
    /**
     * 度量不在这里自己算 —— 统一走 `app.navMetrics()`（惰性算一次 + 全局缓存）。
     * 原实现在每个实例的 attached 里调 `wx.getMenuButtonBoundingClientRect()` +
     * `wx.getWindowInfo()`：两次**同步跨线程调用**，且回调里必 `setData` 一次
     * → 每开一个二级页都白付一次，表现为「点进去先卡一下」。
     *
     * 🔴 本文件**全文不得出现 `wx.getWindowInfo(` / `wx.getSystemInfoSync(`** ——
     *   check-perf.js 是整个文件文本扫描（不只扫 attached）。
     *   需要窗口尺寸就往下面 `_win()` 要，它读的是 app.navMetrics() 的缓存。
     */
    attached() {
      const app = getApp && getApp();
      const m = (app && app.navMetrics)
        ? app.navMetrics()
        : { statusBarHeight: 20, padRight: 0, windowWidth: 375, windowHeight: 812 };
      // 主题按钮的居中偏移：24rpx（导航行 88 − 按钮 64）的一半，按屏宽折成 px
      const topPx = Math.round((m.windowWidth || 375) * 24 / 750 / 2);
      // 值没变就不 setData，省掉一次无意义的二次渲染
      if (m.statusBarHeight === this.data.statusBarHeight &&
          m.padRight === this.data.padRight &&
          topPx === this.data.themeTopPx) return;
      this.setData({
        statusBarHeight: m.statusBarHeight,
        padRight: m.padRight,
        themeTopPx: topPx
      });
    },
    detached() {
      // 组件销毁时必须停掉动画定时器：否则退场后仍在 setData，
      // 报「setData 到已销毁组件」并泄漏闭包。
      if (this._revealTimer) {
        clearInterval(this._revealTimer);
        this._revealTimer = null;
      }
      if (this._themeOff) {
        this._themeOff();
        this._themeOff = null;
      }
    }
  },
  methods: {
    onBack() {
      if (this.data.customBack) {
        this.triggerEvent('back');
        return;
      }
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack({ delta: this.data.delta });
      } else {
        wx.switchTab({ url: '/pages/home/index' });
      }
    },
    onHome() {
      wx.switchTab({ url: '/pages/home/index' });
    },

    /**
     * 对外：**切到指定模式**并从 (x, y) 播圆形揭示。
     * ------------------------------------------------------------
     * 两处入口共用这一个方法，不要各写一份：
     *   ① 左上角的切换按钮（onToggleTheme）
     *   ② 「我的」页 → 外观设置项（页内三态选择，二级页没有左上角按钮）
     * 走同一个方法才保证「按钮切有动效、设置里切没动效」不会割裂。
     *
     * @param {'system'|'light'|'dark'} mode 目标模式
     * @param {number} [x] 圆心 x（px，页面坐标）；省略/非数字 = 屏幕中心
     * @param {number} [y] 圆心 y
     */
    applyTheme(mode, x, y) {
      const t = require('../../utils/theme');
      // 开关关闭：两个入口都不渲染，这里本就调不到。留这道守卫是防「将来有人从别处
      // 调过来」—— 那时按钮虽然不显示，主题却会被悄悄改掉（且没有动效提示，最难查）。
      if (!this.data.themeEnabled) return;
      const cx = (typeof x === 'number') ? x : this._centerX();
      const cy = (typeof y === 'number') ? y : this._centerY();
      // system 的解析值此刻还是**旧**的（wx.onThemeChange 还没触发），必须自己问一次系统
      const resolved = mode === 'system' ? t.getSystemTheme() : mode;
      this._playReveal(cx, cy, resolved);
      t.setMode(mode);
    },

    /**
     * 切换主题（system → light → dark → system 循环）
     * ------------------------------------------------------------
     * 圆形揭示是**两段式**，顺序不能反：
     *   ① 先用当前主题的底色把整个屏幕盖住（半径 0）；
     *   ② 再切主题（页面根节点的 class 换掉，底下已经是新主题了）；
     *   ③ 然后把遮罩从触点扩散开 —— 用户看到的是「新主题从手指处被揭开」。
     * ⚠️ 若先切主题再盖：会闪一下旧主题（盖之前那一帧已经变了），
     *    也就是最典型的「白闪」；反过来先盖则用户全程看不到中间态。
     * ⚠️ 遮罩颜色取的是**新**主题底色（--bg-page 的实色近似），
     *    取错就会在揭开瞬间看到一次色差闪动。
     */
    onToggleTheme(e) {
      const t = require('../../utils/theme');
      // 触点相对页面（e.detail.x / y 在小程序里是相对触发元素的局部坐标，
      // 这里用 x/y 即可 —— 按钮自身 64rpx 见方，误差远小于半径）
      const x = (e && e.detail && typeof e.detail.x === 'number') ? e.detail.x : this._centerX();
      const y = (e && e.detail && typeof e.detail.y === 'number') ? e.detail.y : this._centerY();
      const next = { system: 'light', light: 'dark', dark: 'system' }[t.getMode()] || 'light';
      this.applyTheme(next, x, y);
    },

    /**
     * 窗口尺寸（px）。
     * 🔴 统一走 app.navMetrics() 的缓存，**不得**在这里调 wx.getWindowInfo()：
     *    check-perf.js 全文扫描本文件，出现即判红（导航关键路径禁止同步跨线程调用）。
     *    这几个方法只在「用户点主题按钮」时跑一次，不在关键路径上，但门禁一视同仁，
     *    所以照走缓存 —— 顺带还省了每次切主题的一次同步 IPC。
     */
    _win() {
      const app = getApp && getApp();
      if (app && app.navMetrics) {
        const m = app.navMetrics();
        return { w: m.windowWidth || 375, h: m.windowHeight || 812 };
      }
      return { w: 375, h: 812 };
    },

    _centerX() {
      return Math.round(this._win().w / 2);
    },
    _centerY() {
      return Math.round(this._win().h / 2);
    },

    /**
     * 播一次圆形揭示。
     * @param {number} x 圆心 x（px）
     * @param {number} y 圆心 y（px）
     * @param {string} nextTheme 'light' | 'dark' —— **新**主题
     */
    _playReveal(x, y, nextTheme) {
      // 已在动画中：直接换圆心/目标色，不叠第二个定时器
      if (this._revealTimer) return;
      // ⚠️ 尊重系统「减弱动效」：不播遮罩直接换主题。
      //    小程序没有 `prefers-reduced-motion` 的 JS API，CSS 侧已用
      //    `@media (prefers-reduced-motion: reduce)` 关掉动画（见 index.wxss），
      //    这里只处理「JS 驱动的逐帧半径」这一段 —— 它不受 CSS media 管，必须自己判。
      //    判据见 _prefersReducedMotion()：同步 API 已下沉到 utils/theme 惰性缓存，
      //    取不到就照常播（宁多播一次，不要把动效永久关掉）。
      if (this._prefersReducedMotion()) return;

      const R = this._reachRadius(x, y);
      this.setData({
        revealShow: true,
        revealX: x,
        revealY: y,
        revealR: 0,
        revealColor: nextTheme === 'dark' ? '#0E1116' : '#F1F4F9'
      });
      // 逐帧增大半径直到覆盖全屏；到顶后下一帧摘掉遮罩。
      // 用定时器分段而非 CSS transition：clip-path 逐帧插值在中低端机上更稳，
      // 且能在任意时刻中断（切页面 / 退场，见 detached）。
      let r = 0;
      const step = Math.max(24, Math.round(R / 18));   // 约 18 帧走完 ≈ 300ms
      this._revealTimer = setInterval(() => {
        r += step;
        if (r >= R) {
          if (this._revealTimer) { clearInterval(this._revealTimer); this._revealTimer = null; }
          this.setData({ revealShow: false, revealR: 0 });
          return;
        }
        this.setData({ revealR: r });
      }, 16);
    },

    /**
     * 系统是否要求减弱动效。取不到就返回 false（照常播）。
     * 🔴 同步 API 的调用下沉到 utils/theme 的 prefersReducedMotion()：那里**惰性算一次
     *    就缓存**。这里每次切主题都调一次的话，就是「每次点按钮一次同步跨线程 IPC」。
     */
    _prefersReducedMotion() {
      try {
        return require('../../utils/theme').prefersReducedMotion();
      } catch (e) {
        return false;
      }
    },

    /** 半径 = 圆心到**最远角**的距离（不是到边距离）：要保证四个角全被盖住 */
    _reachRadius(x, y) {
      const win = this._win();
      const w = win.w, h = win.h;
      return Math.ceil(Math.sqrt(
        Math.max(x * x, (w - x) * (w - x)) + Math.max(y * y, (h - y) * (h - y))
      ));
    }
  }
});
