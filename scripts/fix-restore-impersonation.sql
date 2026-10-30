-- 恢复演示身份映射：示例成员01(openid) → 赵子涵(演示班 104)
-- 该映射是「切换体验版 / 切换测试账号」的生效依据（guard.getContext 按 impersonation 解析生效身份）；
-- 缺失时后端看不到演示身份，class.list 会回退到真实超管视图、把真实班级塞进课表切班条，
-- 且 resolveClassId / isDemoMember 全线隔离失效。
-- 与 auth/switchDemo 的写入口径逐字一致（auth/index.js:639 同一条 INSERT … ON DUPLICATE KEY UPDATE）。
INSERT INTO impersonation (openid, member_id)
VALUES ('oVAAy5GI1lQLlvNIFtVs6CBEzQM4', 250)
ON DUPLICATE KEY UPDATE member_id = 250;
