/**
 * P5 · 信息（Tab 5）
 * ------------------------------------------------------------
 * 老师建议：底部导航新增独立的「班级信息」分类，先罗列成员 / 课表 / 班费 /
 * 通知 / 作业 / 文档（框架图式层级），完善导航。
 * 本页是**聚合页**而非从零做：根「班级概况」展示班级名 + 成员统计，
 * 下面 4 个子卡分别跳到已有模块（成员=roster / 班费=fee(独立页) /
 * 通知=notice / 作业=homework；文档不在班级信息内）。
 *
 * ⚠️「课程表」子卡已于 2026-10-28 下线（用户要求）：它走的是
 *    `wx.switchTab('/pages/timetable/index')` —— 切到底部导航本来就有的第二个 tab，
 *    用户点完画面还是原来那个页面，等于一个「什么都不发生」的按钮。
 *    课表入口保留在底部 tabBar，删掉这里的重复入口不会让人找不到课表。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const pageAnim = require('../../utils/page-anim');
const theme = require('../../utils/theme');
const mem = require('../../utils/mem');

/** 班级概况这类低频变化的数据：Tab 切回 / 短间隔重进时，新鲜窗口内不打接口（与首页 STALE_MS 同源）。 */
const STALE_MS = 20000;

Page({
  data: {
    statusBarHeight: 20,
    // 体验模式标记（与登录 demo 同源）：true 时倒数日区展示「体验版常驻」标识（2026-11-12）。
    demo: false,
    /** Tab 入场动画序号：0 = 还没进过（播完整版），之后在 1 / 2 之间轮换（轻量版） */
    animSeq: 0,
    /** 入场动画就绪标记：false = 根节点挂 pa-hold（块透明），等首屏身份 + 数据就绪再统一开播 */
    paReady: false,
    loading: true,
    profile: null,
    className: '',
    /** 成员统计（api.memberStats）：{ total, groupA, groupB } */
    stats: null,
    /** 班费总额（api.feeSummary.class.total），非超管/生活委员可能拿不到 → null */
    feeTotal: null,
    /**
     * 「班级管理」入口是否可见（2026-10-28 补）：
     * 首页精简后这个入口在首页消失，改挂到本页「班级概况」卡右上角。
     * 口径与旧首页 canViewClass 完全一致：**仅超管 / 辅导员**，普通成员和班委都看不到
     * （班级是全局资产，不该让班委随手改）。
     */
    canManageClass: false,
    /* ---------------- 教职工切班（2026-10-28 需求） ----------------
     * 一个辅导员带多个班，以前只能进「班级成员」「班费」各自切，班级信息页却永远
     * 钉在主班 —— 在 A 班看到的人数/班费其实都是 B 班的，容易误判。
     * 现在切班收口到本页：切完班名、总人数/A/B、班费金额一起变，点进子页面也带着走。
     *
     * 数据来源 class.list：对辅导员后端只返回 staff_class 绑定的班（class/index.js
     * 的 isCounselorNow 分支），所以这份列表天然就是「他有权看的全部班级」。
     */
    /** 可切换的班级 [{ id, name }]，只对超管 / 辅导员有意义；普通成员恒为空 */
    classChips: [],
    /** 当前查看的班级 id；0 = 没有可切换的班，两个接口由后端解析成本班 */
    viewClassId: 0,
    /** 是否教职工（超管 / 辅导员）。普通成员只有自己一个班，不显示切班入口 */
    isStaff: false,
    /**
     * 请假能力位（2026-11-01 请假 v3）：
     *   canApply   —— 本人可提交请假申请。普通成员（含班委，非教职工）都算，教职工走别通道。
     *   canApprove —— 有审批他人申请的权限（班长 / 副班长 / 超管），来自 auth.login 的 canApprove。
     */
    canApply: false,
    canApprove: false,
    /** 待我审批的请假条数（审批卡角标）；非审批人恒为 0 */
    pendingCount: 0,
    /** 当前看的是不是「非本人主班」—— 通知卡据此置灰（它跟不过去，见 onOpen 注释） */
    isOtherClass: false,
    /**
     * 班级大标题的字号（rpx，2026-11-14 用户要求「居中、自适应、保证一行显示完」）。
     * 由 _nameFont() 按班名字数算，wxml 用内联 style 绑到 .ci-hero-name。
     * WXSS 里不能表达「字多就缩」，所以必须算在 JS 里。
     */
    nameFont: 44,
    /* 班级选择弹层的 classSheetShow / clsSheetH 已于 2026-11-14 随 bottom-sheet 删除 ——
     * 切班统一走 class-picker 下拉（组件内部管开合，页面不再持状态）。 */
    /** 倒数日列表（2026-11-03 改云端）：**仅本人**的事件，后端按 member_id 隔离，按日期升序 */
    countdowns: [],
    /** 倒数日添加弹层 */
    cdSheetShow: false,
    cdName: '',
    cdDate: ''
  },

  onLoad() {
    const app = getApp();
    theme.mount(this);   // 深色模式：挂 t-light / t-dark 到本页根节点
    this.setData({ statusBarHeight: (app && app.globalData && app.globalData.statusBarHeight) || 20 });
    this.setData({ demo: !!(app && app.globalData && app.globalData.demo) });
  },

  onUnload() {
    theme.unmount(this);   // 深色模式：摘掉主题订阅
  },

  onShow() {
    const app = getApp();
    // 第 5 个 tab：把底部导航的选中态同步到「信息」
    if (app && app.setTabBar) app.setTabBar(2);
    // 就绪后统一播入场动画（v0.7.31：等身份 + 首屏数据，或 READY_MS 兜底）
    pageAnim.playReady(this, getApp());
    this.load();
    this.loadCountdowns();
  },

  load() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || null;
    // 「班级管理」入口可见性 + 切班能力：同一口径（与后端 guard.isSuper / isCounselor 一致）
    const isSuperNow = !!(app && app.isSuper && app.isSuper());
    const isCounselorNow = !!(p && p.groupTag === 'X');
    const isStaff = isSuperNow || isCounselorNow;
    this.setData({ profile: p, canManageClass: isStaff, isStaff });
    // 请假能力位（v3）：普通成员（含班委）本人可提交申请；审批权看 auth.login 下发的 canApprove。
    // ⚠️ 用 app.canApprove() 而不是本地比对 position：与后端 isLeaveApprover 单一真源，不会漂移。
    const canApprove = !!(app && app.canApprove && app.canApprove());
    const canApply = !isStaff;
    this.setData({ canApply, canApprove });
    if (canApprove) this._loadPending();

    /* 教职工：可切换多个班。classList 仍然必要（要知道「他到底能看哪几个班」），
     * 但**不再让统计等它** —— 顺序与取舍见分支内说明。 */
    if (isStaff) {
      /* 教职工路径（2026-10-29 重构）：统计**先**出数，不等 classList。
       *
       * 原来这条路径是串行的：classList（查我能看哪几个班）→ 才拉 memberStats / feeSummary。
       * 云函数冷启动时每次调用 2~3s，串起来就是实测的「6 秒以上」——而班级概况的三个数字
       * 根本不依赖班名，白白被堵住。现在先用「当前已知班级」出数，chips 解析完若选中班
       * 不同再补拉一次（_loadClassData 有同班去重，重复 cid 不会打第二次）。
       *
       * 同时修掉「未绑定班级」：classList 失败（超时 / 返回体异常）时旧代码走进
       * `_applyClass(0, [])`，把班名清成空串 ⇒ 页面一边显示真实人数、一边显示「未绑定班级」，
       * 自相矛盾。现在失败只记录、不清空，并重试一次。 */
      const own = Number((p && p.classId) || 0);
      this._loadClassData(Number(this.data.viewClassId) || 0);   // 先出 overview 数字

      /* 教职工可切换班级列表：低频变化，新鲜窗口内直接复用内存缓存（不重拉）。 */
      const listKey = mem.keys.classList();
      const cachedList = mem.read(listKey);
      const now = Date.now();
      if (cachedList && this._lastListLoad && now - this._lastListLoad < STALE_MS && this.data.classChips.length) {
        /* 命中缓存也要走一遍 keep / sel 选择逻辑：keep 分支一旦被删，缓存命中这条路径同样会把
         * 班级弹回主班（门禁变异自证盯着这条）。keep 正常时 sel = 当前 viewClassId，不弹回、零请求。 */
        const chips = this.data.classChips;
        const keep = chips.some(c => c.id === Number(this.data.viewClassId));
        const sel = keep ? Number(this.data.viewClassId)
          : (chips.some(c => c.id === own) ? own : chips[0].id);
        this._applyClass(sel, chips);
        return;
      }

      const buildChips = (list) => util.sortClasses(Array.isArray(list) ? list : [])
        .map(c => {
          const name = util.classNameOf(c);
          // short（2026-10-28）：通知页把班名放进导航标题，全名「示例专业B1班」
          // 一行放不下，取「示例班级C」这种短名（取不到就退回全名）。
          const m = /\d{4}\s*班/.exec(name) || /\d{3,4}/.exec(name);
          return { id: Number(c.id) || 0, name, short: m ? m[0].replace(/\s+/g, '') : name };
        })
        .filter(c => c.id);

      /** chips 到手后的收口：定选中班 → 写缓存 → 更新 chips → 拉该班数据 */
      const settle = (chips, raw) => {
        if (!chips.length) {
          /* 🔴 拿不到列表时**不要**清班名：统计已经出了数，清了就变「有人数但显示未绑定班级」。
           * 只落日志（含返回体形状，供下次定位），页面保持上一帧的班名。 */
          console.error('[classinfo] classList empty', JSON.stringify({
            isArray: Array.isArray(raw), len: Array.isArray(raw) ? raw.length : -1
          }));
          return;
        }
        /* 默认选中：已选且仍在列表内 → 本人主班 → 列表第一个。
         * 🔴 不能无条件回到主班：onShow 每次都会跑 load()，无条件重置会让
         *    「切到 1 班 → 瞥一眼微信 → 切回来」被弹回 示例班级A，等于切班白切。 */
        const keep = chips.some(c => c.id === Number(this.data.viewClassId));
        const sel = keep ? Number(this.data.viewClassId)
          : (chips.some(c => c.id === own) ? own : chips[0].id);
        mem.write(listKey, raw);
        this._lastListLoad = Date.now();
        this.setData({ classChips: chips });
        this._applyClass(sel, chips);
      };

      const fetchList = () => api.classList({ all: true }, { toast: false })
        .then((list) => { settle(buildChips(list), list); return true; });

      fetchList()
        .catch((e) => {
          console.error('[classinfo] classList failed', e && e.stack ? e.stack : e);
          // 重试一次：偶发超时不该让这一屏永远停在「未绑定班级」。仍失败就保持已出的统计。
          return fetchList();
        })
        .catch((e) => {
          console.error('[classinfo] classList retry failed', e && e.stack ? e.stack : e);
        });
      return;
    }

    /* 普通成员：只有一个班。班名与统计**解耦**——统计（总人数 / A·B 组 / 班费）立刻拉、
     * 先出数，不让「等班名」把整张「班级概况」一起卡住；班名本运行期恒定，优先内存缓存
     * （首次解析后切 Tab / 重进零请求、秒开），其次 profile.className（后端不下发，基本
     * 走不到），最后才查一次 classList 兜底。classId 始终传 0 让后端解析成本班（逐字等价改造前）。
     * 缓存按成员 id 隔离：演示态 / 切换身份后不会把上一个班的名字串进来。 */
    const memberId = (p && p.id) || 0;
    this._loadClassData(0);   // 先出 overview 数字，不等班名
    const cachedName = mem.read(mem.keys.myClass(memberId));
    if (cachedName) { this._setClassName({ className: cachedName, isOtherClass: false }); return; }
    const className = (p && p.className) || '';
    if (className) { mem.write(mem.keys.myClass(memberId), className); this._setClassName({ className, isOtherClass: false }); return; }
    api.classList({ all: true }, { toast: false })
      .then((list) => {
        const rows = (list || []);
        const myId = (p && p.classId) || 0;
        /* 普通成员 classList 只回本班（后端 WHERE id = 本班）：优先按 profile.classId 命中；
         * 命中不到（profile.classId 偶发失同步 / 切换体验版残留缓存）直接取唯一一条，
         * 避免退回「未绑定班级」。stats 已先行拉取，这里只补班名。 */
        let mine = myId ? rows.find(c => (c.id || c.classId) === myId) : null;
        if (!mine && rows.length === 1) mine = rows[0];
        const name = mine ? util.classNameOf(mine) : '';
        if (name) mem.write(mem.keys.myClass(memberId), name);
        this._setClassName({ className: name, isOtherClass: false });
      })
      .catch((e) => {
        console.error('[classinfo] classList failed', e && e.stack ? e.stack : e);
      });
  },

  /**
   * 班名字号自适应（2026-11-14 用户要求「居中、自适应大小、保证一行显示完」）。
   * 卡片内容宽约 630rpx（750 − 两侧留白 − 卡片内边距），汉字宽度 ≈ 字号
   * ⇒ 44rpx 能容 14 个字，超出就按字数等比缩，下限 26rpx（再小就没有主标题的分量）。
   * ⚠️ WXSS 没有「字多自动缩」的表达，只能在 JS 侧算好再内联下发。
   */
  _nameFont(name) {
    const len = String(name || '').length;
    if (!len) return 44;
    return Math.max(26, Math.min(44, Math.floor(630 / len)));
  },

  /** 统一出口：改班名必须同时重算字号，否则长班名会溢出成两行 */
  _setClassName(patch) {
    const name = patch.className !== undefined ? patch.className : this.data.className;
    this.setData(Object.assign({ nameFont: this._nameFont(name) }, patch));
  },

  /**
   * 切换（或初始化）当前查看的班级：更新 chips 选中态 + 班名，重拉该班的人数与班费。
   * `id = 0`（教职工一个班都没绑）→ 退回后端默认本班，行为与改造前一致。
   */
  _applyClass(id, chips) {
    const p = this.data.profile || {};
    const own = Number(p.classId || 0);
    const list = chips || this.data.classChips || [];
    const hit = list.filter(c => c.id === Number(id))[0];
    /* 班名兜底（2026-10-29）：命中不到、或命中的 chip 名为空时，退回「本人主班 → 列表第一个
     * → 上一帧的值」。🔴 绝不清成空串 —— 空串会让 wxml 显示「未绑定班级」，而同一屏右边
     * 明明显示着真实人数，自相矛盾（这正是用户看到的那一屏）。 */
    const fallbackName = ((list.filter(c => c.id === own)[0] || list[0]) || {}).name || '';
    const nextName = (hit && hit.name) ? hit.name : (fallbackName || this.data.className || '');
    this.setData({
      viewClassId: Number(id) || 0,
      className: nextName,
      /* 班名改了就重算字号 —— 长班名（12 字以上）否则会折成两行，用户要的是「一行显示完」 */
      nameFont: this._nameFont(nextName),
      /* 「看的是别班」只用来标记其它三张子卡（roster / fee / homework）的参数口径：
       * 它们的 classId 语义是「查看指定班级」，本班传进去会被当成跨班态。
       * 通知不走这条（2026-10-28）：它现在支持按班查看，本班也带 classId，见 onOpen。
       * 🔴 2026-11-14 修「辅导员点班级成员进去 0 人」：原来写 `!!id && !!own && id !== own`，
       *    而教职工是**全局账号**（member.class_id 恒 0）⇒ `!!own` 永远为假 ⇒ 恒 false
       *    ⇒ 子页面 URL 不带 classId ⇒ roster 按「本班」请求 ⇒ 后端拿 class_id=0 查出 0 条。
       *    超管主班是真班级，所以一直没有暴露。判据只能是「两个数字不相等」。
       *    门禁 check-classinfo-switch ⑬ 守着这条（只在主班为 0 的账号上翻车）。 */
      isOtherClass: !!id && Number(id) !== own,
      /* 先清空再拉：不清的话切班瞬间 hero 里还挂着上一个班的人数，
       * 用户会以为「两个班人数一样」，比空白更容易误导。 */
      stats: null,
      feeTotal: null
    });
    // 同步到全局「当前查看班级」：信息页是切班中心，其余 Tab 跟随此值联动
    getApp().globalData.viewClassId = Number(id) || 0;
    this._loadClassData(Number(id) || 0);
  },

  /**
   * 拉某个班的概况数据。`classId = 0` 时两个接口都回落到本班：
   *   · member.stats  → targetClassId()：非超管/非辅导员恒返回本班，辅导员校验 staffClassIds
   *   · fee.getSummary → guard.resolveClassId()：同一套跨班校验
   * 所以普通成员这条路径与改造前逐字等价，不需要后端任何改动。
   */
  _loadClassData(classId, force) {
    const cid = Number(classId) || 0;
    const arg = classId ? { classId } : {};
    const key = mem.keys.classinfo(cid);
    const cached = mem.read(key);

    /* SWR：先用内存缓存同步渲染 —— 切回本页 / 切回同一个班时瞬间出数，不闪骨架、不白屏。
     * 缓存只在本运行期有效（不落 storage，与首页 / 通知策略一致）。 */
    if (cached) {
      this.setData({ loading: false, stats: cached.stats, feeTotal: cached.feeTotal });
    }
    /* 频率闸门：同一班 + 数据仍在新鲜窗口内 + 非强制 → 不打接口。
     * onShow 每次都跑、Tab 切回都重跑，但班级概况这类低频变化的数据没必要每次打；
     * 切班（cid 变化）会自然触发重拉，显式动作可传 force 强制刷新。 */
    const now = Date.now();
    if (!force && cached && this._lastClassId === cid && this._lastLoad && now - this._lastLoad < STALE_MS) {
      return;
    }
    /* 没缓存也没内容才显示骨架；有缓存时保持缓存内容、后台静默刷新（避免切回白屏一闪）。 */
    const hasContent = !!this._hasData;
    if (!hasContent && !cached) this.setData({ loading: true });

    /* 同一班的请求已在飞 → 不重复打。
     * 教职工路径会先按「已知班级」出统计、chips 到齐后再确认选中班；两次 cid 常常相同，
     * 不去重就会在冷启动时把同一份数据连打两次（6s 直接翻成 12s）。 */
    if (this._inflightCid === cid) return;
    this._inflightCid = cid;

    // 成员统计（总人数 / A 组 / B 组）—— 班级概况的核心数字
    api.memberStats(arg, { toast: false })
      .then((r) => {
        this._inflightCid = null;
        this._hasData = true;
        this._lastLoad = Date.now();
        this._lastClassId = cid;
        mem.write(key, { stats: r, feeTotal: this.data.feeTotal });
        this.setData({ loading: false, stats: r });
      })
      .catch((e) => {
        // 不吞：真实原因（超时 / 业务码 / JS 异常）落 console，下次一眼可见
        this._inflightCid = null;
        console.error('[classinfo] memberStats failed', e && e.stack ? e.stack : e);
        this.setData({ loading: false, stats: null });
      });

    // 班费总额（仅生活委员 / 管委会成员拿得到；拿不到就保持 null，卡里显示通用文案）
    api.feeSummary(arg, { toast: false })
      .then((r) => {
        const c = (r && r.class) || {};
        const feeTotal = (c.total != null ? Number(c.total) : null);
        mem.write(key, { stats: this.data.stats, feeTotal });
        this.setData({ feeTotal });
      })
      .catch((e) => {
        console.error('[classinfo] feeSummary failed', e && e.stack ? e.stack : e);
      });
  },

  /* ---------------- 倒数日（2026-11-03 改云端）：个人自定义事件，按人隔离 ---------------- */
  /**
   * 读取**自己的**倒数日（后端按 member_id 隔离，拿不到别人的），并算「还剩 N 天」文案。
   *
   * 天数优先用后端返回的 `days`（后端按北京时间日期算，不受手机时区影响）；
   * 后端没给（老数据 / 字段缺失）时才本地兜底算一次。
   */
  loadCountdowns() {
    return this._fetchCountdowns().then((list) => {
      this.setData({ countdowns: this._enrichCd(list) });
      // 1.0.8.19~1.0.8.21 的旧数据存在本地，这里做一次性搬迁（成功即清 key，失败下次再试）
      this._migrateLocalCd();
      return list;
    });
  },

  _fetchCountdowns() {
    return api.countdownList({}, { toast: false })
      .then((d) => ((d && d.list) || []))
      .catch((e) => {
        // 拉不到不清空已有列表：网络抖动时把上次的内容留在界面上，比空着更不容易误解成「被删了」
        console.error('[classinfo] 拉取倒数日失败', e && e.stack ? e.stack : e);
        return this.data.countdowns || [];
      });
  },

  _enrichCd(list) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return (list || [])
      .slice()
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
      .map((it) => {
        let diff = Number(it.days);
        if (!Number.isFinite(diff)) {
          const t = new Date((it.date || '1970-01-01') + 'T00:00:00');
          diff = Math.round((t - today) / 86400000);
        }
        let dayText;
        if (diff > 0) dayText = diff + '天';
        else if (diff === 0) dayText = '今天';
        else dayText = '已过 ' + (-diff) + ' 天';
        return Object.assign({}, it, { dayText, passed: diff < 0 });
      });
  },

  /**
   * 一次性迁移：把旧版本存在 wx.storage 的倒数日搬到云端。
   *
   * 迁移成功的判据是**全部条目都上传成功** —— 只要有一条失败就保留本地 key，
   * 下次 onShow 再试，绝不做「删了本地却没上传」这种静默丢数据的事。
   * `_cdMigrating` 是内存锁：onShow 重复触发时不会并发跑两遍上传。
   */
  _migrateLocalCd() {
    if (this._cdMigrating) return;
    let local = [];
    try {
      const raw = wx.getStorageSync('countdown_events_v1');
      if (Array.isArray(raw) && raw.length) local = raw;
    } catch (e) {
      return;
    }
    if (!local.length) return;
    this._cdMigrating = true;
    const tasks = local
      .map((it) => ({
        name: String((it && it.name) || '').trim().slice(0, 30),
        date: String((it && it.date) || '').slice(0, 10)
      }))
      .filter((it) => it.name && /^\d{4}-\d{2}-\d{2}$/.test(it.date));
    const upload = tasks.length
      ? tasks.reduce(
          (p, it) => p.then(() => api.countdownAdd(it, { toast: false })),
          Promise.resolve()
        )
      : Promise.resolve();
    upload
      .then(() => {
        wx.removeStorageSync('countdown_events_v1');
        this._cdMigrating = false;
        console.log('[classinfo] 倒数日本地数据已迁云端，共', tasks.length, '条');
        if (tasks.length) this.loadCountdowns();
      })
      .catch((e) => {
        this._cdMigrating = false;
        // 保留本地 key，下次 onShow 重试；不弹 toast 打扰用户（他们并不知道有迁移这回事）
        console.error('[classinfo] 倒数日迁移失败，保留本地待重试', e && e.stack ? e.stack : e);
      });
  },

  /** 打开添加弹层并清空表单 */
  onCdAdd() {
    this.setData({ cdSheetShow: true, cdName: '', cdDate: '' });
  },

  onCdNameInput(e) {
    this.setData({ cdName: e.detail.value });
  },

  onCdDateChange(e) {
    this.setData({ cdDate: e.detail.value });
  },

  onCdSheetClose() {
    if (!this.data.cdSheetShow) return;
    this.setData({ cdSheetShow: false });
  },

  /** 保存到云端（个人）；后端对「同人同名同日期」幂等，连点不会重复 */
  onCdSave() {
    const name = (this.data.cdName || '').trim();
    const date = this.data.cdDate;
    if (!name) { wx.showToast({ title: '请填写事件名称', icon: 'none' }); return; }
    if (!date) { wx.showToast({ title: '请选择目标日期', icon: 'none' }); return; }
    if (this._cdSaving) return;
    this._cdSaving = true;
    api.countdownAdd({ name, date }, { toast: false })
      .then((r) => {
        this._cdSaving = false;
        this.setData({ cdSheetShow: false });
        this.loadCountdowns();
        wx.showToast({ title: r && r.existed ? '已经有这一个了' : '已添加', icon: 'none' });
      })
      .catch((e) => {
        this._cdSaving = false;
        console.error('[classinfo] 保存倒数日失败', e && e.stack ? e.stack : e);
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      });
  },

  /** 点列表项 → 确认后删除（后端会再校验归属，删别人的直接 40003） */
  onCdTap(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    if (!id) return;
    const item = (this.data.countdowns || []).filter((c) => String(c.id) === String(id))[0];
    if (!item) return;
    wx.showModal({
      title: '删除倒数日',
      content: '确定删除「' + item.name + '」？',
      confirmColor: '#F53F3F',
      success: (r) => {
        if (!r.confirm) return;
        api.countdownDelete({ id }, { toast: false })
          .then(() => this.loadCountdowns())
          .catch((err) => {
            console.error('[classinfo] 删除倒数日失败', err && err.stack ? err.stack : err);
            wx.showToast({ title: '删除失败，请重试', icon: 'none' });
          });
      }
    });
  },

  /**
   * 下拉里点一个班：切换口径。
   * `id = 0`（教职工一个班都没绑）→ 退到后端默认本班，行为与改造前一致。
   * ⚠️ 2026-11-14：来源由 bottom-sheet 行的 dataset 改为 class-picker 的 detail.id，
   *    两种都认（门禁与旧调用点都是 dataset 形态）。弹层状态已迁进组件，这里不再管开合。
   */
  onClassPick(e) {
    const id = Number((e && e.detail && e.detail.id) ||
      (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id)) || 0;
    if (!id || id === Number(this.data.viewClassId)) return;
    if (getApp().track) getApp().track.action('class_switch', id);
    this._applyClass(id);
  },

  /**
   * 点击子卡：全是二级页，一律 navigateTo。
   * 看的是别班时把 classId 顺着 URL 传下去，子页面才显示那个班：
   *   · roster → onLoad 读 options.classId，进「查看指定班级」态
   *   · fee    → onLoad 读 options.classId 作为「查看班级」的初始值
   * ⚠️ roster / fee **只在 isOtherClass 时带参数**：roster 里写的是
   *    `otherClass: classId > 0`，连自己班的 id 一起传会被当成「查看别班」，语义就错了。
   */
  onOpen(e) {
    const key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || '';
    const map = {
      roster:   '/pages/roster/index',
      fee:      '/pages/fee/index'
    };
    let url = map[key];
    if (!url) return;
    if (this.data.isOtherClass && this.data.viewClassId) {
      url += '?classId=' + this.data.viewClassId;
    }
    wx.navigateTo({ url, fail: () => {} });
  },

  /**
   * 「班级管理」入口（2026-10-28）：点右上角图标进 pages/classes。
   * 与首页旧 goClasses 完全一致（含埋点），仅换了挂载位置。
   */
  goClasses() {
    if (getApp().track) getApp().track.action('class_open');
    wx.navigateTo({ url: '/pages/classes/index' });
  },

  /**
   * 请假审批角标：仅审批人拉「待我审批」列表计数（非审批人不打）。
   * 超管看到全班级的待批、班长/副班长只看本班（后端 leavePendingList 已分口径）。
   * 失败静默归零，不让角标卡在旧数字上误导。
   */
  _loadPending() {
    if (!getApp().canApprove || !getApp().canApprove()) { this.setData({ pendingCount: 0 }); return; }
    api.leavePendingList({}, { toast: false })
      .then((r) => {
        const list = (r && r.list) || [];
        this.setData({ pendingCount: list.length });
      })
      .catch(() => { this.setData({ pendingCount: 0 }); });
  },

  /** 「我的请假」卡 → 进入请假页（本人申请 + 进度；默认 apply tab） */
  onGoMyLeave() {
    wx.navigateTo({ url: '/pages/leave/index', fail: () => {} });
  },

  /** 「请假审批」卡 → 进入请假页并定位审批 tab */
  onGoApprove() {
    wx.navigateTo({ url: '/pages/leave/index?tab=approve', fail: () => {} });
  },

  noop() {}
});
