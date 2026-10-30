/**
 * P7 · 作业提交与管理 · 列表页（2026-10-24）
 * ------------------------------------------------------------
 * · 班委：看本班全部作业，底部固定「发布作业」按钮
 * · 普通成员：只看「指定给本组」的作业，卡片上带自己的提交状态
 * · 点击卡片 → 进详情（提交 / 批阅）
 * · 左滑卡片露出删除区（仅发布者本人 / 超管，见后端 canDelete；与通知页同交互）
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const theme = require('../../utils/theme');

const STATUS_TEXT = { PENDING: '待批阅', DONE: '已完成', REJECT: '有问题' };
const REQUIRE_TEXT = { NONE: '', IMAGE: '图片', FILE: '文件', EITHER: '图片或文件' };

/** 删除区露出总宽（px，含删除区本身 72px + 与卡片的 8px 间距；与 notice 页同口径） */
const DEL_WIDTH = 80;

Page({
  data: {
    classId: 0,
    list: [],
    loaded: false,
    canReview: false
  },

  onLoad(options) {
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    const classId = Number(options && options.classId) || 0;
    this.setData({ classId });
  },

  onShow() {
    this._load();
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅
  },

  _load() {
    api.homeworkList(this._payload({}))
      .then((res) => {
        const list = (res && res.list) || [];
        this.setData({
          list: list.map(h => Object.assign({}, h, {
            groupText: (h.groups || []).map(g => g === 'SELF' ? '仅自己' : g + ' 组').join(' / '),
            requireText: REQUIRE_TEXT[h.requireType] || '',
            statusText: h.myStatus ? (STATUS_TEXT[h.myStatus] || h.myStatus) : '未交',
            statusTone: h.myStatus || 'none'
          })),
          canReview: !!(res && res.canReview),
          loaded: true
        });
      })
      .catch(() => this.setData({ loaded: true }));
  },

  _payload(extra) {
    const p = { classId: this.data.classId };
    return Object.assign(p, extra || {});
  },

  onOpen(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.navigateTo({ url: '/pages/homework/detail?id=' + id + '&classId=' + this.data.classId });
  },

  /* ---------------- 左滑手势（露出删除区，与通知页同交互） ---------------- */
  onSwipeStart(e) {
    const t = e.touches[0];
    const id = Number(e.currentTarget.dataset.id);
    const index = Number(e.currentTarget.dataset.index);
    // 先收起其它已展开的卡片（同时只展开一张）
    if (this._openId && this._openId !== id) {
      const i = (this.data.list || []).findIndex(x => x.id === this._openId);
      if (i >= 0) this.setData({ ['list[' + i + '].offset']: 0, ['list[' + i + '].swiping']: false });
      this._openId = null;
    }
    const item = this.data.list[index];
    this._swipe = {
      id, index,
      startX: t.clientX,
      startY: t.clientY,
      startOffset: (item && item.offset) || 0
    };
    if (item) this.setData({ ['list[' + index + '].swiping']: true });
  },

  onSwipeMove(e) {
    if (!this._swipe) return;
    const t = e.touches[0];
    const dx = t.clientX - this._swipe.startX;
    const dy = t.clientY - this._swipe.startY;
    // 纵向为主时交给页面滚动，不处理；只有横向滑动才移动卡片
    if (Math.abs(dx) < Math.abs(dy)) return;
    let offset = this._swipe.startOffset + dx;
    if (offset > 0) offset = 0;
    if (offset < -DEL_WIDTH) offset = -DEL_WIDTH;
    this.setData({ ['list[' + this._swipe.index + '].offset']: offset });
  },

  onSwipeEnd() {
    if (!this._swipe) return;
    const s = this._swipe;
    this._swipe = null;
    const item = this.data.list[s.index];
    const offset = (item && item.offset) || 0;
    let target = 0;
    // 滑过一半就吸附展开，否则回弹收起
    if (offset <= -DEL_WIDTH / 2) {
      target = -DEL_WIDTH;
      this._openId = s.id;
    } else {
      target = 0;
      if (this._openId === s.id) this._openId = null;
    }
    this.setData({
      ['list[' + s.index + '].swiping']: false,
      ['list[' + s.index + '].offset']: target
    });
  },

  /* ---------------- 侧滑删除（仅发布者本人 / 超管，见后端 canDelete） ---------------- */
  onDelete(e) {
    const index = Number(e.currentTarget.dataset.index);
    const item = this.data.list[index];
    if (!item || !item.canDelete) return;
    const self = this;
    wx.showModal({
      title: '删除作业',
      content: '将删除「' + item.title + '」及其全部提交记录与文件，不可恢复。',
      confirmText: '删除',
      confirmColor: '#F53F3F',
      success: (r) => {
        if (!r.confirm) {
          // 取消：收起删除区（不然白开着碍事）
          self.setData({ ['list[' + index + '].offset']: 0, ['list[' + index + '].swiping']: false });
          self._openId = null;
          return;
        }
        self._doDelete(item.id, index);
      }
    });
  },

  _doDelete(id, index) {
    if (this._deleting) return;
    this._deleting = true;
    api.homeworkDelete(this._payload({ homeworkId: id }))
      .then(() => {
        const list = (this.data.list || []).slice();
        if (index >= 0 && index < list.length) list.splice(index, 1);
        this._openId = null;
        this.setData({ list });
        util.toast('已删除');
      })
      .catch(() => { /* api 层已 toast */ })
      .then(() => { this._deleting = false; });
  },

  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  }
});
