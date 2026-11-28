-- 临时调课权·后台单独授予（2026-11-28 用户要求）
-- ---------------------------------------------------------------------------
-- 口径：与 member.speech_perm / fee_perms 同一套「只额外授予」语义 ——
--       勾上 = 这个人能在小程序课表页看到「临时调课」入口并落库调课；
--       不勾也不会撤销既有权限（超管 / 班委本就有调课权）。
-- 判定真源：cloudfunctions/common/guard.js 的 hasShiftPerm / canShift /
--           requireShiftAuth；前端入口由 auth.login 下发的 profile.canShift 控制
--           ⇒ 后台改完权限，用户重新进小程序即生效，无需发版/审核。
-- 后台入口：admin-web 成员编辑弹层「单独授予权限（临时调课）」。
--
-- ⚠️ 本环境 TDSQL **不支持** `ADD COLUMN IF NOT EXISTS`，重复执行会报 1060。
--    执行前先探测：SHOW COLUMNS FROM member LIKE 'shift_perm';
--    有结果 = 已加过，跳过本脚本。
-- ---------------------------------------------------------------------------
ALTER TABLE member
  ADD COLUMN shift_perm TINYINT NOT NULL DEFAULT 0 COMMENT '后台单独授予的临时调课权 1=有';
