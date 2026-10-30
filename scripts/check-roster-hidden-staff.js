/**
 * check-roster-hidden-staff.js ——「成员与分组不显示教职工 + 已绑定口径」门禁（#53，2026-10-04）
 *
 * 需求背景（用户 2026-10-04 报）：
 *   ② 名册概览的「已绑定」不得把**辅导员（教职工）**算进去；
 *   ③ 教职工的账号与绑定情况**只在「班级管理 → 教职工管理」**里维护，成员与分组不显示。
 *
 * 2026-10-08 修订：② 原本还要求「排除 test（测试账号）」，现拆成两条独立的规则 ——
 *   「不显示测试账号」已由 **member.list 服务端无条件过滤**承担（见 check-test-account-hidden.js），
 *   前端再判一次是死代码，且会让下一个人以为「前端兜住就行」而去改后端。
 *   所以本门禁 ② 只管 X；测试账号那一半改由 check-test-account-hidden.js 单独守。
 *
 * 守四条（缺一条就是静默回归）：
 *   ① roster 页 `_loadMembers` 的名单必须过滤掉 `groupTag === 'X'`（教职工不进成员列表）；
 *   ② roster 页 `boundCount` 必须排除 `X`（口径同 ①）——**不要求**排除 test，理由见上；
 *   ③ **反向**：后端 `member.list` 的 `public:'manage'` 分支**不得**加 `group_tag <> 'X'`
 *      —— 「切换测试账号」要靠它取到**测试辅导员**视角（mine → member.testAccountList，
 *      2026-10-08 起走独立 action，但后端 manage 仍不过滤 X 保持单一入口的调试能力）。
 *   ④ 相对面：值日页选人与首页通知选人各自保留自己的 X 过滤（不在本次改动范围内，防被顺手删）。
 *
 * 含变异自证：对源码做坏样本变异，断言必须翻转成失败，否则该判据是「假通过」。
 * 变异只在内存字符串上做，不落盘、不碰真文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const assertTrue = (cond, msg) => { if (cond) ok(msg); else bad(msg); };

const rosterJs = read('miniprogram/pages/roster/index.js');
const memberJs = read('cloudfunctions/member/index.js');
const dutyJs = read('miniprogram/pages/duty/index.js');
const homeJs = read('miniprogram/pages/home/index.js');

/** 取 `_loadMembers() {` 定义体（到下一个顶层方法定义 `\n  xxx(` 为止）
 *  ⚠️ 锚点必须带 ` {` —— 文件里 `_loadMembers()` 的**调用点**出现在它前面十几个位置。 */
function rosterLoadBlock(src) {
  const i = src.indexOf('_loadMembers() {');
  if (i < 0) return '';
  const rest = src.slice(i + 1);
  const m = /\n  [A-Za-z_$][\w$]*\(/.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}
/** 取 member.list 里 `public === 'manage'` 分支体（到第三个分支 `guard.requireBind` 为止） */
function manageBlock(src) {
  const i = src.indexOf("payload.public === 'manage'");
  if (i < 0) return '';
  const j = src.indexOf('guard.requireBind(ctx);', i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

/* ---- ① roster 名单过滤 X ---- */
const loadBlock = rosterLoadBlock(rosterJs);
assertTrue(
  /\.filter\(x => x\.groupTag !== 'X'\)\.map\(x =>/.test(loadBlock) ||
    /\.filter\(x => x\.groupTag !== 'X'\)/.test(loadBlock),
  'roster._loadMembers 过滤掉教职工（groupTag !== \'X\'）—— 成员与分组不显示辅导员'
);

/* ---- ② boundCount 口径（只管 X；test 由服务端 member.list 一律过滤，见文件头修订说明）----
 * ⚠️ 正则允许赋值号后有前缀：2026-10-28 起该行是三元表达式
 *    `patch.boundCount = this.data.canManage ? rows.filter(...).length : null`
 *    （普通成员走只读接口，后端不回 bound，算出来必然是 0 ⇒ 假红字，必须给 null）。
 *    判据仍然是「rows.filter 里同时有 bound 与 groupTag !== 'X'」，只是不再要求紧跟 `=`。 */
const BOUND_COUNT_RE = /patch\.boundCount\s*=[^\n]*rows\.filter\(x => x\.bound && x\.groupTag !== 'X'\)\.length/;
assertTrue(
  BOUND_COUNT_RE.test(rosterJs),
  'roster.boundCount 排除辅导员(X)：已绑定口径与「总人数」一致'
);

/* ---- ③ 反向：后端 manage 分支不得一刀切掉 X（否则切换测试辅导员失效） ---- */
/** 去掉 JS 注释（行注释 + 块注释）等长替换，保住行号与列位 ——
 *  判据扫的是**代码**不是注释：注释里写「原式还带 if (!isSuperNow)」就会让
 *  「禁止再出现该变量」的断言永远失败（2026-10-08 实测踩过）。 */
function stripComments(src) {
  const out = src.split('');
  let i = 0, q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i += 2; continue; }
      if (c === q) q = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') out[i++] = ' '; continue; }
    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] !== '\n') out[i] = ' '; i++; }
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

const mgBlock = manageBlock(memberJs);
const mgCode = stripComments(mgBlock);
assertTrue(mgBlock.length > 0, '能定位 member.list 的 manage 分支体');
assertTrue(
  !/group_tag\s*(<>|!=)\s*'X'/.test(mgCode),
  'member.list manage 分支**未**加 group_tag <>\'X\'（manage 是通用名册入口，前端按身份自行滤 X）'
);
// 反向补一条：manage 分支**必须**过滤测试账号（2026-10-08 铁律），且**不能**再按身份开口子
assertTrue(
  /NOT_TEST\(\)/.test(mgCode) && !/\bisSuperNow\b/.test(mgCode),
  'member.list manage 分支**无条件**过滤测试账号（无「仅非超管」开口子）'
);

/* ---- ④ 相对面：duty / home 通知选人各自保留 X 过滤 ---- */
assertTrue(
  /groupTag !== 'X'/.test(dutyJs),
  '值日页选人仍保留 groupTag !== \'X\'（辅导员不参与值日）'
);
// ⚠️ 2026-10-27 归位：通知「指定成员」选人随发布表单搬到 pages/notice/publish
const pbJs = read('miniprogram/pages/notice/publish/index.js');
assertTrue(
  /\.filter\(x => x\.groupTag !== 'X'\)/.test(pbJs),
  '通知「指定成员」选人仍过滤 groupTag !== \'X\'（发布页 pages/notice/publish）'
);

/* ============================ 变异自证 ============================ */
function proveNotVacuous(label, src, mutate, predicate) {
  const mutated = mutate(src);
  const before = predicate(src);
  const after = predicate(mutated);
  if (before && !after) ok('自证：' + label + ' 坏样本会被抓（判据非假通过）');
  else bad('自证：' + label + ' 变异后断言未翻转（before=' + before + ' after=' + after + '），判据可能失效');
}

// ① 删掉 roster 的 X 过滤 → 断言必须翻转
proveNotVacuous(
  '删掉成员列表的 X 过滤',
  rosterLoadBlock(rosterJs),
  (s) => s.replace(".filter(x => x.groupTag !== 'X')", ''),
  (s) => /\.filter\(x => x\.groupTag !== 'X'\)/.test(s)
);

// ② 把 boundCount 改回「不排除 X」 → 断言必须翻转
proveNotVacuous(
  '把已绑定口径改回只数 bound',
  rosterJs,
  (s) => s.replace(
    "rows.filter(x => x.bound && x.groupTag !== 'X').length",
    'rows.filter(x => x.bound).length'
  ),
  (s) => BOUND_COUNT_RE.test(s)
);

// ③ 给后端 manage 分支塞进 group_tag <> 'X' → 反向断言必须翻转
proveNotVacuous(
  '给 manage 分支加 group_tag <> X',
  mgBlock,
  (s) => s.replace('let sql =', "let sql0 = ''; // group_tag <> 'X'\n        let sql ="),
  (s) => !/group_tag\s*(<>|!=)\s*'X'/.test(s)
);

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
} else {
  console.log('✅ 成员与分组·教职工隔离门禁全部通过');
}
