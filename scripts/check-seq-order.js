/**
 * 自检：值日配对的「序号顺序」（2026-09-24 用户报告后新增）
 * ------------------------------------------------------------
 * 用户反馈原话：
 *   「为什么示例成员50和示例成员52是50号和52号，在周一第四节就排到了。」
 *
 * 事实：那次 AI 挑的人**是对的** —— A 组用了最小的 10 个可用号、B 组用了最小的 14 个，
 * 24 个名额两两不重复。错的只是「人 ↔ 课次」的配对顺序：模型把 B 组最后两个号
 * （50 示例成员50、52 示例成员52）配给了最早的 B 组课（周一第 4 节），把 46、48 放到了最晚的周四第 5 节。
 *
 * 定稿的语义（用户选择「本地强制按课次顺序」）：
 *   **AI 只决定「哪些课次不动」和「哪些人本轮跳过」；「谁配到哪节课」由本地按
 *   「日期 + 节次」的先后顺序取最小可用号决定。**
 *
 * 本脚本断言：
 *   §1 用户原案例（真实第 2 周课表 + 真实名册 + 那次 AI 的真实输出）→ 周一第 4 节必须是 30、32
 *   §2 第 1~6 周真实课表：同一 groupScope 的课次按时间排序后序号区间严格递增、无重复
 *   §3 unchanged / skipSeqs 仍然生效
 *   §4 代码卫生：validatePlan 里不得再拿 AI 的 memberSeqs 做配对
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/schedule/index.js'), 'utf8');

// 新内核：validatePlan 依赖模块级 pickBySeq / buildState（轮转游标），必须注入
const RR_PATH = path.resolve(ROOT, 'cloudfunctions/common/round-robin');
const { pickBySeq, buildState } = require(RR_PATH);

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('PASS  ' + name + (extra ? '   → ' + extra : '')); }
  else { fail += 1; console.log('FAIL  ' + name + (extra ? '   → ' + extra : '')); }
}

function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}
const validatePlan = new Function('pickBySeq', 'buildState', extractFn('validatePlan') + '\n return validatePlan;')(pickBySeq, buildState);

/* ---------------- 真实名册（2026-09-24 从库导出，56 人，奇=A 偶=B） ---------------- */
const ROSTER_TEXT = `01 示例成员01 A|02 示例成员02 B|03 示例成员03 A|04 示例成员04 B|05 示例成员05 A|06 示例成员06 B|
07 示例成员07 A|08 示例成员08 B|09 示例成员09 A|10 示例成员10 B|11 示例成员11 A|12 示例成员12 B|13 示例成员13 A|14 示例成员14 B|
15 示例成员15 A|16 示例成员16 B|17 示例成员17 A|18 示例成员18 B|19 示例成员19 A|20 示例成员20 B|21 示例成员21 A|22 示例成员22 B|
23 示例成员23 A|24 示例成员24 B|25 示例成员25 A|26 示例成员26 B|27 示例成员27 A|28 示例成员28 B|29 示例成员29 A|30 示例成员30 B|
31 示例成员31 A|32 示例成员32 B|33 示例成员33 A|34 示例成员34 B|35 示例成员35 A|36 示例成员36 B|37 示例成员37 A|38 示例成员38 B|
39 示例成员39 A|40 示例成员40 B|41 示例成员41 A|42 示例成员42 B|43 示例成员43 A|44 示例成员44 B|45 示例成员45 A|46 示例成员46 B|
47 示例成员47 A|48 示例成员48 B|49 示例成员49 A|50 示例成员50 B|51 示例成员51 A|52 示例成员52 B|53 示例成员53 A|54 示例成员54 B|
55 示例成员55 A|56 示例成员56 B`;

const SEQ_NAME = new Map();
const SEQ_GROUP = new Map();
function buildRoster(roundUsedSeqs) {
  const used = new Set(roundUsedSeqs || []);
  const roster = [];
  ROSTER_TEXT.split('|').forEach((chunk) => {
    const m = chunk.trim().match(/^(\d\d)\s+(\S+?)\s+([AB])$/);
    if (!m) return;
    const seq = Number(m[1]);
    SEQ_NAME.set(seq, m[2]);
    SEQ_GROUP.set(seq, m[3]);
    roster.push({ seq, name: m[2], group: m[3], dutyCountThisRound: used.has(seq) ? 1 : 0, lastDutyAt: null });
  });
  if (roster.length !== 56) throw new Error('名册应为 56 人，实际 ' + roster.length);
  return roster;
}
const baseRoster = buildRoster([]);
const pad2 = n => (n < 10 ? '0' + n : String(n));
const usedSeqs = plan => {
  const out = new Set();
  plan.forEach(p => p.memberSeqs.forEach(q => out.add(q)));
  return out;
};
const isDupFree = plan => {
  const seen = new Set();
  for (const p of plan) {
    for (const q of p.memberSeqs) { if (seen.has(q)) return false; seen.add(q); }
  }
  return true;
};
// 按 (date, period) 排序的课次顺序
const chrono = plan => plan.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));

/* ============================================================
 * §1 用户原案例
 * ============================================================ */
console.log('\n=== §1 用户那次生成（真实第 2 周课表） ===');

const D = { 1: '2026-09-21', 2: '2026-09-22', 3: '2026-09-23', 4: '2026-09-24' };
// 第 2 周（09-21 ~ 09-24）真实课次；周五 09-25 是中秋节，不上课
const WEEK2 = [
  { sessionId: 2, d: 1, period: 2, scope: 'A', course: '微课设计与制作' },
  { sessionId: 5, d: 1, period: 3, scope: null, course: '习近平新时代中国特色社会主义思想概论' },
  { sessionId: 3, d: 1, period: 4, scope: 'B', course: '微课设计与制作' },
  { sessionId: 8, d: 2, period: 1, scope: 'A', course: '小学人工智能教育' },
  { sessionId: 10, d: 2, period: 2, scope: null, course: '小学数学课程与教学论' },
  { sessionId: 22, d: 2, period: 5, scope: 'A', course: '三笔字' },
  { sessionId: 9, d: 3, period: 1, scope: 'B', course: '小学人工智能教育' },
  { sessionId: 13, d: 3, period: 3, scope: 'A', course: '小学生心理健康指导' },
  { sessionId: 14, d: 3, period: 4, scope: 'B', course: '小学生心理健康指导' },
  { sessionId: 15, d: 3, period: 5, scope: 'A', course: '音乐基础' },
  { sessionId: 17, d: 4, period: 2, scope: null, course: '小学语文课程与教学论' },
  { sessionId: 16, d: 4, period: 5, scope: 'B', course: '音乐基础' }
];
const week2Sessions = WEEK2.map(s => ({
  sessionId: s.sessionId, date: D[s.d], dayOfWeek: s.d, dayText: '周' + '一二三四'[s.d - 1],
  period: s.period, course: s.course, room: '', groupScope: s.scope, dutyCount: 2,
  existingDutySeqs: [], busySameDaySeqs: [], onLeaveSeqs: []
}));
const week2Ctx = {
  cfg: {}, roster: baseRoster, sessions: week2Sessions,
  seqById: new Map(), idBySeq: new Map(baseRoster.map(r => [r.seq, 100 + r.seq])),
  weekStart: D[1],
  // 轮转游标初值：A/B 都从 0 开始；「1~24 已排过」由 raw.skipSeqs 表达，内核会跳过
  state: buildState(baseRoster, { A: 0, B: 0 })
};

// 用户那句话 = A 组 ≤23 且 B 组 ≤24 → 合起来正好 1..24
const SKIP_1_24 = [];
for (let i = 1; i <= 24; i++) SKIP_1_24.push(i);
// 那次 AI 的真实输出（从用户截图逐行抄录）
const AI_RAW_CASE = {
  assignments: [
    { sessionId: 2, memberSeqs: [25, 27] },
    { sessionId: 5, memberSeqs: [26, 28] },
    { sessionId: 3, memberSeqs: [50, 52] },   // ← 问题就出在这一行
    { sessionId: 8, memberSeqs: [29, 31] },
    { sessionId: 10, memberSeqs: [30, 32] },
    { sessionId: 22, memberSeqs: [33, 35] },
    { sessionId: 9, memberSeqs: [34, 36] },
    { sessionId: 13, memberSeqs: [37, 39] },
    { sessionId: 14, memberSeqs: [38, 40] },
    { sessionId: 15, memberSeqs: [41, 43] },
    { sessionId: 17, memberSeqs: [42, 44] },
    { sessionId: 16, memberSeqs: [46, 48] }
  ],
  unchanged: [], skipSeqs: SKIP_1_24, notes: 'A、B 组分别从 25 / 26 号接着往后排'
};
const v1 = validatePlan(week2Ctx, AI_RAW_CASE);
const row = sid => v1.plan.find(p => p.sessionId === sid);
const fmtRow = sid => {
  const p = row(sid);
  return p.date.slice(5) + ' ' + p.dayText + '第' + p.period + '节  '
    + p.memberSeqs.map(q => pad2(q) + ' ' + SEQ_NAME.get(q)).join('、');
};

check('12 个课次全部排满', v1.plan.length === 12 && v1.plan.every(p => p.memberSeqs.length === p.dutyCount),
  v1.plan.length + ' 个');
check('24 个名额两两不同（无重复）', isDupFree(v1.plan));
/**
 * §1 核心原则（用户 2026-09-24 的诉求）：配对由「日期 + 节次」的先后顺序决定，
 * 同一组的号**一路往后排**——早期课次必然是较小的号，最晚的课次才是最大的号。
 * 之前被吐槽的「周一第4节就排到 50、52（示例成员50、示例成员52）」就是把这个原则搞反了。
 *
 * ⚠️ 不写死绝对号：新内核（pickBySeq + 独立 A/B 游标）下，周一第3节（全体课）会先取走最小的 B 组号（26），
 * 所以周一第4节（B 组课）拿到的是 28、30 这类「次小」号——这仍然正确（早期=小号）。
 * 这里断言「原则」而非具体数字，既能抓住「早期排到大号」的原始 bug，又不与游标实现绑死。
 */
const b3 = row(3).memberSeqs;
const b16 = row(16).memberSeqs;
const allB = v1.plan
  .filter(p => p.groupScope === 'B' || p.groupScope === null)
  .flatMap(p => p.memberSeqs.filter(q => SEQ_GROUP.get(q) === 'B'));
const maxB = Math.max.apply(null, allB);
check('周一第4节（B 组课）取到的是较小号，不再是 50、52 这种早期大号',
  Math.max.apply(null, b3) < Math.max.apply(null, b16), fmtRow(3) + '  vs  ' + fmtRow(16));
check('最大的 B 组号落在最晚的课次（周四第5节），而非早期课次',
  Math.max.apply(null, b16) === maxB && Math.max.apply(null, b3) < maxB,
  '周四第5节最大=' + Math.max.apply(null, b16) + '，全计划最大 B=' + maxB);
check('A 组课全部是 A 组的人', v1.plan.filter(p => p.groupScope === 'A')
  .every(p => p.memberSeqs.every(q => SEQ_GROUP.get(q) === 'A')));
check('B 组课全部是 B 组的人', v1.plan.filter(p => p.groupScope === 'B')
  .every(p => p.memberSeqs.every(q => SEQ_GROUP.get(q) === 'B')));
check('被跳过的人（1~24 号）一个都没排上',
  Array.from(usedSeqs(v1.plan)).every(q => SKIP_1_24.indexOf(q) < 0));
check('告警解释了「AI 建议的号没被采用」',
  v1.warnings.some(w => w.indexOf('已按序号顺序重新配对') >= 0),
  (v1.warnings.find(w => w.indexOf('已按序号顺序重新配对') >= 0) || '').slice(0, 40) + '…');
check('不再出现「AI 漏排」这种已经不适用的告警',
  !v1.warnings.some(w => w.indexOf('AI 漏排') >= 0));

console.log('\n  实际产出：');
chrono(v1.plan).forEach((p) => {
  console.log('    ' + p.date.slice(5) + ' ' + p.dayText + '第' + p.period + '节  '
    + (p.groupScope ? p.groupScope + ' 组课' : '全体课 ')
    + '  ' + p.memberSeqs.map(q => pad2(q) + ' ' + SEQ_NAME.get(q)).join('、'));
});

/* ---- 幂等性：把结果再喂回去（这正是 aiApply 做的事）必须一字不变 ---- */
// 复位游标：validatePlan 会就地推进 ctx.state，二次校验须用初始游标（与「预览==落库」语义一致）
week2Ctx.state = buildState(baseRoster, { A: 0, B: 0 });
const again = validatePlan(week2Ctx, {
  assignments: v1.plan.map(p => ({ sessionId: p.sessionId, memberSeqs: p.memberSeqs })),
  unchanged: [], skipSeqs: SKIP_1_24, notes: ''
});
check('幂等：预览再校验一次结果完全一致（预览 == 落库）',
  JSON.stringify(again.plan) === JSON.stringify(v1.plan));

/* ============================================================
 * §2 第 1~6 周真实课表：顺序性质
 * ============================================================ */
console.log('\n=== §2 第 1~6 周真实课表：同一组的号必须一路递增 ===');

// 从 miniprogram/data/timetable.js 取真实课表种子
const TT = fs.readFileSync(path.join(ROOT, 'miniprogram/data/timetable.js'), 'utf8');
const seedText = TT.slice(TT.indexOf('const SEED_SESSIONS = ['), TT.indexOf('];', TT.indexOf('const SEED_SESSIONS = [')) + 2);
const SEED_SESSIONS = new Function(seedText + '\n return SEED_SESSIONS;')();
const holText = TT.slice(TT.indexOf('const SEED_HOLIDAYS = ['), TT.indexOf('];', TT.indexOf('const SEED_HOLIDAYS = [')) + 2);
const SEED_HOLIDAYS = new Function(holText + '\n return SEED_HOLIDAYS;')();
const OFF = new Set(SEED_HOLIDAYS.filter(h => h.kind === 'OFF').map(h => String(h.date).slice(0, 10)));
const TERM_START = '2026-09-14';

function dateOfWeekDay(week, dow) {
  const p = TERM_START.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setDate(d.getDate() + (week - 1) * 7 + (dow - 1));
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function matchesWeeks(weeks, wk) {
  const s = String(weeks || '').trim();
  if (!s) return true;
  return s.split(',').some(x => Number(x) === Number(wk));
}
function sessionsOfWeek(wk) {
  const out = [];
  SEED_SESSIONS.forEach((s) => {
    if (!matchesWeeks(s.weeks, wk)) return;
    const date = dateOfWeekDay(wk, s.day);
    if (OFF.has(date)) return;                       // 法定放假当天不上课
    out.push({
      sessionId: s.id, date, dayOfWeek: s.day, dayText: '周' + '一二三四五六日'[s.day - 1],
      period: s.period, course: s.name, room: s.room, groupScope: s.group || null,
      dutyCount: 2, existingDutySeqs: [], busySameDaySeqs: [], onLeaveSeqs: []
    });
  });
  return out;
}

// 先用第 2 周核对 helper：必须和 §1 里那份手工核对的真实列表一致
const w2 = sessionsOfWeek(2);
check('helper 生成的第 2 周课表与手工核对的真实列表一致',
  w2.length === 12 && w2.map(s => s.sessionId).sort((a, b) => a - b).join(',')
    === WEEK2.map(s => s.sessionId).sort((a, b) => a - b).join(','),
  w2.length + ' 个课次');

/**
 * 顺序性质：A、B 两组各自独立轮转（用户拍板），所以「不回头」应按**真实组别**校验 ——
 * 把每个序号按 A/B 归类，再分别按时间先后检查严格递增。
 * ⚠️ 不能把全体课（scope=null，每节 1A+1B）混进一个桶做全局递增：A、B 是两条独立游标，
 * 当 A/B 课次数量不等时会错位（如某节 B 取到 16、上一节 A 取到 17），但各组内部仍严格递增。
 */
function seqMonotonic(plan) {
  const groups = { A: [], B: [] };
  chrono(plan).forEach((p) => {
    p.memberSeqs.forEach(q => {
      const g = SEQ_GROUP.get(q);
      if (g === 'A' || g === 'B') groups[g].push({ seq: q, session: p });
    });
  });
  for (const key of ['A', 'B']) {
    const arr = groups[key];
    for (let i = 1; i < arr.length; i++) {
      if (!(arr[i].seq > arr[i - 1].seq)) {
        return { ok: false, key, at: arr[i].session, prevMax: arr[i - 1].seq, curMin: arr[i].seq };
      }
    }
  }
  return { ok: true };
}

const SIX = [];
for (let wk = 1; wk <= 6; wk++) {
  const sessions = sessionsOfWeek(wk);
  if (!sessions.length) continue;
  const ctx = {
    cfg: {}, roster: buildRoster([]), sessions,
    seqById: new Map(), idBySeq: new Map(baseRoster.map(r => [r.seq, 100 + r.seq])),
    weekStart: sessions[0].date,
    state: buildState(buildRoster([]), { A: 0, B: 0 })
  };
  const v = validatePlan(ctx, { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
  const mono = seqMonotonic(v.plan);
  const used = Array.from(usedSeqs(v.plan)).sort((a, b) => a - b);
  SIX.push({ wk, count: v.plan.length, used });
  check('第 ' + wk + ' 周：' + v.plan.length + ' 个课次无重复', isDupFree(v.plan));
  check('第 ' + wk + ' 周：同一组的号一路递增（不回头）', mono.ok,
    mono.ok ? '最大号 ' + Math.max.apply(null, used)
      : mono.key + ' 组「' + mono.at.dayText + '第' + mono.at.period + '节」拿了 ' + mono.curMin
        + '，比前一节的 ' + mono.prevMax + ' 还小');
}

console.log('\n  1~6 周实际用到的号：');
SIX.forEach(x => console.log('    第 ' + x.wk + ' 周（' + x.count + ' 节 · ' + (x.used.length) + ' 人）: '
  + x.used.map(pad2).join(',')));

/* ============================================================
 * §3 unchanged / skipSeqs 仍然生效
 * ============================================================ */
console.log('\n=== §3 「保持原样」与「本轮跳过」仍然生效 ===');

const ctx3 = {
  cfg: {}, roster: buildRoster([]), sessions: sessionsOfWeek(4),
  seqById: new Map(), idBySeq: new Map(baseRoster.map(r => [r.seq, 100 + r.seq])),
  weekStart: sessionsOfWeek(4)[0].date,
  state: buildState(buildRoster([]), { A: 0, B: 0 })
};
// 先造一批「已存在的值日」给 unchanged 用
const seed = validatePlan(ctx3, { assignments: [], unchanged: [], skipSeqs: [], notes: '' });
const firstFour = seed.plan.slice(0, 4).map(p => p.sessionId);
ctx3.sessions.forEach((s) => {
  if (firstFour.indexOf(s.sessionId) >= 0) {
    const p = seed.plan.find(x => x.sessionId === s.sessionId);
    s.existingDutySeqs = p.memberSeqs.slice();
    s.busySameDaySeqs = [];
  }
});
// 复位游标：上面的 seed 调用已就地推进 ctx3.state，v3 须用初始游标（否则会从上次推进后的位置续排）
ctx3.state = buildState(ctx3.roster, { A: 0, B: 0 });
const v3 = validatePlan(ctx3, {
  assignments: [{ sessionId: ctx3.sessions[0].sessionId, memberSeqs: [1, 2] }],
  unchanged: firstFour,
  skipSeqs: [5, 7, 9],
  notes: ''
});
check('unchanged 的课次原样保留（人没被换掉）',
  firstFour.every(sid => {
    const a = seed.plan.find(x => x.sessionId === sid).memberSeqs;
    const b = v3.plan.find(x => x.sessionId === sid).memberSeqs;
    return String(a) === String(b);
  }), firstFour.join(','));
check('unchanged 的课次被标记 kept',
  firstFour.every(sid => v3.plan.find(x => x.sessionId === sid).kept === true));
check('skipSeqs 的人一个都没排进「新排」的课次',
  [5, 7, 9].every(q => v3.plan.filter(p => !p.kept).every(p => p.memberSeqs.indexOf(q) < 0)),
  // 「保持原样」的课次不受 skipSeqs 影响：那是使用者明确说「这块不动」的，原样保留
  'kept 课次里的人 = ' + v3.plan.filter(p => p.kept)
    .reduce((a, p) => a.concat(p.memberSeqs), []).sort((a, b) => a - b).map(pad2).join(','));
check('unchanged 占了名额：后面课次不会再用他们',
  firstFour.every(sid => {
    const a = seed.plan.find(x => x.sessionId === sid).memberSeqs;
    return a.every(q => v3.plan.filter(p => firstFour.indexOf(p.sessionId) < 0)
      .every(p => p.memberSeqs.indexOf(q) < 0));
  }));
check('告警里说明「有 N 个课次保持原样」',
  v3.warnings.some(w => w.indexOf('保持原样') >= 0));

/* ============================================================
 * §4 代码卫生
 * ============================================================ */
console.log('\n=== §4 代码卫生 ===');
const body = extractFn('validatePlan');
check('validatePlan 里不再按 AI 的人选配课次（没有 itemBySession）',
  body.indexOf('itemBySession') < 0);
check('validatePlan 里不再有「回头点本轮已排过的人」那套 hasFresh 判断',
  body.indexOf('hasFresh') < 0);
check('存在「按课次时间先后取号」的第二轮遍历',
  /ordered\.forEach\(\(s\) => \{\s*\n\s*if \(keptIds\.has\(s\.sessionId\)\) return;/.test(body));
check('没有任何「AI 漏排…补齐」的旧告警文案', body.indexOf('AI 漏排') < 0);

/* ============================================================
 * §5 文档同步：说明文档里嵌的提示词必须与源码逐字一致
 * ============================================================ */
console.log('\n=== §5 文档同步 ===');
const DOC = path.join(ROOT, 'docs/AI 一键生成值日表-提示词与配置说明.md');
const docText = fs.readFileSync(DOC, 'utf8');

// 从源码里还原 DEFAULT_AI_PROMPT 的字符串（去掉每行的引号与逗号）
const pStart = SRC.indexOf('const DEFAULT_AI_PROMPT = [') + 'const DEFAULT_AI_PROMPT = ['.length;
const pEnd = SRC.indexOf("].join('\\n');", pStart);
const promptText = SRC.slice(pStart, pEnd).split('\n')
  .map(x => x.trim()).filter(x => x.startsWith("'"))
  .map(x => x.slice(1, x.lastIndexOf("'"))).join('\n');

const block = docText.slice(docText.indexOf('```text') + 7, docText.indexOf('```', docText.indexOf('```text') + 7));
check('说明文档里嵌的默认提示词与源码逐字一致',
  block.trim() === promptText.trim(),
  '文档 ' + block.trim().length + ' 字 / 源码 ' + promptText.trim().length + ' 字');
check('文档写明「配对由程序决定」这一设计原则',
  docText.indexOf('谁配到哪节课次') >= 0 && docText.indexOf('按课次先后顺序取最小序号') >= 0);
check('文档不再宣传已下线的 4 个示例 chip',
  docText.indexOf('当前预置的 4 个 chip') < 0);
check('文档标注了不支持「周三第一节多安排 1 人」这类说法',
  docText.indexOf('多安排 1 人') >= 0 && docText.indexOf('不支持的写法') >= 0);

/* ---------------- 汇总 ---------------- */
console.log('\n' + (fail === 0 ? '全部通过 ✅' : '有 ' + fail + ' 项未通过 ❌') + '   （' + pass + ' 项通过）');
if (fail) process.exitCode = 1;
