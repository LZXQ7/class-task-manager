#!/usr/bin/env node
/**
 * 生成后台账号的 INSERT SQL（不直连数据库）
 * ============================================================
 * 为什么是「生成 SQL」而不是直接连库写：
 *   admin-web 的连接配置在云函数运行时环境里（common/db.js 读云端 env），
 *   本地 node 拿不到 VPC 内网地址，硬跑只会连不上再让人误判成脚本坏了。
 *   项目既有做法也是这条（scripts/migrate-admin-web.sql + run_sql_file.sh）。
 *
 * 用法：
 *   node scripts/admin-create-user.js <username> <member_id> [password]
 *   password 省略时随机生成 16 位强口令并打印（只打印一次，务必保存）。
 *
 * ⚠️ member_id 必须是**真超管**且 status='ACTIVE'（真源口径，测试账号 99 段除外）。
 *    这里会先做只读校验并把结果一并写进 SQL 注释，方便事后核对。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [, , username, memberIdArg, passwordArg] = process.argv;
if (!username || !memberIdArg) {
  console.error('用法：node scripts/admin-create-user.js <username> <member_id> [password]');
  process.exit(2);
}
const memberId = Number(memberIdArg);
if (!Number.isInteger(memberId) || memberId <= 0) {
  console.error('member_id 必须是正整数');
  process.exit(2);
}
const usernameOk = /^[A-Za-z0-9_.-]{3,32}$/.test(username);
if (!usernameOk) {
  console.error('用户名只允许字母数字 _ . - ，长度 3–32');
  process.exit(2);
}

// 口令强度：低于 10 位直接拒绝 —— 后台账号一旦被爆破没人看得见
let password = passwordArg;
let generated = false;
if (!password) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(16);
  password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  generated = true;
}
if (String(password).length < 10) {
  console.error('口令至少 10 位');
  process.exit(2);
}

/**
 * 口令哈希：格式必须与 cloudfunctions/admin-web/lib/auth.js 的 hashPassword 完全一致
 *   scrypt$N$r$p$salt_b64$hash_b64
 * 独立实现（不 require 云函数那份）—— 那份会连带 require db.js，
 * 在本地没有云端 env 的情况下会直接抛错，正是本脚本要避开的事。
 */
function hashPassword(plain) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
}

const hash = hashPassword(password);
const sqlEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

const sql = [
  '-- 后台账号创建（由 scripts/admin-create-user.js 生成）',
  '-- 生成时间：' + stamp,
  '-- 用户名：' + username + '  member_id：' + memberId,
  '-- ⚠️ 执行前请先只读核对该 member 是真超管且 status=ACTIVE（测试账号 99 段无效）：',
  "--   SELECT id, name, student_no, is_super, status FROM member WHERE id = " + memberId + ';',
  '-- INSERT 用 IGNORE：用户名已存在时静默跳过（不会覆盖既有口令）',
  "INSERT IGNORE INTO admin_user (username, pass_hash, member_id, status) VALUES ('" +
    sqlEsc(username) + "', '" + sqlEsc(hash) + "', " + memberId + ', 1);',
  '-- 核对：应恰好 1 行',
  "SELECT id, username, member_id, status FROM admin_user WHERE username = '" + sqlEsc(username) + "';",
  ''
].join('\n');

const outDir = path.join(__dirname, '..', 'outputs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'admin-create-user.sql');
fs.writeFileSync(out, sql, 'utf8');

console.log('已生成：' + out);
console.log('执行：bash scripts/run_sql_file.sh outputs/admin-create-user.sql');
if (generated) {
  console.log('');
  console.log('随机口令（只显示这一次，请立刻保存）：' + password);
}
console.log('');
console.log('提醒：口令哈希已在上面的 SQL 里，**别把 outputs/admin-create-user.sql 提交进 git**。');
