const popupAnim = require('../popup-anim');

/**
 * 通用底部弹层（全站唯一实现）
 * ============================================================
 * v0.7.32：**下拉关闭（可拖拽）**——按用户口径实现：
 *   ① grabber 指示条 + **标题栏整块**作为拖动感应区（约 60px，不是只有文字热区）；
 *   ② 向上拖：跟手到顶后进入 **rubber-banding**（位移指数衰减、渐近最多 26px），松手 spring 弹回；
 *   ③ 向下拖：完全跟手；松手**位移 + 速度共同判定** ——
 *      超过面板高度一半 / 或快速下滑轻扫 → 滑出并关闭；否则 spring 回位；
 *      **回弹与关闭的时长都由松手瞬间的速度算出来**（不是固定 300ms 匀速）；
 *   ④ 遮罩透明度跟随拖动位移同步减淡；
 *   ⑤ **可打断**：回弹/关闭动画进行中按住标题栏，接住当前位移与速度继续拖；
 *   ⑥ 只有 `.sheet-drag`（指示条 + 标题栏）响应 touchmove，内容区 scroll-view 不受影响。
 *
 * ⚠️ 实现纪律（用户明确要求「不要出现」的两点）：
 *   · **只动 transform / opacity**，绝不改 width/height/top → 拖动期不重排、不闪烁；
 *   · **先播完滑出动画再卸载**：drag 关闭走 `_closeOut()` 自己的位移动画，播完才
 *     `triggerEvent('close')`；节点卸载仍由 popup-anim 的 mounted/active 两帧机制负责。
 * ⚠️ 小程序没有真 spring：用「速度算时长 + 带轻微 overshoot 的 cubic-bezier」逼近，
 *    并把打断时的位置按同一条曲线的近似解算出来（`_curOffset()`）。
 */
const DURATION = 240;

/** rubber-band：向上最多再拉这么多 px（渐近值，永远拉不到） */
const RUBBER_MAX = 26;
/** 「快速下滑轻扫」的速度阈值（px/ms，向下为正） */
const FLICK_V = 0.6;
/** 回弹/关闭动画的时长夹取范围（ms） */
const MIN_MS = 130;
const MAX_MS = 420;
/** 高度过渡时长（ms，v1.0.7）：与入场 transform 的 .24s 同一量级，短于它才不会显得拖沓 */
const RESIZE_ANIM_MS = 220;
/** 高度过渡的最小区差（px）：小于它不播动画 —— 内容微调时播反而像卡顿 */
const RESIZE_MIN_DIFF = 8;
/** 开场静默期（ms，v1.0.7）：入场 transform 是 240ms，这段时间内不做高度过渡 */
const OPEN_SETTLE_MS = 260;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 指数衰减：raw 越大越拉不动，渐近 RUBBER_MAX */
const rubber = (raw) => RUBBER_MAX * (1 - 1 / (1 + raw / RUBBER_MAX));
/** 与 .22,1.06,.36,1 形状接近的近似解（打断时按它反推当前位置） */
const easeOutApprox = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);
/**
 * 面板 max-height 的档位（比例），**必须与 wxss 里 `.sheet-panel` / `.tall` 的
 * `78vh` / `92vh` 对齐**（改一处必须改两处；门禁 check-sheet-resize-anim 钉住）。
 *
 * 为什么不从 `getComputedStyle` 解析面板的 max-height：vh / calc 在部分 WebView 上
 * 返回的是原串而不是 px，解析不了就只能放弃夹取。这里直接「比例 × 窗口高」算最稳。
 */
const CAP_RATIO = 0.78;
const CAP_RATIO_TALL = 0.92;
/** 挂上过渡类之后，等一帧（ms）再改高度值 —— 保证「有过渡属性」这件事先被提交 */
const TRANSITION_ARM_MS = 16;

Component({
  options: { addGlobalClass: true, multipleSlots: true },
  behaviors: [popupAnim],
  properties: {
    // ⚠️ show 的 observer 必须写在组件里（popup-anim 只提供 mounted/active 与 animSync）：
    // 若在 behavior 里也声明 show，组件自身这份会覆盖掉它，observer 直接不生效。
    show: { type: Boolean, value: false, observer(nv) { this.animSync(nv); } },
    title: { type: String, value: '' },
    height: { type: Number, value: 0 },      // rpx，0=自适应
    maskClose: { type: Boolean, value: true },
    showClose: { type: Boolean, value: true },
    radius: { type: Number, value: 24 },
    // 是否让开底部自定义 tabBar（Tab 页弹层需 true，避免内容被 tabBar 遮挡）
    tabbar: { type: Boolean, value: true },
    // v0.7.25：更高的面板（max-height 92vh）—— 内容确实装不进 78vh 的弹层（如成员详情：
    // 固定操作区 + 备注列表 + 书写区）用它；内容少的弹层不要开，避免「小内容大面板」。
    tall: { type: Boolean, value: false },
    // v0.7.25：底部固定操作条（<view slot="footer"> … </view>）—— 结构级固定在面板底部
    // （panel 是 flex column，footer 是第三个 flex 子项），不随 sheet-body 滚动。
    // ⚠️ 不要用 position:fixed 实现「固定」：panel 带过渡 transform，会建包含块（MEMORY 铁律②）。
    footer: { type: Boolean, value: false },
    // v0.7.32：是否允许下拉关闭。带表单 / 日期选择的弹层（如请假登记）可置 false 防误关。
    draggable: { type: Boolean, value: true },
    // v1.0.5：body 是否允许下拉刷新（成员与分组等列表型弹层开启；表单类弹层保持 false）
    refreshable: { type: Boolean, value: false },
    /**
     * v1.0.7：内容高度变化时**平滑过渡**面板高度（默认关）。
     *
     * 为什么需要：面板高度是 `height: auto` + `max-height`（自适应弹层），
     * 而 **CSS 无法过渡 `height: auto`** —— 内容从「全部」筛到「近 7 天」时高度
     * 瞬间塌缩，视觉上是「弹层被一刀切掉」。
     *
     * ⚠️ 为什么**不用**「锁定旧高度 → 下一帧放开到 auto」那套两段式
     *    （2026-10-08 第一版就是这么写的，实测被否：闪烁两下 + 几乎不平滑）：
     *   · `resizeScroll()` 是使用方在 **setData 回调**里调的 —— 那一刻内容已重排完，
     *     面板**已经是新高度**。这时才把面板写回旧高度，用户看到的是
     *     「跳到新 → 又跳回旧 → 再过渡到新」= **两次可见跳变**；
     *   · 且第二段是「显式 px → `height:auto`」，**auto 不可插值** ⇒ WebView 直接跳变。
     *
     * ### 现在的做法：把面板高度**夹**在 [min-height, max-height] 之间
     * 常态下发 `min-height: H px; max-height: H px`（H = 上一次落定高度）——
     * 上下**同值**夹取 ⇒ 面板可见高度恒等于 H，**内容怎么变都动不了它**
     *（内容超高时由 body 内部滚动承接，与 max-height 的原有行为一致）。
     * 于是「把两个值一起从 H 改成 T」就是 H ⇒ T 的**两端都是确定 px** 的插值，
     * 浏览器直接补间：**一次 setData 即生效**，既不需要"先换成 px 再放开"，
     * 也不会有回跳闪烁；而且**变高和变矮是对称的**——两者都是「H ⇒ T 的插值」，
     * 不存在"变高走 auto、变矮走 px"这种两套路径。
     *
     * ⚠️ 为什么不直接写 `height: H px`（那样更简单、也是最常见的做法）：
     *    写死 height 会让面板**永远停在那个值**，内容变多时不再长高 ⇒
     *    万一某处漏调 `resizeScroll()`，内容就被截在过矮的面板里（且夹不出来）。
     *    min/max 只是夹取、auto 仍在中间生效，漏调的最坏后果只是「少一段动画」。
     *
     * 只对**自适应高度**弹层有意义；传了 `height` 的弹层高度本来就固定。
     * 由使用方在 setData 回调里调 `resizeScroll()`；开合入场动画期间不参与。
     */
    resizeAnim: { type: Boolean, value: false }
  },
  data: {
    safeBottom: 0, tabbarPx: 49, capStyle: '', bodyMaxH: '',
    /* ---- 拖拽（v0.7.32）---- */
    dragging: false,     // 手指按住拖动中（用于给面板加 .drag 关掉过渡）
    dragStyle: '',       // 面板内联样式：拖拽/回弹/滑出期间覆盖 class 的 transform
    maskStyle: '',       // 遮罩内联样式：透明度跟手
    /* ---- 高度过渡（v1.0.7）---- */
    // 面板高度的**夹紧值**，值形如 `min-height:480px; max-height:480px;`（**自带尾分号**）；
    // '' = 未启用。
    // ⚠️ 必须做成「整段声明」而不是裸数值：WXML 里插值之间要有 `;` 分隔
    //    （scripts/check-inline-style-join.js 会把 `}}{{` 判死 —— 相邻插值不加分隔符
    //    会把上一条声明的值粘进下一条的属性名，历史上真出过「整条声明连同 max-height
    //    一起被丢弃」的线上事故）。
    // ⚠️ 为什么 min-height 与 max-height **成对**下发（详见 _animateResize 的注释）：
    //    只写 min-height 只能补「变矮」，「变高」会因 height:auto 立刻顶上去而仍然跳变；
    //    上下一起夹 = 面板高度完全由这两个值决定 ⇒ 高低两个方向都能插值。
    // ⚠️ 用 min/max-height 而不是 height：写死 height 会让面板永远停在那个值，
    //    内容变化后不再自适应；min/max 只是夹取，auto 仍在中间生效。
    // ⚠️ 单位是 px：这里由 JS 下发，与 wxss 里 rpx 无关。
    resizeStyle: '',
    resizeCls: ''        // '' = 无过渡；'animating' = 正在过渡（wxss 里给 .sheet-panel 挂高度过渡）
  },
  observers: {
    /* 关闭（active 落回 false）后清掉拖拽内联样式 —— 否则残留的 inline opacity/transform
       会盖住 class 规则（下一次打开时面板停在半途）。 */
    active(v) {
      if (!v && (this.data.dragStyle || this.data.maskStyle || this.data.dragging
        || this.data.resizeCls || this.data.resizeStyle)) {
        this.setData({
          dragging: false, dragStyle: '', maskStyle: '',
          resizeCls: '', resizeStyle: ''
        });
        this._lastPanelH = 0;   // 下次打开重新量，不能沿用上次的夹紧值
        this._openedAt = 0;
        this._resizePending = false;
        return;
      }
      /* v1.0.6：打开后补量一次 body 的可滚动范围。
       spring-scroll 在 ready() 量到的常常是「空壳」高度（内容还没填进来），
       _maxScroll 记成 0，后面的手势就滑不动了 —— 现在统一由弹层自己补一拍。 */
      if (v) {
        this._openedAt = Date.now();
        this._scheduleResize();
        // v1.0.7：入场结束后量一次真实高度，作为**夹紧值**的初值。
        // 不夹的话，第一次筛选时没有可插值的起点 ⇒ 首筛不播动画；
        // 而且没有 max-height 兜着，内容一长就会先硬顶上去跳一下。
        // 300ms = 入场 240ms + 内容首帧填完（早于它量到的是空壳高度）。
        if (this.properties.resizeAnim) {
          const self = this;
          this._resizeFloorTimer = setTimeout(function () {
            self._resizeFloorTimer = null;
            self._measurePanelH(function (h) {
              if (!h) return;
              self._lastPanelH = h;
              self._setResizeClamp(h, false);
              // ⚠️ 铺完初值后再补一拍高度重算（v1.0.7 修「选择同学不显示成员」）。
              //   `_animateResize` 有 260ms 开场静默期（OPEN_SETTLE_MS，防入场 transform 期跳变）；
              //   而 80ms 那次 `_scheduleResize` 正落在静默期内，只补了可滚动范围、没算高度。
              //   于是「名单在 300ms 之后才回来」时，内容变高这一事实**没有任何一次调用
              //   会去处理**（后续的 setData 回调都还没到）⇒ 夹紧值停在开场的矮值上，
              //   成员名单被裁掉一截。这一拍就是那道兜底。
              self.resizeScroll();
            });
          }, 300);
        }
      }
    }
  },
  lifetimes: {
    /**
     * 度量统一走 `app.sheetMetrics()`（惰性算一次 + 全局缓存）。
     * ⚠️ 弹层即使**没打开**，组件实例也已经在页面组件树里，所以这里的花销是
     * 「每打开一个页面」都要付的：原来每次都调一次同步的 `wx.getWindowInfo()`
     * 并 `setData` 触发二次渲染 —— 这正是「进新页面先卡一下」的一部分。
     */
    attached() {
      const app = getApp && getApp();
      const m = (app && app.sheetMetrics)
        ? app.sheetMetrics()
        : { safeBottom: 0, tabbarPx: 49, sheetCapStyle: '' };
      // 滚动兜底（v1.0.5）：未显式传 height 的弹层（成员详情 / 我的页明细 /
      // 请假登记 / 首页请假名单），面板只有 max-height 没有确定高度，
      // flex:1 的 scroll-view 在微信里拿不到确定高度 → 整段内容滚不动。
      // 由 JS 给 body 下发一个确定的 max-height（内容短时面板仍按内容自适应，
      // 内容长时 body 被 caps → 内容可滚动）。传了 height 的弹层已有确定高度，无需再 cap。
      // ⚠️ v0.7.32：扣掉的头部高度 104rpx → **124rpx**（新增 28rpx grabber 指示条）——
      //    改头部结构必须同步这里，否则长内容会比面板高一条指示条的高度。
      const ph = this.properties.height || 0;
      const tall = this.properties.tall;
      const bodyMaxH = ph
        ? ''
        : ';max-height: calc(' + (tall ? '92vh' : '78vh') + ' - 124rpx)';
      if (m.safeBottom === this.data.safeBottom && m.tabbarPx === this.data.tabbarPx
        && (m.sheetCapStyle || '') === this.data.capStyle && bodyMaxH === this.data.bodyMaxH) return;
      this.setData({
        safeBottom: m.safeBottom,
        tabbarPx: m.tabbarPx,
        capStyle: m.sheetCapStyle || '',
        bodyMaxH
      });
    },
    detached() {
      if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
      if (this._resizeTimer) { clearTimeout(this._resizeTimer); this._resizeTimer = null; }
      // v1.0.7：高度过渡的定时器也要清 —— 页面销毁后还在跑就会对已销毁实例 setData
      if (this._resizeAnimTimer) { clearTimeout(this._resizeAnimTimer); this._resizeAnimTimer = null; }
      if (this._resizeEndTimer) { clearTimeout(this._resizeEndTimer); this._resizeEndTimer = null; }
      if (this._resizeFloorTimer) { clearTimeout(this._resizeFloorTimer); this._resizeFloorTimer = null; }
    }
  },
  methods: {
    onMask() {
      if (this.data.maskClose) this.triggerEvent('close');
    },
    onClose() {
      this.triggerEvent('close');
    },
    noop() {},

    /* v1.0.5：body 下拉刷新 → 转发给使用方页面（roster 等监听 bindrefresh 重载） */
    _onRefresh() {
      this.triggerEvent('refresh');
    },
    /** 使用方重载完成后调用：收起 body 的下拉刷新指示器 */
    finishRefresh() {
      const sc = this.selectComponent('#sheetScroll');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    },
    /**
     * 使用方内容高度变化后调用：让 body 重新测量可滚动范围 + 重算面板高度。
     *
     * ⚠️⚠️ **顺序铁律：先重测、再算高度**（v1.0.7 修「选择同学不显示成员」）。
     *    `_animateResize()` 里的目标高度 = `chrome + sc.contentHeight()`，
     *    而 `contentHeight()` 读的是 spring-scroll 的 `_contentH` ——
     *    它**只在 `_measure()` 的异步 selector query 回调里更新**。
     *    原来的写法（先 `_animateResize()` 后 `sc.resize()`）拿到的是**上一轮的旧高度**，
     *    于是夹紧值被锁在一个偏矮的数字上，面板再也长不高：
     *      弹层刚打开时成员列表还是空的（内容很矮）⇒ 锁在矮高度
     *      → 名单回来后面板不跟着长 ⇒ 第 13 行之后全被裁掉（用户看到的现象）
     *      → 在搜索框输入序号会触发新一轮 setData，此时上一轮的 `sc.resize()`
     *        已经把 `_contentH` 更新对了 ⇒ 高度这才算对 ⇒ 「输入序号才显示出来」
     *    所以必须挂在 `sc.resize()` 的回调里算高度。
     */
    resizeScroll() {
      const sc = this.selectComponent('#sheetScroll');
      if (sc && sc.resize) sc.resize(() => this._animateResize());
      else this._animateResize();
    },

    /* ================= 高度过渡（v1.0.7） ================= */

    /**
     * 面板高度平滑过渡：把夹紧值从 `_lastPanelH` 补间到新目标。
     *
     * ### 为什么是「min/max 成对夹紧」而不是「显式 height」
     * 面板常态是 `height: auto`，**CSS 过渡不了 auto**（第一版就栽在这）。
     * 改成成对下发 `min-height: H px; max-height: H px`：
     *   · 上下**同值**夹取 ⇒ 面板可见高度恒等于 H，内容怎么变都动不了它（不会提前跳变）；
     *   · 两端都是 JS 下发的确定 px ⇒ 浏览器直接插值，不需要"先锁定再放开"，
     *     也就不会有回跳闪烁；
     *   · **变高变矮完全对称**（都是 H ⇒ T 的插值）。⚠️ 只写 `min-height` 做不到：
     *     那样「变矮」能被地板撑住，但「变高」时 `height:auto` 会**立刻**把面板顶上去
     *     ⇒ 变高仍然是硬跳变。
     *
     * ### 为什么目标高度要**从内容算**，不能量面板
     * 夹紧值一旦下发，量 `.sheet-panel` 量到的恒是夹紧值（auto 怎么变都被夹住）
     * ⇒ 永远发现不了「内容变矮了」。所以目标高度 = **头尾固定高 + body 内容自然高**，
     * 再夹到面板上限（内容超长时本来就贴上限，多出来的由 body 内部滚动承接）。
     *
     * 不做的场景（都直接放行，绝不多加一层延迟）：
     *   · 没开 `resizeAnim` / 传了 `height` 的固定高度弹层 / 正在拖拽或回弹；
     *   · 入场 transform（240ms）没跑完 —— 只判 `active` 不够，popup-anim 里 active
     *     是 show 之后 20ms 就置 true 的，而使用方首帧 setData 回调恰在那前后；
     *   · 上一段过渡还没结束（重入保护）；
     *   · 高度差 < RESIZE_MIN_DIFF（内容微调播动画反而像卡顿）。
     */
    _animateResize() {
      if (!this.properties.resizeAnim) return;
      if (this.properties.height) return;             // 固定高度弹层无需过渡
      if (this._anim || this._drag) return;            // 拖拽/回弹进行中
      if (!this.data.active) return;
      if (this._openedAt && (Date.now() - this._openedAt) < OPEN_SETTLE_MS) return;
      // 上一段过渡还在跑 ⇒ 不能重入，但**不能把这次的高度变化丢掉**：
      // 置一个 pending，等过渡收尾时补算一次（否则内容又变了一次就被永久忽略，
      // 面板会停在过时的夹紧值上 —— 偏矮时内容就被裁掉）。
      if (this._resizeEndTimer) { this._resizePending = true; return; }

      const sc = this.selectComponent('#sheetScroll');
      // ⚠️ 内容高度还没量出来过（首帧 / spring-scroll 尚未 ready）时**直接放行**：
      //    用 0 当目标会把夹紧值砸成 0，面板瞬间塌成一条 —— 比不播动画糟得多。
      if (!sc || typeof sc.contentHeight !== 'function') return;
      const contentH = sc.contentHeight();
      if (!contentH) return;

      const self = this;
      const from = this._lastPanelH;
      // 目标 = 头尾固定部分（面板高 − body 高，二者都是布局高，不受 transform 影响）
      //        + body 内容自然高；再夹到面板上限（内容超长时本来也只显示到上限）。
      this._measureHeights(function (m) {
        if (!m) return;
        let to = m.chrome + contentH;
        if (m.cap && to > m.cap) to = m.cap;
        if (!to) return;
        if (!from) {
          // 首次进入（还没夹紧过）：直接落一个夹紧值，不播「从无到有」的假动画。
          self._lastPanelH = to;
          self._setResizeClamp(to, false);
          return;
        }
        if (Math.abs(to - from) < RESIZE_MIN_DIFF) {
          // 差异可忽略：把夹紧值对齐到目标，**不挂过渡类**（挂了就是"从相同高度放到相同高度"，
          // 白白多跑一帧过渡）。这条也顺带兜住「夹紧值因漏调而偏高」的自愈。
          self._lastPanelH = to;
          self._setResizeClamp(to, false);
          return;
        }
        self._playResize(to);
      });
    },

    /**
     * 量面板的**布局高**与 body 的**布局高**（差值 = 头尾固定高），以及面板的高度上限。
     *
     * ⚠️ 为什么用 `fields({size:true})` 而不是 `boundingClientRect()`：
     *    入场/拖拽期间面板带 `transform: translateY(...)`，boundingClientRect 量的是
     *    **视觉矩形**（含位移，甚至含 scale），减出来的高度会错。
     *    `fields({size:true})` 给的是布局尺寸，与 transform 无关。
     * ⚠️ body 的选择器是 `.sheet-spring`（**不是** `.sheet-body`）：v1.0.5 起 body 已经
     *    换成 spring-scroll，`.sheet-body` 这个类只留在 wxss 里当历史说明，wxml 中
     *    **根本不存在** ⇒ 选它永远拿到 null，这段会直接 return（第一版实打实踩过：
     *    高度过渡看着"没生效"，真因是这里量不到 body）。
     * ⚠️ 上限不靠 `getComputedStyle` 解析 `vh`/`calc`（部分 WebView 返回原串）：
     *    直接按「档位比例 × 窗口高」算，再与 app.sheetMetrics 的胶囊上限取小。
     */
    _measureHeights(cb) {
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (!q || !q.select || !q.exec) return;
      q.select('.sheet-panel').fields({ size: true });
      q.select('.sheet-spring').fields({ size: true });
      const self = this;
      q.exec(function (res) {
        const arr = res || [];
        const panel = arr[0];
        const body = arr[1];
        if (!panel || !body || !panel.height || !body.height) return;
        cb({
          chrome: Math.max(0, panel.height - body.height),
          cap: self._capPx()
        });
      });
    },

    /**
     * 面板当前生效的高度上限（px）。
     * ⚠️ 高度过渡拿它当「天花板」：内容比它还长时，面板只能显示到这么高
     *    （剩下的交给 body 内部滚动），夹紧值也绝不能超过它。
     */
    _capPx() {
      const app = getApp && getApp();
      const win = (app && app.globalData && app.globalData.windowHeight) || 0;
      if (!win) return 0;                              // 拿不到窗口高 ⇒ 不夹（交回 auto）
      const ratio = this.properties.tall ? CAP_RATIO_TALL : CAP_RATIO;
      let cap = win * ratio;
      // app.sheetMetrics 的胶囊上限（capStyle = `max-height:calc(100vh - Xpx)`）更严时取它。
      // ⚠️ 这个串是 app.js 自己拼的（格式受控），所以按字面量解析是安全的；
      //    解析不出就当没有这项约束。
      const m = /100vh\s*-\s*(\d+(?:\.\d+)?)px/.exec(this.data.capStyle || '');
      if (m) cap = Math.min(cap, win - Number(m[1]));
      return Math.max(0, cap);
    },

    /**
     * 量一次面板**当前的可见高度**，回调出去（拿不到就不回调）。
     * 只用于**开场铺夹紧值** —— 那一刻还没夹紧过，量到的就是 auto 的真实高度。
     *
     * ⚠️ 这里用 `boundingClientRect` 而不是 `fields({size:true})`：开场 300ms 时面板
     *    已经 `.up`（transform 归零），视觉矩形 == 布局尺寸，两者等价；
     *    而 `boundingClientRect` 在旧基础库上支持面更广，铺初值不值得为它冒兼容风险。
     *    ⚠️ 但**绝不能**拿它去算高度差（拖拽/回弹期间会量到含位移的视觉矩形）。
     */
    _measurePanelH(cb) {
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (!q || !q.select || !q.exec) return;
      q.select('.sheet-panel').boundingClientRect(function (rect) {
        cb(rect && rect.height ? rect.height : 0);
      }).exec();
    },

    /**
     * 下发夹紧值（成对的 min-height + max-height）。`animate=false` 时**不挂**过渡类。
     *
     * ⚠️ 每次都成对写全量值，而不是「只写变化的那个」：漏掉任何一个方向，
     *    面板都会被钉死在旧值上（变高时 max-height 停在旧值 ⇒ 顶不上去）。
     * ⚠️ animate 时**必须分两拍**：先只挂过渡类（高度不动），等一帧（TRANSITION_ARM_MS）
     *    再改高度值。同一批 setData 里既加 class 又改高度，渲染层会把它合并成一次样式
     *    提交 ⇒ 浏览器看不到「旧值 + 过渡属性已生效」这个起点，结果是
     *    **不报错、但一点动画都不播**（用户反馈「几乎没有平滑的降低动画」的另一半原因）。
     */
    _setResizeClamp(px, animate) {
      if (this._resizeAnimTimer) { clearTimeout(this._resizeAnimTimer); this._resizeAnimTimer = null; }
      if (this._resizeEndTimer) { clearTimeout(this._resizeEndTimer); this._resizeEndTimer = null; }
      const style = 'min-height:' + px + 'px; max-height:' + px + 'px;';
      if (!animate) {
        this.setData({ resizeStyle: style, resizeCls: '' });
        return;
      }
      const self = this;
      this.setData({ resizeCls: 'animating' });        // 第 1 拍：只挂过渡类
      this._resizeAnimTimer = setTimeout(function () { // 第 2 拍：再改高度
        self._resizeAnimTimer = null;
        self.setData({ resizeStyle: style });
      }, TRANSITION_ARM_MS);
      // 过渡跑完撤掉过渡类，免得下一次内容变化时从旧曲线起播。
      this._resizeEndTimer = setTimeout(function () {
        self._resizeEndTimer = null;
        self.setData({ resizeCls: '' });
        // ⚠️ 补算被重入保护挡掉的那一次（v1.0.7）：过渡期间内容又变了一次时，
        //    `_animateResize` 只置 pending 就返回了 —— 不在这里补算，那次高度变化就永久丢失。
        if (self._resizePending) {
          self._resizePending = false;
          self._animateResize();
        }
      }, TRANSITION_ARM_MS + RESIZE_ANIM_MS + 40);
    },

    /**
     * 播一段高度过渡：夹紧值 from → to（两端都是显式 px，浏览器直接插值）。
     * ⚠️ 真正的逐帧插值由浏览器完成，JS 只负责给出两端；`_lastPanelH` 记的是
     *    **目标值**（不是当前可见值）—— 下一次比较用的是它。
     */
    _playResize(to) {
      this._lastPanelH = to;
      this._setResizeClamp(to, true);
    },
    /**
     * 使用方**切换了内容板块**后调用：把 body 滚回顶部（1.0.6 请假弹层「今日 ⇄ 历史」）。
     * ⚠️ 与 `resizeScroll()` 是两件事：resize 只夹紧越界偏移、不会把偏移拉回 0。
     *    板块高度差大时不置顶，新板块会被旧偏移顶出视野 = 一片空白。
     */
    scrollTop() {
      const sc = this.selectComponent('#sheetScroll');
      if (sc && sc.scrollTop) sc.scrollTop();
    },
    /**
     * 打开后**补量一次** body 的可滚动范围（v1.0.6）。
     *
     * 为什么要放在组件里而不是让每个使用方自己调：
     *   所有弹层都是「先挂载空壳 → 数据回来再填」，spring-scroll 的 `ready()` 量到的
     *   是空壳高度（`_maxScroll = 0`）；手势起点 `onStart` 虽然也会重测，但那是
     *   **异步**的 —— 第一下的位移用旧值算，落在一个矮范围里被夹住，手感就是「滑不动」。
     * ⚠️ 80ms 是等「挂载 → 首帧渲染 → 使用方的 setData」这一拍，不是等动画
     *    （面板是 transform 位移，不改变布局尺寸，所以不用等 240ms 的入场过渡）。
     */
    _scheduleResize() {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._resizeTimer = null;
        this.resizeScroll();
      }, 80);
    },

    /* ================= 拖拽（v0.7.32） ================= */

    /** 量一次面板高度（关闭阈值 = 一半，遮罩衰减也用它）。异步，命中前用兜底值。 */
    _measure() {
      const q = this.createSelectorQuery && this.createSelectorQuery();
      if (!q || !q.select) return;
      const sel = q.select('.sheet-panel');
      if (!sel || typeof sel.boundingClientRect !== 'function') return;
      sel.boundingClientRect((rect) => {
        if (rect && rect.height) this._panelH = rect.height;
      }).exec();
    },

    /** 当前位移（px，0=打开态）：有动画在跑就按同一条曲线近似解出来（打断用） */
    _curOffset() {
      const a = this._anim;
      if (!a) return this._applied || 0;
      const p = a.dur ? clamp((Date.now() - a.t0) / a.dur, 0, 1) : 1;
      return a.from + (a.to - a.from) * easeOutApprox(p);
    },

    /** 打断：把正在跑的动画收干，停到当前位置 */
    _freeze() {
      if (!this._anim) return;
      this._applied = this._curOffset();
      this._anim = null;
      if (this._dragTimer) { clearTimeout(this._dragTimer); this._dragTimer = null; }
    },

    _panelStyle(y) {
      return 'transform: translateY(' + y.toFixed(2) + 'px); transition: none;';
    },
    /** 遮罩跟着位移线性减淡（拖到底 = 全透明） */
    _maskStyle(y) {
      const h = this._panelH || 1;
      const o = clamp(1 - y / h, 0, 1);
      return 'opacity: ' + o.toFixed(3) + '; transition: none;';
    },

    onHeadStart(e) {
      if (!this.data.draggable || !this.data.active) return;
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (!t) return;
      // 关闭按钮等「点按型」子元素不参与拖动（避免一碰标题栏就进入 dragging 态）
      const ds = (e.target && e.target.dataset) || {};
      if (ds.nodrag) return;
      this._measure();
      this._freeze();                                  // ⑤ 接住正在跑的回弹/关闭动画
      const base = this._applied || 0;
      this._drag = {
        y0: t.clientY, base, lastY: t.clientY, lastT: Date.now(), v: 0, moved: false
      };
      this.setData({ dragging: true, dragStyle: this._panelStyle(base), maskStyle: this._maskStyle(base) });
    },

    onHeadMove(e) {
      const d = this._drag;
      if (!d || !this.data.dragging) return;
      const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      if (!t) return;
      const now = Date.now();
      const raw = t.clientY - d.y0 + d.base;            // 向下为正
      // ② 向上超过原位 → rubber-banding（指数衰减，最多再拉 RUBBER_MAX）
      const y = raw < 0 ? -rubber(-raw) : raw;
      const dt = now - d.lastT;
      if (dt > 0) d.v = (t.clientY - d.lastY) / dt;     // px/ms（向下为正）
      d.lastY = t.clientY;
      d.lastT = now;
      if (Math.abs(raw) > 3) d.moved = true;
      this._applied = y;
      this.setData({ dragStyle: this._panelStyle(y), maskStyle: this._maskStyle(y) });
    },

    onHeadEnd() {
      const d = this._drag;
      this._drag = null;
      if (!d || !this.data.dragging) return;
      const y = this._applied || 0;
      const h = this._panelH || 480;
      const v = d.v || 0;
      // ③ 位移 + 速度共同判定：过半 或 快速下滑轻扫 → 关闭；否则回位
      if (y > h / 2 || v > FLICK_V) this._closeOut(y, h, v);
      else this._springBack(y, v);
    },

    /** 回弹：时长由「剩余距离 / 松手速度」算出（速度越大越快，带一点回弹手感） */
    _springBack(y, v) {
      const speed = Math.max(Math.abs(v), 0.45);
      const dur = Math.round(clamp((Math.abs(y) / speed) * 0.9 + 90, MIN_MS, MAX_MS));
      this._anim = { t0: Date.now(), from: y, to: 0, dur };
      this.setData({
        dragging: false,
        dragStyle: 'transform: translateY(0px); transition: transform ' + dur
          + 'ms cubic-bezier(.22,1.06,.36,1);',
        maskStyle: ''
      });
      this._finish(dur, () => {
        this._anim = null;
        this._applied = 0;
        this.setData({ dragStyle: '', maskStyle: '' });   // 交还给 class 规则
      });
    },

    /** 滑出关闭：先播完位移动画，再通知页面关（页面把 show 置 false）——「先动画后卸载」 */
    _closeOut(y, h, v) {
      const speed = Math.max(Math.abs(v), 0.5);
      const dur = Math.round(clamp(((h - y) / speed) * 0.9 + 80, MIN_MS, MAX_MS));
      this._anim = { t0: Date.now(), from: y, to: h, dur };
      this.setData({
        dragging: false,
        dragStyle: 'transform: translateY(' + h + 'px); transition: transform ' + dur
          + 'ms cubic-bezier(.4,0,.6,1);',
        maskStyle: 'opacity: 0; transition: opacity ' + dur + 'ms linear;'
      });
      this._finish(dur, () => {
        this._anim = null;
        this._applied = 0;
        // ⚠️ 这里**不清** dragStyle / maskStyle：交给 active 变 false 的 observer 清，
        //    否则清掉的那一帧遮罩会被 class 的 `.in` 拽回全不透明 → 闪一下。
        this.triggerEvent('close');
      });
    },

    _finish(dur, cb) {
      if (this._dragTimer) clearTimeout(this._dragTimer);
      this._dragTimer = setTimeout(() => {
        this._dragTimer = null;
        cb();
      }, dur + 16);
    }
  }
});
