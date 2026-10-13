-- 迁移 v0.7.16：成员备注（辅导员的学生信息 / 家庭情况管理记录）
-- ============================================================
-- 可见性（用户裁决）：仅教职工（X 组）+ 超管可见，学生与普通班委不可见。
-- 教职工只能给「自己绑定班级（staff_class）里的成员」写备注（member.noteScopeOk 校验）；
-- 编辑 / 删除限「作者本人或超管」；教职工账号删除后备注保留（记录跟着学生走）。
--
-- 写入方：member.noteSave / noteDelete
-- 读取方：member.noteList
--
-- ⚠️ 重复执行报 1050「Table already exists」，属预期、可忽略。

CREATE TABLE member_note (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  member_id  INT          NOT NULL COMMENT '被备注的成员（member.id）',
  author_id  INT          NOT NULL COMMENT '写下备注的教职工 / 超管（member.id）',
  content    VARCHAR(512) NOT NULL COMMENT '备注内容（≤500 字）',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '写入时间',
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='成员备注（v0.7.16，仅教职工+超管可见）';
