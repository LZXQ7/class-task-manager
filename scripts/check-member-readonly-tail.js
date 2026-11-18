#!/usr/bin/env node
/**
 * 学号可见范围门禁（2026-11-18 用户收紧口径）
 * ================================================================================
 * 用户最终口径：**仅超管 / 辅导员 / 班委可以看到学号，普通成员看不到**。
 *
 * 演进：
 *   · 2026-10-28：read 分支为隐私故意不回学号 → 连班委都看不到（bug）。
 *   · 2026-11-18 上轮（1.0.8.62）：把尾号放给**所有** read 行 → 普通成员也看到了（放开过头）。
 *   · 2026-11-18 本轮：收紧到班委及以上。班委与普通成员**同走 read 分支**（前端 canManage
 *     只含 isSuper / 辅导员(X组)），所以必须后端按调用者身份 gate、前端加展示闸双保险。
 *
 * 身份链路（真源）：
 *   · 超管(role=ADMIN,is_super=1) / 辅导员(group_tag='X') → canManage=true → public='manage'
 *     → 走「X 号 · 值日 N 次」分支（本门禁只守回归护栏，不动它）。
 *   · 班委(role ∈ {ADMIN,MONITOR} 且非 X) / 普通成员(role=MEMBER) → public='read'
 *     → 后端 guard.isCommittee 区分：班委回 seq 尾号，普通成员**连 seq 都不回**。
 *
 * 定规（任一条翻红即 bug 复发）：
 *   ① 后端 read 分支用 guard.isCommittee(ctx.member) 算 canSeeNo，seq 派生受它 gate；
 *      普通成员返回体**无 seq / studentNo / bound / role / isSuper**。
 *   ② 前端 data 有 canSeeNo = isSuper || 辅导员 || canLeave(=超管||学生班委)，权威位来自后端下发。
 *   ③ wxml 尾号小字分支条件含 canSeeNo：普通成员即使读到缓存里残留的 seq 也不显示；
 *      该分支不含值日次数 / 完整学号 / 绑定态。
 *   ④ 管理视图（!readOnly）「X 号 · 值日 N 次」保持原样（回归护栏）。
 *
 * 判据：真跑 wxml 条件 + 真跑后端 seq gate 三元 + 扫源码，3 变异自证。
 * 用法：node scripts/check-member-readonly-tail.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WXML = read('miniprogram/pages/roster/index.wxml');
const JS = read('miniprogram/pages/roster/index.js');
const MEMBER = read('cloudfunctions/member/index.js');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

/** 取 read 分支源码 */
function readBlock(src) {
  const i = src.indexOf("payload.public === 'read'");
  const j = src.indexOf("payload.public === 'manage'", i < 0 ? 0 : i);
  return (i < 0 || j < 0) ? '' : src.slice(i, j);
}

/** 真跑一个表达式：scope 提供具名变量（item / canSeeNo 等） */
function testExpr(expr, scope) {
  if (!expr) return null;
  try {
    const names = Object.keys(scope);
    const vals = names.map((n) => scope[n]);
    // eslint-disable-next-line no-new-func
    return new Function(...names, 'return (' + expr + ');')(...vals);
  } catch (e) {
    return null;
  }
}

/** 抓 mb-sub 三个分支的条件与内容（按出现顺序：X组 / 只读尾号 / 管理值日） */
function subBranches(wxml) {
  const re = /<view\s+wx:(if|elif)="\{\{([^}]*)\}\}"\s+class="mb-sub">([\s\S]*?)<\/view>/g;
  const out = [];
  let m;
  while ((m = re.exec(wxml))) out.push({ kind: m[1], cond: m[2], body: m[3] });
  return out;
}

const RB = readBlock(strip(MEMBER));
const brs = subBranches(WXML);
const roBranch = brs.find((b) => /readOnly/.test(b.cond) && /seq/.test(b.cond));
const mgBranch = brs.find((b) => /!item\.readOnly/.test(b.cond));

console.log('── ① 后端 read 分支：班委 gate 尾号，普通成员连 seq 都不回');
check(/guard\.isCommittee\s*\(\s*(ctx\.member|\w+)\s*\)/.test(RB),
  'read 分支用 guard.isCommittee(isSuper/辅导员之外的调用者) 区分班委与普通成员');
check(/\bcanSeeNo\b/.test(RB), 'read 分支存在 canSeeNo 身份闸');
// 真跑 seq gate 三元：canSeeNo=false → 无 seq；true → seq=尾号
const seqGateM = RB.match(/\.\.\.\(\s*(canSeeNo\s*\?\s*\{\s*seq\s*:\s*seqTail\([^)]*\)\s*\}\s*:\s*\{\})\s*\)/);
const seqTailM = strip(MEMBER).match(/function\s+seqTail\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/);
if (seqGateM && seqTailM) {
  // eslint-disable-next-line no-new-func
  const seqTail = new Function(seqTailM[1], seqTailM[2]);
  const reveal = testExpr(seqGateM[1], { canSeeNo: true, seqTail, r: { student_no: '000000000128' } });
  const hide = testExpr(seqGateM[1], { canSeeNo: false, seqTail, r: { student_no: '000000000128' } });
  check(reveal && String(reveal.seq) === '28', '班委(canSeeNo=true) → 收到 seq 尾号 28');
  check(hide && hide.seq === undefined, '普通成员(canSeeNo=false) → 返回体无 seq（连尾号都不给）');
  check(String(seqTail('000000000101')) === '1' || String(seqTail('000000000101')) === '01',
    'seqTail 对 01 号产出 1 或 01（后两位口径不变）');
} else {
  check(false, '后端存在可真跑的 seq gate 三元 + seqTail 取值函数');
}
check(!/studentNo\s*:/.test(RB) && !/bound\s*:/.test(RB), 'read 分支仍不回完整 studentNo / bound');
check(!/\brole\s*:/.test(RB) && !/isSuper\s*:/.test(RB), 'read 分支仍不回 role / isSuper');
check(/readOnly\s*:\s*true/.test(RB), 'read 分支仍带 readOnly 标记');

console.log('\n── ② 前端 canSeeNo 身份闸（超管 || 辅导员 || 班委）');
check(/\bcanSeeNo\s*:\s*false/.test(JS), 'data 声明 canSeeNo 初值 false');
// 真跑派生式：三种可见身份 true，普通成员 false
const deriveM = JS.match(/canSeeNo\s*:\s*([^,\n]+canLeave[^,\n]*)/);
if (deriveM) {
  const d = deriveM[1];
  const sup = testExpr(d, { isSuper: true, isCounselor: false, canLeave: false });
  const cou = testExpr(d, { isSuper: false, isCounselor: true, canLeave: false });
  const com = testExpr(d, { isSuper: false, isCounselor: false, canLeave: true });
  const mem = testExpr(d, { isSuper: false, isCounselor: false, canLeave: false });
  check(!!sup && !!cou && !!com, 'canSeeNo 派生式：超管 / 辅导员 / 班委(canLeave) 均为 true');
  check(!mem, 'canSeeNo 派生式：普通成员为 false');
} else {
  check(false, 'canSeeNo 派生式含 canLeave（=超管||学生班委，权威位来自 auth.login）');
}

console.log('\n── ③ wxml：尾号小字分支受 canSeeNo 闸（真跑条件）');
check(!!roBranch, '存在只读行尾号小字分支（带 readOnly && seq 条件）');
if (roBranch) {
  const C = roBranch.cond;
  check(/canSeeNo/.test(C), '尾号分支条件含页面级 canSeeNo 闸');
  const committee = testExpr(C, { canSeeNo: true, item: { readOnly: true, seq: 28, groupTag: 'A' } });
  const plainNoCache = testExpr(C, { canSeeNo: false, item: { readOnly: true, seq: 28, groupTag: 'A' } });
  const admin = testExpr(C, { canSeeNo: true, item: { readOnly: false, seq: 28, groupTag: 'A' } });
  const zero = testExpr(C, { canSeeNo: true, item: { readOnly: true, seq: 0, groupTag: 'A' } });
  check(!!committee, '班委(canSeeNo=true)有尾号 → 显示「28 号」');
  check(!plainNoCache, '普通成员(canSeeNo=false)即使缓存带 seq=28 也不显示（防串味）');
  check(!admin, '管理视图不走只读尾号分支（避免与「值日 N 次」重复）');
  check(!zero, 'seq=0（无学号）→ 不显示半截「0 号」');
  check(/\{\{\s*item\.seq\s*\}\}\s*号/.test(roBranch.body), '小字内容是「{{item.seq}} 号」');
  check(!/cnt-num|值日|studentNo|bound|已绑定/.test(roBranch.body), '尾号小字不含值日次数/完整学号/绑定态');
}
check(!!mgBranch && /!item\.readOnly/.test(mgBranch.cond) && /cnt-num/.test(mgBranch.body),
  '管理视图「X 号 · 值日 N 次」分支保持原样（回归护栏）');

console.log('\n── ④ 变异自证（改坏 → 对应判据必须翻红）');
// 变异1：wxml 去掉 canSeeNo 闸 → 普通成员场景翻真
if (roBranch) {
  const mCond = roBranch.cond.replace(/canSeeNo\s*&&\s*/, '');
  const mutated = testExpr(mCond, { canSeeNo: false, item: { readOnly: true, seq: 28, groupTag: 'A' } });
  check(!!mutated && mCond !== roBranch.cond,
    '变异被抓：wxml 去掉 canSeeNo → 普通成员又看到尾号');
}
// 变异2：后端 seq gate 恒真（去掉身份判断）→ 普通成员拿到 seq
if (seqGateM) {
  const ungated = seqGateM[1].replace(/canSeeNo\s*\?/, 'true ?');
  // eslint-disable-next-line no-new-func
  const seqTail = seqTailM ? new Function(seqTailM[1], seqTailM[2]) : null;
  const leak = testExpr(ungated, { canSeeNo: false, seqTail, r: { student_no: '000000000128' } });
  check(!!leak && String(leak.seq) === '28',
    '变异被抓：后端 seq gate 恒真 → 普通成员返回体又带 seq');
}
// 变异3：canSeeNo 派生去掉 canLeave → 班委看不到
if (deriveM) {
  const noCom = deriveM[1].replace(/\|\|\s*canLeave/, '');
  const com = testExpr(noCom, { isSuper: false, isCounselor: false, canLeave: true });
  check(!com && noCom !== deriveM[1],
    '变异被抓：canSeeNo 去掉 canLeave → 班委看不到学号');
}

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 学号可见范围检查全部通过（仅超管/辅导员/班委）'));
process.exit(failed ? 1 : 0);
