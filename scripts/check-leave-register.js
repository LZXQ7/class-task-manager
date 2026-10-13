#!/usr/bin/env node
/**
 * 第 50 个门禁：班委「请假登记」的权限与多班隔离
 * ============================================================
 * 起因（2026-09-29，1.0.5 需求④）：新增「班委替本班学生登记请假 / 撤销 / 看板」。
 *   这一族动作有三处**静默越权/串班**风险，且都不会报错：
 *     ① 少了 `guard.requireLeaveRegister` ⇒ 任何绑定用户都能替别人登记请假；
 *     ② `leave_request` 的 INSERT 不带 `class_id` ⇒ 靠线上列 DEFAULT 1 蒙对，
 *        只有 1 班正确；而 schedule 侧按 `class_id` 过滤请假 ⇒ 其它班的请假
 *        在排班里查不到 ⇒ **已请假的人照样被排到值日**（本轮顺带修了 applyLeave 同款隐患）；
 *     ③ 撤销时不检查「同一天是否还被另一条生效请假覆盖」⇒ 撤一条把另一条的效力也抹掉。
 *
 * 判据（点名式，逐条断言在**函数体内**）：
 *   ① 三个路由存在，且各自体内都有 requireLeaveRegister；
 *   ② addLeave：显式写 class_id + 只给学生（group_tag <> 'X' + 排除测试账号）+ 幂等；
 *   ③ applyLeave：leave_request 的 INSERT 也显式写 class_id（顺带修的同一类隐患）；
 *   ④ cancelLeave：有「另一条生效请假覆盖则不恢复」的 `continue` 分支；
 *   ⑤ guard.js：isCommittee 必须排除教职工（group_tag !== 'X'），且两者都导出；
 *   ⑥ 能力位单一来源：auth.login 下发 canLeave、app.js 读取 profile.canLeave、
 *      roster 页据此控制入口显隐并接线三个 api；
 *   ⑦ **跨班隔离**（v0.7.32 补，2026-09-29 实踩）：查看类 leaveBoard / leaveSummary
 *      **必须**用 `guard.resolveClassId`（认传入 classId），**禁止** `classIdOf`
 *      —— 后者忽略传入、恒取调用者自己的班 ⇒ 超管查看其它班时也显示本班的请假人数
 *      （截图实锤：示例班级C显示 示例班级A 的 8 人）；
 *   ⑧ 变异：删掉 addLeave 的守卫 / 把 leaveBoard 的取班改成 classIdOf → 必须判死。
 *
 * 退出码 0 = 过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

function braceBlock(src, idx) {
  const open = src.indexOf('{', idx);
  if (open < 0) return '';
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (!d) return src.slice(idx, i + 1); }
  }
  return '';
}
/** routes 里某个 action 的整块（含 handler） */
function routeBlock(src, action) {
  const re = new RegExp('(?:^|\\n)\\s{2}' + action + ":\\s*\\{");
  const m = re.exec(src);
  return m ? braceBlock(src, m.index + m[0].length - 1) : '';
}
function fnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  return m ? braceBlock(src, m.index) : '';
}

const adjust = read('cloudfunctions/adjust/index.js');
// ⚠️ guard 的**真源**是 cloudfunctions/common/guard.js（sync-common.js 再复制进 12 个函数目录）。
//    改副本 = 改错文件：下一次 `node scripts/sync-common.js` 会把它覆盖掉（2026-09-29 实踩）。
const guardSrc = read('cloudfunctions/common/guard.js');
const auth = read('cloudfunctions/auth/index.js');
const appJs = read('miniprogram/app.js');
const rosterJs = read('miniprogram/pages/roster/index.js');
const rosterWxml = read('miniprogram/pages/roster/index.wxml');

/* ---------------- 审计函数（真源与变异共用） ---------------- */
function audit(adjustSrc) {
  const p = [];
  // 查看类（辅导员可读不可写）：leaveBoard / leaveSummary 必须 requireLeaveView
  ['leaveBoard', 'leaveSummary'].forEach((a) => {
    const b = routeBlock(adjustSrc, a);
    if (!b) { p.push('缺少路由 ' + a); return; }
    if (!/guard\.requireLeaveView\s*\(/.test(b)) p.push(a + ' 没有 requireLeaveView 守卫（辅导员应可读不可写）');
    // 跨班隔离（v0.7.32 问题②）：必须 resolveClassId（认传入 classId），禁止 classIdOf
    if (!/guard\.resolveClassId\s*\(/.test(b)) p.push(a + ' 取班没有用 guard.resolveClassId（跨班会串班）');
    if (/guard\.classIdOf\s*\(/.test(b)) p.push(a + ' 用了 classIdOf（忽略传入 classId，超管看别班也会显示本班人数）');
  });
  // 写类（登记 / 撤销）：必须 requireLeaveRegister（班委/超管）
  ['addLeave', 'cancelLeave'].forEach((a) => {
    const b = routeBlock(adjustSrc, a);
    if (!b) { p.push('缺少路由 ' + a); return; }
    if (!/guard\.requireLeaveRegister\s*\(/.test(b)) p.push(a + ' 没有 requireLeaveRegister 守卫');
  });
  const add = routeBlock(adjustSrc, 'addLeave');
  if (add) {
    if (!/INSERT INTO leave_request\s*\(\s*class_id\s*,/.test(add)) p.push('addLeave 写 leave_request 时没有显式 class_id');
    if (!/group_tag\s*<>\s*'X'/.test(add)) p.push('addLeave 没有排除教职工（group_tag <> \'X\'）');
    if (!/notTest\s*\(/.test(add)) p.push('addLeave 没有排除测试账号');
    /* 幂等：同人同区间**同时段**已生效则直接返回。
     * ⚠️ 判据必须容忍 SQL 被折成多段字符串拼接（`" +\n "` 会插在 'APPROVED' 与 AND 之间），
     *    否则「代码是对的、正则没匹配上」会被报成缺失（2026-10-08 踩）。
     * ⚠️ 时段必须一起比：只比日期会让「整天假」与「半天假」互相吞掉
     *    （登记 8:00–12:00 时撞上已有的整天假 → 静默返回 existed，半天假登记不进去）。 */
    if (!/status\s*=\s*'APPROVED'[\s"'+]*AND\s+start_date\s*=\s*\?/.test(add)) {
      p.push('addLeave 缺少幂等检查（同人同区间重复提交会双写）');
    }
    if (!/IFNULL\(\s*start_time\s*,/.test(add) || !/IFNULL\(\s*end_time\s*,/.test(add)) {
      p.push('addLeave 的幂等没比时段（半天假会被同日的整天假吞掉，登记不进去）');
    }
  }
  const apply = routeBlock(adjustSrc, 'applyLeave');
  if (apply && !/INSERT INTO leave_request\s*\(\s*class_id\s*,/.test(apply)) {
    p.push('applyLeave 写 leave_request 时没有显式 class_id（靠 DEFAULT 1 蒙对，多班会串班）');
  }
  const cancel = routeBlock(adjustSrc, 'cancelLeave');
  if (cancel) {
    if (!/status\s*=\s*'APPROVED'/.test(cancel)) p.push('cancelLeave 没有复查「是否仍被另一条生效请假覆盖」');
    if (!/continue;/.test(cancel)) p.push('cancelLeave 缺少「仍被覆盖则不恢复」的 continue 分支');
  }
  return p;
}

console.log('── ① 路由与守卫');
const problems = audit(adjust);
problems.forEach(fail);
if (!problems.length) ok('leaveBoard / leaveSummary（查看）用 requireLeaveView；addLeave / cancelLeave（写）用 requireLeaveRegister');

console.log('\n── ② guard.js：学生班委判定');
const isC = fnBody(guardSrc, 'isCommittee');
if (!isC) fail('guard.js 缺 isCommittee');
else if (!/group_tag\s*!==\s*'X'/.test(isC)) fail('isCommittee 没有排除教职工（辅导员也是 role=ADMIN/MONITOR，必须按 group_tag 排除）');
else ok('isCommittee 排除了教职工（group_tag !== \'X\'）');
if (!/function\s+requireLeaveRegister\s*\(/.test(guardSrc)) fail('guard.js 缺 requireLeaveRegister');
else ok('requireLeaveRegister 存在');
if (!/function\s+requireLeaveView\s*\(/.test(guardSrc)) fail('guard.js 缺 requireLeaveView');
else ok('requireLeaveView 存在');
if (!/module\.exports[\s\S]*isCommittee[\s\S]*requireLeaveRegister[\s\S]*requireLeaveView/.test(guardSrc)) fail('isCommittee / requireLeaveRegister / requireLeaveView 没有导出');
else ok('三者均已导出');

console.log('\n── ③ 能力位单一来源（auth → app → 页面）');
if (!/canLeave:\s*!!\(guard\.isSuper\(m\)\s*\|\|\s*guard\.isCommittee\(m\)\)/.test(auth)) {
  fail('auth.login 的 canLeave 判定式与 guard 不一致（应 isSuper || isCommittee）');
} else ok('auth.login 下发 canLeave = isSuper || isCommittee');
if (!/canLeave\(\)\s*\{[\s\S]*?p\.canLeave/.test(appJs)) fail('app.js 缺 canLeave() 读取 profile.canLeave');
else ok('app.js 读取 profile.canLeave（前端不自算角色）');
if (!/canLeave\s*:/.test(rosterJs) || !/canLeave\s*&&/.test(rosterJs)) fail('roster 页没有用 canLeave 控制入口/加载');
else ok('roster 页按 canLeave 控制入口与看板加载');
const apiHits = ['leaveBoard', 'leaveAdd', 'leaveCancel'].filter(n => rosterJs.indexOf('api.' + n + '(') >= 0);
if (apiHits.length !== 3) fail('roster 页没有接线全部三个 api（缺 ' + ['leaveBoard', 'leaveAdd', 'leaveCancel'].filter(n => apiHits.indexOf(n) < 0).join('/') + '）');
else ok('roster 页接线 leaveBoard / leaveAdd / leaveCancel');
if (!/leaveShow/.test(rosterWxml)) fail('请假弹层没有进 page-meta 的滚动锁表达式（滚动穿透）');
else ok('leaveShow 已进 page-meta 滚动锁');

console.log('\n── ⑥ 前端兜底：请假名单必须与本班名单交叉过滤（防后端串班）');
// 起因（2026-09-29 实拍）：云端 adjust.leaveBoard 曾是「忽略传入班级」的旧版，
// 超管查看 示例班级C时把 示例班级A 的 8 人端出来（点开的「请假登记」名单也是 示例班级A 的人）。
// 后端已修（见 ①），前端再加一道：本班名单里没有的人一律剔除。
if (/_sanitizeLeaveRows\s*\(/.test(rosterJs) && /rows\.filter\(r => ids\[r\.memberId\]\)/.test(rosterJs)) {
  ok('roster 页用本班名单交叉过滤请假行（后端串班时的兜底）');
} else fail('roster 页没有「只保留本班成员」的请假行过滤');
if (/if \(kw \|\| !members\.length\) return rows;/.test(rosterJs)) {
  ok('过滤只在成员搜索为空时启用（搜索态 members 是子集，过滤会误删本班的人）');
} else fail('过滤缺「搜索态跳过」保护 —— 搜索时会把本班请假的人误删');
if (/_resanitizeLeave\(\)/.test(rosterJs)) {
  ok('名单到齐后会再过滤一次（处理 leaveBoard 与 member.list 的到达顺序竞态）');
} else fail('缺「名单到齐后重新过滤」—— leaveBoard 先返回时兜底不生效');
if (/dropped\s*\n?\s*\?/.test(rosterJs) || /dropped/.test(rosterJs)) {
  ok('发生过过滤时统计按过滤后的行重算（否则「请假人数」仍是后端那份串班数字）');
} else fail('过滤后没有重算统计');

console.log('\n── ④ 变异自证：删掉 addLeave 的守卫 → 必须判死');
const mutated = adjust.replace(/(\n\s{2}addLeave:\s*\{[\s\S]*?)guard\.requireLeaveRegister\(ctx\);/, '$1');
if (mutated === adjust) fail('变异没生效（锚点失配）→ 自证无效');
else {
  const mp = audit(mutated);
  if (mp.some(x => x.indexOf('addLeave') >= 0 && x.indexOf('requireLeaveRegister') >= 0)) ok('变异被抓：' + mp.find(x => x.indexOf('addLeave') >= 0));
  else fail('变异未被抓住（判据被削弱）：' + JSON.stringify(mp));
}

console.log('\n── ⑤ 变异自证：leaveBoard 取班改成 classIdOf（跨班串号）→ 必须判死');
const m2 = adjust.replace(
  /(leaveBoard:\s*\{[\s\S]*?)const classId = await guard\.resolveClassId\(pool, ctx, payload\);/,
  '$1const classId = guard.classIdOf(ctx);'
);
if (m2 === adjust) fail('变异没生效（锚点失配）→ 自证无效');
else {
  const mp2 = audit(m2);
  const hit = mp2.find(x => x.indexOf('leaveBoard') >= 0 && x.indexOf('classIdOf') >= 0);
  if (hit) ok('变异被抓：' + hit);
  else fail('变异未被抓住（判据被削弱）：' + JSON.stringify(mp2));
}

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 请假登记权限与多班隔离体检通过');
