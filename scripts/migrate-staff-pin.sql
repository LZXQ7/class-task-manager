-- ============================================================
-- v0.7.17 需求⑥：辅导员「关注的学生」固定到主页
-- ------------------------------------------------------------
-- 背景：辅导员带多个班、上百名学生，其中少数需要长期跟踪（家庭困难、情绪波动、
-- 家校沟通频繁等）。每次都要从「查看班级 → 选班 → 找到这个人」翻进去太深，
-- 所以允许把这些人固定到首页，首页直接显示「头像 + 姓名 + 最新一条备注摘要」，
-- 点开即可继续记录。
--
-- 设计要点：
--   · 关注是**教职工个人维度**（staff_id = 他自己的 member.id），
--     不是班级维度 —— 同一位学生可以被多位老师分别关注，互不影响。
--   · 权限与 member_note **完全同源**（复用 noteScopeOk）：能给他写备注的人才允许关注他。
--   · 读取（pinList）时再按 staff_class 过滤一遍：教职工的班级绑定被改小之后，
--     历史关注不能继续把「已不在他范围内」的学生漏出来。
--   · 上限 8 人（云函数 PIN_MAX），避免首页被塞满。
--
-- TDSQL 注意：一次只执行一条 DDL，没有 ADD COLUMN IF NOT EXISTS。
-- CREATE TABLE IF NOT EXISTS 本身是幂等的，可重复执行。
-- ============================================================

CREATE TABLE IF NOT EXISTS staff_pin (
  staff_id   INT      NOT NULL COMMENT '教职工 / 超管（member.id）',
  member_id  INT      NOT NULL COMMENT '被关注的学生（member.id）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '固定时间（首页按此排序）',
  PRIMARY KEY (staff_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='辅导员关注的学生（固定到主页，v0.7.17）';
