-- ============================================================
-- 教职工一次性绑定码迁移（2026-09-26）
-- 库：CloudBase 云开发 MySQL
-- 背景：辅导员 / 老师没有班级、没有学号，原有绑定链路（口令 → 名单选人 → 学号后 4 位）
--       三重都不适用：
--         ① 名单里根本没有他的条目（现有辅导员 示例成员57 的占位学号 000000000090
--            以 0000000000 开头，被 member 云函数的 NOT_TEST 前缀过滤掉）；
--         ② 从名字选人也对不上（教职工不在 A/B 分组）；
--         ③ 没有学号 → 后 4 位无从验证。
--       所以给教职工一条独立入口：管理员现场发一个**一次性绑定码**，
--       本人在绑定页输入即完成绑定（不校验学号、不走名单、不受名单过滤影响）。
-- 原则：纯 ADD COLUMN，不改任何既有列 / 数据；回滚只需 DROP COLUMN。
-- ============================================================

-- ⚠️ TDSQL **不支持** `ALTER TABLE … ADD COLUMN IF NOT EXISTS`（会报 1064 语法错）。
--    所以这里是普通 ALTER —— 重跑前先用下面的自检确认列不存在，否则会报 1060 Duplicate column。
--    2026-09-26 已在本环境执行完毕并核对通过。
ALTER TABLE member ADD COLUMN staff_code        VARCHAR(16) DEFAULT NULL COMMENT '教职工一次性绑定码；绑定成功后清 NULL';
ALTER TABLE member ADD COLUMN staff_code_expire DATETIME    DEFAULT NULL COMMENT '绑定码过期时间；过期即失效（码本身仍留着，便于「重发」时覆盖）';

-- 2. 绑定码查询索引（bindStaff 按 code 精确定位；码全局唯一，允许 NULL）
ALTER TABLE member ADD INDEX idx_staff_code (staff_code);

-- ============================================================
-- 3. 自检
-- ============================================================
SELECT 'member 是否有 staff_code 列' AS metric,
       SUM(COLUMN_NAME = 'staff_code') AS v1,
       SUM(COLUMN_NAME = 'staff_code_expire') AS v2
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = 'member';

SELECT '现有教职工（X 组）' AS metric, COUNT(*) AS v FROM member WHERE group_tag = 'X';
SELECT '教职工里已绑定的'     AS metric, COUNT(*) AS v FROM member WHERE group_tag = 'X' AND openid IS NOT NULL;
SELECT '持有可绑定码的教职工' AS metric, COUNT(*) AS v FROM member WHERE group_tag = 'X' AND staff_code IS NOT NULL AND openid IS NULL;
