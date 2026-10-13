/**
 * 门禁 #57 / #58 / #59 —— 青果课表导入（需求 D-2）
 * ------------------------------------------------------------
 * #57 解析映射（import-parse.js）：列位置 → day_of_week(1-based)、节次标签 → period、
 *      周次文本 → 显式 CSV weeks、week_rule='ALL'、同(课程名+教师)去重为一门 course、
 *      kind='COURSE' / dutyCount=2。
 * #58 班级隔离（course/index.js importTimetable）：必须用 guard.resolveClassId 收口，
 *      严禁 classIdOf（超管适配他班时 classIdOf 会忽略传入 classId，把数据写进自己班）。
 * #59 命名格式（course/index.js applyTimetable）：fileName = '【班级名】-教学安排表'，
 *      括号只包班级名，班级名取自 class 查询（cls[0].name），绝不包文件名。
 *
 * 全部带双向自证：把关键字面量「改坏」后判据必须翻红；否则判据本身就是假的（门禁失效）。
 * 变异写入工作区内沙盒（scripts/.gate-sandbox），用 fs.writeFileSync，绝不碰 /tmp。
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..');
const SANDBOX = path.join(__dirname, '.gate-sandbox');
const IMPORT_PARSE = path.join(R, 'cloudfunctions/course/import-parse.js');
const COURSE_INDEX = path.join(R, 'cloudfunctions/course/index.js');

let failed = 0;
function ok(m) { console.log('  ✓ ' + m); }
function bad(m) { failed++; console.log('  ✗ ' + m); }
function has(text, needle) { return String(text).indexOf(needle) >= 0; }

/** 抽取某个路由块（从 `key: {` 起到括号平衡），忽略字符串内的括号 */
function blockOf(text, key) {
  const start = text.indexOf(key + ': {');
  if (start < 0) return null;
  let i = text.indexOf('{', start + key.length);
  let depth = 0, inStr = false, esc = false, q = '';
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === q) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, j + 1); }
  }
  return null;
}

/** 变异自证：把改坏后的文本写进沙盒再读回跑判据，判据必须翻红（返回 false） */
function selfProof(origText, mutator, checkFn, label) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const f = path.join(SANDBOX, 'mut.js');
  fs.writeFileSync(f, mutator(origText), 'utf8');
  const mut = fs.readFileSync(f, 'utf8');
  // 清沙盒只是善后：宿主给 fs.rmSync 套了「安全删除」垫片（走回收站二进制，
  // 超时抛 ETIMEDOUT）—— 环境问题不能当成判据失败。
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
  if (checkFn(mut)) bad('自证失败：' + label + ' 变异后仍放行（判据不实）');
  else ok('自证通过：' + label + ' 变异被捕获');
}

/* ---------------- #57 解析映射 ---------------- */
function check57(t) {
  return has(t, 'WEEK_NAMES')
    && has(t, 'dayOfWeek: d + 1')
    && has(t, "weekRule: 'ALL'")
    && has(t, "const key = name + ' ' + teacher;")
    && has(t, 'parseWeekSpec')
    && has(t, "kind: 'COURSE'")
    && has(t, 'dutyCount: 2');
}
console.log('── #57 解析映射（import-parse.js）');
{
  const t = fs.readFileSync(IMPORT_PARSE, 'utf8');
  if (check57(t)) ok('映射字段齐全：列→dayOfWeek / 节次→period / 周次→weeks CSV / 同(名+教师)去重 / COURSE');
  else bad('解析映射缺失关键字段');
  selfProof(t,
    (s) => s.replace("weekRule: 'ALL'", "weekRule: 'BAD'"),
    check57,
    'weekRule 改坏');
}

/* ---------------- #58 班级隔离 ---------------- */
function check58(block) {
  return has(block, 'guard.resolveClassId(') && !has(block, 'classIdOf');
}
console.log('── #58 importTimetable 用 resolveClassId 收口（不串班）');
{
  const t = fs.readFileSync(COURSE_INDEX, 'utf8');
  const blk = blockOf(t, 'importTimetable');
  if (!blk) bad('找不到 importTimetable 路由块');
  else if (check58(blk)) ok('importTimetable 调用 resolveClassId 且不含 classIdOf');
  else bad('importTimetable 未用 resolveClassId 收口或混入了 classIdOf');
  if (blk) selfProof(blk,
    (s) => s.replace('guard.resolveClassId(pool, ctx, payload)', 'guard.classIdOf(ctx)'),
    check58,
    'resolveClassId → classIdOf');
}

/* ---------------- #59 命名格式 ---------------- */
/** 剥掉块内注释 —— 否则判据会命中注释里引用的旧字面量（判据命中注释，已第 5 次踩到） */
function stripComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/**
 * 锁的是**意图**（B5 决议）：文件名里 `【】` 括号**只包班级名**，绝不包住整个文件名。
 * ⚠️ 2026-10-05：青果 A/B 组是两个独立文件，为让超管在申请列表里分得清，
 *    文件名末尾追加了组别后缀（`-A组` / `-B组`，全体课不加）。所以判据从
 *    「锁死整条赋值语句」放宽成「锁住 `'【' + className + '】-教学安排表'` 这个前缀」
 *    —— 前缀变了才是真破防（括号包错对象 / 漏班级名），后缀是合法扩展。
 */
function check59(block) {
  const code = stripComments(block);
  // ⚠️ 锚点**不带结尾引号**：`'【' + className + '】-教学安排表` 后面可能接
  //    `'-' + groupScope + '组'`（组别后缀），带引号就匹配不上了。
  return has(code, "'【' + className + '】-教学安排表")
    && has(code, 'cls[0].name');
}
console.log('── #59 applyTimetable 文件名 = 【班级名】-教学安排表（可带组别后缀）');
{
  const t = fs.readFileSync(COURSE_INDEX, 'utf8');
  const blk = blockOf(t, 'applyTimetable');
  if (!blk) bad('找不到 applyTimetable 路由块');
  else if (check59(blk)) ok('fileName 格式正确（括号只包班级名，名称取自 class 查询）');
  else bad('applyTimetable 文件名格式不符');
  if (blk) {
    // 变异锚点用**真实代码行**（与 course/index.js 的 fileName 赋值逐字一致），不用注释里那句。
    // ⚠️ 改文件名写法时**必须同步这里**，否则前置检查会 FAIL（这是刻意设计：宁可门禁红也别让自证锚点悄悄失配）。
    const REAL = "'【' + className + '】-教学安排表-' + groupScope + '组'";
    if (!has(stripComments(blk), REAL)) {
      bad('自证前置检查失败：没找到预期的 fileName 代码行（源码已改，自证锚点要同步）');
    } else {
      selfProof(blk, (s) => s.replace(REAL, "className + '-教学安排表'"), check59, '去掉【】括号');
      // 真正要防的错：【】把整个文件名（含组别后缀）都包进去
      selfProof(blk,
        (s) => s.replace(REAL, "'【' + className + '-教学安排表-" + "groupScope + '组】'"),
        check59, '【】 把整个文件名包住');
    }
  }
}

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 课表导入门禁 #57/#58/#59 通过');
