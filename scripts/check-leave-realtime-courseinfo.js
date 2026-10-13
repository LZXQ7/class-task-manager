#!/usr/bin/env node
/**
 * 第 69 个门禁：请假卡实时口径 + 课堂情况弹窗
 * =================================================================
 * 2026-10-09 用户两条需求合设。
 *
 * ① 上午请假过了时间仍显示请假（用户原话：「设置的上午请假，但是到下午了，
 *    首页还是显示那个人请假。而不是过了时间变成在位状态」）
 *    ------------------------------------------------------------------
 *    ⚠️ **这不是 bug，是口径分层的有意设计被首页忽略了**。
 *    后端 `leaveBoard` 明确返回两套口径（2026-10-08 定，别再合并）：
 *      · `stat` = **日期口径**：今天有生效请假的全列（**含已过时段**的半天假）
 *      · `now`  = **实时口径**：此刻真在请假时段内
 *    ���页 `_setLeaveHomeClass` 原来**只读 `stat`**、把 `now` 整个丢了 ⇒ 上午请假
 *    的人到了下午仍然计数。
 *    🔴 **本门禁钉死的那条性质**：`now` 缺失时**不许回落到 `stat`** ——
 *    回落到`stat` 就是这个 bug 本身（老后端没返 now 时会静默显示错数字）。
 *    🔴 还要钉「**数字走实时、名单走日期**」：名单若也过滤成实时，
 *    「上午请假、现在已回来」的人会从名单里凭空消失，用户会以为漏了记录；
 *    所以名单保持日期口径全列，已过时段的行标 `over: true`。
 *    ⚠️ 代价是「卡片数字 ≠ 名单行数」，这是**有意的**（与 roster 页口径分层同源）。
 *
 * ② 课堂情况弹窗（班长/副班长点首页今日课次 → 一段可复制的文本）
 *    ------------------------------------------------------------------
 *    · `canCourseInfo` = `canLeave && !isCounselor` —— 复用请假权限口径，
 *      不另造（另造必然与请假权限漂移）。
 *    · 🔴 **`bindtap` 不能用插值**（`bindtap="{{c ? 'x' : ''}}"` 是编译期属性，
 *      插值不生效）⇒ 只能按权限**渲染两份**行。
 *    · 🔴 文本 `courseInfoText` 必须由**一个函数**产出，弹层预览与「一键复制」
 *      读同一个字段 —— 否则会出现「看到的」与「复制的不一样」。
 *    · 应到 = 课次涉及组的人数（groupScope 空 = 全体）；实到 = 应到 − 此刻请假数。
 *      请假名单**必须**用 `leaveHomeNowList`（与卡片实时数字同源）。
 *
 * 变异自证（每组都必须被抓）：
 *   M15 去掉日期区间守卫（today < endDate 也算已过 ⇒ 多天假在最后一天前被误标，2026-10-10 报障）
 *   M1 `now` 缺失时回落到 `stat`（= 本 bug 本身）
 *   M2 卡片数字改回读 `stat`（回到bug 前的样子）
 *   M3 名单也过滤成实时（已过时段的人从名单消失）
 *   M4 已过时段不标 over（用户看到「卡片0 人、名单有人」却无解释）
 *   M5 用插值 bindtap（真机上点了没反应）
 *   M6 canCourseInfo 不看 isCounselor（辅导员也弹课堂情况）
 *   M7 应到不按 groupScope 过滤（单组课按全班算）
 *   M8 复制读的不是 courseInfoText（复制出去与预览不一致）
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

const HOME_JS = 'miniprogram/pages/home/index.js';
const HOME_WXML = 'miniprogram/pages/home/index.wxml';
const HOME_WXSS = 'miniprogram/pages/home/index.wxss';
const DUTY_JS = 'cloudfunctions/duty/index.js';
const ADJUST_JS = 'cloudfunctions/adjust/index.js';
const UTIL_JS = 'miniprogram/utils/util.js';

const js = read(HOME_JS);
const wxml = read(HOME_WXML);
const wxss = read(HOME_WXSS);
const duty = read(DUTY_JS);
/* 请假相关后端在 adjust（leaveBoard / leaveHistory / leaveDelete 都在那儿），
 * 不在 duty —— 读错文件会让「后端回studentNo」那条判据永远失败。 */
const adjustSrc = read(ADJUST_JS);
const util = read(UTIL_JS);

/* 剥注释（只判断代码形态，注释里提到不算） */
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
const jsCode = strip(js);
const wxmlCode = strip(wxml);

/* ------------------------------------------------------------------ */
console.log('── ① 请假卡：数字走实时口径，名单走日期口径');

const setFn = /_setLeaveHomeClass\(r\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!setFn, '能定位 _setLeaveHomeClass');
if (setFn) {
  const b = setFn[1];
  chk(/const now = \(r && r\.now\) \|\| null;/.test(b),
    '⚠️ 读了后端返回的 `now`（实时口径；原来只读 stat，整个 now 被丢了）');
  chk(/patch\.leaveHomeLeave = now\.leave;/.test(b),
    '⚠️⚠️ 卡片大数字 = now.leave（**实时**：此刻真在请假时段内）');
  // 🔴 判据极性：`now` 缺失时置 hasNow=false，**不许回落到 stat**
  chk(/if \(now && now\.leave != null\)/.test(b), 'now 缺失时有独立分支处理');
  chk(/patch\.leaveHomeHasNow = false;/.test(b),
    '⚠️⚠️ now 缺失 ⇒ leaveHomeHasNow=false（而不是回落 stat —— 回落**正是这个 bug**）');
  const elseBranch = /\} else \{([\s\S]*?)\n    \};?\s*$/m.exec(b.split('if (now && now.leave != null) {')[1] || '');
  chk(!/leaveHomeLeave\s*=\s*stat\.leave/.test(b),
    "⚠️⚠️ 不存在「now 缺失时 leaveHomeLeave = stat.leave」的回落（那是 bug 本身）");
  // 名单 = 日期口径全列（不过滤已过时段）
  // 🔴 判据必须钉到**字面量 `rows` 后面不是 `.`**：`leaveHomeRaw: rows\b` 会把
  //    `leaveHomeRaw: rows.filter(...)` 也放过（M3 变异就是这么溜过去的）。
  //    正确写法是 `rows,` / `rows }` / `rows;` 这几种收尾。
  const rawOk = /leaveHomeRaw:\s*rows\s*[,}]/.test(b) || /patch\.leaveHomeRaw = rows\s*;/.test(b);
  chk(rawOk,
    '⚠️⚠️ 名单（leaveHomeRaw/ListA/ListB）用**日期口径全列** rows，不做实时过滤'
    + '（写成 rows.filter(...) 就等于把已过时段的人从名单里抹掉）');
  chk(/leaveHomeNowList = rows\.filter\(\(x\) => !x\.over\);/.test(b),
    '⚠️ 实时名单单独存 leaveHomeNowList（课堂情况弹层用它，与卡片数字同源）');
  chk(/leaveHomeTotal = stat\.leave != null \? stat\.leave : rows\.length;/.test(b),
    '⚠️ 日期口径行数单独存 leaveHomeTotal（供「今日共 N 人请假」用，与名单行数恒等）');
}

/* 「已过时段」判定与标记
 * 🔴 2026-10-10 报障：多天假（10-10~10-11 每天 13:00-18:00）在 10-10 晚上被误标「已过时段」——
 *    旧 markOver 只比 `now2` 与 [startTime,endTime]，**丢了日期区间**：只要今天时钟过了 endTime
 *    就标已过，压根没看 endDate 还有没有明天。现按 endDate 收口（「已过」= 不再有任何未来时段）。 */
chk(/const markOver = \(x\) => \{/.test(jsCode),
  '有 markOver：按「这一刻是否已过该请假的最后时段」标 over');
chk(/const today = util\.todayStr\(\);/.test(jsCode)
  && /const d1 = String\(x\.endDate \|\| x\.startDate \|\| today\);/.test(jsCode),
  '🔴⚠️⚠️ markOver 按**日期区间**判定（取 util.todayStr() 与 endDate）——'
  + '旧实现只比时钟、丢了 endDate ⇒ 多天假在最后一天之前就被误标（2026-10-10 报障）');
chk(/if \(today < d1\) return Object\.assign\(\{\}, x, \{ over: false \}\);/.test(jsCode),
  '🔴⚠️⚠️ 区间还有未来天数（today < endDate）⇒ over:false —— '
  + '**这正是「10-10~10-11 下午假」在 10-10 晚被误标已过的根因**');
chk(/if \(today > d1\) return Object\.assign\(\{\}, x, \{ over: true \}\);/.test(jsCode),
  '⚠️ 区间整体已过去（today > endDate）⇒ over:true（防御分支）');
chk(/if \(!x\.startTime && !x\.endTime\) return Object\.assign\(\{\}, x, \{ over: false \}\);/.test(jsCode),
  '⚠️⚠️ 整天假显式 over:false（两列都空时不能拿空串去比大小，否则整天假被误标成「已过时段」）');
chk(/over: now2 > String\(x\.endTime\)/.test(jsCode),
  '⚠️ 今天=最后一天时：时钟越过 endTime 才算已过（不再用「不在 [startTime,endTime] 内」——'
  + '那会把「今天晚些时候才开始的假」也算已过）');
chk(/wx:if="\{\{item\.over\}\}" class="lv-over"/.test(wxml),
  '⚠️ wxml 渲染「已过时段」角标（不标的话用户看到「卡片 0 人、名单有人」却无解释）');
chk(/\.lv-over\s*\{[^}]*background:\s*var\(--bg-fill\)/.test(wxss),
  '⚠️ .lv-over 用 token --bg-fill（**没有** --fill-2，写错不报错只是背景透明）');

/* 数字的自愈：到点自动翻面 */
chk(/_scheduleLeaveWindowTimer\(\)/.test(js),
  '有 _scheduleLeaveWindowTimer（实时数字得**自己会变**，只靠 onShow 的话用户盯着不动就永远不翻）');
const timerFn = /_scheduleLeaveWindowTimer\(\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!timerFn, '能定位 _scheduleLeaveWindowTimer');
if (timerFn) {
  const b = timerFn[1];
  chk(/setTimeout/.test(b), '用的是 setTimeout **链**（不是 setInterval —— 后台补发一串过期请求）');
  chk(/util\.clockNow\(\)/.test(b), '基准时间走 util.clockNow()（本地时区 HH:mm）');
  chk(/waitMs = Math\.max\(1000,/.test(b), '⚠️ waitMs 有下限（差值为负/ 0 时不能立即触发死循环）');
  chk(/this\._loadLeaveHome\(\)/.test(b), '到点重拉 leaveBoard');
  chk(/if \(this\._leaveWinTimer\) \{ clearTimeout/.test(b), '重排前先清旧定时器（否则链会叠）');
}
chk(/onHide\(\)\s*\{[^}]*_leaveWinTimer/.test(jsCode),
  '🔴 onHide 里清定时器（页面切走仍触发 ⇒ 对已销毁实例 setData）');
chk(/onUnload[\s\S]{0,400}?_leaveWinTimer/.test(jsCode),
  '🔴 onUnload 里也清（最长可跨小时，不清就是泄漏）');

/* 时钟单一真源 */
chk(/function clockNow\(\)/.test(util) && /seqOf, clockNow/.test(util),
  '⚠️ util.clockNow 存在且已导出（两个页面要用同一份，漂移的后果是「首页说在请假、名单说不在」）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② 课堂情况弹窗');

/* 权限 */
const idFn = /_applyIdentity\(\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!idFn, '能定位 _applyIdentity');
if (idFn) {
  const b = idFn[1];
  chk(/const canCourseInfo = canLeave && !isCounselor;/.test(b),
    '⚠️⚠️ canCourseInfo = canLeave && !isCounselor（复用请假权限口径；辅导员视角是隐藏学生功能的）');
  // ⚠️ 认两种写法：`patch = { canCourseInfo, }`（简写）与 `patch.canCourseInfo = ...`
  chk(/canCourseInfo[,:]/.test(b) && /(patch\.canCourseInfo = canCourseInfo|canCourseInfo[,:])/.test(b),
    'canCourseInfo 进了 setData');
}

/* 入口：按权限渲染两份（而不是靠 bindtap 插值） */
chk(/bindtap="onCourseTap"/.test(wxml), '课次行绑了 onCourseTap（**字面量**，不是插值）');
chk(!/bindtap="\{\{[^}]*[a-zA-Z]+Course|bindtap="\{\{canCourseInfo/.test(wxml),
  '⚠️ 课次行的 bindtap 不是插值（条件为假时会绑成一个**空 handler 名**：真机照样能点、'
  + '只是没反应 =「点了没反应又不报错」那类最难查的形态）');
chk(/wx:if="\{\{canCourseInfo\}\}"/.test(wxml) && /wx:else/.test(wxml),
  '⚠️ 课次行按权限**渲染两份**（从根上不存在「绑了空handler」这个分支）');
chk(/data-idx="\{\{ci\}\}"/.test(wxml), '行上带 data-idx（点哪一节要能取到）');
chk(/wx:for-index="ci"/.test(wxml), '⚠️ 显式 wx:for-index（要用下标反查 sessions，不写默认是 item）');
chk(/wx:for="\{\{sessions\}\}"/.test(wxml) && /wx:for="\{\{tomorrowSessions\}\}"/.test(wxml),
  '今日与明日课次都还在（明日**不做**弹窗，但不能把它的行删掉）');
const tmrTap = /<block wx:else>\s*<view wx:for="\{\{tomorrowSessions\}\}"[\s\S]{0,200}?bindtap/.test(wxml);
chk(!tmrTap, '⚠️ 明日课次不绑 tap（明天还没上，不存在课堂情况）');

/* page-meta 必须含新弹层，否则页面在弹层打开时仍可滚动 */
const pm = /page-meta[^>]*page-style="\{\{([^}]*)\}\}/.exec(wxml);
chk(!!pm && /courseInfoShow/.test(pm[1]),
  '⚠️⚠️ page-meta 的锁定表达式含 courseInfoShow（漏了 ⇒ 弹层开着页面还能滚）');

/* 文本唯一真源 */
chk(/courseInfoText: ''/.test(js), 'data 里有 courseInfoText');
chk(/onCourseInfoCopy\(\)\s*\{([\s\S]*?)\n  \},/.test(js), '有 onCourseInfoCopy');
const copyFn = /onCourseInfoCopy\(\)\s*\{([\s\S]*?)\n  \},/.exec(js);
if (copyFn) {
  const b = copyFn[1];
  chk(/const t = this\.data\.courseInfoText \|\| '';/.test(b),
    '⚠️⚠️ 复制读的是 courseInfoText（与弹层预览同一个字段 ⇒ 不会「看到的≠复制的」）');
  chk(/if \(!t\) \{ util\.toast/.test(b),
    '⚠️ 内容为空时拒绝复制并 toast（复制出去是残的比报错更糟）');
  chk(/wx\.setClipboardData/.test(b) && /success/.test(b) && /fail/.test(b),
    '⚠️ setClipboardData 同时有 success/fail（fail 要给手动复制兜底）');
}
chk(/bindtap="onCourseInfoCopy"/.test(wxml), '弹层底部有复制按钮');

/* 组文本逻辑 */
const buildFn = /_buildCourseInfo\(s, roster, leaveList\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!buildFn, '能定位 _buildCourseInfo');
if (buildFn) {
  const b = buildFn[1];
  //剥注释版（用于「不许出现某标识符」这类判据）—— 不剥的话，
  // 上方那段解释 `over` 含义的**注释**会把自己判死（本轮真踩）。
  const bc = strip(buildFn[1]);
  chk(/const scope = String\(\(s && s\.groupScope\) \|\| ''\)\.trim\(\);/.test(b),
    '⚠️ 读课次 groupScope（空 = 全体课）');
  chk(/const inScope = \(x\) => \(!scope \|\| String\(x\.groupTag \|\| ''\) === scope\);/.test(b),
    '⚠️⚠️ inScope 按 groupScope 过滤（单组课不能按全班算应到）');
  chk(/const expected = rows\.filter\(inScope\)\.length;/.test(b),
    '⚠️ 应到 = 落在该组的在册人数');
  chk(/const absentees = \(leaveList \|\| \[\]\)\.filter\(inScope\)\.filter\(overlap\);/.test(b),
    '⚠️⚠️ 请假者按「组口径 + 时段交集」两重过滤');
  chk(/return String\(x\.startTime\) <= ce && String\(x\.endTime\) >= cs;/.test(b),
    '🔴⚠️⚠️ 时段交集判定：leaveStart <= courseEnd 且 leaveEnd >= courseStart'
    + '（去掉它 ⇒ 下午的课会把上午请假的人也算成缺勤）');
  chk(/if \(!cs \|\| !ce\) return true;/.test(b),
    '⚠️ 课次没拿到 periodTime 时退化为「当天请假就算」（宁可多算不可漏算：'
    + '漏算会把缺席的人报成全勤）');
  // 🔴🔴 **反向判据：代码里不许出现 `x.over`**（2026-10-09 用户第三次实拍才暴露）。
  //    本门禁上一版**正相反**——它要求 `if (x.over) return false;` 必须存在，
  //    于是把 bug 本身当成了正确实现钉住。教训与「写法禁令要限定作用域」同源，
  //    但更严重：它不是判死别的代码，而是**主动要求错的东西存在**。
  //    `over` 的含义是「**已过时段**」（此刻不在 [startTime,endTime] 内），
  //    上午 08:00-12:00 的假到了下午就 `over === true`
  //    ⇒ 被当"已撤销"过滤掉 ⇒ 那节上午的课被算成实到 = 应到。
  //    撤销的记录**根本不在 list 里**：后端 leaveBoard 是 `WHERE l.status = 'APPROVED'`。
  chk(!/x\.over/.test(bc),
    '🔴⚠️⚠️ `_buildCourseInfo` 的**代码**里不许用 `x.over` —— 它是「已过时段」不是「已撤销」；'
    + '用它过滤 ⇒ 上午的假到了下午被当成撤销 ⇒ 上午那节课实到 = 应到（用户实拍）'
    + '；⚠️ 必须判**剥注释后**的代码，否则上方那段解释 `over` 含义的注释会自己把自己判死');
  chk(/已撤销.*不会出现在.*list|status = 'APPROVED'/.test(b) || /leaveHomeRaw/.test(b),
    '⚠️ 已撤销的记录由后端 `WHERE status = APPROVED` 挡掉，前端不重复判');
  chk(/const actual = Math\.max\(0, expected - absentees\.length\);/.test(b),
    '实到 = 应到 − 请假数，且下限 0（不能是负数）');
  chk(/'课堂情况：正常'/.test(b), '课堂情况固定写「正常」');
// 🔴🔴 每行请假必须是「**完整学号 + 姓名 + 请假**」（2026-10-09 用户实拍：
//    弹层里只有「郝鹏杰请假」，前面没有学号）。
//    根因是**后端 `leaveBoard` 的行映射漏了 studentNo**（SQL 早就选了 m.student_no，
//    但映射时没带出来）⇒ 前端 `String(x.studentNo || '')` 拿到空串。
//    ⚠️ `seq`（后两位）顶不了替 —— 模板要的是完整学号（形如 000000000056）。
chk(/lines\.push\(String\(x\.studentNo \|\| ''\) \+ \(x\.name \|\| ''\) \+ '请假'\);/.test(b),
    '🔴⚠️⚠️ 每行请假 = 完整学号 + 姓名 + 请假（学号与姓名之间**无空格**，照用户模板抄）');
chk(!/lines\.push\(String\(x\.seq/.test(b),
    '🔴⚠️ 不许拿 `seq`（后两位）当学号塞进文本 —— 模板要完整学号');
// 后端：leaveBoard 必须回完整 studentNo（字段名与 leaveHistory 一致，别造第二种命名）
const boardBlock = /const list = rows\.map\(r => \(\{[\s\S]*?image: r\.leave_image \|\| ''\s*\}\)\);/.exec(adjustSrc);
chk(!!boardBlock && /studentNo: String\(r\.student_no \|\| ''\)/.test(boardBlock[0]),
    '🔴⚠️⚠️ 后端 leaveBoard 的行映射回 studentNo（SQL 早选了 m.student_no，'
    + '只是映射时漏了 ⇒ 前端拿到空串 ⇒ 复制出去少了学号，用户实拍）');
  chk(/'应到' \+ expected \+ '人'/.test(b) && /'实到' \+ actual \+ '人'/.test(b),
    '⚠️ 文案是「应到N人 实到N人」（与用户给的模板一致）');
  chk(/String\(x\.studentNo \|\| ''\) \+ \(x\.name \|\| ''\) \+ '请假'/.test(b),
    "⚠️⚠️ 每行请假 = 学号+姓名+「请假」（用户模板里学号与姓名之间**没有空格**）");
  // ⚠️ 写法 2026-10-09 改过两次：
  //   ① `this.data.classFullName || ''` → 加两级兜底后的 `cls || '（班级）'`
  //      （占位从「本班」改成「（班级）」：前者像真名，会被直接发到群里）。
  chk(/const lines = \[\s*\n\s*cls \|\| '（班级）',/.test(b),
    '⚠️ 第一行是班级全称（模板第一行）；⚠️ 占位用「（班级）」而不是「本班」——后者像真名');
}
chk(/_buildCourseInfo\(s, roster, this\.data\.leaveHomeRaw \|\| \[\]\)/.test(js),
  '⚠️⚠️ 请假名单传的是 **leaveHomeRaw（日期口径全列）**，不是 leaveHomeNowList'
  + '（用户 2026-10-09 定：课堂情况问「这节课谁没来」，答「在这节课时段内请过假的人」；'
  + '用实时名单 ⇒ 上午的假下午就不算 ⇒ 那节上午的课被算成实到 = 应到，**这是本 bug 本身**）');

/* 后端补teacher */
chk(/c\.name, c\.room, c\.teacher/.test(duty),
  '⚠️⚠️ sessionsOnDate 的 SELECT 带了 c.teacher（course 表本来就有这列，课表页已在用）');
chk(/teacher: s\.teacher \|\| ''/.test(duty),
  "⚠️ 回 teacher 空串兜底（老课次没填教师名时前端能识别，而不是显示 undefined）");

/* ---------- 课堂情况弹层的视觉与可达（2026-10-09 用户实拍后追加） ----------
 * 三条都是「不报错、只是不对」：按钮被 tabBar 压住点不到 / 班级名那行空着 /
 * 文本散在背景上与全站卡片不统一。 */
chk(/class="ci-card"/.test(wxmlCode),
  '⚠️ 文本装进 .ci-card 卡片框（散在弹层背景上与全站 .card 不统一）');
chk(/\{\{classFullName \|\| leaveHomeClassName \|\| '（班级）'\}\}/.test(wxmlCode),
    "⚠️⚠️ 弹层里有班级名行且带兜底（用户实拍「课程名上面没有班级名」）；"
    + "⚠️ 兜底**不再写「本班」**——真名已拿到时仍显示「本班」会让人以为没生效");
chk(/ci-cls/.test(wxmlCode) && /ci-course/.test(wxmlCode),
  '⚠️ 班级名与课程名各有自己的 class（能分主次，也便于门禁区分）');
chk(/const cls = String\(this\.data\.classFullName \|\| this\.data\.leaveHomeClassName \|\| ''\)\.trim\(\);/.test(jsCode),
  '⚠️⚠️ 组文本时班级名有两层兜底（classFullName → leaveHomeClassName → 空）');
chk(/cls \|\| '（班级）',/.test(jsCode),
  "⚠️⚠️ 班级名最终兜底成「（班级）」——**绝不能让模板第一行空着**"
  + "（空会被下面那行 filter 连课程名一起滤掉，复制出去少一行）");

/* ---------- 2026-10-09 用户第二轮实拍：间距 / 班级名真值/ 按钮居中 ---------- */
const rosterWxss = read('miniprogram/pages/roster/index.wxss');
chk(/\.ci\s*\{[^}]*padding:\s*8rpx 32rpx 0;/.test(wxss),
  '🔴⚠️⚠️ `.ci` 左右有 32rpx 内边距（原来左右是 0 ⇒ 卡片贴到弹层边缘，'
  + '用户实拍「右侧大面积空白不好看」）；⚠️ 32rpx 是**全站标准**，别自造数值');
// ⚠️ 这里曾有两条 `needClass` 判据（要求点弹层时判断班级名并补拉），**已删除**：
//   它拉的是 `leaveBoard`，而 leaveBoard **不返回 className** ⇒ 补拉是白拉，
//   班级名永远补不上（用户连着两次实拍都显示「本班」/「（班级）」）。
//   班级名现走 duty.home 的 className，由上面「班级名真值」那组判据守。
chk(/\.mb-detail-actions\s*\{[^}]*justify-content:\s*center;/.test(rosterWxss),
  '🔴⚠️⚠️ .mb-detail-actions 有 justify-content:center（.mb-abtn 固定 46% 是为**两个**按钮对称，'
  + '普通管理员只有「调至B组」一个 ⇒ 贴左；用户实拍要求居中对称）');
chk(/flex:\s*0 1 46%/.test(rosterWxss),
  '⚠️ .mb-abtn 仍是 46%（**不要**改成 flex:1 让它满宽 —— 调组是次要操作，满宽比「设为班委」更重）');
chk(/\.ci-foot\s*\{[^}]*padding-bottom:\s*calc\(114rpx/.test(wxss),
  '🔴⚠️⚠️ .ci-foot 有底部让位 padding-bottom: calc(114rpx …)（悬浮 tabBar 会压住 footer，不让位则按钮点不到 —— 用户实拍）');
chk(/max\(env\(safe-area-inset-bottom\), 32px\)/.test(wxss),
  '⚠️ 让位用 max(env(), 32px) 兜底（部分 WebView 不认 env()，照 duty-sheet 的同名处理）');
chk(/\.ci-card\s*\{[^}]*backdrop-filter:\s*var\(--glass-blur\)/.test(wxss),
  '⚠️ .ci-card 带 backdrop-filter（少它玻璃就不"透"，看着像块灰板）；写法照 app.wxss 的 .card');
chk(/background:\s*var\(--glass-bg\)/.test(wxss) && /var\(--r-md\)/.test(wxss),
  '⚠️ .ci-card 用全站玻璃令牌与圆角令牌（写死色值会与全站卡片漂移）');
chk(!/\.ci-prev\s*\{/.test(wxss),
  '⚠️ 旧的 .ci-prev 已移除（改成卡片框后它成了死样式）');

/* ---------- 班级名真值（2026-10-09 用户第二次实拍后改） ----------
 * ⚠️ 血泪史：`leaveBoard` / `member.list` / `class.list` **全都不返回班级名**
 *    （实测确认 leaveBoard 返回只有 date/list/stat/now）。所以前端一度怎么兜底都拿不到
 *    ⇒ 先后显示成空 →「本班」→「（班级）」。**唯一真源必须是 duty.home 的 className。 */
const HOME_JS_R = read(HOME_JS);
chk(/classFullName: r\.className \|\| this\.data\.classFullName \|\| ''/.test(HOME_JS_R),
  '🔴⚠️⚠️ classFullName 来自 duty.home 的 className（首屏就有 = 零额外请求）');
chk(/SELECT name FROM `class` WHERE id = \?/.test(duty) && /className,/g.test(duty),
  '🔴⚠️⚠️ duty 后端查 class 表并回 className');
chk(!/classFullName: \(r && r\.className\) \|\| ''/.test(HOME_JS_R),
  '🔴⚠️ **不再**从 leaveBoard 的 r.className 取（那个字段根本不存在 ⇒ 白留一层误导）');
// ⚠️ 要剥注释再判：`needClass` 现在只**存在于注释里**（说明为什么删掉它），
//    用原文判会误报。判据要查的是「**代码里**没有它」。
const homeCode = HOME_JS_R
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
chk(!/needClass/.test(homeCode),
  '🔴⚠️ 那个按需补拉班级名的分支已从**代码**里删掉（它拉的 leaveBoard 不返回 className ⇒ 纯白拉一次）'
  + '；⚠️ 判据必须剥注释再判，因为这个名字现在只出现在注释里');
chk(/\(s && s\.name\)|cls \|\| '（班级）'/.test(HOME_JS_R),
  '占位仍是「（班级）」不是「本班」（后者像真名，会被直接发到群里）');

console.log('');
console.log('── ③ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

/** 跑判据，返回失败条数。
 *  ⚠️ `o` 必须有**默认值** —— 基线那轮是`judge()` 无参调用，
 *     写成必填参数会直接 TypeError 崩在forEach 里（判据根本没跑）。 */
function judge(o) {
  o = o || {};
  const vJs = o.js || js;
  const vWxml = o.wxml || wxml;
  const vWxss = o.wxss || wxss;
  const vDuty = o.duty || duty;
  // ⚠️ adjust（请假后端）也要能被子类变异替换，否则「后端回 studentNo」那条判据
  //   在变异体上仍读原文件 ⇒ M13 抓不到。
  const vAdjustAll = o.adjust || adjustSrc;
  const vUtil = o.util || util;
  const c1 = strip(vJs);
  const c2 = strip(vWxml);
  let n = 0;
  const push = (x) => { if (!x) n += 1; };

  const sf = /_setLeaveHomeClass\(r\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!sf);
  if (sf) {
    const b = sf[1];
    push(/const now = \(r && r\.now\) \|\| null;/.test(b));
    push(/patch\.leaveHomeLeave = now\.leave;/.test(b));
    push(/if \(now && now\.leave != null\)/.test(b));
    push(/patch\.leaveHomeHasNow = false;/.test(b));
    push(!/leaveHomeLeave\s*=\s*stat\.leave/.test(b));
    push(/leaveHomeRaw:\s*rows\s*[,}]/.test(b) || /patch\.leaveHomeRaw = rows\s*;/.test(b));
    push(/leaveHomeNowList = rows\.filter\(\(x\) => !x\.over\);/.test(b));
    push(/leaveHomeTotal = stat\.leave != null \? stat\.leave : rows\.length;/.test(b));
  }
  push(/const markOver = \(x\) => \{/.test(c1));
  push(/const today = util\.todayStr\(\);/.test(c1) && /const d1 = String\(x\.endDate \|\| x\.startDate \|\| today\);/.test(c1));
  push(/if \(today < d1\) return Object\.assign\(\{\}, x, \{ over: false \}\);/.test(c1));
  push(/if \(today > d1\) return Object\.assign\(\{\}, x, \{ over: true \}\);/.test(c1));
  push(/if \(!x\.startTime && !x\.endTime\) return Object\.assign\(\{\}, x, \{ over: false \}\);/.test(c1));
  push(/over: now2 > String\(x\.endTime\)/.test(c1));
  push(/wx:if="\{\{item\.over\}\}" class="lv-over"/.test(c2));
  push(/\.lv-over\s*\{[^}]*background:\s*var\(--bg-fill\)/.test(vWxss));
  push(/_scheduleLeaveWindowTimer\(\)/.test(vJs));
  const tf = /_scheduleLeaveWindowTimer\(\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!tf);
  if (tf) {
    const b = tf[1];
    push(/setTimeout/.test(b));
    push(/util\.clockNow\(\)/.test(b));
    push(/waitMs = Math\.max\(1000,/.test(b));
    push(/this\._loadLeaveHome\(\)/.test(b));
    push(/if \(this\._leaveWinTimer\) \{ clearTimeout/.test(b));
  }
  push(/onHide\(\)\s*\{[^}]*_leaveWinTimer/.test(c1));
  push(/onUnload[\s\S]{0,400}?_leaveWinTimer/.test(c1));
  push(/function clockNow\(\)/.test(vUtil) && /seqOf, clockNow/.test(vUtil));

  const idf = /_applyIdentity\(\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!idf);
  if (idf) {
    const b = idf[1];
    push(/const canCourseInfo = canLeave && !isCounselor;/.test(b));
    push(/canCourseInfo[,:]/.test(b) && /(patch\.canCourseInfo = canCourseInfo|canCourseInfo[,:])/.test(b));
  }
  push(/bindtap="onCourseTap"/.test(c2));
  push(!/bindtap="\{\{[^}]*[a-zA-Z]+Course|bindtap="\{\{canCourseInfo/.test(c2));
  push(/wx:if="\{\{canCourseInfo\}\}"/.test(c2) && /wx:else/.test(c2));
  push(/data-idx="\{\{ci\}\}"/.test(c2));
  push(/wx:for-index="ci"/.test(c2));
  push(/wx:for="\{\{sessions\}\}"/.test(c2) && /wx:for="\{\{tomorrowSessions\}\}"/.test(c2));
  push(!/<block wx:else>\s*<view wx:for="\{\{tomorrowSessions\}\}"[\s\S]{0,200}?bindtap/.test(c2));
  const pmx = /page-meta[^>]*page-style="\{\{([^}]*)\}\}/.exec(c2);
  push(!!pmx && /courseInfoShow/.test(pmx[1]));
  push(/courseInfoText: ''/.test(vJs));
  const cf = /onCourseInfoCopy\(\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!cf);
  if (cf) {
    const b = cf[1];
    push(/const t = this\.data\.courseInfoText \|\| '';/.test(b));
    push(/if \(!t\) \{ util\.toast/.test(b));
    push(/wx\.setClipboardData/.test(b) && /success/.test(b) && /fail/.test(b));
  }
  push(/bindtap="onCourseInfoCopy"/.test(c2));
  const bf = /_buildCourseInfo\(s, roster, leaveList\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!bf);
  if (bf) {
    const b = bf[1];
    const bcs = strip(bf[1]);
    push(/const scope = String\(\(s && s\.groupScope\) \|\| ''\)\.trim\(\);/.test(b));
    push(/const inScope = \(x\) => \(!scope \|\| String\(x\.groupTag \|\| ''\) === scope\);/.test(b));
    push(/const expected = rows\.filter\(inScope\)\.length;/.test(b));
    push(/return String\(x\.startTime\) <= ce && String\(x\.endTime\) >= cs;/.test(b));
    push(!/x\.over/.test(bcs));
    push(/'课堂情况：正常'/.test(b));
    push(/lines\.push\(String\(x\.studentNo \|\| ''\) \+ \(x\.name \|\| ''\) \+ '请假'\);/.test(b));
    push(!/lines\.push\(String\(x\.seq/.test(b));
    push(/const absentees = \(leaveList \|\| \[\]\)\.filter\(inScope\)\.filter\(overlap\);/.test(b));
    const bb = /const list = rows\.map\(r => \(\{[\s\S]*?image: r\.leave_image \|\| ''\s*\}\)\);/.exec(vAdjustAll);
    push(!!bb && /studentNo: String\(r\.student_no \|\| ''\)/.test(bb[0]));
    push(/const actual = Math\.max\(0, expected - absentees\.length\);/.test(b));
    push(/'课堂情况：正常'/.test(b));
    push(/'应到' \+ expected \+ '人'/.test(b) && /'实到' \+ actual \+ '人'/.test(b));
    push(/String\(x\.studentNo \|\| ''\) \+ \(x\.name \|\| ''\) \+ '请假'/.test(b));
    push(/const lines = \[\s*\n\s*cls \|\| '（班级）',/.test(b));
  }
  push(/_buildCourseInfo\(s, roster, this\.data\.leaveHomeRaw \|\| \[\]\)/.test(vJs));
  push(/c\.name, c\.room, c\.teacher/.test(vDuty));
  push(/teacher: s\.teacher \|\| ''/.test(vDuty));

  // 课堂情况弹层的视觉与可达（与主判据同源）
  push(/class="ci-card"/.test(c2));
  push(/\{\{classFullName \|\| leaveHomeClassName \|\| '（班级）'\}\}/.test(c2));
  push(/ci-cls/.test(c2) && /ci-course/.test(c2));
  push(/const cls = String\(this\.data\.classFullName \|\| this\.data\.leaveHomeClassName \|\| ''\)\.trim\(\);/.test(c1));
  push(/cls \|\| '（班级）',/.test(c1));

  // 第二轮实拍：间距 / 班级名真值 / 按钮居中
  push(/\.ci\s*\{[^}]*padding:\s*8rpx 32rpx 0;/.test(vWxss));
  push(!/needClass/.test(c1));   // c1 已剥注释 ⇒ 只查代码
  const rosterW = read('miniprogram/pages/roster/index.wxss');
  push(/\.mb-detail-actions\s*\{[^}]*justify-content:\s*center;/.test(rosterW));
  push(/flex:\s*0 1 46%/.test(rosterW));
  // 班级名唯一真源 = duty.home
  push(/classFullName: r\.className \|\| this\.data\.classFullName \|\| ''/.test(c1));
  push(!/classFullName: \(r && r\.className\) \|\| ''/.test(c1));
  push(/SELECT name FROM `class` WHERE id = \?/.test(vDuty));
  push(/\.ci-foot\s*\{[^}]*padding-bottom:\s*calc\(114rpx/.test(vWxss));
  push(/max\(env\(safe-area-inset-bottom\), 32px\)/.test(vWxss));
  push(/\.ci-card\s*\{[^}]*backdrop-filter:\s*var\(--glass-blur\)/.test(vWxss));
  push(/background:\s*var\(--glass-bg\)/.test(vWxss) && /var\(--r-md\)/.test(vWxss));
  push(!/\.ci-prev\s*\{/.test(vWxss));
  return n;
}

const MUT = [
  {
    name: 'M1 now 缺失时回落到 stat（**这正是本 bug 本身**：老后端没 now 时显示错数字）',
    apply: () => ({
      js: js.replace('patch.leaveHomeHasNow = false;',
        'patch.leaveHomeHasNow = true;\n      patch.leaveHomeLeave = stat.leave != null ? stat.leave : rows.length;')
    })
  },
  {
    name: 'M2 卡片数字改回读 stat（回到修这个 bug 之前的样子）',
    apply: () => ({
      js: js.replace('patch.leaveHomeLeave = now.leave;',
        'patch.leaveHomeLeave = stat.leave != null ? stat.leave : rows.length;')
    })
  },
  {
    // ⚠️ 锚点必须是**唯一的**：早先写 `leaveHomeRaw: rows;` 会**先匹配到 data 里的
    //    初始值 `leaveHomeRaw: []`** ⇒ replace 静默不生效 ⇒ 变异体没被真正改坏
    //    ⇒ 判据测的是原文件 ⇒ **假自证**。所以锚点带上 `classFullName` 那行做上下文。
    //    （与「变异改名 ≠ 变异」同族：锚点不唯一 = 没变异。）
    name: 'M3 名单也过滤成实时（已过时段的人从名单消失 ⇒ 用户以为漏了记录）',
    // ⚠️ 锚点必须**逐字真实且唯一**：这里原来用 `classFullName: (r && r.className)…`
    //    作上下文，2026-10-09 那行被删后锚点失效 ⇒ replace 静默不生效 ⇒ 变异体
    //    等于原文件 ⇒ **假通过**（本轮真踩）。通用防护见下面的 `mutated === 原文` 自检。
    apply: () => ({
      js: js.replace('leaveHomeRaw: rows,', 'leaveHomeRaw: rows.filter((x) => !x.over),')
    })
  },
  {
    name: 'M4 整天假也标 over（两列都空时拿空串比大小 ⇒ 整天假被误标成「已过时段」）',
    apply: () => ({
      js: js.replace('if (!x.startTime && !x.endTime) return Object.assign({}, x, { over: false });', '')
    })
  },
  {
    // ⚠️ 这里的变异是「把两份渲染改成一份+ 插值 bindtap」。
    //    注意：`bindtap="{{…}}"` 本身在真机上是**可用**的（home:235 / roster:199
    //    既有代码就这么写），所以它不是"语法非法"；问题在于条件为假时会绑成
    //    一个**空 handler 名** —— 真机照样能点、只是没反应，且不报错。
    name: 'M5 改成插值 bindtap（条件为假时绑成空 handler 名 ⇒ 点了没反应也不报错）',
    apply: () => ({
      wxml: wxml.replace('bindtap="onCourseTap" data-idx="{{ci}}"',
        "bindtap=\"{{canCourseInfo ? 'onCourseTap' : ''}}\" data-idx=\"{{ci}}\"")
    })
  },
  {
    name: 'M6 canCourseInfo 不排辅导员（辅导员也弹课堂情况，而他们的视角该隐藏学生功能）',
    apply: () => ({
      js: js.replace('const canCourseInfo = canLeave && !isCounselor;', 'const canCourseInfo = canLeave;')
    })
  },
  {
    name: 'M7 应到不按 groupScope 过滤（单组课按全班算 ⇒ 应到人数错一倍）',
    apply: () => ({
      js: js.replace('const inScope = (x) => (!scope || String(x.groupTag || \'\') === scope);',
        'const inScope = () => true;')
    })
  },
  {
    name: 'M8 复制读的不是 courseInfoText（复制出去与弹层预览不一致）',
    apply: () => ({
      js: js.replace("const t = this.data.courseInfoText || '';", "const t = this.data.courseInfoTitle || '';")
    })
  },
  {
    // 🔴 **本轮真 bug**：传实时名单 ⇒ 上午的假下午就不算 ⇒ 那节上午的课实到 = 应到
    name: 'M10 请假名单退回实时口径（上午的假下午就不算 ⇒ 实到 = 应到，**这正是用户实拍的现象**）',
    apply: () => ({
      js: js.replace('this._buildCourseInfo(s, roster, this.data.leaveHomeRaw || []);',
        'this._buildCourseInfo(s, roster, this.data.leaveHomeNowList || []);')
    })
  },
  {
    name: 'M11 去掉时段交集判定（当天任何请假都算缺勤⇒ 下午的课把上午请假的人也算进去）',
    apply: () => ({
      js: js.replace('return String(x.startTime) <= ce && String(x.endTime) >= cs;',
        'return true;')
    })
  },
  {
    // 🔴 **本轮真 bug（用户第三次实拍才暴露）**：`x.over` 是「已过时段」不是「已撤销」。
    //   把它当撤销过滤 ⇒ 上午 08:00-12:00 的假到了下午被丢 ⇒ 上午那节课实到 = 应到。
    // ⚠️ 锚点用 `const overlap = (x) => {` 后面那行日期判定（逐字且唯一）。
    name: 'M12 把 `x.over`（已过时段）当「已撤销」过滤（**本轮真 bug**：上午的假下午被丢 ⇒ 实到 = 应到）',
    apply: () => ({
      js: js.replace('const overlap = (x) => {',
        'const overlap = (x) => {\n      if (x.over) return false;')
    })
  },
  {
    // 🔴 **本轮真 bug（用户实拍「只有 xxx请假，前面没有学号」）**：
    //   后端 leaveBoard 的行映射漏了 studentNo（SQL 早选了 m.student_no，只是没带出来）。
    // ⚠️ 锚点必须**逐字唯一**：leaveHistory 那处也有 `studentNo: String(...)`，
    //   但缩进是 10 空格（这里是 8）⇒ 靠缩进区分；**不要带换行**（跨行锚点最易漂）。
    name: 'M13 后端 leaveBoard 映射漏掉 studentNo（**本轮真 bug**：文本里少了学号）',
    apply: () => ({
      adjust: adjustSrc.replace("        studentNo: String(r.student_no || ''),\n", '')
    })
  },
  {
    // 拿 seq（后两位）当学号顶替 —— 模板要完整学号
    name: 'M14 拿 `seq`（后两位）当学号顶替（模板要的是完整学号）',
    apply: () => ({
      js: js.replace("lines.push(String(x.studentNo || '') + (x.name || '') + '请假');",
        "lines.push(String(x.seq || '') + (x.name || '') + '请假');")
    })
  },
  {
    // 🔴 **本轮 bug（2026-10-10 用户报障）**：去掉日期区间守卫 ⇒ 多天假（10-10~10-11）
    //   在最后一天（10-11）之前就被标「已过时段」。
    name: 'M15 去掉日期区间守卫（today < endDate 也算已过 ⇒ **本轮 bug**：多天假在最后一天前就被误标）',
    apply: () => ({
      js: js.replace('if (today < d1) return Object.assign({}, x, { over: false });', '')
    })
  }
];

let caught = 0;
MUT.forEach((c) => {
  const before = judge();
  if (before !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  // 🔴🔴 **变异必须真的改到源码**（2026-10-09 实踩）：锚点随实现漂移后
  //    `String.replace` 找不到就**原样返回** ⇒ 变异体等于原文件 ⇒ 门禁测的是原文件
  //    ⇒ 表现为「变异没被抓到」，而真因是**锚点失效**，两者症状完全不同。
  //    ⇒ 每组变异先断言「至少一个字段真的变了」，变了才继续跑判据。
  // ⚠️ 字段列表必须与 MUT 实际会改的键**完全一致** —— 少了 `adjust`（请假后端）
  //    ⇒ 那些「改后端」的变异体变化被当成"没改到源码"，门禁全报锚点失效（假失败）。
  const orig = { js, wxml, wxss, duty, adjust: adjustSrc };
  const touched = ['js', 'wxml', 'wxss', 'duty', 'adjust'].some((k) => over[k] && over[k] !== orig[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效：replace 找不到就原样返回）'
      + ' ⇒ 门禁测的是原文件，这就是「变异没被抓到」的典型假通过。**先修锚点。**');
    bad += 1;
    return;
  }
  let n;
  try { n = judge(over); } catch (e) {
    fail('变异「' + c.name + '」跑挂了（' + e.message + '）—— 变异体必须能真跑');
    bad += 1;
    return;
  }
  if (n > 0) { ok('变异「' + c.name + '」被门禁抓到（' + n + ' 条判据翻红）'); caught += 1; }
  else { fail('变异「' + c.name + '」**没被抓到** —— 判据失效'); bad += 1; }
});
if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) {
  console.log('[FAIL] ' + bad + ' 项未通过');
  process.exit(1);
}
console.log('[PASS] 请假卡实时口径 / 课堂情况弹窗体检全部通过');