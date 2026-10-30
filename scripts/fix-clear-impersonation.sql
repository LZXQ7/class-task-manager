-- 2026-10-29：清理「切换体验版」遗留的 impersonation 映射。
-- 背景：member id=13（示例成员01，真实超管，class_id=3）的 openid 被映射到
--       member id=250（赵子涵，演示班 104）⇒ 服务端 getContext() 全程把他当演示身份，
--       class.list 只回演示班（真实 5 个班一个都看不到）。
--       该行 created_at = 2026-10-29 02:50:37（用户截图后 16 秒生成），属残留态。
-- 影响：删除后该 openid 恢复本人身份（真实超管 / 示例班级A），可逆 —— 前端
--       「我的 → 更多 → 切换体验版」可一键重新进入演示态。
DELETE FROM impersonation WHERE openid = 'oVAAy5GI1lQLlvNIFtVs6CBEzQM4';
