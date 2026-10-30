/**
 * 门禁：值日排班「规则可远程配置」（2026-10-26）
 * ------------------------------------------------------------
 * 背景：用户诉求「一键排班出问题/排错班，不想改小程序规则再送审」。
 * 真相：排班算法跑在云函数（不在小程序前端）⇒ 改算法只部署云函数、不用送审小程序；
 *       且「特定人不排」早已有 member.duty_off 机制。
 * 本门禁守住四条最容易回归的线：
 *   ① 免排机制：generate / cron-weekly 的名单查询都带 duty_off = 0；admin-web 成员可写 duty_off。
 *   ② 规则读写：schedule 的 loadRules/setRules 读写 makeup_days，且 setRules 用 ON DUPLICATE KEY UPDATE（按 class_id upsert）。
 *   ③ 补录窗口：duty 不再写死 EXPIRED_MAKEUP_DAYS，改为读 schedule_rules.makeup_days。
 *   ④ 后台面板：admin-web 有 mod-schedule-rules + /api/schedule-rules 路由 + 前端「排班规则」tab。
 *
 * 不连生产库（纯静态/文件级）。线上真能读写由 `tcb db execute` 对 99999 做 upsert 实测单独验证。
 * ⚠️ 依赖两个**必须存在**的表约束（迁移时已加，改表结构时别丢）：
 *    · schedule_rules.class_id 唯一索引 uk_class（否则 ON DUPLICATE KEY UPDATE 退化成插新行）
 *    · schedule_rules.id AUTO_INCREMENT（否则 INSERT 报 1364 Field 'id' doesn't have a default value）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));
const hasNot = (s, re, msg) => (re.test(s) ? bad(msg) : ok(msg));

/* ============================================================
 * ① 免排机制：member.duty_off 被排班名单过滤 + 后台可写
 * ============================================================ */
console.log('── ① 免排（member.duty_off）');
let scheduleSrc = '', cronSrc = '';
try { scheduleSrc = read('cloudfunctions/schedule/index.js'); } catch (e) { bad('schedule/index.js 不存在'); }
try { cronSrc = read('cloudfunctions/cron-weekly/index.js'); } catch (e) { bad('cron-weekly/index.js 不存在'); }
if (scheduleSrc) {
  const dutyOffHits = (scheduleSrc.match(/duty_off\s*=\s*0/g) || []).length;
  if (dutyOffHits >= 3) ok('schedule 有 ' + dutyOffHits + ' 处 duty_off = 0（generate/AI/手动排班都排除豁免人）');
  else bad('schedule 的 duty_off = 0 过滤不足（期望≥3，实际 ' + dutyOffHits + '）');
}
if (cronSrc) has(cronSrc, /duty_off\s*=\s*0/, 'cron-weekly 定时自动排班排除豁免人（duty_off = 0）');

let modMemberSrc = '';
try { modMemberSrc = read('cloudfunctions/admin-web/lib/mod-member.js'); } catch (e) { bad('admin-web/lib/mod-member.js 不存在'); }
if (modMemberSrc) {
  has(modMemberSrc, /dutyOff:\s*Number\(r\.duty_off\)\s*===\s*1/, 'admin-web 读取 dutyOff');
  has(modMemberSrc, /patch\.dutyOff[\s\S]{0,80}put\('duty_off'/, 'admin-web 可写 duty_off（免排开关）');
}

/* ============================================================
 * ② schedule_rules 读写（含 makeup_days）
 * ============================================================ */
console.log('\n── ② schedule 规则读写（makeup_days）');
if (scheduleSrc) {
  has(scheduleSrc, /makeupDays:\s*\(r\.makeup_days[\s\S]{0,40}\)\s*\?\s*3\s*:\s*Number\(r\.makeup_days\)/, 'loadRules 读 makeup_days（缺省 3）');
  has(scheduleSrc, /INSERT INTO schedule_rules[\s\S]{0,200}makeup_days/, 'setRules INSERT 含 makeup_days 列');
  has(scheduleSrc, /ON DUPLICATE KEY UPDATE[\s\S]{0,300}makeup_days=VALUES\(makeup_days\)/, 'setRules ON DUPLICATE 更新 makeup_days');
  has(scheduleSrc, /const rawMd = Number\(r\.makeupDays\)[\s\S]{0,120}rawMd >= 0 && rawMd <= 60/, 'setRules 对 makeupDays 钳制 0–60');
}

/* ============================================================
 * ③ duty 补录窗口改读库（不再写死）
 * ============================================================ */
console.log('\n── ③ duty 补录窗口（读 schedule_rules.makeup_days）');
let dutySrc = '';
try { dutySrc = read('cloudfunctions/duty/index.js'); } catch (e) { bad('duty/index.js 不存在'); }
if (dutySrc) {
  hasNot(dutySrc, /const\s+EXPIRED_MAKEUP_DAYS\s*=\s*3/, 'duty 不再写死 EXPIRED_MAKEUP_DAYS = 3');
  has(dutySrc, /SELECT makeup_days FROM schedule_rules WHERE class_id/, 'duty 从 schedule_rules 读 makeup_days');
  has(dutySrc, /> makeupDays \* DAY_MS/, 'duty 用 makeupDays 判超期');
}

/* ============================================================
 * ④ admin-web 排班规则面板（免审入口）
 * ============================================================ */
console.log('\n── ④ admin-web 排班规则面板');
let rulesLib = '';
try { rulesLib = read('cloudfunctions/admin-web/lib/mod-schedule-rules.js'); } catch (e) { bad('admin-web/lib/mod-schedule-rules.js 不存在'); }
if (rulesLib) {
  has(rulesLib, /module\.exports\s*=\s*\{\s*getScheduleRules,\s*saveScheduleRules\s*\}/, '规则模块导出 get/save');
  has(rulesLib, /makeup_days/, '规则模块读写 makeup_days');
  has(rulesLib, /ON DUPLICATE KEY UPDATE[\s\S]{0,200}makeup_days=VALUES\(makeup_days\)/, '规则模块按 class_id upsert（含 makeup_days）');
}

let awIndex = '';
try { awIndex = read('cloudfunctions/admin-web/index.js'); } catch (e) { bad('admin-web/index.js 不存在'); }
if (awIndex) {
  has(awIndex, /require\('\.\/lib\/mod-schedule-rules'\)/, 'index.js 引入 mod-schedule-rules');
  has(awIndex, /app\.get\('\/api\/schedule-rules'/, 'index.js 注册 GET /api/schedule-rules');
  has(awIndex, /app\.post\('\/api\/schedule-rules'/, 'index.js 注册 POST /api/schedule-rules');
}

let awApp = '';
try { awApp = read('cloudfunctions/admin-web/public/app.js'); } catch (e) { bad('admin-web/public/app.js 不存在'); }
if (awApp) {
  has(awApp, /function renderRules\(host\)/, 'app.js 有 renderRules');
  has(awApp, /rules:\s*\{\s*title:\s*'排班规则',\s*render:\s*renderRules\s*\}/, 'VIEWS 注册「排班规则」');
  has(awApp, /f-dutyoff/, '成员编辑含「不排值日」下拉');
}

let awHtml = '';
try { awHtml = read('cloudfunctions/admin-web/public/index.html'); } catch (e) { bad('admin-web/public/index.html 不存在'); }
if (awHtml) has(awHtml, /data-view="rules"/, '导航有「排班规则」按钮');

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 排班规则可远程配置（免排 duty_off / makeup_days / admin-web 面板）校验通过');
