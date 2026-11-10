#!/usr/bin/env node
/**
 * 门禁：调课后值日必须随课同步（2026-11-11 用户口径「整批搬到目标格」）
 * ============================================================================
 * 用户原话：「课程表调课后，值日应同步调整，例如 B 组周一下午第四节是 56 号和 2 号
 * 打扫卫生，但是课程调整到周三下午第四节了，应将对应的值日页同步调整。」
 *
 * 2026-11-11 用户拍板口径：**跨周调课也把源周未值日的值日整批搬到目标周目标格
 * （人不变）**；已过日期 / 带 duty_log 的历史行保留不动，不搬不删。
 *
 * 事故形态：`syncDutyForShift()` 的 `toWk` 通道 + `shiftRemove()` 的跨周逆向**早就写好**，
 * 但 `shiftSet` 唯一调用点写的是 `crossWeek ? 'OFF' : kind` 且从不传第 8 参 ⇒
 * 跨周 MOVE 一律删源周值日、目标周不建行，用户看到的就是「课挪走了、值日没跟」。
 *
 * 本门禁三层：
 *   A. 调用点实参**求值**（不是文本匹配）：把 shiftSet 里 syncDutyForShift 的实参表达式
 *      真跑一遍，断言跨周时 kind='MOVE' 且第 8 参是目标周 —— 精确复现根因。
 *   B. 行为仿真：抽出真 `syncDutyForShift`，喂假 conn + 假 week，
 *      断言跨周 UPDATE 同时改 week/class_date/source、同周与 OFF 零回归、撞车删除守对称。
 *   C. 源码契约：warnings / 撤销复原 / week.dutySlotOf / 四处读取端全部接线。
 *
 * 变异自证一律在内存副本上做（judge(mutated)），绝不写盘。
 * 用法：node scripts/check-duty-shift-sync.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const COURSE = read('cloudfunctions/course/index.js');
const WEEK = read('cloudfunctions/common/week.js');
const SCHEDULE = read('cloudfunctions/schedule/index.js');
const DUTY = read('cloudfunctions/duty/index.js');
const EXPORT = read('cloudfunctions/export/index.js');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS  ' + msg); }
  else { fail++; console.log('  FAIL  ' + msg + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, ' '));
}
/** 抽 `async function name(...)` 或 `function name(...)` 的完整源码 */
function extractFn(src, name) {
  const head = src.indexOf('async function ' + name + '(');
  const start = head >= 0 ? head : src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}
/** 抽 routes 里 `  shiftSet: {` 的方法体 */
function extractRoute(src, name) {
  const def = new RegExp('^  ' + name + ':\\s*\\{', 'm').exec(src);
  if (!def) return '';
  const i = src.indexOf('{', def.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(def.index, j + 1); }
  }
  return '';
}

/* ==========================================================================
 * A. shiftSet 调用点实参求值 —— 用户症状的精确复现
 * ======================================================================== */
console.log('\n【A】shiftSet → syncDutyForShift 的实参（真求值）');
const SHIFTSET = stripComments(extractRoute(COURSE, 'shiftSet'));
ok(SHIFTSET.length > 200, '抽得到 shiftSet 方法体（否则下面判据无意义）', SHIFTSET.length);

/** 从（可能是变异副本的）shiftSet 文本里取出 syncDutyForShift 的实参并求值 */
function callArgsOf(shiftSrc) {
  const m = /syncDutyForShift\(([\s\S]*?)\)\s*;/.exec(shiftSrc);
  if (!m) return null;
  const expr = m[1].replace(/\/\/.*$/gm, '');
  const fn = new Function('conn', 'cfg', 't', 'kind', 'effDay', 'stats', 'writeToWeek', 'crossWeek', 'toWeek',
    'return [' + expr + '];');
  return fn({}, {}, { sessionId: 356, week: 9 }, 'MOVE', 3, { moved: 0, removed: 0 }, 11, true, 11);
}
{
  const args = callArgsOf(SHIFTSET);
  ok(!!args && args.length >= 8, 'syncDutyForShift 至少传 8 个参数（含目标周）', args && args.length);
  if (args) {
    ok(args[4] === 'MOVE', "跨周 MOVE 时 kind 必须是 'MOVE'（修复前被强制改成 'OFF' ⇒ 值日被删）", args[4]);
    ok(Number(args[7]) === 11, '目标周次作为第 8 参传下去（修复前为 undefined ⇒ 值日留在源周）', args[7]);
    ok(!/crossWeek \? 'OFF' : kind/.test(SHIFTSET), '调用点不再把跨周强制当 OFF');
  }
}

/* ==========================================================================
 * B. 行为仿真：真 syncDutyForShift + 假 conn / 假 week
 * ======================================================================== */
console.log('\n【B】真 syncDutyForShift 行为仿真');
const FN_TEXT = extractFn(COURSE, 'syncDutyForShift');
ok(FN_TEXT.length > 200, '抽得到 syncDutyForShift 源码', FN_TEXT.length);

const fakeWeek = {
  // 可预测，便于断言 UPDATE 的日期/周次参数
  getDateOfWeekDay: (termStart, wk, day) => 'W' + Number(wk) + 'D' + Number(day)
};

/** 造一个记录型 conn；dups 为「目标周撞车行」 */
function makeConn(dups) {
  const calls = [];
  const rolled = [];
  const conn = {
    query(sql, args) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, args: (args || []).slice() });
      if (/^SELECT id, member_id FROM duty/.test(s)) {
        return Promise.resolve([[{ id: 6177, member_id: 56 }, { id: 6178, member_id: 2 }]]);
      }
      if (/^SELECT id FROM duty/.test(s)) {
        return Promise.resolve([(dups || []).slice()]);
      }
      return Promise.resolve([{ affectedRows: 1 }]);
    }
  };
  const rollbackDutyMarkers = async (c, ids) => { rolled.push(ids.slice()); };
  return { conn, calls, rolled, rollbackDutyMarkers };
}
async function runSync(kind, toWk, dups) {
  const body = FN_TEXT.replace(/^async function[^{]*\{/, '').replace(/\}\s*$/, '');
  const fn = new Function('conn', 'cfg', 'sessionId', 'wk', 'kind', 'toDay', 'stats', 'toWk',
    'week', 'rollbackDutyMarkers',
    'return (async () => {' + body + '})();');
  const h = makeConn(dups);
  const stats = { moved: 0, removed: 0 };
  await fn(h.conn, { termStart: '2026-09-14' }, 356, 9, kind, 3, stats, toWk,
    fakeWeek, h.rollbackDutyMarkers);
  return { stats, calls: h.calls, rolled: h.rolled };
}
const findUpdate = (calls) => calls.find(c => /^UPDATE duty SET class_date/.test(c.sql));
const findDelete = (calls) => calls.find(c => /^DELETE FROM duty WHERE id IN/.test(c.sql));

(async () => {
  // ① 跨周 MOVE：整批搬到目标周（用户口径）
  const cross = await runSync('MOVE', 11, []);
  ok(cross.stats.moved === 2 && cross.stats.removed === 0,
    '跨周 MOVE：2 条值日全部搬走、0 条被删（人不变）', cross.stats);
  const cu = findUpdate(cross.calls);
  ok(!!cu, '跨周 MOVE 发出 UPDATE duty（不是 DELETE）');
  if (cu) {
    ok(cu.args[0] === 'W11D3', 'class_date 按【目标周 11】+ 目标星期三算（不是源周）', cu.args[0]);
    ok(Number(cu.args[1]) === 11, 'week 一起改到目标周 11（值日页按 week 查）', cu.args[1]);
    ok(/source\s*=\s*'MANUAL'/.test(cu.sql),
      "跨周搬移行标 source='MANUAL'（否则下次一键生成 DELETE ... AUTO 会把它抹掉）", cu.sql);
  }
  ok(!findDelete(cross.calls), '跨周 MOVE 不再走 OFF 的删行分支');

  // ② 同周 MOVE：旧行为零回归
  const same = await runSync('MOVE', null, []);
  const su = findUpdate(same.calls);
  ok(same.stats.moved === 2, '同周 MOVE：仍搬 2 条', same.stats);
  ok(!!su && Number(su.args[1]) === 9, '同周 MOVE：week 仍是源周 9（零回归）', su && su.args[1]);
  ok(!!su && !/source\s*=\s*'MANUAL'/.test(su.sql), '同周 MOVE：不改 source（零回归）');

  // ③ OFF：仍整批删除（本周不上）
  const off = await runSync('OFF', null, []);
  ok(off.stats.removed === 2 && off.stats.moved === 0, 'OFF：仍删 2 条、不搬', off.stats);
  ok(!!findDelete(off.calls), 'OFF 走 DELETE 分支');
  ok(off.rolled.length > 0, 'OFF 删行前调用了 rollbackDutyMarkers（轮转对称）');

  // ④ 目标周撞车：uq_duty(session_id, week, member_id) 会 1062，必须先删冲突行
  const clash = await runSync('MOVE', 11, [{ id: 99 }]);
  const cd = findDelete(clash.calls);
  ok(!!cd && cd.args.indexOf(99) >= 0, '目标周同课次同人已有值日 ⇒ 先删冲突行（避免 1062 回滚整笔调课）',
    cd && cd.args);
  ok(clash.rolled.length > 0, '删冲突行也回滚轮转标记（check-duty-marker-symmetry 口径）');
  ok(clash.stats.removed === 1 && clash.stats.moved === 2,
    '撞车后统计正确（删 1 / 搬 2）', clash.stats);
  const clashSelect = clash.calls.find(c => /^SELECT id FROM duty/.test(c.sql));
  ok(!!clashSelect && /session_id\s*=\s*\?/.test(clashSelect.sql),
    '冲突查询覆盖 session_id 维度（只按 class_date 判重会漏 uq_duty 撞车）', clashSelect && clashSelect.sql);

  /* ========================================================================
   * C. 源码契约（防止「修了调用点、漏了读取端 / 撤销 / 提示」）
   * ====================================================================== */
  console.log('\n【C】源码契约：撤销复原 / 读取端节次解析 / 提示文案');
  const REMOVE = stripComments(extractRoute(COURSE, 'shiftRemove'));
  ok(/source\s*=\s*'AUTO'/.test(REMOVE),
    'shiftRemove 跨周逆向把搬移行的 source 复原为 AUTO（撤销要完全回到调课前）');
  const COURSE_CODE = stripComments(COURSE);
  ok(/值日已随课移动|值日随课/.test(COURSE_CODE), 'warnings 改为「值日已随课移动」（不再提示手动添加）');
  ok(!/该次不自动生成值日/.test(COURSE_CODE), '移除旧版「不自动生成值日，请手动添加」的提示');

  ok(/dutySlotOf/.test(WEEK) && /module\.exports[\s\S]*dutySlotOf/.test(WEEK),
    'common/week.js 导出 dutySlotOf（跨周搬移行的 day/period 解析）');
  ok(/incomingOf[\s\S]{0,600}dutySlotOf|dutySlotOf[\s\S]{0,600}incomingOf/.test(WEEK),
    'dutySlotOf 用 incomingOf 反查跨周补课落位（不是另写一套课表解释器）');
  ok(/dutySlotOf\(/.test(SCHEDULE), 'schedule.loadWeekDuties 改用 dutySlotOf（值日页星期/节次正确）');
  ok(/dutySlotOf\(/.test(DUTY), 'duty.today / deriveMyDuties / detail 改用 dutySlotOf');
  ok(/dutySlotOf\(/.test(EXPORT), 'export.weekCsv 改用 dutySlotOf');
  ok(!/week\.resolveSlot\(d\./.test(SCHEDULE),
    'loadWeekDuties 不再对 duty 行直接用裸 resolveSlot（跨周查不到 shift）');

  /* ========================================================================
   * D. 变异自证：任一环拆掉都必须翻红
   * ====================================================================== */
  console.log('\n【D】变异自证（内存副本，不写盘）');
  const mutKind = COURSE.replace(
    /syncDutyForShift\(conn, cfg, t\.sessionId, t\.week,\s*kind, effDay, stats, writeToWeek\)/,
    "syncDutyForShift(conn, cfg, t.sessionId, t.week, crossWeek ? 'OFF' : kind, effDay, stats)");
  if (mutKind !== COURSE) {
    const a = callArgsOf(stripComments(extractRoute(mutKind, 'shiftSet')));
    ok(!!a && (a[4] !== 'MOVE' || Number(a[7]) !== 11),
      "变异 1：退回「跨周按 OFF」 ⇒ A 段实参判据翻红", a && [a[4], a[7]]);
  } else {
    ok(false, '变异 1 锚点命中源码（未命中 ⇒ 自证是假绿）');
  }
  const mutNoWk = COURSE.replace(/, stats, writeToWeek\)/, ', stats)');
  ok(mutNoWk !== COURSE, '变异 2 锚点命中源码');
  const a2 = callArgsOf(stripComments(extractRoute(mutNoWk, 'shiftSet')));
  ok(!!a2 && Number(a2[7]) !== 11, '变异 2：不传目标周 ⇒ A 段判据翻红', a2 && a2.length);

  const mutSrc = COURSE.replace(/source\s*=\s*'MANUAL'/g, '');
  const mutBody = extractFn(mutSrc, 'syncDutyForShift');
  ok(!/source\s*=\s*'MANUAL'/.test(mutBody), '变异 3：抠掉 source=MANUAL ⇒ B 段判据翻红');
  ok(/source\s*=\s*'MANUAL'/.test(extractFn(COURSE, 'syncDutyForShift')), '好样本：源码原样带 source=MANUAL');

  console.log('\n【E】真 week.js：搬移后的值日行展示落位');
  const week = require(path.join(ROOT, 'cloudfunctions/common/week.js'));
  const TERM = '2026-09-14';
  // 用户例子：第 9 周周一第 4 节（session 356）跨周调到第 11 周周三。
  // 故意把目标节次设成 **2**（用户例子里两处都是第 4 节，看不出解析是否错误）。
  const shifts = {
    '356#9': { sessionId: 356, fromWeek: 9, kind: 'MOVE', toDay: 3, toPeriod: 2, toWeek: 11, note: '' }
  };
  ok(typeof week.dutySlotOf === 'function', '真 common/week.js 导出 dutySlotOf');
  if (typeof week.dutySlotOf === 'function') {
    const moved = {
      session_id: 356, day_of_week: 1, period: 4,
      week: 11, class_date: week.getDateOfWeekDay(TERM, 11, 3)
    };
    const s = week.dutySlotOf(moved, shifts, 11);
    ok(!!s && Number(s.day) === 3 && Number(s.period) === 2,
      '搬到目标周的值日显示「周三第 2 节」（裸 resolveSlot 会错显示周一第 4 节）', s);
    const regular = {
      session_id: 356, day_of_week: 1, period: 4,
      week: 11, class_date: week.getDateOfWeekDay(TERM, 11, 1)
    };
    const sr = week.dutySlotOf(regular, shifts, 11);
    ok(!!sr && Number(sr.day) === 1 && Number(sr.period) === 4,
      '目标周该课次的常规值日不被补课落位误覆盖（补课是「多一次」）', sr);
    const src = {
      session_id: 356, day_of_week: 1, period: 4,
      week: 9, class_date: week.getDateOfWeekDay(TERM, 9, 1)
    };
    ok(week.dutySlotOf(src, shifts, 9) === null, '源周常规落位仍判空（课已调走）');
    const plain = {
      session_id: 1, day_of_week: 5, period: 3, week: 4,
      class_date: week.getDateOfWeekDay(TERM, 4, 5)
    };
    const sp = week.dutySlotOf(plain, {}, 4);
    ok(!!sp && sp.day === 5 && sp.period === 3 && sp.shifted === false,
      '无跨周调课时 dutySlotOf 与 resolveSlot 完全等价（零回归）', sp);
  }

  console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('仿真异常: ' + (e && e.stack || e)); process.exit(1); });
