/**
 * 门禁：首页「今日课次 / 明日课次」并入**本人选修课**（2026-10-16 用户需求 A）。
 *
 * 背景：选修课存在独立表 `personal_course`，而首页课次的数据源是 `duty.home`
 *      （后端只 JOIN duty+session+course）⇒ 两条链路天然不通，用户看不到自己加的选修课。
 *      课表页有 `electiveList` + `_mergePersonal` 所以能显示；本门禁钉死首页也补上。
 *
 * 覆盖：
 *  ① 三个新方法必须存在且被接线（_mergePersonalCourses / _loadPersonalCourses / _tomorrowWeekday）
 *  ② 今日与明日**两处**都要走合并
 *  ③ 两个请求要并行（Promise.all）—— 串行会让首屏多等一个 RTT
 *  ④ 选修课不参与值日：sessionId=0 + isPersonal 标记
 *  ⑤ onCourseTap 对选修课直接 return（否则班长点得动、弹一份空名单去发群里）
 *  ⑥ wxml 的 wx:key 必须区分选修课（sessionId 恒 0 会撞 key）
 *  ⑦ 选修课显示「选修」角标，**不得**显示「全体」（会误导成全班课）
 *  ⑧ 周次过滤优先用后端 currentWeek
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const JS = read('miniprogram/pages/home/index.js');
const WXML = read('miniprogram/pages/home/index.wxml');
const WXSS = read('miniprogram/pages/home/index.wxss');

/**
 * 取「定义处」到下一个方法定义之间的源码。
 *
 * 🔴 不能用 `JS.indexOf('_mergePersonalCourses(list')` —— 那是 **setData 里的调用处**
 *    形参文本，切片里根本没有方法体 ⇒ 判据永远红（写门禁时踩过一次）。
 *    这里从行首缩进两格的 `  _name(` 找起（只可能是定义处），再按花括号配对取到下一个方法。
 */
function methodBody(name, nextName) {
  const def = new RegExp('^  ' + name + '\\(', 'm').exec(JS);
  if (!def) throw new Error('找不到方法定义 ' + name);
  const nxt = new RegExp('^  ' + nextName + '\\(', 'm').exec(JS.slice(def.index));
  return JS.slice(def.index, nxt ? def.index + nxt.index : JS.length);
}

let pass = 0;
const fails = [];
const pin = (name, fn) => {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push({ name, msg: e.message }); console.log('  ✗ ' + name + '  → ' + e.message); }
};
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ---------- ① 方法存在 ---------- */
pin('① 三个方法都已定义', () => {
  ['_mergePersonalCourses(list, personal, targetDow, weekNo)', '_loadPersonalCourses()', '_tomorrowWeekday()']
    .forEach((sig) => need(JS.includes(sig), '缺少 ' + sig));
});

/* ---------- ② 今日 + 明日 两处都接线 ---------- */
pin('② 今日与明日课次都并入选修课', () => {
  need(/sessions:\s*this\._markDone\(this\._mergePersonalCourses\(/.test(JS), '今日 sessions 未接线');
  need(/tomorrowSessions:\s*this\._mergePersonalCourses\(/.test(JS), '明日 tomorrowSessions 未接线');
  // 两处都要把「本班课次」作为第 1 参（先过滤再合并，别把选修课丢进 _filterSessions 的分组/去重逻辑）
  const s1 = JS.match(/sessions:\s*this\._markDone\(this\._mergePersonalCourses\(([\s\S]*?)\)\)/);
  const s2 = JS.match(/tomorrowSessions:\s*this\._mergePersonalCourses\(([\s\S]*?)\),\n/);
  need(s1 && /this\._filterSessions\(/.test(s1[1]), '今日：选修课必须并入「已过滤去重」的全班课次之后');
  need(s2 && /this\._filterSessions\(/.test(s2[1]), '明日：选修课必须并入「已过滤去重」的全班课次之后');
});

/* ---------- ③ 两个请求并行 ---------- */
pin('③ electiveList 与 dutyToday 并行拉取（不串行多等一个 RTT）', () => {
  need(/const pToday = api\.dutyToday\(/.test(JS), 'dutyToday 未拆成独立 promise');
  need(/const pPersonal = this\._loadPersonalCourses\(\)/.test(JS), '选修课未并行发起');
  need(/Promise\.all\(\[pToday, pPersonal\]\)/.test(JS), '未用 Promise.all 并行');
  need(JS.includes("api.electiveList({}, { toast: false })"), '选修课未走 api.electiveList');
  // 选修课失败必须兜空、不阻断 dutyToday
  need(/_loadPersonalCourses\(\)[\s\S]*?\.catch\(\(\) => \{ this\._personalCourses = \[\]; \}\)/.test(JS), '选修课失败未兜空数组');
});

/* ---------- ④ 不参与值日 ---------- */
pin('④ 选修课不参与值日（sessionId=0 + isPersonal 标记）', () => {
  const body = methodBody('_mergePersonalCourses', '_loadPersonalCourses');
  need(/sessionId:\s*0/.test(body), '选修课 sessionId 必须为 0（不挂值日表）');
  need(/isPersonal:\s*true/.test(body), '缺 isPersonal 标记');
  need(/pid:\s*Number\(p\.id\)/.test(body), '缺 pid（供 wx:key 与 session 区分）');
  need(/groupScope:\s*null/.test(body), '选修课不该有分组语义');
  need(!/isMine:\s*true/.test(body), '选修课不得被置 isMine（否则会被算成"我的值日"）');
});

/* ---------- ⑤ 课堂情况守卫 ---------- */
pin('⑤ 班长点选修课不弹「课堂情况」（否则是一份空名单）', () => {
  const m = JS.match(/onCourseTap\(e\)[\s\S]*?\n  \},/);
  need(m, '找不到 onCourseTap');
  need(/if \(s\.isPersonal\) return;/.test(m[0]), 'onCourseTap 缺少 isPersonal 守卫');
  need(m[0].indexOf('isPersonal') < m[0].indexOf('setData({'), '守卫必须在 setData 之前（否则弹层已开）');
});

/* ---------- ⑥ wx:key 区分（且必须是裸属性名） ---------- */
pin('⑥ wx:key 用 JS 预计算的 `key` 字段（区分选修课且不写表达式）', () => {
  // 🔴 2026-10-16 修正：上一版把分流写成 `wx:key="{{item.isPersonal ? 'pid' : 'sessionId'}}"`，
  //    DevTools 渲染层直接报 `SyntaxError: missing ) after argument list` +
  //    `Framework inner error (expect FLOW_INITIAL_CREATION end but got FLOW_CREATE_NODE)`。
  //    根因：**wx:key 只接受属性名，不接受 `{{ }}` 表达式**（框架内部做 item[key] 取值）。
  //    全仓 33 种 wx:key 写法都是裸属性名，本条是唯一例外 ⇒ 改回「在 JS 里算好 key」。
  const loops = WXML.match(/wx:for="\{\{(tomorrowSessions|sessions)\}\}"[^>]*wx:key="[^"]*"/g) || [];
  need(loops.length >= 3, '预期至少 3 处 wx:for（今日×2 分支 + 明日），实际 ' + loops.length);
  loops.forEach((l) => {
    need(/wx:key="key"/.test(l), 'wx:key 必须是裸属性名 "key"：' + l.slice(0, 90));
    need(!/\{\{/.test(l.replace(/wx:for="\{\{[^}]*\}\}"/, '')), 'wx:key 不得写表达式：' + l.slice(0, 90));
  });
  // JS 侧必须真的把这个 key 算出来（前缀区分两个 id 空间），且两条返回路径都覆盖
  need(/_withRowKey\(arr\)\s*\{/.test(JS), '缺 _withRowKey 方法');
  const kb = methodBody('_withRowKey', '_mergePersonalCourses');
  need(/'s' \+ \(Number\(cur\.sessionId\)/.test(kb), '全班课次 key 未用 sessionId 前缀');
  need(/'p' \+ \(Number\(cur\.pid\)/.test(kb), '选修课 key 未用 pid 前缀（sessionId 恒 0 会撞 key）');
  const mb = methodBody('_mergePersonalCourses', '_loadPersonalCourses');
  const wraps = (mb.match(/return this\._withRowKey\(out\)/g) || []).length;
  need(wraps >= 2, '今日/明日汇合点的两条 return 都要补 key（含 !dow 早退分支），实际 ' + wraps + ' 处');
});

/* ---------- ⑦ 选修角标，不得显示「全体」 ---------- */
pin('⑦ 选修课显「选修」角标，且不落进「全体」分支', () => {
  const n = (WXML.match(/class="tag elective">选修<\/view>/g) || []).length;
  need(n >= 3, '「选修」角标应出现在 3 处（今日×2 + 明日），实际 ' + n);
  // 「选修」必须与 groupScope 的「A/B 组 / 全体」互斥（用 block wx:else 包起来）
  need(/<view wx:if="\{\{item\.isPersonal\}\}" class="tag elective">选修<\/view>\s*<block wx:else>/.test(WXML),
    '「选修」必须用 block wx:else 与「A/B 组 / 全体」互斥');
  need(/\.tag\.elective\s*\{/.test(WXSS), 'wxss 缺 .tag.elective 定义（check-wxss 会判 wxml 类无样式）');
});

/* ---------- ⑧ 周次优先用后端 currentWeek ---------- */
pin('⑧ 周次过滤优先用后端 currentWeek（兜底才本地算）', () => {
  const body = methodBody('_mergePersonalCourses', '_loadPersonalCourses');
  need(/Number\(weekNo\) \|\| tt\.weekOfDate/.test(body), '未「优先用后端 currentWeek，兜底本地算」');
  need(/if \(!week\) return;/.test(body), '周次算不出来时应宁缺毋滥（直接返回）');
  need(/tt\.matchesWeeks\(p\.weeks \|\| '', week, p\.weekRule \|\| 'ALL'\)/.test(body), '未按周次过滤选修课');
  need(/const tt = require\('\.\.\/\.\.\/data\/timetable'\)/.test(JS), '首页未引入 tt 模块');
});

/* ---------- ⑨ 明日星期必须回绕 ---------- */
pin('⑨ 明日星期跨周回绕（周日→1，否则永远匹配不上）', () => {
  need(/return \(util\.todayWeekday\(\) % 7\) \+ 1;/.test(JS), '明日星期未回绕');
});

/* ---------- ⑩ 选修课补全节次时间（2026-10-29 用户反馈：手动课显示「第x节」而非时间） ---------- */
pin('⑩ 选修课从班级节次表补 periodTime（否则时间列退化成「第N节」）', () => {
  const body = methodBody('_mergePersonalCourses', '_loadPersonalCourses');
  need(/config\.periodTime/.test(body), '未读取班级 config.periodTime');
  need(/ptMap\[/.test(body), '未按节次建时间映射（period → {start,end}）');
  need(/periodTime:\s*[\s\S]{0,120}?start:\s*pt\.start/.test(body), '未用节次时间构造 periodTime.start');
  need(/periodTime:\s*[\s\S]{0,120}?end:\s*pt\.end/.test(body), '未用节次时间构造 periodTime.end');
  need(!/periodTime:\s*null\s*,?\s*\n/.test(body), 'periodTime 仍被写死为 null');
});

/* ---------- ⑪ 选修课行要有可辨识的浅蓝强调底（2026-10-29 二次反馈：要颜色区分，但别是白） ---------- */
pin('⑪ 选修课行有可辨识的浅蓝底（不是白色 / 不是透明）', () => {
  const m = WXSS.match(/\.course-row\.personal\s*\{([^}]*)\}/);
  need(m, '找不到 .course-row.personal 样式');
  const decl = m[1].match(/background(?:-color)?\s*:\s*([^;]+);/);
  need(decl, '选修课行缺 background（需要浅蓝强调）');
  const bg = decl[1].replace(/!important/g, '').trim();
  const low = bg.toLowerCase();
  need(!/^(transparent|none|inherit)$/.test(low), '选修课行需要有颜色（不能透明），实得 ' + bg);
  need(low !== '#fff' && low !== '#ffffff' && low !== 'white' && low !== '#f7faff', '选修课行不能是白色/近白，实得 ' + bg);
});

console.log('');
if (fails.length) {
  console.log('[FAIL] ' + fails.length + ' 项未过');
  process.exit(1);
}
console.log('[PASS] 首页并入本人选修课门禁全过（' + pass + ' 项）');