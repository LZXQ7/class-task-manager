#!/usr/bin/env node
/**
 * 门禁：首页「今日课次 → 课堂情况」跨天请假的连续时段口径（v1.0.8.78）
 * --------------------------------------------------------------------------------
 * 背景：v1.0.8.77 把跨天假改成连续区间（首日只卡下界、末日只卡上界、中间整天含晚上），
 *       后端 inLeaveWindow / 请假卡 markOver / 名单 inLeaveWindowFront 三处同步改了，
 *       唯独首页课堂情况 `_buildCourseInfo` 的 `overlap` 漏改 —— 仍用单日时段交集
 *       （leaveStart<=courseEnd && leaveEnd>=courseStart），导致「开始日晚8点→结束日晚8点」
 *       的跨天假在中间日 / 末日白天课 / 首日晚课不被算作请假，课堂情况里看不到这个人。
 *
 * 反馈回路：用 vm 加载**真源码**里的 _buildCourseInfo（不写副本），mock util / setData，
 * 喂跨天假 + 各日课次，断言 courseInfoAbsentees。改前此门禁必红。
 *
 * 变异自证：对真源码做定向字符串替换构造坏版本，确认相应用例翻红。
 *
 * 用法：node scripts/check-leave-courseinfo-crossday.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HOME_PATH = 'miniprogram/pages/home/index.js';
let HOME = fs.readFileSync(path.join(ROOT, HOME_PATH), 'utf8');

let bad = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => { bad += 1; console.log('  ✗ ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

/** 按花括号配对抽对象方法体（真源码，不靠缩进） */
function methodBody(src, name) {
  const re = new RegExp('\\b' + name + '\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('找不到方法 ' + name);
  const i = src.indexOf('{', m.index);
  let d = 0;
  for (let k = i; k < src.length; k += 1) {
    if (src[k] === '{') d += 1;
    else if (src[k] === '}') { d -= 1; if (!d) return src.slice(i + 1, k); }
  }
  throw new Error('方法未闭合 ' + name);
}

/** 用给定源码构造一个可调用的 build(s,roster,leaveList,today) → {patch} */
function makeBuild(src) {
  const body = methodBody(src, '_buildCourseInfo');
  const sandbox = {
    console,
    __today: '2026-11-21',
    __patch: null,
    setData(p) { sandbox.__patch = p; },
    util: {
      todayStr() { return sandbox.__today; },
      weekdayShort() { return '五'; },
      todayWeekday() { return 5; },
      md() { return '11月21日'; }
    },
    bigPeriodText() { return '上午第一大节'; }
  };
  vm.runInNewContext('function build(s, roster, leaveList){\n' + body + '\n}\nglobalThis.build = build;', sandbox);
  return (s, roster, leaveList, today) => {
    sandbox.__today = today;
    sandbox.__patch = null;
    sandbox.build(s, roster, leaveList);
    return sandbox.__patch || {};
  };
}

/* 跨天假：首日 20:00 → 末日 20:00（用户「开始日期晚上8点、结束日期晚上8点」） */
const LEAVE = {
  name: '张三', studentNo: '20260101', groupTag: 'A', reason: 'SICK',
  startDate: '2026-11-20', endDate: '2026-11-22', startTime: '20:00', endTime: '20:00', periods: []
};
const ROSTER = [{ name: '张三', groupTag: 'A', studentNo: '20260101' }];
const DAY = { groupScope: '', period: 1, name: '语文', periodTime: { start: '08:00', end: '12:00' } };
const EVE = { groupScope: '', period: 5, name: '晚自习', periodTime: { start: '18:00', end: '21:00' } };
const absent = (build, s, leave, today) => (build(s, ROSTER, [leave], today).courseInfoAbsentees || []).length > 0;

/* ── 用例表：[标签, 课次, 请假行, 今天, 是否应算请假] ── */
const CASES = [
  ['跨天-中间日白天课 ⇒ 连续区间整天含白天', DAY, LEAVE, '2026-11-21', true],
  ['跨天-中间日晚自习 ⇒ 连续区间含晚上', EVE, LEAVE, '2026-11-21', true],
  ['跨天-末日白天课 ⇒ 只卡上界20:00，白天在内', DAY, LEAVE, '2026-11-22', true],
  ['跨天-首日白天课 ⇒ 只卡下界20:00，白天不算', DAY, LEAVE, '2026-11-20', false],
  ['跨天-首日晚自习(18:00-21:00) ⇒ ∩20:00起算', EVE, LEAVE, '2026-11-20', true],
  /* 单日旧语义回归护栏（不得被跨天改动破坏） */
  ['单日-上午假(08:00-18:00)白天课 ⇒ 算', DAY,
    Object.assign({}, LEAVE, { startDate: '2026-11-21', endDate: '2026-11-21', startTime: '08:00', endTime: '18:00' }), '2026-11-21', true],
  ['单日-晚8点起假晚上课(18:00-21:00) ⇒ ∩算', EVE,
    Object.assign({}, LEAVE, { startDate: '2026-11-21', endDate: '2026-11-21', startTime: '20:00', endTime: '23:00' }), '2026-11-21', true],
  ['单日-上午假晚上课 ⇒ 不重叠不算', EVE,
    Object.assign({}, LEAVE, { startDate: '2026-11-21', endDate: '2026-11-21', startTime: '08:00', endTime: '12:00' }), '2026-11-21', false],
  /* 半边时间：跨天只填一边 ⇒ 整天假，两端不卡 */
  ['跨天-只填结束时间 ⇒ 整天假首日也算', DAY,
    Object.assign({}, LEAVE, { startTime: '' }), '2026-11-20', true],
  /* 日期守卫：假期不覆盖当天 ⇒ 不算 */
  ['跨天-假期不覆盖当天 ⇒ 不算', DAY, LEAVE, '2026-11-25', false]
];

function runCases(build, quiet) {
  let n = 0;
  CASES.forEach(([label, s, leave, today, expect]) => {
    const got = absent(build, s, leave, today);
    if (got !== expect) {
      n += 1;
      if (!quiet) fail(label + ' → got=' + got + ' expect=' + expect);
    } else if (!quiet) ok(label);
  });
  return n;
}

console.log('── ① 真源码行为：跨天连续区间 + 单日旧语义回归');
const build = makeBuild(HOME);
chk(!!methodBody(HOME, '_buildCourseInfo'), '能从 home/index.js 真源码抽出 _buildCourseInfo');
chk(/d0 !== d1/.test(methodBody(HOME, '_buildCourseInfo')), '真源码含跨天分支（d0 !== d1）');
const mainBad = runCases(build, false);
chk(mainBad === 0, '10 条行为用例全通过（失败=' + mainBad + '）');

console.log('\n── ② 变异自证（改坏真源码 → 相应用例必须翻红）');
/** 每个变异：{name, apply(src)->src, mustRed:[用例下标]} */
const MUTATIONS = [
  {
    // ⚠️ 锚点必须锚到 _buildCourseInfo 独有的 `const s = …` 行：
    //    `if (d0 && d1 && d0 !== d1)` 在 markOver 里也有一份，只匹配它会删错对象。
    name: '去掉整个跨天分支（退回单日时段交集 = 本 bug 本身）',
    apply: (s) => s.replace(/      if \(d0 && d1 && d0 !== d1\) \{\n        const s = String\(x\.startTime\)[\s\S]*?\n      \}\n/, ''),
    // 退回单日后只有「白天课」翻红；晚自习因 ∩20:00 仍在假内不变
    mustRed: [0, 2]
  },
  {
    name: '首日误卡上界（ce >= s 改成 cs <= e ⇒ 首日白天课被误算请假）',
    apply: (s) => s.replace('if (day <= d0) return ce >= s;', 'if (day <= d0) return cs <= e;'),
    // 首日白天课本不算（期望 false）；变异后 cs<=e 命中 ⇒ 翻红
    mustRed: [3]
  },
  {
    name: '末日误卡下界（cs <= e 改成 ce >= s ⇒ 末日白天课被漏）',
    apply: (s) => s.replace('if (day >= d1) return cs <= e;', 'if (day >= d1) return ce >= s;'),
    mustRed: [2]
  },
  {
    name: '中间日误按单日交集（return true 改成旧交集表达式）',
    apply: (s) => s.replace('        return true;                     // 中间整天（含晚上）连续',
      '        return s <= ce && e >= cs;'),
    // 中间日白天课翻红；中间日晚自习因 20:00 在 18:00-21:00 内仍命中，不翻红
    mustRed: [0]
  },
  {
    name: '破坏单日旧语义（交集改恒 true ⇒ 单日晚8点假算到白天课）',
    apply: (s) => s.replace('return String(x.startTime) <= ce && String(x.endTime) >= cs;', 'return true;'),
    mustRed: [7]
  }
];
let caught = 0;
MUTATIONS.forEach((m, idx) => {
  const changed = m.apply(HOME);
  if (changed === HOME) { fail('M' + (idx + 1) + ' 变异没落地（锚点失效）'); return; }
  let mb;
  try { mb = makeBuild(changed); } catch (e) { fail('M' + (idx + 1) + ' 变异源码跑不起来：' + e.message); return; }
  // 断言：mustRed 列出的用例全部翻红（说明这些用例确实锁住了正确行为）
  const allRed = m.mustRed.every((i) => {
    const [, s, leave, today, expect] = CASES[i];
    return absent(mb, s, leave, today) !== expect;
  });
  if (allRed) { ok('M' + (idx + 1) + ' 「' + m.name + '」被抓（' + m.mustRed.length + ' 条用例翻红）'); caught += 1; }
  else fail('M' + (idx + 1) + ' 「' + m.name + '」没被抓 —— 判据失效');
});
chk(caught === MUTATIONS.length, MUTATIONS.length + '/' + MUTATIONS.length + ' 条变异全部被抓');

console.log('\n' + (bad ? '✗ ' + bad + ' 项未通过' : '✓ 课堂情况跨天请假检查全部通过'));
process.exit(bad ? 1 : 0);
