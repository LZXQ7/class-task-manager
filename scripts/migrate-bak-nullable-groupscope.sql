-- =============================================================================
-- 修复：清空课表（ALL）500 —— bak_admin_session.group_scope 不可为 NULL
-- =============================================================================
-- ✅ 状态：已于 2026-10-12 13:42 经 `tcb db execute` 在生产执行完毕，
--    复核 information_schema 确认 IS_NULLABLE='YES'。**留档勿重跑**。
--
-- 现象（2026-10-12 真机）：后台「清空课表」选「全部（含全体课）」点确认 →
--   服务内部错误 500；dry-run 预览正常、数据原封未动（备份失败发生在事务之前）。
--
-- 根因（本地真 MySQL 已复现 ER_BAD_NULL_ERROR 1048，并验证修复有效）：
--   bak_admin_session.group_scope 建表时是 enum('A','B') NOT NULL，
--   而「清空全部」要备份**全体课**（session.group_scope IS NULL），
--   严格模式下 INSERT NULL 直接报：
--     ER_BAD_NULL_ERROR 1048 "Column 'group_scope' cannot be null"
--   导入（commitImport）永远只备份 A/B 组，所以 2026-10-10 以来没暴露；
--   mock DB 的 e2e 不校验列约束，所以本地门禁/e2e 全绿照样翻车。
--   同一个坑也会砸中「删课次」删除全体课的场景（deleteSession 同一份备份 SQL）。
--
-- 修法：group_scope 改为可 NULL（备份 NULL 行，回滚时 INSERT 回 session
--   仍还原为 NULL = 全体课，语义正确）。**这是 DDL，应用账号 classassist_app
--   无 DDL 权限，必须用 root / 特权账号执行**：
--     tcb db execute -e <YOUR_ENV_ID> -s "<下面这条 ALTER>"
--   （或控制台 SQL 窗口直接跑）
-- =============================================================================

ALTER TABLE `bak_admin_session`
  MODIFY COLUMN `group_scope` enum('A','B') NULL DEFAULT NULL
  COMMENT '被覆盖的组别（NULL=全体课，2026-10-12 改，修复清空课表 500）';

-- 执行后自检（应返回 group_scope 列 is_nullable='YES'）：
--   SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bak_admin_session'
--     AND COLUMN_NAME = 'group_scope';

-- 自检通过后，回后台重试「清空课表 → 全部」即可（本次 500 未删任何数据）。
