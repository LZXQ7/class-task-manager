/**
 * 操作审计（后台一切写操作留痕）
 *
 * ⚠️ 与 cloudfunctions/common/audit.js **不是一回事**：
 * 那边的 audit.js 是微信内容安全审核（msgSecCheck / mediaCheckAsync），
 * 名字撞车而已，语义完全不同。后台要的是「谁在什么时候动了哪个班的什么」，
 * 所以单独落 admin_audit_log 表。
 */
const { getPool } = require('../common/db');
const { clientIp } = require('./auth');

/**
 * 记一条审计。
 * ⚠️ 审计**不允许阻断业务**：写审计失败只打日志，不能让已经成功的写操作回滚给用户看报错
 * （那会造成「操作其实生效了，但用户以为没成功」并进而重复提交，比少一条审计更糟）。
 */
async function logAction(session, { module, action, classId = null, summary = '', detail = null }, req) {
  try {
    const pool = getPool();
    await pool.query(
      'INSERT INTO admin_audit_log (admin_id, member_id, username, module, action, class_id, summary, detail, ip) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        session.adminId,
        session.memberId,
        session.username,
        module,
        action,
        classId,
        String(summary).slice(0, 512),
        detail === null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
        req ? clientIp(req) : null
      ]
    );
  } catch (e) {
    console.error('[admin-audit-fail]', action, e && e.message);
  }
}

module.exports = { logAction };