-- ============================================================================
-- 迁移：每周二下午「打扫410」→「410大扫除」（人数 2 → 4）
-- 任务：lzxq-miniapp-duty-tue-20261013-0142
-- 适用范围：仅每周二下午的值日保洁课次（kind='CLEAN', day_of_week=2, period=4）
--          周一/三/四/五的「打扫410」保持 2 人、名称不变。
-- 设计：新增独立课程「410大扫除」(duty_count=4)，把周二 CLEAN 课次改指向它，
--       courseName 即可自动传播到所有展示端（值日页/明细/首页/一键生成预览/
--       导出长图/订阅提醒/Web 后台），无需在 N 个展示点散写字符串。
--       轮转游标（round_cursor_a/b、duty_week_cursor）完全不动 → 序号轮转保留。
-- 幂等：重复执行安全（INSERT 有 NOT EXISTS 守卫；UPDATE 命中条件不变则影响 0 行）。
-- 用法：对本机无法直连生产库（仅 VPC 内网 172.17.0.15:3306），请用
--       `tcb db execute -e <envId> -s "<SQL>"` 从本机对生产库执行本文件内容。
-- ============================================================================

-- 0) 备份受影响的 session 行（先备份，再动手）
CREATE TABLE IF NOT EXISTS bak_session_tue_clean_20261013 LIKE session;
INSERT INTO bak_session_tue_clean_20261013
SELECT s.* FROM session s
JOIN course c1 ON c1.id = s.course_id
WHERE s.kind = 'CLEAN' AND s.day_of_week = 2 AND s.period = 4 AND c1.name = '打扫410';

-- 1) 新增课程「410大扫除」(duty_count=4)
--    created_by 复用「打扫410」课程的创建人（必存在，规避生产库管理员 id 不确定）
INSERT INTO course (name, teacher, room, course_type, duty_count, created_by)
SELECT '410大扫除', NULL, '410', 'ALL', 4, c0.created_by
FROM course c0
WHERE c0.name = '打扫410'
  AND NOT EXISTS (SELECT 1 FROM course WHERE name = '410大扫除');

-- 2) 把周二下午的 CLEAN 课次改指向「410大扫除」，并设课次人数为 4
UPDATE session s
JOIN course c1 ON c1.id = s.course_id
JOIN course c2 ON c2.name = '410大扫除'
SET s.course_id = c2.id, s.duty_count = 4
WHERE s.kind = 'CLEAN' AND s.day_of_week = 2 AND s.period = 4 AND c1.name = '打扫410';

-- 3) 复核（应返回：周二 1 行，courseName=410大扫除，duty_count=4；其余天仍是打扫410/2）
SELECT s.day_of_week, c.name AS courseName, s.duty_count, s.kind
FROM session s
JOIN course c ON c.id = s.course_id
WHERE s.kind = 'CLEAN' AND s.period = 4 AND s.day_of_week BETWEEN 1 AND 5
ORDER BY s.day_of_week;
