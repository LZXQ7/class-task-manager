-- ============================================================
-- 迁移：临时调课（按周生效的课次覆盖）
--   node 之外直接用 MCP manageMysqlDatabase(runStatement) 执行本文件里的每条语句
--   （TDSQL 的 runStatement 一次只接受一条语句，已按单条拆分）
-- 幂等：CREATE TABLE IF NOT EXISTS，可重复执行。
-- ============================================================

CREATE TABLE IF NOT EXISTS session_shift (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  session_id    INT          NOT NULL COMMENT 'session.id',
  week          TINYINT      NOT NULL COMMENT '生效的那一周',
  kind          ENUM('OFF','MOVE') NOT NULL COMMENT 'OFF=本周不上；MOVE=换到 to_day/to_period',
  to_day        TINYINT      DEFAULT NULL COMMENT '1=周一 … 7=周日',
  to_period     TINYINT      DEFAULT NULL COMMENT '1-5',
  note          VARCHAR(64)  DEFAULT '' COMMENT '备注 / 来源标记（如 AI、按日期调课）',
  created_by    INT          DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shift (session_id, week),
  KEY idx_shift_week (week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
