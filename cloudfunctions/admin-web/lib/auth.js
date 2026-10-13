/**
 * 后台鉴权与会话（网页管理后台 · 2026-10-10）
 *
 * 为什么不用 guard.getContext()：
 *   既有 13 个云函数全部靠 cloud.getWXContext().OPENID 拿身份，
 *   网页端根本没有微信上下文 ⇒ 一个都不能复用。所以后台**独立成一套鉴权**，
 *   但**权限真源仍然是 member.is_super**（见 assertSuper 里的回查）。
 *
 * 三条硬规则（缺一条后台就是后门）：
 *   ① admin_user 只回答「谁可以登录后台」；
 *   ② 每次请求都回查 member.is_super=1 且 status='ACTIVE' —— member 被停用/降权
 *      后后台必须立刻失权，而不是等下次登录；
 *   ③ 会话存服务端（admin_session 表）⇒ 可即时吊销；Cookie 里的 sid 是
 *      SHA-256 哈希，库里被拖走也拿不到可用凭证。
 */
const crypto = require('crypto');
const { getPool } = require('../common/db');

const COOKIE_NAME = 'admin_sid';
const SESSION_HOURS = 12;          // 12h 滑动续期
const MAX_FAIL = 8;// 连续失败 8 次锁 15 分钟
const LOCK_MINUTES = 15;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randomSid() {
  // 32 字节强随机 → Cookie 传原始值，库里存哈希
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 口令哈希：**scrypt**（Node 内置），不用 bcrypt。
 * bcrypt 是原生模块 → 云函数 zip 部署要带 .node 二进制，跨平台易炸；
 * scrypt 是 crypto 标准库，零依赖、参数可调、内存硬化同样到位。
 * 格式：scrypt$N$r$p$salt_b64$hash_b64
 */
function hashPassword(plain) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), dk.toString('base64')].join('$');
}

function verifyPassword(plain, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    const dk = crypto.scryptSync(String(plain), salt, expect.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    });
    // 定长比较，避免时序侧信道
    return dk.length === expect.length && crypto.timingSafeEqual(dk, expect);
  } catch (e) {
    return false;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 从 req 取登录态；无效/过期/被停用一律返回 null（**永不抛错**，由路由决定怎么响应） */
async function loadSession(req) {
  const cookies = parseCookies(req);
  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;
  const pool = getPool();
  const sidHash = sha256(raw);
  const [rows] = await pool.query(
    "SELECT s.id AS sid_id, s.admin_id, s.expires_at, a.username, a.member_id, a.status, a.pass_hash " +
    'FROM admin_session s JOIN admin_user a ON a.id = s.admin_id ' +
    'WHERE s.sid = ? AND s.expires_at > NOW() LIMIT 1',
    [sidHash]
  );
  const row = rows[0];
  if (!row) return null;
  if (Number(row.status) !== 1) return null;
  // 规则②：回查 member —— 后台权限的真源在这里，不在 admin_user
  const [ms] = await pool.query(
    "SELECT id, name, is_super, status FROM member WHERE id = ? LIMIT 1",
    [row.member_id]
  );
  const m = ms[0];
  if (!m || Number(m.is_super) !== 1 || m.status !== 'ACTIVE') return null;
  // 滑动续期
  await pool.query(
    'UPDATE admin_session SET expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE id = ?',
    [SESSION_HOURS, row.sid_id]
  );
  return {
    adminId: row.admin_id,
    username: row.username,
    memberId: m.id,
    memberName: m.name,
    // 已登录账号的口令哈希：敏感操作（改密 / 停用后台账号）要用它做**二次校验**。
    // ⚠️ 这个字段只存在于服务端内存，**绝不能出现在任何响应里**
    //    （session 一律只手工挑字段回前端，不做 JSON.stringify(session)）。
    selfHash: row.pass_hash
  };
}

function setSessionCookie(res, raw) {
  // Secure 只在 https 下签发：本地 http 调试时带上它浏览器会直接拒收。
  // CloudBase 默认访问域名是 https，生产必带。
  const secure = String(res.req && res.req.headers && res.req.headers['x-forwarded-proto']) === 'https';
  res.setHeader('Set-Cookie', [
    COOKIE_NAME + '=' + raw +
    '; Path=/; Max-Age=' + SESSION_HOURS * 3600 +
    '; HttpOnly; SameSite=Lax' +
    (secure ? '; Secure' : '')
  ]);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', [COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  const ip = xf ? String(xf).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '';
  return String(ip).slice(0, 64);
}

/**
 * 登录：校验账号 + 口令 + 限流 + 回查 member 超管态
 * 返回 { ok, raw, adminId, ... }；raw 是要写进 Cookie 的原始 sid（**只有这里产生 sid**）
 */
async function login(username, password, req) {
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM admin_user WHERE username = ? LIMIT 1', [username]);
  const a = rows[0];
  const ip = clientIp(req);
  // 账号不存在也要走一次哈希，避免用响应时间探测账号是否存在
  const stored = a ? a.pass_hash : hashPassword('dummy');
  const passOk = verifyPassword(password, stored);
  if (!a || !passOk) {
    if (a) await bumpFail(a);
    return { ok: false, errMsg: '账号或密码不正确' };
  }
  if (Number(a.status) !== 1) return { ok: false, errMsg: '该后台账号已停用' };
  if (a.locked_until && new Date(a.locked_until.replace(' ', 'T') + 'Z') > new Date()) {
    return { ok: false, errMsg: '失败次数过多，请稍后再试' };
  }
  // 规则②：登录这一刻就要回查 member
  const [ms] = await pool.query('SELECT id, name, is_super, status FROM member WHERE id = ? LIMIT 1', [a.member_id]);
  const m = ms[0];
  if (!m || Number(m.is_super) !== 1 || m.status !== 'ACTIVE') {
    return { ok: false, errMsg: '该账号已不是有效的超级管理员，无法登录后台' };
  }
  await pool.query(
    'UPDATE admin_user SET fail_count = 0, locked_until = NULL, last_login_at = NOW(), last_login_ip = ? WHERE id = ?',
    [ip, a.id]
  );
  const raw = randomSid();
  await pool.query(
    'INSERT INTO admin_session (sid, admin_id, expires_at, ip, ua) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?, ?)',
    [sha256(raw), a.id, SESSION_HOURS, ip, String(req.headers['user-agent'] || '').slice(0, 255)]
  );
  return { ok: true, raw, adminId: a.id, username: a.username, memberId: m.id };
}

/** 记一次失败；连续到 MAX_FAIL 就锁 LOCK_MINUTES 分钟（成功登录会清零） */
async function bumpFail(a) {
  const pool = getPool();
  const n = Number(a.fail_count || 0) + 1;
  if (n >= MAX_FAIL) {
    await pool.query(
      'UPDATE admin_user SET fail_count = ?, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
      [n, LOCK_MINUTES, a.id]
    );
  } else {
    await pool.query('UPDATE admin_user SET fail_count = ? WHERE id = ?', [n, a.id]);
  }
}

module.exports = {
  COOKIE_NAME, SESSION_HOURS,
  hashPassword, verifyPassword, parseCookies,
  loadSession, login, setSessionCookie, clearSessionCookie, clientIp,
};