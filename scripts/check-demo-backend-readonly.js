#!/usr/bin/env node
/**
 * 门禁：演示班级「后端只读硬闸」
 * =============================================================
 * 2026-11-13 起因（线上实况）：前端只读守卫做完后，仍有体验者在演示班**成功上传假条**
 *   并写回 leave_request（云存储新增 leave/1794500595197-603.jpg，演示班 id=35 被回写）。
 *   根因：请假走 adjust 云函数，而 adjust **压根没挂演示闸** ——
 *   全站只有 auth/class/course/member/media 五处有 DENY 闸，且那份 DENY 清单
 *   **故意放行**「请假登记/撤销」等日常写（为让审核员体验功能）。
 *
 * 结论：前端拦不住旧客户端，**必须后端硬拦**。
 *
 * ✅ 本门禁钉的不变式：
 *   ① common/review-demo.js 导出 gateDemoWrite + DEMO_WRITE_ACTIONS；
 *   ② 读操作零开销：`!DEMO_WRITE_SET.has(a)` 的 return 必须早于任何查库；
 *   ③ 名单含全部关键写 action（请假/作业/班费/排班/成员/通知）；
 *   ④ 名单**不得**含必须放行项（login / reviewDemo / switchDemo / switchAccount）——
 *      拦了 login 就进不去，拦了 switchAccount 就卡在演示班出不来；
 *   ⑤ 10 个业务云函数 main 都 require 并调用了 gateDemoWrite；
 *   ⑥ 完整性：任何路由名命中写类关键词却不在名单（且不在读误判白名单）⇒ 红，
 *      强迫维护名单（防止将来新增写 action 静默穿透）。
 *
 * 退出码 0 = 过；非 0 = 有问题。
 * 用法：node scripts/check-demo-backend-readonly.js            正常校验
 *      node scripts/check-demo-backend-readonly.js --self-test 变异自证（须全部被抓）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; }
};

/** 必须挂闸的业务云函数（小程序端会调用且含写操作的） */
const GATED_FNS = ['adjust', 'auth', 'class', 'course', 'duty', 'fee', 'homework', 'media', 'member', 'schedule'];

/** 必须出现在写名单里的关键 action（跨模块抽查，防被人删空） */
const MUST_DENY = [
  'leaveApply', 'leaveImageSet', 'leaveApprove', 'leaveMyCancel',   // 请假（本次漏洞）
  'countdownAdd',
  'submit', 'publish', 'review',                                     // 作业
  'feeAppendImages', 'setTotal', 'addExpense',                       // 班费
  'electiveSave', 'shiftSet', 'saveHoliday',                         // 课表/调课
  'removeMember', 'setRole', 'setPosition', 'staffDelete', 'staffCode', // 成员/教职工
  'msgPublish', 'publishNotice',                                     // 通知
  'generate', 'reassign', 'addManual'                                // 排班
];

/** 必须**放行**的 action（拦了会把人锁在演示班 / 进不去） */
const MUST_ALLOW = ['login', 'reviewDemo', 'switchDemo', 'switchAccount', 'checkToken'];

/** 关键词命中但实为读的操作（正则误判白名单，名单里不该出现它们） */
const READ_FALSE_POSITIVE = [
  'swapCandidates',   // 换班候选列表
  'getApplyList',     // 调课申请列表
  'downloadApply',    // 下载申请表
  'aiSettingGet',     // 读 AI 排班设置（被 /set/ 误命中）
  'aiSettingModels'   // 读 AI 模型清单
];

const WRITE_ACTION = /(add|save|set|update|remove|delete|clear|publish|unpublish|apply|import|revert|confirm|cancel|bind|unbind|toggle|move|append|copy|submit|upsert|generate|reassign|swap|handle|track|send|create|mark|reset|upload)/i;

const FILES = { reviewDemo: 'cloudfunctions/common/review-demo.js' };
GATED_FNS.forEach(fn => { FILES['fn_' + fn] = `cloudfunctions/${fn}/index.js`; });

/** 取 routes 对象里声明的 action 键 */
function actionsOf(src) {
  const out = new Set();
  const re = /^\s{2}'?([A-Za-z][\w.]*)'?\s*:\s*\{/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return out;
}

function judge(f) {
  const fails = [];
  const push = (ok, msg) => { if (!ok) fails.push(msg); };

  const rd = f.reviewDemo;

  /* ① 导出与名单存在 */
  push(/gateDemoWrite/.test(rd) && /module\.exports[\s\S]{0,400}gateDemoWrite/.test(rd),
    'review-demo.js 未导出 gateDemoWrite');
  push(/DEMO_WRITE_ACTIONS/.test(rd) && /module\.exports[\s\S]{0,400}DEMO_WRITE_ACTIONS/.test(rd),
    'review-demo.js 未导出 DEMO_WRITE_ACTIONS');

  /* ② 读操作零开销：早退必须在查库之前（只看 gateDemoWrite 函数体内，_demoIds 定义体不算） */
  const gateStart = rd.indexOf('async function gateDemoWrite');
  const gateBody = gateStart >= 0 ? rd.slice(gateStart, gateStart + 900) : '';
  const earlyIdx = gateBody.indexOf('if (!DEMO_WRITE_SET.has(a)) return false;');
  const dbIdx = gateBody.search(/await _demoIds\(|await guard\.demoClassIds\(/);
  push(earlyIdx >= 0, 'gateDemoWrite 缺少「非写名单直接放行」的早退');
  push(earlyIdx >= 0 && dbIdx > earlyIdx,
    'gateDemoWrite 的早退必须早于查库（读操作零开销）');

  /* ③ 关键写 action 全在名单 */
  MUST_DENY.forEach(a => push(new RegExp(`'${a}'`).test(rd), `写名单缺少关键 action: ${a}`));

  /* ④ 必须放行项不得进名单 */
  MUST_ALLOW.forEach(a => {
    const inList = new RegExp(`'${a}'\\s*,?\\s*(?:\\/\\/.*)?\\n`).test(rd.split('const DEMO_WRITE_SET')[0]);
    push(!inList, `名单误含必须放行的 action: ${a}（会导致演示班进不去/出不来）`);
  });

  /* ⑤ 每个业务云函数都要 require + 调用 */
  GATED_FNS.forEach(fn => {
    const src = f['fn_' + fn] || '';
    push(/require\('\.\/common\/review-demo'\)/.test(src), `${fn}: 未 require review-demo`);
    const callIdx = src.indexOf('reviewDemo.gateDemoWrite(');
    const ctxIdx = src.indexOf('const ctx = await guard.getContext()');
    push(callIdx >= 0, `${fn}: main 未调用 reviewDemo.gateDemoWrite`);
    push(callIdx >= 0 && ctxIdx >= 0 && callIdx > ctxIdx,
      `${fn}: gateDemoWrite 必须在取到 ctx 之后调用`);
  });

  /* ⑥ 名单完整性：路由里所有命中写词的 action 都必须在名单内 */
  const known = new Set((rd.match(/'([A-Za-z][\w]*)'/g) || []).map(s => s.replace(/'/g, '')));
  GATED_FNS.forEach(fn => {
    const src = f['fn_' + fn] || '';
    actionsOf(src).forEach(a => {
      if (!WRITE_ACTION.test(a)) return;
      if (READ_FALSE_POSITIVE.includes(a)) return;
      push(known.has(a), `${fn}: 写类 action 「${a}」不在演示班写名单（会静默穿透）`);
    });
  });

  return fails;
}

function loadFiles() {
  const f = {};
  Object.keys(FILES).forEach(k => { f[k] = read(FILES[k]); });
  return f;
}

const fails = judge(loadFiles());
if (!fails.length) {
  console.log('[PASS] 演示班级后端只读硬闸：名单完整、10 个业务云函数已挂闸、读操作零开销');
  process.exitCode = 0;
} else {
  console.log(`[FAIL] ${fails.length} 项未通过：`);
  fails.forEach(m => console.log('  ✗ ' + m));
  process.exitCode = 1;
}

/* ---------------- 变异自证 ---------------- */
if (process.argv.includes('--self-test')) {
  console.log('\n=== 变异自证 ===');
  const cases = [
    ['去掉 adjust 的挂闸调用', (f) => {
      f.fn_adjust = f.fn_adjust.replace(/\s*await reviewDemo\.gateDemoWrite\([^\n]*\n/, '\n');
    }],
    ['名单删掉 leaveApply', (f) => {
      f.reviewDemo = f.reviewDemo.replace("'leaveApply', ", '');
    }],
    ['名单误加 login（必须放行）', (f) => {
      f.reviewDemo = f.reviewDemo.replace("const DEMO_WRITE_ACTIONS = [", "const DEMO_WRITE_ACTIONS = [\n  'login',");
    }],
    ['早退挪到查库之后（读也要查库）', (f) => {
      const early = "  if (!DEMO_WRITE_SET.has(a)) return false;\n";
      f.reviewDemo = f.reviewDemo.replace(early, '');
      f.reviewDemo = f.reviewDemo.replace("  const ids = await _demoIds(pool, guard);", "  const ids = await _demoIds(pool, guard);\n" + early);
    }],
    ['删掉 fee 的 require', (f) => {
      f.fn_fee = f.fn_fee.replace(/const reviewDemo = require\('\.\/common\/review-demo'\);[^\n]*\n/, '');
    }],
    ['模拟新增未登记的写 action', (f) => {
      f.fn_adjust = f.fn_adjust.replace(/^\s{2}leaveApply: \{/m, "  leaveBulkImport: {\n    handler: async () => ({})\n  },\n  leaveApply: {");
    }]
  ];

  let caught = 0;
  cases.forEach(([name, mutate]) => {
    const f = loadFiles();
    mutate(f);
    const r = judge(f);
    const ok = r.length > 0;
    console.log(`${ok ? '✓ 抓到' : '✗ 漏掉'}  ${name}${ok ? `（${r.length} 项）` : ''}`);
    if (ok) caught += 1;
  });
  console.log(`\n自证结果：${caught}/${cases.length} 个变异被抓`);
  if (caught !== cases.length) process.exitCode = 1;
}
