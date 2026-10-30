/**
 * 发布通知（独立页 · 从首页底部弹层迁出）
 * ------------------------------------------------------------
 * 2026-10-27 归位：用户要求**首页只留值日 / 课次 / 请假**，管理员卡片（发布通知入口）随之下架，
 * 原本挂在首页的发布弹层就失去了唯一入口。发布通知归到**通知页**的发布流程里，
 * 作为二级页走系统转场（⚠️ 二级页不挂 st-item 入场，见 check-tab-enter ④）。
 * 表单控件 .np-* 已于同日提升为全局（app.wxss），本页与班费页共用一套。
 */
const api = require('../../../utils/api');
const util = require('../../../utils/util');
const notice = require('../../../utils/notice');
const request = require('../../../utils/request');
const theme = require('../../../utils/theme');

/** 「按职位」预设职位：口径与云函数 member 的 POSITIONS 同源（check-positions-sync 强制比对） */
const NOTICE_POSITION_PRESETS = util.POSITIONS;

Page({
  data: {
    /* 发布通知（管理员） */
    noticeTitle: '',
    noticeContent: '',
    noticeLinkUrl: '',
    noticeLinkName: '',
    noticeLinkDetecting: false,
    noticeLinkError: '',
    /** 金山文档链接预警：小程序内无法直达，提示管理员改用腾讯文档 */
    noticeLinkHint: '',
    noticeScope: 'ALL',
    noticeScopeItems: [{ key: 'ALL', text: '全体成员' }, { key: 'PICK', text: '指定成员' }],
    noticeNeedAck: false,
    /** 发布时附带「一次性弹窗」（v1.0.5）：收件人首页弹一次、看过不再弹 */
    noticePopup: false,
    /* 配图（v0.7.14）：本地临时路径数组，提交时直传云存储后转成 fileID 传给后端 */
    noticeImages: [],
    noticeMembers: [],
    /** 勾选的成员：{ [memberId]: true } —— 用对象而不是数组，WXML 里好判断选中态 */
    noticePick: {},
    noticePickedCount: 0,
    noticePickAllA: false,
    noticePickAllB: false,
    noticeKw: '',
    noticeBusy: false,
    /** 多班级（§43 需求⑥）：可选班级列表（辅导员跨班发送） */
    noticeClasses: [],
    noticeClassIds: [],
    noticeAllClasses: false,
    /**
     * 班级高亮表 {classId: true}。
     * ⚠️ 必须在 JS 里预先算好：WXML 表达式**不支持方法调用**（`arr.indexOf(x)` 恒为假），
     *    写成 `noticeClassIds.indexOf(item.id) >= 0` 会导致选了班级却**永不落 `on`**（即「选了没高亮」）。
     */
    noticeClassPicked: {},
    /** 仅辅导员账号显示「发送班级」区（超管不再显示） */
    noticeShowClasses: false,
    /** 按职位发布：positions 逗号分隔（由预设 chip 勾选生成） */
    noticePositions: '',
    /** 预设职位（辅导员「按职位」一键选择，口径 = member.position 实际的 7 种） */
    noticePosPresets: [],
    /** 当前已选的预设职位（用于高亮） */
    noticePosPicked: {},
    /** 已选职位个数（用于提示文案） */
    noticePosPickedCount: 0,
  },

  onLoad(options) {
    theme.mount(this);
    /* 从某个班的通知页进来（2026-10-28）：把「发送班级」预选成那个班。
     * 没有这一步的话，在 2601 的通知页点「发布」会默认发到自己的主班 示例班级A ——
     * 界面上一切正常，通知却发错了班，属于最难发现的一类事故。 */
    this._presetClassId = Number(options && options.classId) || 0;
    // 每次进页面都重置表单：上一次填了一半的内容不该被下一次悄悄带上
    this.onNoticeOpen();
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅，否则 setData 到已销毁实例
  },

  /* ---------------- 发布通知（管理员） ---------------- */
  /** 每次打开都重置表单：上一次填了一半的内容不该被下一次悄悄带上 */
  onNoticeOpen() {
    // 「班级管理」（2026-09-25 需求③ + §41 重构）：发布范围按身份不同
    //   · 班委：只能发同班 → 「本班成员」(ALL) 或「指定成员」(PICK，限本班)
    //   · 辅导员：可「班级发送」或「仅发班委」或「按职位」（可跨班），不开放任意 PICK
    //   · 超管：全体成员 / 指定成员 / 仅发班委 / 按职位（可跨班）
    const app = getApp();
    if (app.track) app.track.action('notice_publish');
    const p = (app.globalData && app.globalData.profile) || null;
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const isCounselor = !!(p && p.groupTag === 'X');
    const isCommittee = !isSuper && !isCounselor && !!(p && (p.role === 'ADMIN' || p.role === 'MONITOR'));
    let items, scope;
    if (isCommittee) {
      items = [{ key: 'ALL', text: '本班成员' }, { key: 'PICK', text: '指定成员' }];
      scope = 'ALL';
    } else if (isCounselor) {
      items = [
        { key: 'ALL', text: '班级发送' },
        { key: 'COMMITTEE', text: '仅发班委' },
        { key: 'POSITION', text: '按职位' }
      ];
      scope = 'ALL';
    } else {
      items = [
        { key: 'ALL', text: '全体成员' },
        { key: 'PICK', text: '指定成员' },
        { key: 'COMMITTEE', text: '仅发班委' },
        { key: 'POSITION', text: '按职位' }
      ];
      scope = 'ALL';
    }
    // 发布范围默认「本班」（2026-09-26 需求④）：以前默认 noticeAllClasses=true →
    // 空数组被后端解释成「全部启用班级」，于是想发本班的人把通知发成了全校各班。
    // 现在默认只勾本班，要发多班必须显式点「全部班级」或逐个点班。
    const myClassId = Number((p && p.classId) || 1) || 1;
    /* 预选班级（2026-10-28）：从「某个班的通知页」进来时以那个班为准。
     * 超管平时不显示「发送班级」区（口径：超管不按班群发）；只有带着预选班进来时
     * 才显示，否则他没法把这个默认值改掉，等于被迫发到那个班。 */
    const preset = Number(this._presetClassId) || 0;
    this.setData({
      noticeTitle: '', noticeContent: '', noticeLinkUrl: '', noticeLinkName: '', noticeImages: [],
      noticeLinkDetecting: false, noticeLinkError: '', noticeLinkHint: '',
      noticeScope: scope, noticeScopeItems: items, noticeNeedAck: false, noticePopup: false,
      noticeMembers: [], noticePick: {}, noticePickedCount: 0,
      noticePickAllA: false, noticePickAllB: false, noticeKw: '', noticeBusy: false,
      noticeClasses: [], noticeClassIds: [preset || myClassId], noticeAllClasses: false, noticeClassPicked: {},
      noticeShowClasses: isCounselor || !!preset,
      noticePositions: '', noticePosPresets: NOTICE_POSITION_PRESETS,
      noticePosPicked: {}, noticePosPickedCount: 0
    });
    // 可跨班发送的人（辅导员 / 带预选班进来的超管）才需要班级列表
    if (isCounselor || (isSuper && preset)) this._loadNoticeClasses();
  },
  onNoticeClose() { wx.navigateBack(); },
  onNoticeTitle(e) { this.setData({ noticeTitle: e.detail.value }); },
  onNoticeContent(e) { this.setData({ noticeContent: e.detail.value }); },

  /** 配图（v0.7.14）：chooseMedia 压缩后只存本地路径，提交时再直传云存储（避开云函数 60s 与 VPC 下载慢） */
  onNoticePickImage() {
    const left = 3 - this.data.noticeImages.length;
    if (left <= 0) { util.toast('图片最多 3 张'); return; }
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const add = (r.tempFiles || []).map(f => f.tempFilePath).filter(Boolean).slice(0, left);
        if (add.length) this.setData({ noticeImages: this.data.noticeImages.concat(add) });
      }
    });
  },
  onNoticeRemoveImage(e) {
    const i = Number(e.currentTarget.dataset.i);
    const arr = this.data.noticeImages.slice();
    if (i >= 0 && i < arr.length) { arr.splice(i, 1); this.setData({ noticeImages: arr }); }
  },
  onNoticeLink(e) { this._onNoticeLinkInput(String(e.detail.value || '')); },

  /** 拉取可选班级列表（仅辅导员），默认勾选「全部班级」 */
  _loadNoticeClasses() {
    api.classList({ all: true }, { toast: false })
      .then((list) => {
        const classes = util.sortClasses((list || []).filter(c => c.isActive !== false));
        this.setData({
          noticeClasses: classes,
          noticeClassPicked: this._clsPickedMap(this.data.noticeAllClasses, this.data.noticeClassIds)
        });
      })
      .catch(() => this.setData({ noticeClasses: [], noticeClassPicked: {} }));
  },

  /**
   * 班级高亮表。WXML 不能调方法，所以在这里算好 {classId: true}。
   * all=true 时把所有可选班级都点亮（「全部班级」态）。
   */
  _clsPickedMap(all, ids) {
    const map = {};
    if (all) {
      (this.data.noticeClasses || []).forEach(c => { map[Number(c.id)] = true; });
    } else {
      (ids || []).forEach(id => { map[Number(id)] = true; });
    }
    return map;
  },

  /**
   * 「全部班级」= **显式全选**（把每个班 id 都铺进 noticeClassIds）。
   * ⚠️ 不能再用「清空 id 列表 + 后端兜底」的写法：后端已改成「classIds 缺省 = 本班」
   *   （需求④），空数组只代表本班，会静默漏发。
   */
  onNoticeToggleAllClasses() {
    const ids = (this.data.noticeClasses || []).map(c => Number(c.id));
    if (!ids.length) { util.toast('班级列表还没加载出来'); return; }
    this.setData({ noticeAllClasses: true, noticeClassIds: ids, noticeClassPicked: this._clsPickedMap(true, ids) });
  },
  /** 「清空」= 一个班都不选（发布时会被拦下并提示） */
  onNoticeClearClasses() {
    this.setData({ noticeAllClasses: false, noticeClassIds: [], noticeClassPicked: {} });
  },
  /** 点某个班：全选态下 = 取消该班；非全选态 = 增删；选满则标记为「全部班级」态 */
  onNoticeToggleClass(e) {
    const id = Number(e.currentTarget.dataset.id);
    const allIds = (this.data.noticeClasses || []).map(c => Number(c.id));
    const ids = (this.data.noticeAllClasses ? allIds : this.data.noticeClassIds).slice();
    const idx = ids.indexOf(id);
    if (idx >= 0) ids.splice(idx, 1); else ids.push(id);
    const isAll = allIds.length > 0 && ids.length === allIds.length;
    this.setData({
      noticeClassIds: ids,
      noticeAllClasses: isAll,
      noticeClassPicked: this._clsPickedMap(false, ids)
    });
  },
  /** 点预设职位：加入 / 移除（一键选择，7 个预设以外不接受手输） */
  onNoticePosPreset(e) {
    const p = String((e.currentTarget.dataset && e.currentTarget.dataset.pos) || '');
    if (!p) return;
    const cur = String(this.data.noticePositions || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const idx = cur.indexOf(p);
    if (idx >= 0) cur.splice(idx, 1); else cur.push(p);
    this.setData({
      noticePositions: cur.join(','),
      noticePosPicked: this._posPickedOf(cur.join(',')),
      noticePosPickedCount: cur.length
    });
  },
  /** 由职位字符串算出「已选预设」高亮表 */
  _posPickedOf(text) {
    const list = String(text || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    const picked = {};
    (this.data.noticePosPresets || []).forEach(p => { if (list.indexOf(p) >= 0) picked[p] = true; });
    return picked;
  },

  /**
   * 在线文档链接自动检测标题：输入停止 600ms 后调 ai-proxy.title 抓 <title>，
   * 回填到「显示名」（用户已手填就不覆盖）。用 token 防抖 + 乱序丢弃。
   */
  _onNoticeLinkInput(url) {
    const token = (this._linkToken = (this._linkToken || 0) + 1);
    const patch = { noticeLinkUrl: url };
    // 金山文档（kdocs.cn）小程序没有「直达指定文档」的公开路径，且其「最近」列表只显示
    // 用户自己打开过的文档 → 接收同学点开也找不到。发布时就提示管理员改用腾讯文档。
    patch.noticeLinkHint = /^https:\/\/(www\.)?kdocs\.cn\//i.test(url.trim())
      ? '金山文档链接无法在小程序内直达，接收同学需复制链接到浏览器打开。建议改用腾讯文档链接'
      : '';
    if (!url) {
      patch.noticeLinkName = '';
      patch.noticeLinkDetecting = false;
      patch.noticeLinkError = '';
      this.setData(patch);
      return;
    }
    const valid = /^https:\/\//i.test(url.trim());
    patch.noticeLinkDetecting = valid;
    this.setData(patch);
    if (!valid) return;
    clearTimeout(this._linkTimer);
    this._linkTimer = setTimeout(() => {
      api.linkTitle({ url: url.trim() }, { toast: false })
        .then((r) => {
          if (token !== this._linkToken) return;   // 已经继续输入了，丢弃旧结果
          const title = String((r && r.title) || '').trim();
          this.setData({
            noticeLinkDetecting: false,
            noticeLinkError: '',
            noticeLinkName: this.data.noticeLinkName.trim() ? this.data.noticeLinkName : (title || this.data.noticeLinkName)
          });
        })
        .catch((e) => {
          if (token !== this._linkToken) return;
          // 检测失败不打扰用户：显示名留空，提交时后端会兜底「在线文档」
          this.setData({ noticeLinkDetecting: false, noticeLinkError: String((e && e.errMsg) || '') });
        });
    }, 600);
  },
  onNoticeLinkName(e) { this.setData({ noticeLinkName: e.detail.value }); },
  onNoticeAck(e) { this.setData({ noticeNeedAck: !!e.detail.value }); },
  /** 一次性弹窗开关（v1.0.5） */
  onNoticePopupChange(e) { this.setData({ noticePopup: !!e.detail.value }); },

  /**
   * ⚠️ segmented 组件 emit 的是 `{ key }`（见 components/segmented/index.js），
   * **不是** `{ value }`。曾经写成 `String(e.detail.value)` → 拿到 `"undefined"` 字符串：
   * 于是 noticeScope 既不是 'ALL' 也不是 'PICK'，不但名单不展开、连 segmented 的高亮也不动，
   * 看起来就是「点『指定成员』没反应，再点『全体成员』也没反应」（用户 2026-09-25 反馈）。
   * 门禁：scripts/check-segmented.js
   */
  onNoticeScope(e) {
    const scope = String((e.detail && e.detail.key) || 'ALL');
    this.setData({ noticeScope: scope });
    // 名单懒加载：切到「指定成员」才去拉，避免每次打开弹层都多一次请求
    // （COMMITTEE / POSITION 不展开选人面板，接收人由服务端按班委集合 / 职位算定）
    if (scope === 'PICK' && !this.data.noticeMembers.length) this._loadNoticeMembers();
  },

  onNoticeKw(e) {
    this.setData({ noticeKw: String(e.detail.value || '') });
    this._loadNoticeMembers();
  },

  _loadNoticeMembers() {
    api.memberList({ public: 'manage', kw: this.data.noticeKw }, { toast: false })
      .then((list) => {
        /*
         * 选人名单。测试账号与辅导员都不接收通知，但**两者都不是这里在过滤**：
         *   测试账号（学号 0000000000xx）：member.list 已按 2026-10-08 铁律在服务端滤掉
         *     （「所有人员列表一律不显示测试账号」，含超管）——前端再补一层只会是死代码，
         *     且会让人误以为「前端滤了就够」，下次改后端就漏。
         *   辅导员（groupTag=X）：仍需前端过滤（这是业务口径，不是隐私口径，服务端不禁）。
         * 后端 msgPublish PICK 仍同步拦截，防直接 POST 绕过。
         * 学号仅展示末两位（需求④）：前端按学号后两位算序号，与后端 seqOf 一致
         */
        const rows = (list || [])
          .filter(x => x.status !== 'DISABLED')
          .filter(x => x.groupTag !== 'X')                                  // 辅导员不接收
          .map(x => Object.assign({}, x, { seq: util.seqOf(x.studentNo) }))
          .sort((a, b) => a.seq - b.seq); // 按 1-56 顺序排列
        // 同步 pick：丢弃已被过滤掉（不可接收）的成员勾选，避免点了发布按钮还以为发了
        const validIds = new Set(rows.map(r => r.id));
        const cleanPick = {};
        Object.keys(this.data.noticePick).forEach(k => { if (validIds.has(Number(k))) cleanPick[k] = true; });
        this.setData(Object.assign({ noticeMembers: rows }, this._syncPick(cleanPick, rows)));
      })
      .catch(() => this.setData({ noticeMembers: [] }));
  },

  onNoticePick(e) {
    const id = Number(e.currentTarget.dataset.id);
    const pick = Object.assign({}, this.data.noticePick);
    if (pick[id]) delete pick[id]; else pick[id] = true;
    this.setData(this._syncPick(pick));
  },

  /** A/B 组一键切换：点击全选，再次点击取消全选 */
  onPickGroup(e) {
    const tag = String((e.currentTarget.dataset && e.currentTarget.dataset.tag) || '');
    if (tag !== 'A' && tag !== 'B') return;
    const groupIds = (this.data.noticeMembers || [])
      .filter(m => m.groupTag === tag)
      .map(m => m.id);
    if (!groupIds.length) return;
    const pick = Object.assign({}, this.data.noticePick);
    const allSelected = groupIds.every(id => pick[id]);
    if (allSelected) {
      groupIds.forEach(id => delete pick[id]);
    } else {
      groupIds.forEach(id => pick[id] = true);
    }
    this.setData(this._syncPick(pick));
  },

  /** 清空已选 */
  onClearPick() {
    this.setData(this._syncPick({}));
  },

  /** 同步 pick 计数与 A/B 组全选状态（按钮需要视觉反馈） */
  _syncPick(pick, members) {
    members = members || this.data.noticeMembers || [];
    const idsA = members.filter(m => m.groupTag === 'A').map(m => m.id);
    const idsB = members.filter(m => m.groupTag === 'B').map(m => m.id);
    return {
      noticePick: pick,
      noticePickedCount: Object.keys(pick).length,
      noticePickAllA: idsA.length > 0 && idsA.every(id => pick[id]),
      noticePickAllB: idsB.length > 0 && idsB.every(id => pick[id])
    };
  },

  onNoticeSubmit() {
    if (this.data.noticeBusy) return;
    const title = String(this.data.noticeTitle).trim();
    const content = String(this.data.noticeContent).trim();
    if (!content) { util.toast('请填写通知内容'); return; }
    const scope = this.data.noticeScope;
    const memberIds = Object.keys(this.data.noticePick).map(Number);
    if (scope === 'PICK' && !memberIds.length) { util.toast('请至少选择一位接收成员'); return; }
    // 多班级（需求④）：**一律显式传班级 id**。后端把「空数组」解释成「发布者本班」，
    // 所以想跨班就必须把 id 铺开传过去（辅导员「全部班级」按钮已改成显式全选）。
    // 非辅导员（班委 / 超管）恒为本班 —— 前端也只放本班一个 id，后端还会再兜一次。
    const classIds = (this.data.noticeAllClasses
      ? (this.data.noticeClasses || []).map(c => Number(c.id))
      : this.data.noticeClassIds
    ).slice();
    if (this.data.noticeShowClasses && !classIds.length) {
      util.toast('请至少选择一个发送班级'); return;
    }
    const positions = scope === 'POSITION'
      ? String(this.data.noticePositions || '').split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean)
      : [];
    if (scope === 'POSITION' && !positions.length) { util.toast('请至少选择一个职位'); return; }
    this.setData({ noticeBusy: true });
    // 配图先直传云存储（本地路径 → fileID），再随发布一起提交；无图则跳过上传
    const localImgs = this.data.noticeImages.slice();
    Promise.resolve()
      .then(() => {
        if (!localImgs.length) return [];
        wx.showLoading({ title: '上传图片 0/' + localImgs.length, mask: true });
        let done = 0;
        return Promise.all(localImgs.map((p, i) =>
          request.uploadFile('notice/' + Date.now() + '-' + i + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
            .then((id) => { done++; wx.showLoading({ title: '上传图片 ' + done + '/' + localImgs.length, mask: true }); return id; })
            .catch(() => { throw new Error('图片上传失败'); })
        ));
      })
      .then((fileIds) => {
        wx.hideLoading();
        return api.msgPublish({
          title,
          content,
          images: fileIds,
          linkUrl: String(this.data.noticeLinkUrl).trim(),
          linkName: String(this.data.noticeLinkName).trim(),
          scope,
          memberIds,
          classIds,
          positions,
          needAck: this.data.noticeNeedAck,
          popup: this.data.noticePopup
        }, { loading: '发布中' });
      })
      .then((r) => {
        this.setData({ noticeBusy: false });
        wx.navigateBack();
        // v0.7.16（需求④）：发布成功立刻失效通知缓存 —— 自己与接收端下一次 onShow
        // 都会强制重拉列表 / 角标，不再等 15s TTL 自然过期
        notice.invalidate();
        const push = (r && r.push) || {};
        let msg = '通知已发布';
        if (push.skipped) msg += '（微信提醒待模板上线）';
        else if (push.sent) msg += '，已提醒 ' + push.sent + ' 人';
        util.toast(msg);
      })
      .catch(() => { wx.hideLoading(); this.setData({ noticeBusy: false }); });
  },
});
