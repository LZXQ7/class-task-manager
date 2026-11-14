/**
 * 云函数：adjust —— 换班 / 请假（开发文档 8.2 #6 / 7.5 状态机）
 * 原因仅预设 chips（COURSE/SICK/INTERN/OTHER），无自由文本。
 * action: swapCandidates / applySwap / applyLeave / listMine / pendingList / confirm / cancel
 *         + leaveBoard / addLeave / cancelLeave（1.0.5 需求④ 班委代登记请假）
 *
 * 换班确认权（2026-09-24 调整）：
 *   超级管理员「换人」= schedule.reassign，直接替换、无需申请（可还原）；
 *   普通成员「申请换班」= applySwap，落 PENDING_ADMIN，由**超级管理员**确认或拒绝。
 *   成员之间不再互相确认（历史 PENDING_PEER 数据仍兼容）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');
// 演示班级写操作硬闸（2026-11-13）：请假/换班/倒数日全在本函数，是本次违规假条穿透的链路
const reviewDemo = require('./common/review-demo');

const REASONS = ['COURSE', 'SICK', 'INTERN', 'OTHER'];
/**
 * 请假事由白名单（2026-11-03 需求③：公假 / 病假 / 事假 / 其他）。
 *
 * 🔴 **不要复用上面的 REASONS** —— 那是「换班事由」，落 swap_request.reason 列，
 *    该列是 `enum('COURSE','SICK','INTERN','OTHER')` 且在线上。若把 REASONS 改成
 *    公假/事假，换班插入会因枚举越界直接失败。两条业务线各用各的白名单。
 * OTHER 时 `reason_note` 存手填说明（前端强制填，后端双拦）。
 */
const LEAVE_REASONS = ['PUBLIC', 'SICK', 'PERSONAL', 'OTHER'];
const EXPIRE_HOURS = 24;

const STATUS_TEXT = {
  PENDING_PEER: 'PENDING_PEER',
  PENDING_ADMIN: 'PENDING_ADMIN',
  DONE: 'DONE',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED'
};

/* ---------------- 1.0.5 需求④ 请假登记用的常量与工具 ---------------- */

/* 测试账号唯一真源（见 common/test-account.js）。
 * ⚠️ 用 NOT_TEST(alias) 时必须**同时**带 `group_tag <> 'X'`
 *    （占位学号 STAFF 会顶坏前缀匹配，见 MEMORY）——
 *    调用侧自己拼 alias 时也别漏（NOT_TEST('m') + 各 SQL 里的 m.group_tag <> 'X'）。
 */
const { NOT_TEST } = require('./common/test-account');
const notTest = NOT_TEST;   // 保留旧名，SQL 里仍在用 notTest('m')

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 单次请假最长天数（含首尾）：防手滑选成跨学期 */
const LEAVE_MAX_DAYS = 31;

/** 归一化 YYYY-MM-DD；非法返回 ''（绝不放行 '2026-9-1' 这种能过 SQL 但语义不明的写法） */
function normDate(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  if (!DATE_RE.test(s)) return '';
  return Number.isFinite(Date.parse(s + 'T00:00:00Z')) ? s : '';
}

/**
 * 倒数日：目标日期距今多少天（正数=还有 N 天，0=今天，负数=已过 N 天）。
 *
 * 两端都按 **UTC 零点** 做差：`week.todayStr()` 已经是「北京时间日期」字符串
 * （fmtDate 内部 +8h 再取 ISO 日期，不受运行时区影响），再拼 `T00:00:00Z`，
 * 两个纯日期相减恒为整天数 —— 不会因为云函数跑在 UTC 而差一天。
 */
function cdDays(targetDate) {
  const t = String(targetDate || '').slice(0, 10);
  if (!DATE_RE.test(t)) return null;
  const a = Date.parse(week.todayStr() + 'T00:00:00Z');
  const b = Date.parse(t + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** 倒数日单条数量上限：防手滑 / 防刷（超过就别用倒数日了，该用备忘录） */
const CD_MAX_ITEMS = 50;

/** [a, b] 的天数（含首尾）；参数非法返回 Infinity（调用方据此拒绝） */
function spanDays(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.round((tb - ta) / 86400000) + 1;
}

/* ---------------- 请假 v2：半天假 + 假条图片（2026-10-08） ----------------
 * 时段口径（唯一来源）：start_time / end_time 为 TIME 列，NULL = 整天请假。
 * ⚠️ 语义是「区间内**每天**的相同时段」——跨天请假也是每天这个时段（如连三天每天
 *    8:00–12:00），**不支持**「首日 14:00 才开始」这种错位写法（用户 2026-10-08 定）。
 * 「正在请假中」（实时口径）= 当天 ∈ [start_date,end_date] 且 此刻 ∈ [start_time,end_time]；
 *    整天假（两列 NULL）当天全算。
 * ⚠️ 值日标记**不看时段**：登记请假仍按现有整天逻辑把区间内已排值日置 LEAVE
 *    （半天假也整天标记，用户 2026-10-08 反转「解耦」决议后定的原样保留）。 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 归一 HH:mm；非法 / 空 → ''。TIME 列在 dateStrings=true 下读出来是 'HH:mm:ss' */
function normTime(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 5);
  return TIME_RE.test(s) ? s : '';
}

/** 时段对：两空=整天；只给一半或结束不晚于开始 → 当场拦（不静默降级成整天） */
function normTimePair(a, b) {
  const s = normTime(a);
  const e = normTime(b);
  if (!s && !e) return { start: null, end: null };
  if (!s || !e) throw new BizError(41001, '开始与结束时间必须成对填写');
  if (e <= s) throw new BizError(41001, '结束时间必须晚于开始时间');
  return { start: s + ':00', end: e + ':00' };
}

/** 此刻是否落在请假时段内 —— 实时口径唯一判定处（2026-11-02 改用 periods）
 * 优先级：periods 非空 → 按「当前时刻落在哪个时段档」判定（am+pm 在晚上算回校）；
 *          periods 空/未设（整天假或旧记录）→ 按起止时间兜底（与旧口径一致）。 */
function inLeaveWindow(row, clock) {
  const p = row && row.periods;
  const per = Array.isArray(p)
    ? p
    : (p != null && p !== '' ? String(p).split(',').filter(Boolean) : []);
  if (!per.length) {
    const s = normTime(row && (row.startTime != null ? row.startTime : row.start_time));
    const e = normTime(row && (row.endTime != null ? row.endTime : row.end_time));
    if (!s || !e) return true;
    return clock >= s && clock <= e;
  }
  return per.indexOf(segmentOf(clock)) >= 0;
}

/* ---------------- 多时段（2026-11-02 需求①）：periods 权威字段 ----------------
 * periods ∈ {'am','pm','eve'} 的组合；空数组 / 空串 / NULL = 全天（与旧「两列 NULL」等价）。
 * 语义：区间内**每天**的选中时段（如 am+pm = 每天上午+下午，晚上回校）。
 * start_time/end_time 仅由 periods 派生回填，**仅供旧读取路径/显示兼容**，不参与实时判定。 */
const PERIOD_DEFS = {
  am:  { range: ['08:00', '12:00'], label: '上午' },
  pm:  { range: ['13:00', '18:00'], label: '下午' },
  eve: { range: ['18:00', '21:00'], label: '晚上' }
};
/** 合法时段 key 白名单（防注入非法 key） */
const PERIOD_KEYS = ['am', 'pm', 'eve'];

/** 归一 periods：数组去白名单 + 去重；含 'all' 或空 → 空数组（=全天） */
function normPeriods(arr) {
  if (!Array.isArray(arr)) return [];
  const set = [];
  for (const k of arr) {
    const s = String(k || '').trim();
    if (s === 'all' || s === '') continue;
    if (PERIOD_KEYS.indexOf(s) < 0) continue;   // 白名单外忽略
    if (set.indexOf(s) < 0) set.push(s);
  }
  return set;
}

/** periods → {start,end}（派生回填）。空 → 两列 NULL（整天）。 */
function periodsToTime(periods) {
  if (!periods || !periods.length) return { start: null, end: null };
  let s = '23:59', e = '00:00';
  for (const k of periods) {
    const d = PERIOD_DEFS[k];
    if (!d) continue;
    if (d.range[0] < s) s = d.range[0];
    if (d.range[1] > e) e = d.range[1];
  }
  return { start: s + ':00', end: e + ':00' };
}

/** 当前时刻落在哪个时段档（用于实时判定） */
function segmentOf(clock) {
  if (clock < '12:00') return 'am';
 if (clock < '18:00') return 'pm';
  return 'eve';
}

/** 字符串 periods（'am,pm' / '' / NULL）→ 数组 */
function parsePeriods(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.filter(Boolean);
  return String(s).split(',').map(x => x.trim()).filter(Boolean);
}

/**
 * periods 数组 → 中文展示（2026-11-03 需求①：**固定顺序 + 相邻合并**）。
 *
 * 顺序恒定按 am→pm→eve，与点选先后无关（点「下午」再点「上午」不能显示成「下午；上午」）。
 * 相邻时段合并成一个连续区间，跳段（不相邻）才分开说明：
 *   ['pm','am']  → '08:00–18:00'
 *   ['eve','pm'] → '13:00–21:00'
 *   ['eve','am'] → '上午 08:00–12:00；晚上 18:00–21:00'
 *   ['am']       → '上午 08:00–12:00'
 *   ['am','pm','eve'] → '08:00–21:00'
 *   []           → '全天'
 */
function periodsText(arr) {
  const raw = parsePeriods(arr);
  const a = PERIOD_KEYS.filter(k => raw.indexOf(k) >= 0);   // 固定顺序（不是点选顺序）
  if (!a.length) return '全天';
  const groups = [];
  let cur = [a[0]];
  for (let i = 1; i < a.length; i++) {
    if (PERIOD_KEYS.indexOf(a[i]) === PERIOD_KEYS.indexOf(a[i - 1]) + 1) cur.push(a[i]);
    else { groups.push(cur); cur = [a[i]]; }
  }
  groups.push(cur);
  return groups.map(g => {
    const s = PERIOD_DEFS[g[0]].range[0];
    const e = PERIOD_DEFS[g[g.length - 1]].range[1];
    return g.length > 1 ? (s + '–' + e) : (PERIOD_DEFS[g[0]].label + ' ' + s + '–' + e);
  }).join('；');
}

/** 区间内「还没值完」的值日 → 置 LEAVE（与 addLeave / leaveApprove 同口径） */
async function markDutiesLeave(pool, classId, memberId, startDate, endDate, operatorId) {
  const [duties] = await pool.query(
    "SELECT id FROM duty WHERE class_id = ? AND member_id = ? AND status IN ('PENDING','ONGOING') AND class_date BETWEEN ? AND ?",
    [classId, memberId, startDate, endDate]
  );
  for (const d of duties) {
    await pool.query("UPDATE duty SET status = 'LEAVE' WHERE id = ?", [d.id]);
    await pool.query('INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
      [d.id, operatorId, 'LEAVE', memberId]);
  }
  return duties.length;
}

/** 发系统通知给指定成员（scope=PICK），复用 notice_msg + notice_msg_target */
async function notifyMembers(pool, { classId, publisherId, title, content, memberIds }) {
  const ids = [...new Set((memberIds || []).map(Number).filter(Boolean))]
    .filter(id => id !== Number(publisherId));
  if (!ids.length) return 0;
  const [n] = await pool.query(
    "INSERT INTO notice_msg (class_id, publisher_id, title, content, scope, week) VALUES (?,?,?,?, 'PICK', NULL)",
    [classId, publisherId, title, content]
  );
  const noticeId = n.insertId;
  for (const mid of ids) {
    await pool.query('INSERT IGNORE INTO notice_msg_target (notice_id, member_id) VALUES (?, ?)', [noticeId, mid]);
  }
  return noticeId;
}

/** 'YYYY-MM-DD' → 加 n 天（返回同格式字符串）；用于归档/清除日的天数计算 */
function addDays(dateStr10, n) {
  const t = Date.parse(dateStr10 + 'T00:00:00Z');
  if (!Number.isFinite(t)) return '';
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/** 两个日期相差天数（b − a）；非法返回 null */
function diffDays(a, b) {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/**
 * 倒计时永不为负：清理按 **datetime** 触发（hourly / daily），展示按 **date** 计算，
 * 两者最多差不到一天 —— 不夹住的话那一小段时间里会显示「-1 天后清除」。
 */
function clampLeft(n) {
  return n === null || !Number.isFinite(n) ? null : Math.max(0, n);
}

/**
 * 假条图片的归档态与清除倒计时（唯一来源，前端不自己算）。
 *   · APPROVED：end_date 次日 0 点归档，清除日 = end_date + 8 天（归档起算 7 天）
 *     例：请到 10-08 → 10-09 凌晨归档、显示「7 天后清除」→ 10-16 凌晨物理删
 *   · CANCELLED：撤销即归档，清除日 = cancelled_at + 7 天
 * @returns {{archived:boolean, clearInDays:number|null}}
 */
function imageArchiveState(row, today) {
  if (!(row && row.leave_image)) return { archived: false, clearInDays: null };
  if (row.status === 'CANCELLED') {
    const base = row.cancelled_at ? String(row.cancelled_at).slice(0, 10) : String(row.created_at || '').slice(0, 10);
    if (!base) return { archived: true, clearInDays: null };
    return { archived: true, clearInDays: clampLeft(diffDays(today, addDays(base, 7))) };
  }
  const end = week.dateStr(row.end_date);
  if (!end) return { archived: false, clearInDays: null };
  const archiveFrom = addDays(end, 1);            // 次日 0 点进归档态
  const clearAt = addDays(end, 8);                // 归档起算第 7 天后清除
  return {
    archived: diffDays(archiveFrom, today) >= 0,
    clearInDays: clampLeft(diffDays(today, clearAt))
  };
}

async function loadSwap(pool, swapId) {
  const [rows] = await pool.query('SELECT * FROM swap_request WHERE id = ?', [swapId]);
  return rows[0] || null;
}

const routes = {
  /** 候选：同组 ACTIVE、未请假（放开重复排班：当天已有值日也可被选入其他课次），按 duty_count 升序 */
  swapCandidates: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyId = Number(payload.dutyId);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const [duties] = await pool.query(
        `SELECT d.*, s.group_scope FROM duty d JOIN session s ON s.id = d.session_id WHERE d.id = ? AND d.class_id = ?`, [dutyId, classId]
      );
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      const classDate = String(duty.class_date).slice(0, 10);
      const scope = duty.group_scope;
      const args = ['ACTIVE', classId];
      let sql = 'SELECT id, name, group_tag, duty_count, last_duty_at, student_no FROM member WHERE status = ? AND class_id = ? AND id != ? AND duty_off = 0 AND ' + notTest();
      args.push(me.id);
      if (scope) { sql += ' AND group_tag = ?'; args.push(scope); }
      const [members] = await pool.query(sql + ' ORDER BY duty_count, id', args);
      const [leaves] = await pool.query(
        "SELECT member_id FROM leave_request WHERE class_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ?",
        [classId, classDate, classDate]
      );
      const onLeave = new Set(leaves.map(l => l.member_id));
      // 放开重复排班（2026-10-21）：候选不再剔除「当天已有值日」的人，使其可被安排到其他课次的值日。
      // 仅保留请假（onLeave）剔除 —— 请假的人不该被排值日；同课次同周去重由执行侧 uq_duty 兜底。
      return members
        .filter(m => !onLeave.has(m.id))
        .map(m => ({ id: m.id, name: m.name, groupTag: m.group_tag, seq: week.seqOf(m.student_no), dutyCount: m.duty_count || 0, lastDutyAt: m.last_duty_at || null }));
    }
  },

  applySwap: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyId = Number(payload.dutyId);
      const toMemberId = Number(payload.toMemberId);
      const reason = REASONS.includes(payload.reason) ? payload.reason : 'OTHER';
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const [duties] = await pool.query('SELECT * FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '值日不存在');
      if (duty.member_id !== me.id) throw new BizError(40003, '仅能调整自己的值日');
      if (!['PENDING', 'ONGOING', 'EXPIRED'].includes(duty.status)) throw new BizError(41001, '该值日当前不可调整');
      // 不可重复发起
      const [dup] = await pool.query(
        "SELECT id FROM swap_request WHERE duty_id = ? AND from_member = ? AND status IN ('PENDING_PEER','PENDING_ADMIN')", [dutyId, me.id]
      );
      if (dup.length) throw new BizError(41001, '该值日已有待确认的申请');
      /**
       * 超管兜底：换人走 schedule.reassign（直接原地替换），不应产生「待确认」孤儿申请。
       * 前端已对超管隐藏「申请换班」按钮，这里再兜底一次 —— 万一有旧版/其它入口调到本接口，
       * 直接原地换人并落 DONE + duty_reassign（与 confirm(agree) 同一套做法），避免红点/待确认计数被孤儿请求污染。
       */
      if (guard.isSuper(me)) {
        const classDate = String(duty.class_date).slice(0, 10);
        try {
          await pool.query(
            "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
            [toMemberId, dutyId]
          );
        } catch (e) {
          throw new BizError(41001, '对方该时段已有值日，无法换入');
        }
        /* 换班**完全不碰 duty_count**（2026-10-07 用户口径）：
         * 轮转位置只由「自动排班」决定 —— 事后换人只是换一个来干活的人，
         * 不应该改变任何人在轮转队列里的位置（否则会把队尾的人提前、把队头的人推后）。
         * 只更新 last_duty_at：他确实值了日，展示「最近值日」要用。
         * ⚠️ 与「删除值日行要回滚标记」相反：删行必须 -1（真的少值一次），
         *    换班不动（值日次数没变，只是换了人）。两处别再写成对称加减。 */
        await pool.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, toMemberId]);
        await pool.query(
          'INSERT INTO duty_log (duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?)',
          [dutyId, me.id, 'SWAP', me.id, toMemberId]
        );
        const [rec] = await pool.query(
          `INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [dutyId, dutyId, duty.session_id, duty.week, me.id, toMemberId, me.id]
        );
        const [r] = await pool.query(
          `INSERT INTO swap_request (duty_id, type, from_member, to_member, reason, status, expire_at)
           VALUES (?, 'SWAP', ?, ?, ?, 'DONE', ?)`,
          [dutyId, me.id, toMemberId, reason, week.addMinutes(EXPIRE_HOURS * 60)]
        );
        console.log(JSON.stringify({ fn: 'adjust', action: 'applySwap', superDirect: true, member: me.id, swapId: r.insertId }));
        return { swapId: r.insertId, direct: true };
      }
      /**
       * 普通成员申请换人 = 需要**超级管理员确认**（不再是「被邀请人确认」）。
       * 成员只负责「提名想换给谁」，成不成由生活委员拍板；因此状态直接落 PENDING_ADMIN。
       */
      const [r] = await pool.query(
        `INSERT INTO swap_request (duty_id, type, from_member, to_member, reason, status, expire_at)
         VALUES (?, 'SWAP', ?, ?, ?, 'PENDING_ADMIN', ?)`,
        [dutyId, me.id, toMemberId, reason, week.addMinutes(EXPIRE_HOURS * 60)]
      );
      console.log(JSON.stringify({ fn: 'adjust', action: 'applySwap', member: me.id, swapId: r.insertId }));
      return { swapId: r.insertId };
    }
  },

  /** 请假：本人提交即时生效（MVP 简化，管理员订阅知会），值日置 LEAVE 并写 leave_request */
  applyLeave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const dutyIds = (payload.dutyIds || []).map(Number).filter(Boolean);
      const startDate = String(payload.startDate || '').slice(0, 10);
      const endDate = String(payload.endDate || '').slice(0, 10);
      const reason = REASONS.includes(payload.reason) ? payload.reason : 'OTHER';
      if (!dutyIds.length || !startDate || !endDate) throw new BizError(41001, '参数错误');
      // 请假 v2：本人请假同样支持时段（与班委代登记同表同口径）
      const tp = normTimePair(payload.startTime, payload.endTime);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      let swapId = null;
      for (const dutyId of dutyIds) {
        const [rows] = await pool.query('SELECT * FROM duty WHERE id = ? AND class_id = ?', [dutyId, classId]);
        const duty = rows[0];
        if (!duty || duty.member_id !== me.id) continue;
        if (!['PENDING', 'ONGOING', 'EXPIRED'].includes(duty.status)) continue;
        const [r] = await pool.query(
          `INSERT INTO swap_request (class_id, duty_id, type, from_member, start_date, end_date, reason, status, expire_at)
           VALUES (?, ?, 'LEAVE', ?, ?, ?, ?, 'DONE', ?)`,
          [classId, dutyId, me.id, startDate, endDate, reason, week.addMinutes(EXPIRE_HOURS * 60)]
        );
        swapId = r.insertId;
        await pool.query("UPDATE duty SET status = 'LEAVE' WHERE id = ?", [dutyId]);
        // ⚠️ class_id 必须显式写：线上 leave_request.class_id 是 NOT NULL DEFAULT 1 ——
        //    靠默认值只在 1 班正确，2/3/9/10 班会串班（而 schedule 侧按 class_id 过滤请假，
        //    串班后这条请假在排班里查不到 ⇒ 已请假的人照样被排到值日）。
        await pool.query(
          `INSERT INTO leave_request (class_id, member_id, swap_id, start_date, end_date, start_time, end_time, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED')`, [classId, me.id, r.insertId, startDate, endDate, tp.start, tp.end]
        );
        await pool.query(
          'INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
          [dutyId, me.id, 'LEAVE', me.id]
        );
      }
      if (!swapId) throw new BizError(41001, '没有可请假的有效值日');
      return { swapId };
    }
  },

  listMine: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, guard.classIdOf(ctx));
      const periods = week.periodMap(cfg);
      const [rows] = await pool.query(
        `SELECT sr.*, d.class_date, d.status AS dutyStatus, d.session_id, d.week,
                s.period AS sp, s.day_of_week, s.kind AS sessionKind, c.name AS courseName, c.room,
                mf.name AS fromName, mt.name AS toName, d.member_id AS dutyMemberId
           FROM swap_request sr
           JOIN duty d ON d.id = sr.duty_id
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
           JOIN member mf ON mf.id = sr.from_member
           LEFT JOIN member mt ON mt.id = sr.to_member
          WHERE sr.from_member = ? OR sr.to_member = ?
          ORDER BY sr.id DESC LIMIT 50`, [me.id, me.id]
      );
      // 临时调课后的真实节次（duty 表不含节次，需按 session_shift 解析）
      const shifts = await week.loadSessionShifts(pool, guard.classIdOf(ctx));
      return rows.map((r) => {
        const slot = week.resolveSlot(r.session_id, r.day_of_week, r.sp, r.week, shifts);
        const period = slot ? slot.period : r.sp;
        return {
          swapId: r.id,
          type: r.type,
          direction: r.from_member === me.id ? 'out' : 'in',
          dutyId: r.duty_id,
          dutyStatus: week.effectiveStatus({ status: r.dutyStatus, class_date: r.class_date, period }, periods),
          classDate: String(r.class_date).slice(0, 10),
          period,
          // CLEAN = 保洁课次（打扫 410）→ 前端显示「18点前」而不是「第 4 节」
          kind: r.sessionKind || 'COURSE',
          courseName: r.courseName,
          room: r.room || '',
          reason: r.reason,
          fromName: r.fromName,
          toName: r.toName || '',
          status: STATUS_TEXT[r.status] || r.status,
          createdAt: String(r.created_at).slice(0, 16),
          expireAt: String(r.expire_at).slice(0, 16)
        };
      });
    }
  },

  /**
   * 待确认的换班申请（超级管理员）。
   * 成员申请换人后落 PENDING_ADMIN，只有这里能看到「全班待我拍板」的申请。
   */
  pendingList: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      // v0.7.25：超管默认看**全部班** —— 主页红点计数（duty.today）是全库口径，
      // 这里却按 classIdOf(ctx) 只看「当前班」，跨班申请（如测试班）在「我的」页永远查不到，
      // 红点也因此永远不灭。两处口径必须一致：待确认列表 = 待确认计数。
      // 显式传 classId 仍可只看单班。
      // 需求 D：生活委员（非超管）**只能看本班** —— 超管的「默认全库」口径不适用，
      // 且即便显式传 classId 也只认本班（classIdOf 对非超管恒为本班，不可伪造）。
      const me = ctx.member || ctx.realMember;
      const targetClass = guard.isSuper(me)
        ? (payload.classId ? Number(payload.classId) : null)
        : guard.classIdOf(ctx);
      const classFilter = targetClass ? 'AND d.class_id = ?' : '';
      const [rows] = await pool.query(
        `SELECT sr.*, d.class_date, d.status AS dutyStatus, d.session_id, d.week,
                d.class_id, s.period AS sp, s.day_of_week, s.kind AS sessionKind,
                c.name AS courseName, c.room, cl.name AS className,
                mf.name AS fromName, mt.name AS toName
           FROM swap_request sr
           JOIN duty d ON d.id = sr.duty_id
           JOIN session s ON s.id = d.session_id
           JOIN course c ON c.id = s.course_id
           JOIN class cl ON cl.id = d.class_id
           JOIN member mf ON mf.id = sr.from_member
           LEFT JOIN member mt ON mt.id = sr.to_member
          WHERE sr.status = 'PENDING_ADMIN' AND sr.type = 'SWAP' ${classFilter}
          ORDER BY sr.id DESC LIMIT 50`,
        targetClass ? [targetClass] : []
      );
      // 临时调课映射按班各自加载（跨班列表不能只载当前班的 shifts）
      const classIds = [...new Set(rows.map((r) => Number(r.class_id)))];
      const shiftMap = {};
      for (const cid of classIds) {
        shiftMap[cid] = await week.loadSessionShifts(pool, cid);
      }
      return rows.map((r) => {
        const slot = week.resolveSlot(r.session_id, r.day_of_week, r.sp, r.week, shiftMap[Number(r.class_id)] || []);
        return {
          swapId: r.id,
          dutyId: r.duty_id,
          classId: Number(r.class_id),
          className: r.className || '',
          classDate: String(r.class_date).slice(0, 10),
          period: slot ? slot.period : r.sp,
          kind: r.sessionKind || 'COURSE',
          courseName: r.courseName,
          room: r.room || '',
          reason: r.reason,
          fromMemberId: r.from_member,
          fromName: r.fromName,
          toMemberId: r.to_member,
          toName: r.toName || '',
          createdAt: String(r.created_at).slice(0, 16)
        };
      });
    }
  },

  /**
   * 确认换班：**由超级管理员处理**（agree=true 生效换班 / false 拒绝）。
   * 成员之间不再互相确认 —— 申请提交时状态即为 PENDING_ADMIN。
   * 生效后同样写一条 duty_reassign，管理员点错了也能一键还原。
   */
  confirm: {
    auth: { scheduleAuth: true },
    handler: async (payload, ctx) => {
      const me = guard.requireScheduleAuth(ctx);
      const swapId = Number(payload.swapId);
      const agree = !!payload.agree;
      const pool = getPool();
      const swap = await loadSwap(pool, swapId);
      if (!swap) throw new BizError(41001, '申请不存在');
      if (!swap.to_member) throw new BizError(41001, '该申请没有指定替补');
      // PENDING_PEER 是改造前的历史状态，一并兼容
      if (!['PENDING_PEER', 'PENDING_ADMIN'].includes(swap.status)) throw new BizError(41001, '该申请已处理');
      // v0.7.25：按 duty_id 直接取，不再叠加 class_id = classIdOf(ctx) ——
      // 超管已过 guard.requireSuper（可跨班），原写法在「当前班 ≠ 申请所在班」时
      // 会 41001「原值日不存在」：列表修好后这里就成了第二个断点。
      const [duties] = await pool.query('SELECT * FROM duty WHERE id = ?', [swap.duty_id]);
      const duty = duties[0];
      if (!duty) throw new BizError(41001, '原值日不存在');
      // 需求 D：非超管（生活委员）只能处理**本班**申请。
      // 列表侧已按本班过滤，这里再卡一道 —— 否则可直接构造别班的 swapId 越权确认。
      if (!guard.isSuper(me) && Number(duty.class_id) !== guard.classIdOf(ctx)) {
        throw new BizError(40003, '只能处理本班的换班申请');
      }
      if (!agree) {
        await pool.query("UPDATE swap_request SET status = 'REJECTED' WHERE id = ?", [swapId]);
        return { status: 'REJECTED' };
      }
      const classDate = String(duty.class_date).slice(0, 10);
      // 生效：**原地换人**（与 schedule.reassign 同一套做法，一个课次只留一条值日记录）
      try {
        await pool.query(
          "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
          [swap.to_member, swap.duty_id]
        );
      } catch (e) {
        await pool.query("UPDATE swap_request SET status = 'REJECTED' WHERE id = ?", [swapId]);
        throw new BizError(41001, '对方该时段已有值日，无法换入');
      }
      /* 换班不碰 duty_count（口径见 requestSwap 处的注释）：只记 last_duty_at，轮转队列不动。 */
      await pool.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, swap.to_member]);
      await pool.query(
        'INSERT INTO duty_log (duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?)',
        [swap.duty_id, me.id, 'SWAP', swap.from_member, swap.to_member]
      );
      // 与 schedule.reassign 共用同一套换人记录，管理员在值日详情里可以「还原」
      const [rec] = await pool.query(
        `INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [swap.duty_id, swap.duty_id, duty.session_id, duty.week, swap.from_member, swap.to_member, me.id]
      );
      await pool.query("UPDATE swap_request SET status = 'DONE' WHERE id = ?", [swapId]);
      return { status: 'DONE', reassignId: rec.insertId };
    }
  },

  cancel: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const swapId = Number(payload.swapId);
      const pool = getPool();
      const swap = await loadSwap(pool, swapId);
      if (!swap) throw new BizError(41001, '申请不存在');
      if (swap.from_member !== me.id) throw new BizError(40003, '仅申请人可撤销');
      if (!['PENDING_PEER', 'PENDING_ADMIN'].includes(swap.status)) throw new BizError(41001, '当前状态不可撤销');
      // 若请假已即时生效，撤销时恢复值日
      if (swap.type === 'LEAVE') {
        await pool.query("UPDATE duty SET status = 'PENDING' WHERE id = ? AND status = 'LEAVE'", [swap.duty_id]);
        await pool.query("UPDATE leave_request SET status = 'CANCELLED' WHERE swap_id = ?", [swapId]);
      }
      await pool.query("UPDATE swap_request SET status = 'CANCELLED' WHERE id = ?", [swapId]);
      return {};
    }
  },

  /* ================= 1.0.5 需求④：班委「请假登记」 =================
   * 与本人请假（applyLeave）的三点差别：
   *   ① **代他人登记**（班委替本班学生）；
   *   ② **按日期区间**登记，不挑具体值日行（学生下周请假也能提前登记）；
   *   ③ 不写 swap_request —— 那是「本人申请」的载体，代登记不是学生本人的申请；
   *      且 swap_request.duty_id 是 NOT NULL，区间请假没有唯一 duty 可挂。
   * 值日侧：区间内状态为 PENDING/ONGOING 的行置 'LEAVE'（已完成/已请假的保持原状）。
   */

  /** 请假看板：某一天（默认今天）本班生效中的请假名单 + 计数（成员与分组页用） */
  leaveBoard: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      guard.requireLeaveView(ctx);
      const pool = getPool();
      const classId = await guard.resolveClassId(pool, ctx, payload);
      const date = normDate(payload.date) || week.todayStr();
      // 体验模式（guard.isDemoMember，与登录 demo 标记同源）：「常驻」= 去掉「仅今天生效」过滤，
      // 返回演示班全部请假记录（含过期/未来），否则演示者看不到过期请假，体验断裂（2026-11-12 需求）。
      const isDemo = await guard.isDemoMember(pool, ctx);
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date,
                l.start_time, l.end_time, l.periods, l.leave_image,
                m.name, m.group_tag, m.student_no
           FROM leave_request l
           JOIN member m ON m.id = l.member_id
          WHERE l.class_id = ? AND l.status = 'APPROVED'
            ${isDemo ? '' : 'AND l.start_date <= ? AND l.end_date >= ?'}
            AND m.class_id = ? AND m.status <> 'DISABLED'
            AND m.group_tag <> 'X' AND ${notTest('m')}
          ORDER BY m.student_no`,
        isDemo ? [classId, classId] : [classId, date, date, classId]
      );
      /* ⚠️ 口径分层（2026-10-08 定，别再合并成一套）：
       *   list / stat = **日期口径**（今天有生效请假的全列，含已过时段半天假）
       *                —— 首页「x人请假」计数与弹层名单走它，数字恒等于行数（统计同源）；
       *   now         = **实时口径**（此刻真的在请假时段内）
       *                —— 只给「在位统计」用（在位 = 名册 − now.leave）。 */
      const clock = week.nowHHmm();
      const list = rows.map(r => ({
        leaveId: Number(r.leaveId),
        memberId: Number(r.memberId),
        name: r.name,
        groupTag: r.group_tag,
        seq: String(r.student_no || '').slice(-2),
        // 🔴 完整学号（2026-10-09 用户实拍「课堂情况里只有 xxx请假，前面没有学号」）：
        //    SQL 早就选了 `m.student_no`，但**映射时漏了这个字段** ⇒ 前端
        //    `String(x.studentNo || '')` 拿到空串 ⇒ 复制出去变成「郝鹏杰请假」。
        //    ⚠️ `seq`（后两位）不能顶替 —— 模板要的是完整学号（形如 000000000056）。
        studentNo: String(r.student_no || ''),
        startDate: week.dateStr(r.start_date),
        endDate: week.dateStr(r.end_date),
        startTime: normTime(r.start_time),
        endTime: normTime(r.end_time),
        periods: parsePeriods(r.periods),
        hasImage: !!r.leave_image,
        image: r.leave_image || ''
      }));
      const nowList = list.filter(x => inLeaveWindow(x, clock));
      return {
        date,
        list,
        stat: {
          leave: list.length,
          leaveA: list.filter(x => x.groupTag === 'A').length,
          leaveB: list.filter(x => x.groupTag === 'B').length
        },
        now: {
          leave: nowList.length,
          leaveA: nowList.filter(x => x.groupTag === 'A').length,
          leaveB: nowList.filter(x => x.groupTag === 'B').length
        }
      };
    }
  },

  /**
   * 首页请假卡 / 辅导员各班汇总（1.0.5 追加，需求①②）：
   *   · 辅导员（X 组）→ { mode:'counselor', classes:[{classId, className, leave}] }（其绑定范围内每班今日请假数）
   *   · 其它身份（班委 / 超管 / 学生）→ { mode:'class', classId, className, date, list, stat }（本班今日请假）
   * 权限 = requireLeaveView（辅导员可读不可写）；班级隔离走 resolveClassId。
   * 注意：本接口**只给汇总/查看**，登记与撤销仍是 addLeave / cancelLeave。
   */
  leaveSummary: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveView(ctx);
      const pool = getPool();
      // 体验模式（与登录 demo 同源）：常驻 = 去掉「仅今天生效」过滤，返回演示班全部请假记录。
      const isDemo = await guard.isDemoMember(pool, ctx);
      const date = normDate(payload.date) || week.todayStr();
      if (guard.isCounselor(me)) {
        const ids = await guard.staffClassIds(pool, me);
        // ⚠️ 各班汇总走**实时口径**（此刻真在请假的人）—— 与在位统计同一套口径；
        //    日期口径只给「名单 + 撤销」用（leaveBoard / leaveHistory）。
        const clock = week.nowHHmm();
        const classes = [];
        for (const cid of ids) {
          const [c] = await pool.query('SELECT name FROM `class` WHERE id = ?', [cid]);
          const [r] = await pool.query(
            `SELECT l.start_time, l.end_time, l.periods
               FROM leave_request l JOIN member m ON m.id = l.member_id
              WHERE l.class_id = ? AND l.status = 'APPROVED' ${isDemo ? '' : 'AND l.start_date <= ? AND l.end_date >= ?'}
                AND m.group_tag <> 'X' AND ${notTest('m')}`,
            isDemo ? [cid] : [cid, date, date]
          );
          // 实时口径：此刻真在请假时段内（多时段下按「当前时段是否入选中集合」判定）
          const n = r.filter(x => inLeaveWindow(x, clock)).length;
          classes.push({ classId: cid, className: c.length ? c[0].name : ('班级' + cid), leave: n });
        }
        return { mode: 'counselor', date, classes };
      }
      const classId = await guard.resolveClassId(pool, ctx, {});
      const [cl] = await pool.query('SELECT name FROM `class` WHERE id = ?', [classId]);
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date,
                l.start_time, l.end_time, l.periods, l.leave_image,
                m.name, m.group_tag, m.student_no
           FROM leave_request l
           JOIN member m ON m.id = l.member_id
          WHERE l.class_id = ? AND l.status = 'APPROVED'
            ${isDemo ? '' : 'AND l.start_date <= ? AND l.end_date >= ?'}
            AND m.class_id = ? AND m.status <> 'DISABLED'
            AND m.group_tag <> 'X' AND ${notTest('m')}
          ORDER BY m.student_no`,
        isDemo ? [classId, classId] : [classId, date, date, classId]
      );
      const clock2 = week.nowHHmm();
      const list = rows.map(r => ({
        leaveId: Number(r.leaveId),
        memberId: Number(r.memberId),
        name: r.name,
        groupTag: r.group_tag,
        seq: String(r.student_no || '').slice(-2),
        startDate: week.dateStr(r.start_date),
        endDate: week.dateStr(r.end_date),
        startTime: normTime(r.start_time),
        endTime: normTime(r.end_time),
        periods: parsePeriods(r.periods),
        hasImage: !!r.leave_image,
        image: r.leave_image || ''
      }));
      const nowList = list.filter(x => inLeaveWindow(x, clock2));
      return {
        mode: 'class',
        classId,
        className: cl.length ? cl[0].name : '',
        date,
        list,
        stat: {
          leave: list.length,
          leaveA: list.filter(x => x.groupTag === 'A').length,
          leaveB: list.filter(x => x.groupTag === 'B').length
        },
        now: {
          leave: nowList.length,
          leaveA: nowList.filter(x => x.groupTag === 'A').length,
          leaveB: nowList.filter(x => x.groupTag === 'B').length
        }
      };
    }
  },

  addLeave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveRegister(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const memberId = Number(payload.memberId);
      const startDate = normDate(payload.startDate);
      const endDate = normDate(payload.endDate);
      if (!memberId || !startDate || !endDate) throw new BizError(41001, '请选择同学与请假日期');
      if (endDate < startDate) throw new BizError(41001, '结束日期不能早于开始日期');
      if (spanDays(startDate, endDate) > LEAVE_MAX_DAYS) throw new BizError(41001, '单次请假最多 ' + LEAVE_MAX_DAYS + ' 天');
      // 请假 v2（2026-11-02 升级）：多时段。periods 权威（空=全天），派生 start/end 仅兼容。
      const periods = normPeriods(payload.periods);
      const tp = periodsToTime(periods);
      // 目标必须是本班在读**学生**（教职工 / 测试账号 / 已停用一律拒绝）
      const [ms] = await pool.query(
        "SELECT id FROM member WHERE id = ? AND class_id = ? AND status <> 'DISABLED' AND group_tag <> 'X' AND " + notTest(''),
        [memberId, classId]
      );
      if (!ms.length) throw new BizError(41003, '只能给本班在读学生登记请假');
      // 幂等：同人同区间**同时段**已生效 → 直接返回（重复提交不重复写，避免 BASH 重试/连点造成双写）
      // ⚠️ 时段必须一起比：只比日期会让「整天假」和「半天假」互相吞掉（半天假登记不进去）
      const [dup] = await pool.query(
        "SELECT id FROM leave_request WHERE class_id = ? AND member_id = ? AND status = 'APPROVED' " +
        "AND start_date = ? AND end_date = ? AND IFNULL(periods,'') = ? AND source = 'register'",
        [classId, memberId, startDate, endDate, periods.join(',')]
      );
      if (dup.length) return { leaveId: Number(dup[0].id), affected: 0, existed: true };
      const affected = await markDutiesLeave(pool, classId, memberId, startDate, endDate, me.id);
      const [ins] = await pool.query(
        "INSERT INTO leave_request (class_id, member_id, start_date, end_date, start_time, end_time, periods, status, source) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED', 'register')",
        [classId, memberId, startDate, endDate, tp.start, tp.end, periods.join(',')]
      );
      console.log(JSON.stringify({ fn: 'adjust', action: 'addLeave', by: me.id, target: memberId, startDate, endDate, periods: periods.join(','), affected }));
      return { leaveId: Number(ins.insertId), affected };
    }
  },

  /** 撤销代登记的请假：置 CANCELLED，并恢复**不被其它请假覆盖**的值日（对称） */
  cancelLeave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveRegister(ctx);
      const classId = guard.classIdOf(ctx);
      const leaveId = Number(payload.leaveId);
      if (!leaveId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [lr] = await pool.query('SELECT * FROM leave_request WHERE id = ? AND class_id = ?', [leaveId, classId]);
      const leave = lr[0];
      if (!leave) throw new BizError(41004, '请假记录不存在');
      if (leave.status !== 'APPROVED') throw new BizError(41001, '该请假已撤销');
      // 请假 v2：cancelled_at 是「假条图片归档」的第二个起点（撤销即归档、+7 天清除）
      await pool.query("UPDATE leave_request SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?", [week.nowStamp(), leaveId]);
      const from = week.dateStr(leave.start_date);
      const to = week.dateStr(leave.end_date);
      const [duties] = await pool.query(
        "SELECT id, class_date FROM duty WHERE class_id = ? AND member_id = ? AND status = 'LEAVE' AND class_date BETWEEN ? AND ?",
        [classId, leave.member_id, from, to]
      );
      let restored = 0;
      for (const d of duties) {
        const date = week.dateStr(d.class_date);
        // 同一天若仍被**另一条生效请假**覆盖（例如学生本人也请过）→ 不恢复，
        // 否则「撤一条」会把另一条请假的效力一起抹掉。
        const [other] = await pool.query(
          "SELECT id FROM leave_request WHERE class_id = ? AND member_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ? LIMIT 1",
          [classId, leave.member_id, date, date]
        );
        if (other.length) continue;
        await pool.query("UPDATE duty SET status = 'PENDING' WHERE id = ? AND status = 'LEAVE'", [d.id]);
        await pool.query('INSERT INTO duty_log (duty_id, operator_id, action, from_member) VALUES (?,?,?,?)',
          [d.id, me.id, 'CANCEL', leave.member_id]);
        restored++;
      }
      console.log(JSON.stringify({ fn: 'adjust', action: 'cancelLeave', by: me.id, leaveId, restored }));
      return { restored };
    }
  },

  /* ============ 请假 v2（2026-10-08）：历史记录 + 假条图片 ============ */

  /**
   * 历史请假记录（登记弹层「历史」tab 用）。
   *   · 权限 = requireLeaveView（班委 / 超管 / 辅导员；**辅导员只读**，无撤销/传图）
   *   · **含已撤销**（用户定：只要添加过就列入），状态三态：进行中 / 已结束 / 已撤销
   *     （今天还没开始的未来请假 = 未开始）
   *   · **排序（2026-10-08 用户定）**：先按**开始日期倒序**，同一天再按**序号从大到小**
   *     —— 原来是 `l.id DESC`（= 登记先后），同一天的人被登记顺序打散，
   *     看着「乱的」。序号 = `student_no` 后两位（与前端 `seq` 同一口径），
   *     所以排序键必须写 `RIGHT(m.student_no,2)`，不能在前端排（分页/100 条截断会错位）。
   *     末尾补 `l.id DESC` 兜同日同时同序号的并列，保证分页稳定。
   *   · 倒序 **300** 条、不做筛选（用户定）：日期分类 + 日期区间筛选 + 人员搜索/筛选
   *     全部在**前端**做（本地产物即时出结果，不等网络）⇒ 一次拉够本学期量即可。
   *     300 是「拉到够用」与「包不过大」的折中；真要更早的记录再加分页，勿静默截断。
   *   · 假条图片只回 fileID，前端批量换临时链接；附归档态与「N 天后清除」倒计时
   *   · 额外回 `today`（后端时钟），前端算「近 7 天 / 近 30 天」快捷时段用它当日基准，
   *     不让前端自己取日期 —— 跨零点时两者会错开一天。
   * 班级隔离走 resolveClassId（辅导员可看自己带的班）。
   */
  leaveHistory: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      guard.requireLeaveView(ctx);
      const pool = getPool();
      const classId = await guard.resolveClassId(pool, ctx, payload);
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date,
                l.start_time, l.end_time, l.periods, l.leave_image, l.status, l.created_at, l.cancelled_at,
                m.name, m.group_tag, m.student_no
           FROM leave_request l
           JOIN member m ON m.id = l.member_id
          WHERE l.class_id = ? AND l.status IN ('APPROVED','CANCELLED')
            AND m.class_id = ? AND m.status <> 'DISABLED'
            AND m.group_tag <> 'X' AND ${notTest('m')}
          ORDER BY l.start_date DESC, RIGHT(m.student_no, 2) DESC, l.id DESC LIMIT 300`,
        [classId, classId]
      );
      const today = week.todayStr();
      // ⚠️ 状态判定必须**比时刻**而不只是比日期（2026-10-09 用户实拍）：
      //    上午 08:10-09:50 的假，到下午看仍是「进行中」—— 只比 `today > end` 的话，
      //    end 与today 同日 ⇒ 永远落在 ONGOING 分支里，而用户要的是「时段过了 = 已结束」。
      //    这与首页请假卡的实时数字（`now` 口径，见 leaveBoard）**必须一致**，
      //    否则两处打架：卡片说 0 人请假、列表说有人进行中。
      // ⚠️ 真名是 `week.nowHHmm()`（**没有** clockNow；上一版写成 `week.clockNow` 时
      //    因为加了 `if (clock)` 保护而**静默失效**：状态永远走不到时刻判定那一步，
      //    表现为「改了没效果」。所以凡是自己新起的名字，grep 核实过再用。
      const clock = week.nowHHmm();
      const list = rows.map((r) => {
        const start = week.dateStr(r.start_date);
        const end = week.dateStr(r.end_date);
        // 状态由「当前时刻 vs 区间」现算，不存列：请假结束是时间推移的自然结果
        let state = 'ONGOING';
        if (r.status === 'CANCELLED') {
          state = 'CANCELLED';
        } else if (today > end) {
          // 区间已整体过去（跨天假也算结束）
          state = 'ENDED';
        } else if (today < start) {
          state = 'UPCOMING';
        } else if (clock) {
          // 🔴 **今天之内**的假：必须拿时刻比，否则上午的假下午仍显示「进行中」。
          //    `inLeaveWindow` 对「无时段」（start/end_time 为 NULL，即整天假）直接返回 true
          //    ⇒ 整天假保持 ONGOING，这是对的（整天假没有结束的那一刻）。
          if (inLeaveWindow(r, clock)) {
            state = 'ONGOING';
          } else {
            // 时段已过：对用户只呈现「已结束」（课表视角：上午那节课已经上了）。
            // ⚠️ 尚未开始（现在 < 开始时刻）⇒ UPCOMING，别一律ENDED。
            state = clock < normTime(r.start_time) ? 'UPCOMING' : 'ENDED';
          }
        }
        const arc = imageArchiveState(r, today);
        return {
          leaveId: Number(r.leaveId),
          memberId: Number(r.memberId),
          name: r.name,
          groupTag: r.group_tag,
          seq: String(r.student_no || '').slice(-2),
          // 全学号：前端人员搜索要能按学号找（seq 只有后两位，短号搜不全）
          studentNo: String(r.student_no || ''),
          startDate: start,
          endDate: end,
          startTime: normTime(r.start_time),
          endTime: normTime(r.end_time),
          periods: parsePeriods(r.periods),
          state,
          hasImage: !!r.leave_image,
          image: r.leave_image || '',
          imageArchived: arc.archived,
          clearInDays: arc.clearInDays,
          createdAt: String(r.created_at || '').slice(0, 16)
        };
      });
      return { list, today };
    }
  },

  /**
   * 假条图片上传（登记**之后**补传，覆盖式单张）。
   *   · 权限 = requireLeaveRegister（仅班委 / 超管；辅导员与同学都不能传）
   *   · 只接云存储 fileID（前端已直传完毕），不接二进制 —— 云函数绑 VPC 拉云存储极慢
   *   · 换图时**顺手删掉旧文件**，否则云存储只涨不减
   * ⚠️ 内容安全：与「通知配图」（notice_msg.images）同口径 —— 那一处也没走送审，
   *    这里保持一致（要加就两边一起加，别只加一处）。
   */
  leaveImageSet: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveRegister(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const leaveId = Number(payload.leaveId);
      const fileId = String(payload.fileId || '').slice(0, 128);
      if (!leaveId) throw new BizError(41001, '参数错误');
      if (fileId.indexOf('cloud://') !== 0) throw new BizError(41001, '图片上传失败，请重试');
      const [lr] = await pool.query(
        'SELECT id, leave_image FROM leave_request WHERE id = ? AND class_id = ?', [leaveId, classId]
      );
      if (!lr.length) throw new BizError(41004, '请假记录不存在');
      const old = lr[0].leave_image || '';
      await pool.query('UPDATE leave_request SET leave_image = ? WHERE id = ?', [fileId, leaveId]);
      if (old && old !== fileId) {
        try { await cloud.deleteFile({ fileList: [old] }); } catch (e) { /* 旧图删不掉不影响新图 */ }
      }
      console.log(JSON.stringify({ fn: 'adjust', action: 'leaveImageSet', by: me.id, leaveId }));
      return { leaveId, fileId };
    }
  },

  /**
   * 删除**已撤销**的请假记录（2026-10-09 需求：历史 tab 里清掉撤销过的条目）。
   *
   * ⚠️ 这是**物理删除、不可恢复**，比撤销更重，所以口径收得比撤销更紧：
   *   · 权限 = `requireLeaveRegister`（超管 + 班委）—— 与 `cancelLeave` **同一套**，
   *     不另造（另造必然与撤销权限漂移）。辅导员只有 `requireLeaveView`（只读）⇒ 不给。
   *   · **只允许删 `CANCELLED`**：`ONGOING` / `ENDED` / `UPCOMING` 一律拒。
   *     为什么只给已撤销：① 已撤销的值日**已经在 cancelLeave 里恢复过**（LEAVE→PENDING），
   *       删它不会影响值日；② 生效中/已结束的记录是「曾发生过」的证据，
   *       而已撤销的记录留着只会污染历史列表（用户实拍：一条已撤销的挂在最上面）。
   *
   * ⚠️ 连带删掉假条图片（用户 2026-10-09 定）：否则云存储只涨不减 ——
   *   注意这里的假条**已经过了归档期**（撤销即归档、+7 天物理清除，见 imageArchiveState），
   *   留着就是纯垃圾。删不掉不报错（与 leaveImageSet 的旧图删不掉同款处理）。
   *
   * ⚠️ 班级隔离：`WHERE id = ? AND class_id = ?` —— 跨班传 id 一律「记录不存在」。
   */
  leaveDelete: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireLeaveRegister(ctx);
      const classId = guard.classIdOf(ctx);
      const leaveId = Number(payload.leaveId);
      if (!leaveId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [lr] = await pool.query(
        'SELECT id, member_id, status, leave_image FROM leave_request WHERE id = ? AND class_id = ?',
        [leaveId, classId]
      );
      if (!lr.length) throw new BizError(41004, '请假记录不存在');
      const row = lr[0];
      // 🔴 判据极性 = 「**只有已撤销能删**」。这里写成 !== CANCELLED 就拒，
      //    将来若新增状态（如 PENDING 审批中）也自动被挡住，不必改这里。
      if (row.status !== 'CANCELLED') throw new BizError(41001, '只能删除已撤销的请假记录');
      await pool.query('DELETE FROM leave_request WHERE id = ? AND class_id = ?', [leaveId, classId]);
      const fileId = row.leave_image || '';
      if (fileId) {
        try { await cloud.deleteFile({ fileList: [fileId] }); } catch (e) { /* 删不掉不影响记录已删 */ }
      }
      console.log(JSON.stringify({
        fn: 'adjust', action: 'leaveDelete', by: me.id, leaveId,
        memberId: row.member_id, hadImage: !!fileId
      }));
      return { leaveId };
    }
  },

  /* ================= 2026-11-02 需求②：成员自申请 + 审批 =================
   * 与班委代登记（addLeave，即时生效）两条线共用一张 leave_request 表，用 source 区分：
   *   · source='register'  → 班委/超管代登记，即时 APPROVED（见 addLeave）
   *   · source='apply'     → 成员自申请，落 PENDING，由班长/副班长/超管审批
   * 审批：单级、任一审批人（班长兼团支书 / 副班长 / 超管）通过即生效；驳回可重提。 */

  /**
   * 成员自申请请假：填日期区间 + 多时段 + 可选假条，落 PENDING，由本班审批人审批。
   * 仅本人可提交（memberId 强制 = 本人）；不立即标记值日（审批通过才标记，见 leaveApprove）。
   * 提交后通知本班审批人（班长/副班长 + 超管）。
   */
  leaveApply: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const startDate = normDate(payload.startDate);
      const endDate = normDate(payload.endDate);
      if (!startDate || !endDate) throw new BizError(41001, '请选择请假日期');
      if (endDate < startDate) throw new BizError(41001, '结束日期不能早于开始日期');
      if (spanDays(startDate, endDate) > LEAVE_MAX_DAYS) throw new BizError(41001, '单次请假最多 ' + LEAVE_MAX_DAYS + ' 天');
      const periods = normPeriods(payload.periods);
      const tp = periodsToTime(periods);
      const reason = LEAVE_REASONS.includes(payload.reason) ? payload.reason : 'OTHER';
      // 「其他」可补一句手填说明（选填，最多 30 字）；非 OTHER 时一律丢弃，不落库
      const reasonNote = reason === 'OTHER' ? String(payload.reasonNote || '').trim().slice(0, 30) : '';
      // 假条必传（2026-11-03 需求②）：前端拦一次，后端再拦一次——绕过界面直调云函数也必须带图
      const fileId = String(payload.fileId || '').slice(0, 128);
      if (!fileId) throw new BizError(41001, '请上传假条照片');
      if (fileId.indexOf('cloud://') !== 0) throw new BizError(41001, '假条图片上传失败，请重试');
      // 幂等：同人同区间同段已存在 apply 记录 → 直接返回（避免连点/重试双写）
      const [dup] = await pool.query(
        "SELECT id, status FROM leave_request WHERE class_id = ? AND member_id = ? AND start_date = ? AND end_date = ? AND IFNULL(periods,'') = ? AND source = 'apply'",
        [classId, me.id, startDate, endDate, periods.join(',')]
      );
      if (dup.length) return { leaveId: Number(dup[0].id), existed: true, status: dup[0].status };
      const [ins] = await pool.query(
        "INSERT INTO leave_request (class_id, member_id, start_date, end_date, start_time, end_time, periods, status, source, reason, reason_note, leave_image, applied_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'apply', ?, ?, ?, ?)",
        [classId, me.id, startDate, endDate, tp.start, tp.end, periods.join(','), reason, reasonNote || null, fileId, me.id]
      );
      const leaveId = Number(ins.insertId);
      // 审批人 = 本班班长兼团支书 / 副班长（在职、非教职工、有 openid）+ 超管（不限班）
      const [approvers] = await pool.query(
        "SELECT id FROM member WHERE ((group_tag <> 'X' AND status = 'ACTIVE' AND position IN ('班长兼团支书','副班长')) OR (role = 'ADMIN' AND is_super = 1)) " +
        "AND openid IS NOT NULL AND student_no NOT LIKE '0000000000%' AND (class_id = ? OR (role = 'ADMIN' AND is_super = 1))",
        [classId]
      );
      const spanText = startDate + (endDate !== startDate ? '~' + endDate : '');
      await notifyMembers(pool, {
        classId, publisherId: me.id,
        title: '请假待审批',
        content: (me.name || '某同学') + ' 申请请假（' + spanText + ' ' + periodsText(periods) + '），请审批。',
        memberIds: approvers.map(r => Number(r.id))
      });
      console.log(JSON.stringify({ fn: 'adjust', action: 'leaveApply', by: me.id, classId, leaveId, periods: periods.join(',') }));
      return { leaveId, existed: false, status: 'PENDING' };
    }
  },

  /**
   * 审批成员请假申请：班长/副班长/超管，单级任一通过即生效。
   *   agree=true  → APPROVED + 标记区间内值日 LEAVE + 通知申请人
   *   agree=false → REJECTED + 通知申请人
   * 已处理过（非 PENDING）的记录原样返回当前状态（幂等，防重复审批把值日又标一遍）。
   */
  leaveApprove: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      if (!guard.isLeaveApprover(me)) throw new BizError(40003, '仅班长、副班长或超管可审批请假');
      const leaveId = Number(payload.leaveId);
      const agree = !!payload.agree;
      if (!leaveId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [lr] = await pool.query('SELECT * FROM leave_request WHERE id = ?', [leaveId]);
      const leave = lr[0];
      if (!leave) throw new BizError(41004, '请假申请不存在');
      // 班级隔离：非超管只能审批本班申请（防越权审别班）
      if (!guard.isSuper(me) && Number(leave.class_id) !== guard.classIdOf(ctx)) {
        throw new BizError(40003, '只能审批本班的请假申请');
      }
      if (leave.status !== 'PENDING') {
        return { status: leave.status, already: true };
      }
      const classId = Number(leave.class_id);
      const memberId = Number(leave.member_id);
      const startDate = week.dateStr(leave.start_date);
      const endDate = week.dateStr(leave.end_date);
      const spanText = startDate + (endDate !== startDate ? '~' + endDate : '');
      if (agree) {
        await pool.query(
          "UPDATE leave_request SET status = 'APPROVED', approved_by = ?, approved_at = NOW() WHERE id = ?",
          [me.id, leaveId]
        );
        const affected = await markDutiesLeave(pool, classId, memberId, startDate, endDate, me.id);
        await notifyMembers(pool, {
          classId, publisherId: me.id,
          title: '请假已通过',
          content: '你的请假申请（' + spanText + '）已通过审批。',
          memberIds: [memberId]
        });
        console.log(JSON.stringify({ fn: 'adjust', action: 'leaveApprove', by: me.id, leaveId, agree: true, affected }));
        return { status: 'APPROVED', affected };
      }
      await pool.query(
        "UPDATE leave_request SET status = 'REJECTED', approved_by = ?, approved_at = NOW() WHERE id = ?",
        [me.id, leaveId]
      );
      await notifyMembers(pool, {
        classId, publisherId: me.id,
        title: '请假未通过',
        content: '你的请假申请（' + spanText + '）未通过审批。',
        memberIds: [memberId]
      });
      console.log(JSON.stringify({ fn: 'adjust', action: 'leaveApprove', by: me.id, leaveId, agree: false }));
      return { status: 'REJECTED' };
    }
  },

  /**
   * 我的请假申请：返回本人作为申请人的全部请假记录（审批中/已通过/已驳回/已撤销），倒序。
   * 用于「信息页 → 我的请假」列表。
   */
  leaveMyList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date, l.start_time, l.end_time,
                l.periods, l.status, l.source, l.reason, l.reason_note, l.leave_image, l.created_at, l.approved_at,
                m.name, m.group_tag, m.student_no
           FROM leave_request l JOIN member m ON m.id = l.member_id
          WHERE l.member_id = ? AND l.source = 'apply'
          ORDER BY l.id DESC LIMIT 100`,
        [me.id]
      );
      const today = week.todayStr();
      return {
        list: rows.map((r) => {
          const periods = parsePeriods(r.periods);
          return {
            leaveId: Number(r.leaveId),
            memberId: Number(r.memberId),
            name: r.name,
            groupTag: r.groupTag,
            studentNo: String(r.student_no || ''),
            startDate: week.dateStr(r.start_date),
            endDate: week.dateStr(r.end_date),
            startTime: normTime(r.start_time),
            endTime: normTime(r.end_time),
            periods,
            periodsText: periodsText(periods),
            status: r.status,
            source: r.source,
            reason: r.reason,
            reasonNote: r.reason_note || '',
            hasImage: !!r.leave_image,
            image: r.leave_image || '',
            createdAt: String(r.created_at || '').slice(0, 16),
            approvedAt: String(r.approved_at || '').slice(0, 16)
          };
        }),
        today
      };
    }
  },

  /**
   * 待审批请假队列（审批人视角）：超管 → 全班级 PENDING；班长/副班长 → 仅本班 PENDING。
   * 返回申请人姓名/学号/组别/时段/日期/原因/假条，供审批人通过/驳回。
   */
  leavePendingList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      if (!guard.isLeaveApprover(me)) throw new BizError(40003, '仅班长、副班长或超管可查看审批队列');
      const pool = getPool();
      const superNow = guard.isSuper(me);
      const classFilter = superNow ? '' : 'AND l.class_id = ?';
      const args = superNow ? [] : [guard.classIdOf(ctx)];
      const [rows] = await pool.query(
        `SELECT l.id AS leaveId, l.member_id AS memberId, l.start_date, l.end_date, l.start_time, l.end_time,
                l.periods, l.reason, l.reason_note, l.leave_image, l.created_at,
                m.name, m.group_tag, m.student_no, l.class_id, cl.name AS className
           FROM leave_request l
           JOIN member m ON m.id = l.member_id
           LEFT JOIN \`class\` cl ON cl.id = l.class_id
          WHERE l.status = 'PENDING' AND l.source = 'apply' ${classFilter}
          ORDER BY l.id DESC LIMIT 200`,
        args
      );
      return {
        list: rows.map((r) => {
          const periods = parsePeriods(r.periods);
          return {
            leaveId: Number(r.leaveId),
            memberId: Number(r.memberId),
            name: r.name,
            groupTag: r.groupTag,
            studentNo: String(r.student_no || ''),
            startDate: week.dateStr(r.start_date),
            endDate: week.dateStr(r.end_date),
            startTime: normTime(r.start_time),
            endTime: normTime(r.end_time),
            periods,
            periodsText: periodsText(periods),
            reason: r.reason,
            reasonNote: r.reason_note || '',
            hasImage: !!r.leave_image,
            image: r.leave_image || '',
            createdAt: String(r.created_at || '').slice(0, 16),
            classId: Number(r.class_id),
            className: r.className || ''
          };
        })
      };
    }
  },

  /**
   * 撤回自己的请假申请：仅申请人本人、且状态为 PENDING 时。
   * PENDING 尚未标记值日，撤回只置 CANCELLED，无需恢复值日。
   */
  leaveMyCancel: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const leaveId = Number(payload.leaveId);
      if (!leaveId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [lr] = await pool.query('SELECT * FROM leave_request WHERE id = ?', [leaveId]);
      const leave = lr[0];
      if (!leave) throw new BizError(41004, '请假申请不存在');
      if (Number(leave.member_id) !== me.id) throw new BizError(40003, '只能撤回自己的请假申请');
      if (leave.source !== 'apply') throw new BizError(41001, '仅申请类请假可撤回');
      if (leave.status !== 'PENDING') throw new BizError(41001, '该申请已审批，无法撤回');
      await pool.query("UPDATE leave_request SET status = 'CANCELLED', cancelled_at = ? WHERE id = ?", [week.nowStamp(), leaveId]);
      console.log(JSON.stringify({ fn: 'adjust', action: 'leaveMyCancel', by: me.id, leaveId }));
      return { status: 'CANCELLED' };
    }
  },

  /* ---------------- 倒数日（2026-11-03）：个人自定义事件，按 member 隔离 ----------------
   * 需求：「每个人可添加自己的，独立的」。
   *   · 归属维度**只有 member_id**，不带 class_id —— 换了班 / 超管切了班，
   *     自己写的倒数日不该凭空消失（早期前端版本是 wx.storage 本地存，换机即丢，已迁云端）。
   *   · 三条接口全部 needBind，且每条 SQL 都带 `member_id = me.id`；
   *     删除前**先查归属再删**，越权直接 40003，绝不靠前端藏按钮。
   *   · 不返回别人的数据：列表本身就是 `WHERE member_id = ?`，没有「全班倒数日」这种视图。
   */
  countdownList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT id, name, target_date FROM countdown_event WHERE member_id = ? ORDER BY target_date ASC, id ASC LIMIT ?',
        [me.id, CD_MAX_ITEMS]
      );
      return {
        list: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          date: String(r.target_date).slice(0, 10),
          days: cdDays(r.target_date)
        }))
      };
    }
  },

  countdownAdd: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const name = String(payload.name == null ? '' : payload.name).trim().slice(0, 30);
      if (!name) throw new BizError(41001, '请填写事件名称');
      const date = normDate(payload.date);
      if (!date) throw new BizError(41001, '请选择正确的目标日期');
      const pool = getPool();
      // 幂等：同人 / 同名 / 同日期 只存一条（连点两下「保存」不该出现两条一模一样的）
      const [dup] = await pool.query(
        'SELECT id FROM countdown_event WHERE member_id = ? AND name = ? AND target_date = ? LIMIT 1',
        [me.id, name, date]
      );
      if (dup.length) return { id: Number(dup[0].id), existed: true };
      const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM countdown_event WHERE member_id = ?', [me.id]);
      if (Number(cnt[0].n) >= CD_MAX_ITEMS) throw new BizError(41001, '最多 ' + CD_MAX_ITEMS + ' 个倒数日，先删掉一些吧');
      const [r] = await pool.query(
        'INSERT INTO countdown_event (member_id, name, target_date) VALUES (?, ?, ?)',
        [me.id, name, date]
      );
      console.log(JSON.stringify({ fn: 'adjust', action: 'countdownAdd', by: me.id, id: r.insertId, date }));
      return { id: Number(r.insertId), existed: false };
    }
  },

  countdownDelete: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const id = Number(payload.id);
      if (!id) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query('SELECT member_id FROM countdown_event WHERE id = ?', [id]);
      if (!rows.length) throw new BizError(41004, '倒数日不存在');
      if (Number(rows[0].member_id) !== me.id) throw new BizError(40003, '只能删除自己的倒数日');
      await pool.query('DELETE FROM countdown_event WHERE id = ? AND member_id = ?', [id, me.id]);
      console.log(JSON.stringify({ fn: 'adjust', action: 'countdownDelete', by: me.id, id }));
      return { deleted: 1 };
    }
  }
};

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    /* 演示班级只读硬闸（2026-11-13）：演示身份下所有写操作（含请假登记/上传假条/审批）
       一律 40010，绝不落库。读操作在建表返回前就 return，零开销。 */
    await reviewDemo.gateDemoWrite(getPool(), guard, ctx, action);
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    if (route.auth && route.auth.needAdmin) guard.requireAdmin(ctx);
    if (route.auth && route.auth.needSuper) guard.requireSuper(ctx);
    // 排班域（需求 D）：超管（可跨班）/ 生活委员（仅本班，班级来自 classIdOf）
    if (route.auth && route.auth.scheduleAuth) guard.requireScheduleAuth(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[adjust] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
