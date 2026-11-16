/**
 * 课前演讲排班内核（2026-11-16）—— 唯一实现，云函数与门禁共用同一份真源码。
 * ============================================================
 * 业务口径（2026-11-17 二次 grill 定稿 v2）：
 *   · 上午第1节前 8:00-8:10（slot=AM），下午第3节前 14:30-14:40（slot=PM）
 *   · **按实际课表**：只有当天课表有 period=1 / period=3 的集体课才排对应演讲；
 *     选修课（学生本地添加，不进 session 表）不纳入。
 *   · 演讲人组 = 该节课 group_scope：A课选A组、B课选B组、全体课(NULL)取"本轮最小未排号"追平落后组。
 *   · 每人**一个**进度游标（A/B 独立，回绕补漏，跨周永久续排），
 *     由 common/round-robin.js 的 pickBySeq/buildState 承载 —— 与值日游标完全隔离。
 *   · **起点 = 当前进度双游标**（管理员设 A/B 已排到号）：v2 已撤掉"每场人数/起始周几/
 *     起始时段/起始学号"四项固定设置；默认每场 2 人，智能排班可指定单场 1 人。
 *   · ⚠️ **assign 只预演不落库**：返回的 cursors 由云函数 speechPublish 在发布时才写
 *     speech_cursor，撤回回滚到发布前快照 —— 清空后重排不会跳过清空前的人。
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
 * @param {object} options   {start_weekday, start_slot, override:{[sessionId]:1|2}}
 *                          · 起始落点**只在 AI 智能排班的本次指令里出现**（v2 撤掉固定起始设置）；
 *                          · override = 指定课次的人数覆盖（"儿童文学仅1人"）。
 * @param {object} week      注入的 week 工具（matchesWeeks）
 * @returns {Array}          [{date, slot, scope, day, period}]，按 date+slot 升序
 */
function buildSlots(sessions, wk, options, week) {
  const opt = options || {};
  const startDay = Number(opt.start_weekday) || 0;
  const startSlot = opt.start_slot || 'AM';
  const useStart = startDay > 0;   // 有 AI 起始指令才过滤

  const rows = [];
  (sessions || []).forEach(s => {
    const period = Number(s.period);
    const slot = period === AM_PERIOD ? 'AM' : (period === PM_PERIOD ? 'PM' : null);
    if (!slot) return;
    if (week && week.matchesWeeks && !week.matchesWeeks(s.weeks, wk, s.week_rule)) return;
    const day = Number(s.day_of_week);
    /* 起始落点：首场之前的时段不排 —— 周几小于起始日整天不要；同一天若起始时段是 PM，AM 也不要。 */
    if (useStart) {
      if (day < startDay) return;
      if (day === startDay && startSlot === 'PM' && slot === 'AM') return;
    }
    const scope = s.group_scope === 'A' ? 'A' : (s.group_scope === 'B' ? 'B' : 'ALL');
    const row = { date: s.class_date || '', slot, scope, day, period, sessionId: s.id };
    /* 单场人数覆盖（AI 指定课名）：命中 override 的场次带 need=1/2 */
    const ov = opt.override || {};
    const n = Number(ov[s.id]);
    if (n === 1 || n === 2) row.need = n;
    rows.push(row);
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
 * @param {object} cursors {A,B} **管理员设置的"当前进度双游标"** / 上次发布落下的游标
 *                          —— v2 起起点就是这个，不再有任何 start_seq 下限
 * @param {object} options {need_n:2}  默认每场人数（单场 s.need 优先）
 * @returns {{rows:Array, cursors:object, short:number}}
 *          rows = [{date, slot, scope, memberId, seq, group, source:'AUTO'}]
 *          cursors = 本次预演后的游标 —— ⚠️ 只返回，不落库；由 speechPublish 在发布时才写入
 */
function assign(slots, roster, cursors, options) {
  const opt = options || {};
  let need = Number(opt.need_n);
  if (!(need === 1 || need === 2)) need = 2;
  const cur = Object.assign({ A: 0, B: 0 }, cursors || {});
  const state = rr.buildState(roster || [], cur);
  const out = [];
  let short = 0;
  (slots || []).forEach(s => {
    const scope = s.scope === 'A' ? 'A' : (s.scope === 'B' ? 'B' : null); // ALL→null 走全体混排
    const needThis = Number(s.need) === 1 || Number(s.need) === 2 ? Number(s.need) : need;
    const res = rr.pickBySeq(roster || [], scope, needThis, state);
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
    short
  };
}

module.exports = { AM_PERIOD, PM_PERIOD, buildSlots, assign };
