-- 开启审核体验入口（2026-10-11 · v1.0.6.3）
-- 前提：前端已上传（首页才会渲染「审核体验」区块）。口令只填在 mp 后台「审核备注」里。
-- 关闭（审核通过后**必须**执行，同时清掉演示超管的 openid，防止体验者长期持有超管身份）：
--   UPDATE `class` SET review_demo_on = 0, review_demo_code = '' WHERE id = 3;
--   UPDATE member SET openid = NULL WHERE id = 69;   -- 测试超管（000000000091）

UPDATE `class` SET review_demo_on = 1, review_demo_code = 'LXQ-L3SS-CGHQ-DUWG-T5' WHERE id = 3;

SELECT id, name, review_demo_on, review_demo_code FROM `class` WHERE review_demo_on = 1;