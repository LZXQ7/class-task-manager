-- 作业提交与管理（2026-10-24）
-- ---------------------------------------------------------------
-- 三张表：
--   · homework        作业本体（谁发布 / 标题 / 说明 / 截止 / 需交分组 / 是否已清文件）
--   · homework_file   文件实体（班委附件 ATTACH 与学生提交 SUBMIT 共用，member_id=0 表示作业附件）
--   · homework_submit 提交记录（每人每作业唯一一条，覆盖式重交靠这条落地）
--
-- ⚠️ 容量约束：个人版云存储仅 **2GB**，所以
--    ① 文件一律由小程序端 **直传云存储**（不经云函数，绕开 256MB/60s）；
--    ② 云函数只落 fileID 字符串，不收二进制；
--    ③ `purged` 位标记「文件实体已清、记录与状态保留」，截止满 7 天由 cron 清理。
--
-- ⚠️ TDSQL 无 ADD COLUMN IF NOT EXISTS；建表统一 CREATE TABLE IF NOT EXISTS（幂等）。
-- ⚠️ 本迁移只建新表、不动任何存量表，可安全重复执行。
--
-- 执行顺序：只读探查 → 建表 → DESCRIBE 复核。
-- 复核：DESCRIBE homework; DESCRIBE homework_file; DESCRIBE homework_submit;

CREATE TABLE IF NOT EXISTS homework (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id     INT UNSIGNED NOT NULL DEFAULT 0,
  title        VARCHAR(64)  NOT NULL,
  brief        VARCHAR(500) NOT NULL DEFAULT '',
  -- 截止时间（精确到小时/分钟，2026-10-24 由 DATE 升为 DATETIME）
  due_date     DATETIME     NOT NULL,
  -- 需提交作业的分组，逗号分隔：'A' / 'B' / 'A,B'（多选）
  -- ⚠️ 不能叫 `groups`：MySQL 8.0 起 GROUPS 是**保留字**（窗口帧 ROWS/RANGE/GROUPS），
  --    TDSQL 兼容 MySQL 8 ⇒ 裸列名会直接语法报错。故取 target_groups。
  target_groups VARCHAR(16) NOT NULL DEFAULT 'A,B',
  -- 允许上传的图片 / 文件数量（班委设定，钳制在 1..9 / 1..3）
  max_images   TINYINT UNSIGNED NOT NULL DEFAULT 3,
  max_files    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- 要求提交材料类型（2026-10-24 新增）：NONE 不要求 / IMAGE 需图片 / FILE 需文件 / EITHER 图片或文件
  require_type ENUM('NONE','IMAGE','FILE','EITHER') NOT NULL DEFAULT 'NONE',
  publisher_id INT UNSIGNED NOT NULL DEFAULT 0,
  -- 文件实体是否已清理（清理后仅保留记录与状态）
  purged       TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_class_due (class_id, due_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS homework_file (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id     INT UNSIGNED NOT NULL DEFAULT 0,
  homework_id  INT UNSIGNED NOT NULL DEFAULT 0,
  -- 0 = 班委发布的作业附件；>0 = 该成员的提交文件
  member_id    INT UNSIGNED NOT NULL DEFAULT 0,
  kind         ENUM('ATTACH', 'SUBMIT') NOT NULL,
  file_id      VARCHAR(255) NOT NULL DEFAULT '',
  name         VARCHAR(255) NOT NULL DEFAULT '',
  mime         VARCHAR(64)  NOT NULL DEFAULT '',
  size         INT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_homework (homework_id),
  KEY idx_member (member_id),
  KEY idx_hw_kind (homework_id, kind)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE IF NOT EXISTS homework_submit (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id     INT UNSIGNED NOT NULL DEFAULT 0,
  homework_id INT UNSIGNED NOT NULL DEFAULT 0,
  member_id   INT UNSIGNED NOT NULL DEFAULT 0,
  -- PENDING 已交待批 / DONE 已完成 / REJECT 有问题已打回（打回后可覆盖重交）
  status       ENUM('PENDING', 'DONE', 'REJECT') NOT NULL DEFAULT 'PENDING',
  remark       VARCHAR(200) NOT NULL DEFAULT '',
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hw_member (homework_id, member_id),
  KEY idx_hw_status (homework_id, status)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
