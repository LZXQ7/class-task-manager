/**
 * 门禁：使用统计「辅导员账号」范围（2026-11-21）
 *
 * 背景（用户报）：班级范围选「当前班级」，除 3 班 22 次浏览外其余班全是 0；
 *   切「全部班级」却是 37 次。根因 = 辅导员陈慧芳是全校账号 member.class_id=0，
 *   埋点 stat/index.js 取上报人 class_id ⇒ 她的 15 次操作记在 class_id=0，
 *   任何具体班级视图都匹配不到，只有「全部」才含。今天真值：3班 22 + 全员账号 15 = 37。
 *
 * 守什么：
 *  ① 后端 mod-usage.js 用 classId=-2 哨兵表示「仅全校账号」，parseClassId 归一；
 *  ② usage() 里全部 8 个班级过滤点（主 where / 对比段 / 成员 / 功能细分 /
 *     分时 / 概况 / 累计 / 访问类型）都认 STAFF_CLASS，翻成 class_id = 0 —— 只要漏一处，
 *     就会出现「总数对了但图表/明细没跟着筛」的口径撕裂；
 *  ③ 前端三态 usageScope=all|class|staff，classPart 把 staff 翻成 &classId=-2，
 *     三按钮都在且互斥高亮，点击后 softReload（不整页刷新）；
 *  ④ 旧 usageAll 布尔键一次性迁移到三态， staff 范围下 class_id=0 显示「全校账号」。
 *
 * 承重方式：真实源码静态断言 + 内存变异自证（每条判据都有对应坏样本能抓红）。
 * 跑法：node scripts/check-usage-staff-scope.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const FILES = {
  mod: 'cloudfunctions/admin-web/lib/mod-usage.js',
  app: 'cloudfunctions/admin-web/public/app.js'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8');

function has(s, x) { return String(s).indexOf(x) >= 0; }

function audit(X) {
  const bad = [];
  const need = (name, cond) => { if (!cond) bad.push(name); };
  const M = X.mod, A = X.app;
  // 只看代码行，避开注释里提到的字面量造成假绿
  const codeM = M.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  /* ① 后端哨兵与归一 */
  need('staffSentinelDecl', has(codeM, 'const STAFF_CLASS = -2;'));
  need('staffParseFn', has(codeM, 'function parseClassId(v)') && has(codeM, 'if (n === STAFF_CLASS) return STAFF_CLASS;'));
  need('buildFilterUsesParse', has(codeM, 'const classId = parseClassId((query && query.classId)'));

  /* ② 8 个班级过滤点都认 -2（漏一个就口径撕裂）。按变量名逐个锁 */
  const filterVars = [
    ['where', 'where.push', 'class_id = 0'],
    ['conds', 'conds.push', 'class_id = 0'],      // cmpSegment 对比段
    ['memberConds', 'memberConds.push', 'e.class_id = 0'],
    ['bc', 'bc.push', 'e.class_id = 0'],          // 功能点次细分
    ['iConds', 'iConds.push', 'class_id = 0'],    // 分时
    ['sConds', 'sConds.push', 'class_id = 0'],    // 概况
    ['kConds', 'kConds.push', 'class_id = 0']     // 访问类型
  ];
  filterVars.forEach(([v, push, col]) => {
    need('staff_' + v, has(codeM, 'if (classId === STAFF_CLASS) { ' + push + "('" + col + "'); }"));
  });
  // 累计用户数用 cWhere 三元，单独锁
  need('staff_cWhere', has(codeM, "const cWhere = classId === STAFF_CLASS ? 'WHERE class_id = 0'"));
  need('staff_cArgs', has(codeM, 'const cArgs = classId === STAFF_CLASS ? []'));

  /* ③ 前端三态 */
  need('stateThreeScope', has(A, "usageScope: 'all',"));
  need('scopeConst', has(A, "var LS_USAGE_SCOPE = 'admin.web.usageScope';"));
  need('scopeBuildParam', has(A, "state.usageScope === 'staff' ? '&classId=-2'"));
  need('scopeAllBtn', has(A, 'data-ua="all">全部班级</button>'));
  need('scopeClassBtn', has(A, 'data-ua="class">仅当前班级</button>'));
  need('scopeStaffBtn', has(A, 'data-ua="staff">辅导员账号</button>'));
  need('scopeClickSoftReload', /state\.usageScope = b\.dataset\.ua;[\s\S]{0,120}softReload\(\);/.test(A));
  need('scopeResetAll', has(A, "state.usageScope = 'all'; softReload();"));
  // 三按钮高亮互斥：各按钮都按 state.usageScope 比对
  need('scopeMutualExclusive', (A.match(/state\.usageScope === '(all|class|staff)' \? ' btn-primary'/g) || []).length >= 3);

  /* ④ 旧键迁移 + 全校账号显示 */
  need('legacyMigrate', has(A, 'var savedAll = lsGet(LS_USAGE_ALL);') && has(A, "state.usageScope = savedAll === '1' ? 'all' : 'class';"));
  need('staffClassLabel', has(A, "Number(r.classId) === 0 ? '全校账号'"));
  // 不许残留把 usageAll 当状态用的旧代码（只允许迁移读取）
  const usageAllUses = (A.match(/state\.usageAll\b/g) || []).length;
  need('noStaleUsageAllState', usageAllUses === 0);

  return bad;
}

/* ---------------- 变异自证 ---------------- */
const MUTANTS = [
  { key: 'staffSentinelDecl', file: 'mod', from: 'const STAFF_CLASS = -2;', to: 'const STAFF_CLASS = -3;' },
  { key: 'buildFilterUsesParse', file: 'mod', from: 'const classId = parseClassId((query && query.classId)', to: 'const classId = parseInt((query && query.classId)' },
  { key: 'staff_cWhere', file: 'mod', from: "const cWhere = classId === STAFF_CLASS ? 'WHERE class_id = 0'", to: "const cWhere = classId ? 'WHERE class_id = ?'" },
  { key: 'stateThreeScope', file: 'app', from: "usageScope: 'all',", to: "usageScopeX: 'all'," },
  { key: 'scopeBuildParam', file: 'app', from: "state.usageScope === 'staff' ? '&classId=-2'", to: "state.usageScope === 'staff' ? '&classId=0'" },
  { key: 'scopeStaffBtn', file: 'app', from: 'data-ua="staff">辅导员账号</button>', to: 'data-ua="staff">辅导员</button>' },
  { key: 'scopeClickSoftReload', file: 'app', from: 'state.usageScope = b.dataset.ua;', to: 'state.usageScopeX = b.dataset.ua;' },
  { key: 'legacyMigrate', file: 'app', from: 'var savedAll = lsGet(LS_USAGE_ALL);', to: 'var savedAll = null;' },
  { key: 'staffClassLabel', file: 'app', from: "Number(r.classId) === 0 ? '全校账号'", to: "Number(r.classId) === 0 ? '—'" }
];

(async function main() {
  const real = audit(S);
  if (real.length) {
    console.log('✗ 主线源码未通过：' + real.length + ' 项');
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
    const X = Object.assign({}, S, { [mu.file]: src.split(mu.from).join(mu.to) });
    const bad = audit(X);
    if (!bad.length) {
      console.log('  ✗ 变异未被抓到（门禁形同虚设）: ' + mu.key);
      process.exit(1);
    }
    caught++;
    console.log('  ✓ 变异 ' + mu.key + ' → 抓到 ' + bad.slice(0, 3).join(','));
  }
  console.log('✓ 变异自证 ' + caught + '/' + MUTANTS.length + ' 全部抓到');
})().catch((e) => { console.error('门禁自身异常：', e && e.stack); process.exit(1); });
