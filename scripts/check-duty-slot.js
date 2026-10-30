#!/usr/bin/env node
/* check-duty-slot.js —— 排班岗位槽（2026-10-28）
 * ============================================================
 * 为什么需要这个门禁：
 *   槽位逻辑落在**两处**（schedule.getSlots/setSlots 与 cron-weekly.generateWeek），
 *   项目已有「schedule.generate / buildCleaningPlan / cron-weekly.generateWeek
 *   三处同口径，改一处必须同步」的教训 —— 这里把「逐字一致」变成机器可查，
 *   避免手动排与每周自动排给出不同名单。
 *
 * 检查项：
 *   ① 两份 slotOf / loadSlots 源码逐字一致
 *   ② slotOf 的匹配优先级：CLEAN 专用槽 > 精确(星期,节次) > 同星期全天槽 > null
 *   ③ 空槽位必须返回 null —— 这是「现有班级零影响」的根据
 *   ④ 没课的节次不空排（rotatePlan 由 sessions 构建）+ 人数以槽位 needN 为准
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const SCH = path.join(root, 'cloudfunctions/schedule/index.js');
const CRON = path.join(root, 'cloudfunctions/cron-weekly/index.js');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass += 1; console.log('  ✓ ' + label); } else { fail += 1; console.log('  ✗ ' + label); }
}

/** 从源码里截出 `function <name>(...) { ... }` 整段（到第一个顶格 `}` 为止） */
function pickFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'm');
  const m = re.exec(src);
  return m ? m[0] : null;
}
function buildFn(src) {
  // eslint-disable-next-line no-new-func
  return new Function('return (' + src + ')')();
}

const s1 = fs.readFileSync(SCH, 'utf8');
const s2 = fs.readFileSync(CRON, 'utf8');

console.log('── ① 两份实现逐字一致');
['loadSlots', 'slotOf'].forEach((fn) => {
  const a = pickFn(s1, fn);
  const b = pickFn(s2, fn);
  ok(!!a, 'schedule 内含 ' + fn);
  ok(!!b, 'cron-weekly 内含 ' + fn);
  /* ⚠️ 行尾风格必须归一：schedule/index.js 是 CRLF、cron-weekly/index.js 是 LF，
   *    「逐字一致」针对的是**代码内容**，不该因为换行符不同就判死。 */
  const norm = (t) => (t || '').replace(/\r\n/g, '\n').trim();
  ok(!!a && !!b && norm(a) === norm(b), fn + ' 两份逐字一致（忽略行尾符）');
});

console.log('── ② slotOf 匹配优先级');
const slotOf = buildFn(pickFn(s1, 'slotOf'));
const slots = [
  { id: 1, weekday: 1, period: null, kind: 'NORMAL' },   // 周一全天槽
  { id: 2, weekday: 2, period: 3, kind: 'NORMAL' },      // 周二第 3 节
  { id: 3, weekday: 3, period: null, kind: 'CLEAN' },    // 周三保洁槽
  { id: 4, weekday: 1, period: 2, kind: 'NORMAL' }       // 周一第 2 节（与全天槽并存）
];
ok(slotOf(slots, 1, 4, 'NORMAL').id === 1, '周一第4节 → 回落到周一全天槽');
ok(slotOf(slots, 1, 2, 'NORMAL').id === 4, '周一第2节 → 精确槽优先于全天槽');
ok(slotOf(slots, 2, 3, 'NORMAL').id === 2, '周二第3节 → 精确槽');
ok(slotOf(slots, 2, 4, 'NORMAL') === null, '周二第4节 → 无匹配时返回 null（不误用别的槽）');
ok(slotOf(slots, 3, 5, 'CLEAN').id === 3, '周三保洁 → CLEAN 专用槽');
ok(slotOf(slots, 3, 5, 'NORMAL') === null, '周三普通课 → 不串用 CLEAN 槽');
ok(slotOf([], 1, 1, 'NORMAL') === null, '空槽位 → null（= 完全走原逻辑）');
ok(slotOf(null, 1, 1, 'NORMAL') === null, 'slots 为 null → 安全返回 null');
ok(slotOf(slots, 9, 1, 'NORMAL') === null, '不存在的星期 → null');

console.log('── ③ 空槽位 = 原逻辑（现有班级零影响）');
ok(/const slots = await loadSlots\(conn, classId\);/.test(s1), 'schedule 在事务内加载槽位');
ok(/const slots = await loadSlots\(conn, classId\);/.test(s2), 'cron-weekly 在事务内加载槽位');
ok(/slots\.length \? slotOf\(/.test(s1) && /slots\.length \? slotOf\(/.test(s2),
  '两处都以 slots.length 为开关（空则不进入槽位分支）');

console.log('── ④ 没课的节次不空排 + 人数以槽位为准');
/* 主循环的来源是 sessions（数据库里真实存在的课次），槽位只在循环**内部**做匹配：
 *   ① for (const s of sessions)  ② rotatePlan.push(...)  ③ for (... of rotatePlan)
 * 槽位不参与构建 rotatePlan ⇒ 「第 6 节建了岗位但当周没课」一定不会排出人。 */
ok(/for \(const s of sessions\) \{[\s\S]{0,600}?rotatePlan\.push/.test(s1),
  'schedule：rotatePlan 由 sessions 构建（槽位不造课次）');
ok(/for \(const s of sessions\) \{[\s\S]{0,600}?rotatePlan\.push/.test(s2),
  'cron-weekly：rotatePlan 同样由 sessions 构建');

/* 夹具 = 生产库 class_id=1 的真实课表（2026-10-28 查询）：
 *   周一 1-5 / 周二 1,2,4(CLEAN),5 / 周三 1-4 / 周四 1-5 / 周五 1-3 */
const realWeek = { 1: [1, 2, 3, 4, 5], 2: [1, 2, 4, 5], 3: [1, 2, 3, 4], 4: [1, 2, 3, 4, 5], 5: [1, 2, 3] };
const userSlots = [];
for (let wd = 1; wd <= 5; wd += 1) {
  for (let pd = 1; pd <= 8; pd += 1) {
    userSlots.push({ id: wd * 10 + pd, weekday: wd, period: pd, kind: 'NORMAL', needN: 2 });
  }
}
let firedPd = 0;
let idlePd = 0;
for (let wd = 1; wd <= 5; wd += 1) {
  for (let pd = 1; pd <= 8; pd += 1) {
    if (!slotOf(userSlots, wd, pd, 'NORMAL')) continue;
    if (realWeek[wd].indexOf(pd) >= 0) firedPd += 1; else idlePd += 1;
  }
}
ok(firedPd === 21, '建「周一~周五 × 第1-8节」→ 只有 21 个格子当周真有课（会排）');
ok(idlePd === 19, '其余 19 个格子当周没课 ⇒ 不进主循环、不排人');
ok(slotOf(userSlots, 1, 8, 'NORMAL').id === 18,
  '第 8 节这类「有槽没课」的格子槽位本身能匹配到 —— 不排纯粹因为没课次');

/* 人数口径：槽位 needN 必须压过 session.duty_count（后者是课次级默认值，生产库 80 节全是 2），
 * 但 duty_count=0（课次级「不排值日」，生产库 5 节书香校园）必须优先 —— 连槽位也不排。
 * 旧写法 Number(s.duty_count ?? 1) 会把 needN=3/4 截成 2，也会让 duty_count=0 吞掉整个槽。 */
const needExpr = 'dc === 0 ? 0 : (slotRec ? slotRec.needN : dc)';
ok(/const dc = Number\(s\.duty_count \?\? 1\);/.test(s1), 'schedule：duty_count 用 ?? 窄化（0 保持 0）');
ok(/const dc = Number\(s\.duty_count \?\? 1\);/.test(s2), 'cron-weekly：同上');
ok(s1.indexOf(needExpr) >= 0, 'schedule：duty_count=0 不排 / 其余以槽位 needN 为准');
ok(s2.indexOf(needExpr) >= 0, 'cron-weekly：同上');
ok(s1.indexOf('.slice(0, Math.max(0, n - chosen.length))') >= 0,
  'schedule：槽位追加名额扣掉「沿用上周」已占的坑（防超员）');

console.log('');
console.log('── ⑦ 18:10 打扫主教室（CLEAN 槽 + 自动补课次）');

/* 保洁是独立课次（kind='CLEAN'，period=4 就是 18:10 下课），不是大课的某一节。
 * 这两条链路缺一不可：
 *   ① 槽位必须能存 CLEAN（否则生活委员调不了保洁人数）
 *   ② 课次必须能建出来（全系统没有任何入口新建 CLEAN，只能靠 setSlots 补） */
ok(/async function ensureCleanSessions/.test(s1), 'schedule：有 ensureCleanSessions（补建保洁课次）');
ok(/await ensureCleanSessions\(conn, classId, cleanSlots\.map/.test(s1), 'schedule：setSlots 内调用补建');
ok(/INSERT INTO session \(class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count\)/.test(s1),
  'schedule：补建写的是 session 全字段（缺列会落默认值）');
ok(/VALUES \(\?, \?, 'CLEAN', 'ALL', '', \?, 4, NULL, \?\)/.test(s1),
  'schedule：保洁课次 period 固定 4（= 18:10 下课，排在第五节课之前）');

/* 关掉开关必须真的停排：只删槽的话课次还在，会回落按 duty_count 继续排人 */
ok(/const hadClean = Number\(\(beforeClean\[0\] \|\| \{\}\)\.n\) > 0;/.test(s1),
  'schedule：保存前先记住「原本有没有保洁槽」');
ok(/else if \(hadClean\)/.test(s1), 'schedule：原来开过、这次没传 CLEAN 槽 ⇒ 走停排分支');
ok(/UPDATE session SET duty_count = 0 WHERE class_id = \? AND kind = 'CLEAN'/.test(s1),
  'schedule：停排用 duty_count=0（既有语义「这节不排值日」），不删课次');

/* 前后端一致：一配 CLEAN 槽，保洁就完全由槽位定义，没配的天不排 */
const cleanGuard = 's.kind === \'CLEAN\' && cleanMode && (!slotRec || slotRec.kind !== \'CLEAN\')';
ok(s1.indexOf(cleanGuard) >= 0, 'schedule：配了 CLEAN 槽后保洁只认 CLEAN 槽');
ok(s2.indexOf(cleanGuard) >= 0, 'cron-weekly：同口径（否则定时排班和手动排班结果不一致）');

const ui = fs.readFileSync(path.join(root, 'miniprogram/pages/duty/index.js'), 'utf8');
ok(/kind: 'CLEAN'/.test(ui), '前端：保存时真的会提交 CLEAN 槽');
ok(/const cleanRows = \(all \|\| \[\]\)\.filter\(s => s && s\.kind === 'CLEAN'\);/.test(ui),
  '前端：读回时把 CLEAN 槽从岗位列表剥离（否则显示成一行「全天」岗位）');
ok(/_decorateClean/.test(ui), '前端：保洁行逐天渲染（周二大扫除 4 人与其他天 2 人可分别设）');

console.log('');
console.log('── ⑧ 主教室（class.main_room）+ 自检面板默认收起');

/* 主教室：生活委员在「排班方式」里填的房间，落 class.main_room —— 与后台
 * 「班级设置 · 主教室」**同一字段**（不是新造一份配置，否则两边会吵）。
 * 三条不可省的顺序 / 口径要求：
 *   ① 先 UPDATE class.main_room 再 ensureCleanSessions（后者按它给课次命名）
 *   ② 已建课次要跟着改名 → renameCleanRoom
 *   ③ 后台 syncMainRoomCleaning 必须同口径（大扫除房间在前 / 打扫房间在后） */
const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/duty/index.wxml'), 'utf8');
ok(/payload\.mainRoom !== undefined/.test(s1), 'schedule：mainRoom 字段缺省 = 不改（不是默认清空）');
ok(/UPDATE `class` SET main_room = \? WHERE id = \?/.test(s1), 'schedule：主教室落 class.main_room（与后台同字段）');
const iRoomUpd = s1.indexOf('UPDATE `class` SET main_room');
const iCleanAdd = s1.indexOf('await ensureCleanSessions(conn, classId, cleanSlots.map');
ok(iRoomUpd > 0 && iCleanAdd > 0 && iRoomUpd < iCleanAdd,
  'schedule：先改主教室再补建课次（顺序反了新课次会沿用旧房间名）');
ok(/async function renameCleanRoom/.test(s1), 'schedule：有 renameCleanRoom（已建课次跟着改名）');
ok(/if \(hasRoom && mainRoom && mainRoom !== roomBefore\)/.test(s1), 'schedule：仅当主教室真的变化才改名（幂等）');
ok(/name = next \+ '大扫除'/.test(s1) && /name = '打扫' \+ next/.test(s1),
  'schedule：改名口径 = 大扫除房间在前 / 打扫房间在后');
const admCourse = fs.readFileSync(path.join(root, 'cloudfunctions/admin-web/lib/mod-course.js'), 'utf8');
ok(/next = room \+ '大扫除'/.test(admCourse) && /next = '打扫' \+ room/.test(admCourse),
  'admin-web：syncMainRoomCleaning 同口径（两边改不会互相覆盖）');
ok(/mainRoom: String\(\(roomRows\[0\] && roomRows\[0\]\.main_room\) \|\| ''\)\.trim\(\)/.test(s1),
  'schedule：getSlots 回 mainRoom（同一张弹层要显示当前主教室）');
ok(/api\.scheduleSetSlots\(\{ slots, mainRoom: room \}/.test(ui), '前端：保存时把主教室一起提交');
ok(/bindinput="onRoomInput"/.test(wxml) && /value="\{\{cleanRoom\}\}"/.test(wxml),
  '前端：排班方式里有主教室输入框，且回显当前值');
ok(/\{\{cleanTitle\}\}/.test(wxml), '前端：保洁标题跟着主教室走（不是写死「打扫主教室」）');

/* 自检面板：用户 2026-10-28 打回「这个折叠起来默认不展示」。
 * 根因是 _checkAi（打开弹层就会跑）把整份诊断结果塞进了 aiDiag —— 于是
 * 出口 / HTTP 状态 / 环境变量先糊用户一脸，像报错页。 */
const iCheckAi = ui.indexOf('_checkAi() {');
const segCheckAi = iCheckAi >= 0 ? ui.slice(iCheckAi, ui.indexOf('_briefDiag', iCheckAi)) : '';
ok(iCheckAi > 0 && segCheckAi.indexOf('aiDiag:') < 0,
  '前端：_checkAi 不再把诊断结果塞进 aiDiag（否则一开弹层就展开）');
ok(/aiDiagOpen: false/.test(ui), '前端：自检结果默认收起（aiDiagOpen 初值 false）');
ok(/wx:if="\{\{aiDiagOpen\}\}" class="ai-diag-body"/.test(wxml),
  '前端：明细挂在 aiDiagOpen 下（wx:if 真不渲染，不是靠隐藏）');

console.log('');
console.log('通过=' + pass + ' 失败=' + fail);
if (fail) process.exit(1);
