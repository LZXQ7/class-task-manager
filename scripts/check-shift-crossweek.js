/**
 * 门禁：跨周调课（session_shift.to_week）+ 调课撤回
 * ------------------------------------------------------------
 * `node scripts/check-shift-crossweek.js`
 *
 * 2026-11-09 用户需求：「第 9 周这节课不上，改到第 11 周周三第 4 节」+
 *   「调课要能撤回」+「调课时能选目标周次」。
 *
 * 业务语义（两侧合起来才是一笔完整调课，缺一侧就是半截账）：
 *   源周   —— 这节课**不上**（resolveSlot 返回 null）
 *   目标周 —— **多出一次补课**，落在 to_day/to_period（incomingOf 给出，由渲染方追加）
 *   ⚠️ 目标周「该课次自己的常规课」不受影响（补课 ≠ 搬家）。
 *
 * 本门禁直接 require 生产源码（common/week.js + data/timetable.js），不抄副本。
 * 含变异自证：把 toWeek 判定抠掉，必须立刻翻红。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const store = {};
global.wx = {
  getStorageSync: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; }
};

const WEEK_PATH = path.join(ROOT, 'cloudfunctions/common/week.js');
const TT_PATH = path.join(ROOT, 'miniprogram/data/timetable.js');
const COURSE_PATH = path.join(ROOT, 'cloudfunctions/course/index.js');

const week = require(WEEK_PATH);
const tt = require(TT_PATH);

let failed = 0;
let passed = 0;
function ok(cond, name) {
  if (cond) { passed += 1; console.log('  \u2713 ' + name); }
  else { failed += 1; console.log('  \u2717 ' + name); }
}

/* ============================================================
 * 一、纯函数层：resolveSlot / incomingOf（服务端）
 * ============================================================ */
console.log('\n[1] 服务端 week.resolveSlot / incomingOf');

const SID = 356;
const DAY = 1;
const PERIOD = 4;
const map = {
  [week.shiftKey(SID, 9)]: {
    sessionId: SID, fromWeek: 9, kind: 'MOVE',
    toDay: 3, toPeriod: 4, toWeek: 11, note: '跨周补课'
  }
};

ok(week.resolveSlot(SID, DAY, PERIOD, 9, map) === null,
  '源周（第 9 周）：resolveSlot 返回 null = 这节课不上');
const home11 = week.resolveSlot(SID, DAY, PERIOD, 11, map);
ok(home11 && home11.day === DAY && home11.period === PERIOD && home11.shifted === false,
  '目标周（第 11 周）：该课次**自己的常规课**照常（周一第 4 节、未 shift）');

const inc = week.incomingOf(map, 11);
ok(inc.length === 1 && inc[0].sessionId === SID && inc[0].toDay === 3 && inc[0].toPeriod === 4,
  '目标周：incomingOf 给出 1 条补课（周三第 4 节）');
ok(week.incomingOf(map, 9).length === 0, '源周：incomingOf 为空（不重复计入）');
ok(week.incomingOf(map, 10).length === 0, '无关周：incomingOf 为空');

/* 同周调课（to_week 为 NULL）必须保持旧行为 —— 向后兼容 */
const sameMap = {
  [week.shiftKey(SID, 9)]: {
    sessionId: SID, fromWeek: 9, kind: 'MOVE',
    toDay: 4, toPeriod: 3, toWeek: null, note: '同周'
  }
};
const same = week.resolveSlot(SID, DAY, PERIOD, 9, sameMap);
ok(same && same.day === 4 && same.period === 3 && same.shifted === true,
  '同周调课（to_week=NULL）：仍按 to_day/to_period 换格子（旧行为不变）');
ok(week.incomingOf(sameMap, 9).length === 0, '同周调课不产生「调入」条目');

/* OFF 仍是最强语义 */
const offMap = { [week.shiftKey(SID, 9)]: { sessionId: SID, fromWeek: 9, kind: 'OFF', toDay: null, toPeriod: null, toWeek: null } };
ok(week.resolveSlot(SID, DAY, PERIOD, 9, offMap) === null, 'kind=OFF：本周不上（不受跨周改动影响）');

/* ============================================================
 * 二、前端解释器必须同构
 * ============================================================ */
console.log('\n[2] 前端 data/timetable.js resolveSlot / sessShiftsOfWeek');

tt.replaceSessions([{
  id: SID, cid: 1, name: '微课设计与制作', teacher: '张老师', room: 'A101',
  day: DAY, period: PERIOD, group: 'B', weeks: '9,10,11,12,13,14,15,16', weekRule: 'ALL', dutyCount: 2
}]);
const shiftRows = [{ sessionId: SID, week: 9, kind: 'MOVE', toDay: 3, toPeriod: 4, toWeek: 11, note: '跨周补课' }];
tt.replaceSessShifts(shiftRows);

const ttMap = tt.sessShiftMap();
ok(tt.resolveSlot(SID, DAY, PERIOD, 9, ttMap) === null, '端上 resolveSlot：源周不上');
const ttHome = tt.resolveSlot(SID, DAY, PERIOD, 11, ttMap);
ok(ttHome && ttHome.day === DAY && ttHome.period === PERIOD, '端上 resolveSlot：目标周常规课照常');

const srcList = tt.sessionsOfWeek(9);
ok(!srcList.some(x => Number(x.sessionId) === SID), '端上 sessionsOfWeek(9)：这节课不出现');

const dstList = tt.sessionsOfWeek(11);
const inRow = dstList.filter(x => Number(x.sessionId) === SID);
ok(inRow.length === 2, '端上 sessionsOfWeek(11)：同一课次出现 2 条（常规 + 补课）');
const makeup = inRow.find(x => x.shiftKind === 'WEEK_IN');
ok(!!makeup && makeup.dayOfWeek === 3 && makeup.period === 4,
  '补课条目落在周三第 4 节，且标记 shiftKind=WEEK_IN');
ok(!!inRow.find(x => x.shiftKind === '' || x.shiftKind === undefined && x.dayOfWeek === 1),
  '常规条目仍在周一第 4 节（补课没有把原课挤掉）');

/* ============================================================
 * 三、调课结果列表：两侧都要能撤回
 * ============================================================ */
console.log('\n[3] 调课结果列表（sessShiftsOfWeek）');

const ofSrc = tt.sessShiftsOfWeek(9);
ok(ofSrc.length === 1 && ofSrc[0].side === 'out' && ofSrc[0].undoWeek === 9,
  '看源周：side=out、undoWeek=9（撤回按记录所在周删）');
const ofDst = tt.sessShiftsOfWeek(11);
ok(ofDst.length === 1 && ofDst[0].side === 'in' && ofDst[0].undoWeek === 9,
  '看目标周：side=in、undoWeek 仍指向源周 9（否则撤回会删错周、课还在）');

/* ============================================================
 * 四、后端静态契约（源码级）
 * ============================================================ */
console.log('\n[4] 后端源码契约');
const courseSrc = fs.readFileSync(COURSE_PATH, 'utf8');

ok(/to_week/.test(courseSrc) && /writeToWeek/.test(courseSrc),
  'shiftSet 读写 to_week（跨周落库）');
ok(/syncDutyForShift\(conn, cfg, t\.sessionId, t\.week,\s*kind, effDay, stats, writeToWeek\)/.test(courseSrc),
  '跨周调课把目标周传给 syncDutyForShift（值日随课搬到目标格，人不变）');
ok(!/crossWeek \? 'OFF' : kind/.test(courseSrc),
  '跨周调课不再按 OFF 撤掉源周值日');
ok(/值日已随课移动/.test(courseSrc), '保存后提示「值日已随课移动」');
ok(/incomingOf\(shifts, wk\)/.test(courseSrc),
  'weekOccupants 把跨周补课纳入撞车预检');
ok(/sessShifts: Object\.keys\(shiftMap\)/.test(courseSrc),
  'allSessions 随课表下发全量调课（换设备也能看到 / 能撤回）');
ok(/to_week: r\.to_week/.test(fs.readFileSync(WEEK_PATH, 'utf8'))
  || /to_week/.test(fs.readFileSync(WEEK_PATH, 'utf8')),
  'common/week.js 读取 to_week');

/* ============================================================
 * 五、变异自证：把跨周判定抠掉，上面的断言必须翻红
 * ============================================================ */
console.log('\n[5] 变异自证（抠掉 toWeek 判定 → 必须翻红）');
function mutateAndRun(file, from, to, tag) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.log('  \u2717 ' + tag + '：找不到变异锚点'); failed += 1; return; }
  fs.writeFileSync(file, orig.replace(from, to), 'utf8');
  let red = false;
  try {
    execSync('node "' + __filename + '" --mutant', { stdio: 'pipe' });
  } catch (e) { red = true; }
  fs.writeFileSync(file, orig, 'utf8');
  ok(red, tag + '：变异后门禁翻红');
}
if (process.argv.indexOf('--mutant') < 0) {
  mutateAndRun(WEEK_PATH,
    "if (ov.toWeek && Number(ov.toWeek) !== Number(week)) return null;",
    "if (false) return null;",
    'week.resolveSlot 跨周判空');
  mutateAndRun(WEEK_PATH,
    "if (!ov.toWeek || Number(ov.toWeek) !== wk) return;",
    "if (true) return;",
    'week.incomingOf 补课索引');
  mutateAndRun(TT_PATH,
    "if (ov.toWeek && Number(ov.toWeek) !== Number(week)) return null;",
    "if (false) return null;",
    '端上 resolveSlot 跨周判空');
}

/* ============================================================ */
console.log('\n' + (failed === 0
  ? '全部通过：' + passed + ' 项'
  : 'FAILED：' + failed + ' 项失败 / ' + passed + ' 项通过'));
process.exit(failed === 0 ? 0 : 1);
