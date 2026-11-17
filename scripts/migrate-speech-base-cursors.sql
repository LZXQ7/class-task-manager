-- =============================================================
-- 课前演讲 v3：游标「生成即推进」（2026-11-17）
-- -------------------------------------------------------------
-- 背景：旧实现只在「发布」时把游标落到 speech_cursor，连排两周草稿时
--       两周都从同一个起点起跑，排出逐条相同的人（用户：十一周安排过的，十二周又安排了）。
-- 改动：生成/智能排班落库时立即推进 speech_cursor，并把「本周生成之前的游标」
--       记进 speech_publish.base_cursors（供同周重排幂等、清空/撤回回滚）。
--
-- 执行：node scripts/_sql.js "$(cat scripts/migrate-speech-base-cursors.sql)"
--       或在控制台逐条执行。可重复执行（列已存在会报 1060，忽略即可）。
-- =============================================================
ALTER TABLE speech_publish
  ADD COLUMN base_cursors VARCHAR(128) DEFAULT NULL COMMENT 'cursors before this week generate';
