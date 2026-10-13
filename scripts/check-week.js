/**
 * 离线校验 `cloudfunctions/common/week.js`（服务端）与
 * `miniprogram/utils/util.js`（端上）的日期/星期计算是否**逐项一致**
 * ------------------------------------------------------------
 *   node scripts/check-week.js
 *
 * 为什么要做「双端一致性」校验：这两份实现是各自独立写的，历史上就因此出过 bug——
 * 服务端 weekdayOf 用 toDate()+getUTCDay()，被 +08:00 位移带到前一天，
 * 星期整体差一天，导致首页「今日课次」查错 day_of_week、导出 CSV 的星期列也错。
 * 端上 util.weekdayOfNum 用的是本地 Date，反而是对的。
 * 只要两端结果必须相等，这类偏移就不可能再悄悄溜过去。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* timetable.js 读 wx.Storage，这里给个纯内存存根保证读到种子数据 */
const store = {};
global.wx = {
  getStorageSync: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; }
};

const week = require(path.join(ROOT, 'cloudfunctions/common/week.js'));
const util = require(path.join(ROOT, 'miniprogram/utils/util.js'));
const tt = require(path.join(ROOT, 'miniprogram/data/timetable.js'));

let fail = 0;
function check(label, cond, extra) {
  if (!cond) fail++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}

const TERM_START = tt.TERM_START;
const TOTAL_WEEKS = tt.TOTAL_WEEKS;
console.log('学期起始:', TERM_START, '| 总周次:', TOTAL_WEEKS);
console.log();

/* ---------- ① 星期：服务端 vs 端上，逐日比对整个学期 ---------- */
console.log('--- ① weekdayOf 双端一致（整学期逐日） ---');
let mismatch = [];
for (let w = 1; w <= TOTAL_WEEKS; w++) {
  for (let d = 1; d <= 7; d++) {
    const date = week.getDateOfWeekDay(TERM_START, w, d);
    const s = week.weekdayOf(date);
    const c = util.weekdayOfNum(date);
    if (s !== c || s !== d) mismatch.push(date + ' server=' + s + ' client=' + c + ' expect=' + d);
  }
}
check('week.weekdayOf 与 util.weekdayOfNum 全学期一致，且等于预期星期', mismatch.length === 0,
  mismatch.length ? mismatch.slice(0, 5).join(' | ') : (TOTAL_WEEKS * 7) + ' 天全部一致');

/* 显式点名几个易错日期（跨月 / 跨年 / 周日） */
const named = [
  ['2026-09-14', 1], ['2026-09-20', 7], ['2026-09-21', 1],
  ['2026-09-24', 4], ['2026-09-25', 5], ['2026-10-02', 5], ['2027-01-01', 5]
];
const namedBad = named.filter(([d, exp]) => week.weekdayOf(d) !== exp);
check('weekdayOf 关键日期正确（含周日与跨年）', namedBad.length === 0,
  namedBad.length ? JSON.stringify(namedBad) : named.map(x => x[0] + '=' + x[1]).join(' '));

/* 非法输入不抛异常 */
let safe = true;
try { week.weekdayOf(''); week.weekdayOf(null); week.weekdayOf(undefined); } catch (e) { safe = false; }
check('weekdayOf 对空/非法输入不抛异常', safe);

/* ---------- ② 日期推算：服务端 vs 端上课表 ---------- */
console.log();
console.log('--- ② getDateOfWeekDay 双端一致 ---');
let dateBad = [];
for (let w = 1; w <= TOTAL_WEEKS; w++) {
  for (let d = 1; d <= 7; d++) {
    const s = week.getDateOfWeekDay(TERM_START, w, d);
    const c = tt.dateOfWeekDay(TERM_START, w, d);
    if (s !== c) dateBad.push('wk' + w + '/dow' + d + ' server=' + s + ' client=' + c);
  }
}
check('week.getDateOfWeekDay 与 timetable.dateOfWeekDay 全学期一致', dateBad.length === 0,
  dateBad.length ? dateBad.slice(0, 5).join(' | ') : (TOTAL_WEEKS * 7) + ' 天全部一致');

/* ---------- ③ 放假 / 调课 ---------- */
console.log();
console.log('--- ③ classDateOf（放假跳过 / 调课改期） ---');
const cal = { off: new Set(['2026-10-02']), shiftFrom: { '2026-09-21': '2026-09-26' } };
check('放假当天返回 null（第3周周五 10/02）', week.classDateOf({ termStart: TERM_START }, 3, 5, cal) === null,
  String(week.classDateOf({ termStart: TERM_START }, 3, 5, cal)));
check('有调课记录时返回调课后的日期', week.classDateOf({ termStart: TERM_START }, 2, 1, cal) === '2026-09-26',
  String(week.classDateOf({ termStart: TERM_START }, 2, 1, cal)));
check('无假期无调课时返回原始日期', week.classDateOf({ termStart: TERM_START }, 2, 1, { off: new Set(), shiftFrom: {} }) === '2026-09-21',
  String(week.classDateOf({ termStart: TERM_START }, 2, 1, { off: new Set(), shiftFrom: {} })));

/* ---------- ④ 序号 / 周次编码 ---------- */
console.log();
console.log('--- ④ 序号与周次编码 ---');
check('seqOf 取学号后两位', week.seqOf(209901030101) === 1 && week.seqOf('209901030156') === 56,
  week.seqOf(209901030101) + ',' + week.seqOf('209901030156'));
check('seqOf 空值返回 0', week.seqOf('') === 0 && week.seqOf(null) === 0);
check('parseWeeks 去重升序', JSON.stringify(week.parseWeeks('2,4,4,6')) === '[2,4,6]', JSON.stringify(week.parseWeeks('2,4,4,6')));
check('matchesWeeks 空串 = 每周都上', week.matchesWeeks('', 5, null) === true);
check('matchesWeeks 命中集合才上', week.matchesWeeks('2,4,6', 4, null) === true && week.matchesWeeks('2,4,6', 5, null) === false);
check('matchesWeeks 兼容旧 ODD/EVEN', week.matchesWeeks('', 3, 'ODD') === true && week.matchesWeeks('', 4, 'ODD') === false);

/* ---------- ⑤ 临时调课 resolveSlot ----------
 * 这是「某一周这节课到底哪天、第几节」的**唯一解释器**，服务端一份、
 * 端上一份（刻意重复：端上课表要离线渲染，不能为了这一条去联网）。
 * 两份必须逐项一致，否则会出现「课表看着改了、值日表没改」这类最难查的问题。
 */
console.log();
console.log('--- ⑤ 临时调课 resolveSlot 双端一致 ---');
const shifts = {
  [week.shiftKey(5, 2)]: { kind: 'OFF', toDay: null, toPeriod: null, note: '' },
  [week.shiftKey(7, 2)]: { kind: 'MOVE', toDay: 5, toPeriod: 1, note: '' },
  [week.shiftKey(3, 4)]: { kind: 'MOVE', toDay: 1, toPeriod: 5, note: '' }
};
const cases = [
  ['没有调课 → 原样', 1, 3, 4, 2],
  ['OFF → null（本周不上）', 5, 2, 2, 2],
  ['MOVE → 改到周五第 1 节', 7, 4, 2, 2],
  ['MOVE 跨到周一第 5 节', 3, 1, 4, 4],
  ['别的周不受影响（同一课次第 3 周）', 5, 2, 3, 2]
];
let slotBad = [];
cases.forEach(([label, sid, dow, per, wk]) => {
  const s = week.resolveSlot(sid, dow, per, wk, shifts);
  const c = tt.resolveSlot(sid, dow, per, wk, shifts);
  if (JSON.stringify(s) !== JSON.stringify(c)) {
    slotBad.push(label + ' server=' + JSON.stringify(s) + ' client=' + JSON.stringify(c));
  }
});
check('resolveSlot 服务端 / 端上逐项一致', slotBad.length === 0,
  slotBad.length ? slotBad.join(' | ') : cases.length + ' 个用例全部一致');

check('resolveSlot 没有调课记录时原样返回',
  JSON.stringify(week.resolveSlot(1, 3, 4, 2, shifts)) === '{"day":3,"period":4,"shifted":false}',
  JSON.stringify(week.resolveSlot(1, 3, 4, 2, shifts)));
check('resolveSlot OFF 返回 null',
  week.resolveSlot(5, 2, 2, 2, shifts) === null);
check('resolveSlot MOVE 换格子并标记 shifted',
  JSON.stringify(week.resolveSlot(7, 4, 2, 2, shifts)) === '{"day":5,"period":1,"shifted":true}',
  JSON.stringify(week.resolveSlot(7, 4, 2, 2, shifts)));
check('resolveSlot 只影响被点名的那一周',
  week.resolveSlot(5, 2, 2, 3, shifts) !== null);
check('resolveSlot 对空 shifts 不抛异常',
  week.resolveSlot(5, 2, 2, 2, null) !== null && week.resolveSlot(5, 2, 2, 2, {}) !== null);
check('shiftKey 两端同构', week.shiftKey(12, 3) === tt.shiftKey(12, 3),
  week.shiftKey(12, 3) + ' vs ' + tt.shiftKey(12, 3));

/* 端上把临时调课真正用进 sessionsOfWeek：OFF 的课次必须整条消失 */
console.log();
console.log('--- ⑥ sessionsOfWeek 应用临时调课（端上） ---');
const wk2Before = tt.sessionsOfWeek(2);
const offTarget = wk2Before.find(c => c.dayOfWeek === 2 && c.period === 2);
check('第 2 周存在周二第 2 节的课（用于测试）', !!offTarget,
  offTarget ? offTarget.name : '未找到');

if (offTarget) {
  tt.upsertSessShifts([{ sessionId: offTarget.sessionId, week: 2, kind: 'OFF', note: 'test' }]);
  const afterOff = tt.sessionsOfWeek(2);
  check('OFF 后该课次从 sessionsOfWeek 消失',
    !afterOff.some(c => Number(c.sessionId) === Number(offTarget.sessionId)),
    '剩余 ' + afterOff.length + ' 节');
  check('OFF 后第 2 周课次数 -1', afterOff.length === wk2Before.length - 1,
    afterOff.length + ' vs ' + wk2Before.length);

  // 目标格子必须落在**不放假**的那天：第 2 周的周六 9/26 是中秋假期，
  // 挪到放假日会被 classDateOf 剔除（这是正确行为，但会让断言误导人）。
  // 所以这里选周四第 5 节（9/24，不放假）。
  tt.upsertSessShifts([{ sessionId: offTarget.sessionId, week: 2, kind: 'MOVE', toDay: 4, toPeriod: 5, note: 'test' }]);
  const afterMove = tt.sessionsOfWeek(2);
  const moved = afterMove.find(c => Number(c.sessionId) === Number(offTarget.sessionId));
  check('MOVE 后该课次换到周四第 5 节',
    !!moved && moved.dayOfWeek === 4 && moved.period === 5,
    moved ? ('周' + moved.dayOfWeek + ' 第' + moved.period + '节') : '未找到');
  check('MOVE 后课次总数不变', afterMove.length === wk2Before.length);
  // 挪到放假日 → 该课次仍照常显示，但标注 isHoliday（放假也陈列，便于调课）
  tt.upsertSessShifts([{ sessionId: offTarget.sessionId, week: 2, kind: 'MOVE', toDay: 6, toPeriod: 1, note: 'test' }]);
  const movedHoliday = tt.sessionsOfWeek(2).find(c => Number(c.sessionId) === Number(offTarget.sessionId));
  check('MOVE 到放假日（第2周周六 9/26 中秋）→ 仍照常显示且标注 isHoliday',
    !!movedHoliday && movedHoliday.isHoliday === true && movedHoliday.dayOfWeek === 6 && movedHoliday.period === 1,
    movedHoliday ? ('周' + movedHoliday.dayOfWeek + ' 第' + movedHoliday.period + '节 holiday=' + movedHoliday.isHoliday) : '未找到');

  tt.removeSessShifts([offTarget.sessionId], [2]);
  check('撤销后回到原样',
    tt.sessionsOfWeek(2).length === wk2Before.length
    && !!tt.sessionsOfWeek(2).find(c => Number(c.sessionId) === Number(offTarget.sessionId)));
}

/* 临时调课清单（「结果」页签用） */
tt.upsertSessShifts([{ sessionId: 8, week: 5, kind: 'OFF', note: 'x' }]);
const items5 = tt.sessShiftsOfWeek(5);
check('sessShiftsOfWeek 只返回该周，且带上课程名',
  items5.length === 1 && items5[0].sessionId === 8 && !!items5[0].name,
  JSON.stringify(items5.map(i => i.name)));
check('sessShiftsOfWeek 对其它周返回空', tt.sessShiftsOfWeek(6).length === 0);
tt.removeSessShifts([8], [5]);
check('removeSessShifts 之后清单为空', tt.sessShiftsOfWeek(5).length === 0);

console.log();
if (fail) {
  console.log('❌ 失败 ' + fail + ' 项');
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅');
}
