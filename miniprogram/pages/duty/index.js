/**
 * P4 · 本周值日表（Tab 3）
 * 同学：按日查看本周安排；管理员（超管）：生成 / 发布 / 换人 / 导出
 * 手动排班（P5）的入口在「我的」页，本页不再提供。
 * 注意：本工具只做值日提醒，不做打卡与照片凭证。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const pageAnim = require('../../utils/page-anim');
const mem = require('../../utils/mem');
const swipe = require('../../utils/swipe');
const impersonate = require('../../utils/impersonate');
const theme = require('../../utils/theme');

/** 数据新鲜度窗口：切换回本页时，只要在这个窗口内拉过数据，就直接复用、不再发起请求 */
const STALE_MS = 20000;

/**
 * 合并行汇总状态（1.0.4.4 #27）：同一节课的若干人合成一行，右侧只放一个汇总 pill。
 * 取「最未完成」者为准：待值日(PENDING) > 进行中(ONGOING) > 已值日(DONE) > 已结束(EXPIRED)。
 * 纯前端展示聚合，不改库、不影响单条 duty 的状态。
 */
function aggregateDutyStatus(statuses) {
  const rank = { PENDING: 0, ONGOING: 1, DONE: 2, EXPIRED: 3 };
  let best = 'EXPIRED';
  let bestRank = 99;
  (statuses || []).forEach((s) => {
    const r = rank[s] != null ? rank[s] : 99;
    if (r < bestRank) { bestRank = r; best = s; }
  });
  return best;
}

/**
 * 写操作（生成 / 发布 / 撤回 / 清空）的 busy 看门狗上限。
 * ------------------------------------------------------------
 * 为什么要有它（2026-09-26 用户反馈「点『按序号轮转』后没有任何反应」）：
 * 这四个入口都靠页面级 `busy` 做重入保护，命中就是一句裸 `return` ——
 * 不弹窗、不提示、按钮也不变。只要有一次请求卡住（云函数冷启动/网络挂起，
 * wx.cloud.callFunction 最长能吊 60s）或者 `.then` 里抛了个错，`busy` 就永久
 * 停在 true，之后**每一次**点击都被静默吞掉，表现正是「点了没反应」。
 * 现在：① busy 有上限，到点自动复位并告诉用户；② 命中 busy 时给反馈，
 * ③ 「上一次请求其实早没了」的残留 busy 直接放行，不让它挡住本次点击。
 */
const BUSY_TIMEOUT_MS = 15000;

Page({
  data: {
    statusBarHeight: 20,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,
    loading: true,
    failed: false,
    isAdmin: false,
    isSuper: false,
    /** 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条 */
    impersonateBanner: '',
    /** 教职工（辅导员）视角（v0.7.16 需求⑧）：顶部班级筛选标签，逐班查看值日分配 */
    isCounselor: false,
    dutyChips: [],           // [{id,name}] = 该教职工绑定的班级（class.list 已按 staff_class 过滤）
    viewClassId: 0,          // 当前查看的班级（0 = 未选择；教职工必选一个）

    week: 1,
    totalWeeks: 18,
    current: 1,
    termStart: '',

    status: 'DRAFT',
    unpublished: false,
    archived: false,
    days: [],
    /** 「按日」实际渲染的日子（本周 = 今天及以后；其它周 = 全部）。
     *  ⚠️ 底层 `days` **保持整周**：各处 handler 都按它取数，
     *  「已结束」只是把它从**按日列表**里挪进弹层，不是删除数据。 */
    activeDays: [],
    /** 本周里「早于今天」的日子（仅在查看本周时非空）；进「已结束」弹层 */
    pastDays: [],
    /** 「已结束」弹层开关（2026-10-04 需求）：必须同步进 page-meta 的锁滚动表达式 */
    endedSheetShow: false,

    /** 左右滑动切周的方向性动画 class：由 utils/swipe.js 下发，写进数据区容器 */
    swipeCls: '',

    sheetShow: false,
    sheetDutyId: 0,
    /** 合并行点开后的「本课次成员」弹层（1.0.4.4 #27）：列出该节课每人一行，分别操作 */
    groupShow: false,
    groupMembers: [],
    groupTitle: '',
    busy: false,

    /* 加值日生（v0.7.16 需求③，仅超管）：选课次 → 选人 → scheduleAddManual */
    addShow: false,
    addDate: '',             // 目标日期（YYYY-MM-DD）
    addDateText: '',
    addSessions: [],         // 该天的课次（按 sessionId 去重）：{sessionId, whenText, room, courseName, count}
    addSessionId: 0,
    addKw: '',
    addMembers: [],          // 名单（已滤教职工/停用；taken = 已在该课次）
    addBusy: false,

    /* 一键生成 / AI 排班（DeepSeek） */
    aiShow: false,

    /* ── 排班方式（岗位槽，2026-10-28）──────────────────────────
     * 各班生活委员制度不同（每节换人 / 一人包全天），原先规则写死在云函数里。
     * 这里让他们自己定义「哪天、第几节、几个人」：
     *   period = null  → 承包全天（当天所有节次共用这一批人）
     *   period = 数字  → 该节单独一个岗位
     * 保存后**只影响之后新生成的周**，已生成的周原样保留。
     * ⚠️ slotShow 必须同步进 page-meta 的锁滚动表达式（漏一个会背景跟着滚）。 */
    slotShow: false,
    slotList: [],        // [{ key, period, periodIdx, periodText, needN }]
    /* 这套岗位适用哪几天（1=周一 … 7=周日）。一次勾选，全天共用同一组岗位，
     * 不用逐天重复填 —— 例：勾周一到周五 + 建「第1节2人」，保存后 5 天都生效。 */
    slotDays: [1, 2, 3, 4, 5],
    /* 星期 chips 渲染态：{ wd, text, on }
     * ⚠️ on 必须在这里预算 —— WXML 不支持 indexOf 之类的方法调用。 */
    slotDayChips: [],
    slotBusy: false,
    slotSummary: '未设置',
    /* ── 18:10 打扫主教室（2026-10-28）──────────────────────────
     * 独立的 CLEAN 课次，不是大课的某一节：系统里固定排在第 4 节之后、
     * 第 5 节之前（第 4 节 16:30–18:10 下课即打扫），前端一律显示「18 点前」。
     * 🔴 人数必须**逐天可设**：示例班级A现状就是周二大扫除 4 人、其余 2 人，
     *    统一一个人数会在打开开关那一刻把周二冲成 2 人。
     * 一旦配过 CLEAN 槽，该班保洁就完全由槽位定义：列表里没有的天不排人。 */
    cleanOn: false,
    cleanRows: [],       // [{ key, wd, text, needN }]
    cleanSummary: '未开启',
    /* 主教室（保洁房间，2026-10-28）：存在 class.main_room，与后台「班级设置」
     * 同一个字段 —— 生活委员在这里改，后台立刻能看到，反之亦然。
     * 留空 = 课次名退化成「打扫主教室」。 */
    cleanRoom: '',
    cleanTitle: '每天 18:10 打扫主教室',
    weekdayTexts: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    /** 节次选项：第一项「全天」= period null，其余第 1–8 节 */
    periodTexts: ['全天', '第1节', '第2节', '第3节', '第4节', '第5节', '第6节', '第7节', '第8节'],
    aiText: '',
    aiBusy: false,
    aiError: '',
    aiDiag: null,
    /* 自检面板默认**折叠**：以前 _checkAi 会把诊断结果直接塞进 aiDiag，
     * 用户一开「一键生成」弹层就先看到一大块 IP / HTTP 状态 / 环境变量，
     * 像报错页。现在只有显式点「自检」才出现，且出现时也是收起状态。 */
    aiDiagOpen: false,
    aiDiagBrief: '',
    aiModel: '',
    aiHasKey: true,
    aiPlan: [],
    aiCleaningPlan: [],      // 保洁不进 AI 计划，单独回传用于预览展示
    aiWarnings: [],
    aiNotes: '',
    aiSkipSeqs: []
  },

  onLoad() {
    const app = getApp();
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    const cfg = app.globalData.config || {};
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: cfg.termStart || '',
      totalWeeks: cfg.totalWeeks || 18,
      current: cfg.currentWeek || 1,
      week: cfg.currentWeek || 1
    });
    // 用户是否手动切过周（见 _applyWeek）。未手动切过 → onShow 有权把 week 纠回真实当前周；
    // 手动切过后 → 保留用户选择，只同步 current 做「已结束」折叠判定。
    this._weekManual = false;
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅
    // 切周动画的定时器：页面销毁后还在跑就会对已销毁实例 setData
    swipe.cancel(this);
    // busy 看门狗同理（Tab 页一般不销毁，但被 reLaunch 清掉时会走到这里）
    if (this._busyTimer) { clearTimeout(this._busyTimer); this._busyTimer = null; }
    // 按日/按人 FLIP 的打断令牌也一起作废：链上还没醒的 setTimeout 会自己退出，
    // 不会对已销毁的实例 setData（list-transition 的 guard 就是为这一下存在的）
    this._flipToken = (this._flipToken || 0) + 1;
  },

  onShow() {
    const app = getApp();
    if (app.track) app.track.pageView('duty');
    app.setTabBar(3);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    const applyAuth = () => {
      const isCounselor = !!(app.globalData.profile && app.globalData.profile.groupTag === 'X');
      this.setData({
        isAdmin: !!(app && app.isAdmin && app.isAdmin()),
        isSuper: !!(app && app.isSuper && app.isSuper()),
        // 需求 D：排班域入口（清空 / 一键生成 / 发布 / 调整 / 加人）改为
        // 「超管或本班生活委员」—— 判定来自后端 guard，前端不自己比 position
        canSchedule: !!(app && app.canSchedule && app.canSchedule()),
        // 「+ 加值日生」按钮的显隐开关（2026-10-14 用户要求隐藏）。
        // 功能代码（onAddOpen / 弹层 / scheduleAddManual 接口）**全部保留**，只挡入口 ⇒ 想恢复把这里改回 true 即可。
        // ⚠️ 为什么用开关而不是直接删 wxml 的 wx:if：删了以后想恢复得重新翻 git，
        //    而这一行改动 + 一个常量就能表达「暂时不想露出这个入口」。
        showAddDutyBtn: false,
        isCounselor
      });
      // 教职工：加载自己绑定的班级做筛选标签（class.list 对教职工只回绑定班）
      if (isCounselor && !this.data.dutyChips.length) this._loadDutyClasses();
      // 模拟态护栏（v1.0.5）：身份套用后同步顶部横幅
      impersonate.sync(this);
    };
    applyAuth();
    // 登录可能在 onShow 之后才完成：登录就绪后重新套用身份，避免超级管理员按钮首屏不显示
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        applyAuth();
        // 登录就绪后 config.currentWeek 才确定：把周次纠回真实当前周（首屏冷启动场景）
        if (!this._weekManual && this._syncWeek()) this.load(true);
      });
    }
    // 换班同意/拒绝/撤销后（在「我的」页操作），值日表已变：检测 dutyDirty 脏标记，
    // 强制跳过 STALE_MS 缓存重拉一次，否则要「杀掉小程序重进」才看得到更新（1.0.4.4 #28）。
    const dutyDirty = !!(app.globalData && app.globalData.dutyDirty);
    if (app.globalData) app.globalData.dutyDirty = false;
    // 修复（2026-10-10 报障：值日页「已结束」经常失效、且默认显示第 1 周）：
    // App.onLaunch 的 _bootstrap() 是异步 api.login，config.currentWeek 往往晚于本页 onLoad 才写入，
    // 于是 onLoad 把 week/current 兜底成 1、之后又从不重读 → 页面永久停在 week=1 而 current=真实周，
    // isCurrentWeek 恒 false → pastDays=[] → 「已结束」入口（wx:if pastDays.length）整块消失。
    // 这里每次 onShow 把 current 纠回真实当前周；未手动切周时一并把 week 纠回当前周并强制重拉。
    const corrected = this._syncWeek();
    // 🔴 全局「当前查看班级」联动：从班级信息页切到 104 后切到值日页，必须按新班重拉
    //    （否则 STALE_MS 缓存早退会留住上一次的 3 班名单）。
    const gView = Number(app.globalData.viewClassId) || 0;
    const needClassReload = !!gView && gView !== (this._shownViewClassId || 0);
    this.load(corrected || dutyDirty || needClassReload);
    this._shownViewClassId = gView || (this.data.isCounselor ? (Number(this.data.viewClassId) || 0) : 0);
    // v0.7.32 问题②：切 tab 也做一次节流身份重校；身份变了就重套 + 强刷
    if (typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        applyAuth();
        this.load(true);
      }).catch(() => {});
    }
  },

  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5） */
  onRecoverSelf() {
    impersonate.recover();
  },

  /** 教职工：绑定班级列表（筛选标签数据源）。默认选中第一个班。 */
  _loadDutyClasses() {
    api.classList({}, { toast: false })
      .then((list) => {
        const chips = util.sortClasses(list || []).map(c => ({ id: Number(c.id), name: c.name }));
        if (!chips.length) { this.setData({ dutyChips: [] }); return; }
        const keep = chips.some(c => c.id === Number(this.data.viewClassId));
        this.setData({
          dutyChips: chips,
          viewClassId: keep ? Number(this.data.viewClassId) : chips[0].id
        });
        this.load(true);
      })
      .catch(() => {});
  },

  /** 教职工筛选标签点击：换一个班级查看 = 换一份数据（强制刷新，换班不走静默缓存） */
  onDutyClass(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id || id === Number(this.data.viewClassId)) return;
    this.setData({ viewClassId: id });
    // 同步全局「当前查看班级」，与班级信息页切班互通（其余 Tab 跟随）
    getApp().globalData.viewClassId = id;
    this.load(true);
  },

  /* ---------------- 加值日生（v0.7.16 需求③，仅超管） ---------------- */

  /** 打开弹层：从当天的值日行里去重出课次列表（period/教室/课名/已排人数） */
  onAddOpen(e) {
    if (!this.data.canSchedule) return;
    const date = String(e.currentTarget.dataset.date || '');
    const day = this.data.days.find(d => d.date === date);
    if (!day || !day.duties.length) { util.toast('这一天没有可安排的课次'); return; }
    const seen = {};
    const sessions = [];
    day.duties.forEach(x => {
      if (seen[x.sessionId]) { seen[x.sessionId].count += 1; return; }
      const row = {
        sessionId: x.sessionId,
        whenText: util.whenText(x.kind, x.period),
        room: util.fmtRoom(x.room),
        courseName: x.courseName || '',
        count: 1
      };
      seen[x.sessionId] = row;
      sessions.push(row);
    });
    this.setData({
      addShow: true,
      addDate: date,
      addDateText: day.weekdayText + ' ' + day.dateText,
      addSessions: sessions,
      addSessionId: 0,
      addKw: '',
      addMembers: []
    });
  },
  onAddClose() { this.setData({ addShow: false }); },
  onAddBackSession() { this.setData({ addSessionId: 0, addKw: '', addMembers: [] }); },

  /** 选定课次 → 拉本班名单（滤掉教职工 / 停用；标记已在该课次的人）。基表留在 _addBase 供搜索过滤 */
  onAddPickSession(e) {
    const sessionId = Number(e.currentTarget.dataset.id) || 0;
    if (!sessionId) return;
    this.setData({ addSessionId: sessionId, addKw: '', addMembers: [], addBusy: true });
    api.memberList({ public: 'manage' }, { toast: false })
      .then((list) => {
        const day = this.data.days.find(d => d.date === this.data.addDate);
        const takenIds = {};
        ((day && day.duties) || []).forEach(x => {
          if (Number(x.sessionId) === sessionId) takenIds[Number(x.memberId)] = true;
        });
        const members = (list || [])
          .filter(m => m.groupTag !== 'X' && m.status !== 'DISABLED')
          .map(m => ({
            id: Number(m.id),
            name: m.name,
            studentNo: String(m.studentNo || ''),
            seqText: m.groupTag === 'X' ? '·' : (util.seqOf(m.studentNo) || '·'),
            groupTag: m.groupTag,
            taken: !!takenIds[Number(m.id)]
          }))
          .sort((a, b) => (util.seqOf(a.studentNo) - util.seqOf(b.studentNo)) || (a.id - b.id));
        this._addBase = members;
        this.setData({ addMembers: this._filterAdd(String(this.data.addKw || '').trim(), members), addBusy: false });
      })
      .catch(() => this.setData({ addBusy: false }));
  },

  onAddKw(e) {
    const kw = String(e.detail.value || '').trim();
    this.setData({ addKw: kw });
    // 在基表上过滤（不在子集上再滤，否则清空关键词回不去）
    this.setData({ addMembers: this._filterAdd(kw, this._addBase || []) });
  },

  /** 关键词过滤：姓名或学号含关键字（无关键字 = 全量） */
  _filterAdd(kw, list) {
    if (!kw) return list;
    return list.filter(m => m.name.indexOf(kw) >= 0 || m.studentNo.indexOf(kw) >= 0);
  },

  /** 选人 → 挂到该课次（schedule.addManual，超管）；成功即关弹层并强刷 */
  onAddPickMember(e) {
    const memberId = Number(e.currentTarget.dataset.id) || 0;
    if (!memberId || this.data.addBusy) return;
    const member = this.data.addMembers.find(m => m.id === memberId);
    if (member && member.taken) { util.toast('该同学已在这个课次'); return; }
    this.setData({ addBusy: true });
    this._invalidateManual();   // 乐观作废：写之前清掉（check-perf R6），失败也只是多拉一次
    api.scheduleAddManual(
      { sessionId: this.data.addSessionId, week: this.data.week, memberId },
      { loading: '添加中' }
    )
      .then(() => {
        this.setData({ addBusy: false, addShow: false });
        util.toast('已添加');
        this.load(true);
      })
      .catch(() => this.setData({ addBusy: false }));
  },

  /**
   * 周次与「当前周」同步（修复 2026-10-10 报障：值日页「已结束」经常失效、且默认显示第 1 周）。
   * ------------------------------------------------------------
   * 根因：App.onLaunch 里的 _bootstrap()（api.login）是异步的，globalData.config.currentWeek
   * 要等网络回来才写入；而 Tab 页 onLoad 在它之前就跑了，于是 week/current 被兜底成 1，
   * 之后 onShow 从不重读 → 页面永久停在「week=1 而 current=真实周」，isCurrentWeek 恒为
   * false → pastDays=[] → 「已结束 N 天」入口（wx:if pastDays.length）整块消失；且显示的是第 1 周。
   * 这里每次 onShow 把 current 纠正为真实当前周（current 无手动控制权，仅供 isCurrentWeek 判定）；
   * 仅当本页还停在「初始默认周」（用户没手动切过周）时，把 week 也纠正为真实当前周。
   * @returns {boolean} week 是否被纠正（纠正了调用方就走 load(true) 强刷当前周）
   */
  _syncWeek() {
    const app = getApp();
    const cfg = (app.globalData && app.globalData.config) || {};
    const cur = cfg.currentWeek || this.data.current || 1;
    // current 始终反映真实当前周（仅用于「已结束」折叠判定）
    if (Number(this.data.current) !== Number(cur)) this.setData({ current: cur });
    // 用户手动切过周：只同步 current、不动 week，保留用户选择
    if (this._weekManual) return false;
    // 还在初始默认周：纠正为真实当前周；与现有值不同才强刷
    if (Number(this.data.week) !== Number(cur)) {
      this.setData({
        week: cur,
        totalWeeks: cfg.totalWeeks || this.data.totalWeeks
      });
      return true;
    }
    return false;
  },

  load(force) {
    /*
     * 需求①「切换页面若无变化则无需重载」：Tab 切换回来时，只要上一次数据还很新鲜
     * （STALE_MS 内拉过），就直接复用已渲染的内容、连请求都不发 —— 切回来是「秒显」。
     * 显式写操作（生成 / 发布 / 撤回 / 清空 / 换人 / AI 应用）走 `load(true)` 强制刷新。
     */
    const now = Date.now();
    if (!force && this._hasData && this._lastLoad && now - this._lastLoad < STALE_MS) {
      return;
    }
    // 教职工按班查看：缓存键带上 classId，避免 A 班的名单冒充 B 班（v0.7.16）
    // 🔴 全局「当前查看班级」优先（从班级信息页切班联动）：超管/辅导员在别页切到 104，
    //   值日页也跟着显示 104 的排班；其次回落本地 viewClassId（辅导员在值日页切班）。
    const gView = Number(getApp().globalData.viewClassId) || 0;
    const cid = gView || (this.data.isCounselor ? (Number(this.data.viewClassId) || 0) : 0);
    const key = mem.keys.duty(this.data.week) + (cid ? ':' + cid : '');
    /*
     * 首屏优先用 app 在登录后**后台预热**好的那一份（见 app._prefetchTabs）：
     * 首次打开小程序时云函数是冷的，切到值日页要等好几秒；
     * 预热把这段时间挪到了用户还在首页的时候，这里就能直接渲染出来。
     *
     * 页面实例在 Tab 切换时不销毁、data 里还有上一次的内容 —— 只要本周已经画过，
     * 就不要退回骨架（无条件 `loading: true` 会让「切回值日」每次都先闪一遍骨架，
     * 主观上就是「切 Tab 卡卡的」）。
     */
    const cached = this._hasData ? null : mem.read(key);
    const hasContent = !!this._hasData || !!cached;
    if (cached) this._paint(cached);
    else if (!hasContent) this.setData({ loading: true, failed: false });

    return api.scheduleListWeek({ week: this.data.week, classId: cid || undefined }, { toast: false })
      .then((r) => {
        mem.write(key, r);
        this._lastLoad = Date.now();
        this._paint(r);
      })
      .catch(() => {
        this.setData({ loading: false, failed: !hasContent });
        // 已有内容时不清屏（清屏反而更糟），但必须让用户知道这次没刷上 ——
        // 值日名单看错是真会误事的，所以宁可弹一下。
        if (hasContent) util.toast('刷新失败，显示的是上次的名单');
      });
  },

  /* v1.0.5：spring-scroll 下拉刷新 → 强制重载并收起指示器 */
  onRefresh() {
    Promise.resolve(this.load(true)).then(() => {
      const sc = this.selectComponent('#dsMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    }).catch(() => {
      const sc = this.selectComponent('#dsMain');
      if (sc && sc.finishRefresh) sc.finishRefresh();
    });
  },

  /** 把服务端返回的名单铺到界面上（首次拉取 / 预热命中 / 缓存命中共用） */
  _paint(r) {
    const days = this._decorate((r && r.days) || []);
    /*
     * 「已结束」折叠（2026-10-04 需求）：只折**当前周里早于今天**的日子（今天整天留在主列表）。
     *  · 只有查看本周时才折 —— 切到历史周时正常显示全部（历史周本来就是回顾，不该被抽空）；
     *  · 底层 days 保持整周不动（按人视图 / 各处 handler 都依赖它），只把「按日」的渲染源
     *    换成 activeDays，被折走的放进 pastDays 交给弹层。
     * ⚠️ 日期是 'YYYY-MM-DD' 固定宽字符串，字典序比较即日期序，无需转 Date。
     */
    const isCurrentWeek = Number(this.data.week) === Number(this.data.current);
    const today = util.fmtDate(new Date());
    const pastDays = isCurrentWeek ? days.filter(d => String(d.date) < today) : [];
    const activeDays = isCurrentWeek ? days.filter(d => String(d.date) >= today) : days;
    this._hasData = true;
    this.setData({
      loading: false,
      failed: false,
      status: (r && r.status) || 'DRAFT',
      unpublished: !!(r && r.unpublished),
      archived: !!(r && r.archived),
      days,
      activeDays,
      pastDays
    }, () => { this._resizeMain(); });
  },

  _decorate(days) {
    return days.map(d => {
      // 姓名牌改为显示「序号」（名册序号 = 学号后两位）；序号缺失时显示占位符而不是悄悄回落成「姓」
      const duties = (d.duties || []).map(x => Object.assign({}, x, {
        seqText: x.seq ? String(x.seq) : '·',
        isClean: x.kind === 'CLEAN',
        flip: '', // 按日/按人切换的 FLIP 初值（v0.7.19 需求②）
        // 保洁课次显示「18点前」，普通课次显示「第 N 节」（唯一来源 util.whenText）
        whenText: util.whenText(x.kind, x.period)
      }));
      /*
       * 按课次（sessionId）合并（1.0.4.4 #27）：同一节课的两/三人合成一行，
       * 不再各占一排。合并对象带 members[]（原样引用已装饰的 duty，便于点开分别操作），
       * 行右侧只放一个「汇总 pill」（取最未完成状态）。按人视图继续用扁平 duties，不受影响。
       */
      const merged = [];
      const bySession = {};
      duties.forEach(x => {
        const key = x.sessionId;
        if (!bySession[key]) {
          const g = {
            id: 'g' + key,
            sessionId: x.sessionId,
            period: x.period,
            kind: x.kind,
            isClean: x.kind === 'CLEAN',
            whenText: util.whenText(x.kind, x.period),
            room: util.fmtRoom(x.room),
            courseName: x.courseName || '',
            groupScope: x.groupScope,
            isMine: false,
            flip: '',
            members: []
          };
          bySession[key] = g;
          merged.push(g);
        }
        const g = bySession[key];
        g.members.push(x);
        if (x.isMine) g.isMine = true;
      });
      merged.forEach(g => {
        g.avatarSize = 48; // 合并行序号牌 48rpx：序号略收小，把视觉重心让给下方加粗的姓名（姓名 26rpx/600）
        g.status = aggregateDutyStatus(g.members.map(m => m.status));
        g.namesText = g.members.map(m => m.name).join('、');
        // 保洁课次名来自 course（周二=「410大扫除」、其余=「打扫410」），直接以 courseName
        // 作为标题前缀，不再写死「打扫 410」；并去掉结尾重复拼接的 courseName（避免
        // 出现「打扫410 · 410 · 打扫410」三连）。
        g.groupTitle = g.isClean
          ? ((g.courseName || '打扫410') + ' · ' + (util.fmtRoom(g.room) || '未填教室'))
          : ('第' + g.period + '节 · ' + (util.fmtRoom(g.room) || '未填教室') + ' · ' + g.courseName);
        g.count = g.members.length;
      });
      /* 🔴 不在前端重排：展示顺序以后端为准（class_date → period → 同节次内 CLEAN 在后），
       *    即 第4节课 → 打扫410 → 第5节（用户 2026-10-25 纠正：「打扫410不是每天最后」，
       *    其节次本就是第4节）。曾在此按 isClean 把保洁置底，反而压到第5节之后，已移除。
       *    merged 按 duties（后端序）首次出现顺序 push，天然有序，无需再排。 */
      return Object.assign({}, d, {
        duties,
        mergedDuties: merged,
        ghFlip: '', // 日期头 crossfade 初值（v0.7.19 需求②）
        weekdayText: util.weekdayCn(util.weekdayOfNum(d.date)),
        dateText: util.md(d.date),
        totalText: duties.length + ' 人'
      });
    });
  },

  /* ---------------- 周 ---------------- */
  onWeekChange(e) {
    const wk = Number(e.detail.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    /*
     * 换周统一带方向性动画：滑动、点箭头、周次选择器走同一条路（见 utils/swipe.js）。
     * 时序是「先让旧内容朝手指方向滑走（160ms），再换数据，新内容从反方向滑入」——
     * 反过来（先换数据再动）会先白一下再动，比不加动画还难看。
     * 越界（第 1 周还往右滑 / 最后一周还往左滑）由 shift 拦下，只播回弹、不换数据。
     */
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 真正换周（动画 out 段结束后才被回调） */
  _applyWeek(wk) {
    this._weekManual = true;   // 用户主动切周：此后 onShow 不再强行把 week 拉回当前周
    this.setData({ week: wk });
    // 换周 = 换一份数据：屏幕上那份已经不是这一周的了，必须让骨架回来，
    // 否则会拿上周的名单冒充本周（静默刷新只对「同一周重进页面」成立）
    this._hasData = false;
    this.load();
  },

  /** 左右滑动切周（左滑 = 下一周，右滑 = 上一周）。与箭头按钮同一条路径。 */
  _shiftWeek(delta) {
    this.onWeekChange({ detail: { week: Number(this.data.week) + delta } });
  },
  onSwipeStart(e) { swipe.begin(this, e); },
  onSwipeEnd(e) {
    // 弹层（值日详情 / 一键生成 / 合并行成员）的 DOM 就在页面根节点里，滑动会冒泡上来，必须挡掉
    if (this.data.sheetShow || this.data.aiShow || this.data.groupShow) return;
    const dir = swipe.end(this, e);
    if (dir === 'prev') this._shiftWeek(-1);
    else if (dir === 'next') this._shiftWeek(1);
  },

  /** 主内容 spring-scroll 重新测量可滚动范围（内容高度变化后必调，v0.7.19 需求④） */
  _resizeMain() {
    const sc = this.selectComponent('#dsMain');
    if (sc && typeof sc.resize === 'function') sc.resize();
  },


  onRow(e) {
    const id = e.currentTarget.dataset.id;
    const row = this._findRow(id);
    if (!row) return;
    // 从「已结束」弹层里点进来时先收起它，避免两个弹层叠着（本来就已经关着时是 no-op）
    // 合并行（>1 人）：先弹「本课次成员」列表，再点具体某人进 duty-sheet
    if (row.members && row.members.length > 1) {
      this.setData({ endedSheetShow: false, groupShow: true, groupMembers: row.members, groupTitle: row.groupTitle || '' });
      return;
    }
    // 单行（1 人）或按人子行：直接开 duty-sheet
    const dutyId = (row.members && row.members[0]) ? row.members[0].id : Number(id);
    this.setData({ endedSheetShow: false, sheetShow: true, sheetDutyId: dutyId });
  },
  /** 按 data-id 找回行对象：合成 id（'g'+sessionId）= 合并行；数字 = 扁平 duty */
  _findRow(id) {
    if (typeof id === 'string' && id.charAt(0) === 'g') {
      let found = null;
      (this.data.days || []).forEach(d => ((d.mergedDuties || []) || []).forEach(g => { if (g.id === id) found = g; }));
      return found;
    }
    const nid = Number(id);
    let found = null;
    (this.data.days || []).forEach(d => ((d.duties || []) || []).forEach(x => { if (Number(x.id) === nid) found = x; }));
    return found;
  },
  onGroupClose() { this.setData({ groupShow: false }); },

  /* ---------------- 「已结束」（2026-10-04 需求） ----------------
   * 本周里早于今天的日子不进「按日」主列表，收进这里；今天及以后照常显示。
   * 查看历史周时不折（pastDays 为空 → 入口不渲染）。 */
  onEndedOpen() {
    if (!this.data.pastDays.length) return;
    this.setData({ endedSheetShow: true });
  },
  onEndedClose() { this.setData({ endedSheetShow: false }); },
  /** 合并行成员列表里点某人 → 关掉成员列表，开该人的 duty-sheet */
  onGroupPick(e) {
    const dutyId = Number(e.currentTarget.dataset.id);
    if (!dutyId) return;
    this.setData({ groupShow: false, sheetShow: true, sheetDutyId: dutyId });
  },
  onSheetClose() { this.setData({ sheetShow: false }); },
  onSheetChanged() { this._invalidateManual(); this.load(true); },

  /**
   * 值日表被改动 → 作废「手动排班页」的缓存。
   * 本页自己的缓存不用管：紧接着的 `load()` 会用服务端最新数据覆盖它。
   * 调用点选在**写操作发起前**（乐观作废）：即使中途失败，也只是让下一个页面少一次缓存命中，
   * 比「写成了但另一个页面还拿旧名单」安全。
   */
  _invalidateManual() { mem.clear(mem.keys.manual(this.data.week)); },

  /* ---------------- 写操作的重入保护（busy 看门狗） ----------------
   * 四个写入口（生成 / 发布 / 撤回 / 清空）共用。原先各自 `if (busy) return;`
   * 是「静默失败」的温床：busy 一旦卡住，所有按钮就永久失效且毫无提示。
   * 这里是唯一入口，规则写一次：
   *   _busyStart()  置忙 + 上表；到点没结束就自动复位并给用户一句话
   *   _busyEnd()    手动复位（成功/失败都要调，别只在成功分支调）
   *   _busyGate()   true = 本次点击要放弃（并已给提示）；false = 可以继续
   */
  _busyStart() {
    this._busyAt = Date.now();
    this.setData({ busy: true });
    if (this._busyTimer) clearTimeout(this._busyTimer);
    this._busyTimer = setTimeout(() => {
      this._busyTimer = null;
      if (!this.data.busy) return;
      this._busyAt = 0;
      this.setData({ busy: false });
      util.toast('操作超时，已恢复，请重试');
    }, BUSY_TIMEOUT_MS);
  },

  _busyEnd() {
    if (this._busyTimer) { clearTimeout(this._busyTimer); this._busyTimer = null; }
    this._busyAt = 0;
    if (this.data.busy) this.setData({ busy: false });
  },

  /**
   * 返回 true 表示「这次点击不往下走」。
   * 只在**确认还在跑**时拦下并提示；计时器已不在（上一次请求早结束了、只是没人复位
   * busy）或已超过上限，就直接放行 —— 宁可多跑一次也不能让按钮变哑巴。
   */
  _busyGate() {
    if (!this.data.busy) return false;
    const stale = !this._busyTimer || (Date.now() - (this._busyAt || 0) > BUSY_TIMEOUT_MS);
    if (stale) { this._busyEnd(); return false; }
    util.toast('上一个操作还在进行，请稍候');
    return true;
  },

  /* ---------------- 管理员 · 一键生成（序号轮转 / AI） ---------------- */
  onAiOpen() {
    this.setData({
      aiShow: true, aiBusy: false, aiError: '', aiDiag: null,
      aiDiagOpen: false, aiDiagBrief: '',
      aiPlan: [], aiCleaningPlan: [], aiWarnings: [], aiNotes: [], aiSkipSeqs: []
    });
    this._checkAi();
    // 顺手刷一次「排班方式」摘要（静默失败不打扰；入口就在这个弹层里）
    this._loadSlots();
  },
  onAiClose() { this.setData({ aiShow: false }); },
  onAiInput(e) { this.setData({ aiText: e.detail.value }); },

  /* ---------------- 排班方式 · 岗位槽（2026-10-28） ----------------
   * 各班生活委员制度不同（每节课换人 / 一人包全天），原先规则写死在
   * 云函数 generate 的主循环里。这里让他们自己定义「哪几天、第几节、几个人」：
   *   period = null → 承包全天（当天所有节次共用这一批人）
   *   period = n    → 该节单独一个岗位
   * 「适用星期」一次勾选、全周共用，不用逐天重复填。
   * 保存后**只影响之后新生成的周**，已生成的周原样保留。
   */
  onSlotOpen() {
    this._syncDayChips();
    this._syncCleanSummary();
    this.setData({ slotShow: true });
    this._loadSlots();
  },
  onSlotClose() { this.setData({ slotShow: false }); },

  /* slotDays → chips 渲染态。
   * ⚠️ 必须在这里算 on：WXML 不支持 indexOf 这类方法调用，写 {{slotDays.indexOf(..)}} 会渲染成永远不选中。 */
  _syncDayChips() {
    const days = this.data.slotDays || [];
    this.setData({
      slotDayChips: (this.data.weekdayTexts || []).map((t, i) => ({
        wd: i + 1,
        text: t,
        on: days.indexOf(i + 1) >= 0
      }))
    });
  },

  /* ---------------- 18:10 打扫主教室（2026-10-28） ----------------
   * 独立于大课岗位：每一天一条保洁，人数**逐天可设**。
   * 保存时后端会为缺课次的天补齐 CLEAN 课次（period=4 = 18:10 下课），
   * 所以生活委员不用先去后台建课表。
   */
  /** CLEAN 槽列表 → 渲染行；WXML 不支持方法调用，text / key 必须在这里算好 */
  _decorateClean(list) {
    const wk = this.data.weekdayTexts;
    return (list || []).map((s, i) => {
      const wd = Math.min(7, Math.max(1, Number(s && s.weekday) || 1));
      return {
        key: 'c' + i + '_' + ((s && s.id) || 'n') + '_' + wd,
        wd,
        text: wk[wd - 1],
        needN: Math.min(10, Math.max(1, Number(s && s.needN) || 1))
      };
    }).sort((a, b) => a.wd - b.wd);
  },

  /** 把 [1,2,3,4,5] 说成「周一~周五」——连续区间合并，非连续用顿号 */
  _dayText(days) {
    const t = this.data.weekdayTexts || [];
    const arr = (days || []).slice().sort((a, b) => a - b);
    if (!arr.length) return '未选星期';
    const runs = [];
    let from = arr[0];
    let prev = arr[0];
    for (let i = 1; i < arr.length; i += 1) {
      if (arr[i] === prev + 1) { prev = arr[i]; continue; }
      runs.push([from, prev]);
      from = arr[i];
      prev = arr[i];
    }
    runs.push([from, prev]);
    return runs.map((p) => (p[0] === p[1] ? t[p[0] - 1] : (t[p[0] - 1] + '~' + t[p[1] - 1]))).join('、');
  },

  _syncCleanSummary() {
    let text = '未开启';
    const rows = this.data.cleanRows || [];
    if (this.data.cleanOn) {
      const days = rows.map((r) => r.wd);
      const n = rows.length ? Math.max.apply(null, rows.map((r) => r.needN)) : 0;
      text = this._dayText(days) + (rows.length ? (' · ' + (rows.length === 1 ? (n + ' 人') : ('最多 ' + n + ' 人'))) : '');
    }
    this.setData({ cleanSummary: text });
  },

  /* ---------------- 主教室（2026-10-28） ----------------
   * 生活委员自己填「18:10 打扫哪个教室」，落库到 class.main_room（与后台
   * 「班级设置 · 主教室」同一字段），保洁课次的名称/房间会跟着一起改。
   * ⚠️ 输入过程**不 setData 输入框的值**：中文输入法下 value 被回写会吞字，
   *    所以草稿只存 this._roomInput，失焦或保存时才提交（下方 _roomInput 优先）。
   */
  onRoomInput(e) {
    this._roomInput = String((e.detail && e.detail.value) || '');
    this._syncCleanTitle(this._roomInput);
  },

  onRoomBlur(e) {
    const v = String((e.detail && e.detail.value) || '').trim();
    this._roomInput = v;
    this.setData({ cleanRoom: v });
    this._syncCleanTitle(v);
  },

  /** 保洁标题跟着主教室走：设了 410 就是「每天 18:10 打扫410」 */
  _syncCleanTitle(v) {
    const room = String(v === undefined ? (this.data.cleanRoom || '') : (v || '')).trim();
    this.setData({ cleanTitle: '每天 18:10 ' + (room ? ('打扫' + room) : '打扫主教室') });
  },

  onCleanToggle(e) {
    const on = !!(e.detail && e.detail.value);
    /* 第一次打开：没数据就给周一到周五的默认行（最常见制度），
     * 让生活委员只改人数，不用从零点五遍「添加」。
     * 默认 2 人 = 生产库保洁课次的常态值（示例班级A 是周二大扫除 4 人、其余 2 人）。 */
    const patch = { cleanOn: on };
    if (on && !(this.data.cleanRows || []).length) {
      patch.cleanRows = this._decorateClean([1, 2, 3, 4, 5].map((wd) => ({ weekday: wd, needN: 2 })));
    }
    this.setData(patch);
    this._syncCleanSummary();
  },

  onCleanAdd() {
    const rows = (this.data.cleanRows || []).slice();
    /* 默认补到还没用过的最小星期，避免一加就撞车 */
    const used = rows.map((r) => r.wd);
    let wd = 1;
    while (wd <= 7 && used.indexOf(wd) >= 0) wd += 1;
    if (wd > 7) { util.toast('七天都已经有了'); return; }
    rows.push(this._decorateClean([{ weekday: wd, needN: 1 }])[0]);
    this.setData({ cleanRows: rows });
    this._syncCleanSummary();
  },

  onCleanWeekday(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const rows = (this.data.cleanRows || []).slice();
    if (!rows[i]) return;
    const wd = Math.min(7, Math.max(1, Number(e.detail.value) + 1));
    rows[i] = Object.assign({}, rows[i], { wd, text: this.data.weekdayTexts[wd - 1] });
    /* 同一天只能有一条保洁，改重复了直接顶掉原来那条 */
    const seen = {};
    const uniq = [];
    rows.forEach((r) => {
      if (seen[r.wd]) return;
      seen[r.wd] = 1;
      uniq.push(r);
    });
    this.setData({ cleanRows: uniq.sort((a, b) => a.wd - b.wd) });
    this._syncCleanSummary();
  },

  onCleanNeed(e) {
    const ds = e.currentTarget.dataset;
    const i = Number(ds.idx);
    const d = Number(ds.d);
    const rows = (this.data.cleanRows || []).slice();
    if (!rows[i]) return;
    const next = Math.min(10, Math.max(1, (Number(rows[i].needN) || 1) + d));
    rows[i] = Object.assign({}, rows[i], { needN: next });
    this.setData({ cleanRows: rows });
    this._syncCleanSummary();
  },

  onCleanDel(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const rows = (this.data.cleanRows || []).slice();
    if (!(i >= 0 && i < rows.length)) return;
    rows.splice(i, 1);
    this.setData({ cleanRows: rows });
    this._syncCleanSummary();
  },

  /** 切换某一天是否套用这套岗位 */
  onSlotDay(e) {
    const wd = Number(e.currentTarget.dataset.wd);
    if (!(wd >= 1 && wd <= 7)) return;
    const days = (this.data.slotDays || []).slice();
    const at = days.indexOf(wd);
    if (at >= 0) days.splice(at, 1);
    else { days.push(wd); days.sort((a, b) => a - b); }
    this.setData({ slotDays: days });
    this._syncDayChips();
  },

  /** 拉本班槽位 + 主教室。返回 { slots, mainRoom }，老形状（纯数组）也兼容。 */
  _loadSlots() {
    api.scheduleGetSlots({}, { toast: false })
      .then((r) => {
        const all = Array.isArray(r) ? r : ((r && r.slots) || []);
        /* 主教室（class.main_room）：老版本云函数不回这个字段 → 落到 ''，
         * 显示成「打扫主教室」，不会把已有 410 冲掉（保存时字段缺省=不改）。 */
        const room = Array.isArray(r) ? '' : String((r && r.mainRoom) || '').trim();
        /* 🔴 CLEAN 槽必须先剥出去：它是「18:10 保洁」，period 也是 null，
         * 混进岗位列表会被当成一行「全天」岗位显示出来（且保存时会重复写一遍）。 */
        const cleanRows = (all || []).filter(s => s && s.kind === 'CLEAN');
        const list = (all || []).filter(s => !s || s.kind !== 'CLEAN');
        /* 库里是「每个星期 × 每个岗位」一行，读回来要还原成「一组岗位 + 一组星期」：
         *   星期 = 出现过的星期并集；岗位 = 按 period 去重（同 period 在多天出现是同义重复）。 */
        const days = [];
        const seen = {};
        const uniq = [];
        (list || []).forEach((s) => {
          const wd = Math.min(7, Math.max(1, Number(s && s.weekday) || 1));
          if (days.indexOf(wd) < 0) days.push(wd);
          const hasP = s && s.period !== null && s.period !== undefined;
          const k = hasP ? ('p' + Number(s.period)) : 'all';
          if (seen[k]) return;
          seen[k] = 1;
          uniq.push(s);
        });
        /* 保洁区的还原：有 CLEAN 槽 ⇒ 开关打开，逐天还原天数与人数。
         * 🔴 绝不能给「没有 CLEAN 槽」的班自动补默认行：那等于凭空把保洁打开。 */
        this.setData({
          slotList: this._decorateSlots(uniq),
          slotDays: days.length ? days.sort((a, b) => a - b) : [1, 2, 3, 4, 5],
          cleanOn: cleanRows.length > 0,
          cleanRows: this._decorateClean(cleanRows),
          cleanRoom: room
        });
        /* 输入框的「未提交草稿」也跟着同步，否则上次打开残留的 _roomInput
         * 会在这次保存时盖掉刚从库里读到的值。 */
        this._roomInput = room;
        this._syncDayChips();
        this._syncCleanSummary();
        this._syncCleanTitle(room);
        this._syncSlotSummary(list);
      })
      .catch((e) => {
        /* 🔴 空 catch 会把 TypeError 伪装成「接口失败」，必须落日志 */
        console.error('[duty] loadSlots failed', e && e.stack ? e.stack : e);
      });
  },

  /**
   * 转成 WXML 直接能渲染的结构。
   * ⚠️ WXML 不支持方法调用，所以 periodText / periodIdx 必须在这里预算好；
   * ⚠️ wx:key 只接属性名，所以每行额外给一个 key。
   */
  _decorateSlots(list) {
    const pd = this.data.periodTexts;
    return (list || []).map((s, i) => {
      const hasP = s && s.period !== null && s.period !== undefined;
      const p = hasP ? Number(s.period) : null;
      return {
        key: 's' + i + '_' + ((s && s.id) || 'n'),
        id: Number(s && s.id) || 0,
        period: p,
        periodIdx: p === null ? 0 : Math.min(pd.length - 1, p),
        periodText: p === null ? '全天' : ('第' + p + '节'),
        needN: Math.min(10, Math.max(1, Number(s && s.needN) || 1))
      };
    });
  },

  /** 入口那行的摘要文案：未设置 / 一人包全天 · N 天 / 每节课不同人 · N 天 */
  _syncSlotSummary(list) {
    const rows = list || [];
    const days = [];
    const periods = [];
    rows.forEach((s) => {
      const wd = Math.min(7, Math.max(1, Number(s && s.weekday) || 1));
      if (days.indexOf(wd) < 0) days.push(wd);
      const k = (s && s.period !== null && s.period !== undefined) ? ('p' + Number(s.period)) : 'all';
      if (periods.indexOf(k) < 0) periods.push(k);
    });
    let text = '未设置';
    if (rows.length) {
      const allDay = periods.every(k => k === 'all');
      const allPeriod = periods.every(k => k !== 'all');
      const kind = allDay ? '一人包全天' : (allPeriod ? '每节课不同人' : '自定义');
      text = kind + ' · ' + periods.length + ' 个岗位 / ' + days.length + ' 天';
    }
    this.setData({ slotSummary: text });
  },

  onSlotAdd() {
    const list = this.data.slotList.slice();
    list.push(this._decorateSlots([{ period: null, needN: 1 }])[0]);
    this.setData({ slotList: list });
  },

  onSlotDel(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const list = this.data.slotList.slice();
    if (!(i >= 0 && i < list.length)) return;
    list.splice(i, 1);
    this.setData({ slotList: list });
  },

  onSlotPeriod(e) {
    const i = Number(e.currentTarget.dataset.idx);
    const idx = Number(e.detail.value);
    const list = this.data.slotList.slice();
    const period = idx === 0 ? null : idx;
    list[i] = Object.assign({}, list[i], {
      period,
      periodIdx: idx,
      periodText: this.data.periodTexts[idx]
    });
    this.setData({ slotList: list });
  },

  onSlotNeed(e) {
    const ds = e.currentTarget.dataset;
    const i = Number(ds.idx);
    const d = Number(ds.d);
    const list = this.data.slotList.slice();
    if (!list[i]) return;
    const next = Math.min(10, Math.max(1, (Number(list[i].needN) || 1) + d));
    list[i] = Object.assign({}, list[i], { needN: next });
    this.setData({ slotList: list });
  },

  onSlotSave() {
    if (this.data.slotBusy) return;
    const list = this.data.slotList || [];
    const days = this.data.slotDays || [];
    /* 有岗位但一天都没勾 ⇒ 保存后等于「全周不排」，几乎一定是误操作，先拦住 */
    if (list.length && !days.length) {
      util.toast('请至少勾选一天');
      return;
    }
    /* 整体覆盖语义：整份提交，后端事务内先删后插。
     * 展开 = 勾中的每个星期 × 每个岗位 → 一行 duty_slot。
     * 例：勾周一~周五 + 建「第1节2人 / 第2节2人」= 存 10 行，用户只填一次。
     * fixedSeq 暂不在 UI 暴露（后端已支持），先按 null 参与轮转。 */
    const slots = [];
    days.forEach((wd) => {
      list.forEach((s) => {
        slots.push({
          weekday: wd,
          period: s.period,
          needN: s.needN,
          fixedSeq: null,
          kind: 'NORMAL'
        });
      });
    });
    /* 18:10 打扫主教室：逐天一行 CLEAN 槽（period 留空 = 不限节次，
     * 保洁课次固定在 18:10 那一条）。后端会顺带补齐缺失的保洁课次。
     * 列表里没有的天 → 保洁不排人（后端按「配过 CLEAN 槽即由槽位定义」处理）。 */
    if (this.data.cleanOn) {
      const cr = this.data.cleanRows || [];
      if (!cr.length) {
        util.toast('请至少添加一个打扫日');
        return;
      }
      cr.forEach((r) => {
        slots.push({
          weekday: r.wd,
          period: null,
          needN: Math.min(10, Math.max(1, Number(r.needN) || 1)),
          fixedSeq: null,
          kind: 'CLEAN'
        });
      });
    }
    this.setData({ slotBusy: true });
    /* 主教室跟着同一份提交走（'' = 清空，后端只在字段出现时才改）。
     * ⚠️ 草稿优先：用户打完字直接点保存时 bindblur 可能还没跑，
     *    所以 _roomInput 有值就以它为准。 */
    const room = String(this._roomInput === undefined
      ? (this.data.cleanRoom || '') : (this._roomInput || '')).trim();
    api.scheduleSetSlots({ slots, mainRoom: room }, { loading: '保存中' })
      .then((r) => {
        const saved = Array.isArray(r) ? r : ((r && r.slots) || []);
        const savedRoom = Array.isArray(r) ? room : String((r && r.mainRoom) || '').trim();
        this._roomInput = savedRoom;
        this.setData({ slotBusy: false, slotShow: false, cleanRoom: savedRoom });
        this._syncCleanTitle(savedRoom);
        /* 摘要只统计大课岗位：CLEAN 槽没有 period，混进来会被数成「全天岗位」 */
        this._syncSlotSummary((saved || []).filter(s => !s || s.kind !== 'CLEAN'));
        util.toast('已保存，下次生成生效');
      })
      .catch((e) => {
        this.setData({ slotBusy: false });
        util.toast(this._errText(e));
      });
  },

  /** 真正探测一次「出口有没有配密钥」，避免只在代理模式下盲目显示可用 */
  _checkAi() {
    api.scheduleAiCheck({}, { toast: false })
      .then((r) => {
        /* 🔴 只取「有没有密钥 / 什么模型」，**不要**把 r 塞进 aiDiag ——
         * 那会让诊断面板在打开弹层时自动展开（用户 2026-10-28 打回：
         * 「这个折叠起来默认不展示」）。诊断信息只在点「自检」时才给。 */
        this.setData({
          aiHasKey: !!(r && r.hasKey),
          aiModel: (r && r.model) || this.data.aiModel
        });
      })
      .catch((e) => {
        // 空 catch 会把 TypeError 伪装成「接口失败」，这里必须留痕
        console.error('[duty._checkAi]', (e && e.stack) || e);
      });
  },

  /** 诊断结果压成一行摘要，收起态也能一眼看出结论 */
  _briefDiag(d) {
    if (!d) return '';
    const parts = [];
    parts.push(d.hasKey ? '密钥已配置' : '缺密钥');
    if (d.egress) parts.push(d.egress + (d.httpStatus ? (' / HTTP ' + d.httpStatus) : ''));
    if (d.error) parts.push('有错误');
    else if (d.reply) parts.push('往返成功');
    return parts.join(' · ');
  },

  /**
   * 自检：真实往返一次大模型（点它会真的花钱，但能一次定位到底是
   * 出口不通、缺密钥、包部署不对，还是模型本身在报错）。
   * 结果**默认收起**，只露一行摘要；要看明细点展开。
   */
  onAiDiag() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiError: '', aiDiag: null, aiDiagOpen: false, aiDiagBrief: '' });
    api.scheduleAiCheck({ probe: true }, { toast: false, loading: '自检中' })
      .then((r) => this.setData({
        aiBusy: false,
        aiDiag: r || null,
        aiDiagOpen: false,
        aiDiagBrief: this._briefDiag(r)
      }))
      .catch((e) => this.setData({ aiBusy: false, aiError: this._errText(e) }));
  },

  onAiDiagToggle() {
    this.setData({ aiDiagOpen: !this.data.aiDiagOpen });
  },

  onAiCopyDiag() {
    const d = this.data.aiDiag || {};
    let s = '模型：' + (d.model || '-') + '\n通路：' + (d.route || '-') +
      '\n出口：' + (d.egress || '-') + '（HTTP ' + (d.httpStatus || 0) + '）' +
      '\n有密钥：' + (d.hasKey ? '是' : '否') +
      '\n部署包含 seqOf：' + (d.hasSeqOf ? '是' : '否') +
      '\n环境变量：' + JSON.stringify(d.env || {});
    if (d.reply) s += '\n真实往返：成功（' + (d.probeMs || 0) + 'ms）返回 ' + d.reply;
    if (d.error) s += '\n错误：' + d.error;
    if (this.data.aiError) s += '\n本次失败：' + this.data.aiError;
    wx.setClipboardData({ data: s, success: () => util.toast('已复制自检信息') });
  },

  /** 把云函数回来的错误压成一行可读文本（带错误码，便于对照排查） */
  _errText(e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.code);
    const msg = (e && (e.errMsg || e.message)) || '未知错误';
    return (code !== undefined && code !== null ? '[' + code + '] ' : '') + msg;
  },

  onAiRun() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiError: '', aiPlan: [], aiCleaningPlan: [], aiWarnings: [], aiNotes: '' });
    api.scheduleAiPlan({
      week: this.data.week,
      text: this.data.aiText
    }, { loading: 'AI 生成中' })
      .then((r) => {
        const plan = ((r && r.plan) || []).map(p => Object.assign({}, p, {
          namesText: (p.names || []).join('、') || '未排'
        }));
        // 保洁不在 aiPlan 里（模型看不到它），后端单独回传一份「应用后会补的保洁」
        const cleaning = ((r && r.cleaningPlan) || []).map(p => Object.assign({}, p, {
          namesText: (p.names || []).join('、') || '未排',
          whenText: util.whenText('CLEAN', p.period),
          course: p.course || '打扫410'
        }));
        this.setData({
          aiBusy: false,
          aiError: '',
          aiPlan: plan,
          aiCleaningPlan: cleaning,
          aiWarnings: (r && r.warnings) || [],
          aiNotes: (r && r.notes) || '',
          aiSkipSeqs: (r && r.skipSeqs) || [],
          aiModel: (r && r.model) || this.data.aiModel
        });
        if (!plan.length) util.toast('AI 没有给出可用的排班，请换个说法');
      })
      // 关键：不要吞掉错误。以前这里什么都不显示，用户只看到弹层没反应，
      // 完全无从下手排查。现在把云函数回的真实文案留在弹层里，可复制。
      .catch((e) => this.setData({ aiBusy: false, aiError: this._errText(e) }));
  },

  onAiApply() {
    if (this.data.aiBusy || !this.data.aiPlan.length) return;
    this.setData({ aiBusy: true, aiError: '' });
    this._invalidateManual();
    api.scheduleAiApply({
      week: this.data.week,
      plan: this.data.aiPlan.map(p => ({ sessionId: p.sessionId, memberSeqs: p.memberSeqs })),
      // 「保持原样」的课次必须显式告诉服务端，否则会被当成空计划重排
      unchanged: this.data.aiPlan.filter(p => p.kept).map(p => p.sessionId),
      skipSeqs: this.data.aiSkipSeqs
    }, { loading: '写入中' })
      .then((r) => {
        this.setData({ aiBusy: false, aiShow: false, aiPlan: [] });
        let msg = '已按 AI 方案排 ' + ((r && r.created) || 0) + ' 条值日';
        if (r && r.warnings && r.warnings.length) msg += '（有 ' + r.warnings.length + ' 条提醒）';
        if (r && r.resetPublish) msg += '；本周已退回待发布，请重新发布';
        util.toast(msg);
        this.load(true);
      })
      .catch((e) => this.setData({ aiBusy: false, aiError: this._errText(e) }));
  },

  onAiDiscard() { this.setData({ aiPlan: [], aiCleaningPlan: [], aiWarnings: [], aiNotes: '', aiSkipSeqs: [], aiError: '' }); },

  /** 不用 AI：直接按序号轮转生成（原有逻辑） */
  onGenerate() {
    if (this._busyGate()) return;
    /*
     * 用 confirmStrict 而不是 confirm：后者把「取消」和「弹窗没弹出来」都压成 false，
     * 调用方一句 `if (!ok) return;` 就变成「点了没反应」。这里对 fail 必须给一句话。
     */
    util.confirmStrict('按「序号轮转」生成本周值日：接上次排到的地方继续，排满 56 号后自动从 1 号重来；已手动调整的保留不动', '按序号轮转生成')
      .then((act) => {
        if (act === 'fail') { util.toast('确认弹窗没打开，请退出重进本页再试'); return; }
        if (act !== 'confirm') return;
        this._busyStart();
        this._invalidateManual();
        api.scheduleGenerate({ week: this.data.week }, { loading: '生成中' })
          .then((r) => {
            this._busyEnd();
            this.setData({ aiShow: false });
            let msg = '已生成 ' + ((r && r.created) || 0) + ' 条值日';
            if (r && r.holidaySkipped) msg += '，跳过 ' + r.holidaySkipped + ' 节放假课';
            /*
             * `roundReset` 在后端把**两种情形**合成了一个标志，所以文案必须对两者都成立，
             * 绝不能说成「从 1 号重新开始」——
             *   ① 生成开始时全班 56 人本轮都已排满 → 服务端清零标记，本轮从头开；
             *   ② 本周名额多于「本轮还没排的人」（第 4 周就是这样：只剩 49~56 八个人，
             *      却要排 16 个名额）→ 排完 49~56 后**接着序号**进入下一轮（01~08）。
             * 两句的共同事实只有一条：本轮 56 人已经走完一遍，之后是顺着序号继续，不是重头来。
             * （2026-09-26 用户明确要求「接着上一周继续生成，而不是从 1 号重新生成」，
             *   旧文案「本轮已排满，已从 1 号重新开始」正好把情形②说反了。）
             */
            if (r && r.roundReset) msg += '；本轮 56 人已轮完，接着序号继续往下排';
            if (r && r.resetPublish) msg += '；本周已退回待发布，请重新发布';
            util.toast(msg);
            this.load(true);
          })
          // 不能吞错误：只复位 busy、什么都不说的话，用户视角仍然是「点了没反应」
          .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
      });
  },

  onPublish() {
    if (this._busyGate()) return;
    this._busyStart();
    this._invalidateManual();
    api.schedulePublish({ week: this.data.week }, { loading: '发布中' })
      .then(() => {
        this._busyEnd();
        util.toast('本周值日已发布');
        this.load(true);
      })
      .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
  },

  onUnpublish() {
    if (this._busyGate()) return;
    this._busyStart();
    this._invalidateManual();
    api.scheduleUnpublish({ week: this.data.week }, { loading: '处理中' })
      .then(() => {
        this._busyEnd();
        util.toast('已撤回发布');
        this.load(true);
      })
      .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
  },

  /** 清空本周：删除全部值日（含手动）并重置轮转计数，便于一键重新生成 */
  onClear() {
    if (this._busyGate()) return;
    util.confirmStrict('将清空本周全部值日（含手动调整）并重置轮转计数，之后可一键重新生成', '清空本周')
      .then((act) => {
        if (act === 'fail') { util.toast('确认弹窗没打开，请退出重进本页再试'); return; }
        if (act !== 'confirm') return;
        this._busyStart();
        this._invalidateManual();
        api.scheduleClear({ week: this.data.week }, { loading: '清空中' })
          .then(() => {
            this._busyEnd();
            util.toast('已清空，可重新生成');
            this.load(true);
          })
          .catch((e) => { this._busyEnd(); util.toast(this._errText(e)); });
      });
  },

  /* ---------------- 合并行成员弹层（1.0.4.4 #27，替代原「导出」） ---------------- */

  onReload() { this.load(true); },
  noop() {}
});
