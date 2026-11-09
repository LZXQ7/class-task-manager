-- 班费「额外授予」权限位（2026-11-08）
--
-- 用户口径：后台成员列表可单独给成员加「登记班费消费 / 登记团费消费」，
--           只额外授予，不撤销职位自带权限；「设置总额」仍按职位，不单独授予。
-- 格式：逗号分隔的 key 白名单（class,league），真源 cloudfunctions/common/fee-perms.js。
--
-- ⚠️ 本环境 TDSQL 不支持 ADD COLUMN IF NOT EXISTS（1064 语法错，见 1.0.8.20 迁移踩坑）。
--    执行前**必须**先探测列不存在：
--      SHOW COLUMNS FROM member LIKE 'fee_perms';
--    有结果就跳过本脚本，不要重复执行（NOT NULL DEFAULT '' 对存量行自动填 ''）。

ALTER TABLE member
  ADD COLUMN fee_perms VARCHAR(128) NOT NULL DEFAULT ''
  COMMENT '额外授予的班费消费登记权限，逗号分隔 class,league；不含设置总额';
