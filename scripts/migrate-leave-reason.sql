-- ============================================================================
-- scripts/migrate-leave-reason.sql
-- 请假事由（2026-11-03 需求③：公假 / 病假 / 事假 / 其他；「其他」可手填说明）
--
-- 🔴 背景：adjust.leaveApply 的 INSERT 早已写入 `reason` 列，但生产库
--    `leave_request` **并没有这一列**（DESCRIBE 17 列无 reason）——
--    一旦成员提交申请就 1054 Unknown column，属线上必崩。本脚本补齐。
--
-- ⚠️ 本环境 TDSQL 不支持 `ADD COLUMN IF NOT EXISTS`（1064 语法错），故用普通 ADD COLUMN；
--    重复执行会报 1060 Duplicate column，属预期的幂等信号，不是失败。
-- ⚠️ 用 VARCHAR 而非 ENUM：以后再加事由分类不必 ALTER 改枚举（swap_request 的
--    reason 是 ENUM('COURSE','SICK','INTERN','OTHER')，那是换班用的，与请假无关，勿混用）。
-- ============================================================================

ALTER TABLE leave_request ADD COLUMN reason VARCHAR(16) NULL DEFAULT 'OTHER' AFTER periods;
ALTER TABLE leave_request ADD COLUMN reason_note VARCHAR(64) NULL DEFAULT NULL AFTER reason;
