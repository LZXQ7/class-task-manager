#!/usr/bin/env node
/**
 * 离线自检：首页「今日课次 / 明日课次」（2026-09-25 用户反馈）
 * ------------------------------------------------------------
 * ① 当天是节假日 / 调休放假 / 无课时，首页今日课次显示「今天无课」（空态文案含「无课」即可）
 *    旧实现只比「星期几」，所以国庆这类「工作日放假」照样把当天课次列出来。
 *    新实现按「**实际上课日期 === 目标日期**」判定：week.classDateOf(cfg, wk, day, cal)
 *    返回 null（放假）或挪去的别的日期时，这一节就不属于今天。
 *
 * ② 今日课次下方增加「明日课次」卡片，放假 / 无课时显示「明日无课」
 *    · 后端 duty.today 一并返回 tomorrow + tomorrowSessions（同一套 sessionsOnDate 口径）；
 *    · 明天可能跨周（周日的明天是下周一）→ 按目标日期重算 week.getWeek，
 *      且明天必须走 week.fmtDate(Date.now() + DAY_MS)（fmtDate 内部已 +8h，不能再加）。
 *
 * ⚠️ ② 段的两条文案断言**已从「冻结字面量」改为「结构 + 含『无课』」**：原文写死
 *    「今日无课」/「明天无课」，而界面早已是「今天无课🎉」/「明日无课🎉」（措辞 + emoji 都变了）
 *    → 门禁长期假红（2026-09-26 起）。判据锁死用户可见文案 = 每次改文案都要改门禁，
 *    且「假红」会让「全绿」基线失效。现在只锁**意图**：两个 `.no-course` 空态都存在、都在自己的卡片里、
 *    都含「无课」、且旧的「今天没有课」已改掉。措辞与 emoji 可自由改。
 *    自证：把空态文案换成「今天没有课」/ 删掉明日空态 → 必被抓；源码原样 → 不误报。
 *
 * 用法：node scripts/check-today-course.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readM = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function assertTrue(cond, msg) { if (cond) ok(msg); else bad(msg); }

/* ============================================================
 * ① 后端：按「实际上课日期」判定今日 / 明日课次
 * ============================================================ */
console.log('\n── ① duty.today：按实际上课日期算今日 / 明日课次');

const dutyCf = read('cloudfunctions/duty/index.js');

assertTrue(/const sessionsOnDate = \(targetDate\) => \{/.test(dutyCf),
  '抽出 sessionsOnDate(targetDate)：今日 / 明日共用同一套判定');
assertTrue(/week\.getWeek\(cfg\.termStart, targetDate\)/.test(dutyCf),
  '按目标日期重算周次（周日的明天是下周一，跨周天然正确）');
assertTrue(/week\.resolveSlot\(s\.id, s\.day_of_week, s\.period, targetWk, shifts\)/.test(dutyCf),
  '过 resolveSlot：临时调课 OFF 不出现、MOVE 用挪过去的星期 / 节次');
assertTrue(/week\.classDateOf\(cfg, targetWk, slot\.day, cal\) !== targetDate/.test(dutyCf),
  '用 classDateOf(...) === targetDate 判定「这一节到底上不上在目标日期」');
assertTrue(/week\.loadCalendar\(pool\)/.test(dutyCf),
  '先 loadCalendar 拿校历（holidays / shifts / makeup）');
assertTrue(!/const weekday = week\.weekdayOf\(today\)/.test(dutyCf),
  '已删掉旧的「只比星期几」实现（放假的工作日不会再列出当天课次）');
assertTrue(/const todaySessions = sessionsOnDate\(today\);/.test(dutyCf)
  && /const tomorrowSessions = sessionsOnDate\(tomorrow\);/.test(dutyCf),
  '今日 / 明日都走 sessionsOnDate');
assertTrue(/const tomorrow = week\.fmtDate\(new Date\(Date\.now\(\) \+ DAY_MS\)\);/.test(dutyCf),
  '明天 = fmtDate(Date.now() + DAY_MS)（fmtDate 内部已 +8h，不能再加一次）');
assertTrue(/^\s*tomorrow,$/m.test(dutyCf) && /^\s*tomorrowSessions,$/m.test(dutyCf),
  'duty.today 返回值里带上 tomorrow / tomorrowSessions');
assertTrue(/if \(s\.group_scope && myTag && s\.group_scope !== myTag\) return;/.test(dutyCf),
  '分组课只算自己那组（A 组同学不会在首页看到 B 组课）');
assertTrue(/out\.sort\(\(a, b\) => a\.period - b\.period\);/.test(dutyCf),
  '课次按节次升序');

/* ============================================================
 * ② 前端：首页今日无课 / 明日课次卡片
 * ============================================================ */
console.log('\n── ② 首页：今日无课 + 明日课次卡片');

const homeWxml = readM('pages/home/index.wxml');

/**
 * 纯函数审计（变异自证复用）：只看「两个无课空态」这一件事。
 * 判据锁意图不锁措辞 —— 见文件头 ⚠️ 段。
 */
function auditNoCourse(wxml) {
  const p = [];
  const texts = [];
  const re = /class="no-course"[^>]*>([^<]*)<\/view>/g;
  let m;
  while ((m = re.exec(wxml))) texts.push(m[1]);
  if (texts.length < 2) {
    p.push('首页 .no-course 空态不是两个（今日 / 明日各一），实际 ' + texts.length + ' 个');
  }
  texts.forEach((t, i) => {
    if (!/无课/.test(t)) p.push('第 ' + (i + 1) + ' 个 .no-course 空态不含「无课」：' + JSON.stringify(t));
  });
  if (/今天没有课/.test(wxml)) p.push('旧文案「今天没有课」又回来了');
  // 第二个空态必须落在「明日课次」卡片内（标题之后），否则会张冠李戴到今日卡
  const tm = wxml.indexOf('明日课次');
  if (tm < 0) p.push('找不到「明日课次」卡片标题');
  else if (texts.length >= 2) {
    const firstAfterTm = wxml.slice(tm).search(/class="no-course"/);
    if (firstAfterTm < 0) p.push('「明日课次」卡片内没有 .no-course 空态');
  }
  return p;
}

{
  const problems = auditNoCourse(homeWxml);
  if (problems.length) problems.forEach(x => bad(x));
  else ok('今日 / 明日各有一个含「无课」的 .no-course 空态，且明日那个在「明日课次」卡片内');
}
assertTrue(/<text class="card-title">明日课次<\/text>/.test(homeWxml),
  '今日课次下方新增「明日课次」卡片');
assertTrue(/<text class="card-sub">\{\{tomorrowText\}\}<\/text>/.test(homeWxml),
  '明日课次卡片头右侧显示日期（tomorrowText）');
// ⚠️ 口径更新（2026-10-16 首页并入本人选修课）：原判据锚 `wx:key="sessionId"` 的**字面形态**，
//   但选修课的 sessionId 恒为 0（个人课次没有 session 身份，多门选修课会撞 key）。
//   ⚠️ 再更新（2026-10-16 同日）：一度改写成 `wx:key="{{item.isPersonal ? 'pid' : 'sessionId'}}"`，
//   但 **wx:key 只接受属性名、不接受表达式**（DevTools 渲染层报 `missing ) after argument list`），
//   现改为 JS 预计算 `key` 字段（home/index.js `_withRowKey`）⇒ wxml 写裸 `wx:key="key"`。
//   **意图不变**：明日课次仍用与今日课次同一套 `.course-row` 渲染，只是 key 由 JS 算好。
assertTrue(/wx:for="\{\{tomorrowSessions\}\}" wx:key="key"/.test(homeWxml)
  && /class="course-row/.test(homeWxml),
  '明日课次用与今日课次同一套 course-row 渲染（wx:key 用 JS 预计算的 key 字段）');

const homeJs = readM('pages/home/index.js');
assertTrue(/tomorrowSessions: \[\],/.test(homeJs) && /tomorrowText: '',/.test(homeJs),
  'data 里有 tomorrowSessions / tomorrowText');
// 同上：明日课次现在写成 `this._mergePersonalCourses(this._filterSessions(...), ...)`
//      —— 仍**必须先过 _filterSessions**（分组可见性 + 去重），只是外面多了一层选修课合并。
assertTrue(/tomorrowSessions: this\._mergePersonalCourses\(\s*this\._filterSessions\(r\.tomorrowSessions \|\| \[\]/.test(homeJs),
  '明日课次同样过 _filterSessions（与今日课次一致，可带分组 tag 参数）；选修课合并在其后');
assertTrue(/const groupTag = \(r\.member && r\.member\.groupTag\) \|\| this\._groupTag\(\);/.test(homeJs),
  '首页课次分组可见性取 dutyToday 返回的 member.groupTag（模拟态下不被超管本人组串掉）');
assertTrue(/!s\.groupScope \|\| s\.groupScope === t/.test(homeJs),
  '前端 _filterSessions 按分组过滤：仅保留「本组 + 全体」课次');
assertTrue(/list\.filter\(s => !s\.groupScope\)/.test(homeJs),
  '无分组时仅保留「全体」课次（班委/超管未分到 A/B 也不该把两组课都列出来）');
assertTrue(/tomorrowText: this\._fmtDay\(r\.tomorrow\)/.test(homeJs),
  'tomorrowText 由 r.tomorrow 格式化而来');
assertTrue(/_fmtDay\(dateStr\) \{[\s\S]{0,400}月[\s\S]{0,200}周/.test(homeJs),
  '_fmtDay 把 2026-09-25 渲染成「9月25日 周五」');
assertTrue(/\['日',\s*'一',\s*'二',\s*'三',\s*'四',\s*'五',\s*'六'\]\[d\.getDay\(\)\]/.test(homeJs),
  '_fmtDay 用本地日期取星期（不走 Date.parse，避免时区偏一天）');

const homeWxss = readM('pages/home/index.wxss');
assertTrue(/\.card-sub \{/.test(homeWxss),
  '首页 wxss 有 .card-sub（明日课次卡片头右侧日期）');

/* ============================================================
 * ③ 自证（双向）：锁意图的判据仍必须抓得住真正的退化
 * ============================================================ */
console.log('\n── ③ 自证：空态判据锁意图但不放水');
{
  assertTrue(auditNoCourse(homeWxml).length === 0, '好样本：现有源码无问题（不误报）');

  // 措辞 + emoji 随便改，仍算过（这正是本次把判据从字面量改成意图的原因）
  const reword = homeWxml
    .replace('今天无课🎉', '今日全天无课安排')
    .replace('明日无课🎉', '明天暂时无课');
  assertTrue(reword !== homeWxml && auditNoCourse(reword).length === 0,
    '改措辞 / 去 emoji（「今天无课🎉」→「今日全天无课安排」）→ 仍判过（不锁死用户可见文案）');

  // 真退化：空态被判成旧文案
  const legacy = homeWxml.replace('今天无课🎉', '今天没有课');
  assertTrue(auditNoCourse(legacy).length > 0, '变异 1：退回旧文案「今天没有课」→ 被抓住');

  // 真退化：明日空态被删掉（只剩一个）
  const oneState = homeWxml.replace('<view wx:else class="no-course">明日无课🎉</view>', '');
  assertTrue(oneState !== homeWxml && auditNoCourse(oneState).length > 0,
    '变异 2：删掉明日空态（只剩一个 .no-course）→ 被抓住');

  // 真退化：明日空态不写「无课」二字
  const wrongText = homeWxml.replace('明日无课🎉', '暂无');
  assertTrue(auditNoCourse(wrongText).length > 0, '变异 3：明日空态不含「无课」→ 被抓住');
}

/* ============================================================ */
console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 首页今日 / 明日课次自检全部通过'));
process.exit(failed ? 1 : 0);
