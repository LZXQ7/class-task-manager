/**
 * P5 · 班级信息（Tab 5，新增）
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
const notice = require('../../utils/notice');
const pageAnim = require('../../utils/page-anim');
const theme = require('../../utils/theme');
const mem = require('../../utils/mem');

/** 班级概况这类低频变化的数据：Tab 切回 / 短间隔重进时，新鲜窗口内不打接口（与首页 STALE_MS 同源）。 */
const STALE_MS = 20000;

Page({
  data: {
    statusBarHeight: 20,
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
    /**
     * 未读通知数（2026-10-27 补）：首页「查看通知」卡随首页精简下线后，
     * 「还有没看的通知」这个信号在全站没有可见位置了 —— 角标挂在**通知子卡**上，
     * 与首页旧口径完全一致：utils/notice 缓存同步读 + 排除自己发的（游标按成员隔离）。
     */
    noticeUnacked: 0,

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
    /** 当前看的是不是「非本人主班」—— 通知卡据此置灰（它跟不过去，见 onOpen 注释） */
    isOtherClass: false,
    /**
     * 班级选择弹层（2026-10-28 二次调整）。
     * 原来是横滑 chips 条，用户反馈「左右滑动不太好」⇒ 改成点班名弹层选。
     * clsSheetH = 弹层高度（rpx），按班级数量算，见 _sheetHeight()。
     */
    classSheetShow: false,
    clsSheetH: 440
  },

  onLoad() {
    const app = getApp();
    theme.mount(this);   // 深色模式：挂 t-light / t-dark 到本页根节点
    this.setData({ statusBarHeight: (app && app.globalData && app.globalData.statusBarHeight) || 20 });
  },

  onUnload() {
    theme.unmount(this);   // 深色模式：摘掉主题订阅
  },

  onShow() {
    const app = getApp();
    // 第 5 个 tab：把底部导航的选中态同步到「班级信息」
    if (app && app.setTabBar) app.setTabBar(2);
    // 就绪后统一播入场动画（v0.7.31：等身份 + 首屏数据，或 READY_MS 兜底）
    pageAnim.playReady(this, getApp());
    this.load();
    // 通知角标：与首页旧口径同源（缓存同步读，不发请求）；每次进页面刷新一次
    const p = (app && app.globalData && app.globalData.profile) || null;
    const cached = notice.read(0);
    const meId = Number((p && p.id) || 0);
    this.setData({ noticeUnacked: cached ? notice.unackedCount(cached, meId) : 0 });
  },

  load() {
    const app = getApp();
    const p = (app && app.globalData && app.globalData.profile) || null;
    // 「班级管理」入口可见性 + 切班能力：同一口径（与后端 guard.isSuper / isCounselor 一致）
    const isSuperNow = !!(app && app.isSuper && app.isSuper());
    const isCounselorNow = !!(p && p.groupTag === 'X');
    const isStaff = isSuperNow || isCounselorNow;
    this.setData({ profile: p, canManageClass: isStaff, isStaff });

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
        this.setData({ classChips: chips, clsSheetH: this._sheetHeight(chips.length) });
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
    if (cachedName) { this.setData({ className: cachedName, isOtherClass: false }); return; }
    const className = (p && p.className) || '';
    if (className) { mem.write(mem.keys.myClass(memberId), className); this.setData({ className, isOtherClass: false }); return; }
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
        this.setData({ className: name, isOtherClass: false });
      })
      .catch((e) => {
        console.error('[classinfo] classList failed', e && e.stack ? e.stack : e);
      });
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
    this.setData({
      viewClassId: Number(id) || 0,
      className: (hit && hit.name) ? hit.name : (fallbackName || this.data.className || ''),
      /* 「看的是别班」只用来标记其它三张子卡（roster / fee / homework）的参数口径：
       * 它们的 classId 语义是「查看指定班级」，本班传进去会被当成跨班态。
       * 通知不走这条（2026-10-28）：它现在支持按班查看，本班也带 classId，见 onOpen。 */
      isOtherClass: !!id && !!own && Number(id) !== own,
      /* 先清空再拉：不清的话切班瞬间 hero 里还挂着上一个班的人数，
       * 用户会以为「两个班人数一样」，比空白更容易误导。 */
      stats: null,
      feeTotal: null
    });
    // 同步到全局「当前查看班级」：班级信息页是切班中心，其余 Tab 跟随此值联动
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

  /**
   * 弹层高度（rpx）：标题栏（grabber + 标题，约 130）+ 每行 96 + 上下留白 40。
   * 不写死 —— 2 个班弹一个 650rpx 的面板，下半截全是空白，比列表太短更难看。
   * 上限 900：再多也让它内部滚动，别把整屏吃掉。
   */
  _sheetHeight(n) {
    const rows = Math.max(1, Number(n) || 1);
    return Math.min(900, 130 + rows * 96 + 40);
  },

  /** 打开班级选择弹层。只有一个班时入口根本不渲染，这里再兜一次底 */
  onClassSheetOpen() {
    if (this.data.classChips.length < 2) return;
    this.setData({ classSheetShow: true });
  },

  onClassSheetClose() {
    if (!this.data.classSheetShow) return;
    this.setData({ classSheetShow: false });
  },

  /**
   * 弹层里点一个班：切换口径 + 关弹层。
   * `id = 0`（教职工一个班都没绑）→ 退到后端默认本班，行为与改造前一致。
   * 点当前班也关弹层 —— 用户点它是「我确认了」，不是「什么都没发生」。
   */
  onClassPick(e) {
    const id = Number(e.currentTarget.dataset.id) || 0;
    this.setData({ classSheetShow: false });
    if (!id || id === Number(this.data.viewClassId)) return;
    if (getApp().track) getApp().track.action('class_switch', id);
    this._applyClass(id);
  },

  /**
   * 点击 4 个子卡：全是二级页，一律 navigateTo。
   * 看的是别班时把 classId 顺着 URL 传下去，子页面才显示那个班：
   *   · roster   → onLoad 读 options.classId，进「查看指定班级」态（与「班级管理→查看人员」同一条路）
   *   · homework → onLoad 读 options.classId
   *   · fee      → onLoad 读 options.classId 作为「查看班级」的初始值
   *   · notice   → onLoad 读 options.classId 走「按班查看」（2026-10-28 新增）
   * ⚠️ roster / fee / homework **只在 isOtherClass 时带参数**：roster 里写的是
   *    `otherClass: classId > 0`，连自己班的 id 一起传会被当成「查看别班」，语义就错了。
   *    notice 例外：它的 classId 只表示「看哪个班」，本班传进去也正确 ——
   *    而且这样「在 示例班级A 看 示例班级A 的通知」比「不带参数看全部可见」更符合预期。
   */
  onOpen(e) {
    const key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || '';
    const map = {
      roster:   '/pages/roster/index',
      fee:      '/pages/fee/index',
      notice:   '/pages/notice/index',
      homework: '/pages/homework/index'
    };
    let url = map[key];
    if (!url) return;
    if (key === 'notice') {
      /* 2026-10-28：通知不再被拦。原来 media.msgList 用 guard.classIdOf(ctx) 硬锁本班，
       * 切到别班只能置灰 + 弹「通知仅显示本人班级」；现在后端支持按班查看
       * （超管任意活动班 / 辅导员限 staff_class），班级信息页切哪个班就看哪个班的通知。 */
      if (this.data.viewClassId) {
        url += '?classId=' + this.data.viewClassId;
        const hit = (this.data.classChips || []).filter(c => c.id === Number(this.data.viewClassId))[0];
        if (hit && hit.short) url += '&name=' + encodeURIComponent(hit.short);
      }
    } else if (this.data.isOtherClass && this.data.viewClassId) {
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

  noop() {}
});
