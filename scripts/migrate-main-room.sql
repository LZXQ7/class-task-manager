-- ============================================================
-- 迁移：新增「主教室」设置（class.main_room）
-- 适用：线上 CloudBase MySQL（init.sql 已执行过）
-- 需求口径：
--   每个班可设一个「主教室」（示例班级A = 410）。保洁值日按主教室走：
--   周一/三/四/五 = 打扫{主教室}（2 人）、周二 = {主教室}大扫除（4 人），18 点前。
--   房间号写进 CLEAN 课次名 + course.room；改主教室时由后台同步改名（见 mod-class/syncMainRoomCleaning）。
--
-- 本脚本只做**表结构**：给 class 加 main_room 列。不 bake 任何班级数据——
--   示例班级A 设 410 由后台「配置班级 → 主教室」输入框落值（触发同步，410 与现数据一致即 no-op）。
--
-- 为什么 main_room 可 NULL：没设主教室的班保持原状（保洁仍按既有课次名跑），不受影响。
-- 幂等：可重复执行；列已存在则跳过，不报错（TDSQL 无 ADD COLUMN IF NOT EXISTS，故用 information_schema 探）。
-- 执行方式：`tcb db execute -e <envId> -s "<SQL>"` 逐条运行，或 MySQL 客户端内 source 本文件。
-- ============================================================

-- 0) 执行前看一眼现状（只读，放心跑）--------------------------------
-- SELECT id, name FROM `class` ORDER BY id;
-- SHOW COLUMNS FROM `class` LIKE 'main_room';   -- 期望：空（本迁移就是要加它）

-- 1) 加 main_room 列（VARCHAR(32) 可空）-----------------------------
SET @db = DATABASE();
SELECT COUNT(*) INTO @has_main_room
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'class' AND COLUMN_NAME = 'main_room';
SET @sql_main_room = IF(@has_main_room = 0,
  "ALTER TABLE `class` ADD COLUMN main_room VARCHAR(32) NULL DEFAULT NULL AFTER period_time",
  "SELECT 1");
PREPARE stmt_main_room FROM @sql_main_room;
EXECUTE stmt_main_room;
DEALLOCATE PREPARE stmt_main_room;

-- ============================================================
-- 校验（执行后跑）
-- ============================================================
-- 列已在、可空：
-- SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
--   FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'class' AND COLUMN_NAME = 'main_room';
-- 期望：varchar / YES / NULL
--
-- 现有班默认都是 NULL（未设主教室）：
-- SELECT id, name, main_room FROM `class` ORDER BY id;
--
-- 回滚（仅当确需撤销；会丢已设的主教室值，慎用）：
-- SET @db = DATABASE();
-- SELECT COUNT(*) INTO @has FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA=@db AND TABLE_NAME='class' AND COLUMN_NAME='main_room';
-- SET @s = IF(@has>0, "ALTER TABLE `class` DROP COLUMN main_room", "SELECT 1");
-- PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
