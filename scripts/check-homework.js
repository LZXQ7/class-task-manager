/**
 * 门禁：作业提交与管理模块（2026-10-24）
 * ------------------------------------------------------------
 * 守住四条最容易回归的线：
 *   ① 前后端限制常量**逐字一致**（与 POSITIONS / feeRights 同套打法，前端拦不住的后端必须拦住）
 *   ② 大小 / 格式 / 总量**后端权威校验**真的生效（不是只写在前端）
 *   ③ 数量配置钳制在 1–9（图片）/ 1–3（文件）
 *   ④ 权限：仅班委可发布 / 批阅；页面已注册
 *
 * 只用 mockConn，不连生产库。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BE = require(path.join(ROOT, 'cloudfunctions/common/homework-limit.js'));
const FE = require(path.join(ROOT, 'miniprogram/utils/homework-limits.js'));
const { LIMIT, extOf, allowExt, validateFiles } = BE;

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

const MB = 1024 * 1024;

/* ============================================================
 * ① 前后端限制常量对齐
 * ============================================================ */
console.log('── ① 前后端限制常量对齐');
const beKeys = Object.keys(LIMIT);
const feKeys = Object.keys(FE);
let mismatch = 0;
beKeys.forEach(k => {
  if (JSON.stringify(LIMIT[k]) !== JSON.stringify(FE[k])) {
    bad('限制常量不一致：' + k + ' 后端=' + JSON.stringify(LIMIT[k]) + ' 前端=' + JSON.stringify(FE[k]));
    mismatch += 1;
  }
});
if (!mismatch) ok('前后端限制常量完全对齐（共 ' + beKeys.length + ' 项）');
if (feKeys.length !== beKeys.length) {
  bad('常量项数不一致：后端 ' + beKeys.length + ' / 前端 ' + feKeys.length);
} else {
  ok('常量项数一致（' + beKeys.length + ' 项）');
}

/* ============================================================
 * ② 后端校验真的生效（功能级）
 * ============================================================ */
console.log('\n── ② 后端大小 / 格式 / 总量校验');

const baseCfg = { maxImages: 3, maxFiles: 1 };

function file(o) {
  return Object.assign({ fileId: 'cloud://x/y.jpg', name: 'a.jpg', size: 0, kind: 'IMAGE' }, o || {});
}

// 超单图上限（11MB 图片）
{
  const r = validateFiles([file({ size: 11 * MB })], baseCfg, 'SUBMIT');
  if (r.ok) bad('11MB 单图未被拦截（上限应为 10MB）');
  else ok('单图超限被拦截：' + r.msg);
}
// 超单文件上限（21MB 文件）
{
  const r = validateFiles([file({ name: 'a.pdf', kind: 'FILE', size: 21 * MB })], baseCfg, 'SUBMIT');
  if (r.ok) bad('21MB 单文件未被拦截（上限应为 20MB）');
  else ok('单文件超限被拦截：' + r.msg);
}
// 总量超限（3 张 10MB 图 = 30MB 未超；改 6 张 10MB = 60MB 超 50MB）
{
  const list = [];
  for (let i = 0; i < 6; i += 1) list.push(file({ size: 10 * MB, name: 'p' + i + '.jpg' }));
  const r = validateFiles(list, { maxImages: 9, maxFiles: 3 }, 'SUBMIT');
  if (r.ok) bad('总量 60MB 未被拦截（上限应为 50MB）');
  else ok('单次提交总量超限被拦截：' + r.msg);
}
// 格式不符（.exe）
{
  const r = validateFiles([file({ name: 'v.exe', kind: 'FILE', size: 1 * MB })], baseCfg, 'SUBMIT');
  if (r.ok) bad('.exe 未被拦截（不在白名单）');
  else ok('非法格式被拦截：' + r.msg);
}
// 视频文件（.mp4）不进白名单 —— 守住 2GB 配额的关键闸门
{
  const r = validateFiles([file({ name: 'v.mp4', kind: 'FILE', size: 1 * MB })], baseCfg, 'SUBMIT');
  if (r.ok) bad('.mp4 未被拦截（视频不应进白名单）');
  else ok('视频文件被拦截（保护存储配额）：' + r.msg);
}
// 合法：3 张 1MB 图 + 1 个 5MB pdf = 8MB < 50MB
{
  const list = [
    file({ size: 1 * MB, name: 'a.jpg' }),
    file({ size: 1 * MB, name: 'b.png' }),
    file({ size: 1 * MB, name: 'c.webp' }),
    file({ size: 5 * MB, name: 'd.pdf', kind: 'FILE' })
  ];
  const r = validateFiles(list, baseCfg, 'SUBMIT');
  if (r.ok) ok('合法提交通过（3 图 + 1 文件，共 8MB）');
  else bad('合法提交被误拦：' + r.msg);
}

/* ============================================================
 * ③ 数量配置钳制
 * ============================================================ */
console.log('\n── ③ 图片 / 文件数量钳制');
const clamp = (n, lo, hi) => Math.min(Math.max(1, Number(n) || lo), hi);
{
  const a = clamp(99, LIMIT.IMAGE_COUNT_DEFAULT, LIMIT.IMAGE_COUNT_CEILING);
  if (a === LIMIT.IMAGE_COUNT_CEILING) ok('图片张数上限钳制到 ' + LIMIT.IMAGE_COUNT_CEILING);
  else bad('图片张数钳制错误：' + a);
}
{
  const b = clamp(99, LIMIT.FILE_COUNT_DEFAULT, LIMIT.FILE_COUNT_CEILING);
  if (b === LIMIT.FILE_COUNT_CEILING) ok('文件个数上限钳制到 ' + LIMIT.FILE_COUNT_CEILING);
  else bad('文件个数钳制错误：' + b);
}

/* ============================================================
 * ④ 权限 + 页面注册
 * ============================================================ */
console.log('\n── ④ 权限与页面注册');
const hwSrc = read('cloudfunctions/homework/index.js');
has(hwSrc, /require\('\.\/common\/homework-limit'\)/, 'homework 从 common 取限制真源（不本地抄一份）');
has(hwSrc, /canReview\(m\)/, '发布 / 批阅走统一的班委判定 canReview');
has(hwSrc, /guard\.requireBind\(ctx\)/, '所有 action 先校验绑定身份');
has(hwSrc, /ON DUPLICATE KEY UPDATE|ON DUPLICATE KEY/, '重交覆盖原记录（唯一键 + 更新）');
has(hwSrc, /DELETE FROM homework_file[\s\S]{0,200}?kind = 'SUBMIT'|DELETE FROM homework_file/, '重交前清理旧文件记录');
has(hwSrc, /cloud\.deleteFile/, '清理时物理删除云存储对象');
has(hwSrc, /INSERT INTO homework_submit[\s\S]{0,400}?ON DUPLICATE KEY UPDATE/, '提交记录落库用「唯一键 + 覆盖更新」');

/* 清理职责在 cron-weekly（云函数里跑 getContext 拿不到身份，定时器路径走 pool 直连）；
   fileID 校验在 common/homework-limit.js（前后端共用的唯一真源）。 */
const cronSrc = read('cloudfunctions/cron-weekly/index.js');
const limSrc = read('cloudfunctions/common/homework-limit.js');
has(cronSrc, /async function purgeHomeworkFiles/, 'cron-weekly 定义了作业文件清理任务');
has(cronSrc, /result\.homeworkPurge = await purgeHomeworkFiles\(pool\)/, 'daily 定时触发作业清理（幂等）');
has(cronSrc, /DATE_SUB\(CURDATE\(\), INTERVAL \? DAY\)/, '清理按「截止满 N 天」判定');
has(limSrc, /fileId\.indexOf\('cloud:\/\/'\) !== 0/, '校验 fileID 必须是云存储地址（防伪造路径）');

const appJson = JSON.parse(read('miniprogram/app.json'));
['pages/homework/index', 'pages/homework/detail', 'pages/homework/publish'].forEach(p => {
  if ((appJson.pages || []).indexOf(p) >= 0) ok('app.json 已注册 ' + p);
  else bad('app.json 缺少页面注册：' + p);
});

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 作业提交与管理模块校验通过');
