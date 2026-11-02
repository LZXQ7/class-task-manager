-- ============================================================
-- 请假申请审批 + 多时段（2026-11-02）
-- 库：CloudBase 云开发 MySQL
-- 改动：leave_request 加 periods（权威时段集合）/ source / applied_by /
--       approved_by / approved_at，并存量回填 periods。
-- 用法：bash scripts/run_sql_file.sh scripts/migrate-leave-apply.sql
-- ⚠️ run_sql_file.sh 按 `;` 拆句逐条执行；本脚本语句彼此独立，失败的会被标记 [FAIL] 但不阻断其余。
-- ============================================================

-- 1) 加列
-- ⚠️ 本环境 TDSQL 不支持 `ADD COLUMN IF NOT EXISTS`（报 1064），统一用普通 ADD COLUMN。
--    本脚本为一次性迁移，运行前确认 leave_request 尚无 periods/source/applied_by/approved_by/approved_at 五列。
ALTER TABLE leave_request ADD COLUMN periods VARCHAR(64) NULL DEFAULT NULL AFTER end_time;
ALTER TABLE leave_request ADD COLUMN source ENUM('register','apply') NOT NULL DEFAULT 'register' AFTER periods;
ALTER TABLE leave_request ADD COLUMN applied_by INT NULL DEFAULT NULL AFTER source;
ALTER TABLE leave_request ADD COLUMN approved_by INT NULL DEFAULT NULL AFTER applied_by;
ALTER TABLE leave_request ADD COLUMN approved_at DATETIME NULL DEFAULT NULL AFTER approved_by;

-- 2) 存量回填：旧单时段记录按 start_time/end_time 反推 periods
--    · 两列空（整天）        → ''（空串 = 全天，与新增记录同口径）
--    · 命中 am/pm/eve 档      → 对应单 key
--    · 其余手工钟点（未命中）→ periods 保持 NULL，后端按 start/end 兜底（绝不谎报成半天）
--    时段口径（唯一真源）：am 08:00–12:00 / pm 13:00–18:00 / eve 18:00–21:00
UPDATE leave_request SET periods = '' WHERE start_time IS NULL AND end_time IS NULL;
UPDATE leave_request SET periods = 'am' WHERE start_time = '08:00:00' AND end_time = '12:00:00';
UPDATE leave_request SET periods = 'pm' WHERE start_time = '13:00:00' AND end_time = '18:00:00';
UPDATE leave_request SET periods = 'eve' WHERE start_time = '18:00:00' AND end_time = '21:00:00';

-- 3) 复核
-- DESCRIBE leave_request;
-- SELECT id, start_date, end_date, start_time, end_time, periods, source FROM leave_request ORDER BY id DESC LIMIT 20;
