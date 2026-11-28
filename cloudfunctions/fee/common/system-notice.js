/**
 * 系统事件通知写入助手（2026-11-28）
 * ------------------------------------------------------------
 * 调课 / 班费 / 请假审批等**系统事件**都要写 notice_msg + notice_msg_target
 * （PICK）或 notice_msg_class（ALL），与 media.msgPublish 的人工通知共用同一套
 * 展示、角标、回执、软删链路。集中成一个 helper 是为了避免各业务函数各写一遍
 * 双记录时漏掉其中一张表（M1 同源漏改）。
 *
 * ⚠️ 不在这里发订阅消息：系统事件复用站内通知，不消耗有限的一次性订阅额度。
 */
async function writeNotice(pool, opt) {
  const scope = opt.scope === 'PICK' ? 'PICK' : 'ALL';
  const classId = Number(opt.classId) || 0;
  const [ins] = await pool.query(
    `INSERT INTO notice_msg
       (class_id, publisher_id, title, content, images, link_url, link_name, scope, need_ack, popup, week)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      scope === 'PICK' ? 0 : classId,
      Number(opt.publisherId) || 0,
      String(opt.title || '').slice(0, 60),
      String(opt.content || '').slice(0, 2000),
      '[]',
      opt.linkUrl ? String(opt.linkUrl).slice(0, 500) : null,
      opt.linkName ? String(opt.linkName).slice(0, 60) : null,
      scope,
      opt.needAck ? 1 : 0,
      Number(opt.week) || 0
    ]
  );
  const noticeId = ins.insertId;
  if (scope !== 'PICK' && classId) {
    await pool.query('INSERT IGNORE INTO notice_msg_class (notice_id, class_id) VALUES (?, ?)', [noticeId, classId]);
  }
  if (scope === 'PICK') {
    const ids = Array.from(new Set((opt.memberIds || []).map(Number).filter(Boolean)));
    for (const mid of ids) {
      await pool.query('INSERT IGNORE INTO notice_msg_target (notice_id, member_id) VALUES (?, ?)', [noticeId, mid]);
    }
  }
  return noticeId;
}

module.exports = { writeNotice };
