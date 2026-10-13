-- ============================================================
-- 网页管理后台 · 建表脚本
-- 时间：2026-10-10
-- 依据：2026-10-10 工作日志「网页管理后台方案（grill-me 定案）」
--
-- 铁律遵守：
--   ① member 表**零改动** —— admin_user 独立建表，绝不复用 member 做后台账号，
--      避免进入 check-test-account-hidden 等既有门禁的扫描面，也避免后台账号
--      被「停用成员」「测试账号」等业务状态误伤。
--   ② 后台登录**必须回查 member.is_super=1 且 status 正常**（方案硬要求）：
--      admin_user 只是「谁可以登录网页后台」的白名单，真正的权限真源仍是 member。
--      否则 member 被停用 / 降权后，admin_user 会变成绕过 member 的后门。
--   ③ TDSQL 无 ADD COLUMN IF NOT EXISTS，本脚本仅 CREATE TABLE IF NOT EXISTS，
--      可重复执行（幂等）。
-- ============================================================

-- 1. 后台账号（白名单；密码 scrypt 哈希，不存明文）
--    member_id 指向 member.id —— 每次登录都会回查该行的 is_super / status。
--    ⚠️ pass_hash 必须 ≥ VARCHAR(255)：scrypt 格式串 scrypt$N$r$p$salt_b64$hash_b64
--       恰好 **130 字符**（17+24+1+88）。首版按 bcrypt(60) 习惯写 128，
--       线上「改密码」恒 500——应用账号连的是严格模式，130 塞 128 直接
--       ER_DATA_TOO_LONG(1406)；而建号 INSERT 走 tcb 通道（非严格）被**静默截断到 128**，
--       截断版哈希因 verifyPassword 按「存储长度」推导 dkLen 仍能登录，
--       于是「能登录、不能改密」的怪象一路瞒到真机改密才爆。2026-10-10 已线上 ALTER 修掉。
CREATE TABLE IF NOT EXISTS `admin_user` (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  username    VARCHAR(32)  NOT NULL COMMENT '登录名（唯一）',
  pass_hash   VARCHAR(255) NOT NULL COMMENT 'scrypt 哈希（130 字符），禁止存明文',
  member_id   INT          NOT NULL COMMENT '关联 member.id；登录时回查 is_super=1 且 status 正常',
  status      TINYINT      NOT NULL DEFAULT 1 COMMENT '1=启用 0=停用（停用仍保留历史会话）',
  last_login_at DATETIME   DEFAULT NULL,
  last_login_ip VARCHAR(64) DEFAULT NULL,
  fail_count  INT          NOT NULL DEFAULT 0 COMMENT '连续登录失败次数（限流用，成功即清零）',
  locked_until DATETIME    DEFAULT NULL COMMENT '失败过多时的锁定到期时间',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_username (username),
  KEY idx_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 会话（HttpOnly Cookie 里的 sid 落在这里）
--    不用 JWT 的原因：需要**即时吊销**（改密码 / 停用账号时立刻踢下线），
--    JWT 签发后在过期前无法撤销，必须额外维护黑名单，反而更复杂。
--    12h 滑动续期：每次带有效 Cookie 访问即顺延 expires_at。
CREATE TABLE IF NOT EXISTS `admin_session` (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  sid         CHAR(64)     NOT NULL COMMENT '随机会话 ID（Cookie 值，SHA-256 后存）',
  admin_id    INT          NOT NULL COMMENT 'admin_user.id',
  expires_at  DATETIME     NOT NULL COMMENT '到期时间（滑动续期）',
  ip          VARCHAR(64)  DEFAULT NULL,
  ua          VARCHAR(255) DEFAULT NULL COMMENT 'User-Agent 截断 255',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sid (sid),
  KEY idx_admin (admin_id),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 操作审计（后台的一切写操作都要留痕）
--    复用既有 common/audit.js（那是内容安全审核，**不是**操作审计），
--    所以这里单独建表。class_id 必存：后台跨班放开，事后要能回答「谁动了哪个班」。
CREATE TABLE IF NOT EXISTS `admin_audit_log` (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  admin_id    INT          NOT NULL COMMENT 'admin_user.id',
  member_id   INT          NOT NULL COMMENT '当时的 member.id（超管真身）',
  username    VARCHAR(32)  NOT NULL COMMENT '冗余登录名，账号删了也留痕',
  module      VARCHAR(32)  NOT NULL COMMENT 'course / member / class / config',
  action      VARCHAR(48)  NOT NULL COMMENT '如 timetable.import / member.setStatus',
  class_id    INT          DEFAULT NULL COMMENT '目标班级（跨班操作必填）',
  summary     VARCHAR(512) NOT NULL DEFAULT '' COMMENT '人话摘要，便于不查 JSON 也能看懂',
  detail      JSON         DEFAULT NULL COMMENT '结构化明细（干跑预览结果 / 变更前后值）',
  ip          VARCHAR(64)  DEFAULT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin (admin_id),
  KEY idx_created (created_at),
  KEY idx_class (class_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 初始化账号不在本脚本里做 —— 密码哈希由 Node 的 bcrypt 生成后单独 INSERT，
-- 绝不在 SQL 里写明文（SQL 会留在仓库与备份里）。
-- 建表后执行：node scripts/admin-create-user.js <username> <member_id>
-- ============================================================