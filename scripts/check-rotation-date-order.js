/**
 * check-rotation-date-order.js ——「轮转取人按实际上课日期排序」门禁（#56，2026-10-05）
 *
 * 需求（2026-10-05 用户实锤）：国庆调休把 10/7（周三）的课调到 10/10（周六），
 *   值日「按序号轮转」出来的顺序变成 **10 号、8 号、9 号** —— 应该是 8 号接着前面的序号排，
 *   然后 9 号、最后 10 号。
 *
 * 根因：`session.day_of_week` 记的是**课表上的星期几**，调休（MOVE）只是用 resolveSlot
 *   把这节课挪到周六，**day_of_week 仍是 3**。而三条轮转链路都按 SQL 的
 *   `ORDER BY s.day_of_week, s.period` 迭代 → 调来的 10/10（day_of_week=3）
 *   排在 10/8（4）、10/9（5）**前面**被分配轮转序号。不报错、不打架，只是顺序错。
 *
 * 修法：三条链路都改成「先把每个课次解析成实际上课日期 → 按 (classDate, 节次, id) 排序 → 再轮转取人」。
 *   ① schedule.generate（超管「一键生成」）
 *   ② schedule.buildCleaningPlan（AI 应用 / 保洁链路）
 *   ③ cron-weekly（周日 20:00 自动生成）
 *   （aiPlan 的 `ordered` 本来就按解析后日期排，是正确样板，不在修复范围内但一并守住）
 *
 * 判据：
 *   A（结构）三条链路都必须在取人前构建 `rotatePlan` 并**遍历它**，
 *     循环头形如 `for (const { s, slot, classDate } of rotatePlan)` ——
 *     即 classDate 是「排序后拿到的」，不是「循环里现算的」。
 *   B（行为级）抽出真实 comparator 在内存里跑国庆调休场景：
 *     输入 [(周三课→10-10), (周四课→10-08), (周五课→10-09)] → 输出必须是 10-08、10-09、10-10。
 *   C（行为级）三条链路 comparator 行为一致（同一输入同一输出，自动/手动两条链路不许分叉）。
 *   D（相对面）aiPlan 的 `ordered` 仍按 date 排（不许被改回 day_of_week）。
 *
 * 变异自证（内存改写，不落盘）：
 *   comparator 改回按 `a.s.day_of_week` 比 → B 翻红（10-10 排到第一）
 *   某条链路遍历改回 `for (const s of sessions)` → A 翻红
 *   comparator 反向（`>`）→ B 翻红
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEDULE = path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js');
const CRON = path.join(ROOT, 'cloudfunctions', 'cron-weekly', 'index.js');

const scheduleSrc = fs.readFileSync(SCHEDULE, 'utf8');
const cronSrc = fs.readFileSync(CRON, 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const assertTrue = (cond, msg) => { if (cond) ok(msg); else bad(msg); };

/* ---------------- 工具 ---------------- */

/** 从 openIdx 处的 '(' 起做圆括号配对，返回括号内文本（不含首尾括号） */
function parenInner(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return '';
}

/** 抽出一个 comparator 箭头函数的源码文本（形如 `(a, b) => (...)`） */
function comparatorOf(src) {
  const i = src.indexOf('rotatePlan.sort(');
  if (i < 0) return '';
  const open = src.indexOf('(', i + 'rotatePlan.sort'.length);
  return parenInner(src, open).trim();
}

/** 在内存里把 comparator 编译成真正可用的比较函数。
 *  ⚠️ `parenInner` 取到的是 `sort(...)` 的**实参**，也就是整个箭头函数文本
 *     `(a, b) => (...)` —— 所以必须**立即调用**它；
 *     直接 `return (箭头)` 会返回函数本身，sort 拿到的比较结果是函数 → 排不动（假绿）。 */
function loadComparator(code) {
  return new Function('a', 'b', '"use strict"; return (' + code + ')(a, b);');
}

/** 找出所有 `for (const s of sessions) {` 循环的**块体**（花括号配对） */
function sessionsLoopBlocks(src) {
  const out = [];
  const re = /for \(const s of sessions\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { out.push(src.slice(open, i + 1)); break; } }
    }
  }
  return out;
}

/* ---------------- A. 三条链路结构 ---------------- */
const CHAINS = [
  { name: 'schedule.generate（超管一键生成）', src: scheduleSrc },
  { name: 'schedule.buildCleaningPlan（AI/保洁链路）', src: scheduleSrc },
  { name: 'cron-weekly（周日自动生成）', src: cronSrc }
];

const cmpByChain = {};
CHAINS.forEach((c) => {
  const anchors = c.src.split('rotatePlan.sort(').length - 1;
  assertTrue(anchors >= 1, 'A0 ' + c.name + ' 存在 rotatePlan.sort(...)');
  assertTrue(
    /for \(const \{ s, slot, classDate \} of rotatePlan\)/.test(c.src),
    'A1 ' + c.name + ' 遍历的是 rotatePlan（classDate 排序后取得，而不是循环里按星期几现算）'
  );
  const cmp = comparatorOf(c.src);
  cmpByChain[c.name] = cmp;
  assertTrue(cmp.length > 0, 'A2 ' + c.name + ' 的 comparator 可提取');
});

/* 「取人的循环」不许直接遍历 sessions —— 一旦直接遍历，就是按 SQL 的星期几顺序分配轮转序号。
   （预解析循环里出现 resolveSlot 是正常的：它只负责算日期，不取人。） */
[['schedule', scheduleSrc], ['cron-weekly', cronSrc]].forEach(([tag, src]) => {
  const loops = sessionsLoopBlocks(src);
  const guilty = loops.filter(b => /rotationPick\(/.test(b));
  assertTrue(
    guilty.length === 0,
    'A3 ' + tag + '：没有「直接遍历 sessions 就调 rotationPick」的循环（实得 ' + guilty.length + ' 处）'
  );
});

/* ---------------- B/C. 行为级：国庆调休场景 ---------------- */
/** 场景：10/7（周三）的课被调到 10/10（周六）；session.day_of_week 不变 */
const SCENE = [
  { s: { id: 101, day_of_week: 3 }, slot: { day: 6, period: 5 }, classDate: '2026-10-10' }, // 调来的
  { s: { id: 102, day_of_week: 4 }, slot: { day: 4, period: 2 }, classDate: '2026-10-08' },
  { s: { id: 103, day_of_week: 5 }, slot: { day: 5, period: 3 }, classDate: '2026-10-09' }
];
const EXPECT = ['2026-10-08', '2026-10-09', '2026-10-10'];

const sortedDates = (cmp) => SCENE.slice().sort(loadComparator(cmp)).map(x => x.classDate);
const firstOut = sortedDates(cmpByChain[CHAINS[0].name]);

assertTrue(
  JSON.stringify(firstOut) === JSON.stringify(EXPECT),
  'B1 国庆调休场景：轮转顺序 = 10-08 → 10-09 → 10-10（实得 ' + firstOut.join(' → ') + '）'
);

// 同一天内按节次、再按课次 id
const sameDay = [
  { s: { id: 3 }, slot: { period: 3 }, classDate: '2026-10-09' },
  { s: { id: 1 }, slot: { period: 1 }, classDate: '2026-10-09' },
  { s: { id: 2 }, slot: { period: 1 }, classDate: '2026-10-09' }
];
const cmpMain = loadComparator(cmpByChain[CHAINS[0].name]);
const sameDayOut = sameDay.slice().sort(cmpMain).map(x => x.s.id);
assertTrue(
  JSON.stringify(sameDayOut) === JSON.stringify([1, 2, 3]),
  'B2 同一天内按节次 → 课次 id 排（保证与页面上一致的先后顺序，实得 ' + sameDayOut.join(',') + '）'
);

CHAINS.forEach((c) => {
  const out = sortedDates(cmpByChain[c.name]);
  assertTrue(
    JSON.stringify(out) === JSON.stringify(EXPECT),
    'C ' + c.name + ' 与主链路同口径（实得 ' + out.join(' → ') + '）'
  );
});

/* ---------------- D. aiPlan 的 ordered 仍按日期 ---------------- */
assertTrue(
  /const ordered = sessions\.slice\(\)\.sort\(\(a, b\) => \(a\.date < b\.date/.test(scheduleSrc),
  'D aiPlan 的 ordered 仍按解析后日期排（正确样板，别被改回 day_of_week）'
);

/* ============================ 变异自证 ============================ */
function prove(label, mutate, predicate) {
  const before = predicate();
  const mutated = mutate();
  if (mutated === undefined) { bad('自证：' + label + ' 取不到变异源'); return; }
  const after = predicate(mutated);
  if (before === true && after === false) ok('自证：' + label + ' 坏样本会被抓（判据非假通过）');
  else bad('自证：' + label + ' 变异后未翻转（before=' + before + ' after=' + after + '）');
}

// ① comparator 改回按「课表星期几」排（= 修复前的行为）
prove(
  'comparator 改回 day_of_week（调休那天排到第一）',
  () => {
    const c = cmpByChain[CHAINS[0].name]
      .replace('a.classDate < b.classDate ? -1', 'a.s.day_of_week < b.s.day_of_week ? -1')
      .replace('a.classDate > b.classDate ? 1', 'a.s.day_of_week > b.s.day_of_week ? 1');
    return c === cmpByChain[CHAINS[0].name] ? undefined : c;
  },
  (cmp) => {
    const c = cmp || cmpByChain[CHAINS[0].name];
    return JSON.stringify(SCENE.slice().sort(loadComparator(c)).map(x => x.classDate)) === JSON.stringify(EXPECT);
  }
);

// ② comparator 方向写反
prove(
  'comparator 方向写反（> 与 < 互换）',
  () => {
    const c = cmpByChain[CHAINS[0].name]
      .replace('a.classDate < b.classDate ? -1', 'a.classDate > b.classDate ? -1')
      .replace('a.classDate > b.classDate ? 1', 'a.classDate < b.classDate ? 1');
    return c === cmpByChain[CHAINS[0].name] ? undefined : c;
  },
  (cmp) => {
    const c = cmp || cmpByChain[CHAINS[0].name];
    return JSON.stringify(SCENE.slice().sort(loadComparator(c)).map(x => x.classDate)) === JSON.stringify(EXPECT);
  }
);

// ③ 把某条链路的遍历改回 sessions（即回到按星期几取人的老循环）
prove(
  'cron-weekly 遍历改回 for (const s of sessions)（取人循环直遍历 sessions）',
  () => cronSrc.replace(
    /for \(const \{ s, slot, classDate \} of rotatePlan\)/,
    'for (const s of sessions) { const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts); const classDate = week.classDateOf(cfg, wk, slot.day, cal);'
  ),
  (src) => {
    const t = src || cronSrc;
    const loops = sessionsLoopBlocks(t);
    return /for \(const \{ s, slot, classDate \} of rotatePlan\)/.test(t)
      && !loops.some(b => /rotationPick\(/.test(b));
  }
);

// ④ 把所有 rotatePlan.sort(...) 整段删掉（退化成 SQL 的星期几顺序）—— 三条链路都要处理
prove(
  '删掉 rotatePlan.sort(...)（退化成按星期几）',
  () => {
    let out = scheduleSrc;
    for (let guard = 0; guard < 10; guard++) {
      const i = out.indexOf('rotatePlan.sort(');
      if (i < 0) break;
      const open = out.indexOf('(', i);
      const end = open + parenInner(out, open).length + 2; // 含 ')'
      out = out.slice(0, i) + out.slice(end);
    }
    return out === scheduleSrc ? undefined : out;
  },
  (src) => (src || scheduleSrc).indexOf('rotatePlan.sort(') >= 0
);

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
} else {
  console.log('✅ 轮转取人「按实际上课日期排序」门禁全部通过');
}
