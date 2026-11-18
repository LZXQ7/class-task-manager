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
const modFee = require('./lib/mod-fee');
const modDuty = require('./lib/mod-duty');
const modSwap = require('./lib/mod-swap');
const modCountdown = require('./lib/mod-countdown');
const modAccounts = require('./lib/mod-accounts');
const modRoster = require('./lib/mod-roster');
const modUsage = require('./lib/mod-usage');
const modScheduleRules = require('./lib/mod-schedule-rules');
const perms = require('./lib/perms');

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
      user: {
        username: r.username, memberId: r.memberId,
        memberName: r.memberName, position: r.position, isSuper: r.isSuper
      },
      perms: r.perms,
      nav: perms.navFor(r.perms)
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
  const all = await modClass.listClasses();
  // 演示班（class 104）只给超管看：辅导员进后台时，下拉里不该出现一个假的演示班，
  // 否则很容易点错——演示班的数据是虚构的，改了也没意义。
  // 软删除的班（is_active=0 且非演示）一并过滤，两个入口共用同一函数避免漂移。
  const classes = modClass.filterAdminVisible(all, !!s.canSeeDemo);
  res.json({
    ok: true,
    user: {
      username: s.username, memberId: s.memberId, memberName: s.memberName,
      position: s.position, isSuper: s.isSuper
    },
    // 前端据此**动态渲染导航**：没权限的页签根本不出现，而不是出现了点了报 403。
    perms: s.perms,
    nav: perms.navFor(s.perms),
    // ⚠️ 这里曾只回传 {id,name,isActive} 三个字段，把 maskClass 解析好的 periodTime **丢掉了**：
    //   前端「添加课次」的大节下拉（periodOptions）要读 cls.periodTime 才知道本班配了几个大节，
    //   拿不到就只能走兜底 5 项 ⇒ 线上给 示例班级A 配了 6 个大节，下拉仍然只有 5 项（2026-10-14 用户实锤）。
    //   凡是「按班级配置动态渲染」的前端逻辑，字段都必须在这一层放行。
    classes: classes.map((c) => ({
      id: c.id, name: c.name, isActive: c.isActive,
      // 演示班标记：前端据此把下拉里的「（停用）」改写成「（演示）」。
      // 不传这个字段，前端就只能看见 is_active=0，把刻意停用的演示班当成故障显示。
      isDemo: !!c.isDemo,
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

/**
 * 页签级权限中间件（2026-11-15）
 * 必须在 `app.use('/api', ...)` 之后使用 —— 那时 req.session2 已就绪。
 *
 * 403 而不是 404：前端要靠明确的状态码区分「没登录」和「没这个权限」，
 * 否则会把人踢回登录页，看起来像登录态丢了（实际是权限不够）。
 */
function requirePerm(key) {
  return function (req, res, next) {
    const s = req.session2;
    if (!s) return res.status(401).json({ ok: false, errMsg: '未登录或登录已过期' });
    if (!perms.has(s.perms, key)) {
      return res.status(403).json({ ok: false, errCode: 40301, errMsg: '当前账号没有该功能的权限' });
    }
    next();
  };
}

/**
 * 满足任意一个页签权限即可通过。
 * 用于**被多个页签共用**的只读接口：成员列表要给请假代登记、值日改人、换班审批、
 * 倒数日查人都用；如果只挂 members，生活委员（没有 members 权限）会在
 * 点「换人」时拿到 403，看起来像功能坏了。
 */
function requireAnyPerm(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  return function (req, res, next) {
    const s = req.session2;
    if (!s) return res.status(401).json({ ok: false, errMsg: '未登录或登录已过期' });
    const ok = list.some((k) => perms.has(s.perms, k));
    if (!ok) return res.status(403).json({ ok: false, errCode: 40301, errMsg: '当前账号没有该功能的权限' });
    next();
  };
}

/** 概览 / 配置 / 审计 ---------------- */

app.get('/api/overview', requirePerm('overview'), (req, res) => handle(res, () =>
  modConfig.overview(!!(req.session2 && req.session2.canSeeDemo))));

app.get('/api/audit', requirePerm('audit'), (req, res) => handle(res, () => modConfig.listAudit(req.query)));

/* ---------------- 使用统计（2026-10-16） ---------------- */
app.get('/api/usage', requirePerm('usage'), (req, res) => handle(res, () => modUsage.usage(req.query)));

app.get('/api/admin-users', requirePerm('accounts'), (req, res) => handle(res, () => modConfig.listAdminUsers()));

app.post('/api/admin-users/:id', requirePerm('accounts'), (req, res) => handle(res, () =>
  modConfig.updateAdminUser(
    Number(req.params.id),
    req.body || {},
    String((req.body || {}).currentPassword || ''),
    req.session2,
    req
  )
));

/* ---------------- 班级 ---------------- */

/** 班级列表：所有登录用户都要用（顶部选择器），所以不挂 class 权限；但要过滤演示班 */
app.get('/api/classes', (req, res) => handle(res, async () => {
  const all = await modClass.listClasses();
  const s = req.session2;
  return modClass.filterAdminVisible(all, !!(s && s.canSeeDemo));
}));

app.get('/api/classes/:id', requirePerm('class'), (req, res) => handle(res, () => modClass.classDetail(Number(req.params.id))));

app.post('/api/classes/:id', requirePerm('class'), (req, res) => handle(res, () =>
  modClass.updateClass(Number(req.params.id), req.body || {}, req.session2, req)
));

/** 新建班级（2026-11-16）：只要求班级名，其余学期/周数/口令/邀请码/大节时间自动生成 */
app.post('/api/classes', requirePerm('class'), (req, res) => handle(res, () =>
  modClass.createClass(req.body || {}, req.session2, req)
));

/** 软删除班级（2026-11-16）：只置 is_active=0，成员/课表/值日/班费等数据全部保留 */
app.post('/api/classes/:id/delete', requirePerm('class'), (req, res) => handle(res, () =>
  modClass.softDeleteClass(Number(req.params.id), req.session2, req)
));

/* 名单导入（2026-11-16）：预览与写入都要求 members.import ——
 * 它比「看名单」危险得多（一次能凭空造出一整个班的成员），所以不跟着 members 走。 */
app.post('/api/classes/:id/roster/preview', requirePerm('members.import'), (req, res) => handle(res, () =>
  modRoster.previewRoster(Object.assign({ classId: Number(req.params.id) }, req.body || {}))
));

app.post('/api/classes/:id/roster', requirePerm('members.import'), (req, res) => handle(res, () =>
  modRoster.commitRoster(Object.assign({ classId: Number(req.params.id) }, req.body || {}), req.session2, req)
));

/* ---------------- 成员 ---------------- */

app.get('/api/members', requireAnyPerm(['members', 'leave', 'fee', 'duty', 'swap', 'countdown']), (req, res) => handle(res, () => modMember.listMembers(req.query)));

app.get('/api/members/:id', requireAnyPerm(['members', 'leave', 'duty', 'swap']), (req, res) => handle(res, () => modMember.memberDetail(Number(req.params.id))));

/* 成员写操作按「操作级权限」分路由（2026-11-16）：
 * 原来全部挂 `members` —— 能进成员页就等于能改资料、能设超管、能删人。
 * 现在拆成 members.add / members.edit / members.super / members.remove，
 * 前端按同一套 key 显隐按钮，后端这里才是真正的安全边界（前端过滤只是体验）。
 * ⚠️ 顺序：`/:id/super`、`/:id/delete` 必须写在 `/:id` 之前，否则被 :id 吃掉。
 */
app.post('/api/members', requirePerm('members.add'), (req, res) => handle(res, () =>
  modMember.addMember(req.body || {}, req.session2, req)
));

app.post('/api/members/:id/super', requirePerm('members.super'), (req, res) => handle(res, () =>
  modMember.setSuper(Number(req.params.id), !!(req.body || {}).isSuper, req.session2, req)
));

app.post('/api/members/:id/delete', requirePerm('members.remove'), (req, res) => handle(res, () =>
  modMember.removeMember(Number(req.params.id), req.session2, req)
));

app.post('/api/members/:id', requirePerm('members.edit'), (req, res) => handle(res, () =>
  modMember.updateMember(Number(req.params.id), req.body || {}, req.session2, req)
));

/* ---------------- 课程表 ---------------- */

app.get('/api/timetable', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.listTimetable(Number(req.query.classId), String(req.query.group || 'ALL'))
));

/** 干跑预览：只算不改，强制回显目标班级名 + 影响行数 */
app.post('/api/timetable/dry-run', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.dryRunImport(req.body || {})
));

/** 正式导入：自动 bak_* 备份 + 事务 + 审计 */
app.post('/api/timetable/import', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.commitImport(req.body || {}, req.session2, req)
));

/** 单独新增一节课（A 组 / B 组 / 全体），body 含 classId / courseName / dayOfWeek / period / groupScope 等 */
app.post('/api/timetable/session', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.addSession(req.body || {}, req.session2, req)
));

app.post('/api/timetable/session/:id', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.updateSession(Number(req.params.id), req.body || {}, req.session2, req)
));

// 删课次：POST 而非 DELETE 方法 —— 与 member 的 remove 同风格，
// 且网关/浏览器代理对 DELETE 的预检与重定向行为不一致，没必要踩。
app.post('/api/timetable/session/:id/delete', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.deleteSession(Number(req.params.id), req.session2, req)
));

/** 清空课表：删除某班某组（A / B）或全部 COURSE 课次，可选 dryRun 预览 */
app.post('/api/timetable/clear', requirePerm('course'), (req, res) => handle(res, () =>
  modCourse.clearTimetable(req.body || {}, req.session2, req)
));

/* ---------------- 请假 ---------------- */

/** 请假列表：按班级 / 状态 / 关键字 / 日期筛选（不显示测试账号） */
app.get('/api/leave', requirePerm('leave'), (req, res) => handle(res, () =>
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
app.post('/api/leave/:id', requirePerm('leave'), (req, res) => handle(res, () =>
  modLeave.updateLeave(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

/** 后台代登记一条请假（2026-11-15）：默认 source=register + APPROVED，并重算值日 LEAVE 标记 */
app.post('/api/leave', requirePerm('leave'), (req, res) => handle(res, () =>
  modLeave.createLeave(req.body || {}, req.session2, req)
));

/** 删除一条请假（2026-11-15）：连带把该成员这几天的 duty LEAVE 标记退回 PENDING */
app.post('/api/leave/:id/delete', requirePerm('leave'), (req, res) => handle(res, () =>
  modLeave.deleteLeave({ id: Number(req.params.id) }, req.session2, req)
));

/* ---------------- 班费 / 团费（2026-11-15 新增） ----------------
 * 余额不落库（= total − SUM(amount)），改/删一条记录即联动，与小程序同一套口径。
 * ⚠️ 后台删除只删数据库行、**不删云存储凭证图**（小程序删除会连带删图且不可恢复）；
 *    凭证图在网页里用「公网 URL」直接显示（桶为所有用户可读），不需要 SDK。
 */
app.get('/api/fee', requirePerm('fee'), (req, res) => handle(res, () =>
  modFee.getFund({ classId: Number(req.query.classId) })
));

app.post('/api/fee/total', requirePerm('fee'), (req, res) => handle(res, () =>
  modFee.saveTotal(req.body || {}, req.session2, req)
));

app.post('/api/fee/record', requirePerm('fee'), (req, res) => handle(res, () =>
  modFee.addRecord(req.body || {}, req.session2, req)
));

app.post('/api/fee/record/:id', requirePerm('fee'), (req, res) => handle(res, () =>
  modFee.updateRecord(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

app.post('/api/fee/record/:id/delete', requirePerm('fee'), (req, res) => handle(res, () =>
  modFee.deleteRecord({ id: Number(req.params.id) }, req.session2, req)
));

/** 只把某张凭证图从记录的 images 数组里摘掉（云存储文件保留） */
app.post('/api/fee/record/:id/image/remove', requirePerm('fee'), (req, res) => handle(res, () =>
  modFee.removeImage(
    Object.assign({ id: Number(req.params.id) }, req.body || {}),
    req.session2, req
  )
));

/* ---------------- 排班规则（免代码 / 免送审的远程配置入口） ---------------- */
app.get('/api/schedule-rules', requirePerm('rules'), (req, res) => handle(res, async () => {
  const pool = getPool();
  return modScheduleRules.getScheduleRules(pool, req.query.classId);
}));

/* ---------------- 值日记录（2026-11-15 新增） ----------------
 * 后台能改状态、换人、删除单条值日；写操作都进 duty_log（与小程序同一个日志表），
 * 这样两端看到的「谁在什么时候改了这条值日」是同一份事实。
 */
app.get('/api/duty', requirePerm('duty'), (req, res) => handle(res, () =>
  modDuty.listDuty(req.query)
));

app.post('/api/duty/:id/status', requirePerm('duty'), (req, res) => handle(res, () =>
  modDuty.setStatus(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

app.post('/api/duty/:id/member', requirePerm('duty'), (req, res) => handle(res, () =>
  modDuty.setMember(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

app.post('/api/duty/:id/delete', requirePerm('duty'), (req, res) => handle(res, () =>
  modDuty.removeDuty({ id: Number(req.params.id) }, req.session2, req)
));

/* ---------------- 换班申请（2026-11-15 新增） ----------------
 * 审批口径与小程序一致：PENDING_PEER（等对方）→ PENDING_ADMIN（等管理员）→ DONE。
 * 后台可以直接「通过 / 驳回 / 撤销」；通过时会真的把 duty.member_id 换成对方。
 */
app.get('/api/swap', requirePerm('swap'), (req, res) => handle(res, () =>
  modSwap.listSwap(req.query)
));

app.post('/api/swap/:id/approve', requirePerm('swap'), (req, res) => handle(res, () =>
  modSwap.approve({ id: Number(req.params.id), note: (req.body || {}).note }, req.session2, req)
));

app.post('/api/swap/:id/reject', requirePerm('swap'), (req, res) => handle(res, () =>
  modSwap.reject(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

app.post('/api/swap/:id/cancel', requirePerm('swap'), (req, res) => handle(res, () =>
  modSwap.cancel(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

/* ---------------- 倒数日（2026-11-15 新增） ----------------
 * 只读：倒数日是「每个人自己的」本地记录，后台不做增删改，
 * 只回答「谁添加了哪一天」——用于辅导员了解学生在关注什么节点（考试/生日/纪念日）。
 */
app.get('/api/countdown', requirePerm('countdown'), (req, res) => handle(res, () =>
  modCountdown.listCountdown(req.query)
));

/* ---------------- 后台账号开通（2026-11-15 新增，仅超管） ----------------
 * 与「/api/admin-users」的区别：那是「改已有账号的密码/状态」；
 * 这里是「从班级成员里挑一个人，给他开后台账号 + 按职位预填权限」。
 */
app.get('/api/accounts', requirePerm('accounts'), (req, res) => handle(res, () =>
  modAccounts.listAccounts(req.query, req.session2)
));

app.post('/api/accounts', requirePerm('accounts'), (req, res) => handle(res, () =>
  modAccounts.createAccount(req.body || {}, req.session2, req)
));

app.post('/api/accounts/:id', requirePerm('accounts'), (req, res) => handle(res, () =>
  modAccounts.updateAccount(Object.assign({ id: Number(req.params.id) }, req.body || {}), req.session2, req)
));

app.post('/api/accounts/:id/delete', requirePerm('accounts'), (req, res) => handle(res, () =>
  modAccounts.removeAccount({ id: Number(req.params.id) }, req.session2, req)
));

app.post('/api/schedule-rules', requirePerm('rules'), (req, res) => handle(res, () => {
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