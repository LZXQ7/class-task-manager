/**
 * P3 · 课表周视图（Tab 2）
 * ------------------------------------------------------------
 * 课表数据是**一学期不变的静态数据**，已固化在 `data/timetable.js` 里，
 * 打开页面即渲染，不依赖网络（断网、云函数异常都不会再出现「数据没加载出来」）。
 *
 * 仍然联网的两处，且都不影响课表渲染：
 *   ① 打开「课次详情」时按需拉一次本周值日名单（失败就只不显示名单）；
 *   ② 管理员改动课表 / 校历时需要写回数据库 —— 值日生成读的是库里那份。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const tt = require('../../data/timetable');
const config = require('../../utils/config');
const pageAnim = require('../../utils/page-anim');
const impersonate = require('../../utils/impersonate');
const theme = require('../../utils/theme');
/*
 * v0.7.20 需求③「课程表左右切换添加动画」：复用值日页 / 手动排班页那套方向性过渡
 * （out 160ms 滑走 → 换数据 → in 220ms 滑入，class 与 keyframes 都在 app.wxss）。
 * ⚠️ 只借它的**动画**，**不借它的手势**：课表主体本身是 `scroll-x`，横向手势另有归属，
 *    挂 onSwipeStart 会和横向滚动抢方向（scripts/check-week-swipe.js ③ 明确断言
 *    「课表页不得挂 onSwipeStart」）。所以这里只有 onWeekChange / onPickWeek 走 swipe.shift。
 */
const swipe = require('../../utils/swipe');
/** 列表过渡（A 组 ⇄ B 组）：机制/时长/可打断全在该模块，与 roster / duty 共用一份 */
const listTransition = require('../../utils/list-transition');

const WEEK_RULES = [
  { key: 'ALL', text: '全周' },
  { key: 'ODD', text: '单周' },
  { key: 'EVEN', text: '双周' }
];
const DAYS = [
  { key: 1, text: '一' }, { key: 2, text: '二' }, { key: 3, text: '三' },
  { key: 4, text: '四' }, { key: 5, text: '五' },
  // 周六 / 周日也要能排课：调休（周末补课）时把课次直接排到周末那两天
  { key: 6, text: '六' }, { key: 7, text: '日' }
];

/**
 * 课表列宽不再写死 —— 按「实际显示的天数」自适应屏幕宽度：
 *   周一~周五（5 天）→ 平分右侧可视宽，正好铺满，无需横向滚动；
 *   有周末课（6/7 天）→ 用较窄的固定列宽 + 横向滚动（7 列硬塞进 600rpx 会看不清课名）。
 * 下列常量必须与 WXSS 的 `.tt-fixed` width（86rpx）与 `.tt-board` 左右留白（32rpx×2）一致。
 */
const FIXED_W = 86;               // 左侧「节次」列宽
const BOARD_PAD = 64;             // 课表左右留白（各 32rpx）
const BOARD_INNER = 750 - BOARD_PAD - FIXED_W;   // 右侧可视宽（rpx）= 600
const COL_W_WEEKEND = 110;        // 显示周六 / 周日时的列宽（放不下就横向滚）

/** 个人选修课在网格里的配色（与全班课次区分开，一眼看出是「自己的」） */
const PERSONAL_BG = '#EAF1FF';
const PERSONAL_FG = '#3370FF';


/** 周次数组 → 展示文案：空 = 每周都上 */
function weekText(weeks) {
  const arr = typeof weeks === 'string'
    ? weeks.split(',').filter(Boolean).map(Number)
    : (weeks || []);
  if (!arr.length) return '每周';
  return '第 ' + arr.join('、') + ' 周';
}

Page({
  data: {
    statusBarHeight: 20,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版），见 utils/page-anim.js */
    animSeq: 0,
    /** 入场动画就绪标记（v0.7.31）：false = 根节点挂 pa-hold（块透明），等首屏身份+数据就绪再统一开播 */
    paReady: false,
    /** 切周方向性动画 class（'' = 静止）；由 utils/swipe.js 下发，样式在 app.wxss */
    swipeCls: '',
    loading: true,
    failed: false,
    isAdmin: false,
    isSuper: false,
    /** 辅导员（group_tag='X'）：可跨班查看课表（2026-10 需求） */
    isCounselor: false,
    /** 当前班是否已有课表 —— 由云端同步结果决定（空列表=该班还没有课表 ⇒ 走空态），不再按 classId 写死 */
    hasTimetable: true,
    /** 辅导员/超管：可切换查看的班级列表（class.list 已按 staff_class 过滤）[{id,name,termStart,totalWeeks}] */
    classList: [],
    /** 当前查看/渲染的班级 id（学生=本班；辅导员/超管=所选班） */
    viewClassId: 0,
    /** 辅导员/超管：可跨班查看课表（决定是否渲染切班标签与课表网格） */
    canSwitchClass: false,
    /** 「切换测试账号」模拟态顶部横幅（v1.0.5）：非空即渲染红色护栏条 */
    impersonateBanner: '',
    termStart: '',
    totalWeeks: 18,
    week: 1,
    current: 1,

    dates: [],          // [{dow, short, day, isToday, isHoliday, holidayName, isMakeup, isWeekend}]（只含实际显示的天）
    periods: [],        // [{p, label, start}]
    grid: [],           // 5 行 × N 列（N = 实际显示天数，默认周一~周五，周末有课才含周六日）
    dateWidth: 0,       // 日期区总宽（rpx）：供横向滚动容器定宽
    colW: 120,          // 单列宽（rpx）：按显示天数自适应
    rowH: 132,          // 单行高（rpx）：按屏幕高度自适应
    headH: 72,          // 表头高（rpx）
    showScrollHint: false, // 仅在出现周末列（需要横向滚动）时提示
    tip: '',
    viewGroup: 'A',     // 课表视图：仅看 A 组 / 仅看 B 组（含全体课）
    /** 左下角入口（视图 + 临时调课合并）的展开态，v0.7.21 需求③ */
    fabMenuOpen: false,
    /** 右下角加课按钮是否可见（2026-10-15）：人人可见，但普通同学只能加个人选修课（限 2 门） */
    fabShow: false,

    failMsg: '',

    detailShow: false,
    detail: null,

    formShow: false,
    form: null,
    /** 表单模式：'class' = 全班课次（管理员）；'elective' = 个人选修课（人人，最多 2 门，仅自己可见） */
    formMode: 'class',

    weekPickerShow: false,
    weekList: [],
    weekBtns: [],

    /* 校历（节假日 / 调休 / 调课） */
    calShow: false,
    calLoading: false,
    calHolidays: [],
    calShifts: [],
    holidayForm: { date: '', name: '', kind: 'OFF' },
    shiftForm: { from: '', to: '', note: '' },

    /* ---------- 临时调课（按周生效的课次例外） ---------- */
    shiftShow: false,
    shiftTab: 'week',
    shiftTabs: [
      { key: 'week', text: '本周' },
      { key: 'multi', text: '多周次' },
      { key: 'date', text: '按日期' },
      { key: 'ai', text: 'AI 调课' },
      { key: 'list', text: '结果' }
    ],
    shiftSessionLabels: [],
    shiftSessionIndex: 0,
    shiftKind: 'OFF',          // OFF=本周不上；MOVE=改到别的格子
    shiftToDay: 1,
    shiftToPeriod: 1,
    shiftWeeks: [],            // 多周次模式选中的周次
    shiftWeekBtns: [],
    shiftSaving: false,
    offDays: [],               // 「按日期」里勾选的「不上课」的星期（1-7）
    periodChips: [1, 2, 3, 4, 5],   // 节次选择器（新增/编辑课次表单用）；初值=兜底 5，class.list 回来后按本班 period_time 重算（_syncPeriodCount）

    /* AI 智能调课 */
    aiText: '',
    aiBusy: false,
    aiError: '',
    aiPrompt: '',
    aiPromptShow: false,
    aiPreview: [],
    aiOps: [],
    aiNotes: '',
    aiWarnings: [],
    aiExamples: [
      '把周三第 5 节的音乐基础改到周五第 1 节',
      '这周四第 3 节不上',
      '周五的课全部不上',
      '周一第 2 节的微课设计与制作改到周二第 4 节'
    ],

    /* 临时调课结果 */
    shiftItems: [],

    dayChips: DAYS,
    weekRules: WEEK_RULES,
    saving: false
  },

  onLoad() {
    const app = getApp();
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    // 课表相关的一律用本地常量，不依赖登录返回的 config
    const cw = util.currentWeek(tt.TERM_START, tt.TOTAL_WEEKS) || 1;
    this.setData({
      statusBarHeight: app.globalData.statusBarHeight || 20,
      termStart: tt.TERM_START,
      totalWeeks: tt.TOTAL_WEEKS,
      current: cw,
      week: cw
    });
    this._buildWeekList();
  },

  onShow() {
    const app = getApp();
    app.setTabBar(1);
    // v0.7.31：不再立即播 —— 等「身份(app.ready) + 首屏数据(loading=false)」就绪、或 READY_MS 兜底超时再统一开播
    pageAnim.playReady(this, getApp());
    let firstCounselor = false;
    const applyAuth = () => {
      const p = (app && app.globalData && app.globalData.profile) || {};
      firstCounselor = p.groupTag === 'X';
      const isSuper = !!(app && app.isSuper && app.isSuper());
      // ⚠️ hasTimetable 不在这里定：它已改由云端同步结果决定（_syncFromCloud 空列表 ⇒ false）。
      //     applyAuth 会在 onShow/重校时反复执行，若在这里按 classId 写死会覆盖同步结论，
      //     且其他班（示例班级B 等）导入课表后会被误拦进空态。
      // 切班条可见范围（2026-10-09）：仅「辅导员」与「超管且处于切换测试账号态」展示；
      // 真实超管（本人、未切换）与学生都不显示，锁定本班。
      // canSwitchClass（周次条 / fab 菜单 / 空态 / 值日名单 classId）仍按 isCounselor || isSuper 放开，
      // 保证真实超管看本班时功能完整（能换周、能临时调课）；**分组默认不看它**（见下方 ownGroup）。
      const switched = !!(app && app.globalData && app.globalData.switched);
      // 默认分组视图（2026-10-09 用户定「打开课表默认看自己所在的组」）：
      //   · 自己 groupTag 是 A/B ⇒ 默认自己那组（A 组同学打开即见 A 组课）；
      //   · 辅导员（groupTag='X'）或无组（超管/异常）⇒ 默认 'ALL'，
      //     否则辅导员看多组班会「只显示一半」（问题③复发）。
      // 手动选过组（_groupPicked）后不再被默认值覆盖。
      const ownGroup = (p.groupTag === 'A' || p.groupTag === 'B') ? p.groupTag : '';
      const patch = {
        isAdmin: !!(app && app.isAdmin && app.isAdmin()),
        isSuper: isSuper,
        isCounselor: firstCounselor,
        canSwitchClass: !!(firstCounselor || isSuper),
        showClassSwitch: !!(firstCounselor || (isSuper && switched))
      };
      if (!this._groupPicked) patch.viewGroup = ownGroup || 'ALL';
      this.setData(patch);
      // 右下角加课按钮可见性（人人可见个人选修课；管理员额外可加全班课次）
      this._recomputeFab();
      // 模拟态护栏（v1.0.5）：身份套用后同步顶部横幅
      impersonate.sync(this);
    };
    applyAuth();
    const wasCounselor = firstCounselor;
    // 分支①（2026-10）：已启动且班级/身份未变 ⇒ 本地即时渲染 + 后台静默同步，
    // 不再每次切 Tab 都重拉云端并清空网格（避免刷新闪烁）。
    const booted = this._booted;
    const sameClass = booted && Number(this.data.viewClassId) === this._bootedClassId;
    const sameIdentity = booted
      && this._bootedIsCounselor === this.data.isCounselor
      && this._bootedIsSuper === this.data.isSuper;
    if (booted && sameClass && sameIdentity) {
      this.load();                                       // 本地即时渲染（无 loading、无网络）
      this._syncFromCloud({ classId: this.data.viewClassId }); // 后台静默同步：不进 loading、不重拉班级列表
    } else {
      this._afterAuth();                                 // 首次 / 切班 / 身份变化：完整流程
    }
    // 登录可能在 onShow 之后才完成：登录就绪后重新套用身份，避免超级管理员编辑入口首屏不显示。
    // 需求⑧：身份从「非辅导员」变成「辅导员」时必须再走一次 _afterAuth 把网格清掉。
    if (app && app.globalData && !app.globalData.authChecked) {
      app.ready().then(() => {
        applyAuth();
        if (this.data.isCounselor !== wasCounselor) this._afterAuth();
      });
    }
    // v0.7.32 问题②：切 tab 也做一次节流身份重校；身份变了就重套 + 重建课表
    if (typeof app.recheckAuth === 'function') {
      app.recheckAuth().then((changed) => {
        if (!changed) return;
        applyAuth();
        this._afterAuth();
      }).catch(() => {});
    }
  },

  /** 顶部「模拟中」横幅的「恢复本人」（v1.0.5） */
  onRecoverSelf() {
    impersonate.recover();
  },

  /**
   * 需求⑧ 二次升级（2026-10）：课表真源已按班级全量上云，不再按「是否默认课表班」写死拦截 ——
   * 示例班级B 等其他班导入课表后同样要能渲染。学生与辅导员/超管统一走
   * 「class.list 取班级（学生=本班、辅导员/超管=绑定班）→ tt.setClass → 云端同步」，
   * 该班有没有课表由同步结果决定（空列表 ⇒ hasTimetable=false ⇒ 走空态）。
   */
  _afterAuth() {
    this._loadTimetableClasses();
  },

  /** 拉可取班级列表（class.list：学生=本班；辅导员/超管=按 staff_class 过滤的绑定班），默认选中默认课表班或第一个 */
  _loadTimetableClasses() {
    api.classList({}, { toast: false })
      .then((list) => {
        const chips = util.sortClasses(list || []).map(c => ({
          id: Number(c.id), name: c.name, termStart: c.termStart, totalWeeks: c.totalWeeks,
          // 带 periodTime 供节次数用（本班可配到第 6 节等，2026-10-14）
          periodTime: c.periodTime || []
        }));
        if (!chips.length) {
          // 清掉 tt 模块可能残留的上一身份/上一班状态，避免课表残影
          tt.setClass(config.TIMETABLE_CLASS_ID);
          this.setData({ loading: false, classList: [], grid: [], dates: [], periods: [], tip: '' });
          return;
        }
        const keep = chips.some(c => c.id === Number(this.data.viewClassId));
        const def = keep ? Number(this.data.viewClassId)
          : (chips.some(c => c.id === config.TIMETABLE_CLASS_ID) ? config.TIMETABLE_CLASS_ID : chips[0].id);
        const sel = chips.find(c => c.id === def) || chips[0];
        this.setData({
          classList: chips,
          viewClassId: def,
          termStart: sel.termStart || tt.TERM_START,
          totalWeeks: sel.totalWeeks || tt.TOTAL_WEEKS,
          week: Math.min(this.data.week, sel.totalWeeks || tt.TOTAL_WEEKS)
        });
        tt.setClass(def, sel.termStart, sel.totalWeeks);
        // 节次数跟随本班配置（切班时也要跟着变：不同班的大节数可以不同）
        this._syncPeriodCount(def);
        this._buildWeekList();
        this._afterClassPicked();
      })
      .catch(() => { this.setData({ loading: false, failed: true, failMsg: '班级信息加载失败，请检查网络后重试' }); });
  },

  /** 把「当前查看班」的节次数写进 tt 模块，并同步到 data.periodChips（节次选择器） */
  _syncPeriodCount(classId) {
    const cid = Number(classId || this.data.viewClassId) || 0;
    const cls = (this.data.classList || []).find(c => Number(c.id) === cid);
    const n = tt.setPeriods((cls && cls.periodTime) || []);
    const chips = [];
    for (let p = 1; p <= n; p++) chips.push(p);
    this.setData({ periodChips: chips });
    return n;
  },

  /** 选定/切换班级后的统一收尾：强制重新同步该班真源并渲染 */
  _afterClassPicked() {
    this._syncedWeek = 0;   // 换班强制重新同步（_syncFromCloud 按周去重，这里取消去重）
    this._dutyWeek = 0;     // 值日名单也要跟着换班重拉
    // 默认分组由 applyAuth 统一决定（自己那组 / ALL）——这里**不要**再覆盖成 'ALL'，
    // 否则会把「自己所在的组」又冲成全部（用户 2026-10-09 明确要默认看本组）。
    // 分支①（2026-10）：标记已启动 + 记录班级/身份，供 onShow 判断是否走本地缓存短路
    this._booted = true;
    this._bootedClassId = Number(this.data.viewClassId);
    this._bootedIsCounselor = this.data.isCounselor;
    this._bootedIsSuper = this.data.isSuper;
    this.setData({ loading: true, failed: false, failMsg: '' });
    this._recomputeFab();
    this._syncFromCloud({ classId: this.data.viewClassId });
    this._loadPersonal();
  },

  /** 辅导员/超管切班：换一份课表真源（强制重新同步，不走静默缓存） */
  onTimetableClass(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id || id === Number(this.data.viewClassId)) return;
    const sel = (this.data.classList || []).find(c => c.id === id);
    if (!sel) return;
    this.setData({
      viewClassId: id,
      termStart: sel.termStart || tt.TERM_START,
      totalWeeks: sel.totalWeeks || tt.TOTAL_WEEKS,
      week: Math.min(this.data.week, sel.totalWeeks || tt.TOTAL_WEEKS)
    });
    tt.setClass(id, sel.termStart, sel.totalWeeks);
    // 节次数按新班级重算（不同班大节数可以不同）
    this._syncPeriodCount(id);
    this._buildWeekList();
    this._afterClassPicked();
  },

  /**
   * 课表真源同步（2026-07-07）：把 `session` 表（班委发布 / 青果导入）拉下来覆盖本地课表。
   *
   * 背景：课表过去**只读本地那份 2026-09-24 硬编码快照**，于是
   *   ① 班委改课表 / 导入课表后页面不变；
   *   ② 同一门课「全体课表」显示一个教室、同步出来显示另一个教室（两个来源打架）。
   * 现在真源统一到云端，本地只当断网兜底。
   *
   * ⚠️ 三条自我保护，缺一个就会出现「课表凭空清空」这类更糟的故障：
   *   · 失败**不阻断**渲染：先本地渲染一份，网络回来再刷新；
   *   · 写盘只在拿到**非空且合法**列表时进行（replaceSessions 内部再校验一次）；
   *   · 同一周内只拉一次（`_syncedWeek`），切周不发请求。
   */
  _syncFromCloud(payload) {
    // 令牌防串班：同步期间再点切班，旧响应回来时令牌已变 ⇒ 直接丢弃。
    // 否则旧班的课次会被 replaceSessions 写进新班的本地缓存（串班污染）。
    const token = (this._syncToken = (this._syncToken || 0) + 1);
    api.courseAllSessions(payload || {}, { toast: false })
      .then((res) => {
        if (token !== this._syncToken) return;    // 过期响应，丢弃
        this._syncedWeek = this.data.week;
        const list = Array.isArray(res) ? res : ((res && res.list) || []);
        // 空/不合法列表不写盘（保留本地兜底），但「该班有没有课表」以云端为准：
        // 空列表 ⇒ hasTimetable=false ⇒ 学生走「课表待接入」、辅导员走「该班还没有课表」空态。
        tt.replaceSessions(list);
        this.setData({ hasTimetable: list.length > 0 });
        this._recomputeFab();
        this.load();                              // 用当前真源（云端或本地兜底）重渲染
      })
      .catch(() => {
        // 失败不阻断渲染：先按本地真源出一份（默认班有种子，其余班为空网格），网络回来再刷
        if (token === this._syncToken) this.load();
      });
  },

  _buildWeekList() {
    const list = [];
    for (let i = 1; i <= (this.data.totalWeeks || 18); i++) list.push(i);
    this.setData({ weekList: list });
  },

  /** 课表完全本地渲染：不发任何网络请求 */
  load() {
    this.setData({ loading: false, failed: false, failMsg: '' });
    this._holidays = tt.holidays();
    this._shifts = tt.shifts();
    const classCourses = tt.sessionsOfWeek(this.data.week);
    this._courses = classCourses;   // 值日名单 / 调课选择器只看全班课次（不含个人选修课）
    try {
      this._build(this._mergePersonal(classCourses));
    } catch (e) {
      console.error('[timetable] _build failed', e);
      this.setData({ failed: true, failMsg: '课表渲染出错：' + ((e && e.message) || e) });
      return;
    }
    // 临时调课弹层依赖的课次列表 / 周次按钮跟着本周刷新
    this._syncShiftSessions();
    this._syncShiftWeekBtns();
    this._recomputeFab();
    this.setData({ loading: false });
  },


  /**
   * 值日名单：只在打开课次详情时才按需拉一次。
   * 课表本身不依赖它 —— 请求失败就只不显示名单，页面照常。
   */
  _ensureDuties() {
    const wk = this.data.week;
    if (this._dutyWeek === wk || this._dutyLoading) return;
    this._dutyLoading = true;
    // 辅导员/超管切班查看：把当前选中的班级传给后端（resolveClassId 已收口越权）
    const classId = this.data.canSwitchClass ? (Number(this.data.viewClassId) || 0) : 0;
    api.courseListWeek({ week: wk, classId: classId || undefined }, { toast: false })
      .then((res) => {
        this._dutyLoading = false;
        const list = Array.isArray(res) ? res : ((res && res.list) || []);
        const map = {};
        list.forEach(c => { map[c.sessionId] = (c.duties || []); });
        this._dutyMap = map;
        // 把名单同步回 _courses，保证点开的详情读得到值日名单
        (this._courses || []).forEach(c => {
          c.duties = (map[c.sessionId] || []).map(x => Object.assign({}, x, {
            seqText: x.seq ? String(x.seq) : '·'
          }));
        });
        this._dutyWeek = wk;
        this._build(tt.sessionsOfWeek(wk));
        // 详情正开着：把新拿到的名单回填进去
        if (this.data.detailShow && this.data.detail) {
          const co = (this._courses || []).find(c => Number(c.sessionId) === Number(this.data.detail.sessionId));
          if (co) this.setData({ detail: co });
        }
      })
      .catch(() => { this._dutyLoading = false; });
  },

  /** 在已构建的网格里按 sessionId 找课程（一格可能有多节课） */
  _findCell(sessionId) {
    const grid = this.data.grid || [];
    for (const row of grid) {
      for (const cell of row) {
        if (cell && cell.courses) {
          const hit = cell.courses.find(c => Number(c.sessionId) === Number(sessionId));
          if (hit) return hit;
        }
      }
    }
    return null;
  },

  /** 按「分组视图」过滤：仅看所选组的分组课 + 全体课；'ALL' = 全体课 + A 组 + B 组全显示 */
  _filterByGroup(courses) {
    const g = this.data.viewGroup;
    if (!g || g === 'ALL') return courses;
    return courses.filter(c => !c.groupScope || c.groupScope === g);
  },

  /**
   * 左下角入口（v0.7.21 需求③）：A 组 / B 组 / 临时调课 三行收在一个按钮里。
   * 展开态纯 CSS 过渡（transform + opacity），所以这里只翻一个布尔值，
   * 不锁点击、不等动画 —— 半途再点一下能立刻反向收起。
   */
  onMenuToggle() { this.setData({ fabMenuOpen: !this.data.fabMenuOpen }); },

  /** 选 A 组 / B 组：切换视图（不重新请求，直接重建网格）+ 收起菜单 */
  onMenuGroup(e) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key) return;
      this.setData({ fabMenuOpen: false });
    if (key === this.data.viewGroup) return;
      this._groupPicked = true;
      this.setData({ viewGroup: key });
      // 换组带过渡（需求⑤）：_build 收到 animate=true 时走 FLIP
      this._build(this._mergePersonal(tt.sessionsOfWeek(this.data.week)), true);
    },

  /** 进临时调课（仅超管有这一行）；收起菜单再开弹层，避免两层浮层叠在一起 */
  onMenuShift() {
    this.setData({ fabMenuOpen: false });
    this.onShiftOpen();
  },

  /**
   * 个人选修课只对「看自己的班」的人开放：
   *   · 辅导员（跨班查看）关闭；
   *   · 普通同学（canSwitchClass=false，恒看本班）开放；
   *   · 超管未切换测试账号时开放，切换去看别的班时关闭（避免把本人选修课叠到别人班上）。
   */
  _showPersonal() {
    const d = this.data;
    if (d.isCounselor) return false;
    if (!d.canSwitchClass) return true;
    return !!(d.isSuper && !d.showClassSwitch);
  },

  /** 右下角加课按钮可见性（2026-10-16）：人人可见，且**一律是添加个人选修课**（含超管）。 */
  _recomputeFab() {
    const d = this.data;
    const showPersonal = this._showPersonal();
    this.setData({
      fabShow: !d.loading && !d.isCounselor && showPersonal && (d.isAdmin || d.hasTimetable)
    });
  },

  /** 把个人选修课（仅本人可见）映射成与全班课次同构的网格单元 */
  _personalToCell(p) {
    return {
      key: 'p' + Number(p.id),             // wx:key 用：与全班课次（数字 id）不会撞
      sessionId: 0,                       // 个人课次没有 session 身份，不参与值日 / 调课选择器
      pid: Number(p.id),
      name: p.name,
      room: p.room || '',
      teacher: p.teacher || '',
      weekRule: p.weekRule || 'ALL',
      weeks: p.weeks || '',
      weekText: weekText(p.weeks || ''),
      groupScope: null,                   // 无分组语义，所有分组视图都显示
      dutyCount: 0,
      duties: [],
      classDate: '',
      shifted: false,
      isHoliday: false,
      holidayName: '',
      movedOut: false,
      movedIn: false,
      shiftToText: '',
      shiftFromText: '',
      dowText: util.weekdayShort(Number(p.dayOfWeek)),
      dayOfWeek: Number(p.dayOfWeek),
      period: Number(p.period),
      bg: PERSONAL_BG,
      fg: PERSONAL_FG,
      flip: '',
      personal: true,                    // 标记：个人选修课（仅本人可见 / 可编辑）
      mine: true
    };
  },

  /** 全班课次 + 个人选修课 合并（个人课次不参与分组过滤，所有视图都显示） */
  _mergePersonal(classCourses) {
    const pc = (this._personal || []).map(p => this._personalToCell(p));
    return classCourses.concat(pc);
  },

  /** 用「当前周全班课次 + 个人选修课」重建网格（个人数据变动后调用） */
  _rebuildWithPersonal() {
    const classCourses = tt.sessionsOfWeek(this.data.week);
    this._courses = classCourses;
    this._build(this._mergePersonal(classCourses));
  },

  /** 拉取「我」的个人选修课（仅本人可见），写进 this._personal 并刷新网格 */
  _loadPersonal() {
    if (!this._showPersonal()) { this._personal = []; return Promise.resolve(); }
    return api.electiveList({}, { toast: false })
      .then((r) => {
        this._personal = (r && r.list) || [];
        if (this.data.grid && this.data.grid.length) this._rebuildWithPersonal();
      })
      .catch(() => { this._personal = []; });
  },

  /** 构建「上课周次」多选按钮的选中态（WXML 不支持 .indexOf，改用预计算数组） */
  _syncWeekBtns() {
    const weeks = (this.data.form && this.data.form.weeks) || [];
    const set = new Set(weeks);
    const btns = (this.data.weekList || []).map(n => ({ n, on: set.has(n) }));
    this.setData({ weekBtns: btns });
  },

  /**
   * @param {Array}   courses
   * @param {boolean} [animate] 用 FLIP 过渡换网格（只有 A 组 ⇄ B 组用）。
   *   为什么只有这一个入口开动画：
   *     · 切周已经由 .wk-swipe 那套方向性滑动包着，再叠一层 FLIP 是两段运动打架；
   *     · 首屏 / 重新加载没有「旧位置」可飞（列表还没渲染过，量不到反而会误判成新增）。
   */
  _build(courses, animate) {
    const wk = this.data.week;
    const visible = this._filterByGroup(courses || []);
    const hMap = {};
    (this._holidays || []).forEach(h => { hMap[h.date] = h; });
    const shList = this._shifts || [];
    const md = (ds) => { const p = String(ds || '').split('-'); return p.length === 3 ? (Number(p[1]) + '/' + Number(p[2])) : ''; };

    const datesAll = [];
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayDow = util.todayWeekday();
    for (let d = 1; d <= 7; d++) {
      const ds = util.dateOfWeekDay(this.data.termStart, wk, d);
      const num = ds ? Number(ds.slice(8, 10)) : '';
      const h = ds ? hMap[ds] : null;
      const off = !!(h && h.kind === 'OFF');
      const outShift = ds ? shList.find(s => String(s.from).slice(0, 10) === ds) : null;
      const inShift = ds ? shList.find(s => String(s.to).slice(0, 10) === ds) : null;
      datesAll.push({
        dow: d,
        short: util.weekdayShort(d),
        day: num,
        isToday: !!ds && ds === todayStr && d === todayDow,
        isHoliday: off,
        holidayName: off ? h.name : '',
        isMakeup: !!(h && h.kind === 'MAKEUP'),
        isWeekend: d >= 6,
        // 「按日期调课」里勾选的「这几天不上」——WXML 不支持 indexOf，这里预先算好
        off: (this._offDays || []).indexOf(d) >= 0,
        shiftOutText: outShift ? ('调至 ' + md(outShift.to)) : '',
        shiftInText: inShift ? (md(inShift.from) + ' 调入') : ''
      });
    }

    /*
     * 显示哪些天：默认周一~周五；只要周末（周六 / 周日）有课就补上这两列
     * ——「没课不显示周六日，调课后有课了则显示」（§43 需求④）。
     * ⚠️ 判定按「整周全部课次」(courses) 而非当前分组视图(visible)：否则某一组有周末课、
     *    另一组没有时，切换 A/B 会让网格在 5↔7 列跳变、横向滚动提示忽隐忽现，
     *    连带把下方黄色提醒条顶上顶下（报障：切换 A/B 组黄色提醒位置不一样）。
     *    这也符合 onMenuGroup 的 FLIP 设计——换组只改「哪些格子有内容」，不改行列几何。
     *    仍排除「调出」的课：调出日的课已挪走，不该再撑出一列。
     */
    const hasWeekend = (courses || []).some(c => !c.movedOut && Number(c.dayOfWeek) >= 6);
    const showDows = hasWeekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
    const colW = showDows.length <= 5
      ? Math.floor(BOARD_INNER / showDows.length)
      : COL_W_WEEKEND;
    const dates = showDows.map(d => datesAll[d - 1]);

    // 左列只显示节次号「1-N」，**不显示上课时间**（用户要求去掉时间行）
    //
    // 🔴 行数口径（2026-10-14 用户实锤后调整）：平时**一天就是五节大课**，
    //   第 6 节是「书香校园」这类 45 分钟短课的特殊时段 —— 若无条件按配置画满，
    //   没有第 6 节课的周次会多出一整行空格子（用户报「多了一节空行」）。
    //   改为：**配置节次数与本周实际最高节次取大者** —— 本周没第 6 节课就不画第 6 行，
    //   一旦有课自动出现。
    //   ⚠️ 判定同样按「整周全部课次」(courses) 而非当前分组视图(visible)，与 hasWeekend 同理：
    //   否则某一组有第6节课、另一组没有时，切组会让网格在 5↔6 行间跳动。
    //   下限钉 1（整周无课时仍显示 1 行骨架，避免出现空白页头）。
    const maxUsedPeriod = (courses || []).reduce((mx, c) => {
      if (c.movedOut) return mx;                 // 调出日的课已挪走，不该撑出这一行
      return Math.max(mx, Number(c.period) || 0);
    }, 0);
    const nPeriods = Math.max(1, tt.periodCount(), maxUsedPeriod);
    const periods = [];
    for (let p = 1; p <= nPeriods; p++) periods.push({ p });

    // 一格多课：grid[p][c] = { empty, dow, period, wk, courses:[] }；列下标 c ↔ showDows[c]
    const grid = [];
    for (let p = 1; p <= nPeriods; p++) {
      grid.push(showDows.map(d => ({ empty: true, dow: d, period: p, wk: d >= 6, courses: [] })));
    }
    const colorOf = (cid) => util.courseColor(Number(cid || 0));
    visible.forEach(c => {
      if (c.movedOut) return; // 调出日的课从原列消失，仅日期表头标注「调至 X/X」
      const p = Number(c.period), d = Number(c.dayOfWeek);
      if (p < 1 || p > nPeriods) return;
      const ci = showDows.indexOf(d);
      if (ci < 0) return;
      const cell = grid[p - 1][ci];
      const col = colorOf(c.courseId);
      cell.courses.push({
        key: c.sessionId,                   // wx:key 用：个人选修课与全班课次不会撞
        sessionId: c.sessionId,
        name: c.name,
        room: c.room,
        teacher: c.teacher,
        weekRule: c.weekRule,
        weeks: c.weeks || '',
        weekText: weekText(c.weeks || ''),
        groupScope: c.groupScope,
        dutyCount: c.dutyCount,
        // 值日名单来自按需请求；没拉到就是空数组，不影响课表本身
        duties: ((this._dutyMap && this._dutyMap[c.sessionId]) || []).map(x => Object.assign({}, x, {
          seqText: x.seq ? String(x.seq) : '·'
        })),
        classDate: c.classDate,
        shifted: !!c.shifted,
        isHoliday: !!c.isHoliday,
        holidayName: c.holidayName || '',
        movedOut: !!c.movedOut,
        movedIn: !!c.movedIn,
        shiftToText: c.shiftToText || '',
        shiftFromText: c.shiftFromText || '',
        dowText: util.weekdayShort(d),
        dayOfWeek: d,
        period: p,
        bg: col.bg,
        fg: col.fg,
        // A 组 ⇄ B 组 FLIP 的内联样式落点（v0.7.21 需求⑤）；wxml 用 style="background:{{co.bg}};{{co.flip}}"
        flip: ''
      });
    });
    grid.forEach(row => row.forEach(cell => { cell.empty = cell.courses.length === 0; }));

    const grouped = visible.filter(c => c.groupScope);
    const tips = [];
    if (grouped.length) {
      tips.push(this.data.viewGroup === 'ALL'
        ? ('本周有 ' + grouped.length + ' 节分组课（A/B 组）')
        : ('本周有 ' + grouped.length + ' 节分组课（仅对应小组可见）'));
    }
    const offDays = dates.filter(x => x.isHoliday);
    if (offDays.length) tips.push('本周放假：' + offDays.map(x => (x.day + '日 ' + x.holidayName)).join('、'));
    const mkDays = dates.filter(x => x.isMakeup);
    if (mkDays.length) tips.push('调休上班：' + mkDays.map(x => ('周' + x.short + ' ' + x.day + '日')).join('、'));
    // 周末课提示按整周全部课次统计（与 hasWeekend 同口径），保证切换 A/B 时黄条文案/高度稳定
    const wkCourses = (courses || []).filter(c => !c.movedOut && Number(c.dayOfWeek) >= 6);
    if (wkCourses.length) tips.push('本周有 ' + wkCourses.length + ' 节排在周六 / 周日');
    if (shList.length) tips.push('本周有 ' + shList.length + ' 处按天调课');

    const patch = () => ({
      dates,
      periods,
      grid,
      colW,
      dateWidth: showDows.length * colW,
      showScrollHint: showDows.length > 5,
      tip: tips.join('  ·  ')
    });

    if (!animate) { this.setData(patch(), () => this._fitHeight()); return; }

    /*
     * A 组 ⇄ B 组：网格整体重建（onMenuGroup 里直接 _build，不重新请求），
     * 用 FLIP 让**两个视图都有的课**（全体课）飞到新位置，只在目标视图出现的课从下方淡入。
     * 位置只用 top —— 课表主体是 scroll-x，横向偏移不在过渡范围内；而且换组只改变
     * 「哪些格子有内容」，不改变行列几何（除非本组课多出一列周末，那时横向是跳变的，
     * 这是横向滚动容器本身的限制，不在这条过渡的职责里）。
     *
     * ⚠️ 已知取舍：离场块是**瞬时移除**。网格没有「行高」可塌缩（把单个格子的高度塌掉会把
     *    同一行其余格子一起拉开），而 max-height 并集渲染要把新旧两套 grid 拼成一张，
     *    代价远大于收益。观众要看到的是「留下来的课在飞、新来的课在长」，这一条已经满足。
     */
    const lt = listTransition;
    const tk = (this._ttFlipToken = (this._ttFlipToken || 0) + 1);
    // 新对象一律带 flip=''，避免上一次的残留样式跟着重建的对象一起渲染
    grid.forEach((row) => row.forEach((cell) => (cell.courses || []).forEach((co) => { co.flip = ''; })));

    lt.flip(this, {
      sel: '.tt-cell:not(.personal)[data-sid]', key: 'sessionId', field: 'flip',
      guard: () => this._ttFlipToken === tk,
      rows: () => {
        const out = [];
        grid.forEach((row) => row.forEach((cell) => (cell.courses || []).forEach((co) => out.push(co))));
        return out;
      },
      patch,
      after: () => {
        if (this._ttFlipToken !== tk) return;
        grid.forEach((row) => row.forEach((cell) => (cell.courses || []).forEach((co) => { co.flip = ''; })));
        this.setData({ grid });
        this._fitHeight();
      }
    });
  },

  /**
   * 自适应屏幕高度：量出课表顶部在屏幕中的位置，把剩下的高度平分给 5 行。
   * 行高夹在 [104, 168]rpx —— 太矮课名挤成一条线，太高就得滚动。
   * 登录态/网络都不依赖，纯本地计算；测不到（节点未渲染）就保持默认 rowH。
   */
  _fitHeight() {
    let win = null;
    try {
      win = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
    } catch (e) { win = null; }
    if (!win || !win.windowWidth || !win.windowHeight) return;
    // 查询接口在部分环境（单测桩 / 低版本基础库）不完整，取不到就保持默认行高
    if (typeof this.createSelectorQuery !== 'function') return;
    const ratio = 750 / win.windowWidth;              // 1px = ?rpx
    const viewH = win.windowHeight * ratio;           // 视口高（rpx）
    const headH = this.data.headH || 72;
    const reserve = 206;                              // 底部：提示语 + 悬浮按钮 + 底栏让位（rpx；第 6 轮底栏缩小后 220→206）
    try {
      const q = this.createSelectorQuery();
      const sel = q && q.select ? q.select('.tt-board') : null;
      if (!sel || typeof sel.boundingClientRect !== 'function') return;
      sel.boundingClientRect((rect) => {
        if (!rect) return;
        const boardTop = rect.top * ratio;
        let rowH = Math.floor((viewH - boardTop - reserve - headH) / 5);
        rowH = Math.max(104, Math.min(rowH, 168));
        if (rowH !== this.data.rowH) this.setData({ rowH });
      }).exec();
    } catch (e) { /* 测量失败：保持默认行高，不影响课表渲染 */ }
  },

  /* ---------------- 校历：节假日 / 调休 / 调课 ----------------
   * 课表读的是本地副本，所以这里改动也先落本地（立刻生效），
   * 再尽力同步到数据库 —— 值日生成读的是库里那份，同步失败要提示。
   */
  onCalOpen() {
    this.setData({
      calShow: true,
      calLoading: false,
      calHolidays: tt.holidays(),
      calShifts: tt.shifts()
    });
  },
  onCalClose() { this.setData({ calShow: false }); },
  _reloadCal() {
    this.setData({ calHolidays: tt.holidays(), calShifts: tt.shifts() });
    return Promise.resolve();
  },
  /** 本地改动已生效，同步数据库失败时明确告知（值日生成读的是库里那份校历） */
  _syncWarn() {
    return () => util.toast('已本地保存，但同步服务端失败');
  },
  _syncOk() { util.toast('已保存'); },

  onHolidayPick(e) { this.setData({ 'holidayForm.date': e.detail.value }); },
  onHolidayName(e) { this.setData({ 'holidayForm.name': e.detail.value }); },
  onHolidayKind(e) { this.setData({ 'holidayForm.kind': e.currentTarget.dataset.value }); },
  onHolidaySave() {
    const f = this.data.holidayForm;
    if (!f.date) { util.toast('请选择日期'); return; }
    const date = String(f.date).slice(0, 10);
    const item = { date, name: String(f.name || '').trim() || '节假日', kind: f.kind === 'MAKEUP' ? 'MAKEUP' : 'OFF' };
    const list = tt.holidays().filter(h => String(h.date).slice(0, 10) !== date);
    list.push(item);
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    tt.saveHolidays(list);
    this.setData({ 'holidayForm.date': '', 'holidayForm.name': '' });
    this._reloadCal().then(() => this.load());
    api.saveHoliday({ date: item.date, name: item.name, kind: item.kind }, { toast: false })
      .then(() => this._syncOk())
      .catch(this._syncWarn());
  },
  onHolidayDel(e) {
    const date = String(e.currentTarget.dataset.date).slice(0, 10);
    util.confirm('删除后该日恢复正常上课', '删除节假日').then(ok => {
      if (!ok) return;
      tt.saveHolidays(tt.holidays().filter(h => String(h.date).slice(0, 10) !== date));
      this._reloadCal().then(() => this.load());
      api.removeHoliday({ date }, { toast: false })
        .then(() => this._syncOk())
        .catch(this._syncWarn());
    });
  },

  onShiftFrom(e) { this.setData({ 'shiftForm.from': e.detail.value }); },
  onShiftTo(e) { this.setData({ 'shiftForm.to': e.detail.value }); },
  onShiftNote(e) { this.setData({ 'shiftForm.note': e.detail.value }); },
  onShiftSave() {
    const f = this.data.shiftForm;
    if (!f.from || !f.to) { util.toast('请选择调出 / 调入日期'); return; }
    const item = {
      id: Date.now(),
      _local: true,          // 本地自增 id，库里没有对应记录，删除时只能按 from_date 匹配
      week: this.data.week,
      from: String(f.from).slice(0, 10),
      to: String(f.to).slice(0, 10),
      note: String(f.note || '')
    };
    const list = tt.shifts().filter(s => String(s.from).slice(0, 10) !== item.from);
    list.push(item);
    tt.saveShifts(list);
    this.setData({ shiftForm: { from: '', to: '', note: '' } });
    // 调出日如果不在当前周，先跳到那一週，超管才能立刻看到「原列消失 + 调入日出现」
    const fw = tt.weekOfDate(item.from);
    this._reloadCal().then(() => {
      if (Number(fw) >= 1 && Number(fw) <= this.data.totalWeeks && Number(fw) !== this.data.week) {
        this.setData({ week: Number(fw) });
      }
      this.load();
    });
    // 服务端防呆（v0.7.16）：跨周调课返回 needConfirm，弹确认后带 confirm=true 重发
    const doSave = (confirmed) => api.saveShift(
      { from: item.from, to: item.to, note: item.note, confirm: confirmed === true },
      { toast: false }
    ).then((r) => {
      if (r && r.needConfirm) {
        util.confirm(r.message, '跨周调课').then(ok => { if (ok) doSave(true); });
        return;
      }
      util.toast('已保存，值日请重新生成');
    }).catch(this._syncWarn());
    doSave(false);
  },
  onShiftDel(e) {
    const id = Number(e.currentTarget.dataset.id);
    util.confirm('取消后该日恢复原课表', '取消调课').then(ok => {
      if (!ok) return;
      const hit = tt.shifts().find(s => Number(s.id) === id);
      tt.saveShifts(tt.shifts().filter(s => Number(s.id) !== id));
      this._reloadCal().then(() => this.load());
      // 本地新建的调课没有库里的 id，只能按 from_date 删
      api.removeShift(hit && hit._local ? { from: hit.from } : { id: id }, { toast: false })
        .then(() => this._syncOk())
        .catch(this._syncWarn());
    });
  },

  /* ---------------- 临时调课（按周生效的课次例外） ----------------
   * 与「校历 · 按天整体调课」的分工：
   *   校历 → 某一天整体挪走（day_shift），影响这一天所有课次；
   *   这里 → 某节课这一周例外（session_shift），只动被点名的那节课。
   * 两者正交、可叠加，都由 common/week.js 的 resolveSlot 统一解释。
   * 写入策略是**先服务端后本地**：服务端还要同步值日、退回已发布的草稿，
   * 本地抢先改会让超管看到一张与真实入库不一致的课表。
   * ------------------------------------------------------------ */

  onShiftOpen() {
    this._syncShiftSessions();
    this._syncShiftWeekBtns();
    this._loadShiftItems();
    this._loadAiPrompt();
    this.setData({ shiftShow: true });
  },

  onShiftClose() { this.setData({ shiftShow: false }); },

  onShiftTab(e) {
    const key = e.detail.key;
    this.setData({ shiftTab: key });
    if (key === 'list') this._loadShiftItems();
    if (key === 'ai') this._loadAiPrompt();
  },

  /** 本周可选课次（picker 用）。按「星期 + 节次」排序，标签一眼能认出是哪节课 */
  _syncShiftSessions() {
    const list = (this._courses || []).slice()
      .filter(c => !c.movedOut && !c.movedIn) // 调入/调出是显示层产物，不进调课选择器
      .sort((a, b) => (a.dayOfWeek - b.dayOfWeek) || (a.period - b.period));
    this._shiftSessions = list;
    const labels = list.map(c => '周' + util.weekdayShort(c.dayOfWeek) + ' 第' + c.period + '节 · '
      + c.name + (c.groupScope ? '（' + c.groupScope + ' 组）' : ''));
    let idx = Number(this.data.shiftSessionIndex) || 0;
    if (idx >= list.length) idx = 0;
    this.setData({ shiftSessionLabels: labels, shiftSessionIndex: idx });
  },

  onShiftPickSession(e) { this.setData({ shiftSessionIndex: Number(e.detail.value) }); },
  onShiftKind(e) { this.setData({ shiftKind: e.detail.key }); },
  onShiftToDay(e) { this.setData({ shiftToDay: Number(e.currentTarget.dataset.value) }); },
  onShiftToPeriod(e) { this.setData({ shiftToPeriod: Number(e.currentTarget.dataset.value) }); },

  _targetSession() {
    const list = this._shiftSessions || [];
    return list[Number(this.data.shiftSessionIndex) || 0] || null;
  },

  /** 长按课表格子 → 直接打开「本周调整」并定位到这一格的那节课 */
  onCellLongPress(e) {
    if (e.currentTarget.dataset.personal) return;   // 个人选修课不参与临时调课
    if (!this.data.isSuper) { util.toast('只有超级管理员可以临时调课'); return; }
    const sid = Number(e.currentTarget.dataset.sid);
    if (!sid) { util.toast('这个格子没有课，长按无效'); return; }
    this._syncShiftSessions();
    this._syncShiftWeekBtns();
    const idx = (this._shiftSessions || [])
      .findIndex(s => Number(s.sessionId) === sid);
    this.setData({
      shiftShow: true,
      shiftTab: 'week',
      shiftSessionIndex: idx >= 0 ? idx : 0,
      shiftKind: 'OFF'
    });
  },

  /** 统一提交：成功后落本地并刷新课表；服务端告警（撞车等）用弹窗说清楚 */
  _applyShift(payload, localItems, tipText) {
    if (this.data.shiftSaving) return;
    this.setData({ shiftSaving: true });
    api.shiftSet(payload, { toast: false })
      .then((r) => {
        this.setData({ shiftSaving: false });
        tt.upsertSessShifts(localItems || []);
        this._offDays = [];
        this.load();
        this._loadShiftItems();
        const warns = (r && r.warnings) || [];
        if (warns.length) {
          wx.showModal({
            title: '已保存，但有提醒',
            content: warns.join('\n'),
            showCancel: false,
            confirmColor: '#3370FF'
          });
        } else {
          util.toast(tipText + ((r && r.resetPublish) ? '（需重新发布值日）' : ''));
        }
      })
      .catch((e) => {
        this.setData({ shiftSaving: false });
        util.toast((e && e.errMsg) || '同步服务端失败，未生效');
      });
  },

  /** ① 本周调整：只改第 this.data.week 周 */
  onShiftApplyWeek() {
    const s = this._targetSession();
    if (!s) { util.toast('请先选择课次'); return; }
    const wk = this.data.week;
    const move = this.data.shiftKind === 'MOVE';
    const toDay = move ? this.data.shiftToDay : null;
    const toPeriod = move ? this.data.shiftToPeriod : null;
    this._applyShift(
      { week: wk, sessionIds: [s.sessionId], kind: move ? 'MOVE' : 'OFF', toDay, toPeriod, note: '手动调课' },
      [{ sessionId: s.sessionId, week: wk, kind: move ? 'MOVE' : 'OFF', toDay, toPeriod, note: '手动调课' }],
      move ? ('已改到 周' + util.weekdayShort(toDay) + '第 ' + toPeriod + ' 节') : '已设为本周不上'
    );
  },

  /* ② 多周次：同一个课次一次改好几周 */
  _syncShiftWeekBtns() {
    const set = {};
    (this.data.shiftWeeks || []).forEach(n => { set[n] = 1; });
    this.setData({
      shiftWeekBtns: (this.data.weekList || []).map(n => ({
        n, on: !!set[n], cur: n === this.data.week
      }))
    });
  },

  onToggleShiftWeek(e) {
    const wk = Number(e.currentTarget.dataset.week);
    const cur = (this.data.shiftWeeks || []).slice();
    const i = cur.indexOf(wk);
    if (i >= 0) cur.splice(i, 1); else cur.push(wk);
    cur.sort((a, b) => a - b);
    this.setData({ shiftWeeks: cur });
    this._syncShiftWeekBtns();
  },

  onShiftApplyMulti() {
    const s = this._targetSession();
    if (!s) { util.toast('请先选择课次'); return; }
    const weeks = this.data.shiftWeeks || [];
    if (!weeks.length) { util.toast('请选择要调整的周次'); return; }
    const move = this.data.shiftKind === 'MOVE';
    const toDay = move ? this.data.shiftToDay : null;
    const toPeriod = move ? this.data.shiftToPeriod : null;
    this._applyShift(
      { weeks, sessionIds: [s.sessionId], kind: move ? 'MOVE' : 'OFF', toDay, toPeriod, note: '多周次调课' },
      weeks.map(wk => ({
        sessionId: s.sessionId, week: wk, kind: move ? 'MOVE' : 'OFF',
        toDay, toPeriod, note: '多周次调课'
      })),
      '已应用到 ' + weeks.length + ' 周'
    );
  },

  /* ③ 按日期：这几天不上 / 某天调到另一天 */
  onToggleOffDay(e) {
    const d = Number(e.currentTarget.dataset.dow);
    const cur = (this._offDays || []).slice();
    const i = cur.indexOf(d);
    if (i >= 0) cur.splice(i, 1); else cur.push(d);
    cur.sort((a, b) => a - b);
    this._offDays = cur;
    this.setData({ offDays: cur });
    this._build(this._courses || []);
  },

  onApplyDateOff() {
    const days = this.data.offDays || [];
    if (!days.length) { util.toast('请先选择要取消的日期'); return; }
    const wk = this.data.week;
    const dates = days.map(d => util.dateOfWeekDay(this.data.termStart, wk, d));
    // 本地那份要按**课次原本的星期**筛（与服务端 dates 展开口径一致），
    // 不能用已套过临时调课的 _courses，否则两边会算出不同的课次。
    const local = [];
    tt.sessions().forEach((s) => {
      if (days.indexOf(Number(s.day)) < 0) return;
      if (!tt.matchesWeeks(s.weeks, wk)) return;
      local.push({ sessionId: s.id, week: wk, kind: 'OFF', note: '按日期取消' });
    });
    this._applyShift(
      { dates, kind: 'OFF', note: '按日期取消' },
      local,
      '已取消 ' + days.length + ' 天的课'
    );
  },

  /* ④ AI 智能调课 */
  _loadAiPrompt() {
    if (this.data.aiPrompt) return;
    api.aiShiftPrompt({}, { toast: false })
      .then(r => this.setData({ aiPrompt: (r && r.prompt) || '' }))
      .catch(() => {});
  },

  onAiText(e) { this.setData({ aiText: e.detail.value, aiError: '' }); },
  onAiExample(e) {
    this.setData({ aiText: String(e.currentTarget.dataset.text || ''), aiError: '' });
  },
  onAiPromptShow() { this.setData({ aiPromptShow: true }); },
  onAiPromptClose() { this.setData({ aiPromptShow: false }); },
  onAiPromptInput(e) { this.setData({ aiPrompt: e.detail.value }); },
  onAiPromptReset() {
    api.aiShiftPrompt({}, { toast: false })
      .then(r => this.setData({ aiPrompt: (r && r.prompt) || '' }))
      .catch(() => {});
  },

  onAiPlan() {
    if (this.data.aiBusy) return;
    const text = String(this.data.aiText || '').trim();
    if (!text) { util.toast('请先说说要怎么调课'); return; }
    this.setData({
      aiBusy: true, aiError: '', aiPreview: [], aiOps: [], aiWarnings: [], aiNotes: ''
    });
    api.aiShiftPlan({ week: this.data.week, text, prompt: this.data.aiPrompt || undefined }, { toast: false })
      .then((r) => {
        const preview = (r && r.preview) || [];
        this.setData({
          aiBusy: false,
          aiPreview: preview,
          aiOps: (r && r.operations) || [],
          aiNotes: (r && r.notes) || '',
          aiWarnings: (r && r.warnings) || []
        });
        if (!preview.length) util.toast('AI 没有给出需要调整的课次');
      })
      .catch((e) => {
        // 不要把错误吞掉：AI 链路的失败原因必须让超管看见
        this.setData({ aiBusy: false, aiError: (e && (e.errMsg || e.message)) || 'AI 调课失败' });
      });
  },

  onAiDiscard() {
    this.setData({ aiPreview: [], aiOps: [], aiWarnings: [], aiNotes: '', aiError: '' });
  },

  onAiApply() {
    const ops = this.data.aiOps || [];
    if (!ops.length) { util.toast('没有可应用的方案'); return; }
    if (this.data.shiftSaving) return;
    const wk = this.data.week;
    this.setData({ shiftSaving: true, aiError: '' });
    // 一个操作可能包含多节课次，逐个写；某一步失败就停下并如实说明「前几步已生效」
    const run = (i) => {
      if (i >= ops.length) {
        this.setData({ shiftSaving: false });
        tt.upsertSessShifts((this.data.aiPreview || []).map(p => ({
          sessionId: p.sessionId, week: wk, kind: p.kind,
          toDay: p.toDay, toPeriod: p.toPeriod, note: p.note
        })));
        this.load();
        this._loadShiftItems();
        this.setData({ aiPreview: [], aiOps: [], aiWarnings: [], aiNotes: '' });
        util.toast('已应用 AI 调课方案');
        return;
      }
      const op = ops[i];
      api.shiftSet({
        week: wk, sessionIds: op.sessionIds, kind: op.kind,
        toDay: op.toDay, toPeriod: op.toPeriod, note: op.note || 'AI 调课'
      }, { toast: false })
        .then(() => run(i + 1))
        .catch((e) => {
          this.setData({
            shiftSaving: false,
            aiError: '第 ' + (i + 1) + ' 步写入失败：' + ((e && e.errMsg) || '未知原因')
              + '（前面的步骤已生效，可在「结果」里撤销）'
          });
        });
    };
    run(0);
  },

  onAiCheck() {
    if (this.data.aiBusy) return;
    this.setData({ aiBusy: true, aiError: '' });
    api.scheduleAiCheck({ probe: false }, { toast: false })
      .then((r) => {
        this.setData({ aiBusy: false });
        const lines = [
          '通道：' + ((r && r.route) || '-'),
          '模型：' + ((r && r.model) || '-'),
          '出口：' + ((r && r.egress) || '-') + ((r && r.httpStatus) ? (' HTTP ' + r.httpStatus) : ''),
          '密钥：' + ((r && r.hasKey) ? '已配置' : '缺失'),
          '公共模块：' + ((r && r.hasSeqOf === false) ? '缺少 seqOf，请重新同步部署' : '正常'),
          (r && r.error) ? ('错误：' + r.error) : '未发现错误'
        ];
        wx.showModal({
          title: 'AI 链路自检', content: lines.join('\n'),
          showCancel: false, confirmColor: '#3370FF'
        });
      })
      .catch((e) => this.setData({ aiBusy: false, aiError: (e && e.errMsg) || '自检失败' }));
  },

  /* ⑤ 调课结果 */
  _loadShiftItems() {
    const wk = this.data.week;
    const items = tt.sessShiftsOfWeek(wk).map((x) => {
      const fromText = '周' + util.weekdayShort(x.fromDay) + ' 第' + x.fromPeriod + ' 节';
      return Object.assign({}, x, {
        effText: x.kind === 'OFF'
          ? (fromText + ' → 本周不上')
          : (fromText + ' → 周' + util.weekdayShort(x.toDay) + ' 第' + x.toPeriod + ' 节')
      });
    });
    this.setData({ shiftItems: items });
  },

  onShiftUndo(e) {
    const id = Number(e.currentTarget.dataset.id);
    const wk = this.data.week;
    util.confirm('撤销后这节课恢复原来的时间', '撤销临时调课').then((ok) => {
      if (!ok) return;
      api.shiftRemove({ week: wk, sessionIds: [id] }, { toast: false })
        .then(() => {
          tt.removeSessShifts([id], [wk]);
          this.load();
          this._loadShiftItems();
          util.toast('已撤销');
        })
        .catch(err => util.toast((err && err.errMsg) || '撤销失败'));
    });
  },

  onShiftClearWeek() {
    const wk = this.data.week;
    if (!this.data.shiftItems.length) { util.toast('本周没有临时调课'); return; }
    util.confirm('本周全部临时调课都会被撤销，课表恢复原样', '撤销本周全部调课').then((ok) => {
      if (!ok) return;
      api.shiftRemove({ weeks: [wk] }, { toast: false })
        .then(() => {
          tt.removeSessShifts([], [wk]);
          this.load();
          this._loadShiftItems();
          util.toast('已撤销本周全部临时调课');
        })
        .catch(err => util.toast((err && err.errMsg) || '撤销失败'));
    });
  },

  /* ---------------- 周切换 ---------------- */
  /**
   * 点日期条上的气泡箭头 / 越界回弹，都汇到这里。
   * 与值日页同一条路：先让旧课表朝方向滑走（160ms），再换数据、新课表从反方向滑入。
   * 越界（第 1 周还往左 / 最后一周还往右）由 swipe.shift 拦下，只播回弹、不换数据。
   */
  onWeekChange(e) {
    const wk = Number(e.detail.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 真正换周（动画 out 段结束后才被回调） */
  _applyWeek(wk) {
    // 「按日期不上」是跟周走的，换周就清空勾选，免得张冠李戴
    this._offDays = [];
    // 左下角入口顺手收起：换周时它挂在原地会挡着课表滑入
    this.setData({ week: wk, offDays: [], fabMenuOpen: false });
    this.load();
  },

  onWeekPick() { this.setData({ weekPickerShow: true }); },
  onWeekPickerClose() { this.setData({ weekPickerShow: false }); },
  onPickWeek(e) {
    const wk = Number(e.currentTarget.dataset.week);
    if (wk < 1 || wk > this.data.totalWeeks) return;
    // 弹层先关掉：它是 fixed 的、又在动画容器之外，让它挡着看不到课表在动
    this.setData({ weekPickerShow: false });
    const delta = wk - Number(this.data.week);
    if (!delta) return;
    swipe.shift(this, delta, (w) => this._applyWeek(w));
  },

  /** 页面销毁时清掉动画定时器（否则定时器回来时 setData 一个已销毁的页面） */
  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅
    swipe.cancel(this);
    // A 组/B 组 FLIP 的打断令牌作废：链上还没醒的 setTimeout 自己退出，不再对已销毁实例 setData
    this._ttFlipToken = (this._ttFlipToken || 0) + 1;
  },

  /* ---------------- 课次 ---------------- */
  onCell(e) {
    const r = Number(e.currentTarget.dataset.r);
    const c = Number(e.currentTarget.dataset.c);
    const sid = Number(e.currentTarget.dataset.sid);
    const personal = e.currentTarget.dataset.personal;
    const pid = Number(e.currentTarget.dataset.pid);
    if (personal) {
      // 个人选修课：仅本人可见、本人可编辑，点开即进入编辑
      const p = (this._personal || []).find(x => Number(x.id) === pid);
      if (!p) return;
      this._openElectiveForm(p);
      return;
    }
    if (!sid) {
      // 空格子：**不再**「点一下新增全班课次」（2026-10-16 用户定口径：加号/新增一律只加选修课）。
      //   全班课次是公共课表，应由网页管理后台统一维护；随手加会造成重复与跨班污染。
      //   管理员要改全班课次 ⇒ 走已有课次的详情「编辑」，或用网页管理后台。
      //   这里静默返回：点了没反应比弹一个"新增课次"更符合用户当前认知（他只想加选修课）。
      return;
    }
    const course = (this._courses || []).find(x => Number(x.sessionId) === sid);
    if (!course) return;
    // 值日名单按需拉取：课表本身是本地的，这一步失败也只是没有名单
    this._ensureDuties();
    this.setData({ detailShow: true, detail: course });
  },

  onDetailClose() { this.setData({ detailShow: false }); },

  onEditCourse() {
    const d = this.data.detail;
    if (!d) return;
    // 调入是调课产生的临时显示，编辑会误改源课次 —— 让它回到真正的调课入口
    if (d.movedIn) { util.toast('这是「按天调课」产生的临时显示，请在「临时调课 → 按日期」里撤销'); return; }
    this.setData({ detailShow: false });
    this._openForm(d, d.dayOfWeek || 1, d.period || 1);
  },

  onDeleteCourse() {
    const d = this.data.detail;
    if (!d) return;
    if (d.movedIn) { util.toast('这是「按天调课」产生的临时显示，请在「临时调课 → 按日期」里撤销'); return; }
    util.confirm('删除后该课次未开始的值日也会移除', '删除课次').then(ok => {
      if (!ok) return;
      api.courseDelete({ sessionIds: [d.sessionId] }, { loading: '删除中' })
        .then(() => {
          tt.removeSession(d.sessionId);      // 同步本地课表，否则删掉了还显示
          util.toast('已删除');
          this.setData({ detailShow: false });
          this.load();
        })
        .catch(() => {});
    });
  },

  /* ---------------- 表单 P3.1 ---------------- */
  onFab() {
    // 🔴 一律「添加个人选修课」（2026-10-16 用户定口径）：
    //    「所有人右下角的加号都是添加选修课，仅自己可见的那种。超管等也是一样。」
    //    —— 早前这里按 `isAdmin` 分流（管理员 → 新增全班课次），现已统一为选修课。
    //
    //    为什么这样更合理：
    //    · 全班课次属于**公共课表**，应由后台管理（网页管理后台）统一维护，
    //      不该由任何人在小程序里随手加 —— 否则同一门课会被重复添加、跨班也加得进去。
    //    · 选修课天生是「我自己的安排」，语义上就该人人可加、仅自己可见。
    //    · 管理员要改全班课次，用**课次详情里的「编辑」**（`_openForm(cell,…)` 传 cell，
    //      走编辑态而非新建），或直接用网页管理后台。
    const cnt = (this._personal || []).length;
    if (cnt >= 2) { util.toast('个人选修课最多添加 2 门'); return; }
    this._openElectiveForm(null);
  },

  /**
   * 打开**全班课次**的编辑弹层。
   * 🔴 2026-10-16 起**只有编辑态**（唯一调用点 `onEditCourse` 传了 detail 对象）：
   *    「新增全班课次」的两个入口（FAB 的 isAdmin 分流、点空白格）都已下线 —— 用户口径是
   *    「加号一律只加个人选修课（含超管）」。全班课次改由**网页管理后台**维护，
   *    或在这里编辑已有课次。`cell` 形参保留是为了 weeks 的取值路径与将来可能的其它编辑入口。
   */
  _openForm(cell, dayOfWeek, period) {
    let weeks = [];
    if (cell && cell.weeks) {
      weeks = typeof cell.weeks === 'string'
        ? cell.weeks.split(',').filter(Boolean).map(Number)
        : (cell.weeks || []);
    }
    this.setData({
      formShow: true,
      formMode: 'class',
      form: {
        sessionId: cell ? cell.sessionId : 0,
        name: cell ? cell.name : '',
        teacher: cell ? (cell.teacher || '') : '',
        room: cell ? (cell.room || '') : '',
        courseType: cell && cell.groupScope ? 'GROUP' : 'ALL',
        groupScope: (cell && cell.groupScope) || 'A',
        dayOfWeek,
        period,
        weeks,
        // dutyCount=0 = 不排值日（合法值）：(x || 2) 会把 0 误弹回 2，必须显式判 undefined
        dutyCount: (cell && cell.dutyCount !== undefined && cell.dutyCount !== null) ? Number(cell.dutyCount) : 2
      }
    });
    this._syncWeekBtns();
  },

  /** 打开「个人选修课」表单（p=null 新增；否则编辑已有的那门） */
  _openElectiveForm(p) {
    const weeks = p && p.weeks
      ? (typeof p.weeks === 'string' ? p.weeks.split(',').filter(Boolean).map(Number) : (p.weeks || []))
      : [];
    this.setData({
      formShow: true,
      formMode: 'elective',
      form: {
        electiveId: p ? Number(p.id) : 0,
        name: p ? p.name : '',
        teacher: p ? (p.teacher || '') : '',
        room: p ? (p.room || '') : '',
        courseType: 'ALL',
        groupScope: 'A',
        dayOfWeek: p ? Number(p.dayOfWeek) : 1,
        period: p ? Number(p.period) : 1,
        weeks,
        dutyCount: 0
      }
    });
    this._syncWeekBtns();
  },

  /** 保存个人选修课（新增 / 更新）；服务端强制每人最多 2 门 */
  _saveElective(f) {
    if (!String(f.name || '').trim()) { util.toast('请填写课程名'); return; }
    if (this.data.saving) return;
    this.setData({ saving: true });
    const isEdit = Number(f.electiveId) > 0;
    const item = {
      id: isEdit ? Number(f.electiveId) : 0,
      name: f.name,
      teacher: f.teacher,
      room: f.room,
      dayOfWeek: Number(f.dayOfWeek),
      period: Number(f.period),
      weeks: (f.weeks || []),
      weekRule: 'ALL'
    };
    api.electiveSave({ item }, { toast: false })
      .then(() => {
        this.setData({ saving: false, formShow: false });
        util.toast(isEdit ? '已保存' : '已添加');
        this._loadPersonal();
      })
      .catch((e) => {
        this.setData({ saving: false });
        util.toast((e && e.errMsg) || (e && e.message) || '保存失败');
      });
  },

  /** 删除个人选修课（仅本人行） */
  onDeleteElective() {
    const f = this.data.form;
    if (!f || !Number(f.electiveId)) return;
    util.confirm('删除后该选修课不再显示', '删除选修课').then((ok) => {
      if (!ok) return;
      api.electiveDelete({ id: Number(f.electiveId) }, { toast: false })
        .then(() => {
          this.setData({ formShow: false });
          util.toast('已删除');
          this._loadPersonal();
        })
        .catch(() => {});
    });
  },

  onFormClose() { this.setData({ formShow: false }); },

  onFormInput(e) {
    const f = String(e.currentTarget.dataset.field);
    this.setData({ ['form.' + f]: e.detail.value });
  },

  onFormChoose(e) {
    const f = String(e.currentTarget.dataset.field);
    this.setData({ ['form.' + f]: e.currentTarget.dataset.value });
  },

  /** segmented 组件 change 事件携带 detail.key（修复「分组」误置为 undefined） */
  onFormSegmented(e) {
    const f = String(e.currentTarget.dataset.field);
    this.setData({ ['form.' + f]: e.detail.key });
  },

  /** 上课周次多选：切换某周选中态 */
  onToggleWeek(e) {
    const wk = Number(e.currentTarget.dataset.week);
    const cur = (this.data.form && this.data.form.weeks) || [];
    const i = cur.indexOf(wk);
    const next = i >= 0 ? cur.slice(0, i).concat(cur.slice(i + 1)) : cur.concat([wk]);
    this.setData({ 'form.weeks': next });
    this._syncWeekBtns();
  },

  onStepper(e) {
    this.setData({ 'form.dutyCount': Number(e.detail.value) });
  },

  /** 服务端返回真实 sessionId 后，把同一份改动写进本地课表 */
  _saveLocal(f, sessionId) {
    const cid = (f && f.localCourseId) || 0;
    tt.upsertSession({
      id: Number(sessionId),
      cid: cid,
      name: String(f.name || '').trim(),
      teacher: String(f.teacher || '').trim(),
      room: String(f.room || '').trim(),
      day: Number(f.dayOfWeek),
      period: Number(f.period),
      group: f.courseType === 'GROUP' ? (f.groupScope === 'B' ? 'B' : 'A') : null,
      weeks: (f.weeks || []).slice().sort((a, b) => a - b).join(',')
    });
    this.load();
  },

  _payloadOf(f) {
    return {
      sessionId: f.sessionId || 0,
      course: {
        name: f.name, teacher: f.teacher, room: f.room,
        courseType: f.courseType,
        groupScope: f.groupScope,
        weeks: (f.weeks || []),
        dayOfWeek: Number(f.dayOfWeek),
        period: Number(f.period),
        dutyCount: Number(f.dutyCount)
      }
    };
  },

  onSave() {
    const f = this.data.form;
    if (!f) return;
    if (this.data.formMode === 'elective') { this._saveElective(f); return; }
    if (!String(f.name || '').trim()) { util.toast('请填写课程名'); return; }
    if (this.data.saving) return;
    // 编辑已有课次时保留原 courseId，避免本地配色跳变
    if (f.sessionId) {
      const old = tt.sessions().find(s => Number(s.id) === Number(f.sessionId));
      f.localCourseId = old ? old.cid : 0;
    }
    this.setData({ saving: true });
    api.courseUpsert(this._payloadOf(f), { toast: false })
      .then((r) => {
        this.setData({ saving: false, formShow: false });
        this._saveLocal(f, (r && r.sessionId) || f.sessionId);
        util.toast('已保存');
      })
      .catch((e) => {
        this.setData({ saving: false });
        if (e && e.errCode === 50010) {
          wx.showModal({
            title: '时间冲突',
            content: '该时间已有《' + ((e.data && e.data.conflictName) || '其他课程') + '》',
            confirmText: '覆盖',
            cancelText: '换个时间',
            confirmColor: '#3370FF',
            success: (r) => {
              if (!r.confirm) return;
              this.setData({ saving: true });
              const p = this._payloadOf(f);
              p.force = true;
              api.courseUpsert(p, { toast: false })
                .then((r) => {
                  this.setData({ saving: false, formShow: false });
                  this._saveLocal(f, (r && r.sessionId) || f.sessionId);
                  util.toast('已覆盖保存');
                })
                .catch(() => this.setData({ saving: false }));
            }
          });
        }
      });
  },

  onReload() { this._afterAuth() },
  noop() {}
});
