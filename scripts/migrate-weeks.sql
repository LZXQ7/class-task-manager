-- ============================================================
-- 迁移：session 表新增 weeks 列（显式上课周次）
-- 适用：已执行过 init.sql 的旧库。新库直接用 init.sql 即可。
-- 说明：week_rule 仅作为 weeks 为空时的兜底；weeks 非空时优先。
-- ============================================================

-- 1. 新增列（幂等：列已存在时报错可忽略）
SET @exist := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'weeks');
SET @sql := IF(@exist = 0,
  'ALTER TABLE session ADD COLUMN weeks VARCHAR(64) DEFAULT \'\' COMMENT \'逗号分隔上课周次，空=每周都上\' AFTER week_rule',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. 旧 week_rule 数据迁移（仅迁移 weeks 仍为空的行，避免覆盖已设置值）
UPDATE session SET weeks = '' WHERE week_rule = 'ALL' AND (weeks IS NULL OR weeks = '');
UPDATE session SET weeks = '1,3,5,7,9,11,13,15' WHERE week_rule = 'ODD' AND (weeks IS NULL OR weeks = '');
UPDATE session SET weeks = '2,4,6,8,10,12,14,16' WHERE week_rule = 'EVEN' AND (weeks IS NULL OR weeks = '');

-- 3. 每节课默认值日人数统一为 2 人（与前端「新增课次」默认值一致）
ALTER TABLE `course`  ALTER COLUMN `duty_count` SET DEFAULT 2;
ALTER TABLE `session` ALTER COLUMN `duty_count` SET DEFAULT 2;
