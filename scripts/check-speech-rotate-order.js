#!/usr/bin/env node
/**
 * 门禁：课前演讲名单的组内顺序 = 轮转出场序（speech.id），不是学号序
 * ================================================================
 * 用户口径（2026-11-28 截图）：同一场「示例成员02 2 / 示例成员56 56」，
 *   「先是 56，完了才是 2 号，56 在前面」——即游标走到 56 后回绕到 2，
 *   出场序 = 56 → 2。AUTO 行按 plan.rows 顺序 INSERT，id 递增即出场序；
 *   两处 SQL 旧写法 ORDER BY ..., m.student_no 把它翻成 2 → 56（用户实锤）。
 *
 * 反馈回路：
 *   ① 症状回放：用真排序函数对同一组 rows 分别按学号 / 按 id 排，断言前者复现错误序、后者给出正确序；
 *   ② 接线层：speechList 与 loadSpeechSessions 两处 SQL 的 ORDER BY 必须都按 sp.id，
 *      且 ORDER BY 里不得再出现 m.student_no（否则学号排在前仍会翻序）；
 *   ③ 变异自证：任一处改回学号排序 / 只改一处 / 加回 student_no，判据必须翻红。
 *
 * 用法：node scripts/check-speech-rotate-order.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js');
const SRC = fs.readFileSync(FILE, 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/* ① 症状回放：同一场两人，id 序 56→2，学号序 2→56 */
const ROWS = [
  { id: 101, name: '示例成员56', studentNo: '56' },
  { id: 102, name: '示例成员02', studentNo: '2' }
];
const byNo = ROWS.slice().sort((a, b) => Number(a.studentNo) - Number(b.studentNo)).map(r => r.studentNo);
const byId = ROWS.slice().sort((a, b) => a.id - b.id).map(r => r.studentNo);
check(byNo.join(',') === '2,56', '症状回放：按学号排复现错误序 2→56（用户的截图）');
check(byId.join(',') === '56,2', '症状回放：按 speech.id 排得到正确出场序 56→2');

/* ② 接线层：核对两处 SQL 的 ORDER BY 子句 */
function orderClauses(src) {
  const out = [];
  const re = /ORDER BY sp\.class_date, sp\.slot, ([^\n`]+)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1].trim());
  return out;
}

function judge(src) {
  const clauses = orderClauses(src);
  // speechList 与 loadSpeechSessions 各一处；两处都必须按 sp.id 收尾
  const bothId = clauses.length === 2 && clauses.every(c => /^sp\.id\b/.test(c));
  const noStudentNo = clauses.every(c => !/student_no/.test(c));
  return { bothId, noStudentNo, clauses };
}

console.log('── ① 症状回放 + 两处 SQL 接线');
const r = judge(SRC);
check(r.clauses.length === 2, `找到两处演讲排序 SQL（实际 ${r.clauses.length} 处）`);
check(r.bothId, 'speechList 与 loadSpeechSessions 的 ORDER BY 都以 sp.id 收尾（轮转出场序）');
check(r.noStudentNo, 'ORDER BY 里不再出现 m.student_no（否则学号序会盖掉出场序）');
if (!r.bothId || !r.noStudentNo) console.log('     当前 ORDER BY: ' + JSON.stringify(r.clauses));

/* ③ 变异自证：把正确实现改回旧写法，judge 必须翻红 */
console.log('── ② 变异自证（内存替换，绝不写盘）');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
/* 从当前源码构造「正确态」基线：无论当前是红（student_no）还是绿（sp.id），
   GOOD 恒为 sp.id，变异自证才不会因基线本身是坏的而误判。 */
const GOOD = SRC.replace(/ORDER BY sp\.class_date, sp\.slot, m\.student_no/g, 'ORDER BY sp.class_date, sp.slot, sp.id');
const mutants = [
  {
    name: 'speechList 一处改回学号排序',
    src: (() => {
      const i = GOOD.indexOf('ORDER BY sp.class_date, sp.slot, sp.id');
      if (i < 0) return null;
      return GOOD.slice(0, i) + 'ORDER BY sp.class_date, sp.slot, m.student_no' + GOOD.slice(i + 'ORDER BY sp.class_date, sp.slot, sp.id'.length);
    })()
  },
  {
    name: 'loadSpeechSessions 一处改回学号排序',
    src: (() => {
      const needle = 'ORDER BY sp.class_date, sp.slot, sp.id';
      const i = GOOD.lastIndexOf(needle);
      if (i < 0) return null;
      return GOOD.slice(0, i) + 'ORDER BY sp.class_date, sp.slot, m.student_no' + GOOD.slice(i + needle.length);
    })()
  },
  {
    name: '两处都改回学号排序',
    src: mutate(GOOD, 'ORDER BY sp.class_date, sp.slot, sp.id', 'ORDER BY sp.class_date, sp.slot, m.student_no')
  },
  {
    name: '保留 sp.id 但追加 student_no 作为次级排序',
    src: mutate(GOOD, 'ORDER BY sp.class_date, sp.slot, sp.id', 'ORDER BY sp.class_date, sp.slot, sp.id, m.student_no')
  }
];
mutants.forEach(m => {
  if (!m.src) { bad(`变异被抓：${m.name}（样本构造失败）`); return; }
  const j = judge(m.src);
  // 构造成功后 GOOD 本身必须绿，否则变异自证没有意义
  const goodJ = judge(GOOD);
  const goodGreen = goodJ.bothId && goodJ.noStudentNo;
  const red = !(j.bothId && j.noStudentNo);
  check(goodGreen && red, `变异被抓：${m.name}`);
});

console.log(failed ? `\nFAIL · ${failed} 项` : '\nOK · 演讲名单按轮转出场序门禁全部通过');
process.exitCode = failed ? 1 : 0;
