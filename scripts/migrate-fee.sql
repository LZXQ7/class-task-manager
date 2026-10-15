-- 班费 / 团费（2026-10-14）
-- ---------------------------------------------------------------
-- 产品口径（与前端 util.POSITIONS / 首页权限一致）：
--   · 班费总额：超管 / 生活委员 可设置；团费总额：超管 / 班长兼团支书 可设置。
--   · 消费登记：班费 = 班长兼团支书 / 副班长 / 生活委员 / 超管；
--               团费 = 班长兼团支书 / 超管。
--   · 余额 = total - SUM(amount)，运行时计算，不落库（删记录即回退）。
--   · 消费图片走云存储，class_fund_record.images 存 fileID 数组（JSON）。
--
-- ⚠️ TDSQL 没有 ADD COLUMN IF NOT EXISTS，建表用 CREATE TABLE IF NOT EXISTS（幂等）。
-- ⚠️ 执行顺序：只读探查 → 备份 → 建表 → DESCRIBE 复核。
--
-- 1) 备份（改前必做，本迁移只建新表，无存量数据；首次执行可跳过备份）
-- 2) 逐条建表（IF NOT EXISTS 幂等，可重复执行）
-- 3) 复核：DESCRIBE class_fund; DESCRIBE class_fund_record;

CREATE TABLE IF NOT EXISTS class_fund (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id    INT UNSIGNED NOT NULL,
  type        ENUM('class', 'league') NOT NULL,
  total       DECIMAL(10, 2) NOT NULL DEFAULT 0,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_class_type (class_id, type)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS class_fund_record (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id      INT UNSIGNED NOT NULL,
  type          ENUM('class', 'league') NOT NULL,
  amount        DECIMAL(10, 2) NOT NULL,
  note          VARCHAR(200) NOT NULL DEFAULT '',
  images        JSON NULL,
  operator_id   INT UNSIGNED NOT NULL,
  operator_name VARCHAR(60) NOT NULL DEFAULT '',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_class_type_time (class_id, type, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 3) 复核
-- DESCRIBE class_fund;
-- DESCRIBE class_fund_record;
