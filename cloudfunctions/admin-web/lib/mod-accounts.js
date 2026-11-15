/**
 * 后台账号开通（模块：accounts）· 2026-11-15 新增 · 仅超管
 * ============================================================
 * 与既有的 `mod-config.listAdminUsers / updateAdminUser` 分工：
 *   · 那两个管「已有账号」的密码与启停；
 *   · 本模块管**从班级成员里挑一个人开通后台**，并按职位预填权限。
 *   之所以要分开：开通需要「列候选成员 + 判重 + 生成初始密码 + 推导权限」，
 *   塞进原来的模块会让那个已经很长的方法再长一截，且两者权限要求不同。
 *
 * 三个必须守住的点：
 *   ① **初始密码只回显一次**：库里只存 scrypt 哈希，页面刷新后再也拿不到，
 *      丢了只能重置。前端必须提示「现在记下来」。
 *   ② 开通/改权限/停用之后**立刻吊销该账号所有会话**：
 *      否则一个被降权的账号还能用旧 Cookie 继续操作最多 12 小时。
 *   ③ 不能停用/删除**自己**（自锁）：超管把自己的账号停了，就没人能进后台了。
 */
const crypto = require('crypto');
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { logAction } = require('./audit');
const { NOT_TEST } = require('../common/test-account');
const auth = require('./auth');
const permsMod = require('./perms');

/** 去掉 0/O/1/l/I 等易混字符：这个密码要有人在手机上手输 */
const PWD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genPassword(len) {
  const n = len || 10;
  const bytes = crypto.randomBytes(n * 4);
  let out = '';
  for (let i = 0; out.length < n && i < bytes.length; i++) {
    // 取模会有极轻微偏差，对「初始密码」这个用途完全够用（不是加密密钥）
    out += PWD_CHARS[bytes[i] % PWD_CHARS.length];
  }
  return out;
}

/** 列表：该班所有可能开通后台的人 + 已开通账号现状 */
async function listAccounts(q, session) {
  const pool = getPool();
  const classId = Number(q.classId);
  if (!classId) throw new BizError(40001, '缺少班级');

  const kw = String(q.keyword || '').trim();
  const args = [classId];
  let extra = '';
  if (kw) { extra = ' AND (m.name LIKE ? OR m.student_no LIKE ?)'; args.push('%' + kw + '%', '%' + kw + '%'); }

  // 辅导员是全校账号：class_id 恒为 0、group_tag='X'（见 class-scope.js / util.js tier=counselor）。
  // 若只按 m.class_id = ? 过滤，辅导员在**任何**班的候选列表里都看不到 —— 2026-11-15 实锤：
  // 陈慧芳（id=294, class_id=0, group_tag=X, 学号 STAFFV7E9FS）被挡在候选外。
  // 所以教职工（X）单独放行：他们跨班管理，给一个班开通就等于给全校开通。
  // 演示班 / 测试号仍由 NOT_TEST 与上层 classId 白名单挡住。
  const [rows] = await pool.query(
    'SELECT m.id, m.name, m.student_no, m.group_tag, m.role, m.position, m.status, m.is_super, ' +
    'a.id AS admin_id, a.username, a.status AS admin_status, a.perms, a.last_login_at, ' +
    'a.last_login_ip, a.created_at AS admin_created_at ' +
    'FROM member m LEFT JOIN admin_user a ON a.member_id = m.id ' +
    'WHERE (m.class_id = ? OR m.group_tag = \'X\') AND m.status <> \'DISABLED\' AND ' + NOT_TEST('m') + extra + ' ' +
    'ORDER BY (a.id IS NULL) ASC, m.role = \'MEMBER\' ASC, m.group_tag, m.name',
    args
  );

  const accounts = [];
  const candidates = [];
  rows.forEach((r) => {
    const tmpl = permsMod.resolve(r, r.perms || '');
    const base = {
      memberId: r.id, memberName: r.name, studentNo: r.student_no,
      groupTag: r.group_tag, role: r.role, position: r.position || '',
      isSuper: Number(r.is_super) === 1,
      // 「按职位应有」的权限：前端在选择时给个默认勾选，避免超管每次手点
      templatePerms: tmpl
    };
    if (r.admin_id) {
      accounts.push(Object.assign(base, {
        adminId: r.admin_id,
        username: r.username,
        status: Number(r.admin_status),
        permsRaw: r.perms || '',
        perms: tmpl,
        lastLoginAt: r.last_login_at ? String(r.last_login_at).slice(0, 16) : '',
        lastLoginIp: r.last_login_ip || '',
        createdAt: r.admin_created_at ? String(r.admin_created_at).slice(0, 10) : ''
      }));
    } else {
      candidates.push(base);
    }
  });

  return {
    accounts,
    candidates,
    // 前端「新增账号」弹层要展示「这个职位默认给什么权限」
    positionTemplates: permsMod.POSITION_PERMS,
    views: permsMod.VIEWS
  };
}

async function createAccount(p, session, req) {
  const pool = getPool();
  const memberId = Number(p.memberId);
  const username = String(p.username || '').trim();
  if (!memberId) throw new BizError(40001, '请选择成员');
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(username)) {
    throw new BizError(40001, '账号需 4–32 位，字母开头，只允许字母/数字/下划线');
  }

  const [ms] = await pool.query(
    'SELECT id, name, class_id, status, is_super, position, group_tag, role FROM member WHERE id = ? LIMIT 1',
    [memberId]
  );
  const m = ms[0];
  if (!m) throw new BizError(40404, '成员不存在');
  if (m.status !== 'ACTIVE') throw new BizError(40001, '该成员已停用，不能开通后台');
  // 测试账号是内部调试数据，给它开后台等于把假账号坐实成真权限（与 setSuper 同一口径）
  // ⚠️ NOT_TEST('m') 会生成 `m.student_no NOT LIKE ...`，所以 FROM 必须带别名 m，
  //    否则 SQL 报「Unknown column 'm.student_no'」——这条 SQL 曾经没有别名。
  const [ts] = await pool.query('SELECT m.id FROM member m WHERE m.id = ? AND ' + NOT_TEST('m') + ' LIMIT 1', [memberId]);
  if (!ts[0]) throw new BizError(40001, '不能给测试账号开通后台');

  const [dup] = await pool.query('SELECT id FROM admin_user WHERE member_id = ? LIMIT 1', [memberId]);
  if (dup[0]) throw new BizError(40001, '该成员已经有后台账号了');

  const [un] = await pool.query('SELECT id FROM admin_user WHERE username = ? LIMIT 1', [username]);
  if (un[0]) throw new BizError(40001, '账号名已被占用，换一个');

  let perms = null;
  if (Array.isArray(p.perms)) {
    perms = p.perms
      .map((x) => String(x).trim())
      .filter((x) => permsMod.ALL_VIEWS.indexOf(x) >= 0)
      // 超管专属页签不允许通过「显式授权」下发，否则等于开后门
      .filter((x) => permsMod.SUPER_ONLY.indexOf(x) < 0);
  }
  const permsRaw = perms && perms.length ? perms.join(',') : '';
  const finalPerms = permsMod.resolve(m, permsRaw);
  if (!finalPerms.length) throw new BizError(40001, '该职位没有可用的后台权限，请先设置职位或手工勾选');

  const pwd = String(p.password || '').trim() || genPassword(10);
  if (pwd.length < 6) throw new BizError(40001, '初始密码至少 6 位');

  const [ins] = await pool.query(
    'INSERT INTO admin_user (username, pass_hash, member_id, perms, status) VALUES (?,?,?,?,1)',
    [username, auth.hashPassword(pwd), memberId, permsRaw]
  );

  await logAction(session, {
    module: 'account',
    action: 'account.create',
    classId: m.class_id,
    summary: '开通后台：' + m.name + '（' + username + '），权限 ' + finalPerms.join('/'),
    // ⚠️ 绝不把明文密码写进审计表：审计是长期留存、多人可查的
    detail: { adminId: ins.insertId, memberId, username, perms: finalPerms, permsRaw }
  }, req);

  return {
    adminId: ins.insertId, username, password: pwd, perms: finalPerms,
    // 提示前端：这是唯一一次能看到明文密码
    passwordOnce: true
  };
}

async function updateAccount(p, session, req) {
  const pool = getPool();
  const id = Number(p.id);
  if (!id) throw new BizError(40001, '缺少账号 ID');

  const [as] = await pool.query('SELECT * FROM admin_user WHERE id = ? LIMIT 1', [id]);
  const a = as[0];
  if (!a) throw new BizError(40404, '账号不存在');

  const [ms] = await pool.query(
    'SELECT id, name, class_id, is_super, position, group_tag, role FROM member WHERE id = ? LIMIT 1',
    [a.member_id]
  );
  const m = ms[0];
  if (!m) throw new BizError(40404, '账号对应的成员已不存在');

  const sets = [];
  const args = [];
  const changes = [];

  // ---- 权限 ----
  if (p.perms !== undefined) {
    let arr = Array.isArray(p.perms) ? p.perms : String(p.perms || '').split(',');
    arr = arr.map((x) => String(x).trim())
      .filter((x) => x && permsMod.ALL_VIEWS.indexOf(x) >= 0)
      .filter((x) => permsMod.SUPER_ONLY.indexOf(x) < 0);
    // 空数组 = 回到「按职位模板实时推导」，不是「没有任何权限」
    const raw = arr.join(',');
    const finalPerms = permsMod.resolve(m, raw);
    if (!finalPerms.length) throw new BizError(40001, '至少要给一个页签权限');
    sets.push('perms = ?'); args.push(raw);
    changes.push('权限 → ' + finalPerms.join('/'));
  }

  // ---- 启停 ----
  if (p.status !== undefined) {
    const st = Number(p.status) ? 1 : 0;
    if (!st && Number(a.member_id) === Number(session.memberId)) {
      throw new BizError(40001, '不能停用自己的账号（会导致没人能进后台）');
    }
    sets.push('status = ?'); args.push(st);
    changes.push(st ? '启用' : '停用');
  }

  // ---- 重置密码 ----
  let newPwd = '';
  if (p.password !== undefined && String(p.password).trim()) {
    newPwd = String(p.password).trim();
    if (newPwd.length < 6) throw new BizError(40001, '新密码至少 6 位');
    sets.push('pass_hash = ?'); args.push(auth.hashPassword(newPwd));
    sets.push('fail_count = 0'); sets.push('locked_until = NULL');
    changes.push('重置密码');
  }

  if (!sets.length) throw new BizError(40001, '没有要修改的内容');
  args.push(id);
  await pool.query('UPDATE admin_user SET ' + sets.join(', ') + ' WHERE id = ?', args);

  // ② 权限 / 密码 / 状态一变，立刻吊销该账号所有会话
  await pool.query('DELETE FROM admin_session WHERE admin_id = ?', [id]);

  await logAction(session, {
    module: 'account',
    action: 'account.update',
    classId: m.class_id,
    summary: '修改后台账号 ' + a.username + '：' + changes.join('、'),
    detail: { adminId: id, memberId: a.member_id, changes }
  }, req);

  return { changed: changes, password: newPwd || undefined };
}

async function removeAccount(p, session, req) {
  const pool = getPool();
  const id = Number(p.id);
  if (!id) throw new BizError(40001, '缺少账号 ID');
  const [as] = await pool.query('SELECT * FROM admin_user WHERE id = ? LIMIT 1', [id]);
  const a = as[0];
  if (!a) throw new BizError(40404, '账号不存在');
  if (Number(a.member_id) === Number(session.memberId)) {
    throw new BizError(40001, '不能删除自己的账号');
  }
  // 最后一个超管账号也不许删 —— 删了就再也没人能管理后台
  const [ms] = await pool.query('SELECT name, class_id, is_super FROM member WHERE id = ? LIMIT 1', [a.member_id]);
  const m = ms[0] || {};
  if (Number(m.is_super) === 1) {
    const [cnt] = await pool.query(
      'SELECT COUNT(*) AS n FROM admin_user a JOIN member m ON m.id = a.member_id ' +
      "WHERE a.status = 1 AND m.is_super = 1 AND m.status = 'ACTIVE'"
    );
    if (Number(cnt[0].n) <= 1) throw new BizError(40001, '这是最后一个超管账号，不能删除');
  }

  await pool.query('DELETE FROM admin_session WHERE admin_id = ?', [id]);
  await pool.query('DELETE FROM admin_user WHERE id = ?', [id]);

  await logAction(session, {
    module: 'account',
    action: 'account.delete',
    classId: m.class_id || 0,
    summary: '删除后台账号 ' + a.username + '（' + (m.name || a.member_id) + '）',
    detail: { adminId: id, memberId: a.member_id, username: a.username }
  }, req);
  return {};
}

module.exports = { listAccounts, createAccount, updateAccount, removeAccount, genPassword };
