/**
 * 值日记录（模块：duty）· 2026-11-15 新增
 * ============================================================
 * 后台只管三件事：**改状态 / 换人 / 删单条**。
 * 不在这里「重新排班」——那是排班规则（schedule_rules）与小程序 schedule.reassign 的职责，
 * 两套算法并存一定会打架（同一周被两边各排一次，谁后写谁生效，没人说得清）。
 *
 * 与小程序的一致性：
 *   · 换人用 `UPDATE duty SET member_id=?, source='MANUAL', status='PENDING', done_at=NULL`
 *     （与 adjust.approve / schedule.reassign 完全同一套写法）
 *   · 同时写 `duty_log`（action='SWAP'）和 `duty_reassign`，
 *     这样小程序值日详情里的「还原」按钮对后台做的改动同样有效。
 *   · ⚠️ duty_log 有 class_id 列且**有默认值 1**：小程序的写入没带它（历史遗留），
 *     后台必须显式写，否则 class 3 的操作会记到 class 1 名下。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { logAction } = require('./audit');

const STATUSES = ['PENDING', 'ONGOING', 'DONE', 'LEAVE', 'SWAPPED_OUT', 'EXPIRED'];
const STATUS_TEXT = {
  PENDING: '待值日', ONGOING: '进行中', DONE: '已值日',
  LEAVE: '已请假', SWAPPED_OUT: '已换出', EXPIRED: '已结束'
};

function ymd(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 列表：默认查最近 14 天（后台最常看的是「这周谁值日」） */
async function listDuty(q) {
  const pool = getPool();
  const classId = Number(q.classId);
  if (!classId) throw new BizError(40001, '缺少班级');

  const to = q.dateTo ? String(q.dateTo).slice(0, 10) : ymd(new Date());
  const from = q.dateFrom ? String(q.dateFrom).slice(0, 10)
    : ymd(new Date(Date.now() - 13 * 86400000));

  const where = ['d.class_id = ?', 'd.class_date BETWEEN ? AND ?'];
  const args = [classId, from, to];
  if (q.status && STATUSES.indexOf(q.status) >= 0) { where.push('d.status = ?'); args.push(q.status); }
  if (q.memberId) { where.push('d.member_id = ?'); args.push(Number(q.memberId)); }
  if (q.kind === 'COURSE' || q.kind === 'CLEAN') { where.push('s.kind = ?'); args.push(q.kind); }
  const W = where.join(' AND ');

  const page = Math.max(1, Number(q.page) || 1);
  const pageSize = Math.min(300, Math.max(20, Number(q.pageSize) || 60));

  const [cnt] = await pool.query(
    'SELECT COUNT(*) AS n FROM duty d JOIN session s ON s.id = d.session_id WHERE ' + W, args
  );
  const [rows] = await pool.query(
    'SELECT d.id, d.class_date, d.week, d.status, d.source, d.done_at, d.member_id, d.session_id, ' +
    'm.name AS member_name, m.student_no, m.group_tag, ' +
    'c.name AS course_name, s.period, s.kind, s.day_of_week ' +
    'FROM duty d ' +
    'JOIN session s ON s.id = d.session_id ' +
    'LEFT JOIN course c ON c.id = s.course_id ' +
    'LEFT JOIN member m ON m.id = d.member_id ' +
    'WHERE ' + W + ' ORDER BY d.class_date DESC, s.period ASC LIMIT ? OFFSET ?',
    args.concat([pageSize, (page - 1) * pageSize])
  );

  return {
    total: cnt[0].n, page, pageSize, dateFrom: from, dateTo: to,
    statuses: STATUSES.map((k) => ({ key: k, label: STATUS_TEXT[k] })),
    items: rows.map((r) => ({
      id: r.id,
      classDate: String(r.class_date).slice(0, 10),
      week: r.week,
      period: r.period,
      kind: r.kind,
      courseName: r.course_name || (r.kind === 'CLEAN' ? '保洁' : '—'),
      memberId: r.member_id,
      memberName: r.member_name || '—',
      studentNo: r.student_no || '',
      status: r.status,
      statusText: STATUS_TEXT[r.status] || r.status,
      source: r.source,
      doneAt: r.done_at ? String(r.done_at).slice(0, 16) : ''
    }))
  };
}

/** 取一条值日（含班级，用于越权校验） */
async function loadDuty(pool, id) {
  const [rows] = await pool.query('SELECT * FROM duty WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

/** 改状态。DONE 记完成时间，退回待值日则清空完成时间。 */
async function setStatus(p, session, req) {
  const id = Number(p.id);
  const status = String(p.status || '');
  if (!id) throw new BizError(40001, '缺少值日 ID');
  if (STATUSES.indexOf(status) < 0) throw new BizError(40001, '状态不合法');

  const pool = getPool();
  const d = await loadDuty(pool, id);
  if (!d) throw new BizError(40404, '值日记录不存在');
  const before = d.status;
  if (before === status) return { status, unchanged: true };

  // LEAVE 状态不允许在这里手工设：那是请假审批的产物，手工设会让 duty 说「请假」
  // 而 leave_request 里没有对应记录 —— 两端数据不一致，后面排查极难。
  if (status === 'LEAVE') throw new BizError(40001, '「已请假」请到请假页处理，不能手工设置');

  if (status === 'DONE') {
    await pool.query('UPDATE duty SET status = ?, done_at = NOW() WHERE id = ?', [status, id]);
  } else {
    await pool.query('UPDATE duty SET status = ?, done_at = NULL WHERE id = ?', [status, id]);
  }
  await pool.query(
    'INSERT INTO duty_log (class_id, duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?,?)',
    [d.class_id, id, session.memberId, status === 'DONE' ? 'DONE' : 'UNDO', d.member_id, d.member_id]
  );
  await logAction(session, {
    module: 'duty',
    action: 'duty.setStatus',
    classId: d.class_id,
    summary: '值日状态 ' + (STATUS_TEXT[before] || before) + ' → ' + (STATUS_TEXT[status] || status) + '（' + String(d.class_date).slice(0, 10) + '）',
    detail: { dutyId: id, before, after: status }
  }, req);
  return { status };
}

/** 换人（原地换，一个课次只留一条值日记录） */
async function setMember(p, session, req) {
  const id = Number(p.id);
  const toMember = Number(p.memberId);
  if (!id || !toMember) throw new BizError(40001, '缺少值日或成员');

  const pool = getPool();
  const d = await loadDuty(pool, id);
  if (!d) throw new BizError(40404, '值日记录不存在');
  if (Number(d.member_id) === toMember) return { unchanged: true };

  const [ms] = await pool.query(
    'SELECT id, name, class_id, status FROM member WHERE id = ? LIMIT 1', [toMember]
  );
  const m = ms[0];
  if (!m) throw new BizError(40404, '成员不存在');
  // 跨班换人会产生「A 班值日挂在 B 班人名下」，两端都查不到，属于脏数据
  if (Number(m.class_id) !== Number(d.class_id)) throw new BizError(40001, '只能换成本班成员');
  if (m.status !== 'ACTIVE') throw new BizError(40001, '该成员已停用，不能值日');

  const [olds] = await pool.query('SELECT name FROM member WHERE id = ? LIMIT 1', [d.member_id]);
  const oldName = (olds[0] && olds[0].name) || '（空）';

  await pool.query(
    "UPDATE duty SET member_id = ?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = ?",
    [toMember, id]
  );
  const classDate = String(d.class_date).slice(0, 10);
  await pool.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, toMember]);
  await pool.query(
    'INSERT INTO duty_log (class_id, duty_id, operator_id, action, from_member, to_member) VALUES (?,?,?,?,?,?)',
    [d.class_id, id, session.memberId, 'SWAP', d.member_id, toMember]
  );
  // 与 schedule.reassign 共用换人记录 ⇒ 小程序值日详情里的「还原」对后台改动同样有效
  await pool.query(
    'INSERT INTO duty_reassign (duty_id, new_duty_id, session_id, week, from_member, to_member, operator_id) ' +
    'VALUES (?,?,?,?,?,?,?)',
    [id, id, d.session_id, d.week, d.member_id, toMember, session.memberId]
  );
  await logAction(session, {
    module: 'duty',
    action: 'duty.setMember',
    classId: d.class_id,
    summary: '值日换人：' + oldName + ' → ' + m.name + '（' + classDate + '）',
    detail: { dutyId: id, from: d.member_id, to: toMember }
  }, req);
  return { memberId: toMember, memberName: m.name };
}

/** 删单条值日（误排、多排时用）。不碰 duty_count，避免轮转队列被后台悄悄改动。 */
async function removeDuty(p, session, req) {
  const id = Number(p.id);
  if (!id) throw new BizError(40001, '缺少值日 ID');
  const pool = getPool();
  const d = await loadDuty(pool, id);
  if (!d) throw new BizError(40404, '值日记录不存在');

  await pool.query('DELETE FROM duty WHERE id = ?', [id]);
  // 该值日的日志与换人记录一并清掉，否则详情页会挂着指向空记录的「还原」按钮
  await pool.query('DELETE FROM duty_log WHERE duty_id = ?', [id]);
  await pool.query('DELETE FROM duty_reassign WHERE duty_id = ? OR new_duty_id = ?', [id, id]);
  await logAction(session, {
    module: 'duty',
    action: 'duty.delete',
    classId: d.class_id,
    summary: '删除值日：' + String(d.class_date).slice(0, 10) + ' 第' + d.week + '周',
    detail: { dutyId: id, memberId: d.member_id, status: d.status, classDate: String(d.class_date).slice(0, 10) }
  }, req);
  return {};
}

module.exports = { listDuty, setStatus, setMember, removeDuty, STATUSES, STATUS_TEXT };
