/**
 * 网页管理后台 · HTTP 云函数（单函数同源托管页面 + API）
 * ============================================================
 * 为什么必须**单函数同源**（方案铁律）：
 *   CloudBase 静态托管默认域名是 *.tcloudbaseapp.com，HTTP 访问服务是 *.app.tcloudbase.com，
 *   **后缀不同 = 跨站**。跨站下 HttpOnly Cookie 根本不随请求发出去
 *   （SameSite=Lax 只在同站导航时才发），登录态立刻退化成 localStorage 明文 —— 安全倒退。
 *   所以页面和 API 必须由**同一个 HTTP 云函数**用同一个域名吐出来。
 *
 * 鉴权：全部走 lib/auth.js，与 13 个小程序云函数完全独立（网页拿不到 WX 上下文）。
 * 权限真源仍是 member.is_super=1，每次请求都回查。
 */
const path = require('path');
const express = require('express');
const auth = require('./lib/auth');
const { BizError } = require('./common/resp');
const { getPool } = require('./common/db');

const modClass = require('./lib/mod-class');
const modMember = require('./lib/mod-member');
const modCourse = require('./lib/mod-course');
const modConfig = require('./lib/mod-config');
const modLeave = require('./lib/mod-leave');
const modUsage = require('./lib/mod-usage');
const modScheduleRules = require('./lib/mod-schedule-rules');

const app = express();
app.disable('x-powered-by');
// 登录接口要收口令，其余 API 收 JSON
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: false }));

/* ============================================================
 * API 前缀归一化（2026-10-10 线上事故修复）
 * ============================================================
 * 背景：页面 URL 是 /admin，前端所有 API 都写 /admin/api/xxx。
 *   · **线上**：CloudBase 网关只转发 /admin 前缀，且转发到函数时**已剥掉前缀**
 *     （实测 /admin/api/me → 401 命中路由；/api/me → 404 压根没转发）
 *   · **本地 e2e**：直接打 127.0.0.1，没有网关剥前缀 ⇒ /admin/api/xxx 打不到路由
 * 两种形态都得支持，否则「本地全绿、线上全挂」或反过来。
 * 这里统一把 /admin/api/* 归一化回 /api/*，让下面的路由只写一种形态。
 *
 * ⚠️ 只重写 /api 段，**不能整条剥前缀**：静态资源挂在 /admin 前缀上，
 *    整条剥会把 /admin/app.js 变成 /app.js 而错落到 SPA 兜底。
 */
const API_PREFIX_RE = /^\/admin(?=\/api\/)/;
app.use((req, res, next) => {
  if (API_PREFIX_RE.test(req.url)) req.url = req.url.replace(API_PREFIX_RE, '');
  next();
});

/* ============================================================
 * 登录相关（**唯一一组不需要登录态的接口**）
 * ============================================================ */

app.post('/api/auth/login', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) {
    return res.json({ ok: false, errMsg: '请输入账号和密码' });
  }
  try {
    const r = await auth.login(username, password, req);
    if (!r.ok) {
      // 限流信息不外泄具体失败计数，避免被用来探测
      return res.status(r.errMsg === '账号或密码不正确' ? 401 : 403).json({ ok: false, errMsg: r.errMsg });
    }
    auth.setSessionCookie(res, r.raw);
    // ⚠️ 只手工挑字段回前端，**绝不 res.json(session)** ——
    //    session.selfHash 是口令哈希，整个对象序列化会把它泄给浏览器。
    return res.json({
      ok: true,
      user: { username: r.username, memberId: r.memberId }
    });
  } catch (e) {
    // ⚠️ 这里必须把真实异常打出来：e.message 有可能是空串
    //    （比如驱动抛的错不带 message），只打 e.message 会得到 `[login-error] `
    //    这样一个空行，看起来像"没报错"但实际是 500 —— 极难排查。
    console.error('[login-error]', (e && e.stack) || e);
    res.status(500).json({ ok: false, errMsg: '服务暂时不可用，请稍后再试' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const cookies = auth.parseCookies(req);
    const raw = cookies[auth.COOKIE_NAME];
    if (raw) {
      const pool = getPool();
      await pool.query('DELETE FROM admin_session WHERE sid = ?', [auth.sha256(raw)]);
    }
  } catch (e) {
    /* 登出失败也要清本地 Cookie —— 否则用户点了登出还停在后台 */
  }
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

/** 当前登录态 + 班级清单（前端顶部班级选择器用） */
app.get('/api/me', async (req, res) => {
  const s = await auth.loadSession(req);
  if (!s) return res.status(401).json({ ok: false, errMsg: '未登录或登录已过期' });
  const classes = await modClass.listClasses();
  res.json({
    ok: true,
    user: { username: s.username, memberId: s.memberId, memberName: s.memberName },
    // ⚠️ 这里曾只回传 {id,name,isActive} 三个字段，把 maskClass 解析好的 periodTime **丢掉了**：
    //   前端「添加课次」的大节下拉（periodOptions）要读 cls.periodTime 才知道本班配了几个大节，
    //   拿不到就只能走兜底 5 项 ⇒ 线上给 示例班级A 配了 6 个大节，下拉仍然只有 5 项（2026-10-14 用户实锤）。
    //   凡是「按班级配置动态渲染」的前端逻辑，字段都必须在这一层放行。
    classes: classes.map((c) => ({
      id: c.id, name: c.name, isActive: c.isActive,
      periodTime: c.periodTime || [],   // 大节时间（节次数来源）
      mainRoom: c.mainRoom || ''        // 主教室（保洁值日房间）
    }))
  });
});

/* ============================================================
 * 以下全部要求登录态
 * ============================================================ */
app.use('/api', async (req, res, next) => {
  // /api/auth/login 与 /api/me 在上面注册，不会走到这里
  const s = await auth.loadSession(req);
  if (!s) return res.status(401).json({ ok: false, errMsg: '未登录或登录已过期' });
  req.session2 = s;
  next();
});

/** 统一包装：把 BizError 转成人话提示，其余异常统一 500 且不泄漏堆栈 */
function handle(res, fn) {
  const url = (res.req && res.req.originalUrl) || '';
  Promise.resolve()
    .then(fn)
    .then((data) => res.json({ ok: true, data: data === undefined ? null : data }))
    .catch((e) => {
      if (e instanceof BizError || (e && typeof e.errCode === 'number')) {
        return res.status(400).json({ ok: false, errCode: e.errCode, errMsg: e.errMsg || '请求有误' });
      }
      // ⚠️ 堆栈只进服务端日志，**绝不回给浏览器** —— 后台错误信息里常带表名/内部结构。
      //   本机/线上排查 500 的办法见 docs/网页管理后台-使用说明.md「故障排查」：
      //   `tcb fn log` 在未开通 CLS 日志通道时会报 `topic not exist` 拿不到堆栈，
      //   那时临时在下面加一行 `global.__lastApiError = e;` 并挂一个只读诊断端点，
      //   排查完**务必删掉**（诊断信息含表名与 SQL 片段，不能留在生产）。
      console.error('[api-error]', url, e && e.stack);
      res.status(500).json({ ok: false, errMsg: '服务内部错误，请稍后再试' });
    });
}

/* ---------------- 概览 / 配置 / 审计 ---------------- */

app.get('/api/overview', (req, res) => handle(res, () => modConfig.overview()));

app.get('/api/audit', (req, res) => handle(res, () => modConfig.listAudit(req.query)));

/* ---------------- 使用统计（2026-10-16） ---------------- */
app.get('/api/usage', (req, res) => handle(res, () => modUsage.usage(req.query)));

app.get('/api/admin-users', (req, res) => handle(res, () => modConfig.listAdminUsers()));

app.post('/api/admin-users/:id', (req, res) => handle(res, () =>
  modConfig.updateAdminUser(
    Number(req.params.id),
    req.body || {},
    String((req.body || {}).currentPassword || ''),
    req.session2,
    req
  )
));

/* ---------------- 班级 ---------------- */

app.get('/api/classes', (req, res) => handle(res, () => modClass.listClasses()));

app.get('/api/classes/:id', (req, res) => handle(res, () => modClass.classDetail(Number(req.params.id))));

app.post('/api/classes/:id', (req, res) => handle(res, () =>
  modClass.updateClass(Number(req.params.id), req.body || {}, req.session2, req)
));

/* ---------------- 成员 ---------------- */

app.get('/api/members', (req, res) => handle(res, () => modMember.listMembers(req.query)));

app.get('/api/members/:id', (req, res) => handle(res, () => modMember.memberDetail(Number(req.params.id))));

app.post('/api/members', (req, res) => handle(res, () =>
  modMember.addMember(req.body || {}, req.session2, req)
));

app.post('/api/members/:id', (req, res) => handle(res, () => {
  const body = req.body || {};
  if (body.__action === 'setSuper') {
    return modMember.setSuper(Number(req.params.id), !!body.isSuper, req.session2, req);
  }
  if (body.__action === 'remove') {
    return modMember.removeMember(Number(req.params.id), req.session2, req);
  }
  return modMember.updateMember(Number(req.params.id), body, req.session2, req);
}));

/* ---------------- 课程表 ---------------- */

app.get('/api/timetable', (req, res) => handle(res, () =>
  modCourse.listTimetable(Number(req.query.classId), String(req.query.group || 'ALL'))
));

/** 干跑预览：只算不改，强制回显目标班级名 + 影响行数 */
app.post('/api/timetable/dry-run', (req, res) => handle(res, () =>
  modCourse.dryRunImport(req.body || {})
));

/** 正式导入：自动 bak_* 备份 + 事务 + 审计 */
app.post('/api/timetable/import', (req, res) => handle(res, () =>
  modCourse.commitImport(req.body || {}, req.session2, req)
));

/** 单独新增一节课（A 组 / B 组 / 全体），body 含 classId / courseName / dayOfWeek / period / groupScope 等 */
app.post('/api/timetable/session', (req, res) => handle(res, () =>
  modCourse.addSession(req.body || {}, req.session2, req)
));

app.post('/api/timetable/session/:id', (req, res) => handle(res, () =>
  modCourse.updateSession(Number(req.params.id), req.body || {}, req.session2, req)
));

// 删课次：POST 而非 DELETE 方法 —— 与 member 的 remove 同风格，
// 且网关/浏览器代理对 DELETE 的预检与重定向行为不一致，没必要踩。
app.post('/api/timetable/session/:id/delete', (req, res) => handle(res, () =>
  modCourse.deleteSession(Number(req.params.id), req.session2, req)
));

/** 清空课表：删除某班某组（A / B）或全部 COURSE 课次，可选 dryRun 预览 */
app.post('/api/timetable/clear', (req, res) => handle(res, () =>
  modCourse.clearTimetable(req.body || {}, req.session2, req)
));

/* ---------------- 请假 ---------------- */

/** 请假列表：按班级 / 状态 / 关键字 / 日期筛选（不显示测试账号） */
app.get('/api/leave', (req, res) => handle(res, () =>
  modLeave.listLeave({
    classId: Number(req.query.classId),
    memberId: req.query.memberId ? Number(req.query.memberId) : undefined,
    status: req.query.status || undefined,
    keyword: req.query.keyword || undefined,
    dateFrom: req.query.dateFrom || undefined,
    dateTo: req.query.dateTo || undefined
  }, req.session2, req)
));

/** 修改请假（日期 / 时段 / 状态），POST 同 member / session 风格 */
app.post('/api/leave/:id', (req, res) => handle(res, () =>
  modLeave.updateLeave(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

/* ---------------- 排班规则（免代码 / 免送审的远程配置入口） ---------------- */
app.get('/api/schedule-rules', (req, res) => handle(res, async () => {
  const pool = getPool();
  return modScheduleRules.getScheduleRules(pool, req.query.classId);
}));

app.post('/api/schedule-rules', (req, res) => handle(res, () => {
  const pool = getPool();
  return modScheduleRules.saveScheduleRules(pool, (req.body || {}).classId, req.body || {}, req.session2);
}));

/* ============================================================
 * 静态页面（与 API 同源 —— 见文件头「为什么必须单函数同源」）
 * ========================================================⚠️
 * 静态资源要**挂两遍**（2026-10-10 线上事故修复）：
 *   页面 URL 是 /admin（gatewayPath 决定的），HTML 里的资源因此写 /admin/app.js、
 *   /admin/admin.css。而网关只转发 /admin 前缀 ⇒ 资源请求必然带 /admin 前缀。
 *     · 挂 /admin   ⇒ /admin/app.js 命中（线上真实形态）
 *     · 挂 /        ⇒ 根路径下调试、以及本地 e2e 不带前缀时也能命中
 *   两处都挂是幂等的（express.static 命中即停），不引入歧义。
 *   ⚠️ 只挂一处会导致另一种形态下资源 404 —— 而资源 404 的症状极隐蔽：
 *   app.js 挂掉 ⇒ submit 监听器没绑 ⇒ 点「登录」退化成原生表单 GET 提交，
 *   页面刷新无提示（用户视角＝「点了没反应」），且口令被拼进 URL 落进浏览器历史。
 */
app.use('/admin', express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: 0 // 后台是内部工具，缓存旧页面比多几 KB 危险
}));
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // / 让 SPA 兜底处理，别把根路径也变成首页（本地 e2e 从 /admin 进）
  maxAge: 0
}));

// SPA 兜底：非 /api 的 GET 一律回首页
// ⚠️ **必须排除带扩展名的资源请求**（2026-10-10 线上事故同款陷阱）：
//   页面 URL 是 /admin，静态资源因此写成 /admin/app.js。express.static 挂在根，
//   于是 /admin/app.js 找不到文件 → 落到这条兜底 → **把 index.html（HTML）当 JS 返回**
//   → 浏览器报 `Unexpected token '<'`，app.js 一行都没执行
//   → #login-form 的 submit 监听器没绑上 → 点「登录」退化成浏览器原生表单 GET 提交，
//     页面原地刷新无提示（用户视角＝「点了没反应」），**口令还会被拼进 URL**。
//   所以资源 404 必须**原样 404**（让浏览器报真错），绝不能拿首页糊弄。
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* 统一兜底错误处理 —— 必须在最后注册 */
app.use((err, req, res, next) => {
  console.error('[unhandled]', err && err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, errMsg: '服务内部错误' });
});

/* ============================================================
 * 启动
 * ============================================================ */
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log('[admin-web] listening on ' + PORT));
}
// CloudBase HTTP 云函数约定：导出 app 即可由运行时接管
module.exports = app;
module.exports.app = app;