/**
 * 演讲排班（1.0.8.67 · 独立二级页，非 Tab）
 * ------------------------------------------------------------
 * 与值日排班页（pages/manual）分工一致，只是数据换成课前演讲：
 *   · 列出本周**全部演讲场次**（含还没排人的空场）；
 *   · 点「＋ 添加演讲」把同学加到某场；
 *   · 点已排同学 → 换人 / 取消该场；
 *   · 底部发布 / 撤回。
 * 数据来自 speechBoard；写操作 speechAdd / speechRemove / speechReassign / speechPublish。
 * ⚠️ 全部写路由挂 speechAuth（超管 | 生活委员 | 学习委员 | 后台单独授予），
 *   与值日 scheduleAuth 分离 —— 学习委员只排演讲、不排值日。真拦截在云函数。
 * 场次 = (date + slot)；成员行 id = speech 表 id；加人按 sessionId 定位场次。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const mem = require('../../utils/mem');
const swipe = require('../../utils/swipe');
const theme = require('../../utils/theme');

Page({
  data: {
    /* 首帧主题：同步注入，不等 onLoad 异步（深色不闪浅） */
    tClass: theme.rootClass(),
    statusBarHeight: 20,
    loading: true,
    failed: false,

    week: 1,
    totalWeeks: 16,
    current: 1,
    termStart: '',
    published: false,

    days: [],
    roster: [],
    stats: { total: 0, people: 0, sessions: 0 },
    busy: false,

    /** 左右滑动切周的方向性动画 class（utils/swipe.js 下发） */
    swipeCls: '',

    /* 选人弹层 */
    pickerShow: false,
    pickerTitle: '',
    pickerMode: 'ADD',        // ADD | REASSIGN
    pickerSession: null,
    pickerSpeechId: 0,
    pickerCount: 0,
    pickerItems: [],
    kw: '',
    list: [],
    submitting: false
  },

  onLoad() {
    const app = getApp();
    theme.mount(this);
    const cfg = app.globalData.config || {};
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: cfg.termStart || '',
      totalWeeks: cfg.totalWeeks || 16,
      current: cfg.currentWeek || 1,
      week: cfg.currentWeek || 1
    });
  },

  onUnload() {
    theme.unmount(this);
    swipe.cancel(this);
  },

  onShow() {
    const app = getApp();
    if (app.track) app.track.pageView('speech');
    const run = () => this.load();
    if (app && app.globalData && !app.globalData.authChecked) app.ready().then(run);
    else run();
  },

  /** 缓存键：演讲排班独立命名，不污染值日 manual 缓存 */
  _memKey() { return 'speech:board:' + this.data.week; },

  /** 演讲表被改动 → 清本页缓存（下次 load 必拉最新）；值日页演讲视图本就每次真请求，不受缓存影响 */
  _invalidateSpeech() {
    mem.clear(this._memKey());
  },

  load() {
    const key = this._memKey();
    const cached = mem.read(key);
    const hasContent = !!cached;
    if (hasContent) this._paint(cached);
    else this.setData({ loading: true, failed: false });

    api.speechBoard({ week: this.data.week }, { toast: false })
      .then((r) => {
        mem.write(key, r);
        this._paint(r);
      })
      .catch((e) => {
        this.setData({ loading: false, failed: !hasContent });
        util.toast(this._errText(e));
      });
  },

  _paint(r) {
    this.setData({
      loading: false,
      failed: false,
      published: !!(r && r.published),
      days: this._decorateDays((r && r.days) || []),
      roster: (r && r.roster) || [],
      stats: (r && r.stats) || { total: 0, people: 0, sessions: 0 }
    });
  },

  _decorateDays(days) {
    return (days || []).map(d => Object.assign({}, d, {
      weekdayText: util.weekdayCn(util.weekdayOfNum(d.date)),
      dateText: util.md(d.date),
      sessions: (d.sessions || []).map(s => Object.assign({}, s, {}))
    }));
  },

  onWeekChange(e) {
    const wk = Number(e.detail.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  _applyWeek(wk) {
    this.setData({ week: wk });
    this.load();
  },

  _shiftWeek(delta) {
    this.onWeekChange({ detail: { week: Number(this.data.week) + delta } });
  },
  onSwipeStart(e) { swipe.begin(this, e); },
  onSwipeEnd(e) {
    if (this.data.pickerShow) return;
    const dir = swipe.end(this, e);
    if (dir === 'prev') this._shiftWeek(-1);
    else if (dir === 'next') this._shiftWeek(1);
  },

  /* ---------------- 选人 ---------------- */
  onAdd(e) {
    const ds = e.currentTarget.dataset;
    this._openPicker('ADD', ds.date, Number(ds.sid), 0);
  },

  onMemberTap(e) {
    const ds = e.currentTarget.dataset;
    const speechId = Number(ds.sid2);
    const that = this;
    wx.showActionSheet({
      itemList: ['换人', '取消演讲'],
      success: (res) => {
        if (res.tapIndex === 0) that._openPicker('REASSIGN', ds.date, Number(ds.sid), speechId);
        else if (res.tapIndex === 1) that._removeSpeech(speechId);
      },
      fail: () => {}
    });
  },

  _openPicker(mode, date, sessionId, speechId) {
    const day = this.data.days.find(d => d.date === date);
    if (!day) return;
    const session = (day.sessions || []).find(s => s.sessionId === sessionId);
    if (!session) return;

    const inSession = {};
    (session.members || []).forEach(m => { inSession[m.memberId] = true; });

    /* 候选：已在此场次的置灰不可选；分组课限对应组（与值日 _openPicker 同口径） */
    const all = this.data.roster.map(r => {
      const inThis = !!inSession[r.id];
      const groupBad = !!(session.groupScope && r.groupTag !== session.groupScope);
      const disabled = inThis || groupBad;
      let badge = '';
      if (inThis) badge = '已在此场次';
      else if (groupBad) badge = '限 ' + session.groupScope + ' 组';
      return Object.assign({}, r, {
        seqText: r.seq ? String(r.seq) : '·',
        disabled, badge
      });
    });

    this.pickerAll = all;
    const acItems = all.map(r => ({
      id: r.id,
      name: r.name,
      sub: (r.seq ? String(r.seq) + ' 号 · ' : '') + (r.groupTag || '') + ' 组' +
        (r.badge ? ' · ' + r.badge : ''),
      disabled: r.disabled
    }));
    this.setData({
      pickerShow: true,
      pickerMode: mode,
      pickerSession: session,
      pickerSpeechId: speechId,
      pickerCount: all.length,
      pickerItems: acItems,
      pickerTitle: (mode === 'REASSIGN' ? '换人' : '添加演讲') + ' · ' + session.whenText,
      kw: '',
      submitting: false
    });
    this._filter();
  },

  onPickerKw(e) {
    this.setData({ kw: String(e.detail.value || '') });
    this._filter();
  },

  onPickAcMember(e) {
    const id = Number(e.detail && e.detail.id);
    if (!id) return;
    this.onPickMember({ currentTarget: { dataset: { id: id } } });
  },

  _filter() {
    const kw = String(this.data.kw || '').trim();
    const all = this.pickerAll || [];
    const list = kw
      ? all.filter(x => x.name.indexOf(kw) >= 0 || String(x.seq).indexOf(kw) === 0)
      : all;
    this.setData({ list });
  },

  onPickMember(e) {
    if (this.data.submitting) return;
    const id = Number(e.currentTarget.dataset.id);
    const item = (this.data.list || []).find(x => x.id === id);
    if (!item || item.disabled) {
      if (item && item.badge) util.toast(item.badge + '，不可选择');
      return;
    }
    this._submit(id);
  },

  onPickerClose() { this.setData({ pickerShow: false }); },

  _submit(memberId) {
    const session = this.data.pickerSession || {};
    const mode = this.data.pickerMode;
    this.setData({ submitting: true });
    this._invalidateSpeech();
    const p = mode === 'REASSIGN'
      ? api.speechReassign({ id: this.data.pickerSpeechId, memberId })
      : api.speechAdd({ week: this.data.week, sessionId: session.sessionId, memberId });
    p.then(() => {
      this.setData({ submitting: false, pickerShow: false });
      util.toast(mode === 'REASSIGN' ? '已换人' : '已添加演讲');
      this.load();
    }).catch((e) => {
      this.setData({ submitting: false });
      util.toast(this._errText(e));
    });
  },

  _removeSpeech(speechId) {
    const that = this;
    util.confirm('取消后该同学不再参与这场课前演讲', '取消演讲').then(ok => {
      if (!ok) return;
      that._invalidateSpeech();
      api.speechRemove({ id: speechId }, { loading: '处理中' })
        .then(() => { util.toast('已取消'); that.load(); })
        .catch((e) => util.toast(that._errText(e)));
    });
  },

  /* ---------------- 发布 ---------------- */
  onPublish() {
    if (this.data.busy) return;
    const that = this;
    this.setData({ busy: true });
    this._invalidateSpeech();
    api.speechPublish({ week: this.data.week, status: 'PUBLISHED' }, { loading: '发布中' })
      .then(() => { that.setData({ busy: false }); util.toast('本周演讲已发布'); that.load(); })
      .catch((e) => { that.setData({ busy: false }); util.toast(that._errText(e)); });
  },

  onUnpublish() {
    if (this.data.busy) return;
    const that = this;
    util.confirm('撤回后班级将暂时看不到本周演讲', '撤回发布').then(ok => {
      if (!ok) return;
      that.setData({ busy: true });
      that._invalidateSpeech();
      api.speechPublish({ week: that.data.week, status: 'DRAFT' }, { loading: '处理中' })
        .then(() => { that.setData({ busy: false }); util.toast('已撤回发布'); that.load(); })
        .catch((e) => { that.setData({ busy: false }); util.toast(that._errText(e)); });
    });
  },

  onReload() { this.load(); },

  _errText(e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.code);
    const msg = (e && (e.errMsg || e.message)) || '操作失败，请重试';
    return (code !== undefined && code !== null ? '[' + code + '] ' : '') + msg;
  },

  noop() {}
});
