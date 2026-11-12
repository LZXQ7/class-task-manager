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

  /* ---------------- 视图切换 ---------------- */
  var VIEWS = {
    overview:  { title: '概览',   render: renderOverview },
    timetable: { title: '课程表', render: renderTimetable },
    member:    { title: '成员',   render: renderMember },
    class:     { title: '账号班级', render: renderClass },
    config:    { title: '系统配置', render: renderConfig },
    audit:     { title: '操作审计', render: renderAudit },
    leave:     { title: '请假',     render: renderLeave },
    usage:     { title: '使用统计', render: renderUsage },
    rules:     { title: '排班规则', render: renderRules }
  };

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
    state.view = view;
    lsSet(LS_VIEW, view);
    $$('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    $('#page-title').textContent = (VIEWS[view] || {}).title || '';
    var host = $('#view');
    host.innerHTML = '<div class="loading">加载中…</div>';
    // 切视图时先清空旧内容，否则上一次的数据会短暂留在新页面上（串页）
    VIEWS[view].render(host);
  }

  function reload() { go(state.view); }

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
        // 选中的班可能已被停用/删除 ⇒ 兜底选第一个可用班
        if (!currentClass()) state.classId = state.classes.length ? state.classes[0].id : null;
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

  function stat(label, value, hint) {
    return '<div class="stat"><div class="stat-value">' + value + '</div>' +
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
          (rows.length ? '' : '<div class="empty">该班还没有课次，可点右上角「导入课表」</div>') +
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
      b.onclick = function () { state.group = b.dataset.group; reload(); };
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

    $commit.onclick = function () {
      var body = state.importDraft;
      if (!body) { toast('请先解析课表来源', 'err'); return; }
      if (!confirm('即将覆盖 ' + cls.name + ' 的 ' + body.groupScope +
        ' 组全部课程课次。\n系统会自动建备份表，仍建议先核对上方预览。\n\n确认继续？')) return;
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
    $('#c-confirm', dlg).onclick = function () {
      var g = sel.value;
      var scopeText = g === 'ALL' ? '全部课程课次（含全体课）' : g + ' 组课程课次';
      if (!confirm('即将清空 ' + cls.name + ' 的 ' + scopeText +
          '。\n系统会先自动备份，仍建议先核对上方预览。\n\n确认继续？')) return;
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
          '<div class="toolbar-right"><button class="btn" id="lv-refresh">刷新</button></div>' +
          '</div>' +
          '<div class="card">' +
          '<div class="card-hd">请假列表 · 共 ' + rows.length + ' 条</div>' +
          (rows.length ? '' : '<div class="empty">该班暂无请假记录</div>') +
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
              '<td class="td-ops"><button class="link" data-edit-leave="' + r.id + '">编辑</button></td>' +
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

  /** 删课次：课次是「所有周共用」的一行，删它 = 删掉这门课在这个时段的所有周 */
  function removeSession(id, name, when) {
    if (!confirm(
      '确认删除课次「' + name + '」（' + when + '）？\n\n' +
      '· 这是所有周共用的一行，删除后这门课在该时段**所有周**都不再排班；\n' +
      '· 未来的值日安排会一并清掉（已过去的值日记录保留）；\n' +
      '· 该班已发布周次会全部退回草稿，需在小程序端重新发布。\n\n' +
      '删除前会自动备份，可在审计日志里查到批次号。')) return;
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
        '<button class="btn btn-primary" id="btn-add">新增成员</button>' +
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
            '<button class="link" data-m-edit="' + m.id + '">编辑</button>' +
            '<button class="link" data-m-super="' + m.id + '" data-v="' + (m.isSuper ? 0 : 1) + '">' +
              (m.isSuper ? '取消超管' : '设为超管') + '</button>' +
            '<button class="link link-danger" data-m-del="' + m.id + '">删除</button>' +
            '</td></tr>';
        }).join('') : '<tr><td colspan="9" class="empty">' +
          (state.memberKw || state.memberScope !== 'ALL' ? '当前筛选下没有成员' : '该班还没有成员') + '</td></tr>') +
        '</tbody></table></div>' +
        (state.memberPageSize === 0 ? '' :
          pager(r.total, r.page, r.pageSize, function (p) { state.memberPage = p; reload(); }));

      $('#btn-add', host).onclick = function () { openMemberDialog(null); };
      var kw = $('#m-kw', host);
      // 搜索是筛选的一部分：真正重渲染列表（原来只弹「找到 N 人」却不改表格）。
      // 与作用域 / 关键词叠加，且回车后回第 1 页；不用 input 即时刷，避免打字被 reload 打断焦点。
      function applyKw() {
        state.memberKw = kw.value.trim();
        state.memberPage = 1;
        reload();
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
          reload();
        };
      });
      $('#m-size', host).onchange = function () {
        state.memberPageSize = Number(this.value);
        state.memberPage = 1;
        reload();
      };
      $$('[data-m-edit]', host).forEach(function (b) {
        b.onclick = function () { openMemberDialog(Number(b.dataset.mEdit)); };
      });
      $$('[data-m-super]', host).forEach(function (b) {
        b.onclick = function () {
          var on = b.dataset.v === '1';
          if (!confirm(on ? '确认设为超级管理员？\n该成员将立即拥有后台登录资格。' : '确认取消超级管理员？')) return;
          api('/api/members/' + b.dataset.mSuper, { method: 'POST', body: { __action: 'setSuper', isSuper: on } })
            .then(function (r) { toast(r.ok ? '已更新' : r.errMsg, r.ok ? 'ok' : 'err'); if (r.ok) reload(); });
        };
      });
      $$('[data-m-del]', host).forEach(function (b) {
        b.onclick = function () {
          if (!confirm('确认删除该成员？\n有值日或请假历史的成员不可删除，系统会改为提示停用。')) return;
          api('/api/members/' + b.dataset.mDel, { method: 'POST', body: { __action: 'remove' } })
            .then(function (r) {
              if (!r.ok) { toast(r.errMsg, 'err'); return; }
              if (r.data.blocked) { toast(r.data.suggestion, 'err'); return; }
              toast('已删除', 'ok'); reload();
            });
        };
      });
    });
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
      host.innerHTML = '<div class="card">' +
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
            '<td><button class="link" data-c-edit="' + c.id + '">配置</button></td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="card muted-note">敏感字段（学期、周数、绑定开关、大节时间）仅超级管理员可改 —— 后台使用者本就限定为超管。</div>';
      $$('[data-c-edit]', host).forEach(function (b) {
        b.onclick = function () { openClassDialog(Number(b.dataset.cEdit)); };
      });
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
        }).join('') : '<tr><td colspan="8" class="empty">还没有后台账号</td></tr>') +
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
        }).join('') : '<tr><td colspan="6" class="empty">暂无操作记录</td></tr>') +
        '</tbody></table></div>';
      pager(r.total, r.page, r.pageSize, function (p) { state.auditPage = p; reload(); });
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
  function errHtml(d) {
    return '<div class="card empty">' + esc(d.errMsg || '加载失败') + '</div>';
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
  var TREND_DEFS = [
    { off: 0, label: '今日', color: '#3370FF' },
    { off: 1, label: '1 天前', color: '#FF7D00' },
    { off: 7, label: '7 天前', color: '#00B42A' }
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
          { off: 'A', label: cmpSegLabel(segA), color: '#3370FF' },
          { off: 'B', label: cmpSegLabel(segB), color: '#FF7D00' }
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
        tipRow(hit.getAttribute('data-tip-color') || '#00B42A',
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
      { off: 'A', label: cmpSegLabel(segA), color: '#3370FF' },
      { off: 'B', label: cmpSegLabel(segB), color: '#FF7D00' }
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
    if (!list.length) return '<div class="empty">暂无使用记录</div>';
    var total = list.reduce(function (s, r) { return s + Number(r[metric] || 0); }, 0);
    var max = list.reduce(function (m, r) { return Math.max(m, Number(r[metric] || 0)); }, 1);
    return '<div class="src-list">' + list.map(function (r) {
      var v = Number(r[metric] || 0);
      var pct = total ? (v / total * 100).toFixed(2).replace(/\.00$/, '') : '0';
      return '<div class="src-row" data-tip-kind="source" data-tip-name="' + esc(eventLabel(r)) +
        '" data-tip-val="' + v + '" data-tip-pct="' + pct + '" data-tip-color="#00B42A">' +
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
          : '<div class="empty">暂无数据</div>') +
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
          : '<tr><td colspan="6" class="empty">暂无使用记录</td></tr>') +
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
          reload();
        };
      });
      $$('[data-ua]', host).forEach(function (b) {
        b.onclick = function () {
          state.usageAll = b.dataset.ua === '1';
          lsSet(LS_USAGE_ALL, state.usageAll ? '1' : '0');
          reload();
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
          reload();
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
          reload();
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
          reload();
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
          : '<tr><td colspan="6" class="empty">暂无使用记录</td></tr>';
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

  function showMain(me) {
    state.user = me.user;
    state.classes = me.classes || [];
    // 刷新后恢复上次选中的班级；该班已不在可选列表（换账号 / 班级停用）则回退第 1 个
    var savedClass = Number(lsGet(LS_CLASS));
    if (savedClass && state.classes.some(function (c) { return c.id === savedClass; })) {
      state.classId = savedClass;
    }
    if (!state.classId || !currentClass()) {
      state.classId = state.classes.length ? state.classes[0].id : null;
    }
    var sel = $('#class-picker');
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
    $('#who').textContent = me.user.memberName + '（' + me.user.username + '）';
    hideBoot();
    $('#login-view').hidden = true;
    $('#main-view').hidden = false;
    // 刷新后留在上次所在的页，而不是一律跳回概览
    var savedView = lsGet(LS_VIEW);
    go(savedView && VIEWS[savedView] ? savedView : 'overview');
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
    if (state.view === 'member') { state.memberPage = Number(b.dataset.pg); reload(); }
    else if (state.view === 'audit') { state.auditPage = Number(b.dataset.pg); reload(); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();