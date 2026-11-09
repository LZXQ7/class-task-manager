#!/usr/bin/env node
/**
 * 门禁：自动轮转「同一个人重复出现」（2026-11-09 用户实锤 33 / 38 号）
 * ============================================================
 * 事故（生产库 class 3 第 9 周，48 个名额里两人各出现 2 次）：
 *
 * ① **33 号示例成员33**（A 组）在周五第 1 节两门课里各值一次：
 *    A 组「小学综合实践活动设计」与 B 组「三笔字」同一节次、同一 (星期,节次)，
 *    `slotOf` 命中的是同一个槽（`duty_slot` 没有分组维度），
 *    旧代码用 `slotCache[classDate|slotId]` 缓存 → 第二门课直接复用第一门课的人。
 *
 * ② **38 号示例成员38**（B 组）周四手动、周五又被自动排上：
 *    精确槽分支把 `slotRec.needN` 当取人数传给 pickBySeq，而该课次手动已占 1 个名额
 *    （真实缺口只有 1 人）→ 多取的那个人被 slice 丢弃，但 **游标与 used 已推进**
 *    （幽灵消耗）⇒ 序号被推过本该轮到的人 ⇒ 下一个课次只剩「补漏」通道可选，
 *    而补漏当时不看 soft（本周已值过日的人）⇒ 周四手动排过的人被「补」回来。
 *
 * 本门禁守三件事（任一被改回去都必须翻红）：
 *   G1 槽缓存的复用只允许发生在**全天槽**（period === null）
 *   G2 槽分支取人数不得裸传 `slotRec.needN`（精确槽要按「本课次缺口」取）
 *   G3 内核 round-robin 的「补漏」不得把本周已排过的人（softSeqs）当漏排补回来
 */
const fs = require('fs');
const path = require('path');

const R = path.resolve(__dirname, '..');
const SCHED = path.join(R, 'cloudfunctions', 'schedule', 'index.js');
const CRON = path.join(R, 'cloudfunctions', 'cron-weekly', 'index.js');
const RR = path.join(R, 'cloudfunctions', 'common', 'round-robin.js');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failed++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

const schedSrc = stripComments(fs.readFileSync(SCHED, 'utf8'));
const cronSrc = stripComments(fs.readFileSync(CRON, 'utf8'));
const rrRaw = fs.readFileSync(RR, 'utf8');
const rrSrc = stripComments(rrRaw);

/* 把待测源码写成临时模块再 require（纯函数，无云函数依赖） */
let seqTmp = 0;
function loadMod(code) {
  const f = path.join(__dirname, '_gate_rr_' + (++seqTmp) + '.js');
  fs.writeFileSync(f, code, 'utf8');
  delete require.cache[f];
  const m = require(f);
  fs.unlinkSync(f);
  return m;
}

console.log('=== G1 槽缓存的复用只允许发生在「全天槽」(period === null) ===');
['schedule', 'cron-weekly'].forEach((who) => {
  const src = who === 'schedule' ? schedSrc : cronSrc;
  assert(/const reuseAllDay = slotRec\.period === null;/.test(src),
    who + ' 有 reuseAllDay = (slotRec.period === null) 判定');
  assert(/let people = reuseAllDay \? slotCache\.get\(ck\) : null;/.test(src),
    who + ' 精确槽不读缓存（reuseAllDay 才 get）');
  assert(/if \(reuseAllDay\) slotCache\.set\(ck, people\);/.test(src),
    who + ' 精确槽不写缓存（只有全天槽 set）');
});

console.log('\n=== G2 槽分支取人数 = 本课次缺口，不裸传槽的名额 ===');
['schedule', 'cron-weekly'].forEach((who) => {
  const src = who === 'schedule' ? schedSrc : cronSrc;
  assert(!/pickBySeq\(roster, s\.group_scope, slotRec\.needN/.test(src),
    who + ' 已无「pickBySeq(…, slotRec.needN, …)」的幽灵消耗写法');
  assert(/const wantN = reuseAllDay \? slotRec\.needN : Math\.max\(0, n(?: - chosen\.length)?\)/.test(src),
    who + ' wantN = 全天槽 needN / 精确槽本课次缺口');
});

console.log('\n=== G3 补漏通道不把「本周已值过日的人」补回来 ===');
assert(/const missed = pool\.filter\(m => m\.seq <= cur && okOf\(m\) && !\(soft && soft\.has\(m\.seq\)\)\);/.test(rrSrc),
  'round-robin 的 missed 过滤 softSeqs（本周已排 ≠ 本轮漏排）');

/* 运行时用例：回绕后 used 被清空，光标已越过 38（因为它本周已排过），
 * 38 只剩「补漏」一条通道 —— 修复前必被补回来，修复后必须取不到。 */
const ROSTER = [];
for (let q = 2; q <= 40; q += 2) ROSTER.push({ seq: q, group: 'B', id: 100 + q, name: 'B' + q });
const mkState = () => ({
  cursors: { A: 0, B: 40 },
  // 2..40 都算「本轮已排」，唯独 38 不在（它本周手动排过、回绕时 used 被 clear 过）
  used: { A: new Set(), B: new Set(ROSTER.filter(r => r.seq !== 38).map(r => r.seq)) },
  start: { A: 0, B: 40 },
  wrapped: { A: false, B: false }
});
const mod = loadMod(rrRaw);
const res = mod.pickBySeq(ROSTER, 'B', 2, mkState(), { softSeqs: new Set([38]) });
const got = res.chosen.map(m => m.seq);
assert(got.indexOf(38) === -1,
  '本周已排过的 38 号不会被「补漏」取回（实际取到 [' + got.join(',') + '] , short=' + res.short + '）');
assert(res.short === 2, '取不到人如实报缺口（short=2），而不是沉默地重复用 38');

/* 变异自证：把补漏的 soft 过滤删掉 → 38 立刻被补回来 */
{
  const mutated = rrRaw.replace(
    '!(soft && soft.has(m.seq))',
    'true'
  );
  assert(mutated !== rrRaw, '变异体构造成功（去掉 missed 的 soft 过滤）');
  const m2 = loadMod(mutated);
  const r2 = m2.pickBySeq(ROSTER, 'B', 2, mkState(), { softSeqs: new Set([38]) });
  const g2 = r2.chosen.map(m => m.seq);
  assert(mutated !== rrRaw && g2.indexOf(38) >= 0,
    '变异自证：去掉 soft 过滤后 38 号被补回（实际取到 [' + g2.join(',') + ']）⇒ 门禁能抓到这个回归');
}

/* 变异自证 2：槽缓存改回无条件复用 → G1 断言必须翻红 */
{
  const mutSched = fs.readFileSync(SCHED, 'utf8')
    .replace('let people = reuseAllDay ? slotCache.get(ck) : null;', 'let people = slotCache.get(ck);')
    .replace('if (reuseAllDay) slotCache.set(ck, people);', 'slotCache.set(ck, people);');
  const mutSrc = stripComments(mutSched);
  const g1a = /let people = reuseAllDay \? slotCache\.get\(ck\) : null;/.test(mutSrc);
  const g1b = /if \(reuseAllDay\) slotCache\.set\(ck, people\);/.test(mutSrc);
  assert(!g1a && !g1b, '变异自证：把槽缓存改回无条件复用，G1 两条断言都会翻红');
}

console.log('\n' + (failed ? '[FAIL] ' + failed + ' 项未过' : '✅ 全部通过：轮转不重复（33/38 号事故双向锁死）'));
process.exit(failed ? 1 : 0);
