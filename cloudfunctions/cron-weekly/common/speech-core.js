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
 * @param {object} options {need_n:2, pins:[{day,slot,seqs:[12,14]}]}
 *                          · need_n = 默认每场人数（单场 s.need 优先）
 *                          · pins   = 用户点名「周三上午 b组12号14号」这类**指定人号**。
 *                            命中场次用指定的人（不再轮转），并把该组游标**落在这组最大号**上
 *                            （后续场次从它往后续排），这是 2026-11-17 用户实锤的第三版口径：
 *                            「从周三上午开始，b组12号14号，周三下午a组17号19号」。
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
  const list = roster || [];

  /* ---- 指定人号（pins）预处理 ------------------------------------------
   * 口径（用户 2026-11-17 实锤）：用户说「周三上午 b组12号14号」= 这一场就排 12、14，
   * 然后该组从 14 往后续排（周三下午 a组17号19号 ⇒ A 组从 19 往后续排）。
   * 所以 pin 不是「额外插一条」，而是**把游标搬到指定号上** —— 落在钉住的最大号。
   * ⚠️ 游标是"本轮已排到哪"的语义，搬动后 used 必须按新游标重建，
   *    否则进位时残留的 used 会让后续场次从旧位置续排（实测：pin 12/14 后仍出 52/54）。 */
  const bySeq = {};
  list.forEach(m => { const n = Number(m.seq); if (n > 0 && !bySeq[n]) bySeq[n] = m; });
  const pinMap = {};
  const pinnedSeqs = new Set();
  (Array.isArray(opt.pins) ? opt.pins : []).forEach(p => {
    const day = Number(p && p.day);
    const slot = p && p.slot === 'PM' ? 'PM' : (p && p.slot === 'AM' ? 'AM' : '');
    const seqs = (Array.isArray(p && p.seqs) ? p.seqs : [])
      .map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0);
    if (!(day > 0) || !slot || !seqs.length) return;
    const key = day + '|' + slot;
    if (!pinMap[key]) pinMap[key] = [];
    seqs.forEach(n => {
      if (pinMap[key].indexOf(n) < 0) pinMap[key].push(n);
      pinnedSeqs.add(n);
    });
  });
  const groupOf = (m) => (m.group === 'B' ? 'B' : 'A');

  const out = [];
  let short = 0;
  (slots || []).forEach(s => {
    const key = Number(s.day) + '|' + s.slot;
    const pin = pinMap[key];
    if (pin && pin.length) {
      const picked = [];
      pin.forEach(n => { const m = bySeq[n]; if (m && picked.indexOf(m) < 0) picked.push(m); });
      /* ① 每组游标搬到该组钉住的最大号 ② 按新游标重建 used（= 本轮已排到这儿） */
      const maxBy = { A: 0, B: 0 };
      picked.forEach(m => {
        const g = groupOf(m);
        if (Number(m.seq) > maxBy[g]) maxBy[g] = Number(m.seq);
      });
      ['A', 'B'].forEach(g => {
        if (!(maxBy[g] > 0)) return;
        state.cursors[g] = maxBy[g];
        const set = new Set();
        list.forEach(m => { if (groupOf(m) === g && Number(m.seq) <= maxBy[g]) set.add(Number(m.seq)); });
        state.used[g] = set;
      });
      picked.forEach(m => out.push({
        date: s.date,
        slot: s.slot,
        scope: s.scope,
        sessionId: s.sessionId,
        memberId: m.id,
        seq: m.seq,
        group: groupOf(m),
        source: 'PIN'
      }));
      if (picked.length < pin.length) short += pin.length - picked.length;
      return;
    }
    const scope = s.scope === 'A' ? 'A' : (s.scope === 'B' ? 'B' : null); // ALL→null 走全体混排
    const needThis = Number(s.need) === 1 || Number(s.need) === 2 ? Number(s.need) : need;
    /* 钉住的人不参与自动轮转（否则同一周可能被自动排一次、又在指定场排一次） */
    const res = rr.pickBySeq(list, scope, needThis, state, pinnedSeqs.size ? { skipSeqs: pinnedSeqs } : undefined);
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
