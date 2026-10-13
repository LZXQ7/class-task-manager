/**
 * admin-web 后端逻辑自测（不连数据库）
 * 跑法：node scripts/check-admin-web.js
 *
 * 为什么要有这个：
 *   MySQL 只在同 VPC 内网可达，本机跑不了带库的全链路（连上去必 ECONNREFUSED）。
 *   但**纯逻辑**部分（口令哈希、Cookie 解析、会话字段脱敏、鉴权前置拦截、
 *   SQL 白名单化拼接）可以在本地真跑真验 —— 这些恰恰是后台最容易出安全事故的地方，
 *   不能因为「跑不了带库测试」就一格不验。
 *
 * 覆盖对照项目 MEMORY 里的既有教训：
 *   · Cookie 解析边界（畸形头不能抛错）
 *   · 会话对象不得序列化（selfHash 泄漏 = 口令哈希泄给浏览器）
 *   · 人员 SQL 必须显式带 NOT_TEST
 *   · SQL 拼接不得吃进用户输入
 */
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', 'cloudfunctions', 'admin-web');
const auth = require(path.join(ROOT, 'lib', 'auth.js'));
const { NOT_TEST, isTestNo } = require(path.join(ROOT, 'common', 'test-account.js'));

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push({ name, msg: e.message }); }
}

/* ---------------- 口令哈希 ---------------- */
t('口令哈希可逆验证：正确口令通过', () => {
  const h = auth.hashPassword('correct-horse-8');
  assert.strictEqual(auth.verifyPassword('correct-horse-8', h), true);
});
t('口令哈希：错误口令拒绝', () => {
  const h = auth.hashPassword('correct-horse-8');
  assert.strictEqual(auth.verifyPassword('wrong', h), false);
});
t('口令哈希：同口令两次哈希不同（随机盐）', () => {
  assert.notStrictEqual(auth.hashPassword('same'), auth.hashPassword('same'));
});
t('口令哈希：非 scrypt 格式一律拒绝（不抛错）', () => {
  assert.strictEqual(auth.verifyPassword('x', 'not-a-hash'), false);
  assert.strictEqual(auth.verifyPassword('x', ''), false);
  assert.strictEqual(auth.verifyPassword('x', null), false);
});
t('口令明文绝不出现在哈希串里', () => {
  const h = auth.hashPassword('plaintext-secret');
  assert.ok(h.indexOf('plaintext-secret') < 0, '哈希里出现了明文');
  assert.ok(/^scrypt\$\d+\$\d+\$\d+\$/.test(h), '格式不符 scrypt$N$r$p$salt$hash');
});

/* ---------------- Cookie 解析 ---------------- */
function reqWith(cookie) { return { headers: { cookie: cookie || '' } }; }

t('Cookie：正常解析', () => {
  const c = auth.parseCookies(reqWith('admin_sid=abc123; other=1'));
  assert.strictEqual(c.admin_sid, 'abc123');
});
t('Cookie：URL 编码值会被解码', () => {
  const c = auth.parseCookies(reqWith('admin_sid=a%2Fb'));
  assert.strictEqual(c.admin_sid, 'a/b');
});
t('Cookie：畸形头（空 / 无值 / 多余空格）不抛错', () => {
  assert.deepStrictEqual(auth.parseCookies(reqWith('')), {});
  assert.doesNotThrow(() => auth.parseCookies(reqWith(';;=;')));
  assert.doesNotThrow(() => auth.parseCookies(reqWith('   ')));
});
t('Cookie：无 cookie 头返回空对象', () => {
  assert.deepStrictEqual(auth.parseCookies({ headers: {} }), {});
});

/* ---------------- 会话脱敏（安全核心） ---------------- */
t('会话对象里的 selfHash 必须是口令哈希字段名', () => {
  // loadSession 真实返回结构里含 selfHash；这里锁死「这个字段名存在且语义是哈希」，
  // 防止后续有人改成把整个 admin_user 行塞进 session
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'auth.js'), 'utf8');
  assert.ok(/selfHash:\s*row\.pass_hash/.test(src),
    'selfHash 必须直接来自 row.pass_hash，而不是整个行对象');
});
t('主入口不得把 session 整体序列化给前端', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.ok(!/res\.json\(\s*\{\s*ok:\s*true,\s*user:\s*s\s*\}/.test(src),
    '出现了把整个 session 当 user 回前端的写法');
  assert.ok(!/json\.stringify\(\s*s(ession)?\b/.test(src),
    '出现了对 session 做 stringify 的写法');
  // /api/me 必须手工挑字段
  assert.ok(/user:\s*\{\s*username:\s*s\.username/.test(src), '/api/me 应手工挑字段');
});

/* ---------------- 测试账号过滤 ---------------- */
t('NOT_TEST 生成预期 SQL 条件', () => {
  assert.strictEqual(NOT_TEST('m'), "m.student_no NOT LIKE '0000000000%'");
  assert.strictEqual(NOT_TEST(), "student_no NOT LIKE '0000000000%'");
});
t('isTestNo 识别 99 段学号', () => {
  assert.strictEqual(isTestNo('00000000001'), true);
  assert.strictEqual(isTestNo('26010101001'), false);
});

/* ---------------- 人员 SQL 必须显式带 NOT_TEST ---------------- */
/**
 * 抽出「所有以 FROM member 为驱动表」的查询调用片段。
 * 做法：从每个 .query( 出发，用括号配平截到对应的闭括号，再看这段里有没有 FROM member。
 * 比正则切字符串可靠 —— 本项目 SQL 全是「单引号串 + '+ 变量 +' 拼接」，
 * 正则会在拼接处把一条 SQL 切成两半，判据就会漏看后半段的 NOT_TEST。
 */
function extractMemberQueries(src) {
  const out = [];
  const re = /\.query\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    let inStr = null;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (inStr) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inStr) inStr = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch;
      } else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    const call = src.slice(m.index, i);
    if (/FROM\s+member\b/i.test(call)) out.push(call);
  }
  return out;
}

/**
 * 判断某条成员查询是否应当显式带 NOT_TEST。
 *
 * 结论：**除了「按学号/ openid 查重」和「COUNT(*)」，其余全部必须带** ——
 * 包括 `WHERE m.id = ?` 的详情查询。详情只有一行，但它照样可能把测试超管
 * （id=69）完整资料端到浏览器上，和列表泄露是同一类事故。
 * 之前试过把 `m.id = ?` 排除掉，判据立刻「因为漏看 4 条」而变绿 —— 正是
 * 项目 MEMORY 记的「兜底路径互掩盖 ⇒ 变异抓不到」，所以这里只能收紧不能放宽。
 */
const isPersonQuery = (q) => {
  if (/COUNT\(\*\)/i.test(q)) return false;
  // 仅查重例外：按学号 / openid 唯一键点名 —— 「这个学号是不是已存在的测试号」
  // 本来就该查得到，加 NOT_TEST 反而错。
  return !/\b(?:m\.)?(?:student_no|openid)\s*=\s*\?/i.test(q);
};

t('成员模块：列表/详情/改/删 的 SQL 都显式带 NOT_TEST', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-member.js'), 'utf8');
  const qs = extractMemberQueries(src);
  const touching = qs.filter(isPersonQuery);
  assert.ok(touching.length >= 4, '识别的成员查询过少：' + touching.length);
  for (const q of touching) {
    assert.ok(q.indexOf('NOT_TEST') >= 0,
      '有成员查询未显式带 NOT_TEST：\n' + q.replace(/\s+/g, ' ').slice(0, 140));
  }
});

/* ---------------- SQL 拼接白名单（不得吃用户输入） ---------------- */
t('课程表模块：SQL 中的排序/字段名不得来自请求参数', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-course.js'), 'utf8');
  /**
   * ⚠️ 判据随实现更新（2026-10-10）：备份表名不再由 stamp 动态拼出。
   *   原实现 `CREATE TABLE bak_session_' + stamp` 需要 DDL 权限，
   *   而应用库账号 classassist_app 只有 DML ⇒ 线上 500（ER_TABLEACCESS_DENIED_ERROR）。
   *   现改为写**常备表** bak_admin_session / bak_admin_course，stamp 只作 batch_no 参数。
   *   **意图不变**：SQL 里出现的表名必须是代码里的常量，绝不能来自请求参数。
   *   表名安全由新门禁 check-admin-import-ddl.js（74）锁「导入路径零 DDL」，
   *   本条只守「表名不是入参」。
   */
  const constTables = (src.match(/const BAK_(?:SESSION|COURSE) = '([a-z_]+)'/g) || []);
  // 2026-10-10：deleteSession 加入后是 4 份（commitImport 与 deleteSession 各 SESSION+COURSE）
  // 2026-10-12：clearTimetable 加入后变 6 份（三个函数各 SESSION+COURSE）
  assert.strictEqual(constTables.length, 6,
    '备份表名必须是代码常量（BAK_SESSION / BAK_COURSE，三个函数各一份），实测：' + constTables.length);
  assert.ok(/const BAK_SESSION = 'bak_admin_session'/.test(src), 'BAK_SESSION 常量缺失或改名');
  assert.ok(/const BAK_COURSE = 'bak_admin_course'/.test(src), 'BAK_COURSE 常量缺失或改名');
  /**
   * 表名只允许拼常量。但**只在 SQL 语句字符串里查**——
   * 2026-10-10 实踩：判据若扫全文，会命中 rollbackHint 里那句纯文案
   *   '如需回滚：用备份批次号 ' + stamp + ' 从 ' + BAK_SESSION + …
   * 那是给人看的提示，不是 SQL，判它等于把门禁变成噪声。
   * 做法：抽出所有 SQL 字符串字面量（含拼接片段），只在这些片段里查。
   */
  const sqlChunks = [];
  {
    // 抓 pool.query / conn.query 的第一个参数（SQL 文本），到该调用收尾为止
    const re = /(?:pool|conn)\.query\(/g;
    let mm;
    while ((mm = re.exec(src))) {
      // 从 '(' 起做括号配对，取出整个调用实参
      let i = src.indexOf('(', mm.index);
      let depth = 0;
      for (; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (!depth) { i++; break; } }
      }
      sqlChunks.push(src.slice(mm.index, i));
    }
  }
  assert.ok(sqlChunks.length >= 6, '抽到的 SQL 调用过少：' + sqlChunks.length);
  /**
   * 只查 `FROM <表名>` 与 `INSERT INTO <表名>` / `UPDATE <表名>` 位置 ——
   * 这三处后面跟的必须是**代码常量**（BAK_SESSION / BAK_COURSE）。
   *
   * ⚠️ 不能扫「FROM 之后的所有拼接」：WHERE 子句列表是 where.join(',') 这种
   * 正常写法（每个片段都是本文件里的字面量，不是入参），扫全会误报
   * 「表名位置拼接了非常量：where.join」（2026-10-10 实踩）。
   * 判据必须精确对准「表名槽位」，否则就是噪声门禁。
   */
  const TABLE_SLOT = /(?:FROM|INTO|UPDATE)\s+(?:IF NOT EXISTS\s+)?[`'"]?([^`'"\s,;)]+)/gi;
  for (const c of sqlChunks) {
    let m2;
    TABLE_SLOT.lastIndex = 0;
    while ((m2 = TABLE_SLOT.exec(c))) {
      const name = m2[1];
      /**
       * 合法两种形态：
       *   ① 普通字面量表名（session / course / duty …）—— 全小写，无拼接；
       *   ② 代码常量（BAK_SESSION / BAK_COURSE）—— 全大写，由 const 声明。
       * 非法：变量名、req.*、时间戳 —— 即「表名槽位里出现了非常量标识符」。
       * ⚠️ 判据不能写成「必须全大写」（那会把 session/duty 全判红），
       *    也不能只看 `+`（入参也可能不带加号直接内插）。
       */
      const isLiteral = /^[a-z_][a-z0-9_]*$/.test(name);
      const isConst = /^[A-Z][A-Z0-9_]*$/.test(name);
      assert.ok(isLiteral || isConst,
        'SQL 表名位置出现非常量：' + name + '\n      ' + c.replace(/\s+/g, ' ').slice(0, 120));
    }
  }
  // 另：SQL 字符串里不得出现 req.*（请求参数直接进 SQL）
  for (const c of sqlChunks) {
    assert.ok(!/req\.(query|body|params)/.test(c),
      'SQL 里出现了直接引用 req 的插值：' + c.replace(/\s+/g, ' ').slice(0, 120));
  }
  assert.ok(!/\$\{req\.(query|body|params)/.test(src), 'SQL 里出现了直接引用 req 的插值');
});

/* ---------------- 路由：敏感接口都要登录态 ---------------- */
t('主入口：所有 /api 写接口都在登录态中间件之后', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const guardAt = src.indexOf("app.use('/api'");
  assert.ok(guardAt > 0, '缺少 /api 登录态中间件');
  const after = src.slice(guardAt);
  for (const p of [
    "/api/overview", "/api/classes/:id'", "/api/members", "/api/timetable/import",
    "/api/timetable/dry-run'", "/api/timetable/clear'", "/api/timetable/session',",
    "/api/leave',", "/api/leave/:id',",
    "/api/admin-users/:id'", "/api/audit"
  ]) {
    assert.ok(after.indexOf(p) > 0, '接口未受登录态保护：' + p);
  }
  // login / logout / me 必须在中间件之前
  const before = src.slice(0, guardAt);
  for (const p of ['/api/auth/login', '/api/auth/logout', '/api/me']) {
    assert.ok(before.indexOf(p) > 0, p + ' 应在登录态中间件之前注册');
  }
});

/* ---------------- 错误信息不得泄漏 ---------------- */
t('统一异常处理不回传堆栈', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  assert.ok(/console\.error\([\s\S]{0,80}e && e\.stack/.test(src), '堆栈应只进日志');
  assert.ok(!/res\.json\(\{[^}]*stack/.test(src), '响应体里出现了 stack');
});

/* ---------------- 课表写入共用：两边必须共用一份 ---------------- */
t('course 云函数与 admin-web 共用 common/timetable-import.js', () => {
  const course = fs.readFileSync(
    path.join(ROOT, '..', 'course', 'index.js'), 'utf8');
  assert.ok(/require\('\.\/common\/timetable-import'\)/.test(course),
    'course 云函数未引用共用导入模块');
  assert.ok(/timetableImport\.writeTimetable/.test(course),
    'course 云函数导入路径未走共用写入');
  const admin = fs.readFileSync(path.join(ROOT, 'lib', 'mod-course.js'), 'utf8');
  assert.ok(/timetableImport\.writeTimetable/.test(admin),
    'admin-web 未走共用写入');
  // 两份副本内容必须一致（否则 admin-web 副本会漂移）
  const a = fs.readFileSync(path.join(ROOT, '..', 'common', 'timetable-import.js'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'common', 'timetable-import.js'), 'utf8');
  assert.strictEqual(a, b, 'admin-web 里的 timetable-import.js 与 common 真源不一致');
});

/* ---------------- 共用模块：删除课次必须回滚 duty_count ---------------- */
t('writeTimetable 删课次前调用 rollbackDutyMarkers（游标不漂移）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'common', 'timetable-import.js'), 'utf8');
  const fnAt = src.indexOf('async function writeTimetable');
  const body = src.slice(fnAt, src.indexOf('async function toDraftWeeks'));
  const rollbackAt = body.indexOf('rollbackDutyMarkers');
  const deleteAt = body.indexOf('DELETE FROM session');
  assert.ok(rollbackAt > 0, 'writeTimetable 未调用 rollbackDutyMarkers');
  assert.ok(rollbackAt < deleteAt, '回滚轮转标记必须发生在删 session 之前');
});

t('writeTimetable 只覆盖同组、绝不碰 CLEAN', () => {
  const src = fs.readFileSync(path.join(ROOT, 'common', 'timetable-import.js'), 'utf8');
  const fnAt = src.indexOf('async function writeTimetable');
  const body = src.slice(fnAt, src.indexOf('async function toDraftWeeks'));
  assert.ok(/kind = 'COURSE' AND group_scope = \?/.test(body), '删除条件必须限定 COURSE + 本组');
  assert.ok(!/DELETE FROM session WHERE id IN \([^)]*kind/i.test(body), '删除条件里不应出现 kind 过滤在 IN 之外');
});

/* ---------------- 课次改动要退回全部周次 ---------------- */
t('改课次会把该班全部已发布周退回草稿（不是只退第 1 周）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-course.js'), 'utf8');
  const fnAt = src.indexOf('async function updateSession');
  const body = src.slice(fnAt);
  assert.ok(/Array\.from\(\{ length: totalWeeks \}/.test(body),
    '应按该班 total_weeks 生成全部周次');
  assert.ok(!/toDraftWeeks\(\s*pool,\s*\[1\]/.test(body),
    '只退第 1 周是错的：课次是全周共用的一行');
});

/* ---------------- 变异自证：改坏应当被抓 ---------------- */
// 判据极性 = 变异后应变 false/失败
function mutateAndExpectFail(label, file, find, replace, customMutate) {
  const p = path.join(ROOT, file);
  const src = fs.readFileSync(p, 'utf8');
  let mutated;
  if (customMutate) {
    mutated = customMutate(src);
    if (mutated === null) return;
  } else {
    const n = src.split(find).length - 1;
    if (n !== 1) {
      fails.push({ name: '变异锚点不唯一: ' + label, msg: '出现 ' + n + ' 次，应为 1' });
      return;
    }
    mutated = src.replace(find, replace);
  }
  // ⚠️ 变异必须真的改动了源码，否则「变异未生效」会被误读成「测试没抓到」
  if (mutated === src) {
    fails.push({ name: '变异未生效: ' + label, msg: '变异后源码与原文件相同（锚点可能写错）' });
    return;
  }
  const tmpDir = path.join(__dirname, '_mut');
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tmp = path.join(tmpDir, path.basename(file));
    fs.writeFileSync(tmp, mutated);
    // 用判据函数重跑：直接检查变异后的源码是否还满足约束
    const ok = stillPasses(file, tmp);
    if (ok) fails.push({ name: '变异未被抓到: ' + label, msg: '变异后判据仍通过（假绿）' });
    else pass++;
  } finally {
    // 清临时目录只是善后，**失败不能让门禁挂掉**：
    // 宿主给 fs.rmSync 套了「安全删除」垫片（走回收站二进制），
    // 该二进制超时会抛 ETIMEDOUT —— 那是环境问题，不是被测代码的问题。
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}
function stillPasses(file, tmpPath) {
  if (file === 'lib/auth.js') {
    const src = fs.readFileSync(tmpPath, 'utf8');
    // 判据：会话加载**与**登录都必须回查 member 超管态 + 停用态，
    //    两处一处都不能少 —— 少一处就等于留了一个「已登录会话不过期」的后门。
    //    ⚠️ 必须数出现次数而不是「有没有」：只查存在性时，
    //    变异掉其中一处、另一处仍在，判据照样全绿（兜底互掩盖）。
    const need = "Number(m.is_super) !== 1 || m.status !== 'ACTIVE'";
    const cnt = src.split(need).length - 1;
    return cnt >= 2;
  }
  if (file === 'common/timetable-import.js') {
    const src = fs.readFileSync(tmpPath, 'utf8');
    const fnAt = src.indexOf('async function writeTimetable');
    const body = src.slice(fnAt, src.indexOf('async function toDraftWeeks'));
    const rollbackAt = body.indexOf('rollbackDutyMarkers');
    const deleteAt = body.indexOf('DELETE FROM session');
    return rollbackAt > 0 && rollbackAt < deleteAt;
  }
  if (file === 'lib/mod-course.js') {
    const src = fs.readFileSync(tmpPath, 'utf8');
    // 判据一：备份表名只能是**字面量常量**，且 commitImport 与 deleteSession 各有一份。
    //   ⚠️ 2026-10-10 修正：旧判据找 `const bakTable = 'bak_session_' + stamp` ——
    //   源码里根本没这个变量（重构后叫 BAK_SESSION）⇒ 判据恒 false ⇒
    //   下面那几组 mod-course 变异一直靠「恒 false 也算抓到」在假自证。
    //   判据必须贴真实源码形态，变异才有意义。
    const bakCnt = src.split("const BAK_SESSION = 'bak_admin_session';").length - 1;
    const tableNameSafe = bakCnt >= 2
      && !/BAK_(SESSION|COURSE)\s*=\s*String\(/.test(src)
      && !/BAK_(SESSION|COURSE)\s*=\s*['"`][^'"`]*\$\{/.test(src);
    // 判据二：改课次要退回全部周次 —— body 必须**收窄到 updateSession 自己**，
    //   否则 deleteSession 里的同款代码会把变异掩盖掉（兜底互掩盖 ⇒ 假绿）。
    const fnAt = src.indexOf('async function updateSession');
    const delAt = src.indexOf('async function deleteSession');
    const body = src.slice(fnAt, delAt > fnAt ? delAt : undefined);
    const allWeeks = /Array\.from\(\{ length: totalWeeks \}/.test(body);
    // 判据三：删课次必须与导入同口径（2026-10-10 新增 deleteSession）
    // ⚠️ 2026-10-12 修正：clearTimetable 加入后也含 `Array.from({ length: totalWeeks })`，
    //   delBody 若切到文件尾会把 clearTimetable 的同款代码算进来 ⇒
    //   「删掉 deleteSession 的 toDraftWeeks」变异被 clearTimetable 掩护成假绿
    //   （兜底互掩盖 ⇒ 变异抓不到）。必须把 delBody 收窄到 deleteSession 函数体内。
    const clearAt = src.indexOf('async function clearTimetable');
    const delBody = delAt >= 0 ? src.slice(delAt, clearAt > delAt ? clearAt : undefined) : '';
    const delOk = delAt >= 0
      && delAt > fnAt   // 必须是新加的独立函数，不能把 updateSession 改名充数
      && /INSERT INTO `' \+ BAK_SESSION/.test(delBody)
      && /DELETE FROM duty WHERE session_id = \? AND status IN \('PENDING','ONGOING'\) AND class_date >= \?/.test(delBody)
      && /id NOT IN \(SELECT course_id FROM session\)/.test(delBody)
      && /Array\.from\(\{ length: totalWeeks \}/.test(delBody)
      && /action: 'session\.delete'/.test(delBody);
    return tableNameSafe && allWeeks && delOk;
  }
  if (file === 'lib/mod-member.js') {
    const src = fs.readFileSync(tmpPath, 'utf8');
    const touching = extractMemberQueries(src).filter(isPersonQuery);
    return touching.length >= 4 && touching.every((q) => q.indexOf('NOT_TEST') >= 0);
  }
  if (file === 'public/app.js') {
    const src = fs.readFileSync(tmpPath, 'utf8');
    // 判据：右上角切班必须**就地刷新**，且要把状态清干净。
    //   ⚠️ 只查「有没有 reload()」是不够的 —— 同时出现 reload() 和 go('overview')
    //   仍然会跳走（reload 先跑一遍再被跳走）⇒ 必须**互斥**地判。
    const m = /sel\.onchange = function \(\) \{([\s\S]*?)\n    \};/.exec(src);
    if (!m) return false;
    const b = m[1];
    return /reload\(\)/.test(b)
      && !/go\(\s*'overview'\s*\)/.test(b)
      && /memberPage = 1/.test(b) && /auditPage = 1/.test(b)
      && /\.dlg-mask/.test(b);
  }
  return true;
}

mutateAndExpectFail(
  '删课次前不回滚 duty_count',
  'common/timetable-import.js',
  'if (duties.length) await rollbackDutyMarkers(conn, duties.map((r) => Number(r.id)));',
  'if (duties.length) { /* 变异：漏掉回滚 */ }'
);
// 2026-10-10：updateSession 与 deleteSession 都有同款 toDraftWeeks 片段，
// 锚点不唯一 ⇒ 用 customMutate 定位到 updateSession **函数内**的那一处。
mutateAndExpectFail(
  '改课次只退回第 1 周',
  'lib/mod-course.js',
  null,
  null,
  (src) => {
    const at = src.indexOf('async function updateSession');
    const seg = 'const totalWeeks = Number(cfg && cfg.total_weeks) || 16;\n' +
      '  const resetPublish = await timetableImport.toDraftWeeks(\n' +
      '    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), before.class_id\n  );';
    const pos = src.indexOf(seg, at);
    if (pos < 0) return null;
    return src.slice(0, pos) +
      'const resetPublish = await timetableImport.toDraftWeeks(pool, [1], before.class_id);' +
      src.slice(pos + seg.length);
  }
);
// 变异必须打在**能真正改变运行行为**的位置。
// ⚠️ 第一版把 `const NOT_TEST_SQL = NOT_TEST('m')` 改成 '1=1'，结果判据仍全绿 ——
//    因为成员详情那 4 条查询是另一处独立的 `NOT_TEST('m')` 字面调用，
//    变���体压根没影响它们，而列表那两条虽被改坏，判据只看「SQL 里有 NOT_TEST 字样」
//    而不是「NOT_TEST 真的还在生效」。
//    教训同项目 MEMORY：变异锚点打在「看起来对但其实无效」的位置 = 假自证。
// 正确做法：让变异同时抹掉**所有** NOT_TEST 调用点（replace_all 语义），
// 这样「列表 + 详情」一起坏，判据必然变红。
function mutateAll(src, find, replace) {
  const n = src.split(find).length - 1;
  if (n < 2) {
    fails.push({ name: '变异锚点覆盖不足', msg: '只找到 ' + n + ' 处（应 ≥2），变异只会影响部分查询' });
    return null;
  }
  return src.split(find).join(replace);
}

mutateAndExpectFail(
  '成员查询全部去掉测试账号过滤',
  'lib/mod-member.js',
  null,
  null,
  (src) => mutateAll(src, "NOT_TEST('m')", "'1=1'")
);
/**
 * 变异随实现更新（2026-10-10）：备份表名已从「时间戳动态拼」改为「纯常量」。
 * 变异意图不变 —— 证明「表名不得来自入参」这条判据真的会翻脸。
 * 锚点必须用**逐字真实**的代码行，写错会被 mutateAndExpectFail 报「锚点不唯一」。
 *
 * ⚠️ 两条变异缺一不可：
 *   ① 常量被改成读 payload —— 抓「表名来自入参」；
 *   ② 常量本身被换成小写动态串（伪装成普通字面量表名）——
 *      只判「全大写常量」的实现会放它过去，只有「字面量 or 常量」的判据能抓住。
 *      少这一条，判据就只在最直白的写法下有效（2026-10-10 补）。
 */
// 2026-10-10：deleteSession 加入后 BAK_SESSION 常量有两份（commitImport + deleteSession），
// 锚点不再唯一 ⇒ 改用 mutateAll 把**两份一起改坏**，判据 bakCnt>=2 必然翻脸。
mutateAndExpectFail(
  '备份表名改用入参（SQL 注入面）',
  'lib/mod-course.js',
  null,
  null,
  (src) => mutateAll(src,
    "const BAK_SESSION = 'bak_admin_session';",
    "const BAK_SESSION = String(payload.bakTable || 'bak_admin_session');")
);
mutateAndExpectFail(
  '备份表名改成小写动态串（伪装成字面量表名绕过判据）',
  'lib/mod-course.js',
  null,
  null,
  (src) => mutateAll(src,
    "const BAK_SESSION = 'bak_admin_session';",
    "const BAK_SESSION = 'bak_' + String(stamp).toLowerCase();")
);
mutateAndExpectFail(
  '登录不再回查 member 超管态（会话不吊销）',
  'lib/auth.js',
  "if (!m || Number(m.is_super) !== 1 || m.status !== 'ACTIVE') return null;",
  'if (!m) return null;'
);
mutateAndExpectFail(
  '切班又跳回概览（就地刷新被改回 go(overview)）',
  'public/app.js',
  "      //    （2026-10-10 改：原来一切班就跳概览，在成员/课表页翻班非常难受）\n      reload();",
  "      //    （2026-10-10 改：原来一切班就跳概览，在成员/课表页翻班非常难受）\n      go('overview');"
);
mutateAndExpectFail(
  '切班不重置分页游标（会翻到空页）',
  'public/app.js',
  '      state.memberPage = 1;\n      state.auditPage = 1;',
  '      /* 变异：不重置分页 */'
);
mutateAndExpectFail(
  '切班不撤掉开着的导入弹层（看到 A 班、导进 B 班）',
  'public/app.js',
  "      $$('.dlg-mask').forEach(function (d) { d.remove(); });",
  '      /* 变异：留着旧弹层 */'
);
// INSERT 行在 commitImport 与 deleteSession 各一份 ⇒ mutateAll 一起改坏，
// 判据「delBody 必须含 INSERT INTO '+BAK_SESSION」必然翻脸。
mutateAndExpectFail(
  '删课次不备份（没备份就开删）',
  'lib/mod-course.js',
  null,
  null,
  (src) => mutateAll(src,
    "    'INSERT INTO `' + BAK_SESSION + '` (batch_no, class_id, group_scope, session_id, course_id, ' +",
    "    '/* 变异：不备份 */ ' +")
);
mutateAndExpectFail(
  '删课次把历史值日也删了（只该删未来的 PENDING/ONGOING）',
  'lib/mod-course.js',
  '        "DELETE FROM duty WHERE session_id = ? AND status IN (\'PENDING\',\'ONGOING\') AND class_date >= ?",',
  '        "DELETE FROM duty WHERE session_id = ? AND status IN (\'PENDING\',\'ONGOING\')",'
);
mutateAndExpectFail(
  '删课次不退已发布周次（发布中的排班表与数据对不上）',
  'lib/mod-course.js',
  null,
  null,
  (src) => {
    const at = src.indexOf('async function deleteSession');
    if (at < 0) return null;
    const seg = '  const resetPublish = await timetableImport.toDraftWeeks(\n' +
      '    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), before.class_id\n  );';
    const pos = src.indexOf(seg, at);
    if (pos < 0) return null;
    return src.slice(0, pos) + '  const resetPublish = { deleted: 0 };' + src.slice(pos + seg.length);
  }
);

/* ---------------- 课表 HTML 解析的页面接入（浏览器侧） ---------------- */
// 解析器本体由 check-html-parser.js 守；这里只守「挂上了没、接对了没」——
// 脚本没引进 index.html ⇒ 浏览器端 window.TimetableHtml 恒空 ⇒ 导入页静默不可用，
// 而这层是 e2e 测不到的（部署后才存在），只能靠源码判据锁。
const PUB = path.join(ROOT, 'public');
const readPub = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

t('index.html 引入了 timetable-html.js（且带 onerror 兜底）', () => {
  const html = readPub('index.html');
  assert.ok(/timetable-html\.js/.test(html), 'index.html 里没有引入解析器');
  assert.ok(/onerror\s*=\s*["']?[^"']*__noHtmlParser/.test(html),
    '引入 <script> 必须带 onerror 置 __noHtmlParser，否则 404 时只有静默失败');
});

t('app.js 在解析前检查解析器是否就位', () => {
  const js = readPub('app.js');
  assert.ok(/window\.TimetableHtml\s*\)?\s*\{?[\s\S]{0,200}未加载 HTML 解析库/.test(js) ||
    /if\s*\(!window\.TimetableHtml\)[\s\S]{0,120}未加载 HTML 解析库/.test(js),
    '缺少 window.TimetableHtml 缺失时的中文提示');
});

t('四种版面都有中文名（新增版面时别漏）', () => {
  const js = readPub('app.js');
  const m = /var names = \{([\s\S]*?)\};/.exec(js);
  assert.ok(m, '找不到版面名映射');
  ['list', 'print', 'grid', 'legacy'].forEach((k) => {
    assert.ok(new RegExp('\\b' + k + '\\s*:').test(m[1]), '版面名缺少 ' + k);
  });
});

t('导入弹窗有「文件 / HTML 源码」双来源切换', () => {
  const html = readPub('index.html');
  const js = readPub('app.js');
  ['src-file', 'src-html', 'pane-file', 'pane-html'].forEach((id) => {
    assert.ok(html.indexOf(id) >= 0 || js.indexOf(id) >= 0, '缺少 ' + id);
  });
  assert.ok(/src-tab/.test(js), '缺少 .src-tab 切换逻辑');
});

t('打印版去重条数要显示出来（否则操作者以为课少了）', () => {
  const js = readPub('app.js');
  assert.ok(/stats\.deduped[\s\S]{0,80}已合并/.test(js), '缺少 deduped 的中文提示');
});

t('删课次：路由 + 前端确认弹窗都在（2026-10-10 新增能力）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const js = readPub('app.js');
  assert.ok(/timetable\/session\/:id\/delete/.test(idx), '后端缺删除路由');
  assert.ok(/data-del-session/.test(js), '课表行缺删除按钮');
  assert.ok(/function removeSession/.test(js) && /session\/' \+ id \+ '\/delete/.test(js),
    '前端缺 removeSession 或没调删除接口');
  assert.ok(/confirm\(/.test(js.match(/function removeSession[\s\S]{0,900}/)[0]),
    '删除必须先 confirm（课次是所有周共用的一行，删错影响全班）');
});

t('右上角切班：就地刷新，不跳回概览（2026-10-10 用户要求）', () => {
  const js = readPub('app.js');
  const m = /sel\.onchange = function \(\) \{([\s\S]*?)\n    \};/.exec(js);
  assert.ok(m, '找不到 #class-picker 的 onchange');
  const b = m[1];
  assert.ok(/reload\(\)/.test(b), '切班必须 reload() 就地刷新当前页');
  assert.ok(!/go\(\s*'overview'\s*\)/.test(b),
    '切班不能跳 overview —— 会把人从成员/课表页踢走');
  assert.ok(/memberPage = 1/.test(b) && /auditPage = 1/.test(b),
    '两个分页游标都要重置（新班可能没那么多页）');
  assert.ok(/\.dlg-mask/.test(b),
    '开着导入弹层时要一起撤掉 —— 否则「看到 A 班、导进 B 班」');
});

t('清空课表：后端函数存在且安全属性齐全（2026-10-12 新增能力）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-course.js'), 'utf8');
  const js = readPub('app.js');
  assert.ok(/async function clearTimetable/.test(src), '后端缺 clearTimetable 函数');
  // 清空前必须回滚轮转标记（游标不漂移铁律）
  assert.ok(/timetableImport\.rollbackDutyMarkers/.test(src), '清空应回滚轮转标记');
  // 清空后必须退回全部已发布周次（不是只退第 1 周）
  assert.ok(/Array\.from\(\{ length: totalWeeks \}/.test(src), '清空应退回全部周次');
  // 审计 action 必须是 timetable.clear，便于事后追溯
  assert.ok(/action: 'timetable\.clear'/.test(src), '审计 action 应为 timetable.clear');
  // 必须先建备份再删（与导入/删课次同口径）
  assert.ok(/bak_admin_session/.test(src) && /bak_admin_course/.test(src), '清空应建备份');
  // 支持 dryRun 预览，确认前先让用户看清要删多少
  assert.ok(/dryRun/.test(src), '清空应支持干跑预览');
  // 路由 + 前端入口都在
  assert.ok(/timetable\/clear/.test(idx), '后端缺清空路由');
  assert.ok(/btn-clear/.test(js), '课表页缺清空按钮');
  assert.ok(/function openClearDialog/.test(js), '前端缺 openClearDialog');
  assert.ok(/c-group/.test(js), '清空弹窗缺组别选择');
});

t('单独添加课次：后端函数存在且安全属性齐全（2026-10-12 新增能力）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-course.js'), 'utf8');
  const js = readPub('app.js');
  assert.ok(/async function addSession/.test(src), '后端缺 addSession 函数');
  // A/B/全体 必须都能写入；全体课在库里就是 group_scope = NULL（与导入口径一致）
  assert.ok(/groupScope = grp === 'ALL' \? null : grp/.test(src), '全体课应落为 group_scope=NULL');
  // 课程行必须跟组别选 course_type（否则会踩 enum NOT NULL，参考清空课表 500）
  assert.ok(/course_type/.test(src), '应写入 course_type');
  // 新增也是「改了排班表」⇒ 已发布周退回草稿
  assert.ok(/timetableImport\.toDraftWeeks/.test(src), '添加应退回已发布周次');
  // 审计 action 便于追溯
  assert.ok(/action: 'timetable\.add'/.test(src), '审计 action 应为 timetable.add');
  // 路由（注意不带 /:id，区别于编辑路由）与前端入口
  assert.ok(/'\/api\/timetable\/session',/.test(idx), '后端缺添加课次路由');
  assert.ok(/btn-add/.test(js), '课表页缺添加课次按钮');
  assert.ok(/function openAddDialog/.test(js), '前端缺 openAddDialog');
  assert.ok(/a-group/.test(js), '添加弹窗缺组别选择');
});

t('请假：后端 listLeave/updateLeave 存在且安全属性齐全（2026-10-12 新增能力）', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-leave.js'), 'utf8');
  const js = readPub('app.js');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.ok(/async function listLeave/.test(src), '后端缺 listLeave 函数');
  assert.ok(/async function updateLeave/.test(src), '后端缺 updateLeave 函数');
  // 不显示测试账号：NOT_TEST 必须显式出现在查询里
  assert.ok(/NOT_TEST/.test(src), '请假列表应显式过滤测试账号');
  // 改日期/状态要重算 duty 的 LEAVE 标记（与小程序 addLeave/cancelLeave 同口径）
  assert.ok(/resyncDutiesForMember/.test(src), '改日期/状态应重算 duty 标记');
  // 审计 action 便于追溯
  assert.ok(/action: 'leave\.update'/.test(src), '审计 action 应为 leave.update');
  // 路由与前端入口都在
  assert.ok(/'\/api\/leave',/.test(idx), '后端缺请假列表路由');
  assert.ok(/'\/api\/leave\/:id',/.test(idx), '后端缺请假编辑路由');
  assert.ok(/data-view="leave"/.test(html), '导航缺请假入口');
  assert.ok(/function renderLeave/.test(js), '前端缺 renderLeave');
  assert.ok(/function openLeaveEditDialog/.test(js), '前端缺 openLeaveEditDialog');
});

t('绑定情况：概览含各班绑定数 + 前端绑定视图（2026-10-12 新增能力）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'mod-config.js'), 'utf8');
  const js = readPub('app.js');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  // 后端：overview 必须统计各班已绑定人数（openid 非空）
  assert.ok(/boundCnt/.test(src), 'overview 应统计已绑定人数（boundCnt）');
  assert.ok(/boundCount/.test(src), 'overview 应映射 boundCount');
  // 前端：导航入口 + 视图 + 概览展示
  assert.ok(/data-view="binding"/.test(html), '导航缺绑定入口');
  assert.ok(/function renderBinding/.test(js), '前端缺 renderBinding');
  assert.ok(/binding:\s*\{\s*title:\s*'绑定'/.test(js), 'VIEWS 应含 binding');
  assert.ok(/c\.boundCount/.test(js), '概览应展示各班已绑定人数');
});

/* ================= 汇总 ================= */
console.log('');
if (fails.length) {
  console.log('✗ 失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f.name + '\n      ' + f.msg));
  process.exit(1);
}
console.log('✓ check-admin-web 全部通过（' + pass + ' 项）');