-- ============================================================
-- 一次性数据修复：值日轮转「跨周不接续」（2026-09-26）
-- ------------------------------------------------------------
-- 修复前的线上真实状态（查库逐条核对）：
--   · member.duty_count（= 本轮已排次数标记）
--       01~16 = 1   ← 21:40 那次误生成留下的（本周第 4 周的 16 行就是这批人）
--       17~24 = 0   ← 第 1/2 周被「清空本周」时，旧版 clear 把全班标记清零，
--                     这两批人的 duty 行也一并删了，标记无法从行数反推
--       25~48 = 1   ← 第 3 周真实排出来的（用户原话「A 组排到 47 号，B 组排到 48 号」）
--       49~56 = 0
--   · duty: week=3 共 24 行（seq 25~48，已发布，正确）；week=4 共 16 行（seq 01~16，误生成）
--   · duty_log: id 415~430（2026-09-26 21:40:02，恰 16 条 CREATE）就是那次误生成
--
-- 为什么「01~48 都算本轮已排」是**推出来的**而不是猜的：
--   第 3 周由 rotationPick 生成，它取「标记最小档 + 序号升序」。若 01~24 当时标记为 0，
--   它们必然排在最前面；实际上第 3 周排出的是 25~48 —— 说明生成第 3 周时 01~24 的标记
--   已经 > 0。所以「01~48 已排、49 起接续」是唯一自洽的解读。
-- ============================================================

-- ① 删掉误生成产生的值日行对应的操作日志（先删子表）
DELETE FROM duty_log
 WHERE duty_id IN (SELECT id FROM duty WHERE class_id = 1 AND week = 4 AND source = 'AUTO');

-- ② 删掉第 4 周那 16 行误生成的 AUTO 值日
DELETE FROM duty WHERE class_id = 1 AND week = 4 AND source = 'AUTO';

-- ③ 把本轮标记修正为「01~48 已排、49~56 未排」
--    （这也是新代码 repairRoundMarks 会自愈出的结果，这里显式写死让状态立即可预期）
UPDATE member SET duty_count = 1
 WHERE class_id = 1 AND status = 'ACTIVE' AND group_tag <> 'X'
   AND CAST(RIGHT(student_no, 2) AS UNSIGNED) BETWEEN 1 AND 48;

UPDATE member SET duty_count = 0
 WHERE class_id = 1 AND status = 'ACTIVE' AND group_tag <> 'X'
   AND CAST(RIGHT(student_no, 2) AS UNSIGNED) > 48;

-- ④ 核对：01~48 应为 1、49~56 应为 0；第 4 周应为 0 行
-- SELECT CAST(RIGHT(student_no,2) AS UNSIGNED) AS seq, duty_count FROM member
--  WHERE class_id=1 AND status='ACTIVE' AND group_tag<>'X' ORDER BY seq;
-- SELECT week, COUNT(*) FROM duty WHERE class_id=1 GROUP BY week;
