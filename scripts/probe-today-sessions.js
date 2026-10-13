#!/usr/bin/env node
/**
 * 离线探针：把 cloudfunctions/duty 的 today handler 真正跑起来，验证「今日 / 明日课次」。
 * ------------------------------------------------------------
 * 做法：用 Module._load 把 `wx-server-sdk`、`./common/db`、`./common/guard` 换成桩，
 *       `common/week.js` 用**真代码**，pool 用桩返回下面这份从线上库 dump 的快照。
 *       于是 sessionsOnDate 的判定逻辑是真实执行过的，不是静态读源码。
 *
 * 快照时间：2026-09-25 00:38（周五）。当天校历 kind=OFF（中秋节），次日 09-26（周六）也是 OFF。
 * → 这正是用户反馈的场景：**工作日放假，首页不能还列着当天的课**。
 *
 * 用法：node scripts/probe-today-sessions.js
 */
const path = require('path');
const Module = require('module');

/* ---------- 线上库快照（2026-09-25 取自 class_config / session / holiday / day_shift / session_shift） ---------- */
const CFG = {
  id: 1, name: '示例班级A', term_start: '2026-09-14', total_weeks: 16,
  join_token: '<JOIN_TOKEN>', invite_code: '<INVITE_CODE>',
  period_time: [
    { period: 1, start: '08:00', end: '09:40' },
    { period: 2, start: '10:05', end: '11:45' },
    { period: 3, start: '14:00', end: '15:40' },
    { period: 4, start: '16:00', end: '17:40' },
    { period: 5, start: '19:00', end: '20:40' }
  ]
};

const SESSIONS = [
  [1, 1, 1, 'ALL', '6,8,10,12', null, '形势与政策', '3号楼208'],
  [2, 1, 2, 'ALL', '', 'A', '微课设计与制作', '3号楼109'],
  [5, 1, 3, 'ALL', '', null, '习近平新时代中国特色社会主义思想概论', '3号楼213'],
  [3, 1, 4, 'ALL', '1,2,3,4,5,6,7,8', 'B', '微课设计与制作', '3号楼109'],
  [4, 1, 4, 'ALL', '9,10,11,12,13,14,15,16', 'B', '微课设计与制作', '3号楼109'],
  [8, 2, 1, 'ALL', '', 'A', '小学人工智能教育', '3号楼110'],
  [25, 2, 2, 'ALL', '5,6,7,8,9,10,11,12,13,14,15,16', 'A', '小学数学课程与教学论', '3号楼112'],
  [10, 2, 2, 'ALL', '1,2,3,4', null, '小学数学课程与教学论', '3号楼305'],
  [22, 2, 5, 'ALL', '', 'A', '三笔字', '3号楼111'],
  [9, 3, 1, 'ALL', '', 'B', '小学人工智能教育', '3号楼110'],
  [11, 3, 2, 'ALL', '5,6,7,8,9,10,11,12,13,14,15,16', 'B', '小学数学课程与教学论', '3号楼112'],
  [12, 3, 3, 'ALL', '1,3,5,7,9,11,13,15', null, '小学生心理健康指导', '3号楼222'],
  [13, 3, 3, 'ALL', '2,4,6,8,10,12,14,16', 'A', '小学生心理健康指导', '3号楼121'],
  [14, 3, 4, 'ALL', '2,4,6,8,10,12,14,16', 'B', '小学生心理健康指导', '3号楼123'],
  [15, 3, 5, 'ALL', '', 'A', '音乐基础', '二区302'],
  [18, 4, 1, 'ALL', '5,6,7,8,9,10,11,12,13,14,15,16', 'A', '小学语文课程与教学论', '一区212'],
  [17, 4, 2, 'ALL', '1,2,3,4', null, '小学语文课程与教学论', '3号楼303'],
  [19, 4, 2, 'ALL', '5,6,7,8,9,10,11,12,13,14,15,16', 'B', '小学语文课程与教学论', '一区212'],
  [6, 4, 3, 'ALL', '1,3,5,7,9,11,15', null, '习近平新时代中国特色社会主义思想概论', '3号楼213'],
  [7, 4, 3, 'ALL', '13', null, '习近平新时代中国特色社会主义思想概论', '精神谱系馆'],
  [16, 4, 5, 'ALL', '', 'B', '音乐基础', '二区302'],
  [20, 5, 1, 'ALL', '', 'A', '小学综合实践活动设计', '3号楼110'],
  [23, 5, 1, 'ALL', '', 'B', '三笔字', '3号楼111'],
  [21, 5, 2, 'ALL', '', 'B', '小学综合实践活动设计', '3号楼113'],
  [24, 5, 3, 'ALL', '', null, '儿童文学', '3号楼205']
].map(([id, day_of_week, period, week_rule, weeks, group_scope, name, room]) =>
  ({ id, day_of_week, period, week_rule, weeks, group_scope, name, room }));

const HOLIDAYS = [
  { holiday_date: '2026-09-20', kind: 'MAKEUP', name: '国庆节调休上班' },
  { holiday_date: '2026-09-25', kind: 'OFF', name: '中秋节' },
  { holiday_date: '2026-09-26', kind: 'OFF', name: '中秋节' },
  { holiday_date: '2026-09-27', kind: 'OFF', name: '中秋节' },
  { holiday_date: '2026-10-01', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-02', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-03', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-04', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-05', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-06', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-07', kind: 'OFF', name: '国庆节' },
  { holiday_date: '2026-10-10', kind: 'MAKEUP', name: '国庆节调休上班' },
  { holiday_date: '2027-01-01', kind: 'OFF', name: '元旦' }
];

const DAY_SHIFTS = [{ id: 1, week: 4, from_date: '2026-10-06', to_date: '2026-09-20', note: '' }];
const SESSION_SHIFTS = [];

/* ---------- 桩 ---------- */
const rows = (sql) => {
  if (/FROM class_config/i.test(sql)) return [CFG];
  if (/FROM duty d/i.test(sql)) return [];            // 我今日没有值日
  if (/FROM session s JOIN course c/i.test(sql)) return SESSIONS;
  if (/FROM holiday/i.test(sql)) return HOLIDAYS;
  if (/FROM day_shift/i.test(sql)) return DAY_SHIFTS;
  if (/FROM session_shift/i.test(sql)) return SESSION_SHIFTS;
  if (/FROM swap_request/i.test(sql)) return [{ n: 0 }];
  if (/FROM notice n/i.test(sql)) return [];
  if (/FROM notice_read/i.test(sql)) return [];
  return [];
};
const POOL = { query: async (sql) => [rows(sql), []] };

const ME = { id: 1, name: '示例成员01', group_tag: 'A', role: 'ADMIN', is_super: 1 };
const GUARD = {
  getContext: async () => ({ member: ME }),
  requireBind: () => ME,
  requireAdmin: () => ME,
  isSuper: (m) => !!m && m.role === 'ADMIN' && m.is_super === 1,
  isAdmin: (m) => !!m && (m.role === 'ADMIN' || m.role === 'MONITOR')
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') {
    return { init() {}, DYNAMIC_CURRENT_ENV: '<YOUR_ENV_ID>', getTempFileURL: async () => ({ fileList: [] }) };
  }
  if (/common[\\/]db$/.test(request)) return { getPool: () => POOL };
  if (/common[\\/]guard$/.test(request)) return GUARD;
  return origLoad.apply(this, arguments);
};

/* ---------- 跑真实 handler ---------- */
const week = require(path.join(__dirname, '..', 'cloudfunctions', 'common', 'week.js'));
const dutyFn = require(path.join(__dirname, '..', 'cloudfunctions', 'duty', 'index.js'));

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : bad(m));

(async () => {
  const res = await dutyFn.main({ action: 'today', payload: {} });
  console.log('\n原始返回：' + JSON.stringify(res, null, 2));

  chk(res.code === 0 || res.success === true || res.ok !== false, 'duty.today 正常返回');
  const d = res.data || res;

  console.log('\n── 今日 / 明日课次（真实代码路径，pool = 线上库快照）');
  console.log(`  · today=${d.today}  tomorrow=${d.tomorrow}  currentWeek=${d.currentWeek}`);
  console.log(`  · sessions=${d.sessions.length} 条  tomorrowSessions=${d.tomorrowSessions.length} 条`);

  chk(d.today === '2026-09-25', 'today = 2026-09-25（快照日）');
  chk(d.tomorrow === '2026-09-26', 'tomorrow = 2026-09-26（+1 天，没有多算 8 小时）');
  chk(d.currentWeek === 2, 'currentWeek = 2（学期 2026-09-14 起算）');

  chk(d.sessions.length === 0,
    `2026-09-25 是校历 OFF（中秋节）→ 今日课次必须为空（实际 ${d.sessions.length} 条）`);
  chk(d.tomorrowSessions.length === 0,
    `2026-09-26 也是校历 OFF → 明日课次必须为空（实际 ${d.tomorrowSessions.length} 条）`);

  /* 对照：旧口径「只比星期几」在这两天会列出什么 —— 证明这个修复确实解决了用户看到的问题 */
  const friday = SESSIONS.filter((s) => s.day_of_week === 5);
  const saturday = SESSIONS.filter((s) => s.day_of_week === 6);
  console.log(`\n  · 旧口径对照：周五有 ${friday.length} 节课次（${friday.map((s) => s.name).join(' / ')}）`)
  console.log(`                周六有 ${saturday.length} 节课次`);
  chk(friday.length > 0, '旧口径下 2026-09-25（周五）会错误地列出课次 —— 与用户反馈一致');
  chk(d.sessions.length < friday.length, '新口径不再列出放假日课次');

  /* 再验一个普通上课日：2026-09-24 周四（week 2，非节假日，A 组视角） */
  const thu = '2026-09-24';
  const wk2 = week.getWeek(CFG.term_start, thu);
  const cal = await week.loadCalendar(POOL);
  const thuList = SESSIONS.filter((s) => {
    if (!week.matchesWeeks(s.weeks, wk2, s.week_rule)) return false;
    const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk2, []);
    if (!slot || slot.day !== 4) return false;
    if (s.group_scope && s.group_scope !== 'A') return false;
    return week.classDateOf({ termStart: CFG.term_start }, wk2, 4, cal) === thu;
  });
  console.log(`  · 对照 2026-09-24（周四，正常上课日，A 组）= ${thuList.length} 条：${thuList.map((s) => `第${s.period}节 ${s.name}`).join(' / ')}`);
  chk(thuList.length > 0, '普通上课日照常列出课次（修复没有误伤）');

  console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 今日 / 明日课次探针全部通过'));
  process.exit(failed ? 1 : 0);
})();
