-- 课前演讲排班（2026-11-16）
-- 每张表都带 class_id 做多班隔离；游标 / 发布 / 设置各自独立，与值日体系完全分开。
-- ⚠️ 本环境 TDSQL 不支持 ADD COLUMN IF NOT EXISTS，脚本假定已探测过表不存在。

-- 1. 演讲安排行：一场 = 一个时段（上午/下午），可 1~2 人
CREATE TABLE IF NOT EXISTS speech (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  class_id    INT          NOT NULL DEFAULT 1 COMMENT '所属班级',
  week        TINYINT      NOT NULL COMMENT '第几周',
  class_date  DATE         NOT NULL COMMENT '实际上课日期',
  slot        ENUM('AM','PM') NOT NULL COMMENT 'AM=上午第1节前 8:00-8:10；PM=下午第3节前 14:30-14:40',
  member_id   INT          NOT NULL COMMENT '演讲人 member.id',
  scope       ENUM('A','B','ALL') DEFAULT NULL COMMENT '绑定课次的 group_tag；ALL=全体课',
  source      ENUM('AUTO','MANUAL') NOT NULL DEFAULT 'AUTO' COMMENT 'AUTO=按序号生成；MANUAL=管理员换人',
  status      ENUM('PENDING','SWAPPED_OUT') NOT NULL DEFAULT 'PENDING',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_speech (class_id, week, class_date, slot, member_id),
  KEY idx_speech_week (class_id, week),
  KEY idx_speech_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 独立轮转游标（A/B 各自一条，到末尾回绕；与 class.round_cursor_* 值日游标隔离）
CREATE TABLE IF NOT EXISTS speech_cursor (
  class_id    INT          NOT NULL,
  grp         ENUM('A','B') NOT NULL,
  cursor_val  INT          NOT NULL DEFAULT 0 COMMENT '本组本轮已排到的学号序号',
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, grp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 发布状态（草稿→发布给全班→撤回），口径对齐 schedule_publish
CREATE TABLE IF NOT EXISTS speech_publish (
  class_id    INT          NOT NULL,
  week        TINYINT      NOT NULL,
  status      ENUM('DRAFT','PUBLISHED') NOT NULL DEFAULT 'DRAFT',
  published_by INT         DEFAULT NULL,
  published_at DATETIME    DEFAULT NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 班级级设置：每场人数 / 起始周几+时段 / 起始学号（起始项只在首次生成生效）
CREATE TABLE IF NOT EXISTS speech_setting (
  class_id       INT          NOT NULL,
  need_n         TINYINT      NOT NULL DEFAULT 2 COMMENT '每场人数：1 或 2',
  start_weekday  TINYINT      DEFAULT NULL COMMENT '起始周几（1=周一），首场落点；NULL=不设',
  start_slot     ENUM('AM','PM') DEFAULT 'AM' COMMENT '起始时段',
  start_seq      INT          DEFAULT NULL COMMENT '首次选人的最小学号序号下限；NULL=不设',
  init_done      TINYINT      NOT NULL DEFAULT 0 COMMENT '起始设置是否已消费（1=之后按游标续排不再回起点）',
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
