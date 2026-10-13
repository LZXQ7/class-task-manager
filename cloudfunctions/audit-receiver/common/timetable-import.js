/**
 * 课表导入写库核心（2026-10-10 抽出）
 * ============================================================
 * 为什么抽到 common：
 *   课表导入是**唯一一处「全量覆盖」级别的破坏性写操作**（先清空本班同组全部 COURSE
 *   课次，再整批写回）。它此前只长在 course 云函数里，导致小程序侧要导入 示例班级B课表时
 *   只能走「本地脚本解析 → SQL 直插」这种旁门左道 —— 没有干跑预览、没有审计、
 *   也没有 A/B 自动降全体课这条业务规则的复用。
 *   网页后台要做同样的事，就必须有第二个调用点 ⇒ 规则必须只有一份定义处。
 *
 * 签名固定为 (conn, payload, actor)：
 *   conn   已经**开启事务**的连接（写入前必须先 DELETE 旧课次，这是全量覆盖，容不得半提交）
 *   payload{ classId, groupScope, courses[], sessions[] }（courses/sessions 由调用方解析好）
 *   actor  { memberId } —— 落 course.created_by 与审计用；**不是 member 对象**，
 *          因为网页后台没有小程序 member 上下文（那边靠 openid 解出来的）
 *
 * 调用方仍需自行负责：解析文件 → dryRun 预览 → 开事务 → 调本文件 → commit。
 */
const week = require('./week');

/**
 * 删除课次前回滚轮转标记。
 * ⚠️ 删行不回滚 duty_count = 游标单向漂移（项目 MEMORY 铁律 7），
 *    所以任何「删 session」的地方都必须先过这里。
 */
async function rollbackDutyMarkers(conn, ids) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT member_id, COUNT(*) AS n FROM duty
      WHERE id IN (${ph}) AND status <> 'SWAPPED_OUT' GROUP BY member_id`,
    list
  );
  for (const r of rows) {
    await conn.query(
      'UPDATE member SET duty_count = GREATEST(duty_count - ?, 0) WHERE id = ?',
      [Number(r.n) || 0, Number(r.member_id)]
    );
  }
}

/**
 * 事务内写入一批课次（**调用前必须已 beginTransaction**）。
 * 返回 { imported, courses, warnings, deletedSessions, deletedDuties }。
 *
 * 业务口径（不可改）：
 *   · 只覆盖 class_id + groupScope 这一组，绝不碰另一组、绝不碰 CLEAN 保洁课次；
 *   · 「同星期 + 同节次 + 同周次 + 同课名 + 同教室」在 A、B 两组都出现 ⇒ 自动降为全体课
 *     （group_scope = NULL）并**删掉本次这一条**，避免同一门课在库里留两行；
 *   · 删除未开始（PENDING/ONGOING 且 class_date >= 今天）的值日并回滚 duty_count；
 *     已完成 / 已请假的历史值日保留 —— 历史不该被一次导入抹掉。
 */
async function writeTimetable(conn, payload, actor) {
  const classId = Number(payload.classId);
  const groupScope = payload.groupScope;
  const courses = payload.courses || [];
  const sessions = payload.sessions || [];
  const warnings = payload.warnings ? payload.warnings.slice() : [];
  const today = week.todayStr();
  const memberId = actor && actor.memberId ? Number(actor.memberId) : 0;

  // ① 清掉本班「同组」COURSE 课次
  const [cur] = await conn.query(
    "SELECT id FROM session WHERE class_id = ? AND kind = 'COURSE' AND group_scope = ?",
    [classId, groupScope]
  );
  const ids = cur.map((r) => Number(r.id));
  let deletedSessions = 0;
  let deletedDuties = 0;
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const [duties] = await conn.query(
      `SELECT id FROM duty WHERE session_id IN (${ph}) AND status IN ('PENDING','ONGOING') AND class_date >= ?`,
      ids.concat([today])
    );
    if (duties.length) await rollbackDutyMarkers(conn, duties.map((r) => Number(r.id)));
    const [del] = await conn.query(
      `DELETE d FROM duty d JOIN session s ON s.id = d.session_id
        WHERE s.id IN (${ph}) AND s.class_id = ? AND d.status IN ('PENDING','ONGOING') AND d.class_date >= ?`,
      ids.concat([classId, today])
    );
    deletedDuties = del && del.affectedRows ? Number(del.affectedRows) : 0;
    try {
      await conn.query(
        `DELETE FROM session_shift WHERE class_id = ? AND session_id IN (${ph})`,
        [classId].concat(ids)
      );
    } catch (e) { /* 表未建：忽略 */ }
    await conn.query(`DELETE FROM session WHERE id IN (${ph})`, ids);
    deletedSessions = ids.length;
  }

  // ② 清理孤立 COURSE 课程行。
  //    ⚠️ 判据不能只看「本班无引用」—— 另一组的课次可能正引用着同名课程行，
  //    只删「全库无人引用」的，否则 A 组重导会误删 B 组正在用的课程。
  await conn.query(
    'DELETE FROM course WHERE class_id = ? AND id NOT IN (SELECT course_id FROM session)',
    [classId]
  );

  // ③ 写课程（名+教师 去重）与课次。
  //    同名课程 A/B 两组共用同一行 —— 否则课表页会显示成两门重复课。
  const courseIdByKey = new Map();
  for (const co of courses) {
    const [exist] = await conn.query(
      'SELECT id FROM course WHERE class_id = ? AND name = ? AND teacher = ? LIMIT 1',
      [classId, co.name, co.teacher || '']
    );
    if (exist.length) {
      courseIdByKey.set(co.name + ' ' + co.teacher, Number(exist[0].id));
      continue;
    }
    const [r1] = await conn.query(
      'INSERT INTO course (class_id, name, teacher, room, course_type, duty_count, created_by) VALUES (?,?,?,?,?,?,?)',
      [classId, co.name, co.teacher || '', co.room || '', 'ALL', 2, memberId]
    );
    courseIdByKey.set(co.name + ' ' + co.teacher, Number(r1.insertId));
  }
  for (const s of sessions) {
    const cid = courseIdByKey.get(s.name + ' ' + (s.teacher || ''));
    if (!cid) continue;
    await conn.query(
      'INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES (?,?,?,?,?,?,?,?,?)',
      [classId, cid, 'COURSE', 'ALL', s.weeks || '', s.dayOfWeek, s.period, groupScope, 2]
    );
  }

  // ④ A/B 重复 ⇒ 自动降全体课
  const other = groupScope === 'A' ? 'B' : 'A';
  let sharedCount = 0;
  const [dupRows] = await conn.query(
    `SELECT s.id, s.day_of_week, s.period, s.weeks, c.name, IFNULL(c.room,'') AS room
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.class_id = ? AND s.kind = 'COURSE' AND s.group_scope = ?`,
    [classId, other]
  );
  if (dupRows.length) {
    // 周次先规范化再比，否则 '1,2,3' 与 '3,2,1' 会被判成两门不同的课
    const normWeeks = (w) => String(w || '').split(',')
      .map((x) => parseInt(x, 10)).filter((n) => n > 0)
      .sort((a, b) => a - b).join(',');
    const otherKey = new Map();
    dupRows.forEach((r) => {
      otherKey.set([r.day_of_week, r.period, normWeeks(r.weeks), r.name, r.room].join('|'), Number(r.id));
    });
    const [mineRows] = await conn.query(
      `SELECT s.id, s.day_of_week, s.period, s.weeks, c.name, IFNULL(c.room,'') AS room
         FROM session s JOIN course c ON c.id = s.course_id
        WHERE s.class_id = ? AND s.kind = 'COURSE' AND s.group_scope = ?`,
      [classId, groupScope]
    );
    const delIds = [];
    const matchedOtherIds = [];
    const seenOther = new Set();
    for (const r of mineRows) {
      const k = [r.day_of_week, r.period, normWeeks(r.weeks), r.name, r.room].join('|');
      const oid = otherKey.get(k);
      if (oid === undefined) continue;
      // 只降级「确实重复」的那些行；把另一组全部课次都降成 NULL 等于没分组
      delIds.push(Number(r.id));
      if (!seenOther.has(oid)) { seenOther.add(oid); matchedOtherIds.push(oid); }
      sharedCount++;
    }
    if (delIds.length) {
      await conn.query('DELETE FROM session WHERE id IN (' + delIds.map(() => '?').join(',') + ')', delIds);
      await conn.query(
        'UPDATE session SET group_scope = NULL WHERE id IN (' + matchedOtherIds.map(() => '?').join(',') + ')',
        matchedOtherIds
      );
    }
  }
  if (sharedCount) {
    warnings.push('有 ' + sharedCount + ' 节课两组时间/地点/课程相同，已自动合并为全体课（A、B 视图都会显示）');
  }

  return {
    imported: sessions.length,
    courses: courses.length,
    warnings,
    deletedSessions,
    deletedDuties
  };
}

/**
 * 课表内容变了 ⇒ 已发布周退回草稿。
 * 放在本文件是为了让 course 云函数与网页后台**同口径**：两边改课表都必须退回草稿，
 * 否则小程序端看到的是一份「已发布但内容对不上」的排班表。
 */
async function toDraftWeeks(pool, weeks, classId) {
  let reset = false;
  for (const wk of weeks) {
    try {
      const [r] = await pool.query(
        "UPDATE schedule_publish SET status = 'DRAFT' WHERE class_id = ? AND week = ? AND status = 'PUBLISHED'",
        [classId, wk]
      );
      if (r && r.affectedRows) reset = true;
    } catch (e) { /* 表未建：忽略 */ }
  }
  return reset;
}

module.exports = { writeTimetable, toDraftWeeks, rollbackDutyMarkers };