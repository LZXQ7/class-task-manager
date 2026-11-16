-- 课前演讲排班权·后台单独授予（2026-11-17 用户要求）
-- ---------------------------------------------------------------------------
-- 口径：与 member.fee_perms（班费消费登记权）同一套「只额外授予」语义 ——
--       勾上 = 这个人能排课前演讲；不勾也不会撤销职位自带权限
--       （学习委员 / 生活委员 / 超管本来就能排）。
-- 判定真源：cloudfunctions/common/guard.js 的 hasSpeechPerm / canSpeech。
-- 后台入口：admin-web 成员编辑弹层「单独授予权限（课前演讲）」。
--
-- ⚠️ 本环境 TDSQL **不支持** `ADD COLUMN IF NOT EXISTS`，重复执行会报 1060。
--    执行前先探测：SHOW COLUMNS FROM member LIKE 'speech_perm';
--    有结果 = 已加过，跳过本脚本。
-- ---------------------------------------------------------------------------
ALTER TABLE member
  ADD COLUMN speech_perm TINYINT NOT NULL DEFAULT 0 COMMENT '后台单独授予的课前演讲排班权 1=有';
