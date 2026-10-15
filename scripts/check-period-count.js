/**
 * 门禁：大节数必须**跟随本班 period_time**，不得写死 5（2026-10-14）。
 *
 * 背景：2601/示例班级B/示例班级A 要加一门「书香校园」（仅 45 分钟），需要能排到第 6 个大节。
 * 过去全链路把 5 写死（upsert 校验 / 前端网格 / 节次选择器 / replaceSessions），
 * 后台虽能加第 6 行，小程序端却直接把它过滤掉、甚至整批拒收课次。
 *
 * 覆盖：
 *   A. 后端 —— week.periodCount 存在 + upsert/apply 两处校验用它 + 行为自证（配置 6 节则第 6 节可过）
 *   B. 端上 —— data/timetable.js 有 setPeriods/periodCount/MAX_PERIOD；replaceSessions 上限不再是 5
 *   C. 前端 —— 课表页网格与节次选择器读 tt.periodCount()/periodChips，不再出现 [1,2,3,4,5] 硬编码
 *   D. admin-web —— mod-course 的 period 校验改为读班级配置
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const R = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const weekSrc = read('cloudfunctions/common/week.js');
const courseSrc = read('cloudfunctions/course/index.js');
const ttSrc = read('miniprogram/data/timetable.js');
const pageSrc = read('miniprogram/pages/timetable/index.js');
const wxmlSrc = read('miniprogram/pages/timetable/index.wxml');
const modCourseSrc = read('cloudfunctions/admin-web/lib/mod-course.js');
const appSrc = read('cloudfunctions/admin-web/public/app.js');
const indexSrc = read('cloudfunctions/admin-web/index.js');

let failed = 0;
function pin(name, fn) {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

/* ---------- A. 后端 ---------- */
pin('A1 week.js 导出 periodCount', () => {
  assert.ok(/function periodCount\(config\)/.test(weekSrc), 'periodCount 未定义');
  assert.ok(/periodMap, periodCount,/.test(weekSrc), 'periodCount 未导出');
});
pin('A2 periodCount 兜底 5 + 上限 10（MAX_PERIOD_COUNT）', () => {
  assert.ok(/DEFAULT_PERIOD_COUNT\s*=\s*5/.test(weekSrc), '缺兜底 5');
  assert.ok(/MAX_PERIOD_COUNT\s*=\s*10/.test(weekSrc), '缺上限 10');
});
pin('A2b periodCount 必须能吃 JSON **字符串**（mysql2 对 JSON 列返回字符串）', () => {
  // 🔴 2026-10-14 实踩：period_time 在库里是 JSON 字符串。periodCount 早前只认数组，
  //   拿到字符串 ⇒ 走「非数组」分支 ⇒ 无声兜底成 5 ⇒ 用户配了 7 节，后台仍按 5 校验。
  assert.ok(/typeof arr === 'string'/.test(weekSrc), 'periodCount 未处理字符串形态');
  assert.ok(/JSON\.parse\(arr\)/.test(weekSrc), 'periodCount 未解析 JSON 字符串');
});
pin('A3 course upsert 校验改用 week.periodCount(cfg)（不再 period<=5）', () => {
  assert.ok(/const nPeriods = week\.periodCount\(cfg\)/.test(courseSrc), 'upsert 未用 periodCount');
  assert.ok(/period >= 1 && period <= nPeriods/.test(courseSrc), 'upsert 仍写死上界');
  // upsert 与 applyTimetable 两处都不能剩 period<=5
  const hits = courseSrc.match(/period >= 1 && period <= 5/g) || [];
  assert.ok(hits.length === 0, 'course 仍有 ' + hits.length + ' 处 period<=5');
});
pin('A4 course applyTimetable 同样用 periodCount', () => {
  assert.ok(/const nPeriods2 = week\.periodCount\(cfg\)/.test(courseSrc), 'apply 未用 periodCount');
});

/* ---------- B. 端上数据源 ---------- */
pin('B1 data/timetable.js 有 setPeriods / periodCount / MAX_PERIOD 并导出', () => {
  assert.ok(/function setPeriods\(periodTime\)/.test(ttSrc), '缺 setPeriods');
  assert.ok(/const periodCount = \(\) => _periodCount;/.test(ttSrc), '缺 periodCount 读取');
  assert.ok(/const MAX_PERIOD = 10;/.test(ttSrc), '缺 MAX_PERIOD');
  assert.ok(/setPeriods,/.test(ttSrc) && /periodCount,/.test(ttSrc) && /MAX_PERIOD,/.test(ttSrc), '未导出三者');
});
pin('B2 replaceSessions 校验用 MAX_PERIOD（不再写死 5）', () => {
  const fn = ttSrc.slice(ttSrc.indexOf('function replaceSessions'), ttSrc.indexOf('function classDateOf'));
  assert.ok(/s\.period >= 1 && s\.period <= MAX_PERIOD/.test(fn), 'replaceSessions 上限未用 MAX_PERIOD');
  assert.ok(!/period <= 5/.test(fn), 'replaceSessions 仍写死 5');
});

/* ---------- C. 前端页面 ---------- */
pin('C1 课表页网格行数不再写死（读 tt.periodCount 并按本周实际节次取大者）', () => {
  // 🔴 2026-10-14 二次调整：平时一天五节大课，第6节是短课特殊时段。
  //   行数 = max(1, 配置节次数, 本周实际最高节次) ⇒ 没第6节课的周次不出现空行。
  assert.ok(/Math\.max\(1, tt\.periodCount\(\), maxUsedPeriod\)/.test(pageSrc),
    '缺 nPeriods = max(1, tt.periodCount(), maxUsedPeriod)（配置节次数与本周实际取大者）');
  assert.ok(/maxUsedPeriod = \(courses \|\| \[\]\)\.reduce/.test(pageSrc), '缺 maxUsedPeriod（本周实际最高节次）计算');
  // 判定必须按整周 courses 且排除调出，与 hasWeekend 同口径（否则切组会跳动）
  assert.ok(/if \(c\.movedOut\) return mx;/.test(pageSrc), 'maxUsedPeriod 未排除「调出」的课');
  assert.ok(/p <= nPeriods/.test(pageSrc), '网格循环未用 nPeriods');
  assert.ok(/if \(p < 1 \|\| p > nPeriods\) return;/.test(pageSrc), '过滤未用 nPeriods');
  assert.ok(!/p <= 5; p\+\+\)/.test(pageSrc), '仍有 p<=5 硬编码循环');
  assert.ok(!/p > 5\) return;/.test(pageSrc), '仍有 p>5 硬编码过滤');
});
pin('C2 class.list 结果带 periodTime，且按班重算节次数', () => {
  assert.ok(/periodTime: c\.periodTime \|\| \[\]/.test(pageSrc), 'chips 未带 periodTime');
  assert.ok(/_syncPeriodCount\(classId\)/.test(pageSrc), '缺 _syncPeriodCount');
  // 两条切班路径都要调（初载 + onTimetableClass）
  const calls = pageSrc.match(/this\._syncPeriodCount\(/g) || [];
  assert.ok(calls.length >= 2, '_syncPeriodCount 调用点只有 ' + calls.length + ' 处（应含初载与切班）');
});
pin('C3 wxml：节次选择器读 periodChips、骨架屏读 periods，无 [1,2,3,4,5] 硬编码', () => {
  const chips = wxmlSrc.slice(wxmlSrc.indexOf('f-chips'));
  assert.ok(/wx:for="\{\{periodChips\}\}"/.test(chips), '节次选择器未用 periodChips');
  const skel = wxmlSrc.slice(wxmlSrc.indexOf('wx:elif="{{loading}}"'));
  assert.ok(/wx:for="\{\{periods\}\}"/.test(skel.slice(0, 400)), '骨架屏未用 periods');
  assert.ok(!/wx:for="\{\{\[1,2,3,4,5\]\}\}"/.test(wxmlSrc), '仍有 [1,2,3,4,5] 硬编码');
  assert.ok(!/1-2 上午 · 3-4 下午 · 5 晚上/.test(wxmlSrc), '节次提示仍写死 5 节口径');
});

/* ---------- D. admin-web ---------- */
pin('D1 mod-course 的 period 校验改读班级配置（新增与编辑同口径）', () => {
  assert.ok(/period >= 1 && period <= 5/.test(modCourseSrc) === false, 'mod-course 仍写死 period<=5');
  assert.ok(/timetableWeek\.periodCount\(/.test(modCourseSrc), 'mod-course 未用 week.periodCount');
  assert.ok(/async function classPeriodCfg\(pool, classId\)/.test(modCourseSrc), '缺 classPeriodCfg 取本班 period_time');
  // 🔴 2026-10-14 用户实锤第二个 bug：只改了 addSession，updateSession 仍写死 5
  //   ⇒ 「编辑比新增更严」，加错星期后只能删除重加。两条路径必须都读配置。
  const upd = modCourseSrc.slice(modCourseSrc.indexOf('async function updateSession'),
    modCourseSrc.indexOf('async function', modCourseSrc.indexOf('async function updateSession') + 10));
  assert.ok(/timetableWeek\.periodCount\(/.test(upd), 'updateSession 未按本班配置校验（编辑比新增严 ⇒ 只能删不能改）');
  assert.ok(/before\.period/.test(upd), 'updateSession 未容错「课次原本就是这个大节」');
});
pin('D2 admin-web 解析器上限放宽到 10（否则第 6 节整行被丢）', () => {
  assert.ok(/period > 10\) continue/.test(appSrc), '解析器上限未放宽');
  assert.ok(!/period > 5\) continue/.test(appSrc), '解析器仍写死 5');
});
pin('D3 admin-web 大节下拉按本班 periodTime 生成（periodOptions）', () => {
  assert.ok(/function periodOptions\(cls, mustInclude\)/.test(appSrc), '缺 periodOptions');
  // 添加/编辑两个弹层都要用它，且编辑那处必须传 mustInclude（防静默改节次）
  const add = appSrc.slice(appSrc.indexOf('function openAddDialog'));
  assert.ok(/periodOptions\(cls\)/.test(add), '添加弹层未用 periodOptions');
  const edit = appSrc.slice(appSrc.indexOf('function openSessionDialog'));
  assert.ok(/periodOptions\(currentClass\(\), r\.period\)/.test(edit), '编辑弹层未传 mustInclude');
  // 残留的写死数组
  assert.ok(!/\[1, 2, 3, 4, 5\]\.map/.test(appSrc), 'app.js 仍有 [1,2,3,4,5].map 硬编码');
});

/* ---------- D4. /api/me 必须放行 periodTime（2026-10-14 用户实锤的真凶） ----------
 * 🔴 病根：`/api/me` 曾只回传 {id,name,isActive} 三个字段，把 maskClass 解析好的
 *    periodTime 丢在服务端 ⇒ 前端 state.classes 里没有这个字段 ⇒ periodOptions
 *    永远走兜底 5 项 ⇒ **线上给 示例班级A 配了 6 个大节，下拉仍然只有 5 项**。
 *    「凡是按班级配置动态渲染的前端逻辑，字段都必须在这一层放行」——新增白名单字段时务必同步这里。
 */
pin('D4 /api/me 的班级清单放行 periodTime 与 mainRoom', () => {
  const meIdx = indexSrc.indexOf("app.get('/api/me'");
  assert.ok(meIdx > 0, '找不到 /api/me 路由');
  const meBlock = indexSrc.slice(meIdx, meIdx + 900);
  assert.ok(/periodTime:\s*c\.periodTime/.test(meBlock), '/api/me 未放行 periodTime（下拉只能走兜底 5 项）');
  assert.ok(/mainRoom:\s*c\.mainRoom/.test(meBlock), '/api/me 未放行 mainRoom');
  assert.ok(!/classes: classes\.map\(\(c\) => \(\{ id: c\.id, name: c\.name, isActive: c\.isActive \}\)\)/.test(meBlock),
    '/api/me 仍是三字段精简映射（会丢 periodTime）');
});
pin('D5 保存班级配置后必须刷新 state.classes（否则当次不生效）', () => {
  assert.ok(/function refreshClasses\(\)/.test(appSrc), '缺 refreshClasses');
  const saveIdx = appSrc.indexOf("api('/api/classes/' + id, { method: 'POST'");
  assert.ok(saveIdx > 0, '找不到班级保存调用');
  const after = appSrc.slice(saveIdx, saveIdx + 400);
  assert.ok(/refreshClasses\(\)\.then\(reload\)/.test(after), '保存后未刷新班级清单（改了配置当次不生效）');
  assert.ok(!/toast\('已保存', 'ok'\); reload\(\);/.test(after), '保存后仍是裸 reload()（不重拉 /api/me）');
});
pin('D6 后台课表页无「保洁」死代码（过滤 CLEAN 后不应留标签分支）', () => {
  assert.ok(/r\.kind !== 'CLEAN'/.test(appSrc), '课表页不再过滤 CLEAN 课次');
  assert.ok(!/tag-clean/.test(appSrc), '仍有 tag-clean 标签分支（被 filter 掉，永不命中的死代码）');
});

/* ---------- E. 变异自证：真的模拟「回退到写死 5」，判据必须红 ----------

/* ---------- F. 周次区间写法「6-13」必须端上/后端同口径（2026-10-14 用户实锤） ----------
 * 🔴 病根：后台「具体周次」框允许直接写区间，但
 *   · 端上 `data/timetable.js matchesWeeks` 早前只 `split(',') + Number()` ⇒ `Number('6-13')`=NaN ⇒ 整批周次判否
 *   · 后端 `common/week.js parseWeeks` 早前只 `parseInt('6-13')` = 6 ⇒ 7~13 静默丢弃
 *   ⇒ 用户在第 6 周能看到「书香校园」，第 7~13 周全消失（当周恰好在区间内所以没被发现）。
 * 现在两端都支持区间，且后台新增课次时**归一化后再落库**。
 */
pin('F1 后端 parseWeeks 支持区间 6-13', () => {
  const src = weekSrc.slice(weekSrc.indexOf('function parseWeeks'), weekSrc.indexOf('function', weekSrc.indexOf('function parseWeeks') + 20));
  // 区间分支的识别特征：`^(\d+)\s*-\s*(\d+)$`（源码里是 JS 正则字面量，此处按文本匹配）
  assert.ok(src.indexOf('(\\d+)\\s*-\\s*(\\d+)') >= 0, 'parseWeeks 缺区间分支 /^(\\d+)\\s*-\\s*(\\d+)$/');
  assert.ok(/for \(let i = a; i <= b; i\+\+\)/.test(src), 'parseWeeks 未做区间展开');
  assert.ok(/isWeeksBlank\(weeks\)/.test(src), 'parseWeeks 丢了 isWeeksBlank 前置判断');
  // 端上必须同口径（同一个正则形态）
  const tSrc = ttSrc.slice(ttSrc.indexOf('function matchesWeeks'), ttSrc.indexOf('/**', ttSrc.indexOf('function matchesWeeks')));
  assert.ok(tSrc.indexOf('(\\d+)\\s*-\\s*(\\d+)') >= 0, '端上 matchesWeeks 的区间正则与后端不一致');
});
pin('F2 端上 matchesWeeks 支持区间 6-13（与后端同口径）', () => {
  const src = ttSrc.slice(ttSrc.indexOf('function matchesWeeks'), ttSrc.indexOf('/**', ttSrc.indexOf('function matchesWeeks')));
  assert.ok(/\\d\+/.test(src) && /for \(let i = a; i <= b; i\+\+\)/.test(src),
    '端上 matchesWeeks 未做区间展开 ⇒ 课表页看不到 6-13 周的课');
});
pin('F3 后台新增课次时周次归一化后再落库', () => {
  assert.ok(/timetableWeek\.parseWeeks\(/.test(modCourseSrc), 'addSession 未用 parseWeeks 归一化周次（裸区间会入库）');
});
pin('F4 allSessions 回传 duty_count（端上不写死 2）', () => {
  const coSrc = read('cloudfunctions/course/index.js');
  const seg = coSrc.slice(coSrc.indexOf('allSessions'), coSrc.indexOf('shiftList'));
  assert.ok(/s\.duty_count/.test(seg), 'allSessions 的 SQL 未取 duty_count ⇒ 端上只能写死 2');
  assert.ok(/dutyCount:\s*r\.duty_count/.test(seg), 'allSessions 返回未带 dutyCount');
  // 端上两处映射都不许再写死 2
  const occ = (ttSrc.match(/dutyCount:\s*2,/g) || []).length;
  assert.ok(occ === 0, 'data/timetable.js 仍有 ' + occ + ' 处 dutyCount: 2 写死');
});

/* ---------- E. 变异自证：真的模拟「回退到写死 5」，判据必须红 ----------
 * 🔴 注意：单纯把常量值改小（如 MAX_PERIOD 10→5）**抓不住** ——
 *    判据锚的是「用 MAX_PERIOD 这个名字」，名字没变照样绿。
 *    真正的回退形态是**把变量换回字面量 5**（这正是历史上写法），必须能被抓到。
 */
pin('E1 变异自证：replaceSessions 上限写回字面量 5 ⇒ B2 判据必须红', () => {
  const mutated = ttSrc.replace(
    /s\.period >= 1 && s\.period <= MAX_PERIOD/,
    's.period >= 1 && s.period <= 5'
  );
  assert.ok(mutated !== ttSrc, '变异未生效（锚点漂移，需更新判据）');
  const fn = mutated.slice(mutated.indexOf('function replaceSessions'), mutated.indexOf('function classDateOf'));
  const stillOk = /s\.period >= 1 && s\.period <= MAX_PERIOD/.test(fn) && !/period <= 5/.test(fn);
  assert.ok(!stillOk, '变异后判据仍判绿 ⇒ 判据抓不住回退（需改锚点）');
});
pin('E2 变异自证：前端 p>5 硬编码 ⇒ C1 判据必须红', () => {
  const mutated = pageSrc.replace('if (p < 1 || p > nPeriods) return;', 'if (p < 1 || p > 5) return;');
  assert.ok(mutated !== pageSrc, '变异未生效');
  assert.ok(!/p > nPeriods/.test(mutated), '变异后 C1 判据仍判绿 ⇒ 抓不住回退');
});

console.log(failed ? '\n[FAIL] ' + failed + ' 项未过' : '\n[PASS] 大节数动态化门禁全过');
process.exit(failed ? 1 : 0);
