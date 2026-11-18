#!/usr/bin/env node
/**
 * 成员页「操作级权限」门禁（2026-11-16）
 * ============================================================
 * 用户口径：「我添加账号可随时修改其他账号的权限，并且修改其他账号权限时可对
 *   该账号查看成员页可用的权限增加更具体的设置。」
 *
 * 改造前：`members` 是一个开关 —— 能进成员页 = 能改资料 + 能设超管 + 能删人。
 * 改造后：`members` 只表示「能进页面 / 能读名单」，写操作各自一个权限位：
 *   members.view / members.add / members.edit / members.import / members.remove / members.super
 *
 * 本门禁挡四类事故：
 *   ① 后端某个成员写接口又退回挂 `members`（等于细粒度没生效，越权口）；
 *   ② resolve() 的父子展开写错 —— 勾「只读」却顺手拿到删除/设超管的权限（**最危险**）；
 *   ③ 前端把危险按钮无条件渲染（有权限的人点了 403，或没权限的人戳一下就知道接口存在）；
 *   ④ 前端把「成员」又当普通页签勾选（那样 6 个操作位永远发不出去）。
 *
 * 用法：node scripts/check-admin-member-ops.js [--self-test]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloudfunctions/admin-web');
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

const PERMS_SRC = read('lib/perms.js');
const IDX = stripJs(read('index.js'));
const APP = read('public/app.js');
const ACCOUNTS = read('lib/mod-accounts.js');

/** 真跑 perms.js —— 展开规则必须由它自己的实现回答，不是靠正则猜 */
function loadPerms(src) {
  const sb = { module: { exports: {} }, exports: {}, console };
  sb.exports = sb.module.exports;
  vm.createContext(sb);
  vm.runInContext(src || PERMS_SRC, sb, { filename: 'perms.js' });
  return sb.module.exports;
}
const P = loadPerms();
const onlyMembers = (arr) => (arr || []).filter((k) => String(k).indexOf('members') === 0);

/* ============================================================
 * ① 权限位定义
 * ============================================================ */
section('① 7 个操作位定义齐全，且都是 members.* 命名');

check(Array.isArray(P.MEMBER_OPS) && P.MEMBER_OPS.length === 7,
  'MEMBER_OPS 有 7 项（实际 ' + (P.MEMBER_OPS || []).length + '）');
const keys = (P.MEMBER_OPS || []).map((o) => o.key);
['members.view', 'members.add', 'members.edit', 'members.import', 'members.remove', 'members.super', 'members.grant'].forEach((k) => {
  check(keys.indexOf(k) >= 0, '有 ' + k);
});
check(keys.every((k) => k.indexOf('members.') === 0), '全部以 members. 开头（命名空间统一）');
check((P.MEMBER_OPS || []).every((o) => o.label && o.desc), '每项都有 label 与 desc（前端要显示说明）');
check(P.ALL_PERM_KEYS.indexOf('members') >= 0 && P.ALL_PERM_KEYS.indexOf('members.edit') >= 0,
  'ALL_PERM_KEYS 同时收页签与操作位（parsePerms 才不会把子项过滤掉）');
check(P.parsePerms('members.view,members.super').length === 2, 'parsePerms 认得子项');
check(P.parsePerms('members.foo,fee').join(',') === 'fee', 'parsePerms 挡掉不存在的子项');

/* ============================================================
 * ② 父子展开：勾多宽就只能多宽（越权就从这里漏）
 * ============================================================ */
section('② resolve() 展开规则：给多少就多少，绝不顺手提权');

const someone = { is_super: 0, position: '辅导员', group_tag: 'X', role: 'ADMIN' };
const legacy = onlyMembers(P.resolve(someone, 'members')).sort();
check(legacy.length === 8 && legacy.indexOf('members') >= 0 && legacy.indexOf('members.grant') >= 0,
  '老数据（只写 members）→ 展开成父级 + 全部 7 项（含单独授权，老账号不被夺权）');

const viewOnly = onlyMembers(P.resolve(someone, 'members.view')).sort();
check(viewOnly.join(',') === 'members,members.view',
  '只勾「查看」→ 只有 members + members.view（不白送编辑/删除/超管），实测 ' + viewOnly.join(','));

const editOnly = onlyMembers(P.resolve(someone, 'members.edit')).sort();
check(editOnly.indexOf('members.remove') < 0 && editOnly.indexOf('members.super') < 0,
  '只勾「编辑」不会带出「删除 / 设超管」');
check(editOnly.indexOf('members.view') >= 0 && editOnly.indexOf('members') >= 0,
  '勾了写操作自动补「能进页面 + 能看名单」（否则按钮点了也是 403）');
check(editOnly.indexOf('members.grant') < 0,
  '勾「编辑资料」不会白送「单独授权」（三项单独设置必须单独勾，2026-11-18）');

const noMembers = P.resolve(someone, 'fee');
check(onlyMembers(noMembers).length === 0, '完全不勾成员 → 一个成员权限位都不下发');

const superAll = onlyMembers(P.resolve({ is_super: 1 }, ''));
check(superAll.length === 8, '超管恒含全部操作位（含 members.super / members.grant）');

check(P.resolve(someone, 'members,audit').indexOf('audit') < 0,
  '显式勾 audit 仍被 SUPER_ONLY 过滤（细粒度没有开后门）');

/* ============================================================
 * ③ 后端每个成员写接口挂对应操作位
 * ============================================================ */
section('③ 后端接口权限：写操作各自挂子项');

function routePerm(method, p) {
  const re = new RegExp("app\\." + method.toLowerCase() + "\\(\\s*'" + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'\\s*,\\s*requirePerm\\(\\s*'([^']+)'");
  const m = re.exec(IDX);
  return m ? m[1] : '';
}
check(routePerm('post', '/api/members') === 'members.add', 'POST /api/members → members.add');
check(routePerm('post', '/api/members/:id/super') === 'members.super', 'POST /api/members/:id/super → members.super');
check(routePerm('post', '/api/members/:id/delete') === 'members.remove', 'POST /api/members/:id/delete → members.remove');
check(routePerm('post', '/api/members/:id') === 'members.edit', 'POST /api/members/:id → members.edit');
check(routePerm('post', '/api/classes/:id/roster') === 'members.import', 'POST /api/classes/:id/roster → members.import');
check(routePerm('post', '/api/classes/:id/roster/preview') === 'members.import',
  'POST /api/classes/:id/roster/preview → members.import（预览也要，防止有人拿预览刷库）');

// 危险子路由必须排在 /:id 之前，否则被 :id 吃掉 → 落到 members.edit（越权）
const iEdit = IDX.indexOf("app.post('/api/members/:id',");
const iSuper = IDX.indexOf("app.post('/api/members/:id/super',");
const iDel = IDX.indexOf("app.post('/api/members/:id/delete',");
check(iSuper > 0 && iDel > 0 && iEdit > 0 && iSuper < iEdit && iDel < iEdit,
  '/super 与 /delete 声明在 /:id 之前（否则会被 :id 抢先匹配）');

// 旧写法不许回来：__action 分流等于把三个权限压回一个
check(!/__action\s*===\s*'setSuper'/.test(IDX) && !/__action\s*===\s*'remove'/.test(IDX),
  'index.js 不再用 __action 把设超管/删除塞进同一个路由');

/* ============================================================
 * ④ 前端：按钮按权限显隐，「成员」是分组不是开关
 * ============================================================ */
section('④ 前端：按同一批 key 显隐，成员变成分组');

check(/function canPerm\(/.test(APP) && /state\.perms\.indexOf\(key\)/.test(APP),
  'app.js 有 canPerm(key)（精确匹配 state.perms）');
['members.add', 'members.edit', 'members.super', 'members.remove', 'members.import'].forEach((k) => {
  check(new RegExp("canPerm\\('" + k.replace('.', '\\.') + "'\\)").test(APP), 'renderMember 用到 ' + k);
});
check(/canEdit \? '<button class="link" data-m-edit=/.test(APP), '「编辑」按钮按 members.edit 显隐');
check(/canDel \? '<button class="link link-danger" data-m-del=/.test(APP), '「删除」按钮按 members.remove 显隐');
// 2026-11-18：受保护账号（admin）不渲染取消按钮，条件变成 canSuper && !(...)；
// 仍以 canSuper && 开头即为「按 members.super 显隐」，新门禁 check-member-super-guard
// 专门守 protectedSuper 那部分。
check(/canSuper[\s\S]{0,80}?data-m-super=/.test(APP) && /canSuper &&/.test(APP),
  '「设为超管」按钮按 members.super 显隐');

check(/v\.key === 'members'/.test(APP) && /perm-group/.test(APP),
  'permChecks 把 members 特判成分组（否则 6 个操作位永远发不出去）');
check(/state\.memberOps/.test(APP), '前端用后端下发的 state.memberOps（不写死枚举）');
check(/d\.data\.memberOps/.test(APP), 'load() 缓存 memberOps');
check(/memberOps:\s*permsMod\.MEMBER_OPS/.test(ACCOUNTS), '/api/accounts 下发 memberOps');

/* 2026-11-16 用户追加口径：「勾选成员后出现成员的细分权限」——
 * 父项必须是**可勾的**复选框，且细项**默认收起**，勾了才展开。
 * 三种退化写法都会让这条口径失效 / 静默提权，逐条钉住。 */
const APP_N = stripJs(APP).replace(/\s+/g, ' ');
check(/data-perm-parent="members"/.test(APP), '「成员」是可勾父项（带 data-perm-parent）');
check(/<div class="perm-group"' \+ \(memberOn \? '' : ' hidden'\)/.test(APP_N),
  '细项默认带 hidden（不勾父项就不展开）');
check((APP.match(/bindPermGroup\(dlg\);/g) || []).length === 2,
  '开通 / 改权限两个弹层都绑定联动（只绑一处，另一处勾了不会展开）');
check(APP_N.indexOf("if (group) group.hidden = !on; subs.forEach(function (c) { c.checked = on; });") >= 0,
  '勾/取消父项 → 展开收起 + 6 项全勾/全清');
check(APP_N.indexOf("} else if (!subs.some(function (x) { return x.checked; })) { parent.checked = false;") >= 0,
  '子项被取消到一项不剩 → 父项跟着取消（否则裸 members 会被后端当成「全给」= 静默提权）');

/* ============================================================
 * ⑤ 变异自证
 * ============================================================ */
function selfTest() {
  let bad = 0;
  const mut = (label, fn, expectRed) => {
    const r = fn();
    if (r) { console.log('SELFTEST PASS 抓红：' + label); }
    else { console.log('SELFTEST FAIL 漏抓：' + label); bad += 1; }
  };

  // 5.1 「只勾子项」时把全部子项一起发下去（最典型的越权写法）
  mut('子项上卷时顺手把全部权限给出去', () => {
    const src = PERMS_SRC.replace(
      "    if (!has('members.view')) out.push('members.view');\n  }",
      '    MEMBER_OP_KEYS.forEach(function (k) { if (!has(k)) out.push(k); });\n  }'
    );
    if (src === PERMS_SRC) return false;
    const p2 = loadPerms(src);
    const got = onlyMembers(p2.resolve({ is_super: 0, position: '辅导员', group_tag: 'X', role: 'ADMIN' }, 'members.view'));
    return got.indexOf('members.remove') >= 0 || got.indexOf('members.super') >= 0;
  });

  // 5.2 后端把「删除」退回去挂 members
  mut('删除接口退回挂 members', () => {
    const code = IDX.replace(
      "app.post('/api/members/:id/delete', requirePerm('members.remove')",
      "app.post('/api/members/:id/delete', requirePerm('members')"
    );
    return code !== IDX && /app\.post\('\/api\/members\/:id\/delete', requirePerm\('members'\)/.test(code);
  });

  // 5.3 前端把 members 当普通 checkbox
  mut('成员退回成单个开关', () => {
    const code = APP.replace("if (v.key === 'members') {", "if (false) {");
    return code !== APP && !/if \(v\.key === 'members'\) \{/.test(code);
  });

  /* 5.4~5.6 「勾选成员后才出现细项」这条口径的三种退化写法。
     每条都拿 ④ 里那条断言本身当判据（mirror），改坏必然翻红。 */
  const collapse = (s) => stripJs(s).replace(/\s+/g, ' ');
  const GUARD = '} else if (!subs.some(function (x) { return x.checked; })) { parent.checked = false;';

  // 5.4 父项不可勾（细项永远常显）—— 用户口径直接失效
  mut('父项「成员」退回不可勾，细项永远常显', () => {
    const code = APP.replace('<input type="checkbox" value="members" data-perm-parent="members"',
      '<input type="checkbox" value="members"');
    if (code === APP) return false;
    return !/<input type="checkbox" value="members" data-perm-parent="members"/.test(code);
  });

  // 5.5 细项不默认收起
  mut('细项不默认收起（perm-group 少了 hidden）', () => {
    const code = APP.replace("(memberOn ? '' : ' hidden')", "''");
    if (code === APP) return false;
    return collapse(code).indexOf("'<div class=\"perm-group\"' + ''") >= 0;
  });

  // 5.6 子项全取消后父项仍勾着 → 后端把裸 members 当「全给」= 静默提权
  //     注意：真实源码里 `{` 与 `parent.checked` 之间隔了换行，必须用正则改，
  //     直接拿「压平后的整句」做 replace 会静默不命中（自证随之漏抓）。
  mut('子项全取消后父项不回退（裸 members = 全给）', () => {
    const code = APP.replace(/} else if \(!subs\.some\(function \(x\) \{ return x\.checked; \}\)\) \{/,
      '} else if (false) {');
    if (code === APP) return false;
    return collapse(code).indexOf(GUARD) < 0;
  });

  // 5.7 只给其中一个弹层绑联动（另一处勾了不展开）
  mut('只绑一处弹层（改权限处不展开细项）', () => {
    const code = APP.replace('bindPermGroup(dlg);', '');
    if (code === APP) return false;
    return (code.match(/bindPermGroup\(dlg\);/g) || []).length !== 2;
  });

  return bad;
}

if (require.main === module) {
  if (process.argv.indexOf('--self-test') >= 0) {
    console.log('── 变异自证（每条都应被抓）');
    const bad = selfTest();
    console.log('');
    if (bad) { console.log('[FAIL] ' + bad + ' 条自证异常'); process.exit(1); }
    console.log('[PASS] 变异自证全部被抓');
    process.exit(0);
  }
  console.log('\n── 汇总');
  if (fail) { console.log('结果：失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'); process.exit(1); }
  console.log('结果：全部通过（' + pass + ' 项）');
}
