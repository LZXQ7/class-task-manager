/**
 * 课前演讲排班内核（2026-11-16）—— 唯一实现，云函数与门禁共用同一份真源码。
 * ============================================================
 * 业务口径（用户 grill 定稿）：
 *   · 上午第1节前 8:00-8:10（slot=AM），下午第3节前 14:30-14:40（slot=PM）
 *   · **按实际课表**：只有当天课表有 period=1 / period=3 的集体课才排对应演讲；
 *     选修课（学生本地添加，不进 session 表）不纳入。
 *   · 演讲人组 = 该节课 group_scope：A课选A组、B课选B组、全体课(NULL)从全班按序号选。
 *   · 每人**一个**进度游标（A/B 独立，到本组末尾回绕，跨周永久续排），
 *     由 common/round-robin.js 的 pickBySeq/buildState 承载 —— 与值日游标完全隔离。
 *   · 人数 need_n∈{1,2} 默认 2；起始设置（周几+时段、学号下限）只在首次生成消费一次。
 *
 * 本文件是纯函数层：不读库、不碰云环境，输入全是普通对象，便于门禁 vm/require 真跑。
 * ⚠️ 改完必须 `node scripts/sync-common.js` 同步到各云函数的 common 副本再重部署。
 */
const rr = require('./round-robin');

/** 场次的节次映射：AM 盯第1节，PM 盯第3节（用户口径「第一节课和第三节课」）。 */
const AM_PERIOD = 1;
const PM_PERIOD = 3;

/**
 * 从课次列表筛出本周需要排演讲的"场次骨架"。
 * @param {Array} sessions  [{id, day_of_week, period, group_scope, weeks, week_rule, ...}]
 *                          已由调用方处理调课( resolveSlot )与假日，period 是实际节次
 * @param {number} wk        第几周
 * @param {object} setting   {start_weekday, start_slot, init_done}
 * @param {object} week      注入的 week 工具（matchesWeeks）
 * @returns {Array}          [{date, slot, scope, day, period}]，按 date+slot 升序
 */
function buildSlots(sessions, wk, setting, week) {
  const st = setting || {};
  const startDay = Number(st.start_weekday) || 0;
  const startSlot = st.start_slot || 'AM';
  const consumeStart = !st.init_done && startDay > 0;   // 起始落点只在首次消费

  const rows = [];
  (sessions || []).forEach(s => {
    const period = Number(s.period);
    const slot = period === AM_PERIOD ? 'AM' : (period === PM_PERIOD ? 'PM' : null);
    if (!slot) return;
    if (week && week.matchesWeeks && !week.matchesWeeks(s.weeks, wk, s.week_rule)) return;
    const day = Number(s.day_of_week);
    /* 起始落点：首场之前的时段不排 —— 周几小于起始日整天不要；同一天若起始时段是 PM，AM 也不要。 */
    if (consumeStart) {
      if (day < startDay) return;
      if (day === startDay && startSlot === 'PM' && slot === 'AM') return;
    }
    const scope = s.group_scope === 'A' ? 'A' : (s.group_scope === 'B' ? 'B' : 'ALL');
    rows.push({ date: s.class_date || '', slot, scope, day, period, sessionId: s.id });
  });
  rows.sort((a, b) => (
    a.day - b.day || (a.slot === 'AM' ? -1 : 1) - (b.slot === 'AM' ? -1 : 1)
  ));
  return rows;
}

/**
 * 按序号轮转，为所有场次选人。
 * @param {Array} slots   buildSlots 的产物（或云函数算好的场次骨架）
 * @param {Array} roster  [{id, seq, group}]，seq>0 才参与；group='B' 进 B 池，其余进 A 池
 * @param {object} cursors {A,B} 上周续排游标
 * @param {object} setting  {need_n, start_seq, init_done}
 * @returns {{rows:Array, cursors:object, initDone:boolean, short:number}}
 *          rows = [{date, slot, scope, memberId, seq, group, source:'AUTO'}]
 */
function assign(slots, roster, cursors, setting) {
  const st = setting || {};
  let need = Number(st.need_n);
  if (!(need === 1 || need === 2)) need = 2;
  /* 首次生成且设了起始学号 → 游标从 start_seq-1 起（取 seq > cursor 的最小者 = start_seq）。 */
  const cur = Object.assign({ A: 0, B: 0 }, cursors || {});
  if (!st.init_done && Number(st.start_seq) > 0) {
    cur.A = Number(st.start_seq) - 1;
    cur.B = Number(st.start_seq) - 1;
  }
  const state = rr.buildState(roster || [], cur);
  const out = [];
  let short = 0;
  (slots || []).forEach(s => {
    const scope = s.scope === 'A' ? 'A' : (s.scope === 'B' ? 'B' : null); // ALL→null 走全体混排
    const res = rr.pickBySeq(roster || [], scope, need, state);
    short += res.short || 0;
    res.chosen.forEach(m => out.push({
      date: s.date,
      slot: s.slot,
      scope: s.scope,
      sessionId: s.sessionId,
      memberId: m.id,
      seq: m.seq,
      group: m.group === 'B' ? 'B' : 'A',
      source: 'AUTO'
    }));
  });
  return {
    rows: out,
    cursors: { A: state.cursors.A, B: state.cursors.B },
    initDone: true,
    short
  };
}

module.exports = { AM_PERIOD, PM_PERIOD, buildSlots, assign };
