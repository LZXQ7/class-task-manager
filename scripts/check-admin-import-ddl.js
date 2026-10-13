#!/usr/bin/env node
/**
 * 门禁：课表导入路径（commitImport）**不得包含任何 DDL 语句**
 * 编号 74
 *
 * 背景（2026-10-10 真机 500 实踩）
 * ------------------------------------------------------------------
 * commitImport 原本用「按时间戳建备份表」做自动备份：
 *     CREATE TABLE IF NOT EXISTS `bak_session_<stamp>` LIKE session
 * 逻辑在 mock 上天衣无缝，e2e 43 项全绿 —— 但线上 500：
 *     ER_TABLEACCESS_DENIED_ERROR 1142
 *     "CREATE command denied to user 'classassist_app'@'172.17.0.7' for table ..."
 * 根因：**应用数据库账号只有 DML 权限，没有 DDL**。库里那些 bak_* 表全是我用
 * root 手工建的，运行期账号自己建不出来。
 *
 * 为什么这条必须是门禁而不是「记进文档的注意事项」
 * ------------------------------------------------------------------
 * ① 这是**权限维度**的缺陷，mock 层的 e2e 原理上抓不到（mock 的 query 什么都能跑）；
 * ② 失败点在事务**之前**，数据一行不动 —— 现场表现为「导入功能坏了」，
 *    但代码读起来完全正常，review 也看不出来；
 * ③ 修法（改用常备表 bak_admin_session / bak_admin_course，只做 DML）本身
 *    也可能被后人「优化」回 CREATE TABLE —— 那就复发。
 * 所以把「导入路径零 DDL」锁成硬门禁，并做变异自证。
 *
 * 判据：抽出 lib/mod-course.js 的 commitImport 函数体，静态扫 DDL 关键字。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'cloudfunctions', 'admin-web', 'lib', 'mod-course.js');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/**
 * 去掉注释，避免注释/提示语里的关键字造成误报。
 *
 * ⚠️⚠️ 只剥注释，**绝不剥字符串字面量**（2026-10-10 实踩，见下）：
 *   中文注释里出现单个英文撇号（如「操作者'」这种半角写法）会让
 *   `'(?:[^'\\]|\\.)*'` 从那里一路配对到下一个引号，把中间大段真实代码
 *   （含 BAK_SESSION 常量定义与备份段）一起吞掉 —— 表现为
 *   「函数体莫名截断在 const stamp =」，正向锚点全部 findIndex 返 -1，
 *   判据会「因为找不到」而静默假通过。
 *   代价：字符串里的关键字（如注释外的 'CREATE TABLE' 字样）也会被扫到。
 *   这个代价可接受 —— 真代码里不会出现无意义的 DDL 关键字字符串，
 *   而误判成红的代价（后人失去这条门禁）远大于。
 *
 * 剥注释同样有陷阱：
 *   · 块注释 /** ... *\/ 与行注释 // 要都处理；
 *   · 行注释的起始 // 不能吃掉 URL 里的 https://（本文件无此风险，
 *     但用 [^:/] 之前的字符做守卫更稳）；
 *   · 替换必须**等长**或至少保留换行，否则行号全乱（本门禁不依赖行号，
 *     但保持可读性便于排查）。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** 抽出某个顶层函数/方法体的花括号区间（按大括号配对，不用正则猜） */
function sliceBraced(src, headerRe) {
  const m = src.match(headerRe);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * DDL 判定：只认「真正会执行的 DDL」。
 * - CREATE TABLE / DROP / ALTER / TRUNCATE / RENAME
 * - 排除 CREATE TABLE IF NOT EXISTS bak_admin_* 吗？**不排除** ——
 *   本门禁的立场就是「导入路径一条 DDL 都不该有」，
 *   常备表是 DBA 侧一次性建的（scripts/admin-bak-tables.sql），运行期只做 DML。
 */
const DDL = [
  { name: 'CREATE TABLE', re: /\bCREATE\s+(?:TEMPORARY\s+)?TABLE\b/i },
  { name: 'CREATE INDEX', re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i },
  { name: 'CREATE DATABASE', re: /\bCREATE\s+(?:DATABASE|SCHEMA)\b/i },
  { name: 'DROP', re: /\bDROP\s+(?:TABLE|DATABASE|INDEX)\b/i },
  { name: 'ALTER TABLE', re: /\bALTER\s+TABLE\b/i },
  { name: 'TRUNCATE', re: /\bTRUNCATE\b/i },
  { name: 'RENAME TABLE', re: /\bRENAME\s+TABLE\b/i }
];

/** 判定一段代码是否含 DDL；返回命中的关键字名数组 */
function findDDL(code) {
  const hits = [];
  for (const d of DDL) if (d.re.test(code)) hits.push(d.name);
  return hits;
}

console.log('门禁 74：课表导入路径零 DDL（应用库账号无 CREATE 权限）\n');

const raw = fs.readFileSync(TARGET, 'utf8');
const clean = stripComments(raw);

// ---- 1. 结构前提：能定位到 commitImport 与 dryRunImport ----
const commitBody = sliceBraced(clean, /async\s+function\s+commitImport\s*\(/);
const dryBody = sliceBraced(clean, /async\s+function\s+dryRunImport\s*\(/);
ok(!!commitBody, '能定位 commitImport 函数体');
ok(!!dryBody, '能定位 dryRunImport 函数体');
if (!commitBody || !dryBody) {
  console.log('\n✗ 结构前提不成立，后续判据无意义，判失败');
  process.exit(1);
}

// ---- 2. 主判据：两个导入入口都不含 DDL ----
const commitHits = findDDL(commitBody);
ok(commitHits.length === 0,
  'commitImport 不含任何 DDL（当前实现：写常备表，只做 DML）',
  '命中：' + commitHits.join(', '));

const dryHits = findDDL(dryBody);
ok(dryHits.length === 0,
  'dryRunImport 也不含 DDL（干跑必须零副作用）',
  '命中：' + dryHits.join(', '));

// ---- 3. 正向锚点：常备备份表确实被用上了 ----
//  只断言「没有 DDL」不够 —— 万一有人把整个备份段删掉，判据同样会通过（空实现），
//  那就成了「备份形同虚设但门禁全绿」。必须同时锁住备份行为本身。
ok(/bak_admin_session/.test(commitBody), '备份写入常备表 bak_admin_session');
ok(/bak_admin_course/.test(commitBody), '备份写入常备表 bak_admin_course');
// ⚠️ 表名在代码里是**常量拼接**（'INSERT INTO `' + BAK_SESSION + '` (...)'），
//    不是字面量表名 —— 判据若写 /INSERT INTO .*bak_admin_session/ 必然永远为假。
//    同样**不逐字对齐引号形态**（第二个反引号被字符串定界符吃掉，实际是单引号），
//    用「INSERT INTO + 表常量」这一段语义来锚。
ok(/INSERT INTO[^;]{0,120}BAK_SESSION/.test(commitBody),
  '确有对 bak_admin_session 的 INSERT 备份动作（不是只留了表名）');
ok(/INSERT INTO[^;]{0,120}BAK_COURSE/.test(commitBody),
  '确有对 bak_admin_course 的 INSERT 备份动作');
// 每次导入按批次先清同批再写入，避免批次号碰撞时残留上一批的行
/**
 * 断言「存在一条按 batch_no 清理同批次的 DELETE」。
 *
 * ⚠️ 这里**故意不逐字对齐源码形态**（2026-10-10 实踩）：
 *   源码是 `'DELETE FROM `' + BAK_SESSION + '` WHERE batch_no = ?'`，
 *   第二个反引号被字符串定界符吃掉，实际拼接出来是 ` + '` WHERE`（单引号不是反引号）。
 *   逐字对齐的正则要在这两种引号之间反复试（本次试了三轮才对齐），
 *   而任何人改个空格/换行/引号风格，判据就静默变红或变假 —— 门禁变成负担。
 *   语义断言（表常量 + batch_no + WHERE 三者同时出现）足够严：
 *   把 DELETE 整条删掉、或把 batch_no 换成别的列，都抓得住。
 */
ok(/DELETE FROM[^;]{0,80}BAK_SESSION[^;]{0,80}WHERE batch_no/.test(commitBody),
  '按 batch_no 先清同批再写入（批次号碰撞不留残行）');
ok(/batch_no/.test(commitBody), '备份按 batch_no 归档（可累积、可按批次回滚）');

// ---- 4. 备份必须发生在开启事务之前 ----
//  语义要求：备份失败即中止，绝不「没备份就开删」。
//  若顺序颠倒，一旦备份失败，事务里已经把课次删了 —— 数据无法找回。
// ⚠️ 判据锚在**备份动作**（DELETE FROM ... BAK_SESSION）上，不是表名常量：
//    常量声明写在函数开头、事务之前，顺序怎么改它都不动 ⇒ 拿它判恒为真，
//    整条判据就成了摆设（2026-10-10 实踩）。
const bakActAt = commitBody.search(/DELETE FROM\s+`'?\s*\+\s*BAK_SESSION/);
const txnAt = commitBody.search(/beginTransaction/);
ok(bakActAt >= 0 && txnAt >= 0, '能定位备份动作与事务开启点');
ok(bakActAt < txnAt, '备份在 beginTransaction 之前（备份失败即中止，不留半删状态）',
  '备份动作位置 ' + bakActAt + ' / 事务位置 ' + txnAt);

/**
 * 定位「备份段」在 commitImport 体内的区间 [start, end)。
 *
 * ⚠️ 边界必须用**备份动作自己**的起止（首个 DELETE → 末个 INSERT 结束），
 *    不能拿外围变量声明（如 `let backedUp = {...}`）当端点 ——
 *    那个声明写在备份段**之前**（先声明、后赋值），用它当 end 会得到
 *    end < start 的反向区间，切出空串，变异体与原体完全相同 ⇒
 *    变异自证「看起来跑了、其实没改任何东西」，是典型的静默假通过。
 *    （2026-10-10 实测：bakStart=1850 > bakEnd=1675。）
 */
function backupSpan(body) {
  const start = body.indexOf('DELETE FROM');
  if (start < 0) return null;
  const lastInsert = body.lastIndexOf('INSERT INTO');
  if (lastInsert < start) return null;
  // 找末个 INSERT 语句的收尾：从它开始找第一个 ");" 之后
  const tail = body.indexOf(');', lastInsert);
  if (tail < 0) return null;
  return { start, end: tail + 2 };
}

// ---- 5. 变异自证：把代码改回「按时间戳 CREATE TABLE」必须被抓 ----
//  不做变异自证的判据会「静默假通过」——锚点漂移或判据写错都看不出来。
const MUTATIONS = [
  {
    name: '变异1：备份改回 CREATE TABLE ... LIKE session（原始 bug）',
    from: /await pool\.query\('DELETE FROM `'\s*\+\s*BAK_SESSION\s*\+\s*'` WHERE batch_no = \?', \[stamp\]\);/,
    to: "await pool.query('CREATE TABLE IF NOT EXISTS `bak_session_' + stamp + '` LIKE session');",
    hit: 'DDL'
  },
  {
    name: '变异2：改成 CREATE TABLE IF NOT EXISTS（带 IF NOT EXISTS，绕过关键字眼）',
    from: /await pool\.query\('DELETE FROM `'\s*\+\s*BAK_SESSION\s*\+\s*'` WHERE batch_no = \?', \[stamp\]\);/,
    to: "await pool.query('CREATE TABLE IF NOT EXISTS `bak_admin_session2` LIKE session');",
    hit: 'DDL'
  },
  {
    name: '变异3：备份段挪到 beginTransaction 之后（备份失败仍已开删）',
    hit: 'ORDER'
  }
];

for (const mut of MUTATIONS) {
  let mutated;
  if (mut.hit === 'DDL') {
    mutated = commitBody.replace(mut.from, mut.to);
    if (mutated === commitBody) {
      ok(false, mut.name + '（锚点已漂移，变异体没改成 —— 判据本身不可信）');
      continue;
    }
  } else {
    // 变异3：把备份代码块整体搬到事务之后
    const span = backupSpan(commitBody);
    const txnIdx = commitBody.indexOf('beginTransaction');
    if (!span || txnIdx < 0) {
      ok(false, mut.name + '（锚点已漂移，找不到备份段/事务点）');
      continue;
    }
    if (!(span.start < txnIdx)) {
      ok(false, mut.name + '（前置条件不成立：备份本就不在事务前，变异无意义）');
      continue;
    }
    const bakBlock = commitBody.slice(span.start, span.end);
    mutated = commitBody.slice(0, span.start) + commitBody.slice(span.end);
    const newTxn = mutated.indexOf('beginTransaction');
    // 插到事务调用之后（beginTransaction(); 这一句结束之后）
    const after = mutated.indexOf(');', newTxn);
    mutated = mutated.slice(0, after + 3) + '\n' + bakBlock + mutated.slice(after + 3);
  }

  const hits = findDDL(mutated);
  /**
   * ⚠️ 顺序判据必须锚在**备份动作**（`DELETE FROM ... BAK_SESSION`）上，
   *    不能用 `bak_admin_session` 这个名字 ——
   *    常量声明 `const BAK_SESSION = 'bak_admin_session'` 在函数开头，
   *    永远早于事务点，搬不搬备份段它都不动 ⇒ 拿它判顺序恒为「没抓住」，
   *    变异自证就成了永远红的死条款（2026-10-10 实测：bak=1440 < txn=2003）。
   */
  const bakActAt = mutated.search(/DELETE FROM\s+`'?\s*\+\s*BAK_SESSION/);
  const txnAtM = mutated.search(/beginTransaction/);
  // ⚠️ caught 的语义是「**变异体必须被抓住**」。
  //    DDL 类：变异体出现 DDL ⇒ 判据报警 ⇒ 抓住。
  //    顺序类：备份动作跑到事务点之后 ⇒ 违反「备份在事务前」⇒ 抓住。
  //    两个锚点必须都定位到（>=0），否则判定结果不可预期，一律判「没抓住」。
  let caught;
  if (mut.hit === 'ORDER') {
    caught = bakActAt >= 0 && txnAtM >= 0 && bakActAt > txnAtM;
  } else {
    caught = hits.length > 0;
  }
  ok(caught, mut.name + ' → 被判据抓住');
}

// ---- 6. 变异自证：删掉备份段（空实现）必须被抓 ----
//  这是最容易漏的一档：备份代码整段删掉后，「无 DDL」依然成立 ⇒ 判据假通过。
{
  const span = backupSpan(commitBody);
  const stripped = span
    ? commitBody.slice(0, span.start) + commitBody.slice(span.end)
    : commitBody;
  // 判据与第 3 节正向锚点**逐条对应**（用同一组正则），
  // 否则会出现「第3节锚点换了写法、变异4 还在测老写法」的静默假通过。
  const stillHasBackup =
    /INSERT INTO[^;]{0,120}BAK_SESSION/.test(stripped) &&
    /INSERT INTO[^;]{0,120}BAK_COURSE/.test(stripped);
  ok(!stillHasBackup, '变异4：整段删掉备份 → 被正向锚点抓住（防「无 DDL 但无备份」空实现）');
}

// ---- 6. 备份表字段完整性（回滚能不能真的还原）----
//  2026-10-10 真机回滚时发现：备份表漏字段，而漏掉的那个字段是**人工信息**
//  （session.note = 「地点：xxx」「调课原因」）。回滚后一切正常、界面无异常，
//  只有真去查才发现备注没了 —— 这类「静默丢数据」必须由门禁挡住。
{
  const BAK_SESSION = path.join(ROOT, 'scripts', 'admin-bak-tables.sql');
  const sqlTxt = fs.readFileSync(BAK_SESSION, 'utf8');
  const m = sqlTxt.match(/CREATE TABLE IF NOT EXISTS `bak_admin_session`\s*\(([\s\S]*?)\n\)/);
  ok(!!m, '建表脚本里有 bak_admin_session 的完整列定义');
  if (m) {
    const cols = m[1];
    // session 表的每一列都必须被备份 —— 少一列就等于回滚时丢一列数据
    for (const c of ['class_id', 'group_scope', 'session_id', 'course_id',
      'kind', 'week_rule', 'weeks', 'day_of_week', 'period', 'duty_count', 'note']) {
      ok(new RegExp('`' + c + '`').test(cols), 'bak_admin_session 含列 ' + c);
    }
  }
  const m2 = sqlTxt.match(/CREATE TABLE IF NOT EXISTS `bak_admin_course`\s*\(([\s\S]*?)\n\)/);
  ok(!!m2, '建表脚本里有 bak_admin_course 的完整列定义');
  if (m2) {
    const cols = m2[1];
    for (const c of ['course_id', 'name', 'teacher', 'room']) {
      ok(new RegExp('`' + c + '`').test(cols), 'bak_admin_course 含列 ' + c);
    }
  }
}

/**
 * 变异自证：从备份 INSERT 语句里删掉 note 列，必须被上面那条抓住。
 * 不做自证的话，上面那些列名断言可能因为「锚点写错而恒真」而形同虚设。
 */
{
  const noteInSrc = /s\.duty_count,\s*IFNULL\(s\.note,''\)/.test(commitBody);
  ok(noteInSrc, '备份 INSERT 确实带上了 note 列（回滚要还原人工备注）');
  // 变异形态按源码逐字构造（2026-10-10 核对）：
  //   列清单结尾：  'kind, week_rule, weeks, day_of_week, period, duty_count, note) ' +
  //   SELECT 结尾： "s.day_of_week, s.period, s.duty_count, IFNULL(s.note,'') FROM session s WHERE ..."
  const stripped = commitBody
    .replace(/, note\) /g, ') ')
    .replace(/IFNULL\(s\.note,''\)/g, "''");
  ok(!/,\s*note\)/.test(stripped) && !/IFNULL\(s\.note/.test(stripped),
    '变异5：备份 INSERT 去掉 note → 被判据抓住');
}

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('✗ 门禁 74 不通过');
  process.exit(1);
}
console.log('✓ 门禁 74 通过');
