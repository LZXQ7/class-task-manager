-- ============================================================
-- 迁移 v1.1：新增「每天第四节后打扫 410 教室」保洁课次
-- 适用：已部署 v1.0 的线上 CloudBase MySQL（init.sql 已执行过）
-- 说明：
--   1) session 表加 kind 列（COURSE=普通课次值日；CLEAN=值日保洁），
--      默认 'COURSE'，存量行全部不变。
--   2) course 表新增「打扫410」课程（教室 410，全体课，每课 2 人）。
--   3) session 表新增 周一~周五 第4节 共 5 条 kind=CLEAN 的保洁课次，
--      与课次值日【共用同一序号轮转】（member.duty_count 即轮转池）。
--   4) 保洁课次不进课程表页（课表 100% 本地化，本迁移只动 DB），
--      只在值日页 / 手动排班板显示。
-- 幂等：可重复执行；重复执行不会重复插入或报错。
-- 执行方式：用 CloudBase 控制台 / MCP 的 MySQL 执行入口逐条运行，
--           或直接 source 本文件（MySQL 客户端会话内）。
-- ============================================================

-- 1) session 加 kind 列（存量普通课次不受影响）----------------------
SET @db = DATABASE();
SELECT COUNT(*) INTO @has_kind
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'session' AND COLUMN_NAME = 'kind';
SET @sql_kind = IF(@has_kind = 0,
  "ALTER TABLE session ADD COLUMN kind ENUM('COURSE','CLEAN') NOT NULL DEFAULT 'COURSE' AFTER course_id",
  "SELECT 1");
PREPARE stmt_kind FROM @sql_kind;
EXECUTE stmt_kind;
DEALLOCATE PREPARE stmt_kind;

-- 2) 保洁课程（用 name 唯一标记做幂等判断）-------------------------
INSERT INTO course (name, teacher, room, course_type, duty_count, created_by)
SELECT '打扫410', NULL, '410', 'ALL', 2, 13
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM course WHERE name = '打扫410');

-- 3) 周一~周五 第4节 保洁课次（5 条，各自幂等）--------------------
INSERT INTO session (course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count, kind)
SELECT c.id, 'ALL', '', 1, 4, NULL, 2, 'CLEAN'
  FROM course c
  WHERE c.name = '打扫410'
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 1 AND s.period = 4 AND s.kind = 'CLEAN');

INSERT INTO session (course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count, kind)
SELECT c.id, 'ALL', '', 2, 4, NULL, 2, 'CLEAN'
  FROM course c
  WHERE c.name = '打扫410'
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 2 AND s.period = 4 AND s.kind = 'CLEAN');

INSERT INTO session (course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count, kind)
SELECT c.id, 'ALL', '', 3, 4, NULL, 2, 'CLEAN'
  FROM course c
  WHERE c.name = '打扫410'
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 3 AND s.period = 4 AND s.kind = 'CLEAN');

INSERT INTO session (course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count, kind)
SELECT c.id, 'ALL', '', 4, 4, NULL, 2, 'CLEAN'
  FROM course c
  WHERE c.name = '打扫410'
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 4 AND s.period = 4 AND s.kind = 'CLEAN');

INSERT INTO session (course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count, kind)
SELECT c.id, 'ALL', '', 5, 4, NULL, 2, 'CLEAN'
  FROM course c
  WHERE c.name = '打扫410'
    AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 5 AND s.period = 4 AND s.kind = 'CLEAN');

-- 校验：应输出 1 条 course + 5 条 CLEAN session
-- SELECT * FROM course WHERE name = '打扫410';
-- SELECT id, course_id, day_of_week, period, group_scope, duty_count, kind FROM session WHERE kind = 'CLEAN' ORDER BY day_of_week;
