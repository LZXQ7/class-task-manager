-- 关闭审核体验入口（审核通过后执行）· 2026-10-11 · v1.0.6.3
--
-- ⚠️ 为什么必须关：这个入口本质是「知道口令就能当超管」的后门。
--    体验期间口令写在 mp 后台「审核备注」里，审核员/知情人手里都有；
--    不关 = 线上长期存在一个公开的超级管理员通道。
--
-- ✅ 关键：**不需要重新上传前端**。入口由 `wx:if="{{reviewOn}}"` 控制，
--    而 `reviewOn` 来自 `login` 下发的 `config.reviewDemo`（运行时读库）⇒
--    跑完下面两条 SQL，线上版本立即不再渲染该区块。
--
-- 执行后：任何人输任何口令都进不去（`review_demo_code <> ''` 不成立 ⇒ 开关恒关）；
--         已经进过的人下次冷启动时 openid 已被清 ⇒ 被送回绑定页，不再持有超管身份。

-- ① 关开关 + 清口令（开关的双要素：on=1 且 code<>''，清任一即失效，这里两个都置）
UPDATE `class` SET review_demo_on = 0, review_demo_code = '' WHERE id = 3;

-- ② 清掉体验者绑定（**别漏这一步**：不清的话，已进过的人会一直持有测试超管身份）
UPDATE member SET openid = NULL WHERE id = 69;

-- ③ 验证 ①：应看到 on=0、code 为空
SELECT id, name, review_demo_on, review_demo_code FROM `class` WHERE id = 3;

-- ④ 验证 ②：unbound 应为 1（openid 已被清空）
SELECT id, name, student_no, is_super, (openid IS NULL) AS unbound FROM member WHERE id = 69;