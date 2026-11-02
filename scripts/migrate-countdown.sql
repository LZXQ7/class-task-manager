-- 倒数日（2026-11-03）：个人自定义倒数事件，按 member 隔离
--
-- 设计要点：
--   · **不绑 class_id** —— 用户要求「每个人自己的、独立的」。倒数日属于人，不属于班；
--     绑了班级会导致换班（超管切班 / 成员转班）后自己写的倒数日凭空消失。
--   · 只存 member_id，所有读写一律带 `WHERE member_id = ?`，跨人越权在后端直接拦。
--   · target_date 用 DATE（不带时间）—— 倒数日按自然日算，存 datetime 会引入时区差一天。
--   · 已过期的倒数日不删除，由前端展示「已过 N 天」，用户可以自己删。
--
-- ⚠️ 本环境 TDSQL **不支持** `ADD COLUMN IF NOT EXISTS`（migrate-leave-apply 踩过），
--    建表同理不用 IF NOT EXISTS：执行前先用 SHOW TABLES LIKE '%countdown%' 探测。
--    本脚本可安全重跑（跑之前已探测过表不存在；重复执行会报 1050 table exists，不影响数据）。

CREATE TABLE countdown_event (
  id int unsigned NOT NULL AUTO_INCREMENT,
  member_id int unsigned NOT NULL,
  name varchar(30) NOT NULL,
  target_date date NOT NULL,
  created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cd_member (member_id, target_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
