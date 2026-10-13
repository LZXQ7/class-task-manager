#!/usr/bin/env node
/**
 * 离线自检：`weeks` 字段的「未指定 / 非法值」语义（2026-10-07 线上事故）
 * ------------------------------------------------------------
 *   node scripts/check-weeks-semantics.js
 *
 * 【事故现象】用户报「第 4 周周四第 2 节明明是 3 号楼 303，首页和值日页却多出一节
 * 一区 212 的课」。查库发现 `session` 表里有 8 行用 `weeks='99'` 标记为「隐藏」的
 * A 组课次，其中 id=70 正好是周四第 2 节 —— 它在每一周都冒出来了。
 *
 * 【真根因】`common/week.js` 的 `parseWeeks` 把 `1..53` 之外的值 filter 掉：
 *
 *     parseWeeks('99')            → []        // 99 超出 1..53 被丢掉
 *     matchesWeeks('99', 4, 'ALL') → 走 `if (!arr.length)` 分支
 *                                  → matchesWeekRule('ALL', 4) → true
 *
 *   即 `weeks='99'` 的语义是「**每一周都上**」，与「隐藏」的意图**正好相反**。
 *
 * 【修法】把「未指定」与「指定了但全非法」拆成两个概念：
 *   · `weeks` 为 null/undefined/空串/纯空白 ⇒ **每周都上**（存量课大量依赖，不许改）
 *   · `weeks` 非空但一个合法周次都没有（如 '99'）⇒ **哪一周都不上**
 *
 * 本门禁做三件事：
 *   A. 源码结构判据（剥注释后匹配）—— 钉死「空数组不得回落成每周都上」。
 *   B. 行为仿真：直接 require 真模块跑用例 + 与端上 `data/timetable.js` 逐项对拍。
 *   C. 变异自证：把真源码在**内存副本**上改坏，判据必须变红（源码原样则不得误报）。
 *
 * ⚠️ 变异全在内存副本上做（`loadModule(mutatedSrc)`），自证函数里禁止 fs.writeFileSync
 *    —— 早先曾把变异写进真源码再还原，导致每次跑都改源码 / 被 SIGTERM 留脏文件，
 *    出现「同一份代码时绿时不绿」的假失败。
 * ⚠️ 变异锚点一律用**真实代码行**，并加「锚点找不到 ⇒ 直接判 FAIL」的前置检查
 *    —— 锚点静默匹配失败会让变异没生效，自证变成「拿好样本当坏样本」⇒ 假通过。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const WEEK_PATH = path.join(ROOT, 'cloudfunctions/common/week.js');
const COURSE_PATH = path.join(ROOT, 'cloudfunctions/course/index.js');
const WEEK_SRC = fs.readFileSync(WEEK_PATH, 'utf8');
const COURSE_SRC = fs.readFileSync(COURSE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

/** 把注释替换成等长空白（保留换行），避免判据命中注释里的同种字面量 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, ' '));
}

/** 取 `function name(` 的完整源码（含签名），按花括号配对 */
function extractFn(src, name) {
  const head = src.indexOf('function ' + name + '(');
  if (head < 0) return '';
  const i = src.indexOf('{', head);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(head, j + 1); }
  }
  return '';
}

/** 在内存里编译一个 week.js 副本（不落盘），用于变异自证 */
function loadModule(src, filename) {
  const m = new Module(filename, null);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(src, filename);
  return m.exports;
}

const CODE = stripComments(WEEK_SRC);

/* ============================================================
 * A. 源码结构判据
 * ============================================================ */
console.log('【A】源码结构判据（cloudfunctions/common/week.js）');

const F_BLANK = stripComments(extractFn(CODE, 'isWeeksBlank'));
const F_PARSE = stripComments(extractFn(CODE, 'parseWeeks'));
const F_MATCH = stripComments(extractFn(CODE, 'matchesWeeks'));

// A0 前置：三个函数都必须抽得到（抽不到说明源码结构变了，判据全部失效）
check('A0 三个函数都能从源码抽到（isWeeksBlank / parseWeeks / matchesWeeks）',
  !!F_BLANK && !!F_PARSE && !!F_MATCH,
  { blank: F_BLANK.length, parse: F_PARSE.length, match: F_MATCH.length });

// A1 matchesWeeks 必须先问 isWeeksBlank（而不是靠 arr.length 间接判空）
check('A1 matchesWeeks 先判 isWeeksBlank(weeks)，不靠 arr.length 间接判空',
  /if\s*\(\s*isWeeksBlank\(weeks\)\s*\)/.test(F_MATCH), F_MATCH);

// A2 🔴 核心：arr 为空时必须 `return false`，绝不能回落成 matchesWeekRule
//    （count 只算代码里真实出现的 matchesWeekRule 调用，注释已被剥掉）
const ruleCalls = (F_MATCH.match(/matchesWeekRule\s*\(/g) || []).length;
check('A2 matchesWeeks 里 matchesWeekRule 只出现 1 次（只在 isWeeksBlank 分支）',
  ruleCalls === 1, { ruleCalls, body: F_MATCH });
check('A2b matchesWeeks 的 `if (!arr.length)` 分支必须 `return false`',
  /if\s*\(\s*!\s*arr\.length\s*\)\s*return false;/.test(F_MATCH), F_MATCH);

// A3 parseWeeks 的空值判断收敛到 isWeeksBlank（避免两处各写一套、空串语义漂移）
check('A3 parseWeeks 用 isWeeksBlank 判空（不自己再写一遍 `weeks === \'\'`）',
  /if\s*\(\s*isWeeksBlank\(weeks\)\s*\)\s*return \[\];/.test(F_PARSE)
  && !/weeks\s*===\s*''/.test(F_PARSE), F_PARSE);

// A4 isWeeksBlank 必须 trim（否则 '   ' 这种纯空白会掉进「全非法 ⇒ 不上」）
check('A4 isWeeksBlank 用 trim() 判纯空白',
  /\.trim\(\)\s*===\s*''/.test(F_BLANK), F_BLANK);

// A5 isWeeksBlank 必须已导出（course/index.js 的 moveSessionSlots 要用）
check('A5 isWeeksBlank 已导出到 module.exports',
  /module\.exports\s*=\s*\{[\s\S]*?\bisWeeksBlank\b/.test(CODE));

// A6 course/index.js 的「重算周次」分支也必须区分空/非法
const MOVE_FN = stripComments(extractFn(stripComments(COURSE_SRC).replace(
  /async function extractNothing\(\)\{\}/, ''), 'moveSessionSlots').replace(
    /async function /, 'function '));
check('A6 course/index.js moveSessionSlots 用 isWeeksBlank 分流（非法值不铺满学期）',
  /week\.isWeeksBlank\(s\.weeks\)/.test(MOVE_FN)
  && !/if\s*\(\s*arr\.length\s*\)/.test(MOVE_FN), MOVE_FN);

/* ============================================================
 * B. 行为仿真：直接跑真模块
 * ============================================================ */
console.log('\n【B】行为仿真（require 真模块）');

const week = loadModule(WEEK_SRC, WEEK_PATH);

// 事故原始用例：weeks='99' 在第 4 周必须「不上」
check("B1 事故用例 matchesWeeks('99', 4, 'ALL') === false（第 4 周那节多余的课消失）",
  week.matchesWeeks('99', 4, 'ALL') === false, week.matchesWeeks('99', 4, 'ALL'));
check("B1b matchesWeeks('99', 1..18) 全为 false（'99' 是隐藏标记，不是「每周都上」）",
  Array.from({ length: 18 }, (_, i) => i + 1).every(w => week.matchesWeeks('99', w, 'ALL') === false));
check("B1c matchesWeeks('99', 4, 'ODD'/'EVEN') 也是 false（非法值优先于 week_rule）",
  week.matchesWeeks('99', 4, 'ODD') === false && week.matchesWeeks('99', 3, 'EVEN') === false);

// 「未指定」语义必须原封不动（存量课大量依赖）
check("B2 matchesWeeks('', 4, 'ALL') === true（空串仍是每周都上）",
  week.matchesWeeks('', 4, 'ALL') === true);
check('B2b matchesWeeks(null / undefined) === true（未指定仍是每周都上）',
  week.matchesWeeks(null, 4, 'ALL') === true && week.matchesWeeks(undefined, 4, 'ALL') === true);
check("B2c matchesWeeks('   ', 4, 'ALL') === true（纯空白算未指定）",
  week.matchesWeeks('   ', 4, 'ALL') === true);
check("B2d 旧 week_rule 仍生效：ODD/EVEN",
  week.matchesWeeks('', 3, 'ODD') === true && week.matchesWeeks('', 4, 'ODD') === false
  && week.matchesWeeks('', 4, 'EVEN') === true);

// 正常显式周次不受影响
check("B3 matchesWeeks('2,4,6', 4) === true 且 ('2,4,6', 5) === false",
  week.matchesWeeks('2,4,6', 4, 'ALL') === true && week.matchesWeeks('2,4,6', 5, 'ALL') === false);
check("B3b matchesWeeks('1,2,3,4', 4) === true（库里 id=37 那条真实数据）",
  week.matchesWeeks('1,2,3,4', 4, 'ALL') === true);
check('B3c parseWeeks 去重升序不变', JSON.stringify(week.parseWeeks('2,4,4,6')) === '[2,4,6]');
check('B3d parseWeeks 边界：1 与 53 保留，0 / 54 / -1 丢弃',
  JSON.stringify(week.parseWeeks('0,1,53,54,-1')) === '[1,53]');
check('B3e parseWeeks 部分非法时保留合法项（不是全盘丢弃）',
  JSON.stringify(week.parseWeeks('3,99,4')) === '[3,4]');

// 其他非法形态一律判「不上」
check("B4 其他非法值也判不上：'0' / 'abc' / '54' / '99,99' / ','",
  week.matchesWeeks('0', 4, 'ALL') === false
  && week.matchesWeeks('abc', 4, 'ALL') === false
  && week.matchesWeeks('54', 4, 'ALL') === false
  && week.matchesWeeks('99,99', 4, 'ALL') === false
  && week.matchesWeeks(',', 4, 'ALL') === false);
check('B4b isWeeksBlank 对非法值返回 false（它们不是「未指定」）',
  week.isWeeksBlank('99') === false && week.isWeeksBlank('') === true
  && week.isWeeksBlank(null) === true && week.isWeeksBlank('  ') === true
  && week.isWeeksBlank(0) === false);
check('B4c isWeeksBlank(0) === false 但 matchesWeeks(0,…) 不抛异常',
  week.matchesWeeks(0, 4, 'ALL') === false);

/* ---------- B5 与端上 data/timetable.js 对拍 ---------- *
 * 端上 `miniprogram/data/timetable.js` 有一份同构的 matchesWeeks（课表页离线渲染用）。
 * 事故当天课表页显示正常、首页/值日页多出一节课，正是因为这两份实现语义不一致：
 * 端上是「非空串 ⇒ 必须命中集合」（'99' 判不上），云端是「非空但滤空 ⇒ 每周都上」。
 * 修完必须两端逐项对拍，否则同类漂移还会再来。
 */
console.log('\n【B5】端上 data/timetable.js 对拍');
const store = {};
global.wx = {
  getStorageSync: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; }
};
const tt = require(path.join(ROOT, 'miniprogram/data/timetable.js'));

const DUAL = [
  '', null, undefined, '   ', '2,4,6', '1,2,3,4', '99', '0', 'abc', '54', '99,99', ',', '3,99,4', '1,53'
];
const DUAL_WEEKS = [1, 3, 4, 5, 6, 18, 53];
const dualBad = [];
DUAL.forEach((w) => {
  DUAL_WEEKS.forEach((k) => {
    const s = week.matchesWeeks(w, k, 'ALL');
    const c = tt.matchesWeeks(w, k);
    if (s !== c) dualBad.push({ weeks: String(w), wk: k, server: s, client: c });
  });
});
check('B5a matchesWeeks 云端 / 端上在 ' + (DUAL.length * DUAL_WEEKS.length) + ' 组用例上逐项一致',
  dualBad.length === 0, dualBad.slice(0, 6));
// 给「对拍集合本身」配前置断言：判据算出的量本身也要被断言，
// 否则用例集合写错（比如端上没导出 matchesWeeks）会伪装成「一致」。
check('B5b 对拍集合确实覆盖了事故值与边界值（前置断言，防判据自身失效）',
  DUAL.includes('99') && DUAL.includes('') && DUAL.includes('   ')
  && DUAL.includes('abc') && DUAL_WEEKS.includes(4) && typeof tt.matchesWeeks === 'function',
  { dual: DUAL.length, dualWeeks: DUAL_WEEKS.length, hasFn: typeof tt.matchesWeeks === 'function' });

/* ============================================================
 * C. 变异自证（全部在内存副本上做）
 * ============================================================ */
console.log('\n【C】变异自证（在内存副本上改坏源码，判据必须变红）');

/**
 * 行为判据：给定一份 week.js 源码，返回它是否还会犯「'99' 判成每周都上」这个 bug。
 * A 组判据（源码结构）与 B 组判据（行为）都要能被它调用。
 */
function judge(weekSrc) {
  const code = stripComments(weekSrc);
  const mB = extractFn(code, 'isWeeksBlank');
  const mP = extractFn(code, 'parseWeeks');
  const mM = extractFn(code, 'matchesWeeks');
  if (!mB || !mP || !mM) return { buggy: true, why: '抽不到某个函数' };
  const fnM = stripComments(mM);
  // 行为判定
  let mod;
  try { mod = loadModule(weekSrc, WEEK_PATH); }
  catch (e) { return { buggy: true, why: '模块加载失败 ' + e.message }; }
  const bad = [];
  // '99' 必须全周不上
  for (let k = 1; k <= 18; k++) if (mod.matchesWeeks('99', k, 'ALL') !== false) bad.push("'99'@" + k);
  // 未指定必须仍是每周都上（防止「修得太过头」把存量课也砍掉）
  for (const w of ['', null, undefined, '   ']) {
    if (mod.matchesWeeks(w, 4, 'ALL') !== true) bad.push('blank:' + String(w));
  }
  if (mod.matchesWeeks('', 3, 'ODD') !== true) bad.push('ODD');
  if (mod.matchesWeeks('', 4, 'ODD') !== false) bad.push('ODD-even');
  // 正常显式周次
  if (mod.matchesWeeks('2,4,6', 4, 'ALL') !== true) bad.push("'2,4,6'@4");
  if (mod.matchesWeeks('2,4,6', 5, 'ALL') !== false) bad.push("'2,4,6'@5");
  // 纯空白必须 trim 过
  if (mod.matchesWeeks('   ', 4, 'ALL') !== true) bad.push('trim');
  // 结构判定
  if (!/if\s*\(\s*isWeeksBlank\(weeks\)\s*\)/.test(fnM)) bad.push('A1');
  if ((fnM.match(/matchesWeekRule\s*\(/g) || []).length !== 1) bad.push('A2');
  if (!/if\s*\(\s*!\s*arr\.length\s*\)\s*return false;/.test(fnM)) bad.push('A2b');
  if (!/if\s*\(\s*isWeeksBlank\(weeks\)\s*\)\s*return \[\];/.test(stripComments(mP))) bad.push('A3');
  if (!/\.trim\(\)\s*===\s*''/.test(stripComments(mB))) bad.push('A4');
  return { buggy: bad.length > 0, why: bad.join(',') };
}

/** 按锚点做一次替换；锚点找不到 ⇒ 返回 null（后续判 FAIL，绝不静默放过） */
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.replace(from, to);
}

const ORIGINAL = judge(WEEK_SRC);
check('C0 原始源码判为「无此 bug」（防判据本身恒红）', !ORIGINAL.buggy, ORIGINAL.why);

// C1 还原成事故版：把 isWeeksBlank 分支换回 `if (!arr.length) return matchesWeekRule(...)`
const C1 = mutate(WEEK_SRC,
  "  if (isWeeksBlank(weeks)) return matchesWeekRule(weekRule, week);\n  const arr = parseWeeks(weeks);\n  if (!arr.length) return false;",
  "  const arr = parseWeeks(weeks);\n  if (!arr.length) return matchesWeekRule(weekRule, week);");
check('C1 锚点存在于源码中（否则变异没生效 = 假自证）', C1 !== null);
if (C1) {
  const r = judge(C1);
  check('C1 变异体（事故版：空数组回落成每周都上）被判定为有 bug', r.buggy, r.why);
}

// C2 只留 isWeeksBlank 分支、但把空数组重新回落成 weekRule（半修状态，最容易漏）
const C2 = mutate(WEEK_SRC,
  '  if (!arr.length) return false;',
  '  if (!arr.length) return matchesWeekRule(weekRule, week);');
check('C2 锚点存在于源码中', C2 !== null);
if (C2) {
  const r = judge(C2);
  check('C2 变异体（半修：isWeeksBlank 在、但空数组仍回落）被判定为有 bug', r.buggy, r.why);
}

// C3 isWeeksBlank 去掉 trim ⇒ '   ' 掉进「全非法 ⇒ 不上」，把纯空白课次误砍
const C3 = mutate(WEEK_SRC, "return String(weeks).trim() === '';", "return weeks === '';");
check('C3 锚点存在于源码中', C3 !== null);
if (C3) {
  const r = judge(C3);
  check('C3 变异体（isWeeksBlank 去掉 trim）被判定为有 bug', r.buggy, r.why);
}

// C4 修过头：把「未指定」也判成不上（存量课全灭）——判据必须能抓这种反向错误
const C4 = mutate(WEEK_SRC,
  'function isWeeksBlank(weeks) {\n  if (weeks === null || weeks === undefined) return true;',
  'function isWeeksBlank(weeks) {\n  if (weeks === null || weeks === undefined) return false;');
check('C4 锚点存在于源码中', C4 !== null);
if (C4) {
  const r = judge(C4);
  check('C4 变异体（把「未指定」也判成不上）被判定为有 bug', r.buggy, r.why);
}

// C5 判据的「量」本身也要断言：确认 judge 真的会因为 '99' 而红
//    （若 judge 恒返回 buggy=false，上面 4 条变异自证全是空转）
const C5 = judge(WEEK_SRC.replace('return false;', 'return true;'));
check("C5 判据自检：把 matchesWeeks 的 `return false` 换成 `return true` 必被判有 bug",
  C5.buggy, C5.why);

/* ---------- C6 course/index.js 侧的结构变异 ---------- */
const COURSE_MOVE_BAK = COURSE_SRC;
function judgeCourse(src) {
  const fn = stripComments(extractFn(stripComments(src).replace(
    /async function extractNothing\(\)\{\}/, ''), 'moveSessionSlots').replace(/async function /, 'function '));
  if (!fn) return false;
  return /week\.isWeeksBlank\(s\.weeks\)/.test(fn) && !/if\s*\(\s*arr\.length\s*\)/.test(fn);
}
check('C6a 原始 course/index.js 判为合规', judgeCourse(COURSE_MOVE_BAK));
const C6 = mutate(COURSE_MOVE_BAK,
  '    if (week.isWeeksBlank(s.weeks)) {\n      for (let w = 1; w <= (cfg.totalWeeks || 18); w++) {\n        if (week.matchesWeekRule(s.week_rule, w)) weeks.add(w);\n      }\n    } else {\n      week.parseWeeks(s.weeks).forEach(w => weeks.add(w));\n    }',
  '    const arr = week.parseWeeks(s.weeks);\n    if (arr.length) arr.forEach(w => weeks.add(w));\n    else for (let w = 1; w <= (cfg.totalWeeks || 18); w++) {\n      if (week.matchesWeekRule(s.week_rule, w)) weeks.add(w);\n    }');
check('C6b 锚点存在于源码中', C6 !== null);
if (C6) {
  check('C6c 变异体（还原成 `if (arr.length) … else 铺满学期`）被判为不合规',
    !judgeCourse(C6));
}

console.log('\n' + (fail ? '❌ 失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项' : '全部通过 ✅ ' + pass + ' 项'));
if (fail) process.exitCode = 1;
