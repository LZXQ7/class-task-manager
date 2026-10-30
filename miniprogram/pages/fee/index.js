/**
 * 班费 / 团费（独立页，从首页底部弹层迁出；2026-10-27）
 * ------------------------------------------------------------
 * 入口：班级信息页「班费」子卡 → navigateTo 进本页。
 * 设计：顶端 segmented 切换 班费 / 团费（团费仅有权限者可见）；
 *       下方为当前选中经费的 余额 + 消费明细 + 增加消费（管理人）/ 仅查看。
 * ⚠️ 本页是二级页（navigateTo），走系统转场，不用 st-item 入场（见门禁 check-tab-enter ④）。
 *     结构：nav-bar（带回退） + 原生滚动（仿 homework，无 bottom-sheet，无需 page-meta 锁滚动）+ theme 挂卸。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const request = require('../../utils/request');
const theme = require('../../utils/theme');

/** 经费数据默认形状（与后端 feeSummary 对齐；未拉到时先用它占位） */
const EMPTY_FUND = {
  total: 0, expenseTotal: 0, balance: 0,
  totalText: '0', expenseText: '0', balanceText: '0', records: []
};

Page({
  data: {
    tClass: '',
    loading: true,
    failed: false,
    unbound: false,

    isCounselor: false,
    feeCanManageClass: false,
    feeCanManageLeague: false,
    showLeagueCard: false,
    /**
     * 班费/团费切换条：仅 showLeagueCard 时才有「团费」一项。
     * ⚠️ 形状必须是 **{ key, text }** —— 全站 <segmented> 的契约（组件内部渲染
     *    `{{item.text}}`、用 `value === item.key` 判高亮、wx:key="key"）。
     *    2026-10-28 真机：这里写成了 { value, label } ⇒ item.text 为 undefined ⇒
     *    控件渲染成**一个没有字的空胶囊**（用户报「左上角有没用的形状」），
     *    且 value === item.key 恒不成立 ⇒ 点了不高亮。别再改回去。
     */
    feeTabs: [{ key: 'class', text: '班费' }],

    feeType: 'class',          // 当前选中的经费：'class' | 'league'
    feeCanManage: false,       // 当前选中经费是否可管理
    navTitle: '班费',          // 导航标题随选中经费变化
    feeActive: EMPTY_FUND,     // 当前展示的经费（余额/明细）
    feeClass: EMPTY_FUND,      // 班费（恒拉取，切换不重拉）
    feeLeague: EMPTY_FUND,     // 团费（恒拉取，切换不重拉）

    /* 班费/团费跨班查看：**仅辅导员**的可查看班级列表（=staffClassIds）；其余身份恒空 */
    feeClassList: [],
    feeViewClassId: 0,

    /* 列表视图 / 表单视图（仅管理人可进表单） */
    feeView: 'list',
    feeAmount: '',
    feeNote: '',
    feeImages: [],
    feeBusy: false
  },

  onLoad(options) {
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    const t = (options && options.type) || 'class';
    /* 「班级信息」页切班后带过来的 classId（2026-10-28）：作为「查看班级」的初始选中。
     * 不传（普通成员、或看的就是本班）时保持 0 ⇒ _loadFee 发 {} ⇒ 后端 resolveClassId 回落本班。
     * ⚠️ 这里只设初始值，切换器仍在辅导员手里（fee 页自己的 feeClassList）；
     *    _loadFeeClassList 的「oldSel 在列表内就保留」逻辑会尊重这个初值，不会弹回主班。 */
    const cid = Number(options && options.classId) || 0;
    this.setData({ feeType: t === 'league' ? 'league' : 'class', feeViewClassId: cid });
    // 进入即记一次曝光（与首页 fee_open 同源）
    if (getApp().track) getApp().track.action('fee_open', this.data.feeType);
  },

  onShow() {
    this._applyIdentity();
    this._loadFee(true);
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅，否则 setData 到已销毁实例
  },

  /** 身份与权限（仅取班费相关字段）：判定统一走 util.feeRights（与首页/我的页同源）。
   *  同时决定 团费 切换项是否出现、跨班查看列表是否拉取。 */
  _applyIdentity() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || null;
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const isCounselor = !!(p && p.groupTag === 'X');
    const feeR = util.feeRights({ isSuper, position: p ? p.position : '' });
    const showLeagueCard = feeR.showLeagueCard;
    // ⚠️ 字段名必须用组件的契约 { key, text }（components/segmented 的 properties 与 wxml
    //    都只认这两个名字）。写成 { value, label } 的后果：文字取不到 → 渲染成一个**没有字的
    //    空胶囊**（用户报「左上角有没用的形状」，2026-10-27），且 value === item.key 恒不成立
    //    ⇒ 点了也不高亮。别改回去。
    const tabs = [{ key: 'class', text: '班费' }];
    if (showLeagueCard) tabs.push({ key: 'league', text: '团费' });
    // 若（理论上不会）权限丢掉导致当前选中的是团费，回落班费
    const feeType = (this.data.feeType === 'league' && !showLeagueCard) ? 'class' : this.data.feeType;
    this.setData({
      isCounselor,
      feeCanManageClass: feeR.canManageClass,
      feeCanManageLeague: feeR.canManageLeague,
      showLeagueCard,
      feeTabs: tabs,
      feeType,
      unbound: !p,
      loading: !!p   // 未绑定时直接进 unbound 态，不卡加载骨架
    });
    // 班费/团费跨班查看（v0.7.43）：**仅辅导员**可切班看其负责班级的钱。
    if (isCounselor && !this.data.feeClassList.length) this._loadFeeClassList();
    this._syncActive();
  },

  /** 当前选中经费 → 同步 feeActive / feeCanManage / 导航标题 */
  _syncActive() {
    const type = this.data.feeType;
    const canManage = !!(type === 'class' ? this.data.feeCanManageClass : this.data.feeCanManageLeague);
    const fund = type === 'class' ? this.data.feeClass : this.data.feeLeague;
    this.setData({
      feeActive: fund,
      feeCanManage: canManage,
      navTitle: type === 'class' ? '班费' : '团费'
    });
  },

  /* ---------------- 班费 / 团费（从首页迁出，逻辑不变） ---------------- */
  _fmtMoney(n) {
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : '';
    const s = Math.abs(v).toFixed(2).replace(/\.?0+$/, '');
    return sign + s;
  },
  _fmtFund(f) {
    f = f || {};
    return {
      total: Number(f.total) || 0,
      expenseTotal: Number(f.expenseTotal) || 0,
      balance: Number(f.balance) || 0,
      totalText: this._fmtMoney(f.total),
      expenseText: this._fmtMoney(f.expenseTotal),
      balanceText: this._fmtMoney(f.balance),
      records: (f.records || []).map(rec => ({
        id: rec.id,
        amount: Number(rec.amount) || 0,
        amountText: this._fmtMoney(rec.amount),
        note: rec.note || '',
        images: rec.images || [],
        createdAt: rec.createdAt || '',
        operatorName: rec.operatorName || ''
      }))
    };
  },
  /**
   * 班费 / 团费：拉取余额与明细（不阻塞首屏）。
   * 班费与团费**一次性**都拉回来，切换只换展示对象、不重拉（省一次请求）。
   * 写操作传 force 跳过 2s 去重窗口（否则「刚提交完」会被去重吃掉，看起来像没保存）。
   * @param {boolean} [force] 强制刷新
   */
  _loadFee(force) {
    if (this.data.unbound) return;
    const now = Date.now();
    if (!force) {
      if (this._feeLoading) return;
      if (this._feeLoadedAt && now - this._feeLoadedAt < 2000) return;
    }
    this._feeLoading = true;
    this._feeLoadedAt = now;
    // 跨班查看：把当前选中的查看班级带给后端（0/空=本人主班，resolveClassId 回退）
    const viewCid = Number(this.data.feeViewClassId) || 0;
    const arg = viewCid ? { classId: viewCid } : {};
    api.feeSummary(arg, { toast: false })
      .then((r) => {
        const feeClass = this._fmtFund(r && r.class);
        const feeLeague = this._fmtFund(r && r.league);
        const type = this.data.feeType;
        const feeActive = type === 'class' ? feeClass : feeLeague;
        const canManage = !!(type === 'class' ? this.data.feeCanManageClass : this.data.feeCanManageLeague);
        this.setData({
          loading: false, failed: false,
          // ⚠️ 这里必须是局部量 canManage。写成 feeCanManage 会 ReferenceError（data 上没有
          //    这个键时 setData 不报错，但取值时抛），而下面的 catch 会把成功响应也画成失败页。
          //    2026-10-28 实踩：班费页恒显「数据没加载出来」，云函数本身 errCode 0 完全正常。
          feeClass, feeLeague, feeActive, canManage
        });
      })
      .catch((e) => {
        // 不吞：真实原因（超时 / 业务码 / JS 异常）一律落 console，下次一眼可见
        console.error('[fee] getSummary failed', e);
        this.setData({ failed: true, loading: false });
      })
      .then(() => { this._feeLoading = false; });
  },
  /**
   * 班费/团费跨班查看（v0.7.43）：拉「可查看班级」列表 —— **仅辅导员**。
   * 默认选中：若当前 feeViewClassId 不在列表内（含初始 0），优先本人主班，否则第一班并强制重拉一次费用。
   */
  _loadFeeClassList() {
    api.classList({ all: true }, { toast: false })
      .then((list) => {
        const arr = Array.isArray(list) ? list : [];
        const ids = arr.map(c => Number(c.id));
        const oldSel = Number(this.data.feeViewClassId) || 0;
        let sel = oldSel;
        if (!ids.includes(sel)) {
          const own = Number((getApp() && getApp().globalData && getApp().globalData.profile || {}).classId) || 0;
          sel = ids.includes(own) ? own : (arr.length ? ids[0] : 0);
        }
        this.setData({ feeClassList: arr, feeViewClassId: sel });
        if (sel && sel !== oldSel) this._loadFee(true);
      })
      .catch(() => {});
  },
  /** 班费/团费切班：选中某个可查看班级后立即重拉该班的钱 */
  onFeeClassPick(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id || id === Number(this.data.feeViewClassId)) return;
    this.setData({ feeViewClassId: id });
    this._loadFee(true);
  },
  /** 顶端 segmented 切换 班费/团费：仅换展示对象，不重拉（数据已在 _loadFee 一次性拿回） */
  onTypeSwitch(e) {
    // ⚠️ segmented 只 emit key：取选中值必须读 e.detail.key（读成 value 会拿到字符串 "undefined"，
    //    表现就是「点了没反应」，见 check-segmented 的历史事故）
    const type = e.detail.key;
    if (type !== 'class' && type !== 'league') return;
    if (type === this.data.feeType) return;
    this.setData({ feeType: type, feeView: 'list', feeAmount: '', feeNote: '', feeImages: [] });
    this._syncActive();
    if (getApp().track) getApp().track.action('fee_open', type);
  },
  /** 列表视图 → 表单视图（点「增加消费」）；仅管理人可进 */
  onFeeAddOpen() {
    if (!this.data.feeCanManage) return;
    this.setData({ feeView: 'form' });
  },
  /** 给「已有消费记录」补图（仅管理人；当前图数 < 9 才能补）。选图即上传追加，不进表单。 */
  onFeeAppendTap(e) {
    if (!this.data.feeCanManage) return;
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const rec = (this.data.feeActive && this.data.feeActive.records || []).find(r => Number(r.id) === id);
    if (!rec) return;
    const cur = (rec.images && rec.images.length) || 0;
    const left = 9 - cur;
    if (left <= 0) { util.toast('图片最多 9 张'); return; }
    wx.chooseMedia({
      count: left, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (r) => {
        const local = (r.tempFiles || []).map(f => f.tempFilePath).filter(Boolean).slice(0, left);
        if (!local.length) return;
        this._uploadAndAppend(id, local);
      }
    });
  },
  _uploadAndAppend(id, local) {
    wx.showLoading({ title: '上传图片 0/' + local.length, mask: true });
    let done = 0;
    Promise.all(local.map((p, i) =>
      request.uploadFile('fee/' + Date.now() + '-' + i + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
        .then((fid) => { done++; wx.showLoading({ title: '上传图片 ' + done + '/' + local.length, mask: true }); return fid; })
        .catch(() => { throw new Error('图片上传失败'); })
    ))
      .then((fileIds) => {
        wx.hideLoading();
        return api.feeAppendImages({ type: this.data.feeType, id, images: fileIds });
      })
      .then(() => {
        wx.hideLoading();
        util.toast('已补充图片');
        this._loadFee(true);
      })
      .catch(() => { wx.hideLoading(); });
  },
  /** 表单视图 → 列表视图（点「返回」）；已填的内容清空，避免返回后再填出现残留 */
  onFeeFormBack() {
    this.setData({ feeView: 'list', feeAmount: '', feeNote: '', feeImages: [] });
  },
  onFeeAmountInput(e) { this.setData({ feeAmount: String(e.detail.value || '') }); },
  onFeeNoteInput(e) { this.setData({ feeNote: String(e.detail.value || '') }); },
  onFeePickImage() {
    const left = 9 - this.data.feeImages.length;
    if (left <= 0) { util.toast('图片最多 9 张'); return; }
    wx.chooseMedia({
      count: left, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'],
      success: (r) => {
        const add = (r.tempFiles || []).map(f => f.tempFilePath).filter(Boolean).slice(0, left);
        if (add.length) this.setData({ feeImages: this.data.feeImages.concat(add) });
      }
    });
  },
  onFeeRemoveImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    const arr = this.data.feeImages.slice();
    if (i >= 0 && i < arr.length) { arr.splice(i, 1); this.setData({ feeImages: arr }); }
  },
  /**
   * 预览消费凭证图（v0.7.43）：取该条记录的全部图片一起进原生预览器，点任意一张即直接打开。
   * 以被点击图片自身（data-src）为准在整条记录图片数组里 indexOf 反查下标，
   * 规避嵌套 wx:for 内外层默认都叫 index 的坑。
   */
  onFeePreviewImage(e) {
    const ds = e.currentTarget.dataset;
    const recId = Number(ds.id);
    const tapped = ds.src || '';
    const rec = ((this.data.feeActive && this.data.feeActive.records) || [])
      .find(r => Number(r.id) === recId);
    const imgs = (rec && rec.images && rec.images.length) ? rec.images.slice()
      : (tapped ? [tapped] : []);
    if (!imgs.length) return;
    let idx = tapped ? imgs.indexOf(tapped) : -1;
    if (idx < 0) idx = Math.max(0, Number(ds.idx) || 0);
    if (idx >= imgs.length) idx = imgs.length - 1;
    const needCloud = imgs.some(u => typeof u === 'string' && u.indexOf('cloud://') === 0);
    if (!needCloud) {
      wx.previewImage({ urls: imgs, current: imgs[idx] });
      return;
    }
    request.getTempFileURL(imgs).then((map) => {
      const resolved = imgs.map(u => (map && map[u]) || '');
      const urls = resolved.filter(Boolean);
      if (!urls.length) { util.toast('图片预览失败'); return; }
      let i = urls.indexOf(resolved[idx]);
      if (i < 0) i = Math.min(idx, urls.length - 1);
      wx.previewImage({ urls, current: urls[i] });
    }).catch(() => util.toast('图片预览失败'));
  },
  onFeeSubmit() {
    if (this.data.feeBusy) return;
    const amount = Number(this.data.feeAmount);
    if (!Number.isFinite(amount) || amount <= 0) { util.toast('请填写大于 0 的金额'); return; }
    const localImgs = this.data.feeImages.slice();
    this.setData({ feeBusy: true });
    Promise.resolve()
      .then(() => {
        if (!localImgs.length) return [];
        wx.showLoading({ title: '上传图片 0/' + localImgs.length, mask: true });
        let done = 0;
        return Promise.all(localImgs.map((p, i) =>
          request.uploadFile('fee/' + Date.now() + '-' + i + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
            .then((id) => { done++; wx.showLoading({ title: '上传图片 ' + done + '/' + localImgs.length, mask: true }); return id; })
            .catch(() => { throw new Error('图片上传失败'); })
        ));
      })
      .then((fileIds) => {
        wx.hideLoading();
        return api.feeAddExpense({ type: this.data.feeType, amount, note: this.data.feeNote.trim(), images: fileIds });
      })
      .then(() => {
        wx.hideLoading();
        util.toast('已登记消费');
        // 提交成功回到列表视图；force 立刻拉新值，不能被 2s 去重吃掉
        this.setData({ feeBusy: false, feeView: 'list', feeAmount: '', feeNote: '', feeImages: [] });
        this._loadFee(true);
      })
      .catch(() => { wx.hideLoading(); this.setData({ feeBusy: false }); });
  },
  onFeeDeleteRecord(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    wx.showModal({
      title: '删除记录',
      content: '删除后余额会回退，且图片会一并删除，确定吗？',
      confirmText: '删除', confirmColor: '#F53F3F',
      success: (r) => {
        if (!r.confirm) return;
        api.feeDeleteRecord({ type: this.data.feeType, id })
          .then(() => { util.toast('已删除'); this._loadFee(true); })
          .catch(() => {});
      }
    });
  },

  onReload() { this._loadFee(true); },
  goBind() { wx.reLaunch({ url: '/pages/bind/index' }); },

  noop() {}
});
