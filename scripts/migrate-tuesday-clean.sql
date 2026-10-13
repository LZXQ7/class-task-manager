-- ============================================================
-- 迁移：每周二下午「全校大扫除」—— 410 教室，人数 2 → 4，名称「打扫410」→「410大扫除」
-- 适用：已执行过 scripts/migrate-cleaning.sql 的线上 CloudBase MySQL
-- 需求口径（学校通知）：
--   每周二下午是全校大扫除，地点 410 教室。
--   ① 周二下午这一条保洁课次的人数改为 4 人（周一/三/四/五仍 2 人，保持不变）。
--   ② 周二下午这一条的对外名称改为「410大扫除」（周一/三/四/五仍「打扫410」）。
--   ③ 仍然「按序号轮转」：这 4 个人从同一个轮转池里按序号顺延取号，
--      一轮里每人最多一次（不会和同周其它天的值日重复选到同一人）。
--      轮转算法与游标语义**一行代码都不改**，本迁移只改数据。
--
-- 为什么用「新建 course + 改 session 指向」而不是直接改 course 名：
--   5 条 CLEAN 课次（周一~周五）原本共用同一条 course（name='打扫410'）。
--   若直接 UPDATE course SET name='410大扫除'，周一/三/四/五也会跟着改名，
--   违反「只动周二这一条」的边界。所以单独建一条 course 行，
--   再把周二那条 session 的 course_id 指过去。
--
-- 幂等：可重复执行；重复执行不会重复插入、不会把 4 改回 2、也不会报错。
-- 执行方式：CloudBase 控制台 / `tcb db execute -e <envId> -s "<SQL>"` 逐条运行，
--           或 MySQL 客户端内 source 本文件。
-- ⚠️ 本脚本只改数据，不改表结构、不改代码，也不需要重新部署云函数
--    （周二人数读 session.duty_count、名称读 course.name，都是运行时读库）。
-- ============================================================

-- 0) 执行前先看看现状（只读，放心跑）--------------------------------
-- SELECT s.id, s.class_id, s.day_of_week, s.period, s.duty_count, s.kind,
--        c.id AS course_id, c.name AS course_name, c.room
--   FROM session s JOIN course c ON c.id = s.course_id
--  WHERE s.kind = 'CLEAN'
--  ORDER BY s.class_id, s.day_of_week;
-- 期望：周一/三/四/五 = 打扫410 + duty_count 2；周二当前也是 打扫410 + 2（本脚本把它改成 410大扫除 + 4）。

-- 1) 新建课程「410大扫除」（教室 410、全体课、每课 4 人）--------------
--    created_by 取库里真实的超级管理员；取不到时兜底 13（与 init.sql 种子一致）。
SET @owner_id = (SELECT COALESCE(
  (SELECT id FROM member WHERE is_super = 1 ORDER BY id LIMIT 1), 13));

INSERT INTO course (name, teacher, room, course_type, duty_count, created_by)
SELECT '410大扫除', NULL, '410', 'ALL', 4, @owner_id
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM course WHERE name = '410大扫除');

-- 2) 把「周二第 4 节」这条 CLEAN 课次改挂到「410大扫除」，人数改 4 ------
--    只命中 kind='CLEAN' AND day_of_week=2 AND period=4 且当前指向「打扫410」的行，
--    周一/三/四/五与其它普通课次一条都不碰。
UPDATE session s
  JOIN course c_from ON c_from.id = s.course_id
  JOIN course c_to   ON c_to.name = '410大扫除'
   SET s.course_id  = c_to.id,
       s.duty_count = 4
 WHERE s.kind = 'CLEAN'
   AND s.day_of_week = 2
   AND s.period = 4
   AND c_from.name = '打扫410';

-- 3) 兜底：万一某班的周二 CLEAN 课次已经是「410大扫除」但人数还是 2 ----
--    （例如手工改过 course_id），这里把人数补齐成 4，不改课程指向。
UPDATE session s
  JOIN course c ON c.id = s.course_id
   SET s.duty_count = 4
 WHERE s.kind = 'CLEAN'
   AND s.day_of_week = 2
   AND s.period = 4
   AND c.name = '410大扫除'
   AND s.duty_count <> 4;

-- 4) 课程行自身的 duty_count 也对齐 4（新建课次时的默认值）------------
UPDATE course SET duty_count = 4 WHERE name = '410大扫除' AND duty_count <> 4;

-- ============================================================
-- 校验（执行后跑，应看到：周二 = 410大扫除 + 4，其余四天 = 打扫410 + 2）
-- ============================================================
-- SELECT s.id, s.class_id, s.day_of_week, s.period, s.duty_count, s.kind,
--        c.name AS course_name, c.room
--   FROM session s JOIN course c ON c.id = s.course_id
--  WHERE s.kind = 'CLEAN'
--  ORDER BY s.class_id, s.day_of_week;
--
-- 行数校验：应只有 1 条 day_of_week=2 的 CLEAN 课次指向「410大扫除」且 duty_count=4
-- SELECT COUNT(*) AS tue_ok
--   FROM session s JOIN course c ON c.id = s.course_id
--  WHERE s.kind='CLEAN' AND s.day_of_week=2 AND s.period=4
--    AND c.name='410大扫除' AND s.duty_count=4;
--
-- 反向校验：周一/三/四/五必须仍是「打扫410」+ 2 人（应为 0 行）
-- SELECT s.id, s.day_of_week, s.duty_count, c.name
--   FROM session s JOIN course c ON c.id = s.course_id
--  WHERE s.kind='CLEAN' AND s.day_of_week IN (1,3,4,5)
--    AND (c.name <> '打扫410' OR s.duty_count <> 2);

-- ============================================================
-- 回滚（仅当确需撤销时执行；周二回到「打扫410」+ 2 人）
-- ============================================================
-- UPDATE session s
--   JOIN course c_from ON c_from.id = s.course_id
--   JOIN course c_to   ON c_to.name = '打扫410'
--    SET s.course_id  = c_to.id,
--        s.duty_count = 2
--  WHERE s.kind = 'CLEAN'
--    AND s.day_of_week = 2
--    AND s.period = 4
--    AND c_from.name = '410大扫除';
-- DELETE FROM course WHERE name = '410大扫除';
