/* 网页管理后台 · 前端逻辑（零构建、无框架）
 * ============================================================
 * 为什么不用 amis SDK（与方案的偏离，需用户确认）：
 *   方案原定「amis SDK 打进云函数包」。实测权衡后本期改用原生页面：
 *   ① amis SDK 数 MB，会明显拖慢云函数冷启动 —— 而后台是「一天点几次」的工具，
 *      冷启动痛点远小于「构建链 + 版本漂移」的维护成本；
 *   ② 后端接口已按 amis 的 RESTful 约定设计（GET 列表 / POST 提交 / 统一 {ok,data}），
 *      后续要换 amis 只换渲染层，**后端一行不改**。
 *   ⇒ 这是「先把数据通路做对」，不是砍功能。
 *
 * ⚠️ 铁律：所有请求走 api()，**不要裸调 fetch**。
 *    后端在 HTTP 云函数里，5xx + 空 body = 后端根本没起（与偷闲项目同型故障），
 *    裸 fetch 的 response.json() 遇非 JSON 会抛解析错误，把真正的 HTTP 错误掩盖掉。
 */
(function () {
  'use strict';

  var state = {
    user: null,
    classes: [],
    classId: null,
    view: 'overview',
    /* 当前账号可访问的页签（后端 /api/me 下发，2026-11-15）。
       空数组 = 还没拿到登录态；拿到后由 showMain 写入并渲染导航。
       **前端只做「不给入口」，真正的拦截在后端 requirePerm** —— 前端过滤不是安全边界。 */
    perms: [],
    // 使用统计：默认「全部班级」总览（2026-10-18 用户要求直接看全部账号）
    usageAll: true,
    // 使用统计：三个板块各自的指标筛选（纯本地重绘，不重拉 API）
    usageTrendMetric: 'visitUsers',
    usageSourceMetric: 'pv',
    // 分时趋势对比两日：false=参照三线(今日/1天前/7天前)，true=任选两自然日叠加
    // 页面级对比（2026-11-09 用户要求）：对比整个使用统计，不只是分时那张图
    cmpOn: false,
    cmpGran: 'day',   // day = 单日 vs 单日；range = 区间 vs 区间
    cmpA1: '',        // A 段起（YYYY-MM-DD）
    cmpA2: '',        // A 段止（单日模式恒等于 cmpA1）
    cmpB1: '',
    cmpB2: '',
    // 成员明细排序：默认按次数降序（2026-10-23 用户要求）
    memSort: { key: 'pv', dir: 'desc' },
    // 课表导入：解析结果暂存，确认时才提交
    importDraft: null,
    memberPage: 1,
    // 成员列表：页大小 0 = 「全部」（后端不拼 LIMIT）；筛选与小程序名册页同为四选一
    memberPageSize: 50,
    memberScope: 'ALL',
    memberKw: '',
    auditPage: 1,
    // 值日明细分页（2026-11-16 焕新 · UX 规范 P0）：
    // 原来固定 pageSize=200 一次拉满，页面被撑成超长表格 ⇒ 改 60/页 + 分页器。
    // 后端 lib/mod-duty.js 的 pageSize 默认也是 60，两侧口径一致。
    dutyPage: 1,
    dutyPageSize: 60,
    group: 'ALL',
    leaveStatus: 'ALL',
    leaveKw: ''
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  /* 设备形态真源：index.html 在 <head> 按 UA 注入的 <html> class（2026-11-11 用户要求）。
     ⚠️ 不用 innerWidth / matchMedia —— 手机端 / 电脑端版式必须跟设备 UA 走，
     不能跟窗口大小走；admin.css 的手机版规则全部挂在 .ua-mobile 下，与此同源。 */
  function isMobileDevice() {
    if (typeof window.__DEVICE_MOBILE__ === 'boolean') return window.__DEVICE_MOBILE__;
    return document.documentElement.classList.contains('ua-mobile');
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 班级名显示层缩写：示例专业→ 小教（专升本）。
  // ⚠️ 仅影响展示文案，不动数据库 / 小程序 util.js majorRank / 排课 / PII 词表（均依赖全名）。
  function shortClassName(name) {
    if (name === null || name === undefined) return name;
    return String(name).replace(/小学教育/g, '小教');
  }

  /**
   * 班级状态标签。
   * 🔴 演示班（is_demo=1）在库里是 is_active=0 —— 那是**刻意**停的（停用后它不会出现在
   *   真实超管的小程序班级列表里），不是故障。若照 isActive 原样渲染，后台会把它显示成
   *   灰「停用」，让人以为被谁误停（2026-11-04 用户就是这么问上来的）。
   * @param {object} c 班级对象（需带 isDemo / isActive）
   * @param {boolean} [short] 窄表格用短文案
   */
  function classStatusTag(c, short) {
    if (c && c.isDemo) {
      return '<span class="tag tag-demo">' + (short ? '演示' : '演示 · 不参与统计') + '</span>';
    }
    return (c && c.isActive)
      ? '<span class="tag tag-ok">启用</span>'
      : '<span class="tag tag-off">停用</span>';
  }

  function toast(msg, type) {
    var el = $('#toast');
    var isError = type === 'err';
    el.className = 'toast' + (type ? ' toast-' + type : '');
    // 普通结果是非打断式 status；只有关键错误升级为 alert（SPT 02 浮层与通知选型）。
    // 不抢焦点、不把每次通知都播成打断式警告。
    el.setAttribute('role', isError ? 'alert' : 'status');
    el.setAttribute('aria-live', isError ? 'assertive' : 'polite');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    // 错误与关键结果不能只在 2.6s 内一闪而过；成功/普通提示保持原节奏（SPT 02）。
    toast._t = setTimeout(function () { el.hidden = true; }, isError ? 5200 : 2600);
  }

  /* ---------------- 确认弹层（2026-11-16 焕新 · 体验规范 §3.5）----------------
   * 为什么要有：原来全站 13 处危险操作用**浏览器原生 confirm()**，
   *   系统弹窗样式与全站割裂、无法承载富文案、触屏上像"另一个应用"
   *   —— 这是"老气"的最大来源之一。
   * 现在统一走站内 .dlg-mask/.dlg 结构（新增 .dlg-confirm 变体）。
   *
   * 三级危险度（规范 C4）：
   *   L1 轻确认 —— 删单条记录：无倒计时、无勾选
   *   L2 标准   —— 删课次 / 删停用后台账号 / 清空课表：逐条列出影响数量
   *   L3 强确认 —— 覆盖导入 / 清空课表：需显式勾选「我已知晓影响」
   *
   * 无障碍（规范 C5/C6）：
   *   · role="dialog" + aria-modal="true" + aria-labelledby 指向标题
   *   · 焦点移入弹层；**危险按钮默认不聚焦**（焦点落在「取消」），避免回车即误删
   *   · Esc 关闭；关闭后**焦点归还触发元素**
   *
   * @param {object} o
   *   o.title    标题（动词 + 对象）
   *   o.body     正文（HTML，允许 <br> 与 <strong>）
   *   o.okText   确认按钮文案（默认「确认」）
   *   o.danger   true ⇒ 确认按钮用危险色（默认 true）
   *   o.level    'L1' | 'L2' | 'L3'（L3 需勾选「我已知晓影响」）
   * @returns {Promise<boolean>} 用户点了确认才 resolve(true)
   */
  function confirmDialog(o) {
    o = o || {};
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      var needAck = o.level === 'L3';
      dlg.innerHTML =
        '<div class="dlg dlg-confirm" role="dialog" aria-modal="true" aria-labelledby="dlg-cf-hd">' +
        '<div class="dlg-hd" id="dlg-cf-hd">' + esc(o.title || '确认操作') + '</div>' +
        '<div class="dlg-bd">' +
        '<div class="dlg-cf-body">' + (o.body || '') + '</div>' +
        (needAck
          ? '<label class="dlg-cf-ack"><input type="checkbox" id="dlg-cf-ack"> 我已知晓以上影响</label>'
          : '') +
        '</div>' +
        '<div class="dlg-ft">' +
        '<button type="button" class="btn" id="dlg-cf-cancel">取消</button>' +
        '<button type="button" class="btn ' + (o.danger === false ? 'btn-primary' : 'btn-danger') +
        '" id="dlg-cf-ok"' + (needAck ? ' disabled' : '') + '>' + esc(o.okText || '确认') + '</button>' +
        '</div></div>';
      document.body.appendChild(dlg);

      var okBtn = $('#dlg-cf-ok', dlg);
      var cancelBtn = $('#dlg-cf-cancel', dlg);
      var ackBox = needAck ? $('#dlg-cf-ack', dlg) : null;

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        // 焦点归还触发元素（无障碍 C5）
        try {
          if (prevFocus && prevFocus.focus) prevFocus.focus();
        } catch (e) { /* 元素已消失，忽略 */ }
        resolve(!!result);
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
      }
      if (ackBox) {
        ackBox.onchange = function () { okBtn.disabled = !ackBox.checked; };
      }
      cancelBtn.onclick = function () { close(false); };
      okBtn.onclick = function () {
        if (needAck && ackBox && !ackBox.checked) return;
        close(true);
      };
      // 点遮罩关闭（与站内其它弹层一致）
      dlg.onclick = function (e) { if (e.target === dlg) close(false); };
      document.addEventListener('keydown', onKey, true);
      // 焦点落在「取消」（危险操作不默认聚焦确认按钮，避免回车即误删）
      try { cancelBtn.focus(); } catch (e) { /* ignore */ }
    });
  }

  /* ---------------- API 封装 ---------------- */

  // ⚠️ 为什么所有 API 都要补 /admin 前缀（2026-10-10 线上实测踩坑）：
  //    CloudBase HTTP 云函数配了 gatewayPath="/admin"，**网关只转发 /admin 前缀的路径**。
  //    实测：/admin/api/me=401（转发到了、只是没登录态），而 /api/me=404（压根没转发）。
  //    所以业务代码里继续写 '/api/xxx'（读起来与后端路由一致），由这里统一补前缀。
  // ⚠️ 前缀必须**从 location 运行时推导**，不能写死：
  //    · 线上页面 URL 是 /admin  ⇒ 前缀 /admin
  //    · e2e 跑在 127.0.0.1/     ⇒ 前缀 ''（写死会让 43 项本地 e2e 全挂，
  //      而本地全绿恰恰是这个 bug 逃过检测的原因 —— 见 HANDOFF 记录）
  //    ⚠️ 也不能用相对路径：页面 URL 无尾斜杠，浏览器会把 /admin 当文件名解析。
  var API_BASE = /^\/admin(?:\/|$)/.test(location.pathname) ? '/admin' : '';

  function api(pathname, options) {
    options = options || {};
    /* 2026-11-08「经常连接服务器失败」：云函数冷启动 / 网络瞬断多为一次性，
     * 读请求（GET）默认自动重试 1 次；写请求绝不自动重试（避免重复提交）。 */
    var maxRetry = options.retry === undefined
      ? ((options.method || 'GET') === 'GET' ? 1 : 0) : options.retry;
    var attempt = 0;
    function once() {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, options.timeoutMs || 25000) : null;
    var init = {
      method: options.method || 'GET',
      headers: { 'Accept': 'application/json' },
      // ⚠️ 必须带 credentials —— 登录态在 HttpOnly Cookie 里，
      //    不带它每次请求都是未登录。同源部署下不会触发跨站 Cookie 限制。
      credentials: 'same-origin'
    };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    if (ctrl) init.signal = ctrl.signal;
    return fetch(API_BASE + pathname, init)
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
          if (!data) {
            if (res.status === 401) { data = { ok: false, errMsg: '登录已过期，请重新登录' }; }
            else if (res.status >= 500) { data = { ok: false, errMsg: '服务异常（' + res.status + '），请稍后再试' }; }
            else { data = { ok: false, errMsg: '响应异常（HTTP ' + res.status + '）' }; }
          }
          if (!res.ok && data && data.ok === undefined) data.ok = false;
          // 演示班的「班级不存在或已停用」是**设计**不是故障：后台多数接口走
          // guard.resolveClassId，它对超管硬要求 is_active=1，而演示班是刻意停用的。
          // 在这里统一改写成能看懂的话，免得每个页面各弹一次 40003 去查后端。
          // （放 api() 是因为它是所有请求的唯一出口，别为这个去改 20 份 guard 拷贝。）
          var cur = currentClass();
          if (data && data.ok === false && cur && cur.isDemo &&
              /班级不存在或已停用/.test(String(data.errMsg || ''))) {
            data.errMsg = '「' + cur.name + '」是审核体验用的虚拟班，不参与统计、不支持后台修改';
          }
          return data;
        });
      })
      .catch(function (e) {
        if (e && e.name === 'AbortError') {
          return { ok: false, errMsg: '请求超时，请检查网络后重试' };
        }
        // 网络层失败：区分「连不上」与「被拒」
        return { ok: false, errMsg: '无法连接服务器，请确认后台服务是否正常运行' };
      })
      .finally(function () { if (timer) clearTimeout(timer); });
    }
    function run() {
      attempt++;
      return once().then(function (d) {
        var netFail = d && d.ok === false
          && /无法连接服务器|请求超时/.test(String(d.errMsg || ''));
        if (netFail && attempt <= maxRetry) {
          return new Promise(function (r) { setTimeout(r, 400 * attempt); }).then(run);
        }
        if (netFail && maxRetry > 0) {
          d.errMsg = String(d.errMsg) + '（已自动重试 ' + maxRetry + ' 次）';
        }
        return d;
      });
    }
    return run();
  }

  function needAuth(d) {
    if (d && d.errMsg === '登录已过期，请重新登录') {
      showLogin();
      return false;
    }
    return true;
  }

  /* ---------------- 视图切换 ----------------
   * `perm` = 该页签所需的后端权限 key（lib/perms.js 的 VIEWS）。
   * ⚠️ 前端视图 key 与权限 key **不总相同**（member↔members / timetable↔course），
   *    这是历史命名，不能为了「看起来整齐」去改前端 key ——
   *    `state.view` 存在 localStorage 里，改 key 会让所有人的刷新恢复失效。
   *    `config`（系统配置）与 `class`（账号班级）同属「班级/系统管理」，共用一个权限。
   */
  /* 导航顺序口径（2026-11-16 用户要求）：**标题字数越少越靠上，同字数保持原相对顺序**。
   * 即 2 字（概览/成员/请假/班费）→ 3 字（倒数日/课程表）→ 4 字（值日记录/换班申请/
   * 账号班级/系统配置/排班规则/使用统计/操作审计/后台账号）。「值日记录/换班申请」自然
   * 落在「课程表」下面。⚠️ 只调整声明顺序，key 是 localStorage 里的 state.view，不可改。
   * 改顺序须同步 lib/perms.js 的 VIEWS 数组 + index.html 注释 + check-admin-nav-order。 */
  var VIEWS = {
    overview:  { title: '概览',     perm: 'overview',  render: renderOverview },
    member:    { title: '成员',     perm: 'members',   render: renderMember },
    leave:     { title: '请假',     perm: 'leave',     render: renderLeave },
    fee:       { title: '班费',     perm: 'fee',       render: renderFee },
    countdown: { title: '倒数日',   perm: 'countdown', render: renderCountdown },
    timetable: { title: '课程表',   perm: 'course',    render: renderTimetable },
    duty:      { title: '值日记录', perm: 'duty',      render: renderDuty },
    swap:      { title: '换班申请', perm: 'swap',      render: renderSwap },
    class:     { title: '账号班级', perm: 'class',     render: renderClass },
    config:    { title: '系统配置', perm: 'class',     render: renderConfig },
    rules:     { title: '排班规则', perm: 'rules',     render: renderRules },
    usage:     { title: '使用统计', perm: 'usage',     render: renderUsage },
    audit:     { title: '操作审计', perm: 'audit',     render: renderAudit },
    accounts:  { title: '后台账号', perm: 'accounts',  render: renderAccount }
  };

  /** 当前账号能进哪些视图（顺序即导航顺序，与 VIEWS 声明顺序一致） */
  function allowedViews() {
    return Object.keys(VIEWS).filter(function (k) {
      return state.perms.indexOf(VIEWS[k].perm) >= 0;
    });
  }

  function canView(view) {
    return !!(VIEWS[view] && state.perms.indexOf(VIEWS[view].perm) >= 0);
  }

  /**
   * 细粒度操作权限（2026-11-16）：`members.view` / `members.edit` / …
   * state.perms 由 /api/me 下发，后端已按「子项上卷」展开过，所以这里精确匹配即可。
   * ⚠️ 前端隐藏按钮只是体验，真正的边界在 index.js 的 requirePerm —— 两处用的是同一批 key。
   */
  function canPerm(key) {
    return !!(state.perms && state.perms.indexOf(key) >= 0);
  }

  /**
   * 导航分组（2026-11-16 焕新 · 体验规范 §1.4）
   * 目的：超管看到 14 个页签、辅导员 11 个、副班长 7 个 —— 数量差异很大，
   * 扁平一列时既难扫读又显得拥挤。分组标题是**纯视觉叠加层**，页签相对顺序一位不动。
   *
   * ⚠️ 红线（改之前先读，改错会翻门禁）：
   *   R1 渲染按钮的模板必须保留字面量 `data-view="' + k + '"`（k 变量名不能改）
   *      —— check-admin-fee.js 的正则直匹配源码文本；
   *   R2 分组表写在 `var VIEWS = {...}` **之外** —— check-admin-nav-order 的
   *      parseAppViews 要求 `{` 后紧跟 `title:`，写进条目内部会让它解析出 0 项；
   *   R3 分组表的值是字符串/数组，不要用对象字面量 —— check-admin-fee 的
   *      `[^}]*` 正则不允许出现 `}`；
   *   R5 分组标题节点不带 id、不用 <button>、不带 data-view
   *      —— 避免进 Tab 序列、避免被 closest('.nav-item') 误命中。
   *
   * 分组边界恰好落在**等字数边界**上 ⇒ 字数升序口径（用户 2026-11-16 要求）不受影响：
   *   日常 8 项（2/2/2/2/3/3/4/4）→ 管理 4 项（4/4/4/4）→ 审计 2 项（4/4）
   */
  var NAV_GROUPS = [
    { label: '日常', views: ['overview', 'member', 'leave', 'fee', 'countdown', 'timetable', 'duty', 'swap'] },
    { label: '管理', views: ['class', 'config', 'rules', 'usage'] },
    { label: '审计与账号', views: ['audit', 'accounts'] }
  ];

  /**
   * 按权限渲染导航。
   * 为什么不直接在 index.html 里写死再逐个 hidden：
   * 写死会让「HTML 有 10 个、JS 有 14 个」这种漂移长期存在，
   * 而且顺序永远对不上 VIEWS 的声明顺序。全量重绘只有一个真源。
   */
  function renderNav() {
    var nav = $('#nav');
    if (!nav) return;
    var list = allowedViews();                 // 已是 VIEWS 声明顺序
    // 先切分、再剔除空组 —— 单组时**不输出任何标题**（副班长 7 项就是扁平列表）
    var groups = [];
    NAV_GROUPS.forEach(function (g) {
      var items = g.views.filter(function (k) { return list.indexOf(k) >= 0; });
      if (items.length) groups.push({ label: g.label, items: items });
    });
    var html = '';
    if (groups.length > 1) {
      groups.forEach(function (g) {
        html += '<div class="nav-group-label">' + esc(g.label) + '</div>';
        g.items.forEach(function (k) {
          html += '<button class="nav-item" data-view="' + k + '">' + esc(VIEWS[k].title) + '</button>';
        });
      });
    } else {
      // 单组（或分组表没覆盖到的页签）⇒ 扁平渲染，保持 VIEWS 顺序
      list.forEach(function (k) {
        html += '<button class="nav-item" data-view="' + k + '">' + esc(VIEWS[k].title) + '</button>';
      });
    }
    nav.innerHTML = html;
    if (!canView(state.view)) {
      var list2 = allowedViews();
      state.view = list2.length ? list2[0] : 'overview';
    }
    $$('.nav-item', nav).forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === state.view);
      // 读屏用户靠 aria-current 才知道"当前在哪一页"（视觉上是 .active 的指示条）
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  }

  /* ---------------- 刷新后恢复现场（2026-10-18 用户要求） ----------------
   * F5 刷新后不要跳回概览、也不要每次重置到第 1 个班：把当前 view / classId /
   * 统计范围落 localStorage，下次启动读回来。
   * 包 try/catch：门禁 mock 环境没有 localStorage，隐私模式下 setItem 会抛。 */
  var LS_VIEW = 'admin.web.view';
  var LS_CLASS = 'admin.web.classId';
  var LS_USAGE_ALL = 'admin.web.usageAll';
  var LS_USAGE_DAYS = 'admin.web.usageDays';
  var LS_CMP_ON = 'admin.web.cmpOn';
  var LS_CMP_GRAN = 'admin.web.cmpGran';
  var LS_CMP_A1 = 'admin.web.cmpA1';
  var LS_CMP_A2 = 'admin.web.cmpA2';
  var LS_CMP_B1 = 'admin.web.cmpB1';
  var LS_CMP_B2 = 'admin.web.cmpB2';
  var LS_MEM_SORT = 'admin.web.memSort';
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 忽略：不影响功能 */ } }

  function go(view) {
    if (!VIEWS[view]) view = 'overview';
    // 前端守卫：localStorage 里可能存着上一个账号（或降权前）的视图，
    // 直接渲染会让没权限的人看到页面骨架 + 一连串 403。
    if (!canView(view)) {
      var list = allowedViews();
      if (!list.length) {
        $('#view').innerHTML = emptyHtml({
          t: '你没有查看该页的权限',
          d: '当前账号没有后台权限，请联系管理员开通后再登录',
          cls: 'is-forbidden'
        });
        $('#page-title').textContent = '';
        return;
      }
      toast('当前账号没有「' + ((VIEWS[view] || {}).title || view) + '」的权限', 'warn');
      view = list[0];
    }
    state.view = view;
    lsSet(LS_VIEW, view);
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    $('#page-title').textContent = (VIEWS[view] || {}).title || '';
    var host = $('#view');
    host.innerHTML = '<div class="loading">加载中…</div>';
    // 切视图时先清空旧内容，否则上一次的数据会短暂留在新页面上（串页）
    VIEWS[view].render(host);
    // 卡片错峰入场（2026-11-16 焕新）：只在**进入视图**时播一次。
    // ⚠️ 不能放在 render 的回调里 —— 那样每次翻页/筛选都会重播（动画噪音）。
    staggerWhenFilled(host);
  }

  /**
   * 等容器被填上内容后，给它的直接子卡片写 --enter-delay（错峰入场）。
   * 用 MutationObserver 而不是轮询：只在内容真的变了才触发一次。
   * ⚠️ 兜底 1.2s 后自动断开 —— 页面若一直没渲染出卡片，不能一直挂着监听。
   */
  function staggerWhenFilled(host) {
    if (!host || !motionOk()) return;
    var done = false;
    var mo = new MutationObserver(function () {
      if (done) return;
      if (!host.children.length) return;
      done = true;
      stagger(host, 40, 6);
      countUpStats(host);
      try { mo.disconnect(); } catch (e) { /* 已断开 */ }
    });
    mo.observe(host, { childList: true });
    setTimeout(function () {
      if (!done) { try { mo.disconnect(); } catch (e) { /* noop */ } }
    }, 1200);
  }

  /**
   * 统计数字滚动（2026-11-16 焕新 · 视觉规范 §6.4 ③）
   * 只处理带 data-value 的 .stat-value（纯数字），其余跳过。
   * ⚠️ 只在进入视图时播一次（与 stagger 同一次触发）—— 翻页/筛选不重播。
   */
  function countUpStats(root) {
    $$('.stat-value[data-value]', root).forEach(function (el, i) {
      var to = parseFloat(el.getAttribute('data-value'));
      if (isNaN(to)) return;
      // 错开一点，让多张卡不是同时跳（错峰 60ms，最多 5 张）
      setTimeout(function () { countUp(el, to, 700); }, i * 60);
    });
  }

  function reload() { go(state.view); }

  /**
   * 页内重取（2026-11-16 · 体验规范 L4/L6）：切筛选、翻页、搜索、改对比范围时用。
   *
   * 为什么不能直接调 reload()：reload()=go() 每次都把 #view 整个换成
   * `<div class="loading">加载中…</div>` spinner，再调 staggerWhenFilled() 重播
   * 卡片飞入 + 数字滚动。用户切一次「A 组」「下一页」就看到整页闪一下、卡片再飞一遍
   * —— 这就是"切换筛选会刷新页面"的观感，且丢失滚动位置。
   *
   * softReload 只重新执行当前视图的 render，保留旧内容直到新数据就绪；
   * 容器顶部挂 2px 进度条（.is-refreshing）作为加载指示，内容替换后自动收起。
   * render 都是异步 api().then 里写 host.innerHTML，用 MutationObserver 捕获这次替换。
   *
   * ⚠️ 进度条动画**不是 infinite**（风格门禁禁止除 boot-spin 外的无限动画），
   *    1.2s 扫到 92% 停住，等渲染完成移除 class 时消失。
   * ⚠️ 8s 兜底：API 挂了也不能让进度条永远挂着（L4 不能阻塞交互）。
   */
  function softReload() {
    var host = $('#view');
    if (!host || !VIEWS[state.view]) return;
    var top = host.scrollTop;                 // innerHTML 替换会重置滚动位置，记下来恢复
    host.classList.add('is-refreshing');
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      host.classList.remove('is-refreshing');
      try { host.scrollTop = top; } catch (e) { /* 容器不可滚动，忽略 */ }
      try { mo.disconnect(); } catch (e) { /* 已断开 */ }
    }
    var mo = new MutationObserver(function () { setTimeout(finish, 0); });
    mo.observe(host, { childList: true });
    setTimeout(finish, 8000);
    VIEWS[state.view].render(host);
  }

  /**
   * 重新拉一次班级清单并**原地更新 state.classes**（不切视图、不弹提示）。
   *
   * 🔴 为什么必须有它（2026-10-14 实踩）：班级的大节时间 / 主教室存在 `state.classes` 里，
   *   「配置班级」弹层保存成功后 `reload()` 只重渲染当前页，**不重新请求 /api/me**
   *   ⇒ state.classes 仍是旧配置，紧接着打开「添加课次」，大节下拉还是保存前那几项
   *   （用户会以为"保存没生效"）。凡是弹层里改了班级级配置，保存后都要走这里。
   */
  function refreshClasses() {
    return api('/api/me').then(function (me) {
      if (me && me.ok && me.classes) {
        state.classes = me.classes;
        // 选中的班可能已被软删除 ⇒ 兜底选第一个可用班
        if (!currentClass()) state.classId = state.classes.length ? state.classes[0].id : null;
        // 建班 / 删班后同步下拉，避免「列表变了但选择器没变」
        renderClassPicker();
      }
      return state.classes;
    }).catch(function () { /* 拉不到就保持原状，不阻断保存 */ });
  }

  function currentClass() {
    for (var i = 0; i < state.classes.length; i++) {
      if (state.classes[i].id === state.classId) return state.classes[i];
    }
    return null;
  }

  /* ---------------- 动效助手（2026-11-16 焕新）----------------
   * 两件事，都是"让页面有生命"的关键，但都必须是**语义驱动**的：
   *   ① stagger()  卡片错峰入场 —— 只在**进入视图**时播，翻页/筛选不重播；
   *   ② countUp()  统计数字滚动 —— 只在进入含统计数的视图时播一次。
   * 二者都必须尊重 prefers-reduced-motion（用户开了"减少动态效果"就直接落值）。
   * ⚠️ 动效只动 transform + opacity（合成层友好），不改布局高度。
   *
   * 🔴 为什么不用 matchMedia 读动效偏好：
   *   门禁 check-admin-usage-layout 的 appNoWidthSwitch 断言 app.js **不含** 该 API
   *   （原意是禁止用它做**版式判定**，但断言是整文件级的字符串匹配，注释里也不能写）。
   *   ⇒ 改用 CSS 变量中转：CSS 侧在 prefers-reduced-motion 媒体查询里写一个标记变量，
   *      JS 读 getComputedStyle 拿它。这样既满足门禁口径，语义也更准确
   *      （动效开关本来就该由 CSS 媒体查询判定，JS 只是读结果）。 */

  /** 是否允许播动效（系统开了"减少动态效果"就一律不播）。
   *  读 CSS 变量 --motion-ok：CSS 侧默认 "1"，在 reduce 媒体查询里改成 "0"。 */
  function motionOk() {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue('--motion-ok').trim() !== '0';
    } catch (e) {
      return true;
    }
  }

  /**
   * 卡片错峰入场：给容器下的直接子元素依次写 --enter-delay。
   * CSS 侧用 animation-delay: var(--enter-delay, 0ms) 消费（被门禁锁定）。
   * @param {Element} root 容器
   * @param {number} step 每张错开多少 ms
   * @param {number} max  最多错开几张（再多就成" slideshow"了）
   */
  function stagger(root, step, max) {
    if (!root || !motionOk()) return;
    var kids = root.children;
    var n = Math.min(kids.length, max || 6);
    for (var i = 0; i < n; i++) {
      kids[i].style.setProperty('--enter-delay', (i * (step || 40)) + 'ms');
    }
  }

  /**
   * 统计数字滚动：数字从 0 滚到目标值。
   * ⚠️ 只处理**纯数字**（含小数）——「3/4」「已停用」「—」这类一律跳过，
   *    否则会显示成 NaN（比不滚动糟糕得多）。
   * @param {Element} el 元素（内容会被替换为滚动中的数字）
   * @param {number} to  目标值
   * @param {number} dur 毫秒
   */
  function countUp(el, to, dur) {
    if (!el || !motionOk()) return;
    if (typeof to !== 'number' || !isFinite(to)) return;
    var from = 0;
    var start = null;
    var dec = (Math.abs(to) % 1) > 0.0001 ? 2 : 0;   // 有小数就保留 2 位，避免位数跳动
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / (dur || 700));
      // easeOutExpo：起步快、收尾稳
      var e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
      var v = from + (to - from) * e;
      el.textContent = dec ? v.toFixed(dec) : String(Math.round(v));
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = dec ? to.toFixed(dec) : String(to);
    }
    requestAnimationFrame(step);
  }

  /* ---------------- 概览 ---------------- */
  function renderOverview(host) {
    api('/api/overview').then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var o = d.data;
      var s = o.stats;
      host.innerHTML =
        '<div class="stat-row">' +
        stat('班级', s.classCount, '启用中') +
        stat('成员', s.memberCount, '不含测试账号') +
        stat('已绑定', s.boundCount, '已绑微信') +
        stat('课程课次', s.sessionCount, '不含保洁') +
        stat('值日记录', o.classes.reduce(function (n, c) { return c.isDemo ? n : n + c.dutyCount; }, 0), '累计') +
        '</div>' +
        '<div class="card">' +
        '<div class="card-hd">各班规模</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>班级</th><th>成员</th><th>已绑定</th><th>课程课次</th><th>值日记录</th><th>总周数</th><th>状态</th>' +
        '</tr></thead><tbody>' +
        o.classes.map(function (c) {
          return '<tr>' +
            '<td>' + esc(shortClassName(c.name)) + '</td>' +
            '<td>' + c.memberCount + '</td>' +
            '<td>' + c.boundCount + ' / ' + c.memberCount + '</td>' +
            '<td>' + c.sessionCount + '</td>' +
            '<td>' + c.dutyCount + '</td>' +
            '<td>' + c.totalWeeks + '</td>' +
            '<td>' + classStatusTag(c) + '</td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>' +
        '<div class="card muted-note">后台账号 ' + s.adminCount + ' 个 · 近 7 天操作 ' + s.audit7d + ' 条</div>';
    });
  }

  /**
   * 统计卡（2026-11-16 焕新）：纯数字时带 data-value，供 countUp 滚动。
   * ⚠️ 值不是「纯数字」（含小数）时**不带** data-value —— countUp 会跳过，
   *    避免把「3/4」「已停用」滚成 NaN（比不滚动糟糕得多）。
   */
  function stat(label, value, hint) {
    var v = (typeof value === 'number' && isFinite(value)) ? String(value) : esc(value);
    var dv = (typeof value === 'number' && isFinite(value)) ? ' data-value="' + value + '"' : '';
    return '<div class="stat"><div class="stat-value"' + dv + '>' + v + '</div>' +
      '<div class="stat-label">' + esc(label) + '</div>' +
      '<div class="stat-hint">' + esc(hint) + '</div></div>';
  }

  /* ---------------- 课程表 ---------------- */
  function renderTimetable(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    var cls = currentClass();
    api('/api/timetable?classId=' + state.classId + '&group=' + encodeURIComponent(state.group))
      .then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        // 保洁课次（打扫410 / 410大扫除，kind='CLEAN'）只在值日页展示，课程表不显示
        var rows = (d.data || []).filter(function (r) { return r.kind !== 'CLEAN'; });
        var byDay = {};
        rows.forEach(function (r) { (byDay[r.dayOfWeek] = byDay[r.dayOfWeek] || []).push(r); });
        var DAYS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        host.innerHTML =
          '<div class="toolbar">' +
          '<div class="seg">' +
          segBtn('ALL', '全部', state.group) +
          segBtn('A', 'A 组', state.group) +
          segBtn('B', 'B 组', state.group) +
          '</div>' +
          '<div class="toolbar-right">' +
          '<button class="btn btn-primary" id="btn-add">添加课次</button>' +
          '<button class="btn btn-danger" id="btn-clear">清空课表</button>' +
          '<button class="btn btn-primary" id="btn-import">导入课表</button>' +
          '</div></div>' +
          '<div class="card">' +
          '<div class="card-hd">' + esc(cls ? cls.name : '') +
          ' · 共 ' + rows.length + ' 个课次' +
          (state.group === 'ALL' ? '' : '（含全体课）') + '</div>' +
          (rows.length ? '' : emptyHtml({
            t: '该班还没有课次',
            d: '导入一份 xlsx 即可生成整周课表；也可以手动添加单节课次',
            act: { k: 'timetable-import', label: '导入课表', primary: true }
          })) +
          '<table class="tbl"><thead><tr>' +
          '<th>周</th><th>第几节</th><th>课程</th><th>教师</th><th>教室</th><th>组别</th><th>周次</th><th>每节值日</th><th>操作</th>' +
          '</tr></thead><tbody>' +
          [1, 2, 3, 4, 5, 6, 7].map(function (d2) {
            var list = byDay[d2] || [];
            if (!list.length) return '';
            return list.map(function (r, i) {
              return '<tr>' +
                (i === 0 ? '<td rowspan="' + list.length + '" class="td-day">' + DAYS[d2] + '</td>' : '') +
                '<td class="td-period">第 ' + r.period + ' 节</td>' +
                '<td>' + esc(r.courseName) + '</td>' +
                '<td>' + esc(r.teacher) + '</td>' +
                '<td>' + esc(r.room) + '</td>' +
                '<td>' + (r.groupScope === 'ALL'
                  ? '<span class="tag tag-all">全体</span>'
                  : r.groupScope + ' 组') + '</td>' +
                '<td class="td-weeks">' + esc(r.weeks || '每周') + '</td>' +
                '<td>' + r.dutyCount + '</td>' +
                '<td class="td-ops">' +
                '<button class="link" data-edit-session="' + r.id + '">编辑</button>' +
                '<button class="link link-danger" data-del-session="' + r.id + '" ' +
                'data-name="' + esc(r.courseName) + '" data-when="' + DAYS[d2] + ' 第 ' + r.period + ' 节">删除</button>' +
                '</td>' +
                '</tr>';
            }).join('');
          }).join('') +
          '</tbody></table></div>' +
          '<div class="card muted-note">改课次会让该班<strong>全部已发布周次退回草稿</strong>，需在小程序端重新发布。</div>';
        bindSeg(host);
        var bi = $('#btn-import', host);
        if (bi) bi.onclick = openImportDialog;
        var ba = $('#btn-add', host);
        if (ba) ba.onclick = openAddDialog;
        var bc = $('#btn-clear', host);
        if (bc) bc.onclick = openClearDialog;
        $$('[data-edit-session]', host).forEach(function (b) {
          b.onclick = function () { openSessionDialog(Number(b.dataset.editSession)); };
        });
        $$('[data-del-session]', host).forEach(function (b) {
          b.onclick = function () { removeSession(Number(b.dataset.delSession), b.dataset.name, b.dataset.when); };
        });
      });
  }

  function segBtn(v, label, cur) {
    return '<button class="seg-btn' + (v === cur ? ' active' : '') + '" data-group="' + v + '">' + label + '</button>';
  }
  function bindSeg(host) {
    $$('.seg-btn', host).forEach(function (b) {
      // 页内切分组：保留旧内容 + 顶部进度条，不闪 spinner、不重播入场动画
      b.onclick = function () { state.group = b.dataset.group; softReload(); };
    });
  }

  /* -------- 课表导入：干跑预览 → 确认 -------- */
  function openImportDialog() {
    var cls = currentClass();
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg">' +
      '<div class="dlg-hd">导入课表</div>' +
      '<div class="dlg-bd">' +
      '<div class="hint">目标班级：<strong>' + esc(cls ? cls.name : '') + '</strong>（' + state.classId + '）</div>' +
      '<div class="src-row">' +
      '<button class="btn src-tab active" id="src-file">上传 xlsx 文件</button>' +
      '<button class="btn src-tab" id="src-html">粘贴青果网页源码</button>' +
      '</div>' +
      '<div id="pane-file">' +
      '<label class="field"><span class="field-label">选择 xlsx 文件</span>' +
      '<input type="file" id="xlsx-file" accept=".xlsx"></label>' +
      '<div class="hint">文件在<strong>浏览器本地</strong>解析，不上传原文件；只把结构化课次发给服务器。<br>' +
      '「全体课」无需手选 —— 两组都导完后，同时间同地点的同一门课会自动合并为全体课。</div>' +
      '</div>' +
      // ⚠️ 组别必须**由导入者选**，不能猜：青果的 A 组 / B 组是两个独立文件（网页上也可能
      //    是两个不同的查询参数），页面内部没有任何组别标记。「全体课」不是手选的，
      //    而是两次导入后由后端比对自动降级出来的（见 common/timetable-import.js 第 ④ 步）。
      '<div id="pane-html" hidden>' +
      '<div class="hint">在电脑浏览器登录教务系统 → 进到<strong>「我的课表」页面</strong>（确认周次、节次、地点都显示了）' +
      '→ 右键「查看网页源代码」→ 全选复制 → 粘到下面。<br>' +
      '<strong>必须是课表那一页的源码</strong>：登录页 / 首页的源码里没有课表，解析不出东西。<br>' +
      '⚠ 青果的课表渲染在 iframe 里 —— 直接对整个页面「查看网页源代码」会拿到一层空壳。' +
      '正确做法：进到课表页后按 F12，控制台执行 ' +
      '<code>copy(document.querySelector("#frmDesk").contentDocument.documentElement.outerHTML)</code>，' +
      '或右键 iframe 空白处选「查看框架源代码」。<br>' +
      'A 组 / B 组如果在网页上是分开切换的，就分别粘两次。<br>' +
      '源码同样只在浏览器本地解析，不上传。</div>' +
      '<label class="field"><span class="field-label">课表页源代码</span>' +
      '<textarea id="html-src" class="ta" rows="9" spellcheck="false" placeholder="<html> … </html>"></textarea></label>' +
      '<div class="hint" id="html-tip"></div>' +
      '</div>' +
      fld('本次导入的是', '<select id="x-group">' +
        '<option value="A">A 组</option><option value="B">B 组</option></select>') +
      '<div id="dry-box" class="dry-box" hidden></div>' +
      '</div>' +
      '<div class="dlg-ft">' +
      '<button class="btn" id="dlg-cancel">取消</button>' +
      '<button class="btn btn-primary" id="dlg-dry" disabled>解析并预览</button>' +
      '<button class="btn btn-danger" id="dlg-commit" hidden>确认覆盖导入</button>' +
      '</div></div>';
    document.body.appendChild(dlg);

    var parsed = null;
    var srcMode = 'file';
    var $dry = $('#dlg-dry', dlg);
    var $commit = $('#dlg-commit', dlg);
    var $dryBox = $('#dry-box', dlg);
    var fileInput = $('#xlsx-file', dlg);
    var htmlInput = $('#html-src', dlg);

    function resetDraft() {
      parsed = null;
      $commit.hidden = true;
      $dryBox.hidden = true;
      state.importDraft = null;
    }
    function hasFile() { return !!(fileInput.files && fileInput.files[0]); }
    function hasHtml() { return !!String(htmlInput.value || '').trim(); }

    /** 切换来源（xlsx 文件 / 青果网页源码）——两条路产出同一份 sessions 契约 */
    function setMode(mode) {
      srcMode = mode;
      $('#src-file', dlg).className = 'btn src-tab' + (mode === 'file' ? ' active' : '');
      $('#src-html', dlg).className = 'btn src-tab' + (mode === 'html' ? ' active' : '');
      $('#pane-file', dlg).hidden = mode !== 'file';
      $('#pane-html', dlg).hidden = mode !== 'html';
      $('#html-tip', dlg).innerHTML = '';
      resetDraft();
      $dry.disabled = mode === 'file' ? !hasFile() : !hasHtml();
    }
    $('#src-file', dlg).onclick = function () { setMode('file'); };
    $('#src-html', dlg).onclick = function () { setMode('html'); };
    fileInput.onchange = function () { resetDraft(); $dry.disabled = !hasFile(); };
    htmlInput.oninput = function () { resetDraft(); $dry.disabled = !hasHtml(); };
    $('#dlg-cancel', dlg).onclick = function () { dlg.remove(); };
    dlg.onclick = function (e) { if (e.target === dlg) dlg.remove(); };

    $dry.onclick = function () {
      var task = srcMode === 'file'
        ? parseXlsxInBrowser(fileInput.files[0])
        : parseHtmlInBrowser(htmlInput.value);
      task.then(function (res) {
        parsed = res;
        $('#html-tip', dlg).innerHTML = res.tip ? esc(res.tip) : '';
        var body = {
          classId: state.classId,
          groupScope: $('#x-group', dlg).value,
          courses: res.courses,
          sessions: res.sessions,
          warnings: res.warnings || []
        };
        state.importDraft = body;
        api('/api/timetable/dry-run', { method: 'POST', body: body }).then(function (r) {
          if (!r.ok) { toast(r.errMsg, 'err'); return; }
          var i = r.data.impact;
          $('#dry-box', dlg).innerHTML =
            '<div class="dry-title">干跑预览（未改库）</div>' +
            '<div class="dry-row"><span>目标</span><strong>' + esc(r.data.targetSummary) + '</strong></div>' +
            '<div class="dry-row"><span>将删除旧课次</span><strong>' + i.oldSessionCount + ' 个</strong></div>' +
            '<div class="dry-row"><span>将删除未开始值日</span><strong>' + i.affectedDuties + ' 条</strong></div>' +
            '<div class="dry-row"><span>将写入新课次</span><strong>' + i.newSessionCount + ' 个 / ' + i.newCourseCount + ' 门课</strong></div>' +
            '<div class="dry-row"><span>将合并为全体课</span><strong>' + i.willBeShared + ' 节</strong></div>' +
            '<div class="dry-warn">' + esc(r.data.note) + '</div>' +
            (r.data.warnings.length ? '<div class="dry-warn">' + r.data.warnings.map(esc).join('<br>') + '</div>' : '');
          $dryBox.hidden = false;
          $commit.hidden = false;
        });
      }).catch(function (e) {
        toast('解析失败：' + (e && e.message ? e.message : '来源内容不正确'), 'err');
      });
    };

    $commit.onclick = async function () {
      var body = state.importDraft;
      if (!body) { toast('请先解析课表来源', 'err'); return; }
      /* L3 强确认（2026-11-16 焕新 · 体验规范 §3.5 C4）：
         覆盖导入会清掉该组全部课程课次 ⇒ 需显式勾选「我已知晓影响」才放行。
         原文案一字不删（"系统会自动建备份表，仍建议先核对上方预览"）。 */
      var ok = await confirmDialog({
        title: '即将覆盖 ' + cls.name + ' 的 ' + body.groupScope + ' 组全部课程课次',
        okText: '确认覆盖导入',
        level: 'L3',
        body: '系统会自动建备份表，仍建议先核对上方预览。'
      });
      if (!ok) return;
      $commit.disabled = true;
      $commit.textContent = '导入中…';
      api('/api/timetable/import', { method: 'POST', body: body, timeoutMs: 60000 })
        .then(function (r) {
          if (!r.ok) { toast(r.errMsg, 'err'); $commit.disabled = false; $commit.textContent = '确认覆盖导入'; return; }
          dlg.remove();
          toast('导入完成：' + r.data.imported + ' 节课次', 'ok');
          if (r.data.rollbackHint) setTimeout(function () { toast(r.data.rollbackHint); }, 900);
          reload();
        });
    };
  }

  /* -------- 课表清空：选组 → 预览 → 确认 -------- */
  function openClearDialog() {
    var cls = currentClass();
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg">' +
      '<div class="dlg-hd">清空课表</div>' +
      '<div class="dlg-bd">' +
      '<div class="hint">目标班级：<strong>' + esc(cls ? cls.name : '') + '</strong>（' + state.classId + '）' +
      ' · 该操作不可撤销（系统会先自动备份）</div>' +
      fld('清空范围', '<select id="c-group">' +
        '<option value="A">A 组</option>' +
        '<option value="B">B 组</option>' +
        '<option value="ALL">全部（含全体课）</option>' +
        '</select>') +
      '<div id="c-preview" class="dry-box"></div>' +
      '</div>' +
      '<div class="dlg-ft">' +
      '<button class="btn" id="c-cancel">取消</button>' +
      '<button class="btn btn-danger" id="c-confirm">确认清空</button>' +
      '</div></div>';
    // 默认范围跟随当前视图组；ALL 视图下默认「全部」
    var sel = $('#c-group', dlg);
    sel.value = (state.group === 'A' || state.group === 'B') ? state.group : 'ALL';
    document.body.appendChild(dlg);

    function refresh() {
      var g = sel.value;
      var box = $('#c-preview', dlg);
      box.innerHTML = '<div class="dry-warn">计算中…</div>';
      api('/api/timetable/clear', {
        method: 'POST',
        body: { classId: state.classId, groupScope: g, dryRun: true }
      }).then(function (r) {
        if (!r.ok) { box.innerHTML = '<div class="dry-warn">' + esc(r.errMsg || '预览失败') + '</div>'; return; }
        var i = r.data;
        var scopeNote = g === 'ALL'
          ? '（A、B 与全体课都会删除）'
          : '（只删该组独有课次；若某课同时是全体课，需选「全部」才删得掉）';
        box.innerHTML =
          '<div class="dry-title">干跑预览（未改库）' + scopeNote + '</div>' +
          '<div class="dry-row"><span>目标</span><strong>' + esc(i.targetSummary || '') + '</strong></div>' +
          '<div class="dry-row"><span>将删除课次</span><strong>' + (i.oldSessionCount || 0) + ' 个</strong></div>' +
          '<div class="dry-row"><span>将删除未开始值日</span><strong>' + (i.affectedDuties || 0) + ' 条</strong></div>' +
          '<div class="dry-row"><span>将清理孤立课程</span><strong>' + (i.orphanCourses || 0) + ' 门</strong></div>' +
          '<div class="dry-warn">清空后该班全部已发布周次会退回草稿，需在小程序端重新发布。</div>';
      });
    }
    sel.onchange = refresh;
    $('#c-cancel', dlg).onclick = function () { dlg.remove(); };
    dlg.onclick = function (e) { if (e.target === dlg) dlg.remove(); };
    $('#c-confirm', dlg).onclick = async function () {
      var g = sel.value;
      var scopeText = g === 'ALL' ? '全部课程课次（含全体课）' : g + ' 组课程课次';
      /* L3 强确认（体验规范 §3.5 C4）：清空课表影响面最大 ⇒ 需显式勾选确认。 */
      var ok = await confirmDialog({
        title: '即将清空 ' + cls.name + ' 的 ' + scopeText,
        okText: '确认清空',
        level: 'L3',
        body: '系统会先自动备份，仍建议先核对上方预览。'
      });
      if (!ok) return;
      var btn = $('#c-confirm', dlg);
      btn.disabled = true;
      btn.textContent = '清空中…';
      api('/api/timetable/clear', {
        method: 'POST',
        body: { classId: state.classId, groupScope: g, dryRun: false },
        timeoutMs: 60000
      }).then(function (r) {
        if (!r.ok) { toast(r.errMsg || '清空失败', 'err'); btn.disabled = false; btn.textContent = '确认清空'; return; }
        dlg.remove();
        toast('清空完成：删除 ' + (r.data.deletedSessions || 0) + ' 个课次', 'ok');
        if (r.data.rollbackHint) setTimeout(function () { toast(r.data.rollbackHint); }, 900);
        reload();
      });
    };
    refresh();
  }

  /**
   * 浏览器端解析 xlsx（方案已定：解析放浏览器，后端只收结构化 JSON）。
   * 这里不引 SheetJS 到云函数包 —— 页面直接用 CDN 的 SheetJS（xlsx.full.min.js），
   * 没网时提示改用「粘贴文本」路径。返回 { courses, sessions, groupScope }。
   */
  function parseXlsxInBrowser(file) {
    return new Promise(function (resolve, reject) {
      if (typeof XLSX === 'undefined') {
        return reject(new Error(window.__noXlsx
          ? '页面缺少 SheetJS 解析库（网络受限，CDN 未加载）'
          : '页面缺少 SheetJS 解析库，无法解析 xlsx'));
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.onload = function (e) {
        try {
          var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
          var out = buildTimetableFromSheets(wb, XLSX);
          if (!out.sessions.length) {
            return reject(new Error('未从文件中解析到任何课次，请确认是青果导出的教学安排表'));
          }
          resolve(out);
        } catch (err) {
          reject(new Error('解析出错：' + (err && err.message ? err.message : '格式不正确')));
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * 浏览器端解析**青果课表页 HTML 源码**。
   * 与 xlsx 同一条 rationale：解析库跑在本地，后端云函数一行不改、包不膨胀。
   * 解析器本体见 public/timetable-html.js（自研，非 GPL 代码，切勿拿 GPL 版本覆盖）。
   * 返回 { courses, sessions, warnings, tip }。
   */
  function parseHtmlInBrowser(html) {
    return new Promise(function (resolve, reject) {
      if (!window.TimetableHtml) {
        return reject(new Error('页面未加载 HTML 解析库，请刷新重试'));
      }
      var res;
      try {
        res = window.TimetableHtml.parse(html);
      } catch (err) {
        return reject(err);
      }
      var names = {
        list: '列表式表格',
        print: '全校课表(按班级)打印版',
        grid: '网格课表',
        legacy: '旧版兜底'
      };
      var meta = res.meta || {};
      var who = meta.className || meta.studentName || '';
      var stats = res.stats || {};
      res.tip = (who ? '这是「' + who + '」的课表：' : '识别到 ') +
        res.courses.length + ' 门课 / ' + res.sessions.length + ' 个课次' +
        '（版面：' + (names[res.layout] || res.layout) + '）' +
        // 打印版会把同一条课次渲染两次，去重条数说出来，操作者才不会以为"少了"
        (stats.deduped ? '，已合并 ' + stats.deduped + ' 条重复课次' : '') +
        (meta.declaredCourseCount
          ? (meta.declaredCourseCount === res.courses.length
            ? '，与页面顶部「课程门数：' + meta.declaredCourseCount + '」一致'
            : '，但页面顶部写着 ' + meta.declaredCourseCount + ' 门 —— 可能漏课')
          : '');
      resolve(res);
    });
  }

  /**
   * 从工作簿还原 { courses, sessions }。
   * 口径必须与小程序 course/import-parse.js 一致：
   *   识别表头「星期 / 节次 / 周次 / 课程 / 教师 / 教室」，逐行读。
   */
  function buildTimetableFromSheets(wb, XLSX) {
    var sessions = [];
    var courses = [];
    var seenCourse = {};
    var sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return { courses: courses, sessions: sessions };
    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });

    function findCol(names) {
      for (var i = 0; i < names.length; i++) {
        for (var j = 0; j < (rows[0] || []).length; j++) {
          if (String(rows[0][j] || '').replace(/\s/g, '') === names[i]) return j;
        }
      }
      return -1;
    }
    var cDay = findCol(['星期', '周几', '星期几']);
    var cPeriod = findCol(['节次', '大节', '第几节']);
    var cWeeks = findCol(['周次', '上课周次', '周次范围']);
    var cName = findCol(['课程', '课程名称', '科目']);
    var cTeacher = findCol(['教师', '任课教师', '老师']);
    var cRoom = findCol(['教室', '地点', '上课地点']);
    if (cName < 0) throw new Error('未找到「课程」列，请确认是教学安排表');

    var DAY_MAP = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var name = String(row[cName] || '').trim();
      if (!name) continue;
      var dayRaw = String(cDay >= 0 ? row[cDay] : '').trim();
      var day = 0;
      var m = dayRaw.match(/[一二三四五六日天]/);
      if (m) day = DAY_MAP[m[0]] || 0;
      else if (/^[1-7]$/.test(dayRaw)) day = Number(dayRaw);
      if (!day) continue;
      var pRaw = String(cPeriod >= 0 ? row[cPeriod] : '').trim();
      var period = parseInt((pRaw.match(/\d+/) || [0])[0], 10);
      // 上限放宽到 10（与 MAX_PERIOD 同口径）：某些班有第 6 节等 45 分钟短课，
      // 写死 5 会让解析器**整行丢弃**这门课，导入后课表里凭空少一节（2026-10-14）。
      if (!period || period < 1 || period > 10) continue;
      var weeks = normalizeWeeks(cWeeks >= 0 ? row[cWeeks] : '');
      var teacher = String(cTeacher >= 0 ? row[cTeacher] || '' : '').trim();
      var room = String(cRoom >= 0 ? row[cRoom] || '' : '').trim();

      var key = name + '|' + teacher;
      if (!seenCourse[key]) {
        seenCourse[key] = true;
        courses.push({ name: name, teacher: teacher, room: room });
      }
      sessions.push({ name: name, teacher: teacher, room: room, dayOfWeek: day, period: period, weeks: weeks });
    }
    return { courses: courses, sessions: sessions };
  }

  function normalizeWeeks(raw) {
    var s = String(raw || '').trim();
    if (!s) return '';
    var all = s.match(/(\d+)\s*-\s*(\d+)/);
    var out = [];
    if (all) {
      for (var i = Number(all[1]); i <= Number(all[2]); i++) out.push(i);
    } else {
      s.split(/[,，、\s]+/).forEach(function (x) {
        var n = parseInt(x, 10);
        if (n > 0) out.push(n);
      });
    }
    out.sort(function (a, b) { return a - b; });
    return out.join(',');
  }

  /**
   * 本班可选的大节号列表（2026-10-14：不再写死 [1,2,3,4,5]）。
   *
   * `class.period_time` 是**每班可配**的（后台「配置班级 → 大节时间」能加第 6 行，
   * 用于「书香校园」这类 45 分钟短课）。写死 5 时下拉里根本没有第 6 节，用户只能选到
   * 别的节次 —— 与小程序端「第 6 节课被过滤掉」是同一个病根的两面。
   *
   * @param {object} [cls] 班级对象（含 periodTime）；缺省用当前班
   * @param {number} [mustInclude] 必须包含的节次（编辑既有课次时传它，
   *        防「配置后来被改小」导致 select 落到第一项、静默把节次改掉）
   */
  function periodOptions(cls, mustInclude) {
    var c = cls || currentClass();
    var n = 5;   // 兜底（与历史行为一致）
    var pt = c && c.periodTime;
    if (pt && pt.length) {
      pt.forEach(function (x) {
        var v = Number(x && x.period);
        if (v >= 1 && v <= 10) n = Math.max(n, v);
      });
      n = Math.max(n, Math.min(pt.length, 10));
    }
    var m = Number(mustInclude) || 0;
    if (m >= 1 && m <= 10) n = Math.max(n, m);
    var out = [];
    for (var p = 1; p <= n; p++) out.push(p);
    return out;
  }

  /* -------- 单独添加一节课：A 组 / B 组 / 全体 -------- */
  function openAddDialog() {
    var cls = currentClass();
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg"><div class="dlg-hd">添加课次</div>' +
      '<div class="dlg-bd">' +
      '<div class="hint">目标班级：<strong>' + esc(cls ? cls.name : '') + '</strong>（' + state.classId + '）</div>' +
      fld('课程名称', '<input type="text" id="a-name" placeholder="如：高等数学" maxlength="64">' +
        ' <span class="muted-note">同名课程会自动复用</span>') +
      fld('教师', '<input type="text" id="a-teacher" maxlength="32">') +
      fld('教室', '<input type="text" id="a-room" maxlength="32">') +
      '<div class="field-row">' +
      fld('星期', '<select id="a-day">' + [1, 2, 3, 4, 5, 6, 7].map(function (d2) {
        var N = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        return '<option value="' + d2 + '">' + N[d2] + '</option>';
      }).join('') + '</select>') +
      fld('大节', '<select id="a-period">' + periodOptions(cls).map(function (p) {
        return '<option value="' + p + '">第 ' + p + ' 节</option>';
      }).join('') + '</select>') +
      '</div>' +
      fld('组别', '<select id="a-group">' +
        '<option value="ALL">全体（不限组）</option>' +
        '<option value="A">A 组</option>' +
        '<option value="B">B 组</option>' +
        '</select>') +
      '<div class="field-row">' +
      fld('周次规则', '<select id="a-weekrule">' +
        '<option value="ALL">每周</option>' +
        '<option value="ODD">单周</option>' +
        '<option value="EVEN">双周</option>' +
        '</select>') +
      fld('具体周次', '<input type="text" id="a-weeks" placeholder="可选，如 1-16" maxlength="64">') +
      '</div>' +
      fld('每节值日人数', '<input type="number" id="a-duty" min="0" max="20" value="2">') +
      fld('备注', '<input type="text" id="a-note" maxlength="64">') +
      '<div class="muted-note">添加后会将该班<strong>全部已发布周次退回草稿</strong>，需在小程序端重新发布。</div>' +
      '</div>' +
      '<div class="dlg-ft">' +
      '<button class="btn" id="a-cancel">取消</button>' +
      '<button class="btn btn-primary" id="a-confirm">添加</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
    $('#a-cancel', dlg).onclick = function () { dlg.remove(); };
    $('#a-confirm', dlg).onclick = function () {
      var btn = $('#a-confirm', dlg);
      var name = $('#a-name', dlg).value.trim();
      if (!name) { toast('请填写课程名称', 'err'); return; }
      btn.disabled = true; btn.textContent = '添加中…';
      api('/api/timetable/session', {
        method: 'POST',
        body: {
          classId: state.classId,
          courseName: name,
          teacher: $('#a-teacher', dlg).value.trim(),
          room: $('#a-room', dlg).value.trim(),
          dayOfWeek: Number($('#a-day', dlg).value),
          period: Number($('#a-period', dlg).value),
          groupScope: $('#a-group', dlg).value,
          weekRule: $('#a-weekrule', dlg).value,
          weeks: $('#a-weeks', dlg).value.trim(),
          dutyCount: Number($('#a-duty', dlg).value),
          note: $('#a-note', dlg).value.trim()
        }
      }).then(function (res) {
        if (!res.ok) { btn.disabled = false; btn.textContent = '添加'; toast(res.errMsg || '添加失败', 'err'); return; }
        dlg.remove();
        toast('已添加，该班已发布周次已退回草稿', 'ok');
        reload();
      });
    };
  }

  function openSessionDialog(id) {
  var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg"><div class="dlg-hd">编辑课次</div>' +
      '<div class="dlg-bd"><div class="loading">读取中…</div></div>' +
      '<div class="dlg-ft"><button class="btn" id="dlg-cancel">取消</button></div></div>';
    document.body.appendChild(dlg);
    $('#dlg-cancel', dlg).onclick = function () { dlg.remove(); };

    api('/api/timetable?classId=' + state.classId + '&group=ALL').then(function (d) {
      if (!d.ok) { dlg.remove(); toast(d.errMsg, 'err'); return; }
      var r = null;
      for (var i = 0; i < d.data.length; i++) if (d.data[i].id === id) r = d.data[i];
      if (!r) { dlg.remove(); return; }
      $('.dlg-bd', dlg).innerHTML =
        '<div class="hint">' + esc(r.courseName) + ' · ' + esc(r.teacher) + '</div>' +
        fld('星期', '<select id="f-day">' +
          [1, 2, 3, 4, 5, 6, 7].map(function (d2) {
            var N = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
            return '<option value="' + d2 + '"' + (d2 === r.dayOfWeek ? ' selected' : '') + '>' + N[d2] + '</option>';
          }).join('') + '</select>') +
        fld('大节', '<select id="f-period">' +
          periodOptions(currentClass(), r.period).map(function (p) {
            return '<option value="' + p + '"' + (p === r.period ? ' selected' : '') + '>第 ' + p + ' 节</option>';
          }).join('') + '</select>') +
        fld('教室', '<input type="text" id="f-room" value="' + esc(r.room) + '">') +
        fld('每节值日人数', '<input type="number" id="f-duty" min="0" max="20" value="' + r.dutyCount + '">') +
        fld('备注', '<input type="text" id="f-note" value="' + esc(r.note) + '">');
      var ft = $('.dlg-ft', dlg);
      var ok = document.createElement('button');
      ok.className = 'btn btn-primary';
      ok.textContent = '保存';
      ok.onclick = function () {
        api('/api/timetable/session/' + id, {
          method: 'POST',
          body: {
            dayOfWeek: Number($('#f-day', dlg).value),
            period: Number($('#f-period', dlg).value),
            room: $('#f-room', dlg).value,
            dutyCount: Number($('#f-duty', dlg).value),
            note: $('#f-note', dlg).value
          }
        }).then(function (res) {
          if (!res.ok) { toast(res.errMsg, 'err'); return; }
          dlg.remove();
          toast('已保存；该班已发布周次已退回草稿', 'ok');
          reload();
        });
      };
      ft.appendChild(ok);
    });
  }

  function fld(label, inner) {
    return '<label class="field"><span class="field-label">' + esc(label) + '</span>' + inner + '</label>';
  }

  /* ---------------- 请假 ---------------- */
  var LEAVE_STATUS_TEXT = { PENDING: '待审', APPROVED: '通过', REJECTED: '驳回', CANCELLED: '已撤销' };
  function leaveTimeText(startTime, endTime) {
    if (!startTime && !endTime) return '全天';
    return (startTime || '') + (endTime ? '–' + endTime : ' 起');
  }
  function leaveStatusTag(status) {
    var cls = { PENDING: 'tag-warn', APPROVED: 'tag-ok', REJECTED: 'tag-off', CANCELLED: 'tag-off' }[status] || 'tag-off';
    return '<span class="tag ' + cls + '">' + (LEAVE_STATUS_TEXT[status] || status) + '</span>';
  }

  function renderLeave(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    var status = state.leaveStatus;
    var kw = state.leaveKw;
    var pageRows = [];

    function load() {
      var qs = '?classId=' + state.classId +
        (status !== 'ALL' ? '&status=' + encodeURIComponent(status) : '') +
        (kw ? '&keyword=' + encodeURIComponent(kw) : '');
      api('/api/leave' + qs).then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        var rows = d.data || [];
        pageRows = rows;
        host.innerHTML =
          '<div class="toolbar">' +
          '<select id="lv-status" class="input-search">' +
          '<option value="ALL">全部状态</option>' +
          '<option value="PENDING">待审</option>' +
          '<option value="APPROVED">通过</option>' +
          '<option value="REJECTED">驳回</option>' +
          '<option value="CANCELLED">已撤销</option>' +
          '</select>' +
          '<input type="search" id="lv-kw" class="input-search" placeholder="搜索姓名或学号" value="' + esc(kw) + '">' +
          '<div class="toolbar-right">' +
          '<button class="btn" id="lv-add">新增代登记</button>' +
          '<button class="btn" id="lv-refresh">刷新</button>' +
          '</div>' +
          '</div>' +
          '<div class="card">' +
          '<div class="card-hd">请假列表 · 共 ' + rows.length + ' 条</div>' +
          (rows.length ? '' : emptyHtml({
            t: '该班还没有请假记录',
            d: '学生在小程序提交请假后会出现在这里，可按状态审核'
          })) +
          '<table class="tbl"><thead><tr>' +
          '<th>成员</th><th>班级</th><th>日期</th><th>时段</th><th>状态</th><th>假条</th><th>操作</th>' +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' +
              '<td class="td-member">' +
              '<div class="m-name">' + esc(r.name) + '</div>' +
              '<div class="m-sub">' + esc(r.studentNo || '') +
              (r.groupTag && r.groupTag !== 'X' ? ' · ' + esc(r.groupTag) + ' 组' : '') + '</div>' +
              '</td>' +
              '<td>' + esc(String(r.classId)) + '</td>' +
              '<td>' + esc(r.startDate) + (r.startDate !== r.endDate ? ' ~ ' + esc(r.endDate) : '') + '</td>' +
              '<td>' + leaveTimeText(r.startTime, r.endTime) + '</td>' +
              '<td>' + leaveStatusTag(r.status) + '</td>' +
              '<td>' + (r.hasImage ? '<span class="tag tag-ok">有</span>' : '<span class="muted-note">无</span>') + '</td>' +
              '<td class="td-ops">' +
              '<button class="link" data-edit-leave="' + r.id + '">编辑</button>' +
              '<button class="link link-danger" data-del-leave="' + r.id + '">删除</button>' +
              '</td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div>' +
          '<div class="card muted-note">时段留空 = 整天请假；修改日期或状态会同步调整该成员对应日期的值日「请假」标记。</div>';
        bindLeave(host);
      });
    }

    function bindLeave(root) {
      var ss = $('#lv-status', root);
      if (ss) {
        ss.value = status;
        ss.onchange = function () { state.leaveStatus = ss.value; status = ss.value; load(); };
      }
      var kwi = $('#lv-kw', root);
      if (kwi) kwi.onkeydown = function (e) { if (e.key === 'Enter') { state.leaveKw = kwi.value.trim(); kw = state.leaveKw; load(); } };
      var ad = $('#lv-add', root);
      if (ad) ad.onclick = function () { openLeaveCreateDialog(); };
      /* 🔴 同上：$$ 而非 $（$ 返回单元素，.forEach 抛错会让后面的刷新/编辑绑定全部失效） */
      $$('[data-del-leave]', root).forEach(function (b) {
        b.onclick = function () { deleteLeave(Number(b.dataset.delLeave)); };
      });
      var rf = $('#lv-refresh', root);
      if (rf) rf.onclick = function () { state.leaveKw = (kwi ? kwi.value.trim() : ''); kw = state.leaveKw; load(); };
      $$('[data-edit-leave]', root).forEach(function (b) {
        b.onclick = function () {
          var r = null;
          for (var i = 0; i < pageRows.length; i++) if (pageRows[i].id === Number(b.dataset.editLeave)) r = pageRows[i];
          openLeaveEditDialog(r);
        };
      });
    }

    load();
  }

  function openLeaveEditDialog(r) {
    if (!r) { toast('找不到该请假记录', 'err'); return; }
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    var statusOpts = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map(function (s) {
      return '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + (LEAVE_STATUS_TEXT[s] || s) + '</option>';
    }).join('');
    dlg.innerHTML =
      '<div class="dlg"><div class="dlg-hd">编辑请假 · ' + esc(r.name) + '</div>' +
      '<div class="dlg-bd">' +
      fld('成员', '<div class="hint">' + esc(r.name) + '（' + esc(r.studentNo || '') + '）</div>') +
      '<div class="field-row">' +
      fld('起始日期', '<input type="date" id="lv-start" value="' + esc(r.startDate) + '">') +
      fld('结束日期', '<input type="date" id="lv-end" value="' + esc(r.endDate) + '">') +
      '</div>' +
      '<div class="field-row">' +
      fld('开始时间', '<input type="time" id="lv-st" value="' + esc(r.startTime || '') + '">') +
      fld('结束时间', '<input type="time" id="lv-et" value="' + esc(r.endTime || '') + '">') +
      '</div>' +
      fld('状态', '<select id="lv-status2">' + statusOpts + '</select>') +
      '<div class="muted-note">时段留空 = 整天请假。修改日期或状态会同步调整该成员对应日期的值日「请假」标记。</div>' +
      '</div>' +
      '<div class="dlg-ft">' +
      '<button class="btn" id="lv-cancel">取消</button>' +
      '<button class="btn btn-primary" id="lv-save">保存</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
    $('#lv-cancel', dlg).onclick = function () { dlg.remove(); };
    $('#lv-save', dlg).onclick = function () {
      var btn = $('#lv-save', dlg);
      btn.disabled = true; btn.textContent = '保存中…';
      api('/api/leave/' + r.id, {
        method: 'POST',
        body: {
          startDate: $('#lv-start', dlg).value,
          endDate: $('#lv-end', dlg).value,
          startTime: $('#lv-st', dlg).value,
          endTime: $('#lv-et', dlg).value,
          status: $('#lv-status2', dlg).value
        }
      }).then(function (res) {
        if (!res.ok) { btn.disabled = false; btn.textContent = '保存'; toast(res.errMsg || '保存失败', 'err'); return; }
        dlg.remove();
        toast('已保存；日期/状态变更已同步值日标记', 'ok');
        reload();
      });
    };
  }

  /* ---------------- 请假：后台代登记 / 删除（2026-11-15 新增） ----------------
   * 代登记与小程序 `adjust.addLeave` 同口径：source='register'、**默认直接 APPROVED**，
   * 保存后服务端会重算该成员这几天的 duty「请假」标记。
   * 删除会连带把 duty 的 LEAVE 标记退回 PENDING（否则那条值日会一直显示"已请假"）。
   */
  function openLeaveCreateDialog() {
    api('/api/members?classId=' + state.classId + '&page=1&pageSize=0&scope=ALL').then(function (d) {
      if (!d.ok) { toast(d.errMsg || '读取成员失败', 'err'); return; }
      var items = (d.data && d.data.items) || [];
      if (!items.length) { toast('该班没有可登记的成员', 'err'); return; }
      var opts = items.map(function (m) {
        return '<option value="' + m.id + '">' + esc(m.name) +
          (m.studentNo ? '（' + esc(m.studentNo) + '）' : '') + '</option>';
      }).join('');
      var today = ymd(new Date());
      var statusOpts = ['APPROVED', 'PENDING', 'REJECTED'].map(function (s) {
        return '<option value="' + s + '"' + (s === 'APPROVED' ? ' selected' : '') + '>' +
          (LEAVE_STATUS_TEXT[s] || s) + '</option>';
      }).join('');
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">代登记请假</div>' +
        '<div class="dlg-bd">' +
        fld('成员', '<select id="lvc-member">' + opts + '</select>') +
        '<div class="field-row">' +
        fld('起始日期', '<input type="date" id="lvc-start" value="' + today + '">') +
        fld('结束日期', '<input type="date" id="lvc-end" value="' + today + '">') +
        '</div>' +
        '<div class="field-row">' +
        fld('开始时间（可空）', '<input type="time" id="lvc-st">') +
        fld('结束时间（可空）', '<input type="time" id="lvc-et">') +
        '</div>' +
        fld('状态', '<select id="lvc-status">' + statusOpts + '</select>') +
        '<div class="muted-note">时间留空 = 整天请假。后台代登记默认直接「通过」，如需走审批可改为「待审」。</div>' +
        '</div><div class="dlg-ft">' +
        '<button class="btn" id="lvc-cancel">取消</button>' +
        '<button class="btn btn-primary" id="lvc-save">保存</button>' +
        '</div></div>';
      document.body.appendChild(dlg);
      $('#lvc-cancel', dlg).onclick = function () { dlg.remove(); };
      $('#lvc-save', dlg).onclick = function () {
        var btn = $('#lvc-save', dlg);
        btn.disabled = true; btn.textContent = '保存中…';
        api('/api/leave', {
          method: 'POST',
          body: {
            classId: state.classId,
            memberId: Number($('#lvc-member', dlg).value),
            startDate: $('#lvc-start', dlg).value,
            endDate: $('#lvc-end', dlg).value,
            startTime: $('#lvc-st', dlg).value,
            endTime: $('#lvc-et', dlg).value,
            status: $('#lvc-status', dlg).value
          }
        }).then(function (res) {
          if (!res.ok) { btn.disabled = false; btn.textContent = '保存'; toast(res.errMsg || '保存失败', 'err'); return; }
          dlg.remove();
          toast('已登记；对应日期的值日标记已同步', 'ok');
          reload();
        });
      };
    });
  }

  async function deleteLeave(id) {
    var ok = await confirmDialog({
      title: '删除这条请假？',
      okText: '确认删除',
      body: '· 删除<b>不可恢复</b>；<br>· 该成员这几天原本被标成「已请假」的值日会退回「待值日」。<br><br>如果只是想改成已撤销，请用「编辑」把状态改为「已撤销」。'
    });
    if (!ok) return;
    api('/api/leave/' + id + '/delete', { method: 'POST' }).then(function (res) {
      if (!res.ok) { toast(res.errMsg || '删除失败', 'err'); return; }
      toast('已删除；值日标记已同步', 'ok');
      reload();
    });
  }

  /* ============================================================
   * 值日记录 / 换班申请（2026-11-15 新增）
   * ============================================================
   * 两者共用 `openMemberPicker`：都要「从本班选一个人」，
   * 各自写一遍就会各自漏掉「只列 ACTIVE 成员」或「只列本班」这类约束。
   */

  var DUTY_STATUS_TEXT = {
    PENDING: '待值日', ONGOING: '进行中', DONE: '已值日',
    LEAVE: '已请假', SWAPPED_OUT: '已换出', EXPIRED: '已结束'
  };
  function dutyTag(s) {
    var cls = { DONE: 'tag-ok', PENDING: 'tag-warn', ONGOING: 'tag-warn' }[s] || 'tag-off';
    return '<span class="tag ' + cls + '">' + esc(DUTY_STATUS_TEXT[s] || s) + '</span>';
  }

  var SWAP_STATUS_TEXT = {
    PENDING_PEER: '待对方确认', PENDING_ADMIN: '待管理员确认',
    DONE: '已完成', REJECTED: '已拒绝', CANCELLED: '已撤销'
  };
  function swapTag(s) {
    var cls = { DONE: 'tag-ok' }[s] || (/^PENDING/.test(s) ? 'tag-warn' : 'tag-off');
    return '<span class="tag ' + cls + '">' + esc(SWAP_STATUS_TEXT[s] || s) + '</span>';
  }

  /**
   * 通用「选一个人」弹层。
   * 只列本班 ACTIVE 成员；调用方拿到 { id, name } 后自己做后续动作。
   */
  function openMemberPicker(title, onPick) {
    api('/api/members?classId=' + state.classId + '&page=1&pageSize=0&scope=ALL').then(function (d) {
      if (!d.ok) { toast(d.errMsg || '读取成员失败', 'err'); return; }
      var items = ((d.data && d.data.items) || []).filter(function (m) {
        return m.status === 'ACTIVE' || m.status === undefined;
      });
      if (!items.length) { toast('本班没有可用成员', 'err'); return; }
      var opts = items.map(function (m) {
        return '<option value="' + m.id + '">' + esc(m.name) +
          (m.studentNo ? '（' + esc(m.studentNo) + '）' : '') +
          (m.groupTag ? ' · ' + esc(m.groupTag) + '组' : '') + '</option>';
      }).join('');
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">' + esc(title) + '</div>' +
        '<div class="dlg-bd">' + fld('选择成员', '<select id="pk-member">' + opts + '</select>') + '</div>' +
        '<div class="dlg-ft">' +
        '<button class="btn" id="pk-cancel">取消</button>' +
        '<button class="btn btn-primary" id="pk-ok">确定</button>' +
        '</div></div>';
      document.body.appendChild(dlg);
      $('#pk-cancel', dlg).onclick = function () { dlg.remove(); };
      $('#pk-ok', dlg).onclick = function () {
        var sel = $('#pk-member', dlg);
        var id = Number(sel.value);
        var name = sel.options[sel.selectedIndex].textContent;
        dlg.remove();
        onPick(id, name);
      };
    });
  }

  /* ---------------- 值日记录 ---------------- */

  function renderDuty(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    // 默认看最近 7 天（含今天）：后台最常见的诉求是「这周谁值日 / 昨天谁没做」
    var f = state.dutyFilter || (state.dutyFilter = {
      dateFrom: ymd(new Date(Date.now() - 6 * 86400000)),
      dateTo: ymd(new Date()),
      status: '',
      kind: ''
    });

    function load() {
      var qs = 'classId=' + state.classId +
        '&dateFrom=' + encodeURIComponent(f.dateFrom) +
        '&dateTo=' + encodeURIComponent(f.dateTo) +
        (f.status ? '&status=' + f.status : '') +
        (f.kind ? '&kind=' + f.kind : '') +
        /* 2026-11-16 焕新 · UX 规范 P0：原来固定 pageSize=200 一次拉 200 行，
           页面被撑成"长表格"，用户要滚很久才够到分页/操作区。
           现在按 60 条分页（后端默认也是 60），与成员页口径一致。 */
        '&page=' + state.dutyPage + '&pageSize=' + state.dutyPageSize;
      /* ⚠️ 上面这一行**必须以分号结尾**（2026-11-16 事故）：
         曾漏写分号，导致下面的 api('/api/duty?' + qs) 被 `+` 吞进 qs 的初始化表达式，
         调用时 qs 尚是 undefined ⇒ 请求发成 /api/duty?undefined ⇒ 后端报「缺少班级」。
         node --check 抓不到 —— 字符串 + Promise 是**合法语法**，语义才错。门禁靠断言
         classId 与 api 调用之间必须有分号来守（check-admin-duty-guard）。 */
      api('/api/duty?' + qs).then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        var rows = d.data.items || [];
        var statusOpts = ['', 'PENDING', 'ONGOING', 'DONE', 'SWAPPED_OUT', 'EXPIRED'].map(function (s) {
          return '<option value="' + s + '"' + (s === f.status ? ' selected' : '') + '>' +
            (s ? DUTY_STATUS_TEXT[s] : '全部状态') + '</option>';
        }).join('');
        var kindOpts = [['', '全部课次'], ['COURSE', '课程'], ['CLEAN', '保洁']].map(function (p) {
          return '<option value="' + p[0] + '"' + (p[0] === f.kind ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('');

        var body = rows.length ? rows.map(function (r) {
          // 状态下拉直接改（一次点击完成），不再点进弹层再选一遍
          var st = '<select class="duty-st" data-duty-status="' + r.id + '">' +
            ['PENDING', 'ONGOING', 'DONE', 'SWAPPED_OUT', 'EXPIRED'].map(function (s) {
              return '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' +
                DUTY_STATUS_TEXT[s] + '</option>';
            }).join('') + '</select>';
          return '<tr>' +
            '<td class="td-period">' + esc(r.classDate) + '</td>' +
            '<td>' + r.week + '</td>' +
            '<td>' + r.period + '</td>' +
            '<td>' + esc(r.courseName) + '</td>' +
            '<td>' + esc(r.memberName) + (r.studentNo ? '<span class="muted-note"> · ' + esc(r.studentNo) + '</span>' : '') + '</td>' +
            '<td>' + dutyTag(r.status) + '</td>' +
            '<td>' + (r.source === 'MANUAL' ? '<span class="muted-note">手工</span>' : '<span class="muted-note">自动</span>') + '</td>' +
            '<td class="td-ops">' + st +
            '<button class="link" data-duty-swap="' + r.id + '">换人</button>' +
            '<button class="link link-danger" data-duty-del="' + r.id + '">删除</button>' +
            '</td></tr>';
        }).join('') : '<tr><td colspan="8">' + emptyHtml({
          t: '这段时间没有值日记录',
          d: '换个日期范围看看；若该班还没排值日，先在「课程表」里配好课次'
        }) + '</td></tr>';

        host.innerHTML =
          '<div class="toolbar">' +
          '<div class="toolbar-left">' +
          '<input type="date" id="duty-from" value="' + esc(f.dateFrom) + '">' +
          '<span class="muted-note">至</span>' +
          '<input type="date" id="duty-to" value="' + esc(f.dateTo) + '">' +
          '<select id="duty-status">' + statusOpts + '</select>' +
          '<select id="duty-kind">' + kindOpts + '</select>' +
          '</div>' +
          '<div class="toolbar-right"><button class="btn" id="duty-refresh">刷新</button></div>' +
          '</div>' +
          '<div class="card">' +
          /* 2026-11-16 焕新 · UX 规范 P0：标题处显示**总条数**（后端 total），
             不再显示当前页行数（分页后 rows.length 只是本页条数，会误导）。 */
          '<div class="card-hd">值日明细 · 共 ' + (d.data.total != null ? d.data.total : rows.length) + ' 条' +
          '<span class="muted-note">（状态可直接下拉修改；「已请假」由请假审批产生，这里不提供手工设置）</span></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>日期</th><th>周次</th><th>节次</th><th>课次</th><th>值日人</th><th>状态</th><th>来源</th><th>操作</th>' +
          '</tr></thead><tbody>' + body + '</tbody></table></div>' +
          /* 分页器（原来一次拉 200 行，现在 60/页） */
          (d.data.total && state.dutyPageSize
            ? pager(d.data.total, d.data.page || state.dutyPage, state.dutyPageSize, function (p) {
                state.dutyPage = p; load();
              })
            : '') +
          '</div>';

        bind();
      });
    }

    function bind() {
      var fromEl = $('#duty-from', host);
      var toEl = $('#duty-to', host);
      var stEl = $('#duty-status', host);
      var kdEl = $('#duty-kind', host);
      /* 筛选条件变化 ⇒ 回到第 1 页（否则可能停在一个已不存在的页码上，
         后端返回空列表、用户以为"数据没了"）—— 与成员页口径一致。 */
      function reloadFromFirst() { state.dutyPage = 1; load(); }
      if (fromEl) fromEl.onchange = function () { f.dateFrom = fromEl.value; reloadFromFirst(); };
      if (toEl) toEl.onchange = function () { f.dateTo = toEl.value; reloadFromFirst(); };
      if (stEl) stEl.onchange = function () { f.status = stEl.value; reloadFromFirst(); };
      if (kdEl) kdEl.onchange = function () { f.kind = kdEl.value; reloadFromFirst(); };
      var rf = $('#duty-refresh', host);
      if (rf) rf.onclick = function () { load(); };

      $$('[data-duty-status]', host).forEach(function (s) {
        s.onchange = function () {
          var id = Number(s.dataset.dutyStatus);
          s.disabled = true;
          api('/api/duty/' + id + '/status', { method: 'POST', body: { status: s.value } }).then(function (r) {
            s.disabled = false;
            if (!r.ok) { toast(r.errMsg || '修改失败', 'err'); load(); return; }
            toast('状态已更新', 'ok');
            load();
          });
        };
      });
      $$('[data-duty-swap]', host).forEach(function (b) {
        b.onclick = function () {
          var id = Number(b.dataset.dutySwap);
          openMemberPicker('换人值日', function (memberId, name) {
            api('/api/duty/' + id + '/member', { method: 'POST', body: { memberId: memberId } }).then(function (r) {
              if (!r.ok) { toast(r.errMsg || '换人失败', 'err'); return; }
              toast('已换给 ' + name, 'ok');
              load();
            });
          });
        };
      });
      $$('[data-duty-del]', host).forEach(function (b) {
        b.onclick = async function () {
          var ok = await confirmDialog({
            title: '删除这条值日记录？',
            okText: '确认删除',
            body: '· 只删这一条，不影响其它周次；<br>· 不会改动任何人的值日次数（<b>轮转队列不变</b>）；<br>· 删掉后该时段就没有值日人了。'
          });
          if (!ok) return;
          api('/api/duty/' + Number(b.dataset.dutyDel) + '/delete', { method: 'POST' }).then(function (r) {
            if (!r.ok) { toast(r.errMsg || '删除失败', 'err'); return; }
            toast('已删除', 'ok');
            load();
          });
        };
      });
    }

    load();
  }

  /* ---------------- 换班申请 ---------------- */

  function renderSwap(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    if (!state.swapStatus) state.swapStatus = '';

    function load() {
      var qs = 'classId=' + state.classId + (state.swapStatus ? '&status=' + state.swapStatus : '') + '&pageSize=100';
      api('/api/swap?' + qs).then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        var rows = d.data.items || [];
        var segs = [['', '全部'], ['PENDING_PEER', '待对方'], ['PENDING_ADMIN', '待管理员'], ['DONE', '已完成'], ['REJECTED', '已拒绝'], ['CANCELLED', '已撤销']]
          .map(function (p) {
            return '<button type="button" class="seg-btn' + (p[0] === state.swapStatus ? ' active' : '') +
              '" data-swap-st="' + p[0] + '">' + p[1] + '</button>';
          }).join('');

        var body = rows.length ? rows.map(function (r) {
          var ops = '';
          if (r.canAct) {
            if (r.type === 'SWAP') ops += '<button class="link" data-swap-ok="' + r.id + '">通过</button>';
            ops += '<button class="link link-danger" data-swap-no="' + r.id + '">驳回</button>' +
                   '<button class="link" data-swap-cancel="' + r.id + '">撤销</button>';
          } else {
            ops = '<span class="muted-note">已处理</span>';
          }
          return '<tr' + (r.expired ? ' class="row-warn"' : '') + '>' +
            '<td class="td-period">' + esc(r.createdAt) + '</td>' +
            '<td>' + esc(r.typeText) + '</td>' +
            '<td>' + esc(r.classDate) + '<span class="muted-note"> 第' + r.week + '周 ' + r.period + '节</span><br>' +
            '<span class="muted-note">' + esc(r.courseName) + '</span></td>' +
            '<td>' + esc(r.fromName) + '</td>' +
            '<td>' + (r.toName ? esc(r.toName) : '<span class="muted-note">未指定</span>') + '</td>' +
            '<td>' + esc(r.reasonText) + '</td>' +
            '<td>' + swapTag(r.status) + (r.expired ? '<br><span class="muted-note">已过期</span>' : '') + '</td>' +
            '<td class="td-ops">' + ops + '</td></tr>';
        }).join('') : '<tr><td colspan="8">' + emptyHtml({
          t: '该班还没有换班申请',
          d: '学生在小程序发起换班后，待审批的都列在这里'
        }) + '</td></tr>';

        host.innerHTML =
          '<div class="toolbar">' +
          '<div class="seg" role="group">' + segs + '</div>' +
          '<div class="toolbar-right"><button class="btn" id="swap-refresh">刷新</button></div>' +
          '</div>' +
          '<div class="card">' +
          '<div class="card-hd">换班 / 请假代班申请 · 共 ' + rows.length + ' 条' +
          '<span class="muted-note">（「通过」会真的把值日换成替补，并记进换人历史，小程序里可还原）</span></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>申请时间</th><th>类型</th><th>值日</th><th>申请人</th><th>替补</th><th>原因</th><th>状态</th><th>操作</th>' +
          '</tr></thead><tbody>' + body + '</tbody></table></div></div>';

        bind();
      });
    }

    function bind() {
      $$('[data-swap-st]', host).forEach(function (b) {
        b.onclick = function () { state.swapStatus = b.dataset.swapSt; load(); };
      });
      var rf = $('#swap-refresh', host);
      if (rf) rf.onclick = function () { load(); };

      $$('[data-swap-ok]', host).forEach(function (b) {
        b.onclick = async function () {
          var ok = await confirmDialog({
            title: '通过这条换班申请？',
            okText: '确认通过',
            danger: false,
            body: '值日人会立刻换成替补，并写入换人记录（小程序里可还原）。'
          });
          if (!ok) return;
          api('/api/swap/' + Number(b.dataset.swapOk) + '/approve', { method: 'POST', body: {} }).then(function (r) {
            if (!r.ok) { toast(r.errMsg || '操作失败', 'err'); load(); return; }
            toast('已通过，值日人已更新', 'ok');
            load();
          });
        };
      });
      $$('[data-swap-no]', host).forEach(function (b) {
        b.onclick = async function () {
          var ok = await confirmDialog({
            title: '驳回这条申请？',
            okText: '确认驳回',
            danger: false,
            body: '驳回后该申请将标记为已驳回，不会改动值日安排。'
          });
          if (!ok) return;
          api('/api/swap/' + Number(b.dataset.swapNo) + '/reject', { method: 'POST', body: {} }).then(function (r) {
            if (!r.ok) { toast(r.errMsg || '操作失败', 'err'); return; }
            toast('已驳回', 'ok');
            load();
          });
        };
      });
      $$('[data-swap-cancel]', host).forEach(function (b) {
        b.onclick = async function () {
          var ok = await confirmDialog({
            title: '撤销这条申请？',
            okText: '确认撤销',
            body: '若它已把值日置为「已请假」，会一并退回「待值日」。'
          });
          if (!ok) return;
          api('/api/swap/' + Number(b.dataset.swapCancel) + '/cancel', { method: 'POST', body: {} }).then(function (r) {
            if (!r.ok) { toast(r.errMsg || '操作失败', 'err'); return; }
            toast('已撤销', 'ok');
            load();
          });
        };
      });
    }

    load();
  }

  /* ---------------- 倒数日（只读） ---------------- */

  function renderCountdown(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    if (state.cdKeyword === undefined) state.cdKeyword = '';

    function load() {
      var qs = 'classId=' + state.classId + (state.cdKeyword ? '&keyword=' + encodeURIComponent(state.cdKeyword) : '');
      api('/api/countdown?' + qs).then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        var rows = d.data.items || [];
        var body = rows.length ? rows.map(function (r) {
          var dl = r.daysLeft;
          var txt = dl > 0 ? ('还有 ' + dl + ' 天') : (dl === 0 ? '就是今天' : (Math.abs(dl) + ' 天前'));
          var cls = dl < 0 ? 'muted-note' : '';
          return '<tr' + (r.past ? ' class="row-muted"' : '') + '>' +
            '<td class="td-period">' + esc(r.targetDate) + '</td>' +
            '<td class="' + cls + '">' + esc(txt) + '</td>' +
            '<td>' + esc(r.name) + '</td>' +
            '<td>' + esc(r.memberName) + (r.studentNo ? '<span class="muted-note"> · ' + esc(r.studentNo) + '</span>' : '') + '</td>' +
            '<td>' + esc(r.position || '—') + '</td>' +
            '<td class="muted-note">' + esc(r.createdAt) + '</td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="6">' + emptyHtml({
          t: '该班还没有添加倒数日',
          d: '同学们可在小程序自行添加，临近的日期会显示在首页'
        }) + '</td></tr>';

        host.innerHTML =
          '<div class="toolbar">' +
          '<div class="toolbar-left">' +
          '<input type="search" id="cd-kw" placeholder="搜事件或姓名" value="' + esc(state.cdKeyword) + '">' +
          '</div>' +
          '<div class="toolbar-right"><button class="btn" id="cd-refresh">刷新</button></div>' +
          '</div>' +
          '<div class="card">' +
          '<div class="card-hd">倒数日 · 共 ' + rows.length + ' 条' +
          '<span class="muted-note">（今天 ' + d.data.todayCount + ' 条，未来 ' + d.data.upcomingCount +
          ' 条；这是同学们各自添加的私人日子，后台只读，不做增删改）</span></div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>目标日期</th><th>倒计时</th><th>事件</th><th>添加人</th><th>职位</th><th>添加时间</th>' +
          '</tr></thead><tbody>' + body + '</tbody></table></div></div>';

        bind();
      });
    }

    function bind() {
      var kw = $('#cd-kw', host);
      if (kw) {
        // 输入即筛（本地 300ms 防抖），不用按回车
        var t = null;
        kw.oninput = function () {
          clearTimeout(t);
          t = setTimeout(function () {
            state.cdKeyword = kw.value.trim();
            load();
          }, 300);
        };
      }
      var rf = $('#cd-refresh', host);
      if (rf) rf.onclick = function () { load(); };
    }

    load();
  }

  /* ---------------- 后台账号（仅超管） ---------------- */

  /**
   * 权限勾选网格。selected 为已勾选的权限 key 数组。
   *
   * 2026-11-16：`members` 是**可勾的父项**，勾上才展开 6 个操作位
   *   （查看名单 / 新增 / 编辑 / 导入 / 删除 / 设超管）——
   *   用户口径：「勾选成员后出现成员的细分权限」。不勾就只发 `members` 之外的页签。
   *   key 与 label 全部由 /api/accounts 下发（state.memberOps），前端不写死枚举。
   */
  function permChecks(selected) {
    var list = state.accountViews || [];
    var ops = state.memberOps || [];
    var sel = selected || [];
    // 老账号可能只存了父级 members（没有子项）→ 后端 expandMembers 视为「全部 6 项」，前端照此显示
    var hasSub = ops.some(function (o) { return sel.indexOf(o.key) >= 0; });
    var memberOn = sel.indexOf('members') >= 0 || hasSub;
    var html = '';
    list.forEach(function (v) {
      if (v.key === 'members') {
        html += '<label class="perm-item perm-parent" title="勾选后才展开细项">' +
          '<input type="checkbox" value="members" data-perm-parent="members"' +
          (memberOn ? ' checked' : '') + '><span>' + esc(v.label) + '</span></label>' +
          '<div class="perm-group"' + (memberOn ? '' : ' hidden') + '>' +
          '<div class="perm-group-hd"><span class="muted-note">可进成员页 · 下面逐项决定能做什么</span></div>' +
          '<div class="perm-sub">' +
          (ops.length ? ops.map(function (o) {
            var on = hasSub ? sel.indexOf(o.key) >= 0 : memberOn;
            return '<label class="perm-item" title="' + esc(o.desc || '') + '">' +
              '<input type="checkbox" value="' + esc(o.key) + '"' + (on ? ' checked' : '') + '>' +
              '<span>' + esc(o.label) + '</span></label>';
          }).join('') : '<span class="muted-note">（后端未下发成员操作位）</span>') +
          '</div></div>';
        return;
      }
      var on = sel.indexOf(v.key) >= 0;
      html += '<label class="perm-item"><input type="checkbox" value="' + esc(v.key) + '"' +
        (on ? ' checked' : '') + '><span>' + esc(v.label) + '</span></label>';
    });
    return '<div class="perm-grid">' + html + '</div>';
  }

  /**
   * 「成员」父项 ↔ 6 个操作位联动（2026-11-16 用户追加口径）。
   *   · 勾父项 → 展开并把 6 项全勾（等于一个开关给全套，跟改前的直觉一致）；
   *   · 取消父项 → 收起并清空，pickedPerms 不会带出隐藏的勾；
   *   · 子项被逐个取消到一项不剩 → 父项跟着取消。
   *     这条必须有：后端把「裸 members」解释成全部 6 项（老数据兼容），
   *     留着勾父项却一项不给 = 静默提权。
   * 必须在 innerHTML 落地之后调用（先 appendChild 再 bind）。
   */
  function bindPermGroup(dlg) {
    var root = dlg || document;
    var parent = root.querySelector('[data-perm-parent="members"]');
    if (!parent) return;
    var group = root.querySelector('.perm-group');
    var subs = $$('.perm-sub input[type="checkbox"]', group || root);
    parent.onchange = function () {
      var on = !!parent.checked;
      if (group) group.hidden = !on;
      subs.forEach(function (c) { c.checked = on; });
    };
    subs.forEach(function (c) {
      c.onchange = function () {
        if (c.checked) {
          parent.checked = true;
          if (group) group.hidden = false;
        } else if (!subs.some(function (x) { return x.checked; })) {
          parent.checked = false;
          if (group) group.hidden = true;
        }
      };
    });
  }

  function pickedPerms(dlg) {
    return $$('.perm-grid input:checked', dlg).map(function (c) { return c.value; });
  }

  function renderAccount(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }

    function load() {
      api('/api/accounts?classId=' + state.classId).then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        // 页签清单、成员操作位与职位模板只在第一次拿到时缓存（后续弹层要用）
        if (d.data.views) state.accountViews = d.data.views;
        if (d.data.memberOps) state.memberOps = d.data.memberOps;
        if (!state.accountViews) state.accountViews = [];
        if (!state.memberOps) state.memberOps = [];
        var accs = d.data.accounts || [];
        var cands = d.data.candidates || [];

        var ops = state.memberOps || [];
        var accBody = accs.length ? accs.map(function (a) {
          /* 权限展示：成员页细项合并成一格「成员（全部 / 3·共 6 项）」，
             否则一行会摊出「成员 / 查看成员名单 / 新增成员 / …」把列撑爆。 */
          var ap = a.perms || [];
          var subN = ap.filter(function (k) { return k.indexOf('members.') === 0; }).length;
          var permTxt = ap.filter(function (k) { return k !== 'members' && k.indexOf('members.') !== 0; })
            .map(function (k) {
              var v = (state.accountViews || []).filter(function (x) { return x.key === k; })[0];
              return v ? v.label : k;
            });
          if (subN || ap.indexOf('members') >= 0) {
            var mt = (subN >= ops.length && subN > 0) ? '成员（全部）'
              : (subN ? '成员（' + subN + '/共 ' + ops.length + ' 项）' : '成员');
            permTxt.unshift(mt);
          }
          permTxt = permTxt.join(' / ') || '<span class="muted-note">无</span>';
          return '<tr>' +
            '<td>' + esc(a.memberName) + (a.studentNo ? '<span class="muted-note"> · ' + esc(a.studentNo) + '</span>' : '') + '</td>' +
            /* 超管 = 危险权限 → 用 tag-super(红) 而非 tag-ok(绿)：
               绿色会读成「一切正常」，红色才表达「此账号权限极高」。 */
            '<td>' + esc(a.position || '—') + (a.isSuper ? ' <span class="tag tag-super">超管</span>' : '') + '</td>' +
            '<td class="fee-amt">' + esc(a.username) + '</td>' +
            '<td class="td-perms">' + permTxt + '</td>' +
            '<td>' + (a.status ? '<span class="tag tag-ok">启用</span>' : '<span class="tag tag-off">停用</span>') + '</td>' +
            '<td class="muted-note">' + (a.lastLoginAt || '从未登录') + '</td>' +
            '<td class="td-ops">' +
            '<button class="link" data-acc-perm="' + a.adminId + '">改权限</button>' +
            '<button class="link" data-acc-toggle="' + a.adminId + '" data-on="' + a.status + '">' +
            (a.status ? '停用' : '启用') + '</button>' +
            '<button class="link link-danger" data-acc-del="' + a.adminId + '">删除</button>' +
            '</td></tr>';
        }).join('') : '<tr><td colspan="7">' + emptyHtml({
          t: '该班还没有开通后台账号',
          d: '开通后老师与班委才能登录本后台管理数据',
          act: { k: 'account-add', label: '开通后台', primary: true }
        }) + '</td></tr>';

        host.innerHTML =
          '<div class="toolbar">' +
          '<div class="toolbar-left"><span class="muted-note">' +
          '后台权限按「职位」自动套用默认模板；开通时可手工调整。停用或改权限后，对方当前登录状态会立即失效。</span></div>' +
          '<div class="toolbar-right">' +
          '<button class="btn btn-primary" id="acc-open">开通后台</button>' +
          '<button class="btn" id="acc-refresh">刷新</button>' +
          '</div>' +
          '</div>' +
          '<div class="card">' +
          '<div class="card-hd">已开通账号 · 共 ' + accs.length + ' 个</div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>姓名</th><th>职位</th><th>账号</th><th>权限</th><th>状态</th><th>最后登录</th><th>操作</th>' +
          '</tr></thead><tbody>' + accBody + '</tbody></table></div></div>';

        bind(cands);
      });
    }

    function bind(cands) {
      var rf = $('#acc-refresh', host);
      if (rf) rf.onclick = function () { load(); };

      var op = $('#acc-open', host);
      if (op) op.onclick = function () { openAccountPickDialog(cands, load); };
      $$('[data-acc-perm]', host).forEach(function (b) {
        b.onclick = function () { openAccountPermDialog(Number(b.dataset.accPerm), load); };
      });
      $$('[data-acc-toggle]', host).forEach(function (b) {
        b.onclick = async function () {
          var on = Number(b.dataset.on) ? 1 : 0;
          var next = on ? 0 : 1;
          var ok = await confirmDialog({
            title: next ? '启用这个后台账号？' : '停用这个后台账号？',
            okText: next ? '确认启用' : '确认停用',
            danger: !next,
            body: next ? '启用后该账号可以登录后台。'
              : '停用后对方会<b>立刻被踢出后台</b>，需要重新登录（且登录会被拒）。'
          });
          if (!ok) return;
          api('/api/accounts/' + Number(b.dataset.accToggle), { method: 'POST', body: { status: next } }).then(function (r) {
            if (!r.ok) { toast(r.errMsg || '操作失败', 'err'); return; }
            toast(next ? '已启用' : '已停用', 'ok');
            load();
          });
        };
      });
      $$('[data-acc-del]', host).forEach(function (b) {
        b.onclick = async function () {
          var ok = await confirmDialog({
            title: '删除这个后台账号？',
            okText: '确认删除',
            body: '只删「登录后台的资格」，<b>不会删除班级成员档案</b>、也不影响小程序使用。'
          });
          if (!ok) return;
          api('/api/accounts/' + Number(b.dataset.accDel) + '/delete', { method: 'POST' }).then(function (r) {
            if (!r.ok) { toast(r.errMsg || '删除失败', 'err'); return; }
            toast('已删除', 'ok');
            load();
          });
        };
      });
    }

    /**
     * 选人弹层：搜索 / 过滤候选，点选后进入开通弹层。
     * 取代原来「底部铺开一个大表格逐行点开通」的展示方式（2026-11-15 用户要求）。
     * candidate 由后端下发，已含辅导员（class_id=0 / group_tag=X）与班级成员。
     */
    function openAccountPickDialog(cands, done) {
      if (!cands.length) { toast('没有可开通的人员（本班成员都已开通，且无可用教职工）', 'err'); return; }
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      dlg.innerHTML =
        '<div class="dlg dlg-pick"><div class="dlg-hd">开通后台 · 选择人员</div>' +
        '<div class="dlg-bd">' +
        fld('搜索（姓名 / 学号 / 职位 / 分组）',
          '<input type="text" id="pick-kw" placeholder="输入关键字筛选，如：生活委员 / 辅导员 / 260805">') +
        '<div class="seg pick-filter">' +
        '<button class="seg-btn active" data-pick-kind="all">全部</button>' +
        '<button class="seg-btn" data-pick-kind="staff">教职工</button>' +
        '<button class="seg-btn" data-pick-kind="committee">班委</button>' +
        '</div>' +
        '<div class="pick-list" id="pick-list"></div>' +
        '<div class="muted-note">共 ' + cands.length + ' 人可开通；教职工（含辅导员）为全校账号，开通后在所有班级生效。</div>' +
        '</div><div class="dlg-ft">' +
        '<button class="btn" id="pick-cancel">取消</button>' +
        '</div></div>';
      document.body.appendChild(dlg);
      $('#pick-cancel', dlg).onclick = function () { dlg.remove(); };

      // 角色文案：辅导员/教职工单独标注，避免超管误当普通学生
      function roleText(c) {
        if (c.groupTag === 'X') return '教职工';
        return c.role === 'MEMBER' ? '普通成员' : (c.role === 'MONITOR' ? '班长' : '管理员');
      }
      // 身份分类：staff=教职工(group_tag=X)，committee=班委(非教职工且非普通成员)
      function isStaff(c) { return c.groupTag === 'X'; }
      function isCommittee(c) { return c.groupTag !== 'X' && c.role !== 'MEMBER'; }
      function renderList(kw, kind) {
        kw = String(kw || '').trim().toLowerCase();
        kind = kind || 'all';
        var hit = cands.filter(function (c) {
          // 身份筛选（2026-11-15 用户要求：全部 / 教职工 / 班委）
          if (kind === 'staff' && !isStaff(c)) return false;
          if (kind === 'committee' && !isCommittee(c)) return false;
          if (!kw) return true;
          return [c.memberName, c.studentNo, c.position, c.groupTag, roleText(c)]
            .some(function (v) { return String(v || '').toLowerCase().indexOf(kw) >= 0; });
        });
        // 「全部」视图教职工置顶（2026-11-16 用户要求）：带原始序号做稳定排序，
        // 教职工排最前，其余保持后端返回顺序，不受搜索词影响。
        if (kind === 'all') {
          hit = hit.map(function (c, i) { return { c: c, i: i }; })
            .sort(function (a, b) {
              var ka = isStaff(a.c) ? 0 : 1;
              var kb = isStaff(b.c) ? 0 : 1;
              return ka === kb ? a.i - b.i : ka - kb;
            })
            .map(function (x) { return x.c; });
        }
        var list = $('#pick-list', dlg);
        if (!hit.length) {
          list.innerHTML = '<div class="empty pick-empty">' +
            '<div class="empty-t">没有匹配的人员</div>' +
            '<div class="empty-d">换个关键词，或清空搜索框</div>' +
            '</div>';
          return;
        }
        list.innerHTML = hit.map(function (c) {
          return '<button class="pick-item" data-pick-member="' + c.memberId + '">' +
            '<span class="pick-name">' + esc(c.memberName) +
            (isStaff(c) ? ' <span class="tag tag-all">教职工</span>' : '') +
            /* 班委 = 身份类 → 与「教职工」同归品牌蓝（视觉规范 §2.6：颜色承载语义，
               身份统一蓝、状态才用绿）。原先用 tag-ok(绿) 会让「班委」和「正常状态」混同。 */
            (isCommittee(c) ? ' <span class="tag tag-all">班委</span>' : '') + '</span>' +
            '<span class="pick-meta">' + esc(c.position || '未设职位') + ' · ' + esc(roleText(c)) +
            (c.groupTag && c.groupTag !== 'X' ? ' · ' + esc(c.groupTag) + '组' : '') +
            (c.studentNo ? ' · ' + esc(c.studentNo) : '') + '</span></button>';
        }).join('');
        $$('[data-pick-member]', list).forEach(function (b) {
          b.onclick = function () {
            var id = Number(b.dataset.pickMember);
            var c = cands.filter(function (x) { return x.memberId === id; })[0];
            dlg.remove();
            if (c) openAccountCreateDialog(c, done);
          };
        });
      }
      var curKind = 'all';
      $$('[data-pick-kind]', dlg).forEach(function (b) {
        b.onclick = function () {
          curKind = b.dataset.pickKind;
          $$('[data-pick-kind]', dlg).forEach(function (x) {
            x.classList.toggle('active', x === b);
          });
          renderList($('#pick-kw', dlg).value, curKind);
        };
      });
      $('#pick-kw', dlg).oninput = function (e) { renderList(e.target.value, curKind); };
      renderList('', curKind);
      $('#pick-kw', dlg).focus();
    }

    /** 开通弹层：默认账号名 = 学号（好记、不撞），权限默认按职位模板勾好 */
    function openAccountCreateDialog(c, done) {
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">开通后台账号 · ' + esc(c.memberName) + '</div>' +
        '<div class="dlg-bd">' +
        fld('账号名（登录用）', '<input type="text" id="ac-name" value="' + esc(c.studentNo || '') +
          '" placeholder="字母开头，4–32 位">') +
        fld('初始密码', '<input type="text" id="ac-pwd" placeholder="留空自动生成 10 位随机密码">') +
        '<div class="field"><span class="field-label">权限（已按职位「' + esc(c.position || '未设置') + '」预勾）</span>' +
        permChecks(c.templatePerms || []) + '</div>' +
        '<div class="muted-note">初始密码只显示这一次，请当场记下转给对方；忘了只能重置。</div>' +
        '</div><div class="dlg-ft">' +
        '<button class="btn" id="ac-cancel">取消</button>' +
        '<button class="btn btn-primary" id="ac-save">开通</button>' +
        '</div></div>';
      document.body.appendChild(dlg);
      bindPermGroup(dlg);
      $('#ac-cancel', dlg).onclick = function () { dlg.remove(); };
      $('#ac-save', dlg).onclick = function () {
        var btn = $('#ac-save', dlg);
        var username = $('#ac-name', dlg).value.trim();
        var pwd = $('#ac-pwd', dlg).value.trim();
        var perms = pickedPerms(dlg);
        if (!perms.length) { toast('至少要给一个页签权限', 'err'); return; }
        btn.disabled = true; btn.textContent = '开通中…';
        api('/api/accounts', {
          method: 'POST',
          body: { memberId: c.memberId, username: username, password: pwd, perms: perms }
        }).then(function (r) {
          btn.disabled = false; btn.textContent = '开通';
          if (!r.ok) { toast(r.errMsg || '开通失败', 'err'); return; }
          dlg.remove();
          showPasswordDialog('账号已开通', r.data.username, r.data.password, done);
        });
      };
    }

    /** 改权限 / 重置密码 */
    function openAccountPermDialog(adminId, done) {
      api('/api/accounts?classId=' + state.classId).then(function (d) {
        if (!d.ok) { toast(d.errMsg || '读取失败', 'err'); return; }
        var a = (d.data.accounts || []).filter(function (x) { return x.adminId === adminId; })[0];
        if (!a) { toast('账号不存在', 'err'); return; }
        var dlg = document.createElement('div');
        dlg.className = 'dlg-mask';
        dlg.innerHTML =
          '<div class="dlg"><div class="dlg-hd">' + esc(a.memberName) + ' · ' + esc(a.username) + '</div>' +
          '<div class="dlg-bd">' +
          '<div class="field"><span class="field-label">权限（当前职位：' + esc(a.position || '未设置') + '）</span>' +
          permChecks(a.perms || []) + '</div>' +
          fld('重置密码', '<input type="text" id="ac-newpwd" placeholder="留空则不修改，至少 6 位">') +
          '<div class="muted-note">保存后该账号的登录状态会立即失效，需要用新密码重新登录。</div>' +
          '</div><div class="dlg-ft">' +
          '<button class="btn" id="ap-cancel">取消</button>' +
          '<button class="btn btn-primary" id="ap-save">保存</button>' +
          '</div></div>';
        document.body.appendChild(dlg);
        bindPermGroup(dlg);
        $('#ap-cancel', dlg).onclick = function () { dlg.remove(); };
        $('#ap-save', dlg).onclick = function () {
          var btn = $('#ap-save', dlg);
          var perms = pickedPerms(dlg);
          var pwd = $('#ac-newpwd', dlg).value.trim();
          if (!perms.length) { toast('至少要给一个页签权限', 'err'); return; }
          btn.disabled = true; btn.textContent = '保存中…';
          var body = { perms: perms };
          if (pwd) body.password = pwd;
          api('/api/accounts/' + adminId, { method: 'POST', body: body }).then(function (r) {
            btn.disabled = false; btn.textContent = '保存';
            if (!r.ok) { toast(r.errMsg || '保存失败', 'err'); return; }
            dlg.remove();
            toast('已保存' + (pwd ? '；请把新密码转给对方' : ''), 'ok');
            if (done) done();
          });
        };
      });
    }

    /** 初始密码一次性展示（页面刷新后拿不到，必须当场记） */
    function showPasswordDialog(title, username, password, done) {
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">' + esc(title) + '</div>' +
        '<div class="dlg-bd">' +
        fld('账号', '<input type="text" readonly value="' + esc(username) + '">') +
        fld('初始密码', '<input type="text" readonly value="' + esc(password) + '">') +
        '<div class="muted-note">这个密码<b>只显示这一次</b>。关闭后无法再查看，只能重置。</div>' +
        '</div><div class="dlg-ft">' +
        '<button class="btn btn-primary" id="pw-ok">我已记下</button>' +
        '</div></div>';
      document.body.appendChild(dlg);
      $('#pw-ok', dlg).onclick = function () { dlg.remove(); if (done) done(); };
    }

    load();
  }

  /* ---------------- 班费 / 团费（2026-11-15 新增） ----------------
   * 与小程序共用同一套表与口径：余额 = 总额 − 已消费，**不落库**，改/删一条记录立即联动。
   * 🔴 后台删除**只删数据库行、不删云存储凭证图**（小程序删除会连带删图，且不可恢复）。
   * 凭证图直接走公网 URL（存储桶 ACL = 所有用户可读，2026-11-15 实测），不需要签名/SDK。
   */
  var FEE_TYPE_LABEL = { class: '班费', league: '团费' };

  function fmtMoney(n) {
    var v = Number(n) || 0;
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  function renderFee(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    var type = state.feeType || 'class';

    function load() {
      api('/api/fee?classId=' + state.classId).then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        // 缓存到内存（2026-11-16 焕新 · FB-3）：
        // 弹层（编辑/删除）原本每次都要**重新拉一次全量班费接口**才能找到一条记录，
        // 而失败时只弹 toast、弹层根本不打开 ⇒ 用户看到「点了没反应」。
        // 现在弹层直接从内存取，零请求、零失败路径。
        state.feeCache = { classId: state.classId, funds: (d.data && d.data.funds) || {} };
        var fund = (d.data.funds && d.data.funds[type]) || { total: 0, spent: 0, balance: 0, records: [] };
        var segs = ['class', 'league'].map(function (k) {
          var on = k === type;
          return '<button type="button" class="seg-btn' + (on ? ' active' : '') +
            '" data-fee-type="' + k + '">' + FEE_TYPE_LABEL[k] + '</button>';
        }).join('');
        var records = fund.records || [];
        var body = records.length ? records.map(function (r) {
          var thumbs = r.images.length
            ? '<span class="fee-thumbs">' + r.images.slice(0, 3).map(function (im) {
                return '<img class="fee-thumb" src="' + esc(im.url) + '" data-fee-img="' + esc(im.url) + '" alt="凭证">';
              }).join('') +
              (r.images.length > 3 ? '<span class="muted-note">+' + (r.images.length - 3) + '</span>' : '') +
              '</span>'
            : '<span class="muted-note">无</span>';
          return '<tr>' +
            '<td class="td-period">' + esc(r.createdAt) + '</td>' +
            '<td class="fee-amt">¥' + fmtMoney(r.amount) + '</td>' +
            '<td>' + (r.note ? esc(r.note) : '<span class="muted-note">—</span>') + '</td>' +
            '<td>' + esc(r.operatorName || '—') + '</td>' +
            '<td>' + thumbs + '</td>' +
            '<td class="td-ops">' +
            '<button class="link" data-fee-edit="' + r.id + '">编辑</button>' +
            '<button class="link link-danger" data-fee-del="' + r.id + '">删除</button>' +
            '</td></tr>';
        }).join('') : '<tr><td colspan="6">' + emptyHtml({
          t: '该班还没有消费记录',
          d: '登记第一笔支出后，余额会自动从总额里扣减',
          act: { k: 'fee-add', label: '登记消费', primary: true }
        }) + '</td></tr>';

        host.innerHTML =
          '<div class="toolbar">' +
          '<div class="seg" role="group" aria-label="经费类型">' + segs + '</div>' +
          '<div class="toolbar-right">' +
          '<button class="btn" id="fee-total">设置总额</button>' +
          '<button class="btn btn-primary" id="fee-add">登记消费</button>' +
          '</div></div>' +
          '<div class="card">' +
          '<div class="card-hd">' + FEE_TYPE_LABEL[type] + '汇总 · 余额 = 总额 − 已消费（运行时计算，不落库）</div>' +
          '<div class="fee-sum">' +
          '<div class="fee-sum-i"><div class="fee-sum-k">总额</div><div class="fee-sum-v">¥' + fmtMoney(fund.total) + '</div></div>' +
          '<div class="fee-sum-i"><div class="fee-sum-k">已消费</div><div class="fee-sum-v">¥' + fmtMoney(fund.spent) + '</div></div>' +
          '<div class="fee-sum-i"><div class="fee-sum-k">当前余额</div><div class="fee-sum-v fee-sum-bal">¥' + fmtMoney(fund.balance) + '</div></div>' +
          '</div></div>' +
          '<div class="card">' +
          '<div class="card-hd">消费明细 · 共 ' + records.length + ' 条</div>' +
          '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
          '<th>时间</th><th>金额</th><th>备注</th><th>操作人</th><th>凭证</th><th>操作</th>' +
          '</tr></thead><tbody>' + body + '</tbody></table></div></div>' +
          '<div class="card muted-note">后台删除只移除记录，<b>凭证图片仍保留在云存储</b>' +
          '（小程序里删除才会连带删图，且无法恢复）。后台登记消费不支持上传图片，凭证请在小程序「追加图片」里补。</div>';

        bind(fund);
      });
    }

    function bind(fund) {
      /* 🔴 必须是 $$（querySelectorAll）。写成 $ 会拿到**单个元素**，
         .forEach 立刻抛 TypeError ⇒ 下面所有 onclick 一个都绑不上，
         而 innerHTML 早已写完 ⇒ 页面看着完全正常，只是「按钮点了没反应」。 */
      $$('[data-fee-type]', host).forEach(function (b) {
        b.onclick = function () { state.feeType = b.dataset.feeType; load(); };
      });
      var bt = $('#fee-total', host);
      if (bt) bt.onclick = function () { openFeeTotalDialog(type, Number(fund.total) || 0); };
      var ba = $('#fee-add', host);
      if (ba) ba.onclick = function () { openFeeRecordDialog(type, null); };
      $$('[data-fee-edit]', host).forEach(function (b) {
        b.onclick = function () { openFeeRecordDialog(type, Number(b.dataset.feeEdit)); };
      });
      $$('[data-fee-del]', host).forEach(function (b) {
        b.onclick = function () { deleteFeeRecord(Number(b.dataset.feeDel)); };
      });
      $$('[data-fee-img]', host).forEach(function (img) {
        img.onclick = function () { openImagePreview(img.dataset.feeImg); };
      });
    }

    load();
  }

  /** 设置总额。总额是「收缴总数」，余额由它减去已消费算出来，所以这里只改总额。 */
  function openFeeTotalDialog(type, current) {
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg"><div class="dlg-hd">设置' + FEE_TYPE_LABEL[type] + '总额</div>' +
      '<div class="dlg-bd">' +
      fld('总额（元）', '<input type="number" step="0.01" min="0" id="fee-total-in" value="' +
        esc(String(Number(current) || 0)) + '">') +
      '<div class="muted-note">总额是已收缴的总金额；余额 = 总额 − 已消费明细合计，改这里不需要动任何记录。</div>' +
      '</div><div class="dlg-ft">' +
      '<button class="btn" id="fee-total-cancel">取消</button>' +
      '<button class="btn btn-primary" id="fee-total-save">保存</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
    $('#fee-total-cancel', dlg).onclick = function () { dlg.remove(); };
    $('#fee-total-save', dlg).onclick = function () {
      var btn = $('#fee-total-save', dlg);
      var v = Number($('#fee-total-in', dlg).value);
      if (!isFinite(v) || v < 0) { toast('总额须为不小于 0 的数字', 'err'); return; }
      btn.disabled = true; btn.textContent = '保存中…';
      api('/api/fee/total', {
        method: 'POST',
        body: { classId: state.classId, type: type, total: v }
      }).then(function (res) {
        if (!res.ok) { btn.disabled = false; btn.textContent = '保存'; toast(res.errMsg || '保存失败', 'err'); return; }
        dlg.remove();
        toast('总额已更新', 'ok');
        reload();
      });
    };
  }

  /** 编辑/新增消费。r 为 null 表示新增。数据从服务端重新取，避免用到过期快照。 */
  /**
   * 打开「登记 / 编辑消费」弹层（2026-11-16 焕新 · FB-3）
   * 数据**从内存缓存取**（renderFee 拉过时写入 state.feeCache），
   * 不再为此单独请求一次全量班费接口 —— 原来的写法有两个问题：
   *   ① 每次开关弹层都白拉一次全量接口（白打）；
   *   ② 请求失败时只 toast 一下就 return，弹层**根本不打开** ⇒ 用户看到「点了没反应」。
   * 现在：缓存命中直接开弹层；缓存未命中（直接调、或切班后缓存失效）才回退请求，
   *      且请求失败时**仍然打开弹层**并在层内显示错误 + 【重试】。
   */
  function openFeeRecordDialog(type, id) {
    var cached = state.feeCache && state.feeCache.classId === state.classId
      ? state.feeCache.funds : null;
    if (cached) {
      buildFeeRecordDialog(type, id, cached[type] || { records: [] });
    } else {
      api('/api/fee?classId=' + state.classId).then(function (d) {
        if (!d.ok) {
          // 失败也要把弹层开出来，并在层内显示错误 + 重试（而不是"点了没反应"）
          buildFeeRecordDialog(type, id, null, d.errMsg || '读取失败');
          return;
        }
        var funds = (d.data && d.data.funds) || {};
        state.feeCache = { classId: state.classId, funds: funds };
        buildFeeRecordDialog(type, id, funds[type] || { records: [] });
      });
    }
  }

  /** 真正的弹层构建（数据从内存取；fund 为 null 时显示错误 + 重试） */
  function buildFeeRecordDialog(type, id, fund, errMsg) {
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    if (!fund) {
      // 读取失败：层内错误 + 【重试】按钮（体验规范 §3.6）
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">读取失败</div>' +
        '<div class="dlg-bd"><div class="err-state-msg">' + esc(errMsg || '读取失败') + '</div></div>' +
        '<div class="dlg-ft"><button type="button" class="btn" data-dlg-close>关闭</button>' +
        '<button type="button" class="btn btn-primary" data-fee-retry>重试</button></div></div>';
      document.body.appendChild(dlg);
      $('[data-fee-retry]', dlg).onclick = function () {
        dlg.remove();
        openFeeRecordDialog(type, id);
      };
      $('[data-dlg-close]', dlg).onclick = function () { dlg.remove(); };
      return;
    }
    {
      var r = null;
      if (id) {
        for (var i = 0; i < fund.records.length; i++) if (fund.records[i].id === id) r = fund.records[i];
        if (!r) { toast('找不到这条记录', 'err'); return; }
      }
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">' +
        (r ? '编辑消费 · #' + r.id : '登记' + FEE_TYPE_LABEL[type] + '消费') +
        '</div><div class="dlg-bd">' +
        fld('金额（元）', '<input type="number" step="0.01" min="0.01" id="fee-amt" value="' +
          (r ? esc(String(r.amount)) : '') + '" placeholder="例如：12.50">') +
        fld('备注', '<input type="text" id="fee-note" maxlength="200" value="' +
          (r ? esc(r.note || '') : '') + '" placeholder="例如：打印活动照片">') +
        fld('时间', '<input type="datetime-local" id="fee-time" value="' +
          (r ? esc(String(r.createdAt).replace(' ', 'T').slice(0, 16)) : '') + '">') +
        (r && r.images.length
          ? '<div class="muted-note">这条记录有 ' + r.images.length + ' 张凭证图（在列表里点缩略图可放大）。</div>'
          : '<div class="muted-note">' + (r ? '这条记录没有凭证图。' : '后台不支持上传凭证，保存后在小程序里「追加图片」。') + '时间留空 = 取服务器当前时间。</div>') +
        '</div><div class="dlg-ft">' +
        '<button class="btn" id="fee-cancel">取消</button>' +
        '<button class="btn btn-primary" id="fee-save">保存</button>' +
        '</div></div>';
      document.body.appendChild(dlg);
      $('#fee-cancel', dlg).onclick = function () { dlg.remove(); };
      $('#fee-save', dlg).onclick = function () {
        var btn = $('#fee-save', dlg);
        var amount = Number($('#fee-amt', dlg).value);
        if (!(amount > 0)) { toast('金额须大于 0', 'err'); return; }
        var payload = {
          classId: state.classId,
          type: type,
          amount: amount,
          note: $('#fee-note', dlg).value,
          createdAt: $('#fee-time', dlg).value ? $('#fee-time', dlg).value.replace('T', ' ') : ''
        };
        btn.disabled = true; btn.textContent = '保存中…';
        var url = r ? '/api/fee/record/' + r.id : '/api/fee/record';
        api(url, { method: 'POST', body: payload }).then(function (res) {
          if (!res.ok) { btn.disabled = false; btn.textContent = '保存'; toast(res.errMsg || '保存失败', 'err'); return; }
          dlg.remove();
          toast(r ? '已保存' : '已登记', 'ok');
          reload();
        });
      };
    }
  }

  /**
   * 删除消费记录（2026-11-16 焕新 · FB-3）
   * 与打开弹层同理：记录**从内存缓存取**，不再为此单独拉一次全量班费接口。
   * 缓存未命中才回退请求。
   */
  function deleteFeeRecord(id) {
    var cached = state.feeCache && state.feeCache.classId === state.classId
      ? state.feeCache.funds : null;
    if (cached) {
      confirmDeleteFeeRecord(id, cached);
    } else {
      api('/api/fee?classId=' + state.classId).then(function (d) {
        if (!d.ok) { toast(d.errMsg || '读取失败', 'err'); return; }
        confirmDeleteFeeRecord(id, (d.data && d.data.funds) || {});
      });
    }
  }

  /** 删除前的二次确认（从内存数据里找到那条记录）
   *  ⚠️ 必须是 async：内部用 await confirmDialog()（站内弹层，替代原生 confirm）。
   *     调用方 deleteFeeRecord 无需 await —— 它是 fire-and-forget 的点击入口，
   *     弹层未确认前不会有任何副作用。 */
  async function confirmDeleteFeeRecord(id, funds) {
    var found = null;
    ['class', 'league'].forEach(function (k) {
      var f = funds[k];
      if (!f) return;
      f.records.forEach(function (r) { if (r.id === id) found = { r: r, t: k }; });
    });
    if (!found) { toast('找不到这条记录', 'err'); return; }
    var r = found.r;
    /* L1 轻确认（体验规范 §3.5 C3）：后果文案**一字不删** ——
       check-admin-fee.js:147 断言源码含「不可恢复」与「凭证图片」。 */
    var ok = await confirmDialog({
      title: '确认删除这条消费记录？',
      okText: '确认删除',
      body: '· ' + esc(r.createdAt) + '　¥' + esc(fmtMoney(r.amount)) + (r.note ? '　' + esc(r.note) : '') + '<br>' +
        '· 删除后余额会立即相应增加（余额 = 总额 − 已消费）<br>' +
        '· 记录<b>不可恢复</b>；<b>凭证图片</b>（' + r.images.length + ' 张）会保留在云存储，但记录本身没了<br><br>' +
        '如果只是想改金额，请用「编辑」。'
    });
    if (!ok) return;
    api('/api/fee/record/' + id + '/delete', { method: 'POST' }).then(function (res) {
        if (!res.ok) { toast(res.errMsg || '删除失败', 'err'); return; }
        toast('已删除', 'ok');
        reload();
      });
  }

  function openImagePreview(url) {
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg dlg-img"><div class="dlg-hd">凭证图片</div>' +
      '<div class="dlg-bd"><img class="img-preview" src="' + esc(url) + '" alt="凭证"></div>' +
      '<div class="dlg-ft"><button class="btn" id="img-close">关闭</button></div></div>';
    document.body.appendChild(dlg);
    $('#img-close', dlg).onclick = function () { dlg.remove(); };
    dlg.onclick = function (e) { if (e.target === dlg) dlg.remove(); };
  }

  /** 删课次：课次是「所有周共用」的一行，删它 = 删掉这门课在这个时段的所有周 */
  async function removeSession(id, name, when) {
    /* L2 标准确认（体验规范 §3.5 C4）：删课次连带清未来值日 + 已发布周次退回草稿
       ⇒ 逐条列出影响。原文案**一字不删**（含「所有周共用」「轮转队列」类表述）。 */
    var ok = await confirmDialog({
      title: '确认删除课次「' + esc(name) + '」（' + esc(when) + '）？',
      okText: '确认删除',
      level: 'L2',
      body: '· 这是<b>所有周共用</b>的一行，删除后这门课在该时段<b>所有周</b>都不再排班；<br>' +
        '· <b>未来的值日安排会一并清掉</b>（已过去的值日记录保留）；<br>' +
        '· 该班<b>已发布周次会全部退回草稿</b>，需在小程序端重新发布。<br><br>' +
        '删除前会自动备份，可在审计日志里查到批次号。'
    });
    if (!ok) return;
    api('/api/timetable/session/' + id + '/delete', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) { toast(res.errMsg, 'err'); return; }
        var d = res.data || {};
        toast('已删除' + (d.deletedDuties ? '，连带清掉未来值日 ' + d.deletedDuties + ' 条' : '') +
          '；已发布周次已退回草稿', 'ok');
        reload();
      });
  }

  /* ---------------- 成员 ---------------- */
  /* 四选一筛选口径与小程序 pages/roster 的 groupFilter 一致；页大小 0 = 全部。
   * 由 scripts/check-member-filters.js 看守前后端口径，勿只改一侧。 */
  var MEMBER_SCOPE_ORDER = ['ALL', 'COMMITTEE', 'A', 'B'];
  var MEMBER_SCOPE_LABEL = { ALL: '全部成员', COMMITTEE: '仅班委', A: 'A 组', B: 'B 组' };
  var MEMBER_PAGE_SIZES = [10, 30, 50, 0];

  function renderMember(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    /* 操作级权限（2026-11-16）：没这项权限的人连按钮都看不到，
       而不是「点了才 403」—— 后者会被当成功能坏了。 */
    var canAdd = canPerm('members.add');
    var canEdit = canPerm('members.edit');
    var canSuper = canPerm('members.super');
    var canDel = canPerm('members.remove');
    var canImport = canPerm('members.import');
    var qs = '?classId=' + state.classId + '&page=' + state.memberPage +
      '&pageSize=' + state.memberPageSize + '&scope=' + encodeURIComponent(state.memberScope) +
      (state.memberKw ? '&keyword=' + encodeURIComponent(state.memberKw) : '');
    api('/api/members' + qs).then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var r = d.data;
      var scopeBtns = MEMBER_SCOPE_ORDER.map(function (k) {
        var on = state.memberScope === k;
        return '<button type="button" class="seg-btn' + (on ? ' active' : '') +
          '" data-scope="' + k + '" aria-pressed="' + on + '">' + MEMBER_SCOPE_LABEL[k] + '</button>';
      }).join('');
      var sizeOpts = MEMBER_PAGE_SIZES.map(function (n) {
        return '<option value="' + n + '"' + (state.memberPageSize === n ? ' selected' : '') + '>' +
          (n === 0 ? '全部' : n + ' 人') + '</option>';
      }).join('');
      var scopeTip = state.memberScope === 'ALL' ? '' : ' · ' + MEMBER_SCOPE_LABEL[state.memberScope];
      var kwTip = state.memberKw ? ' · 关键词「' + esc(state.memberKw) + '」' : '';
      var pageTip = state.memberPageSize === 0
        ? '已显示全部'
        : '第 ' + r.page + ' / ' + Math.max(1, Math.ceil(r.total / state.memberPageSize)) + ' 页 · 每页 ' + state.memberPageSize + ' 人';
      host.innerHTML =
        '<div class="toolbar">' +
        '<input type="search" id="m-kw" class="input-search" placeholder="搜索姓名或学号（回车）" value="' + esc(state.memberKw) + '">' +
        '<div class="toolbar-right">' +
        (canImport ? '<button class="btn" id="btn-import">导入名单</button>' : '') +
        (canAdd ? '<button class="btn btn-primary" id="btn-add">新增成员</button>' : '') +
        '</div></div>' +
        '<div class="toolbar member-toolbar">' +
        '<div class="seg member-scope" role="group" aria-label="成员筛选">' + scopeBtns + '</div>' +
        '<div class="member-page-size">' +
        '<label class="tb-label" for="m-size">每页显示</label>' +
        '<select id="m-size" class="tb-select">' + sizeOpts + '</select>' +
        '</div></div>' +
        '<div class="card">' +
        '<div class="card-hd">共 ' + r.total + ' 人（不含测试账号）' + scopeTip + kwTip + ' · ' + pageTip + '</div>' +
        '<table class="tbl"><thead><tr>' +
        // 「状态」= 成员在册状态（正常 / 请假 / 停用）；「绑定」= 是否已绑微信（openid）。
        // 2026-11-12 用户要求：绑定情况并入成员列表，原独立的「绑定」页已删除。
        '<th>学号</th><th>姓名</th><th>分组</th><th>角色</th><th>职位</th><th>状态</th><th>绑定</th><th>值日数</th><th>操作</th>' +
        '</tr></thead><tbody>' +
        (r.items.length ? r.items.map(function (m) {
          return '<tr>' +
            '<td class="td-no">' + esc(m.studentNo) + '</td>' +
            '<td>' + esc(m.name) + (m.isSuper ? ' <span class="tag tag-super">超管</span>' : '') + '</td>' +
            '<td>' + (m.groupTag === 'X' ? '—' : m.groupTag + ' 组') + '</td>' +
            '<td>' + roleText(m.role) + '</td>' +
            '<td>' + esc(m.position || '—') + permTags(m.feePerms) + '</td>' +
            '<td>' + statusTag(m.status) + '</td>' +
            // 绑定状态来自 /api/members 的 bound 字段（openid 是否为空），与小程序登录态同源。
            '<td>' + (m.bound
              ? '<span class="tag tag-ok">已绑定</span>'
              : '<span class="tag tag-off">未绑定</span>') + '</td>' +
            // duty_off（不排值日）必须在列表可见：值日是本小程序的核心业务，
            // 「这个人不参与排班」只藏在编辑弹层里的话，管理员在排班视图根本看不出来。
            '<td>' + m.dutyCount + (m.dutyOff ? ' <span class="tag tag-warn">不排值日</span>' : '') + '</td>' +
            '<td class="td-ops">' +
            (canEdit ? '<button class="link" data-m-edit="' + m.id + '">编辑</button>' : '') +
            (canSuper ? '<button class="link" data-m-super="' + m.id + '" data-v="' + (m.isSuper ? 0 : 1) + '">' +
              (m.isSuper ? '取消超管' : '设为超管') + '</button>' : '') +
            (canDel ? '<button class="link link-danger" data-m-del="' + m.id + '">删除</button>' : '') +
            (!canEdit && !canSuper && !canDel ? '<span class="muted-note">只读</span>' : '') +
            '</td></tr>';
        }).join('') : '<tr><td colspan="9">' +
          /* 空态三分（E1）：筛选后为空 ≠ 该班没人。
             前者给「清除筛选条件」，后者给「新增成员」—— 两条出路完全不同。 */
          (state.memberKw || state.memberScope !== 'ALL'
            ? emptyHtml({
                t: '当前筛选下没有成员',
                d: '关键词或分组把成员全过滤掉了',
                cls: 'is-filtered',
                act: { k: 'member-clear', label: '清除筛选条件' }
              })
            : emptyHtml({
                t: '该班还没有成员',
                d: '成员在小程序绑定班级后会自动同步，也可以手动新增',
                act: { k: 'member-add', label: '新增成员', primary: true }
              })) +
          '</td></tr>') +
        '</tbody></table></div>' +
        (state.memberPageSize === 0 ? '' :
          pager(r.total, r.page, r.pageSize, function (p) { state.memberPage = p; softReload(); }));

      // 按钮按权限渲染，元素可能不存在 → 绑定时必须判空（直接 .onclick 会 TypeError，
      // 而它是 bind 的第一行，抛错会让后面所有 onclick 全部绑不上、页面看着正常点不动）
      var btnAdd = $('#btn-add', host);
      if (btnAdd) btnAdd.onclick = function () { openMemberDialog(null); };
      var btnImport = $('#btn-import', host);
      if (btnImport) btnImport.onclick = function () {
        var c = currentClass();
        openRosterDialog(state.classId, c ? c.name : '本班', reload);
      };
      var kw = $('#m-kw', host);
      // 搜索是筛选的一部分：真正重渲染列表（原来只弹「找到 N 人」却不改表格）。
      // 与作用域 / 关键词叠加，且回车后回第 1 页；不用 input 即时刷，避免打字被 reload 打断焦点。
      function applyKw() {
        state.memberKw = kw.value.trim();
        state.memberPage = 1;
        softReload();
      }
      kw.onkeydown = function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        applyKw();
      };
      kw.onsearch = function () { if (!kw.value) applyKw(); };  // 点搜索框自带的 × 立即还原
      $$('[data-scope]', host).forEach(function (b) {
        b.onclick = function () {
          if (state.memberScope === b.dataset.scope) return;
          state.memberScope = b.dataset.scope;
          state.memberPage = 1;
          /* 即时高亮：页内重取要等 API 返回才重绘，先本地点亮按钮，
             否则点了「A 组」却要等半秒才变色，看着像没点上（体验规范 L6）。 */
          $$('[data-scope]', host).forEach(function (x) {
            var on = x.dataset.scope === state.memberScope;
            x.classList.toggle('active', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          softReload();
        };
      });
      $('#m-size', host).onchange = function () {
        state.memberPageSize = Number(this.value);
        state.memberPage = 1;
        softReload();
      };
      $$('[data-m-edit]', host).forEach(function (b) {
        b.onclick = function () { openMemberDialog(Number(b.dataset.mEdit)); };
      });
      $$('[data-m-super]', host).forEach(function (b) {
        b.onclick = async function () {
          var on = b.dataset.v === '1';
          var ok = await confirmDialog({
            title: on ? '确认设为超级管理员？' : '确认取消超级管理员？',
            okText: on ? '确认设置' : '确认取消',
            danger: on,
            body: on ? '该成员将立即拥有后台登录资格。' : '取消后该成员将失去后台页签权限。'
          });
          if (!ok) return;
          api('/api/members/' + b.dataset.mSuper + '/super', { method: 'POST', body: { isSuper: on } })
            .then(function (r) { toast(r.ok ? '已更新' : r.errMsg, r.ok ? 'ok' : 'err'); if (r.ok) reload(); });
        };
      });
      $$('[data-m-del]', host).forEach(function (b) {
        b.onclick = async function () {
          var ok = await confirmDialog({
            title: '确认删除该成员？',
            okText: '确认删除',
            body: '有值日或请假历史的成员不可删除，系统会改为提示停用。'
          });
          if (!ok) return;
          api('/api/members/' + b.dataset.mDel + '/delete', { method: 'POST' })
            .then(function (r) {
              if (!r.ok) { toast(r.errMsg, 'err'); return; }
              if (r.data.blocked) { toast(r.data.suggestion, 'err'); return; }
              toast('已删除', 'ok'); reload();
            });
        };
      });
    });
  }

  /* ---------------- 导入成员名单（2026-11-16） ----------------
   * 文件以 base64 发给后端解析：xlsx 是二进制，前端解不了，也不值得为它引一个 xlsx 库；
   * 后端的解析器与小程序是同一套规则（common/roster-parse.js），命令行里测过 15 种写法。
   *
   * 🔴 预览与提交**用同一份 payload**：输入一变就重置预览按钮，逼用户重新预览一次。
   *    理由：commit 在后端会重新解析（不信前端回传的行），但用户界面必须先看到
   *    「会新增几人 / 会改名几人 / 哪些冲突」，否则一次误导入能凭空造出一个班。
   */
  var ROSTER_OP = {
    create: { text: '新增', cls: 'tag-ok' },
    update: { text: '改名', cls: 'tag-warn' },
    same: { text: '已存在', cls: 'tag-off' },
    conflict: { text: '跨班冲突', cls: 'tag-super' },
    dup: { text: '文件内重复', cls: 'tag-warn' },
    need_no: { text: '缺学号', cls: 'tag-super' }
  };

  function openRosterDialog(classId, className, done) {
    var payload = null;
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg dlg-wide"><div class="dlg-hd">导入成员名单 · ' + esc(className) + '</div>' +
      '<div class="dlg-bd">' +
      '<div class="field"><span class="field-label">方式一：选择文件（.xlsx / .csv / .txt，上限 4MB）</span>' +
      '<input type="file" id="r-file" accept=".xlsx,.xlsm,.csv,.txt"></div>' +
      '<div class="field"><span class="field-label">方式二：直接粘贴（一行一个人，学号与姓名顺序不限）</span>' +
      '<textarea id="r-text" rows="5" class="ta" placeholder="000000000301,张三&#10;李四 000000000302"></textarea></div>' +
      '<div class="hint">智能识别：学号在前或在后、逗号 / 空格 / 制表符分隔、学号与姓名连写、Excel 多工作表都能识别；' +
      '只有序号没有学号的名册，会按本班已有学号前缀自动补全。已存在的学号只更新姓名，不改分组与职位。</div>' +
      '<div id="r-preview"></div>' +
      '</div>' +
      '<div class="dlg-ft">' +
      '<button class="btn" id="r-cancel">取消</button>' +
      '<button class="btn" id="r-check">预览</button>' +
      '<button class="btn btn-primary" id="r-commit" disabled>确认导入</button>' +
      '</div></div>';
    document.body.appendChild(dlg);

    function resetPreview() {
      payload = null;
      var btn = $('#r-commit', dlg);
      if (btn) { btn.disabled = true; btn.textContent = '确认导入'; }
      var box = $('#r-preview', dlg);
      if (box) box.innerHTML = '';
    }

    /** 取当前输入：粘贴优先于文件（粘贴更即时，且文件框可能选过一次还留着） */
    function collectPayload(cb) {
      var text = $('#r-text', dlg).value.trim();
      if (text) { cb({ text: text }); return; }
      var fi = $('#r-file', dlg);
      var f = fi && fi.files && fi.files[0];
      if (!f) { cb(null); return; }
      if (f.size > 4 * 1024 * 1024) { toast('文件超过 4MB，请拆分后导入', 'err'); cb(null); return; }
      var fr = new FileReader();
      fr.onload = function () { cb({ base64: String(fr.result), filename: f.name }); };
      fr.onerror = function () { toast('读取文件失败，请重试', 'err'); cb(null); };
      fr.readAsDataURL(f);
    }

    function renderPreviewInto(box, d) {
      var s = d.summary || {};
      var chips = [
        ['新增', s.create || 0, 'tag-ok'],
        ['改名', s.update || 0, 'tag-warn'],
        ['已存在', s.same || 0, 'tag-off'],
        ['跨班冲突', s.conflict || 0, 'tag-super'],
        ['文件内重复', s.dup || 0, 'tag-warn'],
        ['缺学号', s.need_no || 0, 'tag-super']
      ].map(function (x) {
        return '<span class="tag ' + x[2] + '">' + x[0] + ' ' + x[1] + '</span>';
      }).join(' ');

      var rows = (d.items || []).slice(0, 200).map(function (it) {
        var op = ROSTER_OP[it.op] || { text: it.op, cls: 'tag-off' };
        return '<tr><td class="td-no">' + esc(it.studentNo || '（待补）') + '</td>' +
          '<td>' + esc(it.name) + '</td>' +
          '<td><span class="tag ' + op.cls + '">' + op.text + '</span></td>' +
          '<td class="muted-note">' + esc(it.reason || '') + '</td></tr>';
      }).join('');

      var failed = (d.failed || []).slice(0, 30).map(function (f) {
        return '<li>第 ' + f.line + ' 行：' + esc(f.reason) + '　<code>' + esc(f.raw || '') + '</code></li>';
      }).join('');

      box.innerHTML =
        '<div class="roster-sum">' + chips +
        '<span class="muted-note">共识别 ' + (d.total || 0) + ' 人' +
        (d.seqPrefix ? ' · 本班学号前缀 ' + esc(d.seqPrefix) : '') +
        (d.sheets > 1 ? ' · 合并 ' + d.sheets + ' 个工作表' : '') + '</span></div>' +
        (d.hint ? '<div class="hint">' + esc(d.hint) + '</div>' : '') +
        (rows ? '<div class="tbl-wrap roster-tbl"><table class="tbl"><thead><tr>' +
          '<th>学号</th><th>姓名</th><th>处理</th><th>说明</th></tr></thead><tbody>' +
          rows + '</tbody></table></div>' +
          ((d.items || []).length > 200 ? '<div class="muted-note">仅显示前 200 行，实际会处理全部 ' + d.items.length + ' 行</div>' : '')
          : '') +
        (failed ? '<div class="field"><span class="field-label">无法识别的行（不会被导入）</span><ul class="roster-fail">' + failed + '</ul></div>' : '');
    }

    $('#r-cancel', dlg).onclick = function () { dlg.remove(); };
    $('#r-text', dlg).oninput = resetPreview;
    $('#r-file', dlg).onchange = resetPreview;

    $('#r-check', dlg).onclick = function () {
      collectPayload(function (p) {
        if (!p) { toast('请选择文件或粘贴名单', 'err'); return; }
        payload = p;
        var box = $('#r-preview', dlg);
        var btn = $('#r-commit', dlg);
        box.innerHTML = '<div class="loading">解析中…</div>';
        btn.disabled = true;
        api('/api/classes/' + classId + '/roster/preview', { method: 'POST', body: p }).then(function (r) {
          if (!r.ok) {
            box.innerHTML = errHtml(r);
            toast(r.errMsg || '预览失败', 'err');
            return;
          }
          renderPreviewInto(box, r.data);
          var actionable = (r.data.summary.create || 0) + (r.data.summary.update || 0);
          btn.disabled = !actionable;
          btn.title = actionable ? '' : '没有需要写入的成员（全部已存在或存在冲突）';
        });
      });
    };

    $('#r-commit', dlg).onclick = function () {
      if (!payload) { toast('请先点「预览」确认会导入哪些人', 'err'); return; }
      var btn = $('#r-commit', dlg);
      btn.disabled = true;
      btn.textContent = '导入中…';
      api('/api/classes/' + classId + '/roster', { method: 'POST', body: payload }).then(function (r) {
        btn.textContent = '确认导入';
        if (!r.ok) { btn.disabled = false; toast(r.errMsg || '导入失败', 'err'); return; }
        dlg.remove();
        toast('导入完成：新增 ' + r.data.created + ' 人、改名 ' + r.data.updated + ' 人' +
          (r.data.skipped ? '、跳过 ' + r.data.skipped + ' 行' : ''), 'ok');
        if (done) done();
      });
    };
  }

  /** 新增班级（2026-11-16）：只填班级名，其余后端自动生成，建完可在「配置」里改 */
  function openCreateClassDialog(done) {
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML =
      '<div class="dlg"><div class="dlg-hd">新增班级</div><div class="dlg-bd">' +
      fld('班级名称', '<input type="text" id="nc-name" maxlength="64" placeholder="如：示例专业2604班">') +
      '<div class="hint">其余字段自动生成：学期第一周取<b>本周周一</b>、总周数 16、绑定入口开启、' +
      '加入口令与邀请码自动分配（不重复）、大节时间套用现有班级配置。' +
      '建好后可直接「导入名单」，或在「配置」里改任一字段。</div>' +
      '</div><div class="dlg-ft">' +
      '<button class="btn" id="nc-cancel">取消</button>' +
      '<button class="btn btn-primary" id="nc-ok">创建</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
    $('#nc-cancel', dlg).onclick = function () { dlg.remove(); };
    $('#nc-name', dlg).onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#nc-ok', dlg).click(); }
    };
    $('#nc-ok', dlg).onclick = function () {
      var name = $('#nc-name', dlg).value.trim();
      if (!name) { toast('请填写班级名称', 'err'); return; }
      var btn = $('#nc-ok', dlg);
      btn.disabled = true; btn.textContent = '创建中…';
      api('/api/classes', { method: 'POST', body: { name: name } }).then(function (r) {
        btn.disabled = false; btn.textContent = '创建';
        if (!r.ok) { toast(r.errMsg || '创建失败', 'err'); return; }
        dlg.remove();
        toast('已创建「' + name + '」，可继续导入名单', 'ok');
        if (done) done(r.data);
      });
    };
    var inp = $('#nc-name', dlg);
    if (inp) inp.focus();
  }

  // 单独授予的班费权限标签（字面量与真源 FEE_PERM_KEYS 一致，由 check-fee-perms 看守）
  var FEE_PERM_LABELS = { class: '登记班费', league: '登记团费' };
  function hasPerm(list, k) { return !!(list && list.indexOf(k) >= 0); }
  function permTags(list) {
    if (!list || !list.length) return '';
    return ' ' + list.map(function (k) {
      return '<span class="tag tag-all" title="额外授予：' + esc(FEE_PERM_LABELS[k] || k) + '">+' +
        esc(FEE_PERM_LABELS[k] || k) + '</span>';
    }).join(' ');
  }

  function roleText(r) {
    return r === 'ADMIN' ? '管理员' : r === 'MONITOR' ? '班委' : '学生';
  }
  function statusTag(s) {
    if (s === 'ACTIVE') return '<span class="tag tag-ok">正常</span>';
    if (s === 'LEAVE') return '<span class="tag tag-warn">请假</span>';
    return '<span class="tag tag-off">停用</span>';
  }

  function openMemberDialog(id) {
    var isNew = !id;
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML = '<div class="dlg"><div class="dlg-hd">' + (isNew ? '新增成员' : '编辑成员') + '</div>' +
      '<div class="dlg-bd">' + (isNew ? memberFormHTML(null) : '<div class="loading">读取中…</div>') + '</div>' +
      '<div class="dlg-ft"><button class="btn" id="dlg-cancel">取消</button>' +
      (isNew ? '<button class="btn btn-primary" id="dlg-ok">创建</button>' : '') +
      '</div></div>';
    document.body.appendChild(dlg);
    $('#dlg-cancel', dlg).onclick = function () { dlg.remove(); };
    if (isNew) {
      $('#dlg-ok', dlg).onclick = function () {
        var body = readMemberForm(dlg);
        api('/api/members', { method: 'POST', body: body }).then(function (r) {
          if (!r.ok) { toast(r.errMsg, 'err'); return; }
          dlg.remove(); toast('已创建', 'ok'); reload();
        });
      };
      return;
    }
    api('/api/members/' + id).then(function (r) {
      if (!r.ok) { dlg.remove(); toast(r.errMsg, 'err'); return; }
      $('.dlg-bd', dlg).innerHTML = memberFormHTML(r.data);
      var ok = document.createElement('button');
      ok.className = 'btn btn-primary'; ok.textContent = '保存';
      ok.onclick = function () {
        api('/api/members/' + id, { method: 'POST', body: readMemberForm(dlg) }).then(function (res) {
          if (!res.ok) { toast(res.errMsg, 'err'); return; }
          dlg.remove(); toast('已保存', 'ok'); reload();
        });
      };
      $('.dlg-ft', dlg).appendChild(ok);
    });
  }

  // 职位白名单：与小程序 member/index.js 的 POSITIONS、云函数 mod-member.js 逐字一致（勿改字面）。
  // position 是排班/名册的授权字段，不允许自由文本 —— 服务端也按同一份白名单校验。
  var POSITIONS = ['班长兼团支书', '副班长', '学习委员', '生活委员', '组织宣传委员', '文体委员', '心理委员'];
  function positionOptions(cur) {
    var opts = [['', '无（普通成员）']].concat(POSITIONS.map(function (p) { return [p, p]; }));
    // 现值不在白名单（历史遗留值）：保留为选项避免打开编辑就被静默改值；
    // 但保存时服务端会拒收，提示改选列表值（等于强制一次数据清洗）。
    if (cur && POSITIONS.indexOf(cur) < 0) opts.push([cur, cur + '（现值，建议改选）']);
    return opts.map(function (p) {
      return '<option value="' + esc(p[0]) + '"' + (p[0] === (cur || '') ? ' selected' : '') + '>' + esc(p[1]) + '</option>';
    }).join('');
  }

  function memberFormHTML(m) {
    m = m || {};
    return fld('姓名', '<input type="text" id="f-name" value="' + esc(m.name || '') + '">') +
      fld('学号', '<input type="text" id="f-no" value="' + esc(m.studentNo || '') + '"' + (m.id ? '' : '') + '>') +
      fld('分组', '<select id="f-group">' +
        ['A', 'B', 'X'].map(function (g) {
          return '<option value="' + g + '"' + (g === (m.groupTag || 'A') ? ' selected' : '') + '>' +
            (g === 'X' ? '不分组（教职工）' : g + ' 组') + '</option>';
        }).join('') + '</select>') +
      fld('角色', '<select id="f-role">' +
        [['MEMBER', '学生'], ['ADMIN', '管理员'], ['MONITOR', '班委']].map(function (p) {
          return '<option value="' + p[0] + '"' + (p[0] === (m.role || 'MEMBER') ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('') + '</select>') +
      fld('职位头衔', '<select id="f-position">' + positionOptions(m.position) + '</select>') +
      fld('状态', '<select id="f-status">' +
        [['ACTIVE', '正常'], ['LEAVE', '请假'], ['DISABLED', '停用']].map(function (p) {
          return '<option value="' + p[0] + '"' + (p[0] === (m.status || 'ACTIVE') ? ' selected' : '') + '>' + p[1] + '</option>';
        }).join('') + '</select>') +
      fld('不参与值日轮换', '<select id="f-dutyoff">' +
        '<option value="0"' + (!m.dutyOff ? ' selected' : '') + '>否</option>' +
        '<option value="1"' + (m.dutyOff ? ' selected' : '') + '>是（不排值日）</option></select>') +
      // 单独授予（2026-11-08）：只额外给，不撤销职位自带权限；设置总额不在此列。
      // ⚠️ 不能用 fld() 包多个 checkbox —— 外层是 <label>，点任意位置会误触第一个框。
      '<div class="field"><span class="field-label">单独授予权限（班费）</span>' +
      '<label class="chk"><input type="checkbox" id="f-perm-class"' +
        (hasPerm(m.feePerms, 'class') ? ' checked' : '') + '> 可登记班费消费</label>' +
      '<label class="chk"><input type="checkbox" id="f-perm-league"' +
        (hasPerm(m.feePerms, 'league') ? ' checked' : '') + '> 可登记团费消费</label>' +
      '<div class="hint">在职位权限之外额外授予，不会撤销任何职位自带权限；「设置总额」仍按职位。' +
      '登记权限同时允许补充凭证与删除记录。</div></div>';
  }
  function readMemberForm(dlg) {
    return {
      name: $('#f-name', dlg).value.trim(),
      studentNo: $('#f-no', dlg).value.trim(),
      groupTag: $('#f-group', dlg).value,
      role: $('#f-role', dlg).value,
      position: $('#f-position', dlg).value.trim(),
      status: $('#f-status', dlg).value,
      dutyOff: $('#f-dutyoff', dlg).value === '1',
      feePerms: (function () {
        var out = [];
        var a = $('#f-perm-class', dlg); if (a && a.checked) out.push('class');
        var b = $('#f-perm-league', dlg); if (b && b.checked) out.push('league');
        return out;
      }())
    };
  }

  /* ---------------- 账号班级 ---------------- */
  function renderClass(host) {
    api('/api/classes').then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var rows = d.data;
      var canCreate = canPerm('class');
      var canImport = canPerm('members.import');
      host.innerHTML =
        '<div class="toolbar"><div class="toolbar-left"><span class="muted-note">' +
        '新增班级只需填名称，学期 / 口令 / 邀请码 / 大节时间自动生成；建好可直接导入成员名单。</span></div>' +
        '<div class="toolbar-right">' +
        (canCreate ? '<button class="btn btn-primary" id="c-add">新增班级</button>' : '') +
        '</div></div>' +
        '<div class="card">' +
        '<div class="card-hd">全部班级（后台可跨班查看与配置）</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>班级</th><th>成员</th><th>主教室</th><th>学期起始</th><th>周数</th><th>口令</th><th>邀请码</th><th>绑定入口</th><th>状态</th><th>操作</th>' +
        '</tr></thead><tbody>' +
        rows.map(function (c) {
          return '<tr>' +
            '<td>' + esc(shortClassName(c.name)) + '</td>' +
            '<td>' + c.memberCount + '</td>' +
            '<td>' + (c.mainRoom ? esc(c.mainRoom) : '<span class="muted-note">未设</span>') + '</td>' +
            '<td>' + esc(c.termStart) + '</td>' +
            '<td>' + c.totalWeeks + '</td>' +
            '<td class="td-no">' + esc(c.joinToken) + '</td>' +
            '<td class="td-no">' + esc(c.inviteCode) + '</td>' +
            '<td>' + (c.bindOpen ? '<span class="tag tag-ok">开</span>' : '<span class="tag tag-off">关</span>') + '</td>' +
            '<td>' + classStatusTag(c, true) + '</td>' +
            '<td class="td-ops">' +
            '<button class="link" data-c-edit="' + c.id + '">配置</button>' +
            (canImport ? '<button class="link" data-c-import="' + c.id + '" data-c-name="' + esc(c.name) + '">导入名单</button>' : '') +
            /* 软删除：需要 class 权限；演示班是审核入口，不给删 */
            (canCreate && !c.isDemo ? '<button class="link" data-c-del="' + c.id + '" data-c-name="' + esc(c.name) + '">删除</button>' : '') +
            '</td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="card muted-note">敏感字段（学期、周数、绑定开关、大节时间）仅超级管理员可改 —— 后台使用者本就限定为超管。</div>';
      $$('[data-c-edit]', host).forEach(function (b) {
        b.onclick = function () { openClassDialog(Number(b.dataset.cEdit)); };
      });
      $$('[data-c-import]', host).forEach(function (b) {
        b.onclick = function () { openRosterDialog(Number(b.dataset.cImport), b.dataset.cName, reload); };
      });
      $$('[data-c-del]', host).forEach(function (b) {
        b.onclick = function () { deleteClass(Number(b.dataset.cDel), b.dataset.cName); };
      });
      var add = $('#c-add', host);
      if (add) add.onclick = function () {
        openCreateClassDialog(function () { refreshClasses().then(reload); });
      };
    });
  }

  /**
   * 软删除班级（2026-11-16）：只停用班级，不删任何业务数据。
   * 为什么是 L3：班级一消失，小程序端所有成员都看不到入口、口令/邀请码立即失效，
   * 影响面远大于删一条消费记录；恢复需要人工改库，所以必须勾选「我已知晓影响」。
   */
  async function deleteClass(id, name) {
    var ok = await confirmDialog({
      title: '确认删除班级「' + name + '」？',
      okText: '确认删除',
      level: 'L3',
      body: '· 该班会从账号班级列表和顶部班级选择器消失，小程序端也不可见<br>' +
        '· 成员、课表、值日、班费、通知等数据<b>全部保留</b>，不会清除<br>' +
        '· 加入口令 / 邀请码立即失效；如需恢复需人工改数据库重新启用<br><br>' +
        '如果只是暂时不想显示，确认后可以达到同样效果。'
    });
    if (!ok) return;
    api('/api/classes/' + id + '/delete', { method: 'POST' }).then(function (res) {
      if (!res.ok) { toast(res.errMsg || '删除失败', 'err'); return; }
      toast('已删除班级', 'ok');
      // 当前选中的班可能就是刚删的班：refreshClasses() 会兜底切到第一个可用班
      refreshClasses().then(reload);
    });
  }

  function openClassDialog(id) {
    api('/api/classes/' + id).then(function (r) {
      if (!r.ok) { toast(r.errMsg, 'err'); return; }
      var c = r.data;
      var pt = c.periodTime || [];
      var dlg = document.createElement('div');
      dlg.className = 'dlg-mask';
      dlg.innerHTML =
        '<div class="dlg"><div class="dlg-hd">配置 ' + esc(c.name) + '</div><div class="dlg-bd">' +
        '<div class="stat-row compact">' +
        stat('课程课次', c.stats.courseSessionCount, '') +
        stat('保洁课次', c.stats.cleanCount, '') +
        stat('值日记录', c.stats.dutyCount, '') +
        '</div>' +
        fld('班级名', '<input type="text" id="c-name" value="' + esc(c.name) + '">') +
        fld('主教室（保洁值日按此房间，如 410）', '<input type="text" id="c-room" maxlength="32" value="' + esc(c.mainRoom || '') + '" placeholder="如 410 / 3号教学楼410">') +
        fld('学期第一周周一', '<input type="date" id="c-term" value="' + esc(c.termStart) + '">') +
        fld('总周数', '<input type="number" id="c-weeks" min="1" max="30" value="' + c.totalWeeks + '">') +
        fld('绑定入口', '<select id="c-bind">' +
          '<option value="1"' + (c.bindOpen ? ' selected' : '') + '>开启</option>' +
          '<option value="0"' + (!c.bindOpen ? ' selected' : '') + '>关闭（防爆破）</option></select>') +
        fld('大节时间（每行 start-end，如 08:00-09:40）', '<textarea id="c-pt" rows="5" class="ta">' +
          pt.map(function (p) { return p.period + ' ' + p.start + '-' + p.end; }).join('\n') +
        '</textarea>') +
        '</div><div class="dlg-ft">' +
        '<button class="btn" id="dlg-cancel">取消</button>' +
        '<button class="btn btn-primary" id="dlg-ok">保存</button></div></div>';
      document.body.appendChild(dlg);
      $('#dlg-cancel', dlg).onclick = function () { dlg.remove(); };
      $('#dlg-ok', dlg).onclick = function () {
        var lines = $('#c-pt', dlg).value.split('\n').map(function (x) { return x.trim(); })
          .filter(Boolean);
        var periodTime = lines.map(function (l, i) {
          var m = l.match(/(\d+)?\s*(\d{2}:\d{2})\s*[-~]\s*(\d{2}:\d{2})/);
          if (!m) throw new Error('第 ' + (i + 1) + ' 行格式应为「1 08:00-09:40」');
          return { period: Number(m[1]) || i + 1, start: m[2], end: m[3] };
        });
        var body;
        try {
          body = {
            name: $('#c-name', dlg).value.trim(),
            mainRoom: $('#c-room', dlg).value.trim(),
            termStart: $('#c-term', dlg).value,
            totalWeeks: Number($('#c-weeks', dlg).value),
            bindOpen: $('#c-bind', dlg).value === '1',
            periodTime: periodTime
          };
        } catch (e) { toast(e.message, 'err'); return; }
        api('/api/classes/' + id, { method: 'POST', body: body }).then(function (res) {
          if (!res.ok) { toast(res.errMsg, 'err'); return; }
          dlg.remove(); toast('已保存', 'ok');
          // 先把班级清单刷回来（periodTime / mainRoom 都在里面），
          // 再重渲染 —— 否则本次改的大节时间/主教室在本页要等到下次刷新才生效。
          refreshClasses().then(reload);
        });
      };
    });
  }

  /* ---------------- 系统配置（后台账号） ---------------- */
  function renderConfig(host) {
    api('/api/admin-users').then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var rows = d.data;
      host.innerHTML = '<div class="card">' +
        '<div class="card-hd">后台账号（权限真源仍是 member.is_super）</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>账号</th><th>关联成员</th><th>最近登录</th><th>IP</th><th>失败次数</th><th>后台启用</th><th>实际可用</th><th>操作</th>' +
        '</tr></thead><tbody>' +
        (rows.length ? rows.map(function (a) {
          return '<tr>' +
            '<td>' + esc(a.username) + '</td>' +
            '<td>' + esc(a.memberName) + '（' + a.memberId + '）</td>' +
            '<td>' + esc(a.lastLoginAt || '—') + '</td>' +
            '<td class="td-no">' + esc(a.lastLoginIp || '—') + '</td>' +
            '<td>' + a.failCount + (a.lockedUntil ? ' <span class="tag tag-warn">锁定至 ' + esc(a.lockedUntil.slice(11, 16)) + '</span>' : '') + '</td>' +
            '<td>' + (a.status ? '是' : '否') + '</td>' +
            '<td>' + (a.effective ? '<span class="tag tag-ok">可用</span>' : '<span class="tag tag-off">不可用</span>') + '</td>' +
            '<td><button class="link" data-a-pw="' + a.id + '">改密码</button>' +
            (a.failCount ? '<button class="link" data-a-reset="' + a.id + '">解锁</button>' : '') +
            '</td></tr>';
        }).join('') : '<tr><td colspan="8">' + emptyHtml({
          t: '该班还没有开通后台账号',
          d: '到「后台账号」页开通后，这里才会出现账号',
          act: { k: 'account-open', label: '去开通' }
        }) + '</td></tr>') +
        '</tbody></table></div>' +
        '<div class="card muted-note">「实际可用」= 后台启用 <strong>且</strong> member 仍是超管且未停用。三者缺一即不能登录 —— 这是防「member 停用后后台仍可进」的关键。</div>';
      $$('[data-a-pw]', host).forEach(function (b) {
        b.onclick = function () { openPwDialog(b.dataset.aPw); };
      });
      $$('[data-a-reset]', host).forEach(function (b) {
        b.onclick = function () {
          api('/api/admin-users/' + b.dataset.aReset, { method: 'POST', body: { resetFail: true } })
            .then(function (r) { toast(r.ok ? '已解锁' : r.errMsg, r.ok ? 'ok' : 'err'); if (r.ok) reload(); });
        };
      });
    });
  }

  /* ---------------- 排班规则（远程配置入口，改它不用重新发版 / 送审小程序） ---------------- */
  var WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  function renderRules(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    api('/api/schedule-rules?classId=' + state.classId).then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var r = d.data || {};
      var wdOpts = WEEKDAY_TEXT.map(function (t, i) {
        return '<option value="' + i + '"' + (Number(r.cronWeekday) === i ? ' selected' : '') + '>' + t + '</option>';
      }).join('');
      host.innerHTML =
        '<div class="card">' +
        '<div class="card-hd">排班规则 · 本班（改这里不用重新发版 / 送审小程序）</div>' +
        '<div style="padding:16px 16px 4px">' +
        '<div class="muted-note" style="padding:0 0 14px">下面这些参数在一键排班、定时自动排班、补录时都会实时读取；改完点保存即刻生效，无需改代码。</div>' +
        fld('补录窗口（天）', '<input type="number" id="r-makeup" min="0" max="60" value="' + (r.makeupDays === 0 ? 0 : (Number(r.makeupDays) || 3)) + '"><div class="muted-note" style="padding:6px 0 0">值日过期后多少天内仍可补录「完成」。原本写死 3 天。</div>') +
        fld('同一人同一天不重复排', '<select id="r-avoid"><option value="1"' + (r.avoidSameDay ? ' selected' : '') + '>开启</option><option value="0"' + (!r.avoidSameDay ? ' selected' : '') + '>关闭</option></select><div class="muted-note" style="padding:6px 0 0">开启后同一天多节课只给同一人排一次。</div>') +
        fld('定时自动排班', '<select id="r-cron"><option value="1"' + (r.cronEnabled ? ' selected' : '') + '>开启</option><option value="0"' + (!r.cronEnabled ? ' selected' : '') + '>关闭</option></select><div class="muted-note" style="padding:6px 0 0">每周到点自动生成下周值日。</div>') +
        fld('自动排班 · 周几', '<select id="r-wd">' + wdOpts + '</select>') +
        fld('自动排班 · 几点', '<input type="number" id="r-hr" min="0" max="23" value="' + (Number(r.cronHour) || 20) + '">') +
        '<div style="padding:2px 0 16px"><button class="btn btn-primary" id="r-save">保存规则</button></div>' +
        '</div></div>' +
        '<div class="card muted-note">' +
        '<strong>另外两处也在后台改、同样无需送审：</strong><br>' +
        '· <strong>谁不参与值日</strong> → 到「成员」页编辑该成员，把「不排值日」设为<strong>是</strong>（写 member.duty_off，一键排班与定时排班都会自动跳过，且不受轮转影响）。<br>' +
        '· <strong>保洁排第几节</strong> → 到「课程表」页编辑保洁课次（kind=CLEAN）的节次即可，算法按课表顺序排，不是写死的。' +
        '</div>';
      $('#r-save', host).onclick = function () {
        var body = {
          classId: state.classId,
          makeupDays: Number($('#r-makeup', host).value),
          avoidSameDay: $('#r-avoid', host).value === '1',
          cronEnabled: $('#r-cron', host).value === '1',
          cronWeekday: Number($('#r-wd', host).value),
          cronHour: Number($('#r-hr', host).value)
        };
        api('/api/schedule-rules', { method: 'POST', body: body }).then(function (res) {
          toast(res.ok ? '已保存，即刻生效' : res.errMsg, res.ok ? 'ok' : 'err');
        });
      };
    });
  }

  function openPwDialog(id) {
    var dlg = document.createElement('div');
    dlg.className = 'dlg-mask';
    dlg.innerHTML = '<div class="dlg"><div class="dlg-hd">修改密码</div><div class="dlg-bd">' +
      '<div class="hint">需输入<strong>当前登录密码</strong>二次确认；改密后该账号全部会话会被踢下线。</div>' +
      fld('当前登录密码', '<input type="password" id="a-cur" autocomplete="current-password">') +
      fld('新密码（至少 8 位）', '<input type="password" id="a-new" autocomplete="new-password">') +
      '</div><div class="dlg-ft"><button class="btn" id="dlg-cancel">取消</button>' +
      '<button class="btn btn-primary" id="dlg-ok">确认修改</button></div></div>';
    document.body.appendChild(dlg);
    $('#dlg-cancel', dlg).onclick = function () { dlg.remove(); };
    $('#dlg-ok', dlg).onclick = function () {
      api('/api/admin-users/' + id, {
        method: 'POST',
        body: { currentPassword: $('#a-cur', dlg).value, newPassword: $('#a-new', dlg).value }
      }).then(function (r) {
        if (!r.ok) { toast(r.errMsg, 'err'); return; }
        dlg.remove(); toast('已修改，请重新登录', 'ok');
        setTimeout(showLogin, 800);
      });
    };
  }

  /* ---------------- 操作审计 ---------------- */
  function renderAudit(host) {
    api('/api/audit?page=' + state.auditPage + '&pageSize=50').then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var r = d.data;
      host.innerHTML = '<div class="card">' +
        '<div class="card-hd">共 ' + r.total + ' 条 · 第 ' + r.page + ' 页</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>时间</th><th>账号</th><th>模块</th><th>动作</th><th>班级</th><th>摘要</th>' +
        '</tr></thead><tbody>' +
        (r.items.length ? r.items.map(function (a) {
          return '<tr>' +
            '<td class="td-no">' + esc(a.createdAt) + '</td>' +
            '<td>' + esc(a.username) + '</td>' +
            '<td>' + esc(a.module) + '</td>' +
            '<td class="td-no">' + esc(a.action) + '</td>' +
            '<td>' + (a.classId || '—') + '</td>' +
            '<td class="td-sum" title="' + esc(a.summary) + '">' + esc(a.summary) + '</td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="6">' + emptyHtml({
          t: '还没有操作记录',
          d: '后台的每次增删改都记在这里，含操作人、时间与 IP'
        }) + '</td></tr>') +
        '</tbody></table></div>';
      pager(r.total, r.page, r.pageSize, function (p) { state.auditPage = p; softReload(); });
    });
  }

  function pager(total, page, pageSize, onGo) {
    // 「全部」（pageSize=0）不分页：除零会得到 Infinity，翻页按钮也会指向不存在的页
    if (!pageSize || pageSize <= 0) return '';
    var pages = Math.max(1, Math.ceil(total / pageSize));
    if (pages <= 1) return '';
    return '<div class="pager">' +
      '<button class="btn" data-pg="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
      '<span>第 ' + page + ' / ' + pages + ' 页</span>' +
      '<button class="btn" data-pg="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>下一页</button>' +
      '</div>';
  }
  /**
   * 空态（2026-11-16 焕新 · 体验规范 E1/E2/E4）
   * 旧写法是一行灰字：'<div class="empty">该班还没有课次，可点右上角「导入课表」</div>'
   *   —— 「没有数据」「怎么做」「点哪里」全糊在一句话里，且**没有出路**；
   *   全站 16 处空态，0 处有行动按钮。
   * 现在三段式：
   *   .empty-t   主语 + 对象（该班还没有课次）
   *   .empty-d   补充说明（导入一份 xlsx 即可生成整周课表）
   *   .empty-act 出路按钮（导入课表）
   * ⚠️ 外层 `.empty` 类名必须保留（旧样式与旧门禁的锚点），只增强内部结构。
   * ⚠️ 文案必须有主语（该班 / 当前筛选 / 你），禁止「暂无数据」这类公文词。
   * @param {object} o
   *   o.t    标题（必填，纯文本，内部会 esc）
   *   o.d    补充说明（可选）
   *   o.act  { k: 动作键, label: 按钮文案, primary: 是否主按钮 }（可选，键见 EMPTY_ACTS）
   *   o.cls  修饰类：'is-filtered'（筛选后为空）/ 'is-forbidden'（无权限）
   */
  function emptyHtml(o) {
    return '<div class="empty' + (o.cls ? ' ' + o.cls : '') + '">' +
      '<div class="empty-t">' + esc(o.t) + '</div>' +
      (o.d ? '<div class="empty-d">' + esc(o.d) + '</div>' : '') +
      (o.act
        ? '<button type="button" class="btn' + (o.act.primary ? ' btn-primary' : '') +
          ' empty-act" data-empty-act="' + o.act.k + '">' + esc(o.act.label) + '</button>'
        : '') +
      '</div>';
  }

  /**
   * 空态行动点：**一次性 document 委托**，不逐处绑定。
   * 为什么不用 $$('[data-empty-act]').forEach(...)：空态会在局部重绘里换掉
   * （成员筛选、使用统计排序都会重写 tbody），逐处绑定漏一个就成死按钮。
   * 动作键里只做「点现有按钮 / 复位现有筛选」，不新增业务逻辑 —— 保持单一真源。
   */
  var EMPTY_ACTS = {
    'timetable-import': function () { var b = $('#btn-import'); if (b) b.click(); },
    'timetable-add': function () { var b = $('#btn-add'); if (b) b.click(); },
    'member-add': function () { var b = $('#btn-add'); if (b) b.click(); },
    'member-clear': function () {
      state.memberKw = ''; state.memberScope = 'ALL'; state.memberPage = 1; softReload();
    },
    'fee-add': function () { var b = $('#fee-add'); if (b) b.click(); },
    /* 「后台账号」页自己的开通按钮（id=acc-open），不是跳到别的页签 */
    'account-add': function () { var b = $('#acc-open'); if (b) b.click(); },
    'usage-reset': function () { state.usageDays = 0; state.usageAll = true; softReload(); },
    /* 系统配置页只能看到账号列表、开不了账号 ⇒ 跳到「后台账号」页 */
    'account-open': function () { go('accounts'); },
    /* 错误态出路：把当前视图重新拉一遍（云函数冷启动/瞬断是一过性的） */
    'retry': function () { reload(); }
  };
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-empty-act]') : null;
    if (!el) return;
    var fn = EMPTY_ACTS[el.getAttribute('data-empty-act')];
    if (fn) { e.preventDefault(); fn(); }
  });

  /**
   * 错误态（2026-11-16 焕新）
   * 旧版返回 `<div class="card empty">` ⇒ 错误与「没有数据」视觉同形，
   * 用户分不清「加载失败」和「就是没数据」（体验规范 P0-1）。
   * 现在用独立的 .err-state：卡片 + 错误色左侧轨 + 错误色文字。
   * ⚠️ 类名 .empty 仍保留在 class 里：旧门禁/旧样式依赖它做居中，
   *    但视觉由 .err-state 接管（见 admin.css 的 .err-state 规则）。
   */
  function errHtml(d) {
    return '<div class="card err-state">' +
      '<div class="err-state-icon" aria-hidden="true"></div>' +
      '<div class="err-state-t">加载失败</div>' +
      '<div class="err-state-msg">' + esc(d.errMsg || '加载失败') + '</div>' +
      /* 光说「失败」是死路一条（体验规范 E5）：云函数冷启动 / 网络瞬断都很常见，
         给一个「重试」把当前视图重新拉一遍，别逼用户自己按 F5。 */
      '<button type="button" class="btn err-state-act" data-empty-act="retry">重试</button>' +
      '</div>';
  }

  /* ---------------- 使用统计（2026-10-16） ---------------- */
  // event → 中文名：页面类来自各页 onShow(pageView)，入口类来自 track.action(key)
  var EVENT_LABEL = {
    home: '首页', mine: '我的', duty: '值日', manual: '手动排班',
    timetable: '课程表', timetable_apply: '调课申请', classes: '班级',
    roster: '名册', notice: '通知', bind: '班级绑定', webview: '网页', doc: '文档',
    fee_open: '班费/团费', notice_open: '打开通知', notice_publish: '发布通知',
    homework_open: '打开作业',
    /* 2026-10-28：首页「作业提交播报」被点开（跳作业页）。
     * 缺这条映射统计页会裸奔成 home_feed_tap，门禁 check-admin-web 会判死。 */
    home_feed_tap: '点开作业播报',
    class_open: '打开班级', roster_open: '打开名册', leave_open: '打开请假',
    /* 1.0.8.32：首页点「关注的学生」就地展开详情（不再跳名册页） */
    pin_open_detail: '查看关注学生详情',
    about: '关于', switch_account: '切换账号', switch_demo: '切换体验版',
    /* 体验版入口（mine 页「更多」）：进入/退出演示态埋点 */
    switch_demo_exit: '切换正式版', demo_back_login: '退出体验版',
    /* 班级切换（classinfo 页切班，ref=班级id）；re_open_class 为旧版遗留事件，库里仍有历史数据 */
    class_switch: '切换班级', re_open_class: '换课'
  };
  /** 事件显示名：fee_open 再按 ref（class|league）细分「班费」「团费」 */
  function eventLabel(r) {
    if (r.event === 'fee_open') {
      if (r.ref === 'league') return '团费';
      if (r.ref === 'class') return '班费';
      return '班费/团费';
    }
    return EVENT_LABEL[r.event] || r.event;
  }
  /** 把后端给的「成员各功能点次」对象渲染成中文标签 + 次数（如「课程表 ×5 · 值日 ×2 · 团费 ×8」） */
  function memberEventCounts(bd) {
    if (!bd || typeof bd !== 'object') return '—';
    var keys = Object.keys(bd);
    if (!keys.length) return '—';
    var items = keys.map(function (k) {
      var i = k.indexOf('/');
      var r = i > 0 ? { event: k.slice(0, i), ref: k.slice(i + 1) } : { event: k };
      return { label: eventLabel(r), cnt: bd[k] };
    });
    items.sort(function (a, b) { return b.cnt - a.cnt; });
    return items.map(function (it) {
      return '<span class="ev-count"><b>' + esc(it.label) + '</b> ×' + esc(it.cnt) + '</span>';
    }).join('');
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function ymd(dt) { return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate()); }

  /**
   * 把「只有有数据的日期」补齐成连续时间轴。
   * 数据库只返回有记录的日期，新站点常只有 1 天数据 ⇒ 柱状图会塌成孤零零一根
   * （2026-10-18 用户反馈「每日活跃总览显示有问题」）。这里按选定范围逐日补 0。
   */
  function buildDailyAxis(days, daily) {
    var map = {};
    (daily || []).forEach(function (x) { map[String(x.d).slice(0, 10)] = x.pv; });
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    var start;
    var end = today;
    // 「昨天」是单日轴：不能沿用 days>0 的「从 N 天前一路补到今天」，
    // 否则点昨天会画出两根柱（昨天 + 今天），与日历日口径不符。
    if (days === -1) { start = yesterday; end = yesterday; }
    else if (days > 0) {
      start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    } else {
      var keys = Object.keys(map).sort();
      if (!keys.length) return [];
      start = new Date(keys[0] + 'T00:00:00');
      if (isNaN(start.getTime())) start = new Date(keys[0]);
      // 「全部」也要有上限，否则跨度一年会挤成一条线
      var span = Math.round((today - start) / 86400000) + 1;
      if (span > 120) start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 119);
    }
    var out = [];
    var cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    while (cur.getTime() <= end.getTime()) {
      var k = ymd(cur);
      out.push({ d: k, pv: map[k] || 0 });
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    return out;
  }

  /* ---------------- 使用统计增强（2026-11-09）：三板块渲染 ----------------
   * 对齐微信「小程序数据助手」的版式，但数据全部来自自建 usage_event 埋点。
   * ⚠️ 口径诚实：微信场景值（任务栏 / 相册等）没有采集，
   *    所以「访问来源」按页面/功能入口展示，卡片上写明以避免误读成官方数据。
   */
  var TREND_METRICS = ['visitUsers', 'opens', 'pageViews'];
  var TREND_METRIC_LABEL = {
    visitUsers: '访问人数', opens: '打开次数', pageViews: '访问页面数'
  };
  var BINARY_METRICS = [
    { key: 'pv', label: '打开次数' }, { key: 'uv', label: '访问人数' }
  ];

  /* ---------------- 使用统计动效（2026-11-09） ----------------
   * 复刻微信「We分析」看板的 hover 预览：悬停出数值浮层 + 垂直准星，移开收起。
   * 只用 transform / opacity 做动画，位置跟随也走 translate3d；
   * 事件委托挂在 #view 上（onmousemove 属性赋值天然幂等），切指标只重绘容器。 */
  var TREND_GEOM = { W: 720, H: 200, padL: 36, padR: 14, padT: 14, padB: 28 };
  /**
   * 趋势折线定义（2026-11-16 焕新）
   * ⚠️ 颜色必须是 **CSS 变量**（SVG 的 stroke 可以直接吃 var()）：
   *    原来写死 '#FF7D00'，而图例用的是 --chart-2（#9A5600 琥珀）⇒
   *    图例显示深橙、折线显示亮橙，同一条线对不上（体验设计师实测发现）。
   *    ⇒ 现在折线与图例共用同一批 --series-* 令牌，全链同源。
   * ⚠️ 三个折线是「今日 / 1 天前 / 7 天前」三档对比，不是分类维度 ——
   *    所以用独立的 --series-today/1d/7d（蓝 / 琥珀 / 绿），不复用状态色。
   */
  var TREND_DEFS = [
    { off: 0, label: '今日', color: 'var(--series-today)' },
    { off: 1, label: '1 天前', color: 'var(--series-1d)' },
    { off: 7, label: '7 天前', color: 'var(--series-7d)' }
  ];
  var tipLastHtml = '';

  function tipRow(color, label, val) {
    return '<div class="insight-tip-r">' +
      (color ? '<i style="background:' + color + '"></i>' : '') +
      '<span>' + esc(label) + '</span><b>' + esc(String(val)) + '</b></div>';
  }

  function showInsightTip(html, ev) {
    var tip = $('#insight-tip');
    if (!tip) return;
    var inner = $('.insight-tip-inner', tip);
    // 内容没变就不重建 DOM：鼠标在同一行内移动时不该让浮层反复闪
    if (inner && html !== tipLastHtml) { inner.innerHTML = html; tipLastHtml = html; }
    var w = tip.offsetWidth || 180, h = tip.offsetHeight || 90;
    var x = Math.max(8, Math.min(ev.clientX + 16, window.innerWidth - w - 10));
    var y = Math.max(8, Math.min(ev.clientY - 10, window.innerHeight - h - 10));
    tip.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    tip.classList.add('is-visible');
    tip.setAttribute('aria-hidden', 'false');
  }

  function hideInsightTip() {
    var tip = $('#insight-tip');
    if (!tip) return;
    tip.classList.remove('is-visible');
    tip.setAttribute('aria-hidden', 'true');
  }

  function clearInsightHover(host) {
    if (!host) return;
    $$('.trend-hover-layer.is-active, .src-row.is-active', host)
      .forEach(function (e) {
        e.classList.remove('is-active');
      });
  }

  function onInsightMove(e, ins, rows) {
    var t = e.target;
    if (!t || !t.closest) { return; }
    var host = $('#view');
    clearInsightHover(host);

    // ① 分时折线：按鼠标 X 换算小时，出「时间段 + 三条系列」预览 + 垂直准星
    var svg = t.closest('.trend-svg');
    if (svg) {
      var r = svg.getBoundingClientRect();
      if (!r.width) { hideInsightTip(); return; }
      var g = TREND_GEOM;
      var vx = (e.clientX - r.left) / r.width * g.W;
      var hh = Math.max(0, Math.min(23, Math.round((vx - g.padL) / (g.W - g.padL - g.padR) * 23)));
      var metric = state.usageTrendMetric;
      var activeDefs, byOff = {};
      if (state.cmpOn && (ins || {}).cmp && ins.cmp.on) {
        // 页面级对比：两条线来自 insights.cmp.a / .b 的 24h 分时
        var segA = ins.cmp.a || {}, segB = ins.cmp.b || {};
        activeDefs = [
          { off: 'A', label: cmpSegLabel(segA), color: 'var(--series-a)' },
          { off: 'B', label: cmpSegLabel(segB), color: 'var(--series-b)' }
        ];
        (segA.hourly || []).forEach(function (row) {
          byOff.A = byOff.A || {};
          byOff.A[Number(row.h)] = Number(row[metric] || 0);
        });
        (segB.hourly || []).forEach(function (row) {
          byOff.B = byOff.B || {};
          byOff.B[Number(row.h)] = Number(row[metric] || 0);
        });
      } else {
        activeDefs = TREND_DEFS;
        ((ins || {}).hourly || []).forEach(function (row) {
          var b = byOff[row.offDay] = byOff[row.offDay] || {};
          b[row.h] = Number(row[metric] || 0);
        });
      }
      var html = '<span class="insight-tip-t">' + esc(pad2(hh) + ':00 - ' + pad2(hh + 1) + ':00') +
        '</span>' + activeDefs.map(function (d) {
          return tipRow(d.color, d.label, (byOff[d.off] || {})[hh] || 0);
        }).join('');
      var layer = $('.trend-hover-layer', svg);
      if (layer) {
        var cx = trendX(hh, g);
        var cross = $('.trend-crosshair', layer);
        if (cross) { cross.setAttribute('x1', cx.toFixed(1)); cross.setAttribute('x2', cx.toFixed(1)); }
        // 曲线无 points 属性：数据点直接用与折线同一套 trendX/trendY 映射算坐标
        var maxVh = 1;
        activeDefs.forEach(function (d) {
          for (var h = 0; h < 24; h++) maxVh = Math.max(maxVh, Number((byOff[d.off] || {})[h] || 0));
        });
        $$('.trend-line', svg).forEach(function (ln) {
          var off = ln.getAttribute('data-off');
          var v = (byOff[off] || {})[hh] || 0;
          var dot = $('.trend-dot[data-off="' + off + '"]', layer);
          if (dot) {
            dot.setAttribute('cx', trendX(hh, g).toFixed(1));
            dot.setAttribute('cy', trendY(v, g, maxVh).toFixed(1));
          }
        });
        layer.classList.add('is-active');
      }
      showInsightTip(html, e);
      return;
    }

    // ② 横条：口径在渲染时算好存 data-tip-*，这里不重算
    var hit = t.closest('[data-tip-kind]');
    if (hit) {
      var kind = hit.getAttribute('data-tip-kind');
      hit.classList.add('is-active');
      showInsightTip('<span class="insight-tip-t">' +
        (kind === 'source' ? '访问来源' : '访问类型') + '</span>' +
        tipRow(hit.getAttribute('data-tip-color') || 'var(--series-7d)',
          hit.getAttribute('data-tip-name') || '', hit.getAttribute('data-tip-val') || '0') +
        tipRow('', '占比', (hit.getAttribute('data-tip-pct') || '0') + '%'), e);
      return;
    }
    hideInsightTip();
  }

  /** 切指标时让新图表轻微淡入（transition 而非 keyframes，快速连点可打断） */
  function swapIn(el, html) {
    if (!el) return;
    el.innerHTML = html;
    el.classList.remove('is-swapped');
    void el.offsetWidth;   // 强制一次样式计算，否则浏览器合并变更、过渡不会触发
    el.classList.add('is-swapped');
  }

  function downloadCsv(filename, head, rows) {
    var q = function (c) {
      var s = String(c == null ? '' : c);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var lines = [head].concat(rows).map(function (r) { return r.map(q).join(','); });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportInsight(kind, ins, rows) {
    var head, body, name;
    ins = ins || {};
    if (kind === 'trend') {
      var m = state.usageTrendMetric;
      if (state.cmpOn && (ins.cmp || {}).on) {
        var cd = [
          { off: 'A', label: cmpSegLabel(ins.cmp.a) },
          { off: 'B', label: cmpSegLabel(ins.cmp.b) }
        ];
        var cby = { A: {}, B: {} };
        ((ins.cmp.a || {}).hourly || []).forEach(function (r) { cby.A[Number(r.h)] = Number(r[m] || 0); });
        ((ins.cmp.b || {}).hourly || []).forEach(function (r) { cby.B[Number(r.h)] = Number(r[m] || 0); });
        head = ['小时'].concat(cd.map(function (d) { return d.label; }));
        body = [];
        for (var h = 0; h < 24; h++) {
          body.push([pad2(h) + ':00'].concat(cd.map(function (d) {
            return cby[d.off][h] || 0;
          })));
        }
        name = '访问实时数据-对比分时.csv';
      } else {
        head = ['小时'].concat(TREND_DEFS.map(function (d) { return d.label; }));
        var byOff = {};
        (ins.hourly || []).forEach(function (r) {
          var b = byOff[r.offDay] = byOff[r.offDay] || {};
          b[r.h] = Number(r[m] || 0);
        });
        body = [];
        for (var h2 = 0; h2 < 24; h2++) {
          body.push([pad2(h2) + ':00'].concat(TREND_DEFS.map(function (d) {
            return (byOff[d.off] || {})[h2] || 0;
          })));
        }
        name = '访问实时数据-分时.csv';
      }
    } else if (kind === 'cmp') {
      var ca = (ins.cmp || {}).a || {}, cb = (ins.cmp || {}).b || {};
      head = ['指标', 'A 段 ' + cmpSegLabel(ca), 'B 段 ' + cmpSegLabel(cb), '差值 (A-B)', '变化率'];
      body = CMP_METRICS.map(function (x) {
        var va = cmpValue(ca, x.key), vb = cmpValue(cb, x.key);
        var d = va - vb;
        var pct = vb ? ((d / vb) * 100).toFixed(2) + '%' : '—';
        return [x.label, fmtCmp(va, x.rate), fmtCmp(vb, x.rate), fmtCmp(d, x.rate), pct];
      });
      name = '使用统计-对比总览.csv';
    } else if (kind === 'source') {
      head = ['页面 / 功能入口', '打开次数 (PV)', '访问人数 (UV)'];
      body = (rows || []).map(function (r) { return [eventLabel(r), r.pv || 0, r.uv || 0]; });
      name = '访问来源Top10.csv';
    } else {
      head = ['指标', '目标日', '前一日', '7 日前'];
      var o = Number(ins.targetOffset || 0), dm = {};
      ((ins.summary || {}).days || []).forEach(function (r) { dm[r.offDay] = r; });
      var z = { visitUsers: 0, opens: 0, pageViews: 0 };
      var d0 = dm[o] || z, d1 = dm[o + 1] || z, d7 = dm[o + 7] || z;
      var cum = (ins.summary || {}).cumulative || {};
      body = [
        ['累计用户数', cum.u0 || 0, cum.u1 || 0, cum.u7 || 0],
        ['日访问人数', d0.visitUsers || 0, d1.visitUsers || 0, d7.visitUsers || 0],
        ['日打开次数', d0.opens || 0, d1.opens || 0, d7.opens || 0],
        ['日访问页面数', d0.pageViews || 0, d1.pageViews || 0, d7.pageViews || 0]
      ];
      name = '小程序活跃概况.csv';
    }
    downloadCsv(name, head, body);
  }

  // 属性前缀含等号和左引号：静态门禁可直接看到控件属性名，不必追函数参数
  var CHIP_ATTRS = { trend: 'data-tm="', source: 'data-sm="' };
  function insightChips(attr, items, cur) {
    return '<div class="metric-chips">' + items.map(function (it) {
      return '<button type="button" class="metric-chip' + (cur === it.key ? ' active' : '') +
        '" ' + attr + esc(it.key) + '">' + esc(it.label) + '</button>';
    }).join('') + '</div>';
  }

  /** 折线坐标映射（trendSvg 与 hover 取点共用同一套，保证数据点落在曲线上） */
  function trendX(h, g) { return g.padL + (g.W - g.padL - g.padR) * (h / 23); }
  function trendY(v, g, maxV) {
    var span = g.H - g.padT - g.padB;
    return g.H - g.padB - span * (v / maxV);
  }
  /** Catmull-Rom → 三次贝塞尔，把「折线」变「平滑曲线」（对齐 We分析 视觉）。
   *  minY 钳制：样条在「0 邻点 + 正邻点」处会向下过冲跌破基线，故所有 y 钳到 ≥ minY，
   *  保证曲线与线下面积永不沉到 0 基准线之下。 */
  function smoothTrendPath(pts, minY) {
    if (pts.length < 2) return '';
    var cy = function (y) { return (minY == null) ? y : Math.min(y, minY); };
    var d = 'M ' + pts[0][0].toFixed(1) + ' ' + cy(pts[0][1]).toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6;
      var c1y = cy(p1[1] + (p2[1] - p0[1]) / 6);
      var c2x = p2[0] - (p3[0] - p1[0]) / 6;
      var c2y = cy(p2[1] - (p3[1] - p1[1]) / 6);
      d += ' C ' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' +
        c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' +
        p2[0].toFixed(1) + ' ' + cy(p2[1]).toFixed(1);
    }
    return d;
  }
  /** 线下渐变面积：平滑曲线顶部 + 封口到基线 */
  function trendAreaPath(pts, baseY, minY) {
    if (pts.length < 2) return '';
    return smoothTrendPath(pts, minY) +
      ' L ' + pts[pts.length - 1][0].toFixed(1) + ' ' + baseY.toFixed(1) +
      ' L ' + pts[0][0].toFixed(1) + ' ' + baseY.toFixed(1) + ' Z';
  }

  /** 分时图网格 + y 轴刻度 + x 轴 24 整点标签（参照 / 对比两模式共用） */
  function trendGridMarkup(g, maxV, baseY) {
    var grid = '';
    for (var gi = 0; gi <= 3; gi++) {
      var gv = Math.round(maxV * gi / 3);
      var gy = trendY(gv, g, maxV);
      grid += '<line x1="' + g.padL + '" y1="' + gy.toFixed(1) + '" x2="' + (g.W - g.padR) +
        '" y2="' + gy.toFixed(1) + '" stroke="var(--line)" stroke-width="1"></line>' +
        '<text x="' + (g.padL - 8) + '" y="' + (gy + 4).toFixed(1) +
        '" text-anchor="end" class="trend-axis-txt">' + gv + '</text>';
    }
    for (var h = 0; h < 24; h++) {
      grid += '<text x="' + trendX(h, g).toFixed(1) + '" y="' + (g.H - 8) +
        '" text-anchor="middle" class="trend-axis-txt trend-axis-x">' + pad2(h) + ':00</text>';
    }
    return grid;
  }
  /** 分时图 hover 层（垂直准星 + 每条线的数据点）；defs 决定准星点数与配色 */
  function trendHoverLayer(g, padT, baseY, defs) {
    return '<g class="trend-hover-layer">' +
      '<line class="trend-crosshair" x1="' + g.padL + '" y1="' + padT + '" x2="' + g.padL +
        '" y2="' + baseY + '"></line>' +
      defs.map(function (d) {
        return '<circle class="trend-dot" data-off="' + d.off + '" cx="' + g.padL +
          '" cy="' + baseY + '" r="3.5" fill="' + d.color + '"></circle>';
      }).join('') + '</g>';
  }

  /** 分时折线：固定今日 / 1 天前 / 7 天前三条，每条 24 个点（00:00~23:00），平滑曲线 + 渐变面积 */
  function trendSvg(ins, metric) {
    var g = TREND_GEOM;
    var W = g.W, H = g.H, padL = g.padL, padR = g.padR, padT = g.padT, padB = g.padB;
    var baseY = H - padB;
    var byOff = {};
    (ins.hourly || []).forEach(function (r) {
      var b = byOff[r.offDay] = byOff[r.offDay] || {};
      b[r.h] = Number(r[metric] || 0);
    });
    var defs = TREND_DEFS;
    var maxV = 1;
    defs.forEach(function (d) {
      for (var h = 0; h < 24; h++) maxV = Math.max(maxV, Number((byOff[d.off] || {})[h] || 0));
    });
    var grid = trendGridMarkup(g, maxV, baseY);
    var grads = '', areas = '', lines = '';
    defs.forEach(function (d) {
      var pts = [];
      for (var h = 0; h < 24; h++) {
        pts.push([trendX(h, g), trendY(Number((byOff[d.off] || {})[h] || 0), g, maxV)]);
      }
      var gid = 'trendGrad' + d.off;
      grads += '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + d.color + '" stop-opacity="0.18"></stop>' +
        '<stop offset="100%" stop-color="' + d.color + '" stop-opacity="0"></stop>' +
        '</linearGradient>';
      areas += '<path class="trend-area" data-off="' + d.off + '" fill="url(#' + gid + ')" stroke="none" d="' +
        trendAreaPath(pts, baseY, baseY) + '"></path>';
      lines += '<path class="trend-line" data-off="' + d.off + '" fill="none" stroke="' + d.color +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="' + smoothTrendPath(pts, baseY) + '"></path>';
    });
    var legend = '<div class="trend-legend">' + defs.map(function (d) {
      return '<span class="trend-lg"><i style="background:' + d.color + '"></i>' + d.label + '</span>';
    }).join('') + '</div>';
    var hoverLayer = trendHoverLayer(g, padT, baseY, defs);
    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="访问实时数据分时趋势">' +
      '<defs>' + grads + '</defs>' + grid + areas + lines + hoverLayer + '</svg>' + legend;
  }

  /** 对比总览指标（渲染表与导出 CSV 共用同一份定义，避免两处口径漂移） */
  var CMP_METRICS = [
    { key: 'pv', label: '总次数', rate: false },
    { key: 'uv', label: '使用人数', rate: false },
    { key: 'perUser', label: '人均次数', rate: true },
    { key: 'perDay', label: '日均次数', rate: true },
    { key: 'pageViews', label: '页面浏览', rate: false },
    { key: 'actions', label: '功能点击', rate: false },
    { key: 'opens', label: '打开次数', rate: false },
    { key: 'evCnt', label: '覆盖功能数', rate: false }
  ];
  /** 取指标值：人均/日均是派生值，其余直接读段聚合 */
  function cmpValue(seg, key) {
    if (!seg) return 0;
    if (key === 'perUser') return seg.uv ? seg.pv / seg.uv : 0;
    if (key === 'perDay') return seg.days ? seg.pv / seg.days : 0;
    return Number(seg[key] || 0);
  }
  /** 对比数值格式：率值保留 1 位小数（人均可能 0.3），计数取整 */
  function fmtCmp(v, rate) {
    return rate ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v));
  }
  /** 对比段标签：单日显示完整日期，区间显示「起 ~ 止」 */
  function cmpSegLabel(seg) {
    if (!seg || !seg.from) return '—';
    return seg.from === seg.to ? seg.from : seg.from + ' ~ ' + seg.to;
  }

  /** 页面级对比的分时叠加：A 段 / B 段各画一条 24h 曲线（区间段为各整点合计） */
  function trendCmpSvg(ins, metric) {
    var g = TREND_GEOM;
    var W = g.W, H = g.H, padL = g.padL, padR = g.padR, padT = g.padT, padB = g.padB;
    var baseY = H - padB;
    var cmp = (ins && ins.cmp) || {};
    var segA = cmp.a || {}, segB = cmp.b || {};
    var defs = [
      { off: 'A', label: cmpSegLabel(segA), color: 'var(--series-a)' },
      { off: 'B', label: cmpSegLabel(segB), color: 'var(--series-b)' }
    ];
    var bySeg = { A: {}, B: {} };
    (segA.hourly || []).forEach(function (r) { bySeg.A[Number(r.h)] = Number(r[metric] || 0); });
    (segB.hourly || []).forEach(function (r) { bySeg.B[Number(r.h)] = Number(r[metric] || 0); });
    var maxV = 1;
    defs.forEach(function (d) {
      for (var h = 0; h < 24; h++) maxV = Math.max(maxV, Number(bySeg[d.off][h] || 0));
    });
    var grid = trendGridMarkup(g, maxV, baseY);
    var grads = '', areas = '', lines = '';
    defs.forEach(function (d) {
      var pts = [];
      for (var h = 0; h < 24; h++) {
        pts.push([trendX(h, g), trendY(Number(bySeg[d.off][h] || 0), g, maxV)]);
      }
      var gid = 'trendGrad' + d.off;
      grads += '<linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + d.color + '" stop-opacity="0.18"></stop>' +
        '<stop offset="100%" stop-color="' + d.color + '" stop-opacity="0"></stop>' +
        '</linearGradient>';
      areas += '<path class="trend-area" data-off="' + d.off + '" fill="url(#' + gid + ')" stroke="none" d="' +
        trendAreaPath(pts, baseY, baseY) + '"></path>';
      lines += '<path class="trend-line" data-off="' + d.off + '" fill="none" stroke="' + d.color +
        '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" d="' + smoothTrendPath(pts, baseY) + '"></path>';
    });
    var legend = '<div class="trend-legend">' + defs.map(function (d) {
      return '<span class="trend-lg"><i style="background:' + d.color + '"></i>' + esc(d.label) + '</span>';
    }).join('') + '</div>';
    var hoverLayer = trendHoverLayer(g, padT, baseY, defs);
    return '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="对比分时趋势">' +
      '<defs>' + grads + '</defs>' + grid + areas + lines + hoverLayer + '</svg>' + legend;
  }

  /** 访问来源 Top10：按页面 / 功能入口的 PV/UV 排横条（非微信场景值） */
  function sourceBars(rows, metric) {
    var list = rows.slice().sort(function (a, b) {
      return Number(b[metric] || 0) - Number(a[metric] || 0);
    }).slice(0, 10);
    if (!list.length) return emptyHtml({
      t: '该班还没有使用记录',
      d: '学生打开小程序的功能页后，这里会按来源排行'
    });
    var total = list.reduce(function (s, r) { return s + Number(r[metric] || 0); }, 0);
    var max = list.reduce(function (m, r) { return Math.max(m, Number(r[metric] || 0)); }, 1);
    return '<div class="src-list">' + list.map(function (r) {
      var v = Number(r[metric] || 0);
      var pct = total ? (v / total * 100).toFixed(2).replace(/\.00$/, '') : '0';
      return '<div class="src-row" data-tip-kind="source" data-tip-name="' + esc(eventLabel(r)) +
        '" data-tip-val="' + v + '" data-tip-pct="' + pct + '" data-tip-color="var(--chart-4)">' +
        '<span class="src-label">' + esc(eventLabel(r)) + '</span>' +
        '<div class="src-track"><div class="src-bar" style="width:' +
          Math.max(2, Math.round(v / max * 100)) + '%"></div></div>' +
        '<span class="src-val">' + v + '</span>' +
        '<span class="src-pct">' + pct + '%</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  /** 变化率：无基数时不编造百分比（如实写「— / 新增」） */
  function deltaHtml(label, cur, base) {
    var txt, cls;
    if (!base) { txt = cur ? '新增' : '—'; cls = 'flat'; }
    else {
      var p = (cur - base) / base * 100;
      txt = (p > 0 ? '+' : '') + p.toFixed(2) + '%';
      cls = p > 0 ? 'up' : (p < 0 ? 'down' : 'flat');
    }
    return '<span class="metric-delta ' + cls + '">' + label + ' ' + txt + '</span>';
  }

  /** 小程序活跃概况：四卡 + 较前一日 / 较 7 日前 */
  function summaryCards(ins) {
    var o = Number(ins.targetOffset || 0);
    var daysMap = {};
    ((ins.summary || {}).days || []).forEach(function (r) { daysMap[r.offDay] = r; });
    var cum = (ins.summary || {}).cumulative || {};
    var zero = { visitUsers: 0, opens: 0, pageViews: 0 };
    var d0 = daysMap[o] || zero, d1 = daysMap[o + 1] || zero, d7 = daysMap[o + 7] || zero;
    var items = [
      { label: '累计用户数', unit: '人', cur: Number(cum.u0 || 0), prev: Number(cum.u1 || 0), d7: Number(cum.u7 || 0) },
      { label: '日访问人数', unit: '人', cur: Number(d0.visitUsers || 0), prev: Number(d1.visitUsers || 0), d7: Number(d7.visitUsers || 0) },
      { label: '日打开次数', unit: '次', cur: Number(d0.opens || 0), prev: Number(d1.opens || 0), d7: Number(d7.opens || 0) },
      { label: '日访问页面数', unit: '个', cur: Number(d0.pageViews || 0), prev: Number(d1.pageViews || 0), d7: Number(d7.pageViews || 0) }
    ];
    return '<div class="metric-grid">' + items.map(function (it) {
      return '<div class="metric-card">' +
        '<div class="metric-label">' + it.label + '</div>' +
        '<div class="metric-value">' + it.cur + '<span class="metric-unit">' + it.unit + '</span></div>' +
        '<div class="metric-cmp">' + deltaHtml('较前一日', it.cur, it.prev) +
          deltaHtml('较 7 日前', it.cur, it.d7) + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  function renderUsage(host) {
    // 统计范围刷新后保留；默认「全部班级」（不分班总览，2026-10-18 用户要求）
    var savedAll = lsGet(LS_USAGE_ALL);
    if (savedAll !== null) state.usageAll = savedAll === '1';
    // 时间范围也持久化（0=全部）。⚠️ 不能用 `!state.usageDays` 判默认值：
    // 0 是 falsy，会把用户点的「全部」当场改回 30（2026-10-18 实反馈：
    // 「点击全部没用，蓝色还在近 30 天上面」）
    var savedDays = lsGet(LS_USAGE_DAYS);
    if (savedDays !== null && savedDays !== '') state.usageDays = Number(savedDays);
    if (typeof state.usageDays !== 'number' || isNaN(state.usageDays)) state.usageDays = 30;
    // 成员排序状态恢复（白名单校验，脏数据回退默认）
    var savedSort = lsGet(LS_MEM_SORT);
    if (savedSort) {
      try {
        var s0 = JSON.parse(savedSort);
        if (s0 && (s0.key === 'pv' || s0.key === 'activeDays' || s0.key === 'lastTs') &&
            (s0.dir === 'asc' || s0.dir === 'desc')) state.memSort = s0;
      } catch (e) { /* 脏数据回退默认 */ }
    }
    /* 页面级对比：恢复开关 / 粒度 / 两段日期。
     *  · 默认值按粒度不同：单日 = 今天 vs 昨天；区间 = 近 7 天 vs 前 7 天；
     *  · 日期一律本地时区算（DB 与浏览器同区），用 ymd() 格式化成 YYYY-MM-DD。 */
    var savedCmpOn = lsGet(LS_CMP_ON);
    if (savedCmpOn !== null) state.cmpOn = savedCmpOn === '1';
    var savedGran = lsGet(LS_CMP_GRAN);
    if (savedGran === 'day' || savedGran === 'range') state.cmpGran = savedGran;
    var _today = new Date();
    var _dayAgo = function (n) {
      return new Date(_today.getFullYear(), _today.getMonth(), _today.getDate() - n);
    };
    var _dA = state.cmpGran === 'range' ? _dayAgo(6) : _today;
    var _dA2 = state.cmpGran === 'range' ? _today : _dA;
    var _dB1 = state.cmpGran === 'range' ? _dayAgo(13) : _dayAgo(1);
    var _dB2 = state.cmpGran === 'range' ? _dayAgo(7) : _dB1;
    state.cmpA1 = lsGet(LS_CMP_A1) || ymd(_dA);
    state.cmpA2 = lsGet(LS_CMP_A2) || ymd(_dA2);
    state.cmpB1 = lsGet(LS_CMP_B1) || ymd(_dB1);
    state.cmpB2 = lsGet(LS_CMP_B2) || ymd(_dB2);
    var days = state.usageDays;
    var classPart = state.usageAll ? '' : '&classId=' + state.classId;
    // 对比参数始终带上：cmpOn=0 时后端不查，但保留日期便于下次开启时直接生效
    var cmpPart = '&cmpOn=' + (state.cmpOn ? '1' : '0') + '&cmpGran=' + state.cmpGran +
      '&cmpA1=' + encodeURIComponent(state.cmpA1) + '&cmpA2=' + encodeURIComponent(state.cmpA2) +
      '&cmpB1=' + encodeURIComponent(state.cmpB1) + '&cmpB2=' + encodeURIComponent(state.cmpB2);
    api('/api/usage?days=' + days + classPart + cmpPart).then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var o = d.data || {};
      var responseInsights = o.insights || {};
      var rows = o.rows || [];

      var rangeBtns = [
        { d: 1, t: '今天' }, { d: -1, t: '昨天' }, { d: 7, t: '近 7 天' },
        { d: 30, t: '近 30 天' }, { d: 0, t: '全部' }
      ].map(function (x) {
        return '<button class="btn' + (days === x.d ? ' btn-primary' : '') +
          '" data-rg="' + x.d + '">' + x.t + '</button>';
      }).join(' ');

      var totalHtml = '<div class="stat-row">' +
        stat('总浏览/点击', o.total ? o.total.pv : 0, '累计次数') +
        stat('总使用人数', o.total ? o.total.uv : 0, '去重成员') +
        '</div>';

      /* 2026-11-11 用户要求：删掉那张「按次数排行的功能/页面表格」。
         它与「访问来源 Top10」读的是同一份 rows（按 event 聚合的埋点），只是换了张表格皮，
         属于重复信息；榜单只保留 Top10 横条，顺带清掉 maxPv / kindLabel 死代码。 */

      var axis = buildDailyAxis(days, (o.trend && o.trend.daily) || []);
      var maxDaily = axis.reduce(function (m, x) { return Math.max(m, x.pv); }, 1);
      // 轴说明：days=0（全部）时不能说「近 30 天」——后端 trend.days 也只是回显值
      // days=1 是「今天」，单独措辞，避免「近 1 天」的别扭说法
      var axisNote = days === -1
        ? '横轴：日期（昨天，每日总次数）'
        : (days === 1
          ? '横轴：日期（今天，每日总次数）'
          : (days
            ? '横轴：日期（近 ' + days + ' 天，每日总次数）'
            : '横轴：日期（全部，每日总次数）'));
      var dailyHtml = '<div class="card card-usage"><div class="card-hd">每日活跃总览（点击/浏览总次数）</div>' +
        (axis.length
          ? '<div class="bars">' + axis.map(function (x) {
              var pct = x.pv > 0 ? Math.max(4, Math.round(x.pv / maxDaily * 100)) : 0;
              // data-tip 走 CSS 气泡即时显示；原生 title 有约 1 秒系统延迟，已弃用
              return '<div class="bar-col' + (x.pv > 0 ? '' : ' is-zero') + '" data-tip="' + esc(x.d) + ' · ' + x.pv + ' 次">' +
                (x.pv > 0 ? '<div class="bar-v" style="height:' + pct + '%"></div>' : '') + '</div>';
            }).join('') + '</div>' +
            '<div class="bars-axis"><span>' + esc(axis[0].d) + '</span>' +
              '<span class="bars-axis-mid">共 ' + axis.length + ' 天</span>' +
              '<span>' + esc(axis[axis.length - 1].d) + '</span></div>' +
            '<div class="muted-note">' + axisNote + '</div>'
          : emptyHtml({
              t: '当前筛选下没有记录',
              d: '换个时间范围，或切回「全部班级」看看',
              cls: 'is-filtered',
              act: { k: 'usage-reset', label: '重置筛选条件' }
            })) +
        '</div>';

      // 成员使用明细：「总使用人数」具体到账号（后端已排除测试账号）。
      // 排序（2026-10-23）：次数/活跃天数/最近活跃三列可排，点击正序、再点倒序，
      // 默认按次数降序；状态持久化（LS_MEM_SORT）。空值（'—'/空）无论方向恒垫底，
      // 方向只翻转非空比较。排序是纯前端本地重绘（数据已全量在客户端，不重拉 API）。
      var members = o.members || [];
      function memIsEmpty(v) { return v == null || v === '' || v === '—'; }
      function memCmpVal(a, b) {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        a = String(a); b = String(b);
        return a < b ? -1 : (a > b ? 1 : 0);
      }
      function sortMembers(list) {
        var key = state.memSort.key, dir = state.memSort.dir;
        return list.slice().sort(function (x, y) {
          var ex = memIsEmpty(x[key]), ey = memIsEmpty(y[key]);
          if (ex && ey) return 0;
          if (ex) return 1;            // 空值恒垫底
          if (ey) return -1;
          var c = memCmpVal(x[key], y[key]);
          return dir === 'asc' ? c : -c;
        });
      }
      function memRowHtml(r) {
        return '<tr>' +
          '<td>' + esc(r.memberName) + (r.studentNo ? '<span class="ev-key">' + esc(r.studentNo) + '</span>' : '') + '</td>' +
          '<td>' + esc(shortClassName(r.className)) + '</td>' +
          '<td class="td-no">' + r.pv + '</td>' +
          '<td class="td-no">' + r.activeDays + '</td>' +
          // ⚠️ .ev-list 是 display:flex，不能直接挂在 <td> 上（flex 覆盖 table-cell
          //    会让该格脱离表格行列对齐，整行错位，2026-10-22 用户反馈），必须包内层 div
          '<td><div class="ev-list">' + memberEventCounts(r.eventsBreakdown) + '</div></td>' +
          '<td class="td-no">' + esc(r.lastTs || '—') + '</td>' +
          '</tr>';
      }
      // 可排序列头：label 用 .th-txt 包裹（applyTableLabels 取它做手机端 data-label，
      // 箭头字符不能混进标签）；箭头只在当前排序列显示 ↑/↓
      function sortTh(key, label) {
        var on = state.memSort.key === key;
        return '<th class="th-sort' + (on ? ' th-sort-on' : '') + '" data-sk="' + key + '">' +
          '<span class="th-txt">' + label + '</span>' +
          '<span class="sort-ind">' + (on ? (state.memSort.dir === 'asc' ? '↑' : '↓') : '') + '</span></th>';
      }
      var memTbl = '<div class="card"><div class="card-hd">成员使用明细（按人，已排除测试账号）</div>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>成员</th><th>班级</th>' +
        sortTh('pv', '次数 (PV)') +
        sortTh('activeDays', '活跃天数') +
        '<th>使用功能（次数）</th>' +
        sortTh('lastTs', '最近活跃') +
        '</tr></thead><tbody data-mem-tbody>' +
        (members.length ? sortMembers(members).map(memRowHtml).join('')
          : '<tr><td colspan="6">' + emptyHtml({
              t: '该班还没有使用记录',
              d: '成员打开小程序后，这里会按人统计次数与活跃天数'
            }) + '</td></tr>') +
        '</tbody></table></div></div>';

      // 班级范围：全部班级 / 仅当前班级（与右上角班级选择器解耦，刷新后保留）
      // ⚠️ 标签不缀具体班名——右上角选择器已经显示当前班，再写一遍是冗余（2026-10-18 用户要求）
      var scopeBtns =
        '<button class="btn' + (state.usageAll ? ' btn-primary' : '') + '" data-ua="1">全部班级</button>' +
        '<button class="btn' + (state.usageAll ? '' : ' btn-primary') + '" data-ua="0">仅当前班级</button>';
      // 页面级对比控件（2026-11-09）：对比的是**整个使用统计**，开关放在工具条，
      // 不再藏在分时卡里。单日模式只显示 A/B 各一个日期；区间模式各显示起止。
      var isRange = state.cmpGran === 'range';
      var rangeCls = isRange ? '' : ' hidden';
      var cmpDatesHtml = '<div class="cmp-dates" data-cmp-dates' + (state.cmpOn ? '' : ' hidden') + '>' +
        '<span class="cmp-tag cmp-tag-a">A</span>' +
        '<input type="date" class="cmp-date" data-cmpk="cmpA1" value="' + esc(state.cmpA1) + '" aria-label="A 段开始日期">' +
        '<span class="cmp-to' + rangeCls + '">~</span>' +
        '<input type="date" class="cmp-date cmp-end' + rangeCls + '" data-cmpk="cmpA2" value="' + esc(state.cmpA2) + '" aria-label="A 段结束日期">' +
        '<span class="cmp-vs">vs</span>' +
        '<span class="cmp-tag cmp-tag-b">B</span>' +
        '<input type="date" class="cmp-date" data-cmpk="cmpB1" value="' + esc(state.cmpB1) + '" aria-label="B 段开始日期">' +
        '<span class="cmp-to' + rangeCls + '">~</span>' +
        '<input type="date" class="cmp-date cmp-end' + rangeCls + '" data-cmpk="cmpB2" value="' + esc(state.cmpB2) + '" aria-label="B 段结束日期">' +
        '</div>';
      var cmpTools = '<div class="usage-cmp">' +
        '<span class="tb-label">对比</span>' +
        '<div class="seg">' +
          '<button type="button" class="seg-btn' + (state.cmpOn ? '' : ' active') + '" data-cmp="0">关闭</button>' +
          '<button type="button" class="seg-btn' + (state.cmpOn ? ' active' : '') + '" data-cmp="1">开启</button>' +
        '</div>' +
        '<div class="seg cmp-gran' + (state.cmpOn ? '' : ' hidden') + '">' +
          '<button type="button" class="seg-btn' + (isRange ? '' : ' active') + '" data-gran="day">单日</button>' +
          '<button type="button" class="seg-btn' + (isRange ? ' active' : '') + '" data-gran="range">区间</button>' +
        '</div>' +
        cmpDatesHtml +
        '</div>';
      // 同一行流式排布：时间范围贴左，班级范围 + 对比靠右连成一串（2026-11-09 用户要求
      // 对比不要单独占一行）；窄屏才自然换行
      var toolbar = '<div class="toolbar toolbar-usage">' +
        '<div class="usage-range"><span class="tb-label">时间范围</span>' + rangeBtns + '</div>' +
        '<div class="usage-scope"><span class="tb-label">班级范围</span>' + scopeBtns + '</div>' +
        cmpTools +
        '</div>';
      // 三板块（2026-11-09）：分时趋势 / 来源 Top10 / 活跃概况。
      // 放在原有统计卡与表格之前，进页面第一屏就能看到概况，下面保留全部明细。
      var ins = responseInsights;
      var trendItems = TREND_METRICS.map(function (k) {
        return { key: k, label: TREND_METRIC_LABEL[k] };
      });
      var cardNote = function (t) { return '<span class="card-hd-note">' + esc(t) + '</span>'; };
      // hover 预览浮层：position:fixed + translate3d，不受 .card 的 overflow:hidden 裁切
      var tipHtml = '<div id="insight-tip" class="insight-tip" role="tooltip" aria-hidden="true">' +
        '<div class="insight-tip-inner"></div></div>';
      // 卡片 0/60/120/180ms 错峰入场；导出按钮默认透明，hover / focus-within 才淡入
      var enterStyle = function (i) { return ' style="--enter-delay:' + (i * 60) + 'ms"'; };
      var cardAction = function (kind) {
        return '<button type="button" class="card-hd-action" data-export="' + kind +
          '" aria-label="导出该板块数据为 CSV" title="导出 CSV">导出</button>';
      };
      var cmpVisible = !!(state.cmpOn && ins.cmp && ins.cmp.on);
      var baseEntry = cmpVisible ? 1 : 0;

      /* 对比总览卡：A 段 / B 段 8 个指标并列 + 差值 + 变化率。
       * 口径与明细表同源（usage_event），但时间段由上方对比控件决定，**不受「时间范围」影响**。 */
      var cmpHtml = '';
      if (cmpVisible) {
        var ca = ins.cmp.a || {}, cb = ins.cmp.b || {};
        var cmpRows = CMP_METRICS.map(function (x) {
          var va = cmpValue(ca, x.key), vb = cmpValue(cb, x.key);
          var diff = va - vb;
          var pctHtml;
          if (!vb) {
            pctHtml = '<span class="cmp-pct flat">' + (va ? '新增' : '—') + '</span>';
          } else {
            var pct = diff / vb * 100;
            pctHtml = '<span class="cmp-pct ' + (diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat')) + '">' +
              (diff > 0 ? '+' : '') + pct.toFixed(1) + '%</span>';
          }
          return '<tr><th>' + esc(x.label) + '</th>' +
            '<td class="td-no">' + fmtCmp(va, x.rate) + '</td>' +
            '<td class="td-no">' + fmtCmp(vb, x.rate) + '</td>' +
            '<td class="td-no">' + (diff > 0 ? '+' : '') + fmtCmp(diff, x.rate) + '</td>' +
            '<td>' + pctHtml + '</td></tr>';
        }).join('');
        cmpHtml = '<div class="card card-insight card-cmp"' + enterStyle(0) + '>' +
          '<div class="card-hd">对比总览' + cardNote(ins.cmp.gran === 'range' ? '时间段对比' : '单日对比') + cardAction('cmp') + '</div>' +
          '<div class="tbl-wrap"><table class="tbl cmp-tbl"><thead><tr>' +
          '<th>指标</th>' +
          '<th><i class="cmp-dot cmp-dot-a"></i>A · ' + esc(cmpSegLabel(ca)) + '</th>' +
          '<th><i class="cmp-dot cmp-dot-b"></i>B · ' + esc(cmpSegLabel(cb)) + '</th>' +
          '<th>差值 (A−B)</th><th>变化</th>' +
          '</tr></thead><tbody>' + cmpRows + '</tbody></table></div>' +
          '<div class="muted-note">A / B 两段同一套埋点口径；下方「分时趋势」同步按这两段画线，' +
            '访问来源与成员明细仍按上方「时间范围」显示。' +
            (ins.cmp.gran === 'range' ? ' 区间模式下分时每点是该时段合计，UV 逐时去重后相加、不等于区间去重人数。' : '') +
          '</div></div>';
      }

      var trendBody = cmpVisible
        ? trendCmpSvg(ins, state.usageTrendMetric)
        : trendSvg(ins, state.usageTrendMetric);
      var realtimeHtml = '<div class="card card-insight"' + enterStyle(baseEntry) + '>' +
        '<div class="card-hd">访问实时数据' + cardNote(cmpVisible
          ? '对比：' + cmpSegLabel(ins.cmp.a) + ' vs ' + cmpSegLabel(ins.cmp.b)
          : '自建埋点 · 今日 / 昨天 / 7 天前') + cardAction('trend') + '</div>' +
        '<div class="insight-tools"><span class="tb-label">指标筛选</span>' +
          insightChips(CHIP_ATTRS.trend, trendItems, state.usageTrendMetric) + '</div>' +
        '<div id="trend-host" class="insight-host is-swapped">' + trendBody + '</div>' +
        '<div class="muted-note">打开次数按「首页浏览」近似统计；访问页面数按页面浏览事件统计' +
          (cmpVisible && ins.cmp.gran === 'range' ? '；区间对比为各整点合计' : '') + '</div>' +
        '</div>';
      var sourceHtml = '<div class="card card-insight"' + enterStyle(baseEntry + 1) + '>' +
        '<div class="card-hd">访问来源 Top10' + cardNote('按页面 / 功能入口') + cardAction('source') + '</div>' +
        '<div class="insight-tools"><span class="tb-label">指标筛选</span>' +
          insightChips(CHIP_ATTRS.source, BINARY_METRICS, state.usageSourceMetric) + '</div>' +
        '<div id="source-host" class="insight-host is-swapped">' + sourceBars(rows, state.usageSourceMetric) + '</div>' +
        '<div class="muted-note">占比按当前指标在该榜内的合计计算；微信场景值（任务栏 / 相册等）未采集</div>' +
        '</div>';
      var summaryHtml = '<div class="card card-insight"' + enterStyle(baseEntry + 2) + '>' +
        '<div class="card-hd">小程序活跃概况' + cardNote(days === -1 ? '目标日：昨天' : '目标日：今天') + cardAction('summary') + '</div>' +
        summaryCards(ins) +
        '<div class="muted-note">累计用户数为截至目标日出现过的去重人数；对比口径为前一日 / 7 日前的同指标</div>' +
        '</div>';

      /* 板块顺序（2026-11-11 用户要求）：总览数字卡置顶，排在「访问实时数据」之上。
         手机 UA 布局（见 admin.css 的 .ua-mobile）：总览 stat-row + 每日活跃图全宽堆叠，
         下面「成员明细」单独成块、成员卡两列并排；重复的功能/页面排行表格已删。 */
      tipLastHtml = '';   // 浮层刚重建，内容缓存必须作废，否则切页回来会是空白
      host.innerHTML = tipHtml + toolbar +
        totalHtml +
        (cmpHtml ? '<div class="insight-grid">' + cmpHtml + '</div>' : '') +
        '<div class="insight-grid">' + realtimeHtml + '</div>' +
        '<div class="insight-grid">' + sourceHtml + '</div>' +
        '<div class="insight-grid">' + summaryHtml + '</div>' +
        '<div class="usage-top">' + dailyHtml + '</div>' +
        '<div class="usage-members">' + memTbl + '</div>';

      /* 事件委托挂在 host（#view）上：切指标只重绘容器、host 本身不换，无需重绑。
         用 onmousemove/onmouseleave 属性赋值，重复 renderUsage 天然幂等，不会叠加监听。 */
      host.onmousemove = function (e) { onInsightMove(e, ins, rows); };
      host.onmouseleave = function () { hideInsightTip(); clearInsightHover(host); };
      $$('[data-export]', host).forEach(function (b) {
        b.onclick = function () {
          try {
            exportInsight(b.getAttribute('data-export'), ins, rows);
            toast('已导出 CSV');
          } catch (err) {
            console.error('[usage-export] 导出失败', err && err.stack || err);
            toast('导出失败，请重试', 'err');
          }
        };
      });

      $$('[data-rg]', host).forEach(function (b) {
        b.onclick = function () {
          state.usageDays = Number(b.dataset.rg);
          lsSet(LS_USAGE_DAYS, String(state.usageDays));
          softReload();
        };
      });
      $$('[data-ua]', host).forEach(function (b) {
        b.onclick = function () {
          state.usageAll = b.dataset.ua === '1';
          lsSet(LS_USAGE_ALL, state.usageAll ? '1' : '0');
          softReload();
        };
      });
      /* 四板块的指标筛选：只换内存状态 + 重绘对应容器，不重拉 /api/usage。
       * 数据一次请求已全部在客户端，重新发请求只会让「切指标」变慢且丢掉当前范围。 */
      function bindMetricChips(attr, stateKey, redraw) {
        $$('[' + attr + ']', host).forEach(function (b) {
          b.onclick = function () {
            state[stateKey] = b.getAttribute(attr);
            $$('[' + attr + ']', host).forEach(function (x) {
              x.classList.toggle('active', x === b);
            });
            redraw();
          };
        });
      }
      bindMetricChips('data-tm', 'usageTrendMetric', function () {
        swapIn($('#trend-host', host), cmpVisible
          ? trendCmpSvg(ins, state.usageTrendMetric)
          : trendSvg(ins, state.usageTrendMetric));
      });
      /* 对比开关 / 粒度 / 日期：三者都会改变后端要查的数据，统一走 reload 重拉。
       * 只本地重绘是不行的——关闭对比时总览卡要整块消失、开启时要新建，靠重渲染最干净。 */
      function syncCmpCtl() {
        $$('[data-cmp]', host).forEach(function (x) {
          x.classList.toggle('active', x.dataset.cmp === (state.cmpOn ? '1' : '0'));
        });
        $$('[data-gran]', host).forEach(function (x) {
          x.classList.toggle('active', x.dataset.gran === state.cmpGran);
        });
        var dates = $('[data-cmp-dates]', host);
        if (dates) dates.classList.toggle('hidden', !state.cmpOn);
        var granBox = $('.cmp-gran', host);
        if (granBox) granBox.classList.toggle('hidden', !state.cmpOn);
        var rg = state.cmpGran === 'range';
        $$('.cmp-end, .cmp-to', host).forEach(function (x) {
          x.classList.toggle('hidden', !rg);
        });
      }
      $$('[data-cmp]', host).forEach(function (b) {
        b.onclick = function () {
          state.cmpOn = b.dataset.cmp === '1';
          lsSet(LS_CMP_ON, state.cmpOn ? '1' : '0');
          syncCmpCtl();
          softReload();
        };
      });
      $$('[data-gran]', host).forEach(function (b) {
        b.onclick = function () {
          var g = b.dataset.gran === 'range' ? 'range' : 'day';
          if (state.cmpGran === g) return;
          state.cmpGran = g;
          lsSet(LS_CMP_GRAN, g);
          // 换粒度后沿用旧日期会拼出「单日却带起止」这种无意义组合，直接换成该粒度的默认段：
          //   单日 = 今天 vs 昨天；区间 = 近 7 天 vs 前 7 天
          var t = new Date();
          var ago = function (n) { return new Date(t.getFullYear(), t.getMonth(), t.getDate() - n); };
          if (g === 'range') {
            state.cmpA1 = ymd(ago(6)); state.cmpA2 = ymd(t);
            state.cmpB1 = ymd(ago(13)); state.cmpB2 = ymd(ago(7));
          } else {
            state.cmpA1 = state.cmpA2 = ymd(t);
            state.cmpB1 = state.cmpB2 = ymd(ago(1));
          }
          lsSet(LS_CMP_A1, state.cmpA1); lsSet(LS_CMP_A2, state.cmpA2);
          lsSet(LS_CMP_B1, state.cmpB1); lsSet(LS_CMP_B2, state.cmpB2);
          syncCmpCtl();
          softReload();
        };
      });
      // 日期变更：单日模式 A2/B2 必须跟着 A1/B1 走（否则后端拿到「单日却带区间止」）；
      // 区间模式起止倒置由后端 parseCmpDate 之后统一纠序，前端不拦。
      $$('.cmp-date', host).forEach(function (inp) {
        inp.onchange = function () {
          var k = inp.dataset.cmpk;
          var lsMap = { cmpA1: LS_CMP_A1, cmpA2: LS_CMP_A2, cmpB1: LS_CMP_B1, cmpB2: LS_CMP_B2 };
          if (!lsMap[k]) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(inp.value)) return;   // 清空 / 半填不发请求
          state[k] = inp.value;
          lsSet(lsMap[k], inp.value);
          if (state.cmpGran !== 'range') {
            if (k === 'cmpA1') { state.cmpA2 = inp.value; lsSet(LS_CMP_A2, inp.value); }
            if (k === 'cmpB1') { state.cmpB2 = inp.value; lsSet(LS_CMP_B2, inp.value); }
          }
          softReload();
        };
      });
      bindMetricChips('data-sm', 'usageSourceMetric', function () {
        swapIn($('#source-host', host), sourceBars(rows, state.usageSourceMetric));
      });
      // 排序点击 → 本地重绘 tbody（不重拉 API）。重绘出的新行必须重新注入
      // data-label：applyTableLabels 用 labelsDone 守卫跳过已处理的表，
      // 不清掉的话重绘出的新行没有 data-label，手机 UA 下卡片字段名会全部丢失。
      var memTbody = $('[data-mem-tbody]', host);
      function redrawMemRows() {
        if (!memTbody) return;
        memTbody.innerHTML = members.length
          ? sortMembers(members).map(memRowHtml).join('')
          : '<tr><td colspan="6">' + emptyHtml({
              t: '该班还没有使用记录',
              d: '成员打开小程序后，这里会按人统计次数与活跃天数'
            }) + '</td></tr>';
        $$('[data-sk]', host).forEach(function (th) {
          var on = th.getAttribute('data-sk') === state.memSort.key;
          th.classList.toggle('th-sort-on', on);
          var ind = $('.sort-ind', th);
          if (ind) ind.textContent = on ? (state.memSort.dir === 'asc' ? '↑' : '↓') : '';
        });
        var memTable = memTbody.closest('.tbl');
        if (memTable && memTable.dataset.labelsDone) {
          delete memTable.dataset.labelsDone;
          applyTableLabels($('#view'));
        }
      }
      $$('[data-sk]', host).forEach(function (th) {
        th.onclick = function () {
          var k = th.getAttribute('data-sk');
          if (state.memSort.key === k) {
            // 同列再点：正序 ↔ 倒序
            state.memSort.dir = state.memSort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            // 换列：先正序
            state.memSort = { key: k, dir: 'asc' };
          }
          lsSet(LS_MEM_SORT, JSON.stringify(state.memSort));
          redrawMemRows();
        };
      });
    });
  }

  /* ---------------- 登录 / 启动 ---------------- */
  // 加载态只在「还没决定显示登录页还是主界面」时存在；
  // 两个分流函数都必须撤掉它，否则刷新后会停在「正在加载…」
  function hideBoot() {
    var b = $('#bootstrap');
    if (b) b.hidden = true;
  }

  function showLogin() {
    state.user = null;
    hideBoot();
    $('#login-view').hidden = false;
    $('#main-view').hidden = true;
    $('#login-password').value = '';
  }

  /**
   * 顶部班级选择器重绘（2026-11-16 抽离）。
   * 🔴 不能只在 showMain() 里画一次：建班 / 软删除班级都会改 state.classes，
   *    如果不同步重绘，会出现「列表已经没了、下拉里还在」——点了就报班级不存在。
   */
  function renderClassPicker() {
    var sel = $('#class-picker');
    if (!sel) return;
    sel.innerHTML = state.classes.map(function (c) {
      // 演示班标注「（演示）」而不是「（停用）」：库里的 is_active=0 是刻意为之，
      // 直接显示「（停用）」会让人以为这个班被误停、进而去「修」它（反而破坏演示隔离）。
      var suffix = c.isDemo ? '（演示）' : (c.isActive ? '' : '（停用）');
      return '<option value="' + c.id + '"' + (c.id === state.classId ? ' selected' : '') + '>' +
        esc(shortClassName(c.name)) + suffix + '</option>';
    }).join('');
    sel.onchange = function () {
      state.classId = Number(sel.value);
      lsSet(LS_CLASS, sel.value);
      // 两个分页游标都要回到第 1 页：新班可能没那么多页，留着旧页码会翻到空页
      state.memberPage = 1;
      state.auditPage = 1;
      // ⚠️ 开着弹层时必须一起撤掉：导入弹层把「目标班级」写死在弹层文字里，
      //    而提交时读的是 state.classId ⇒ 不撤就会出现「看到 A 班、导进 B 班」。
      $$('.dlg-mask').forEach(function (d) { d.remove(); });
      state.importDraft = null;
      // ⚠️ 切班**不要跳回概览页**：切班只改数据范围，不该把人从当前页踢走
      //    （2026-10-10 改：原来一切班就跳概览，在成员/课表页翻班非常难受）
      reload();
      var cls = currentClass();
      // 概览页不显示班级名、数据也跟班级无关 ⇒ 不给提示的话点了像没反应
      if (cls && cls.isDemo) {
        // 演示班在库里是 is_active=0（刻意停用），后台多数接口走 guard.resolveClassId
        // 要求 active=1 ⇒ 会回「班级不存在或已停用」。这属于设计，不是故障：
        // 切过去时直接说明原因，别让人对着一片报错去查后端（2026-11-04 用户提问来源）。
        toast('「' + cls.name + '」是审核体验用的虚拟班，不参与统计、不支持后台修改', 'warn');
      } else if (cls) {
        toast('已切换到「' + cls.name + '」');
      }
    };
  }

  function showMain(me) {
    state.user = me.user;
    state.classes = me.classes || [];
    // 权限必须在渲染任何页面之前写入：renderNav/go 都依赖它
    state.perms = me.perms || [];
    // 刷新后恢复上次选中的班级；该班已不在可选列表（换账号 / 班级停用）则回退第 1 个
    var savedClass = Number(lsGet(LS_CLASS));
    if (savedClass && state.classes.some(function (c) { return c.id === savedClass; })) {
      state.classId = savedClass;
    }
    if (!state.classId || !currentClass()) {
      state.classId = state.classes.length ? state.classes[0].id : null;
    }
    // 顶部班级选择器：登录 / 刷新走这里；建班、删班后由 refreshClasses() 再调一次
    renderClassPicker();
    // 顶栏显示「姓名 · 职位」：后台多人共用时，一眼能确认自己是谁、什么权限
    $('#who').textContent = me.user.memberName +
      (me.user.position ? ' · ' + me.user.position : '') +
      (me.user.isSuper ? ' · 超管' : '') +
      '（' + me.user.username + '）';
    hideBoot();
    $('#login-view').hidden = true;
    $('#main-view').hidden = false;
    // 导航由权限全量重绘（没权限的页签根本不出现，而不是点了报 403）
    renderNav();
    // 刷新后留在上次所在的页，而不是一律跳回概览；但上一个账号的页可能已无权访问
    var savedView = lsGet(LS_VIEW);
    var list = allowedViews();
    go(savedView && canView(savedView) ? savedView : (list[0] || 'overview'));
  }

  function boot() {
    // app.js 能跑到这里，说明脚本本身是好的 ⇒ 撤掉 index.html 里的 5s 兜底定时器
    // （不清的话，极端慢网下它会突然把登录页放出来，盖住正在加载的主界面）
    if (window.__bootTimer) { clearTimeout(window.__bootTimer); window.__bootTimer = null; }

    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = $('#login-btn');
      var err = $('#login-err');
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = '登录中…';
      api('/api/auth/login', {
        method: 'POST',
        body: { username: $('#login-username').value.trim(), password: $('#login-password').value }
      }).then(function (d) {
        btn.disabled = false;
        btn.textContent = '登录';
        if (!d.ok) {
          err.textContent = d.errMsg || '登录失败';
          err.hidden = false;
          return;
        }
        return api('/api/me').then(function (me) {
          if (!me.ok) { err.textContent = me.errMsg; err.hidden = false; return; }
          showMain(me);
        });
      });
    });

    $('#logout-btn').addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' }).then(showLogin);
    });

    // 手机 UA 抽屉菜单：汉堡按钮开/关，遮罩点击关。
    // ⚠️ 版式只认 UA（见 isMobileDevice）：窗口缩窄不再切成桌面版，也不该顺手关掉抽屉。
    var sideEl = $('#side');
    var backdropEl = $('#side-backdrop');
    var menuBtn = $('#menu-btn');
    function closeDrawer() {
      sideEl.classList.remove('open');
      backdropEl.classList.remove('show');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
    function openDrawer() {
      sideEl.classList.add('open');
      backdropEl.classList.add('show');
      menuBtn.setAttribute('aria-expanded', 'true');
    }
    menuBtn.addEventListener('click', function () {
      sideEl.classList.contains('open') ? closeDrawer() : openDrawer();
    });
    backdropEl.addEventListener('click', closeDrawer);
    window.addEventListener('resize', function () {
      if (!isMobileDevice()) closeDrawer();
    });

    $('#nav').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-item');
      if (b) { go(b.dataset.view); closeDrawer(); }
    });

    // 手机版表格卡片化：自动给每个 <td> 注入 data-label（取对应 <th> 文本），
    // 配合 .ua-mobile 的 CSS 把表格渲染成「每行一张卡片」。用 MutationObserver 覆盖所有
    // 异步渲染的表格，无需逐个视图改模板（2026-10-22 重设计；2026-11-11 改按 UA 生效）。
    function applyTableLabels(root) {
      $$('.tbl', root).forEach(function (tbl) {
        if (tbl.dataset.labelsDone) return;
        // 给表格的外层 .card 补 card-tbl：手机 UA 下该卡退化为透明标题区，
        // 否则白卡叠白卡在 12px 间隙里闭合成「空矩形」，卡片看不出分开（2026-10-22 修）
        var card = tbl.closest('.card');
        if (card && isMobileDevice()) card.classList.add('card-tbl');
        var ths = tbl.querySelectorAll('thead th');
        // 🔴 必须按行遍历、行内按列号对位——querySelectorAll('tbody td') 是跨行
        //    连续编号，直接用全局下标会让第 2 行起 ths[i] 越界、标签全部丢失
        //    （2026-10-22 无头渲染实测抓到）。
        tbl.querySelectorAll('tbody tr').forEach(function (tr) {
          Array.prototype.forEach.call(tr.children, function (td, col) {
            if (td.hasAttribute('colspan')) return;          // 跳过「暂无记录」等合并单元格
            var th = ths[col];
            if (!th) return;
            td.setAttribute('data-label', ((th.querySelector('.th-txt') || th).textContent || '').trim());
            if (td.querySelector('.ev-list')) td.classList.add('ev-cell');
          });
        });
        tbl.dataset.labelsDone = '1';
      });
    }
    var viewEl = $('#view');
    if (viewEl && 'MutationObserver' in window) {
      new MutationObserver(function () { applyTableLabels(viewEl); })
        .observe(viewEl, { childList: true, subtree: true });
    }
    applyTableLabels(viewEl);

    // 已有会话就直接进（刷新页面不该要求重登）
    api('/api/me').then(function (me) {
      if (me.ok) showMain(me);
      else showLogin();
    });
  }

  // 分页按钮统一代理（渲染时不用逐个绑定）
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-pg]');
    if (!b || b.disabled) return;
    if (state.view === 'member') { state.memberPage = Number(b.dataset.pg); softReload(); }
    else if (state.view === 'audit') { state.auditPage = Number(b.dataset.pg); softReload(); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();