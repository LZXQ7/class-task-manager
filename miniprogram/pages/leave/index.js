/**
 * 我的请假 / 请假审批（2026-11-01 请假 v3）
 * ------------------------------------------------------------
 * 普通成员：本人提交请假申请（日期区间 + 多时段 + 可选假条），提交后由班长/副班长/超管审批；
 * 审批人（班长/副班长/超管）：在「审批」tab 看到待批队列，通过/驳回。
 * 与 roster 的「班委代登记」是两条线：代登记即时生效（source='register'），自申请需审批（source='apply'）。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const request = require('../../utils/request');
const theme = require('../../utils/theme');

/** 时段 key → 中文短标签（与后端 PERIOD_DEFS 同口径） */
const SLOT_LABEL_MAP = { am: '上午', pm: '下午', eve: '晚上' };
const PERIOD_HINT = { am: '上午 08:00–12:00', pm: '下午 13:00–18:00', eve: '晚上 18:00–21:00' };
const REASON_OPTS = [
  { key: 'COURSE', text: '课程相关' },
  { key: 'SICK', text: '病假' },
  { key: 'INTERN', text: '实习' },
  { key: 'OTHER', text: '其他' }
];
const STATUS_TEXT = { PENDING: '待审批', APPROVED: '已通过', REJECTED: '未通过', CANCELLED: '已撤回' };
const STATUS_CLASS = { PENDING: 'st-pending', APPROVED: 'st-approved', REJECTED: 'st-rejected', CANCELLED: 'st-cancelled' };

/** YYYY-MM-DD */
function ymd(d) {
  const y = d.getFullYear();
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + day;
}
function parsePeriodsFront(p) {
  if (!p) return [];
  if (Array.isArray(p)) return p.filter(Boolean);
  return String(p).split(',').map((t) => t.trim()).filter(Boolean);
}
function periodsTextFront(periods) {
  const a = parsePeriodsFront(periods);
  if (!a.length) return '全天';
  return a.map((k) => SLOT_LABEL_MAP[k] || k).join('、');
}

Page({
  data: {
    statusBarHeight: 20,
    tClass: '',
    tab: 'apply',
    canApprove: false,
    segOpts: [{ key: 'apply', text: '我的申请' }],
    loading: false,
    /* ---- 申请表单 ---- */
    startDate: '',
    endDate: '',
    maxDate: '',
    leavePeriods: [],
    periodAllOn: true,
    periodAmOn: false,
    periodPmOn: false,
    periodEveOn: false,
    leavePeriodHint: '全天请假（区间内每天所有时段都算请假）。',
    reasonOpts: REASON_OPTS,
    reasonIndex: 3,
    reasonText: '其他',
    imageFileId: '',
    imageThumb: '',
    submitting: false,
    /* ---- 列表 ---- */
    myList: [],
    pendingList: [],
    busyId: 0,
    /* 图片临时链接缓存：fileID → 临时 URL，避免每次预览都换 */
    _imgUrlCache: {}
  },

  onLoad(options) {
    const app = getApp();
    theme.mount(this);   // 深色模式：挂 t-light / t-dark 到本页根节点
    this.setData({ statusBarHeight: (app && app.globalData && app.globalData.statusBarHeight) || 20 });
    const now = new Date();
    const today = ymd(now);
    const canApprove = !!(app && app.canApprove && app.canApprove());
    const tab = (options && options.tab === 'approve' && canApprove) ? 'approve' : 'apply';
    const segOpts = canApprove
      ? [{ key: 'apply', text: '我的申请' }, { key: 'approve', text: '审批' }]
      : [{ key: 'apply', text: '我的申请' }];
    this.setData({
      canApprove, tab, segOpts,
      startDate: today,
      endDate: today,
      maxDate: ymd(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()))
    });
  },

  onUnload() { theme.unmount(this); },

  onShow() { this.load(); },

  /** 加载两个列表（审批人额外拉待批队列） */
  load() {
    this._loadMy();
    if (this.data.canApprove) this._loadPending();
  },

  _decorate(x) {
    return Object.assign({}, x, {
      statusText: STATUS_TEXT[x.status] || x.status,
      statusClass: STATUS_CLASS[x.status] || '',
      periodsText: x.periodsText || periodsTextFront(x.periods),
      reasonText: (REASON_OPTS.filter((r) => r.key === x.reason)[0] || {}).text || '其他',
      imgUrl: ''
    });
  },

  _loadMy() {
    this.setData({ loading: true });
    api.leaveMyList({}, { toast: false })
      .then((r) => {
        const list = ((r && r.list) || []).map((x) => this._decorate(x));
        this.setData({ myList: list, loading: false });
        this._refreshImages('myList');
      })
      .catch(() => this.setData({ loading: false }));
  },

  _loadPending() {
    api.leavePendingList({}, { toast: false })
      .then((r) => {
        const list = ((r && r.list) || []).map((x) => this._decorate(x));
        this.setData({ pendingList: list });
        this._refreshImages('pendingList');
      })
      .catch(() => {});
  },

  /**
   * 批量把 cloud:// 假条 fileID 换成临时预览 URL（<image> 不能直接吃 cloud://）。
   * 已换过的 fileID 走本地缓存，避免重复请求；换完回写对应列表的 imgUrl。
   */
  _refreshImages(listName) {
    const list = this.data[listName] || [];
    const ids = list
      .filter((x) => x.hasImage && x.image && !this.data._imgUrlCache[x.image])
      .map((x) => x.image);
    const apply = () => {
      const cache = this.data._imgUrlCache;
      const next = list.map((x) => Object.assign({}, x, {
        imgUrl: (x.hasImage && x.image && cache[x.image]) ? cache[x.image] : (x.imgUrl || '')
      }));
      this.setData({ [listName]: next });
    };
    if (!ids.length) { apply(); return; }
    request.getTempFileURL(ids)
      .then((map) => {
        this.setData({ _imgUrlCache: Object.assign({}, this.data._imgUrlCache, map || {}) });
        apply();
      })
      .catch(() => apply());
  },

  /* ---------------- tab 切换（segmented：必须读 e.detail.key） ---------------- */
  onTabChange(e) {
    const key = e.detail ? e.detail.key : '';
    if (!key || key === this.data.tab) return;
    this.setData({ tab: key });
  },

  /* ---------------- 申请表单 ---------------- */
  onDateChange(e) {
    const key = e.currentTarget.dataset.kind === 'end' ? 'endDate' : 'startDate';
    this.setData({ [key]: e.detail.value });
  },

  /** 多时段选择：全天与半天互斥；上午/下午/晚上 任意组合（含跳段）。统一过白名单。 */
  _setLeavePeriods(arr) {
    const norm = [];
    (arr || []).forEach((k) => {
      if (['am', 'pm', 'eve'].indexOf(k) >= 0 && norm.indexOf(k) < 0) norm.push(k);
    });
    const hint = norm.length
      ? (norm.map((k) => PERIOD_HINT[k]).join('；') + '（区间内每天都按这些时段算，未选时段视为在校）')
      : '全天请假（区间内每天所有时段都算请假）。';
    this.setData({
      leavePeriods: norm,
      periodAllOn: norm.length === 0,
      periodAmOn: norm.indexOf('am') >= 0,
      periodPmOn: norm.indexOf('pm') >= 0,
      periodEveOn: norm.indexOf('eve') >= 0,
      leavePeriodHint: hint
    });
  },

  onPeriodTap(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'all') { this._setLeavePeriods([]); return; }
    if (['am', 'pm', 'eve'].indexOf(k) < 0) return;
    const cur = this.data.leavePeriods || [];
    const next = cur.indexOf(k) >= 0 ? cur.filter((x) => x !== k) : cur.concat([k]);
    this._setLeavePeriods(next);
  },

  onReasonChange(e) {
    const idx = Number(e.detail.value);
    const opt = REASON_OPTS[idx];
    if (opt) this.setData({ reasonIndex: idx, reasonText: opt.text });
  },

  /** 选图 → 直传云存储拿 fileID（二进制不经过云函数），暂存用于提交与预览 */
  onPickImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const p = (r.tempFiles || [])[0] && (r.tempFiles || [])[0].tempFilePath;
        if (!p) return;
        wx.showLoading({ title: '上传假条…', mask: true });
        request.uploadFile('leave/' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
          .then((fileId) => {
            this.setData({ imageFileId: fileId, imageThumb: p });
            wx.hideLoading();
            util.toast('假条已上传');
          })
          .catch((err) => { wx.hideLoading(); util.toast((err && err.errMsg) || '上传失败，请重试'); });
      }
    });
  },

  onRemoveImage() { this.setData({ imageFileId: '', imageThumb: '' }); },

  /** 预览假条：fileID 先换临时 URL（带缓存）再 previewImage */
  onPreviewImage(e) {
    const fileId = e.currentTarget.dataset.fid;
    if (!fileId) return;
    const cached = this.data._imgUrlCache[fileId];
    if (cached) { wx.previewImage({ urls: [cached], current: cached }); return; }
    wx.showLoading({ title: '加载图片…', mask: true });
    request.getTempFileURL([fileId])
      .then((map) => {
        wx.hideLoading();
        const url = (map || {})[fileId] || '';
        if (!url) { util.toast('图片加载失败'); return; }
        this.setData({ _imgUrlCache: Object.assign({}, this.data._imgUrlCache, map || {}) });
        wx.previewImage({ urls: [url], current: url });
      })
      .catch(() => { wx.hideLoading(); util.toast('图片加载失败'); });
  },

  _resetForm() {
    const today = ymd(new Date());
    this.setData({
      startDate: today, endDate: today,
      leavePeriods: [], periodAllOn: true, periodAmOn: false, periodPmOn: false, periodEveOn: false,
      leavePeriodHint: '全天请假（区间内每天所有时段都算请假）。',
      reasonIndex: 3, reasonText: '其他',
      imageFileId: '', imageThumb: ''
    });
  },

  onSubmitApply() {
    if (this.data.submitting) return;
    const { startDate, endDate, leavePeriods, reasonText, imageFileId } = this.data;
    if (!startDate || !endDate) { util.toast('请选择请假日期'); return; }
    if (endDate < startDate) { util.toast('结束日期不能早于开始日期'); return; }
    const reason = REASON_OPTS[this.data.reasonIndex] ? REASON_OPTS[this.data.reasonIndex].key : 'OTHER';
    const periods = leavePeriods || [];
    this.setData({ submitting: true });
    api.leaveApply({ startDate, endDate, periods, reason, fileId: imageFileId }, { toast: false })
      .then((r) => {
        this.setData({ submitting: false });
        util.toast((r && r.existed) ? '该区间已申请过' : '已提交，等待审批');
        this._resetForm();
        this._loadMy();
      })
      .catch((err) => {
        this.setData({ submitting: false });
        util.toast((err && err.errMsg) || '提交失败，请重试');
      });
  },

  /* ---------------- 我的申请：撤回（仅 PENDING） ---------------- */
  onWithdraw(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    util.confirmStrict('撤回这条请假申请？撤回后需重新提交。', '撤回申请')
      .then((act) => {
        if (act !== 'confirm') return;
        if (this.data.busyId) return;
        this.setData({ busyId: id });
        api.leaveMyCancel({ leaveId: id }, { toast: false })
          .then(() => { this.setData({ busyId: 0 }); util.toast('已撤回'); this._loadMy(); })
          .catch((err) => { this.setData({ busyId: 0 }); util.toast((err && err.errMsg) || '撤回失败'); });
      });
  },

  /* ---------------- 审批：通过 / 驳回（仅审批人） ---------------- */
  onApprove(e) { this._doApprove(Number(e.currentTarget.dataset.id), true); },

  onReject(e) {
    const id = Number(e.currentTarget.dataset.id);
    util.confirmStrict('驳回这条请假申请？驳回后申请人可重新提交。', '驳回请假')
      .then((act) => { if (act === 'confirm') this._doApprove(id, false); });
  },

  _doApprove(id, agree) {
    if (!id || this.data.busyId) return;
    this.setData({ busyId: id });
    api.leaveApprove({ leaveId: id, agree }, { toast: false })
      .then(() => {
        this.setData({ busyId: 0 });
        util.toast(agree ? '已通过' : '已驳回');
        this._loadPending();
        // 审批后申请人状态变化在本页不可见，无需动 myList；通知会推给申请人
      })
      .catch((err) => {
        this.setData({ busyId: 0 });
        util.toast((err && err.errMsg) || '操作失败');
      });
  },

  noop() {}
});
