-- 使用埋点（2026-10-16）
-- ---------------------------------------------------------------
-- 记录小程序端上报的「页面浏览 / 功能点击」事件（cloudfunctions/stat 的 track action）。
--   · openid    ：上报成员微信 openid（未归类场景留空串）
--   · class_id  ：成员所属班级（0 = 未归类 / 超管未绑定班）
--   · kind      ：page_view（看了哪个页面）/ action（用了哪个功能）
--   · event     ：功能/页面键（如 home / fee_open / notice_open），最长 64
--   · ref       ：可选子键（如 fee_open 的 class|league），最长 64
--   · ts        ：上报时间（东八区墙钟）
--
-- ⚠️ TDSQL 无 ADD COLUMN IF NOT EXISTS；建表用 CREATE TABLE IF NOT EXISTS 幂等。
-- ⚠️ 本迁移只建新表、不动任何存量表，可安全重复执行；新表无存量，首跑免备份。
--
-- 执行顺序：只读探查 → 建表 → DESCRIBE 复核。
-- 复核：DESCRIBE usage_event;

CREATE TABLE IF NOT EXISTS usage_event (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  openid    VARCHAR(64)  NOT NULL DEFAULT '',
  class_id  INT UNSIGNED NOT NULL DEFAULT 0,
  kind      ENUM('page_view', 'action') NOT NULL,
  event     VARCHAR(64)  NOT NULL,
  ref       VARCHAR(64)  NOT NULL DEFAULT '',
  ts        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_class_ts   (class_id, ts),
  KEY idx_event      (event),
  KEY idx_kind_event (kind, event)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 复核
-- DESCRIBE usage_event;
