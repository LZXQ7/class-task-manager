/**
 * 离线校验本地课表 `miniprogram/data/timetable.js`
 * ------------------------------------------------------------
 * 课表已固化到小程序本地，不再走云函数，所以这份数据的正确性只能靠离线自检保证。
 * 脚本 stub 掉 wx.Storage 后直接 require 真实数据模块，测的就是生产代码本身。
 *
 *   node scripts/check-timetable-local.js
 *
 * 校验点：
 *   ① 每个周次的上课周次过滤（含「单周 / 双周 / 区间 / 接力」四种编码）
 *   ② 放假仍照常显示课次并标注 isHoliday（第 2 周周五中秋、第 3 周国庆），便于临时调课
 *   ③ 同一格子不会同时冒出两节课（互斥的接力课次必须只命中一个）
 *   ④ 日期计算（学期起始 2026-09-14 = 周一）
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');

/* wx.Storage 存根：不落盘，纯内存，保证每次跑都是种子数据 */
const store = {};
global.wx = {
  getStorageSync: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; }
};

const tt = require(path.join(ROOT, 'miniprogram/data/timetable.js'));

let fail = 0;
function check(label, cond, extra) {
  if (!cond) fail++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}

console.log('学期起始:', tt.TERM_START, '| 总周次:', tt.TOTAL_WEEKS, '| 课次总数:', tt.SEED_SESSIONS.length);
console.log();

/* ---------- ① 日期 ---------- */
console.log('--- ① 日期计算 ---');
check('第1周周一 = 2026-09-14', tt.dateOfWeekDay(tt.TERM_START, 1, 1) === '2026-09-14', tt.dateOfWeekDay(tt.TERM_START, 1, 1));
check('第2周周一 = 2026-09-21', tt.dateOfWeekDay(tt.TERM_START, 2, 1) === '2026-09-21', tt.dateOfWeekDay(tt.TERM_START, 2, 1));
check('第2周周五 = 2026-09-25', tt.dateOfWeekDay(tt.TERM_START, 2, 5) === '2026-09-25', tt.dateOfWeekDay(tt.TERM_START, 2, 5));
check('第3周周四 = 2026-10-01', tt.dateOfWeekDay(tt.TERM_START, 3, 4) === '2026-10-01', tt.dateOfWeekDay(tt.TERM_START, 3, 4));
/* 课表现在是 7 列（含周六 / 周日，供调休排课），日期计算必须能走到第 6、7 天 */
check('第1周周六 = 2026-09-19', tt.dateOfWeekDay(tt.TERM_START, 1, 6) === '2026-09-19', tt.dateOfWeekDay(tt.TERM_START, 1, 6));
check('第1周周日 = 2026-09-20', tt.dateOfWeekDay(tt.TERM_START, 1, 7) === '2026-09-20', tt.dateOfWeekDay(tt.TERM_START, 1, 7));
// 9/20 是「调休上班」（MAKEUP），不是放假 —— 不能被当作 OFF 剔除，否则周末调休课的日期就丢了
check('调休上班日 9/20 不算放假（classDateOf 不返回空）',
  (tt.classDateOf(1, 7) || {}).date === '2026-09-20', JSON.stringify(tt.classDateOf(1, 7)));
check('第3周周六 10/3、周日 10/4 被国庆假期剔除',
  !(tt.classDateOf(3, 6) || {}).date && !(tt.classDateOf(3, 7) || {}).date,
  JSON.stringify([tt.classDateOf(3, 6), tt.classDateOf(3, 7)]));
check('第4周周六 10/10 是调休上班，保留',
  (tt.classDateOf(4, 6) || {}).date === '2026-10-10', JSON.stringify(tt.classDateOf(4, 6)));

/* ---------- ② 上课周次编码 ---------- */
console.log('\n--- ② 上课周次过滤 ---');
const cell = (wk, day, period, group) =>
  tt.sessionsOfWeek(wk).filter(s => s.dayOfWeek === day && s.period === period &&
    (group === undefined ? true : (!s.groupScope || s.groupScope === group)));

check('形势与政策（6,8,10,12周）：第7周不上', cell(7, 1, 1).length === 0);
check('形势与政策：第8周上', cell(8, 1, 1).length === 1);
check('微课B组 1-8周：第1周 = 示例老师02', (cell(1, 1, 4)[0] || {}).teacher === '示例老师02', (cell(1, 1, 4)[0] || {}).teacher);
check('微课B组 9-16周：第9周 = 示例老师04', (cell(9, 1, 4)[0] || {}).teacher === '示例老师04', (cell(9, 1, 4)[0] || {}).teacher);
check('心理（单周/全体）：第1周 → 3号楼222', (cell(1, 3, 3)[0] || {}).room === '3号楼222', (cell(1, 3, 3)[0] || {}).room);
check('心理（双周/A组）：第2周 → 3号楼121', (cell(2, 3, 3)[0] || {}).room === '3号楼121', (cell(2, 3, 3)[0] || {}).room);
check('习思想 第13周 → 精神谱系馆', (cell(13, 4, 3)[0] || {}).room === '精神谱系馆', (cell(13, 4, 3)[0] || {}).room);
check('习思想 第11周 → 3号楼213', (cell(11, 4, 3)[0] || {}).room === '3号楼213', (cell(11, 4, 3)[0] || {}).room);
check('数学 a组 1-4周：第5周换成 3号楼112 的分组课', (cell(5, 2, 2)[0] || {}).room === '3号楼112', (cell(5, 2, 2)[0] || {}).room);
// 用第 4 周（10/5–10/11）：周五 10/9 不放假，才测得到周五的课
check('周五第1节 A 组视图只有「小学综合实践活动设计」',
  cell(4, 5, 1, 'A').length === 1 && cell(4, 5, 1, 'A')[0].name === '小学综合实践活动设计',
  JSON.stringify(cell(4, 5, 1, 'A').map(c => c.name)));
check('周五第1节 B 组视图只有「三笔字」',
  cell(4, 5, 1, 'B').length === 1 && cell(4, 5, 1, 'B')[0].name === '三笔字',
  JSON.stringify(cell(4, 5, 1, 'B').map(c => c.name)));

/* ---------- ③ 放假仍显示 + 标注 isHoliday ---------- */
console.log('\n--- ③ 法定放假仍显示并标注 isHoliday ---');
const w2 = tt.sessionsOfWeek(2);
const w2Fri = w2.filter(s => s.dayOfWeek === 5);
check('第2周周五的课仍显示（9/25 中秋放假，但照常陈列便于调课）', w2Fri.length > 0, '周五课次数=' + w2Fri.length);
check('第2周周五的课全部被标注 isHoliday', w2Fri.every(s => s.isHoliday), JSON.stringify(w2Fri.map(s => s.name + ':' + s.isHoliday)));
check('第2周非假期的课仍是 12 节（= 24 条值日 / 2 人）', w2.filter(s => !s.isHoliday).length === 12, w2.filter(s => !s.isHoliday).length);
const w3 = tt.sessionsOfWeek(3);
const w3H = w3.filter(s => s.isHoliday);
check('第3周 10/1、10/2 的课存在且标注 isHoliday', w3H.some(s => s.classDate === '2026-10-01') && w3H.some(s => s.classDate === '2026-10-02'), '假期课次数=' + w3H.length);
check('第3周非假期的课全部落在 9/28–9/30', w3.filter(s => !s.isHoliday).every(s => s.classDate >= '2026-09-28' && s.classDate <= '2026-09-30'), JSON.stringify([...new Set(w3.filter(s => !s.isHoliday).map(s => s.classDate))]));
check('第3周假期课的 holidayName = 国庆节', w3H.length > 0 && w3H.every(s => s.holidayName === '国庆节'), JSON.stringify([...new Set(w3H.map(s => s.holidayName))]));

/* ---------- ④ 同一格子不冲突 ---------- */
console.log('\n--- ④ 同一格子互斥 ---');
let dup = [];
for (let wk = 1; wk <= tt.TOTAL_WEEKS; wk++) {
  for (const g of ['A', 'B']) {
    const seen = {};
    tt.sessionsOfWeek(wk)
      .filter(s => !s.groupScope || s.groupScope === g)
      .forEach(s => {
        const k = s.dayOfWeek + '#' + s.period;
        if (seen[k]) dup.push('第' + wk + '周 ' + g + '组 周' + s.dayOfWeek + '第' + s.period + '节：' + seen[k] + ' × ' + s.name);
        seen[k] = s.name;
      });
  }
}
check('16 周 × A/B 两组视图下没有任何格子撞课', dup.length === 0, dup.slice(0, 5).join(' | '));

/* ---------- ⑤ 结构完整性 ---------- */
console.log('\n--- ⑤ 数据完整性 ---');
const src = fs.readFileSync(path.join(ROOT, 'miniprogram/data/timetable.js'), 'utf8');
const badRoom = tt.SEED_SESSIONS.filter(s => !s.name || !s.room || !s.teacher);
check('每节课都有 名称/教师/教室', badRoom.length === 0, JSON.stringify(badRoom.map(s => s.id)));
const badPos = tt.SEED_SESSIONS.filter(s => !(s.day >= 1 && s.day <= 7) || !(s.period >= 1 && s.period <= 5));
check('星期 1–7 / 节次 1–5', badPos.length === 0, JSON.stringify(badPos.map(s => s.id)));
// 课表已支持周末列，但当前真实课表里没有周末课 —— 所以下面「第2周 = 12 课次」等计数仍然成立
check('当前课表里没有周六 / 周日的课', tt.SEED_SESSIONS.every(s => s.day <= 5),
  JSON.stringify(tt.SEED_SESSIONS.filter(s => s.day > 5).map(s => s.id)));
const ids = tt.SEED_SESSIONS.map(s => s.id);
check('session id 无重复（与库一致）', new Set(ids).size === ids.length);
check('课次总数 = 25', tt.SEED_SESSIONS.length === 25, String(tt.SEED_SESSIONS.length));
check('学期起始写在模块里', src.indexOf("TERM_START = '2026-09-14'") > 0);

/* ---------- ⑥ 辅导员/超管可切班查看课表（2026-10 需求⑧升级） ---------- */
console.log('\n--- ⑥ 辅导员/超管：可切换查看其他班的课表 ---');
/*
 * ⚠️ 2026-10 需求⑧「二次升级」：课表真源按班级全量上云后，**不再按 classId 写死拦截任何身份**——
 *    学生与辅导员/超管统一走「class.list → tt.setClass → 云端同步」，该班有没有课表由同步结果
 *    决定（空列表 ⇒ hasTimetable=false ⇒ 空态）。因此断言：①_afterAuth 统一入口；②有无课表由
 *    同步结果决定；③空班给明确空态。week-switcher / fab-menu / fab 等**编辑/调课入口**的
 *    `!isCounselor` 守卫仍然必须保留（辅导员能看，但不能改）。
 */
const ttJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/timetable/index.js'), 'utf8');
const ttWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/timetable/index.wxml'), 'utf8');
check('课表页识别辅导员身份（group_tag === "X"）', /isCounselor:\s*firstCounselor/.test(ttJs) && /firstCounselor = p\.groupTag === 'X'/.test(ttJs));
check('学生不再按 classId 写死拦截（_afterAuth 统一走 _loadTimetableClasses，示例班级B 等班导入后同样渲染）',
  /_afterAuth\(\)\s*\{[\s\S]{0,300}?this\._loadTimetableClasses\(\)/.test(ttJs)
  && !/hasTimetable:\s*\(p\.classId \|\| 1\)\s*===\s*config\.TIMETABLE_CLASS_ID/.test(ttJs));
check('该班有没有课表由云端同步结果决定（空列表 ⇒ hasTimetable=false ⇒ 走空态）',
  /hasTimetable:\s*list\.length\s*>\s*0/.test(ttJs));
check('同步加令牌防串班（切班后旧响应不得写进新班缓存）',
  /_syncToken[\s\S]{0,400}?if \(token !== this\._syncToken\) return;/.test(ttJs));
check('辅导员/超管无绑定班级时给出明确空态（不卡骨架屏）',
  /canSwitchClass && !classList\.length && !loading && !failed/.test(ttWxml)
  && /暂无可查看的班级/.test(ttWxml));
check('所选班级云端无课次时给明确空态（不渲染空网格）',
  /canSwitchClass && classList\.length && !hasTimetable && !loading && !failed/.test(ttWxml)
  && /该班还没有课表/.test(ttWxml));
/*
 * 原来是「数 `!isCounselor` 出现次数 ≥4 / `wx:if="{{!isCounselor}}"` ≥2」的粗判据。
 * v0.7.21 需求③ 把顶部那条 A/B 分段并进了左下角 .fab-menu，合法地少了一个守卫 →
 * 计数判据会误报。这里换成**逐个入口点名**：切周 / 分组+调课入口 / 管理员调课悬浮按钮，
 * 三个开标签各自必须带 !isCounselor。比数个数更精确，也不会因为一次合并不停调阈值。
 *
 * ⚠️ v1.0.5 追加：**切周条还必须带 `hasTimetable`，而 `!isCounselor` 一个字都不能少**。
 *    课表隔离曾把切周条守卫写成 `wx:if="{{hasTimetable}}"` —— 但辅导员的主班就是 class_id=1，
 *    `hasTimetable` 对他**恒为 true** → 切周条照样渲染，与需求⑧「辅导员不渲染课表网格」直接冲突。
 *    （当时这个回归被误判成「门禁漂移、建议对齐门禁」；实际是门禁抓对了、页面写错了。）
 *    「是不是课表班」与「是不是辅导员」是两个独立维度，守卫必须同时带，不能互相替代。
 *    ⚠️ 2026-10 补充：辅导员现在**能看**课表（走 classList 切班分支），但「看」和「改」仍分离——
 *        week-switcher 透出班级切换、fab-menu/fab 的 `!isCounselor` 守卫继续拦住调课/编辑入口。
 */
function openTagWithClass(src, re) {
  const m = re.exec(src);
  return m ? m[0] : '';
}
/** 三个「辅导员不该看到」的入口，各自的开标签里必须带 !isCounselor；切周条另须 hasTimetable */
function counselGuardsOk(src) {
  const w = openTagWithClass(src, /<week-switcher\b[\s\S]*?\/>/);
  const fm = openTagWithClass(src, /<view\b[^>]*class="fab-menu[^>]*>/);
  const fb = openTagWithClass(src, /<view\b[^>]*class="fab(?:\s|")[^>]*>/);
  return !!w && /!isCounselor/.test(w) && /hasTimetable/.test(w)
    && !!fm && /!isCounselor/.test(fm)
    && !!fb && /!isCounselor/.test(fb);
}
check('辅导员看不到切周 / A-B 分组 / 调课与编辑入口（逐入口点名）', counselGuardsOk(ttWxml));
/** 「校历」入口（超管专用）：同样必须同时带 hasTimetable 与 !isCounselor。
 *  ⚠️ 用「>校历</text>」锚定到这个具体入口，而非第一个 tt-nav-btn —— 课表页现在有三个
 *  tt-nav-btn（适配申请 / 校历 / 导入课表），re.exec 只返回第一个，会误判适配申请那枚。 */
function calGuardOk(src) {
  const cal = openTagWithClass(src, /<text\b[^>]*class="tt-nav-btn"[^>]*>校历<\/text>/);
  return !!cal && /!isCounselor/.test(cal) && /hasTimetable/.test(cal);
}
check('辅导员看不到「校历」入口', calGuardOk(ttWxml));
/* 双向自证：拆掉任一个入口的守卫都必须被抓到；原样必须通过（好样本不误报）。
   没有自证的话，哪天 wxml 结构一改、三个抽取正则全都取不到标签，
   `!!tag` 那几项会把它判失败（不会静默放过），但也没人能证明它「本来是对的」。 */
check('自证：原样判为通过', counselGuardsOk(ttWxml) && calGuardOk(ttWxml));
check('自证：摘掉 .fab-menu 的辅导员守卫会被抓到',
  // ⚠️ 锚点必须是**当前真实代码行**（2026-10 二次升级后 fab-menu 守卫改为
  // `!loading && ((canSwitchClass && classList.length) || (!isCounselor && hasTimetable))`）。
  !counselGuardsOk(ttWxml.replace('wx:if="{{!loading && ((canSwitchClass && classList.length) || (!isCounselor && hasTimetable))}}"',
    'wx:if="{{!loading && ((canSwitchClass && classList.length) || (hasTimetable))}}"')));
check('自证：摘掉切周条的辅导员守卫（只留 hasTimetable）会被抓到',
  // ⚠️ 2026-10 切周条守卫改为 `(!isCounselor && hasTimetable) || (canSwitchClass && classList.length)`。
  !counselGuardsOk(ttWxml.replace('wx:if="{{(!isCounselor && hasTimetable) || (canSwitchClass && classList.length)}}"',
    'wx:if="{{(hasTimetable) || (canSwitchClass && classList.length)}}"')));
check('自证：摘掉校历入口的辅导员守卫会被抓到',
  !calGuardOk(ttWxml.replace('wx:if="{{isSuper && hasTimetable && !isCounselor}}"',
    'wx:if="{{isSuper && hasTimetable}}"')));
check('学生空态留了「课表待接入教务系统」说明标记（仅非辅导员/非课表班学生）',
  /!canSwitchClass && !hasTimetable/.test(ttWxml) && /课表待接入教务系统/.test(ttWxml));

/* ---------- ⑦ 课表页已回退：只保留「全班课表」（2026-10-07 用户要求） ----------
 * 用户原话：「课程表页回退，不要全班课表和我的课表切换选项了，仅保留全班课表，
 * 回退到之前没有做申请适配的版本」。
 *
 * 已把 `miniprogram/pages/timetable/` 还原到基线 `20261005-014930`
 * （我的课表 / 导入课表 / 申请适配都还没有的那一版），并把 `pages/timetable-apply`
 * 整页移出小程序、app.json 注销。
 *
 * 本节从「断言我的课表存在」改成**锁住这次回退**：这些入口一旦被人重新加回来必须被抓到。
 * ⚠️ 云端能力**故意保留**（course 的 myList / mySave / syncFromClass / publishToClass /
 *    applyTimetable / handleApply，以及 member_timetable、timetable_apply 两张表）——
 *    前端不再暴露入口而已，将来要恢复直接接回页面即可，不必重写后端。
 */
console.log('\n--- ⑦ 课表页回退状态（仅保留全班课表） ---');
const appJson = fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8');
check('课表页没有「我的课表 / 数据源切换」（srcTabs / srcView / mineRows）',
  !/srcTabs|srcView|mineRows|_mineAsCourses/.test(ttJs) && !/srcTabs/.test(ttWxml));
check('课表页没有「导入课表 / 申请适配」入口',
  !/onImportTap|onApplyTap|applyTimetable|importShow|groupSheetShow/.test(ttJs + ttWxml));
check('申请适配页已从 app.json 注销',
  appJson.indexOf('"pages/timetable-apply/index"') < 0);
check('课表页仍保留「全班课表」主视图（没被误删）',
  // ⚠️ 锚点用基线真实代码行：`tt.sessionsOfWeek(week)` 取课次 + `_build(courses)` 渲染网格。
  //    `_resolveCourses` 是「我的课表」上线后才有的函数，回退后不存在（别拿它当锚点）。
  /tt\.sessionsOfWeek\(this\.data\.week\)/.test(ttJs) && /_build\(courses/.test(ttJs));

/* 双向自证：把上面两条判据抽成函数，只在**内存副本**上变异（绝不写盘），
 * 确认「入口被加回来」时判据真的会红 —— 否则这几行就是装饰。 */
const noMineUi = (js, wxml) => !/srcTabs|srcView|mineRows|_mineAsCourses/.test(js) && !/srcTabs/.test(wxml);
const noApplyUi = (js, wxml) => !/onImportTap|onApplyTap|applyTimetable|importShow|groupSheetShow/.test(js + wxml);
check('自证：原样判为通过（回退判定函数本身有效）', noMineUi(ttJs, ttWxml) && noApplyUi(ttJs, ttWxml));
check('自证：把「我的课表」入口加回页面会被抓到',
  !noMineUi(ttJs + '\n const srcTabs = []; function _mineAsCourses(){}', ttWxml));
check('自证：把「申请适配」入口加回页面会被抓到',
  !noApplyUi(ttJs + '\n function onApplyTap(){} function applyTimetable(){}', ttWxml));

/* ⚠️ 云端节次守卫仍要守：1-5 = 一天五大节（用户口径 1-2/3-4/5-6/7-8/9-10 小节）。
 * `courseUpsert` 是「全班课表」的课次新增/编辑入口，回退后依然在用。
 * ⚠️ `period >= 1 && period <= 5` 这行在 course/index.js 里有**两处**
 *    （courseUpsert + myTimetableSave），不能用「取第一处」的写法做判据/变异：
 *    那样变异会改到 courseUpsert 头上、另一处原封不动 ⇒ 变异空转、判据假绿。
 *    正确做法：正则全局扫描**所有**节次守卫、取最大值，判据 = 「全部都是 5」。 */
const courseJs = fs.readFileSync(path.join(ROOT, 'cloudfunctions/course/index.js'), 'utf8');
const PERIOD_GUARD_SRC = "if (!(period >= 1 && period <= 5)) throw new BizError(41001, '请选择节次');";
/** 扫出所有节次守卫里的上界并取最大（0 = 一个都没找到 ⇒ 锚点漂移）
 *  ⚠️ 报错文案可能带动态内容（如「请选择节次（1-7）」，上界回显给用户），
 *     故只锚 `BizError(41001,` 起的调用形态，不锚文案字面量。 */
function periodGuardMax(src) {
  const re = /if \(!\(period >= 1 && period <= (\d)\)\) throw new BizError\(41001,/g;
  let max = 0, m;
  while ((m = re.exec(src))) max = Math.max(max, Number(m[1]));
  return max;
}
/* 🔴 口径变更（2026-10-14）：本日历曾把「节次校验收口 1-5」当铁律钉死，
 *   为的是挡住第 6/7 节进课表。现在需求反过来了 ——
 *   2601/示例班级B/示例班级A 要加一门「书香校园」（仅 45 分钟），必须能排到**第 6 个大节**。
 *   ⇒ 校验收口改为「按本班 class.period_time」（week.periodCount，兜底 5 / 上限 10），
 *   本组断言随之从「上界必须是 5」翻成「必须收口到 periodCount、且上界不再写死」。
 *   节次数动态化的完整判据见 scripts/check-period-count.js。 */
check('云端课次节次校验改为收口本班配置（periodCount），不再写死 5',
  periodGuardMax(courseJs) === 0 && /week\.periodCount\(cfg\)/.test(courseJs),
  '写死守卫上界 = ' + periodGuardMax(courseJs) + '，periodCount 引用 ' +
  (courseJs.split('week.periodCount(cfg)').length - 1) + ' 处');
/* 变异必须**真的改到文件**再判「被抓到」：把动态上界换回写死的 7，必须被抓到 */
const PERIOD_DYN_GUARD_SRC = "if (!(period >= 1 && period <= nPeriods)) throw new BizError(41001, '请选择节次（1-' + nPeriods + '）');";
const courseMutated = courseJs.split(PERIOD_DYN_GUARD_SRC)
  .join("if (!(period >= 1 && period <= 7)) throw new BizError(41001, '请选择节次（1-7）');");
check('自证：动态守卫锚点存在（防漂移，否则下一项是假绿）',
  courseMutated !== courseJs && courseJs.indexOf(PERIOD_DYN_GUARD_SRC) >= 0,
  '锚点出现 ' + (courseJs.split(PERIOD_DYN_GUARD_SRC).length - 1) + ' 次');
check('自证：节次校验回退成写死 7 会被抓到',
  periodGuardMax(courseMutated) === 7 && /week\.periodCount\(cfg\)/.test(courseMutated),
  '变异后上界 = ' + periodGuardMax(courseMutated));

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
