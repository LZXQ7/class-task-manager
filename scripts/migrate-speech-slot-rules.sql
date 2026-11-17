-- 课前演讲「每场人数规则」（2026-11-17，v3）
-- ------------------------------------------------------------
-- 用户口径：「课前演讲设置规则，每周五下午的儿童文学只安排一个人课前演讲」。
--
-- 存储：speech_setting.slot_rules（TEXT，JSON 数组）
--       格式 `[{"sid":339,"need":1}]`，sid = session.id（课次），need 只有 1。
--       **2 人 = 默认，不落库** —— 规则表里只留「只排 1 人」的场次，
--       这样清空规则 = 全部回到每场 2 人，不需要额外的删除逻辑。
--
-- 为什么复用 speech_setting 而不新建表：
--   1. 它就是「课前演讲的设置」，一行一个班，天然是规则的容器；
--   2. v2 起 need_n / start_* 已作废（起点改为双游标），这张表正好空着；
--   3. 少一张表少一次事务与一份权限面。
--
-- ⚠️ 幂等：重复执行会报「Duplicate column」，可忽略（已上线过就别再跑）。
--    实际执行：node scripts/_sql.js "ALTER TABLE ..."（见发布记录）
ALTER TABLE speech_setting
  ADD COLUMN slot_rules TEXT NULL COMMENT '每场人数规则 JSON：[{"sid":339,"need":1}]，只存 need=1';
