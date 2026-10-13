-- 网页管理后台上线前只读探查（2026-10-10）
-- 目的：动生产库之前先看清现状，确认 (1) 三张新表已落库 (2) admin_user 为空 (3) 真超管是谁
SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('admin_user','admin_session','admin_audit_log','bak_admin_user') ORDER BY TABLE_NAME;
SELECT id, username, member_id, status, fail_count, locked_until, last_login_at FROM admin_user ORDER BY id;
SELECT COUNT(*) AS session_rows FROM admin_session;
SELECT COUNT(*) AS audit_rows FROM admin_audit_log;
-- 真超管候选：is_super=1 且 status=ACTIVE 且不是测试账号（99 段学号）
SELECT id, name, student_no, class_id, role, position FROM member WHERE is_super = 1 AND status = 'ACTIVE' AND student_no NOT LIKE '0000000000%' ORDER BY id;
-- 测试超管（应被后台登录拒绝，仅供核对）
SELECT id, name, student_no FROM member WHERE is_super = 1 AND student_no LIKE '0000000000%' ORDER BY id;