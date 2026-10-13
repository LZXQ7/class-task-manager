-- 青果课表导入：成员「申请适配」记录表（需求 D-2 / 门禁 #59）
-- 成员在未适配班级上传 .xlsx → 建 PENDING 申请；超管在「课表适配申请」列表下载并复用 importTimetable 适配。
-- 文件名固定格式：【班级名】-教学安排表（class.name 不带括号，B5 决议）。
CREATE TABLE IF NOT EXISTS timetable_apply (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  class_id    INT          NOT NULL COMMENT '申请所属班级（锁申请者本人班）',
  member_id   INT          NOT NULL COMMENT '提交申请的成员（锁 ctx.member.id，只能本人）',
  file_id     VARCHAR(255) NOT NULL COMMENT '云存储 fileID（timetable-apply/ 私有目录）',
  file_name   VARCHAR(128) NOT NULL COMMENT '【班级名】-教学安排表',
  group_scope ENUM('A','B') DEFAULT NULL COMMENT '本次申请适配的组别（2026-10-05）：青果 A/B 组是两个独立文件，组别由提交者选；NULL=全体课',
  status      ENUM('PENDING','DONE','REJECTED') NOT NULL DEFAULT 'PENDING',
  summary     TEXT         COMMENT '解析摘要 JSON：{courseCount,sessionCount,warnings}',
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  handled_at  DATETIME     DEFAULT NULL COMMENT '超管处理后时间',
  KEY idx_class  (class_id),
  KEY idx_status (status),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
