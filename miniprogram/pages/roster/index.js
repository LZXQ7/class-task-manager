/**
 * P6 · 成员与分组（独立页，从「我的」迁出，仅管理员可见入口）
 * 包含：成员列表 + 详情 + 调组/启停/解绑 + 导入名单 + 增删成员 + 撤回导入
 * 调组/解绑按钮对「自己」一律隐藏（自保 §41 需求①）。
 * 多班级（§43）：可由「班级管理 → 查看人员」带 classId 进入，查看指定班级；
 *   不带参数则看本班（classId=0，后端 targetClassId 回退本班）。
 * 名单增强（2026-09-25）：
 *   · 导入支持任意列序（姓名,学号 / 学号,姓名 / 班级,学号,姓名,…）；带「班级」列时先预览、再确认；
 *   · 每次导入可「撤回」；超管 / 辅导员可单个「添加」「移出」成员。
 * v0.7.9（2026-09-26）：
 *   · 列表新增「仅班委」筛选（纯展示层，members 保持全量供详情查找）；
 *   · 详情新增「设为班委 / 改班委职位」（超管 + 辅导员），职位取值唯一来源 util.POSITIONS，
 *     落库走 member.setPosition（同时写 role=ADMIN）。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
/** 列表过渡（全班 ⇄ 仅班委）：机制/时长/两阶段 setData 全在该模块，三页共用一份 */
const listTransition = require('../../utils/list-transition');
/** 成员名单内存缓存（v0.7.32 问题①）：同班回访先用缓存渲染、再后台刷新（SWR） */
const mem = require('../../utils/mem');
const theme = require('../../utils/theme');
/** 直传云存储 / 取临时链接（请假条图片：前端直传绕开 VPC 慢下载，与通知配图同链路） */
const request = require('../../utils/request');

/** Date → 'YYYY-MM-DD'（本地时区；请假登记的原生 picker 取值格式） */
function ymd(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ============================================================
 * 请假时段：全天 / 上午 / 下午 / 晚上 四选一
 * ============================================================
 * 旧版是「全天」⇄「手动选两个 time picker」（leaveHalf + leaveStartTime +
 * leaveEndTime），用户实际反馈**两层都看不懂**：胶囊像状态标签不像能按的东西，
 * 「指定时段」是抽象词（用户脑子里是「我要请半天假」），而真要请半天的人
 * 只想说「上午」/「下午」，让他挑 08:00~12:00 是把内部结构漏给了用户。
 * 现在收敛成四选一，钟点**写死**（上午/下午 2026-10-09 定；晚上 2026-10-12 补）。
 *
 * ⚠️ 后端口径**完全不变**：start_time/end_time 仍是「区间内**每天**的相同时段」，
 *    两列都为空 = 整天。所以这是纯前端改动，不需要重新部署云函数
 *    （后端 `adjust.normTimePair` 只校验「成对 + 结束晚于开始」，18:00/21:00 天然合法）；
 *    值日标记逻辑也不动（半天假仍按整天标记，用户 2026-10-08 已反转过一次）。
 *
 * ⚠️ 加「晚上」时 **width 要一起给 segmented**：默认 320rpx 等分格，
 *    三档 107rpx/格 → 四档只剩 80rpx/格，「全天」两字在选中态（30rpx 字号）
 *    左右只剩 ~10rpx，会显挤。故 wxml 里显式给 width=440（每格 110rpx ≈ 原密度）。
 */
const LEAVE_SLOTS = [
  { key: 'all', label: '全天', start: '', end: '', hint: '整天请假' },
  { key: 'am', label: '上午', start: '08:00', end: '12:00', hint: '每天 08:00–12:00' },
  { key: 'pm', label: '下午', start: '13:00', end: '18:00', hint: '每天 13:00–18:00' },
  { key: 'eve', label: '晚上', start: '18:00', end: '21:00', hint: '每天 18:00–21:00' }
];
/** key → 档位；**唯一真源**，取不到时回落 all（全天）而不是崩 */
function slotOf(key) {
  return LEAVE_SLOTS.filter((s) => s.key === key)[0] || LEAVE_SLOTS[0];
}

/**
 * 历史记录里的时段反推成「上午/下午/晚上」显示（2026-10-09）。
 *
 * ⚠️ **按区间匹配而不是精确等于**：旧数据是用户手动输的任意钟点
 *    （如 08:30–11:30），精确等于匹配不上就会退回成「08:30–11:30」原文 ——
 *    那反而是对的。所以规则是：**命中某一档就用那一档的短标签，没命中就显示原文**。
 * 🔴 半天假也可能被误判：若将来出现跨档区间（如 08:00–18:00），它既不等于 am
 *    也不等于 pm ⇒ 会原样显示钟点，这是安全的（不会谎报成半个）。
 */
function slotLabel(startTime, endTime) {
  const s = String(startTime || '').slice(0, 5);
  const e = String(endTime || '').slice(0, 5);
  if (!s && !e) return '';
  for (let i = 1; i < LEAVE_SLOTS.length; i++) {
    const o = LEAVE_SLOTS[i];
    if (o.start && o.start === s && o.end === e) return o.label;
  }
  return s + '–' + e;
}

/**
 * 导入撤回窗口 = 导入后 **24 小时**（1.0.6 需求③：撤回入口只显示一天）。
 *
 * ⚠️ **前后端双拦**，这是刻意的：前端只负责「不显示」，过期后仍能绕过界面直接调
 *    云函数 ⇒ 真正的闸门必须在 `member.revertImport`（那里会按 created_at 再算一次）。
 *    后端 `importBatches` 已经下发了 `revertible`，直接采信；老后端没这个字段时
 *    才退回本地按 `createdAt` 算一次（只为过渡期，不是主路径）。
 * ⚠️ `createdAt` 是 MySQL 的 'YYYY-MM-DD HH:mm'，**不是 ISO**：`Date.parse` 在 iOS
 *    上对非 ISO 串的解析历来飘忽，所以手工拆字段构造本地 Date，不交给解析器。
 */
const REVERT_WINDOW_MS = 24 * 60 * 60 * 1000;
function batchRevertible(x) {
  if (!x || x.reverted) return false;
  if (typeof x.revertible === 'boolean') return x.revertible;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(x.createdAt || ''));
  if (!m) return false;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return isFinite(t) ? (Date.now() - t) <= REVERT_WINDOW_MS : false;
}

Page({
  data: {
    statusBarHeight: 20,
    /** 目标班级 id；0 = 本班（后端按生效身份回退） */
    classId: 0,
    navTitle: '成员与分组',
    /** 是否在查看别的班级 */
    otherClass: false,
    /** 超管 / 辅导员：可移出成员、停用、撤回导入（破坏性操作） */
    canManage: false,
    /**
     * 名册录入权（需求 D，2026-09-27）：超管 / 辅导员 / 班长兼团支书。
     * 覆盖「添加成员」「导入名单」「调至 A/B 组」——即**增改**，不含移出/撤回。
     * 取值来自 auth.login 的 canRosterEdit（单一来源，避免与后端判定漂移）。
     */
    canRosterEdit: false,
    /** 职位授予权（需求 D）：仅超管。「生活委员」「班长兼团支书」两个授权职位置灰的依据 */
    canGrantPosition: false,
    /** 管理员 / 超管：详情里「解除微信绑定」等按钮的显示依据 */
    isAdmin: false,
    isSuper: false,
    /** 辅导员（groupTag='X'）：与超管同享「看绑定状态 / 停用成员」权限（v0.7.19） */
    isCounselor: false,
    /** 成员备注（v0.7.16 需求⑦）：仅教职工 + 超管可见可写 */
    noteVisible: false,
    noteList: [],
    noteDraft: '',
    noteEditId: 0,
    noteBusy: false,
    /** 主页关注（v0.7.17 需求⑥，权限与备注同源）：当前这个人是否已被固定到主页 */
    pinVisible: false,
    pinned: false,
    pinBusy: false,
    pinCount: 0,
    pinLimit: 8,

    memberStats: null,
    members: [],
    /** 列表展示用的（可能是筛选后的）成员；`members` 始终保留全量，供详情查找 */
    viewMembers: [],
    /** 首屏成员列表是否已加载完成：加载中显示骨架，避免「没有匹配的成员」闪现（Req 3） */
    membersLoaded: false,
    /** 「仅班委」筛选开关（2026-09-26 需求①） */
    onlyCommittee: false,
    /** 班委人数（用于筛选 chip 上的角标） */
    committeeCount: 0,
    /** 全班已绑定微信人数（只在未搜索时统计，避免把搜索结果当全班）
     *  ⚠️ 初始 null 而不是 0（1.0.6 需求④）：卡片壳现在**常驻**，用 0 占位会让人
     *    误读成「一个人都没绑定」；null → wxml 显示 '—'，名单回来才填真值。 */
    boundCount: null,
    memberKw: '',
    mDetailShow: false,
    mDetail: null,
    /** 详情选中是否是自己；true 时调组/启停/解绑按钮一律隐藏 */
    mDetailIsSelf: false,

    /* 设置班委（超管 / 辅导员）：点开后在弹层里选具体职位 */
    posShow: false,
    /** [{ text, on }] —— on = 当前职位 */
    posList: [],
    posCurrent: '',
    /** 目标当前是否已是班委（决定是否显示「取消班委」） */
    posIsCommittee: false,

    importShow: false,
    importText: '',
    /** 'input' 粘贴阶段 → 'preview' 分组确认阶段 */
    importPhase: 'input',
    importBusy: false,
    importGroups: [],
    importClasses: [],
    importResult: null,
    lastBatch: null,
    /** 走的是 Excel 文件而不是粘贴文本 */
    importFromExcel: false,
    importFileId: '',
    importFileName: '',
    /** 缺失的班级自动新建（仅超管 / 辅导员可勾） */
    importCreateMissing: false,

    addShow: false,
    addName: '',
    addNo: '',
    addBusy: false,

    /* ---------- 1.0.5 需求④：请假登记（班委） ---------- */
    /** 请假登记权：超管 / 本班学生班委（来自 auth.login 的 canLeave，单一来源） */
    canLeave: false,
    /** 请假看板（后端 adjust.leaveBoard）：{ leave, leaveA, leaveB } + 前端算出的在位 */
    leaveStat: null,
    leaveShow: false,
    leaveList: [],
    /** 请假中查表：{ [memberId]: true } —— wxml 用 `leaveMap[item.id]` 判断（不动态改成员行，
     *  否则会被 _loadMembers 的异步回填覆盖） */
    leaveMap: {},
    /** 请假区间（YYYY-MM-DD）；打开弹层时默认今天 */
    leaveStart: '',
    leaveEnd: '',
    leaveKw: '',
    /** 选人列表（按搜索词过滤后的学生） */
    leaveCands: [],
    leaveBusy: false,
    /** 原生 picker 的日期上限（今天 + 一年），避免手滑选到很远的未来 */
    leaveMaxDate: '',
    /** 请假名单按 A/B 组拆分（顶部「请假人数」点击后只读查看用；登记弹层里也直接复用） */
    leaveListA: [],
    leaveListB: [],
    /** 辅导员只读名单弹层（辅导员只看不改，无撤销/登记） */
    leaveViewShow: false,
    leaveViewListA: [],
    leaveViewListB: [],

    /* ---------- 1.0.6 请假 v2：时段 / 历史 / 假条图片 ---------- */
    /** 登记弹层内切换：today（今日名单+登记） / history（历史请假，含已撤销） */
    leaveTab: 'today',
    /**
     * 请假时段档位（2026-10-09）：'all' | 'am' | 'pm'。
     * ⚠️ 取代了旧的 leaveHalf + leaveStartTime + leaveEndTime 三个字段 ——
     *    钟点已写死（见 LEAVE_SLOTS），不需要页面持有具体时分。
     */
    leaveSlot: 'all',
    /**
     * 时段档位的展示数组（2026-10-09）。
     * ⚠️ 写成 **data 里的常量数组**而不是在 wxml 里内联字面量：
     *    内联数组每次父级 setData 都会生成新对象 → segmented 的 observer 再响一次
     *    （见 components/segmented/index.js 头部注释，那会打断正在播的两拍动画）。
     * ⚠️ 字段名是 `text` 不是 `label`（segmented 的 items 契约是 [{key, text}]）。
     */
    leaveSlotOpts: LEAVE_SLOTS.map(s => ({ key: s.key, text: s.label })),
    /** 历史请假（后端 adjust.leaveHistory，倒序 300 条，含已撤销；筛选全在前端做） */
    leaveHistory: [],
    /**
     * 历史筛选 + 按日期分类（1.0.7）。
     *  · 日期筛选：日期区间（histFrom ~ histTo，'' = 不限）+ 快捷时段（histRange）
     *  · 人员搜索：histKw（姓名/学号模糊）
     *  · 人员筛选：histMembers（选中的 memberId 数组，多选；为空 = 全班）
     *  · 渲染产物：leaveHistGroups（按开始日期倒序分组的组数组），**不直接渲染 leaveHistory**
     * ⚠️ 筛选条件**不传给后端**：一次拉 300 条到本地算，改条件只重跑 _applyHistoryFilter()
     *    ⇒ 点一下就出结果、不等网络。后端 today 是「近 N 天」的日基准（前端自取日期会跨零点错开）。
     */
    histFrom: '',
    histTo: '',
    histRange: '',        // '' | '7' | '30'（与快捷胶囊对应；选了区间就清掉它）
    histKw: '',
    histMembers: [],
    /** 已选成员 id → true（给 WXML 查「这个人是不是已选」用；
     *  ⚠️ WXML 表达式**不支持方法调用**，`histMembers.indexOf(id)` 会运行期静默失效 ⇒ 必须在这里算好） */
    histPickedMap: {},
    /** 已选人员的胶囊回显：[{ id, name }]（名字回捞自本班名单，
     *  不存 histKw —— 搜索词和「已选人员」是两件事，混在一起清不干净） */
    histPickedNames: [],
    /** 人员搜索的候选（从本班 members 现算，未搜索时不显示） */
    histCands: [],
    histCandShow: false,
    /** 按开始日期倒序分组：[{ key, label, sub, count, items }] */
    leaveHistGroups: [],
    /** 筛选后的总条数（标题上的数字走它，不走 leaveHistory.length） */
    leaveHistCount: 0,
    /** 当前是否处于「已筛选」状态（清空按钮显隐 + 空态文案） */
    histAny: false,
    /** 生效的区间（快捷时段算出来的也要回显在 picker 上，否则胶囊和日期框对不上） */
    histFromShow: '',
    histToShow: '',
    /** 后端时钟今天（近 N 天的日基准，前端自取日期会跨零点错开一天） */
    histToday: '',
    /** fileID → 临时链接（一次批量换取，列表缩略图用；不逐个请求） */
    leaveImgUrls: {},
    /** 后端「此刻正在请假」的实时计数（在位统计唯一数据源，与日期口径的 stat 分开） */
    leaveNow: { leave: 0, leaveA: 0, leaveB: 0 },
    /**
     * 今日 ⇄ 历史 的内容切换方向（'' / 'r' / 'l'）：决定入场动画从哪一侧进来。
     * ⚠️ 它是**纯视觉**字段，不参与任何业务判断；切完由 `after` 那一拍清回 ''。
     *    不清会让「下次进弹层」误播一次动画（容器重建时 class 还在）。
     */
    leavePane: ''
  },

  onLoad(options) {
    const app = getApp();
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    const o = options || {};
    const classId = Number(o.classId) || 0;
    const name = o.name ? decodeURIComponent(o.name) : '';
    /** 首页「关注的学生」深链带过来的成员 id：名单加载完自动打开他的详情（见 _openPendingMember） */
    this._pendingOpenId = Number(o.openMemberId) || 0;
    /**
     * 首页请假弹层底部「需要撤销？去请假登记 ›」带过来的 openLeave=1（1.0.6）：
     * 落到本页后**自动打开请假弹层**，省掉「找班级 → 点请假人数 → 再点」这几跳。
     * ⚠️ 要等名单加载完再开（见 _openPendingLeave）：弹层里选人要用 members，
     *    而且 onLoad 阶段 canLeave 可能还没补齐（登录晚于 onLoad）。
     */
    this._pendingOpenLeave = String(o.openLeave || '') === '1';
    const p = (app && app.globalData && app.globalData.profile) || null;
    const isSuper = !!(app && app.isSuper && app.isSuper());
    const canManage = isSuper || !!(p && p.groupTag === 'X');
    const canRosterEdit = !!(app && app.canRosterEdit && app.canRosterEdit());
    const canGrantPosition = !!(app && app.canGrantPosition && app.canGrantPosition());
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      classId,
      otherClass: classId > 0,
      canManage,
      canRosterEdit,
      canGrantPosition,
      isSuper,
      isCounselor: !!(p && p.groupTag === 'X'),
      isAdmin: !!(app && app.isAdmin && app.isAdmin()),
      canLeave: !!(app && app.canLeave && app.canLeave()),
      navTitle: name ? (name + ' · 成员') : '成员与分组'
    });
    // 登录可能晚于 onLoad 完成：就绪后补一次身份，否则超管首屏看不到「解除微信绑定」
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        const p2 = (app.globalData && app.globalData.profile) || null;
        const s2 = !!(app.isSuper && app.isSuper());
        this.setData({
          isSuper: s2,
          isCounselor: !!(p2 && p2.groupTag === 'X'),
          isAdmin: !!(app.isAdmin && app.isAdmin()),
          canManage: s2 || !!(p2 && p2.groupTag === 'X'),
          canRosterEdit: !!(app.canRosterEdit && app.canRosterEdit()),
          canGrantPosition: !!(app.canGrantPosition && app.canGrantPosition()),
          canLeave: !!(app.canLeave && app.canLeave())
        }, () => {
          // ⚠️ 登录晚于 onLoad 完成时：onLoad/onShow 里那两次 _loadLeaveBoard 都会因为
          //    canLeave 还没算出来而直接 return —— 必须在这里补拉一次，
          //    否则班委首屏会看到「请假」入口却没有第二行统计（要退出重进才出现）。
          this._loadLeaveBoard();
        });
      });
    }
    this._loadStats();
    this._loadMembers();
    this._loadLeaveBoard();
    // ⚠️ v0.7.32 问题①：`class.list`（导入预览的选班）与 `importBatches`（撤回导入）
    //    **只在「导入名单」弹层里用到**，不再在进页面时发 —— 否则首屏要并发 5 个云函数
    //    （每个都可能有冷启动）。改到 onImportOpen 打开弹层时才拉。
  },

  onShow() {
    // 从详情回来时实时刷新统计
    this._loadStats();
    this._loadLeaveBoard();
  },

  /** 全班 ⇄ 仅班委的过渡链在页面销毁后不该继续（guard 见 _applyFilter） */
  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅
    this._ltToken = (this._ltToken || 0) + 1;
  },

  /** 统一的入参：带上目标班级（0 = 本班） */
  _payload(extra) {
    return Object.assign({ classId: this.data.classId }, extra || {});
  },

  _loadStats() {
    api.memberStats(this._payload(), { toast: false })
      .then((r) => this.setData({ memberStats: r }, () => this._applyLeaveStat()))
      .catch(() => {});
  },

  /* ================= 1.0.5 需求④：请假登记（班委） =================
   * 权限 = 超管 / 本班学生班委（后端 guard.requireLeaveRegister 真拦；前端只控制入口显隐）。
   * 口径：按**日期区间**登记；区间内已排的值日会被置「已请假」；可撤销并恢复值日。
   * 「在位人数」= 名册人数 − 当天请假人数（A/B 组同理）—— 两个数同源，不各自算一套。
   */

  /** 拉今日请假看板（名单 + 计数），并回填「请假中」查表
   *  权限：canLeave（班委/超管）或 isCounselor（辅导员只读）—— 辅导员也要看本班请假人数
   *  loud：用户**主动**打开登记/名单时传 true → 失败走 toast；页面加载/onShow 的静默刷新传空。 */
  _loadLeaveBoard(loud) {
    if (!this.data.canLeave && !this.data.isCounselor) return;
    api.leaveBoard(this._payload(), { toast: false })
      .then((r) => {
        const raw = (r && r.list) || [];
        const list = this._sanitizeLeaveRows(raw);
        this._applyLeaveRows(list, (r && r.stat) || {}, raw.length - list.length);
      })
      .catch((err) => { if (loud) util.toast((err && err.errMsg) || '请假名单加载失败，请重试'); });
  },

  /**
   * 历史请假（1.0.6）：**含已撤销**，倒序 300 条。
   * 权限 = 后端 requireLeaveView（班委 / 超管 / 辅导员都能看，辅导员只读）。
   * 状态由后端现算（进行中 / 已结束 / 已撤销 / 未开始），这里只补展示文案。
   * ⚠️ 筛选/分组**不在这里做**，全部交给 _applyHistoryFilter()（纯函数，同一份数据
   *    既是数据源也是渲染源 ⇒ 不会出现「列表显示的和筛出来的不一致」）。
   */
  _loadLeaveHistory(loud) {
    if (!this.data.canLeave && !this.data.isCounselor) return;
    api.leaveHistory(this._payload(), { toast: false })
      .then((r) => {
        const list = (r && r.list) || [];
        const stateText = {
          ONGOING: '进行中', ENDED: '已结束', CANCELLED: '已撤销', UPCOMING: '未开始'
        };
        const rows = list.map((x) => Object.assign({}, x, {
          stateText: stateText[x.state] || '',
          // 归档角标：假条图片进入「N 天清除」倒计时才显示。
          // ⚠️ 2026-10-09：原文案「N 天后清除」太宽（用户实拍），胶囊没有 max-width
          //    ⇒ 随文案无限撑开，把右侧假条缩略图挤到边上。改短为「N 天清除」。
          clearText: (x.imageArchived && x.clearInDays != null)
            ? (x.clearInDays > 0 ? (x.clearInDays + ' 天清除') : '即将清除')
            : '',
          // 历史行的时段短标签（上午/下午；旧数据是任意钟点，匹配不上就回原文）
          slotText: slotLabel(x.startTime, x.endTime)
        }));
        this.setData({ leaveHistory: rows, histToday: (r && r.today) || '' }, () => {
          this._applyHistoryFilter();
          this._refreshLeaveImageUrls();
          this._resizeLeaveSheet();
        });
      })
      .catch((err) => { if (loud) util.toast((err && err.errMsg) || '历史记录加载失败，请重试'); });
  },

  /**
   * 删除一条**已撤销**的历史请假记录（2026-10-09 需求）。
   *
   * ⚠️ 不可恢复，所以**必须走二次确认**（`util.confirmStrict`，不是 confirm）——
   *    这是破坏性操作，且是「清掉一条已撤销的记录」这种用户可能手滑的操作。
   *    文案要说清「连带假条照片一起删」，否则用户以为只是从列表里消失。
   *    ⚠️ `confirmStrict(content, title)` 返回 **Promise<'confirm'|'cancel'|'fail'>**，
   *    **不是回调** —— 传成回调则永远进不了删除分支（点了没反应且不报错）。
   *    ⚠️ 参数顺序 = (内容, 标题)，别写反。
   *
   * ⚠️ 删除后**重拉而不是本地 splice**：
   *    历史列表是按 `start_date DESC, RIGHT(student_no,2) DESC, id DESC` 分组渲染的
   *    （`_applyHistoryFilter` 里按 `start_date` 建组），本地 splice 掉一行之后
   *    组头人数 / 空组 / 筛选结果都要重算 —— 那是 `_applyHistoryFilter` 的活。
   *    宁可多一次请求，也不要在前端重算一遍分组逻辑（两处必然漂移）。
   *    ⚠️ 但也不能只 `setData({leaveHistory: …})`：那样**组头人数会与实际行数不符**
   *    ⇒ 必须重跑 `_applyHistoryFilter`。
   */
  onHistDelete(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const row = (this.data.leaveHistory || []).find((x) => Number(x.leaveId) === id);
    if (!row) return;
    // 🔴 判据极性 = 「**只有已撤销能删**」。这里先挡一道（后端也会拒），
    //    双保险的意义是：用户点了没反应会以为坏了，而这里能给出明确原因。
    if (row.state !== 'CANCELLED') { util.toast('只能删除已撤销的记录'); return; }
    const who = row.name || '该同学';
    const extra = row.hasImage ? '\n（假条照片会一并删除，不可恢复）' : '';
    util.confirmStrict(
      '将删除「' + who + ' ' + (row.startDate || '') + '」这条**已撤销**的记录' + extra + '。\n删除后无法恢复。',
      '删除已撤销的请假'
    ).then((r) => { if (r === 'confirm') this._doHistDelete(id); });
  },

  /** 真删：确认后调后端 → 重拉历史（连带重算分组与筛选） */
  _doHistDelete(id) {
    // 先取出这条的 image（清临时链接缓存用）。⚠️ **必须在重拉之前**取 ——
    //   重拉后 leaveHistory 已被替换，那时再找就找不到这条了。
    const row = (this.data.leaveHistory || []).find((x) => Number(x.leaveId) === id);
    const img = row && row.image;
    api.leaveDelete({ leaveId: id }, { loading: '删除中' })
      .then(() => {
        util.toast('已删除');
        // 假条缩略图的临时链接缓存里那一条也要清掉（缓存真源是 `leaveImgUrls` ——
        // 今日名单与历史**共用同一份**，所以字段名不是 histImgUrls，别自造）。
        if (img) {
          const urls = Object.assign({}, this.data.leaveImgUrls || {});
          delete urls[img];
          this.setData({ leaveImgUrls: urls });
        }
        this._loadLeaveHistory(false);
      })
      .catch((err) => {
        util.toast((err && err.errMsg) || '删除失败，请重试');
        // 失败也要重拉：后端可能已经删成功但响应丢了 ⇒ 让列表回到真实状态
        this._loadLeaveHistory(false);
      });
  },

  /**
   * 人员搜索的统一口径（**筛选与候选列表共用**，两边漂移就会出现「候选里有、结果里没有」）。
   * 三路**有序**匹配，命中即止：
   *   1. 姓名模糊 —— 「张」能捞出「张三」
   *   2. 短学号：补零归一后**整段相等** —— 「01」「1」都能捞出序号 01 那个人
   *   3. 全学号模糊，**仅当输入 ≥ 4 位** —— 「20260101」能捞出一批
   * ⚠️ 为什么短学号要**整段相等**、且第 3 路要**限长**：
   *    学号本身就含序号（2026010101 里就有 '01'）。若第 2 路用子串、或第 3 路不限长，
   *    「搜 01」会把全班都捞出来 —— 短学号这个入口等于废了。
   *    限 4 位是因为：真正的学号片段至少 4 位才有区分度，2~3 位片段（如 '260'）
   *    与短学号语义重叠、区分度太低，宁可让用户直接点候选。
   *
   * 🔴 2026-10-09 修「1 号只能搜 01、不能搜 1」（用户实拍）：`seq` 是 `pad2`
   *    补过零的（1 号 => '01'），所以 `sq === kw` 这种**字面相等**在输 '1' 时必然不成立。
   *    ⇒ 第 2 路改成**先归一去零再比**（'1'/'01'/'001' 都归一为 '1'），**整段相等仍然保留**。
   *    ⚠️ 绝不能改成「输1 就子串匹配」—— 那会重演「搜 01 把全班捞出来」的老坑
   *    （1/10/11/21… 全部命中）。归一 + 整段相等才是「1 号就是 1 号」。
   */
  _histMatch(name, seq, studentNo, q) {
    const nm = String(name || '').toLowerCase();
    const sq = String(seq || '');
    const sno = String(studentNo || '').toLowerCase();
    const kw = String(q || '').trim().toLowerCase();
    if (!kw) return true;
    if (nm.indexOf(kw) >= 0) return true;
    // 短学号：两侧都「去前导零」后比（'01'/'1'/'001' ⇒ '1'）。
    // ⚠️ 只有纯数字输入才归一 —— 「0abc」这种不该被当成学号比。
    const nz = (v) => (/^\d+$/.test(v) ? String(Number(v)) : v);
    if (nz(sq) === nz(kw)) return true;
    return kw.length >= 4 && sno.indexOf(kw) >= 0;
  },

  /* ================= 1.0.7 历史请假：筛选 + 按日期分类 =================
   * 口径（用户定）：
   *   · 日期分类键 = **开始日期 start_date**（不是每一天都展开）—— 跨天假只在它开始
   *     那天出现一次，行内已经写了「startDate ~ endDate」，够看清跨度；按天展开会让
   *     3 天假在列表里占 3 行、还多出「这不是他请的假」的错觉。
   *   · 区间筛选用**开始日期**判（start_date >= from && start_date <= to），
   *     与分类键同口径 —— 不然会出现「筛出的一组却在组外」的割裂。
   *   · 全部在前端算：改条件只重跑本方法，不发请求。
   */

  /** 筛选是否处于「全开」状态（决定清空按钮显隐 + 空态文案） */
  _historyFiltered() {
    const d = this.data;
    return !!(d.histRange || d.histKw || d.histMembers.length || d.histFrom || d.histTo);
  },

  /**
   * 纯计算：筛选 → 按开始日期分组。写成一个方法而不是散在 WXML 里，
   * 是为了让「分组」和「筛选」共用同一份中间数组（不会出现两处口径打架）。
   */
  _applyHistoryFilter() {
    const d = this.data;
    const all = d.leaveHistory || [];
    const today = d.histToday || util.todayStr();

    // ① 快捷时段 → 换算成区间起止（近 N 天含今天，故 from = today - (N-1)）
    let from = String(d.histFrom || '');
    let to = String(d.histTo || '');
    if (d.histRange) {
      const n = Number(d.histRange) || 0;
      if (n > 0) {
        to = today;
        from = util.dateAddDays(today, -(n - 1));
      }
    }
    const kw = String(d.histKw || '').trim().toLowerCase();
    const picked = d.histMembers || [];

    const rows = all.filter((x) => {
      // 日期区间（按开始日期，与分类键同口径）
      if (from && x.startDate < from) return false;
      if (to && x.startDate > to) return false;
      // 人员筛选（多选）
      if (picked.length && picked.indexOf(Number(x.memberId)) < 0) return false;
      // 人员搜索（口径见 _histMatch：姓名模糊 / 短学号整段相等 / 全学号模糊）
      if (kw && !this._histMatch(x.name, x.seq, x.studentNo, kw)) return false;
      return true;
    });

    // ② 按开始日期分组（all 已按 start_date DESC 排 ⇒ 组序天然倒序，组内保序）
    const map = {};
    const order = [];
    rows.forEach((x) => {
      const k = x.startDate || '';
      if (!map[k]) { map[k] = []; order.push(k); }
      map[k].push(x);
    });
    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    // 组内逐条装饰「行内日期文本」：同一组里不同人的 endDate 可以不同
    //（09-29 有人请到 09-30、有人只请 09-29），所以**不能按组算一个 sub** ——
    // 必须逐条算，否则整组会显示成同一个范围。
    const groups = order.map((k) => ({
      key: k,
      label: this._histDateLabel(k, today),
      count: map[k].length,
      items: map[k].map((x) => Object.assign({}, x, {
        subText: this._histSub(x.startDate, x.endDate)
      }))
    }));

    // 选中态查表（WXML 不能调方法，见 data.histPickedMap 注释）
    const pickedMap = {};
    picked.forEach((id) => { pickedMap[id] = true; });
    // 胶囊回显：名字从**本班名单**回捞（selected 行本身就是班内数据，但走名单更稳，
    //  名单里改名了也不会显示旧名）
    const roster = this.data.members || [];
    const pickedNames = picked.map((pid) => {
      const hit = roster.filter((m) => Number(m.id) === pid)[0];
      return { id: pid, name: hit ? (hit.name + (hit.seq ? ' ' + hit.seq : '')) : ('#' + pid) };
    });

    this.setData({
      histFromShow: from,
      histToShow: to,
      histPickedMap: pickedMap,
      histPickedNames: pickedNames,
      leaveHistGroups: groups,
      leaveHistCount: rows.length,
      histAny: this._historyFiltered()
    }, () => { this._resizeLeaveSheet(); });
  },

  /** 「10月8日 周三」；跨年的补年份。今天标「今天」、昨天标「昨天」。 */
  _histDateLabel(ds, today) {
    if (!ds) return '';
    if (ds === today) return '今天 · ' + this._histWeekday(ds);
    const y = util.dateAddDays(today, -1);
    if (ds === y) return '昨天 · ' + this._histWeekday(ds);
    const p = ds.split('-');
    const label = (Number(p[1]) || 0) + '月' + (Number(p[2]) || 0) + '日';
    return (Number(p[0]) !== Number(today.slice(0, 4)) ? p[0] + '年' : '') + label + ' ' + this._histWeekday(ds);
  },

  /** 星期几（本地解析，避开new Date('yyyy-MM-dd') 的 UTC 偏移坑） */
  _histWeekday(ds) {
    const p = String(ds || '').split('-');
    if (p.length < 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  },

  /**
   * 行内日期文本：**去掉年份**（组头已经写了完整日期，年份重复一遍只是噪音）。
   * 单日假 = 「10-08」；跨天假 = 「09-29 ~ 09-30」。
   * 跨年时结束日期带上年份（09-29 ~ 2027-01-03，否则「今年9月29日到1月3日」读不出跨年）。
   */
  _histSub(startDate, endDate) {
    const md = (ds) => {
      const p = String(ds || '').split('-');
      if (p.length < 3) return String(ds || '');
      return (Number(p[1]) || 0) + '-' + (p[2].length < 2 ? '0' + p[2] : p[2]);
    };
    const s = md(startDate);
    const e = md(endDate);
    if (!e || e === s) return s;
    const sy = String(startDate || '').slice(0, 4);
    const ey = String(endDate || '').slice(0, 4);
    return s + ' ~ ' + (sy !== ey ? endDate : e);
  },

  /* ---------- 筛选交互 ---------- */

  /**
   * 快捷时段：读 `<segmented>` 的 change 事件（只带 { key }，见组件契约）。
   * ⚠️ key 用 'all' 表示「全部」而不是空串 —— segmented 的 value 是 String 属性，
   *    空串会让组件找不到匹配项而回落到第 0 格（虽然结果相同，但指示器两拍动画
   *    会从「上一格」的位置算起，方向可能反）。'all' ↔ '' 的映射只在这一处发生。
   * ⚠️ segmented 内部 `key === value` 时直接 return ⇒ **单选不可取消**（不再支持
   *    「再点一次退回全部」）；要清空走 .lv-clear / 搜索框 × /「全部」格。
   */
  onHistRangeTap(e) {
    const k = String((e.detail && e.detail.key) || '');
    this.setData({ histRange: k === 'all' ? '' : k }, () => this._applyHistoryFilter());
  },

  /** 日期区间：picker 改值 */
  onHistFromChange(e) {
    this.setData({ histFrom: e.detail.value, histRange: '' }, () => this._applyHistoryFilter());
  },
  onHistToChange(e) {
    this.setData({ histTo: e.detail.value, histRange: '' }, () => this._applyHistoryFilter());
  },

  /** 清空全部筛选（人员多选 / 搜索词 / 日期区间 / 快捷时段一起清） */
  onHistClear() {
    this.setData({
      histFrom: '', histTo: '', histRange: '', histKw: '',
      histMembers: [], histCands: [], histCandShow: false
    }, () => this._applyHistoryFilter());
  },

  /** 人员搜索：出/收候选面板 */
  onHistSearchInput(e) {
    const kw = String(e.detail.value || '');
    this.setData({ histKw: kw }, () => this._applyHistoryFilter());
    const q = kw.trim().toLowerCase();
    if (!q) { this.setData({ histCands: [], histCandShow: false }); return; }
    const cands = (this.data.members || [])
      .filter((m) => this._histMatch(m.name, m.seq, m.studentNo, q))
      .slice(0, 20)
      .map((m) => ({ id: m.id, name: m.name, seq: m.seq || '' }));
    this.setData({ histCands: cands, histCandShow: true });
  },

  /** 点候选 = 切换选中（多选）；选中后收候选面板、清搜索词（由胶囊回显已选） */
  onHistCandTap(e) {
    const id = Number(e.currentTarget.dataset.id);
    const cur = (this.data.histMembers || []).slice();
    const picked = cur.indexOf(id) >= 0 ? cur.filter((x) => x !== id) : cur.concat([id]);
    this.setData({
      histMembers: picked,
      histKw: '',
      histCands: [],
      histCandShow: false
    }, () => this._applyHistoryFilter());
  },

  /** 清掉某个已选人员（筛选条上的胶囊 ×） */
  onHistMemberRemove(e) {
    const id = Number(e.currentTarget.dataset.id);
    const picked = (this.data.histMembers || []).filter((x) => x !== id);
    this.setData({ histMembers: picked }, () => this._applyHistoryFilter());
  },

/**
 * 本地时钟 HH:mm —— **已改为 `util.clockNow()`**（2026-10-09）。
 * ⚠️ 原先是本页私有副本，与首页各写一份；请假「实时口径」要在两个页面用
 *    （首页卡片数字按时段翻面 / 本页今日在位与名单）⇒ 两份必然漂移，
 *    漂移的后果是「首页说他在请假、名单里说他不在」。
 *    保留这个薄封装只是为了让本页现有调用点（`_clockNow()`）不用改。
 */
_clockNow() {
  return util.clockNow();
},

  /**
   * 批量换临时链接：把今日名单 + 历史里的假条 fileID 一次换完（不逐个请求）。
   * 云存储 fileID 默认「所有用户可读」，所以前端可直接换链预览。
   */
  _refreshLeaveImageUrls() {
    const ids = [];
    const push = (x) => { if (x && x.image && ids.indexOf(x.image) < 0) ids.push(x.image); };
    (this.data.leaveList || []).forEach(push);
    (this.data.leaveHistory || []).forEach(push);
    (this.data.leaveViewListA || []).forEach(push);
    (this.data.leaveViewListB || []).forEach(push);
    if (!ids.length) return;
    request.getTempFileURL(ids)
      .then((map) => {
        const cur = this.data.leaveImgUrls || {};
        this.setData({ leaveImgUrls: Object.assign({}, cur, map || {}) });
      })
      .catch(() => {});
  },

  /**
   * 把（可能已过滤的）请假行落到 data。
   * dropped>0 表示**过滤掉了不属于本班的行** → stat 必须按过滤后的行重算，
   * 否则「请假人数」还会是后端那份（串班的）数字。
   */
  _applyLeaveRows(list, backendStat, dropped) {
    // ⚠️ 2026-09起所有请假行都补一个 `slotText`（WXML **不能调方法**，
    //    所以「上午/下午」的反推必须在 JS 里算好）。在这里补一次，
    //    下面 leaveListA / leaveListB 是从 list 派生的，会自动继承。
    list = (list || []).map(x => Object.assign({}, x, {
      slotText: slotLabel(x.startTime, x.endTime)
    }));
    // ⚠️⚠️ `leaveMap`（「请假中」标签）必须用**实时口径**，不是日期口径（2026-10-09 用户实拍）：
    //    原来这里直接 `list.forEach(x => map[x.memberId] = true)` —— `list` 是**日期口径全列**
    //    （含已过时段的半天假）⇒ 郝鹏杰上午 08:00-12:00 的假，到19:26 仍显示「请假中」。
    //    这与同一文件下面的口径分层注释（「stat/list = 日期口径」「leaveNow = 实时口径」）**自相矛盾**：
    //    顶部「在位统计」用实时（显示他不在假里），行尾标签却用日期（说他还在假）⇒ 两处打架。
    //    ⇒ 改成用下面那个 `nowList`（实时）来填；`nowList` 必须在填 map **之前**算出来。
    const clock = this._clockNow();
    // 整天假（无时段）恒算「在请假」；半天假则要求此刻落在时段内。
    const nowList = list.filter(x => (!x.startTime || !x.endTime) ? true : (clock >= x.startTime && clock <= x.endTime));
    const map = {};
    nowList.forEach(x => { map[x.memberId] = true; });
    const st = backendStat || {};
    const stat = dropped
      ? {
        leave: list.length,
        leaveA: list.filter(x => x.groupTag === 'A').length,
        leaveB: list.filter(x => x.groupTag === 'B').length
      }
      : {
        leave: st.leave != null ? st.leave : list.length,
        leaveA: st.leaveA != null ? st.leaveA : list.filter(x => x.groupTag === 'A').length,
        leaveB: st.leaveB != null ? st.leaveB : list.filter(x => x.groupTag === 'B').length
      };
    /* ⚠️ 口径分层（2026-10-08 定，别再合并）：
     *   · stat / list   = **日期口径**：今天有生效请假的全列（含已过时段的半天假）
     *                     → 弹层「今日请假 · N 人」与名单行数同源，数字恒等于行数；
     *   · leaveNow      = **实时口径**：此刻真在请假时段内的人
     *                     → 只给顶部「在位统计」用（在位 = 名册 − leaveNow）。
     * ⚠️ 实时计数**从过滤后的 list 现算**，不用后端那份 —— 否则串班过滤掉行之后，
     *    两个口径又对不上（本项目「数字 ≠ 明细条数」的旧伤不能复发）。
     * ⚠️ `clock` / `nowList` 已在上面算好（为了先填 `leaveMap`）——
     *    重复 `const` 声明会直接抛 SyntaxError，别再加第二份。 */
    this.setData({
      leaveList: list,
      leaveListA: list.filter(x => x.groupTag === 'A'),
      leaveListB: list.filter(x => x.groupTag === 'B'),
      leaveMap: map,
      leaveStat: Object.assign({ leave: 0, leaveA: 0, leaveB: 0, onAll: 0, onA: 0, onB: 0 }, stat),
      leaveCands: this._leaveFilter(this.data.leaveKw, this.data.members),
      leaveNow: {
        leave: nowList.length,
        leaveA: nowList.filter(x => x.groupTag === 'A').length,
        leaveB: nowList.filter(x => x.groupTag === 'B').length
      }
    }, () => { this._applyLeaveStat(); this._refreshLeaveImageUrls(); this._resizeLeaveSheet(); });
  },

  /**
   * **只保留本班成员**的请假行（v0.7.32 兜底，防跨班串号）。
   * 背景：云端 `adjust.leaveBoard` 曾出现「忽略传入班级、恒按调用者自己的班查」的旧版 ——
   * 超管查看别班时会把**本班**的请假名单端出来（用户实拍：示例班级C显示 示例班级A 的 8 人，
   * 点开「请假登记」名单里也是 示例班级A 的人）。这里用**本班名单**（`member.list` 的返回，
   * 它按班过滤是正确的）做一次交叉过滤：名单里没有的人一律剔除。
   * ⚠️ 只在**成员搜索为空**时启用 —— 搜索态下 `this.data.members` 是子集，过滤会误删。
   */
  _sanitizeLeaveRows(rows) {
    const kw = String(this.data.memberKw || '').trim();
    const members = this.data.members || [];
    if (kw || !members.length) return rows;
    const ids = {};
    members.forEach(m => { ids[m.id] = true; });
    return rows.filter(r => ids[r.memberId]);
  },

  /** 成员名单到齐（或搜索清空）后，对已渲染的请假名单再过滤一次（处理两者到达顺序的竞态） */
  _resanitizeLeave() {
    const cur = this.data.leaveList || [];
    if (!cur.length) return;
    const keep = this._sanitizeLeaveRows(cur);
    if (keep.length === cur.length) return;
    this._applyLeaveRows(keep, null, cur.length - keep.length);
  },

  /**
   * 在位人数 = 名册人数 − **此刻**请假人数（A/B 组同理）。
   * ⚠️ 这张「今日在位」卡整卡走**实时口径**（请假人数与在位人数必须加减自洽），
   *    与弹层「今日请假」名单的日期口径是两套，不要互相套用（2026-10-08 口径分层）。
   */
  _applyLeaveStat() {
    const st = this.data.memberStats;
    const lv = this.data.leaveStat;
    if (!st || !lv) return;
    const nw = this.data.leaveNow || { leave: 0, leaveA: 0, leaveB: 0 };
    const leave = nw.leave || 0;
    const leaveA = nw.leaveA || 0;
    const leaveB = nw.leaveB || 0;
    this.setData({
      leaveStat: {
        leave,
        leaveA,
        leaveB,
        onAll: Math.max(0, (st.total || 0) - leave),
        onA: Math.max(0, (st.groupA || 0) - leaveA),
        onB: Math.max(0, (st.groupB || 0) - leaveB)
      }
    });
  },

  /** 选人候选：本班在读**学生**（排除教职工 X 组），按姓名/序号/学号过滤 */
  _leaveFilter(kw, rows) {
    const k = String(kw || '').trim().toLowerCase();
    return (rows || [])
      .filter(m => m.groupTag !== 'X')
      .filter(m => !k
        || String(m.name || '').toLowerCase().indexOf(k) >= 0
        || String(m.seq || '').indexOf(k) === 0
        || String(m.studentNo || '').indexOf(k) >= 0)
      .slice(0, 200);
  },

  onLeaveOpen() {
    const now = new Date();
    const today = ymd(now);
    this.setData({
      leaveShow: true,
      leaveTab: 'today',
      // 开弹层一律从「今日」进，方向类必须清干净（否则会误播一次入场动画）
      leavePane: '',
      leaveStart: today,
      leaveEnd: today,
      leaveKw: '',
      // 时段每次开弹层都回落到「全天」（2026-10-09：旧版残留的 leaveHalf/时分一并删掉）
      leaveSlot: 'all',
      leaveMaxDate: ymd(new Date(now.getFullYear() + 1, now.getMonth(), now.getDate())),
      leaveCands: this._leaveFilter('', this.data.members)
    });
    this._loadLeaveBoard(true);
    this._loadLeaveHistory();
  },

  /**
   * 今日 / 历史 切换（切到历史时才拉，避免每次开弹层都多一个请求）。
   *
   * ⚠️ 事件契约：`<segmented>` 抛的是 `triggerEvent('change', { key })`，
   *    **必须读 `e.detail.key`**。读 `.value`（或 `dataset.t`）只会拿到 undefined，
   *    表现就是「点了没反应」——首页「查看名单」那个坑就是这么来的。
   *
   * 为什么是「方向性淡入」而不是值日页「按日/按人」那套 FLIP：
   *   FLIP 能算位移的前提是「同一批对象在旧布局里有参照位置」；今日与历史是
   *   **两份完全不同的数据**（leaveList / leaveHistory），没有共同的 key 可比对，
   *   量不出位移。所以只能给**新板块**做入场。
   *   ⚠️ 旧内容**不做淡出**：`wx:if` 一换旧节点当场卸载，那段淡出根本播不到，
   *      只是白白把切换拖晚 100ms。方向性入场本身已经说清了「往哪边走」。
   */
  onLeaveTab(e) {
    // ⚠️ 必须字面写成 `e.detail.key`：scripts/check-segmented.js 的判据就是
    //    在 handler 体里找 `\.detail\.key`。写成 `(e.detail || {}).key` 虽然等价，
    //    但门禁扫不到（实测误报「handler 未使用 e.detail.key」）。
    const key = e.detail ? e.detail.key : '';
    if (!key) return;
    const t = key === 'history' ? 'history' : 'today';
    if (this.data.leaveTab === t) return;
    // 方向：历史在右（从右边进来）、今日在左（从左边进来）
    const dir = t === 'history' ? 'r' : 'l';
    // 开了系统「减弱动态效果」就只换数据、不写方向类（因此不播动画）
    const patch = listTransition.reduced()
      ? { leaveTab: t, leavePane: '' }
      : { leaveTab: t, leavePane: dir };
    this.setData(patch, () => {
      // ① 置顶：两个板块高度差很大，滚到底再切过去会看到一片空白
      //    ⚠️ 先置顶、再 resize（顺序反了会量到旧内容的高度）
      const sel = this.data.leaveViewShow ? '#leaveViewSheet' : '#leaveSheet';
      const sheet = this.selectComponent(sel);
      if (sheet && sheet.scrollTop) sheet.scrollTop();
      if (sheet && sheet.resizeScroll) sheet.resizeScroll();
      // ② 播完把方向类清掉：不清的话下次开弹层容器重建时 class 还在，会误播一次
      if (!patch.leavePane) return;
      setTimeout(() => {
        if (this.data.leavePane === dir) this.setData({ leavePane: '' });
      }, listTransition.MS.IN + listTransition.FRAME_MS);
    });
    if (t === 'history') this._loadLeaveHistory(true);
  },

  /**
   * 请假时段 = **全天 / 上午 / 下午 三选一**（2026-10-09）。
   *
   * ⚠️ 取代了旧的三件套（onLeaveTimeOpen / onLeaveAllDay / onLeaveTime + 两个 time
   *    picker）。用户对旧版的评价是「很多人用不明白」：胶囊长得像状态标签、
   *    「指定时段」是抽象词，而真要请半天的人只想说「上午」/「下午」。
   *    钟点写死（见 LEAVE_SLOTS），所以这里只剩「记住选了哪一档」。
   *
   * ⚠️ `<segmented>` 的事件契约是 `triggerEvent('change', { key })` ——
   *    **必须读 `e.detail.key`**。读 `.value` / `currentTarget.dataset` 只会拿到 undefined，
   *    表现就是「点了没反应」（首页「查看名单」那个坑就是这么来的；门禁
   *    scripts/check-segmented.js 也按这一条扫 handler 体）。
   * 🔴 判据极性 = 「**选中值必须先过白名单**」：直接 `setData({ leaveSlot: k })`
   *    会让任意 key 写进 leaveSlot（写坏了 onLeavePick 会把非法档位当合法提交）。
   */
  onLeaveSlot(e) {
    const k = e.detail ? e.detail.key : '';
    if (!k) return;
    if (LEAVE_SLOTS.map((s) => s.key).indexOf(k) < 0) return;  // 白名单外直接忽略
    if (k === this.data.leaveSlot) return;
    this.setData({ leaveSlot: k }, () => this._resizeLeaveSheet());
  },

  onLeaveClose() {
    this.setData({ leaveShow: false });
  },

  /**
   * 顶部「请假人数」点击（1.0.5 追加，需求①②）：
   *   · 班委/超管 → 打开请假登记弹层（含 A/B 名单 + 撤销，复用 leaveShow）；
   *   · 辅导员   → 打开**只读**名单弹层（只看不改，无撤销/登记，leaveViewShow）。
   * 辅导员进具体班级时「只显请假人数、不显在位」，点开能看到 A/B 分组的人。
   */
  onLeaveViewOpen() {
    if (this.data.canLeave) { this.onLeaveOpen(); return; }
    if (this.data.isCounselor) {
      const list = this.data.leaveList || [];
      this.setData({
        leaveViewShow: true,
        leaveTab: 'today',
        leavePane: '',
        leaveViewListA: list.filter(x => x.groupTag === 'A'),
        leaveViewListB: list.filter(x => x.groupTag === 'B')
      }, () => this._resizeLeaveSheet());
      // 辅导员也能翻历史（只读，含假条图片）
      this._loadLeaveHistory();
    }
  },

  onLeaveViewClose() {
    this.setData({ leaveViewShow: false });
  },

  /**
   * 请假弹层内容高度变了 → 让 body 重新量一次可滚动范围（1.0.6 修「完全滚不动」）。
   *
   * ⚠️ 为什么页面还要自己盯一遍：bottom-sheet 只在「打开那一拍」自动补量，
   *    而弹层里的高度之后还会反复变（名单回来 / 切今日·历史 / 搜索过滤 /
   *    展开时段），不补量的话 spring-scroll 会拿旧的 `_maxScroll` 去夹手指。
   *    补量是幂等的（只夹紧越界偏移），重复调不会抖。
   */
  _resizeLeaveSheet() {
    const sel = this.data.leaveViewShow ? '#leaveViewSheet' : '#leaveSheet';
    const sheet = this.selectComponent(sel);
    if (sheet && sheet.resizeScroll) sheet.resizeScroll();
  },

  onLeaveKw(e) {
    const kw = e.detail.value;
    this.setData({ leaveKw: kw, leaveCands: this._leaveFilter(kw, this.data.members) }, () => {
      this._resizeLeaveSheet();
    });
  },

  /** 原生日期选择（dataset.kind = start | end） */
  onLeaveDate(e) {
    const key = e.currentTarget.dataset.kind === 'end' ? 'leaveEnd' : 'leaveStart';
    this.setData({ [key]: e.detail.value });
  },

  /** 点某位同学 → 确认 → 按当前区间登记请假 */
  onLeavePick(e) {
    if (this.data.leaveBusy) return;
    const id = Number(e.currentTarget.dataset.id);
    const m = (this.data.members || []).find(x => x.id === id);
    if (!m) return;
    const { leaveStart, leaveEnd, leaveSlot } = this.data;
    if (!leaveStart || !leaveEnd) { util.toast('请先选择请假日期'); return; }
    if (leaveEnd < leaveStart) { util.toast('结束日期不能早于开始日期'); return; }
    // 时段：钟点写死在 LEAVE_SLOTS，页面只存 key ⇒ 旧的「结束必须晚于开始」校验
    // 已随之失去意义（写死的档位不可能违反），**不再保留那条死代码**。
    // ⚠️ slotOf 兜底：leaveSlot 被写坏时回落到「全天」而不是提交半个非法时段。
    const slot = slotOf(leaveSlot);
    const span = leaveStart === leaveEnd
      ? leaveStart + (slot.key === 'all' ? '（整天）' : (' ' + slot.label))
      : (leaveStart + ' ~ ' + leaveEnd + (slot.key === 'all' ? '（整天）' : (' 每天 ' + slot.label)));
    util.confirmStrict('为「' + m.name + '」登记 ' + span + ' 的请假？\n区间内已排的值日会标记为「已请假」。', '请假登记')
      .then((act) => {
        if (act !== 'confirm') return;
        this.setData({ leaveBusy: true });
        const payload = {
          memberId: id,
          startDate: leaveStart,
          endDate: leaveEnd,
          startTime: slot.start,
          endTime: slot.end
        };
        api.leaveAdd(payload, { toast: false })
          .then((r) => {
            this.setData({ leaveBusy: false });
            util.toast((r && r.existed) ? '该区间已登记过' : '已登记请假');
            this._loadLeaveBoard();
            this._loadLeaveHistory();
          })
          .catch((err) => {
            this.setData({ leaveBusy: false });
            util.toast((err && err.errMsg) || '登记失败，请重试');
          });
      });
  },

  /** 撤销某条请假（并恢复区间内的值日） */
  onLeaveCancelTap(e) {
    if (this.data.leaveBusy) return;
    const leaveId = Number(e.currentTarget.dataset.id);
    const item = (this.data.leaveList || []).find(x => x.leaveId === leaveId);
    if (!item) return;
    util.confirmStrict('撤销「' + item.name + '」' + item.startDate + ' ~ ' + item.endDate + ' 的请假？\n区间内被标记为「已请假」的值日会恢复。', '撤销请假')
      .then((act) => {
        if (act !== 'confirm') return;
        this.setData({ leaveBusy: true });
        api.leaveCancel({ leaveId }, { toast: false })
          .then((r) => {
            this.setData({ leaveBusy: false });
            util.toast((r && r.restored) ? ('已撤销，恢复 ' + r.restored + ' 条值日') : '已撤销');
            // 撤销后进历史（状态=已撤销，假条同步进入 7 天倒计时），两个列表都要刷新
            this._loadLeaveBoard();
            this._loadLeaveHistory();
          })
          .catch((err) => {
            this.setData({ leaveBusy: false });
            util.toast((err && err.errMsg) || '撤销失败，请重试');
          });
      });
  },

  /* ---------- 1.0.6：假条图片（上传 / 查看） ----------
   * 链路与「通知配图」完全一致：chooseMedia 压缩 → 前端直传云存储拿 fileID
   * → 调 adjust.leaveImageSet 落库（**二进制不经过云函数**，绑 VPC 拉云存储极慢）。
   * 权限：上传 = 班委/超管（canLeave，后端 requireLeaveRegister 真拦）；
   *       查看 = 班委/超管/辅导员（后端 requireLeaveView 才返回 fileID）。
   */

  /**
   * 行内「传假条 / 假条缩略图 / 假条」按钮（1.0.6 需求①：容错可重传）：
   *   无图 → 直接选图上传；
   *   有图 → **动作面板**给两个动作：查看大图 / **重新上传**（传错了能重来）。
   * ⚠️ 为什么不绑「长按重传」：长按没提示没确认，还容易和「点击看大图」打架；
   *    动作面板把两个动作都写出来，用户不用猜。
   * ⚠️ 辅导员（无登记权）只给预览，不列「重新上传」—— 后端 requireLeaveRegister 会真拦，
   *    这里只是别让他看见一个点了必失败的选项。
   */
  onLeaveImageTap(e) {
    const leaveId = Number(e.currentTarget.dataset.id);
    if (!leaveId) return;
    if (String(e.currentTarget.dataset.has) !== '1') { this._uploadLeaveImage(leaveId); return; }
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
   * 选图 → 前端直传云存储 → 调 adjust.leaveImageSet 落库（**已上传过也能再来一遍**）。
   * ⚠️ 后端 `leaveImageSet` 覆盖前会 deleteFile 掉旧 fileID，所以重传不用改后端，
   *    也不会在云存储里留下孤儿图。
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
        wx.showLoading({ title: '上传假条…', mask: true });
        request.uploadFile('leave/' + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.jpg', p)
          .then((fileId) => api.leaveImageSet({ leaveId, fileId }, { toast: false }))
          .then(() => {
            wx.hideLoading();
            util.toast('假条已上传');
            this._loadLeaveBoard();
            this._loadLeaveHistory();
          })
          .catch((err) => {
            wx.hideLoading();
            util.toast((err && err.errMsg) || '假条上传失败，请重试');
          });
      }
    });
  },

  /** 预览假条：用 fileID 换临时链接（列表已批量换过，这里兜底再换一次） */
  _previewLeaveImage(leaveId) {
    let fileId = '';
    const findIn = (arr) => {
      const it = (arr || []).find(x => x.leaveId === leaveId);
      if (it && it.image) fileId = it.image;
    };
    findIn(this.data.leaveList);
    if (!fileId) findIn(this.data.leaveHistory);
    if (!fileId) findIn(this.data.leaveViewListA);
    if (!fileId) findIn(this.data.leaveViewListB);
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

  /** 可选班级（用于导入预览里手动指定归属） */
  _loadClasses() {
    api.classList({ all: true }, { toast: false })
      .then((list) => this.setData({ importClasses: util.sortClasses((list || []).filter(c => c.isActive !== false)) }))
      .catch(() => {});
  },

  /** 最近一次**可撤回**的导入（1.0.6 需求③：撤回入口只保留 24 小时，过期就隐藏） */
  _loadLastBatch() {
    api.importBatches(this._payload(), { toast: false })
      .then((list) => {
        const b = (list || []).find(batchRevertible) || null;
        this.setData({ lastBatch: b });
      })
      .catch(() => this.setData({ lastBatch: null }));
  },

  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  },

  _loadMembers() {
    const kw = this.data.memberKw;
    const key = mem.keys.roster(this.data.classId, kw);
    // v0.7.32 问题①：同班回访先用**内存缓存**同步渲染（不闪骨架），再后台刷新（SWR）
    const cached = mem.read(key);
    if (cached && cached.length) this._applyMemberRows(cached, kw);
    api.memberList(this._payload({ public: 'manage', kw }), { toast: false })
      .then((list) => {
        // 2026-10-04 需求③：成员与分组**不显示教职工（辅导员）** —— 教职工的账号与绑定
        // 情况只在「班级管理 → 教职工管理」里维护。后端 list 的 manage 分支**不过滤 X**
        // （因为「切换测试账号」要能切到测试辅导员），所以按生效身份在这里过滤。
        //
        // 2026-10-08：原先这里还把「测试账号」挑出来打标签（test 字段 + 学号 99 段正则），
        // 现已删除 —— member.list 的 manage 分支改为**一律**过滤测试账号（含超管），
        // 前端再判一次既是死代码，也会让人以为「前端兜住就行」。
        const rows = (list || []).filter(x => x.groupTag !== 'X').map(x => {
          const rt = util.roleTag(x);
          return Object.assign({}, x, {
            // 辅导员（X 组）不展示学号：seq 只用于排序，给一个大值让他留在列表末尾
            // （展示层由 groupTag==='X' 分支接管，不会出现「999 号」）
            seq: x.groupTag === 'X' ? 999 : util.seqOf(x.studentNo),
            roleTag: rt ? rt.text : '',
            roleTier: rt ? rt.tier : '',
            // 列表过渡的内联样式落点（v0.7.21 需求⑤）；wxml 用 style="{{item.lt}}"
            lt: ''
          });
        });
        rows.sort((a, b) => a.seq - b.seq);
        mem.write(key, rows);
        this._applyMemberRows(rows, kw);
      })
      .catch(() => { if (!cached) this.setData({ members: [], viewMembers: [], membersLoaded: true }); });
  },

  /** 把整理好的名单行落到 data（缓存渲染与网络回填共用同一条路径，避免两套写法漂移） */
  _applyMemberRows(rows, kw) {
    const patch = {
      members: rows,
      viewMembers: this._filterRows(rows, this.data.onlyCommittee),
      committeeCount: rows.filter(x => this._isCommittee(x)).length,
      membersLoaded: true
    };
    // 2026-10-04 需求②：「已绑定」不含辅导员（辅导员行已在上游滤掉，这里再兜一层）。
    // 2026-10-08：原式还排除了 !x.test（测试账号），现已随名单侧统一过滤一并删除 ——
    // 名单里恒无测试账号，这个条件恒为真，留着只会让人以为测试账号还能被处理。
    if (!kw) patch.boundCount = rows.filter(x => x.bound && x.groupTag !== 'X').length;
    // 「选择同学」的候选名单是**从 members 现算**的，而 leaveBoard 可能**先于** member.list
    // 返回 —— 那一次 _applyLeaveStat 里算出的 leaveCands 是空数组。名单后到时必须补算一次，
    // 否则弹层里「选择同学」一直是空的（同样表现为「只有去搜索框输序号才看得到人」，
    // 因为 onLeaveKw 会现算一遍）。仅在登记弹层开着时算，闭着时省掉这次 setData。
    if (this.data.leaveShow) patch.leaveCands = this._leaveFilter(this.data.leaveKw, rows);
    this.setData(patch, () => {
      // 候选名单从空变成一整屏 ⇒ 弹层内容变高，必须补一次补量/重算高度，
      // 否则面板停在旧的（偏矮的）夹紧值上，后面的人全被裁掉。
      if (this.data.leaveShow) this._resizeLeaveSheet();
    });
    this._openPendingMember(rows);
    this._openPendingLeave();
    // v0.7.32：名单到齐后，对「已经渲染出来的请假名单」再过滤一次 ——
    // 首页/本页的 leaveBoard 可能先于 member.list 返回，那时没有名单可比对。
    this._resanitizeLeave();
  },

  /**
   * 深链自动打开某位成员的详情（v0.7.17 需求⑥）：
   * 首页「关注的学生」卡片点进来时带 openMemberId，落到这里直接把详情弹出来 ——
   * 否则用户还要在几十行名单里自己再找一遍，等于没省事。
   * ⚠️ 只在**名单加载完成之后**按 id 查，不要在 onLoad 里查（那时 members 还是空的）。
   */
  _openPendingMember(rows) {
    const id = Number(this._pendingOpenId) || 0;
    if (!id) return;
    this._pendingOpenId = 0;      // 只自动打开一次：用户关掉详情后不该再弹回来
    const hit = (rows || []).find(x => Number(x.id) === id);
    if (!hit) { util.toast('该学生不在这个班级里'); return; }
    this.onMemberRow({ currentTarget: { dataset: { id: hit.id } } });
  },

  /**
   * 深链自动打开请假弹层（1.0.6）：首页弹层底部那行「需要撤销？去请假登记 ›」
   * 跳过来时带 openLeave=1，这里直接把弹层打开。
   *
   * ⚠️ 走 `onLeaveViewOpen()` 而不是 `onLeaveOpen()`：前者按身份分流
   *    （班委/超管 → 登记弹层，辅导员 → 只读名单），直接 onLeaveOpen 会把
   *    没有登记权的辅导员也塞进登记弹层，里面全是灰的。
   * ⚠️ 只自动开一次：用户关掉之后不该再弹回来。
   */
  _openPendingLeave() {
    if (!this._pendingOpenLeave) return;
    this._pendingOpenLeave = false;
    this.onLeaveViewOpen();
  },

  /**
   * 「班委」判据（2026-09-26 需求①）：有管理身份、且不是辅导员（教职工）。
   * 超管（示例成员01·生活委员）也算班委 —— 他确实担任着一个班委职位。
   * 2026-10-08：原式还带 `&& !x.test`（排除测试账号），现已删除 ——
   * 名单侧一律不返回测试账号，这个条件恒为真。留着的真实风险是：
   * 将来某个列表**刻意**放出测试账号时，班委口径会静默不一致。
   */
  _isCommittee(x) {
    return !!x && (x.role === 'ADMIN' || x.role === 'MONITOR')
      && x.groupTag !== 'X';
  },

  /** 按「仅班委」开关过滤；筛选是纯展示层行为，不动 members（详情查找仍按全量） */
  _filterRows(rows, only) {
    return only ? (rows || []).filter(x => this._isCommittee(x)) : (rows || []);
  },

  /**
   * 全班 ⇄ 仅班委（v0.7.21 需求⑤）：
   * 被筛掉的行**边渐隐边塌缩行高**（不是先渐隐、留一块空白再突然跳位），
   * 保留下来的行被布局连续带走；切回全班时新出现的行从 0 高度展开 + 从下方淡入。
   * ⚠️ 这段过渡的机制、时长、两阶段 setData 全在 utils/list-transition.js，
   *    三页共用一份；这里只负责说清「现在筛谁」和「补丁长什么样」。
   * ⚠️ 列表项必须有稳定 wx:key（这里是 id）+ 稳定的 data-id，FLIP/塌缩靠它认人。
   */
  _applyFilter(only) {
    const lt = listTransition;
    // 打断令牌：chip 连点时，上一轮的 setTimeout 醒来发现令牌变了就自己退出，
    // 不会回来把新一轮的 max-height / opacity 清掉（否则第二轮会被「按住」）
    const tk = (this._ltToken = (this._ltToken || 0) + 1);
    lt.filterSwap(this, {
      sel: '.mb-row[data-id]',
      key: 'id',
      field: 'lt',
      guard: () => this._ltToken === tk,
      cur: () => this.data.viewMembers,
      next: () => this._filterRows(this.data.members, only),
      // 选中态（chip 高亮）立刻生效，不等动画 —— 控件必须马上响应，动画只是内容的
      patch: (rows) => ({ viewMembers: rows, onlyCommittee: only })
    });
  },

  onToggleCommittee() {
    this._applyFilter(!this.data.onlyCommittee);
  },

  /** 「全班」chip：关掉筛选（点两次同一个 chip 不会来回抖） */
  onFilterAll() {
    if (!this.data.onlyCommittee) return;
    this._applyFilter(false);
  },

  onMemberKw(e) {
    this.setData({ memberKw: String(e.detail.value || '') });
    this._loadMembers();
  },

  onMemberRow(e) {
    const id = Number(e.currentTarget.dataset.id);
    const m = this.data.members.find(x => x.id === id);
    if (!m) return;
    const app = getApp();
    const me = (app && app.globalData && app.globalData.profile) || null;
    const isCounselor = !!(me && me.groupTag === 'X');
    const noteVisible = isCounselor || !!(app && app.isSuper && app.isSuper());
    this.setData({
      mDetailShow: true,
      mDetail: m,
      mDetailIsSelf: !!(me && me.id === m.id),
      isCounselor,
      noteVisible,
      // 主页关注**仅辅导员**（v0.7.18 需求①）：超管不再有这个入口，与后端 pinList/pinToggle 同口径
      pinVisible: isCounselor,
      noteList: [],
      noteDraft: '',
      noteEditId: 0
    });
    if (noteVisible) {
      this._loadNotes(m.id);
    }
    if (isCounselor) {
      this._loadPinState(m.id);
    }
  },

  onMDetailClose() { this.setData({ mDetailShow: false }); },

  /* ---------------- 主页关注（v0.7.17 需求⑥） ---------------- */

  /**
   * 关注状态：`pinList` 最多 8 条，一次拉全量后本地判定，不为「这一条是否已关注」再开一个接口。
   * 详情页只要判断布尔值 + 显示已用名额，全量数据足够。
   */
  _loadPinState(memberId) {
    api.pinList({}, { toast: false })
      .then((r) => {
        const list = (r && r.list) || [];
        this.setData({
          pinned: list.some(x => Number(x.memberId) === Number(memberId)),
          pinCount: list.length,
          pinLimit: Number((r && r.limit) || 8)
        });
      })
      .catch(() => {});
  },

  onTogglePin() {
    const m = this.data.mDetail;
    if (!m || this.data.pinBusy) return;
    this.setData({ pinBusy: true });
    api.pinToggle({ memberId: m.id }, { toast: false })
      .then((r) => {
        const nowPinned = !!(r && r.pinned);
        this.setData({
          pinBusy: false,
          pinned: nowPinned,
          pinCount: Number((r && r.count) || 0),
          pinLimit: Number((r && r.limit) || 8)
        });
        util.toast(nowPinned ? '已固定到主页' : '已取消固定');
      })
      .catch((e) => {
        this.setData({ pinBusy: false });
        util.toast((e && e.errMsg) || '操作失败');
      });
  },


  /* ---------------- 成员备注（v0.7.16 需求⑦，仅教职工 + 超管） ---------------- */

  _loadNotes(memberId) {
    api.noteList({ memberId }, { toast: false })
      .then((list) => {
        this.setData({
          noteList: (list || []).map(x => Object.assign({}, x, {
            createdAtText: String(x.createdAt || '').replace('T', ' ').slice(5, 16)
          }))
        });
      })
      .catch(() => {});
  },

  onNoteInput(e) { this.setData({ noteDraft: e.detail.value }); },

  /** 点自己写的备注 = 载入草稿改为编辑（保存走 noteSave 带 id） */
  onNoteEdit(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    const hit = (this.data.noteList || []).find(x => x.id === id);
    if (!hit) return;
    this.setData({ noteEditId: id, noteDraft: hit.content });
  },

  /** 退出编辑态，回到「写一条新备注」（草稿丢弃） */
  onNoteCancel() {
    this.setData({ noteEditId: 0, noteDraft: '' });
  },

  onNoteSave() {
    const m = this.data.mDetail;
    if (!m || this.data.noteBusy) return;
    const content = String(this.data.noteDraft || '').trim();
    if (!content) { util.toast('备注内容不能为空'); return; }
    this.setData({ noteBusy: true });
    api.noteSave(
      { memberId: m.id, content, id: this.data.noteEditId || undefined },
      { loading: '保存中' }
    )
      .then(() => {
        this.setData({ noteBusy: false, noteDraft: '', noteEditId: 0 });
        util.toast('备注已保存');
        this._loadNotes(m.id);
      })
      .catch((e) => { this.setData({ noteBusy: false }); util.toast((e && e.errMsg) || '保存失败'); });
  },

  onNoteDelete(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    util.confirm('删除这条备注？', '删除备注').then((ok) => {
      if (!ok) return;
      api.noteDelete({ id }, { loading: '删除中' })
        .then(() => { util.toast('已删除'); this._loadNotes(this.data.mDetail.id); })
        .catch((err) => util.toast((err && err.errMsg) || '删除失败'));
    });
  },

  onToggleGroup() {
    const m = this.data.mDetail;
    if (!m) return;
    if (this.data.mDetailIsSelf) return;        // 自保：不给调组
    // 需求 D：调 A/B 组属名册编辑（影响轮转公平），与导入写入同集合
    if (!this.data.canRosterEdit) { util.toast('仅超级管理员、辅导员或班长可调整分组'); return; }
    const tag = m.groupTag === 'A' ? 'B' : 'A';
    api.updateGroup(this._payload({ memberId: m.id, groupTag: tag }), { loading: '处理中' })
      .then(() => {
        util.toast('已调整到 ' + tag + ' 组');
        this.setData({ mDetailShow: false });
        this._loadMembers();
      })
      .catch(() => {});
  },

  onToggleStatus() {
    const m = this.data.mDetail;
    if (!m) return;
    if (this.data.mDetailIsSelf) return;        // 自保：不给启停
    const status = m.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED';
    api.setMemberStatus(this._payload({ memberId: m.id, status }), { loading: '处理中' })
      .then(() => {
        util.toast(status === 'DISABLED' ? '已停用' : '已恢复');
        this.setData({ mDetailShow: false });
        this._loadMembers();
      })
      .catch(() => {});
  },

  /**
   * 设置班委（2026-09-26 需求②）：超管 + 辅导员可用。
   * 点「设为班委 / 改班委职位」→ 弹层里选具体职位（取值唯一来源 util.POSITIONS）。
   * 已是班委时，弹层里额外提供「取消班委」。
   * 需求 D（2026-09-27）：职位分两类 —— 「生活委员」「班长兼团支书」是**授权职位**
   * （前者给排班权、后者给名册录入权），任免只有超管能点；其余职位辅导员照旧可任免。
   * 前端置灰只是提示，真正拦截在云函数 `member.setPosition` 的 requirePositionGrant。
   */
  onOpenPosition() {
    const m = this.data.mDetail;
    if (!m) return;
    if (!this.data.canManage) { util.toast('仅超级管理员或辅导员可设置班委'); return; }
    if (this.data.mDetailIsSelf) return;             // 自保：不给自己调班委身份
    if (m.groupTag === 'X') { util.toast('辅导员不是学生班委'); return; }
    if (m.isSuper) { util.toast('超级管理员的身份不能在这里修改'); return; }
    const isCommittee = this._isCommittee(m);
    const canGrant = !!this.data.canGrantPosition;
    this.setData({
      posShow: true,
      posCurrent: isCommittee ? (m.position || '') : '',
      posIsCommittee: isCommittee,
      posList: util.POSITIONS.map(p => ({
        text: p,
        on: isCommittee && p === (m.position || ''),
        // 授权职位对非超管置灰（含「撤销」场景：m.position 本身就落在这两项上）
        locked: !canGrant && util.GRANTED_POSITIONS.indexOf(p) >= 0
      }))
    });
  },

  onPosClose() { this.setData({ posShow: false }); },

  /** 选中某个职位 → 落库（role 同时置为 ADMIN） */
  onPickPosition(e) {
    const m = this.data.mDetail;
    if (!m) return;
    const position = String(e.currentTarget.dataset.pos || '');
    if (!position) return;
    // 授权职位：非超管一律拦下并说明原因（不静默返回，避免「点了没反应」）
    if (!this.data.canGrantPosition && util.GRANTED_POSITIONS.indexOf(position) >= 0) {
      util.toast('「' + position + '」由超级管理员任命');
      return;
    }
    this._savePosition(m, position);
  },

  /** 取消班委（清空职位 + role 置回 MEMBER） */
  onCancelPosition() {
    const m = this.data.mDetail;
    if (!m) return;
    // 目标当前职位是授权职位时，撤销同样属「授予权」范围 → 仅超管
    if (!this.data.canGrantPosition && util.GRANTED_POSITIONS.indexOf(String(m.position || '')) >= 0) {
      util.toast('「' + m.position + '」的撤销由超级管理员操作');
      return;
    }
    util.confirm('取消「' + m.name + '」的班委身份？其职位也会一并清空', '取消班委').then((ok) => {
      if (!ok) return;
      this._savePosition(m, '');
    });
  },

  _savePosition(m, position) {
    api.setMemberPosition(this._payload({ memberId: m.id, position }), { loading: '处理中' })
      .then(() => {
        util.toast(position ? ('已设为' + position) : '已取消班委');
        this.setData({ posShow: false, mDetailShow: false });
        this._loadMembers();
        /*
         * v0.7.32 问题②：职位变更会改变「班委专属入口」的可见性 ——
         *   · 置 rosterDirty → 首页 onShow 强制跳过 STALE_MS 重拉（同一台设备立即生效）；
         *   · 若改的是**本人**，本地 profile（角色/职位）也变了，顺手重校一次身份。
         * 别人手机上的那位：由对方 tab 页 onShow 的节流身份重校兜住（见 app.recheckAuth）。
         */
        const app = getApp();
        if (app && app.globalData) app.globalData.rosterDirty = true;
        if (this.data.mDetailIsSelf && app && app.refreshAuth) app.refreshAuth().catch(() => {});
      })
      .catch(() => {});
  },

  /** 解除微信绑定（不可逆）。解绑自己 = 两次确认 + 跳回绑定页。 */
  onUnbindMember() {
    const m = this.data.mDetail;
    if (!m) return;
    if (this.data.mDetailIsSelf) return;        // 自保：走自己的「解除绑定」入口
    const firstTip = '解除后「' + m.name + '」需重新绑定才能使用。';
    util.confirm(firstTip, '解除微信绑定').then((ok) => {
      if (!ok) return;
      api.unbindMember(this._payload({ memberId: m.id }), { loading: '处理中' })
        .then(() => {
          util.toast('已解除绑定');
          this.setData({ mDetailShow: false });
          this._loadMembers();
        })
        .catch(() => {});
    });
  },

  /** 移出班级（超管 / 辅导员）：删成员 + 未开始的值日 */
  onRemoveMember() {
    const m = this.data.mDetail;
    if (!m || !this.data.canManage) return;
    if (m.bound) { util.toast('该成员已绑定微信，请先解除绑定'); return; }
    util.confirm('将「' + m.name + '」移出本班名单？未开始的值日会一并移除', '移出班级').then((ok) => {
      if (!ok) return;
      api.removeMember(this._payload({ memberId: m.id }), { loading: '处理中' })
        .then((r) => {
          util.toast('已移出' + ((r && r.dutyRemoved) ? '（含 ' + r.dutyRemoved + ' 条值日）' : ''));
          this.setData({ mDetailShow: false });
          this._loadMembers();
          this._loadStats();
        })
        .catch(() => {});
    });
  },

  /* ---------------- 单个添加成员（超管 / 辅导员 / 班长，需求 D） ---------------- */
  onAddOpen() {
    if (!this.data.canRosterEdit) { util.toast('仅超级管理员、辅导员或班长可添加成员'); return; }
    this.setData({ addShow: true, addName: '', addNo: '', addBusy: false });
  },
  onAddClose() { this.setData({ addShow: false }); },
  onAddName(e) { this.setData({ addName: String(e.detail.value || '') }); },
  onAddNo(e) { this.setData({ addNo: String(e.detail.value || '') }); },
  onAddSubmit() {
    if (this.data.addBusy) return;
    const name = String(this.data.addName || '').trim();
    const studentNo = String(this.data.addNo || '').trim();
    if (!name) { util.toast('请填写姓名'); return; }
    if (!/^[A-Za-z0-9]{4,32}$/.test(studentNo)) { util.toast('请填写正确的学号（4 位以上数字）'); return; }
    this.setData({ addBusy: true });
    api.addMember(this._payload({ name, studentNo }), { loading: '添加中' })
      .then((r) => {
        this.setData({ addShow: false, addBusy: false });
        util.toast('已添加至 ' + r.groupTag + ' 组');
        this._loadMembers();
        this._loadStats();
      })
      .catch(() => this.setData({ addBusy: false }));
  },

  /* ---------------- 导入名单（粘贴 / Excel → 预览 → 确认） ---------------- */
  onImportOpen() {
    // 需求 D：导入=批量增改名册，与「添加成员」同集合
    if (!this.data.canRosterEdit) { util.toast('仅超级管理员、辅导员或班长可导入名单'); return; }
    // v0.7.32 问题①：这两个请求改为「开弹层才拉」（过去在 onLoad 就发，拖慢首屏）
    this._loadClasses();
    this._loadLastBatch();
    this.setData({
      importShow: true, importPhase: 'input', importText: '',
      importGroups: [], importResult: null, importBusy: false,
      importFromExcel: false, importFileId: '', importFileName: '', importCreateMissing: false
    });
  },
  onImportClose() { this.setData({ importShow: false }); },
  onImportText(e) { this.setData({ importText: String(e.detail.value || '') }); },

  /** 从聊天里选一个 Excel / CSV 文件（微信只允许从小程序外部选文件） */
  onImportPickFile() {
    if (this.data.importBusy) return;
    if (!wx.chooseMessageFile) { util.toast('当前微信版本不支持选择文件，请改用上面的粘贴方式'); return; }
    /*
     * ⚠️ `extension` 每一项**必须带点**（官方要求，如 '.xlsx'）。之前写成 'xlsx' 会被当作
     * 过滤条件且匹配不到任何文件 → 聊天里明明有表格却「无文件可选」。
     * 这里索性**不加过滤**（只限定 type='file'），选完再由 _uploadAndPreview 校验后缀：
     * 宁可列表里多几项，也不要出现「一个都选不了」。
     */
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (res) => {
        const f = (res.tempFiles || [])[0];
        if (!f) { util.toast('没有选到文件'); return; }
        this._uploadAndPreview(f);
      },
      fail: (err) => {
        // 用户主动取消不算失败，别弹提示
        if (String((err && err.errMsg) || '').indexOf('cancel') >= 0) return;
        util.toast('打开文件列表失败，可改用上面的粘贴方式');
      }
    });
  },

  _uploadAndPreview(f) {
    const name = f.name || 'roster.xlsx';
    const ext = String(name.split('.').pop() || '').toLowerCase();
    if (['xlsx', 'csv'].indexOf(ext) < 0) {
      util.toast('请选择 .xlsx 或 .csv 文件（旧版 .xls 请先另存为 .xlsx）');
      return;
    }
    const cloudPath = 'import/' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    wx.showLoading({ title: '读取中', mask: true });
    wx.cloud.uploadFile({
      cloudPath,
      filePath: f.path,
      success: (r) => {
        wx.hideLoading();
        this.setData({ importFileId: r.fileID, importFileName: name });
        this._runPreview({ fileId: r.fileID }, { fromExcel: true });
      },
      fail: () => { wx.hideLoading(); util.toast('文件上传失败，请重试'); }
    });
  },

  /** 第一阶段：解析预览（不写库） —— 有粘贴文本走文本，否则用已选的文件 */
  onImportParse() {
    if (this.data.importBusy) return;
    if (String(this.data.importText).trim()) {
      this._runPreview({ text: this.data.importText }, { fromExcel: false });
      return;
    }
    if (this.data.importFileId) {
      this._runPreview({ fileId: this.data.importFileId }, { fromExcel: true });
      return;
    }
    util.toast('请粘贴名单，或从聊天选择一个表格');
  },

  _runPreview(extra, opts) {
    if (this.data.importBusy) return;
    this.setData({ importBusy: true });
    const call = opts.fromExcel ? api.importExcel : api.importCsv;
    call(this._payload(Object.assign({ preview: true }, extra)), { loading: '解析中' })
      .then((r) => {
        const rows = (r.groups || []).map(g => Object.assign({}, g, {
          // 默认勾选：已匹配到班、且不是「可疑（weak）/冲突（conflict）」
          include: !!g.classId && !g.weak && !g.conflict
        }));
        this.setData({
          importBusy: false, importGroups: rows, importPhase: 'preview',
          importFromExcel: !!opts.fromExcel
        });
        if (!rows.length) util.toast('没有解析到有效名单');
      })
      .catch(() => this.setData({ importBusy: false }));
  },

  onImportBack() { this.setData({ importPhase: 'input' }); },

  onToggleCreateMissing(e) {
    this.setData({ importCreateMissing: !!e.detail.value });
  },

  onToggleInclude(e) {
    const i = Number(e.currentTarget.dataset.i);
    const groups = this.data.importGroups.slice();
    if (!groups[i]) return;
    groups[i] = Object.assign({}, groups[i], { include: !groups[i].include });
    this.setData({ importGroups: groups });
  },

  /** 给某个分组手动指定归属班级（同班号不同专业 / 未匹配时用） */
  onPickGroupClass(e) {
    const i = Number(e.currentTarget.dataset.i);
    const g = this.data.importGroups[i];
    if (!g) return;
    const classes = this.data.importClasses || [];
    if (!classes.length) { util.toast('没有可选班级'); return; }
    wx.showActionSheet({
      itemList: classes.map(c => c.name),
      success: (res) => {
        const cls = classes[res.tapIndex];
        if (!cls) return;
        const groups = this.data.importGroups.slice();
        groups[i] = Object.assign({}, g, { classId: Number(cls.id), className: cls.name, include: true, weak: false, conflict: false });
        this.setData({ importGroups: groups });
      }
    });
  },

  /** 第二阶段：按确认结果写入（可顺带新建缺失班级） */
  onImportConfirm() {
    if (this.data.importBusy) return;
    const picked = (this.data.importGroups || []).filter(g => g.include);
    if (!picked.length) { util.toast('请至少选择一个要导入的班级'); return; }
    const mapping = {};
    const createLabels = [];
    picked.forEach((g) => {
      if (g.classId) mapping[g.label] = g.classId;
      else if (this.data.importCreateMissing && g.label) createLabels.push(g.label);
    });
    if (!Object.keys(mapping).length && !createLabels.length) {
      util.toast('选中的分组还没有归属班级：请「选班」或打开「自动新建班级」');
      return;
    }
    const payload = this._payload({
      mapping,
      createLabels,
      createMissing: this.data.importCreateMissing && createLabels.length > 0
    });
    if (this.data.importFromExcel) payload.fileId = this.data.importFileId;
    else payload.text = this.data.importText;

    const call = this.data.importFromExcel ? api.importExcel : api.importCsv;
    this.setData({ importBusy: true });
    call(payload, { loading: '导入中' })
      .then((r) => {
        this.setData({
          importBusy: false, importResult: r, importPhase: 'input', importText: '',
          importGroups: [], importFromExcel: false, importFileId: '', importFileName: ''
        });
        const parts = [];
        if (r.imported) parts.push('新增 ' + r.imported + ' 人');
        if (r.updated) parts.push('更新 ' + r.updated + ' 人');
        if (r.skipped) parts.push('跳过 ' + r.skipped + ' 人');
        if (r.createdClasses && r.createdClasses.length) parts.push('新建 ' + r.createdClasses.length + ' 个班级');
        const content = parts.join('，') || '没有变化';
        this._loadMembers();
        this._loadStats();
        this._loadClasses();
        this._loadLastBatch();
        wx.showModal({
          title: '导入完成',
          content: content
            + (r.createdClasses && r.createdClasses.length ? '\n新建班级：' + r.createdClasses.join('、') : '')
            + (r.skipped ? '\n（跳过：学号已属于其它班级）' : '')
            + '\n\n要撤回这次导入吗？',
          confirmText: '撤回',
          cancelText: '完成',
          confirmColor: '#F53F3F',
          success: (res) => { if (res.confirm) this._doRevert(r.batchId); }
        });
      })
      .catch(() => this.setData({ importBusy: false }));
  },

  /* ---------------- 撤回导入 ---------------- */
  onRevertTap() {
    const b = this.data.lastBatch;
    if (!b) { util.toast('没有可撤回的导入记录'); return; }
    util.confirm('将删除这次导入新增的 ' + b.inserted + ' 人（已绑定或有值日的会跳过）', '撤回这次导入').then((ok) => {
      if (!ok) return;
      this._doRevert(b.id);
    });
  },

  _doRevert(batchId) {
    api.revertImport(this._payload({ batchId }), { loading: '撤回中' })
      .then((r) => {
        let msg = '已撤回：删除 ' + r.removed + ' 人';
        if (r.restored) msg += '，还原 ' + r.restored + ' 人';
        if (r.skipped) msg += '，跳过 ' + r.skipped + ' 人';
        util.toast(msg);
        this.setData({ importResult: null });
        this._loadMembers();
        this._loadStats();
        this._loadLastBatch();
      })
      .catch(() => {});
  }
});
