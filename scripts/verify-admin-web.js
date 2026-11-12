/**
 * admin-web 端到端验证（Playwright + mock DB）
 * 跑法：node scripts/verify-admin-web.js
 *
 * 为什么 mock：MySQL 只在同 VPC 内网可达（172.17.0.15:3306），
 * 本机起真后端必然 ECONNREFUSED ⇒ 「起服务 → 浏览器点一遍」这条路走不通。
 * 所以只打桩 **db 层**（getPool 返回夹具数据），
 * HTTP 路由 / Cookie 登录态 / 会话回查 member / 前端渲染全部走真代码。
 *
 * ⚠️ 本脚本验不到什么（部署后必须真机补验，不得拿本脚本当已验证）：
 *   · 真 SQL 与生产库结构/字段类型/TDSQL 方言的一致性；
 *   · 课表导入的真事务、A/B 自动降全体课、duty_count 回滚；
 *   · 云函数冷启动与超时（HTTP 云函数 config.json 已把 timeout 调到 60s）。
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

const ADMIN = path.join(__dirname, '..', 'cloudfunctions', 'admin-web');
const SHOTS = path.join(__dirname, '..', 'outputs', 'admin-web');
/* Chromium 路径自动探测（2026-11-12）：原来写死 chromium_headless_shell-1223，
 * playwright 升级到 1234 后 e2e 直接「executable doesn't exist」——把版本号写死
 * 等于每次 playwight 更新都要改门禁。改为扫 ms-playwright 下最新的
 * chromium_headless_shell-* / chromium-*，取第一个真实存在的可执行文件。 */
const CHROME = (function () {
  const root = 'C:/Users/PC/AppData/Local/ms-playwright';
  const cands = [];
  try {
    fs.readdirSync(root).sort().reverse().forEach(function (d) {
      const shell = path.join(root, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
      const full = path.join(root, d, 'chrome-win', 'chrome.exe');
      if (fs.existsSync(shell)) cands.push(shell);
      if (fs.existsSync(full)) cands.push(full);
    });
  } catch (e) { /* 目录不存在则落到下面的兜底 */ }
  return cands[0] || path.join(root, 'chromium_headless_shell-1223',
    'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
})();
const { chromium } = require('C:/Users/PC/.dsh/skills/dashi-ppt/project/node_modules/playwright-core');

/* ---------------- 夹具 ---------------- */
/**
 * 🔴 班级的大节时间（2026-10-14 新增，见 [6.2] 断言组）。
 *
 * 为什么要给夹具配**非空** period_time：早前三个班的 period_time 全是 null，
 * 于是「大节下拉」这条链路**从头到尾没被 e2e 碰过** ——
 * 页面永远走 periodOptions 的兜底分支（5 项），配了 6 节能不能出第 6 项这种问题自然测不出来。
 * 用户实锤的正是这条：示例班级A 已配 6 节，下拉仍只有 5 项。
 *
 * 2601/示例班级B = 5 节（线上现状）、示例班级A = 6 节（第 6 节 16:30-17:15，模拟「书香校园」短课）。
 */
const PERIOD_TIME_5 = JSON.stringify([
  { period: 1, start: '08:10', end: '09:50' }, { period: 2, start: '10:10', end: '11:50' },
  { period: 3, start: '14:40', end: '16:20' }, { period: 4, start: '16:30', end: '18:10' },
  { period: 5, start: '19:00', end: '20:40' }
]);
const PERIOD_TIME_6 = JSON.stringify([
  { period: 1, start: '08:10', end: '09:50' }, { period: 2, start: '10:10', end: '11:50' },
  { period: 3, start: '14:40', end: '16:20' }, { period: 4, start: '16:30', end: '18:10' },
  { period: 5, start: '19:00', end: '20:40' }, { period: 6, start: '16:30', end: '17:15' }
]);
/**
 * ⚠️ 顺序铁律：必须**先**把 db.js 打桩，再 require 任何一个 admin-web 模块。
 *    顺序搞反的话（先 require lib/auth.js），真 db.js 已经把 mysql2 拉进来并
 *    在 require 期建池，桩根本拦不住 —— 表现是 AggregateError 连 172.17.0.15:3306，
 *    而报错行落在真 db.js 里，看起来像"后台代码有问题"，其实是测试自己的锅。
 */
const authModPath = path.join(ADMIN, 'lib', 'auth.js');
// ⚠️ 用 resolve 会真的加载一次 db.js（连带 mysql2），桩就白打了。
//    直接用绝对路径当 cache key，不触发任何加载。
const dbPath = path.join(ADMIN, 'common', 'db.js');

/**
 * 夹具用的口令哈希：**独立实现** scrypt 格式（与 lib/auth.js 同格式）。
 * 之所以不直接用 auth.hashPassword：auth.js 会 require db.js，
 * 而 db.js 要到下面才打桩 —— 直接用它就会把真 mysql2 拉进来。
 * 这里手工构造同格式字符串，让登录时的 verifyPassword 真跑真解。
 */
const crypto = require('crypto');
function hashFor(plain) {
  const N = 16384, r = 8, p = 1;
  const salt = Buffer.alloc(16, 7);
  const dk = crypto.scryptSync(plain, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
}

const TABLES = {
  class: [
    { id: 1, name: '示例专业B1班', join_token: '123456', invite_code: '<INVITE_CODE>', term_start: '2026-09-14', total_weeks: 16, bind_open: 1, is_active: 1, period_time: PERIOD_TIME_5, cnt: 52 },
    { id: 2, name: '示例专业A2班', join_token: '234567', invite_code: '<INVITE_CODE>', term_start: '2026-09-14', total_weeks: 16, bind_open: 1, is_active: 1, period_time: PERIOD_TIME_5, cnt: 50 },
    { id: 3, name: '示例专业A1班', join_token: '345678', invite_code: '<INVITE_CODE>', term_start: '2026-09-14', total_weeks: 16, bind_open: 1, is_active: 1, period_time: PERIOD_TIME_6, cnt: 58 }
  ],
  member: [
    { id: 13, class_id: 3, name: '示例成员01', student_no: '2099010101', group_tag: 'A', role: 'ADMIN', is_super: 1, position: '生活委员', status: 'ACTIVE', openid: 'o1', duty_count: 5, duty_off: 0, remind_block: 0, last_duty_at: '2026-10-08' },
    // ⚠️ 刻意放测试超管（学号 99 段）：验证「后台一律不显示测试账号」这条铁律
    { id: 69, class_id: 3, name: '测试超管', student_no: '0000000000', group_tag: 'A', role: 'ADMIN', is_super: 1, position: '', status: 'LEAVE', openid: null, duty_count: 0, duty_off: 0, remind_block: 0, last_duty_at: null },
    { id: 54, class_id: 3, name: '示例成员42', student_no: '2603010102', group_tag: 'B', role: 'ADMIN', is_super: 0, position: '班长兼团支书', status: 'ACTIVE', openid: 'o2', duty_count: 12, duty_off: 0, remind_block: 0, last_duty_at: '2026-10-09' },
    // 2026-11-08 单独授权夹具：普通成员李四被额外授予「登记班费消费」（不改职位）。
    // [7.6] 会在真实浏览器里验列表 tag / 弹层勾选态 / 保存回写。
    { id: 55, class_id: 3, name: '李四', student_no: '2603010103', group_tag: 'A', role: 'MEMBER', is_super: 0, position: '', status: 'ACTIVE', openid: 'o3', duty_count: 2, duty_off: 0, remind_block: 0, last_duty_at: null, fee_perms: 'class' },
    // openid 刻意留空（2026-11-12）：成员列表新增「绑定」列后，需要同时验到
    // 「已绑定」与「未绑定」两种渲染；王五的 openid 不被任何其它断言依赖。
    { id: 56, class_id: 3, name: '王五', student_no: '2603010104', group_tag: 'B', role: 'MEMBER', is_super: 0, position: '', status: 'DISABLED', openid: null, duty_count: 0, duty_off: 1, remind_block: 0, last_duty_at: null },
    { id: 57, class_id: 1, name: '一班同学', student_no: '2601010101', group_tag: 'A', role: 'MEMBER', is_super: 0, position: '', status: 'ACTIVE', openid: 'o5', duty_count: 1, duty_off: 0, remind_block: 0, last_duty_at: null }
  ],
  session: [
    { id: 101, class_id: 3, course_id: 101, kind: 'COURSE', week_rule: 'ALL', weeks: '1-16', day_of_week: 1, period: 1, group_scope: 'A', duty_count: 2, note: '' },
    { id: 102, class_id: 3, course_id: 102, kind: 'COURSE', week_rule: 'ALL', weeks: '1-16', day_of_week: 1, period: 2, group_scope: null, duty_count: 2, note: '' },
    { id: 103, class_id: 3, course_id: 103, kind: 'CLEAN', week_rule: 'ALL', weeks: '', day_of_week: 5, period: 5, group_scope: null, duty_count: 2, note: '' },
    { id: 104, class_id: 3, course_id: 104, kind: 'COURSE', week_rule: 'ALL', weeks: '1-16', day_of_week: 2, period: 1, group_scope: 'B', duty_count: 2, note: '调课' },
    // 第 6 大节课次（[6.2c-2] 回归用）：示例班级A 配了 6 个大节，这节课排第 6 节。
    // 没有它就没法验证「编辑第 6 节课次」这条路径（旧代码会报「大节应为 1-5」）。
    { id: 106, class_id: 3, course_id: 106, kind: 'COURSE', week_rule: 'ALL', weeks: '', day_of_week: 3, period: 6, group_scope: null, duty_count: 0, note: '' }
  ],
  // 课程行：与 session 一一对应（course_id 与 session.id 同号，便于 JOIN 命中）
  course: [
    { id: 101, class_id: 3, name: '大学语文', teacher: '张老师', room: 'A101' },
    { id: 102, class_id: 3, name: '高等数学', teacher: '李老师', room: 'A102' },
    { id: 103, class_id: 3, name: '值日保洁', teacher: '', room: '410' },
    { id: 104, class_id: 3, name: '大学英语', teacher: '王老师', room: 'B201' },
    { id: 106, class_id: 3, name: '书香校园', teacher: '', room: '3号教学楼210' }
  ],
  duty: [], member_note: [], staff_class: [], leave_request: [],
  schedule_publish: [], session_shift: [],
  admin_user: [], admin_session: [], admin_audit_log: []
};
TABLES.admin_user.push({ id: 1, username: 'admin', pass_hash: hashFor('Admin@2026'), member_id: 13, status: 1, last_login_at: null, last_login_ip: null, fail_count: 0, locked_until: null });
TABLES.admin_user.push({ id: 2, username: 'notsuper', pass_hash: hashFor('User@2026'), member_id: 55, status: 1, last_login_at: null, last_login_ip: null, fail_count: 0, locked_until: null });

/* ---------------- 打桩 db（必须在 require auth 之前） ---------------- */
/**
 * 取 SQL 的**主表**（驱动表）名。
 *
 * 坑比看起来多，前后各踩过一次：
 *   ① 取「第一个 FROM」：概览 SQL 里
 *      `SELECT c.*, (SELECT COUNT(*) FROM member m …) AS cnt FROM \`class\` c`
 *      会先命中子查询的 member ⇒ 班级名空白、计数全 0；
 *   ② 取「最后一个 FROM」：`admin_session s JOIN admin_user a`
 *      会命中 admin_user ⇒ 合并方向反了，登录 200 但 /api/me 恒 401；
 *   ③ 想靠「FROM 后紧邻是否 (」判断子查询：也不行 ——
 *      `FROM member m WHERE` 后面是表别名，但这个 FROM 确实在子查询内。
 *
 * 正解：**逐字符扫描**记录每个 FROM 出现时的括号深度（深度 0 = 顶层），
 * 取顶层最后一个；全都在子查询里才退回第一个。
 * ⚠️ 扫描必须在整串上连续进行（不能在每个 FROM 上另起一次），
 *    否则深度永远是「从该 FROM 之后开始算」，子查询里的 FROM 会被误判为顶层。
 */
function mainTableOf(s) {
  // 先去掉字符串字面量，避免引号里的 FROM / 括号干扰
  const clean = String(s).replace(/'(?:[^']|'')*'/g, "''");
  // JOIN 之后的表不是驱动表，只看 JOIN 之前的部分
  const joinAt = clean.search(/\bJOIN\b/i);
  const head = joinAt > 0 ? clean.slice(0, joinAt) : clean;

  const hits = [];
  let depth = 0;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    const m = /^FROM\s+`?(\w+)`?/i.exec(head.slice(i));
    if (m) hits.push({ table: m[1], depth: depth });
    if (m) i += 3; // 跳过 "FROM" 三个字符，其后的表名不再重复命中
  }
  const top = hits.filter((h) => h.depth === 0);
  if (top.length) return top[top.length - 1].table;
  return hits.length ? hits[0].table : null;
}

/**
 * 极简 WHERE 求值：只支持 mock 实际用到的那几种条件，
 * **按 SQL 里 `?` 出现的顺序**依次绑定 args（这才是 mysql2 的真实语义）。
 *
 * ⚠️ 之前用 `args.find(a => /^\d+$/.test(a))` 到处猜参数，踩了三坑：
 *   成员列表 SQL 第一个 ? 其实是 class_id，但课表 SQL 里 args 混着数字与字符串；
 *   更糟的是「成员数显示 0 / 课表整页空白」看起来像后端 bug，其实是 mock 猜错了参数。
 * 正解只有一个：**顺序绑定**。
 */
/**
 * 取**顶层**（括号深度 0）的最后一个 WHERE 位置；没有则 -1。
 *
 * ⚠️ 不能用 `sql.search(/\bWHERE\b/i)` —— 那取到的是**第一个** WHERE，
 * 而概览 SQL 长这样：
 *   SELECT c.id, (SELECT COUNT(*) FROM member m WHERE m.class_id = c.id AND …) AS memberCnt,
 *          (SELECT COUNT(*) FROM session s WHERE s.class_id = c.id AND s.kind='COURSE') AS sessionCnt
 *   FROM `class` c
 * 第一个 WHERE 在子查询里 ⇒ 子查询条件被套到 `class` 行上求值，
 * `undefined !== 'COURSE'` ⇒ **整表被过滤光**，表现为「班级数 0 / 成员数 0」——
 * 看起来像后端统计写错了，实则是 mock 把作用域搞错了。
 */
function topWhereAt(s) {
  let depth = 0;
  let at = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; continue; }
    if (depth === 0 && /^WHERE\b/i.test(s.slice(i, i + 5))) { at = i; i += 4; }
  }
  return at;
}

function rowMatches(row, sql, args) {
  const whereAt = topWhereAt(sql);
  if (whereAt < 0) return true;
  // ⚠️ 必须先摘掉 `(s.group_scope = ? OR s.group_scope IS NULL)` 这类复合片段：
  //   它由 applyWhere 专门按组求值。若留在原地，rowMatches 会把里面的
  //   `group_scope = ?` 单独拎出来跟 'A' 比 —— 全体课（group_scope 为 NULL）
  //   直接被判否，于是「A 组视图」只剩本组课、全体课凭空消失。
  //   这就是 MEMORY 里记的「两条兜底路径互掩盖 ⇒ 变异抓不到」的同款陷阱。
  const cond0 = sql.slice(whereAt).replace(/\(\s*\w+\.group_scope\s*=\s*\?\s+OR\s+\w+\.group_scope\s+IS NULL\s*\)/gi, ' ');
  /* 成员搜索是 `(m.name LIKE ? OR m.student_no LIKE ?)`。
   * rowMatches 的逐条件求值天然是 AND，留着它会要求姓名和学号**同时**命中
   * ⇒ 任何关键词都筛出 0 人（假空）。这里摘出片段，循环后按 OR 语义单独判一次。 */
  const hasKwOr = /\(\s*m\.name LIKE \?\s+OR\s+m\.student_no LIKE \?\s*\)/i.test(cond0);
  const cond = cond0.replace(/\(\s*m\.name LIKE \?\s+OR\s+m\.student_no LIKE \?\s*\)/gi, ' ');
  // 逐个条件： <col> <op> <val>  ；val 可能是 ? 或 '字面量'
  // ⚠️ 列名**可能带表前缀也可能不带**：`session s ... WHERE s.class_id = ?` 有前缀，
  //    而 `SELECT period_time FROM \`class\` WHERE id = ? LIMIT 1` 没有。
  //    早前正则强制要求 `\w+\.\w+`，不带前缀的条件**一个都解析不出来**
  //    ⇒ conds 为空 ⇒ rowMatches 直接 return true ⇒ 过滤失效、返回全表第一行。
  //    表现：加第 6 节课时报「大节应为 1-5」（拿到的是别的班的配置），极难定位。
  const conds = [];
  const re = /(?:\w+\.)?(\w+)\s*(=|<>|!=|NOT LIKE|LIKE)\s*(\?|'[^']*')/gi;
  let m;
  while ((m = re.exec(cond))) conds.push({ col: m[1], op: m[2].toUpperCase(), val: m[3] });
  let ai = 0;
  for (const c of conds) {
    let expect;
    if (c.val === '?') { expect = args[ai++]; }
    else { expect = c.val.slice(1, -1); }
    const actual = row[c.col];
    if (c.op === '=' && String(actual) !== String(expect)) return false;
    // 「仅班委」用 `role <> 'MEMBER'` / `group_tag <> 'X'`：不实现 <> 会让整个
    // 筛选条件被解析后静默忽略（列表仍返回 4 人，断言假绿），必须补齐。
    if ((c.op === '<>' || c.op === '!=') && String(actual) === String(expect)) return false;
    if (c.op === 'LIKE') {
      // 支持 'prefix%' / '%suffix' / '%both%'：成员搜索传的是 '%关键词%'，
      // 只认前缀会把关键词查询全判成不匹配（列表假空）。
      const lit = String(expect);
      const a = String(actual === null || actual === undefined ? '' : actual);
      const lead = lit[0] === '%';
      const tail = lit[lit.length - 1] === '%';
      const stem = lit.slice(lead ? 1 : 0, tail ? -1 : undefined);
      if (lead && tail) { if (a.indexOf(stem) < 0) return false; }
      else if (tail) { if (a.indexOf(stem) !== 0) return false; }
      else if (lead) { if (a.slice(-stem.length) !== stem) return false; }
      else if (a !== lit) return false;
    }
    if (c.op === 'NOT LIKE') {
      // NOT_TEST('m') 展开后就是这个形态；不支持它 = 测试账号过滤被整条忽略
      const lit = String(expect);
      const hit = lit.slice(-1) === '%'
        ? String(actual === null || actual === undefined ? '' : actual).indexOf(lit.slice(0, -1)) === 0
        : String(actual) === lit;
      if (hit) return false;
    }
  }
  if (hasKwOr) {
    // 摘掉 OR 片段后，ai 正好停在关键词的两个 ? 之前（其后再无参与求值的 ?）
    const raw = args[ai] === undefined ? '' : String(args[ai]);
    const kw = raw.replace(/^%/, '').replace(/%$/, '');
    const hit = String(row.name === null || row.name === undefined ? '' : row.name).indexOf(kw) >= 0 ||
      String(row.student_no === null || row.student_no === undefined ? '' : row.student_no).indexOf(kw) >= 0;
    if (!hit) return false;
  }
  return true;
}

/**
 * 给行补上 SELECT 列表里的**标量子查询别名**，如
 *   `(SELECT COUNT(*) FROM member m WHERE m.class_id = c.id AND m.student_no NOT LIKE '…') AS memberCnt`
 *
 * ⚠️ 不做这一步，概览的成员数 / 课次数 / 值日数**恒为 0** ——
 * mock 只返回主表行，从不计算子查询，而前端 `c.memberCount` 取的就是这个别名。
 * 症状是「概览表格有班级、统计卡全是 0」，很容易被误判成后端统计逻辑写错。
 *
 * 条件求值时列名可能来自内层表也可能来自外层行（`c.id`），两边都试。
 */
function applyScalarSubqueries(rows, sql) {
  const re = /\(\s*SELECT\s+COUNT\(\*\)\s+FROM\s+`?(\w+)`?\s+(\w+)\s+WHERE\s+([\s\S]+?)\)\s+AS\s+`?(\w+)`?/gi;
  let m;
  while ((m = re.exec(sql))) {
    const [, tbl, innerAlias, cond, alias] = m;
    const inner = TABLES[tbl] || [];
    rows.forEach((row) => {
      row[alias] = inner.filter((r) => evalScalarCond(cond, r, innerAlias, row)).length;
    });
  }
  return rows;
}

/**
 * 单条条件求值。
 * @param {string} innerAlias 子查询里 FROM 那张表的别名 —— **必须按别名区分内/外列**：
 *   `WHERE m.class_id = c.id` 里的 `id` 若从内层 member 行取，会拿 member.id(=13)
 *   去比 class.id，计数全错且不报错（最阴的一类 mock bug）。
 */
function evalScalarCond(cond, inner, innerAlias, outer) {
  // 右边三种形态都要吃：? 占位符 / '字面量' / 另一张表的列（`c.id`）
  const re = /(\w+)\.(\w+)\s*(=|<>|!=|NOT LIKE|LIKE)\s*(\?|'[^']*'|\w+\.\w+)/gi;
  let m;
  while ((m = re.exec(cond))) {
    const tblAlias = m[1];
    const col = m[2];
    const op = m[3].toUpperCase();
    const raw = m[4];
    const pick = (a, c) => (a === innerAlias ? (inner || {})[c] : (outer || {})[c]);
    const actual = pick(tblAlias, col);
    let expect;
    if (raw === '?') {
      // 标量子查询里出现 ? 就必须把外层 args 传进来按序绑定，
      // 不能猜也不能静默跳过（跳过 = 少一个条件 = 计数偏大且不报错）。
      throw new Error('[mock] 标量子查询不支持 ? 占位符：' + cond);
    }
    if (raw[0] === "'") { expect = raw.slice(1, -1); }
    else {
      const p = /^(\w+)\.(\w+)$/.exec(raw);
      expect = pick(p[1], p[2]);
    }
    const a = String(actual === null || actual === undefined ? '' : actual);
    const lit = expect === undefined || expect === null ? '' : String(expect);
    const pre = lit.slice(-1) === '%';
    const stem = pre ? lit.slice(0, -1) : lit;
    if (op === '=' && a !== lit) return false;
    if (op === '<>' && a === lit) return false;
    if (op === 'NOT LIKE' && (pre ? a.indexOf(stem) === 0 : a === lit)) return false;
    if (op === 'LIKE' && (pre ? a.indexOf(stem) !== 0 : a !== lit)) return false;
  }
  return true;
}


/**
 * 顶层 WHERE 条件的统一求值入口（JOIN 分支与非 JOIN 分支**都必须走这里**）。
 *
 * ⚠️ 早前把过滤写在非 JOIN 分支里 ⇒ 课表（session JOIN course）整条查询
 * 一个条件都不生效，A 视图照样显示 B 组课 —— 而断言「A 组视图不含 B 组独有课」
 * 当时是**靠页面空白蒙混过去的**（连「课表列出大学语文」都是失败的）。
 * 教训与 2026-10-10 记的「两条兜底路径互掩盖」同源：**任何 mock 的能力缺口，
 * 都可能让本该失败的断言变成另一条失败，掩盖真实原因**。
 */
function applyWhere(rows, sql, args) {
  let out = rows.filter((r) => rowMatches(r, sql, args || []));
  // group_scope 的 A/B 过滤：`(s.group_scope = ? OR s.group_scope IS NULL)`
  // 里的 OR / IS NULL 语义 rowMatches 不支持，这里显式按组过滤（A 视图 = 本组 + 全体）
  if (/\(\s*\w+\.group_scope\s*=\s*\?\s+OR\s+\w+\.group_scope\s+IS NULL\s*\)/i.test(sql)) {
    const g = (args || []).filter((a) => a === 'A' || a === 'B')[0];
    if (g) out = out.filter((r) => r.group_scope === g || r.group_scope === null);
  }
  return out;
}

/**
 * 使用统计专用 mock（2026-11-09）。
 *
 * 为什么单独接管：mod-usage.js 的查询全是聚合（GROUP BY / SUM(CASE) / COUNT(DISTINCT)），
 * 通用 POOL 分支只会把 usage_event 当普通表返回原始行 —— SELECT 别名一个都没有，
 * 前端拿到 undefined 就整页空白。这里按 SQL 特征返回**带正确别名**的聚合夹具。
 *
 * 「昨天」不是只验按钮样式：SQL 里出现昨天条件时，总 PV/UV 与概况数值会一起变，
 * 浏览器里必须看到数字真的跟着变（否则就是按钮点了没发请求 / 后端没吃参数）。
 */
function todayStr(offset) {
  const d = new Date();
  d.setDate(d.getDate() - (offset || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function usageEventMock(s, args) {
  const isY = /DATE\(ts\) = DATE_SUB\(CURDATE\(\), INTERVAL 1 DAY\)/.test(s);
  // ① 顶部总计（PV / UV）—— 昨天口径下数值必须不同。
  //    ⚠️ 明细排行 SQL 也含 COUNT(*) AS pv, COUNT(DISTINCT openid) AS uv，
  //       但带 GROUP BY：不加这层排除会把 10 行排行吃掉只剩 1 行（横条断言假红）。
  if (/COUNT\(\*\) AS pv, COUNT\(DISTINCT openid\) AS uv/.test(s) && !/GROUP BY/.test(s)) {
    return [[{ pv: isY ? 17 : 42, uv: isY ? 4 : 9 }], []];
  }
  // ② 三时点累计用户
  if (/COUNT\(DISTINCT CASE WHEN/.test(s)) return [[{ u0: 97, u1: 97, u7: 94 }], []];
  // ③a 页面级对比·段聚合（cmpSegment 第一条 SQL）：pv/uv/覆盖功能数/活跃天数/三类 PV
  //     数值按 from 的「日」派生，保证 A/B 两段日期不同 → 数值必然不同（不会假绿成同一份）
  if (/COUNT\(DISTINCT event\) AS evCnt/.test(s)) {
    const from = String((args && args[args.length - 2]) || '2026-11-01');
    const dom = Number(from.slice(-2)) || 1;
    return [[{
      pv: 100 + dom * 2, uv: 6 + (dom % 4), evCnt: 8, dayCnt: 1,
      pageViews: 70 + dom, opens: 20 + dom, actions: 30 + dom
    }], []];
  }
  // ③a2 页面级对比·段分时（cmpSegment 第二条 SQL）：24 整点，值随段变
  if (/GROUP BY HOUR\(ts\)/.test(s)) {
    const from = String((args && args[args.length - 2]) || '2026-11-01');
    const dom = Number(from.slice(-2)) || 1;
    const base = 1 + (dom % 5);
    const rows = [];
    for (let h = 0; h < 24; h++) {
      rows.push({
        h: h,
        visitUsers: base + (h % 4),
        opens: base + (h % 3),
        pageViews: base + (h === 9 ? 12 : (h === 19 ? 7 : 0))
      });
    }
    return [rows, []];
  }
  // ③ 分时趋势：三天 × 24 小时 × 三指标
  if (/HOUR\(ts\) AS h/.test(s)) {
    const rows = [];
    [0, 1, 7].forEach((off) => {
      for (let h = 0; h < 24; h++) {
        const base = off === 0 ? 1 : (off === 1 ? 2 : 0);
        rows.push({
          offDay: off, h: h,
          visitUsers: base + (h % 3),
          opens: base + (h % 4),
          pageViews: base + (h === 11 ? 8 : (h === 7 ? 4 : 0))
        });
      }
    });
    return [rows, []];
  }
  // ④ 活跃概况：目标日 / 前一日 / 7 日前。
  //    ⚠️ 目标日偏移藏在 args 末尾三个 IN (?, ?, ?) 参数里，不能靠 SQL 里的
  //       DATE(ts)=昨天 判断 —— 概况 SQL 用的是 DATEDIFF，压根不含那串条件。
  //       否则点「昨天」后前端按 targetOffset=1 取到的会是「前一日」那行（28/65/269）。
  if (/AS offDay/.test(s)) {
    const o = args.length >= 3 ? Number(args[args.length - 3]) : 0;
    const isTargetY = o === 1;
    return [[
      { offDay: o, visitUsers: isTargetY ? 4 : 11, opens: isTargetY ? 6 : 17, pageViews: isTargetY ? 20 : 51 },
      { offDay: o + 1, visitUsers: 28, opens: 65, pageViews: 269 },
      { offDay: o + 7, visitUsers: 5, opens: 13, pageViews: 75 }
    ], []];
  }
  // ⑤ 访问类型分布（设备平台的替代口径）
  if (/GROUP BY kind/.test(s)) {
    return [[{ kind: 'page_view', pv: 31, uv: 9 }, { kind: 'action', pv: 11, uv: 6 }], []];
  }
  // ⑥ 功能排行（同时供「访问来源 Top10」横条复用）
  if (/GROUP BY event, kind, ref/.test(s)) {
    const defs = [
      ['home', 'page_view', '', 9, 6], ['duty', 'page_view', '', 5, 4],
      ['fee_open', 'action', 'class', 4, 3], ['fee_open', 'action', 'league', 3, 2],
      ['roster', 'page_view', '', 3, 3], ['notice_open', 'action', '', 2, 2],
      ['timetable', 'page_view', '', 2, 2], ['mine', 'page_view', '', 1, 1],
      ['about', 'action', '', 1, 1], ['homework_open', 'action', '', 1, 1]
    ];
    return [defs.map((d) => ({ event: d[0], kind: d[1], ref: d[2], pv: d[3], uv: d[4], lastTs: '2026-11-08 23:00' })), []];
  }
  // ⑦ Top 事件（逐日趋势用）
  if (/GROUP BY event ORDER BY COUNT\(\*\) DESC LIMIT 8/.test(s)) {
    return [[{ event: 'home' }, { event: 'duty' }], []];
  }
  if (/GROUP BY event, DATE_FORMAT/.test(s)) return [[], []];
  // ⑧ 每日活跃总览
  if (/GROUP BY DATE_FORMAT\(DATE\(ts\)/.test(s)) {
    return [[{ d: todayStr(0), pv: 42 }, { d: todayStr(1), pv: 17 }, { d: todayStr(7), pv: 8 }], []];
  }
  // ⑨ 成员明细 / 功能点次
  if (/LEFT JOIN member/.test(s) && /GROUP BY e\.openid, e\.class_id/.test(s)) {
    return [[{
      openid: 'o1', class_id: 3, memberName: '示例成员01', studentNo: '2099010101',
      className: '示例专业A1班', pv: 12, activeDays: 3, lastTs: '2026-11-08 23:00'
    }], []];
  }
  if (/GROUP BY e\.openid, e\.event, e\.ref/.test(s)) {
    return [[{ openid: 'o1', event: 'home', ref: '', cnt: 8 }], []];
  }
  return [[], []];
}

const POOL = {
  calls: [],
  /** 课表接口的 group 参数（A/B），mock 靠它过滤 group_scope */
  _group: null,
  async query(sql, args) {
    POOL.calls.push({ sql: String(sql), args: args || [] });
    const s = String(sql);
    // 使用统计的聚合查询全部走专用夹具：通用分支不认 GROUP BY / SUM(CASE)，
    // 会把「昨天」这类条件当成普通 SELECT，导致统计页整页空白（断言假红）。
    if (/FROM usage_event/i.test(s)) return usageEventMock(s, args || []);
    // INSERT 进会话表要真的记进去，否则后续 Cookie 校验查不到
    if (/INSERT INTO admin_session/i.test(s)) {
      const a = args || [];
      TABLES.admin_session.push({
        id: TABLES.admin_session.length + 1, sid: a[0], admin_id: a[1],
        expires_at: '2099-01-01', ip: a[3], ua: a[4]
      });
      return [{ insertId: TABLES.admin_session.length }, []];
    }
    if (/^\s*SELECT COUNT/i.test(s)) {
      const t = mainTableOf(s);
      // ⚠️ COUNT 也必须按同一套条件过滤，否则会出现「列表 1 人但写着共 6 人」——
      //    分页 total 与实际条数不一致，断言与用户看到的都对不上（2026-10-10 实踩）。
      const all = (TABLES[t] || []).filter((r) => rowMatches(r, s, args || []));
      return [[{ c: all.length }], []];
    }
    if (/^\s*DELETE FROM/i.test(s)) {
      // 保守的 DELETE 模拟：只吃 `DELETE FROM t WHERE col = ?`（单等号）这一种形态。
      // 带 IN / >= / 子查询的删除一律**不动数据**返回 0 行 ——
      // 宁可少删（断言会红），也不能因为 mock 不保真把整张表清了（断言假绿）。
      if (/\(SELECT|IN\s*\(|>=|<=|<|>/.test(s)) return [{ affectedRows: 0 }, []];
      const t = (s.match(/^DELETE FROM `?(\w+)`?/i) || [])[1];
      const tbl = TABLES[t];
      if (!tbl) return [{ affectedRows: 0 }, []];
      const cond = /WHERE\s+(?:`?\w+`?\.)?`?(\w+)`?\s*=\s*\?\s*$/i.exec(s);
      if (!cond) return [{ affectedRows: 0 }, []];
      const key = (args || [])[0];
      const keep = tbl.filter((r) => String(r[cond[1]]) !== String(key));
      const affected = tbl.length - keep.length;
      tbl.length = 0;
      keep.forEach((r) => tbl.push(r));
      return [{ affectedRows: affected }, []];
    }
    if (/^\s*UPDATE/i.test(s)) {
      /**
       * 模拟 `UPDATE t SET col = ?[, col = ?]... WHERE id = ?`（[6.2b] 新增）。
       *
       * 🔴 为什么必须真落库：早前 mock 对写操作一律不生效，于是
       *   「配置班级 → 改大节时间 → 保存 → 看添加课次下拉」这类断言**必然假红**
       *   （保存返回成功但夹具没变，页面当然拿不到新配置）。
       *   同 DELETE 段的保守原则：只吃最朴素的 `SET a = ?, b = ?` + `WHERE id = ?` 形态，
       *   其余（子查询 / IN / 范围条件）一律不动数据只报 0 行 —— 宁可少改，不能乱改。
       */
      const t = (s.match(/^UPDATE\s+`?(\w+)`?/i) || [])[1];
      const tbl = TABLES[t];
      const whereId = /WHERE\s+(?:`?\w+`?\.)?`?id`?\s*=\s*\?\s*$/i.exec(s);
      if (!tbl || !whereId) return [{ affectedRows: 0 }, []];
      if (/\(SELECT|IN\s*\(|>=|<=|<|>/.test(s.replace(/WHERE[\s\S]*$/i, ''))) {
        return [{ affectedRows: 0 }, []];
      }
      const setPart = (s.match(/^UPDATE\s+`?\w+`?\s+SET\s+([\s\S]+?)\s+WHERE/i) || [])[1] || '';
      const cols = [];
      const re = /`?(\w+)`?\s*=\s*\?/g;
      let m;
      while ((m = re.exec(setPart))) cols.push(m[1]);
      const idVal = (args || [])[args.length - 1];
      const vals = (args || []).slice(0, cols.length);
      const row = tbl.find((r) => String(r.id) === String(idVal));
      if (!row) return [{ affectedRows: 0 }, []];
      cols.forEach((c, i) => { row[c] = vals[i]; });
      return [{ affectedRows: 1 }, []];
    }
    /**
     * JOIN 查询：把两张表按主键拼起来，而不是只返回 FROM 那一张。
     * 首版只认 FROM 表 ⇒ `admin_session JOIN admin_user` 拿不到 username/member_id，
     * 表现为「登录返回 200 且 Cookie 正常，但紧接着 /api/me 永远 401」——
     * 看起来像会话逻辑坏了，其实是 mock 少拼了 JOIN 那一侧。
     */
    if (process.env.SQLDEBUG) {
      console.error('[sql]', s.replace(/\s+/g, ' '));
      console.error('[args]', JSON.stringify(args || []));
    }
    const join = s.match(/JOIN\s+`?(\w+)`?\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/i);
    if (join) {
      const [, joinTable, joinAlias, lAlias, lCol, rAlias, rCol] = join;
      const fromTable = mainTableOf(s);
      const right = TABLES[joinTable] || [];
      /**
       * ⚠️ 关联键的左右**归属必须按别名判定，不能按位置**（2026-10-10 实踩两次）：
       *   `session s JOIN course c ON c.id = s.course_id`  ← 左边是 JOIN 表
       *   `admin_session s JOIN admin_user a ON a.id = s.admin_id` ← 右边是主表
       * 早前按「第 3 组=主表字段」硬编码，于是课表 JOIN 拿 session.id 去比
       * course.course_id（不存在）⇒ 全表关联不上 ⇒ 页面只剩表头，看着像后端没返数据。
       */
      const leftIsJoin = lAlias === joinAlias;
      const fromKey = leftIsJoin ? rCol : lCol;
      const joinKey = leftIsJoin ? lCol : rCol;
      if (process.env.SQLDEBUG) {
        console.error('[join]', fromTable, fromKey, '<->', joinTable, joinKey);
      }
      const merged = (TABLES[fromTable] || []).map((row) => {
        const link = right.find((r) => String(row[fromKey]) === String(r[joinKey]));
        if (!link) return null;
        const out = Object.assign({}, row);
        Object.keys(link).forEach((k) => { if (out[k] === undefined) out[k] = link[k]; });
        return out;
      }).filter(Boolean);
      return [applyScalarSubqueries(applyWhere(merged, s, args), s), []];
    }
    const table = mainTableOf(s)
      || (s.match(/INTO\s+`?(\w+)`?/) || [])[1]
      || (s.match(/UPDATE\s+`?(\w+)`?/) || [])[1];
    /**
     * ⚠️ 这里**必须**做最小条件过滤，否则 e2e 会得出完全相反的结论：
     *   后端把 `NOT_TEST` / `class_id = ?` 写进 SQL 是真过滤（MySQL 会执行），
     *   但 mock 若原样返回全表，前端就会把测试超管也渲染出来 ——
     *   断言「成员列表不含测试超管」反而会**失败**，看起来像代码有 bug，
     *   实则是 mock 不保真。生产代码的 NOT_TEST 已由 check-admin-web 门禁锁定。
     */
    let rows = (TABLES[table] || []).slice();
    if (process.env.SQLDEBUG) {
      console.error('[sql]', s.replace(/\s+/g, ' '));
      console.error('[args]', JSON.stringify(args || []));
      console.error('[table]', table, '=> rows', rows.length);
    }
    /**
     * ⚠️ 必须做条件过滤，否则 e2e 会得出完全相反的结论：
     *   后端把 NOT_TEST / class_id = ? 写进 SQL 是真过滤（MySQL 会执行），
     *   但 mock 若原样返回全表，前端就会把测试超管也渲染出来 ——
     *   断言「成员列表不含测试超管」反而会失败，看起来像代码有 bug，实则是 mock 不保真。
     */
    /**
     * ⚠️ 必须做条件过滤，否则 e2e 会得出完全相反的结论：
     *   后端把 NOT_TEST / class_id = ? 写进 SQL 是真过滤（MySQL 会执行），
     *   但 mock 若原样返回全表，前端就会把测试超管也渲染出来 ——
     *   断言「成员列表不含测试超管」反而会失败，看起来像代码有 bug，实则是 mock 不保真。
     */
    rows = applyWhere(rows, s, args);
    // 成员列表用 `LIMIT ? OFFSET ?`：args 末尾是 OFFSET，倒数第二才是 LIMIT。
    // 早前一律取最后一个，第 1 页 offset=0 被当成「不限条数」，分页断言无法保真。
    if (/LIMIT \?/i.test(s) && args && args.length) {
      const hasOffset = /LIMIT\s+\?\s+OFFSET\s+\?/i.test(s);
      const n = Number(args[hasOffset ? args.length - 2 : args.length - 1]);
      const off = hasOffset ? Number(args[args.length - 1]) : 0;
      if (!isNaN(n) && n > 0) rows = rows.slice(off, off + n);
      else if (!isNaN(off) && off > 0) rows = rows.slice(off);
    }
    return [applyScalarSubqueries(rows, s), []];
  },
  async getConnection() {
    const self = this;
    return {
      async beginTransaction() {}, async commit() {}, async rollback() {},
      async ping() {}, release() {},
      query: function (sql, args) { return self.query(sql, args); }
    };
  }
};
const stub = new Module(dbPath);
stub.filename = dbPath;
stub.loaded = true;
stub.exports = { getPool: function () { return POOL; } };
// Windows 下 Node 的 module cache key 大小写/分隔符取决于加载时传入的路径，
// 与 require.cache 的键可能不完全一致 ⇒ 两种写法都登记一份，确保一定拦得住。
require.cache[dbPath] = stub;
require.cache[dbPath.replace(/\\/g, '/')] = stub;
require.cache[require.resolve(dbPath)] = stub;

// 打桩就位后才允许加载 admin-web
const app = require(path.join(ADMIN, 'index.js'));
const PORT = 3122;
// ⚠️ e2e 必须从 **/admin** 进去，而不是根路径（2026-10-10 修正）。
//    线上 gatewayPath="/admin" ⇒ 网关只转发 /admin 前缀，页面里所有资源与 API 都带该前缀。
//    本地跑根路径时 API_BASE 推导成 ''、资源也不带前缀，**测的是另一套路径形态** ——
//    这正是「静态资源写 /app.js 导致线上登录按钮完全失效」能一路逃过 43 项 e2e 的原因：
//    本地全绿、线上全挂。改成本地也走 /admin 后，路径形态与线上一致，缺前缀会当场红。
const BASE = 'http://127.0.0.1:' + PORT + '/admin';

/* ---------------- 断言 ---------------- */
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push({ name, extra }); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

(async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = app.listen(PORT);
  await new Promise((r) => server.once('listening', r));
  console.log('[e2e] 服务已起 ' + BASE);

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrs = [];
  /**
   * 「预期中的失败请求」窗口：只在故意造负例的那几步里打开。
   * ⚠️ 不要用 URL/状态码黑名单去滤 console 错误 —— 那样写出来的规则会随接口增减而失效，
   * 且**永远滤不干净**（浏览器还会另打一条 "Failed to load resource"，URL 不在你的列表里）。
   * ⚠️ 也**不要写死条数**（如 markExpect(4)）：前端到底发了几次请求会随实现变，
   * 多写少了会漏掉真错误，少写了会让这条断言变成永远失败的红线。
   * 正解：布尔窗口 —— 打开后由该步结束时显式关闭，只抑制窗口期内出现的错误。
   */
  let inExpected = false;
  const openExpect = () => { inExpected = true; };
  const closeExpect = () => { inExpected = false; };
  page.on('console', (m) => {
    if (m.type() !== 'error' || inExpected) return;
    consoleErrs.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (inExpected) return;
    consoleErrs.push('pageerror: ' + e.message);
  });
  // 后端就算 500 也只是一条 fetch 结果，前端可能吞掉；把非 2xx 的 API 响应抓出来，
  // 否则「统计全是 0」这种症状会被误判成前端渲染问题（2026-10-10 实踩）。
  page.on('response', async (r) => {
    if (!/\/api\//.test(r.url()) || r.status() < 400 || inExpected) return;
    let body = '';
    try { body = (await r.text()).slice(0, 300); } catch (e) { /* 已消费 */ }
    consoleErrs.push('HTTP ' + r.status() + ' ' + r.url() + ' :: ' + body);
  });

  try {
    /* --- 1. 未登录进不去 --- */
    console.log('\n[1] 未登录访问');
    // 未登录时前端主动探 /api/me，必然 401 —— 这是登录门禁在正常工作
    openExpect();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-view:not([hidden])', { timeout: 8000 });
    closeExpect();
    ok('未登录显示登录页', await page.isVisible('#login-view'));
    ok('主界面隐藏', !(await page.isVisible('#main-view')));
    await page.screenshot({ path: path.join(SHOTS, '01-login.png') });

    /* --- 2. 错误口令被拒 --- */
    console.log('\n[2] 错误口令');
    openExpect(); // 故意用错口令，应 401
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'wrong-pass');
    await page.click('#login-btn');
    // ⚠️ 这里刻意包了 try/catch 并 dump 现场（2026-10-10 踩坑时加的）：
    //   waitForSelector 超时只抛一行 Timeout，看不出到底是「登录页没渲染」
    //   还是「点了按钮没发请求」。dump 出 err/btn 状态 + 当前 URL（URL 带 ?password=
    //   就说明退化成了原生表单提交 = app.js 没执行）。
    try {
      await page.waitForSelector('#login-err:not([hidden])', { timeout: 8000 });
    } catch (e) {
      console.log('  [dbg 超时] 现场：', await page.evaluate(() => {
        const el = document.querySelector('#login-err');
        const btn = document.querySelector('#login-btn');
        return JSON.stringify({
          errHidden: el ? el.hidden : null, errText: el ? el.textContent : null,
          btnDisabled: btn ? btn.disabled : null, btnText: btn ? btn.textContent : null,
          url: location.href
        });
      }));
      throw e;
    }
    closeExpect();
    ok('错误口令给出中文提示', (await page.textContent('#login-err')).length > 2);
    ok('错误口令不进入主界面', !(await page.isVisible('#main-view')));
    await page.screenshot({ path: path.join(SHOTS, '02-login-fail.png') });

    /* --- 3. 非超管登不进 --- */
    console.log('\n[3] 非超管账号被拒');
    openExpect(); // 故意用非超管账号登录，应被拒
    await page.fill('#login-username', 'notsuper');
    await page.fill('#login-password', 'User@2026');
    await page.click('#login-btn');
    await page.waitForTimeout(900);
    closeExpect();
    const notSuperMsg = (await page.textContent('#login-err')) || '';
    ok('非超管被拒绝登录', /超级管理员|不正确/.test(notSuperMsg), notSuperMsg);
    ok('非超管未进入主界面', !(await page.isVisible('#main-view')));

    /* --- 4. 正常登录 --- */
    console.log('\n[4] 超管登录');
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'Admin@2026');
    await page.click('#login-btn');
    await page.waitForSelector('#main-view:not([hidden])', { timeout: 10000 });
    ok('登录后进入主界面', await page.isVisible('#main-view'));
    const cookies = await ctx.cookies();
    const sid = cookies.find((c) => c.name === 'admin_sid');
    ok('写入了 admin_sid Cookie', !!sid);
    ok('Cookie 是 HttpOnly', !!(sid && sid.httpOnly));
    ok('Cookie 有 SameSite', !!(sid && /Lax/.test(String(sid.sameSite))));
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.screenshot({ path: path.join(SHOTS, '03-overview.png'), fullPage: true });

    /* --- 5. 概览数字 --- */
    console.log('\n[5] 概览');
    const statVals = await page.$$eval('.stat-value', (els) => els.map((e) => e.textContent.trim()));
    ok('概览有统计卡', statVals.length >= 4, JSON.stringify(statVals));
    ok('班级数为 3', statVals[0] === '3', statVals[0]);
    // 成员数 = 6 个夹具 − 1 个测试账号 = 5（测试超管必须不算）
    ok('成员数排除测试账号（应为 5）', statVals[1] === '5', '实际 ' + statVals[1]);
    const overviewBody = await page.textContent('.tbl');
    ok('概览表格不出现测试超管', overviewBody.indexOf('测试超管') < 0);

    /* --- 6. 课程表 --- */
    console.log('\n[6] 课程表');
    // 显式切到 示例班级A：夹具的课次/成员都挂在这一班（默认选中的是列表第一个班），
    // 断言必须写明所依赖的班，否则换个夹具顺序就会莫名其妙地空表。
    await page.selectOption('#class-picker', '3');
    await page.waitForTimeout(600);
    await page.click('.nav-item[data-view="timetable"]');
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.waitForTimeout(300);
    const tt = await page.textContent('#view');
    if (process.env.SQLDEBUG) console.error('[view:课表]', tt.replace(/\s+/g, ' ').slice(0, 400));
    ok('课表列出大学语文', tt.indexOf('大学语文') >= 0);
    ok('全体课有独立标记', tt.indexOf('全体') >= 0);
    await page.screenshot({ path: path.join(SHOTS, '04-timetable.png'), fullPage: true });

    // 切 A 组：本组 + 全体，A 组独有课应出现
    await page.click('.seg-btn[data-group="A"]');
    await page.waitForTimeout(700);
    const ttA = await page.textContent('#view');
    if (process.env.SQLDEBUG) console.error('[view:课表A组]', ttA.replace(/\s+/g, ' ').slice(0, 400));
    ok('A 组视图含本组课（大学语文）', ttA.indexOf('大学语文') >= 0);
    ok('A 组视图含全体课（高等数学）', ttA.indexOf('高等数学') >= 0);
    ok('A 组视图不含 B 组独有课', ttA.indexOf('大学英语') < 0);
    await page.screenshot({ path: path.join(SHOTS, '05-timetable-groupA.png'), fullPage: true });
    await page.click('.seg-btn[data-group="ALL"]');
    await page.waitForTimeout(600);

    /* --- 6.2 大节下拉随班级配置变化（2026-10-14 用户实锤：配了第6节，下拉仍只有5项） ---
     * 夹具：示例班级A 配 6 节、2601 配 5 节 ⇒ 两个班的下拉项数必须不同。
     * 这组断言能抓住的三类回退：
     *   ① 下拉写死 [1,2,3,4,5]（periodOptions 退化成常量）；
     *   ② 下拉读的是「页面加载时的班级快照」，切班后不更新；
     *   ③ periodOptions 读错字段（periodTime 拼错 / 从 course 读）。 */
    console.log('\n[6.2] 大节下拉随班级配置变化');
    async function periodOptsOf(clsId) {
      await page.selectOption('#class-picker', String(clsId));
      await page.waitForTimeout(700);
      await page.click('.nav-item[data-view="timetable"]').catch(() => {});
      await page.waitForSelector('.tbl', { timeout: 8000 });
      await page.waitForTimeout(250);
      await page.click('#btn-add');
      await page.waitForSelector('#a-period', { timeout: 8000 });
      const opts = await page.$$eval('#a-period option', (els) => els.map((e) => e.textContent.trim()));
      const target = await page.$eval('.dlg-bd .hint', (e) => e.textContent.trim()).catch(() => '');
      await page.evaluate(() => { const d = document.querySelector('.dlg-mask'); if (d) d.remove(); });
      await page.waitForTimeout(150);
      return { opts, target };
    }
    const p6 = await periodOptsOf(3);   // 夹具配 6 节
    const p5 = await periodOptsOf(1);   // 夹具配 5 节
    ok('配 6 节的班下拉有 6 项', p6.opts.length === 6, '实际 ' + p6.opts.length + ' 项：' + p6.opts.join('/'));
    ok('配 6 节的班下拉含「第 6 节」', p6.opts.indexOf('第 6 节') >= 0, p6.opts.join('/'));
    ok('配 5 节的班下拉有 5 项（不是恒为 6）', p5.opts.length === 5, '实际 ' + p5.opts.length + ' 项');
    ok('两个班的下拉确实随配置变化（不是写死）', p6.opts.length !== p5.opts.length,
      p6.opts.length + ' vs ' + p5.opts.length);
    ok('弹层标注的班级与所选班一致（防「看到 A 班导进 B 班」）',
      /示例班级A/.test(p6.target) && /2601/.test(p5.target), p6.target + ' / ' + p5.target);

    /* --- 6.2b 保存后立即生效（2026-10-14 第二个 bug：reload 不刷 state.classes） ---
       * 现象：配置弹层保存成功 ⇒ 弹层关闭、列表重渲染，但 state.classes 还是旧配置，
       *   紧接着打开「添加课次」，下拉仍是保存前那几项 —— 用户以为"保存没生效"。
       * 做法：给 2601 配 6 节 → 保存 → 不刷新页面，直接打开添加课次看是不是 6 项。 */
    console.log('\n[6.2b] 班级配置保存后立即生效');
    await page.selectOption('#class-picker', '1');
    await page.waitForTimeout(600);
    await page.click('.nav-item[data-view="class"]');
    await page.waitForSelector('[data-c-edit]', { timeout: 8000 });
    await page.click('[data-c-edit="1"]');
    await page.waitForSelector('#c-pt', { timeout: 8000 });
    // 直接写规范格式（每行「序号 start-end」），不给配置弹层留歧义
    await page.fill('#c-pt', ['1 08:10-09:50', '2 10:10-11:50', '3 14:40-16:20',
      '4 16:30-18:10', '5 19:00-20:40', '6 16:30-17:15'].join('\n'));
    await page.click('#dlg-ok');
    await page.waitForSelector('#toast:not([hidden])', { timeout: 8000 });
    await page.waitForTimeout(900);
    // 页面未刷新（模拟"保存后不刷新"），但配置弹层保存成功 ⇒ state.classes 必须已被刷新
    await page.click('.nav-item[data-view="timetable"]').catch(() => {});
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.click('#btn-add');
    await page.waitForSelector('#a-period', { timeout: 8000 });
    const afterSave = await page.$$eval('#a-period option', (els) => els.map((e) => e.textContent.trim()));
    await page.evaluate(() => { const d = document.querySelector('.dlg-mask'); if (d) d.remove(); });
    ok('保存大节时间后，不刷新页面直接添加课次也能选到第 6 节（state.classes 已刷新）',
      afterSave.length === 6, '实际 ' + afterSave.length + ' 项：' + afterSave.join('/'));
    // 复位夹具，别影响后续用例
    TABLES.class[0].period_time = PERIOD_TIME_5;
    await page.selectOption('#class-picker', '3');   // 后续用例仍以 示例班级A 为准
    await page.waitForTimeout(600);

    /* --- 6.2c 保洁课次在后台课表页的显示口径（2026-10-14 自证） ---
     * 这里曾有一处自相矛盾：渲染时 `.filter(r => r.kind !== 'CLEAN')` 把保洁课次全部滤掉，
     * 同一段模板里却还留着「保洁」标签的分支（`<span class="tag tag-clean">保洁</span>`）
     * ⇒ 那段标签代码永远不可能命中，纯死代码 + 意图不明。
     * 现在统一为：**课程表页不显示保洁课次**（保洁只在值日/排班语境出现），
     * 标签分支随之删除，避免再有人以为「保洁标签应该出现在课表里」。
     * 断言：课表页既不出现「保洁」标签行，也不出现保洁课次名。 */
    console.log('\n[6.2c] 保洁课次不在后台课表页出现');
    ok('课表页不显示保洁标签（口径统一：CLEAN 只在值日语境）', tt.indexOf('保洁') < 0,
      tt.replace(/\s+/g, ' ').match(/.{0,30}保洁.{0,30}/) || '');
    ok('课表页不出现保洁课次名（打扫410/大扫除）',
      tt.indexOf('打扫410') < 0 && tt.indexOf('大扫除') < 0);
    ok('渲染层没有死代码：过滤掉 CLEAN 后不应再留保洁标签分支',
      !/tag-clean/.test(fs.readFileSync(path.join(ADMIN, 'public', 'app.js'), 'utf8')),
      'app.js 里还有 tag-clean 标签分支（已被 filter 掉，永不命中）');

    /* --- 6.2c-2 编辑课次的大节校验（2026-10-14 用户实锤第二个 bug） ---
     * 现象：课次加错星期后想直接改，保存报「大节应为 1-5」，只能删除重加。
     * 病根：`mod-course.js` 的 `addSession` 已改成读本班配置（nPeriods），
     *   但 **`updateSession` 里那一行还写死 5** ⇒ 编辑比新增更严，逻辑不自洽。
     * 做法：给 示例班级A（配 6 节）加一节第 6 节的课 → 编辑它改成别的星期/大节 → 保存应成功。 */
    console.log('\n[6.2c-2] 编辑课次的大节校验与本班配置一致');
    {
      /* 🔧 先隔离 mock 保真度：直接问它「period_time 查询能不能答上行」，
       *    否则待会儿断言红时，分不清是后端代码错还是 mock 返回空（2026-10-14 卡在这）。
       */
      const ptRows = await POOL.query('SELECT period_time FROM `class` WHERE id = ? LIMIT 1', [3]);
      const ptVal = ptRows[0] && ptRows[0][0] ? ptRows[0][0].period_time : null;
      const ptArr = ptVal ? (typeof ptVal === 'string' ? JSON.parse(ptVal) : ptVal) : [];
      ok('mock 能答出 示例班级A 的 period_time（mock 保真度自检）',
        ptArr.length > 0,
        '实际 ' + JSON.stringify(ptVal).slice(0, 80));
      // 直接问后端那个函数算出的节次数（同一个 require 实例，不经过 HTTP）
      const calc = require(path.join(ADMIN, 'common', 'week.js')).periodCount({ periodTime: ptVal });
      ok('periodCount 对 示例班级A 的配置算出 ≥6 节（生产口径）', calc >= 6,
        '算出 ' + calc + ' 节（period_time 有 ' + ptArr.length + ' 项）');
      if (calc < 6) {
        // 打出三班的真实值，一眼看出是哪一行被谁改坏了
        console.log('    [dbg] 三班 period_time 项数: ' +
          TABLES.class.map((c) => c.id + '=' + (JSON.parse(c.period_time || '[]') || []).length).join(', '));
      }
      const sid = await page.evaluate(async (b) => {
        // 通过后台自己的接口加一节第 6 节课（模拟用户先加错、后来要改）
        const r = await fetch(b + '/api/timetable/session', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ classId: 3, courseName: '回归测试课', room: 'X1', dayOfWeek: 3, period: 6, groupScope: 'ALL', weekRule: 'ALL', weeks: '', dutyCount: 0 })
        });
        return (await r.json());
      }, BASE);
      /* ⚠️ 判据只认「接口没报节次错」。mock 不做 INSERT 落库 ⇒ sessionId 恒为 null，
       *   拿它去点编辑按钮会假红（那是 mock 的限制，不是被测行为）。 */
      ok('可新增第 6 节课次（addSession 按本班配置放行，未报 1-5）',
        !!(sid && sid.ok) && !/1-5/.test(JSON.stringify(sid)),
        JSON.stringify(sid).slice(0, 160));

      // 再用「编辑」接口验证：把一节现有的第 6 节课次的星期改掉，应保存成功
      const upd = await page.evaluate(async (b) => {
        const r = await fetch(b + '/api/timetable/session/106', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dayOfWeek: 5, period: 6 })
        });
        return (await r.json());
      }, BASE);
      ok('编辑第 6 节课次（改星期）不再报「大节应为 1-5」',
        !!(upd && upd.ok) && !/1-5/.test(JSON.stringify(upd)),
        JSON.stringify(upd).slice(0, 160));
      // 复位：改回周三
      await page.evaluate(async (b) => {
        await fetch(b + '/api/timetable/session/106', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dayOfWeek: 3, period: 6 })
        });
      }, BASE);
    }

    /* --- 6.5 删课次（2026-10-10 新增能力） --- */
    console.log('\n[6.5] 删课次');
    const beforeRows = await page.$$eval('#view tbody tr', (els) => els.length);
    const beforeSessions = TABLES.session.length;
    // Playwright 默认把 confirm 全 dismiss ⇒ 不 accept 的话删除永远不会发生，
    // 断言「课次少了 1」就会假红，看起来像删除功能坏了
    page.once('dialog', (d) => d.accept());
    await page.click('[data-del-session="101"]');
    await page.waitForTimeout(800);
    /* 夹具 示例班级A 有 5 条 session（101/102/104/106 课程 + 103 保洁 CLEAN），
     * 而课表页**按设计过滤掉 CLEAN**（见 [6.2c]）⇒ 页面上只有 4 行。
     * 早前这里断言「4 行」而当时夹具只有 4 条 session（过滤后 3 行）⇒ 长期假红；
     * 加了第 6 节课次(106) 后正确值是 4 行。断言必须写明算式，别写裸数字。 */
    ok('删除前课表有 4 行（5 条 session − 1 条 CLEAN 保洁）', beforeRows === 4, '实际 ' + beforeRows);
    ok('确认后课次真的少了一行（页面就地刷新）',
      (await page.$$eval('#view tbody tr', (els) => els.length)) === beforeRows - 1);
    ok('session 表真删了那一行（不是 mock 假删）',
      TABLES.session.length === beforeSessions - 1 && !TABLES.session.some((r) => r.id === 101));
    ok('删除走了备份（先写 bak_admin_session）',
      POOL.calls.some((c) => /INSERT INTO `?bak_admin_session`?/.test(c.sql)));
    ok('删除有审计（session.delete）',
      POOL.calls.some((c) => /session\.delete|INSERT INTO admin_audit_log/.test(c.sql)));
    // CLEAN 保洁课次也该有删除按钮，但这里不点（夹具里它被 listTimetable 返回）
    await page.screenshot({ path: path.join(SHOTS, '05b-session-deleted.png'), fullPage: true });

    /* --- 6.6 清空课表（2026-10-12 新增能力） --- */
    console.log('\n[6.6] 清空课表');
    // 6.5 删课后已就地刷新，这里再确认停在 示例班级A 课表页
    await page.click('.nav-item[data-view="timetable"]').catch(() => {});
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.waitForTimeout(300);
    ok('课表页有「清空课表」按钮', await page.isVisible('#btn-clear'));
    // 打开弹窗，验证 A/B/全部 三组选项 + 默认预览
    await page.click('#btn-clear');
    await page.waitForSelector('.dlg', { timeout: 5000 });
    const clearDlg = await page.textContent('.dlg');
    ok('清空弹窗含 A 组选项', clearDlg.indexOf('A 组') >= 0);
    ok('清空弹窗含 B 组选项', clearDlg.indexOf('B 组') >= 0);
    ok('清空弹窗含 全部 选项', clearDlg.indexOf('全部') >= 0);
    ok('清空弹窗默认给出干跑预览', (await page.textContent('#c-preview')).replace(/\s+/g, '').length > 2);
    await page.click('#c-cancel');
    await page.waitForTimeout(200);

    // 干跑预览（经真实路由，走真 clearTimetable 的 SELECT 口径）
    const dryA = await page.evaluate(async (b) => {
      const r = await fetch(b + '/api/timetable/clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ classId: 3, groupScope: 'A', dryRun: true })
      });
      return r.json();
    }, BASE);
    ok('清空 dry-run(A) 返回 ok', dryA.ok === true, JSON.stringify(dryA));
    ok('dry-run(A) 返回 A 组口径（dryRun + groupScope）',
      dryA.data && dryA.data.dryRun === true && dryA.data.groupScope === 'A', JSON.stringify(dryA.data));
    // ⚠️ className 不在这里断言：mock 的 rowMatches 只按 `别名.列` 过滤，
    //   clearTimetable 查 class 用的是未加别名的 `WHERE id = ?`，mock 取不中条件
    //   会回退到首行夹具（示例班级C），这是测试桩的局限，不是代码问题 ——
    //   真实 MySQL 下 `WHERE id = ?` 正常生效。A 组过滤由下方 oldSessionCount 验证。
    // 6.5 已删掉 A 组唯一的 大学语文(id101)，故 A 组剩余 COURSE 课次应为 0
    ok('dry-run(A) 统计到 0 个 A 组课次（与删课次后状态一致）',
      dryA.data && dryA.data.oldSessionCount === 0, JSON.stringify(dryA.data));

    // 提交清空（ALL）：mock 的 IN 删除不真删数据，这里只验「走了备份 + 写了审计」
    const beforeCalls = POOL.calls.length;
    const commitAll = await page.evaluate(async (b) => {
      const r = await fetch(b + '/api/timetable/clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ classId: 3, groupScope: 'ALL', dryRun: false })
      });
      return r.json();
    }, BASE);
    ok('清空提交(ALL) 返回 ok', commitAll.ok === true, JSON.stringify(commitAll));
    ok('清空走了备份（bak_admin_session / bak_admin_course）',
      POOL.calls.slice(beforeCalls).some((c) => /INSERT INTO `?bak_admin_(session|course)`?/.test(c.sql)));
    ok('清空写了审计（timetable.clear）',
      POOL.calls.slice(beforeCalls).some((c) => /timetable\.clear|INSERT INTO admin_audit_log/.test(c.sql)));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, '05c-clear.png'), fullPage: true });

    /* --- 7. 成员：测试账号不显示 --- */
    console.log('\n[7] 成员');
    await page.click('.nav-item[data-view="member"]');
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.waitForTimeout(300);
    const mem = await page.textContent('#view');
    if (process.env.SQLDEBUG) console.error('[view:成员]', mem.replace(/\s+/g, ' ').slice(0, 500));
    ok('成员列表不含测试超管', mem.indexOf('测试超管') < 0);
    ok('成员列表不含 99 段学号', mem.indexOf('0000000000') < 0);
    ok('成员列表含真实成员', mem.indexOf('示例成员01') >= 0);
    ok('超管有标记', mem.indexOf('超管') >= 0);
    ok('停用状态有标记', mem.indexOf('停用') >= 0);
    ok('不参与值日标记可见', mem.indexOf('是（不排值日）') >= 0 || mem.indexOf('不排值日') >= 0);
    // 2026-11-12：绑定情况并入成员列表（原独立「绑定」页已删），这里验真渲染：
    // 表头有「绑定」列，且已绑定（示例成员01 o1）/ 未绑定（王五 openid=null）两种标签都出得来。
    const memHead = await page.textContent('#view .tbl thead');
    ok('成员表头含「绑定」列', /绑定/.test(memHead), memHead.replace(/\s+/g, ' '));
    ok('绑定列渲染「已绑定」', mem.indexOf('已绑定') >= 0);
    ok('绑定列渲染「未绑定」', mem.indexOf('未绑定') >= 0);
    ok('独立绑定页已移除（导航无 binding）',
      (await page.$$('.nav-item[data-view="binding"]')).length === 0);
    await page.screenshot({ path: path.join(SHOTS, '06-member.png'), fullPage: true });

    /* --- 7.5 右上角切班：就地刷新，不跳回概览（2026-10-10 用户要求） ---
       源码判据（check-admin-web）只能证明「没写 go('overview')」，
       证明不了「运行时真的没跳走」—— reload() 一旦在某个视图里抛错就会白屏，
       所以这里必须在真实浏览器里点一遍。 */
    console.log('\n[7.5] 切班不跳页');
    const opts = await page.$$eval('#class-picker option', (els) => els.map((e) => e.value));
    const switchTo = opts.length > 1 ? (opts.indexOf('3') >= 0 ? opts.find((v) => v !== '3') : opts[1]) : null;
    if (!switchTo) {
      ok('夹具至少要有 2 个班才能验切班', false, 'option=' + JSON.stringify(opts));
    } else {
      await page.selectOption('#class-picker', switchTo);
      await page.waitForTimeout(700);
      ok('切班后仍停在成员页（没被踢回概览）',
        await page.isVisible('.nav-item[data-view="member"].active'),
        '当前 active=' + await page.$eval('.nav-item.active', (e) => e.dataset.view));
      ok('切班后成员页内容仍在（就地刷新成功）',
        await page.isVisible('#btn-add') && /学号/.test(await page.textContent('#view')));
      ok('切班后成员列表仍可用（不是空态/错误态）',
        !/请先在右上角选择班级|加载失败/.test(await page.textContent('#view')));
      ok('切班给了可见反馈（toast）', await page.isVisible('#toast'),
        '概览/成员页不显示班级名，无提示会像没反应');
      // 切回 示例班级A，后续断言依赖这一班
      await page.selectOption('#class-picker', '3');
      await page.waitForTimeout(700);
    }
    await page.screenshot({ path: path.join(SHOTS, '06b-member-switch-class.png'), fullPage: true });

    /* --- 7.6 成员单独授予班费权限（2026-11-08） ---
       check-fee-perms.js 是源码级门禁，证明不了三件运行时的事：
       列表 tag 真渲染 / 编辑弹层勾选态真跟随库值 / 保存真把 fee_perms 回写。
       这里在真实浏览器里走一遍并留截图。 */
    console.log('\n[7.6] 成员单独授予权限');
    await page.click('.nav-item[data-view="member"]');
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.waitForTimeout(400);
    const permList = await page.textContent('#view');
    ok('列表显示额外授予的「登记班费」标签', permList.indexOf('+登记班费') >= 0);
    ok('未授予团费的成员不显示团费标签', permList.indexOf('+登记团费') < 0);

    const permRow = TABLES.member.find((m) => m.id === 55);
    await page.click('[data-m-edit="55"]');
    await page.waitForSelector('#f-perm-class', { timeout: 8000 });
    ok('编辑弹层有两个权限勾选框',
      await page.isVisible('#f-perm-class') && await page.isVisible('#f-perm-league'));
    ok('已授予的「登记班费」为勾选态', await page.isChecked('#f-perm-class'));
    ok('未授予的「登记团费」未勾选', !(await page.isChecked('#f-perm-league')));
    await page.screenshot({ path: path.join(SHOTS, '06c-member-perms.png') });
    // 弹层内容区比视口高：再滚到底截一张，确认第二个勾选框与说明文字排版正常
    await page.$eval('.dlg-mask .dlg-bd', (el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(SHOTS, '06d-member-perms-bottom.png') });

    await page.check('#f-perm-league');
    await page.click('.dlg-mask .dlg-ft .btn-primary');
    await page.waitForTimeout(800);
    ok('保存真的把 fee_perms 回写成 class,league',
      permRow.fee_perms === 'class,league', '实际 ' + permRow.fee_perms);
    ok('保存后列表出现「登记团费」标签',
      (await page.textContent('#view')).indexOf('+登记团费') >= 0);
    // 兜底清理弹层，避免挡住后续 [8] 班级配置页的点击
    await page.evaluate(() => { const d = document.querySelector('.dlg-mask'); if (d) d.remove(); });

    /* --- 7.7 成员列表：页大小 10/30/50/全部 + 四选一筛选（2026-11-08） ---
       源码级判据在 check-member-filters.js；这里在真实浏览器里证明控件真发请求、
       真改表格，且「全部」真的不分页、搜索与筛选真的叠加。 */
    console.log('\n[7.7] 成员分页与筛选');
    await page.click('.nav-item[data-view="member"]');
    await page.waitForSelector('#m-size', { timeout: 8000 });
    await page.waitForTimeout(300);
    const rowsOf = () => page.$$eval('[data-m-edit]', (els) => els.length);
    const hd = () => page.textContent('.card-hd');
    const waitHd = (txt) => page.waitForFunction(
      (t) => { const e = document.querySelector('.card-hd'); return !!e && e.textContent.indexOf(t) >= 0; },
      txt, { timeout: 8000 });
    const memberSqlSince = (n) => POOL.calls.slice(n)
      .filter((c) => /SELECT m\.\* FROM member m/i.test(c.sql));

    ok('默认每页 50 人', (await page.inputValue('#m-size')) === '50');
    ok('默认「全部成员」选中', await page.isVisible('[data-scope="ALL"].active'));
    ok('默认列出本班 4 名非测试成员', (await rowsOf()) === 4, '实际 ' + (await rowsOf()));

    let c0 = POOL.calls.length;
    await page.selectOption('#m-size', '10');
    await waitHd('每页 10 人');
    ok('切 10 人/页：标题更新', (await hd()).indexOf('每页 10 人') >= 0);
    ok('切 10 人/页：真的把 pageSize=10 传给后端',
      memberSqlSince(c0).some((c) => c.args.indexOf(10) >= 0));

    await page.selectOption('#m-size', '30');
    await waitHd('每页 30 人');
    ok('切 30 人/页：标题更新', (await hd()).indexOf('每页 30 人') >= 0);

    c0 = POOL.calls.length;
    await page.selectOption('#m-size', '0');
    await waitHd('已显示全部');
    const allSql = memberSqlSince(c0);
    ok('切「全部」：标题显示已显示全部', (await hd()).indexOf('已显示全部') >= 0);
    ok('切「全部」：SQL 不带 LIMIT', allSql.length > 0 && allSql.every((c) => !/LIMIT \?/.test(c.sql)),
      'SQL 条数 ' + allSql.length);
    ok('切「全部」：不渲染分页按钮', (await page.$$('.pager')).length === 0);
    ok('切「全部」：4 人都在', (await rowsOf()) === 4);
    await page.screenshot({ path: path.join(SHOTS, '06e-member-filters.png') });

    await page.selectOption('#m-size', '50');
    await waitHd('每页 50 人');
    await page.click('[data-scope="COMMITTEE"]');
    await waitHd('仅班委');
    let viewText = await page.textContent('#view');
    ok('仅班委：只剩 2 人', (await rowsOf()) === 2, '实际 ' + (await rowsOf()));
    ok('仅班委：含示例成员01/示例成员42', viewText.indexOf('示例成员01') >= 0 && viewText.indexOf('示例成员42') >= 0);
    ok('仅班委：不含普通成员李四/王五',
      viewText.indexOf('李四') < 0 && viewText.indexOf('王五') < 0);
    ok('仅班委 chip 为选中态', await page.isVisible('[data-scope="COMMITTEE"].active'));

    await page.click('[data-scope="A"]');
    await waitHd('A 组');
    viewText = await page.textContent('#view');
    ok('A 组：只剩 2 人', (await rowsOf()) === 2);
    ok('A 组：含示例成员01/李四，不含示例成员42/王五',
      viewText.indexOf('示例成员01') >= 0 && viewText.indexOf('李四') >= 0 &&
      viewText.indexOf('示例成员42') < 0 && viewText.indexOf('王五') < 0);

    await page.click('[data-scope="B"]');
    await waitHd('B 组');
    viewText = await page.textContent('#view');
    ok('B 组：只剩 2 人', (await rowsOf()) === 2);
    ok('B 组：含示例成员42/王五，不含示例成员01/李四',
      viewText.indexOf('示例成员42') >= 0 && viewText.indexOf('王五') >= 0 &&
      viewText.indexOf('示例成员01') < 0 && viewText.indexOf('李四') < 0);

    await page.click('[data-scope="ALL"]');
    await waitHd('共 4 人');
    ok('切回全部成员：4 人都在', (await rowsOf()) === 4);

    await page.fill('#m-kw', '李四');
    await page.press('#m-kw', 'Enter');
    await waitHd('关键词');
    viewText = await page.textContent('#view');
    ok('搜索真的重渲染列表（只剩李四）', (await rowsOf()) === 1 && viewText.indexOf('李四') >= 0,
      '实际行数 ' + (await rowsOf()));
    ok('搜索关键词显示在标题上', (await hd()).indexOf('关键词「李四」') >= 0);
    await page.click('[data-scope="B"]');
    await page.waitForTimeout(400);
    ok('搜索与筛选叠加：李四(A组) + B组 = 空态',
      (await rowsOf()) === 0 && (await page.textContent('#view')).indexOf('当前筛选下没有成员') >= 0);
    await page.click('[data-scope="ALL"]');
    await page.fill('#m-kw', '');
    await page.press('#m-kw', 'Enter');
    await waitHd('共 4 人');
    ok('清空搜索后恢复 4 人', (await rowsOf()) === 4);

    /* --- 7.8 使用统计：昨天 + 四板块（2026-11-09） ---
       源码级判据在 check-usage-insights.js；这里在真实浏览器里证明四块都渲染、
       分时图固定 24 点、「昨天」真的把 days=-1 传到后端并换掉口径与数字。 */
    console.log('\n[7.8] 使用统计：昨天 + 四板块');
    await page.click('.nav-item[data-view="usage"]');
    await page.waitForTimeout(700);
    const usageText = await page.textContent('#view');
    const trendLines = () => page.$$eval('.trend-svg .trend-line',
      (els) => els.map((e) => e.getAttribute('d') || ''));
    const srcVals = () => page.$$eval('.src-val', (els) => els.map((e) => e.textContent.trim()));
    const totalVals = () => page.$$eval('.stat-row .stat-value',
      (els) => els.map((e) => e.textContent.trim()));

    ok('时间范围出现「昨天」按钮', (await page.$$('[data-rg="-1"]')).length === 1);
    ok('三个板块标题齐全',
      ['访问实时数据', '访问来源 Top10', '小程序活跃概况']
        .every((x) => usageText.indexOf(x) >= 0));
    let lines = await trendLines();
    ok('分时趋势渲染今日/昨天/7天前三条折线', lines.length === 3, '实际 ' + lines.length);
    ok('每条折线固定 24 个点（时间轴 0~23 时，23 段贝塞尔）', lines.length === 3 &&
      lines.every((p) => (p.match(/ C /g) || []).length === 23),
      '段数 ' + lines.map((p) => (p.match(/ C /g) || []).length).join('/'));
    ok('活跃概况四项指标名齐全',
      ['累计用户数', '日访问人数', '日打开次数', '日访问页面数'].every((x) => usageText.indexOf(x) >= 0));
    const metricVals = await page.$$eval('.metric-value',
      (els) => els.map((e) => e.textContent.trim()));
    ok('活跃概况四卡显示 97 / 11 / 17 / 51',
      metricVals.length === 4 && /^97/.test(metricVals[0]) && /^11/.test(metricVals[1]) &&
      /^17/.test(metricVals[2]) && /^51/.test(metricVals[3]),
      '实际 ' + JSON.stringify(metricVals));
    ok('活跃概况带较前一日 / 较 7 日前对比',
      usageText.indexOf('较前一日') >= 0 && usageText.indexOf('较 7 日前') >= 0);
    ok('访问来源 Top10 有横条', (await page.$$('.src-bar')).length >= 5);
    await page.screenshot({ path: path.join(SHOTS, '06f-usage-insights.png'), fullPage: true });

    // 指标筛选：切「访问页面数」后折线点位必须真的变化（不是只换按钮高亮）
    const beforePts = (await trendLines())[0];
    await page.click('[data-tm="pageViews"]');
    await page.waitForTimeout(200);
    ok('分时指标切「访问页面数」后折线真的重绘', (await trendLines())[0] !== beforePts);
    const beforeSrc = (await srcVals())[0];
    await page.click('[data-sm="uv"]');
    await page.waitForTimeout(200);
    ok('来源指标切「访问人数」后横条数值真的变化', (await srcVals())[0] !== beforeSrc);
    await page.click('[data-tm="visitUsers"]');
    await page.click('[data-sm="pv"]');

    // 「昨天」：按钮高亮 + SQL 用日期等值条件（不是 INTERVAL 1 DAY）+ 数字跟着变
    const cu0 = POOL.calls.length;
    await page.click('[data-rg="-1"]');
    await page.waitForTimeout(700);
    const ySql = POOL.calls.slice(cu0).map((c) => c.sql);
    ok('点「昨天」按钮高亮', await page.isVisible('[data-rg="-1"].btn-primary'));
    ok('点「昨天」后 SQL 用 DATE(ts)=昨天 等值条件',
      ySql.some((q) => /DATE\(ts\) = DATE_SUB\(CURDATE\(\), INTERVAL 1 DAY\)/.test(q)));
    ok('点「昨天」没有把 -1 当近 N 天参数塞进 SQL',
      POOL.calls.slice(cu0).every((c) => c.args.indexOf(-1) < 0));
    ok('点「昨天」后总浏览/点击变成 17', (await totalVals()).some((v) => v === '17'),
      '实际 ' + JSON.stringify(await totalVals()));
    const yMetrics = await page.$$eval('.metric-value',
      (els) => els.map((e) => e.textContent.trim()));
    ok('点「昨天」后活跃概况跟着切到昨天口径（4 / 6 / 20）',
      yMetrics.length === 4 && /^4/.test(yMetrics[1]) && /^6/.test(yMetrics[2]) &&
      /^20/.test(yMetrics[3]), '实际 ' + JSON.stringify(yMetrics));
    ok('点「昨天」后每日轴只剩 1 天',
      (await page.textContent('#view')).indexOf('共 1 天') >= 0);
    await page.screenshot({ path: path.join(SHOTS, '06g-usage-yesterday.png'), fullPage: true });
    // 还原默认范围，避免把 localStorage 里的 -1 带进后续用例
    await page.click('[data-rg="30"]');
    await page.waitForTimeout(400);

    /* --- 7.9 使用统计动效（2026-11-09）：hover 预览 / 卡片 / chip / 入场 ---
       源码级判据在 check-usage-insights.js；这里在真实浏览器里证明鼠标悬停
       真的能唤出浮层、移开真的收起、准星与扇区高亮命中，以及 reduced-motion 生效。 */
    console.log('\n[7.9] 使用统计：四类动效');
    const tipVisible = () => page.$eval('#insight-tip',
      (e) => e.classList.contains('is-visible')).catch(() => false);
    const tipText = () => page.$eval('#insight-tip',
      (e) => e.textContent.trim()).catch(() => '');
    const tipHidden = () => page.$eval('#insight-tip',
      (e) => e.getAttribute('aria-hidden')).catch(() => null);
    ok('页面存在唯一预览浮层', (await page.$$('#insight-tip')).length === 1);

    // ① 横条 hover → 「名称 / 数值 / 占比」预览气泡
    const srcName = await page.$eval('.src-row .src-label', (e) => e.textContent.trim());
    await (await page.$('.src-row')).hover();
    await page.waitForTimeout(220);
    ok('横条 hover 浮出预览气泡', await tipVisible());
    ok('预览气泡含来源名', (await tipText()).indexOf(srcName) >= 0, '实际 ' + (await tipText()));
    ok('预览气泡含占比', (await tipText()).indexOf('%') >= 0, '实际 ' + (await tipText()));
    await page.screenshot({ path: path.join(SHOTS, '06j-usage-source-hover.png') });
    const shownOnHover = await tipVisible();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(220);
    ok('鼠标移开后预览气泡收起', shownOnHover && !(await tipVisible()));
    ok('浮层 aria-hidden 复位', (await tipHidden()) === 'true');

    // ② 折线 hover → 时间段 + 三条系列数值 + 垂直准星
    await (await page.$('.trend-svg')).hover();
    await page.waitForTimeout(220);
    const trendTip = await tipText();
    ok('折线 hover 浮出时间段预览', /\d{2}:00/.test(trendTip), '实际 ' + trendTip);
    ok('折线预览含今日/1天前/7天前三系列',
      ['今日', '1 天前', '7 天前'].every((x) => trendTip.indexOf(x) >= 0), '实际 ' + trendTip);
    ok('折线 hover 点亮垂直准星', (await page.$$('.trend-hover-layer.is-active')).length === 1);
    // ②b 折线是平滑曲线（含贝塞尔 C 命令）而非直线（L），且带线下渐变面积
    const trendPathD = await page.$eval('.trend-line', (e) => e.getAttribute('d') || '');
    ok('折线是平滑曲线（d 含贝塞尔 C 命令，非直线 L）',
      /C/.test(trendPathD), '实际前缀 ' + trendPathD.slice(0, 36));
    ok('折线带线下渐变面积', (await page.$$('.trend-area')).length === 3);
    ok('存在渐变定义', (await page.$$eval('linearGradient', (els) => els.length)) >= 3);
    await page.screenshot({ path: path.join(SHOTS, '06h-usage-hover.png') });
    const tipBox = await page.$eval('#insight-tip', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.screenshot({
      path: path.join(SHOTS, '06l-usage-tip-detail.png'),
      clip: {
        x: Math.max(0, tipBox.x - 24), y: Math.max(0, tipBox.y - 24),
        width: tipBox.w + 48, height: tipBox.h + 48
      }
    });

    // ③ 卡片 hover → 轻微上浮 + 右上角导出按钮淡入
    await (await page.$('.card-insight')).hover();
    await page.waitForTimeout(240);
    const cardTf = await page.$eval('.card-insight', (e) => getComputedStyle(e).transform);
    ok('卡片 hover 有轻微上浮（不是原地位移）',
      cardTf !== 'none' && cardTf !== 'matrix(1, 0, 0, 1, 0, 0)', '实际 ' + cardTf);
    ok('卡片 hover 时右上角导出按钮淡入',
      await page.$$eval('.card-hd-action',
        (els) => els.length > 0 && Number(getComputedStyle(els[0]).opacity) > 0.9));
    ok('导出按钮带 data-export 与无障碍标签',
      await page.$$eval('.card-hd-action',
        (els) => els.length > 0 && !!els[0].getAttribute('data-export') && !!els[0].getAttribute('aria-label')));

    // ⑤ chip hover / 错峰入场 / 门控
    const chipBefore = await page.$eval('[data-tm="opens"]', (e) => getComputedStyle(e).transform);
    await page.hover('[data-tm="opens"]');
    await page.waitForTimeout(220);
    const chipAfter = await page.$eval('[data-tm="opens"]', (e) => getComputedStyle(e).transform);
    ok('指标 chip hover 有位移反馈', chipBefore !== chipAfter,
      '前 ' + chipBefore + ' / 后 ' + chipAfter);
    const enter = await page.$$eval('.card-insight', (els) => els.map((e) => ({
      name: getComputedStyle(e).animationName, delay: getComputedStyle(e).animationDelay
    })));
    ok('三张卡片带 card-enter 错峰入场',
      enter.length === 3 && enter.every((x) => x.name === 'card-enter') &&
      new Set(enter.map((x) => x.delay)).size >= 3,
      '实际 ' + JSON.stringify(enter));
    const gating = await page.evaluate(() => Array.from(document.styleSheets).some((s) => {
      try {
        return Array.from(s.cssRules).some((r) => r.conditionText &&
          r.conditionText.indexOf('hover: hover') >= 0);
      } catch (e) { return false; }
    }));
    ok('hover 动效被 (hover:hover) and (pointer:fine) 门控', gating);

    // ⑥ reduced-motion：去掉位移，保留内容与淡入（先证默认偏好下动画是开着的，
    //    否则「reduce 下 animationName=none」在没实现时也会假绿）
    const rmBefore = await page.$eval('.card-insight', (e) => getComputedStyle(e).animationName);
    ok('默认动效偏好下入场动画启用', rmBefore === 'card-enter', '实际 ' + rmBefore);
    const hasReduceRule = await page.evaluate(() => Array.from(document.styleSheets).some((s) => {
      try {
        return Array.from(s.cssRules).some((r) => r.conditionText &&
          r.conditionText.indexOf('prefers-reduced-motion') >= 0);
      } catch (e) { return false; }
    }));
    ok('样式表声明 prefers-reduced-motion 降级', hasReduceRule);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(120);
    const rm = await page.$eval('.card-insight', (e) => ({
      name: getComputedStyle(e).animationName,
      transform: getComputedStyle(e).transform
    }));
    ok('reduced-motion 下关闭位移动画', rm.name === 'none' && rmBefore === 'card-enter',
      '实际 ' + JSON.stringify(rm));
    await (await page.$('.card-insight')).hover();
    await page.waitForTimeout(220);
    const rmHoverTf = await page.$eval('.card-insight', (e) => getComputedStyle(e).transform);
    ok('reduced-motion 下 hover 也不位移',
      rmHoverTf === 'none' || rmHoverTf === 'matrix(1, 0, 0, 1, 0, 0)', '实际 ' + rmHoverTf);
    await page.screenshot({ path: path.join(SHOTS, '06i-usage-reduced-motion.png') });
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    /* ⑦ 页面级对比：对比的是**整个使用统计**（2026-11-09 用户要求），
     *    开关在工具条，不是分时卡里的局部按钮；开启后顶部新建「对比总览」卡，
     *    分时图跟随画 A/B 两段曲线，下方明细表仍按「时间范围」显示。 */
    await page.click('[data-cmp="1"]');
    await page.waitForSelector('.card-cmp', { timeout: 8000 });
    await page.waitForTimeout(300);
    ok('对比开关高亮', await page.$eval('[data-cmp="1"]', (e) => e.classList.contains('active')));
    ok('工具条出现对比控件', !!(await page.$('.usage-cmp')));
    // 布局守门（2026-11-09 用户要求）：对比控件必须与时间范围/班级范围同一行流式排布，
    // 不能 flex-basis:100% 独占一整行、左边留一大片空白。
    const boxOf = async () => page.evaluate(() => {
      const b = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
      };
      return {
        range: b('.usage-range'), scope: b('.usage-scope'),
        cmp: b('.usage-cmp'), dates: b('[data-cmp-dates]')
      };
    });
    const cmpGeo = await boxOf();
    ok('对比控件与时间范围同一行（不独占一行）',
      !!cmpGeo.range && !!cmpGeo.cmp && Math.abs(cmpGeo.range.y - cmpGeo.cmp.y) <= 12,
      '实际 ' + JSON.stringify(cmpGeo));
    ok('出现对比总览卡', !!(await page.$('.card-cmp')));
    const cmpRowCount = (await page.$$('.cmp-tbl tbody tr')).length;
    ok('对比总览列出 8 个指标', cmpRowCount === 8, '实际 ' + cmpRowCount);
    const cmpDatesVisible = (await page.$$('.cmp-date:not(.hidden)')).length;
    ok('单日模式只显示两个日期输入', cmpDatesVisible === 2, '实际 ' + cmpDatesVisible);
    ok('单日模式 A / B 日期不同',
      (await page.$eval('.cmp-date[data-cmpk="cmpA1"]', (e) => e.value)) !==
      (await page.$eval('.cmp-date[data-cmpk="cmpB1"]', (e) => e.value)));
    // 总览表首行（总次数）A/B 两列：数值必须各自独立，否则就是两段查了同一份数据
    const cmpCells = await page.$$eval('.cmp-tbl tbody tr:first-child td',
      (tds) => tds.map((t) => t.textContent.trim()));
    ok('对比总览 A/B 数值各自独立', cmpCells.length >= 3 && cmpCells[0] !== cmpCells[1],
      '实际 ' + JSON.stringify(cmpCells));
    ok('对比总览有差值列', /^[+-]?\d/.test(cmpCells[2] || ''), '实际 ' + cmpCells[2]);
    ok('对比总览有变化率', !!(await page.$('.cmp-pct')));
    ok('对比模式分时只画两条曲线', (await page.$$('.trend-line')).length === 2,
      '实际 ' + (await page.$$('.trend-line')).length);
    ok('对比模式图例为两段标签', (await page.$$('.trend-lg')).length === 2);
    await (await page.$('.trend-svg')).hover();
    await page.waitForTimeout(220);
    const cmpTip = await tipText();
    ok('分时 hover 浮出两段数值', (await page.$$('#insight-tip .insight-tip-r')).length === 2,
      '实际 ' + cmpTip);
    await page.screenshot({ path: path.join(SHOTS, '08m-usage-cmp-overview.png'), fullPage: true });

    // 切「区间」粒度：起止四个日期都可见，总览卡改为时间段口径
    await page.click('[data-gran="range"]');
    await page.waitForSelector('.card-cmp', { timeout: 8000 });
    await page.waitForTimeout(300);
    const cmpDatesRange = (await page.$$('.cmp-date:not(.hidden)')).length;
    ok('区间模式显示 4 个日期输入', cmpDatesRange === 4, '实际 ' + cmpDatesRange);
    ok('区间模式总览卡仍在', !!(await page.$('.card-cmp')));
    ok('区间模式标注为时间段对比',
      (await page.textContent('.card-cmp')).indexOf('时间段对比') >= 0);
    const rangeGeo = await boxOf();
    // 区间模式 4 个日期框比单日宽一倍，桌面 1440 下放不进第一行是合理的；
    // 但折行后必须靠右续排（margin-left:auto），不能顶格从内容区最左另起一段。
    ok('区间模式对比组折行也靠右续排（不顶格独占）',
      !!rangeGeo.cmp && !!rangeGeo.range && rangeGeo.cmp.y > rangeGeo.range.y
        ? rangeGeo.cmp.x > rangeGeo.range.x + 100
        : rangeGeo.cmp.x > rangeGeo.range.x,
      '实际 ' + JSON.stringify(rangeGeo));
    await page.screenshot({ path: path.join(SHOTS, '08n-usage-cmp-range.png'), fullPage: true });

    // 还原：单日 → 关闭，避免把对比态带进后续用例
    await page.click('[data-gran="day"]');
    await page.waitForTimeout(500);
    await page.click('[data-cmp="0"]');
    await page.waitForTimeout(500);
    ok('关闭对比后总览卡消失', !(await page.$('.card-cmp')));
    ok('关闭对比后分时恢复三条曲线',
      (await page.$$('.trend-line')).length === 3, '实际 ' + (await page.$$('.trend-line')).length);

    /* --- 8. 班级配置 --- */
    console.log('\n[8] 账号班级');
    await page.click('.nav-item[data-view="class"]');
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.waitForTimeout(300);
    const cls = await page.textContent('#view');
    ok('列出 3 个班', (cls.match(/260[123]班/g) || []).length >= 3);
    ok('显示班级口令', cls.indexOf('345678') >= 0);
    await page.screenshot({ path: path.join(SHOTS, '07-classes.png'), fullPage: true });

    // 打开配置弹层
    await page.click('[data-c-edit="3"]');
    await page.waitForSelector('.dlg', { timeout: 8000 });
    await page.waitForTimeout(300);
    ok('配置弹层打开', await page.isVisible('.dlg'));
    const dlgText = await page.textContent('.dlg');
    ok('弹层显示课程课次统计', /课程课次/.test(dlgText));
    await page.screenshot({ path: path.join(SHOTS, '08-class-dialog.png') });
    await page.click('#dlg-cancel');

    /* --- 9. 系统配置：后台账号有效态 --- */
    console.log('\n[9] 系统配置');
    await page.click('.nav-item[data-view="config"]');
    await page.waitForSelector('.tbl', { timeout: 8000 });
    await page.waitForTimeout(300);
    const cfg = await page.textContent('#view');
    ok('列出后台账号 admin', cfg.indexOf('admin') >= 0);
    ok('非超管账号标为不可用', cfg.indexOf('不可用') >= 0);
    await page.screenshot({ path: path.join(SHOTS, '09-admin-users.png'), fullPage: true });

    /* --- 10. 改密码二次校验 --- */
    await page.click('[data-a-pw="1"]');
    await page.waitForSelector('.dlg', { timeout: 8000 });
    ok('改密码要求当前密码', (await page.textContent('.dlg')).indexOf('当前登录密码') >= 0);
    await page.screenshot({ path: path.join(SHOTS, '10-change-pw.png') });
    // 故意填错当前密码 → 应报错
    openExpect(); // 改密接口应 400/401
    await page.fill('#a-cur', 'wrong-current');
    await page.fill('#a-new', 'NewPass@2026');
    await page.click('#dlg-ok');
    await page.waitForSelector('#toast:not([hidden])', { timeout: 8000 });
    closeExpect();
    const toastTxt = await page.textContent('#toast');
    ok('当前密码错误时拒绝改密', /不正确|拒绝/.test(toastTxt), toastTxt);
    await page.screenshot({ path: path.join(SHOTS, '11-pw-rejected.png') });
    await page.click('#dlg-cancel');

    /* --- 11. 操作审计 --- */
    console.log('\n[11] 操作审计');
    await page.click('.nav-item[data-view="audit"]');
    await page.waitForTimeout(700);
    ok('审计视图可达', (await page.$('#view')) !== null);
    await page.screenshot({ path: path.join(SHOTS, '12-audit.png'), fullPage: true });

    /* --- 12. 刷新不掉登录（Cookie 会话） --- */
    console.log('\n[12] 刷新保持登录');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-view:not([hidden])', { timeout: 10000 });
    ok('刷新后仍在主界面（HttpOnly Cookie 生效）', await page.isVisible('#main-view'));

    /**
     * 12.5 权限真源实时回查（**最关键的一组，2026-10-10 变异实测补上**）
     *
     * 变异自证发现：`loadSession` 去掉「回查 member.is_super + status」后，
     * 40 项 e2e **依然全过** —— 说明前面所有断言都只在登录那一次校验过超管态。
     * 而方案里这是硬要求：admin_user 只回答「谁能登录」，**member.is_super 才是权限真源**；
     * 少了实时回查，member 一旦被停用/降权，已登录的后台会话还能继续用 ——
     * admin_user 就变成绕过 member 状态的后门。
     *
     * 做法：保持登录态，直接改夹具里的 member 行，再刷新页面。
     */
    console.log('\n[12.5] 权限真源实时回查');
    const target = TABLES.member.find((m) => m.id === 13);
    const savedSuper = target.is_super;
    const savedStatus = target.status;
    /**
     * 判断「会话是否已被踢掉」：**只认登录页真的出现**。
     * ⚠️ 这里**绝不能**写成 `try { 等登录页 } catch { kicked = true }` ——
     *   会话仍有效时登录页永远不会出现，等待必然超时，catch 一兜就变成
     *   「已踢出」⇒ 变异体（去掉 member 回查）也能全绿。
     *   这是本轮实测到的假绿：超时必须等于**失败**。
     */
    async function sessionKicked() {
      openExpect(); // 会话失效后前端探 /api/me 必然 401
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        // 等「登录页出现」或「主界面出现」二者之一，谁先来算谁
        await page.waitForSelector('#login-view:not([hidden]), #main-view:not([hidden])', { timeout: 10000 });
        return await page.isVisible('#login-view');
      } finally {
        closeExpect();
      }
    }

    // ① 把超管降权 → 会话应立即失效
    target.is_super = 0;
    ok('超管被降权后会话立即失效', await sessionKicked());
    target.is_super = savedSuper;
    // ② 恢复超管但停用 → 同样应失效（member.status 也是真源的一部分）
    target.status = 'DISABLED';
    ok('超管被停用后会话立即失效', await sessionKicked());
    target.status = savedStatus;
    // ③ 全部复原后重新登录，后续用例照常
    // ⚠️ 若上面的降权/停用**没有**踢掉会话（变异体），页面还停在主界面，
    //   后续 fill 登录框会抛 "element is not visible"、直接 goto 又会因
    //   会话仍有效而进不了登录页 —— 门禁输出就变成一坨堆栈，看不出哪条判据挂了。
    //   正解：无条件清掉 Cookie 强制回到未登录态，两种情况都能干净地重新登录。
    await ctx.clearCookies();
    openExpect(); // 无 Cookie 时前端探 /api/me 必然 401
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-view:not([hidden])', { timeout: 8000 });
    closeExpect();
    await page.fill('#login-username', 'admin');
    await page.fill('#login-password', 'Admin@2026');
    await page.click('#login-btn');
    await page.waitForSelector('#main-view:not([hidden])', { timeout: 10000 });
    closeExpect();
    ok('恢复后重新登录成功', await page.isVisible('#main-view'));

    /* --- 13. 登出 --- */
    console.log('\n[13] 登出');
    openExpect(); // 登出后的 /api/me 与下面那次故意的 401 探测
    await page.click('#logout-btn');
    await page.waitForSelector('#login-view:not([hidden])', { timeout: 8000 });
    ok('登出回到登录页', await page.isVisible('#login-view'));
    const after = await ctx.cookies();
    const sid2 = after.find((c) => c.name === 'admin_sid');
    ok('登出后 Cookie 被清', !sid2 || !sid2.value);
    // 登出后直接访问接口应 401
    const res = await page.evaluate(async (b) => {
      const r = await fetch(b + '/api/overview', { credentials: 'same-origin' });
      return r.status;
    }, BASE);
    closeExpect();
    ok('登出后接口返回 401', res === 401, '实际 ' + res);

    /* --- 14. 控制台无报错 --- */
    console.log('\n[14] 前端无控制台错误');
    // 只保留与网络无关的噪声过滤；4xx/5xx 与 JS 异常已在采集处按「预期失败窗口」处理
    const realErrs = consoleErrs.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|jsdelivr|net::/i.test(e));
    ok('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  } finally {
    await browser.close();
    server.close();
  }

  console.log('');
  if (fails.length) {
    console.log('✗ 失败 ' + fails.length + ' / ' + (pass + fails.length) + ' 项');
    fails.forEach((f) => console.log('  ✗ ' + f.name + (f.extra ? ' — ' + f.extra : '')));
    process.exit(1);
  }
  console.log('✓ 端到端全部通过（' + pass + ' 项）');
  console.log('  截图目录：' + SHOTS);
  process.exit(0);
})().catch((e) => {
  console.error('运行失败：', e && e.stack);
  process.exit(1);
});