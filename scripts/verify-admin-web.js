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
const CHROME = 'C:/Users/PC/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const { chromium } = require('C:/Users/PC/.dsh/skills/dashi-ppt/project/node_modules/playwright-core');

/* ---------------- 夹具 ---------------- */
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
    { id: 1, name: '示例专业B1班', join_token: '123456', invite_code: '<INVITE_CODE>', term_start: '2026-09-14', total_weeks: 16, bind_open: 1, is_active: 1, period_time: null, cnt: 52 },
    { id: 2, name: '示例专业A2班', join_token: '234567', invite_code: '<INVITE_CODE>', term_start: '2026-09-14', total_weeks: 16, bind_open: 1, is_active: 1, period_time: null, cnt: 50 },
    { id: 3, name: '示例专业A1班', join_token: '345678', invite_code: '<INVITE_CODE>', term_start: '2026-09-14', total_weeks: 16, bind_open: 1, is_active: 1, period_time: null, cnt: 58 }
  ],
  member: [
    { id: 13, class_id: 3, name: '示例成员01', student_no: '2099010101', group_tag: 'A', role: 'ADMIN', is_super: 1, position: '生活委员', status: 'ACTIVE', openid: 'o1', duty_count: 5, duty_off: 0, remind_block: 0, last_duty_at: '2026-10-08' },
    // ⚠️ 刻意放测试超管（学号 99 段）：验证「后台一律不显示测试账号」这条铁律
    { id: 69, class_id: 3, name: '测试超管', student_no: '0000000000', group_tag: 'A', role: 'ADMIN', is_super: 1, position: '', status: 'LEAVE', openid: null, duty_count: 0, duty_off: 0, remind_block: 0, last_duty_at: null },
    { id: 54, class_id: 3, name: '示例成员42', student_no: '2603010102', group_tag: 'B', role: 'ADMIN', is_super: 0, position: '班长兼团支书', status: 'ACTIVE', openid: 'o2', duty_count: 12, duty_off: 0, remind_block: 0, last_duty_at: '2026-10-09' },
    { id: 55, class_id: 3, name: '李四', student_no: '2603010103', group_tag: 'A', role: 'MEMBER', is_super: 0, position: '', status: 'ACTIVE', openid: 'o3', duty_count: 2, duty_off: 0, remind_block: 0, last_duty_at: null },
    { id: 56, class_id: 3, name: '王五', student_no: '2603010104', group_tag: 'B', role: 'MEMBER', is_super: 0, position: '', status: 'DISABLED', openid: 'o4', duty_count: 0, duty_off: 1, remind_block: 0, last_duty_at: null },
    { id: 57, class_id: 1, name: '一班同学', student_no: '2601010101', group_tag: 'A', role: 'MEMBER', is_super: 0, position: '', status: 'ACTIVE', openid: 'o5', duty_count: 1, duty_off: 0, remind_block: 0, last_duty_at: null }
  ],
  session: [
    { id: 101, class_id: 3, course_id: 101, kind: 'COURSE', week_rule: 'ALL', weeks: '1-16', day_of_week: 1, period: 1, group_scope: 'A', duty_count: 2, note: '' },
    { id: 102, class_id: 3, course_id: 102, kind: 'COURSE', week_rule: 'ALL', weeks: '1-16', day_of_week: 1, period: 2, group_scope: null, duty_count: 2, note: '' },
    { id: 103, class_id: 3, course_id: 103, kind: 'CLEAN', week_rule: 'ALL', weeks: '', day_of_week: 5, period: 5, group_scope: null, duty_count: 2, note: '' },
    { id: 104, class_id: 3, course_id: 104, kind: 'COURSE', week_rule: 'ALL', weeks: '1-16', day_of_week: 2, period: 1, group_scope: 'B', duty_count: 2, note: '调课' }
  ],
  // 课程行：与 session 一一对应（course_id 与 session.id 同号，便于 JOIN 命中）
  course: [
    { id: 101, class_id: 3, name: '大学语文', teacher: '张老师', room: 'A101' },
    { id: 102, class_id: 3, name: '高等数学', teacher: '李老师', room: 'A102' },
    { id: 103, class_id: 3, name: '值日保洁', teacher: '', room: '410' },
    { id: 104, class_id: 3, name: '大学英语', teacher: '王老师', room: 'B201' }
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
  const cond = sql.slice(whereAt).replace(/\(\s*\w+\.group_scope\s*=\s*\?\s+OR\s+\w+\.group_scope\s+IS NULL\s*\)/gi, ' ');
  // 逐个条件： <col> <op> <val>  ；val 可能是 ? 或 '字面量'
  const conds = [];
  const re = /(\w+)\.(\w+)\s*(=|<>|!=|NOT LIKE|LIKE)\s*(\?|'[^']*')/gi;
  let m;
  while ((m = re.exec(cond))) conds.push({ col: m[2], op: m[3].toUpperCase(), val: m[4] });
  let ai = 0;
  for (const c of conds) {
    let expect;
    if (c.val === '?') { expect = args[ai++]; }
    else { expect = c.val.slice(1, -1); }
    const actual = row[c.col];
    if (c.op === '=' && String(actual) !== String(expect)) return false;
    if (c.op === 'LIKE') {
      // 只支持 'prefix%' 这一种形态，够用且不会写出一个假通配符实现
      const lit = String(expect);
      if (lit.slice(-1) === '%') {
        if (String(actual === null || actual === undefined ? '' : actual).indexOf(lit.slice(0, -1)) !== 0) return false;
      } else if (String(actual) !== lit) return false;
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

const POOL = {
  calls: [],
  /** 课表接口的 group 参数（A/B），mock 靠它过滤 group_scope */
  _group: null,
  async query(sql, args) {
    POOL.calls.push({ sql: String(sql), args: args || [] });
    const s = String(sql);
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
    const limit = s.match(/LIMIT \?/);
    if (limit && args && args.length) {
      const n = Number(args[args.length - 1]);
      if (!isNaN(n) && n > 0) rows = rows.slice(0, n);
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
    ok('保洁课次可见并标记', tt.indexOf('保洁') >= 0);
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

    /* --- 6.5 删课次（2026-10-10 新增能力） --- */
    console.log('\n[6.5] 删课次');
    const beforeRows = await page.$$eval('#view tbody tr', (els) => els.length);
    const beforeSessions = TABLES.session.length;
    // Playwright 默认把 confirm 全 dismiss ⇒ 不 accept 的话删除永远不会发生，
    // 断言「课次少了 1」就会假红，看起来像删除功能坏了
    page.once('dialog', (d) => d.accept());
    await page.click('[data-del-session="101"]');
    await page.waitForTimeout(800);
    ok('删除前课表有 4 行', beforeRows === 4, '实际 ' + beforeRows);
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