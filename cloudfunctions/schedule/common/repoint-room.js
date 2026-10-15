/**
 * 课程身份 = 班级 + 课程名 + 教师 + 教室（见 timetable-import.js 同口径）。
 *
 * 背景（room 碰撞 bug 根因）：room 只挂在共享的 course 行上、session 无 room 列；
 * 过去按 name+teacher 复用 course 行 ⇒ 同课不同教室被压成第一个教室，且
 * `UPDATE course SET room` 会把同课名所有课次的教室一起改掉。
 *
 * 本文件把「改一节教室」收敛为「把该课次改挂到 (name,teacher,newRoom) 的课程行，
 * 没有就新建」，绝不改动其它课次正在用的共享课程行。旧课程行若已无人引用则清理。
 *
 * orphanHook(courseId)：可选，删除孤儿课程行前先备份（admin-web 用它写 BAK_COURSE）。
 *   小程序侧 course 云函数不备份（其既有 upsert 删除孤儿课程也从不备份），传 undefined。
 *
 * 返回 { newCourseId, oldCourseId, orphanDeleted }。
 */
async function repointSessionRoom(pool, opts) {
  const {
    classId, sessionId, name, teacher, newRoom,
    courseType, dutyCount, memberId, orphanHook
  } = opts;
  const room = String(newRoom || '').slice(0, 32);

  // ① 找 / 建目标课程行（含教室，即同课不同教室 = 两行，互不干扰）
  const [hit] = await pool.query(
    'SELECT id FROM course WHERE class_id = ? AND name = ? AND teacher = ? AND room = ? LIMIT 1',
    [Number(classId), name, teacher || '', room]
  );
  let newCourseId;
  if (hit[0]) {
    newCourseId = Number(hit[0].id);
  } else {
    const [ins] = await pool.query(
      'INSERT INTO course (class_id, name, teacher, room, course_type, duty_count, created_by) ' +
      'VALUES (?,?,?,?,?,?,?)',
      [Number(classId), name, teacher || '', room,
        courseType || 'GROUP', dutyCount == null ? 2 : Number(dutyCount), Number(memberId) || 0]
    );
    newCourseId = Number(ins.insertId);
  }

  // ② 改挂课次到目标课程行
  const [cur] = await pool.query(
    'SELECT course_id FROM session WHERE id = ? AND class_id = ?',
    [Number(sessionId), Number(classId)]
  );
  const oldCourseId = cur[0] ? Number(cur[0].course_id) : null;
  await pool.query(
    'UPDATE session SET course_id = ? WHERE id = ? AND class_id = ?',
    [newCourseId, Number(sessionId), Number(classId)]
  );

  // ③ 旧课程行若已无人引用则清理（避免同课名不同教室留下死行）
  let orphanDeleted = false;
  if (oldCourseId && oldCourseId !== newCourseId) {
    const [ref] = await pool.query('SELECT 1 FROM session WHERE course_id = ? LIMIT 1', [oldCourseId]);
    if (!ref.length) {
      if (orphanHook) await orphanHook(oldCourseId);
      await pool.query('DELETE FROM course WHERE id = ?', [oldCourseId]);
      orphanDeleted = true;
    }
  }
  return { newCourseId, oldCourseId, orphanDeleted };
}

module.exports = { repointSessionRoom };
