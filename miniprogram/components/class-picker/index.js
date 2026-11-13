/**
 * 班级下拉选择器（2026-11-14）
 * ============================================================
 * 起因（用户需求②④）：「辅导员账号查看班费，多个班级改为选项，点击字段展开所有班级的选项；
 *   手指按住时高亮，点中后收起菜单并回填字段，同时更新结果」「所有可以切换班级查看的
 *   都改为下拉菜单」。
 *
 * 2026-11-14 追加（用户口径）：「展开时列表以当前选中项为中心对齐，选中后收回并更新框内文字，
 *   相关内容同步更新」—— 展开不再整块往下掉，而是把「已选中那一行」对齐到字段中心，
 *   其余选项分布在它上下；定位算式在 utils/class-picker-layout.js（纯函数，可测）。
 *   四个使用页共用本组件 ⇒ 改一处即「所有下拉选择框」同时生效。
 *
 * 为什么做成组件：此前同一件事有四套写法 —— 班费/值日/课表各一条横向 chips 条
 *   （fee-cls-chips / dt-fchips / tt-fchips），班级信息页另有一套 bottom-sheet 弹层。
 *   四套样式、四种交互，改一处永远漏三处。收成一个组件后，「切班」只有一种形态。
 *
 * ⚠️ 不设全屏遮罩：这些页面大多在 <spring-scroll> 内，`.ss-content` 的 transform 会
 *   把 `position: fixed` 的包含块从视口改成滚动容器 ⇒ 遮罩会跟着内容滚、盖不住整屏。
 *   所以收起靠三种明确动作：再点字段 / 点浮层空白处 / 选中后自动收。
 *
 * 事件：bind:change → { detail: { id } }（id 为 0 表示无效项，调用方自行忽略）
 */
const layout = require('../../utils/class-picker-layout.js');

Component({
  options: { addGlobalClass: true },
  properties: {
    /** [{ id, name }]，id 必须能转成数字（与各页 viewClassId 同口径） */
    list: { type: Array, value: [] },
    /** 当前选中的班级 id（0 = 未选） */
    value: { type: Number, value: 0 },
    /** 字段左侧的前缀说明，如「查看班级」；留空则不渲染 */
    label: { type: String, value: '' },
    placeholder: { type: String, value: '选择班级' },
    /**
     * 固定触发器文案（2026-11-14）：非空时字段只显示这段文字、不显示当前班名。
     * 用在「班名已经在页面大标题里」的场景（信息页）—— 那里字段挤在「班级概况」右边，
     * 再放一遍全名会被省略号截成「示例专业26…」，等于没显示。
     * 该页的「框内文字」由卡片大标题（className）承担，切班后由 _applyClass 同步更新。
     */
    triggerText: { type: String, value: '' },
    /** 展开时「已选中」那一项是否打勾（班级信息页面上要更明确，其余页保持轻量） */
    showCheck: { type: Boolean, value: true }
  },

  data: {
    open: false,
    curName: '',
    /* 规范化后的选项与选中值：id 一律转数字。
     * 各页传给 list 的 id 类型不统一（classinfo 是 number、timetable 直接用接口原值），
     * 而 wxml 里 `item.id === curId` 是严格比较 —— 类型不一致会「点了能切、勾不显示」。
     * 在这里转一次，四个页面都不用各自操心。 */
    opts: [],
    curId: 0,
    /** 当前选中项下标：展开定位要用它把选中行对齐到字段中心 */
    curIndex: 0,
    /** 浮层内联定位。'' = 尚未测量，退回 wxss 的普通下拉（top:100%） */
    popStyle: ''
  },

  observers: {
    /**
     * ⚠️ 必须用回调参数算，不能在里面读 this.data —— 属性监听器触发时 this.data 可能
     * 还是上一轮的值（app-icon 的同款坑），会算出旧班名回填到字段上。
     */
    'list, value': function (list, value) {
      this._sync(list, value);
    }
  },

  lifetimes: {
    attached() { this._sync(); },
    /* 展开定位是异步的（createSelectorQuery）：页面在回调前被销毁时别再对已卸载组件 setData */
    detached() { this._gone = true; }
  },

  methods: {
    _sync(list, value) {
      const l = list === undefined ? this.data.list : list;
      const v = value === undefined ? this.data.value : value;
      const opts = (l || []).map(x => ({ id: Number(x.id) || 0, name: String(x.name || '') }));
      const curId = Number(v) || 0;
      const hit = opts.find(x => x.id === curId);
      let curIndex = opts.findIndex(x => x.id === curId);
      if (curIndex < 0) curIndex = 0;
      this.setData({
        opts,
        curId,
        curName: hit ? hit.name : '',
        curIndex
      });
    },

    /** 点字段：收起 / 展开（展开要先量位置，见 _openCentered） */
    onToggle() {
      if (!this.data.opts || !this.data.opts.length) return;
      if (this.data.open) { this.setData({ open: false }); return; }
      this._openCentered();
    },

    /**
     * 展开时把「当前选中项」对齐到字段中心。
     * ⚠️ createSelectorQuery 是异步的：先把定位算出来再一起 setData({open:true})，
     *    否则浮层会先在旧位置闪一帧再跳到新位置（动画起点错乱）。
     * ⚠️ 拿不到运行时信息（门禁 Node 环境 / 查询失败 / 老基础库）时退回空 popStyle，
     *    即 wxss 默认的普通下拉 —— 功能不丢，只是不居中。
     */
    _openCentered() {
      const openWith = (popStyle) => {
        if (this._gone) return;
        this.setData({ open: true, popStyle: popStyle || '' });
      };
      if (typeof wx === 'undefined' || !wx.createSelectorQuery) { openWith(''); return; }

      let win = null;
      try {
        win = wx.getWindowInfo ? wx.getWindowInfo()
          : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : null);
      } catch (e) {
        console.error('[class-picker] getWindowInfo failed', e && e.stack ? e.stack : e);
      }
      if (!win || !win.windowWidth || !win.windowHeight) { openWith(''); return; }

      wx.createSelectorQuery().in(this).select('.cp-field').boundingClientRect((rect) => {
        if (!rect || !rect.height) { openWith(''); return; }
        const r = layout.layoutPop({
          fieldTop: rect.top,
          fieldH: rect.height,
          winW: win.windowWidth,
          winH: win.windowHeight,
          index: this.data.curIndex,
          count: (this.data.opts || []).length
        });
        /* margin-top 必须归零：wxss 默认给普通下拉留了 10rpx，测量后的 top 已含全部偏移，
         * 不清掉会让选中项整体下移 10rpx，中心对不齐。 */
        openWith('top:' + r.top + 'rpx;height:' + r.height + 'rpx;margin-top:0rpx;');
      }).exec();
    },

    /** 选中：回填 → 收起 → 抛事件（三者顺序固定，先收再抛，避免调用方 setData 把浮层又打开） */
    onPick(e) {
      const id = Number(e.currentTarget.dataset.id) || 0;
      /* ⚠️ 「是不是点当前项」必须**先存旧值**再 setData —— 回填后 curId 已经是新 id，
       *    再拿它比较恒等 → 事件永远抛不出去（四个页面全都「点了没反应」）。 */
      const prev = Number(this.data.curId) || 0;
      this.setData({ open: false });
      if (!id) return;
      const hit = (this.data.opts || []).find(x => x.id === id);
      if (hit) this.setData({ curId: id, curName: hit.name });
      if (id === prev) return;   // 点当前项 = 确认，不重复抛事件
      this.triggerEvent('change', { id: id });
    },

    /**
     * 点浮层空白处收起（2026-11-14 启用）。
     * 浮层以选中项为中心展开后**会盖住字段行**，「再点字段收起」不再可靠，
     * 必须给一条明确的收起路径。点选项时 onPick 已把 open 置 false，这里自然空转。
     */
    onSelfClose() {
      if (this.data.open) this.setData({ open: false });
    },

    /** 空实现：拦住浮层内的滑动，别把 touchmove 冒泡给页面滚动 */
    noop() {}
  }
});
