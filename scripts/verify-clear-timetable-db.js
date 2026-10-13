/**
 * [repro-clear] 真实 MySQL 复现「清空课表 ALL → 500」
 *
 * 回路：本地 ephemeral MySQL（mysql-memory-server）+ 生产同款 DDL
 *       （关键：bak_admin_session.group_scope 是 enum('A','B') NOT NULL）
 *       + 用户场景数据（示例班级C 34 个 COURSE 课次，含 group_scope IS NULL 全体课）
 *       → 直接调用真的 clearTimetable（common/db.getPool 已替换为本地池）。
 *
 * 预期红：commit ALL 在备份 INSERT 时因全体课 group_scope=NULL 违反 NOT NULL。
 * 预期绿（修复验证）：ALTER bak_admin_session 让 group_scope 可 NULL 后重跑 → ok:true，
 *                     且 CLEAN 课次保留、备份含 NULL 行、孤儿课程被清、发布周退草稿。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy';
const WS = 'C:/Users/PC/.workbuddy/binaries/node/workspace/node_modules';
const { createDB } = require(WS + '/mysql-memory-server');
const mysql = require(WS + '/mysql2/promise');

// ---- 在 require mod-course 之前打补丁（它 require 时就解构 getPool/logAction）----
const dbmod = require(ROOT + '/cloudfunctions/admin-web/common/db');
const audit = require(ROOT + '/cloudfunctions/admin-web/lib/audit');
let realPool = null;
dbmod.getPool = () => realPool;
audit.logAction = async (session, payload) => {
  fs.appendFileSync(__dirname + '/repro-clear-audit.log', JSON.stringify(payload) + '\n');
};

const modCourse = require(ROOT + '/cloudfunctions/admin-web/lib/mod-course');

const DDL = `
CREATE TABLE class (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  join_token VARCHAR(32) NOT NULL UNIQUE,
  invite_code VARCHAR(16) NOT NULL UNIQUE,
  term_start DATE NOT NULL,
  total_weeks TINYINT NOT NULL DEFAULT 16,
  bind_open TINYINT NOT NULL DEFAULT 1,
  period_time JSON DEFAULT NULL,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE member (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL DEFAULT 1,
  duty_count INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE course (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL DEFAULT 1,
  name VARCHAR(64) NOT NULL,
  teacher VARCHAR(32) DEFAULT NULL,
  room VARCHAR(32) DEFAULT NULL,
  course_type ENUM('ALL','GROUP') NOT NULL,
  duty_count TINYINT DEFAULT 2,
  created_by INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE session (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL DEFAULT 1,
  course_id INT NOT NULL,
  kind ENUM('COURSE','CLEAN') NOT NULL DEFAULT 'COURSE',
  week_rule ENUM('ALL','ODD','EVEN') DEFAULT 'ALL',
  weeks VARCHAR(64) DEFAULT '',
  day_of_week TINYINT NOT NULL,
  period TINYINT NOT NULL,
  group_scope ENUM('A','B') DEFAULT NULL,
  duty_count TINYINT DEFAULT 2,
  note VARCHAR(64) NOT NULL DEFAULT '',
  KEY idx_slot (day_of_week, period, week_rule),
  KEY idx_course (course_id),
  KEY idx_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE duty (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  week TINYINT NOT NULL,
  class_date DATE NOT NULL,
  member_id INT NOT NULL,
  status ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source ENUM('AUTO','MANUAL') DEFAULT 'AUTO',
  done_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_duty (session_id, week, member_id),
  KEY idx_date (class_date),
  KEY idx_member_week (member_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE session_shift (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  week TINYINT NOT NULL,
  kind ENUM('OFF','MOVE') NOT NULL,
  to_day TINYINT DEFAULT NULL,
  to_period TINYINT DEFAULT NULL,
  note VARCHAR(64) DEFAULT '',
  created_by INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shift (session_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 生产 multiclass 后的 schedule_publish 形状（class_id + week）
CREATE TABLE schedule_publish (
  class_id INT NOT NULL DEFAULT 1,
  week TINYINT NOT NULL,
  status ENUM('DRAFT','PUBLISHED') DEFAULT 'DRAFT',
  published_at DATETIME DEFAULT NULL,
  published_by INT DEFAULT NULL,
  PRIMARY KEY (class_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE admin_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  member_id INT NOT NULL,
  username VARCHAR(32) NOT NULL,
  module VARCHAR(32) NOT NULL,
  action VARCHAR(48) NOT NULL,
  class_id INT DEFAULT NULL,
  summary VARCHAR(512) NOT NULL DEFAULT '',
  detail JSON DEFAULT NULL,
  ip VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ↓↓↓ 与生产 scripts/admin-bak-tables.sql 逐字同款（关键嫌疑就在 group_scope NOT NULL）↓↓↓
CREATE TABLE IF NOT EXISTS bak_admin_session (
  batch_no   varchar(20)  NOT NULL,
  class_id   int          NOT NULL,
  group_scope enum('A','B')  NOT NULL,
  session_id int          NOT NULL,
  course_id  int          NOT NULL,
  kind       enum('COURSE','CLEAN') NOT NULL,
  week_rule  enum('ALL','ODD','EVEN') DEFAULT 'ALL',
  weeks      varchar(64)  DEFAULT '',
  day_of_week tinyint     NOT NULL,
  period     tinyint      NOT NULL,
  duty_count tinyint      DEFAULT '2',
  note      varchar(64)  NOT NULL DEFAULT '',
  KEY idx_batch (batch_no),
  KEY idx_class_group (class_id, group_scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bak_admin_course (
  batch_no  varchar(20) NOT NULL,
  course_id int         NOT NULL,
  name      varchar(64) NOT NULL,
  teacher   varchar(32) DEFAULT '',
  room      varchar(64) DEFAULT '',
  KEY idx_batch (batch_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function seed(conn) {
  await conn.query(
    "INSERT INTO class (name, join_token, invite_code, term_start, total_weeks) VALUES ('示例班级C','jt1','ic1','2026-09-07',16)"
  );
  // 16 门课：c1..c15 清空后成孤儿；c16 被 CLEAN 课次引用必须保留
  for (let i = 1; i <= 16; i++) {
    await conn.query(
      "INSERT INTO course (name, course_type, created_by) VALUES (?, 'ALL', 1)", ['课程' + i]
    );
  }
  // 34 个 COURSE：10 个全体课(NULL) + 12 个 A + 12 个 B（c1..c15 各被引用；c16 不被 COURSE 引用）
  const scopes = [];
  for (let i = 0; i < 10; i++) scopes.push([1 + (i % 10), null]);      // 全体课 → course 1..10
  for (let i = 0; i < 12; i++) scopes.push([11 + (i % 2), 'A']);       // A 组 → course 11,12
  for (let i = 0; i < 12; i++) scopes.push([13 + (i % 2), 'B']);       // B 组 → course 13,14
  for (const [cid, gs] of scopes) {
    await conn.query(
      "INSERT INTO session (course_id, kind, day_of_week, period, group_scope, note) VALUES (?, 'COURSE', 1, 1, ?, '')",
      [cid, gs]
    );
  }
  // 2 个 CLEAN（必须幸存），c16
  await conn.query(
    "INSERT INTO session (course_id, kind, day_of_week, period, group_scope, note) VALUES (16,'CLEAN',6,5,NULL,'保洁')"
  );
  await conn.query(
    "INSERT INTO session (course_id, kind, day_of_week, period, group_scope, note) VALUES (16,'CLEAN',7,5,NULL,'保洁')"
  );
  // 值日：仅 2 条过去的 DONE（对应用户场景 affectedDuties=0），挂在 session 1
  await conn.query(
    "INSERT INTO duty (session_id, week, class_date, member_id, status, done_at) VALUES (1,2,'2026-09-14',1,'DONE','2026-09-14 20:00:00')"
  );
  await conn.query(
    "INSERT INTO duty (session_id, week, class_date, member_id, status, done_at) VALUES (1,3,'2026-09-21',1,'DONE','2026-09-21 20:00:00')"
  );
  // 已发布周
  await conn.query("INSERT INTO schedule_publish (class_id, week, status) VALUES (1,1,'PUBLISHED'),(1,2,'PUBLISHED'),(1,3,'DRAFT')");
}

async function counts(conn) {
  const [[r]] = await conn.query(`
    SELECT
      (SELECT COUNT(*) FROM session WHERE kind='COURSE') AS courseSessions,
      (SELECT COUNT(*) FROM session WHERE kind='CLEAN') AS cleanSessions,
      (SELECT COUNT(*) FROM bak_admin_session) AS bakSessionRows,
      (SELECT COUNT(*) FROM bak_admin_course) AS bakCourseRows,
      (SELECT COUNT(*) FROM course) AS courses,
      (SELECT COUNT(*) FROM duty) AS duties,
      (SELECT COUNT(*) FROM schedule_publish WHERE status='PUBLISHED') AS publishedWeeks
  `);
  return r;
}

async function main() {
  const db = await createDB({ dbName: 'repro_clear', username: 'root' });
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName
  });
  const pool = mysql.createPool({
    host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName,
    connectionLimit: 5
  });
  realPool = pool;

  const out = [];
  const log = (s) => { console.log(s); out.push(s); };

  try {
    for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) {
      await conn.query(stmt);
    }
    await seed(conn);
    const session2 = { adminId: 1, memberId: 1, username: 'repro' };
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

    log('=== [0] 初始状态: ' + JSON.stringify(await counts(conn)));

    log('=== [1] dryRun ALL');
    const preview = await modCourse.clearTimetable({ classId: 1, groupScope: 'ALL', dryRun: true }, session2, req);
    log('    preview: ' + JSON.stringify(preview));

    log('=== [2] commit ALL（预期红：全体课 group_scope=NULL 违反 bak NOT NULL）');
    try {
      const r = await modCourse.clearTimetable({ classId: 1, groupScope: 'ALL', dryRun: false }, session2, req);
      log('    ❌ 未复现！返回: ' + JSON.stringify(r));
      log('    状态: ' + JSON.stringify(await counts(conn)));
    } catch (e) {
      log('    🔴 RED 复现: code=' + e.code + ' errno=' + e.errno + ' sqlState=' + e.sqlState);
      log('    message: ' + e.message);
      log('    sql: ' + String(e.sql || '').slice(0, 200));
      log('    事务后状态(应原样未动): ' + JSON.stringify(await counts(conn)));
    }

    log('=== [3] 修复验证：ALTER bak_admin_session.group_scope 允许 NULL 后重跑');
    await conn.query(
      "ALTER TABLE bak_admin_session MODIFY COLUMN `group_scope` enum('A','B') NULL DEFAULT NULL COMMENT '被覆盖的组别（NULL=全体课）'"
    );
    const r2 = await modCourse.clearTimetable({ classId: 1, groupScope: 'ALL', dryRun: false }, session2, req);
    log('    ✅ GREEN 返回: ' + JSON.stringify(r2));
    const after = await counts(conn);
    log('    终态: ' + JSON.stringify(after));
    const [[bakNull]] = await conn.query('SELECT COUNT(*) c FROM bak_admin_session WHERE group_scope IS NULL');
    log('    备份中 group_scope IS NULL 的行数(应=10): ' + bakNull.c);
    if (after.cleanSessions !== 2) throw new Error('CLEAN 课次被误删！');
    if (after.courseSessions !== 0) throw new Error('COURSE 课次未清完！');
    if (Number(bakNull.c) !== 10) throw new Error('备份 NULL 行数不对！');
    if (after.publishedWeeks !== 0) throw new Error('已发布周未退草稿！');
    log('=== 结论：ALTER 修复有效');
  } finally {
    try { await conn.end(); } catch (e) {}
    try { await pool.end(); } catch (e) {}
    try { await db.stop(); } catch (e) {}
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[FATAL]', e); process.exit(1); });
