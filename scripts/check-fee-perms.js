/**
 * 门禁：班费「单独授予」权限（2026-11-08）
 *
 * 守什么：
 *  ① 真源 common/fee-perms.js 的白名单只有 class/league，且归一化/字符串化/判定齐备；
 *  ② fee 云函数 feeManager 叠加 hasFeePerm（只额外授予），feeTotalSetter **不受影响**；
 *  ③ auth.login 下发 4 个能力位，其中消费登记两位含单独授权；
 *  ④ 小程序 util.feeRights 优先采用下发位、旧缓存回退按职位；两个调用点都把位传进去；
 *  ⑤ 后台 mod-member 白名单校验 + 读写列，app.js 两个开关 + 收集 + 列表标签，css 有 .chk；
 *  ⑥ 迁移 SQL 不加 IF NOT EXISTS（本环境 TDSQL 不支持）；
 *  ⑦ 三份关键 common 副本与真源逐字一致。
 *
 * 承重方式：静态断言 + **从真实源码抠函数跑桩**（不是抄一份实现），
 *          再加 7 组内存变异自证 —— 去掉任一关键环节，审计必须报出来。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function has(s, x) { return s.indexOf(x) >= 0; }

const FILES = {
  perms: 'cloudfunctions/common/fee-perms.js',
  fee: 'cloudfunctions/fee/index.js',
  auth: 'cloudfunctions/auth/index.js',
  mod: 'cloudfunctions/admin-web/lib/mod-member.js',
  app: 'cloudfunctions/admin-web/public/app.js',
  css: 'cloudfunctions/admin-web/public/admin.css',
  util: 'miniprogram/utils/util.js',
  feePage: 'miniprogram/pages/fee/index.js',
  minePage: 'miniprogram/pages/mine/index.js',
  sql: 'scripts/migrate-fee-perms.sql'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = read(FILES[k]);

/* 真源（不参与变异）：只额外授予的判定函数 */
const realPerms = require(path.join(ROOT, FILES.perms));

/** 从源码里按大括号配对抠出一个具名函数声明（真实源码承重，不抄实现） */
function extractFn(src, name) {
  const re = new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('extractFn 找不到 ' + name);
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

/** 用 vm-free 的 Function 把小程序 util.js 整份加载（该文件无 require） */
function loadUtil(src) {
  const mod = { exports: {} };
  new Function('module', 'exports', src)(mod, mod.exports);
  return mod.exports;
}

const guardStub = {
  isSuper: (m) => !!(m && m.isSuper),
  isMonitor: (m) => !!(m && m.position === '班长兼团支书'),
  isViceMonitor: (m) => !!(m && m.position === '副班长'),
  isDutyAdmin: (m) => !!(m && m.position === '生活委员')
};

/** 审计一份源码集合，返回问题 key 数组 */
function audit(X) {
  const p = [];
  const need = (cond, key) => { if (!cond) p.push(key); };

  /* ① 真源 */
  need(has(X.perms, "const FEE_PERM_KEYS = ['class', 'league'];"), 'trueSource');
  need(has(X.perms, 'function normalizeFeePerms') && has(X.perms, 'function stringifyFeePerms')
    && has(X.perms, 'function hasFeePerm'), 'trueSourceExports');

  /* ② fee：叠加授权 + 总额不受影响 */
  let fmSrc = '', ftSrc = '';
  try { fmSrc = extractFn(X.fee, 'feeManager'); } catch (e) { p.push('fnExtractFeeManager'); }
  try { ftSrc = extractFn(X.fee, 'feeTotalSetter'); } catch (e) { p.push('fnExtractFeeTotalSetter'); }
  need(has(fmSrc, 'hasFeePerm(m, type)'), 'feeManagerOR');
  need(!has(ftSrc, 'hasFeePerm'), 'feeTotalClean');
  need(has(X.fee, "require('./common/fee-perms')"), 'feeRequire');

  /* ③ auth 下发 */
  need(has(X.auth, 'feeRights: {'), 'authIssue');
  const authBlock = X.auth.slice(X.auth.indexOf('feeRights: {'), X.auth.indexOf('feeRights: {') + 1400);
  need(has(authBlock, "hasFeePerm(m, 'class')") && has(authBlock, "hasFeePerm(m, 'league')"), 'authIssueGrant');
  need(['canManageClass', 'canManageLeague', 'canSetTotalClass', 'canSetTotalLeague']
    .every(k => has(authBlock, k + ':')), 'authIssueFourBits');
  // 「设置总额」两位绝不能挂单独授权（用户口径：只做两项消费登记）
  const totalClassLine = (authBlock.match(/canSetTotalClass:[^\n]*/) || [''])[0];
  const totalLeagueLine = (authBlock.match(/canSetTotalLeague:[^\n]*/) || [''])[0];
  need(!has(totalClassLine, 'hasFeePerm') && !has(totalLeagueLine, 'hasFeePerm'), 'authNoTotalGrant');

  /* ④ 小程序 */
  need(has(X.util, 'const issued = m.feeRights;') && has(X.util, '!!issued.canManageClass'), 'utilIssued');
  need(has(X.util, 'const isSuper = !!m.isSuper;'), 'utilFallback');
  need(has(X.feePage, 'feeRights: p ? p.feeRights : null'), 'feePagePass');
  need(has(X.minePage, 'feeRights: p ? p.feeRights : null'), 'minePagePass');

  /* ⑤ 后台 */
  need(has(X.mod, 'feePerms: normalizeFeePerms(r.fee_perms)'), 'modMask');
  need(has(X.mod, 'if (patch.feePerms !== undefined)') && has(X.mod, 'FEE_PERM_KEYS.indexOf(k) < 0'), 'modValidate');
  need(has(X.mod, "put('fee_perms', stringifyFeePerms(patch.feePerms))"), 'modPut');
  need(has(X.mod, 'fee_perms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    && has(X.mod, 'stringifyFeePerms(data.feePerms)'), 'modInsert');
  need(has(X.app, 'id="f-perm-class"') && has(X.app, 'id="f-perm-league"'), 'appCheckbox');
  need(has(X.app, "out.push('class')") && has(X.app, "out.push('league')"), 'appCollect');
  need(has(X.app, 'permTags(m.feePerms)'), 'appTags');
  need(has(X.css, '.field .chk') && has(X.css, 'input[type=checkbox]'), 'cssChk');

  /* ⑥ 迁移 SQL（注释里提到过 IF NOT EXISTS 这个词，判据必须先剥掉 -- 注释行） */
  const sqlBody = X.sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  need(has(sqlBody, "ADD COLUMN fee_perms VARCHAR(128) NOT NULL DEFAULT ''"), 'sqlColumn');
  need(!has(sqlBody, 'IF NOT EXISTS'), 'sqlNoIfNotExists');

  /* 功能层：真实源码抠函数 + 桩 */
  try {
    const fm = new Function('guard', 'hasFeePerm', 'return (' + fmSrc + ');')(guardStub, realPerms.hasFeePerm);
    const ft = new Function('guard', 'hasFeePerm', 'return (' + ftSrc + ');')(guardStub, realPerms.hasFeePerm);
    const plain = { position: '', fee_perms: '' };
    need(fm('class', plain) === false && fm('league', plain) === false, 'fnPlainDenied');
    need(fm('class', { position: '', fee_perms: 'class' }) === true
      && fm('league', { position: '', fee_perms: 'class' }) === false, 'fnClassOnly');
    need(fm('class', { position: '', fee_perms: 'class,league' }) === true
      && fm('league', { position: '', fee_perms: 'class,league' }) === true, 'fnBoth');
    need(fm('league', { position: '', fee_perms: 'league' }) === true
      && fm('class', { position: '', fee_perms: 'league' }) === false, 'fnLeagueOnly');
    need(fm('class', { position: '生活委员', fee_perms: '' }) === true, 'fnPositionKept');
    need(fm('league', { position: '班长兼团支书', fee_perms: '' }) === true, 'fnMonitorKept');
    need(fm('class', { isSuper: true, fee_perms: '' }) === true, 'fnSuper');
    need(fm('class', { position: '', fee_perms: 'bogus,,,class' }) === true
      && fm('league', { position: '', fee_perms: 'bogus' }) === false, 'fnNormalize');
    // 只额外授予：单独授权绝不打开「设置总额」
    need(ft('class', { position: '', fee_perms: 'class,league' }) === false
      && ft('league', { position: '', fee_perms: 'class,league' }) === false, 'fnTotalNotGranted');
    need(ft('class', { position: '生活委员', fee_perms: '' }) === true
      && ft('league', { position: '班长兼团支书', fee_perms: '' }) === true, 'fnTotalByPosition');
  } catch (e) { p.push('fnRun:' + e.message); }

  /* 功能层：真实 util.js（或变异版） */
  try {
    const u = loadUtil(X.util);
    const issued = u.feeRights({ feeRights: {
      canManageClass: true, canManageLeague: false,
      canSetTotalClass: false, canSetTotalLeague: false
    } });
    need(issued.canManageClass === true && issued.canManageLeague === false, 'fnUtilIssued');
    need(issued.showLeagueCard === true && issued.hasAny === true, 'fnUtilIssuedMeta');
    const fallback = u.feeRights({ isSuper: false, position: '' });
    need(fallback.canManageClass === false && fallback.canManageLeague === false, 'fnUtilFallback');
    const pos = u.feeRights({ isSuper: false, position: '生活委员' });
    need(pos.canManageClass === true && pos.canSetTotalClass === true, 'fnUtilPosition');
    const none = u.feeRights(null);
    need(none.canManageClass === false && none.showLeagueCard === false, 'fnUtilNone');
  } catch (e) { p.push('fnUtilRun:' + e.message); }

  return p;
}

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra ? ' — ' + extra : '')); }
}

console.log('=== check-fee-perms：真实源码审计 ===');
const problems = audit(S);
ok(problems.length === 0, '真实源码 0 问题', problems.join(', '));

console.log('=== 关键副本与真源逐字一致 ===');
for (const fn of ['fee', 'auth', 'admin-web']) {
  const copy = read('cloudfunctions/' + fn + '/common/fee-perms.js');
  ok(copy === S.perms, fn + '/common/fee-perms.js 与真源一致');
}

console.log('=== 变异自证（内存，不落盘） ===');
function mutated(overrides) { return Object.assign({}, S, overrides); }
const CASES = [
  ['M1 去掉 feeManager 的单独授权 → 必须翻红',
    mutated({ fee: S.fee.replace('  if (hasFeePerm(m, type)) return true;\n', '') }),
    ['feeManagerOR', 'fnClassOnly', 'fnBoth', 'fnLeagueOnly']],
  ['M2 给「设置总额」也塞单独授权 → 必须翻红',
    mutated({ fee: S.fee.replace('function feeTotalSetter(type, m) {\n  if (guard.isSuper(m)) return true;',
      'function feeTotalSetter(type, m) {\n  if (hasFeePerm(m, type)) return true;\n  if (guard.isSuper(m)) return true;') }),
    ['feeTotalClean', 'fnTotalNotGranted']],
  ['M3 auth 去掉班费单独授权 → 必须翻红',
    mutated({ auth: S.auth.replace("|| hasFeePerm(m, 'class'))", ')') }),
    ['authIssueGrant']],
  ['M4 前端不采用下发位 → 必须翻红',
    mutated({ util: S.util.replace('const issued = m.feeRights;', 'const issued = null;') }),
    ['utilIssued', 'fnUtilIssued']],
  ['M5 后台去掉白名单校验 → 必须翻红',
    mutated({ mod: S.mod.replace('      if (FEE_PERM_KEYS.indexOf(k) < 0) throw new BizError(40001, \'权限项不合法：\' + k);\n', '') }),
    ['modValidate']],
  ['M6 班费页不传下发位 → 必须翻红',
    mutated({ feePage: S.feePage.replace('      feeRights: p ? p.feeRights : null\n', '') }),
    ['feePagePass']],
  ['M7 迁移 SQL 加 IF NOT EXISTS → 必须翻红',
    mutated({ sql: S.sql.replace('ADD COLUMN fee_perms', 'ADD COLUMN IF NOT EXISTS fee_perms') }),
    ['sqlColumn']]
];
for (const [label, X, expectAny] of CASES) {
  const got = audit(X);
  ok(expectAny.some(k => got.indexOf(k) >= 0), label, '实得 ' + got.join(','));
}

console.log('check-fee-perms: 通过 ' + pass + ' / 失败 ' + fail);
process.exitCode = fail ? 1 : 0;
