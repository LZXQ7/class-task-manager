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
    // 课表导入：解析结果暂存，确认时才提交
    importDraft: null,
    memberPage: 1,
    auditPage: 1,
    group: 'ALL',
    leaveStatus: 'ALL',
    leaveKw: '',
    bindingFilter: 'all'
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2600);
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
    binding:   { title: '绑定',     render: renderBinding },
    usage:     { title: '使用统计', render: renderUsage }
  };

  /* ---------------- 刷新后恢复现场（2026-10-18 用户要求） ----------------
   * F5 刷新后不要跳回概览、也不要每次重置到第 1 个班：把当前 view / classId /
   * 统计范围落 localStorage，下次启动读回来。
   * 包 try/catch：门禁 mock 环境没有 localStorage，隐私模式下 setItem 会抛。 */
  var LS_VIEW = 'admin.web.view';
  var LS_CLASS = 'admin.web.classId';
  var LS_USAGE_ALL = 'admin.web.usageAll';
  var LS_USAGE_DAYS = 'admin.web.usageDays';
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
        stat('值日记录', o.classes.reduce(function (n, c) { return n + c.dutyCount; }, 0), '累计') +
        '</div>' +
        '<div class="card">' +
        '<div class="card-hd">各班规模</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>班级</th><th>成员</th><th>已绑定</th><th>课程课次</th><th>值日记录</th><th>总周数</th><th>状态</th>' +
        '</tr></thead><tbody>' +
        o.classes.map(function (c) {
          return '<tr>' +
            '<td>' + esc(c.name) + '</td>' +
            '<td>' + c.memberCount + '</td>' +
            '<td>' + c.boundCount + ' / ' + c.memberCount + '</td>' +
            '<td>' + c.sessionCount + '</td>' +
            '<td>' + c.dutyCount + '</td>' +
            '<td>' + c.totalWeeks + '</td>' +
            '<td>' + (c.isActive ? '<span class="tag tag-ok">启用</span>' : '<span class="tag tag-off">停用</span>') + '</td>' +
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

  /* ---------------- 绑定情况 ---------------- */
  // 只读视图：展示当前班级每位成员的微信绑定状态（已绑定 / 未绑定），
  // 顶部给出「本班 X 人，已绑定 Y 人，绑定率 Z%」汇总，并提供 全部/已绑定/未绑定 筛选。
  // 绑定数据复用 /api/members 的 bound 字段，筛选在前端做（班级人数通常 < 200，一次拉全）。
  function renderBinding(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    var cls = currentClass();
    var filter = state.bindingFilter;

    function load() {
      api('/api/members?classId=' + state.classId + '&page=1&pageSize=300').then(function (d) {
        if (!d.ok) { host.innerHTML = errHtml(d); return; }
        var all = d.data.items;
        var total = d.data.total;
        var bound = all.filter(function (m) { return m.bound; }).length;
        var rate = total ? Math.round(bound / total * 100) : 0;
        var view = all.filter(function (m) {
          if (filter === 'bound') return m.bound;
          if (filter === 'unbound') return !m.bound;
          return true;
        });
        host.innerHTML =
          '<div class="toolbar">' +
          '<select id="bd-filter" class="input-search">' +
          '<option value="all">全部</option>' +
          '<option value="bound">已绑定</option>' +
          '<option value="unbound">未绑定</option>' +
          '</select>' +
          '<div class="toolbar-right"><button class="btn" id="bd-refresh">刷新</button></div>' +
          '</div>' +
          '<div class="card">' +
          '<div class="card-hd">' + esc(cls ? cls.name : '') + ' · 绑定情况</div>' +
          '<div class="summary">本班共 ' + total + ' 人，已绑定微信 ' + bound + ' 人，绑定率 ' + rate + '%</div>' +
          (total ? '' : '<div class="empty">该班还没有成员</div>') +
          '<table class="tbl"><thead><tr>' +
          '<th>学号</th><th>姓名</th><th>分组</th><th>绑定状态</th><th>成员状态</th>' +
          '</tr></thead><tbody>' +
          view.map(function (m) {
            return '<tr>' +
              '<td class="td-no">' + esc(m.studentNo) + '</td>' +
              '<td>' + esc(m.name) + (m.isSuper ? ' <span class="tag tag-super">超管</span>' : '') + '</td>' +
              '<td>' + (m.groupTag === 'X' ? '—' : m.groupTag + ' 组') + '</td>' +
              '<td>' + (m.bound ? '<span class="tag tag-ok">已绑定</span>' : '<span class="tag tag-off">未绑定</span>') + '</td>' +
              '<td>' + statusTag(m.status) + '</td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div>';
        var sf = $('#bd-filter', host);
        if (sf) {
          sf.value = filter;
          sf.onchange = function () { state.bindingFilter = sf.value; filter = sf.value; load(); };
        }
        var rf = $('#bd-refresh', host);
        if (rf) rf.onclick = function () { load(); };
      });
    }
    load();
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
              '<td>' + esc(r.name) +
              ' <span class="muted-note">' + esc(r.studentNo || '') +
              (r.groupTag && r.groupTag !== 'X' ? ' · ' + esc(r.groupTag) + ' 组' : '') + '</span></td>' +
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
  function renderMember(host) {
    if (!state.classId) { host.innerHTML = errHtml({ errMsg: '请先在右上角选择班级' }); return; }
    var qs = '?classId=' + state.classId + '&page=' + state.memberPage + '&pageSize=50';
    api('/api/members' + qs).then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var r = d.data;
      host.innerHTML =
        '<div class="toolbar">' +
        '<input type="search" id="m-kw" class="input-search" placeholder="搜索姓名或学号">' +
        '<div class="toolbar-right">' +
        '<button class="btn btn-primary" id="btn-add">新增成员</button>' +
        '</div></div>' +
        '<div class="card">' +
        '<div class="card-hd">共 ' + r.total + ' 人（不含测试账号）· 第 ' + r.page + ' 页</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>学号</th><th>姓名</th><th>分组</th><th>角色</th><th>职位</th><th>状态</th><th>值日数</th><th>操作</th>' +
        '</tr></thead><tbody>' +
        (r.items.length ? r.items.map(function (m) {
          return '<tr>' +
            '<td class="td-no">' + esc(m.studentNo) + '</td>' +
            '<td>' + esc(m.name) + (m.isSuper ? ' <span class="tag tag-super">超管</span>' : '') + '</td>' +
            '<td>' + (m.groupTag === 'X' ? '—' : m.groupTag + ' 组') + '</td>' +
            '<td>' + roleText(m.role) + '</td>' +
            '<td>' + esc(m.position || '—') + '</td>' +
            '<td>' + statusTag(m.status) + '</td>' +
            // duty_off（不排值日）必须在列表可见：值日是本小程序的核心业务，
            // 「这个人不参与排班」只藏在编辑弹层里的话，管理员在排班视图根本看不出来。
            '<td>' + m.dutyCount + (m.dutyOff ? ' <span class="tag tag-warn">不排值日</span>' : '') + '</td>' +
            '<td class="td-ops">' +
            '<button class="link" data-m-edit="' + m.id + '">编辑</button>' +
            '<button class="link" data-m-super="' + m.id + '" data-v="' + (m.isSuper ? 0 : 1) + '">' +
              (m.isSuper ? '取消超管' : '设为超管') + '</button>' +
            '<button class="link link-danger" data-m-del="' + m.id + '">删除</button>' +
            '</td></tr>';
        }).join('') : '<tr><td colspan="8" class="empty">该班还没有成员</td></tr>') +
        '</tbody></table></div>' +
        pager(r.total, r.page, r.pageSize, function (p) { state.memberPage = p; reload(); });

      $('#btn-add', host).onclick = function () { openMemberDialog(null); };
      var kw = $('#m-kw', host);
      kw.onkeydown = function (e) {
        if (e.key !== 'Enter') return;
        var v = kw.value.trim();
        api('/api/members?classId=' + state.classId + '&page=1&pageSize=50' +
          (v ? '&keyword=' + encodeURIComponent(v) : '')).then(function (r) {
          if (!r.ok) { toast(r.errMsg, 'err'); return; }
          toast('找到 ' + r.data.total + ' 人');
        });
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
        '<option value="1"' + (m.dutyOff ? ' selected' : '') + '>是（不排值日）</option></select>');
  }
  function readMemberForm(dlg) {
    return {
      name: $('#f-name', dlg).value.trim(),
      studentNo: $('#f-no', dlg).value.trim(),
      groupTag: $('#f-group', dlg).value,
      role: $('#f-role', dlg).value,
      position: $('#f-position', dlg).value.trim(),
      status: $('#f-status', dlg).value,
      dutyOff: $('#f-dutyoff', dlg).value === '1'
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
            '<td>' + esc(c.name) + '</td>' +
            '<td>' + c.memberCount + '</td>' +
            '<td>' + (c.mainRoom ? esc(c.mainRoom) : '<span class="muted-note">未设</span>') + '</td>' +
            '<td>' + esc(c.termStart) + '</td>' +
            '<td>' + c.totalWeeks + '</td>' +
            '<td class="td-no">' + esc(c.joinToken) + '</td>' +
            '<td class="td-no">' + esc(c.inviteCode) + '</td>' +
            '<td>' + (c.bindOpen ? '<span class="tag tag-ok">开</span>' : '<span class="tag tag-off">关</span>') + '</td>' +
            '<td>' + (c.isActive ? '<span class="tag tag-ok">启用</span>' : '<span class="tag tag-off">停用</span>') + '</td>' +
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
    class_open: '打开班级', roster_open: '打开名册', leave_open: '打开请假',
    about: '关于', switch_account: '切换账号'
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
  /** 把后端 GROUP_CONCAT 的 "event/ref" 串转成中文名列表（如「首页、班费」） */
  function labelEvents(csv) {
    if (!csv) return '—';
    var keys = String(csv).split(',');
    var names = keys.map(function (k) {
      var i = k.indexOf('/');
      if (i > 0) return eventLabel({ event: k.slice(0, i), ref: k.slice(i + 1) });
      return eventLabel({ event: k });
    });
    return esc(names.join('、'));
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
    var start;
    if (days > 0) {
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
    while (cur.getTime() <= today.getTime()) {
      var k = ymd(cur);
      out.push({ d: k, pv: map[k] || 0 });
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    return out;
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
    var days = state.usageDays;
    var classPart = state.usageAll ? '' : '&classId=' + state.classId;
    api('/api/usage?days=' + days + classPart).then(function (d) {
      if (!d.ok) { host.innerHTML = errHtml(d); return; }
      var o = d.data || {};
      var rows = o.rows || [];
      var maxPv = rows.reduce(function (m, r) { return Math.max(m, r.pv); }, 1);
      var kindLabel = { page_view: '页面浏览', action: '功能点击' };

      var rangeBtns = [
        { d: 7, t: '近 7 天' }, { d: 30, t: '近 30 天' }, { d: 0, t: '全部' }
      ].map(function (x) {
        return '<button class="btn' + (days === x.d ? ' btn-primary' : '') +
          '" data-rg="' + x.d + '">' + x.t + '</button>';
      }).join(' ');

      var totalHtml = '<div class="stat-row">' +
        stat('总浏览/点击', o.total ? o.total.pv : 0, '累计次数') +
        stat('总使用人数', o.total ? o.total.uv : 0, '去重成员') +
        '</div>';

      var tbl = '<div class="card"><div class="card-hd">功能使用情况排行（按次数）</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>功能 / 页面</th><th>类型</th><th>次数 (PV)</th><th>人数 (UV)</th><th>最近活跃</th>' +
        '</tr></thead><tbody>' +
        (rows.length ? rows.map(function (r) {
          var pct = Math.max(2, Math.round(r.pv / maxPv * 100));
          return '<tr>' +
            '<td><span class="ev-name">' + esc(eventLabel(r)) + '</span>' +
              '<span class="ev-key">' + esc(r.event) + (r.ref ? '/' + esc(r.ref) : '') + '</span></td>' +
            '<td>' + (kindLabel[r.kind] || esc(r.kind)) + '</td>' +
            '<td class="td-no">' + r.pv + '<span class="pv-bar" style="width:' + pct + '%"></span></td>' +
            '<td class="td-no">' + r.uv + '</td>' +
            '<td class="td-no">' + esc(r.lastTs || '—') + '</td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="5" class="empty">暂无使用记录</td></tr>') +
        '</tbody></table></div>';

      var axis = buildDailyAxis(days, (o.trend && o.trend.daily) || []);
      var maxDaily = axis.reduce(function (m, x) { return Math.max(m, x.pv); }, 1);
      // 轴说明：days=0（全部）时不能说「近 30 天」——后端 trend.days 也只是回显值
      var axisNote = days
        ? '横轴：日期（近 ' + days + ' 天，每日总次数）'
        : '横轴：日期（全部，每日总次数）';
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

      // 成员使用明细：「总使用人数」具体到账号（后端已排除测试账号）
      var members = o.members || [];
      var memTbl = '<div class="card"><div class="card-hd">成员使用明细（按人，已排除测试账号）</div>' +
        '<table class="tbl"><thead><tr>' +
        '<th>成员</th><th>班级</th><th>次数 (PV)</th><th>活跃天数</th><th>用过哪些功能</th><th>最近活跃</th>' +
        '</tr></thead><tbody>' +
        (members.length ? members.map(function (r) {
          return '<tr>' +
            '<td>' + esc(r.memberName) + (r.studentNo ? '<span class="ev-key">' + esc(r.studentNo) + '</span>' : '') + '</td>' +
            '<td>' + esc(r.className) + '</td>' +
            '<td class="td-no">' + r.pv + '</td>' +
            '<td class="td-no">' + r.activeDays + '</td>' +
            '<td class="ev-list">' + labelEvents(r.events) + '</td>' +
            '<td class="td-no">' + esc(r.lastTs || '—') + '</td>' +
            '</tr>';
        }).join('') : '<tr><td colspan="6" class="empty">暂无使用记录</td></tr>') +
        '</tbody></table></div>';

      // 班级范围：全部班级 / 仅当前班级（与右上角班级选择器解耦，刷新后保留）
      // ⚠️ 标签不缀具体班名——右上角选择器已经显示当前班，再写一遍是冗余（2026-10-18 用户要求）
      var scopeBtns =
        '<button class="btn' + (state.usageAll ? ' btn-primary' : '') + '" data-ua="1">全部班级</button>' +
        '<button class="btn' + (state.usageAll ? '' : ' btn-primary') + '" data-ua="0">仅当前班级</button>';
      // 左右布局：时间范围在左、班级范围在右（同一行，窄屏才换行）
      var toolbar = '<div class="toolbar toolbar-usage">' +
        '<div class="usage-range"><span class="tb-label">时间范围</span>' + rangeBtns + '</div>' +
        '<div class="usage-scope"><span class="tb-label">班级范围</span>' + scopeBtns + '</div>' +
        '</div>';
      host.innerHTML = toolbar + totalHtml + tbl + memTbl + dailyHtml;

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
      return '<option value="' + c.id + '"' + (c.id === state.classId ? ' selected' : '') + '>' +
        esc(c.name) + (c.isActive ? '' : '（停用）') + '</option>';
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
      if (cls) toast('已切换到「' + cls.name + '」');
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

    $('#nav').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-item');
      if (b) go(b.dataset.view);
    });

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