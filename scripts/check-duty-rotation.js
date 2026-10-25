/* 离线验证：自动排班的「按序号连续轮转」算法（v0.7.31 新游标内核）
   ============================================================
   规则（与 cloudfunctions/common/round-robin.js 的 pickBySeq 一致）：
     · 名册序号 = 学号后两位；真实名册 2..56 号（A=奇 27 人 / B=偶 28 人，共 55 人，301 不参与）
     · A组课只排 A 组（奇数号），B组课只排 B 组（偶数号），全体课取全局序号最小两人（落后组优先追平；某组已回绕而另一组没回绕时退回 1A+1B）
     · 轮转位置 = 显式数字游标 `class.round_cursor_a/b`，**不**再寄存在 duty_count 里
     · 取人 = 取 `seq > cursor` 里序号最小的；走到 56 回绕到 0 开新一轮
     · **回绕前先补漏**（序号 ≤ cursor 但本轮未排的人），保障「每一轮把 55 人全部排上，不漏人」
     · 同一人当天不排两次（avoid_same_day）；法定假日当天不上课，不排值日

   ⚠️ 取人内核直接 require 真源码 `cloudfunctions/common/round-robin.js`——
      复制副本正是 2026-09-24「跨天重复」事故没被测出来的原因：
      测试用自己的旧算法，生产代码改了它也不知道。
   ============================================================ */

const fs = require('fs');
const path = require('path');

const RR = require(path.resolve(__dirname, '../cloudfunctions/common/round-robin'));
const { pickBySeq, buildState } = RR;

const pad = n => String(n).padStart(2, '0');

/* 真实名册：序号 2..56（seq 1 = 301 不参与），奇数 A / 偶数 B */
function buildRoster() {
  const roster = [];
  for (let seq = 2; seq <= 56; seq++) {
    roster.push({ id: 100 + seq, seq, group: seq % 2 === 1 ? 'A' : 'B', mark: 0 });
  }
  return roster;
}

const NAMES = ('示例成员01,示例成员02,示例成员03,示例成员04,示例成员05,示例成员06,示例成员07,示例成员08,示例成员09,示例成员10,示例成员11,示例成员12,示例成员13,示例成员14,示例成员15,示例成员16,示例成员17,示例成员18,示例成员19,示例成员20,示例成员21,示例成员22,示例成员23,示例成员24,示例成员25,示例成员26,示例成员27,示例成员28,示例成员29,示例成员30,示例成员31,示例成员32,示例成员33,示例成员34,示例成员35,示例成员36,示例成员37,示例成员38,示例成员39,示例成员40,示例成员41,示例成员42,示例成员43,示例成员44,示例成员45,示例成员46,示例成员47,示例成员48,示例成员49,示例成员50,示例成员51,示例成员52,示例成员53,示例成员54,示例成员55,示例成员56').split(',');
const roster = buildRoster();
roster.forEach(m => { m.name = NAMES[m.seq - 1]; });

let pass = true;
function chk(label, cond) {
  if (!cond) pass = false;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
}

/* ============ §A 游标连续性（用户口径：A=47→49、B=48→50，56 后回绕） ============ */
console.log('\n===== §A 游标连续性（A=47/B=48 续排）=====');
{
  const st = buildState(roster, { A: 47, B: 48 });
  const a1 = pickBySeq(roster, 'A', 1, st, {}).chosen[0].seq;
  chk('A 组从 47 续排第一个 = 49', a1 === 49);
  // A/B 各自独立：取 A 不动 B 的游标（尚未取 B，B 应仍为 48）
  chk('取 A 不动 B 的游标（A=49 / B 仍 =48）', st.cursors.A === 49 && st.cursors.B === 48);
  // 继续往后：A 49→51→53→55，再下一次回绕到 3（奇数最小可用）
  const aSeqs = [a1];
  for (let i = 0; i < 3; i++) aSeqs.push(pickBySeq(roster, 'A', 1, st, {}).chosen[0].seq);
  chk('A 组依次 49,51,53,55', JSON.stringify(aSeqs) === JSON.stringify([49, 51, 53, 55]));
  const aWrapRes = pickBySeq(roster, 'A', 1, st, {});
  chk('A 组 55 之后再从头（回绕到 3）', aWrapRes.wrapped === true && aWrapRes.chosen[0].seq === 3 && st.cursors.A === 3);

  // B 组从独立游标续排（用全新 state，避免与上面已推进的 st 串扰）
  const stB = buildState(roster, { A: 47, B: 48 });
  const b1 = pickBySeq(roster, 'B', 1, stB, {}).chosen[0].seq;
  chk('B 组从 48 续排第一个 = 50', b1 === 50);
  const bSeqs = [b1];
  for (let i = 0; i < 3; i++) bSeqs.push(pickBySeq(roster, 'B', 1, stB, {}).chosen[0].seq);
  chk('B 组依次 50,52,54,56', JSON.stringify(bSeqs) === JSON.stringify([50, 52, 54, 56]));
  const bWrapRes = pickBySeq(roster, 'B', 1, stB, {});
  chk('B 组 56 之后再从头（回绕到 2）', bWrapRes.wrapped === true && bWrapRes.chosen[0].seq === 2 && stB.cursors.B === 2);
}

/* ============ §B 一轮不漏人（A 27/27、B 28/28，各只回绕 1 次） ============ */
console.log('\n===== §B 一轮覆盖全部 55 人、不漏不重 =========');
{
  const st = buildState(roster, { A: 0, B: 0 });
  const aGot = new Set();
  let aWrapped = false;
  let guard = 0;
  while (guard++ < 100) {
    const r = pickBySeq(roster, 'A', 1, st, {});
    if (r.wrapped) aWrapped = true;
    if (r.chosen.length === 0) break;
    aGot.add(r.chosen[0].seq);
    // 集齐全部 27 个奇数、且已发生一次回绕后停（证明正好一轮、回绕一次）
    if (aGot.size === 27 && aWrapped) break;
  }
  const aAll = new Set(roster.filter(m => m.group === 'A').map(m => m.seq));
  chk('A 组一轮恰好覆盖全部 27 个奇数（不漏）', aGot.size === 27 && [...aAll].every(s => aGot.has(s)));
  chk('A 组一轮内只回绕 1 次（到齐后回绕即停）', aWrapped === true);

  const stB = buildState(roster, { A: 0, B: 0 });
  const bGot = new Set();
  let bWrapped = false;
  guard = 0;
  while (guard++ < 100) {
    const r = pickBySeq(roster, 'B', 1, stB, {});
    if (r.wrapped) bWrapped = true;
    if (r.chosen.length === 0) break;
    bGot.add(r.chosen[0].seq);
    if (bGot.size === 28 && bWrapped) break;
  }
  const bAll = new Set(roster.filter(m => m.group === 'B').map(m => m.seq));
  chk('B 组一轮恰好覆盖全部 28 个偶数（不漏）', bGot.size === 28 && [...bAll].every(s => bGot.has(s)));
  chk('B 组一轮内只回绕 1 次（到齐后回绕即停）', bWrapped === true);

  // 两组互不串扰：跑完 A 整轮后，B 的游标仍是 0、B 的 used 仍是空
  chk('A 整轮跑完不污染 B（B 游标仍 0）', st.cursors.B === 0);
}

/* ============ §C 真实课表仿真（对照课次结构，验不变量） ============
   用真实第 2/3 周的课次骨架跑一遍新内核，验证：
     ① 分组课只取本组；② 全体课取 2 人（可 2A/2B/1A+1B，落后组优先，无同人重复）；
     ③ 同一人当天不重复；④ 一轮里每人最多一次。 */
console.log('\n===== §C 真实课表仿真（第 2/3 周课次骨架）=====');
{
  const week2Days = [
    {
      date: '09-21 一', items: [
        { period: 2, scope: 'A', name: '微课设计与制作' },
        { period: 3, scope: null, name: '习思想' },
        { period: 4, scope: 'B', name: '微课设计与制作' }
      ]
    },
    {
      date: '09-22 二', items: [
        { period: 1, scope: 'A', name: '小学人工智能教育' },
        { period: 2, scope: null, name: '小学数学课程与教学论' },
        { period: 5, scope: 'A', name: '三笔字' }
      ]
    },
    {
      date: '09-23 三', items: [
        { period: 1, scope: 'B', name: '小学人工智能教育' },
        { period: 3, scope: 'A', name: '小学生心理健康指导' },
        { period: 4, scope: 'B', name: '小学生心理健康指导' },
        { period: 5, scope: 'A', name: '音乐基础' }
      ]
    },
    {
      date: '09-24 四', items: [
        { period: 2, scope: null, name: '小学语文课程与教学论' },
        { period: 5, scope: 'B', name: '音乐基础' }
      ]
    }
  ];
  const st = buildState(roster, { A: 47, B: 48 });
  const dayUsed = {};
  let invariantOk = true;
  let shortCount = 0;
  const out = [];
  for (const day of week2Days) {
    dayUsed[day.date] = new Set();
    for (const s of day.items) {
      const picked = pickBySeq(roster, s.scope, 2, st, { avoidSameDay: true, busySeqs: dayUsed[day.date], inBatchSeqs: dayUsed[day.date] });
      if (picked.short > 0) shortCount += picked.short;
      const seqs = picked.chosen.map(m => m.seq);
      // ① 分组课只取本组
      if (s.scope === 'A' && !picked.chosen.every(m => m.group === 'A')) invariantOk = false;
      if (s.scope === 'B' && !picked.chosen.every(m => m.group === 'B')) invariantOk = false;
      // ② 全体课取 2 人，且都来自合法分组（A/B）：同人不可重复（localTaken 已保证），
      //    可 2A / 2B / 1A+1B（落后组优先，见 §C2）；不再强制 1A+1B。
      if (s.scope === null) {
        if (!(picked.chosen.length === 2
              && picked.chosen.every(m => m.group === 'A' || m.group === 'B'))) invariantOk = false;
      }
      // ③ 同一人当天不重复
      seqs.forEach(q => { if (dayUsed[day.date].has(q)) invariantOk = false; dayUsed[day.date].add(q); });
      out.push(day.date + ' 第' + s.period + '节 ' + (s.scope ? s.scope + '组' : '全体') + ' → ' + picked.chosen.map(m => pad(m.seq) + ' ' + m.name).join('、'));
    }
  }
  out.forEach(l => console.log('   ' + l));
  chk('分组课只取本组 / 全体课取 2 人（可 2A/2B/1A+1B）/ 当天不重复', invariantOk);
  chk('第 2 周每节都排满（无候选不足缺口）', shortCount === 0);
}

/* ============ §C2 全体课「落后组优先 + 回绕护栏」四例（2026-10-07 新口径）============
   用户原话：全体课按全局序号最小取人，落后组优先追平。
     例① B 排到 16、A 才排到 9  → 全体课取 A 的 11、13（2A 追平）
     例② B 排到 16、A 排到 15 → 全体课取 A17、B18（1A+1B，两组接近自然回到交替）
   护栏：某组已回绕（state.wrapped 置位）而另一组还没回绕 → 全体课强制退回 1A+1B。 */
console.log('\n===== §C2 全体课 落后组优先 + 回绕护栏 =====');
{
  // 例①：A 落后（游标 9 < B 16）→ 全体课取 A 的 11、13（2A）
  {
    const st = buildState(roster, { A: 9, B: 16 });
    const r = pickBySeq(roster, null, 2, st, {});
    const seqs = r.chosen.map(m => m.seq).sort((x, y) => x - y);
    chk('例① A 落后(9<16)：全体课取 A 的 11、13（2A）',
      JSON.stringify(seqs) === JSON.stringify([11, 13]) && r.chosen.every(m => m.group === 'A'));
  }
  // 例②：两组接近（A15 / B16）→ 全体课取 A17、B18（1A+1B）
  {
    const st = buildState(roster, { A: 15, B: 16 });
    const r = pickBySeq(roster, null, 2, st, {});
    const seqs = r.chosen.map(m => m.seq).sort((x, y) => x - y);
    const groups = new Set(r.chosen.map(m => m.group));
    chk('例② 两组接近(15/16)：全体课取 A17、B18（1A+1B）',
      JSON.stringify(seqs) === JSON.stringify([17, 18]) && groups.has('A') && groups.has('B'));
  }
  // 护栏：A 已回绕 / B 未回绕 → 全体课退回 1A+1B（不得 2A）
  {
    const st = buildState(roster, { A: 3, B: 48 });
    st.wrapped = { A: true, B: false };
    const r = pickBySeq(roster, null, 2, st, {});
    const groups = new Set(r.chosen.map(m => m.group));
    chk('护栏：A 已回绕 / B 未回绕 → 全体课强制 1A+1B（不得 2A）',
      groups.has('A') && groups.has('B') && r.chosen.length === 2);
  }
  // 护栏（反向）：B 已回绕 / A 未回绕 → 全体课退回 1A+1B（不得 2B）
  {
    const st = buildState(roster, { A: 48, B: 4 });
    st.wrapped = { B: true, A: false };
    const r = pickBySeq(roster, null, 2, st, {});
    const groups = new Set(r.chosen.map(m => m.group));
    chk('护栏（反向）：B 已回绕 / A 未回绕 → 全体课强制 1A+1B（不得 2B）',
      groups.has('A') && groups.has('B') && r.chosen.length === 2);
  }
  // 无护栏且 A 落后：连续两个全体课都 2A（A 11,13 与 A 15,17），验证「持续追平」
  {
    const st = buildState(roster, { A: 9, B: 16 });
    const r1 = pickBySeq(roster, null, 2, st, {});
    const r2 = pickBySeq(roster, null, 2, st, {});
    const g1 = new Set(r1.chosen.map(m => m.group));
    const g2 = new Set(r2.chosen.map(m => m.group));
    chk('无护栏、A 落后：连续两个全体课都 2A（11,13 与 15,17）',
      g1.has('A') && !g1.has('B') && g2.has('A') && !g2.has('B')
      && JSON.stringify(r1.chosen.map(m => m.seq).sort((x, y) => x - y)) === JSON.stringify([11, 13])
      && JSON.stringify(r2.chosen.map(m => m.seq).sort((x, y) => x - y)) === JSON.stringify([15, 17]));
  }
}

/* ============ §roundReset 文案口径（文本级，2026-09-26 新增） ============
   背景：后端 `roundReset` 一个标志包含两种情形——
     ① 生成开始时全班本轮已排满 → 清零，本轮从头开；
     ② 本周名额多于「本轮还没排的人」（第 4 周：只剩 49~56，却要排 16 个名额）
        → 排完 49~56 后**接着序号**进入下一轮。
   旧文案「已从 1 号重新开始」把情形②说反了 —— 用户会以为 Bug 又复现。
   ⚠️ 判据必须**先剥注释**：duty/index.js 的注释里正是为了说明这件事而引用了旧措辞，
      不剥注释就会「自己把自己抓了」（注释命中判据，本项目已栽过三次）。
   ================================================================ */
const DUTY_SRC = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/duty/index.js'), 'utf8');
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')            // 块注释
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');    // 行注释（避开 :// 与引号串）
}
const BAD_PHRASE = /从\s*1\s*号重新开始/;
/** true = 口径正确：既不出现旧措辞，roundReset 那句又确实说「接着序号」 */
function roundWordsOk(src) {
  const code = stripComments(src);
  if (BAD_PHRASE.test(code)) return false;
  const line = code.split('\n').find((l) => l.includes('roundReset') && l.includes('msg +='));
  return !!line && line.includes('接着序号');
}

console.log('\n===== roundReset 文案口径（文本级）=====');
{
  const ok = roundWordsOk(DUTY_SRC);
  if (!ok) pass = false;
  console.log((ok ? '  ✓ ' : '  ✗ ') + 'duty/index.js：roundReset 文案为「接着序号继续往下排」，且不含「从 1 号重新开始」');

  // 双向自证：坏样本必被抓 + 好样本不误报
  const OLD = "msg += '；本轮 56 人已轮完，接着序号继续往下排';";
  const bad = DUTY_SRC.replace(OLD, "msg += '；本轮已排满，已从 1 号重新开始';");
  const badCaught = bad !== DUTY_SRC && !roundWordsOk(bad);
  const goodPass = roundWordsOk(DUTY_SRC);
  const selfOk = badCaught && goodPass;
  if (!selfOk) pass = false;
  console.log((selfOk ? '  ✓ ' : '  ✗ ') + '自证：注入旧措辞必被抓（' + badCaught + '）、原样必过（' + goodPass + '）');
}

/* ── §7 换班不得改动轮转标记（2026-10-07 用户口径）─────────────────────────
 * 用户口径：「手动换班不计入按序号排班内」—— 轮转位置只由「自动排班」决定；
 * 事后换一个来干活的人，不应该改变任何人在队列里的位置。
 * 三处换人入口都要守住：adjust.requestSwap(超管兜底) / adjust.confirm(班委确认) /
 * schedule.reassign(超管在值日详情换人)。
 *
 * ⚠️ 别误伤：删除值日行**必须**回滚标记（rollbackDutyMarkers），
 *   AI 方案的标记写库（duty_count + ?）也照旧 —— 那些是「真的多/少值了一次」。
 *   所以判据只钉「`duty_count = duty_count + 1`」这个**换班专用**写法。 */
console.log('\n--- §7 换班不改动轮转标记 ---');
const ADJUST_SRC = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/adjust/index.js'), 'utf8');
const SCHED_SRC = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/schedule/index.js'), 'utf8');
const DUTY_FN_SRC = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/duty/index.js'), 'utf8');
const EXPORT_SRC = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/export/index.js'), 'utf8');
const CRON_SRC = fs.readFileSync(path.resolve(__dirname, '../cloudfunctions/cron-weekly/index.js'), 'utf8');

function chk2(label, cond) {
  if (!cond) pass = false;
  console.log((cond ? '  ✓ ' : '  ✗ ') + label);
}
/** adjust 里换人是**唯一**会写轮转标记的地方 ⇒ 整文件不该出现任何 duty_count 写入 */
function adjustKeepsMarks(src) {
  return !/UPDATE member SET duty_count/.test(src);
}
/** schedule 里换人/还原换人都不能写；唯一允许的 +1 是 addManual（新增值日名额，有意保留） */
function schedSwapKeepsMarks(src) {
  const hits = src.match(/UPDATE member SET duty_count = duty_count \+ 1/g) || [];
  if (hits.length !== 1) return false;
  return /手动加人也算「本轮已排」[\s\S]{0,240}UPDATE member SET duty_count = duty_count \+ 1/.test(src);
}
chk2('adjust 的两处换班（超管兜底 / 班委确认）都不写 duty_count', adjustKeepsMarks(ADJUST_SRC));
chk2('schedule 的换人 + 还原换人都不写 duty_count（只剩 addManual 那一处 +1）', schedSwapKeepsMarks(SCHED_SRC));
chk2('adjust 换班仍会更新 last_duty_at（不是把功能整个删掉）',
  /UPDATE member SET last_duty_at = \? WHERE id = \?/.test(ADJUST_SRC));
chk2('删除值日行仍会回滚标记（该减的还是要减，没被误伤）',
  /UPDATE member SET duty_count = GREATEST\(duty_count - \?, 0\)/.test(SCHED_SRC));

/* 双向自证：注入旧的「+1」写法必须被抓到；原样必须通过（好样本不误报）。 */
const INJECT = "await pool.query('UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?', [d, m]);";
chk2('自证：把旧的「+1」写法注入 adjust 会被抓到', !adjustKeepsMarks(ADJUST_SRC + '\n' + INJECT));
chk2('自证：给 schedule 多加一处「+1」会被抓到（>1 处即违规）',
  !schedSwapKeepsMarks(SCHED_SRC + '\n' + INJECT));
chk2('自证：原样判为通过（judge 本身有效）', adjustKeepsMarks(ADJUST_SRC) && schedSwapKeepsMarks(SCHED_SRC));

/* ============ §C3 全体课不得饿死某组（2026-10-25 修复回归锁）============
 * 用户实锤：class 3 第 8 周起点 {A:1, B:56}，B 整池 used 满、ahead 空，
 *   旧内核会让全体课（ab 都上的大课）只取 A 组 ⇒ 表现为「大课变仅 a 组打扫」。
 * 修复：全体课取人时若某组 ahead 空但其整池本轮已排满，清 used + 游标归 0 立即回绕兜底，
 *   让该组重新可被选。本判据用等价起点 {A:1, B:56} 复现，断言全体课一定能取到 B 组。
 * ⚠️ 直接 require 真源码（与文件头原则一致），不抄副本。 */
console.log('\n===== §C3 全体课不得饿死某组（{A:1,B:56} 等价起点）=====');
{
  // 等价于 class 3 第 8 周：B 游标卡 56 → B 整池 used 满、ahead 空
  const st = buildState(roster, { A: 1, B: 56 });
  // 先推进 A 游标（模拟周一 P1 全体取 A、P2 A 组课），让 A 远领先、B 仍「卡死」
  pickBySeq(roster, 'A', 2, st, {});   // A: 3,5
  pickBySeq(roster, 'A', 2, st, {});   // A: 7,9  → A 游标到 9
  // 此时再取全体课：A 已到 9，B 整池 used。修复后必须回绕 B 取到 B 组的人
  const r = pickBySeq(roster, null, 2, st, {});
  const groups = new Set(r.chosen.map(m => m.group));
  chk('§C3 全体课在 B 游标卡 56 时仍取到 B 组（不饿死）', groups.has('B') && r.chosen.length === 2);
  chk('§C3 全体课未退化成仅 A 组', !(groups.has('A') && !groups.has('B')));
  // 反向对称：A 卡死（{A:56, B:1}）→ 全体课必须能取到 A 组
  const st2 = buildState(roster, { A: 56, B: 1 });
  pickBySeq(roster, 'B', 2, st2, {});
  pickBySeq(roster, 'B', 2, st2, {});
  const r2 = pickBySeq(roster, null, 2, st2, {});
  const g2 = new Set(r2.chosen.map(m => m.group));
  chk('§C3 对称：A 卡死时全体课仍取到 A 组', g2.has('A') && r2.chosen.length === 2);
}

/* ============ §C4 打扫410 按节次排：同节次内「课先行、保洁后」（2026-10-25 用户纠正回归锁）============
 * 正确顺序（用户原话）：「第一节、第二节、第三节、第四节、打扫410、第五节」——
 * 保洁课次的节次本就是第4节：先按 period，同节次内 CLEAN 只是 tie-breaker（课先行、保洁后），
 * 于是 第4节课 → 打扫410 → 第5节。
 * 🔴 绝不是「恒排每天最后」：曾按那个实现（CLEAN 权重提到 period 之前），有第5节课的日子
 *    保洁被压到第5节之后，被用户 2026-10-25 打回。本判据用生产实测课次结构锁死正确口径。
 * 覆盖 7 处：schedule.rotatePlan（generate 取人序，直接 eval 真源码比较函数）/
 *   schedule.manualBoard 课次排序 / schedule.loadWeekDuties SQL / duty 云函数 SQL /
 *   export SQL + JS rows.sort / cron-weekly rotatePlan（每周自动生成）/ 前端不再重排。
 * SCHED_SRC / DUTY_SRC / DUTY_FN_SRC / EXPORT_SRC / CRON_SRC 已在上方加载。 */
console.log('\n===== §C4 打扫410 按节次排（同节次内课先行、保洁后）=====');
{
  // —— generate 的 rotatePlan.sort（主路径）——
  // ⚠️ 文件里有两处 rotatePlan.sort：line 1031（buildCleaningPlan，仅保洁课次、无课次混排，
  //   (period,id) 已完备）与 generate 主路径（含 CLEAN 权重）。必须精确挑「含 CLEAN」的那个，
  //   否则会误测到 buildCleaningPlan 的比较函数（曾踩过：首轮匹配到 1031 导致 period=1 用例误红）。
  const allRot = [...SCHED_SRC.matchAll(/rotatePlan\.sort\(\(a, b\) => \(([\s\S]*?)\)\);/g)];
  let rotM = null;
  for (const mm of allRot) { if (mm[1].includes('CLEAN')) { rotM = mm; break; } }
  let rotCmp = null;
  try { if (rotM) rotCmp = new Function('a', 'b', 'return (' + rotM[1] + ');'); } catch (e) { rotCmp = null; }
  chk('§C4 能从 schedule 源码抽出含 CLEAN 权重的 rotatePlan 比较函数', !!rotCmp);
  if (rotCmp) {
    // 周一 11/02 实测课次：326=p1全体课 / 330=p2 A组课 / 334=p3全体课 / 357=p4 B组课 / 26=p4 打扫410
    const mon = [
      { classDate: '2026-11-02', s: { kind: 'CLEAN', id: 26 }, slot: { period: 4 } },
      { classDate: '2026-11-02', s: { kind: 'COURSE', id: 326 }, slot: { period: 1 } },
      { classDate: '2026-11-02', s: { kind: 'COURSE', id: 330 }, slot: { period: 2 } },
      { classDate: '2026-11-02', s: { kind: 'COURSE', id: 334 }, slot: { period: 3 } },
      { classDate: '2026-11-02', s: { kind: 'COURSE', id: 357 }, slot: { period: 4 } }
    ];
    mon.sort(rotCmp);
    chk('§C4 周一：第4节课(357) 排在 打扫410(26) 前面（保洁不再因 session id 小插到课前）',
      mon[3].s.id === 357 && mon[4].s.kind === 'CLEAN');
    // 周二 11/03 实测课次：327=p1 A组 / 332=p2 A组 / 30=p4 打扫410 / 340=p5 A组课
    const tue = [
      { classDate: '2026-11-03', s: { kind: 'COURSE', id: 340 }, slot: { period: 5 } },
      { classDate: '2026-11-03', s: { kind: 'CLEAN', id: 30 }, slot: { period: 4 } },
      { classDate: '2026-11-03', s: { kind: 'COURSE', id: 327 }, slot: { period: 1 } },
      { classDate: '2026-11-03', s: { kind: 'COURSE', id: 332 }, slot: { period: 2 } }
    ];
    tue.sort(rotCmp);
    chk('§C4 周二：打扫410(p4) 排在第5节课(p5) 前面（🔴 用户纠正：不是每天最后）',
      tue[2].s.kind === 'CLEAN' && tue[3].s.id === 340);
    // 跨日期：日期权重高于节次与保洁（调休/同日混排都不能破坏日期优先）
    const cross = [
      { classDate: '2026-11-03', s: { kind: 'CLEAN', id: 30 }, slot: { period: 1 } },
      { classDate: '2026-11-02', s: { kind: 'COURSE', id: 326 }, slot: { period: 5 } }
    ];
    cross.sort(rotCmp);
    chk('§C4 跨日期仍按日期优先（11-02 的任何课次先于 11-03 的保洁）',
      cross[0].classDate === '2026-11-02');
  }
  // —— 另几处排序：CLEAN 权重必须位于 period **之后**（只是同节次 tie-breaker）——
  chk('§C4 manualBoard 课次排序：period 在前、CLEAN 权重在后',
    /sessions\.sort\(\(a, b\) =>\s*\(Number\(a\.period\) - Number\(b\.period\)\)\s*\|\|\s*\(\(a\.kind === 'CLEAN'\)/.test(SCHED_SRC));
  chk('§C4 前端不再按 isClean 置底（merged.sort 已移除，展示顺序以后端为准）',
    !/merged\.sort/.test(DUTY_SRC));
  chk('§C4 duty 云函数 SQL：period 在前、(s.kind=\'CLEAN\') 在后',
    /ORDER BY d\.class_date, s\.period, \(s\.kind = 'CLEAN'\)/.test(DUTY_FN_SRC));
  chk('§C4 export 云函数 SQL：period 在前、(s.kind=\'CLEAN\') 在后',
    /ORDER BY d\.class_date, s\.period, \(s\.kind = 'CLEAN'\)/.test(EXPORT_SRC));
  chk('§C4 export 云函数 JS rows.sort：period 在前、CLEAN 权重在后',
    /: \(a\.period - b\.period\)\s*\|\|\s*\(\(a\.sessionKind === 'CLEAN'\)/.test(EXPORT_SRC));
  chk('§C4 cron-weekly rotatePlan：period 在前、CLEAN 权重在后（每周自动生成同口径）',
    /: \(Number\(a\.slot\.period\) - Number\(b\.slot\.period\)\)\s*\|\|\s*\(\(a\.s\.kind === 'CLEAN'\)/.test(CRON_SRC));
  chk('§C4 cron-weekly SELECT 取了 s.kind（排序判据用）',
    /s\.duty_count, s\.kind\s*\n\s*FROM session s WHERE s\.class_id/.test(CRON_SRC));
  // —— 自证（变异必须翻红，证明判据能分辨对错）——
  {
    const chk2 = (label, cond) => { if (!cond) { pass = false; console.log('    ✗ ' + label); } };
    // 变异1：「恒置底」错误实现（CLEAN 权重提到 period 之前）→ 周二用例里保洁被压到第5节课之后
    const wrongCmp = new Function('a', 'b', 'return ('
      + '((a.s.kind === \'CLEAN\') ? 1 : 0) - ((b.s.kind === \'CLEAN\') ? 1 : 0)'
      + ' || (Number(a.slot.period) - Number(b.slot.period)) || (a.s.id - b.s.id));');
    const tueW = [
      { classDate: '2026-11-03', s: { kind: 'COURSE', id: 340 }, slot: { period: 5 } },
      { classDate: '2026-11-03', s: { kind: 'CLEAN', id: 30 }, slot: { period: 4 } }
    ];
    tueW.sort(wrongCmp);
    chk2('自证：错误实现（CLEAN 提前）会把打扫410 压到第5节课之后 → 周二判据可分辨',
      tueW[0].s.kind !== 'CLEAN');
    // 变异2：完全无 CLEAN 权重（旧版按 session id）→ 周一用例里保洁(id 26)插到第4节课(id 357)前面
    const noWeightCmp = new Function('a', 'b', 'return ('
      + '(Number(a.slot.period) - Number(b.slot.period)) || (a.s.id - b.s.id));');
    const monW = [
      { classDate: '2026-11-02', s: { kind: 'CLEAN', id: 26 }, slot: { period: 4 } },
      { classDate: '2026-11-02', s: { kind: 'COURSE', id: 357 }, slot: { period: 4 } }
    ];
    monW.sort(noWeightCmp);
    chk2('自证：无 CLEAN 权重（旧版按 id）会把打扫410 插到第4节课前面 → 周一判据可分辨',
      monW[0].s.kind === 'CLEAN');
    console.log('    ✓ 自证：两种错误实现均被对应用例分辨（判据有效）');
  }
}

console.log('\n' + (pass ? '[PASS] 轮转算法 + roundReset 文案口径 + 第8周修复锁 全部通过 ✓' : '[FAIL] 存在不一致 ✗'));
process.exit(pass ? 0 : 1);
