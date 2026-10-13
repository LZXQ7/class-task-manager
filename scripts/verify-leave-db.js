/**
 * [verify-leave-db] 真 MySQL 回归：后台请假 查看/编辑
 *
 * 回路：mysql-memory-server 本地真 MySQL + 生产同款 DDL + 真实调用 mod-leave。
 * 重点验证 SQL 语义（mock 验不到）：
 *   · listLeave 不显示测试账号（student_no 命中 0000000000 前缀）；
 *   · 列表按 classId / status 过滤；
 *   · 改时段（用户场景：下午 → 下午到晚上）只改 leave_request，不触动 duty；
 *   · 改日期区间 / 改状态 触发 duty 的 LEAVE 标记重算（与小程序 addLeave/cancelLeave 同口径）；
 *   · 审计 action = leave.update；非法入参被拒。
 */
'use strict';
const path = require('path');

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
const modLeave = require(ROOT + '/cloudfunctions/admin-web/lib/mod-leave');

const DDL = `
CREATE TABLE class (
  id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL, join_token VARCHAR(32) NOT NULL UNIQUE,
  invite_code VARCHAR(16) NOT NULL UNIQUE, term_start DATE NOT NULL, total_weeks TINYINT NOT NULL DEFAULT 16,
  is_active TINYINT NOT NULL DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE member (
  id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1, name VARCHAR(64) NOT NULL,
  student_no VARCHAR(32) NOT NULL, group_tag VARCHAR(8) DEFAULT 'X', status VARCHAR(16) DEFAULT 'ACTIVE',
  duty_count INT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE leave_request (
  id INT AUTO_INCREMENT PRIMARY KEY, member_id INT NOT NULL, swap_id INT DEFAULT NULL,
  start_date DATE NOT NULL, end_date DATE NOT NULL,
  start_time TIME NULL DEFAULT NULL, end_time TIME NULL DEFAULT NULL,
  status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') DEFAULT 'PENDING',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  leave_image VARCHAR(128) NULL DEFAULT NULL, cancelled_at DATETIME NULL DEFAULT NULL,
  KEY idx_member_date (member_id, start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE duty (
  id INT AUTO_INCREMENT PRIMARY KEY, session_id INT NOT NULL, week TINYINT NOT NULL,
  class_date DATE NOT NULL, member_id INT NOT NULL,
  status ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source ENUM('AUTO','MANUAL') DEFAULT 'AUTO', done_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_duty (session_id, week, member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE admin_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY, admin_id INT NOT NULL, member_id INT NOT NULL,
  username VARCHAR(32) NOT NULL, module VARCHAR(32) NOT NULL, action VARCHAR(48) NOT NULL, class_id INT DEFAULT NULL,
  summary VARCHAR(512) NOT NULL DEFAULT '', detail JSON DEFAULT NULL, ip VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } }

async function q1(conn, sql, args) { const [r] = await conn.query(sql, args); return r; }

async function main() {
  const db = await createDB({ dbName: 'repro_leave', username: 'root' });
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName });
  const pool = mysql.createPool({ host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName, connectionLimit: 5 });
  realPool = pool;
  try {
    for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(stmt);
    await conn.query("INSERT INTO class (name, join_token, invite_code, term_start) VALUES ('示例班级A','jt3','ic3','2026-09-14')");
    // 真人张三 / 测试账号（学号命中 0000000000 前缀）
    await conn.query("INSERT INTO member (class_id, name, student_no, group_tag) VALUES (1,'张三','20210011','A'),(1,'测试号','000000000001','A'),(1,'李四','20210012','B'),(1,'王五','20210013','A')");
    const session2 = { adminId: 1, memberId: 99, username: 'repro' };
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };

    console.log('=== 数据准备：张三 APPROVED 下午假；测试号 APPROVED 下午假');
    await conn.query("INSERT INTO leave_request (member_id, start_date, end_date, start_time, end_time, status) VALUES (1,'2026-10-01','2026-10-01','13:00:00','17:00:00','APPROVED')");
    await conn.query("INSERT INTO leave_request (member_id, start_date, end_date, start_time, end_time, status) VALUES (2,'2026-10-02','2026-10-02','13:00:00','17:00:00','APPROVED')");
    // 张三 10-01 的值日已被置 LEAVE（addLeave 行为）
    await conn.query("INSERT INTO duty (session_id, week, class_date, member_id, status) VALUES (1,1,'2026-10-01',1,'LEAVE')");

    console.log('=== listLeave 不显示测试账号');
    let list = await modLeave.listLeave({ classId: 1 }, session2, req);
    assert(list.length === 1 && list[0].name === '张三', '测试账号被过滤，仅返回张三（实测：' + JSON.stringify(list.map(r => r.name)) + '）');

    console.log('=== listLeave 按 status 过滤');
    let pend = await modLeave.listLeave({ classId: 1, status: 'PENDING' }, session2, req);
    assert(pend.length === 0, 'status=PENDING 返回 0 条');
    let appr = await modLeave.listLeave({ classId: 1, status: 'APPROVED' }, session2, req);
    assert(appr.length === 1, 'status=APPROVED 返回 1 条');

    console.log('=== 改时段：下午(13-17) → 下午到晚上(13-21)（用户场景）');
    const r1 = await modLeave.updateLeave({ id: 1, startTime: '13:00', endTime: '21:00' }, session2, req);
    assert(r1.ok && r1.dateChanged === false && r1.statusChanged === false, '仅时段微调，dateChanged/statusChanged 均为 false');
    let lr = await q1(conn, 'SELECT start_time, end_time FROM leave_request WHERE id = 1');
    assert(lr[0].start_time === '13:00:00' && lr[0].end_time === '21:00:00', 'leave_request 时段已改为 13:00–21:00（实测：' + lr[0].start_time + '~' + lr[0].end_time + '）');
    let d1 = await q1(conn, "SELECT status FROM duty WHERE class_date='2026-10-01' AND member_id=1");
    assert(d1[0].status === 'LEAVE', '仅改时段不触动 duty（仍 LEAVE）');

    console.log('=== 改日期区间 → 重算 duty 标记');
    // 李四 APPROVED 10-05~10-06，duty：10-05 LEAVE，10-07 PENDING
    await conn.query("INSERT INTO leave_request (member_id, start_date, end_date, status) VALUES (3,'2026-10-05','2026-10-06','APPROVED')");
    await conn.query("INSERT INTO duty (session_id, week, class_date, member_id, status) VALUES (10,1,'2026-10-05',3,'LEAVE'),(11,1,'2026-10-07',3,'PENDING')");
    await modLeave.updateLeave({ id: 3, startDate: '2026-10-07', endDate: '2026-10-08' }, session2, req);
    let d05 = await q1(conn, "SELECT status FROM duty WHERE class_date='2026-10-05' AND member_id=3");
    let d07 = await q1(conn, "SELECT status FROM duty WHERE class_date='2026-10-07' AND member_id=3");
    assert(d05[0].status === 'PENDING', '10-05 不再被覆盖 → 退回 PENDING');
    assert(d07[0].status === 'LEAVE', '10-07 新被覆盖 → 置 LEAVE');

    console.log('=== 改状态 APPROVED → CANCELLED → 重算并置 cancelled_at');
    await conn.query("INSERT INTO leave_request (member_id, start_date, end_date, status) VALUES (4,'2026-10-09','2026-10-09','APPROVED')");
    await conn.query("INSERT INTO duty (session_id, week, class_date, member_id, status) VALUES (12,1,'2026-10-09',4,'LEAVE')");
    await modLeave.updateLeave({ id: 4, status: 'CANCELLED' }, session2, req);
    let d09 = await q1(conn, "SELECT status FROM duty WHERE class_date='2026-10-09' AND member_id=4");
    let ca = await q1(conn, 'SELECT cancelled_at FROM leave_request WHERE id = 4');
    assert(d09[0].status === 'PENDING', '撤销后 10-09 duty 退回 PENDING');
    assert(!!ca[0].cancelled_at, '撤销已置 cancelled_at（实测：' + ca[0].cancelled_at + '）');

    console.log('=== 审计 action = leave.update');
    assert(auditActions.includes('leave.update'), '审计 action = leave.update（实测：' + JSON.stringify(auditActions) + '）');

    console.log('=== 非法入参应被拒（BizError 40001）');
    for (const [label, body] of [
      ['缺 id', { startTime: '13:00' }],
      ['非法状态', { id: 1, status: 'WEIRD' }],
      ['起始晚于结束', { id: 1, startDate: '2026-10-09', endDate: '2026-10-08' }],
      ['结束时间不晚于开始', { id: 1, startTime: '18:00', endTime: '13:00' }],
    ]) {
      let threw = false;
      try { await modLeave.updateLeave(body, session2, req); } catch (e) { threw = e.errCode === 40001 || e.code === 'BizError'; }
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
