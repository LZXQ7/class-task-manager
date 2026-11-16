/**
 * 课前演讲排班（2026-11-16）
 * 每天上午第1节前 8:00-8:10、下午第3节前 14:30-14:40 的课前演讲安排。
 * 入口在「本周值日」页顶部；权限与发布体系与值日一致（超管 | 本班生活委员）。
 * 排班内核在云函数 schedule 的 speech* 路由，独立游标 / 独立发布态。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const theme = require('../../utils/theme');

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

Page({
  data: {
    tClass: theme.rootClass(),
    statusBarHeight: 20,
    week: 1,
    current: 1,
    totalWeeks: 18,
    termStart: '',
    canSchedule: false,
    loading: true,
    status: 'DRAFT',
    unpublished: false,
    days: [],
    setting: { need_n: 2, start_weekday: null, start_slot: 'AM', start_seq: null },
    /* 设置弹层 */
    settingShow: false,
    setNeedN: 2,
    setStartWeekday: 0,      // 0 = 不设；1~7 = 周一~周日
    setStartSlot: 'AM',
    setStartSeq: '',
    weekdayOpts: [
      { key: 0, label: '不设（从游标续排）' },
      { key: 1, label: '周一' }, { key: 2, label: '周二' }, { key: 3, label: '周三' },
      { key: 4, label: '周四' }, { key: 5, label: '周五' }, { key: 6, label: '周六' }, { key: 7, label: '周日' }
    ],
    needOpts: [{ key: 1, label: '1 人' }, { key: 2, label: '2 人' }],
    slotOpts: [{ key: 'AM', label: '上午' }, { key: 'PM', label: '下午' }],
    /* 换人弹层 */
    swapShow: false,
    swapTarget: null,        // { id, date, slot, scope, name }
    swapMembers: [],         // [{id, name, studentNo, seq}]，来自 speechList 的 roster
    roster: []               // 管理员换人候选名册（speechList 下发）
  },

  onLoad() {
    const app = getApp();
    theme.mount(this);
    const cfg = app.globalData.config || {};
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: cfg.termStart || '',
      totalWeeks: cfg.totalWeeks || 18,
      current: cfg.currentWeek || 1,
      week: cfg.currentWeek || 1,
      canSchedule: !!(app && app.canSchedule && app.canSchedule())
    });
  },

  onUnload() { theme.unmount(this); },

  onShow() {
    const app = getApp();
    if (app.track) app.track.pageView('speech');
    this.setData({ canSchedule: !!(app && app.canSchedule && app.canSchedule()) });
    this.load();
  },

  /* ---------------- 数据 ---------------- */
  load() {
    const gView = Number(getApp().globalData.viewClassId) || 0;
    this.setData({ loading: true });
    return api.speechList({ week: this.data.week, classId: gView || undefined }, { toast: false })
      .then((r) => {
        const days = this._decorate((r && r.days) || []);
        const st = r && r.setting ? r.setting : this.data.setting;
        this.setData({
          loading: false,
          status: (r && r.status) || 'DRAFT',
          unpublished: !!(r && r.unpublished),
          days,
          setting: st,
          canSchedule: r && typeof r.canSchedule === 'boolean' ? r.canSchedule : this.data.canSchedule,
          roster: (r && r.roster) || []
        });
      })
      .catch((e) => {
        this.setData({ loading: false });
        util.toast((e && e.errMsg) || '加载演讲安排失败');
      });
  },

  _decorate(days) {
    return (days || []).map(d => Object.assign({}, d, { weekdayText: '周' + (WEEKDAY[d.weekday] || '') }));
  },

  onWeekChange(e) {
    const week = Number(e.detail && e.detail.week) || this.data.week;
    this.setData({ week }, () => this.load());
  },

  /* ---------------- 管理：设置 ---------------- */
  onSettingOpen() {
    const s = this.data.setting || {};
    this.setData({
      settingShow: true,
      setNeedN: s.need_n === 1 ? 1 : 2,
      setStartWeekday: Number(s.start_weekday) || 0,
      setStartSlot: s.start_slot === 'PM' ? 'PM' : 'AM',
      setStartSeq: s.start_seq == null ? '' : String(s.start_seq)
    });
  },
  onSettingClose() { this.setData({ settingShow: false }); },
  onNeedPick(e) { this.setData({ setNeedN: Number(e.currentTarget.dataset.key) }); },
  onWeekdayPick(e) { this.setData({ setStartWeekday: Number(e.currentTarget.dataset.key) }); },
  onSlotPick(e) { this.setData({ setStartSlot: e.currentTarget.dataset.key }); },
  onStartSeqInput(e) { this.setData({ setStartSeq: e.detail.value }); },
  onSettingSave() {
    const seq = String(this.data.setStartSeq || '').trim();
    if (seq && !/^\d+$/.test(seq)) { util.toast('起始学号序号要填数字'); return; }
    if (this._busy) { util.toast('处理中，请稍候'); return; }
    this._busy = true;
    api.speechSetSettings({
      need_n: this.data.setNeedN,
      start_weekday: this.data.setStartWeekday || null,
      start_slot: this.data.setStartSlot,
      start_seq: seq || null
    }, { toast: false }).then(() => {
      this._busy = false;
      this.setData({ settingShow: false });
      util.toast('设置已保存');
      this.load();
    }).catch((e) => {
      this._busy = false;
      util.toast((e && e.errMsg) || '保存失败');
    });
  },

  /* ---------------- 管理：生成 / 清空 / 发布 ---------------- */
  onGenerate() {
    if (this._busy) { util.toast('处理中，请稍候'); return; }
    this._busy = true;
    wx.showLoading({ title: '正在生成…', mask: true });
    api.speechGenerate({ week: this.data.week }, { toast: false }).then((r) => {
      this._busy = false;
      wx.hideLoading();
      util.toast(r && r.created ? ('已排 ' + r.created + ' 人次' + (r.short ? '（有缺口）' : '')) : '本周无需排演讲');
      this.load();
    }).catch((e) => {
      this._busy = false;
      wx.hideLoading();
      util.toast((e && e.errMsg) || '生成失败');
    });
  },
  onClear() {
    if (this._busy) { util.toast('处理中，请稍候'); return; }
    wx.showModal({
      title: '清空本周演讲', content: '确定清空本周全部演讲安排？（不影响轮转进度，下次生成接着排）',
      confirmColor: '#E34D59', success: (res) => {
        if (!res.confirm) return;
        this._busy = true;
        api.speechClear({ week: this.data.week }, { toast: false }).then(() => {
          this._busy = false; util.toast('已清空'); this.load();
        }).catch((e) => { this._busy = false; util.toast((e && e.errMsg) || '清空失败'); });
      }
    });
  },
  onPublish() {
    if (this._busy) { util.toast('处理中，请稍候'); return; }
    this._busy = true;
    api.speechPublish({ week: this.data.week, status: 'PUBLISHED' }, { toast: false }).then(() => {
      this._busy = false; util.toast('已发布给全班'); this.load();
    }).catch((e) => { this._busy = false; util.toast((e && e.errMsg) || '发布失败'); });
  },
  onUnpublish() {
    if (this._busy) { util.toast('处理中，请稍候'); return; }
    this._busy = true;
    api.speechPublish({ week: this.data.week, status: 'DRAFT' }, { toast: false }).then(() => {
      this._busy = false; util.toast('已撤回'); this.load();
    }).catch((e) => { this._busy = false; util.toast((e && e.errMsg) || '撤回失败'); });
  },

  /* ---------------- 管理：单场换人 ---------------- */
  onSwapTap(e) {
    if (!this.data.canSchedule) return;
    const d = e.currentTarget.dataset;
    this.setData({
      swapShow: true,
      swapTarget: { id: d.id, date: d.date, slot: d.slot, scope: d.scope, name: d.name },
      swapMembers: this.data.roster || []
    });
  },
  onSwapPick(e) {
    const mid = Number(e.currentTarget.dataset.mid);
    const t = this.data.swapTarget;
    if (!mid || !t) return;
    api.speechReassign({ id: t.id, memberId: mid }, { toast: false }).then(() => {
      this.setData({ swapShow: false }); util.toast('已换人'); this.load();
    }).catch((e) => util.toast((e && e.errMsg) || '换人失败'));
  },
  onSwapClose() { this.setData({ swapShow: false }); }
});
