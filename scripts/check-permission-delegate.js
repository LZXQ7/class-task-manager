/**
 * 门禁：需求 D「权限下放」三域（2026-09-27）
 * ------------------------------------------------------------
 * 背景：职位（member.position）原先是**纯展示字段**，本批升格为**授权依据** ——
 * 「生活委员」获得排班权、「班长兼团支书」获得名册录入权。这一改把权限面从
 * 「一个人（超管）」扩到「三个角色」，风险点在于**任何一处漏判都会变成越权**：
 *   · 后端漏判 = 同学可自行排班 / 改别人班的名单；
 *   · 前端漏判 = 有权限的人看不到按钮（功能等于没上线）；
 *   · 授予权漏判 = 辅导员任命一个生活委员 = 间接把排班权发了出去。
 *
 * 判据按「**后端守卫 + 前端入口**」成对校验，并且**按能力位而不是 isSuper**：
 * 能力位单一来源是 auth.login 下发的 canSchedule / canRosterEdit / canGrantPosition，
 * 前端经 app.js 三个同名方法读 —— 判定式散落两处必然漂移。
 *
 * ⚠️ 计数式判据（16 / 2 / 4）是「路由覆盖完整性」的唯一可行表达：新增排班域路由
 *    却忘了声明 scheduleAuth，就是**裸奔**，必须是红灯。改动这些数字前先确认是否
 *    真的新增/删除了路由。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const md5 = p => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));
const count = (s, re) => (s.match(re) || []).length;
const eq = (a, b, msg) => (a === b ? ok(msg) : bad(msg + '（实得 ' + a + '，期望 ' + b + '）'));

const AUTH = read('cloudfunctions/auth/index.js');
const SCH = read('cloudfunctions/schedule/index.js');
const ADJ = read('cloudfunctions/adjust/index.js');
const MEM = read('cloudfunctions/member/index.js');
const GUARD = read('cloudfunctions/common/guard.js');
const APP = read('miniprogram/app.js');
const DUTY_W = read('miniprogram/pages/duty/index.wxml');
const MINE_W = read('miniprogram/pages/mine/index.wxml');
const ROS_W = read('miniprogram/pages/roster/index.wxml');
const ROS_J = read('miniprogram/pages/roster/index.js');

/* ============================================================
 * ① 三域能力位：单一来源 = auth.login
 * ============================================================ */
console.log('── ① 三域能力位（auth.login 下发，前端不再自算）');

/**
 * 能力位判定式（源码入 → 失败码出）。抽成函数供 §⑤ 变异自证复用同一套判据。
 */
function judgeCap(src) {
  const out = [];
  if (!/canSchedule:\s*!!\(guard\.isSuper\(m\) \|\| guard\.isDutyAdmin\(m\)\)/.test(src)) out.push('cap-schedule');
  if (!/canRosterEdit:\s*!!\(guard\.isSuper\(m\) \|\| guard\.isCounselor\(m\) \|\| guard\.isMonitor\(m\)\)/.test(src)) out.push('cap-roster');
  if (!/canGrantPosition:\s*!!guard\.isSuper\(m\)/.test(src)) out.push('cap-grant');
  return out;
}
const capFails = judgeCap(AUTH);
const capOk = c => !capFails.includes(c);
if (capOk('cap-schedule')) ok('canSchedule = 超管 | 生活委员（排班域）');
else bad('canSchedule 判定式缺失或不符（应为 超管 | isDutyAdmin）');
if (capOk('cap-roster')) ok('canRosterEdit = 超管 | 辅导员 | 班长（名册录入域，增改不含删）');
else bad('canRosterEdit 判定式缺失或不符（应为 超管 | 辅导员 | isMonitor）');
if (capOk('cap-grant')) ok('canGrantPosition = 仅超管（职位授予域）');
else bad('canGrantPosition 判定式缺失或被放宽（必须为仅超管）');

has(APP, /canSchedule\(\)\s*\{/, 'app.js 提供 canSchedule()');
has(APP, /canRosterEdit\(\)\s*\{/, 'app.js 提供 canRosterEdit()');
has(APP, /canGrantPosition\(\)\s*\{/, 'app.js 提供 canGrantPosition()');
// 前端不得再散落 position 字面量判定（判定式两处必然漂移）
const lit = [APP, ROS_J, DUTY_W, MINE_W, ROS_W].map(s =>
  count(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''), /position\s*===\s*'[^']*'/g)
).reduce((a, b) => a + b, 0);
eq(lit, 0, '前端仓位判定没有散落的 position 字面量（一律走能力位）');

/* ============================================================
 * ② 排班域：scheduleAuth 路由覆盖 + 派发器接线
 * ============================================================ */
console.log('\n── ② 排班域（排班域路由必须声明 scheduleAuth）');
// 16（原排班域） + 5（需求 D 下半：aiSettingGet / Save / Test / Clear / Models 同属排班域）
// ⚠️ 新增排班域路由时必须同步这个数 —— 漏声明 scheduleAuth 会让新路由裸奔，
//    本门禁就是为此而存在的（2026-09-27 加 AI 设置 4 条时它确实翻红提醒了）。
eq(count(SCH, /auth:\s*\{\s*scheduleAuth:\s*true\s*\}/g), 21, 'schedule 排班域路由数');
eq(count(ADJ, /auth:\s*\{\s*scheduleAuth:\s*true\s*\}/g), 2, 'adjust 排班域路由数');

/** 派发器接线（源码入 → 失败码出） */
function judgeDispatch(src) {
  return /if \(route\.auth && route\.auth\.scheduleAuth\) guard\.requireScheduleAuth\(ctx\);/.test(src)
    ? [] : ['dispatch'];
}
const dispFails = judgeDispatch(SCH);
if (!dispFails.length) ok('schedule 派发器：route.auth.scheduleAuth → guard.requireScheduleAuth');
else bad('schedule 派发器未接线（声明了 scheduleAuth 却不校验 = 裸奔）');
has(ADJ, /route\.auth\.scheduleAuth\) guard\.requireScheduleAuth\(ctx\)/, 'adjust 派发器同样接线');

has(GUARD, /function isDutyAdmin\(member\)\s*\{/, 'guard 有 isDutyAdmin');
has(GUARD, /String\(member\.position \|\| ''\) === POSITION_DUTY_ADMIN/, 'isDutyAdmin 按 position 判');
has(GUARD, /member\.group_tag !== 'X'/, 'isDutyAdmin 排除教职工（X 组不是学生班委）');
has(GUARD, /const POSITION_DUTY_ADMIN = '生活委员';/, 'POSITION_DUTY_ADMIN 字面量');
has(GUARD, /const POSITION_MONITOR = '班长兼团支书';/, 'POSITION_MONITOR 字面量');

// common 副本一致性：guard.js 的 12 份函数副本必须与源逐字一致
const src5 = md5('cloudfunctions/common/guard.js');
const copies = fs.readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== 'common')
  .map(d => 'cloudfunctions/' + d.name + '/common/guard.js')
  .filter(p => fs.existsSync(path.join(ROOT, p)));
const drift = copies.filter(p => md5(p) !== src5);
if (!drift.length) ok('common/guard.js 的 ' + copies.length + ' 份函数副本与源逐字一致');
else bad('common/guard.js 副本漂移：' + drift.join(', '));

/* ============================================================
 * ③ 名册录入域：requireRosterEdit + 跨班兜底
 * ============================================================ */
console.log('\n── ③ 名册录入域（增改不含删 + 只能动本班）');
has(MEM, /function requireRosterEditCheck\(ctx\)\s*\{/, 'member 有 requireRosterEditCheck 薄封装');
has(MEM, /return guard\.requireRosterEdit\(ctx\);/, '薄封装转调 guard.requireRosterEdit');
eq(count(MEM, /requireRosterEditCheck\(ctx\);/g), 4, '名册写入分支的守卫调用点');

/**
 * 跨班兜底（源码入 → 失败码出）。
 * applyImport 的 `mapping`（{ 班级标签 → classId }）是**前端回传、可伪造**的，
 * 放开到「班长」后若不校验调用者班级，就是跨班批量改姓名 / 分组的越权口。
 */
function judgeScope(src) {
  const out = [];
  if (!/if \(!\(guard\.isSuper\(meScope\) \|\| guard\.isCounselor\(meScope\)\)\)/.test(src)) out.push('scope-guard');
  if (!/noNoRows\.concat\(scopeSkipped\)/.test(src)) out.push('scope-report');
  return out;
}
const scopeFails = judgeScope(MEM);
if (!scopeFails.includes('scope-guard')) ok('applyImport 有本班作用域校验（非超管/辅导员只写本班）');
else bad('applyImport 缺跨班兜底：mapping 可被伪造 → 跨班批量改姓名 / 分组');
if (!scopeFails.includes('scope-report')) ok('越界分组计入 skippedRows（不静默丢弃）');
else bad('越界分组被静默丢弃（用户会以为导入成功）');

/* ============================================================
 * ④ 前端入口按能力位显隐（不是 isSuper）
 * ============================================================ */
console.log('\n── ④ 前端入口按能力位显隐');
has(DUTY_W, /wx:if="\{\{canSchedule\}\}" class="dt-admin /, '值日页排班操作区按 canSchedule 显示');
has(DUTY_W, /btn-text="\{\{canSchedule \? '去发布' : ''\}\}"/, '未发布提示的「去发布」按 canSchedule');
eq(count(DUTY_W, /wx:if="\{\{canSchedule\}\}"/g) + count(DUTY_W, /canSchedule \?/g), 6,
  '值日页排班入口全部改按 canSchedule（6 处：含 #27 合并行 / 合并行成员弹层的「调整›」入口）');
eq(count(DUTY_W, /isSuper/g), 0, '值日页不再用 isSuper 判排班权');
has(MINE_W, /wx:if="\{\{canSchedule\}\}"[^>]*bindtap="goManual"/, '「手动排班」入口按 canSchedule 显示');
has(MINE_W, /wx:if="\{\{canSchedule && pendingSwaps\.length\}\}"/, '「待确认换班」按 canSchedule 显示');
has(ROS_W, /wx:if="\{\{canRosterEdit\}\}"/, '名册「添加 / 导入」入口按 canRosterEdit 显示');
has(ROS_W, /&& canRosterEdit/, '名册「调组」入口按 canRosterEdit 显示');

/* ============================================================
 * ⑤ 变异自证：判据真的能抓到回归吗
 * ============================================================ */
console.log('\n── ⑤ 变异自证');
const mut = (src, from, to) => {
  const i = src.indexOf(from);
  return i < 0 ? null : src.slice(0, i) + to + src.slice(i + from.length);
};
const CASES = [
  ['cap-schedule', 'canSchedule 去掉生活委员（下放被撤销）',
    judgeCap, mut(AUTH, 'canSchedule: !!(guard.isSuper(m) || guard.isDutyAdmin(m)),', 'canSchedule: !!guard.isSuper(m),')],
  ['cap-roster', 'canRosterEdit 去掉班长',
    judgeCap, mut(AUTH, 'canRosterEdit: !!(guard.isSuper(m) || guard.isCounselor(m) || guard.isMonitor(m)),', 'canRosterEdit: !!guard.isSuper(m),')],
  ['cap-grant', '职位授予权放宽给辅导员',
    judgeCap, mut(AUTH, 'canGrantPosition: !!guard.isSuper(m),', 'canGrantPosition: !!(guard.isSuper(m) || guard.isCounselor(m)),')],
  ['dispatch', '派发器不再校验 scheduleAuth（声明了也不拦）',
    judgeDispatch, mut(SCH, 'if (route.auth && route.auth.scheduleAuth) guard.requireScheduleAuth(ctx);', 'if (route.auth && route.auth.scheduleAuth) void 0;')],
  ['scope-guard', '删掉 applyImport 的跨班兜底',
    judgeScope, mut(MEM, 'if (!(guard.isSuper(meScope) || guard.isCounselor(meScope)))', 'if (false)')],
  ['scope-report', '越界分组不再回报（静默丢弃）',
    judgeScope, mut(MEM, 'noNoRows.concat(scopeSkipped)', 'noNoRows')],
];
if (!capFails.length && !dispFails.length && !scopeFails.length) ok('真实源码零失败（好样本不误报）');
else bad('真实源码被判红 → 判据写错：' + capFails.concat(dispFails, scopeFails).join(', '));
CASES.forEach(([code, label, judge, mutated]) => {
  if (mutated === null) { bad('自证：[' + code + '] 变异锚点未命中（源码已变，需同步判据）'); return; }
  const f = judge(mutated);
  if (f.includes(code)) ok('自证：' + label + ' → 翻红 ✓');
  else bad('自证：' + label + ' 竟未翻红（期望 ' + code + '，实得 [' + f.join(',') + ']）');
});

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 需求 D 权限下放校验通过');
