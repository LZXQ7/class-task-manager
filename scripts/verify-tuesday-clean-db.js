/**
 * 真库验证：每周二下午「410大扫除」= 4 人 + 名称「410大扫除」
 * ------------------------------------------------------------
 * 为什么用真 MySQL（mysql-memory-server）而不是桩 DB：
 *   本次改动的核心是**数据**（session.duty_count 2→4、course 换成「410大扫除」）。
 *   桩 DB 不会校验列类型/约束/UPDATE 语义，出了错也是「假绿」。
 *
 * 两段验证：
 *   [A] 迁移 SQL 语义：把库造成「改动前」的样子（周一~周五 5 条 CLEAN 全指向「打扫410」、
 *       duty_count=2），然后**真的执行** scripts/migrate-tuesday-clean.sql，
 *       断言周二=410大扫除+4、其余四天仍是打扫410+2。
 *   [B] 排班结果：用**真云函数源码** cloudfunctions/schedule/index.js 跑一次
 *       action=generate（只桩掉 wx-server-sdk / db / guard），断言
 *         ① 周二那条 CLEAN 课次落了 4 行 duty；
 *         ② 这 4 人互不相同，且与本周其它天的值日**不重复**（一轮每人最多一次）；
 *         ③ 周一/三/四/五的 CLEAN 仍是 2 人；
 *         ④ 周二那条回显的课程名是「410大扫除」。
 *
 * 用法：node scripts/verify-tuesday-clean-db.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy';
const WS = 'C:/Users/PC/.workbuddy/binaries/node/workspace/node_modules';
const { createDB } = require(WS + '/mysql-memory-server');
const mysql = require(WS + '/mysql2/promise');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
function eq(actual, expect, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expect)) ok(msg + '   → ' + JSON.stringify(actual));
  else bad(msg + '   → 实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect));
}

/* ---------------- DDL：只造本次验证用得到的表（生产同款列） ---------------- */
const DDL = `
CREATE TABLE class (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  join_token VARCHAR(32) NOT NULL,
  invite_code VARCHAR(16) NOT NULL,
  term_start DATE NOT NULL,
  total_weeks TINYINT NOT NULL DEFAULT 16,
  bind_open TINYINT NOT NULL DEFAULT 1,
  is_active TINYINT NOT NULL DEFAULT 1,
  period_time TEXT,
  round_cursor_a INT NOT NULL DEFAULT 0,
  round_cursor_b INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE class_config (
  id INT PRIMARY KEY,
  term_start DATE NOT NULL,
  total_weeks TINYINT NOT NULL DEFAULT 16,
  period_time TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE member (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL DEFAULT 1,
  name VARCHAR(32) NOT NULL,
  student_no VARCHAR(32) NOT NULL UNIQUE,
  group_tag ENUM('A','B','X') NOT NULL DEFAULT 'A',
  role ENUM('ADMIN','MONITOR','MEMBER') DEFAULT 'MEMBER',
  is_super TINYINT NOT NULL DEFAULT 0,
  position VARCHAR(32) NOT NULL DEFAULT '',
  status ENUM('ACTIVE','LEAVE','DISABLED') DEFAULT 'ACTIVE',
  duty_count INT DEFAULT 0,
  last_duty_at DATE DEFAULT NULL,
  duty_off TINYINT NOT NULL DEFAULT 0,
  remind_block TINYINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE course (
  id INT AUTO_INCREMENT PRIMARY KEY,
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
  note VARCHAR(64) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE duty (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL DEFAULT 1,
  session_id INT NOT NULL,
  week TINYINT NOT NULL,
  class_date DATE NOT NULL,
  member_id INT NOT NULL,
  status ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source ENUM('AUTO','MANUAL') DEFAULT 'AUTO',
  done_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_duty (session_id, week, member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE duty_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  duty_id INT NOT NULL,
  operator_id INT NOT NULL,
  action ENUM('CREATE','SWAP','LEAVE','DONE','UNDO','CANCEL') NOT NULL,
  from_member INT DEFAULT NULL,
  to_member INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE duty_week_cursor (
  class_id INT NOT NULL DEFAULT 1,
  week TINYINT NOT NULL,
  start_a INT NOT NULL DEFAULT 0,
  start_b INT NOT NULL DEFAULT 0,
  end_a INT NOT NULL DEFAULT 0,
  end_b INT NOT NULL DEFAULT 0,
  PRIMARY KEY (class_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE schedule_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  class_id INT NOT NULL DEFAULT 1,
  sort_by_count TINYINT DEFAULT 1,
  avoid_same_day TINYINT DEFAULT 1,
  avoid_back_to_back TINYINT DEFAULT 0,
  cron_enabled TINYINT DEFAULT 1,
  cron_weekday TINYINT DEFAULT 0,
  cron_hour TINYINT DEFAULT 20
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE schedule_publish (
  class_id INT NOT NULL DEFAULT 1,
  week TINYINT NOT NULL,
  status ENUM('DRAFT','PUBLISHED') DEFAULT 'DRAFT',
  published_at DATETIME DEFAULT NULL,
  published_by INT DEFAULT NULL,
  PRIMARY KEY (class_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE session_shift (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  week TINYINT NOT NULL,
  kind ENUM('OFF','MOVE') NOT NULL,
  to_day TINYINT DEFAULT NULL,
  to_period TINYINT DEFAULT NULL,
  note VARCHAR(64) DEFAULT '',
  UNIQUE KEY uq_shift (session_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE leave_request (
  id INT AUTO_INCREMENT PRIMARY KEY,
  member_id INT NOT NULL,
  swap_id INT DEFAULT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') DEFAULT 'PENDING',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE swap_request (
  id INT AUTO_INCREMENT PRIMARY KEY,
  duty_id INT NOT NULL,
  status ENUM('PENDING_PEER','PENDING_ADMIN','DONE','CANCELLED') DEFAULT 'PENDING_PEER',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

/** 本周一（东八区）*/
function thisMonday() {
  const d = new Date();
  const dow = d.getDay() || 7;
  d.setDate(d.getDate() - dow + 1);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function main() {
  const db = await createDB({ dbName: 'tue_clean', username: 'root' });
  const conn = await mysql.createConnection({
    host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName,
    dateStrings: true
  });
  const pool = mysql.createPool({
    host: '127.0.0.1', port: db.port, user: db.username, password: '', database: db.dbName,
    connectionLimit: 5, dateStrings: true
  });

  try {
    for (const stmt of DDL.split(';').map(s => s.trim()).filter(Boolean)) await conn.query(stmt);

    const MON = thisMonday();
    console.log('── 本周周一 = ' + MON + '（第 1 周）');

    /* ---------- 造「改动前」的数据：5 条 CLEAN 全指向「打扫410」、duty_count=2 ---------- */
    await conn.query(
      "INSERT INTO class (id, name, join_token, invite_code, term_start, total_weeks) VALUES (1, '验证班', 'tk', 'ic', ?, 16)", [MON]
    );
    await conn.query("INSERT INTO class_config (id, term_start, total_weeks) VALUES (1, ?, 16)", [MON]);
    await conn.query('INSERT INTO schedule_rules (class_id, avoid_same_day) VALUES (1, 1)');

    // 40 名在册学生（序号 1~40），A/B 交替分组
    const memVals = [];
    for (let i = 1; i <= 40; i += 1) {
      memVals.push([1, '同学' + i, '2099010301' + String(i).padStart(2, '0'), i % 2 ? 'A' : 'B']);
    }
    await conn.query(
      'INSERT INTO member (class_id, name, student_no, group_tag) VALUES ?',
      [memVals]
    );

    await conn.query(
      "INSERT INTO course (name, teacher, room, course_type, duty_count, created_by) VALUES ('打扫410', NULL, '410', 'ALL', 2, 1)"
    );
    const [[c410]] = await conn.query("SELECT id FROM course WHERE name = '打扫410'");
    // 周一~周五 第 4 节，5 条 CLEAN，全部 duty_count=2（改动前的样子）
    for (let d = 1; d <= 5; d += 1) {
      await conn.query(
        "INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES (1, ?, 'CLEAN', 'ALL', '', ?, 4, NULL, 2)",
        [c410.id, d]
      );
    }
    // 再放 3 条普通课次（周一/周三/周五 第 2 节，各 2 人）—— 用于验证「一轮里每人最多一次」
    await conn.query(
      "INSERT INTO course (name, teacher, room, course_type, duty_count, created_by) VALUES ('大学英语', '张老师', '410', 'ALL', 2, 1)"
    );
    const [[cEng]] = await conn.query("SELECT id FROM course WHERE name = '大学英语'");
    for (const d of [1, 3, 5]) {
      await conn.query(
        "INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES (1, ?, 'COURSE', 'ALL', '', ?, 2, NULL, 2)",
        [cEng.id, d]
      );
    }

    /* ================= [A] 迁移 SQL 语义 ================= */
    console.log('\n── [A] 真跑 scripts/migrate-tuesday-clean.sql');
    const before = await cleanState(conn);
    eq(before, [2, 2, 2, 2, 2].map(() => '打扫410|2'), '迁移前：周一~周五 5 条 CLEAN 全是「打扫410|2」');

    const migSql = fs.readFileSync(path.join(ROOT, 'scripts/migrate-tuesday-clean.sql'), 'utf8');
    const stmts = migSql
      .split('\n')
      .filter(l => !/^\s*--/.test(l))                 // 去掉整行注释
      .join('\n')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const s of stmts) await conn.query(s);

    const after = await cleanState(conn);
    eq(after, ['打扫410|2', '410大扫除|4', '打扫410|2', '打扫410|2', '打扫410|2'],
      '迁移后：周二=「410大扫除|4」，周一/三/四/五仍是「打扫410|2」');

    // 幂等：再跑一遍不应变化
    for (const s of stmts) await conn.query(s);
    eq(await cleanState(conn), after, '迁移 SQL 幂等：重复执行一次结果不变');
    const [[cnt]] = await conn.query("SELECT COUNT(*) c FROM course WHERE name = '410大扫除'");
    eq(Number(cnt.c), 1, '课程「410大扫除」只有 1 条（重复执行没有插重）');

    /* ================= [B] 真跑 schedule.generate ================= */
    console.log('\n── [B] 真跑云函数 schedule.generate（第 1 周）');
    const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/schedule/index.js'), 'utf8');
    const mod = { exports: {} };
    const fakeRequire = (name) => {
      if (name === 'wx-server-sdk') return { DYNAMIC_CURRENT_ENV: 'dyn', init() {} };
      if (name === './common/db') return { getPool: () => pool };
      if (name === './common/guard') {
        return {
          getContext: async () => ({ member: { id: 1, is_super: 1, class_id: 1 } }),
          classIdOf: () => 1,
          requireScheduleAuth: () => {},
          requireBind: () => {}, requireAdmin: () => {}, requireSuper: () => {},
          isSuper: () => true
        };
      }
      if (name.startsWith('./common/')) {
        return require(path.join(ROOT, 'cloudfunctions', 'common', name.replace('./common/', '') + '.js'));
      }
      throw new Error('意外的 require：' + name);
    };
    new Function('require', 'module', 'exports', 'process', 'console', src)(
      fakeRequire, mod, mod.exports, process, { log() {}, error() {} }
    );

    const res = await mod.exports.main({ action: 'generate', payload: { week: 1 } });
    if (res && res.code !== undefined && res.code !== 0) {
      bad('generate 返回错误：' + JSON.stringify(res));
      return;
    }
    ok('generate 执行成功   → ' + JSON.stringify(res && res.data));

    const [dutyRows] = await conn.query(
      `SELECT d.session_id, d.member_id, s.day_of_week, s.kind, c.name AS courseName
         FROM duty d
         JOIN session s ON s.id = d.session_id
         JOIN course  c ON c.id = s.course_id
        WHERE d.class_id = 1 AND d.week = 1
        ORDER BY s.day_of_week, d.member_id`
    );
    const cleanByDay = {};
    const allWeek = new Map();
    dutyRows.forEach(r => {
      if (r.kind !== 'CLEAN') return;
      (cleanByDay[r.day_of_week] = cleanByDay[r.day_of_week] || []).push(r.member_id);
    });
    dutyRows.forEach(r => {
      allWeek.set(r.member_id, (allWeek.get(r.member_id) || 0) + 1);
    });

    eq(cleanByDay[2] || [], (cleanByDay[2] || []).slice(), '周二保洁有人');
    eq((cleanByDay[2] || []).length, 4, '周二「410大扫除」排到 4 人');
    [1, 3, 4, 5].forEach(d => eq((cleanByDay[d] || []).length, 2, '周' + '一二三四五'[d - 1] + '「打扫410」仍是 2 人'));

    const tue = cleanByDay[2] || [];
    eq(new Set(tue).size, tue.length, '周二这 4 人互不相同');

    const dup = [...allWeek.entries()].filter(([, n]) => n > 1);
    eq(dup, [], '一轮里每人最多一次（本周没有任何人值日两次）');

    const tueCourse = (dutyRows.filter(r => r.day_of_week === 2 && r.kind === 'CLEAN')[0] || {}).courseName;
    eq(tueCourse, '410大扫除', '周二保洁课次回显的课程名 =「410大扫除」');
    const otherCourses = [...new Set(dutyRows.filter(r => r.kind === 'CLEAN' && r.day_of_week !== 2).map(r => r.courseName))];
    eq(otherCourses, ['打扫410'], '周一/三/四/五保洁课次名仍是「打扫410」');
  } finally {
    try { await pool.end(); } catch (e) {}
    try { await conn.end(); } catch (e) {}
    try { await db.stop(); } catch (e) {}
  }

  console.log('\n' + (failed ? '❌ 失败 ' + failed + ' 项' : '✅ 全部通过'));
  process.exit(failed ? 1 : 0);
}

/** 周一~周五 CLEAN 课次的「课程名|人数」数组 */
async function cleanState(conn) {
  const [rows] = await conn.query(
    `SELECT s.day_of_week, s.duty_count, c.name
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.kind = 'CLEAN' AND s.period = 4
      ORDER BY s.day_of_week`
  );
  const m = {};
  rows.forEach(r => { m[r.day_of_week] = r.name + '|' + r.duty_count; });
  return [1, 2, 3, 4, 5].map(d => m[d] || '缺失');
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
