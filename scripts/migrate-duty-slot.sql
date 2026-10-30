-- ============================================================
-- duty_slot：排班「岗位槽」模板（每班一组）
-- ------------------------------------------------------------
-- 背景（2026-10-27/28）：各班生活委员的值日制度不同 ——
--   有的班「每节课换一批人」，有的班「一人承包一整天」，
--   还有的班「某人固定周几」。原先算法把「按课程节次排」写死在
--   schedule 的生成主循环里，规则一改就得改代码。
--
-- 做法：把「要排哪些岗位」抽成一张表，让生活委员自己填。
--   系统只负责在每个槽上按序号轮转取人；槽位为空 = 完全走原逻辑。
--
-- 语义：
--   weekday   1-7，对应实际生效的星期（调休后用 resolveSlot 的 slot.day，
--             **不是** session.day_of_week —— 调休时后者不变，会排错天）
--   period    节次；NULL = 本槽承包全天（当天所有节次都归这一批人）
--   need_n    本槽要几个人（1 表示一人包岗）
--   fixed_seq 固定某人的学号序号（NULL = 参与轮转）；用 seq 而非 member_id，
--             因为轮转内核 pickBySeq 全部按 seq 工作
--   kind      NORMAL | CLEAN —— CLEAN 单独成槽，不消耗轮转游标
--   sort_order 生成时的遍历顺序，与 class_date/period 共同决定先后
--
-- 兼容性：本表为空时 generate 走原路径，现有班级零影响。
-- ============================================================

CREATE TABLE IF NOT EXISTS duty_slot (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  class_id    INT          NOT NULL,
  weekday     TINYINT      NOT NULL COMMENT '1-7，实际生效的星期（已考虑调休）',
  `period`    TINYINT      DEFAULT NULL COMMENT '节次；NULL=承包全天',
  need_n      TINYINT      NOT NULL DEFAULT 1 COMMENT '本槽人数',
  fixed_seq   SMALLINT     DEFAULT NULL COMMENT '固定某人的学号序号；NULL=轮转',
  kind        VARCHAR(16)  NOT NULL DEFAULT 'NORMAL' COMMENT 'NORMAL|CLEAN',
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_class_sort (class_id, sort_order, weekday, `period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='排班岗位槽模板';
