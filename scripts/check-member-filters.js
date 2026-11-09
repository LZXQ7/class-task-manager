/**
 * 门禁：后台成员列表「页大小 10/30/50/全部 + 四选一筛选」（2026-11-08）
 *
 * 守什么：
 *  ① 后端 MEMBER_SCOPES 白名单四选一，非法值回落 ALL（不接受拼接用户输入）；
 *  ② 「班委」口径与小程序 pages/roster._isCommittee 主路径一致（role 非 MEMBER 且非 X 组）；
 *  ③ pageSize=0 是「全部」的合法值，不拼 LIMIT/OFFSET；0 不能被 `|| 50` 吃掉；
 *  ④ 附加条件为空时不拼出语法错的裸 ' AND '；两条 SQL 仍显式带 NOT_TEST_SQL；
 *  ⑤ 前端传 scope/pageSize/keyword/page，默认 50 / ALL，切条件回第 1 页，
 *     「全部」不渲染 pager，搜索真正重渲染（不是只弹 toast）；
 *  ⑥ CSS 有桌面与窄屏样式。
 *
 * 承重方式：静态断言 + **从真实源码抠出 listMembers 跑 pool 桩**（断言真实生成的
 *          SQL 与 args，不是抄一份实现）+ 8 组内存变异自证 —— 去掉任一环必须翻红。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function has(s, x) { return s.indexOf(x) >= 0; }

const FILES = {
  mod: 'cloudfunctions/admin-web/lib/mod-member.js',
  app: 'cloudfunctions/admin-web/public/app.js',
  css: 'cloudfunctions/admin-web/public/admin.css',
  roster: 'miniprogram/pages/roster/index.js'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = read(FILES[k]);

/** 按大括号配对抠出具名函数声明（真实源码承重，不抄实现） */
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
  // 正则从 `function` 起匹配，会把前面的 `async ` 留在外面 —— 不补回来，
  // 函数体里的 await 就落进普通函数，`new Function` 直接抛语法错。
  const am = /(async\s+)$/.exec(src.slice(0, m.index));
  const start = am ? m.index - am[1].length : m.index;
  return src.slice(start, i);
}

/** 把 listMembers 从源码里加载进桩环境，返回可调用实例 */
function loadListMembers(modSrc) {
  const fnSrc = extractFn(modSrc, 'listMembers');
  const scopes = /const MEMBER_SCOPES = (\[[^\]]*\]);/.exec(modSrc);
  if (!scopes) throw new Error('找不到 MEMBER_SCOPES');
  const MEMBER_SCOPES = new Function('return ' + scopes[1])();
  const calls = [];
  const pool = {
    query: async function (sql, args) {
      calls.push({ sql: String(sql), args: args || [] });
      if (/^SELECT COUNT/i.test(sql)) return [[{ c: 7 }], []];
      return [[{ id: 1, student_no: '2099010101' }], []];
    }
  };
  const fn = new Function('getPool', 'NOT_TEST', 'maskMember', 'MEMBER_SCOPES',
    fnSrc + '\nreturn listMembers;')(
    function () { return pool; },
    function (alias) { return (alias ? alias + '.' : '') + "student_no NOT LIKE '0000000000%'"; },
    function (r) { return r; },
    MEMBER_SCOPES
  );
  return { fn: fn, calls: calls };
}

/** 跑真实 listMembers，断言生成的 SQL 与参数。
 *  ⚠️ 必须串行且每例独立 pool：并发跑会让所有 case 的 `before` 都是 0，
 *     彼此取到对方的 SQL —— 表现为一片假红（本门禁首跑就踩了）。 */
async function behavior(modSrc, need) {
  const cases = [
    { q: { classId: 3, pageSize: 50, page: 1 }, tag: 'default' },
    { q: { classId: 3, pageSize: 10, page: 2, scope: 'A' }, tag: 'a10' },
    { q: { classId: 3, pageSize: 30, page: 1, scope: 'B' }, tag: 'b30' },
    { q: { classId: 3, pageSize: 50, page: 1, scope: 'COMMITTEE' }, tag: 'committee' },
    { q: { classId: 3, pageSize: 0, scope: 'A' }, tag: 'allA' },
    { q: { classId: 3, pageSize: 50, scope: 'DROP TABLE', keyword: '张' }, tag: 'badScope' },
    { q: { pageSize: 0 }, tag: 'noFilter' }
  ];
  for (const c of cases) {
    const L = loadListMembers(modSrc);
    await L.fn(c.q);
    const two = L.calls.slice(0, 2);
    // 每条成员查询只发 COUNT + SELECT 两条
    need(two.length === 2, 'sqlCount:' + c.tag);
    const sel = two[1] || { sql: '', args: [] };
    const cnt = two[0] || { sql: '', args: [] };
    // 运行时 SQL 里的 NOT_TEST 已被桩展开成字面条件，不能再找变量名
    need(has(sel.sql, "student_no NOT LIKE '0000000000%'") &&
      has(cnt.sql, "student_no NOT LIKE '0000000000%'"), 'notTest:' + c.tag);
    need(!/AND\s*$|WHERE\s*$/.test(sel.sql.replace(/\s+$/, '')), 'danglingAnd:' + c.tag);
    need(!/AND\s*$|WHERE\s*$/.test(cnt.sql.replace(/\s+$/, '')), 'danglingAndCnt:' + c.tag);

    if (c.tag === 'allA' || c.tag === 'noFilter') {
      need(!/LIMIT \?/.test(sel.sql), 'allNoLimit:' + c.tag);
      need(sel.args.indexOf(0) < 0, 'allNoSizeArg:' + c.tag);
    } else {
      need(/LIMIT \? OFFSET \?/.test(sel.sql), 'pagedLimit:' + c.tag);
      const size = c.q.pageSize;
      need(sel.args[sel.args.length - 2] === size, 'pagedSize:' + c.tag);
      const expectOffset = ((c.q.page || 1) - 1) * size;
      need(sel.args[sel.args.length - 1] === expectOffset, 'pagedOffset:' + c.tag);
    }
    if (c.q.scope === 'A' || c.q.scope === 'B') {
      need(has(sel.sql, 'm.group_tag = ?') && sel.args.indexOf(c.q.scope) >= 0, 'groupSql:' + c.tag);
    }
    if (c.q.scope === 'COMMITTEE') {
      need(has(sel.sql, "m.role <> 'MEMBER' AND m.group_tag <> 'X'"), 'committeeSql');
    }
    if (c.q.scope === 'DROP TABLE') {
      need(!has(sel.sql, 'DROP TABLE'), 'scopeWhitelist');
      need(!/m\.role <> 'MEMBER'/.test(sel.sql), 'badScopeFallback');
    }
    if (c.q.keyword) {
      need(has(sel.sql, 'm.name LIKE ? OR m.student_no LIKE ?'), 'keywordSql');
      need(sel.args.indexOf('%张%') >= 0, 'keywordArg');
    }
  }
}

/** 审计一份源码集合，返回问题 key 数组；runtime=false 用于只跑静态段 */
async function audit(X, withRuntime) {
  const p = [];
  const need = (cond, key) => { if (!cond) p.push(key); };

  /* ① 后端白名单与口径 */
  need(has(X.mod, "const MEMBER_SCOPES = ['ALL', 'COMMITTEE', 'A', 'B'];"), 'scopesWhitelist');
  need(has(X.mod, 'MEMBER_SCOPES.indexOf(scopeRaw) >= 0 ? scopeRaw :'), 'scopesFallback');
  need(has(X.mod, "where.push(\"m.role <> 'MEMBER' AND m.group_tag <> 'X'\")"), 'committeeLiteral');
  need(has(X.mod, "where.push('m.group_tag = ?');") && has(X.mod, 'args.push(scope);'), 'groupParam');
  need(has(X.mod, "const all = String(q.pageSize) === '0';"), 'zeroIsAll');
  // 注释里会引用「错误写法」做说明，判据只看代码行，否则自己把自己的注释判红
  const codeOnly = X.mod.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  need(!has(codeOnly, 'Number(q.pageSize) || 50'), 'noFalsyZero');
  need(has(X.mod, "all ? '' : ' LIMIT ? OFFSET ?'"), 'allNoLimitBranch');
  need(has(X.mod, "const suffix = extra ? ' AND ' + extra : '';"), 'emptyFilterGuard');
  need(has(X.mod, 'all ? args : args.concat([pageSize, (page - 1) * pageSize])'), 'allArgs');
  need((X.mod.match(/NOT_TEST_SQL \+ suffix/g) || []).length === 2, 'notTestBothQueries');

  /* ② 与小程序名册口径对齐（role 非 MEMBER 且非 X 组） */
  need(has(X.roster, "x.role === 'ADMIN' || x.role === 'MONITOR'"), 'rosterCommitteeRole');
  need(has(X.roster, "x.groupTag !== 'X'"), 'rosterCommitteeNoStaff');
  need(has(X.roster, "groupFilter: 'ALL'"), 'rosterFourScope');

  /* ③ 前端控件与请求 */
  need(has(X.app, "var MEMBER_SCOPE_ORDER = ['ALL', 'COMMITTEE', 'A', 'B'];"), 'uiScopes');
  need(has(X.app, 'var MEMBER_PAGE_SIZES = [10, 30, 50, 0];'), 'uiSizes');
  need(has(X.app, 'memberPageSize: 50') && has(X.app, "memberScope: 'ALL'"), 'uiDefaults');
  need(has(X.app, "'&pageSize=' + state.memberPageSize + '&scope=' + encodeURIComponent(state.memberScope)"), 'uiQs');
  need(has(X.app, "(state.memberKw ? '&keyword=' + encodeURIComponent(state.memberKw) : '')"), 'uiKeyword');
  need(has(X.app, "'<select id=\"m-size\" class=\"tb-select\">'"), 'uiSelect');
  need(has(X.app, "$$('[data-scope]', host).forEach"), 'uiScopeBind');
  need(has(X.app, "state.memberPageSize = Number(this.value);"), 'uiSizeBind');
  need((X.app.match(/state\.memberPage = 1;\s*reload\(\);/g) || []).length >= 3, 'uiResetPage');
  need(has(X.app, "state.memberPageSize === 0 ? '' :"), 'uiNoPagerOnAll');
  need(has(X.app, "if (!pageSize || pageSize <= 0) return '';"), 'pagerZeroGuard');
  // 从真实源码抠出 applyKw 函数体：搜索必须真的触发重渲染（原来只弹 toast 不改表格）
  let applyKwSrc = '';
  try { applyKwSrc = extractFn(X.app, 'applyKw'); } catch (e) { p.push('fnExtractApplyKw'); }
  need(has(applyKwSrc, 'state.memberKw = kw.value.trim();') && has(applyKwSrc, 'reload();'), 'searchReload');
  need(!has(X.app, "toast('找到 ' + r.data.total + ' 人')"), 'searchNoFakeToast');
  need(has(X.app, '当前筛选下没有成员'), 'filteredEmptyText');

  /* ④ 样式 */
  need(has(X.css, '.member-toolbar { flex-wrap: wrap;'), 'cssToolbar');
  need(has(X.css, '.tb-select {'), 'cssSelect');
  need(has(X.css, '.member-scope .seg-btn { flex: 1; min-height: 44px;'), 'cssMobile');

  if (withRuntime !== false) await behavior(X.mod, need);
  return p;
}

/* ---------------- 变异自证：去掉任一环节，审计必须翻红 ---------------- */
const MUTANTS = [
  { key: 'zeroIsAll', file: 'mod', from: "const all = String(q.pageSize) === '0';", to: 'const all = false;' },
  { key: 'committeeLiteral', file: 'mod', from: '"m.role <> \'MEMBER\' AND m.group_tag <> \'X\'"', to: '"m.role <> \'MEMBER\'"' },
  { key: 'allNoLimitBranch', file: 'mod', from: "all ? '' : ' LIMIT ? OFFSET ?'", to: "' LIMIT ? OFFSET ?'" },
  { key: 'emptyFilterGuard', file: 'mod', from: "const suffix = extra ? ' AND ' + extra : '';", to: "const suffix = ' AND ' + extra;" },
  { key: 'scopesFallback', file: 'mod', from: 'MEMBER_SCOPES.indexOf(scopeRaw) >= 0 ? scopeRaw :', to: '' },
  { key: 'uiQs', file: 'app', from: "'&pageSize=' + state.memberPageSize + '&scope=' + encodeURIComponent(state.memberScope)", to: "'&pageSize=' + state.memberPageSize" },
  { key: 'uiSizes', file: 'app', from: 'var MEMBER_PAGE_SIZES = [10, 30, 50, 0];', to: 'var MEMBER_PAGE_SIZES = [10, 30, 50];' },
  { key: 'uiNoPagerOnAll', file: 'app', from: "state.memberPageSize === 0 ? '' :", to: 'false ? \'\' :' },
  { key: 'searchReload', file: 'app', from: 'function applyKw() {\n        state.memberKw = kw.value.trim();\n        state.memberPage = 1;\n        reload();\n      }', to: 'function applyKw() {\n        state.memberKw = kw.value.trim();\n      }' }
];

(async function main() {
  const real = await audit(S, true);
  if (real.length) {
    console.log('✗ 主线源码审计未通过：' + real.length + ' 项');
    real.forEach((k) => console.log('  ✗ ' + k));
    process.exit(1);
  }
  console.log('✓ 主线源码审计通过');

  let caught = 0;
  for (const mu of MUTANTS) {
    const src = S[mu.file];
    if (!has(src, mu.from)) {
      console.log('  ✗ 变异锚点失效（判据已漂移）: ' + mu.key);
      process.exit(1);
    }
    const X = Object.assign({}, S, { [mu.file]: src.replace(mu.from, mu.to) });
    let bad = [];
    try { bad = await audit(X, true); } catch (e) { bad = ['throw:' + e.message]; }
    if (!bad.length) {
      console.log('  ✗ 变异未被抓到（门禁形同虚设）: ' + mu.key);
      process.exit(1);
    }
    caught++;
    console.log('  ✓ 变异 ' + mu.key + ' → 抓到 ' + bad.slice(0, 3).join(','));
  }
  console.log('✓ 变异自证 ' + caught + '/' + MUTANTS.length + ' 全部抓到');
})().catch((e) => {
  console.error('门禁自身异常：', e && e.stack);
  process.exit(1);
});
