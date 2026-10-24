-- 作业模块 · 增量迁移（2026-10-24 发布作业增强）
-- ---------------------------------------------------------------
-- 仅对**已存在**的 production 库执行一次；新建库请走 migrate-homework.sql 的
-- CREATE TABLE（已含 require_type 与 DATETIME 版 due_date），无需本文件。
--
-- 执行（沙箱外，需 bypass 网络/凭据）：
--   tcb db execute -e <env> -s "$(cat scripts/migrate-homework-alter.sql)"
--
-- ⚠️ 本文件**不可重复安全执行**：
--   · ALTER ... MODIFY due_date 可重复（幂等）。
--   · ALTER ... ADD COLUMN require_type 在已含该列时会报错，故仅首次执行。
--   若需重跑，先把 require_type 列 DROP 再执行，或仅保留 MODIFY 段。

-- 1) due_date: DATE -> DATETIME（截止精确到小时/分钟）
ALTER TABLE homework MODIFY due_date DATETIME NOT NULL;

-- 历史 DATE 值被 MySQL 自动补成 00:00:00，会“刚迁移就显示已截止”，
-- 故把当时为 00:00:00 的行推到当天 23:59:00。
UPDATE homework
   SET due_date = DATE_ADD(due_date, INTERVAL (23 * 60 + 59) MINUTE)
 WHERE due_date IS NOT NULL
   AND HOUR(due_date) = 0 AND MINUTE(due_date) = 0 AND SECOND(due_date) = 0;

-- 2) require_type: 要求提交材料类型（NONE/IMAGE/FILE/EITHER）
ALTER TABLE homework ADD COLUMN require_type ENUM('NONE','IMAGE','FILE','EITHER') NOT NULL DEFAULT 'NONE' AFTER max_files;
