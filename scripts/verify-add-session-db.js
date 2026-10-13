/**
 * [verify-add-session-db] 真 MySQL 回归：单独添加课次（A/B/全体）
 *
 * 回路：mysql-memory-server 本地真 MySQL + 生产同款 DDL + 真实调用 addSession。
 * 重点验证 SQL 语义（mock 验不到）：
 *   · 全体课必须落 group_scope=NULL（与导入口径一致，否则误当成某组）；
 *   · course_type 必须按组别填（全体='ALL' / A,B='GROUP'），否则踩 enum NOT NULL
 *     就像 2026-10-12 清空课表 500 那样；
 *   · 同名课程复用、已发布周退回草稿、审计记录。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy';
const WS = 'C:/Users/PC/.workbuddy/binaries/node/workspace/node_modules';
const { createDB } = require(WS + '/mysql-memory-server');
const mysql = require(WS + '/mysql2/promise');

const dbmod = require(ROOT + '/cloudfunctions/admin-web/common/db');
const audit = require(ROOT + '/cloudfunctions/admin-web/lib/audit');
let realPool = null;
const auditActions = [];
dbmod.getPool = () => realPool;
audit.logAction = async (s, p) => { auditActions.push(p && p.action); };
const modCourse = require(ROOT + '/cloudfunctions/admin-web/lib/mod-course');

const DDL = `
CREATE TABLE class (
  id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, join_token VARCHAR(32) NOT NULL UNIQUE,
  invite_code VARCHAR(16) NOT NULL UNIQUE, term_start DATE NOT NULL, total_weeks TINYINT NOT NULL DEFAULT 16,
  bind_open TINYINT NOT NULL DEFAULT 1, period_time JSON DEFAULT NULL, is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE member (id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1, duty_count INT DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE course (
  id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1, name VARCHAR(64) NOT NULL,
  teacher VARCHAR(32) DEFAULT NULL, room VARCHAR(32) DEFAULT NULL, course_type ENUM('ALL','GROUP') NOT NULL,
  duty_count TINYINT DEFAULT 2, created_by INT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE session (
  id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1, course_id INT NOT NULL,
  kind ENUM('COURSE','CLEAN') NOT NULL DEFAULT 'COURSE', week_rule ENUM('ALL','ODD','EVEN') DEFAULT 'ALL',
  weeks VARCHAR(64) DEFAULT '', day_of_week TINYINT NOT NULL, period TINYINT NOT NULL,
  group_scope ENUM('A','B') DEFAULT NULL, duty_count TINYINT DEFAULT 2, note VARCHAR(64) NOT NULL DEFAULT '',
  KEY idx_slot (day_of_week, period, week_rule), KEY idx_course (course_id), KEY idx_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE duty (id INT AUTO_INCREMENT PRIMARY KEY, session_id INT NOT NULL, week TINYINT NOT NULL,
  class_date DATE NOT NULL, member_id INT NOT NULL, status ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source ENUM('AUTO','MANUAL') DEFAULT 'AUTO', done_at DATETIME DEFAULT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_duty (session_id, week, member_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE session_shift (id INT AUTO_INCREMENT PRIMARY KEY, session_id INT NOT NULL, week TINYINT NOT NULL,
  kind ENUM('OFF','MOVE') NOT NULL, to_day TINYINT DEFAULT NULL, to_period TINYINT DEFAULT NULL, note VARCHAR(64) DEFAULT '',
  created_by INT DEFAULT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shift (session_id, week)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE schedule_publish (class_id INT NOT NULL DEFAULT 1, week TINYINT NOT NULL,
  status ENUM('DRAFT','PUBLISHED') DEFAULT 'DRAFT', published_at DATETIME DEFAULT NULL, published_by INT DEFAULT NULL,
  PRIMARY KEY (class_id, week)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE admin_audit_log (id INT AUTO_INCREMENT PRIMARY KEY, admin_id INT NOT NULL, member_id INT NOT NULL,
  username VARCHAR(32) NOT NULL, module VARCHAR(32) NOT NULL, action VARCHAR(48) NOT NULL, class_id INT DEFAULT NULL,
  summary VARCHAR(512) NOT NULL DEFAULT '', detail JSON DEFAULT NULL, ip VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bak_admin_session (batch_no varchar(20) NOT NULL, class_id int NOT NULL,
  group_scope enum('A','B') NULL DEFAULT NULL, session_id int NOT NULL, course_id int NOT NULL,
  kind enum('COURSE','CLEAN') NOT NULL, week_rule enum('ALL','ODD','EVEN') DEFAULT 'ALL', weeks varchar(64) DEFAULT '',
  day_of_week tinyint NOT NULL, period tinyint NOT NULL, duty_count tinyint DEFAULT '2', note varchar(64) NOT NULL DEFAULT '',
  KEY idx_batch (batch_no), KEY idx_class_group (class_id, group_scope)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bak_admin_course (batch_no varchar(20) NOT NULL, course_id int NOT NULL,
  name varchar(64) NOT NULL, teacher varchar(32) DEFAULT '', room varchar(64) DEFAULT '',
  KEY idx_batch (batch_no)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } }

async function q1(conn, sql, args) { const [r] = await conn.query(sql, args); return r; }

async function main() {
  const db = await createDB({ dbName: 'repro_add', username: 'root' });
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName });
  const pool = mysql.createPool({ host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName, connectionLimit: 5 });
  realPool = pool;
  try {
    for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(stmt);
    await conn.query("INSERT INTO class (name, join_token, invite_code, term_start, total_weeks) VALUES ('示例班级A','jt3','ic3','2026-09-14',16)");
    await conn.query("INSERT INTO course (class_id, name, teacher, room, course_type, created_by) VALUES (1,'高等数学','李老师','A101','ALL',1)");
    await conn.query("INSERT INTO schedule_publish (class_id, week, status) VALUES (1,1,'PUBLISHED'),(1,2,'PUBLISHED'),(1,3,'DRAFT')");
    const session2 = { adminId: 1, memberId: 13, username: 'repro' };
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

    console.log('=== A 组新增（应建新 course，course_type=GROUP，group_scope=A）');
    const a = await modCourse.addSession({ classId: 1, courseName: '大学物理', teacher: '王老师', room: 'B201', dayOfWeek: 3, period: 2, groupScope: 'A', weekRule: 'ALL', weeks: '', dutyCount: 2, note: '' }, session2, req);
    assert(a.ok === true, 'A 组新增返回 ok');
    let row = await q1(conn, 'SELECT group_scope, course_id FROM session WHERE id = ?', [a.sessionId]);
    assert(row[0].group_scope === 'A', 'A 组课次 group_scope = A（实测：' + row[0].group_scope + '）');
    let ctype = await q1(conn, 'SELECT course_type FROM course WHERE id = ?', [a.courseId]);
    assert(ctype[0].course_type === 'GROUP', 'A 组课程 course_type = GROUP（实测：' + ctype[0].course_type + '）');

    console.log('=== B 组新增（course_type=GROUP，group_scope=B）');
    const b = await modCourse.addSession({ classId: 1, courseName: '线性代数', dayOfWeek: 4, period: 1, groupScope: 'B', weekRule: 'ODD', weeks: '1-15' }, session2, req);
    row = await q1(conn, 'SELECT group_scope FROM session WHERE id = ?', [b.sessionId]);
    assert(row[0].group_scope === 'B', 'B 组课次 group_scope = B');
    ctype = await q1(conn, 'SELECT course_type FROM course WHERE id = ?', [b.courseId]);
    assert(ctype[0].course_type === 'GROUP', 'B 组课程 course_type = GROUP');

    console.log('=== 全体新增（group_scope=NULL，course_type=ALL）');
    const w = await modCourse.addSession({ classId: 1, courseName: '形势与政策', dayOfWeek: 5, period: 5, groupScope: 'ALL', weekRule: 'ALL', weeks: '' }, session2, req);
    row = await q1(conn, 'SELECT group_scope FROM session WHERE id = ?', [w.sessionId]);
    assert(row[0].group_scope === null, '全体课次 group_scope = NULL（关键！否则会误判成某组）');
    ctype = await q1(conn, 'SELECT course_type FROM course WHERE id = ?', [w.courseId]);
    assert(ctype[0].course_type === 'ALL', '全体课程 course_type = ALL');

    console.log('=== 同名课程复用（应复用「高等数学」，不新建 course）');
    const before = (await q1(conn, 'SELECT COUNT(*) c FROM course'))[0].c;
    await modCourse.addSession({ classId: 1, courseName: '高等数学', dayOfWeek: 1, period: 1, groupScope: 'ALL' }, session2, req);
    const after = (await q1(conn, 'SELECT COUNT(*) c FROM course'))[0].c;
    assert(before === after, '同名课程未新增 course（复用，' + before + '→' + after + '）');

    console.log('=== 已发布周次退回草稿');
    const [[pub]] = await conn.query("SELECT COUNT(*) c FROM schedule_publish WHERE class_id=1 AND status='PUBLISHED'");
    assert(pub.c === 0, '新增后已发布周次已全部退回草稿（剩余 PUBLISHED=' + pub.c + '）');

    console.log('=== 审计记录');
    assert(auditActions.includes('timetable.add'), '审计 action = timetable.add（实测：' + JSON.stringify(auditActions) + '）');

    console.log('=== 非法入参应被拒（BizError）');
    for (const [label, body] of [
      ['缺课程名', { classId: 1, dayOfWeek: 1, period: 1, groupScope: 'A' }],
      ['非法组别', { classId: 1, courseName: 'X', dayOfWeek: 1, period: 1, groupScope: 'C' }],
      ['非法周次规则', { classId: 1, courseName: 'X', dayOfWeek: 1, period: 1, groupScope: 'A', weekRule: 'BAD' }],
      ['非法大节', { classId: 1, courseName: 'X', dayOfWeek: 1, period: 9, groupScope: 'A' }],
    ]) {
      let threw = false;
      try { await modCourse.addSession(body, session2, req); } catch (e) { threw = e.errCode === 40001 || e.code === 'BizError'; }
      assert(threw, '拒绝：' + label);
    }

    console.log(failures === 0 ? '\n✅ 全部通过' : '\n❌ 失败 ' + failures + ' 项');
  } finally {
    try { await conn.end(); } catch (e) {}
    try { await pool.end(); } catch (e) {}
    try { await db.stop(); } catch (e) {}
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
