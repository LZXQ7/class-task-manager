-- 演示班标记（2026-10-28 · 「演示班级口令跟着体验入口走」）
-- ============================================================
-- 背景：审核体验入口原本把口令写在**开启者自己的班**上（update class set ... where id = ctx.member.class_id），
--   而绑定目标是 99 段测试超管（member id 69，属于 示例班级A）⇒ 审核员一进来看到的是**真实同学姓名与
--   真实课表/值日**。现在要求：口令开启后进的是**全虚构的演示班**，看到的值日与课表都是虚拟数据。
--
-- 做法：给 `class` 加 `is_demo` 标记。
--   · reviewDemoSet（开启入口）把口令写到 **is_demo = 1 的班**（没配就退回开启者本班，保持旧行为）；
--   · reviewDemo（凭口令进入）优先绑**该班的超管成员**（演示班 = 赵子涵），演示班没配超管才退回 99 段测试号；
--   · 演示态身份（member.is_review_demo = 1）在 class.list 里**只看得到本班** ⇒ 无法切到真实班级。
--
-- ⚠️ TDSQL 没有 ADD COLUMN IF NOT EXISTS，执行前必须先查 information_schema（已查：0 行）。
-- 回滚：
--   UPDATE `class` SET is_demo = 0;
--   ALTER TABLE `class` DROP COLUMN is_demo;

CREATE TABLE bak_class_pre_demoflag_20261028 AS SELECT * FROM `class`;

ALTER TABLE `class`
  ADD COLUMN is_demo TINYINT NOT NULL DEFAULT 0 COMMENT '演示班（1=体验入口进入的班，数据全虚构）';

-- 当前唯一演示班：示例专业2605班（演示）
UPDATE `class` SET is_demo = 1 WHERE invite_code = 'DEMO2605';

-- 自检：只应有 1 行 is_demo = 1，且它就是 2605（演示）
SELECT id, name, invite_code, is_demo, is_active,
       (SELECT COUNT(*) FROM member m WHERE m.class_id = `class`.id) AS members,
       (SELECT COUNT(*) FROM member m WHERE m.class_id = `class`.id AND m.is_super = 1) AS supers
FROM `class` ORDER BY id;
