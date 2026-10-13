/**
 * 课程表（模块：course）
 *
 * 后台的课表能力与小程序的关键差异（这正是做后台的价值）：
 *   小程序侧超管要导入**别的班**的课表时，guard.classIdOf 会把写入目标串到本人班
 *   （项目 MEMORY「课表多班隔离」已记录该限制，本期小程序只做「查看」）。
 *   后台没有 openid 上下文，直接用**显式传入的 classId**，并把它落进审计，
 *   干跑预览强制显示目标班级名 + 影响行数。
 *
 * 写入一律走 common/timetable-import.js —— 与小程序 course.importTimetable 同一份实现，
 * 两条业务规则（A/B 自动降全体课 / 删课次回滚 duty_count）不允许各写一份。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const timetableImport = require('../common/timetable-import');
const timetableWeek = require('../common/week');
const { logAction } = require('./audit');

/**
 * 课表读取：一个班全部课次（COURSE + CLEAN 都给，CLEAN 是保洁别混掉）。
 * @param {number} classId
 * @param {string} [group] 'A'|'B'|'ALL'
 */
async function listTimetable(classId, group) {
  const pool = getPool();
  const where = ['s.class_id = ?'];
  const args = [Number(classId)];
  if (group === 'A' || group === 'B') {
    // A 视图 = 本组课 + 全体课（group_scope IS NULL），这与小程序课表页口径一致
    where.push('(s.group_scope = ? OR s.group_scope IS NULL)');
    args.push(group);
  }
  const [rows] = await pool.query(
    'SELECT s.id, s.kind, s.week_rule, s.weeks, s.day_of_week, s.period, s.group_scope, ' +
    's.duty_count, s.note, c.name, c.teacher, c.room ' +
    'FROM session s JOIN course c ON c.id = s.course_id ' +
    'WHERE ' + where.join(' AND ') +
    ' ORDER BY s.day_of_week, s.period, c.name',
    args
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    courseName: r.name,
    teacher: r.teacher || '',
    room: r.room || '',
    dayOfWeek: Number(r.day_of_week),
    period: Number(r.period),
    weeks: r.weeks || '',
    weekRule: r.week_rule || 'ALL',
    // group_scope 为 NULL = 全体课，前端要能区分展示（不是 bug，是两组合上的课）
    groupScope: r.group_scope === null ? 'ALL' : r.group_scope,
    dutyCount: Number(r.duty_count || 0),
    note: r.note || ''
  }));
}

/**
 * 干跑预览：**只算不改**，返回「这次导入会动到什么」。
 * 护栏要求（方案已定）：必须显示目标班级名 + 影响行数，让操作者在点确认前
 * 真的知道自己要覆盖掉谁。
 *
 * @param {object} payload { classId, groupScope, courses, sessions }
 */
async function dryRunImport(payload) {
  const pool = getPool();
  const classId = Number(payload.classId);
  const groupScope = String(payload.groupScope || '').toUpperCase();
  if (groupScope !== 'A' && groupScope !== 'B') throw new BizError(40001, '请选择要导入的组别（A 或 B）');
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (!sessions.length) throw new BizError(40001, '没有可导入的课次');

  const [crows] = await pool.query('SELECT id, name FROM `class` WHERE id = ? LIMIT 1', [classId]);
  if (!crows[0]) throw new BizError(40404, '班级不存在');
  const className = crows[0].name;

  // 将被删除的既有课次 / 值日（**只统计未开始且属同组同班的**）
  const [oldSessions] = await pool.query(
    "SELECT id FROM session WHERE class_id = ? AND kind = 'COURSE' AND group_scope = ?",
    [classId, groupScope]
  );
  const ids = oldSessions.map((r) => Number(r.id));
  let affectedDuties = 0;
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const [[d]] = await pool.query(
      "SELECT COUNT(*) AS c FROM duty WHERE session_id IN (" + ph + ") " +
      "AND status IN ('PENDING','ONGOING') AND class_date >= CURDATE()",
      ids
    );
    affectedDuties = Number(d.c || 0);
  }

  // A/B 重复（会降为全体课）的预估条数
  const normWeeks = (w) => String(w || '').split(',')
    .map((x) => parseInt(x, 10)).filter((n) => n > 0)
    .sort((a, b) => a - b).join(',');
  const other = groupScope === 'A' ? 'B' : 'A';
  const [otherRows] = await pool.query(
    'SELECT s.day_of_week, s.period, s.weeks, c.name, IFNULL(c.room,\'\') AS room ' +
    'FROM session s JOIN course c ON c.id = s.course_id ' +
    "WHERE s.class_id = ? AND s.kind = 'COURSE' AND s.group_scope = ?",
    [classId, other]
  );
  const otherKeys = new Set(otherRows.map((r) =>
    [r.day_of_week, r.period, normWeeks(r.weeks), r.name, r.room].join('|')
  ));
  let willBeShared = 0;
  for (const s of sessions) {
    const k = [s.dayOfWeek, s.period, normWeeks(s.weeks), s.name, s.room || ''].join('|');
    if (otherKeys.has(k)) willBeShared++;
  }

  return {
    dryRun: true,
    classId,
    className,
    groupScope,
    groupLabel: groupScope + ' 组',
    targetSummary: '将覆盖 ' + className + ' 的 ' + groupScope + ' 组全部课程课次',
    impact: {
      oldSessionCount: ids.length,
      oldSessionRows: ids,
      affectedDuties,
      newSessionCount: sessions.length,
      newCourseCount: Array.isArray(payload.courses) ? payload.courses.length : 0,
      willBeShared
    },
    warnings: (payload.warnings || []).slice(),
    // 已发布周会被退回草稿 —— 提前告诉操作者，别让他以为发布状态不受影响
    note: '导入后该班已发布的周次会退回草稿，需要在小程序端重新发布。'
  };
}

/**
 * 正式导入：先自动 bak_* 备份，再开事务调共用写入逻辑。
 * 备份表名带时间戳，与手工 SQL 回滚口径一致（方案：回滚走手工 SQL）。
 */
async function commitImport(payload, session, req) {
  const pool = getPool();
  const classId = Number(payload.classId);
  const groupScope = String(payload.groupScope || '').toUpperCase();
  if (groupScope !== 'A' && groupScope !== 'B') throw new BizError(40001, '请选择要导入的组别（A 或 B）');
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (!sessions.length) throw new BizError(40001, '没有可导入的课次');

  const [crows] = await pool.query('SELECT id, name FROM `class` WHERE id = ? LIMIT 1', [classId]);
  if (!crows[0]) throw new BizError(40404, '班级不存在');
  const className = crows[0].name;

  const stamp = new Date()
    .toISOString().replace(/[-:T]/g, '').slice(0, 14);

  /**
   * 先备份将被删除的课次（含其课程行），失败即中止，绝不「没备份就开删」。
   *
   * ⚠️ 为什么写**常备表**而不是 `CREATE TABLE bak_session_<时间戳> LIKE session`
   *   （2026-10-10 真机 500 实踩）：应用数据库账号 `classassist_app` 只有 DML 权限，
   *   没有 DDL —— CREATE TABLE 直接被 MySQL 拒掉：
   *     ER_TABLEACCESS_DENIED_ERROR 1142 "CREATE command denied to user ..."
   *   表现为导入接口 500，且因为事务还没开、数据一行没动，**看起来像导入坏了**。
   *   而所有历史 bak_* 表都是我用 root 手工建的，运行期账号自己建不出来。
   *
   *   改成两张预先建好的常备表（scripts/admin-bak-tables.sql，DBA 侧一次性执行）：
   *     bak_admin_session —— 结构 = session 的可写副本 + batch_no 批次号
   *     bak_admin_course  —— 结构 = course  的可写副本 + batch_no 批次号
   *   每次导入 = DELETE WHERE batch_no = 本次 + INSERT SELECT，全程 DML。
   *   好处：① 不需要 DDL；② 备份可累积、可按批次回滚（原来按时间戳分表，
   *   导多了就是几十张表，没人查得动）；③ 结构恒定，回滚 SQL 只需换 batch_no。
   */
  const BAK_SESSION = 'bak_admin_session';
  const BAK_COURSE = 'bak_admin_course';

  const [oldSessions] = await pool.query(
    "SELECT s.* FROM session s WHERE s.class_id = ? AND s.kind = 'COURSE' AND s.group_scope = ?",
    [classId, groupScope]
  );
  let backedUp = { sessions: 0, courses: 0 };
  if (oldSessions.length) {
    const ids = oldSessions.map((r) => Number(r.id));
    const ph = ids.map(() => '?').join(',');
    await pool.query('DELETE FROM `' + BAK_SESSION + '` WHERE batch_no = ?', [stamp]);
    await pool.query(
      'INSERT INTO `' + BAK_SESSION + '` (batch_no, class_id, group_scope, session_id, course_id, ' +
      'kind, week_rule, weeks, day_of_week, period, duty_count, note) ' +
      "SELECT ?, s.class_id, s.group_scope, s.id, s.course_id, s.kind, s.week_rule, s.weeks, " +
      "s.day_of_week, s.period, s.duty_count, IFNULL(s.note,'') FROM session s WHERE s.id IN (" + ph + ')',
      [stamp].concat(ids)
    );
    backedUp.sessions = oldSessions.length;

    const courseIds = Array.from(new Set(oldSessions.map((r) => Number(r.course_id)).filter(Boolean)));
    if (courseIds.length) {
      const cph = courseIds.map(() => '?').join(',');
      await pool.query('DELETE FROM `' + BAK_COURSE + '` WHERE batch_no = ?', [stamp]);
      await pool.query(
        'INSERT INTO `' + BAK_COURSE + '` (batch_no, course_id, name, teacher, room) ' +
        'SELECT ?, c.id, c.name, IFNULL(c.teacher,\'\'), IFNULL(c.room,\'\') ' +
        'FROM course c WHERE c.id IN (' + cph + ')',
        [stamp].concat(courseIds)
      );
      backedUp.courses = courseIds.length;
    }
  }

  const conn = await pool.getConnection();
  let result;
  try {
    await conn.beginTransaction();
    result = await timetableImport.writeTimetable(
      conn,
      {
        classId,
        groupScope,
        courses: Array.isArray(payload.courses) ? payload.courses : [],
        sessions,
        warnings: payload.warnings || []
      },
      { memberId: session.memberId }
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // 内容变了 ⇒ 已发布周退回草稿（与小程序同口径）
  const [[cfg]] = await pool.query('SELECT total_weeks FROM `class` WHERE id = ?', [classId]);
  const totalWeeks = Number(cfg && cfg.total_weeks) || 16;
  const resetPublish = await timetableImport.toDraftWeeks(
    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), classId
  );

  await logAction(session, {
    module: 'course',
    action: 'timetable.import',
    classId,
    summary: '导入 ' + className + ' ' + groupScope + ' 组课表：' + result.imported + ' 节课次（覆盖旧 ' + result.deletedSessions + ' 节）',
    detail: {
      className,
      groupScope,
      imported: result.imported,
      courses: result.courses,
      deletedSessions: result.deletedSessions,
      deletedDuties: result.deletedDuties,
      resetPublish,
      backupBatch: stamp,
      backupTables: oldSessions.length ? [BAK_SESSION, BAK_COURSE] : [],
      backupRows: backedUp
    }
  }, req);

  return {
    ...result,
    className,
    resetPublish,
    backupBatch: stamp,
    backupTables: oldSessions.length ? [BAK_SESSION, BAK_COURSE] : [],
    backupRows: backedUp,
    rollbackHint: oldSessions.length
      ? '如需回滚：用备份批次号 ' + stamp + ' 从 ' + BAK_SESSION + '（课次）与 ' +
        BAK_COURSE + '（课程）手工恢复，SQL 见 docs/网页管理后台-使用说明.md。'
      : '本次为首次导入，无需回滚。'
  };
}

/** 单个课次改（跨班可改） */
async function updateSession(id, patch, session, req) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT s.*, c.name AS course_name FROM session s JOIN course c ON c.id = s.course_id WHERE s.id = ? LIMIT 1',
    [id]
  );
  const before = rows[0];
  if (!before) throw new BizError(40404, '课次不存在');

  const sets = [];
  const args = [];
  const changed = {};
  const put = (col, val) => { sets.push(col + ' = ?'); args.push(val); changed[col] = val; };
  if (patch.dayOfWeek !== undefined) {
    const d = Number(patch.dayOfWeek);
    if (!(d >= 1 && d <= 7)) throw new BizError(40001, '星期应为 1-7');
    put('day_of_week', d);
  }
  if (patch.period !== undefined) {
    const p = Number(patch.period);
    if (!(p >= 1 && p <= 5)) throw new BizError(40001, '大节应为 1-5');
    put('period', p);
  }
  if (patch.room !== undefined) {
    const r = String(patch.room).slice(0, 32);
    // 教室挂在 course 上（不在 session，见项目 MEMORY「请假改造决议」）
    await pool.query('UPDATE course SET room = ? WHERE id = ?', [r, before.course_id]);
    changed.room = r;
  }
  if (patch.note !== undefined) put('note', String(patch.note).slice(0, 64));
  if (patch.dutyCount !== undefined) {
    const n = Number(patch.dutyCount);
    if (!(n >= 0 && n <= 20)) throw new BizError(40001, '每节值日人数应在 0-20');
    put('duty_count', n);
  }
  if (!sets.length && !('room' in changed)) throw new BizError(40001, '没有要更新的字段');

  if (sets.length) {
    args.push(id);
    await pool.query('UPDATE session SET ' + sets.join(', ') + ' WHERE id = ?', args);
  }
  // 课次是「所有周共用」的一行，改它等于改了全部周 ⇒ 已发布周要**全部**退回草稿，
  // 只退第 1 周会留下「已发布但内容对不上」的周次（小程序端看到的是错的排班表）。
  const [[cfg]] = await pool.query('SELECT total_weeks FROM `class` WHERE id = ?', [before.class_id]);
  const totalWeeks = Number(cfg && cfg.total_weeks) || 16;
  const resetPublish = await timetableImport.toDraftWeeks(
    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), before.class_id
  );
  await logAction(session, {
    module: 'course',
    action: 'session.update',
    classId: before.class_id,
    summary: '修改课次 ' + before.course_name + '（' + before.day_of_week + ' 星期第 ' + before.period + ' 节）：' + Object.keys(changed).join('、'),
    detail: { sessionId: id, before: { dayOfWeek: before.day_of_week, period: before.period, note: before.note, dutyCount: before.duty_count }, after: changed }
  }, req);
  return { ok: true, resetPublish, changed };
}

/**
 * 单个课次删除（跨班可删）。与导入/改课次同口径的三件事一件不能少：
 *   ① 先备份（常备表 bak_admin_session / bak_admin_course，应用账号没有 DDL，
 *      不能 CREATE TABLE bak_xxx —— 见 commitImport 里的实踩注释）；
 *   ② 只删**未来**的 PENDING/ONGOING 值日并先回滚标记，历史值日原样保留
 *      （与 common/timetable-import.js writeTimetable 完全同一口径）；
 *   ③ 删完后把该班**全部已发布周次**退回草稿 —— 课次少了一行，
 *      已发布周里的排班表就与数据对不上了，只退一周会留错表。
 */
async function deleteSession(id, session, req) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT s.*, c.name AS course_name FROM session s JOIN course c ON c.id = s.course_id WHERE s.id = ? LIMIT 1',
    [id]
  );
  const before = rows[0];
  if (!before) throw new BizError(40404, '课次不存在');

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const BAK_SESSION = 'bak_admin_session';
  const BAK_COURSE = 'bak_admin_course';

  // 备份课次行（同导入第①步的列集，回滚 SQL 只需换 batch_no）
  await pool.query('DELETE FROM `' + BAK_SESSION + '` WHERE batch_no = ?', [stamp]);
  await pool.query(
    'INSERT INTO `' + BAK_SESSION + '` (batch_no, class_id, group_scope, session_id, course_id, ' +
    'kind, week_rule, weeks, day_of_week, period, duty_count, note) ' +
    "SELECT ?, s.class_id, s.group_scope, s.id, s.course_id, s.kind, s.week_rule, s.weeks, " +
    "s.day_of_week, s.period, s.duty_count, IFNULL(s.note,'') FROM session s WHERE s.id = ?",
    [stamp, id]
  );

  const conn = await pool.getConnection();
  let deletedDuties = 0;
  try {
    await conn.beginTransaction();
    const today = timetableWeek.todayStr();
    const [duties] = await conn.query(
      "SELECT id FROM duty WHERE session_id = ? AND status IN ('PENDING','ONGOING') AND class_date >= ?",
      [id, today]
    );
    if (duties.length) {
      await timetableImport.rollbackDutyMarkers(conn, duties.map((r) => Number(r.id)));
      const [del] = await conn.query(
        "DELETE FROM duty WHERE session_id = ? AND status IN ('PENDING','ONGOING') AND class_date >= ?",
        [id, today]
      );
      deletedDuties = del && del.affectedRows ? Number(del.affectedRows) : 0;
    }
    try {
      await conn.query('DELETE FROM session_shift WHERE class_id = ? AND session_id = ?', [before.class_id, id]);
    } catch (e) { /* 表未建：忽略（与导入同） */ }
    await conn.query('DELETE FROM session WHERE id = ?', [id]);
    // 孤立课程行清理：判据是**全库无人引用**（course 是本班的、但可能被另一组课次
    // 引用着），只删「本班无引用」会误删另一组正在用的课 —— 与导入第②步同口径。
    // 先备份可能被删的 course 行：它就是这门课最后的存档。
    const [orphans] = await conn.query(
      'SELECT id FROM course WHERE class_id = ? AND id NOT IN (SELECT course_id FROM session)',
      [before.class_id]
    );
    if (orphans.length) {
      const ph = orphans.map((r) => '?').join(',');
      await pool.query('DELETE FROM `' + BAK_COURSE + '` WHERE batch_no = ?', [stamp]);
      await conn.query(
        'INSERT INTO `' + BAK_COURSE + '` (batch_no, course_id, name, teacher, room) ' +
        "SELECT ?, c.id, c.name, IFNULL(c.teacher,''), IFNULL(c.room,'') FROM course c WHERE c.id IN (" + ph + ')',
        [stamp].concat(orphans.map((r) => Number(r.id)))
      );
      await conn.query(
        'DELETE FROM course WHERE class_id = ? AND id NOT IN (SELECT course_id FROM session)',
        [before.class_id]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  const [[cfg]] = await pool.query('SELECT total_weeks FROM `class` WHERE id = ?', [before.class_id]);
  const totalWeeks = Number(cfg && cfg.total_weeks) || 16;
  const resetPublish = await timetableImport.toDraftWeeks(
    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), before.class_id
  );

  await logAction(session, {
    module: 'course',
    action: 'session.delete',
    classId: before.class_id,
    summary: '删除课次 ' + before.course_name + '（周' + before.day_of_week + ' 第 ' + before.period + ' 节），连带清掉未来值日 ' + deletedDuties + ' 条',
    detail: {
      sessionId: id,
      before: { dayOfWeek: before.day_of_week, period: before.period, weeks: before.weeks, dutyCount: before.duty_count, note: before.note },
      deletedDuties,
      resetPublish,
      backupBatch: stamp,
      backupTables: [BAK_SESSION, BAK_COURSE]
    }
  }, req);

  return {
    ok: true,
    deletedDuties,
    resetPublish,
    backupBatch: stamp,
    rollbackHint: '如需回滚：用备份批次号 ' + stamp + ' 从 ' + BAK_SESSION + '（课次）与 ' +
      BAK_COURSE + '（课程）手工恢复。'
  };
}

/**
 * 清空课表：删除某班某组（A / B）或全部的 COURSE 课次。
 * 与导入 / 删课次同口径的三件事一件不能少：
 *   ① 先备份（常备表 bak_admin_session / bak_admin_course，应用账号无 DDL）；
 *   ② 只删**未来**的 PENDING/ONGOING 值日并先回滚 duty_count 标记；
 *   ③ 删完后把该班**全部已发布周次**退回草稿。
 * 可选 dryRun：只算不改，返回影响预览（前端确认前先给用户看清楚要删多少）。
 *
 * 组别语义（与导入对齐）：
 *   · 'A' / 'B'：只删该组独有课次（group_scope = ?），全体课（group_scope IS NULL）不删；
 *   · 'ALL'：删全部 COURSE 课次（含全体课）—— 因为全体课两组共用，单组清空不应动它。
 * 三种范围都**只碰 COURSE**，绝不碰 CLEAN 保洁课次。
 */
async function clearTimetable(payload, session, req) {
  const pool = getPool();
  const classId = Number(payload.classId);
  const groupScope = String(payload.groupScope || '').toUpperCase();
  const dryRun = !!payload.dryRun;
  if (groupScope !== 'A' && groupScope !== 'B' && groupScope !== 'ALL') {
    throw new BizError(40001, '请选择要清空的组别（A 组 / B 组 / 全部）');
  }
  const [crows] = await pool.query(
    'SELECT id, name, total_weeks FROM `class` WHERE id = ? LIMIT 1', [classId]
  );
  if (!crows[0]) throw new BizError(40404, '班级不存在');
  const className = crows[0].name;
  const totalWeeks = Number(crows[0].total_weeks) || 16;

  // 只动 COURSE 课次；全体课（group_scope IS NULL）只有在 ALL 时才删
  const whereScope = groupScope === 'ALL'
    ? "(s.kind = 'COURSE' AND (s.group_scope IN ('A','B') OR s.group_scope IS NULL))"
    : "s.kind = 'COURSE' AND s.group_scope = ?";
  const scopeArgs = groupScope === 'ALL' ? [] : [groupScope];

  const [oldSessions] = await pool.query(
    'SELECT s.* FROM session s WHERE s.class_id = ? AND ' + whereScope,
    [classId].concat(scopeArgs)
  );
  const ids = oldSessions.map((r) => Number(r.id));

  // 未开始值日（影响行数，提交时一并清理）
  let affectedDuties = 0;
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    const [[d]] = await pool.query(
      "SELECT COUNT(*) AS c FROM duty WHERE session_id IN (" + ph + ") " +
      "AND status IN ('PENDING','ONGOING') AND class_date >= CURDATE()",
      ids
    );
    affectedDuties = Number(d.c || 0);
  }

  // 孤立课程预估：被删课次引用的课程，删完若没别的课次引用就变孤儿
  let orphanCourses = 0;
  if (ids.length) {
    const courseIds = Array.from(new Set(oldSessions.map((r) => Number(r.course_id)).filter(Boolean)));
    if (courseIds.length) {
      const ph = ids.map(() => '?').join(',');
      const [ref] = await pool.query(
        'SELECT DISTINCT course_id FROM session WHERE class_id = ? AND id NOT IN (' + ph + ')',
        [classId].concat(ids)
      );
      const stillUsed = new Set(ref.map((r) => Number(r.course_id)));
      orphanCourses = courseIds.filter((c) => !stillUsed.has(c)).length;
    }
  }

  const groupLabel = groupScope === 'ALL' ? '全部课程课次（含全体课）' : groupScope + ' 组课程课次';
  const targetSummary = '将清空 ' + className + ' 的 ' + groupLabel;

  if (dryRun) {
    return {
      dryRun: true,
      className,
      groupScope,
      groupLabel,
      targetSummary,
      oldSessionCount: ids.length,
      affectedDuties,
      orphanCourses
    };
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const BAK_SESSION = 'bak_admin_session';
  const BAK_COURSE = 'bak_admin_course';

  // ① 备份将被删除的课次（含其课程行），失败即中止，绝不「没备份就开删」
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    await pool.query('DELETE FROM `' + BAK_SESSION + '` WHERE batch_no = ?', [stamp]);
    await pool.query(
      'INSERT INTO `' + BAK_SESSION + '` (batch_no, class_id, group_scope, session_id, course_id, ' +
      'kind, week_rule, weeks, day_of_week, period, duty_count, note) ' +
      "SELECT ?, s.class_id, s.group_scope, s.id, s.course_id, s.kind, s.week_rule, s.weeks, " +
      "s.day_of_week, s.period, s.duty_count, IFNULL(s.note,'') FROM session s WHERE s.id IN (" + ph + ')',
      [stamp].concat(ids)
    );
    const courseIds = Array.from(new Set(oldSessions.map((r) => Number(r.course_id)).filter(Boolean)));
    if (courseIds.length) {
      const cph = courseIds.map(() => '?').join(',');
      await pool.query('DELETE FROM `' + BAK_COURSE + '` WHERE batch_no = ?', [stamp]);
      await pool.query(
        'INSERT INTO `' + BAK_COURSE + '` (batch_no, course_id, name, teacher, room) ' +
        'SELECT ?, c.id, c.name, IFNULL(c.teacher,\'\'), IFNULL(c.room,\'\') ' +
        'FROM course c WHERE c.id IN (' + cph + ')',
        [stamp].concat(courseIds)
      );
    }
  }

  const conn = await pool.getConnection();
  let deletedDuties = 0;
  try {
    await conn.beginTransaction();
    const today = timetableWeek.todayStr();
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const [duties] = await conn.query(
        "SELECT id FROM duty WHERE session_id IN (" + ph + ") AND status IN ('PENDING','ONGOING') AND class_date >= ?",
        ids.concat([today])
      );
      if (duties.length) {
        await timetableImport.rollbackDutyMarkers(conn, duties.map((r) => Number(r.id)));
        const [del] = await conn.query(
          "DELETE FROM duty WHERE session_id IN (" + ph + ") AND status IN ('PENDING','ONGOING') AND class_date >= ?",
          ids.concat([today])
        );
        deletedDuties = del && del.affectedRows ? Number(del.affectedRows) : 0;
      }
      try {
        await conn.query('DELETE FROM session_shift WHERE class_id = ? AND session_id IN (' + ph + ')',
          [classId].concat(ids));
      } catch (e) { /* 表未建：忽略 */ }
      await conn.query('DELETE FROM session WHERE id IN (' + ph + ')', ids);
    }
    // 孤立课程清理：只删「全库无人引用」的课程行（与导入 / 删课次同口径）
    if (ids.length) {
      const [orphans] = await conn.query(
        'SELECT id FROM course WHERE class_id = ? AND id NOT IN (SELECT course_id FROM session)',
        [classId]
      );
      const orphanRows = orphans || [];
      if (orphanRows.length) {
        const cph = orphanRows.map((r) => '?').join(',');
        await pool.query('DELETE FROM `' + BAK_COURSE + '` WHERE batch_no = ?', [stamp]);
        await conn.query(
          'INSERT INTO `' + BAK_COURSE + '` (batch_no, course_id, name, teacher, room) ' +
          "SELECT ?, c.id, c.name, IFNULL(c.teacher,''), IFNULL(c.room,'') FROM course c WHERE c.id IN (" + cph + ')',
          [stamp].concat(orphanRows.map((r) => Number(r.id)))
        );
        await conn.query(
          'DELETE FROM course WHERE class_id = ? AND id NOT IN (SELECT course_id FROM session)',
          [classId]
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  // 内容变了 ⇒ 已发布周退回草稿（与导入 / 删课次同口径）
  const resetPublish = await timetableImport.toDraftWeeks(
    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), classId
  );

  await logAction(session, {
    module: 'course',
    action: 'timetable.clear',
    classId,
    summary: '清空 ' + className + ' ' + groupLabel + '：删除 ' + ids.length + ' 个课次',
    detail: {
      className,
      groupScope,
      groupLabel,
      deletedSessions: ids.length,
      deletedDuties,
      orphanCourses,
      resetPublish,
      backupBatch: stamp,
      backupTables: ids.length ? [BAK_SESSION, BAK_COURSE] : []
    }
  }, req);

  return {
    ok: true,
    deletedSessions: ids.length,
    deletedDuties,
    orphanCourses,
    resetPublish,
    backupBatch: stamp,
    rollbackHint: ids.length
      ? '如需回滚：用备份批次号 ' + stamp + ' 从 ' + BAK_SESSION + '（课次）与 ' +
        BAK_COURSE + '（课程）手工恢复。'
      : '本次无课次可清空。'
  };
}

/**
 * 单独新增一节课（A 组 / B 组 / 全体）。
 * 与编辑/导入同口径的两件小事：
 *   ① 课程行按「本班 + 课程名」精确匹配，命中则复用（顺手补 teacher/room），
 *      没有则新建，course_type 跟组别走（全体课='ALL'，A/B='GROUP'）；
 *   ② 课次是「所有周共用」的一行，加一节等于改了排班表 ⇒ 已发布周全部退回草稿。
 * 纯新增、不删数据，无需备份。
 */
async function addSession(payload, session, req) {
  const pool = getPool();
  const classId = Number(payload.classId);
  const courseName = String(payload.courseName || '').trim();
  if (!courseName) throw new BizError(40001, '请填写课程名称');
  if (courseName.length > 64) throw new BizError(40001, '课程名称过长（≤64 字）');
  const teacher = payload.teacher != null ? String(payload.teacher).slice(0, 32) : '';
  const room = payload.room != null ? String(payload.room).slice(0, 32) : '';
  const dayOfWeek = Number(payload.dayOfWeek);
  if (!(dayOfWeek >= 1 && dayOfWeek <= 7)) throw new BizError(40001, '星期应为 1-7');
  const period = Number(payload.period);
  if (!(period >= 1 && period <= 5)) throw new BizError(40001, '大节应为 1-5');
  const grp = String(payload.groupScope || 'ALL').toUpperCase();
  if (grp !== 'A' && grp !== 'B' && grp !== 'ALL') throw new BizError(40001, '组别只能是 A / B / 全体');
  // 全体课在库里就是 group_scope = NULL（与前端标签/导入口径一致）
  const groupScope = grp === 'ALL' ? null : grp;
  const courseType = grp === 'ALL' ? 'ALL' : 'GROUP';
  const weekRule = String(payload.weekRule || 'ALL').toUpperCase();
  if (!['ALL', 'ODD', 'EVEN'].includes(weekRule)) throw new BizError(40001, '周次规则无效');
  const weeks = payload.weeks != null ? String(payload.weeks).slice(0, 64) : '';
  const dutyCount = payload.dutyCount !== undefined ? Number(payload.dutyCount) : 2;
  if (!(dutyCount >= 0 && dutyCount <= 20)) throw new BizError(40001, '每节值日人数应在 0-20');
  const note = payload.note != null ? String(payload.note).slice(0, 64) : '';

  const [crows] = await pool.query(
    'SELECT id, name, total_weeks FROM `class` WHERE id = ? LIMIT 1', [classId]
  );
  if (!crows[0]) throw new BizError(40404, '班级不存在');
  const className = crows[0].name;
  const totalWeeks = Number(crows[0].total_weeks) || 16;

  // ① 课程行：本班同名复用，否则新建
  let courseId;
  const [ex] = await pool.query(
    'SELECT id FROM course WHERE class_id = ? AND name = ? LIMIT 1', [classId, courseName]
  );
  if (ex[0]) {
    courseId = Number(ex[0].id);
    await pool.query(
      'UPDATE course SET teacher = IF(? = \'\', teacher, ?), room = IF(? = \'\', room, ?) WHERE id = ?',
      [teacher, teacher, room, room, courseId]
    );
  } else {
    const [ins] = await pool.query(
      'INSERT INTO course (class_id, name, teacher, room, course_type, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [classId, courseName, teacher, room, courseType, Number(session.memberId) || 0]
    );
    courseId = Number(ins.insertId);
  }

  // ② 写入课次
  const [sinx] = await pool.query(
    "INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count, note) " +
    "VALUES (?, ?, 'COURSE', ?, ?, ?, ?, ?, ?, ?)",
    [classId, courseId, weekRule, weeks, dayOfWeek, period, groupScope, dutyCount, note]
  );
  const sessionId = Number(sinx.insertId);

  // 内容变了 ⇒ 已发布周退回草稿（与编辑/导入同口径）
  const resetPublish = await timetableImport.toDraftWeeks(
    pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), classId
  );

  await logAction(session, {
    module: 'course',
    action: 'timetable.add',
    classId,
    summary: '新增课次 ' + courseName + '（' + (groupScope ? groupScope + ' 组' : '全体') +
      '，周' + dayOfWeek + ' 第 ' + period + ' 节）',
    detail: {
      className, courseName, groupScope: grp, dayOfWeek, period, weekRule, weeks, dutyCount, note,
      sessionId, courseId
    }
  }, req);

  return { ok: true, sessionId, courseId, groupScope: grp, resetPublish };
}

module.exports = { listTimetable, dryRunImport, commitImport, updateSession, deleteSession, clearTimetable, addSession };