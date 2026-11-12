/**
 * 等价验证：演示班级后端只读硬闸（真实加载 common/review-demo.js 跑断言）
 *
 * 场景：
 *   demo-write   演示身份 + 写 action   → 必须抛 40010
 *   demo-read    演示身份 + 读 action   → 必须放行，且 **一次库都不查**（零开销）
 *   real-write   真实身份 + 写 action   → 必须放行（真实用户行为不变）
 *   exit-demo    演示身份 + switchAccount → 必须放行（否则卡在演示班出不来）
 *   review-demo  演示身份 + reviewDemo    → 必须放行（否则进不去演示班）
 *
 * 用法：node scripts/_verify_demo_backend_gate.js [场景]
 * 不带参数 = 全部场景
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const reviewDemo = require(path.join(ROOT, 'cloudfunctions', 'common', 'review-demo.js'));

function makeGuard(demoIds) {
  const stat = { demoClassIds: 0 };
  return {
    stat,
    demoClassIds: async () => { stat.demoClassIds += 1; return demoIds; }
  };
}

async function run(action, member, demoIds) {
  const guard = makeGuard(demoIds || [104]);
  const ctx = { member: Object.assign({ class_id: 1 }, member) };
  let threw = null;
  try {
    await reviewDemo.gateDemoWrite({}, guard, ctx, action);
  } catch (e) {
    threw = e;
  }
  return { threw, queries: guard.stat.demoClassIds };
}

const SCENARIOS = {
  'demo-write': async () => {
    const r = await run('leaveApply', { class_id: 104 });
    return { ok: !!(r.threw && r.threw.errCode === 40010), msg: `errCode=${r.threw && r.threw.errCode}` };
  },
  'demo-read': async () => {
    const r = await run('leaveMyList', { class_id: 104 });
    return { ok: !r.threw && r.queries === 0, msg: `threw=${!!r.threw} queries=${r.queries}` };
  },
  'real-write': async () => {
    const r = await run('leaveApply', { class_id: 1 });
    return { ok: !r.threw, msg: `threw=${r.threw && r.threw.errCode}` };
  },
  'exit-demo': async () => {
    const r = await run('switchAccount', { class_id: 104 });
    return { ok: !r.threw, msg: `threw=${r.threw && r.threw.errCode}` };
  },
  'review-demo': async () => {
    const r = await run('reviewDemo', { class_id: 104 });
    return { ok: !r.threw, msg: `threw=${r.threw && r.threw.errCode}` };
  },
  'demo-approve': async () => {
    // 审批通过 = 写（前端正则会漏判，后端名单必须抓到）
    const r = await run('leaveApprove', { class_id: 104 });
    return { ok: !!(r.threw && r.threw.errCode === 40010), msg: `errCode=${r.threw && r.threw.errCode}` };
  },
  'demo-image': async () => {
    // 本次穿透的正是这条：上传假条后写 leave_image
    const r = await run('leaveImageSet', { class_id: 104 });
    return { ok: !!(r.threw && r.threw.errCode === 40010), msg: `errCode=${r.threw && r.threw.errCode}` };
  }
};

(async () => {
  const want = process.argv[2];
  const names = want ? [want] : Object.keys(SCENARIOS);
  let bad = 0;
  for (const n of names) {
    const fn = SCENARIOS[n];
    if (!fn) { console.log(`[FAIL] 未知场景 ${n}`); bad += 1; continue; }
    const r = await fn();
    console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${n} — ${r.msg}`);
    if (!r.ok) bad += 1;
  }
  if (bad) process.exitCode = 1;
})();
