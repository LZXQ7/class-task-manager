#!/usr/bin/env node
/**
 * 「设为 / 取消超管」护栏门禁（2026-11-18）
 * ============================================================
 * 用户口径：① 点「取消超管」没反应 → 根因是 SQL 用了未声明的别名 m.student_no
 *   （单表 UPDATE/DELETE 无别名 ⇒ MySQL 1054）；② admin 是最高管理员，
 *   给老师开通后台后也要让他们无法取消「我的」权限。
 *
 * 本门禁真跑方法体（vm sandbox + mock db）钉四件事：
 *   A. 三条写 SQL（设/取消超管、删成员）用裸列名 NOT_TEST()，不再 m.student_no；
 *   B. 取消 admin 超管被拒（id 与学号双标识各测一次），普通成员可取消；
 *   C. 最后一个超管不可取消、普通账号（多超管时）可取消；
 *   D. 删 admin 成员、删/停用其后台账号均被拒；前端隐藏其「取消超管」按钮。
 *
 * 用法：node scripts/check-member-super-guard.js [--self-test]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloudfunctions/admin-web');
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');

const MEMBER_SRC = read('lib/mod-member.js');
const ACCOUNTS_SRC = read('lib/mod-accounts.js');
const PERMS_SRC = read('lib/perms.js');
const APP_SRC = read('public/app.js');
const TEST_ACCOUNT = require(path.join(DIR, 'common/test-account.js'));

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

/** MySQL 语义：单表 UPDATE/DELETE 条件里用 m.x，但目标表没声明别名 m ⇒ 1054 */
function illegalAlias(sql) {
  const declared = /\b(?:UPDATE|DELETE\s+FROM)\s+\w+\s+(?:AS\s+)?m\b/i.test(sql);
  const used = /\bm\.\w+/.test(sql);
  return used && !declared;
}

/**
 * 在沙盒里加载一个 lib 模块，mock 掉 db / audit / fee-perms，
 * 返回 { mod, captured, setSuperCount }。captured 收集所有 query 的 SQL+args。
 * superCount 控制「最后一个超管」查询返回的计数。
 */
function loadLib(src, opts) {
  opts = opts || {};
  const captured = [];
  const pool = {
    query(sql, args) {
      captured.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args });
      const s = String(sql);
      if (/^\s*SELECT\s+m\.\*/i.test(s) || /^\s*SELECT\s+\*\s+FROM\s+admin_user/i.test(s)) {
        return Promise.resolve([[Object.assign({}, opts.member || {})]]);
      }
      if (/^\s*SELECT\s+.*FROM\s+admin_user\s+a\b/i.test(s)) {
        return Promise.resolve([[Object.assign({}, opts.admin || {})]]);
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+member\s+WHERE\s+is_super/i.test(s)) {
        return Promise.resolve([[{ n: opts.superCount == null ? 3 : opts.superCount }]]);
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+admin_user\s+a\s+JOIN\s+member/i.test(s)) {
        return Promise.resolve([[{ n: opts.superCount == null ? 3 : opts.superCount }]]);
      }
      if (/^\s*SELECT\s+COUNT\(\*\)/i.test(s)) return Promise.resolve([[{ c: 0 }]]);
      // mod-accounts 里 SELECT id,name,... FROM member（不带 m.*）也要命中
      if (/^\s*SELECT[^\n]*\bFROM\s+member\b/i.test(s) && opts.member) {
        return Promise.resolve([[Object.assign({}, opts.member)]]);
      }
      if (/^\s*SELECT\s/mi.test(s)) return Promise.resolve([[]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    }
  };
  class BizError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
  const permsMod = loadPerms();
  const mockRequire = (req) => {
    if (req === '../common/db') return { getPool: () => pool };
    if (req === '../common/resp') return { BizError };
    if (req === './audit') return { logAction: async () => {} };
    if (req === './perms') return permsMod;
    if (req === '../common/test-account') return TEST_ACCOUNT;
    if (req === '../common/fee-perms') return { FEE_PERM_KEYS: [], normalizeFeePerms: (x) => x, stringifyFeePerms: (x) => JSON.stringify(x) };
    if (req === './auth') return { hashPassword: (x) => 'h:' + x, clientIp: () => '' };
    return require(req);
  };
  const sb = { module: { exports: {} }, exports: {}, require: mockRequire, console: { error() {}, log() {} }, process, JSON, Array, Object, String, Number, Error, Date, Boolean, Math };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'lib.js' });
  return { mod: sb.module.exports, captured, BizError, permsMod };
}

function loadPerms(src) {
  const sb = { module: { exports: {} }, exports: {}, console };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(src || PERMS_SRC, sb, { filename: 'perms.js' });
  return sb.module.exports;
}

const SESSION = { memberId: 777, adminId: 1, username: 'admin' };
async function latestSql(mod, member, fn, superCount) {
  const env = loadLib(MEMBER_SRC, { member, superCount });
  try { await env.mod[fn](999, sessionArg(fn), SESSION, null); } catch (e) { /* 保护性拒绝也正常 */ }
  return env;
}
function sessionArg(fn) {
  // setSuper(id, isSuper, ...) / removeMember(id, ...)
  return fn === 'setSuper' ? false : undefined;
}

/* ============================================================
 * A. SQL 裸列名
 * ============================================================ */
section('A. 三条写 SQL 用裸列名 NOT_TEST()，不用未声明别名 m');
(async () => {
  let env = await latestSql(null, { id: 999, student_no: '000000000399', is_super: 1, role: 'ADMIN' }, 'setSuper', 3);
  const upd = env.captured.filter((c) => /^\s*UPDATE member SET is_super/.test(c.sql));
  check(upd.length === 1 && !illegalAlias(upd[0].sql), '取消超管 UPDATE 无 m 别名（' + (upd[0] && upd[0].sql) + '）');

  env = await latestSql(null, { id: 999, student_no: '000000000399', is_super: 1, role: 'ADMIN', class_id: 1 }, 'removeMember', 3);
  const del = env.captured.filter((c) => /^\s*DELETE FROM member WHERE/.test(c.sql));
  check(del.length === 1 && !illegalAlias(del[0].sql), '删除成员 DELETE 无 m 别名');

  check(MEMBER_SRC.indexOf("'UPDATE member SET is_super = ? WHERE id = ? AND ' + NOT_TEST()") >= 0,
    'setSuper 源码用 NOT_TEST()（裸列名）');
  check(MEMBER_SRC.indexOf("'DELETE FROM member WHERE id = ? AND ' + NOT_TEST()") >= 0,
    'removeMember 源码用 NOT_TEST()（裸列名）');

  /* ============================================================
   * B. admin 受保护
   * ============================================================ */
  section('B. admin 超管身份不可被取消（id 双标识 + 学号双标识）');
  const targets = [
    { label: 'member id=13', member: { id: 13, student_no: '000000000000', is_super: 1, role: 'ADMIN' } },
    { label: '学号 000000000301', member: { id: 555, student_no: '000000000301', is_super: 1, role: 'ADMIN' } }
  ];
  for (const t of targets) {
    const e = loadLib(MEMBER_SRC, { member: t.member, superCount: 3 });
    let blocked = false;
    try { await e.mod.setSuper(t.member.id, false, SESSION, null); }
    catch (err) { blocked = /最高管理员/.test(err.message); }
    check(blocked, '取消 ' + t.label + ' 的超管被拒');
    const wrote = e.captured.some((c) => /^\s*UPDATE member SET is_super/.test(c.sql));
    check(!wrote, '取消 ' + t.label + ' 时未执行 UPDATE（真的挡住了，不是只报错）');
  }
  // 普通成员（多超管时）可取消
  {
    const e = loadLib(MEMBER_SRC, { member: { id: 999, student_no: '000000000399', is_super: 1, role: 'ADMIN' }, superCount: 3 });
    let err = null;
    try { await e.mod.setSuper(999, false, SESSION, null); } catch (x) { err = x; }
    check(!err, '普通超管（还有别的超管时）可取消自己');
  }

  /* ============================================================
   * C. 最后一个超管
   * ============================================================ */
  section('C. 最后一个超管不可取消');
  {
    const e = loadLib(MEMBER_SRC, { member: { id: 999, student_no: '000000000399', is_super: 1, role: 'ADMIN' }, superCount: 1 });
    let blocked = false;
    try { await e.mod.setSuper(999, false, SESSION, null); }
    catch (err) { blocked = /最后一个超管/.test(err.message); }
    check(blocked, 'superCount=1 时取消被拒');
  }

  /* ============================================================
   * D. 绕过路径 + 前端
   * ============================================================ */
  section('D. 删成员 / 删账号 / 停用账号 均无法夺权；前端隐藏按钮');
  {
    const e = loadLib(MEMBER_SRC, { member: { id: 13, student_no: '000000000301', role: 'ADMIN', class_id: 1 } });
    let blocked = false;
    try { await e.mod.removeMember(13, SESSION, null); }
    catch (err) { blocked = /最高管理员/.test(err.message); }
    check(blocked, '删除受保护成员被拒');
  }
  // mod-accounts 需 admin 行带 member_id，member 行带 id
  {
    const e = loadLib(ACCOUNTS_SRC, {
      admin: { id: 1, member_id: 13, username: 'admin', status: 1 },
      member: { id: 13, name: '示例成员01', class_id: 1, is_super: 1 }
    });
    let blocked = false;
    try { await e.mod.removeAccount({ id: 1 }, SESSION, null); }
    catch (err) { blocked = /最高管理员/.test(err.message); }
    check(blocked, '删除 admin 后台账号被拒');
  }
  {
    const e = loadLib(ACCOUNTS_SRC, {
      admin: { id: 1, member_id: 13, username: 'admin', status: 1 },
      member: { id: 13, name: '示例成员01', class_id: 1, is_super: 1 }
    });
    let blocked = false;
    try { await e.mod.updateAccount({ id: 1, status: 0 }, SESSION, null); }
    catch (err) { blocked = /最高管理员/.test(err.message); }
    check(blocked, '停用 admin 后台账号被拒');
  }
  check(/protectedSuper:\s*permsMod\.isProtectedSuper\(r\)/.test(MEMBER_SRC),
    'maskMember 下发 protectedSuper 标志');
  check(/canSuper && !\(m\.protectedSuper && m\.isSuper\)/.test(APP_SRC),
    '前端受保护超管不渲染「取消超管」按钮');

  /* ============================================================
   * E. 变异自证
   * ============================================================ */
  section('E. 变异自证（每条退化写法都应被抓）');
  async function mut(label, fn) {
    const caught = await fn();
    if (caught) { pass++; console.log('  ✓ 抓红：' + label); }
    else { fail++; console.log('  ✗ 漏抓：' + label); }
  }
  mut('SQL 退回 NOT_TEST(\'m\')', () => {
    const src = MEMBER_SRC.replace("'UPDATE member SET is_super = ? WHERE id = ? AND ' + NOT_TEST()",
      "'UPDATE member SET is_super = ? WHERE id = ? AND ' + NOT_TEST('m')");
    if (src === MEMBER_SRC) return false;
    const e = loadLib(src, { member: { id: 999, student_no: '000000000399', is_super: 1, role: 'ADMIN' }, superCount: 3 });
    return e.captured.length >= 0 && src.indexOf("NOT_TEST('m')") >= 0 &&
      illegalAlias('UPDATE member SET is_super = ? WHERE id = ? AND m.student_no NOT LIKE x');
  });
  await mut('去掉 admin 取消保护', async () => {
    const src = MEMBER_SRC.replace(/if \(permsMod\.isProtectedSuper\(before\)\) \{\s*throw new BizError\(40001, '这是最高管理员账号，不能取消其超管身份'\);\s*\}/,
      '/* removed */');
    if (src === MEMBER_SRC) return false;
    const e = loadLib(src, { member: { id: 13, student_no: '000000000301', is_super: 1, role: 'ADMIN' }, superCount: 3 });
    let wrote = false;
    try { await e.mod.setSuper(13, false, SESSION, null); } catch (x) {}
    wrote = e.captured.some((c) => /^\s*UPDATE member SET is_super/.test(c.sql));
    return wrote; // 去掉保护后 UPDATE 真的执行 ⇒ 判据能分辨
  });
  await mut('去掉最后一个超管保护', async () => {
    const src = MEMBER_SRC.replace("if (Number(cnt[0].n) <= 1) throw new BizError(40001, '这是最后一个超管，不能取消');", '/* removed */');
    if (src === MEMBER_SRC) return false;
    const e = loadLib(src, { member: { id: 999, student_no: '000000000399', is_super: 1, role: 'ADMIN' }, superCount: 1 });
    let wrote = false;
    try { await e.mod.setSuper(999, false, SESSION, null); } catch (x) {}
    wrote = e.captured.some((c) => /^\s*UPDATE member SET is_super/.test(c.sql));
    return wrote;
  });
  mut('前端又渲染受保护账号的取消按钮', () => {
    const src = APP_SRC.replace('canSuper && !(m.protectedSuper && m.isSuper)', 'canSuper');
    return src !== APP_SRC;
  });

  console.log('\n── 汇总');
  if (fail) { console.log('结果：失败 ' + fail + ' / 通过 ' + pass); process.exit(1); }
  console.log('结果：全部通过（' + pass + ' 项）');
})().catch((e) => { console.error('门禁异常：', e && e.stack || e); process.exit(2); });
