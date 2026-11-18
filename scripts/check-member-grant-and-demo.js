#!/usr/bin/env node
/**
 * 单独授权权限位 + 概览演示班过滤门禁（2026-11-18）
 * ============================================================
 * 用户口径：
 *   ① 辅导员概览页「各班规模」表格不该出现演示班（顶部下拉已过滤，表格曾漏）。
 *   ② admin 给其他账号配权限时，能决定对方能否改成员编辑弹窗里的三项
 *      「单独设置」：不排值日 / 班费消费授权 / 课前演讲授权 —— 做成 members.grant 位。
 *
 * 真跑方法体（vm sandbox + mock db）钉：
 *   A. perms：members.grant 是第 7 个操作位；老账号(只写 members)自动含它（不夺权）；
 *      只勾 members.edit 不会带出 grant；超管恒含。
 *   B. updateMember：无 grant 时 dutyOff/feePerms/speechPerm 三项不进 UPDATE；
 *      有 grant 时三项照常写库；姓名/职位等基础字段两种权限都能改。
 *   C. addMember：无 grant 时不把 feePerms/speechPerm 写进 INSERT。
 *   D. overview(true) 含演示班行；overview(false) 过滤演示班且 stats 口径不变。
 *   E. 前端：memberFormHTML 按 canGrant 分支、readMemberForm 带 canGrant、openMemberDialog 传权限。
 *
 * 用法：node scripts/check-member-grant-and-demo.js [--self-test]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloudfunctions/admin-web');
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');

const MEMBER_SRC = read('lib/mod-member.js');
const CONFIG_SRC = read('lib/mod-config.js');
const PERMS_SRC = read('lib/perms.js');
const APP_SRC = read('public/app.js');
const TEST_ACCOUNT = require(path.join(DIR, 'common/test-account.js'));

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

function loadPerms(src) {
  const sb = { module: { exports: {} }, exports: {}, JSON, Array, Object, String, Number };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(src || PERMS_SRC, sb, { filename: 'perms.js' });
  return sb.module.exports;
}

/** 加载 mod-member：captured 收集 UPDATE/INSERT 的 sets，session.perms 可配。 */
function loadMember(opts) {
  opts = opts || {};
  const captured = [];
  const memberRow = Object.assign({
    id: 5, name: '测试', student_no: '000000000001', class_id: 1,
    role: 'MEMBER', status: 'ACTIVE', group_tag: 'A', position: '',
    is_super: 0, fee_perms: '[]', speech_perm: 0, duty_off: 0, openid: null
  }, opts.member || {});
  const pool = {
    query(sql, args) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      captured.push({ sql: s, args });
      if (/^\s*SELECT\s+m\.\*/i.test(s)) return Promise.resolve([[Object.assign({}, memberRow)]]);
      if (/^\s*SELECT\s+COUNT\(\*\)/i.test(s)) return Promise.resolve([[{ c: 0 }]]);
      if (/^\s*SELECT\s+id,\s*name\s+FROM\s+`class`/i.test(s)) return Promise.resolve([[{ id: 1, name: '测试班' }]]);
      if (/^\s*SELECT\s+id\s+FROM\s+member\s+WHERE\s+student_no/i.test(s)) return Promise.resolve([[]]);
      if (/^\s*INSERT\s+INTO\s+member/i.test(s) || /^\s*UPDATE\s+member/i.test(s)) return Promise.resolve([{ insertId: 5, affectedRows: 1 }]);
      if (/^\s*SELECT\s/mi.test(s)) return Promise.resolve([[Object.assign({}, memberRow)]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    }
  };
  class BizError extends Error { constructor(c, m) { super(m); this.code = c; this.errCode = c; this.errMsg = m; } }
  const mockRequire = (r) => {
    if (r === '../common/db') return { getPool: () => pool };
    if (r === '../common/resp') return { BizError };
    if (r === './audit') return { logAction: async () => {} };
    if (r === './perms') return loadPerms();
    if (r === '../common/test-account') return TEST_ACCOUNT;
    if (r === '../common/fee-perms') return {
      FEE_PERM_KEYS: ['class', 'league'],
      normalizeFeePerms: (x) => (Array.isArray(x) ? x : []),
      stringifyFeePerms: (x) => JSON.stringify(Array.isArray(x) ? x : [])
    };
    return require(r);
  };
  const sb = { module: { exports: {} }, exports: {}, require: mockRequire, console: { error() {}, log() {} }, process, JSON, Array, Object, String, Number, Error, Date, Boolean, Math };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(MEMBER_SRC, sb, { filename: 'mod-member.js' });
  return { mod: sb.module.exports, captured };
}

/** 加载 mod-config：overview 用假 CLASS_ROWS，验证 canSeeDemo 过滤。 */
function loadConfig() {
  const pool = {
    query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT\s+c\.id, c\.name.*FROM\s+`class`/i.test(s)) {
        return Promise.resolve([[
          { id: 1, name: '真实班', is_active: 1, is_demo: 0, total_weeks: 16, term_start: '2026-01-01', memberCnt: 57, boundCnt: 50, sessionCnt: 28, dutyCnt: 100 },
          { id: 104, name: '演示班', is_active: 0, is_demo: 1, total_weeks: 16, term_start: '2026-01-01', memberCnt: 40, boundCnt: 40, sessionCnt: 13, dutyCnt: 288 }
        ]]);
      }
      if (/admin_user/i.test(s)) return Promise.resolve([[{ c: 3 }]]);
      if (/admin_audit_log/i.test(s)) return Promise.resolve([[{ c: 5 }]]);
      return Promise.resolve([[]]);
    }
  };
  class BizError extends Error { constructor(c, m) { super(m); this.code = c; } }
  const mockRequire = (r) => {
    if (r === '../common/db') return { getPool: () => pool };
    if (r === '../common/resp') return { BizError };
    if (r === '../common/test-account') return TEST_ACCOUNT;
    if (r === './audit') return { logAction: async () => {} };
    return require(r);
  };
  const sb = { module: { exports: {} }, exports: {}, require: mockRequire, console: { error() {}, log() {} }, process, JSON, Array, Object, String, Number, Error, Date, Boolean, Math };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(CONFIG_SRC, sb, { filename: 'mod-config.js' });
  return sb.module.exports;
}

(async () => {
  const P = loadPerms();

  section('A. perms：members.grant 权限位定义与展开');
  check(P.MEMBER_OP_KEYS.indexOf('members.grant') >= 0, 'members.grant 在操作位清单里');
  check(P.MEMBER_OP_KEYS.indexOf('members.grant') === P.MEMBER_OP_KEYS.length - 1,
    'members.grant 在数组末尾（老账号展开才含它，不被夺权）');
  const someone = { is_super: 0, position: '辅导员', group_tag: 'X', role: 'ADMIN' };
  check(P.resolve(someone, 'members').indexOf('members.grant') >= 0,
    '老账号（只写 members）自动含 members.grant');
  check(P.resolve(someone, 'members.edit').indexOf('members.grant') < 0,
    '只勾「编辑资料」不含「单独授权」');
  check(P.resolve(someone, 'members.edit,members.grant').indexOf('members.grant') >= 0,
    '显式勾 members.grant 才有');
  check(P.resolve({ is_super: 1 }, '').indexOf('members.grant') >= 0, '超管恒含 members.grant');
  check(P.isValidPermKey('members.grant'), 'isValidPermKey 认得 members.grant');

  section('B. updateMember：无 grant 时三项不写库（防越权 / 防伪造提交）');
  const patchNoGrant = {
    name: '改名', dutyOff: true, feePerms: ['class'], speechPerm: true
  };
  const r1 = loadMember({});
  await r1.mod.updateMember(5, Object.assign({}, patchNoGrant), { perms: ['members', 'members.edit'], memberId: 1 }, {});
  const upd1 = r1.captured.filter((c) => /^UPDATE member/i.test(c.sql)).pop();
  check(!!upd1, '无 grant：仍执行姓名等基础字段更新（不阻断正常编辑）');
  check(upd1 && upd1.sql.indexOf('name = ?') >= 0, '无 grant：name 照常写入');
  check(upd1 && upd1.sql.indexOf('duty_off') < 0, '无 grant：duty_off 不写');
  check(upd1 && upd1.sql.indexOf('fee_perms') < 0, '无 grant：fee_perms 不写');
  check(upd1 && upd1.sql.indexOf('speech_perm') < 0, '无 grant：speech_perm 不写');

  const r2 = loadMember({});
  await r2.mod.updateMember(5, Object.assign({}, patchNoGrant), { perms: ['members', 'members.edit', 'members.grant'], memberId: 1 }, {});
  const upd2 = r2.captured.filter((c) => /^UPDATE member/i.test(c.sql)).pop();
  check(upd2 && upd2.sql.indexOf('duty_off') >= 0, '有 grant：duty_off 照常写');
  check(upd2 && upd2.sql.indexOf('fee_perms') >= 0, '有 grant：fee_perms 照常写');
  check(upd2 && upd2.sql.indexOf('speech_perm') >= 0, '有 grant：speech_perm 照常写');

  section('C. addMember：无 grant 时不把单独授权塞进新增');
  const addPatch = {
    classId: 1, name: '新人', studentNo: '000000000099', groupTag: 'A',
    role: 'MEMBER', status: 'ACTIVE', position: '', feePerms: ['class'], speechPerm: true
  };
  const r3 = loadMember({});
  await r3.mod.addMember(Object.assign({}, addPatch), { perms: ['members', 'members.add'], memberId: 1 }, {});
  const ins3 = r3.captured.filter((c) => /^INSERT INTO member/i.test(c.sql)).pop();
  check(!!ins3, '无 grant：仍可新增成员');
  check(ins3 && ins3.args.indexOf('["class"]') < 0 && !String(ins3.args).includes('["class"]'),
    '无 grant：INSERT 参数里不带班费授权');
  check(ins3 && ins3.args[ins3.args.length - 1] === 0, '无 grant：speech_perm 落库为 0');

  section('D. overview：按 canSeeDemo 过滤演示班');
  const cfg = loadConfig();
  const ovSuper = await cfg.overview(true);
  check(ovSuper.classes.some((c) => c.id === 104), '超管 overview 含演示班行（可标「演示」）');
  const ovCoach = await cfg.overview(false);
  check(!ovCoach.classes.some((c) => c.id === 104), '辅导员 overview 不含演示班行');
  check(ovCoach.classes.some((c) => c.id === 1), '辅导员 overview 仍含真实班');
  check(ovCoach.stats.memberCount === 57, '辅导员 stats 口径不变（排除演示班）');

  section('E. 前端：按 canGrant 显隐三项');
  check(/function memberFormHTML\(m, canGrant\)/.test(APP_SRC), 'memberFormHTML 接收 canGrant');
  check(/var grantFields = canGrant \?/.test(APP_SRC), '三项字段包在 canGrant 分支');
  check(/function readMemberForm\(dlg, canGrant\)/.test(APP_SRC), 'readMemberForm 接收 canGrant');
  check(/if \(canGrant\) \{[\s\S]{0,400}body\.dutyOff/.test(APP_SRC), '无 grant 不提交 dutyOff');
  check(/var canGrant = canPerm\('members\.grant'\)/.test(APP_SRC), 'openMemberDialog 用 canPerm 取权限');
  check((APP_SRC.match(/memberFormHTML\([^)]*, canGrant\)/g) || []).length >= 2,
    '新增 / 编辑两处都传 canGrant');
  check(/无「单独授权」权限/.test(APP_SRC), '无权限时给出说明文案');

  section('F. 变异自证：把关键防护改坏必须被抓红');
  async function mut(label, badSrc, verify) {
    const ok = await verify(badSrc);
    if (ok) { pass++; console.log('  ✓ 抓红：' + label); }
    else { fail++; console.log('  ✗ 漏抓：' + label); }
  }
  // F.1 后端去掉 grant 校验 → 无权限时三项会被写库
  await mut('后端去掉 members.grant 校验',
    MEMBER_SRC.replace(
      "if (!permsMod.has(session && session.perms, 'members.grant')) {\n    delete patch.dutyOff;\n    delete patch.feePerms;\n    delete patch.speechPerm;\n  }",
      ''
    ),
    async (src) => {
      if (src === MEMBER_SRC) return false;
      // 用改坏后的源码跑一遍
      const bad = await runMemberSrc(src, patchNoGrant, { perms: ['members.edit'] });
      const upd = bad.captured.filter((c) => /^UPDATE member/i.test(c.sql)).pop();
      return upd && upd.sql.indexOf('duty_off') >= 0;
    }
  );

  console.log('\n' + '='.repeat(50));
  console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

/** 用指定源码跑 updateMember（变异用） */
async function runMemberSrc(src, patch, session) {
  const captured = [];
  const memberRow = { id: 5, name: '测试', student_no: '000000000001', class_id: 1, role: 'MEMBER', status: 'ACTIVE', group_tag: 'A', position: '', is_super: 0, fee_perms: '[]', speech_perm: 0, duty_off: 0 };
  const pool = {
    query(sql) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      captured.push({ sql: s });
      if (/^\s*SELECT\s+m\.\*/i.test(s)) return Promise.resolve([[memberRow]]);
      if (/^\s*SELECT\s+COUNT\(\*\)/i.test(s)) return Promise.resolve([[{ c: 0 }]]);
      if (/^\s*SELECT\s/mi.test(s)) return Promise.resolve([[memberRow]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    }
  };
  class BizError extends Error { constructor(c, m) { super(m); this.code = c; } }
  const mockRequire = (r) => {
    if (r === '../common/db') return { getPool: () => pool };
    if (r === '../common/resp') return { BizError };
    if (r === './audit') return { logAction: async () => {} };
    if (r === './perms') return loadPerms();
    if (r === '../common/test-account') return TEST_ACCOUNT;
    if (r === '../common/fee-perms') return { FEE_PERM_KEYS: ['class', 'league'], normalizeFeePerms: (x) => x || [], stringifyFeePerms: (x) => JSON.stringify(x || []) };
    return require(r);
  };
  const sb = { module: { exports: {} }, exports: {}, require: mockRequire, console: { error() {}, log() {} }, process, JSON, Array, Object, String, Number, Error, Date, Boolean, Math };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: 'bad.js' });
  // updateMember 内部多次 await pool.query，必须 await 完整跑完才收集得到 UPDATE
  await sb.module.exports.updateMember(5, Object.assign({}, patch), session, {});
  return { captured };
}
