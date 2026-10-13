-- ============================================================
-- 多班级系统迁移脚本（§43）
-- 库：CloudBase 云开发 MySQL
-- 改动：新建 class 表 + 8 张业务表加 class_id + 迁移 示例班级A + 导入 2601 + 创建 示例班级B
-- 时间：2026-09-25 ~18:25
-- 原则：
--   - 存量数据 class_id 全部置 1（即原 示例班级A），不破坏现有体验
--   - 不删除 class_config（兼容旧 init.sql 与现有读 path），但写入侧切换到 class 表
--   - class 表唯一对外源；class_config 仅留作兜底只读
-- ============================================================

-- 1. 班级表（每个班级一行，配置独立）
CREATE TABLE IF NOT EXISTS `class` (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL COMMENT '班级名（如 示例班级C）',
  join_token    VARCHAR(32)  NOT NULL UNIQUE COMMENT '班级口令',
  invite_code   VARCHAR(16)  NOT NULL UNIQUE COMMENT '小程序码 scene 用的邀请码',
  term_start    DATE         NOT NULL COMMENT '学期第一周周一',
  total_weeks   TINYINT      NOT NULL DEFAULT 16,
  bind_open     TINYINT      NOT NULL DEFAULT 1 COMMENT '0=关闭绑定入口',
  period_time   JSON         DEFAULT NULL COMMENT '大节时间 JSON；NULL=走全局兜底',
  is_active     TINYINT      NOT NULL DEFAULT 1 COMMENT '0=停用（已毕业的班级等场景）',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 从 class_config 迁移 示例班级A → class 表 id=1
-- 如果 class 表里已有 id=1，跳过；保证幂等
INSERT INTO `class` (id, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time)
SELECT 1, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time
  FROM class_config WHERE id = 1
ON DUPLICATE KEY UPDATE name=VALUES(name);

-- 3. 业务表加 class_id（默认 1，兼容存量）
ALTER TABLE member          ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE course          ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE session         ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE duty            ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE duty_log        ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE swap_request    ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE leave_request   ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE notice          ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE notice_msg      ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER id;
ALTER TABLE notice_msg_target  ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER notice_id;
ALTER TABLE notice_msg_read    ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER notice_id;
ALTER TABLE notice_msg_delete  ADD COLUMN IF NOT EXISTS class_id INT NOT NULL DEFAULT 1 AFTER notice_id;

-- 4. 索引（除主键外的常用 WHERE 维度）
-- member.class_id 已有默认排序；查询多用 (class_id, status) / (class_id, role)
ALTER TABLE member     ADD INDEX IF NOT EXISTS idx_class_status (class_id, status);
ALTER TABLE member     ADD INDEX IF NOT EXISTS idx_class_role   (class_id, role);
ALTER TABLE course     ADD INDEX IF NOT EXISTS idx_class        (class_id);
ALTER TABLE session    ADD INDEX IF NOT EXISTS idx_class        (class_id);
ALTER TABLE duty       ADD INDEX IF NOT EXISTS idx_class_date   (class_id, class_date);
ALTER TABLE notice_msg ADD INDEX IF NOT EXISTS idx_class_created (class_id, created_at);

-- 5. 插入 示例班级C（id=2）—— 学号前缀 2099010303xx
-- 学期/口令/邀请码：term_start 跟随 示例班级A 一致；口令 202601（与原 示例班级A 不同避免混淆），邀请码 <INVITE_CODE>
INSERT IGNORE INTO `class` (id, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time)
VALUES (2, '示例班级C', '202601', '<INVITE_CODE>', '2026-09-14', 16, 1,
 '[{"period":1,"start":"08:00","end":"09:40"},{"period":2,"start":"10:05","end":"11:45"},{"period":3,"start":"14:00","end":"15:40"},{"period":4,"start":"16:00","end":"17:40"},{"period":5,"start":"19:00","end":"20:40"}]');

-- 6. 创建 示例班级B（id=3，空班级，留给用户手动导入名单）
INSERT IGNORE INTO `class` (id, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time)
VALUES (3, '示例班级B', '<JOIN_TOKEN>', '<INVITE_CODE>', '2026-09-14', 16, 1,
 '[{"period":1,"start":"08:00","end":"09:40"},{"period":2,"start":"10:05","end":"11:45"},{"period":3,"start":"14:00","end":"15:40"},{"period":4,"start":"16:00","end":"17:40"},{"period":5,"start":"19:00","end":"20:40"}]');

-- ============================================================
-- 7. 导入 示例班级C 57 名成员（class_id=2；学号末位奇=A 组，偶=B 组）
-- 数据源：F:\示例班级C.xlsx（2026-09-25 用户提供）
-- ============================================================
INSERT IGNORE INTO member (name, student_no, group_tag, role, class_id) VALUES
('肖诗轩', '209901030301', 'A', 'MEMBER', 2),
('示例成员59', '209901030302', 'B', 'MEMBER', 2),
('示例成员63',   '209901030303', 'A', 'MEMBER', 2),
('丁湘豫', '209901030304', 'B', 'MEMBER', 2),
('郭昕瑜', '209901030305', 'A', 'MEMBER', 2),
('吴炳馨', '209901030306', 'B', 'MEMBER', 2),
('乔月琴', '209901030307', 'A', 'MEMBER', 2),
('张铭钰', '209901030308', 'B', 'MEMBER', 2),
('段文静', '209901030309', 'A', 'MEMBER', 2),
('聂铭',   '209901030310', 'B', 'MEMBER', 2),
('袁金鹏', '209901030311', 'A', 'MEMBER', 2),
('胡文熙', '209901030312', 'B', 'MEMBER', 2),
('谢柳',   '209901030313', 'A', 'MEMBER', 2),
('韩雨彤', '209901030314', 'B', 'MEMBER', 2),
('卢书瑶', '209901030315', 'A', 'MEMBER', 2),
('何明',   '209901030316', 'B', 'MEMBER', 2),
('薛雯',   '209901030317', 'A', 'MEMBER', 2),
('钱柄滔', '209901030318', 'B', 'MEMBER', 2),
('许晨',   '209901030319', 'A', 'MEMBER', 2),
('宋宇华', '209901030320', 'B', 'MEMBER', 2),
('傅紫怡', '209901030321', 'A', 'MEMBER', 2),
('程子墨', '209901030322', 'B', 'MEMBER', 2),
('戴佳',   '209901030323', 'A', 'MEMBER', 2),
('冯嘉',   '209901030324', 'B', 'MEMBER', 2),
('余雅琳', '209901030325', 'A', 'MEMBER', 2),
('萧若曦', '209901030326', 'B', 'MEMBER', 2),
('苏婉',   '209901030327', 'A', 'MEMBER', 2),
('龚柯',   '209901030328', 'B', 'MEMBER', 2),
('田欣怡', '209901030329', 'A', 'MEMBER', 2),
('郝思源', '209901030330', 'B', 'MEMBER', 2),
('毛俊熙', '209901030331', 'A', 'MEMBER', 2),
('彭晓彤', '209901030332', 'B', 'MEMBER', 2),
('蔡凌',   '209901030333', 'A', 'MEMBER', 2),
('梁佳怡', '209901030334', 'B', 'MEMBER', 2),
('邓子辰', '209901030335', 'A', 'MEMBER', 2),
('贺锦',   '209901030336', 'B', 'MEMBER', 2),
('麦梓',   '209901030337', 'A', 'MEMBER', 2),
('邹语',   '209901030338', 'B', 'MEMBER', 2),
('石佳一', '209901030339', 'A', 'MEMBER', 2),
('柳青',   '209901030340', 'B', 'MEMBER', 2),
('夏若',   '209901030341', 'A', 'MEMBER', 2),
('雷雨',   '209901030342', 'B', 'MEMBER', 2),
('万辰',   '209901030343', 'A', 'MEMBER', 2),
('罗宇泽', '209901030344', 'B', 'MEMBER', 2),
('曾语桐', '209901030345', 'A', 'MEMBER', 2),
('汪可昕', '209901030346', 'B', 'MEMBER', 2),
('潘卓',   '209901030347', 'A', 'MEMBER', 2),
('邱雪',   '209901030348', 'B', 'MEMBER', 2),
('韦明',   '209901030349', 'A', 'MEMBER', 2),
('熊沐',   '209901030350', 'B', 'MEMBER', 2),
('蒋薇',   '209901030351', 'A', 'MEMBER', 2),
('阎俊',   '209901030352', 'B', 'MEMBER', 2),
('孙淑璠', '209901030353', 'A', 'MEMBER', 2),
('苑烨轩', '209901030354', 'B', 'MEMBER', 2),
('示例成员11',   '209901030355', 'A', 'MEMBER', 2),
('李宠',   '209901030356', 'B', 'MEMBER', 2),
('陈腾浩', '209901030357', 'A', 'MEMBER', 2);

-- ============================================================
-- 8. 数据完整性校验（脚本末尾自检）
-- ============================================================
SELECT 'class 总数' AS metric, COUNT(*) AS v FROM `class`;
SELECT '示例班级C成员数' AS metric, COUNT(*) AS v FROM member WHERE class_id = 2 AND student_no NOT LIKE '0000000000%';
SELECT '示例班级A成员数（原班）' AS metric, COUNT(*) AS v FROM member WHERE class_id = 1 AND student_no NOT LIKE '0000000000%';
SELECT 'class_config 保留（兜底）' AS metric, COUNT(*) AS v FROM class_config;