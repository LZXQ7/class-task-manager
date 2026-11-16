-- 课前演讲排班 v2（2026-11-17）：发布才落游标 + 撤回回滚 + 双游标起点
-- ⚠️ TDSQL 不支持 ADD COLUMN IF NOT EXISTS，逐条执行；执行前先 SHOW COLUMNS 探测。

-- 1a. speech_publish 增「待落游标」：generate 只预演，把本次预演后的 A/B 游标暂存这里，
--     发布时才写进 speech_cursor。JSON 形如 {"A":31,"B":28}。
ALTER TABLE speech_publish
  ADD COLUMN pending_cursors VARCHAR(128) DEFAULT NULL COMMENT 'generate 预演后待发布的 A/B 游标 JSON'
  AFTER published_at;

-- 1b. speech_publish 增「发布前游标快照」：发布时把当前 speech_cursor 存这里，撤回时回滚。
ALTER TABLE speech_publish
  ADD COLUMN cursor_snapshot VARCHAR(128) DEFAULT NULL COMMENT '发布前的 A/B 游标 JSON，撤回时回滚'
  AFTER pending_cursors;

-- 2. speech_setting 语义变更（列保留兼容，代码不再读写 need_n/start_*）：
--    起点改为直接设置 speech_cursor 的 A/B 两行。无需改表结构。
--    旧 start_weekday/start_slot/start_seq/init_done 列留存但弃用（避免 DROP 破坏历史库）。

-- 3. cursor_snapshot 写入示例（发布时由云函数完成，仅示意）：
--    UPDATE speech_publish SET cursor_snapshot = '{"A":31,"B":28}', status='PUBLISHED' ...
