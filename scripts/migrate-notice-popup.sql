-- ============================================================
-- v1.0.5 需求：发布通知可选「弹出一次性弹窗」
-- ------------------------------------------------------------
-- 背景：超管的「发布更新公告」已能全员弹一次（app_notice + member.app_notice_seen）。
-- 现在班委 / 辅导员 / 超管「发布通知」时也想可选地弹一次，让没看列表的人也不错过。
--
-- 为什么**不**直接复用 app_notice：
--   1) app_notice 是全局表（无班级 / 接收人维度），班委发「本班」「指定成员」的通知
--      若写进 app_notice，弹窗会漏给别班 / 非接收人 —— 越权可见。
--   2) app_notice_seen 是单个「已读到的最新 id」（只增不减）。两种弹窗共用一个游标，
--      先发的会被后发的「盖过」而永远不弹（静默丢失）。
--   所以这里按 notice_msg 逐条记「谁看过」，与更新公告的机制完全隔离。
--
-- TDSQL 注意：一次只执行一条 DDL，没有 ADD COLUMN IF NOT EXISTS。
--   ALTER TABLE ... ADD COLUMN popup 只需执行一次（重复执行报 1060 已存在，属预期）。
--   CREATE TABLE IF NOT EXISTS 本身幂等，可重复执行。
-- ============================================================

-- ① notice_msg 增加 popup 标记（1=发布时附带一次性弹窗）
ALTER TABLE notice_msg
  ADD COLUMN popup TINYINT NOT NULL DEFAULT 0
  COMMENT '1=发布时附带一次性弹窗（首页未读弹一次，看过不再弹；v1.0.5 起）'
  AFTER need_ack;

-- ② 弹窗已读表（每人每条一次）
CREATE TABLE IF NOT EXISTS notice_popup_seen (
  notice_id     INT          NOT NULL COMMENT '通知 id（notice_msg.id）',
  member_id     INT          NOT NULL COMMENT '已看过该弹窗的成员 member.id',
  seen_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '看过时间',
  PRIMARY KEY (notice_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知「一次性弹窗」已读（每人每条一次，v1.0.5）';
