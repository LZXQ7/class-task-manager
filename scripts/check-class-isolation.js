#!/usr/bin/env node
/**
 * 第 51 个门禁：课表数据的**跨班隔离**
 * ============================================================
 * 起因（2026-09-29，用户反馈「其他班级的首页课次也没做隔离，显示的是 示例班级A 的」）：
 *   `course` / `session` 在 `scripts/migrate-multiclass.sql` 里都加了 `class_id`，
 *   于是每个班各有自己的课表 —— **「列出一批课次」的查询一律要按 `class_id` 过滤**。
 *   而 `duty.today` 取「今日/明日课次」的那条 SQL **漏了这个条件** ⇒ 它把**所有班**的
 *   session 混在一起返回（当时只有 示例班级A 有课 → 人人看到 示例班级A 的课表）。
 *   ⚠️ 这种漏条件**不报错、不抛异常**，只是「静默把别班的数据端出来」，
 *      首页还照样「有内容」，肉眼极难发现是错的 —— 必须静态拦住。
 *
 * 判据（点名式）：
 *   ① 扫 `cloudfunctions/<fn>/index.js` 里所有**字符串字面量**（先剥注释）。
 *      凡字面量里出现 `FROM|JOIN session` 或 `FROM|JOIN session_shift`，
 *      必须满足**其一**：
 *        · 带 `class_id`（按班过滤），或
 *        · 已被**行级条件**限定（`xxx_id = ?` / `id IN (...)` / `from_member = ?` …）——
 *          这类查询只取「某一行 / 某个人的行」，天然不可能跨班灌一批数据；
 *        · 或在 EXEMPT 里**逐条点名登记**（如 cron 群发提醒，本就该跨班）。
 *      否则判死并打印文件 + SQL 片段。
 *   ② 豁免必须**点名**：EXEMPT 是精确片段匹配，新增例外得显式写进来（含原因）。
 *   ③ 防空转：必须真的扫到字面量、也真的扫到 session 查询。
 *   ④ 双向自证：带 class_id 放行 / 行级限定放行 / 漏过滤判死 / 注释里的坏样本不算数。
 *   ⑤ 变异自证：删掉 duty.today 那条查询的 `s.class_id = ? AND ` → 必须判死。
 *
 * ⚠️ 只扫各函数入口 `index.js`，不扫 `common/`：`common/week.js` 的 `loadSessionShifts(pool, classId)`
 *    是**按入参拼 SQL**（条件式追加 class_id），字面量里当然没有 —— 扫它只会假阳性。
 *
 * 退出码 0 = 过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN_DIR = path.join(ROOT, 'cloudfunctions');
const read = (p) => fs.readFileSync(p, 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

/**
 * 例外清单（**逐条点名**，片段匹配、忽略空白差异）。
 * 这些是「本来就该跨班」或「按外键精确取行」的查询，不构成跨班列表泄漏。
 */
const EXEMPT = [
  // cron-weekly：值日提醒是**群发**，按日期取当天所有班的值日 —— 跨班是需求本身
  'WHERE d.class_date = ? AND d.status IN ('
];

/**
 * 行级限定：`xxx_id = ?` / `id = ${x}` / `id IN (...)` 这类**只取某行 / 某个人的行**的条件。
 * 有它就不可能出现「把别班的整批数据端出来」。
 * ⚠️ 必须要求「右侧是**绑定值**（? / ${…}）或 IN 列表」：
 *    · 写成 `id =`（宽松版）会被 **JOIN 的 `ON c.id = s.course_id`** 骗过 ——
 *      那句是连接条件、不是过滤，实测导致变异自证失效（本门禁第一次就是栽在这）；
 *    · SELECT 列表里的 `s.id, s.day_of_week` 也必须不算数（那正是要抓的那个 bug 的写法）。
 */
const ROW_SCOPED = /(?:\b\w+\.)?\b(?:id|session_id|duty_id|member_id|course_id|from_member|to_member|staff_id|notice_id|swap_id)\s*(?:=\s*(?:\?|\$\{)|\sIN\s*\()/i;

/** 从源码里取出所有字符串字面量（先剥 // 与 注释；支持 ' " ` 与转义） */
function literalsOf(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let buf = '';
      while (j < n) {
        if (src[j] === '\\') { buf += src[j] + src[j + 1]; j += 2; continue; }
        if (src[j] === c) break;
        buf += src[j];
        j++;
      }
      out.push(buf);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const isSessionSql = (lit) => /\b(?:FROM|JOIN)\s+(?:session|session_shift)\b/i.test(lit);

/** 判定单个字面量是否为「列课次却没按班过滤」 */
function isLeaky(lit) {
  if (!isSessionSql(lit)) return false;
  if (/class_id/i.test(lit)) return false;
  if (ROW_SCOPED.test(lit)) return false;
  const n = norm(lit);
  return !EXEMPT.some(e => n.indexOf(norm(e)) >= 0);
}

/** 扫一段源码，返回泄漏片段 */
function scanSrc(src) {
  return literalsOf(src).filter(isLeaky).map(s => norm(s).slice(0, 90));
}

/* ---------------- ① 真实扫描 ---------------- */
console.log('── ① 各云函数入口：列课次的查询必须按 class_id（或行级条件）限定');
const files = fs.readdirSync(FN_DIR)
  .filter(d => fs.existsSync(path.join(FN_DIR, d, 'index.js')))
  .map(d => ({ name: d, p: path.join(FN_DIR, d, 'index.js') }));

let litCount = 0;
let sessCount = 0;
let leaks = 0;
files.forEach(f => {
  const src = read(f.p);
  const ls = literalsOf(src);
  litCount += ls.length;
  sessCount += ls.filter(isSessionSql).length;
  scanSrc(src).forEach(b => {
    fail('cloudfunctions/' + f.name + '/index.js 列课次没按班过滤：' + b);
    leaks++;
  });
});
if (!litCount) fail('防空转：一个字符串字面量都没扫到（提取器坏了）');
else ok('扫描 ' + files.length + ' 个函数入口，共 ' + litCount + ' 个字面量');
if (!sessCount) fail('防空转：没扫到任何 session / session_shift 查询（判据可能已失效）');
else if (!leaks) ok('全部 ' + sessCount + ' 处课次查询都按 class_id 或行级条件限定（点名豁免 ' + EXEMPT.length + ' 条）');

/* ---------------- ② 首页那条必须显式按班（本次事故点） ---------------- */
console.log('\n── ② duty.today：今日/明日课次与调课都必须取本班');
const dutySrc = read(path.join(FN_DIR, 'duty', 'index.js'));
if (/WHERE s\.class_id = \? AND s\.kind <> 'CLEAN'/.test(dutySrc)) ok('duty.today 列课次的 SQL 带了 s.class_id = ?');
else fail('duty.today 列课次的 SQL 没带 s.class_id = ?（会串班）');
if (/week\.loadSessionShifts\(pool,\s*classId\)/.test(dutySrc)) ok('duty.today 调 loadSessionShifts 时传了 classId');
else fail('duty.today 调 loadSessionShifts 没传 classId（会把别班的调课读进来）');

/* ---------------- ③ 双向自证 ---------------- */
console.log('\n── ③ 双向自证');
const good = "const q = `SELECT s.id FROM session s WHERE s.class_id = ? AND s.kind <> 'CLEAN'`;";
const rowScoped = "const q = `SELECT d.*, s.period FROM duty d JOIN session s ON s.id = d.session_id WHERE d.member_id = ?`;";
const badSample = "const q = `SELECT s.id, s.day_of_week FROM session s WHERE s.kind <> 'CLEAN' ORDER BY s.day_of_week`;";
const commentSample = "/* const q = `SELECT s.id FROM session s WHERE s.kind <> 'CLEAN'`; */\nconst y = 1;";
if (scanSrc(good).length === 0) ok('自证：带 class_id 的样本放行');
else fail('自证失败：好样本被误报 ' + JSON.stringify(scanSrc(good)));
if (scanSrc(rowScoped).length === 0) ok('自证：行级限定（member_id = ?）的样本放行');
else fail('自证失败：行级限定样本被误报 ' + JSON.stringify(scanSrc(rowScoped)));
if (scanSrc(badSample).length === 1) ok('自证：漏过滤的样本判死（SELECT 列表里的 s.id 不算限定）');
else fail('自证失败：坏样本没被识别');
if (scanSrc(commentSample).length === 0) ok('自证：注释里的坏样本不算数（已剥注释）');
else fail('自证失败：注释里的坏样本被误判');

/* ---------------- ④ 变异自证 ---------------- */
console.log('\n── ④ 变异自证：删掉 duty 那条查询的 class_id → 必须判死');
const mutated = dutySrc.replace("WHERE s.class_id = ? AND s.kind <> 'CLEAN'", "WHERE s.kind <> 'CLEAN'");
if (mutated === dutySrc) fail('变异没生效（锚点失配）→ 自证无效');
else {
  const hit = scanSrc(mutated);
  if (hit.length) ok('变异被抓：' + hit[0]);
  else fail('变异未被抓住（判据被削弱）');
}

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 课表跨班隔离体检通过');
