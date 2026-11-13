/**
 * 班级下拉选择器（2026-11-14）
 * ============================================================
 * 起因（用户需求②④）：「辅导员账号查看班费，多个班级改为选项，点击字段展开所有班级的选项；
 *   手指按住时高亮，点中后收起菜单并回填字段，同时更新结果」「所有可以切换班级查看的
 *   都改为下拉菜单」。
 *
 * 为什么做成组件：此前同一件事有四套写法 —— 班费/值日/课表各一条横向 chips 条
 *   （fee-cls-chips / dt-fchips / tt-fchips），班级信息页另有一套 bottom-sheet 弹层。
 *   四套样式、四种交互，改一处永远漏三处。收成一个组件后，「切班」只有一种形态。
 *
 * ⚠️ 不设全屏遮罩：这些页面大多在 <spring-scroll> 内，`.ss-content` 的 transform 会
 *   把 `position: fixed` 的包含块从视口改成滚动容器 ⇒ 遮罩会跟着内容滚、盖不住整屏。
 *   所以收起靠三种明确动作：再点字段 / 点某个班 / 选中后自动收。
 *
 * 事件：bind:change → { detail: { id } }（id 为 0 表示无效项，调用方自行忽略）
 */
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
    curId: 0
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
    attached() { this._sync(); }
  },

  methods: {
    _sync(list, value) {
      const l = list === undefined ? this.data.list : list;
      const v = value === undefined ? this.data.value : value;
      const opts = (l || []).map(x => ({ id: Number(x.id) || 0, name: String(x.name || '') }));
      const curId = Number(v) || 0;
      const hit = opts.find(x => x.id === curId);
      this.setData({
        opts,
        curId,
        curName: hit ? hit.name : ''
      });
    },

    /** 点字段：展开 / 收起 */
    onToggle() {
      if (!this.data.opts || !this.data.opts.length) return;
      this.setData({ open: !this.data.open });
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

    /** 展开态下点字段外的空白（父级卡片给了 catchtap 的位置）：收起 */
    onSelfClose() {
      if (this.data.open) this.setData({ open: false });
    },

    /** 空实现：拦住浮层内的滑动，别把 touchmove 冒泡给页面滚动 */
    noop() {}
  }
});
