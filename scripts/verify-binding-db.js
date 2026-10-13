/**
 * [verify-binding-db] 真 MySQL 回归：后台绑定情况
 *
 * 回路：mysql-memory-server 本地真 MySQL + 生产同款 DDL + 真实调用 mod-config.overview。
 * 重点验证 SQL 语义（mock 验不到）：
 *   · overview 的 boundCount 统计「openid 非空」的成员；
 *   · 测试账号（student_no 命中 0000000000 前缀）被排除，不计入 memberCount / boundCount；
 *   · 各班绑定数与 stats.boundCount 汇总正确。
 */
'use strict';
const path = require('path');

const ROOT = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy';
const WS = 'C:/Users/PC/.workbuddy/binaries/node/workspace/node_modules';
const { createDB } = require(WS + '/mysql-memory-server');
const mysql = require(WS + '/mysql2/promise');

const dbmod = require(ROOT + '/cloudfunctions/admin-web/common/db');
let realPool = null;
dbmod.getPool = () => realPool;
const modConfig = require(ROOT + '/cloudfunctions/admin-web/lib/mod-config');

const DDL = `
CREATE TABLE \`class\` (
  id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL,
  is_active TINYINT NOT NULL DEFAULT 1, total_weeks TINYINT NOT NULL DEFAULT 16,
  term_start DATE NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE member (
  id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1,
  name VARCHAR(64) NOT NULL, student_no VARCHAR(32) NOT NULL,
  group_tag VARCHAR(8) DEFAULT 'X', status VARCHAR(16) DEFAULT 'ACTIVE',
  openid VARCHAR(64) DEFAULT NULL UNIQUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE session (
  id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1,
  course_id INT NOT NULL, kind ENUM('COURSE','CLEAN') NOT NULL DEFAULT 'COURSE',
  day_of_week TINYINT NOT NULL, period TINYINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE duty (
  id INT AUTO_INCREMENT PRIMARY KEY, class_id INT NOT NULL DEFAULT 1, session_id INT NOT NULL, week TINYINT NOT NULL,
  class_date DATE NOT NULL, member_id INT NOT NULL,
  status ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source ENUM('AUTO','MANUAL') DEFAULT 'AUTO', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE admin_user (
  id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(32) NOT NULL,
  status TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE admin_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY, admin_id INT NOT NULL, member_id INT NOT NULL,
  username VARCHAR(32) NOT NULL, module VARCHAR(32) NOT NULL, action VARCHAR(48) NOT NULL,
  class_id INT DEFAULT NULL, summary VARCHAR(512) DEFAULT '', detail JSON DEFAULT NULL,
  ip VARCHAR(64) DEFAULT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

let failures = 0;
function assert(cond, msg) { if (!cond) { failures++; console.log('  ✗ ' + msg); } else { console.log('  ✓ ' + msg); } }

async function main() {
  const db = await createDB({ dbName: 'repro_binding', username: 'root' });
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName });
  const pool = mysql.createPool({ host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName, connectionLimit: 5 });
  realPool = pool;
  try {
    for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(stmt);
    await conn.query("INSERT INTO `class` (name, is_active, total_weeks, term_start) VALUES ('示例班级A',1,16,'2026-09-14'),('示例班级B',1,16,'2026-09-14')");
    // 1 班：张三(已绑) / 李四(未绑) / 测试号(已绑但测试账号→排除)
    await conn.query("INSERT INTO member (class_id, name, student_no, group_tag, openid) VALUES (1,'张三','20210011','A','openid_zs'),(1,'李四','20210012','B',NULL),(1,'测试号','000000000001','A','openid_test')");
    // 2 班：王五(已绑) / 赵六(未绑)
    await conn.query("INSERT INTO member (class_id, name, student_no, group_tag, openid) VALUES (2,'王五','20210013','A','openid_ww'),(2,'赵六','20210014','B',NULL)");
    await conn.query("INSERT INTO admin_user (username, status) VALUES ('admin', 1)");
    await conn.query("INSERT INTO admin_audit_log (admin_id, member_id, username, module, action) VALUES (1,1,'admin','config','x')");

    console.log('=== overview 概览 ===');
    const o = await modConfig.overview();
    const c1 = o.classes.find(c => c.id === 1);
    const c2 = o.classes.find(c => c.id === 2);
    assert(o.classes.length === 2, '返回 2 个班级');
    assert(c1.memberCount === 2, '1 班 memberCount=2（测试号被排除，实测：' + c1.memberCount + '）');
    assert(c1.boundCount === 1, '1 班 boundCount=1（仅张三，李四未绑、测试号被排除，实测：' + c1.boundCount + '）');
    assert(c2.memberCount === 2, '2 班 memberCount=2');
    assert(c2.boundCount === 1, '2 班 boundCount=1（仅王五，实测：' + c2.boundCount + '）');
    assert(o.stats.memberCount === 4, '汇总 memberCount=4（实测：' + o.stats.memberCount + '）');
    assert(o.stats.boundCount === 2, '汇总 boundCount=2（实测：' + o.stats.boundCount + '）');

    console.log(failures === 0 ? '\n✅ 全部通过' : '\n❌ 失败 ' + failures + ' 项');
  } finally {
    try { await conn.end(); } catch (e) {}
    try { await pool.end(); } catch (e) {}
    try { await db.stop(); } catch (e) {}
  }
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
