-- =============================================================================
-- admin-web 网页管理后台：课表导入的常备备份表（DBA 侧一次性执行）
-- =============================================================================
-- 为什么需要（2026-10-10 真机 500 实踩）：
--   导入课表前要自动备份将被删除的课次/课程，最初实现是
--     CREATE TABLE bak_session_<时间戳> LIKE session;  -- 再 INSERT SELECT
--   但**应用数据库账号 classassist_app 只有 DML 权限（无 DDL）**，
--   CREATE TABLE 被 MySQL 直接拒掉：
--     ER_TABLEACCESS_DENIED_ERROR 1142
--     "CREATE command denied to user 'classassist_app'@'172.17.0.7' for table ..."
--   ⇒ /api/timetable/import 直接 500。
--   库里现有的 bak_* 表都是 root 手工建的，运行期账号自己建不出来。
--
-- 修法：预先建好两张**结构恒定**的常备表，运行期只做 DML
--      （DELETE WHERE batch_no=? + INSERT SELECT），不再需要任何 DDL。
-- 附带好处：备份按批次累积可查（原来按时间戳分表，导多了几十张没人查得动），
--          回滚只需换 batch_no，SQL 不用重写。
--
-- 执行方式（用 root / 控制台，**不要**用 classassist_app）：
--   tcb db execute -e <envId> -s "<本文件内容>"
-- 已执行时间：2026-10-10
-- =============================================================================

-- 课次备份表：只保留回滚必需的字段（不是 session 的整份副本）
-- ⚠️ group_scope 必须**可 NULL**（2026-10-12 清空课表 500 实踩）：
--   「清空全部」要备份全体课（session.group_scope IS NULL），NOT NULL 会直接
--   ER_BAD_NULL_ERROR 1048 "Column 'group_scope' cannot be null" ⇒ 接口 500。
--   导入（commitImport）永远只备份 A/B 组所以当初没暴露；NULL 行回滚时 INSERT
--   回 session 也会还原成 NULL（全体课），语义正确。
CREATE TABLE IF NOT EXISTS `bak_admin_session` (
  `batch_no`   varchar(20)  NOT NULL                COMMENT '导入批次号（YYYYMMDDHHMMSS），回滚就换这个值',
  `class_id`   int          NOT NULL                COMMENT '被覆盖的班级',
  `group_scope` enum('A','B')  NULL DEFAULT NULL    COMMENT '被覆盖的组别（NULL=全体课，2026-10-12 改）',
  `session_id` int          NOT NULL                COMMENT '原 session.id（回滚时按它删/还原）',
  `course_id`  int          NOT NULL                COMMENT '原关联课程 id',
  `kind`       enum('COURSE','CLEAN') NOT NULL     COMMENT '原课次类型',
  `week_rule`  enum('ALL','ODD','EVEN') DEFAULT 'ALL',
  `weeks`      varchar(64)  DEFAULT ''              COMMENT '原上课周次（逗号分隔）',
  `day_of_week` tinyint     NOT NULL                COMMENT '原星期（1=周一）',
  `period`     tinyint     NOT NULL                COMMENT '原节次',
  `duty_count` tinyint     DEFAULT '2'              COMMENT '原每节值日人数（回滚要还原）',
  `note`      varchar(64)  NOT NULL DEFAULT ''       COMMENT '原课表备注（调课原因/地点，回滚要还原）',
  KEY `idx_batch` (`batch_no`),
  KEY `idx_class_group` (`class_id`,`group_scope`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='admin-web 课表导入的课次备份（按批次累积，运行期只做 DML）';

-- ⚠️ 补列（2026-10-10 真机回滚时发现漏了 note）：
--   首版备份表没建 note 列，而 session.note 存的是「地点：xxx」「调课原因」这类
--   人工信息 —— 漏了它，回滚就会静默丢数据，且**当场看不出来**（note 默认空串，
--   一切正常，只有真去查才發現备注没了）。
--   已在生产执行过一次 ALTER；新建环境直接用上面的完整建表语句即可。
-- ALTER TABLE `bak_admin_session` ADD COLUMN `note` varchar(64) NOT NULL DEFAULT ''
--   COMMENT '原课表备注（调课原因/地点，回滚要还原）';

-- 课程备份表：删课次后 course 行可能变成孤儿，回滚时需要还原
CREATE TABLE IF NOT EXISTS `bak_admin_course` (
  `batch_no`  varchar(20) NOT NULL     COMMENT '导入批次号',
  `course_id` int         NOT NULL     COMMENT '原 course.id',
  `name`      varchar(64) NOT NULL     COMMENT '原课程名',
  `teacher`   varchar(32) DEFAULT ''   COMMENT '原教师',
  `room`      varchar(64) DEFAULT ''   COMMENT '原教室',
  KEY `idx_batch` (`batch_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='admin-web 课表导入的课程备份（按批次累积，运行期只做 DML）';

-- =============================================================================
-- 回滚 SQL 模板（把 <批次号> 换成导入返回的 backupBatch 值）
-- =============================================================================
-- 1) 查这次导入了什么
--    SELECT * FROM bak_admin_session WHERE batch_no = '<批次号>';
--
-- 2) 删掉本次写入的新课次（course_id 来自本批次的备份范围）
--    DELETE FROM session
--    WHERE class_id = ? AND kind = 'COURSE' AND group_scope = ?
--      AND id NOT IN (SELECT session_id FROM bak_admin_session WHERE batch_no = '<批次号>');
--
-- 3) 还原被删的旧课次（注意 duty_count / note 一并还原）
--    INSERT INTO session
--      (id, class_id, course_id, kind, week_rule, weeks, day_of_week, period,
--       group_scope, duty_count, note)
--    SELECT session_id, class_id, course_id, kind, week_rule, weeks,
--           day_of_week, period, group_scope, duty_count, note
--    FROM bak_admin_session WHERE batch_no = '<批次号>';
--
-- 4) 还原课程行
--    INSERT INTO course (id, name, teacher, room)
--    SELECT course_id, name, teacher, room
--    FROM bak_admin_course WHERE batch_no = '<批次号>';
--
-- ⚠️ 步骤 2/3 涉及主键 id，必须在同一事务里做，且先确认没有别的新课次
--    复用了旧 id（正常不会，id 是 AUTO_INCREMENT）。
-- =============================================================================
