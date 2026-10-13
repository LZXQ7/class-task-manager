-- =====================================================================
-- 清理「超管对自己发起换班」产生的孤儿数据（详见 .workbuddy/memory/DETAILS.md §26）
-- 背景：超管（示例成员01 id=13）在开发版手动排班把自己加进某条值日，又点了「申请换班」，
--       产生一条 PENDING_ADMIN 的孤儿 swap_request，同时 member_id=13 多了一条测试 duty。
--       这些脏数据写在共享 env+DB 里，连审核中/正式版都看得到（红点 / 待值日计数被污染）。
--
-- 用法：先跑【第一阶段】看清楚要删的 id，再跑【第二阶段】按实际 id 删除。
--       （本工具部署/清理需用 MCP，auth.json 修复后才能执行；也可直接复制到 CloudBase 控制台执行。）
-- =====================================================================

-- ============ 第一阶段：定位（只读，可反复执行） ============

-- 1) 超管名下的 swap_request（重点看 status='PENDING_ADMIN' 且 type='SWAP' 的孤儿）
SELECT id, duty_id, type, from_member, to_member, reason, status, created_at
FROM swap_request
WHERE from_member = 13 OR to_member = 13
ORDER BY id DESC;

-- 2) 超管当前的值日（找出「手动排班加进来」的那条：通常 source='MANUAL'）
SELECT id, member_id, session_id, week, class_date, status, source, created_at
FROM duty
WHERE member_id = 13
ORDER BY class_date, id;

-- 3) 超管当前的 duty_count（手动排班会 +1，清理时要回滚）
SELECT id, name, duty_count, last_duty_at FROM member WHERE id = 13;

-- ============ 第二阶段：清理（确认 id 后再执行） ============
-- 把下面 <SWAP_ID> 和 <DUTY_ID> 换成第一阶段查到的实际值。
-- 判定原则：
--   · <SWAP_ID> = 那条 status='PENDING_ADMIN' / type='SWAP' / from_member=13 的孤儿申请
--   · <DUTY_ID> = 那条 source='MANUAL' 且是测试时手动加进来的 duty（不要把轮换里正常分到的值日删了）
--   如果拿不准哪条是测试 duty，先不删 duty，只删孤儿 swap_request，红点与待确认 banner即消失；
--   待值日计数若仍异常，再单独处理该 duty。

-- 4) 删除孤儿 swap_request
DELETE FROM swap_request WHERE id = <SWAP_ID>;

-- 5) 删除测试 duty（谨慎：只删手动加的那条）
DELETE FROM duty WHERE id = <DUTY_ID>;

-- 6) 回滚 duty_count（+1 → -1，与 schedule.addManual 的 +1 对称）
UPDATE member SET duty_count = GREATEST(duty_count - 1, 0) WHERE id = 13;

-- 7) （可选）若还想保留「换班」结果、把这条 duty 直接给当时想换的那个人 <TO_MEMBER>：
--    UPDATE duty SET member_id = <TO_MEMBER>, source='MANUAL', status='PENDING', done_at=NULL WHERE id = <DUTY_ID>;
--    UPDATE member SET duty_count = duty_count + 1 WHERE id = <TO_MEMBER>;
--    然后跳过第 5、6 步，只执行第 4 步删孤儿申请。

-- ============ 复核 ============
-- 跑完后再执行第一阶段 1)、2)、3)，应看不到 PENDING_ADMIN 孤儿、duty 恢复为正常轮换值日、
-- duty_count 也已回滚。首页红点 / 待确认 banner / 「我的」页待值日计数应恢复正常。
