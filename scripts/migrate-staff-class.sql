-- 迁移 v0.7.16：教职工 ↔ 班级 多对多绑定
-- ============================================================
-- 背景（用户需求①）：教职工账号不再从属于单一班级 ——
--   在班级管理页由超管统一「添加 / 解绑教职工账号」，并把班级**多选**绑给某位教职工；
--   每位教职工只能看到自己管理的班级。
--
-- 数据模型：
--   staff_class (staff_id, class_id)  主键 (staff_id, class_id)
--   · staff_id = member.id（group_tag='X' 的教职工账号）
--   · 有映射行     → 该教职工可见/可操作这些班级
--   · 无映射行     → 回退 member.class_id 主班（存量单班教职工兼容，如 id=72）
--   · 都没有       → 空集（什么都看不到，前端引导找超管绑定）
--
-- 写入方：member.staffBindClasses（全量覆写）/ member.addStaff（建号时可选绑定）
-- 读取方：guard.staffClassIds(pool, member) / guard.resolveClassId(pool, ctx, payload)
--         ↓ 被 schedule.listWeek（值日班级筛选）/ class.list（班级管理列表）/
--           member.targetClassId（跨班管理收口）/ media.msgPublish（通知目标班）共用
--
-- ⚠️ TDSQL 不支持部分 `IF NOT EXISTS` 语法族（ADD COLUMN 报 1064）；
--    重复执行本文件会报 1050「Table already exists」，属预期、可忽略。

CREATE TABLE staff_class (
  staff_id   INT      NOT NULL COMMENT 'member.id，group_tag=X 的教职工账号',
  class_id   INT      NOT NULL COMMENT '班级 id（class.id）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '绑定时间',
  PRIMARY KEY (staff_id, class_id),
  KEY idx_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='教职工与班级的多对多绑定（v0.7.16）';

-- 存量兼容：把现有 X 组成员的主班回填进映射（等价于原单班语义，之后超管可自由改绑）
-- INSERT IGNORE INTO staff_class (staff_id, class_id)
--   SELECT id, class_id FROM member WHERE group_tag = 'X' AND class_id > 0;
