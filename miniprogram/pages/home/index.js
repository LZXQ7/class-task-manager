/**
 * P2 · 首页 · 今日（Tab 1）
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const tt = require('../../data/timetable');
const subscribe = require('../../utils/subscribe');
const pageAnim = require('../../utils/page-anim');
const notice = require('../../utils/notice');
const request = require('../../utils/request');
const impersonate = require('../../utils/impersonate');
const theme = require('../../utils/theme');

/**
 * Hero 卡 = 纯提醒：只告诉你「今天你值日」以及在哪一节、和谁一起，
 * 不再提供打卡 / 确认完成（本工具只做值日提醒，不做打卡验收）。
 */
const HERO = {
  PENDING: { cls: 'plain', title: '今天你值日', titleColor: '#1D2129', subColor: '#4E5969', status: '待值日' },
  ONGOING: { cls: 'blue', title: '今天你值日', titleColor: '#FFFFFF', subColor: 'rgba(255,255,255,0.8)', status: '进行中' },
  DONE: { cls: 'plain', title: '今天你值日', titleColor: '#1D2129', subColor: '#4E5969', status: '已完成' },
  LEAVE: { cls: 'leave', title: '今天你请假了', titleColor: '#D46B08', subColor: '#D46B08', status: '已请假' },
  SWAPPED_OUT: { cls: 'plain', title: '今天已换出', titleColor: '#1D2129', subColor: '#4E5969', status: '已换出' },
  EXPIRED: { cls: 'plain', title: '今天你值日', titleColor: '#1D2129', subColor: '#4E5969', status: '已结束' }
};

/** 数据新鲜度窗口：切换回首页时，只要在这个窗口内拉过数据，就直接复用、不再发起请求 */
const STALE_MS = 20000;

/** 「按职位」预设职位：辅导员发通知时一键选择。
 *  取值统一从 `utils/util.js` 的 POSITIONS 取（与云函数 member 的 POSITIONS 同源，
 *  由门禁 scripts/check-positions-sync.js 强制比对），这里不再各写一份。 */
const NOTICE_POSITION_PRESETS = util.POSITIONS;

Page({
  data: {
    statusBarHeight: 20,
    loading: true,
    failed: false,
    unbound: false,

    dateText: '',
    weekText: '',
    myDuty: null,
    sessions: [],
    /** 明日课次（后端按「实际上课日期」算，放假 / 调课 / 跨周都已考虑） */
    tomorrowSessions: [],
    tomorrowText: '',
    pendingSwapCount: 0,
    unreadNotice: null,
    isAdmin: false,
    member: null,
    /* 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条 */
    impersonateBanner: '',
    /* 更新公告（v0.7.25）：超管发送 → 主页弹一次、看过不再弹 */
    anncSheetShow: false,
    anncNotice: {},
    /* 通知一次性弹窗（v1.0.5）：发布通知时可选 → 收件人主页弹一次、看过不再弹 */
    npopSheetShow: false,
    npopNotice: {},
    /** 管理员卡标题（按身份显示职位头衔；超管金 / 班委蓝 / 辅导员青） */
    adminTag: '',
    adminTier: '',
    /** 是否可查看班级（超管 / 辅导员，多班级 §43） */
    canViewClass: false,
    /** 教职工（辅导员）视角：隐藏学生功能块（v0.7.16 需求⑥⑨） */
    isCounselor: false,
    /** 「关注的学生」卡可见（v0.7.17 需求⑥）：与成员详情的「固定到主页」按钮同口径 */
    showPins: false,
    /** 固定到主页的学生（≤ pinLimit 条）：{ memberId, name, classId, className, latestNote, noteCount } */
    pins: [],
    pinLimit: 8,
    currentWeek: 1,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,

    hero: null,
    heroSub: '',
    periodText: '',

    sheetShow: false,
    sheetDutyId: 0,

    playing: false,
    remindOn: false,
    /** 微信提醒额度耗尽（后端 remind_block，cron 发送 43101 时置 1）→ 首页弹「重新开启」 */
    remindBlock: false,
    /** 测试提醒发送中（防连点） */
    remindBusy: false,
    /** 查看通知入口角标 = 待确认数（同步读缓存，不阻塞首屏） */
    noticeUnacked: 0,

    /* 发布通知（管理员） */
    noticeShow: false,
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

    /* 首页请假卡（1.0.5 追加，需求①②）：班委/超管看本班请假人数；辅导员看各班总数 */
    showLeaveHome: false,
    leaveHomeMode: 'class',
    leaveHomeClassName: '',
    leaveHomeDate: '',
    leaveHomeLeave: 0,
    leaveHomeLeaveA: 0,
    leaveHomeLeaveB: 0,
    leaveHomeRaw: [],
    leaveHomeClasses: [],
    /**
     * 「当前（实时）请假人数」与「今日共请假人数」**两个口径并存**（2026-10-09 需求①）。
     *   · leaveHomeLeave/A/B = **实时**（此刻真在请假时段内）—— 卡片大数字用它；
     *   · leaveHomeTotal     = **日期**（今天有生效请假的全列，含已过时段）
     *                          —— 与弹层名单行数恒等，供核对。
     * ⚠️ 老后端不返 `now` ⇒ leaveHomeHasNow=false，卡片显示「—」而**不回落**成
     *    日期口径（回落正是这个 bug 的成因）。
     */
    leaveHomeHasNow: false,
    leaveHomeTotal: 0,
    /** 此刻真在请假的人（实时口径，来自 leaveBoard.now 换算后的行）—— 课堂情况弹层用 */
    leaveHomeNowList: [],
    /** 班级全称（课堂情况模板第一行；与 leaveHomeClassName 同源） */
    classFullName: '',

    /* ---- 课堂情况弹窗（2026-10-09 需求②）：班长/副班长点今日课次 ---- */
    /** 班长/副班长/超管才true（复用 canLeave 口径，见 _applyIdentity 注释） */
    canCourseInfo: false,
    courseInfoShow: false,
    courseInfoLoading: false,
    /** 组好的整段文本（一键复制的内容；**唯一真源**，弹层显示与复制都用它） */
    courseInfoText: '',
    courseInfoTitle: '',
    courseInfoTeacher: '',
    courseInfoRoom: '',
    courseInfoExpected: 0,
    courseInfoActual: 0,
    courseInfoAbsentees: [],
    /** 本班在册名单（点开时才拉，缓存复用；应到人数由它算） */
    classRoster: [],
    /** 名单查看弹层（班委可撤销；辅导员只读） */
    leaveHomeShow: false,
    leaveHomeViewTitle: '',
    leaveHomeListA: [],
    leaveHomeListB: [],
    leaveHomeCanCancel: false,
    leaveHomeBusy: false,
    /** fileID → 临时链接（1.0.6 需求③：行尾缩略图用；与 roster 页同一套批量换链，不逐个请求） */
    leaveImgUrls: {},
    /** 弹层内「加载中…」（v0.7.32 问题②：点开即弹，名单后台再刷新） */
    leaveHomeLoading: false,

    /* ---- 班费 / 团费（2026-10-14） ---- */
    /** 班费管理权（点开 + 消费）：班长兼团支书 / 副班长 / 生活委员 / 超管；普通成员 view-only */
    feeCanManageClass: false,
    /** 团费管理权：班长兼团支书 / 超管 */
    feeCanManageLeague: false,
    /** 团费卡对所有人可见（view-only 或管理），恒为 true；旧「仅管理人可见」口径已废弃 */
    showLeagueCard: true,
    /* 🔴 总额设置权（班费 = 超管 / 生活委员；团费 = 超管 / 班长兼团支书）已迁到「我的」页
        —— 这里不再判定也不再展示设置框，避免出现两处入口改同一个值。 */
    /** 班费汇总（{ total, expenseTotal, balance, totalText, expenseText, balanceText, records:[] }） */
    feeClass: { total: 0, expenseTotal: 0, balance: 0, totalText: '0', expenseText: '0', balanceText: '0', records: [] },
    feeLeague: { total: 0, expenseTotal: 0, balance: 0, totalText: '0', expenseText: '0', balanceText: '0', records: [] },
    /** 弹层状态 */
    feeShow: false,
    feeActive: { total: 0, expenseTotal: 0, balance: 0, totalText: '0', expenseText: '0', balanceText: '0', records: [] },
    feeType: 'class',
    feeActiveName: '班费',
    feeCanManage: false,
    /** 弹层视图：'list' = 余额 + 消费明细 + 增加消费按钮；'form' = 金额 / 备注 / 凭证图片 / 提交。
        2026-10-14 需求：表单不再常驻，点「增加消费」才进表单，避免长表单把明细挤到屏幕外。 */
    feeView: 'list',
    /** 消费表单：金额 / 备注 / 图片（云存储 fileID 数组，最多 9 张） */
    feeAmount: '',
    feeNote: '',
    feeImages: [],
    feeBusy: false
  },

  onLoad() {
    const app = getApp();
    // 深色模式（C-4）：把 t-light / t-dark 挂到本页根节点（wxml 里的 {{tClass}}），
    // 并订阅切换 —— 之后用户在任何页切主题，本页都会跟着重挂。
    theme.mount(this);
    this.setData({ statusBarHeight: app.globalData.statusBarHeight || 20 });
    this._renderDate();
  },

  /**
   * 请假时段翻面定时器的清理（2026-10-09 需求①）。
   * 🔴 必须有：`_scheduleLeaveWindowTimer` 排的是**最长可跨小时的** setTimeout，
   *    不清就会在页面切走/销毁后仍触发 `_loadLeaveHome` —— 对已销毁实例 setData，
   *    报错 + 泄漏闭包（与 bottom-sheet `_resizeEndTimer` 同一个坑）。
   *    onShow 里的 `_loadLeaveHome` 会重新排一条链，所以清掉不影响功能。
   */
  onHide() {
    if (this._leaveWinTimer) { clearTimeout(this._leaveWinTimer); this._leaveWinTimer = null; }
  },

  // ⚠️⚠️ **本页原有 onUnload 在下方（带 theme.unmount）** —— 别在这里再写一个！
  //   小程序 Page 定义里**同名生命周期后者覆盖前者** ⇒ 新写的会把原有的顶掉，
  //   结果是theme.unmount 丢失（深色模式订阅泄漏，门禁 check-dark-mode 会抓）。
  //   要加清理就加到**原来那个** onUnload 里去。

  onShow() {
    const app = getApp();
    this.setData({ remindOn: !!wx.getStorageSync('remindOn') });
    app.setTabBar(0);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    const p = this._applyIdentity();
    /*
     * §41 需求③：切换测试账号切回原身份后，首页按钮不见。
     * 根因是 STALE_MS 缓存窗口内 load() 直接 return，沿用旧 isAdmin/adminTag 数据。
     * 修复：onShow 身份指纹变化时强制 load(true) 重拉一次。
     * 指纹含 classId —— 跨班查看/切换后也要重拉。
     */
    const fp = this._identityFpOf(p);
    const identityChanged = (this._identityFp !== undefined && this._identityFp !== fp);
    this._identityFp = fp;
    /*
     * §43 需求①：进入小程序时「查看班级」不显示，切到别的 Tab 再回来才出现。
     * 根因：首次进入时 onShow 早于登录完成，profile 还是 null → canViewClass=false，
     * 之后再没人重算。修复：未完成登录时等 app.ready()，就绪后重套一次身份。
     */
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        const p2 = this._applyIdentity();
        const fp2 = this._identityFpOf(p2);
        if (fp2 !== this._identityFp) { this._identityFp = fp2; this.load(true); }
      });
    }
    // 角标：从 utils/notice 缓存同步读取（命中即有，无需网络）。空缓存保持 0。
    // 需求⑤：角标 = 我还没看过的新通知（排除自己发的），游标按成员隔离。
    const cached = notice.read(0);
    const meId = Number((p && p.id) || 0);
    this.setData({ noticeUnacked: cached ? notice.unackedCount(cached, meId) : 0 });
    // v0.7.16（需求④）：角标改为 **SWR** —— 旧值先亮，每次 onShow 都后台重拉一次。
    // 旧实现只读缓存（最长 15s 内不更新），别人刚发的通知红点不动。
    this._refreshNoticeBadge(meId);
    // 换班确认/拒绝/撤销后，首页 badge 与底部红点必须立即失效：
    // 「我的」页操作成功后会置位 swapDirty，这里强制跳过 STALE_MS 缓存重载一次。
    const swapDirty = !!(app.globalData && app.globalData.swapDirty);
    if (app.globalData) app.globalData.swapDirty = false;
    // 1.0.4.4 #28：换班同意后值日表已变，dutyDirty 置位时首页 Hero 也强制重拉。
    // 注意：dutyDirty 只由「值日页」onShow 清空（它是权威消费者），首页/我的只消费不清，
    // 保证无论先逛哪个 Tab，最终进值日页一定刷新得到最新排班。
    const dutyDirty = !!(app.globalData && app.globalData.dutyDirty);
    // v0.7.32 问题②：在「成员与分组」里改了职位（含把自己设成班委）后置位 rosterDirty，
    // 这里强制跳过 STALE_MS 重拉一次，班委专属卡片（admin-card）立即出现。
    const rosterDirty = !!(app.globalData && app.globalData.rosterDirty);
    if (app.globalData) app.globalData.rosterDirty = false;
    this.load(identityChanged || swapDirty || dutyDirty || rosterDirty);
    /*
     * 班费 / 团费：与通知角标同一套口径 —— **每次 onShow 独立重拉一次**。
     * ⚠️ 不能只挂在 load() 的 .then 里：load 有 STALE_MS（20s）缓存早退 ——
     *    切回首页且数据"新鲜"时它连请求都不发，那条路径上班费永远不刷新。
     *    于是「在『我的』改了班费总额 → 回到首页看到旧值，要等好一会儿才变」
     *    （2026-10-15 实踩）。班费是低频小额查询，每次进首页拉一次可以接受。
     * feeDirty：我的页刚改过总额时置位（同 swapDirty 的套路），这里跳过去重窗口强制拉。
     */
    const feeDirty = !!(app.globalData && app.globalData.feeDirty);
    if (app.globalData) app.globalData.feeDirty = false;
    this._loadFee(feeDirty);
    // 今日课次灰化计时器：即便 load 命中 STALE_MS 缓存直接 return（数据已在），也要续排到点翻面
    this._scheduleDoneTimer();
    // 请假卡：onShow 已重拉（_applyIdentity → _loadLeaveHome）；这里再补排一条时段翻面定时器
    // —— onHide 清过它，即便本次重拉失败，也能在下一个刷新点自愈（19:00–20:40 这类时段）。
    this._scheduleLeaveWindowTimer();
    /*
     * v0.7.32 问题②（别人的手机）：切 tab 也做一次节流身份重校（app 内 20s 一次）。
     * 过去只在 App.onShow（回前台）重校 ⇒ 对方不杀进程、不回前台就永远看不到新权限。
     * 重校发现身份变了就重套身份 + 强刷首页（back-end 的 isAdmin 也随之刷新）。
     */
    if (app && typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        const p2 = this._applyIdentity();
        this._identityFp = this._identityFpOf(p2);
        this.load(true);
      }).catch(() => {});
    }
  },

  /** 后台静默重拉通知列表 → 更新缓存与角标（失败静默，不打扰用户） */
  _refreshNoticeBadge(meId) {
    api.msgList({}, { toast: false })
      .then((list) => {
        notice.write(list);
        this.setData({ noticeUnacked: notice.unackedCount(list, meId) });
      })
      .catch(() => {});
  },

  /** 身份指纹：任一维度变化都视为换了身份，需要重拉数据 */
  _identityFpOf(p) {
    return p
      ? (p.id + '/' + (p.isSuper ? 1 : 0) + '/' + (p.role || '') + '/' + (p.position || '') + '/' + (p.classId || 1))
      : 'none';
  },

  /**
   * 按当前登录身份刷新「管理员卡标题」与「查看班级」入口。
   * 返回 profile，供调用方算身份指纹。
   */
  _applyIdentity() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || null;
    const rt = util.roleTag({
      isSuper: !!(app && app.isSuper && app.isSuper()),
      groupTag: p ? p.groupTag : '',
      role: p ? p.role : '',
      position: p ? p.position : ''
    });
    // 查看班级入口：超管或辅导员可见（多班级 §43 需求⑤）
    const canViewClass = !!(app && app.isSuper && app.isSuper()) || !!(p && p.groupTag === 'X');
    // v0.7.16：教职工（辅导员）视角 —— 首页隐藏学生功能（值日 Hero / 今日明日课次 / 提醒胶囊）
    const isCounselor = !!(p && p.groupTag === 'X');
    // 「关注的学生」卡片（v0.7.18 需求①）：**仅辅导员**可见。
    // 上一版跟着 canViewClass（超管 ∨ 辅导员），超管也会看到这张卡 —— 已按用户口径收紧，
    // 与后端 pinList / pinToggle 的「仅辅导员」一致。
    const showPins = isCounselor;
    // 首页请假卡（1.0.5 追加）：班委/超管看本班请假人数、辅导员看各班总数 —— 一律可见，
    // 普通同学不可见（决策④）。辅导员只读（leaveHomeMode='counselor'），班委/超管可撤销。
    const canLeave = !!(app && app.canLeave && app.canLeave());
    const showLeaveHome = isCounselor || canLeave;
    // 「课堂情况」弹窗的可见性（2026-10-09 需求②）：**班长/副班长/超管**。
    // ⚠️ 复用 `canLeave` 而不是新造一套 —— canLeave 的口径就是
    //    「班委（ADMIN/MONITOR）+ 超管」，正是需求里说的「班长、副班长」；
    //    另造一套必然与请假权限漂移（能请假的看得到、点不动，或反过来）。
    // ⚠️ 辅导员（X 组）**不**给：他们的视角是隐藏学生功能的（见上面 isCounselor 注释），
    //    首页连今日课次都看不到，自然也不该有这个弹窗。
    const canCourseInfo = canLeave && !isCounselor;
    // 班费 / 团费权限（2026-10-14）：判定统一走 util.feeRights —— 与后端 fee 云函数同口径，
    // 且与我的页共用同一份实现（早先在本页直接比对职位字面量，两个页面各写一份判定式，
    // 「这里能设置、我的页却不显示」之类的漂移迟早出现）。
    const feeR = util.feeRights({
      isSuper: !!(app && app.isSuper && app.isSuper()),
      position: p ? p.position : ''
    });
    const feeCanManageClass = feeR.canManageClass;
    const feeCanManageLeague = feeR.canManageLeague;
    const showLeagueCard = feeR.showLeagueCard;   // 团费卡仅能管团费者可见
    const patch = {
      canViewClass, isCounselor, showPins,
      canLeave,
      showLeaveHome,
      canCourseInfo,
      leaveHomeMode: isCounselor ? 'counselor' : 'class',
      feeCanManageClass, feeCanManageLeague,
      showLeagueCard
    };
    if (rt) { patch.adminTag = rt.text; patch.adminTier = rt.tier; }
    this.setData(patch);
    if (showPins) this._loadPins();
    if (showLeaveHome) this._loadLeaveHome();
    // 模拟态护栏（v1.0.5）：每次套用身份都同步一次顶部横幅，登录晚到时也能补上
    impersonate.sync(this);
    return p;
  },

  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5） */
  onRecoverSelf() {
    impersonate.recover();
  },

  /**
   * 关注的学生列表（v0.7.17 需求⑥）。
   * 每次进首页都重拉（≤8 行的小查询），保证在成员详情里刚钉的人**切回来就能看到** ——
   * 和「我的」页计数用同一套 SWR 口径：旧值先显示、后台静默刷新。
   */
  _loadPins() {
    api.pinList({}, { toast: false })
      .then((r) => this.setData({
        pins: (r && r.list) || [],
        pinLimit: Number((r && r.limit) || 8)
      }))
      .catch(() => {});
  },

  /* ---------------- 首页请假卡（1.0.5 追加，需求①②） ----------------
   * 班委/超管：**走已部署的 leaveBoard**（与「成员与分组」同源，返回 { date, list, stat }）——
   *            刻意不依赖追加批次新加的 leaveSummary 路由，避免「后端没更新到就整卡看不了」。
   * 辅导员    ：走 leaveSummary（其绑定范围内每班今日请假数，mode:'counselor'）。
   * 点击卡 → 班委/超管打开可撤销的名单弹层；辅导员点某班 → 拉该班名单（只读）。 */
  _loadLeaveHome() {
    if (this.data.leaveHomeMode === 'counselor') {
      api.leaveSummary({}, { toast: false })
        .then((r) => { if (r && r.classes) this.setData({ leaveHomeClasses: util.sortClasses(r.classes || []) }); })
        .catch(() => {});
      return;
    }
    api.leaveBoard({}, { toast: false })
      .then((r) => { if (r) this._setLeaveHomeClass(r); })
      .catch(() => {});
  },

  /**
   * 请假卡落地（2026-10-09 修「上午请假过了时间仍显示请假」）。
   *
   * 🔴 **这里原来只读 `stat`（日期口径），把后端返回的 `now` 整个丢了** ——
   *    而 `now` 才是「此刻真在请假时段内」的实时口径。于是上午请假的人到了下午
   *    卡片上仍然是请假（用户实拍）。后端 2026-10-08 定的口径分层是对的，
   *    是**首页没用上实时那一套**。
   *
   * ⚠️ **数字走实时、名单走日期**（用户 2026-10-09 定）：
   *    `stat`（今天有生效请假的全列，**含已过时段**）仍给名单 ——
   *    否则「上午请假、现在已回来」的人会从名单里凭空消失，用户会以为漏了记录；
   *    已过时段的那几行标 `over: true`（wxml 显示「已过时段」角标）。
   *    ⚠️ 代价是「卡片数字 ≠ 名单行数」—— 这是**有意的**，与 roster 页
   *    「今日请假 N 人」的口径分层同源（同一个人身上两个数字各有各的用处）。
   *
   * 🔴 老后端没返 `now` 时**不能**回落到 `stat`（那正是这个 bug）——
   *    宁可不显示数字也不能显示错的。
   */
  _setLeaveHomeClass(r) {
    const list = (r && r.list) || [];
    const now = (r && r.now) || null;
    const markOver = (x) => {
      /*
       * 🔴 2026-10-10 报障修复：多天假（10-10~10-11 每天 13:00-18:00）在 10-10 晚上被误标「已过时段」。
       *    旧实现只比 `now2` 与 [startTime,endTime]，**完全丢了日期区间** —— 只要今天时钟过了
       *    endTime 就标已过，压根没看 `endDate` 还有没有明天。
       *    现按 endDate 收口：「已过时段」= 该请假**不再有任何未来时段**（整个区间都过去了）。
       *    ⇒ 今天是区间中段（today < endDate）无论几点都不算已过（明天还要请，用户在报障里就是这么期望的）。
       */
      const today = util.todayStr();
      const d1 = String(x.endDate || x.startDate || today);
      if (today < d1) return Object.assign({}, x, { over: false });   // 区间还有未来天数
      if (today > d1) return Object.assign({}, x, { over: true });    // 区间整体已过去（防御：leaveBoard 只回覆盖今天的行）
      // 今天 = 最后一天：整天假今天还没过完 ⇒ 不算已过
      if (!x.startTime && !x.endTime) return Object.assign({}, x, { over: false });
      // 有时段：时钟越过 endTime 才算「已过时段」（不再用「不在区间内」——那会把「今天晚些时候的假」也算已过）
      const now2 = util.clockNow();
      return Object.assign({}, x, { over: now2 > String(x.endTime) });
    };
    const rows = list.map(markOver);
    const a = rows.filter(x => x.groupTag === 'A');
    const b = rows.filter(x => x.groupTag === 'B');
    const stat = (r && r.stat) || {};
    const patch = {
      leaveHomeClassName: (r && r.className) || '',
      leaveHomeDate: (r && r.date) || '',
      // ⚠️ **不再在这里赋 classFullName**（2026-10-09）：它一度从 `r.className` 取，
      //    但 leaveBoard **根本不返回 className**（本轮实测：返回只有
      //    date/list/stat/now）⇒ 这个赋值一直是空串，白留一层误导。
      //    班级名真正的来源是 duty.home 的 className（首页首屏就有）。
      leaveHomeRaw: rows,
      leaveHomeListA: a,
      leaveHomeListB: b
    };
    // 数字：实时口径。后端没给 now ⇒ 置null（wxml 不渲染数字），**不回落 stat**
    if (now && now.leave != null) {
      patch.leaveHomeLeave = now.leave;
      patch.leaveHomeLeaveA = now.leaveA != null ? now.leaveA : 0;
      patch.leaveHomeLeaveB = now.leaveB != null ? now.leaveB : 0;
      patch.leaveHomeHasNow = true;
      // 课堂情况弹层的请假名单：**同一份数据现算**（后端只回 now 的聚合计数，
      // 行级的「此刻在不在时段内」在前端判 —— 口径与 markOver 完全一致，
      // 用后端聚合计数 + 前端行级判断会导致两个数字对不上）。
      patch.leaveHomeNowList = rows.filter((x) => !x.over);
    } else {
      patch.leaveHomeHasNow = false;
      patch.leaveHomeNowList = [];
    }
    // 「今日共 N 人请假」= 日期口径行数（与名单行数恒等，供弹层标题与排班核对用）
    patch.leaveHomeTotal = stat.leave != null ? stat.leave : rows.length;
    this.setData(patch, () => {
      this._refreshLeaveImageUrls();
      this._scheduleLeaveWindowTimer();
    });
  },

  /**
   * 请假时段到点自动重拉（2026-10-09 需求①）。
   *
   * 为什么必须排这个定时器：卡片数字改成**实时口径**后，它得**自己会变** ——
   * 只靠 onShow 重拉的话，用户盯着首页不动，数字会一直停在旧值
   * （这正是用户报的现象）。首页已有 STALE_MS=20s 缓存，切回来会重拉，
   * 但「一直停在首页」这个场景不经过 onShow。
   *
   * 排到**下一个刷新点**：三个固定边界（上午 12:00 / 下午 18:00 / 午夜）**以及**
   * 当天请假记录各时段的开始/结束时刻（startTime/endTime）。
   * 🔴 只认三个写死边界时，19:00–20:40 这种时段的「开始」和「结束」都不在边界上 ⇒
   *    到点不翻面（用户报障）。把请假行自身的 startTime/endTime 也当刷新点即可自愈。
   * 到点重拉一次 leaveBoard，数字自动翻面。多档位只需排最近的那一个，
   * 翻面后 `_setLeaveHomeClass` 会再排下一次 ⇒ 自然形成链。
   *
   * ⚠️ 必须是 setTimeout 链而不是 setInterval：后者在 App 退到后台时
   *    仍会按墙钟触发，回到前台会补发一串过期请求。
   */
  _scheduleLeaveWindowTimer() {
    if (this._leaveWinTimer) { clearTimeout(this._leaveWinTimer); this._leaveWinTimer = null; }
    if (!this.data.leaveHomeHasNow) return;
    const now = util.clockNow();
    /*
     * 候选刷新点 = 三个固定边界（上午 12:00、下午 18:00、午夜）
     *            ∪ 当天请假记录各时段的开始/结束时刻（startTime/endTime）。
     * startTime/endTime 由后端 normTime() 归一为「HH:MM」（空串 = 整天假，不产生边界）。
     * 归一成 HH:MM 再比较：不补零的 '9:00' 与 '12:00' 直接比字符串会错序。
     */
    const cands = ['12:00', '18:00', '00:00'];
    const push = (t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
      if (!m) return;
      cands.push((m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2]);
    };
    (this.data.leaveHomeRaw || []).forEach((r) => { push(r.startTime); push(r.endTime); });
    // 取**严格晚于此刻**的最近一个点
    let next = '';
    for (let i = 0; i < cands.length; i += 1) {
      if (cands[i] > now && (!next || cands[i] < next)) next = cands[i];
    }
    if (!next) return;                       // 今天都过完了 ⇒ 明天再算（onShow 会重排）
    const [hh, mm] = next.split(':').map(Number);
    const [nh, nm] = now.split(':').map(Number);
    const waitMs = Math.max(1000, ((hh * 60 + mm) - (nh * 60 + nm)) * 60 * 1000);
    this._leaveWinTimer = setTimeout(() => {
      this._leaveWinTimer = null;
      this._loadLeaveHome();
    }, waitMs);
  },

  /**
   * 批量换临时链接（1.0.6 需求③）：把弹层名单里的假条 fileID 一次换完。
   * ⚠️ 与 roster 页 `_refreshLeaveImageUrls` 同名同职责（各页一份，页面之间不互相引用）——
   *    云存储 fileID 默认「所有用户可读」，前端可直接换链渲染缩略图。
   */
  _refreshLeaveImageUrls() {
    const ids = [];
    const push = (x) => { if (x && x.image && ids.indexOf(x.image) < 0) ids.push(x.image); };
    (this.data.leaveHomeListA || []).forEach(push);
    (this.data.leaveHomeListB || []).forEach(push);
    (this.data.leaveHomeRaw || []).forEach(push);
    if (!ids.length) return;
    request.getTempFileURL(ids)
      .then((map) => {
        this.setData({ leaveImgUrls: Object.assign({}, this.data.leaveImgUrls || {}, map || {}) });
      })
      .catch(() => {});
  },

  /** 班委/超管：点击本班请假卡 → **立即**弹层（用 onShow 已拉到的名单），再后台刷新。
   *  v0.7.32 问题②：过去「先请求 leaveBoard、回来才开弹层」→ 点一下要等一段时间才弹。
   *  走已部署的 leaveBoard（不依赖 leaveSummary）；失败可见（主动动作）。 */
  onLeaveHomeOpen() {
    this.setData({
      leaveHomeShow: true,
      leaveHomeViewTitle: (this.data.leaveHomeClassName || '本班') + '请假',
      leaveHomeCanCancel: true,
      leaveHomeLoading: true
    });
    api.leaveBoard({}, { toast: false })
      .then((r) => {
        if (r) this._setLeaveHomeClass(r);
        this.setData({ leaveHomeLoading: false });
      })
      .catch((err) => {
        this.setData({ leaveHomeLoading: false });
        util.toast((err && err.errMsg) || '名单加载失败，请重试');
      });
  },

  /** 辅导员：点击某班 → **立即**弹层（先空、显示加载中），再拉该班名单（只读）
   *  2026-10-04 修「名单加载失败」：过去调 leaveSummary({classId}) 并期望 mode:'class'，
   *  但后端 leaveSummary 的辅导员分支**从不认 classId**（恒回 mode:'counselor' 汇总），
   *  该分支从未实现过 ⇒ 必然失败。改走已部署的 leaveBoard（resolveClassId 认传入班级、
   *  staffClassIds 收口越权），返回 {date,list,stat}，名单结构与其完全一致。 */
  onLeaveHomeClassTap(e) {
    const cid = Number(e.currentTarget.dataset.id);
    const name = e.currentTarget.dataset.name || '';
    this.setData({
      leaveHomeShow: true,
      leaveHomeViewTitle: name + '请假',
      leaveHomeCanCancel: false,
      leaveHomeListA: [],
      leaveHomeListB: [],
      leaveHomeLoading: true
    });
    api.leaveBoard({ classId: cid }, { toast: false })
      .then((r) => {
        if (!r) {
          this.setData({ leaveHomeLoading: false });
          util.toast('名单加载失败，请重试');
          return;
        }
        const list = (r.list) || [];
        this.setData({
          leaveHomeListA: list.filter(x => x.groupTag === 'A'),
          leaveHomeListB: list.filter(x => x.groupTag === 'B'),
          leaveHomeLoading: false
        }, () => this._refreshLeaveImageUrls());
      })
      .catch((err) => {
        this.setData({ leaveHomeLoading: false });
        util.toast((err && err.errMsg) || '名单加载失败，请重试');
      });
  },

  onLeaveHomeClose() {
    this.setData({ leaveHomeShow: false, leaveHomeLoading: false });
  },

  /* ================= 课堂情况弹窗（2026-10-09 需求②） =================
   * 班长/副班长点首页「今日课次」任意一行 → 弹出一段可直接发群的课堂情况文本，
   * 一键复制。文本形态（用户给的模板）：
   *   小学教育(专升本)示例班级A
   *   小学语文课程与教学论
   *   示例老师10 应到56人 实到55人
   *   课堂情况：正常
   *   000000000346示例成员46请假
   */

  /**
   * 点某一节课 → 组出这段文本。
   *
   * ⚠️ **应到人数是现算的**，口径与首页其它数字同源：
   *    全体课（groupScope 为空/null）⇒ 应到 = 本班在册人数（不含辅导员/测试账号/已停用）；
   *    A/B 组课 ⇒ 应到 = 该组人数。**实到 = 应到 − 此刻真在请假的人数**。
   *    请假名单用 `leaveBoard` 的 `now`（实时口径）—— 与卡片那个数字**同一个来源**，
   *    否则会出现「卡片说1 人在假、弹层说没人请假」。
   *
   * ⚠️ 应到人数需要成员名单，首页**常驻不加载**（为了首屏速度）⇒ 点开时才拉一次
   *    `memberList`。这是按需加载，不是每个课次都拉。
   */
  onCourseTap(e) {
    if (!this.data.canCourseInfo) return;
    const idx = Number(e.currentTarget.dataset.idx);
    const s = (this.data.sessions || [])[idx];
    if (!s) return;
    // 🔴 选修课不进「课堂情况」（2026-10-16 首页并入选修课时加）：
    //    选修课 `sessionId=0`、不驱动值日 ⇒ `_loadCourseRoster` 按 sessionId 查名单只会得到
    //    一份无意义的空名单，班委会把它当真实数据发到群里。直接忽略点击。
    //    （未被守卫时的症状：选修课那行班长点得动、弹层标题是课程名但名单恒空。）
    if (s.isPersonal) return;
    this.setData({
      courseInfoShow: true,
      courseInfoLoading: true,
      courseInfo: null,
      // 课次信息先摆上（教师名可能为空，此时那一行由 wxml 隐藏）
      courseInfoTitle: s.name || '',
      courseInfoTeacher: s.teacher || '',
      courseInfoRoom: s.room || ''
    });
    this._loadCourseRoster(s);
  },

  /** 拉本班名单 → 算应到 → 组文本 → 顺带把请假名单对齐到「此刻」 */
  _loadCourseRoster(s) {
    const need = !this.data.classRoster || !this.data.classRoster.length;
    const after = (rows) => {
      const roster = rows || [];
      this.setData({ classRoster: roster });
      // 请假名单用 `leaveHomeRaw`（**日期口径全列**）—— 不是 `leaveHomeNowList`。
      // 🔴 课堂情况问「这节课谁没来」，答「在这节课时段内请过假的人」（用户 2026-10-09 定）。
      //    用实时名单 ⇒ 上午的假到了下午就不算，**那节上午的课会被算成实到 = 应到**。
      this._buildCourseInfo(s, roster, this.data.leaveHomeRaw || []);
    };
    // 🔴 请假数据**可能还没到**（卡片的 leaveBoard 失败/慢、或用户刚进首页就点课次）
    //    ⇒ 先补拉一次再组文本，否则会输出一份「0 人请假」的假报告 ——
    //    那比报错更糟：班委会直接发到群里。
    //    ⚠️ 2026-10-09 删掉了原来的 `|| needClass` 分支：那个「去拉班级名」的
    //    动作查的是 `leaveBoard`，而**它根本不返回 className** ⇒ 白拉一次、
    //    班级名永远补不上（用户实拍两次都显示「本班」/「（班级）」）。
    //    班级名现在走 duty.home 的主路径（首屏就到），这里只需管请假数据。
    // 🔴🔴 判断条件必须跟**实际喂给 _buildCourseInfo 的那个字段**一致（2026-10-09 第三轮实拍）：
    //    `_buildCourseInfo` 已改用 `leaveHomeRaw`（日期口径全列），而这里还在判
    //    `leaveHomeNowList`（实时口径）⇒ 「nowList 已有但 raw 为空」时会**跳过补拉**
    //    ⇒ 静默输出「没人请假」的假报告（用户实拍：上午有人请了一上午假，课堂情况显示实到 = 应到）。
    if (!this.data.leaveHomeRaw || !this.data.leaveHomeRaw.length) {
      api.leaveBoard({}, { toast: false })
        .then((r) => {
          if (r) this._setLeaveHomeClass(r);
          this._loadRosterThen(s, need, after);
        })
        .catch(() => this._loadRosterThen(s, need, after));
      return;
    }
    this._loadRosterThen(s, need, after);
  },

  /** 名单：已有则直接用，没有才拉（与 _loadCourseRoster 的按需加载策略一致） */
  _loadRosterThen(s, need, after) {
    if (!need) { after(this.data.classRoster); return; }
    api.memberList({ public: 'manage' }, { toast: false })
      .then((list) => {
        // 与首页选人名单**同一套过滤**（通知弹层 `_loadNoticeMembers`）：
        // 停用的不算、辅导员（X）不算；测试账号后端已滤，前端不再重复判。
        const rows = (list || [])
          .filter((x) => x.status !== 'DISABLED')
          .filter((x) => x.groupTag !== 'X')
          .map((x) => Object.assign({}, x, { seq: util.seqOf(x.studentNo) }));
        after(rows);
      })
      .catch(() => after([]));
  },

  /**
   * 组课堂情况文本。
   *
   * ⚠️ **纯函数式**（自己算所有数，不读 data 里的中间态）—— 这样门禁能在内存里
   *    直接调用它真跑，不用模拟 setData 时序。
   *
   * @param s       课次（需 groupScope / periodTime）
   * @param roster  本班在册名单（已滤停用与辅导员）
   * @param leaveList今天有生效请假的人（**日期口径全列** leaveBoard.list，含 startTime/endTime）
   */
  _buildCourseInfo(s, roster, leaveList) {
    const rows = roster || [];
    // 应到 = 课次涉及的组（groupScope 空 = 全体）
    const scope = String((s && s.groupScope) || '').trim();
    const inScope = (x) => (!scope || String(x.groupTag || '') === scope);
    const expected = rows.filter(inScope).length;
    // 🔴 请假者口径（2026-10-09 用户实拍「B 组上午一人请假 ⇒ 课堂情况却显示实到 28」）：
    //    原来传的是**实时**名单（`leaveHomeNowList`，此刻在时段内才算数）——
    //    于是上午的假到了下午就「不在名单里」，那节上午的课算成实到 28。
    //    课堂情况问的是「**这节课谁没来**」，答案是「**在这节课的时间范围内请过假**的人」，
    //    与「此刻还在不在假」无关（人下午回来了，但那节上午的课他确实缺了）。
    //    ⇒ 改用 `leaveBoard.list`（日期口径全列），按「时段与本节课有交集」筛。
    const pt = (s && s.periodTime) || null;
    const cs = String((pt && pt.start) || '');
    const ce = String((pt && pt.end) || '');
    // ⚠️ 同一天才有交集可言；跨天假（startDate≠ 上课时那天）按日期覆盖判。
    const day = String(util.todayStr());
    const overlap = (x) => {
      // ⚠️⚠️ **不要用 `x.over` 过滤**（2026-10-09 用户实踩，我自己的 bug）：
      //    `over` 是「**已过时段**」的意思（此刻不在 [startTime,endTime] 内），
      //    **不是「已撤销」**。上午 08:00-12:00 的假到了下午 `over === true`
      //    ⇒ 我用它当"撤销"过滤 ⇒ **那节上午的课被算成实到 = 应到**
      //    （用户实拍「明明上午有人请了一上午假，课堂情况却显示没人请假」）。
      //    撤销的记录**根本不会出现在这份 list 里** —— 后端 leaveBoard 的 SQL是
      //    `WHERE l.status = 'APPROVED'`，已撤销的直接查不出来，不需要前端再判。
      const d0 = String(x.startDate || '');
      const d1 = String(x.endDate || d0);
      if (day && (d0 > day || d1 < day)) return false;   // 假期不覆盖上课那天
      // 整天假（无时段）⇒ 整天都算
      if (!x.startTime || !x.endTime) return true;
      // ⚠️ 课次没拿到时段（periodTime 为 null）⇒ 退化为「当天请假就算」，
      //    比"什么都不算"更接近真相（宁可多算，不可漏算——漏算会让班长把缺席的人报成全勤）。
      if (!cs || !ce) return true;
      // 有交集：leaveStart <= courseEnd 且 leaveEnd >= courseStart
      return String(x.startTime) <= ce && String(x.endTime) >= cs;
    };
    // 请假者也必须落在同一组口径内：单组课里，别组的人请假不该扣这节课的应到
    const absentees = (leaveList || []).filter(inScope).filter(overlap);
    const actual = Math.max(0, expected - absentees.length);
    // 🔴 模板第一行是「班级全称」（形如「示例专业A1班」）。
    //    它只由 `_setLeaveHomeClass` 顺带赋值（`leaveBoard` 的 className），
    //    而那个请求是异步的 ⇒ 曾出现「本班」占位（用户实拍）。
    //    三层保障：
    //      ① `classFullName`（**主路径**，来自 duty.home 的 className，首屏就到）；
    //      ② `leaveHomeClassName`（请假日备用；实测常为空，仅作二次兜底）；
    //      ③ 还拿不到时用**「（班级）」**占位。
    //      ③ 还拿不到时用**「（班级）」**占位。
    //    ⚠️③ 为什么不写「本班」：那是个**看起来像真名的词** —— 班委会直接发到群里，
    //    别人看到「本班 · 儿童文学」不知道是哪个班，比明说「没取到」更糟。
    //    ⚠️ 第一行**绝不能空**：空会被下面那行 filter 连课程名一起滤掉，复制出去少一行首。
    const cls = String(this.data.classFullName || this.data.leaveHomeClassName || '').trim();
    const lines = [
      cls || '（班级）',
      (s && s.name) || '',
      [
        (s && s.teacher) || '',
        '应到' + expected + '人',
        '实到' + actual + '人'
      ].filter(Boolean).join(' '),
      '课堂情况：正常'
    ];
    // 每行请假：学号 姓名 请假（用户模板里学号与姓名之间**没有空格**，照抄）
    absentees.forEach((x) => {
      lines.push(String(x.studentNo || '') + (x.name || '') + '请假');
    });
    // ⚠️ 只滤**尾部**的空行：第 0 行（班级全称）已经兜底成「本班」，
    //    但万一将来它真的空了，也不能连带把课程名那几行一起滤掉。
    const text = lines
      .map((l, i) => (i === 0 ? l : String(l || '').trim()))
      .filter((l, i) => (i === 0 ? true : !!l))
      .join('\n');
    this.setData({
      courseInfoLoading: false,
      courseInfoText: text,
      courseInfoExpected: expected,
      courseInfoActual: actual,
      courseInfoAbsentees: absentees
    });
  },

  onCourseInfoClose() {
    this.setData({ courseInfoShow: false, courseInfoLoading: false });
  },

  /** 一键复制（需求②）：整段纯文本写剪贴板 */
  onCourseInfoCopy() {
    const t = this.data.courseInfoText || '';
    if (!t) { util.toast('内容还没准备好'); return; }
    wx.setClipboardData({
      data: t,
      success() { util.toast('已复制，去群里粘贴吧'); },
      fail() { util.toast('复制失败，请长按上方文字手动复制'); }
    });
  },

  /**
   * 行内「假条缩略图 / 传假条」（1.0.6 需求①②③）：
   *   无图 → 直接选图上传；
   *   有图 → **动作面板**给两个动作：查看大图 / **重新上传**（容错：传错了能重来）。
   * ⚠️ 为什么不给缩略图绑「长按重传」：长按没有提示、没有确认、还容易和「点击看大图」
   *    打架；动作面板把两个动作都写出来，用户不用猜。
   * ⚠️ 辅导员（无登记权）点缩略图只预览，不给「重新上传」—— 后端 requireLeaveRegister
   *    也会真拦，这里只是别让他看见一个点了会失败的选项。
   * ⚠️ 撤销从这里拿掉了（需求①）：撤销**只在请假登记弹层里保留**。首页离登记入口太远，
   *    误触一次要跑好几跳才能补救；补偿入口是弹层底部那行「去请假登记」（见下方）。
   */
  onLeaveHomeImageTap(e) {
    if (this.data.leaveHomeBusy) return;
    const d = e.currentTarget.dataset || {};
    const leaveId = Number(d.id);
    if (!leaveId) return;
    if (String(d.has) !== '1') { this._uploadLeaveImage(leaveId); return; }
    if (!this.data.canLeave) { this._previewLeaveImage(leaveId); return; }
    wx.showActionSheet({
      itemList: ['查看大图', '重新上传'],
      success: (r) => {
        if (r.tapIndex === 0) this._previewLeaveImage(leaveId);
        else if (r.tapIndex === 1) this._uploadLeaveImage(leaveId);
      },
      fail: () => {}
    });
  },

  /**
   * 选图 → 前端直传云存储 → 调 adjust.leaveImageSet 落库。
   * ⚠️ **已上传过也能再来一遍**（容错）：后端 `leaveImageSet` 在覆盖前会 deleteFile 掉旧
   *    fileID，所以重传不用改后端，也不会留下两张孤儿图。
   */
  _uploadLeaveImage(leaveId) {
    if (!this.data.canLeave) { util.toast('仅班委可上传假条'); return; }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (r) => {
        const p = (r.tempFiles || [])[0] && (r.tempFiles || [])[0].tempFilePath;
        if (!p) return;
        this.setData({ leaveHomeBusy: true });
        wx.showLoading({ title: '上传假条…', mask: true });
        request.uploadFile('leave/' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
          .then((fileId) => api.leaveImageSet({ leaveId, fileId }, { toast: false }))
          .then(() => {
            wx.hideLoading();
            this.setData({ leaveHomeBusy: false });
            util.toast('假条已上传');
            this._refreshLeaveHome();
          })
          .catch((err) => {
            wx.hideLoading();
            this.setData({ leaveHomeBusy: false });
            util.toast((err && err.errMsg) || '假条上传失败，请重试');
          });
      }
    });
  },

  /** 预览假条：云存储的 fileID 不能直接喂给 previewImage，先换临时链接
   *  ⚠️ 缩略图已经批量换过一次（_refreshLeaveImageUrls），命中缓存就别再请求 +
   *    别再闪「加载图片…」遮罩（点缩略图是高频操作，每次都闪一下很廉价）。 */
  _previewLeaveImage(leaveId) {
    let fileId = '';
    const findIn = (arr) => {
      const it = (arr || []).find(x => x.leaveId === leaveId);
      if (it && it.image) fileId = it.image;
    };
    findIn(this.data.leaveHomeListA);
    if (!fileId) findIn(this.data.leaveHomeListB);
    if (!fileId) findIn(this.data.leaveHomeRaw);
    if (!fileId) { util.toast('没有假条图片'); return; }
    const cached = (this.data.leaveImgUrls || {})[fileId];
    if (cached) { wx.previewImage({ urls: [cached], current: cached }); return; }
    wx.showLoading({ title: '加载图片…', mask: true });
    request.getTempFileURL([fileId])
      .then((map) => {
        wx.hideLoading();
        const url = (map || {})[fileId];
        if (!url) { util.toast('图片加载失败'); return; }
        wx.previewImage({ urls: [url], current: url });
      })
      .catch(() => { wx.hideLoading(); util.toast('图片加载失败'); });
  },

  /** 传完假条刷新弹层名单（不重开弹层：重开会闪一下） */
  _refreshLeaveHome() {
    api.leaveBoard({}, { toast: false })
      .then((r) => { if (r) this._setLeaveHomeClass(r); })
      .catch(() => {});
  },

  /**
   * 弹层底部「需要撤销？去请假登记 ›」。
   * ⚠️ 必带 openLeave=1：roster 的 onLoad 接这个参数，名单加载完自动展开登记弹层。
   *    不带的话用户落地还要自己找「请假人数」入口 —— 等于没省跳，这行白了写。
   * ⚠️ 本班卡恒为 classId=0（roster 带 0 = 后端按生效身份回退本班）。
   */
  onLeaveHomeGotoRoster() {
    wx.navigateTo({ url: '/pages/roster/index?openLeave=1' });
  },

  /** 点关注的学生 → 直接进他的成员详情（带 classId，辅导员跨班也能定位） */
  onPinTap(e) {
    const d = e.currentTarget.dataset || {};
    const memberId = Number(d.id) || 0;
    if (!memberId) return;
    const qs = 'classId=' + (Number(d.classId) || 0) +
      '&openMemberId=' + memberId +
      '&name=' + encodeURIComponent(String(d.name || ''));
    wx.navigateTo({ url: '/pages/roster/index?' + qs });
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅，否则 setData 到已销毁实例
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    if (this._audio) { this._audio.destroy(); this._audio = null; }
    // 请假时段翻面定时器（2026-10-09 需求①）：最长可跨小时，不清会在页面销毁后
    // 仍触发 _loadLeaveHome ⇒ 对已销毁实例 setData（报错 + 泄漏闭包）。
    // ⚠️ 必须加在**这个** onUnload 里 —— 本页生命周期同名后者覆盖前者。
    if (this._leaveWinTimer) { clearTimeout(this._leaveWinTimer); this._leaveWinTimer = null; }
  },

  onHide() {
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    if (this._audio) { this._audio.stop(); this.setData({ playing: false }); }
  },

  _renderDate() {
    const d = new Date();
    const wd = util.weekdayCn(util.todayWeekday());
    this.setData({
      dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + wd
    });
  },

  load(force) {
    /*
     * 需求①「切换页面若无变化则无需重载」：Tab 切换回来时，只要上一次数据还很新鲜
     * （STALE_MS 内拉过），就直接复用已渲染的内容、连请求都不发 —— 切回来「秒显」。
     * 显式操作（点开 Hero 弹层后换班等）走 `load(true)` 强制刷新。
     */
    const now = Date.now();
    if (!force && this._hasData && this._lastLoad && now - this._lastLoad < STALE_MS) {
      return;
    }
    /*
     * 页面实例在 Tab 切换时**不会销毁**，data 里还是上一次的内容 ——
     * 所以「切回首页闪一下骨架」纯粹是自己造成的：无条件 `loading: true` 会把
     * 屏幕上的内容整页替换成骨架，等云函数回来再换回去。
     * 有内容就保持内容、后台静默刷新（与通知页同一套策略）。
     */
    const hasContent = !!this._hasData;
    if (!hasContent) this.setData({ loading: true, failed: false });
    // 🔴 选修课（personal_course）与 dutyToday 是两条独立链路，并行拉以免拖慢首屏；
    //    任一失败都不阻断另一条（catch 内已兜成空数组）。
    const pToday = api.dutyToday({}, { toast: false });
    const pPersonal = this._loadPersonalCourses();
    return Promise.all([pToday, pPersonal])
      .then(([r]) => {
        const myDuty = r.myDuty || null;
        // 分组可见性用的「本组」取**本次 dutyToday 返回的 member.groupTag**（后端 me.group_tag 的权威值），
        // 而不是 globalData.profile.groupTag —— 后者在「切换测试账号」模拟态下仍是超管本人，
        // 会拿超管的组去过滤被模拟账号的课次，导致 A/B 组错乱（班长/副班长看串组）。
        const groupTag = (r.member && r.member.groupTag) || this._groupTag();
        let hero = null;
        let heroSub = '';
        let periodText = '';
        if (myDuty) {
          hero = HERO[myDuty.status] || HERO.PENDING;
          heroSub = [util.fmtRoom(myDuty.room), myDuty.courseName, myDuty.groupScope ? myDuty.groupScope + ' 组' : '全体']
            .filter(Boolean).join(' · ');
          // 保洁（kind='CLEAN'）显示「18点前」；它没有 periodTime（后端已置空），
          // 避免出现「18点前 · 16:00」这种自相矛盾的组合
          periodText = util.whenText(myDuty.kind, myDuty.period) + (myDuty.periodTime ? ' · ' + myDuty.periodTime.start : '');
        }
        this._hasData = true;
        this._lastLoad = Date.now();
        this.setData({
          loading: false,
          failed: false,
          unbound: false,
          myDuty,
          hero,
          heroSub,
          periodText,
          // 今日 / 明日课次各并入「本人选修课」（2026-10-16 需求 A）。
          // · 今日 = util.todayWeekday()；明日 = 今天+1 的星期（跨周自动回绕：周日→1）。
          // · currentWeek 用后端 dutyToday 返回的权威值，周次过滤与值日/课表同一口径。
          sessions: this._markDone(this._mergePersonalCourses(
            this._filterSessions(r.sessions || [], groupTag),
            this._personalCourses, util.todayWeekday(), r.currentWeek)),
          tomorrowSessions: this._mergePersonalCourses(
            this._filterSessions(r.tomorrowSessions || [], groupTag),
            this._personalCourses, this._tomorrowWeekday(), r.currentWeek),
          tomorrowText: this._fmtDay(r.tomorrow),
          pendingSwapCount: r.pendingSwapCount || 0,
          unreadNotice: this._fmtNotice(r.unreadNotice),
          isAdmin: !!r.isAdmin,
          // 班级全称（2026-10-09）：**duty.home 的主路径**，不是 leaveBoard ——
          // leaveBoard / member.list / class.list 都不返回班级名（实测确认），
          // 所以只能由首页首屏这个本来就在调的接口带回来。
          classFullName: r.className || this.data.classFullName || '',
          member: r.member || null,
          remindBlock: !!(r.member && r.member.remindBlock),
          currentWeek: r.currentWeek || 1,
          weekText: '第 ' + (r.currentWeek || 1) + ' 周'
        });
        // 今日课次「已上完」灰化：数据落盘后排一个到点自动翻面的计时器
        this._scheduleDoneTimer();
        const tb = typeof this.getTabBar === 'function' ? this.getTabBar() : null;
        // 值相同就不写：每次 onShow 都 setData 会让 tabBar 多渲染一轮（视觉抖动）
        const dotNext = (r.pendingSwapCount || 0) > 0;
        if (tb && tb.data && tb.data.dot !== dotNext) tb.setData({ dot: dotNext });
        // 主页弹层（不阻塞首屏）：先看「通知一次性弹窗」，再看「更新公告」，未读才弹
        this._loadPopups();
        // 班费 / 团费：不阻塞首屏，后台拉取余额与明细
        this._loadFee();
      })
      .catch((e) => {
        const code = e && e.errCode;
        this.setData({
          loading: false,
          unbound: code === 40001 || code === 40002,
          // 已经有内容时刷新失败不把整页打成错误态（对用户应当无感）
          failed: !hasContent && code !== 40001 && code !== 40002
        });
      });
  },

  onReload() { this.load(true); },

  /* v1.0.5：spring-scroll 下拉刷新 → 强制重载并收起指示器 */
  onRefresh() {
    Promise.resolve(this.load(true)).then(() => {
      const sc = this.selectComponent('#homeMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    }).catch(() => {
      const sc = this.selectComponent('#homeMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    });
  },

  goBind() { wx.reLaunch({ url: '/pages/bind/index' }); },

  /* ---------------- 主页弹层：通知一次性弹窗 + 更新公告 ----------------
   * 两类弹窗共用「未读才弹、看过不再弹」，但**有先后**：通知弹窗 > 更新公告，
   * 一次只弹一层（关掉通知弹窗后，更新公告下次进主页再弹），避免叠两层把首屏糊住。
   *   ① 通知一次性弹窗（v1.0.5）：发布通知勾了「弹出一次性弹窗」→ 取「我可见、没看过」的
   *      最新一条弹一次。「我可见」由 msgList 的可见性 SQL 保证（本班 / 指定 / 按职位…），
   *      「看过」= 关闭时写 notice_popup_seen（每人每条一次，与更新公告机制完全隔离）。
   *   ② 更新公告（v0.7.25）：超管发、全员弹一次；「看过」= 关闭时写 member.app_notice_seen。
   * 拉取失败静默（都不是关键路径，不为准入 / 首屏让路）。 */
  _loadPopups() {
    this._popupSeenIds = this._popupSeenIds || {};   // 本会话已关掉的弹窗 id，防「关掉又被缓存弹回来」
    api.msgList({}, { toast: false })
      .then((list) => {
        const pop = (list || []).find(n =>
          n.popup && !n.popupSeen && !n.isPublisher && !this._popupSeenIds[n.id]);
        if (pop) { this.setData({ npopNotice: pop, npopSheetShow: true }); return null; }
        return this._loadAppNotice();
      })
      // 通知列表挂了也别把更新公告一起吞掉
      .catch(() => { this._loadAppNotice(); });
  },

  /** 更新公告：未读才弹（appNoticeLatest + appNoticeSeen，全局单条只增不减） */
  _loadAppNotice() {
    return api.appNoticeLatest({}, { toast: false })
      .then((r) => {
        const n = r && r.notice;
        if (n && !n.seen) this.setData({ anncNotice: n, anncSheetShow: true });
      })
      .catch(() => {});
  },

  /** 关闭「通知一次性弹窗」：写已读 + 记本会话，避免关掉后又被旧缓存重新弹出来 */
  onNpopDismiss() {
    const n = this.data.npopNotice || {};
    if (this.data.npopSheetShow && n.id) {
      this._popupSeenIds = this._popupSeenIds || {};
      this._popupSeenIds[n.id] = true;
      api.msgPopupSeen({ noticeId: n.id }, { toast: false }).catch(() => {});
    }
    this.setData({ npopSheetShow: false });
  },

  onAnncDismiss() {
    const n = this.data.anncNotice || {};
    if (this.data.anncSheetShow && n.id) {
      api.appNoticeSeen({ noticeId: n.id }, { toast: false }).catch(() => {});
    }
    this.setData({ anncSheetShow: false });
  },

  _groupTag() {
    const app = getApp();
    return (app && app.globalData.profile && app.globalData.profile.groupTag) || '';
  },

  /**
   * 'YYYY-MM-DD' → '9月26日 周六'。
   * 星期必须用**本地时区**构造再 getDay()：走 toDate()+getUTCDay() 会因为 +08:00 位移
   * 落到前一天（项目里踩过的「星期整体差一天」坑）。
   */
  _fmtDay(dateStr) {
    const p = String(dateStr || '').split('-');
    if (p.length < 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return Number(p[1]) + '月' + Number(p[2]) + '日 周' + wd;
  },

  /**
   * 今日课次按分组可见性过滤 + **去重**。
   *
   * 去重的来由（2026-10-07 用户实锤）：同一门课在 `session` 表里可能同时存在
   * 「全体课(group_scope=NULL)」与「A/B 组课」两条**同一天、同一节、同一教室**的记录
   * （青果导入会这么留）。组别过滤后两条都留下 ⇒ 首页「今日/明日课次」把同一节课
   * 显示两遍，一条标 A 组、一条标全体（用户原话「显示了两个相同的课」）。
   *
   * 口径：按 (日期, 第几节, 课程名) 判重，**保留分组课**（更具体的那条，
   * 与全班课表按组查看时看到的一致）；只有全体课时才留全体课那条。
   * 不同日期 / 不同节次 / 不同课名的**不去重**（那些是真的两节课）。
   */
  _filterSessions(sessions, tag) {
    const list = Array.isArray(sessions) ? sessions : [];
    // 本组：优先用调用方传入的权威值（来自 dutyToday 的 member.groupTag），否则回退 globalData.profile。
    // ⚠️ 空组（班委/超管未分到 A/B，或 A/B 组本身为空）→ 仅保留「全体」课次，
    //    绝不把 A/B 两组课都列出来（2026-10-10 修：空组时旧实现回落成「全部显示」，
    //    于是班长/副班长在首页看到 A 组 + B 组 + 全体）。
    const t = (tag != null && tag !== '' && tag !== 'X') ? tag : this._groupTag();
    const visible = t
      ? list.filter(s => !s.groupScope || s.groupScope === t)
      : list.filter(s => !s.groupScope);
    const seen = {};
    const out = [];
    visible.forEach(s => {
      // ⚠️ 后端 `sessionsOnDate` 返回的对象**没有 classDate**（同一天���课次都在这一个数组里），
      //    所以判重键用 (节次, 课程名, 教室)。带上教室是为了「同名同节但不同教室」的两门课不被误合并。
      const room = util.fmtRoom(s.room);
      const key = [s.period || '', s.name || '', room].join('|');
      const prev = seen[key];
      if (prev === undefined) {
        seen[key] = s;
        out.push(Object.assign({}, s, { room }));
        return;
      }
      // 同一格已有条目：只在「已有的是全体课、这条是分组课」时替换，分组课优先
      if (!prev.groupScope && s.groupScope) {
        out[out.indexOf(prev)] = Object.assign({}, s, { room });
        seen[key] = s;
      }
    });
    return out;
  },

  /** 明日的星期（1..7）。周日=7 ⇒ 明日=1（**必须回绕**，否则周日会算出 8 永远匹配不上）。 */
  _tomorrowWeekday() {
    return (util.todayWeekday() % 7) + 1;
  },

  /**
   * 给「今日 / 明日课次」每行补一个稳定的唯一 `key`（渲染层 wx:key 用）。
   *
   * 🔴 **为什么必须materialize成字段，不能写在 WXML 里**（2026-10-16 修正）：
   *   `wx:key` 的值只接受**属性名**（框架内部做 `item[key]` 取值），
   *   **不接受 `{{ }}` 表达式**。全仓 33 种 wx:key 写法都是裸属性名（`id` / `*this` / `key` …），
   *   上一版图省事写成 `wx:key="{{item.isPersonal ? 'pid' : 'sessionId'}}"`，
   *   属于全项目唯一一处「表达式当 key」⇒ 渲染层报错，DevTools 日志：
   *     `[渲染层错误] Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': missing ) after argument list`
   *     `[渲染层错误] Framework inner error (expect FLOW_INITIAL_CREATION end but got FLOW_CREATE_NODE)`
   *   所以派生值一律在 JS 里算好（与项目铁律「WXML 不做逻辑」一致）。
   *
   * 为什么不能用裸 `sessionId`：选修课的 `sessionId` 恒为 0（个人课次没有 session 身份），
   * 多门选修课会撞同一个 key ⇒ 列表增删时 diff 错位（input 值 / 开关态串行）。
   * 加前缀区分两个 id 空间：全班课次 `s<sessionId>`、个人选修课 `p<pid>`。
   */
  _withRowKey(arr) {
    return (arr || []).map((s, i) => {
      const cur = s || {};
      if (cur.key) return cur;
      const k = cur.isPersonal
        ? 'p' + (Number(cur.pid) || 0)
        : 's' + (Number(cur.sessionId) || Number(cur.id) || i);
      return Object.assign({}, cur, { key: k });
    });
  },

  /**
   * 把「我」的个人选修课并进首页课次（2026-10-16 用户需求 A）。
   *
   * 用户原话：「首页显示的今日课次自己的选修课仅自己可见，明日有选修课也显示到明日课次中」。
   *
   * 🔴 为什么首页原本看不到选修课：
   *   首页课次的数据源是 `duty.home`（值日语义）—— 后端只 JOIN `duty`+`session`+`course`，
   *   而选修课存在**独立表 `personal_course`**（不驱动值日、不进 `session`），两条链路天然不通。
   *   课程表页能显示是因为它额外拉了 `electiveList` 并用 `_mergePersonal` 合并；首页此前没接。
   *
   * 口径：
   *  · **仅本人可见** —— `electiveList` 后端已按 `member_id = 本人` 过滤，端上不构造他人课程。
   *  · **只并今日/明日** —— 其它星期的选修课属于课表页的职责，首页不重复列。
   *  · **周次过滤** —— `weeks` 为区间（`6-13`）或显式列表时才在对应周出现；空则按 `weekRule` 判。
   *  · **不参与值日** —— `sessionId: 0`（不挂值日表）、无 duty 归属 ⇒ 不会被算成「我的值日」，
   *    也不会进「课堂情况」弹层的值日统计。
   *  · **样式区分** —— 打 `isPersonal` 标记，wxml 可据此加一个「选修」角标。
   */
  _mergePersonalCourses(list, personal, targetDow, weekNo) {
    const out = Array.isArray(list) ? list.slice() : [];
    const dow = Number(targetDow) || 0;
    // 星期算不出来也得给行补 key（列表照样渲染，只是不并选修课）
    if (!dow) return this._withRowKey(out);
    // 周次：**优先用 dutyToday 返回的 currentWeek**（后端权威，与值日/课表同一口径），
    // 拿不到时退回本地按 termStart 算（weekOfDate 依赖 tt 模块的 _termStart，
    // 首页没有 setClass 过，只有兜底默认值，故不能作为首选）。
    const week = Number(weekNo) || tt.weekOfDate(util.todayStr());
    (personal || []).forEach(p => {
      if (Number(p.dayOfWeek) !== dow) return;                     // 只并目标日（今日或明日）
      if (!week) return;                                           // 周次算不出来就不显示（宁缺毋滥）
      if (!tt.matchesWeeks(p.weeks || '', week, p.weekRule || 'ALL')) return;   // 周次不命中就不显示
      out.push({
        sessionId: 0,           // 个人课次没有 session 身份 ⇒ 不参与值日 / 调课
        pid: Number(p.id) || 0,
        name: p.name || '',
        teacher: p.teacher || '',
        room: util.fmtRoom(p.room),
        period: Number(p.period) || 0,
        dayOfWeek: dow,
        weekRule: p.weekRule || 'ALL',
        weeks: p.weeks || '',
        groupScope: null,       // 无分组语义，任何分组视图都显示
        isPersonal: true,       // 供 wxml 加「选修」角标、避免被误认成值日
        periodTime: null        // 保洁课次同样为 null；首页时间列会回退成「第N节」
      });
    });
    // 唯一汇合点：全班课次（去重后）+ 本次并入的选修课一起补 key，
    // 今日 / 明日两条链路都走这里 ⇒ WXML 只写 wx:key="key" 即可。
    return this._withRowKey(out);
  },

  /** 拉「我」的选修课（仅本人可见），写进 this._personalCourses 供今日/明日两处合并 */
  _loadPersonalCourses() {
    return api.electiveList({}, { toast: false })
      .then((r) => { this._personalCourses = (r && r.list) || []; })
      .catch(() => { this._personalCourses = []; });
  },

  /* ---------------- 今日课次「已上完」灰化（2026-09-29 需求） ----------------
   * 触发规则：当前时间 ≥ 该节课的下课时间(periodTime.end) ⇒ 视为上完、整行变灰。
   * 保洁/CLEAN 课次后端 periodTime 为 null（显示「18点前」），没有下课时间 ⇒ 不参与灰化。
   * 明日课次是未来日期、永远不应灰化，所以只在本函数给「今日」sessions 打标。 */
  _doneAt(s) {
    if (!s || !s.periodTime || !s.periodTime.end) return false;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.periodTime.end);
    if (!m) return false;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return (Number(m[1]) * 60 + Number(m[2])) <= nowMin;
  },
  _markDone(sessions) {
    return (sessions || []).map(s => Object.assign({}, s, { done: this._doneAt(s) }));
  },
  /* 计时器到点/前台切回时，只重算「今日」sessions 的 done，真正翻面了才 setData（开销极小） */
  _refreshDoneFlags() {
    const sessions = this.data.sessions || [];
    if (!sessions.length) return;
    let changed = false;
    const next = sessions.map((s) => {
      const done = this._doneAt(s);
      if (done !== !!s.done) changed = true;
      return done === s.done ? s : Object.assign({}, s, { done });
    });
    if (changed) this.setData({ sessions: next });
  },
  /* 排下一个「到点翻面」的定时器：算最近一节还没上完的课的下课时刻，到点后再评估+续排。
   * 全部已上完 ⇒ 不排；切走/卸载由 onHide/onUnload 清掉。_scheduleDoneTimer 自身先清旧计时器，
   * 所以在 load 的 .then 与 onShow 里重复调用也不会叠出多个。 */
  _scheduleDoneTimer() {
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    const sessions = this.data.sessions || [];
    if (!sessions.length) return;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let nextMs = Infinity;
    sessions.forEach((s) => {
      if (s.done || !s.periodTime || !s.periodTime.end) return;
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.periodTime.end);
      if (!m) return;
      const endMin = Number(m[1]) * 60 + Number(m[2]);
      if (endMin > nowMin) {
        const fire = (endMin - nowMin) * 60000 - (now.getSeconds() * 1000 + now.getMilliseconds());
        if (fire < nextMs) nextMs = fire;
      }
    });
    if (!isFinite(nextMs)) return;            // 全部已上完，无需再排
    const delay = Math.max(1000, nextMs);     // 至少 1s，避免 0ms 抖动；否则睡到下一节下课
    this._doneTimer = setTimeout(() => {
      this._doneTimer = null;
      this._refreshDoneFlags();
      this._scheduleDoneTimer();
    }, delay);
  },

  /* ---------------- Hero ---------------- */
  onHero() {
    if (!this.data.myDuty) return;
    this.setData({ sheetShow: true, sheetDutyId: this.data.myDuty.id });
  },

  onSheetClose() { this.setData({ sheetShow: false }); },
  onSheetChanged() { this.load(true); },

  /* ---------------- 语音通知 ---------------- */
  onPlayNotice() {
    const n = this.data.unreadNotice;
    if (!n) return;
    if (this.data.playing) {
      if (this._audio) this._audio.stop();
      this.setData({ playing: false });
      return;
    }
    if (!n.url) { util.toast('语音还在审核中，请稍后再听'); return; }
    if (this._audio) this._audio.destroy();
    const a = wx.createInnerAudioContext();
    a.src = n.url;
    a.play();
    this._audio = a;
    this.setData({ playing: true });
    a.onEnded(() => {
      this.setData({ playing: false });
      this._markRead(n.id);
    });
    a.onError(() => {
      this.setData({ playing: false });
      util.toast('播放失败，请稍后重试');
    });
    a.onStop(() => this.setData({ playing: false }));
  },

  _markRead(id) {
    api.markNoticeRead({ noticeId: id }, { toast: false })
      .then(() => this.setData({ unreadNotice: null }))
      .catch(() => {});
  },

  /* ---------------- 扫码 ---------------- */
  onScan() {
    wx.scanCode({
      onlyFromCamera: false,
      success: (res) => {
        const raw = String((res && (res.path || res.result || res.rawData)) || '');
        this._handleScan(raw);
      },
      fail: () => {}
    });
  },

  _handleScan(raw) {
    let scene = raw;
    const m = /[?&]scene=([^&]+)/.exec(raw);
    if (m) {
      try { scene = decodeURIComponent(m[1]); } catch (e) { scene = m[1]; }
    }
    scene = String(scene || '').trim();
    if (/^N\d+$/.test(scene)) {
      this._playNoticeById(Number(scene.slice(1)));
      return;
    }
    if (/^\d+$/.test(scene)) {
      this._playNoticeById(Number(scene));
      return;
    }
    if (scene) {
      api.resolveScene({ scene }, { toast: false })
        .then(() => {
          const app = getApp();
          app.globalData.scene = scene;
          wx.reLaunch({ url: '/pages/bind/index' });
        })
        .catch(() => util.toast('无法识别的二维码'));
      return;
    }
    util.toast('无法识别的二维码');
  },

  _playNoticeById(noticeId) {
    api.noticeAudio({ noticeId }, { loading: '加载中' })
      .then((n) => {
        if (this._audio) this._audio.destroy();
        const a = wx.createInnerAudioContext();
        a.src = n.url;
        a.play();
        this._audio = a;
        this.setData({ playing: true });
        a.onEnded(() => { this.setData({ playing: false }); this._markRead(n.noticeId); });
        a.onError(() => { this.setData({ playing: false }); util.toast('播放失败'); });
        a.onStop(() => this.setData({ playing: false }));
        wx.showToast({ title: n.publisherName + ' 的语音通知', icon: 'none' });
      })
      .catch(() => {});
  },

  /* ---------------- 快捷入口 ---------------- */
  _fmtNotice(n) {
    if (!n) return null;
    const durSec = Math.round((Number(n.durationMs) || 0) / 1000);
    n.durationText = util.fmtDuration(durSec);
    return n;
  },

  /* goDuty 已随首页「本周值日」快捷入口一起下线：值日本来就有底部 Tab */
  goTimetable() { wx.switchTab({ url: '/pages/timetable/index' }); },

  goMine() { wx.switchTab({ url: '/pages/mine/index' }); },

  /** 成员与分组（管理员入口）：独立页，从「我的」迁出 */
  goRoster() { wx.navigateTo({ url: '/pages/roster/index' }); },

  /** 查看班级（超管 / 辅导员，多班级 §43 需求⑤） */
  goClasses() { wx.navigateTo({ url: '/pages/classes/index' }); },

  /** 查看通知（§41 需求⑦）：首页快捷入口，全员可见，避免绕到「我的」 */
  goNotice() {
    wx.navigateTo({
      url: '/pages/notice/index',
      fail: () => wx.switchTab({ url: '/pages/mine/index' })
    });
  },

  /* ---------------- 发布通知（管理员） ---------------- */
  /** 每次打开都重置表单：上一次填了一半的内容不该被下一次悄悄带上 */
  onNoticeOpen() {
    // 「班级管理」（2026-09-25 需求③ + §41 重构）：发布范围按身份不同
    //   · 班委：只能发同班 → 「本班成员」(ALL) 或「指定成员」(PICK，限本班)
    //   · 辅导员：可「班级发送」或「仅发班委」或「按职位」（可跨班），不开放任意 PICK
    //   · 超管：全体成员 / 指定成员 / 仅发班委 / 按职位（可跨班）
    const app = getApp();
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
    this.setData({
      noticeShow: true,
      noticeTitle: '', noticeContent: '', noticeLinkUrl: '', noticeLinkName: '', noticeImages: [],
      noticeLinkDetecting: false, noticeLinkError: '', noticeLinkHint: '',
      noticeScope: scope, noticeScopeItems: items, noticeNeedAck: false, noticePopup: false,
      noticeMembers: [], noticePick: {}, noticePickedCount: 0,
      noticePickAllA: false, noticePickAllB: false, noticeKw: '', noticeBusy: false,
      noticeClasses: [], noticeClassIds: [myClassId], noticeAllClasses: false, noticeClassPicked: {},
      noticeShowClasses: isCounselor,
      noticePositions: '', noticePosPresets: NOTICE_POSITION_PRESETS,
      noticePosPicked: {}, noticePosPickedCount: 0
    });
    // 仅辅导员可跨班发送：拉班级列表（默认只勾本班，列表回来后高亮本班）
    if (isCounselor) this._loadNoticeClasses();
  },
  onNoticeClose() { this.setData({ noticeShow: false }); },
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
        this.setData({ noticeBusy: false, noticeShow: false });
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

  /* ---------------- 提醒 ---------------- */
  /**
   * 微信通知：先要「订阅消息」授权（必须由点击触发），再顺手加手机日历。
   * 模板 ID 未配置（utils/config.js 为空）时只加日历，并如实提示。
   *
   * v0.7.15：悬浮胶囊有三种形态（见 index.wxml）——
   *   未开启 / 已开启但额度耗尽（remindBlock）/ 已开启且额度正常（隐藏）。
   * 「额度耗尽」分支走 `request()` 重新授权，成功后调 `remindReopen` 清掉后端标记。
   */
  onRemind() {
    if (this.data.remindBlock) {
      if (!subscribe.ready()) { util.toast('微信提醒待模板上线'); return; }
      subscribe.request().then((r) => {
        if (!r.ok) { util.toast('未授权成功，可稍后重试'); return; }
        api.remindReopen().catch(() => {}).then(() => {
          this.setData({ remindBlock: false });
          util.toast('已重新开启微信提醒');
        });
      });
      return;
    }
    if (this.data.remindOn) { util.toast('微信通知已打开'); return; }
    if (!subscribe.ready()) { this._enableRemind(true); return; }
    subscribe.request().then((r) => {
      if (!r.ok) { util.toast('未授权订阅消息，可在「我的」再试一次'); return; }
      this._enableRemind(false);
    });
  },

  /** 落地「已打开」：写 storage + 加手机重复日历（可选能力） */
  _enableRemind(noTemplate) {
    const hint = noTemplate ? '（微信提醒待模板上线）' : '';
    const done = (msg) => {
      wx.setStorageSync('remindOn', 1);
      this.setData({ remindOn: true });
      util.toast(msg + hint);
    };
    if (wx.addPhoneRepeatCalendar) {
      const start = Math.floor(Date.now() / 1000) + 86400;
      wx.addPhoneRepeatCalendar({
        title: '查看本周班级值日安排',
        startTime: start,
        endTime: start + 600,
        repeatInterval: 'week',
        repeatCount: 18,
        alarmOffset: 1800,
        success: () => done('已打开微信通知，并加入日历'),
        fail: () => done('已打开微信通知')
      });
    } else {
      done('已打开微信通知');
    }
  },

  /**
   * 测试提醒：向本人发一条值日提醒模板消息，弹窗回访「收到没」；
   * 没收到 / 发送失败则引导重新授权（详见 utils/subscribe.js runTest）。
   */
  onTestRemind() {
    if (this.data.remindBusy) return;
    this.setData({ remindBusy: true });
    subscribe.runTest(() => api.testRemind()).then(() => this.setData({ remindBusy: false }));
  },

  /* ---------------- 班费 / 团费（2026-10-14） ----------------
   * 卡片：班费全员可见；团费仅超管 / 班长兼团支书可见（首页左右一排两卡）。
   * 权限：班费管理 = 班长兼团支书 / 副班长 / 生活委员 / 超管；团费管理 = 班长兼团支书 / 超管。
   *       普通成员（及无管理职位的班委）班费卡仅展示、不可点开。
   * 总额设置：班费 = 超管 / 生活委员；团费 = 超管 / 班长兼团支书。
   * 图片：消费图片客户端直传云存储，提交时与金额一起上报 fileID；最多 9 张。 */
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
   * 调用点有三类：
   *   · onShow：每次进首页都拉（不受 load 的 STALE_MS 早退影响，见 onShow 注释）；
   *   · load() 的 .then：登录晚于 onShow 完成时补一次（那时 onShow 那次是未绑定态）；
   *   · 写操作之后（登记消费 / 删记录 / 点开弹层）：**强制**拉，跳过去重。
   * 前两类会连着各来一次，所以这里去重：请求中跳过、2s 内刚拉过跳过。
   * ⚠️ 写操作必须传 force —— 否则「刚提交完、2 秒内刚拉过」会被去重吃掉，看起来像没保存。
   * @param {boolean} [force] 强制刷新（跳过去重窗口）
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
    api.feeSummary({}, { toast: false })
      .then((r) => {
        const feeClass = this._fmtFund(r && r.class);
        const feeLeague = this._fmtFund(r && r.league);
        const patch = { feeClass, feeLeague };
        // 弹层打开时同步当前激活对象，避免余额 / 明细显示旧值
        if (this.data.feeShow) patch.feeActive = this.data.feeType === 'class' ? feeClass : feeLeague;
        this.setData(patch);
      })
      .catch(() => {})
      .then(() => { this._feeLoading = false; });
  },
  onFeeTap(e) {
    const type = e.currentTarget.dataset.type; // 'class' | 'league'
    const canManage = !!(type === 'class' ? this.data.feeCanManageClass : this.data.feeCanManageLeague);
    // 2026-10-15：班费/团费卡对所有已绑定成员可点。管理人 = 管理（可增删/补图）；
    // 其余成员 = view-only（仅查看，无法修改）。后端 getSummary 本就对所有成员返回，这里只是放开入口。
    const fund = type === 'class' ? this.data.feeClass : this.data.feeLeague;
    this.setData({
      feeShow: true,
      feeType: type,
      feeActiveName: type === 'class' ? '班费' : '团费',
      feeCanManage: canManage,
      feeActive: fund,
      // 每次点开都回到列表视图（上次停在表单视图的话，会把明细挤看不见）
      feeView: 'list',
      feeAmount: '',
      feeNote: '',
      feeImages: [],
      feeBusy: false
    });
    // 点开就拉一次最新值：别人（另一位班委）刚登记过消费时，卡片数据可能还是上一次 onShow 的
    this._loadFee(true);
  },
  onFeeClose() { this.setData({ feeShow: false, feeView: 'list' }); },
  /** 列表视图 → 表单视图（点「增加消费」） */
  onFeeAddOpen() {
    if (!this.data.feeCanManage) return; // 仅查看：不允许进表单
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
        this._loadFee(true); // 刷新明细，新图立即显示
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
  onFeePreviewImage(e) {
    const src = e.currentTarget.dataset.src;
    if (!src) return;
    if (src.indexOf('cloud://') === 0) {
      request.getTempFileURL([src]).then((map) => {
        const url = map && map[src];
        if (url) wx.previewImage({ urls: [url], current: url });
      }).catch(() => util.toast('图片预览失败'));
    } else {
      wx.previewImage({ urls: [src], current: src });
    }
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
        // 提交成功回到列表视图 —— 用户要看到刚记的那条进明细了，停在表单会以为没成功
        this.setData({ feeBusy: false, feeView: 'list', feeAmount: '', feeNote: '', feeImages: [] });
        // force：刚写完必须立刻拉新值，不能被「2 秒内刚拉过」的去重吃掉
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

  noop() {}
});
