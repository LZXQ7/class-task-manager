/**
 * 换班申请（模块：swap）· 2026-11-15 新增
 * ============================================================
 * 状态机（与小程序的 `adjust.approve / cancel` 完全一致，**不要另起一套**）：
 *   PENDING_PEER（等对方同意）→ PENDING_ADMIN（等管理员）→ DONE
 *   任一步可 → REJECTED / CANCELLED
 *
 * 审批通过要真的改库，不能只改状态：
 *   · type='SWAP'：`duty.member_id` 原地换成对方 + 写 duty_log(SWAP) + 写 duty_reassign
 *     ⇒ 小程序值日详情里的「还原」按钮对后台的审批同样有效。
 *   · type='LEAVE'：这是「请假代班」，请假本身即时生效，审批请走请假页；
 *     这里拒绝处理，避免出现「duty 说请假、leave_request 没记录」的分裂状态。
 *
 * ⚠️ duty_log 的 class_id 有默认值 1，小程序的写入没带它（历史遗留）；
 *    后台必须显式写，否则 class 3 的操作会记到 class 1 名下。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { logAction } = require('./audit');

const STATUSES = ['PENDING_PEER', 'PENDING_ADMIN', 'DONE', 'REJECTED', 'CANCELLED'];
const STATUS_TEXT = {
  PENDING_PEER: '待对方确认', PENDING_ADMIN: '待管理员确认',
  DONE: '已完成', REJECTED: '已拒绝', CANCELLED: '已撤销'
};
const REASON_TEXT = { COURSE: '上课', SICK: '生病', INTERN: '实习', OTHER: '其它' };

function ymd(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function listSwap(q) {
  const pool = getPool();
  const classId = Number(q.classId);
  if (!classId) throw new BizError(40001, '缺少班级');

  const where = ['sr.class_id = ?'];
  const args = [classId];
  if (q.status && STATUSES.indexOf(q.status) >= 0) { where.push('sr.status = ?'); args.push(q.status); }
  if (q.type === 'SWAP' || q.type === 'LEAVE') { where.push('sr.type = ?'); args.push(q.type); }
  const W = where.join(' AND ');

  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(200, Math.max(20, Number(q.pageSize) || 50));

  const [cnt] = await pool.query('SELECT COUNT(*) AS n FROM swap_request sr WHERE ' + W, args);
  const [rows] = await pool.query(
    'SELECT sr.id, sr.type, sr.status, sr.reason, sr.duty_id, sr.from_member, sr.to_member, ' +
    'sr.start_date, sr.end_date, sr.expire_at, sr.created_at, ' +
    'd.class_date, d.week, d.status AS duty_status, s.period, s.kind, c.name AS course_name, ' +
    'mf.name AS from_name, mf.student_no AS from_no, mt.name AS to_name, mt.student_no AS to_no ' +
    'FROM swap_request sr ' +
    'LEFT JOIN duty d ON d.id = sr.duty_id ' +
    'LEFT JOIN session s ON s.id = d.session_id ' +
    'LEFT JOIN course c ON c.id = s.course_id ' +
    'LEFT JOIN member mf ON mf.id = sr.from_member ' +
    'LEFT JOIN member mt ON mt.id = sr.to_member ' +
    'WHERE ' + W + ' ORDER BY sr.created_at DESC LIMIT ? OFFSET ?',
    args.concat([pageSize, (page - 1) * pageSize])
  );

  const now = new Date();
  return {
    total: cnt[0].n, page, pageSize,
    statuses: STATUSES.map((k) => ({ key: k, label: STATUS_TEXT[k] })),
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      typeText: r.type === 'LEAVE' ? '请假代班' : '换班',
      status: r.status,
      statusText: STATUS_TEXT[r.status] || r.status,
      reason: r.reason || '',
      reasonText: REASON_TEXT[r.reason] || '—',
      dutyId: r.duty_id,
      classDate: r.class_date ? String(r.class_date).slice(0, 10) : '',
      week: r.week,
      courseName: r.course_name || (r.kind === 'CLEAN' ? '保洁' : '—'),
      period: r.period,
      fromMember: r.from_member,
      fromName: r.from_name || '—',
      fromNo: r.from_no || '',
      toMember: r.to_member,
      toName: r.to_name || '',
      toNo: r.to_no || '',
      startDate: r.start_date ? String(r.start_date).slice(0, 10) : '',
      endDate: r.end_date ? String(r.end_date).slice(0, 10) : '',
      createdAt: r.created_at ? String(r.created_at).slice(0, 16) : '',
      // 过期未处理（expire_at 已过但状态还挂着）—— 前端标红，提示管理员处理
      expired: r.expire_at ? new Date(String(r.expire_at).replace(' ', 'T')) < now : false,
      canAct: r.status === 'PENDING_PEER' || r.status === 'PENDING_ADMIN'
    }))
  };
}

async function loadSwap(pool, id) {
  const [rows] = await pool.query('SELECT * FROM swap_request WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

/**
 * 通过：SWAP 类型才真换人；LEAVE 类型明确拒绝（走请假页）。
 * 换人失败（对方该时段已有值日）时把申请退回 REJECTED，与小程序同一个处理。
 */
async function approve(p, session, req) {
  const id = Number(p.id);
  if (!id) throw new BizError(40001, '缺少申请 ID');
  const pool = getPool();
  const sw = await loadSwap(pool, id);
  if (!sw) throw new BizError(40404, '申请不存在');
  if (['PENDING_PEER', 'PENDING_ADMIN'].indexOf(sw.status) < 0) throw new BizError(40001, '该申请已处理');
  if (sw.type === 'LEAVE') {
    throw new BizError(40001, '这是请假代班申请，请到「请假」页审批（那里会同步值日标记）');
  }
  if (!sw.to_member) throw new BizError(40001, '该申请没有指定替补，无法通过');

  const [ds] = await pool.query('SELECT * FROM duty WHERE id = ? LIMIT 1', [sw.duty_id]);
  const d = ds[0];
  if (!d) throw new BizError(40404, '原值日不存在');
  if (Number(d.class_id) !== Number(sw.class_id)) {
    // 数据自洽性检查：申请与值日不在同一班，说明历史脏数据，不能再往上叠改动
    throw new BizError(40001, '申请与值日不属于同一班级，请先核对数据');
  }

  const classDate = String(d.class_date).slice(0, 10);
  try {
    await pool.query(
      "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
      [sw.to_member, sw.duty_id]
    );
  } catch (e) {
    await pool.query("UPDATE swap_request SET status = 'REJECTED' WHERE id = ?", [id]);
    throw new BizError(40001, '对方该时段已有值日，无法换入（申请已置为已拒绝）');
  }
  await pool.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, sw.to_member]);
  await pool.query(
    'INSERT INTO duty_log (class_id, duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?,?)',
    [d.class_id, sw.duty_id, session.memberId, 'SWAP', sw.from_member, sw.to_member]
  );
  await pool.query(
    'INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id) ' +
    'VALUES (?,?,?,?,?,?,?)',
    [sw.duty_id, sw.duty_id, d.session_id, d.week, sw.from_member, sw.to_member, session.memberId]
  );
  await pool.query("UPDATE swap_request SET status = 'DONE' WHERE id = ?", [id]);

  const [ns] = await pool.query('SELECT name FROM member WHERE id = ? LIMIT 1', [sw.to_member]);
  await logAction(session, {
    module: 'swap',
    action: 'swap.approve',
    classId: sw.class_id,
    summary: '通过换班：' + classDate + ' 改由 ' + ((ns[0] && ns[0].name) || sw.to_member) + ' 值日',
    detail: { swapId: id, dutyId: sw.duty_id, from: sw.from_member, to: sw.to_member }
  }, req);
  return { status: 'DONE' };
}

async function reject(p, session, req) {
  const id = Number(p.id);
  if (!id) throw new BizError(40001, '缺少申请 ID');
  const pool = getPool();
  const sw = await loadSwap(pool, id);
  if (!sw) throw new BizError(40404, '申请不存在');
  if (['PENDING_PEER', 'PENDING_ADMIN'].indexOf(sw.status) < 0) throw new BizError(40001, '该申请已处理');

  await pool.query("UPDATE swap_request SET status = 'REJECTED' WHERE id = ?", [id]);
  await logAction(session, {
    module: 'swap',
    action: 'swap.reject',
    classId: sw.class_id,
    summary: '驳回换班申请 #' + id + (p.note ? '（' + String(p.note).slice(0, 40) + '）' : ''),
    detail: { swapId: id, note: String(p.note || '').slice(0, 200) }
  }, req);
  return { status: 'REJECTED' };
}

/** 撤销：管理员代申请人撤销。若它已经把 duty 置成 LEAVE（历史数据），一并退回待值日。 */
async function cancel(p, session, req) {
  const id = Number(p.id);
  if (!id) throw new BizError(40001, '缺少申请 ID');
  const pool = getPool();
  const sw = await loadSwap(pool, id);
  if (!sw) throw new BizError(40404, '申请不存在');
  if (['PENDING_PEER', 'PENDING_ADMIN'].indexOf(sw.status) < 0) throw new BizError(40001, '当前状态不可撤销');

  if (sw.type === 'LEAVE') {
    await pool.query("UPDATE duty SET status = 'PENDING' WHERE id = ? AND status = 'LEAVE'", [sw.duty_id]);
    await pool.query("UPDATE leave_request SET status = 'CANCELLED' WHERE swap_id = ?", [id]);
  }
  await pool.query("UPDATE swap_request SET status = 'CANCELLED' WHERE id = ?", [id]);
  await logAction(session, {
    module: 'swap',
    action: 'swap.cancel',
    classId: sw.class_id,
    summary: '撤销换班申请 #' + id + (p.note ? '（' + String(p.note).slice(0, 40) + '）' : ''),
    detail: { swapId: id, note: String(p.note || '').slice(0, 200) }
  }, req);
  return { status: 'CANCELLED' };
}

module.exports = { listSwap, approve, reject, cancel, STATUSES, STATUS_TEXT };
