#!/usr/bin/env node
/**
 * 门禁 #60：个人课表（member_timetable）后端契约自证
 * ============================================================
 * 背景（2026-10-06）：新增「所有人可编辑自己的课表（仅自己可见）+ 班长/副班长
 * 发布到全班」。这套东西最危险的不是能不能跑，而是**越权**：
 *   ① my* 三件套若采信 payload.memberId ⇒ 任何人都能改/删他人课表；
 *   ② mySave/myDelete 的 UPDATE/DELETE 若不带 member_id ⇒ 同上；
 *   ③ myList 若不按本班过滤 ⇒ 跨班看到别人的课表；
 *   ④ publishToClass 若不校验职位 ⇒ 任何成员都能覆盖全班课表；
 *   ⑤ publishToClass 覆盖 session 前不回滚 duty_count ⇒ 值日游标单向漂移
 *      （删了值日行却没扣标记 = 那一格永远排不到人）。
 *
 * 本门禁把上面 5 条逐一钉死，并做**变异自证**（故意弄坏 → 必须判死），
 * 避免「判据命中注释」「放宽判据后变异仍放行」这类假绿。
 *
 * 判据一律 stripComments —— 注释里写「这里要校验 member_id」不算通过。
 */
const fs = require('fs');

const COURSE = 'cloudfunctions/course/index.js';
const GUARD_SRC = 'cloudfunctions/common/guard.js';

function read(p) { return fs.readFileSync(p, 'utf8'); }

/** 剥掉 // 与 /* *\/ 注释，避免判据命中解释性文字（5 次踩坑后的硬要求） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** 取某个 action 的 handler 函数体（按 `  name: {` 到下一个同级 `  name2: {`） */
function actionBody(src, action) {
  const start = src.indexOf('\n  ' + action + ': {');
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const problems = [];
function need(cond, msg) { if (!cond) problems.push(msg); }

const rawCourse = read(COURSE);
const rawGuard = read(GUARD_SRC);
const course = stripComments(rawCourse);
const guard = stripComments(rawGuard);

// ── 锚点存在性：action 必须真的注册了（防止把函数体改了却没挂路由）──
const ACTIONS = ['myList', 'mySave', 'myDelete', 'myImport', 'syncFromClass', 'publishToClass', 'myClear'];
ACTIONS.forEach(a => {
  need(new RegExp('\\n {2}' + a + ': \\{').test(course), 'course：缺少 action ' + a);
});

const myList = actionBody(course, 'myList');
const mySave = actionBody(course, 'mySave');
const myDelete = actionBody(course, 'myDelete');
const myImport = actionBody(course, 'myImport');
const sync = actionBody(course, 'syncFromClass');
const publish = actionBody(course, 'publishToClass');
const myClear = actionBody(course, 'myClear');

// ① myList 只读本人：必须用 ctx.member.id + classIdOf，且按本班过滤
need(/classIdOf\s*\(\s*ctx\s*\)/.test(myList), 'myList：未用 guard.classIdOf(ctx) 取本班');
need(/member\.id/.test(myList), 'myList：未用 ctx.member.id 限定本人');
need(/member_id\s*=\s*\?/.test(myList) && /class_id\s*=\s*\?/.test(myList),
  'myList：WHERE 必须同时按 member_id 与 class_id 过滤（个人课表不得跨班/见他人）');
need(!/payload\.\s*memberId/.test(myList), 'myList：不得采信 payload.memberId');

// ② mySave 新增走本人；更新必须带 member_id 兜底（防按 id 裸改他人行）
need(/classIdOf\s*\(\s*ctx\s*\)/.test(mySave), 'mySave：未用 guard.classIdOf(ctx) 取本班');
need(!/payload\.\s*memberId/.test(mySave), 'mySave：不得采信 payload.memberId（否则可写他人课表）');
const upd = /UPDATE\s+member_timetable[\s\S]*?WHERE[\s\S]*?member_id\s*=\s*\?/i.test(mySave);
need(upd, 'mySave：UPDATE 必须带 member_id 条件（否则按 id 裸改可篡改他人课表）');
need(/INSERT INTO member_timetable[\s\S]*?member_id/i.test(mySave), 'mySave：新增必须写入 member_id');
// 覆写他人行时 affectedRows=0 ⇒ 抛错，而不是静默成功
need(/affectedRows[\s\S]{0,120}?BizError/.test(mySave), 'mySave：更新命中 0 行时必须抛错（不得静默成功）');

// ③ myDelete 同款
need(!/payload\.\s*memberId/.test(myDelete), 'myDelete：不得采信 payload.memberId');
need(/DELETE FROM member_timetable[\s\S]*?member_id\s*=\s*\?[\s\S]*?class_id\s*=\s*\?/i.test(myDelete),
  'myDelete：DELETE 必须同时带 member_id 与 class_id（防删他人课表）');
need(/affectedRows[\s\S]{0,120}?BizError/.test(myDelete), 'myDelete：删除 0 行时必须抛错');

// ④ myImport：写个人表、只认本人、覆盖前先清自己的、只导 COURSE、复用解析器不重复实现
need(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(myImport), 'myImport：auth 必须是 needBind（谁都能导自己的课表）');
need(!/payload\.\s*memberId/.test(myImport), 'myImport：不得采信 payload.memberId');
need(/member_id\s*=\s*\?/.test(myImport) && /class_id\s*=\s*\?/.test(myImport),
  'myImport：DELETE 必须带 member_id + class_id（覆盖只能清自己的）');
need(/DELETE\s+FROM\s+member_timetable\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+member_id\s*=\s*\?/i.test(myImport),
  'myImport：必须先清空本人旧课表再导入（覆盖式），且条件锁定本人');
need(/INSERT\s+INTO\s+member_timetable/i.test(myImport), 'myImport：必须写 member_timetable（不是全班 session）');
need(/member\.id/.test(myImport) && /classIdOf\s*\(\s*ctx\s*\)/.test(myImport), 'myImport：写入须用 ctx.member.id + 本班 classId');
need(/kind\s*===\s*'COURSE'/.test(myImport) || /'COURSE'\s*\)/.test(myImport), 'myImport：只应导入 COURSE（个人课表不承载保洁值日）');
need(/parseTimetableXlsx/.test(myImport), 'myImport：必须复用 import-parse 的解析器（不得重复实现）');
need(/base64/.test(myImport), 'myImport：必须收 base64（云函数在 VPC 内回下载云存储极慢会 20s 超时）');
need(/if\s*\(\s*!payload\.commit\s*\)/.test(myImport), 'myImport：必须有 commit 开关（默认预览、确认后才落库）');

// ⑤ syncFromClass：全班 → 个人（人人可用，与 publishToClass 方向相反）
need(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(sync), 'syncFromClass：auth 必须是 needBind（人人可用自己的课表）');
need(!/payload\.\s*memberId/.test(sync), 'syncFromClass：不得采信 payload.memberId');
need(/classIdOf\s*\(\s*ctx\s*\)/.test(sync), 'syncFromClass：未用 classIdOf（必须锁本班）');
// 覆盖式：先清本人，再 INSERT；且 INSERT 的 SELECT 源必须是 session+course（本班 COURSE）
need(/DELETE\s+FROM\s+member_timetable\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+member_id\s*=\s*\?/i.test(sync),
  'syncFromClass：必须先清空本人旧课表（覆盖式）且条件锁定本人');
need(/FROM\s+session\s+s\s+JOIN\s+course\s+c\s+ON\s+c\.id\s*=\s*s\.course_id/i.test(sync),
  'syncFromClass：源必须是 session JOIN course（拿全班课次）');
need(/s\.class_id\s*=\s*\?/.test(sync) && /kind\s*=\s*'COURSE'/.test(sync),
  'syncFromClass：必须按本班 + 只取 COURSE（保洁值日课次不进个人课表）');
need(/INSERT\s+INTO\s+member_timetable/i.test(sync), 'syncFromClass：必须写 member_timetable（不是全班 session）');
need(/member\.id/.test(sync), 'syncFromClass：写入须用 ctx.member.id');
need(/if\s*\(\s*!payload\.commit\s*\)/.test(sync), 'syncFromClass：必须有 commit 开关（覆盖式必须先预览再确认）');
// 组过滤（2026-10-06 真机反馈）：A 组只拿「全体课+A组课」、B 组只拿「全体课+B组课」。
// 判据锚真实代码：member.group_tag 取组 + SQL 里同时出现 IS NULL 与 = ? 两个 group_scope 条件。
need(/member\.group_tag\s*===\s*'A'/.test(sync) && /member\.group_tag\s*===\s*'B'/.test(sync),
  'syncFromClass：必须按 member.group_tag（A/B）决定组过滤口径');
need(/group_scope\s+IS\s+NULL/.test(sync) && /s\.group_scope\s*=\s*\?/.test(sync),
  'syncFromClass：源查询必须含「全体课(IS NULL) + 本组课(= ?)」的组过滤条件');
// 去重（2026-10-06 真机反馈）：session 里同一门课同一格可能有「NULL 全体课 + 同内容组课」
// 两行（青果导入同名未复用遗留）⇒ 不去重个人课表同格叠两门。判据锚真实代码三件套。
need(/const seen = \{\};/.test(sync)
  && /if\s*\(seen\[k\]\)\s*return;/.test(sync)
  && /\[r\.name,\s*r\.day_of_week,\s*r\.period,\s*r\.weeks,\s*r\.week_rule\]/.test(sync),
  'syncFromClass：写入前必须按（课名+星期+节次+周次+规则）去重');
// ⚠️ 方向别搞反：sync 不得回滚 duty 标记（它不动 session），publish 才要
need(!/rollbackDutyMarkers/.test(sync), 'syncFromClass：不应回滚 duty 标记（它不删 session，删了反而错）');

// ⑦ myClear：清空本人个人课表（人人可用，只清自己，不回滚 duty 标记）
need(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(myClear), 'myClear：auth 必须是 needBind（人人可清自己的课表）');
need(!/payload\.\s*memberId/.test(myClear), 'myClear：不得采信 payload.memberId');
need(/classIdOf\s*\(\s*ctx\s*\)/.test(myClear), 'myClear：未用 classIdOf（必须锁本班）');
need(/DELETE\s+FROM\s+member_timetable\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+member_id\s*=\s*\?/i.test(myClear),
  'myClear：DELETE 必须同时带 class_id 与 member_id（防清他人/跨班）');
need(/member\.id/.test(myClear), 'myClear：删除须用 ctx.member.id（锁本人）');
// ⚠️ 个人课表不驱动值日，清空不得回滚 duty 标记（那是 session 表的职责）
need(!/rollbackDutyMarkers/.test(myClear), 'myClear：不应回滚 duty 标记（个人课表清空不影响值日）');

// ⑥ publishToClass 权限 + 只发本人 + 只取本班
need(/needTimetablePublish:\s*true/.test(publish), 'publishToClass：auth 必须是 needTimetablePublish（超管/班长/副班长）');
need(!/requireSuper/.test(publish), 'publishToClass：不得降级成仅超管');
need(/classIdOf\s*\(\s*ctx\s*\)/.test(publish), 'publishToClass：未用 classIdOf（班委必须仅限本班，不得采信 payload.classId）');
need(!/payload\.classId/.test(publish), 'publishToClass：不得采信 payload.classId（跨班覆盖越权）');
need(/FROM member_timetable[\s\S]*?member_id\s*=\s*\?/i.test(publish), 'publishToClass：源必须限定 member_id=本人');
need(/kind\s*=\s*'COURSE'/.test(publish), 'publishToClass：只应发布 COURSE（保洁课次不随个人课表覆盖）');

// ⑤ 覆盖 session 前必须回滚值日标记（否则游标单向漂移）
const rollbackBeforeDelete = /await\s+rollbackDutyMarkers\s*\(\s*conn[\s\S]*?DELETE FROM session/.test(publish);
need(rollbackBeforeDelete, 'publishToClass：删 session 前必须先 await rollbackDutyMarkers（否则值日游标漂移）');
need(/DELETE\s+d\s+FROM\s+duty/.test(publish) || /status\s+IN\s*\(\s*'PENDING'\s*,\s*'ONGOING'\s*\)/.test(publish),
  'publishToClass：删课次时必须连带清理未开始的 PENDING/ONGOING 值日行');
need(/session_shift/.test(publish), 'publishToClass：删课次前必须清 session_shift（否则留下幽灵调课记录）');
need(/beginTransaction/.test(publish) && /commit/.test(publish) && /rollback/.test(publish),
  'publishToClass：必须走事务（删+插跨多语句，中途失败会留下空课表）');

// ⑥ guard 真源必须有 副班长 常量 + 发布守卫
need(/POSITION_VICE_MONITOR\s*=\s*'副班长'/.test(guard), "guard：缺 POSITION_VICE_MONITOR = '副班长'");
need(/function\s+isViceMonitor\s*\(/.test(guard), 'guard：缺 isViceMonitor()');
need(/function\s+requireTimetablePublish\s*\(/.test(guard), 'guard：缺 requireTimetablePublish()');
// 发布守卫只认 超管|班长|副班长 —— 刻意不含辅导员（发布覆盖全班，授权面要窄）
const pubBody = (guard.match(/function\s+requireTimetablePublish\s*\([^)]*\)\s*\{[\s\S]*?\n\}/) || [''])[0];
need(/isSuper\s*\(/.test(pubBody) && /isMonitor\s*\(/.test(pubBody) && /isViceMonitor\s*\(/.test(pubBody),
  'requireTimetablePublish：必须同时放行 超管 / 班长 / 副班长');
need(!/isCounselor\s*\(/.test(pubBody), 'requireTimetablePublish：不得放行辅导员（发布覆盖全班课表，授权面须窄于名册编辑）');
const viceBody = (guard.split('function isViceMonitor')[1] || '').split('\nfunction ')[0];
need(/group_tag\s*!==\s*'X'/.test(viceBody),
  "isViceMonitor：必须排除 group_tag='X'（教职工不得靠改职位混进学生权限）");

// ── 输出 ──
console.log('── 门禁 #60：个人课表后端契约 ──');
if (problems.length) {
  problems.forEach(p => console.log('FAIL  ' + p));
} else {
  console.log('PASS  ① myList 只读本人本班（不采信 payload.memberId）');
  console.log('PASS  ② mySave 更新/新增都锁 member_id，0 行抛错');
  console.log('PASS  ③ myDelete 带 member_id+class_id，0 行抛错');
  console.log('PASS  ④ myImport 覆盖式写个人表（先清本人）、只导 COURSE、复用解析器、有 commit 开关');
  console.log('PASS  ⑤ syncFromClass 全班→个人（人人可用、只取本班 COURSE、按 A/B 组过滤、覆盖式、有 commit）');
  console.log('PASS  ⑥ publishToClass 仅 超管/班长/副班长，且只发本人本班 COURSE');
  console.log('PASS  ⑦ publishToClass 删 session 前回滚 duty 标记 + 清 session_shift + 走事务');
  console.log('PASS  ⑧ guard 有 副班长 常量 / isViceMonitor / requireTimetablePublish（不含辅导员）');
  console.log('PASS  ⑨ myClear 清空本人课表（needBind、锁本人、不回滚 duty 标记）');
}

// ── 变异自证：每条判据都要「弄坏必被抓」 ──
console.log('\n── 自证：逐条变异必被抓 ──');
let caught = 0, total = 0;
function mutate(name, fn) {
  total++;
  const m = fn();
  const bad = audit(m.course, m.guard);
  if (bad.length) { console.log('PASS  ' + name + ' → 被抓住'); caught++; }
  else { console.log('FAIL  ' + name + ' → 变异放行（判据不实）'); }
}
function audit(c, g) {
  const save = problems.length;
  problems.length = 0;
  // 复用主判据：临时替换模块级变量不便，故内联复算（保持与主判据同源）
  const A = ACTIONS.map(a => new RegExp('\\n {2}' + a + ': \\{').test(c));
  if (A.some(x => !x)) problems.push('action 缺失');
  const L = actionBody(c, 'myList'), S = actionBody(c, 'mySave'),
    D = actionBody(c, 'myDelete'), I = actionBody(c, 'myImport'),
    Y = actionBody(c, 'syncFromClass'), P = actionBody(c, 'publishToClass'),
    C2 = actionBody(c, 'myClear');
  if (!/member_id\s*=\s*\?/.test(L) || !/class_id\s*=\s*\?/.test(L)) problems.push('myList 过滤');
  if (/payload\.\s*memberId/.test(S) || /payload\.\s*memberId/.test(D) || /payload\.\s*memberId/.test(L) || /payload\.\s*memberId/.test(I) || /payload\.\s*memberId/.test(Y) || /payload\.\s*memberId/.test(C2)) problems.push('采信 payload.memberId');
  if (!/UPDATE\s+member_timetable[\s\S]*?WHERE[\s\S]*?member_id\s*=\s*\?/i.test(S)) problems.push('mySave 更新无 member_id');
  if (!/DELETE FROM member_timetable[\s\S]*?member_id\s*=\s*\?/i.test(D)) problems.push('myDelete 无 member_id');
  if (!/DELETE\s+FROM\s+member_timetable\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+member_id\s*=\s*\?/i.test(I)) problems.push('myImport 覆盖未锁本人');
  if (!/INSERT\s+INTO\s+member_timetable/i.test(I)) problems.push('myImport 写错表（必须是 member_timetable，不能写全班 session）');
  if (!/parseTimetableXlsx/.test(I)) problems.push('myImport 未复用解析器');
  if (!/DELETE\s+FROM\s+member_timetable\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+member_id\s*=\s*\?/i.test(Y)) problems.push('syncFromClass 覆盖未锁本人');
  if (!/INSERT\s+INTO\s+member_timetable/i.test(Y)) problems.push('syncFromClass 写错表');
  if (/rollbackDutyMarkers/.test(Y)) problems.push('syncFromClass 不该回滚 duty 标记');
  if (!/if\s*\(\s*!payload\.commit\s*\)/.test(Y)) problems.push('syncFromClass 缺 commit 开关（覆盖式无预览）');
  if (!/member\.group_tag\s*===\s*'A'/.test(Y) || !/group_scope\s+IS\s+NULL/.test(Y) || !/s\.group_scope\s*=\s*\?/.test(Y)) problems.push('syncFromClass 缺组过滤（A/B 会互串）');
  if (!/if\s*\(seen\[k\]\)\s*return;/.test(Y) || !/\[r\.name,\s*r\.day_of_week,\s*r\.period,\s*r\.weeks,\s*r\.week_rule\]/.test(Y)) problems.push('syncFromClass 缺去重（同格叠两门）');
  if (!/DELETE\s+FROM\s+member_timetable\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+member_id\s*=\s*\?/i.test(C2)) problems.push('myClear 未锁本人');
  if (/rollbackDutyMarkers/.test(C2)) problems.push('myClear 不该回滚 duty 标记');
  if (!/needTimetablePublish:\s*true/.test(P)) problems.push('publish 无权限门');
  if (/payload\.classId/.test(P)) problems.push('publish 采信 classId');
  if (!/await\s+rollbackDutyMarkers\s*\(\s*conn[\s\S]*?DELETE FROM session/.test(P)) problems.push('publish 未回滚标记');
  if (!/POSITION_VICE_MONITOR\s*=\s*'副班长'/.test(g)) problems.push('缺副班长常量');
  if (/isCounselor\s*\(/.test((g.match(/function\s+requireTimetablePublish\s*\([^)]*\)\s*\{[\s\S]*?\n\}/) || [''])[0])) problems.push('发布守卫放行辅导员');
  const r = problems.slice();
  problems.length = save;
  return r;
}

mutate('myList 去掉 class_id 过滤（跨班可见）', () => ({
  course: course.replace('WHERE class_id = ? AND member_id = ?\n          ORDER BY day_of_week', 'WHERE member_id = ?\n          ORDER BY day_of_week'),
  guard
}));
mutate('mySave 改采信 payload.memberId', () => ({
  course: course.replace('const member = guard.requireBind(ctx);\n      const classId = guard.classIdOf(ctx);\n      const pool = getPool();\n      const cfg = await week.getConfig(pool, classId);',
    'const member = guard.requireBind(ctx);\n      const classId = guard.classIdOf(ctx);\n      const pool = getPool();\n      const cfg = await week.getConfig(pool, classId);\n      if (payload.memberId) member.id = payload.memberId;'),
  guard
}));
mutate('mySave 的 UPDATE 去掉 member_id（可改他人）', () => ({
  course: course.replace('WHERE id=? AND member_id=? AND class_id=?', 'WHERE id=? AND class_id=?'),
  guard
}));
mutate('myDelete 去掉 member_id（可删他人）', () => ({
  course: course.replace('DELETE FROM member_timetable WHERE id = ? AND member_id = ? AND class_id = ?', 'DELETE FROM member_timetable WHERE id = ? AND class_id = ?'),
  guard
}));
mutate('myClear 去掉 member_id（可清他人课表）', () => {
  // ⚠️ DELETE ... class_id=? AND member_id=? 在 myImport/syncFromClass 里也有，必须只改 myClear 段
  const s0 = course.indexOf('\n  myClear: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    'DELETE FROM member_timetable WHERE class_id = ? AND member_id = ?',
    'DELETE FROM member_timetable WHERE class_id = ?'
  );
  return { course: head + tail, guard };
});
mutate('publishToClass 撤掉权限门', () => ({
  course: course.replace('publishToClass: {\n    auth: { needTimetablePublish: true },', 'publishToClass: {\n    auth: { needBind: true },'),
  guard
}));
mutate('publishToClass 采信 payload.classId（跨班覆盖）', () => {
  // ⚠️ classIdOf(ctx) 在文件里多处出现，只改 publishToClass 段内那一处
  const pubStart = course.indexOf('\n  publishToClass: {');
  const head = course.slice(0, pubStart);
  let tail = course.slice(pubStart);
  const mutatedTail = tail.replace(
    'const classId = guard.classIdOf(ctx);',
    'const classId = Number(payload.classId) || guard.classIdOf(ctx);'
  );
  return { course: head + mutatedTail, guard };
});
mutate('publishToClass 删 session 前不回滚 duty 标记', () => {
  // ⚠️ 必须只改 publishToClass 段：同样的 rollback 行在 importTimetable 里也有一份
  const pubStart = course.indexOf('\n  publishToClass: {');
  const head = course.slice(0, pubStart);
  let tail = course.slice(pubStart);
  const mutatedTail = tail.replace(
    /if \(duties\.length\) await rollbackDutyMarkers\(conn, duties\.map\(r => Number\(r\.id\)\)\);\n/,
    ''
  );
  return { course: head + mutatedTail, guard };
});
mutate('发布守卫放进辅导员', () => ({
  course, guard: guard.replace('if (isSuper(m) || isMonitor(m) || isViceMonitor(m)) return m;', 'if (isSuper(m) || isCounselor(m) || isMonitor(m) || isViceMonitor(m)) return m;')
}));

mutate('myImport 改成写全班 session（越权改他人课表）', () => {
  const s0 = course.indexOf('\n  myImport: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    'INSERT INTO member_timetable (class_id, member_id, name, teacher, room, day_of_week, period, weeks, week_rule, kind) VALUES ',
    'INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES '
  );
  return { course: head + tail, guard };
});
mutate('myImport 覆盖时不清旧行（改为直接累加）', () => {
  const s0 = course.indexOf('\n  myImport: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    /await pool\.query\('DELETE FROM member_timetable WHERE class_id = \? AND member_id = \?', \[classId, member\.id\]\);/,
    ''
  );
  return { course: head + tail, guard };
});
mutate('syncFromClass 覆盖时不清旧行（累加变脏）', () => {
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    /await pool\.query\('DELETE FROM member_timetable WHERE class_id = \? AND member_id = \?', \[classId, member\.id\]\);/,
    ''
  );
  return { course: head + tail, guard };
});
mutate('syncFromClass 去掉组过滤（A/B 两组课全量拷进个人课表）', () => {
  // ⚠️ 锚真实代码行（stripComments 后仍存在）；变异只做在内存副本上，绝不写盘
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    "const myGroup = (member.group_tag === 'A' || member.group_tag === 'B') ? member.group_tag : '';",
    "const myGroup = '';"
  );
  return { course: head + tail, guard };
});
mutate('syncFromClass 组条件退化成全量（全体+本组 → 全部课次）', () => {
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    "const grpCond = myGroup ? '(s.group_scope IS NULL OR s.group_scope = ?)' : 's.group_scope IS NULL';",
    "const grpCond = 'TRUE';"
  );
  return { course: head + tail, guard };
});
mutate('syncFromClass 改成写全班 session（越权）', () => {
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(
    'INSERT INTO member_timetable (class_id, member_id, name, teacher, room, day_of_week, period, weeks, week_rule, kind) VALUES ',
    'INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES '
  );
  return { course: head + tail, guard };
});
mutate('syncFromClass 去掉 commit 开关（覆盖式无预览）', () => {
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace('if (!payload.commit) {', 'if (false) {');
  return { course: head + tail, guard };
});
mutate('syncFromClass 误加 rollbackDutyMarkers（不删 session 却回滚标记）', () => {
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  // ⚠️ 锚点必须是「当前真实代码行」——曾锚在已删除的 `const [stat] = await pool.query(` 上，
  //    replace 空转 ⇒ 变异放行假绿（2026-10-06 重构后改锚 `const seen = {};`）
  tail = tail.replace(
    'const seen = {};',
    'await rollbackDutyMarkers(conn, []);\n      const seen = {};'
  );
  return { course: head + tail, guard };
});
mutate('syncFromClass 去掉去重（同格叠两门课）', () => {
  const s0 = course.indexOf('\n  syncFromClass: {');
  const head = course.slice(0, s0);
  let tail = course.slice(s0);
  tail = tail.replace(/if\s*\(seen\[k\]\)\s*return;\n\s*/, '');
  return { course: head + tail, guard };
});

console.log('\n' + (caught === total && !problems.length
  ? '✓ 门禁 #60 全部通过（含 ' + total + ' 项变异自证）'
  : '✗ 变异自证 ' + caught + '/' + total + '，' + problems.length + ' 项主判据未通过'));
process.exit(caught === total && !problems.length ? 0 : 1);
