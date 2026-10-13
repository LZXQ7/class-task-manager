-- 审核体验入口（2026-10-11 · v1.0.6.3）
-- 背景：微信审核驳回「存在登录受限问题」（运营规范 3.3.3）—— 本小程序常规绑定是**三步**
--       （班级口令 → 名单选人 → 学号后 4 位），审核员没有口令、名单里也没有他的名字，
--       光给口令也过不了第 2 步。故在首页旁挂一条「审核体验」一键直达通道。
-- 落库选择：开关/口令放 `class` 表，而不是环境变量或代码里 ——
--   · 环境变量：关闭需重新部署云函数，审核通过后才能改；
--   · 代码里：口令随小程序包可被反解；
--   · DB：审核通过后一条 UPDATE 即关，且只有超管能读写。
-- ⚠️ TDSQL **没有** ADD COLUMN IF NOT EXISTS，执行前必须先查 information_schema（已查：0 行）。
-- 回滚：UPDATE `class` SET review_demo_on = 0, review_demo_code = '';

CREATE TABLE bak_class_pre_reviewdemo_20261011 AS SELECT * FROM `class`;

ALTER TABLE `class`
  ADD COLUMN review_demo_on TINYINT NOT NULL DEFAULT 0 COMMENT '审核体验入口开关（1=开放）',
  ADD COLUMN review_demo_code VARCHAR(64) NOT NULL DEFAULT '' COMMENT '审核体验口令（永不回传前端）';

SELECT COUNT(*) AS bak_rows FROM bak_class_pre_reviewdemo_20261011;

SELECT id, name, review_demo_on, review_demo_code FROM `class` ORDER BY id;

-- ============================================================
-- v1.0.6.4（2026-10-12）增补：演示身份降权 —— 「演示态」标记列
-- 背景：审核入口绑的是 99 段**测试超管**（完整超管），口令一旦泄露，来人可做任何超管
--       操作。新增 is_review_demo 列标记演示身份：演示态下 common/review-demo 会拦截
--       「破坏性 / 授权性 / 全站性」写操作（抛 40010，前端提示「演示模式…」），
--       其余功能（值日 / 课表 / 请假 / 排班 / 通知）照常演示 —— 既降权又不缺功能。
-- ⚠️ TDSQL 无 ADD COLUMN IF NOT EXISTS，执行前先查 information_schema（已查：0 行）。
-- 开启体验入口时一并置 1：UPDATE member SET is_review_demo = 1 WHERE id = 69;
-- 关闭体验入口时一并清零：UPDATE member SET is_review_demo = 0, openid = NULL WHERE id = 69;
-- 全量回滚：UPDATE member SET is_review_demo = 0;
-- ============================================================

ALTER TABLE member
  ADD COLUMN is_review_demo TINYINT NOT NULL DEFAULT 0 COMMENT '审核演示身份（1=演示态，拦截破坏性动作）';

SELECT COUNT(*) AS member_rows FROM member;
SELECT id, name, student_no, role, is_super, is_review_demo FROM member WHERE is_super = 1 ORDER BY id;