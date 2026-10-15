#!/usr/bin/env node
/**
 * 离线自检：每周二下午「410大扫除」= 4 人 + 名称「410大扫除」
 * ------------------------------------------------------------
 * 学校通知：每周二下午全校大扫除（410 教室）。因此周二那条保洁课次
 *   ① 人数 2 → 4（周一/三/四/五保持 2 人不变）；
 *   ② 对外名称「打扫410」→「410大扫除」；
 *   ③ 仍按序号轮转，与课程值日共用同一个轮转池（算法/游标一行不改）。
 *
 * 本门禁把「改回去」的几个口子钉死：
 *   A. 种子 scripts/init.sql：有「410大扫除」课程（4 人）+ 周二 session 改指；
 *   B. 生产迁移 scripts/migrate-tuesday-clean.sql：存在、幂等、只碰周二；
 *   C. 排班取人数量来自 session.duty_count（不能写死 2，否则周二排不满 4 人）；
 *   D. 保洁提醒文案取 courseName（写死「打扫410」会让周二通知说错）；
 *   E. 值日页分组标题 / AI 预览标签取 courseName（同上）。
 *
 * 每条判据都配一次「变异自证」：把源码改成回归形态后判据必须翻红，
 * 否则说明判据是恒真的假闸（本项目踩过：注释里也有同名文案 ⇒ 全文件 grep 假通过）。
 *
 * 用法：node scripts/check-tuesday-clean.js
 * 深水验证（真 MySQL 跑迁移 + 真跑 generate）：node scripts/verify-tuesday-clean-db.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

/**
 * 判据：re 必须命中 src；且把 src 变异成 regressed 形态后**必须不命中**。
 * 两个方向都验过，才能说明 re 真的在守这条规则（而不是恒真/恒假）。
 */
function pin(desc, src, re, mutate) {
  if (!re.test(src)) { bad(desc + ' —— 判据未命中（规则没落实或被改回去了）'); return; }
  const mutated = mutate(src);
  if (mutated === src) { bad(desc + ' —— 变异没生效（mutate 函数没改到东西，自证无效）'); return; }
  if (re.test(mutated)) { bad(desc + ' —— 变异后仍命中：判据是恒真的假闸'); return; }
  ok(desc);
}

/* ---------- A. 种子数据 ---------- */
console.log('── A. 种子 scripts/init.sql');
const initSql = read('scripts/init.sql');
pin('init.sql 新增课程「410大扫除」且 duty_count=4',
  initSql,
  /SELECT\s+'410大扫除',\s*NULL,\s*'410',\s*'ALL',\s*4,/,
  (s) => s.replace(/SELECT\s+'410大扫除',\s*NULL,\s*'410',\s*'ALL',\s*4,/, "SELECT '410大扫除', NULL, '410', 'ALL', 2,"));
pin('init.sql 把周二 CLEAN 课次改挂「410大扫除」并置 duty_count=4',
  initSql,
  /UPDATE session s[\s\S]{0,240}?SET s\.course_id\s*=\s*c2\.id,\s*s\.duty_count\s*=\s*4[\s\S]{0,200}?day_of_week\s*=\s*2\s*AND\s*s\.period\s*=\s*4/,
  (s) => s.replace(/s\.duty_count\s*=\s*4/, 's.duty_count = 2'));
if (/day_of_week\s*=\s*2\s*AND\s*s\.period\s*=\s*4/.test(initSql)) {
  ok('init.sql 的改挂动作限定在「周二 + 第4节」');
} else {
  bad('init.sql 的改挂动作没有限定星期二（会误伤其它天）');
}

/* ---------- B. 生产迁移 SQL ---------- */
console.log('\n── B. 生产迁移 scripts/migrate-tuesday-clean.sql');
const migPath = path.join(ROOT, 'scripts/migrate-tuesday-clean.sql');
if (!fs.existsSync(migPath)) {
  bad('缺少 scripts/migrate-tuesday-clean.sql（生产库没有可照做的迁移步骤）');
} else {
  const mig = read('scripts/migrate-tuesday-clean.sql');
  pin('迁移 SQL 用 INSERT ... WHERE NOT EXISTS 保证幂等',
    mig,
    /INSERT INTO course\s*\([\s\S]{0,200}?'410大扫除'[\s\S]{0,200}?WHERE NOT EXISTS/,
    (s) => s.replace(/WHERE NOT EXISTS \(SELECT 1 FROM course WHERE name = '410大扫除'\)/, ''));
  pin('迁移 SQL 只把周二 CLEAN 课次改成 4 人',
    mig,
    /UPDATE session s[\s\S]{0,240}?SET s\.course_id\s*=\s*c_to\.id,\s*s\.duty_count\s*=\s*4[\s\S]{0,200}?s\.day_of_week\s*=\s*2\s*AND\s*s\.period\s*=\s*4/,
    (s) => s.replace(/s\.duty_count\s*=\s*4/, 's.duty_count = 2'));
  if ((mig.match(/day_of_week\s*=\s*2/g) || []).length >= 2) {
    ok('迁移 SQL 两处 UPDATE 都带 day_of_week=2 限定（周一/三/四/五不受影响）');
  } else {
    bad('迁移 SQL 有 UPDATE 没带 day_of_week=2 限定（会误伤其它天）');
  }
  if (/UPDATE session s[\s\S]*?WHERE s\.kind = 'CLEAN'/.test(mig)) {
    ok('迁移 SQL 的 UPDATE 都带 kind=\'CLEAN\' 限定（不会误改普通课次）');
  } else {
    bad('迁移 SQL 有 UPDATE 没带 kind=\'CLEAN\' 限定（会误改普通课次）');
  }
}

/* ---------- C. 排班取人数量来自 session.duty_count ---------- */
console.log('\n── C. 排班取人 cloudfunctions/schedule/index.js · buildCleaningPlan');
const sched = read('cloudfunctions/schedule/index.js');
pin('保洁课次取人数量 = session.duty_count − 已占（不写死 2，周二才能排满 4 人）',
  sched,
  /const need = Number\(s\.duty_count \?\? 2\) - taken\.size;/,
  (s) => s.replace(/const need = Number\(s\.duty_count \?\? 2\) - taken\.size;/, 'const need = 2 - taken.size;'));
pin('保洁课次名回显取 courseName（前端据此显示「410大扫除」）',
  sched,
  /course: s\.courseName \|\| '打扫410'/,
  (s) => s.replace(/course: s\.courseName \|\| '打扫410'/, "course: '打扫410'"));

/* ---------- D. 提醒文案 ---------- */
console.log('\n── D. 微信订阅消息提醒 cloudfunctions/cron-weekly/index.js');
const cron = read('cloudfunctions/cron-weekly/index.js');
pin('保洁提醒文案 = 「18点前」+ courseName（周二自动显示「18点前410大扫除」）',
  cron,
  /cur\.items\.push\('18点前' \+ \(r\.courseName \|\| '打扫410'\)\)/,
  (s) => s.replace(/cur\.items\.push\('18点前' \+ \(r\.courseName \|\| '打扫410'\)\)/, "cur.items.push('18点前打扫410')"));
pin('纯保洁日「课程名称」格用当天保洁课次名顶格（周二不能退回「打扫410」）',
  cron,
  /info\.courses\.join\('、'\) \|\| info\.cleanCourses\.join\('、'\) \|\| '打扫410'/,
  (s) => s.replace(/info\.courses\.join\('、'\) \|\| info\.cleanCourses\.join\('、'\) \|\| '打扫410'/, "info.courses.join('、') || '打扫410'"));

/* ---------- E. 前端展示 ---------- */
console.log('\n── E. 前端展示 miniprogram/pages/duty');
const dutyJs = read('miniprogram/pages/duty/index.js');
pin('值日页保洁分组标题以 courseName 开头（周二显示「410大扫除 · 410」）',
  dutyJs,
  /g\.groupTitle = g\.isClean\s*\n?\s*\? \(\(g\.courseName \|\| '打扫410'\) \+ ' · '/,
  (s) => s.replace(/\(\(g\.courseName \|\| '打扫410'\) \+ ' · '/, "('打扫410' + ' · '"));
const dutyWxml = read('miniprogram/pages/duty/index.wxml');
pin('一键生成预览的保洁标签取 courseName（周二显示「410大扫除」）',
  dutyWxml,
  /\{\{item\.course \|\| '打扫410'\}\}/,
  (s) => s.replace(/\{\{item\.course \|\| '打扫410'\}\}/, '打扫410'));

/* ---------- F. 边界：周一/三/四/五的口径没被顺手改掉 ---------- */
console.log('\n── F. 边界：其它四天仍是「18点前 / 打扫410」');
const utilJs = read('miniprogram/utils/util.js');
if (/return kind === 'CLEAN' \? CLEAN_WHEN : \('第' \+ period \+ '节'\)/.test(utilJs)) {
  ok('util.whenText 仍把全部保洁课次统一显示「18点前」（周二也是「18点前」）');
} else {
  bad('util.whenText 不再是「保洁一律 18点前」口径');
}
const doc = read('docs/微信订阅消息接入指引.md');
if (/周二为「\*\*18点前410大扫除\*\*」、其余为「\*\*18点前打扫410\*\*」/.test(doc)) {
  ok('订阅消息文档已写清周二与其它天的区别');
} else {
  bad('订阅消息文档没写清周二与其它天的区别');
}

/* ---------- G. 轮转算法与游标未被改动 ---------- */
console.log('\n── G. 轮转算法/游标语义保持原样');
const core = read('cloudfunctions/common/round-robin.js');
if (/softSeqs/.test(core) && /avoidSeqs/.test(core)) {
  ok('轮转内核 pickBySeq 仍带 softSeqs（一轮里每人最多一次）');
} else {
  bad('轮转内核的 softSeqs/avoidSeqs 约束被删了（会出现同一人一周多次）');
}
if (/const need = Number\(s\.duty_count \?\? 2\) - taken\.size;/.test(sched)
  && !/day_of_week === 2/.test(sched)) {
  ok('schedule 侧没有「按星期二特判」的分支（周二靠 duty_count 数据生效，不是代码分支）');
} else {
  bad('schedule 侧出现了按星期二特判的分支 —— 应只靠数据（duty_count / course.name）生效');
}

/* ---------- H. 课程表仍要隐藏保洁（改名带来的回归点） ---------- */
console.log('\n── H. 课程表页仍隐藏保洁课次（含改名后的周二）');
const tt = read('miniprogram/data/timetable.js');
/*
 * 🔴 这一条是**改名直接引入的回归**：课表页靠 `/打扫/` 过滤保洁课次，
 *    而「410大扫除」里没有「打」字 ⇒ 周二那节保洁会漏进课程表页，
 *    打破「课程表不显示保洁」的既有口径。判据必须覆盖两种名字。
 */
{
  const re = /CLEAN_NAME_RE\s*=\s*\/(打扫\|大扫除)\//;
  pin('课程表的保洁过滤同时覆盖「打扫410」与「410大扫除」',
    tt, re,
    (s) => s.replace(/CLEAN_NAME_RE\s*=\s*\/(打扫\|大扫除)\//, 'CLEAN_NAME_RE = /打扫/'));
  const uses = (tt.match(/CLEAN_NAME_RE\.test\(s\.name \|\| ''\)/g) || []).length;
  if (uses >= 2) ok('两处课次遍历都用了同一个过滤常量   → ' + uses + ' 处');
  else bad('只有 ' + uses + ' 处用了过滤常量（应 ≥2：正常课次 + 调课调入）');
  if (!/\/打扫\/\.test/.test(tt)) ok('已无散写的 `/打扫/` 字面量（过滤口径收在单一常量里）');
  else bad('仍有散写的 `/打扫/` 字面量 —— 改保洁名时容易漏改');
}

console.log('\n' + (failed ? '❌ 失败 ' + failed + ' 项' : '✅ 全部通过'));
process.exit(failed ? 1 : 0);
