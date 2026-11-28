/**
 * 班级通知（模块：notice）· 2026-11-28 新增 · **只读**
 * ============================================================
 * 小程序端 notice 页能看班级通知与回执，后台却没有对应视图 —— 老师想核查
 * 「发了什么、发给谁、多少人确认收到」只能翻手机。这里提供后台只读入口。
 *
 * 隐私边界（用户口径）：
 *   · 回执**只给数字**（ackCount / recipientCount），不逐人列「谁已读 / 谁没读」；
 *   · 学生仅统计口径排除测试号与辅导员（group_tag='X'），与小程序 msgList 一致；
 *   · 班级归属口径同 msgList 的「班级视角」：ALL 按 class_id（含跨班 notice_msg_class），
 *     其它 scope 按 notice_msg_target 里有人在该班。
 *
 * 本模块只读：不导出发布 / 删除 / 标记接口（后台发通知仍走小程序 media 云函数）。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');

const SCOPE_TEXT = { ALL: '全体', PICK: '指定成员', COMMITTEE: '仅班委', POSITION: '按职位' };

/**
 * 只读：某班归属的通知列表 + 回执统计（只给数字）。
 * @param q { classId, keyword, limit }
 */
async function listNotice(q) {
  const pool = getPool();
  const classId = Number(q.classId);
  if (!classId) throw new BizError(40001, '缺少班级');

  const args = [classId, classId, classId];
  let extra = '';
  const kw = String(q.keyword || '').trim();
  if (kw) { extra = ' AND (n.title LIKE ? OR n.content LIKE ?)'; args.push('%' + kw + '%', '%' + kw + '%'); }

  /* 回执统计全部走 COUNT 子查询，只回数字；不 SELECT 逐人已读行。 */
  const [rows] = await pool.query(
    `SELECT n.id, n.title, n.content, n.scope, n.need_ack, n.link_url, n.link_name, n.created_at,
            n.class_id, n.publisher_id, m.name AS publisherName,
            (SELECT COUNT(*) FROM notice_msg_read x JOIN member xm ON xm.id = x.member_id
              WHERE x.notice_id = n.id AND x.member_id <> n.publisher_id AND xm.group_tag <> 'X'
                AND xm.student_no NOT LIKE '0000000000%') AS ackCount,
            CASE n.scope
              WHEN 'ALL' THEN (SELECT COUNT(*) FROM member WHERE status = 'ACTIVE' AND id <> n.publisher_id
                AND group_tag <> 'X' AND student_no NOT LIKE '0000000000%' AND class_id = n.class_id)
              WHEN 'COMMITTEE' THEN (SELECT COUNT(*) FROM member WHERE role = 'ADMIN' AND is_super = 0
                AND group_tag <> 'X' AND student_no NOT LIKE '0000000000%' AND status = 'ACTIVE'
                AND openid IS NOT NULL AND id <> n.publisher_id)
              ELSE (SELECT COUNT(*) FROM notice_msg_target t WHERE t.notice_id = n.id AND t.member_id <> n.publisher_id)
            END AS recipientCount
       FROM notice_msg n
       JOIN member m ON m.id = n.publisher_id
      WHERE (
              (n.scope = 'ALL' AND (n.class_id = ? OR (n.class_id = 0 AND EXISTS (
                    SELECT 1 FROM notice_msg_class nc WHERE nc.notice_id = n.id AND nc.class_id = ?))))
           OR (n.scope <> 'ALL' AND EXISTS (
                    SELECT 1 FROM notice_msg_target t JOIN member tm ON tm.id = t.member_id
                     WHERE t.notice_id = n.id AND tm.class_id = ?))
            )` + extra + `
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 200`,
    args
  );

  const items = rows.map((r) => ({
    id: r.id,
    title: r.title || '',
    content: String(r.content || '').slice(0, 300),
    scope: r.scope || 'ALL',
    scopeText: SCOPE_TEXT[r.scope] || r.scope || '',
    needAck: !!r.need_ack,
    publisherName: r.publisherName || '—',
    createdAt: r.created_at ? String(r.created_at).slice(0, 16) : '',
    linkName: r.link_name || '',
    linkUrl: r.link_url || '',
    ackCount: Number(r.ackCount) || 0,
    recipientCount: Number(r.recipientCount) || 0
  }));

  const totalAck = items.reduce((n, x) => n + x.ackCount, 0);
  return {
    total: items.length,
    needAckCount: items.filter((x) => x.needAck).length,
    totalAck,
    items
  };
}

module.exports = { listNotice };
