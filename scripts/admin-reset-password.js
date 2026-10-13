#!/usr/bin/env node
/**
 * 生成「重置后台账号口令」的 UPDATE SQL（不直连数据库）
 * 哈希格式必须与 cloudfunctions/admin-web/lib/auth.js 的 hashPassword 完全一致：
 *   scrypt$N$r$p$salt_b64$hash_b64
 * 用法：
 *   node scripts/admin-reset-password.js <username> [new_password]
 *   new_password 省略时随机生成 16 位强口令并打印（只打印一次，务必保存）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [, , username, passwordArg] = process.argv;
if (!username) {
  console.error('用法：node scripts/admin-reset-password.js <username> [new_password]');
  process.exit(2);
}
const usernameOk = /^[A-Za-z0-9_.-]{3,32}$/.test(username);
if (!usernameOk) {
  console.error('用户名只允许字母数字 _ . - ，长度 3–32');
  process.exit(2);
}

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

// 与 auth.js 完全一致：N=16384, r=8, p=1, dkLen=64
function hashPassword(plain) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
}

const hash = hashPassword(password);
// 同时顺手把锁定/失败计数清零，避免「改完密码还是锁着」
const sqlEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "''");
const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

const sql = [
  '-- 后台账号口令重置（由 scripts/admin-reset-password.js 生成）',
  '-- 生成时间：' + stamp,
  '-- 目标用户名：' + username,
  '-- ⚠️ 执行前请先确认该 username 存在且 status=1：',
  "--   SELECT id, username, member_id, status FROM admin_user WHERE username = '" + sqlEsc(username) + "';",
  '-- UPDATE 同时清零失败计数与锁定时间（避免改完仍被锁 15 分钟）',
  "UPDATE admin_user SET pass_hash = '" + sqlEsc(hash) + "', fail_count = 0, locked_until = NULL WHERE username = '" + sqlEsc(username) + "';",
  '-- 核对：应恰好 1 行受影响；member 必须是 is_super=1 且 status=ACTIVE 才能登入',
  ''
].join('\n');

const outDir = path.join(__dirname, '..', 'outputs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'admin-reset-password.sql');
fs.writeFileSync(out, sql, 'utf8');

console.log('已生成：' + out);
console.log('执行：bash scripts/run_sql_file.sh outputs/admin-reset-password.sql');
if (generated) {
  console.log('');
  console.log('随机新口令（只显示这一次，请立刻保存）：' + password);
} else {
  console.log('');
  console.log('新口令已写入 SQL（上面的 <口令> 即此值），执行后生效。');
}
console.log('提醒：含口令哈希的 SQL 别提交进 git（outputs/ 已在 .gitignore）。');
