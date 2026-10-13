/**
 * 离线仿真「按序号连续轮转」v2 —— 显式游标内核（pickBySeq + buildState）
 * ============================================================
 * 用户 2026-10-07 第五次反馈（原话）：
 *   「按序号轮转还是不对……目前轮到 a组47、b组48，但是并没有按照序号，
 *    也就是 a组49、b组50 开始轮到 56 后再从头 2 号开始轮。并且每一轮都要
 *    按序号将 55 个人全部排上，而不是漏人缺人。」
 *
 * v0.7.31 起轮转位置彻底改成「显式数字游标」（class.round_cursor_a/b +
 * duty_week_cursor 按周快照），旧版把游标寄存在 member.duty_count 里、
 * 靠 repairRoundMarks 反推的那套（rotationPick / repairRoundMarks）已全部删除。
 * 本脚本把新口径变成可执行断言：
 *   A. A=47/B=48 起，A 组必须从 49、B 组必须从 50 继续（不回退、不重头）；
 *   B. 同轮按序号严格递增，到 56 才回绕（回绕后从最小序号 2 开始）；
 *   C. 一轮必须把本组全部 55 人排满，不漏人、不重复；
 *   D. A/B 两组游标独立，互不串扰；
 *   E. 全体课（scope=null）两组严格交替，各自行进同步；
 *   F. 按周幂等：同一游标起点重复生成 → 名单完全一致（无随机性）；
 *   G. 代码卫生：轮转算法只有一份（round-robin.js），旧函数已删除，
 *      schedule 与 cron-weekly 都通过内核取人并落游标（saveWeekCursors + syncGlobalCursors）。
 *
 * 为什么不连数据库 / 不调云函数：MCP 的 invokeFunction 没有 WX 上下文，业务
 * action 一律 40001 验不了逻辑；而 pickBySeq/buildState 都是纯函数，直接 require
 * 生产内核源码（round-robin.js 无云依赖）即可测到真身。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/** 直接 require 生产内核（round-robin.js 是纯函数，无云依赖） */
const { pickBySeq, buildState, inferCursor } = require(path.join(ROOT, 'cloudfunctions/common/round-robin'));

const CORE_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/common/schedule-core.js'), 'utf8');
const RR_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/common/round-robin.js'), 'utf8');
const SCHED_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/schedule/index.js'), 'utf8');
const CRON_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/cron-weekly/index.js'), 'utf8');

/** 剥注释再判据 —— 本仓库判据反复栽在「判据命中注释里的字面量」，这里统一处理 */
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let fail = 0;
function check(label, cond, extra) {
  const okFlag = !!cond;
  if (!okFlag) fail++;
  console.log((okFlag ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}

/** 真实名册：2~56 ⇒ A 27 人（奇）、B 28 人（偶），共 55 人（与线上一致） */
function roster() {
  const out = [];
  for (let i = 2; i <= 56; i++) out.push({ id: i, seq: i, group: i % 2 === 1 ? 'A' : 'B', name: 'S' + i });
  return out;
}
const sizeOf = (r, g) => r.filter(m => m.group === g).length;
const seqs = (arr) => arr.map(m => m.seq);
const J = (a) => JSON.stringify(a);

/* ============================================================
 * 第 1 部分：A=47/B=48 续排 + 回绕（用户原话，最核心）
 * ============================================================ */
console.log('=== 第 1 部分：A=47/B=48 续排 + 回绕（用户原话）===');
{
  const r = roster();
  const st = buildState(r, { A: 47, B: 48 });
  const a = pickBySeq(r, 'A', 2, st);
  const b = pickBySeq(r, 'B', 2, st);
  check('A 组第一节课 = 49,51（接着 47 往后排，不回退到 1 号）', J(seqs(a.chosen)) === '[49,51]', seqs(a.chosen).join(','));
  check('B 组第一节课 = 50,52（接着 48 往后排）', J(seqs(b.chosen)) === '[50,52]', seqs(b.chosen).join(','));
}
{
  const r = roster();
  const st = buildState(r, { A: 47, B: 48 });
  const seen = { A: [], B: [] };
  for (let i = 0; i < 4; i++) seen.A.push(...seqs(pickBySeq(r, 'A', 2, st).chosen));
  check('A 组：49,51,53,55 之后回绕到 03,05,07,09', J(seen.A) === '[49,51,53,55,3,5,7,9]', seen.A.join(','));
  const bseen = [];
  for (let i = 0; i < 3; i++) bseen.push(...seqs(pickBySeq(r, 'B', 2, st).chosen));
  check('B 组：50,52,54,56 之后回绕到 02,04（🔴 A 组回绕不得抹掉 B 组进度）', J(bseen) === '[50,52,54,56,2,4]', bseen.join(','));
}
{
  const r = roster();
  const st = buildState(r, { A: 47, B: 48 });
  const a1 = seqs(pickBySeq(r, 'A', 2, st).chosen);
  const b1 = seqs(pickBySeq(r, 'B', 2, st).chosen);
  const a2 = seqs(pickBySeq(r, 'A', 2, st).chosen);
  check('A/B 交叉取人互不串扰（A=49,51→53,55，B 始终是 50,52）',
    J(a1) === '[49,51]' && J(b1) === '[50,52]' && J(a2) === '[53,55]', 'A=' + a1 + ',' + a2 + ' B=' + b1);
}

/* ============================================================
 * 第 2 部分：一轮不漏人（每组的 55 人中各排满）
 * ============================================================ */
console.log('\n=== 第 2 部分：一轮不漏人（每组的 55 人中各排满）===');
{
  const r = roster();
  const st = buildState(r, { A: 0, B: 0 });
  const got = { A: [], B: [] };
  for (let i = 0; i < 14; i++) for (const g of ['A', 'B']) got[g].push(...seqs(pickBySeq(r, g, 2, st).chosen));
  for (const g of ['A', 'B']) {
    const uniq = [...new Set(got[g])].sort((x, y) => x - y);
    check(g + ' 组一轮覆盖 ' + uniq.length + '/' + sizeOf(r, g) + ' 人', uniq.length === sizeOf(r, g), uniq.length + '/' + sizeOf(r, g));
    const expect = r.filter(m => m.group === g).map(m => m.seq).sort((x, y) => x - y);
    check(g + ' 组覆盖的正是全组名单（无漏无重）', J(uniq) === J(expect));
  }
}

/* ============================================================
 * 第 3 部分：同轮序号严格递增，只回绕 1 次
 * ============================================================ */
console.log('\n=== 第 3 部分：同轮序号严格递增，只回绕 1 次 ===');
{
  const r = roster();
  const st = buildState(r, { A: 47, B: 48 });
  const got = [];
  for (let i = 0; i < 13; i++) got.push(...seqs(pickBySeq(r, 'A', 2, st).chosen));
  let wraps = 0;
  for (let i = 1; i < got.length; i++) if (got[i] < got[i - 1]) wraps++;
  check('A 组 26 人次只回绕 1 次', wraps === 1, 'wraps=' + wraps);
  check('A 组覆盖 26 人', new Set(got).size === 26, new Set(got).size + '');
  got.push(...seqs(pickBySeq(r, 'A', 2, st).chosen));
  check('第 14 节补齐最后一人（全组 27 人）', new Set(got).size === 27, new Set(got).size + '');
}

/* ============================================================
 * 第 4 部分：补漏（中间被跳过的人本轮内必补上，游标不回退）
 * ============================================================ */
console.log('\n=== 第 4 部分：补漏（中间被跳过的人本轮内必补上）===');
{
  const r = roster();
  const st = buildState(r, { A: 47, B: 48 });
  const x = pickBySeq(r, 'A', 2, st, { avoidSameDay: true, busySeqs: new Set([49]) });
  check('49 当天有值日 → 本次取 51,53（游标越过）', J(seqs(x.chosen)) === '[51,53]', seqs(x.chosen).join(','));
  const y = pickBySeq(r, 'A', 2, st, {});
  check('下一节先补 49 再取 55（游标不回退）', J(seqs(y.chosen)) === '[49,55]', seqs(y.chosen).join(','));
  const all = new Set([...seqs(x.chosen), ...seqs(y.chosen)]);
  for (let i = 0; i < 12; i++) seqs(pickBySeq(r, 'A', 2, st).chosen).forEach(q => all.add(q));
  check('A 组本轮最终覆盖 ' + sizeOf(r, 'A') + ' 人', all.size === sizeOf(r, 'A'), all.size + '');
}

/* ============================================================
 * 第 5 部分：全体课（scope=null）落后组优先（按 ahead 比较）+ 回绕护栏
 * ============================================================ */
console.log('\n=== 第 5 部分：全体课（scope=null）落后组优先 + 回绕护栏 ===');
{
  const r = roster();
  const st = buildState(r, { A: 47, B: 48 });
  const s = [];
  for (let i = 0; i < 5; i++) s.push(seqs(pickBySeq(r, null, 2, st).chosen));
  check('全体课第1~4节 = (49,50)(51,52)(53,54)(55,56)',
    J(s.slice(0, 4)) === '[[49,50],[51,52],[53,54],[55,56]]', JSON.stringify(s.slice(0, 4)));
  check('第5节两组同时回绕 = (2,3)', J(s[4]) === '[2,3]', J(s[4]));
  const a = seqs(pickBySeq(r, 'A', 2, st).chosen);
  const b = seqs(pickBySeq(r, 'B', 2, st).chosen);
  check('分组课接着各自游标：A=5,7 / B=4,6', J(a) === '[5,7]' && J(b) === '[4,6]', 'A=' + a + ' B=' + b);
}
{
  const r = roster();
  // 全新轮次（A:0/B:0）+ 30 节「分组 + 全体」混排：真实一周里分组课会先把各组补漏排掉，
  // 所以不能用「A50/B0 + 纯全体」这种人为构造（buildState 会把 ≤cursor 的人标成本轮已排，
  // 纯全体又没分组课去排那些补漏，反而测不出真实覆盖）。本用例验证：混排一轮不漏 55 人。
  const scopes = ['A','B',null,'A',null,'B',null,'A','B',null,'A','B',null,'A','B',null,'A','B',null,'B','A','B',null,'A','B',null,'A','B',null,'A'];
  const st = buildState(r, { A: 0, B: 0 });
  const got = [];
  for (const sc of scopes) got.push(...seqs(pickBySeq(r, sc, 2, st).chosen));
  const uniq = [...new Set(got)].sort((a, b) => a - b);
  check('30 节（分组+全体混排）覆盖全部 55 人（一轮不漏）', uniq.length === 55, uniq.length + '');
}

/* ============================================================
 * 第 6 部分：按周幂等（同一游标起点重复生成 → 名单完全一致）
 * ============================================================ */
console.log('\n=== 第 6 部分：按周幂等（无随机性）===');
{
  const sim = () => {
    const r = roster();
    const st = buildState(r, { A: 47, B: 48 });
    const out = [];
    // 模拟一周 20 节：分组 / 全体课混排
    const scopes = ['A', 'B', null, 'A', null, 'B', null, 'A', 'B', null,
      'A', 'B', null, 'A', 'B', null, 'A', 'B', null, 'B'];
    for (const sc of scopes) out.push(...seqs(pickBySeq(r, sc, 2, st).chosen));
    return out.join(',');
  };
  const run1 = sim();
  const run2 = sim();
  check('同一游标起点重复生成 → 名单完全一致（无随机性）', run1 === run2, run1.slice(0, 40) + '…');
}

/* ============================================================
 * 第 7 部分：代码卫生（只有一份轮转算法 + 游标落库）
 * ============================================================ */
console.log('\n=== 第 7 部分：代码卫生（单一来源 + 游标落库）===');
check('旧 rotationPick 已从内核删除', !/function rotationPick\s*\(/.test(CORE_SRC));
check('旧 repairRoundMarks 已从内核删除', !/function repairRoundMarks\s*\(/.test(CORE_SRC));
check('轮转内核 pickBySeq 只定义在 round-robin.js（单一来源）',
  /function pickBySeq\s*\(/.test(RR_SRC)
  && !/function pickBySeq\s*\(/.test(SCHED_SRC)
  && !/function pickBySeq\s*\(/.test(CRON_SRC)
  && !/function pickBySeq\s*\(/.test(CORE_SRC));
check('schedule 通过 require 用内核，无本地副本（rotationPick 已迁走）',
  /require\('\.\/common\/schedule-core'\)/.test(SCHED_SRC) && !/function pickBySeq\s*\(/.test(SCHED_SRC));
check('cron-weekly 通过 require 用内核，无本地副本',
  /require\('\.\/common\/schedule-core'\)/.test(CRON_SRC) && !/function pickBySeq\s*\(/.test(CRON_SRC));
check('cron-weekly 无 Math.random()（不可复现 / 会跨天重复）',
  !/Math\.random\(\)/.test(stripComments(CRON_SRC)));
check('schedule-core 导出游标读写（loadWeekCursors / saveWeekCursors / syncGlobalCursors / dropWeekCursorsFrom）',
  /function loadWeekCursors\s*\(/.test(CORE_SRC)
  && /function saveWeekCursors\s*\(/.test(CORE_SRC)
  && /function syncGlobalCursors\s*\(/.test(CORE_SRC)
  && /function dropWeekCursorsFrom\s*\(/.test(CORE_SRC));
check('schedule 生成后落游标（saveWeekCursors + syncGlobalCursors 都在）',
  /saveWeekCursors\(/.test(SCHED_SRC) && /syncGlobalCursors\(/.test(SCHED_SRC));
check('cron-weekly 生成后也落游标（两条链路同口径）',
  /saveWeekCursors\(/.test(CRON_SRC) && /syncGlobalCursors\(/.test(CRON_SRC));
check('cron-weekly 已删除对 roundFix 的引用（曾导致每代必报 50000）', !/roundFix/.test(CRON_SRC));
check('schedule 已删除对 roundFix / repairRoundMarks 的引用（剥注释后）',
  !/roundFix/.test(stripComments(SCHED_SRC)) && !/repairRoundMarks/.test(stripComments(SCHED_SRC)));
check('内核 round-robin.js 完全不读 duty_count（轮转位置与统计彻底解耦，剥注释后）',
  !/duty_count/.test(stripComments(RR_SRC)));
check('schedule / cron-weekly 仍把 duty_count 当纯统计回写（CASE 写法）',
  /UPDATE member SET duty_count = CASE/.test(SCHED_SRC) && /UPDATE member SET duty_count = CASE/.test(CRON_SRC));
check('一键生成 / 每周自动生成都不再「全员 mark>0 → 全班清零」（轮转位置不会被打回 1 号）',
  !/roster\.every\([^)]*mark\s*>\s*0/.test(stripComments(SCHED_SRC))
  && !/roster\.every\([^)]*mark\s*>\s*0/.test(stripComments(CRON_SRC)));

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
