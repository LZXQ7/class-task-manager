-- ============================================================
-- 班级任务管理 · 数据库初始化脚本
-- 库：CloudBase 云开发 MySQL（默认 schema = {envId}）
-- 版本：v1.0 MVP（对应开发文档 7.1 DDL + 必要补充表 schedule_publish）
-- ============================================================

-- 1. 班级配置（单行）
CREATE TABLE IF NOT EXISTS class_config (
  id            INT PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL,
  term_start    DATE         NOT NULL COMMENT '学期第一周周一',
  total_weeks   TINYINT      NOT NULL DEFAULT 16,
  join_token    VARCHAR(32)  NOT NULL COMMENT '班级口令',
  invite_code   VARCHAR(16)  NOT NULL UNIQUE COMMENT '小程序码 scene 用的邀请码',
  -- 绑定入口开关（防爆破，2026-09-25）：24h 累计验证失败 ≥500 次自动置 0，
  -- 超管在「我的」页手动开启（auth.setBindOpen）。学号后 4 位连续可推算，必须能一键关死。
  bind_open     TINYINT      NOT NULL DEFAULT 1,
  period_time   JSON         COMMENT '大节时间 [{"period":1,"start":"08:00","end":"09:40"}]'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 成员
CREATE TABLE IF NOT EXISTS member (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(32)  NOT NULL,
  student_no    VARCHAR(32)  NOT NULL UNIQUE,
  group_tag     ENUM('A','B','X') NOT NULL DEFAULT 'A' COMMENT 'A/B=值日分组；X=不分组（辅导员等教职工）',
  role          ENUM('ADMIN','MONITOR','MEMBER') DEFAULT 'MEMBER',
  is_super      TINYINT       NOT NULL DEFAULT 0 COMMENT '1=超级管理员（可解绑账号、安排值日表），仅 role=ADMIN 时有效',
  position      VARCHAR(32)   NOT NULL DEFAULT '' COMMENT '职位头衔（班长兼团支书/副班长/生活委员…，超管/辅导员也写），前端按三色分层展示',
  status        ENUM('ACTIVE','LEAVE','DISABLED') DEFAULT 'ACTIVE',
  openid        VARCHAR(64)  DEFAULT NULL UNIQUE COMMENT '绑定后写入',
  -- 绑定时间（2026-09-25）：通知列表只显示此时间之后发布的通知（media.msgList 过滤）；
  -- auth.bind 成功时写入 NOW()。存量已绑定成员在上线时统一置为当时时间作基线。
  bind_time     DATETIME     DEFAULT NULL,
  avatar_url    VARCHAR(512) DEFAULT NULL COMMENT '微信头像 URL（getUserProfile / chooseAvatar 获得）',
  duty_count    INT          DEFAULT 0,
  last_duty_at  DATE         DEFAULT NULL,
  -- 不参与值日轮换（v1.0.5）：本人指定某些人不排值日（如 3 班「1 号」示例成员58）。
  -- 值日自动生成 / 保洁 / 手动换班选人池都排除 duty_off=1；不影响成员列表、请假、统计等展示。
  duty_off      TINYINT      NOT NULL DEFAULT 0 COMMENT '1=不参与值日轮换（本人指定不排）',
  -- 微信提醒额度疑似耗尽（v0.7.15）：cron-weekly 发订阅消息吃到 43101 时置 1，
  -- 发成功或学生重新授权（member.remindReopen）时清 0。前端首页据此弹「重新开启」入口。
  remind_block  TINYINT      NOT NULL DEFAULT 0,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_group_status (group_tag, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2.1 教职工 ↔ 班级 多对多绑定（v0.7.16）
-- 教职工账号不再从属单一班级：可见/可操作范围 = staff_class 映射集合；
-- 无映射行时回退 member.class_id 主班（存量单班教职工兼容）。
CREATE TABLE IF NOT EXISTS staff_class (
  staff_id   INT      NOT NULL COMMENT 'member.id，group_tag=X 的教职工账号',
  class_id   INT      NOT NULL COMMENT '班级 id（class.id）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '绑定时间',
  PRIMARY KEY (staff_id, class_id),
  KEY idx_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2.2 成员备注（v0.7.16）：辅导员的学生信息 / 家庭情况管理记录；仅教职工+超管可见
CREATE TABLE IF NOT EXISTS member_note (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  member_id  INT          NOT NULL COMMENT '被备注的成员（member.id）',
  author_id  INT          NOT NULL COMMENT '写下备注的教职工 / 超管（member.id）',
  content    VARCHAR(512) NOT NULL COMMENT '备注内容（≤500 字）',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '写入时间',
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2.3 主页关注的学生（v0.7.17 需求⑥）：辅导员把需要长期跟踪的学生固定到首页。
-- 权限与 member_note 同源（复用 noteScopeOk）；读取时再按 staff_class 过滤一遍，
-- 防止班级绑定被改小之后，历史关注继续把已不在范围内的学生漏出来。
CREATE TABLE IF NOT EXISTS staff_pin (
  staff_id   INT      NOT NULL COMMENT '教职工 / 超管（member.id）',
  member_id  INT      NOT NULL COMMENT '被关注的学生（member.id）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '固定时间（首页按此排序）',
  PRIMARY KEY (staff_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 课程
CREATE TABLE IF NOT EXISTS course (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL,
  teacher       VARCHAR(32)  DEFAULT NULL,
  room          VARCHAR(32)  DEFAULT NULL,
  course_type   ENUM('ALL','GROUP') NOT NULL,
  duty_count    TINYINT      DEFAULT 2 COMMENT '每节课值日人数，默认 2 人',
  created_by    INT          NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 课次（排班原子单位）
CREATE TABLE IF NOT EXISTS session (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  class_id      INT          NOT NULL DEFAULT 1 COMMENT '所属班级（多班隔离；生产库已有，init.sql 补记于 2026-10-07）',
  course_id     INT          NOT NULL,
  kind          ENUM('COURSE','CLEAN') NOT NULL DEFAULT 'COURSE' COMMENT 'COURSE=普通课次值日；CLEAN=值日保洁（打扫410）',
  week_rule     ENUM('ALL','ODD','EVEN') DEFAULT 'ALL',
  weeks         VARCHAR(64)  DEFAULT '' COMMENT '逗号分隔的上课周次，空=每周都上；优先于 week_rule',
  day_of_week   TINYINT      NOT NULL COMMENT '1=周一',
  period        TINYINT      NOT NULL COMMENT '1-4全天 5晚上',
  group_scope   ENUM('A','B') DEFAULT NULL COMMENT 'NULL=全体课',
  duty_count    TINYINT      DEFAULT 2 COMMENT '每节课值日人数，默认 2 人',
  note          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '课表备注：调课原因等（2026-10-07 加）',
  KEY idx_slot (day_of_week, period, week_rule),
  KEY idx_course (course_id),
  KEY idx_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. 值日
CREATE TABLE IF NOT EXISTS duty (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  session_id    INT          NOT NULL,
  week          TINYINT      NOT NULL,
  class_date    DATE         NOT NULL,
  member_id     INT          NOT NULL,
  status        ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source        ENUM('AUTO','MANUAL') DEFAULT 'AUTO',
  done_at       DATETIME     DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_duty (session_id, week, member_id),
  KEY idx_date (class_date),
  KEY idx_member_week (member_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. 值日操作日志
CREATE TABLE IF NOT EXISTS duty_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  duty_id       INT          NOT NULL,
  operator_id   INT          NOT NULL,
  action        ENUM('CREATE','SWAP','LEAVE','DONE','UNDO','CANCEL') NOT NULL,
  from_member   INT          DEFAULT NULL,
  to_member     INT          DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_duty (duty_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. 换班申请
CREATE TABLE IF NOT EXISTS swap_request (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  duty_id       INT          NOT NULL,
  type          ENUM('SWAP','LEAVE') NOT NULL,
  from_member   INT          NOT NULL,
  to_member     INT          DEFAULT NULL,
  start_date    DATE         DEFAULT NULL,
  end_date      DATE         DEFAULT NULL,
  reason        ENUM('COURSE','SICK','INTERN','OTHER') DEFAULT NULL,
  status        ENUM('PENDING_PEER','PENDING_ADMIN','DONE','REJECTED','CANCELLED') DEFAULT 'PENDING_PEER',
  expire_at     DATETIME     NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_to (to_member, status),
  KEY idx_from (from_member, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 请假单（供排班过滤）
CREATE TABLE IF NOT EXISTS leave_request (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  member_id     INT          NOT NULL,
  swap_id       INT          DEFAULT NULL,
  start_date    DATE         NOT NULL,
  end_date      DATE         NOT NULL,
  status        ENUM('PENDING','APPROVED','REJECTED','CANCELLED') DEFAULT 'PENDING',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_member_date (member_id, start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 附件（照片/语音）
CREATE TABLE IF NOT EXISTS attachment (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  biz_type      ENUM('DUTY_PHOTO','NOTICE_AUDIO') NOT NULL,
  biz_id        INT          NOT NULL,
  file_id       VARCHAR(128) NOT NULL,
  mime          VARCHAR(32)  NOT NULL,
  real_mime     VARCHAR(32)  DEFAULT NULL,
  size          INT          DEFAULT 0,
  duration_ms   INT          DEFAULT NULL,
  audit_status  ENUM('AUDITING','PASS','BLOCKED') DEFAULT 'AUDITING',
  audit_trace   VARCHAR(64)  DEFAULT NULL,
  uploader_id   INT          NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_biz (biz_type, biz_id),
  KEY idx_audit (audit_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. 语音通知
CREATE TABLE IF NOT EXISTS notice (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  publisher_id  INT          NOT NULL,
  audio_id      INT          NOT NULL,
  duration_ms   INT          NOT NULL,
  week          TINYINT      NOT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. 通知已读
CREATE TABLE IF NOT EXISTS notice_read (
  notice_id     INT          NOT NULL,
  member_id     INT          NOT NULL,
  read_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id, member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. 排班规则（单行）
CREATE TABLE IF NOT EXISTS schedule_rules (
  id            INT PRIMARY KEY,
  sort_by_count TINYINT      DEFAULT 1,
  avoid_same_day TINYINT     DEFAULT 1,
  avoid_back_to_back TINYINT DEFAULT 0,
  cron_enabled  TINYINT      DEFAULT 1,
  cron_weekday  TINYINT      DEFAULT 0,
  cron_hour     TINYINT      DEFAULT 20,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 13. 绑定尝试限流
CREATE TABLE IF NOT EXISTS bind_attempt (
  openid        VARCHAR(64) PRIMARY KEY,
  fail_count    INT          DEFAULT 0,
  locked_until  DATETIME     DEFAULT NULL,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 14. 周发布状态（补充表：开发文档 8.2 schedule.listWeek 需返回 DRAFT/PUBLISHED/ARCHIVED，
--     原 DDL 缺少周发布状态落点，此处补齐）
CREATE TABLE IF NOT EXISTS schedule_publish (
  week          TINYINT PRIMARY KEY,
  status        ENUM('DRAFT','PUBLISHED') DEFAULT 'DRAFT',
  published_at  DATETIME     DEFAULT NULL,
  published_by  INT          DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 15. 临时调课（按周生效的课次覆盖）
-- 为什么不用「改 session.weeks」表达「本周不上」：那会改掉整学期的课表计划、且不可逆。
-- 这里存**那一周**的例外，原始课表一行不动，随时可撤销。
--   kind=OFF  → 该课次本周不上（to_* 为空）
--   kind=MOVE → 该课次本周改到 to_day / to_period（同周内，不跨周）
CREATE TABLE IF NOT EXISTS session_shift (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  session_id    INT          NOT NULL COMMENT 'session.id',
  week          TINYINT      NOT NULL COMMENT '生效的那一周',
  kind          ENUM('OFF','MOVE') NOT NULL COMMENT 'OFF=本周不上；MOVE=换到 to_day/to_period',
  to_day        TINYINT      DEFAULT NULL COMMENT '1=周一 … 7=周日',
  to_period     TINYINT      DEFAULT NULL COMMENT '1-5',
  note          VARCHAR(64)  DEFAULT '' COMMENT '备注 / 来源标记（如 AI、按日期调课）',
  created_by    INT          DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_shift (session_id, week),
  KEY idx_shift_week (week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 16. 换人记录（超级管理员「换人」= 直接替换，可一键还原）
-- 为什么单开一张表：换人后原 duty 变成 SWAPPED_OUT、列表里不再出现，
-- 只靠 duty_log 无法幂等地判断「这次换人是否已被还原」，也无法定位新插入的那一行。
-- 这里把「原 duty / 新 duty / 双方 / 是否已还原」显式记下来，还原时按记录精确回滚。
CREATE TABLE IF NOT EXISTS duty_reassign (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  duty_id       INT          NOT NULL COMMENT '原值日 duty.id（已置 SWAPPED_OUT）',
  new_duty_id   INT          DEFAULT NULL COMMENT '换人后新插入的 MANUAL duty.id',
  session_id    INT          NOT NULL,
  week          TINYINT      NOT NULL,
  from_member   INT          NOT NULL COMMENT '被换下的人',
  to_member     INT          NOT NULL COMMENT '换上的人',
  operator_id   INT          NOT NULL COMMENT '操作人（超级管理员）',
  undone        TINYINT      NOT NULL DEFAULT 0 COMMENT '1=已还原',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  undone_at     DATETIME     DEFAULT NULL,
  KEY idx_duty (duty_id),
  KEY idx_new_duty (new_duty_id),
  KEY idx_week (week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 17. 班级通知（文字 + 可选在线文档链接 + 可选「确认收到」）
-- 为什么不复用 notice：那张表是「语音通知」（audio_id NOT NULL），首页的未读语音卡片还在用它。
-- 文字通知的可见范围（全体 / 指定成员）与回执语义都和语音不同，混表会让两边的查询互相污染。
CREATE TABLE IF NOT EXISTS notice_msg (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  publisher_id  INT          NOT NULL COMMENT '发布人 member.id',
  title         VARCHAR(64)  NOT NULL,
  content       TEXT         NOT NULL,
  images        JSON         DEFAULT NULL COMMENT '通知配图 fileID 数组（v0.7.14，最多 3 张，cloud:// 开头）',
  link_url      VARCHAR(512) DEFAULT NULL COMMENT '在线文档链接（金山文档 / 腾讯文档等）',
  link_name     VARCHAR(64)  DEFAULT NULL COMMENT '链接显示名，如「金山文档」',
  scope         ENUM('ALL','PICK','COMMITTEE','POSITION') NOT NULL DEFAULT 'ALL' COMMENT 'ALL=全体成员；PICK=指定成员；COMMITTEE=仅发班委；POSITION=按职位（2026-09-26 §41 引入，建表语句滞后至此补齐）',
  need_ack      TINYINT      NOT NULL DEFAULT 0 COMMENT '1=需要成员点「收到」',
  popup         TINYINT      NOT NULL DEFAULT 0 COMMENT '1=发布时附带一次性弹窗（首页未读弹一次，看过不再弹；v1.0.5 起）',
  week          TINYINT      DEFAULT NULL COMMENT '发布时所在周（归档用）',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 18. 通知的指定接收人（scope=PICK 时才有记录；ALL 不写行）
CREATE TABLE IF NOT EXISTS notice_msg_target (
  notice_id     INT          NOT NULL,
  member_id     INT          NOT NULL,
  PRIMARY KEY (notice_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 19. 通知已读 / 已确认回执（成员点「收到」写这里；need_ack=0 的通知只看不确认）
CREATE TABLE IF NOT EXISTS notice_msg_read (
  notice_id     INT          NOT NULL,
  member_id     INT          NOT NULL,
  read_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 20. 通知「我删除的」（成员把某条通知从自己列表里删掉，仅对自己生效，不影响他人可见性）
CREATE TABLE IF NOT EXISTS notice_msg_delete (
  notice_id     INT          NOT NULL,
  member_id     INT          NOT NULL,
  deleted_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 21. 通知「一次性弹窗」已读（v1.0.5）：发布通知时可勾选「弹出一次性弹窗」，
--     成员下次打开首页弹一次、看过不再弹（每人每条一次）。与 app_notice_seen 无关：
--     app_notice 是超管全局的「版本更新公告」，本表按 notice_msg.id 逐条记，互不干扰。
CREATE TABLE IF NOT EXISTS notice_popup_seen (
  notice_id     INT          NOT NULL COMMENT '通知 id（notice_msg.id）',
  member_id     INT          NOT NULL COMMENT '已看过该弹窗的成员 member.id',
  seen_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '看过时间',
  PRIMARY KEY (notice_id, member_id),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通知「一次性弹窗」已读（每人每条一次，v1.0.5）';

-- 21. 超管「切换测试账号」模拟态映射（openid 真实身份不变，生效身份替换为目标测试账号）
-- 目标成员限定学号 99 段测试账号（auth.switchAccount 校验）；删行 = 恢复本人。
CREATE TABLE IF NOT EXISTS impersonation (
  openid        VARCHAR(64) PRIMARY KEY,
  member_id     INT          NOT NULL COMMENT '被模拟的目标成员 id（限定测试账号 99 段）',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 22. 绑定失败日志（防爆破第二层，2026-09-25）
-- bind_attempt 按 openid 计数挡不住换微信号攻击；本表按「目标学号」与「全局」双维度限流：
--   同一 target（memberId）60 分钟内被试错 >= 8 次 → 拒绝该学号验证 60 分钟（auth.assertTargetOk）；
--   全部失败 60 分钟内 >= 300 条 → 全局熔断（auth.assertGlobalOk）。
-- 24h 前旧记录由 auth 在写入时顺手清理。
CREATE TABLE IF NOT EXISTS bind_fail_log (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  openid      VARCHAR(64) NOT NULL,
  kind        ENUM('token','student') NOT NULL,
  target      VARCHAR(32) NOT NULL DEFAULT '',
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_target (target, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 初始化数据
-- ============================================================

-- 班级配置：学期 2026-09-14（周一，开学日）起，共 16 周；口令 <JOIN_TOKEN>；邀请码 <INVITE_CODE>
INSERT IGNORE INTO class_config (id, name, term_start, total_weeks, join_token, invite_code, period_time)
VALUES (1, '示例班级A', '2026-09-14', 16, '<JOIN_TOKEN>', '<INVITE_CODE>',
 '[{"period":1,"start":"08:00","end":"09:40"},{"period":2,"start":"10:05","end":"11:45"},{"period":3,"start":"14:00","end":"15:40"},{"period":4,"start":"16:00","end":"17:40"},{"period":5,"start":"19:00","end":"20:40"}]');

-- 排班规则默认值
INSERT IGNORE INTO schedule_rules (id) VALUES (1);

-- 演示成员名单（12 人，尾号奇偶分 A/B 组；张伟为管理员，openid 留空待绑定）
INSERT INTO member (name, student_no, group_tag, role) VALUES
  ('张伟', '20260101', 'A', 'ADMIN'),
  ('李娜', '20260102', 'B', 'MEMBER'),
  ('王芳', '20260103', 'A', 'MEMBER'),
  ('刘洋', '20260104', 'B', 'MEMBER'),
  ('陈静', '20260105', 'A', 'MEMBER'),
  ('杨帆', '20260106', 'B', 'MONITOR'),
  ('赵磊', '20260107', 'A', 'MEMBER'),
  ('黄敏', '20260108', 'B', 'MEMBER'),
  ('周杰', '20260109', 'A', 'MEMBER'),
  ('吴优', '20260110', 'B', 'MEMBER'),
  ('徐强', '20260111', 'A', 'MEMBER'),
  ('孙丽', '20260112', 'B', 'MEMBER');

-- 测试账号 + 辅导员（2026-09-25）：学号 99 段=非学生段；status=LEAVE 可绑定但不进值日轮转池
-- （排班生成器/cron-weekly/media 群发都只取 status='ACTIVE'）。重导可还原。
INSERT INTO member (name, student_no, group_tag, role, is_super, status)
SELECT * FROM (
  SELECT '示例成员57' AS name, '000000000090' AS student_no, 'X' AS group_tag, 'ADMIN' AS role, 0 AS is_super, 'LEAVE' AS status, '辅导员' AS position
  UNION ALL SELECT '测试超管',   '000000000091', 'A', 'ADMIN',  1, 'LEAVE'
  UNION ALL SELECT '测试管理员', '000000000092', 'B', 'ADMIN',  0, 'LEAVE'
  UNION ALL SELECT '测试成员',   '000000000093', 'A', 'MEMBER', 0, 'LEAVE'
) t
WHERE NOT EXISTS (SELECT 1 FROM member WHERE student_no = t.student_no);

-- 值日保洁：每天第四节后打扫 410 教室（与课次值日共用同一序号轮转，只在值日页显示）
-- 用 name 唯一标记做幂等判断；created_by 指向超级管理员（示例成员01 id=13）。
INSERT INTO course (name, teacher, room, course_type, duty_count, created_by)
SELECT '打扫410', NULL, '410', 'ALL', 2, 13
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM course WHERE name = '打扫410');

INSERT INTO session (course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count)
SELECT c.id, 'CLEAN', 'ALL', '', 1, 4, NULL, 2 FROM course c WHERE c.name = '打扫410'
  AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 1 AND s.period = 4 AND s.kind = 'CLEAN');
INSERT INTO session (course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count)
SELECT c.id, 'CLEAN', 'ALL', '', 2, 4, NULL, 2 FROM course c WHERE c.name = '打扫410'
  AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 2 AND s.period = 4 AND s.kind = 'CLEAN');
INSERT INTO session (course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count)
SELECT c.id, 'CLEAN', 'ALL', '', 3, 4, NULL, 2 FROM course c WHERE c.name = '打扫410'
  AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 3 AND s.period = 4 AND s.kind = 'CLEAN');
INSERT INTO session (course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count)
SELECT c.id, 'CLEAN', 'ALL', '', 4, 4, NULL, 2 FROM course c WHERE c.name = '打扫410'
  AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 4 AND s.period = 4 AND s.kind = 'CLEAN');
INSERT INTO session (course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count)
SELECT c.id, 'CLEAN', 'ALL', '', 5, 4, NULL, 2 FROM course c WHERE c.name = '打扫410'
  AND NOT EXISTS (SELECT 1 FROM session s WHERE s.course_id = c.id AND s.day_of_week = 5 AND s.period = 4 AND s.kind = 'CLEAN');

-- 每周二下午为全校大扫除：名称改为「410大扫除」、人数 4 人（周一/三/四/五仍「打扫410」、2 人）
INSERT INTO course (name, teacher, room, course_type, duty_count, created_by)
SELECT '410大扫除', NULL, '410', 'ALL', 4, 13
  FROM DUAL
  WHERE NOT EXISTS (SELECT 1 FROM course WHERE name = '410大扫除');
UPDATE session s
  JOIN course c1 ON c1.id = s.course_id
  JOIN course c2 ON c2.name = '410大扫除'
  SET s.course_id = c2.id, s.duty_count = 4
WHERE s.kind = 'CLEAN' AND s.day_of_week = 2 AND s.period = 4 AND c1.name = '打扫410';

-- 9. 课表适配申请（青果导入需求 D-2 / 门禁 #59）
CREATE TABLE IF NOT EXISTS timetable_apply (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  class_id    INT          NOT NULL COMMENT '申请所属班级（锁申请者本人班）',
  member_id   INT          NOT NULL COMMENT '提交申请的成员（锁 ctx.member.id，只能本人）',
  file_id     VARCHAR(255) NOT NULL COMMENT '云存储 fileID（timetable-apply/ 私有目录）',
  file_name   VARCHAR(128) NOT NULL COMMENT '【班级名】-教学安排表',
  status      ENUM('PENDING','DONE','REJECTED') NOT NULL DEFAULT 'PENDING',
  summary     TEXT         COMMENT '解析摘要 JSON：{courseCount,sessionCount,warnings}',
  created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  handled_at  DATETIME     DEFAULT NULL COMMENT '超管处理后时间',
  KEY idx_class  (class_id),
  KEY idx_status (status),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
