-- 2026-09-25：为 member 表增加 avatar_url 字段，用于存储微信头像
ALTER TABLE member ADD COLUMN avatar_url VARCHAR(512) DEFAULT NULL COMMENT '微信头像 URL（getUserProfile / chooseAvatar 获得）';
