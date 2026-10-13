#!/usr/bin/env node
/**
 * 离线自检：SQL 里对 duty 表别名的列引用，必须都是 duty 真实存在的列
 * ------------------------------------------------------------
 * 事故背景（2026-09-28，对外 1.0.4.4）：
 *   `duty` 云函数 myList 的 SQL 写了 `SELECT ... d.kind ...`，
 *   但 **duty 表没有 kind 列**（kind 在 session 表上）。
 *   → MySQL `1054 (42S22) Unknown column 'd.kind' in 'field list'`
 *   → handler 抛异常 → 前端 catch → 「加载失败，请重试」+ 列表空「暂无相关值日」。
 *   已用线上库实证：`SELECT d.kind FROM duty d` 必报 1054；改 `s.kind` 后返回正常。
 *
 * 为什么需要这道门禁：
 *   ① 这类错误**语法完全合法**，Node 与门禁都跑不出来，只有真连库才炸；
 *   ② duty 表与 session 表列名高度重合（week / status / class_date 都有），
 *      把 session 的列误写成 d.xxx 极易发生且不报错（若 SQL 用 d.* 展开就更隐蔽）；
 *   ③ 现状里 today / detail / schedule 三处是「SQL 选了 s.kind、代码读 d.kind」
 *      的**混读**——碰巧正确（d.* 不含 kind），一旦给 duty 加 kind 列就静默出错。
 *   所以本门禁把 duty 的列清单钉死，任何 `d.<不在清单里的列>` 一律报红。
 *
 * 判据（扫描生产源码文本）：
 *   ① 先做一次微型 tokenizer **剥掉行注释 / 块注释**，只取字符串字面量内容
 *      —— 否则源码注释里为解释事故而引用的 `d.kind` 字样会假红（本文件的注释就含它）；
 *   ② 对含 `duty` 的字符串，取 `FROM|JOIN duty <别名>` 得到别名集合（排除 SQL 关键字）；
 *   ③ 校验 `<别名>.<列>`：列 ∈ DUTY_COLUMNS 放行，`<别名>.*` 放行，其余报红。
 *
 * 双向自证：
 *   正向 —— 真实源码全过（且该源码的注释里确实含 `d.kind` 字样，顺带证明「剥注释」生效）；
 *   反向 —— 把生产源码里的 `s.kind AS sessionKind` 在**内存中**变异成
 *           `d.kind AS sessionKind`，必须被抓出且列名为 kind。
 *           （只在内存里改字符串，不写副本文件、不用 sed，避免「拿原文件当坏样本」的假通过。）
 *
 * 用法：node scripts/check-duty-columns.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }

/* ---------- duty 的真实列清单（唯一事实来源：scripts/init.sql 的 CREATE TABLE duty，
              外加 scripts/migrate-multiclass.sql 追加的 class_id）----------
   改表结构时**必须**同步这里，否则门禁会拦下正确的代码（或漏掉错误的代码）。 */
const DUTY_COLUMNS = new Set([
  'id', 'class_id', 'session_id', 'week', 'class_date',
  'member_id', 'status', 'source', 'done_at', 'created_at'
]);

/* SQL 里紧跟在 `duty` 之后、但不是别名的关键字（`FROM duty JOIN ...` 这种没别名的情况） */
const NOT_ALIAS = /^(?:AS|WHERE|JOIN|INNER|LEFT|RIGHT|ON|ORDER|GROUP|LIMIT|SET|USING|AND|OR|STRAIGHT_JOIN)$/i;

/**
 * 微型 tokenizer：从源码里取出**字符串字面量内容**，注释一律跳过。
 * 支持 ' " ` 三种引号与反斜杠转义；字符串内部不解析注释（所以 'https://x' 不会被误剥）。
 */
function extractStrings(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {                 // 行注释
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && c2 === '*') {          // 块注释
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      let buf = '';
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') { buf += src[j + 1] || ''; j += 2; continue; }
        if (ch === quote) break;
        buf += ch;
        j++;
      }
      out.push({ text: buf, index: i });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

/** 源码偏移 → 行号（1 起） */
function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

/**
 * 核心判据（第 1 层）：扫**一条 SQL 文本**，返回 { violations, checked }。
 * checked = 实际校验过的 `<别名>.<列>` 个数 —— 自证时用它防「样本根本没被分析」的假通过。
 * locator(offsetInSql) → 行号（源码扫描时由第 2 层提供；裸 SQL 样本传 null）。
 */
function scanSql(sql, label, locator) {
  const violations = [];
  const seen = new Set();
  let checked = 0;
  if (!/\bduty\b/i.test(sql)) return { violations, checked };

  const aliases = new Set();
  const reAlias = /\b(?:FROM|JOIN)\s+duty\s+(?:AS\s+)?([A-Za-z_]\w*)/gi;
  let m;
  while ((m = reAlias.exec(sql))) {
    if (!NOT_ALIAS.test(m[1])) aliases.add(m[1]);
  }

  for (const a of aliases) {
    const reCol = new RegExp('\\b' + a + '\\.([A-Za-z_]\\w*)', 'g');
    let cm;
    while ((cm = reCol.exec(sql))) {
      const col = cm[1];
      if (col === '*') continue;                       // `d.*` 放行
      checked += 1;
      if (DUTY_COLUMNS.has(col)) continue;
      const line = locator ? locator(cm.index) : null;
      const key = label + ':' + line + ':' + a + '.' + col;
      if (seen.has(key)) continue;                     // 同处多写不重复报
      seen.add(key);
      violations.push({ label, line, alias: a, col, snip: sql.replace(/\s+/g, ' ').trim().slice(0, 110) });
    }
  }
  return { violations, checked };
}

/**
 * 核心判据（第 2 层）：扫一段**源码** —— 先剥注释取字符串字面量，再逐条走 scanSql。
 * 纯函数（不读文件、不写盘），所以自证可以直接把变异后的源码喂进来。
 */
function scanSource(src, label) {
  let violations = [];
  let checked = 0;
  for (const s of extractStrings(src)) {
    const r = scanSql(s.text, label, (off) => lineOf(src, s.index + 1 + off));
    violations = violations.concat(r.violations);
    checked += r.checked;
  }
  return { violations, checked };
}

/** 收集 cloudfunctions 下的全部 .js（跳过 node_modules） */
function collectJs(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      collectJs(path.join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.js')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/* ---------- ① 正向：真实源码必须零违规 ---------- */
console.log('── ① 扫描 cloudfunctions 全部源码：duty 别名不得引用不存在的列');
const files = collectJs(path.join(ROOT, 'cloudfunctions'), []).sort();
console.log('     文件数：' + files.length);

const allViolations = [];
let totalChecked = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const src = fs.readFileSync(f, 'utf8');
  const r = scanSource(src, rel);
  totalChecked += r.checked;
  for (const v of r.violations) allViolations.push(v);
}
if (!allViolations.length) {
  ok('全部 ' + files.length + ' 个云函数文件：duty 别名的列引用均为真实列');
} else {
  for (const v of allViolations) {
    bad(v.label + ':' + v.line + '  `' + v.alias + '.' + v.col + '` 不是 duty 的列（duty 列：' +
      [...DUTY_COLUMNS].join('/') + '）\n        ' + v.snip);
  }
}
// 防「空转假通过」：判据必须真的分析到了列引用
if (totalChecked > 0) ok('实际校验 ' + totalChecked + ' 处 `<别名>.<列>` 引用（判据确实在分析，非空转）');
else bad('一处 duty 列引用都没校验到 —— 判据疑似失效');

/* ---------- ② 正向（剥注释自证）：注释里的 d.kind 字样不得被命中 ---------- */
console.log('\n── ② 剥注释自证：注释中的 d.kind 字样不算违规');
const dutySrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/duty/index.js'), 'utf8');
const commentMentions = (dutySrc.match(/d\.kind/g) || []).length;
if (commentMentions > 0) {
  const r2 = scanSource(dutySrc, 'in-memory');
  if (!r2.violations.length) ok('duty/index.js 注释含 ' + commentMentions + ' 处 `d.kind` 字样，扫描仍 0 违规（剥注释生效）');
  else bad('注释里的 `d.kind` 被当成了违规（剥注释失效）：' + JSON.stringify(r2.violations[0]));
} else {
  bad('duty/index.js 里找不到 `d.kind` 注释锚点——事故说明注释被删了？本项自证失效，请复查');
}

/* ---------- ③ 反向：内存变异为 d.kind 必须被抓 ---------- */
console.log('\n── ③ 反向自证：把生产源码的 `s.kind AS sessionKind` 变异成 `d.kind AS sessionKind`');
const NEEDLE = 's.kind AS sessionKind';
// 只数「字符串里的」锚点：注释里为说明事故也写了同一串，若把它算进来，断言语义会被注释带偏
const codeText = extractStrings(dutySrc).map((s) => s.text).join('\n');
const hits = codeText.split(NEEDLE).length - 1;
if (hits === 0) {
  bad('源码里找不到变异锚点 `' + NEEDLE + '`（判据已失效，必须复查门禁本身）');
} else {
  const mutated = dutySrc.split(NEEDLE).join('d.kind AS sessionKind');
  const r3 = scanSource(mutated, 'mutated');
  const kinds = r3.violations.filter((v) => v.col === 'kind');
  if (kinds.length >= hits) {
    ok('变异 ' + hits + ' 处（仅代码处） → 抓出 ' + kinds.length + ' 处 `d.kind` 违规（如 行' + kinds[0].line + '）');
  } else {
    bad('变异 ' + hits + ' 处，却只抓出 ' + kinds.length + ' 处 —— 判据漏检');
  }
}

/* ---------- ④ 反向：d.* 与合法列不得误报 ---------- */
console.log('\n── ④ 反向自证：`d.*` 与合法列不误报');
const goodSql = 'SELECT d.*, d.id, d.class_date, s.kind FROM duty d JOIN session s ON s.id = d.session_id';
const r4 = scanSql(goodSql, 'good-sample', null);
if (!r4.violations.length && r4.checked > 0) ok('`d.*` / `d.id` / `d.class_date` 放行（实校 ' + r4.checked + ' 处，0 违规）');
else bad('好样本结果异常：violations=' + JSON.stringify(r4.violations) + ' checked=' + r4.checked);
const badSql = 'SELECT d.doneAt FROM duty d';
const r5 = scanSql(badSql, 'bad-sample', null);
if (r5.violations.length === 1 && r5.violations[0].col === 'doneAt') ok('坏样本 `d.doneAt`（驼峰误写）被抓出');
else bad('坏样本未被抓出或抓错：' + JSON.stringify(r5));

/* ---------- 汇总 ---------- */
console.log('');
if (failed) {
  console.log('✗ check-duty-columns 失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('✓ check-duty-columns 全部通过');
