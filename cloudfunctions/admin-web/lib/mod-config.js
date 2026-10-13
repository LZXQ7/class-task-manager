/**
 * 系统配置 + 审计查询（模块：config / audit）
 *
 * 第一期不含排班与请假（方案已定：语义最重、漂移代价最高，留到第二期）。
 * 本模块给的是「班级级配置」——学期起始、总周数、绑定开关、大节时间、
 * 以及后台自己的操作审计流水。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { NOT_TEST } = require('../common/test-account');
const { logAction } = require('./audit');

/** 后台首页概览：一屏看清各班规模 */
async function overview() {
  const pool = getPool();
  const [classes] = await pool.query(
    'SELECT c.id, c.name, c.is_active, c.total_weeks, c.term_start, ' +
    '(SELECT COUNT(*) FROM member m WHERE m.class_id = c.id AND ' + NOT_TEST('m') + ') AS memberCnt, ' +
    // ⚠️ 绑定 = openid 已写入（成员把微信绑定到学号）。同样显式排除测试账号。
    '(SELECT COUNT(*) FROM member m WHERE m.class_id = c.id AND m.openid IS NOT NULL AND ' + NOT_TEST('m') + ') AS boundCnt, ' +
    "(SELECT COUNT(*) FROM session s WHERE s.class_id = c.id AND s.kind = 'COURSE') AS sessionCnt, " +
    '(SELECT COUNT(*) FROM duty d WHERE d.class_id = c.id) AS dutyCnt ' +
    'FROM `class` c ORDER BY c.id'
  );
  const [[admin]] = await pool.query(
    'SELECT COUNT(*) AS c FROM admin_user WHERE status = 1'
  );
  const [[recent]] = await pool.query(
    'SELECT COUNT(*) AS c FROM admin_audit_log WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)'
  );
  return {
    classes: classes.map((c) => ({
      id: c.id,
      name: c.name,
      isActive: Number(c.is_active) !== 0,
      totalWeeks: c.total_weeks,
      termStart: typeof c.term_start === 'string' ? c.term_start.slice(0, 10) : c.term_start,
      memberCount: Number(c.memberCnt || 0),
      boundCount: Number(c.boundCnt || 0),
      sessionCount: Number(c.sessionCnt || 0),
      dutyCount: Number(c.dutyCnt || 0)
    })),
    stats: {
      classCount: classes.filter((c) => Number(c.is_active) !== 0).length,
      memberCount: classes.reduce((n, c) => n + Number(c.memberCnt || 0), 0),
      boundCount: classes.reduce((n, c) => n + Number(c.boundCnt || 0), 0),
      sessionCount: classes.reduce((n, c) => n + Number(c.sessionCnt || 0), 0),
      adminCount: Number(admin.c || 0),
      audit7d: Number(recent.c || 0)
    }
  };
}

/** 操作审计流水（可筛模块 / 班级 / 时间） */
async function listAudit(q = {}) {
  const pool = getPool();
  const where = ['1=1'];
  const args = [];
  if (q.module) { where.push('a.module = ?'); args.push(String(q.module)); }
  if (q.classId) { where.push('a.class_id = ?'); args.push(Number(q.classId)); }
  if (q.username) { where.push('a.username = ?'); args.push(String(q.username)); }
  if (q.keyword) {
    where.push('(a.summary LIKE ? OR a.action LIKE ?)');
    const kw = '%' + String(q.keyword) + '%';
    args.push(kw, kw);
  }
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const page = Math.max(1, Number(q.page) || 1);
  const [[cnt]] = await pool.query(
    'SELECT COUNT(*) AS c FROM admin_audit_log a WHERE ' + where.join(' AND '), args
  );
  const [rows] = await pool.query(
    'SELECT a.* FROM admin_audit_log a WHERE ' + where.join(' AND ') +
    ' ORDER BY a.id DESC LIMIT ? OFFSET ?',
    args.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total: Number(cnt.c || 0),
    page,
    pageSize,
    items: rows.map((r) => {
      let detail = r.detail;
      if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch (e) { /* 原样 */ } }
      return {
        id: r.id,
        adminId: r.admin_id,
        username: r.username,
        module: r.module,
        action: r.action,
        classId: r.class_id,
        summary: r.summary,
        detail,
        ip: r.ip,
        createdAt: typeof r.created_at === 'string' ? r.created_at.replace('T', ' ').slice(0, 19) : r.created_at
      };
    })
  };
}

/** 后台账号列表（只有超管能进后台，所以这里不做分权） */
async function listAdminUsers() {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT a.id, a.username, a.member_id, a.status, a.last_login_at, a.last_login_ip, ' +
    'a.fail_count, a.locked_until, m.name AS member_name, m.is_super, m.status AS member_status ' +
    'FROM admin_user a LEFT JOIN member m ON m.id = a.member_id ORDER BY a.id'
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    memberId: r.member_id,
    memberName: r.member_name || '',
    status: Number(r.status) === 1,
    lastLoginAt: r.last_login_at ? String(r.last_login_at).slice(0, 19) : null,
    lastLoginIp: r.last_login_ip || '',
    failCount: Number(r.fail_count || 0),
    lockedUntil: r.locked_until ? String(r.locked_until).slice(0, 19) : null,
    // member 侧的真实权限态 —— 后台账号只是白名单，这里才是权限真源
    memberIsSuper: Number(r.is_super) === 1,
    memberStatus: r.member_status || '',
    effective: Number(r.status) === 1 && Number(r.is_super) === 1 && r.member_status === 'ACTIVE'
  }));
}

/** 改密码 / 重置失败次数 / 停用 —— 都要求二次确认口令 */
async function updateAdminUser(id, patch, selfPassword, session, req) {
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM admin_user WHERE id = ? LIMIT 1', [id]);
  const a = rows[0];
  if (!a) throw new BizError(40404, '后台账号不存在');

  if (patch.newPassword !== undefined) {
    // ⚠️ 改密码 / 停用 / 重置自己以外账号，都必须先验当前登录者的口令 ——
    //    后台拿到一个已登录会话就等于拿到全部生产数据，这道二次校验不能省。
    const { verifyPassword } = require('./auth');
    if (!verifyPassword(selfPassword || '', session.selfHash || '')) {
      throw new BizError(40301, '当前登录密码不正确，操作已拒绝');
    }
    const np = String(patch.newPassword);
    if (np.length < 8) throw new BizError(40001, '新密码至少 8 位');
    if (np.length > 128) throw new BizError(40001, '密码过长');
    if (np === selfPassword) throw new BizError(40001, '新密码不能与当前密码相同');
    const { hashPassword } = require('./auth');
    await pool.query(
      'UPDATE admin_user SET pass_hash = ?, fail_count = 0, locked_until = NULL WHERE id = ?',
      [hashPassword(np), id]
    );
    // 改密即吊销该账号全部会话 —— 这是「改密码是为了把别人踢下线」的常识语义。
    // ⚠️ 改**自己**密码时本会话也会被删掉（前端会立刻跳回登录页，这是预期行为，
    //    不是 bug）；所以改密成功后不要再依赖 session 继续操作。
    await pool.query('DELETE FROM admin_session WHERE admin_id = ?', [id]);
  }
  if (patch.status !== undefined) {
    await pool.query('UPDATE admin_user SET status = ? WHERE id = ?', [patch.status ? 1 : 0, id]);
    if (!patch.status) await pool.query('DELETE FROM admin_session WHERE admin_id = ?', [id]);
  }
  if (patch.resetFail) {
    await pool.query('UPDATE admin_user SET fail_count = 0, locked_until = NULL WHERE id = ?', [id]);
  }
  await logAction(session, {
    module: 'config',
    action: 'admin.update',
    summary: '修改后台账号 ' + a.username + '：' + Object.keys(patch).filter((k) => k !== 'newPassword').join('、') + (patch.newPassword !== undefined ? '、密码' : ''),
    detail: { adminId: id, username: a.username, fields: Object.keys(patch) }
  }, req);
  return { ok: true };
}

module.exports = { overview, listAudit, listAdminUsers, updateAdminUser };