/**
 * 请假（模块：leave）
 * 后台请假视图：查看本班请假列表 + 修正已录入的请假（日期 / 时段 / 状态）。
 * 与小程序 adjust 云函数共用同一张 leave_request 表、同一套时段口径：
 *   start_time / end_time 为 TIME，NULL = 整天请假；date 区间 + status 决定值日 LEAVE 标记。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { NOT_TEST } = require('../common/test-account');
const { logAction } = require('./audit');

const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

function normDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).slice(0, 10));
  if (!m) return null;
  return m[1] + '-' + m[2] + '-' + m[3];
}
function normTime(s) {
  if (s === null || s === undefined || s === '') return null;
  const str = String(s).trim();
  if (!str) return null;
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(str);
  if (!m) throw new BizError(40001, '时间格式应为 HH:MM');
  if (Number(m[1]) > 23 || Number(m[2]) > 59) throw new BizError(40001, '时间超出范围');
  return m[3] ? (m[1] + ':' + m[2] + ':' + m[3]) : (m[1] + ':' + m[2]);
}

// ⚠️ mysql2 默认把 DATE/DATETIME 返回成 JS Date 对象，必须统一归一成字符串，
// 否则 String(old.start_date) 比较 / toDate 切片 / BETWEEN 排序会拿到 "Thu Oct ..." 而错乱。
function toDateStr(v) {
  if (!v) return v;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }
  return String(v).slice(0, 10);
}
function fmtDT(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  return String(v).slice(0, 19);
}

/**
 * 时段校验（2026-11-22 修）：口径是「开始时间=起始日的开始，结束时间=结束日的结束」。
 *  · 单日请假（startDate===endDate）：两个时刻落在同一天，必须 start < end；
 *  · 跨天请假（startDate<endDate）：首日晚上开始、末日早上结束（如 19:00→08:00）完全合法，
 *    此时 start >= end 反而才是常态，**绝不能拦**。
 * 早前两处（update/create）无条件 `start>=end → 抛错`，导致后台编辑跨天假一保存就报
 * 「开始时间须早于结束时间」（用户实拍 11/22 19:00 ~ 11/24 08:00），与小程序 adjust
 * 的跨天连续口径（1.0.8.77）矛盾。
 */
function assertTimeOrder(startTime, endTime, startDate, endDate) {
  if (startTime && endTime && startDate === endDate && startTime >= endTime) {
    throw new BizError(40001, '开始时间须早于结束时间');
  }
}

/**
 * 请假列表。
 * @param {object} q
 * @param {number} q.classId   必填：班级（后台显式按班级查，不做小程序那套跨班隔离）
 * @param {number} [q.memberId]
 * @param {string} [q.status]  PENDING/APPROVED/REJECTED/CANCELLED，不给=全部
 * @param {string} [q.keyword] 姓名 / 学号 模糊
 * @param {string} [q.dateFrom] 按 start_date >= 过滤
 * @param {string} [q.dateTo]   按 end_date <= 过滤
 */
async function listLeave(q = {}) {
  const pool = getPool();
  // ⚠️ 测试账号过滤必须**显式出现在 SQL 里**（与成员列表同铁律，门禁靠 grep NOT_TEST 兜底）。
  // ⚠️ leave_request 本身没有 class_id，班级归属要从 member 取（m.class_id）。
  const NOT_TEST_SQL = NOT_TEST('m');
  const where = ['m.class_id = ?', NOT_TEST_SQL];
  const args = [Number(q.classId)];
  if (q.memberId) { where.push('l.member_id = ?'); args.push(Number(q.memberId)); }
  if (q.status && LEAVE_STATUS.includes(q.status)) { where.push('l.status = ?'); args.push(q.status); }
  if (q.keyword) {
    const kw = '%' + String(q.keyword).trim() + '%';
    where.push('(m.name LIKE ? OR m.student_no LIKE ?)');
    args.push(kw, kw);
  }
  if (q.dateFrom) { const d = normDate(q.dateFrom); if (d) { where.push('l.start_date >= ?'); args.push(d); } }
  if (q.dateTo) { const d = normDate(q.dateTo); if (d) { where.push('l.end_date <= ?'); args.push(d); } }

  const [rows] = await pool.query(
    'SELECT l.id, l.member_id, m.class_id, l.start_date, l.end_date, l.start_time, l.end_time, ' +
    'l.status, l.leave_image, l.created_at, l.cancelled_at, ' +
    'm.name, m.student_no, m.group_tag ' +
    'FROM leave_request l JOIN member m ON m.id = l.member_id ' +
    'WHERE ' + where.join(' AND ') +
    ' ORDER BY l.start_date DESC, l.id DESC LIMIT 300',
    args
  );

  return rows.map((r) => ({
    id: Number(r.id),
    memberId: Number(r.member_id),
    classId: Number(r.class_id),
    name: r.name,
    studentNo: r.student_no,
    groupTag: r.group_tag,
    startDate: toDateStr(r.start_date),
    endDate: toDateStr(r.end_date),
    startTime: typeof r.start_time === 'string' ? r.start_time.slice(0, 5) : (r.start_time || ''),
    endTime: typeof r.end_time === 'string' ? r.end_time.slice(0, 5) : (r.end_time || ''),
    status: r.status,
    hasImage: !!r.leave_image,
    createdAt: fmtDT(r.created_at),
    cancelledAt: fmtDT(r.cancelled_at)
  }));
}

/**
 * 修改请假（日期 / 时段 / 状态）。
 * 仅时段变化 → 只改 leave_request，不影响 duty（duty 标记只看日期区间）；
 * 日期区间或状态变化 → 重算该成员在并集日期区间内 duty 的 LEAVE 标记（与小程序 addLeave/cancelLeave 同口径）。
 */
async function updateLeave(payload, session, req) {
  const pool = getPool();
  const id = Number(payload.id);
  if (!id) throw new BizError(40001, '缺少请假 id');
  // leave_request 无 class_id，审计需要班级 → 关联 member 取 class_id。
  const [cur] = await pool.query(
    'SELECT l.*, m.class_id AS member_class_id FROM leave_request l JOIN member m ON m.id = l.member_id WHERE l.id = ?',
    [id]
  );
  if (!cur[0]) throw new BizError(40404, '请假记录不存在');
  const old = cur[0];

  const startDate = payload.startDate != null ? (normDate(payload.startDate) || toDateStr(old.start_date)) : toDateStr(old.start_date);
  const endDate = payload.endDate != null ? (normDate(payload.endDate) || toDateStr(old.end_date)) : toDateStr(old.end_date);
  if (!startDate || !endDate) throw new BizError(40001, '日期不能为空');
  if (startDate > endDate) throw new BizError(40001, '起始日期不能晚于结束日期');

  let startTime = old.start_time;
  let endTime = old.end_time;
  if (payload.startTime !== undefined) startTime = normTime(payload.startTime);
  if (payload.endTime !== undefined) endTime = normTime(payload.endTime);
  assertTimeOrder(startTime, endTime, startDate, endDate);

  let status = old.status;
  if (payload.status !== undefined) {
    const s = String(payload.status).toUpperCase();
    if (!LEAVE_STATUS.includes(s)) throw new BizError(40001, '非法状态');
    status = s;
  }

  const oldStart = toDateStr(old.start_date);
  const oldEnd = toDateStr(old.end_date);
  const dateChanged = oldStart !== startDate || oldEnd !== endDate;
  const statusChanged = String(old.status) !== status;
  const nowSetCancel = status === 'CANCELLED' && old.status !== 'CANCELLED';

  await pool.query(
    'UPDATE leave_request SET start_date = ?, end_date = ?, start_time = ?, end_time = ?, status = ?' +
    (nowSetCancel ? ', cancelled_at = NOW()' : '') +
    ' WHERE id = ?',
    [startDate, endDate, startTime, endTime, status, id]
  );

  if (dateChanged || statusChanged) {
    const from = [oldStart, startDate].sort()[0];
    const to = [oldEnd, endDate].sort()[1];
    await resyncDutiesForMember(pool, Number(old.member_id), from, to);
  }

  await logAction(session, {
    module: 'leave',
    action: 'leave.update',
    classId: Number(old.member_class_id),
    summary: '修改请假 #' + id + '（成员 ' + Number(old.member_id) + '）：' +
      (dateChanged || statusChanged ? '日期/状态变更' : '时段微调'),
    detail: {
      id, memberId: Number(old.member_id),
      before: { startDate: oldStart, endDate: oldEnd, startTime: old.start_time || '', endTime: old.end_time || '', status: old.status },
      after: { startDate, endDate, startTime: startTime || '', endTime: endTime || '', status }
    }
  }, req);

  return { ok: true, id, dateChanged, statusChanged };
}

/**
 * 按 (日期区间, APPROVED 覆盖) 重算某成员 duty 的 LEAVE 标记。
 * 与小程序 addLeave / cancelLeave 同口径：duty 标记只看日期区间、不看时段；
 * 覆盖 → LEAVE（若原 PENDING/ONGOING），不再覆盖且原为 LEAVE → 退回 PENDING。
 */
async function resyncDutiesForMember(pool, memberId, from, to) {
  const [duties] = await pool.query(
    'SELECT id, class_date, status FROM duty WHERE member_id = ? AND class_date BETWEEN ? AND ?',
    [memberId, from, to]
  );
  for (const d of duties) {
    if (!(d.status === 'PENDING' || d.status === 'ONGOING' || d.status === 'LEAVE')) continue;
    const [cov] = await pool.query(
      "SELECT 1 FROM leave_request WHERE member_id = ? AND status = 'APPROVED' AND start_date <= ? AND end_date >= ? LIMIT 1",
      [memberId, toDateStr(d.class_date), toDateStr(d.class_date)]
    );
    const covered = cov.length > 0;
    if (covered && (d.status === 'PENDING' || d.status === 'ONGOING')) {
      await pool.query("UPDATE duty SET status = 'LEAVE' WHERE id = ?", [d.id]);
    } else if (!covered && d.status === 'LEAVE') {
      await pool.query("UPDATE duty SET status = 'PENDING' WHERE id = ?", [d.id]);
    }
  }
}

/**
 * 后台代登记一条请假（2026-11-15 新增）。
 * 与小程序 `adjust.addLeave` 同口径：后台代登记默认 `source='register'` + **直接 APPROVED**
 * （班委代登记不需要再走一遍审批），随后重算该成员这几天的值日 LEAVE 标记。
 * @param {object} payload { classId, memberId, startDate, endDate, startTime, endTime, status? }
 */
async function createLeave(payload, session, req) {
  const pool = getPool();
  const classId = Number(payload.classId);
  const memberId = Number(payload.memberId);
  if (!classId) throw new BizError(40001, '缺少班级');
  if (!memberId) throw new BizError(40001, '请选择成员');

  // ⚠️ 必须校验成员确实属于这个班：否则后台可以给 A 班成员在 B 班记一条请假，
  //    而列表按 m.class_id 过滤 ⇒ 这条记录会变成"谁都看不见"的幽灵数据。
  const [m] = await pool.query('SELECT id, name, class_id FROM member WHERE id = ?', [memberId]);
  if (!m[0]) throw new BizError(40404, '成员不存在');
  if (Number(m[0].class_id) !== classId) throw new BizError(40001, '该成员不属于所选班级');

  const startDate = normDate(payload.startDate);
  const endDate = normDate(payload.endDate) || startDate;
  if (!startDate) throw new BizError(40001, '请选择起始日期');
  if (startDate > endDate) throw new BizError(40001, '起始日期不能晚于结束日期');

  const startTime = normTime(payload.startTime);
  const endTime = normTime(payload.endTime);
  assertTimeOrder(startTime, endTime, startDate, endDate);

  let status = 'APPROVED';
  if (payload.status !== undefined) {
    const s = String(payload.status).toUpperCase();
    if (!LEAVE_STATUS.includes(s)) throw new BizError(40001, '非法状态');
    status = s;
  }

  const by = Number((session && session.memberId) || 0) || null;
  // periods 留空 = 按 start_time / end_time 判定时段；两者都空 = 整天。
  // 不在这里编造 am/pm/eve 组合 —— 那会把"手工钟点"谎报成某个半天（1.0.8.20 踩过）。
  const [r] = await pool.query(
    'INSERT INTO leave_request (class_id, member_id, start_date, end_date, start_time, end_time, ' +
    'periods, reason, source, applied_by, approved_by, approved_at, status) ' +
    'VALUES (?, ?, ?, ?, ?, ?, NULL, ?, \'register\', ?, ?, ?, ?)',
    [classId, memberId, startDate, endDate, startTime, endTime, 'OTHER',
      by, status === 'APPROVED' ? by : null, status === 'APPROVED' ? new Date() : null, status]
  );

  await resyncDutiesForMember(pool, memberId, startDate, endDate);

  await logAction(session, {
    module: 'leave',
    action: 'leave.create',
    classId,
    summary: '后台代登记请假 #' + r.insertId + '：' + m[0].name + ' ' +
      startDate + (endDate !== startDate ? ' ~ ' + endDate : '') + '（' + status + '）',
    detail: { id: r.insertId, classId, memberId, startDate, endDate, startTime: startTime || '', endTime: endTime || '', status }
  }, req);

  return { id: r.insertId, status };
}

/**
 * 删除一条请假（2026-11-15 新增）。
 * ⚠️ 必须重算该成员这段时间的 duty 标记：删掉 APPROVED 请假后，
 *    原本被标成 LEAVE 的值日要退回 PENDING，否则会一直显示"已请假"。
 */
async function deleteLeave(payload, session, req) {
  const pool = getPool();
  const id = Number(payload.id);
  if (!id) throw new BizError(40001, '缺少请假 id');
  const [rows] = await pool.query(
    'SELECT l.*, m.class_id AS member_class_id, m.name FROM leave_request l ' +
    'JOIN member m ON m.id = l.member_id WHERE l.id = ?', [id]
  );
  if (!rows[0]) throw new BizError(40404, '请假记录不存在');
  const old = rows[0];

  await pool.query('DELETE FROM leave_request WHERE id = ?', [id]);
  await resyncDutiesForMember(pool, Number(old.member_id), toDateStr(old.start_date), toDateStr(old.end_date));

  await logAction(session, {
    module: 'leave',
    action: 'leave.delete',
    classId: Number(old.member_class_id),
    summary: '删除请假 #' + id + '：' + old.name + ' ' + toDateStr(old.start_date) +
      ' ~ ' + toDateStr(old.end_date) + '（原状态 ' + old.status + '）',
    detail: {
      id,
      memberId: Number(old.member_id),
      startDate: toDateStr(old.start_date),
      endDate: toDateStr(old.end_date),
      status: old.status,
      hadImage: !!old.leave_image
    }
  }, req);

  return { id };
}

module.exports = { listLeave, updateLeave, createLeave, deleteLeave };
