#!/usr/bin/env node
/**
 * 门禁：模拟态下「可切班级」的收窄口径（utils/class-scope.js，2026-11-14）
 * ============================================================
 * 真实报障：超级管理员切到辅导员身份后，课表页「查看班级」只剩 1 个班（应为 5 个）。
 *   根因：收窄用的是 profile.classId，而**辅导员是全局账号、class_id 恒 0**，
 *   后端 login 会拿「第一个绑定班」顶上 ⇒ effId=1 ⇒ 5 个班被 filter 成 1 个。
 *   班费 / 值日 / 班级信息都没这道收窄，所以只有课表页塌了。
 *
 * 为什么单独一道门禁：这个 bug 需要「模拟态 + 教职工」两个条件同时成立才触发，
 *   正常开发时几乎不会走到；一旦有人把收窄逻辑改回按 classId 一刀切，
 *   表现是「辅导员进入课表页只能看到一个班」——不崩、不报错，很容易带着上线。
 *
 * 锁住的四件事：
 *   ① 非模拟态：原样返回（不能误收窄）
 *   ② 模拟态 + 辅导员（groupTag='X'）：**保留全部绑定班**
 *   ③ 模拟态 + 学生 / 测试超管（单班身份）：收窄到目标班（隔离铁律不能被绕过）
 *   ④ 目标班不在候选里（身份映射失同步）：保留原样，别把切班条抹成空
 *
 * 自证：3 组变异（去掉 X 分支 / 改用 isSuper 判断 / 无脑 filter）必须翻红。
 *
 * 用法：node scripts/check-timetable-class-scope.js
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { narrowByImpersonation } = require(path.join(ROOT, 'miniprogram/utils/class-scope.js'));

const CHIPS = [
  { id: 1, name: '示例专业B1班' },
  { id: 2, name: '示例专业A2班' },
  { id: 3, name: '示例专业A1班' },
  { id: 9, name: '商务示例专业B2班' },
  { id: 10, name: '示例专业B2班' }
];

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/* ① 非模拟态 */
{
  const r = narrowByImpersonation(CHIPS, { switched: false, profile: { classId: 1, groupTag: 'X' } });
  ok(r.length === 5, '① 非模拟态：5 个班原样返回（不误收窄）');
}

/* ② 模拟态 + 辅导员 */
{
  const r = narrowByImpersonation(CHIPS, { switched: true, profile: { classId: 1, groupTag: 'X' } });
  ok(r.length === 5, '② 模拟态 + 辅导员：保留全部 5 个绑定班（本轮修复的核心）');
  ok(r.some(c => c.id === 3) && r.some(c => c.id === 10), '② 示例班级A / 英语 2601 都还在（不是只剩首个绑定班）');
}

/* ③ 单班身份仍然收窄 */
{
  const stu = narrowByImpersonation(CHIPS, { switched: true, profile: { classId: 2, groupTag: 'B' } });
  ok(stu.length === 1 && stu[0].id === 2, '③ 模拟成学生：收窄到 2 班（隔离铁律不绕过）');
  const sup = narrowByImpersonation(CHIPS, { switched: true, profile: { classId: 3, groupTag: 'A' } });
  ok(sup.length === 1 && sup[0].id === 3, '③ 模拟成测试超管：收窄到 3 班（仍按 classId 隔离）');
}

/* ④ 目标班不在候选里 */
{
  const r = narrowByImpersonation(CHIPS, { switched: true, profile: { classId: 104, groupTag: 'A' } });
  ok(r.length === 5, '④ 目标班 104 不在候选里：保留原样，不把切班条抹成空');
}

/* ⑤ 入参容错 */
{
  ok(narrowByImpersonation(null, { switched: true }).length === 0, '⑤ 入参为 null 不炸（返回空数组）');
  ok(narrowByImpersonation(CHIPS).length === 5, '⑤ 不传 globalData 不炸（按非模拟态处理）');
}

/* ================= 变异自证 ================= */
console.log('\n── 自证（改坏一处必须翻红）');
const SRC = require('fs').readFileSync(path.join(ROOT, 'miniprogram/utils/class-scope.js'), 'utf8');
function runMutated(mutSrc) {
  const wrap = { exports: {} };
  /* eslint-disable no-new-func */
  new Function('module', 'exports', mutSrc)(wrap, wrap.exports);
  return wrap.exports.narrowByImpersonation;
}
const MUTANTS = [
  {
    name: '去掉「辅导员不收窄」分支（回到按 classId 一刀切 —— 本轮 bug 原形）',
    from: "  if (p.groupTag === 'X') return list;\n",
    to: ''
  },
  {
    name: '改用 isSuper 判断「能不能切班」（演示超管会被放过，隔离铁律破）',
    from: "  if (p.groupTag === 'X') return list;\n",
    to: "  if (p.isSuper) return list;\n"
  },
  {
    name: '目标班不在候选里也硬 filter（切班条被抹成空）',
    from: '  if (!list.some(c => Number(c.id) === effId)) return list;\n',
    to: ''
  }
];
let mFail = 0;
MUTANTS.forEach((mu) => {
  const bad = SRC.split(mu.from).join(mu.to);
  if (bad === SRC) { mFail++; console.log('  ✗ 变异样本没命中源码：' + mu.name); return; }
  const fn = runMutated(bad);
  let caught = false;
  try {
    // ② 辅导员必须 5 个
    if (fn(CHIPS, { switched: true, profile: { classId: 1, groupTag: 'X' } }).length !== 5) caught = true;
    // ④ 目标班不在候选里必须保留
    if (!caught && fn(CHIPS, { switched: true, profile: { classId: 104, groupTag: 'A' } }).length !== 5) caught = true;
    // ③ 单班身份仍要收窄
    if (!caught && fn(CHIPS, { switched: true, profile: { classId: 2, groupTag: 'B' } }).length !== 1) caught = true;
  } catch (e) { caught = true; }
  if (caught) { pass++; console.log('  ✓ 抓住 → ' + mu.name); }
  else { mFail++; console.log('  ✗ 漏放 → ' + mu.name); }
});

console.log('\n通过=' + pass + ' 失败=' + (fail + mFail));
process.exit(fail + mFail ? 1 : 0);
