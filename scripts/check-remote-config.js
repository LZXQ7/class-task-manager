/**
 * 门禁：前端远程配置下发（config 云函数 + remote-config 封装，2026-10-26）
 * ------------------------------------------------------------
 * 守住最容易回归的线：
 *   ① 云函数 config.get 是**公开读**（auth: null）—— 配置本就该给所有前端看，不绑身份；
 *      且真从 app_config 表读全表、返回 {k:v}。
 *   ② 前端 remote-config.js 封装存在且导出 loadRemoteConfig / getRemote，用 storage 缓存。
 *   ③ api.js 登记了 configGet（走 config 云函数的 get action）。
 *   ④ app.js 启动（onLaunch）与回前台（onShow）都拉取远程配置。
 *   ⑤ 首页消费方已迁移（2026-10-28）：静态欢迎语 homeBanner 下线，换成「作业提交播报」；
 *      远程配置机制仍在 app 层拉取，只是当前没有页面消费 homeBanner。
 *   ⑥ cloudbaserc.json 已登记 config（含 vpc，与 fee/stat/auth 同款）⇒ 部署路径正确。
 *
 * 不连生产库（与 check-homework.js 同打法，纯静态/文件级校验）；
 * 线上「真能读到 app_config」由 `tcb fn invoke config --data '{"action":"get"}'` 单独验证。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

/* ============================================================
 * ① 云函数 config.get：公开读 app_config 全表
 * ============================================================ */
console.log('── ① 云函数 config.get（公开读 app_config）');
let cfgSrc;
try { cfgSrc = read('cloudfunctions/config/index.js'); }
catch (e) { bad('cloudfunctions/config/index.js 不存在'); cfgSrc = ''; }
if (cfgSrc) {
  has(cfgSrc, /'SELECT k, v FROM '\s*\+\s*TABLE/, 'config 从 app_config 表读取 k,v（SELECT … + TABLE）');
  has(cfgSrc, /TABLE\s*=\s*'app_config'/, "config 的 TABLE 常量 = 'app_config'");
  has(cfgSrc, /auth:\s*null/, 'config.get 路由 auth: null（公开读，不绑身份）');
  has(cfgSrc, /get:\s*\{/, 'config 定义了 get action');
  has(cfgSrc, /exports\.main\s*=/, 'config 导出 main（exports.main）');
  // 返回结构：遍历 rows 拼成 {k:v} 对象，再经 ok() 包成 {errCode:0,data}
  has(cfgSrc, /items\[r\.k\]\s*=\s*decodeValue\(r\.v\)/, 'config 把每行拼成 {k:v} 返回');
}

/* ============================================================
 * ② 前端 remote-config.js 封装
 * ============================================================ */
console.log('\n── ② 前端 remote-config.js 封装');
let rcSrc;
try { rcSrc = read('miniprogram/utils/remote-config.js'); }
catch (e) { bad('miniprogram/utils/remote-config.js 不存在'); rcSrc = ''; }
if (rcSrc) {
  has(rcSrc, /module\.exports\s*=\s*\{\s*loadRemoteConfig,\s*getRemote/, '导出 loadRemoteConfig + getRemote');
  has(rcSrc, /STORAGE_KEY\s*=\s*'app\.remoteConfig'/, '用 storage 缓存（键 app.remoteConfig）');
  has(rcSrc, /api\.configGet\(\{\},\s*\{\s*toast:\s*false\s*\}\)/, 'loadRemoteConfig 调 api.configGet');
  has(rcSrc, /writeCache\(items\)/, '拉取成功后写入缓存');
}

/* ============================================================
 * ③ api.js 登记 configGet
 * ============================================================ */
console.log('\n── ③ api.js 登记 configGet');
const apiSrc = read('miniprogram/utils/api.js');
has(apiSrc, /configGet:\s*C\('config',\s*'get'\)/, "api.js 登记 configGet: C('config','get')");

/* ============================================================
 * ④ app.js 启动 / 回前台拉取
 * ============================================================ */
console.log('\n── ④ app.js 接入');
const appSrc = read('miniprogram/app.js');
has(appSrc, /require\('\.\/utils\/remote-config'\)/, 'app.js require remote-config');
has(appSrc, /function pullRemoteConfig\(\)/, 'app.js 定义 pullRemoteConfig');
has(appSrc, /pullRemoteConfig\(\)/, 'app.js 调用 pullRemoteConfig（启动 / 回前台）');
const pullCount = (appSrc.match(/pullRemoteConfig\(\)/g) || []).length;
if (pullCount >= 2) ok('pullRemoteConfig 至少两处调用（onLaunch + onShow）');
else bad('pullRemoteConfig 调用点不足（期望 ≥2，实际 ' + pullCount + '）');

/* ============================================================
 * ⑤ 首页消费方已迁移（2026-10-28）
 * ------------------------------------------------------------
 * 首页顶部原来是远程配置下发的静态欢迎语 homeBanner。用户 2026-10-28 要求把它
 * 换成「作业提交播报」，因此：
 *   · 首页**不再** require remote-config、也不再渲染 homeBanner
 *     （两条横幅叠在一起 = 一进首页两块蓝条，很难看）；
 *   · 远程配置机制**没有停用** —— app.js 仍在 onLaunch / onShow 拉取（见 ④），
 *     以后要做别的免审文案仍可用，只是当前没有页面消费 homeBanner。
 * 播报自身的完整逻辑（游标 / 不重播 / 定时器清理）由 scripts/check-home-feed.js 守。
 * ============================================================ */
console.log('\n── ⑤ 首页消费方迁移（homeBanner → 作业提交播报）');
const homeJs = read('miniprogram/pages/home/index.js');
const homeWxml = read('miniprogram/pages/home/index.wxml');
const homeWxss = read('miniprogram/pages/home/index.wxss');

if (!/require\('\.\.\/\.\.\/utils\/remote-config'\)/.test(homeJs)) {
  ok('首页已不 require remote-config（不再消费 homeBanner）');
} else {
  bad('首页仍在 require remote-config —— 静态欢迎语会与作业播报抢同一个位置，删掉');
}
if (!/\{\{homeBanner\}\}/.test(homeWxml)) {
  ok('首页 wxml 不再渲染 homeBanner（静态欢迎语已下线）');
} else {
  bad('首页 wxml 仍在渲染 homeBanner —— 那是被替换掉的静态欢迎语');
}
has(homeWxml, /class="home-feed/, '首页 wxml 有作业提交播报条 .home-feed');
has(homeJs, /api\.homeworkFeed\(/, '首页通过 api.homeworkFeed 取播报数据');
has(homeWxss, /\.home-feed\s*\{/, 'home wxss 定义 .home-feed 样式');
has(homeWxss, /\.home-feed-line\s*\{/, 'home wxss 定义 .home-feed-line 样式');

/* ============================================================
 * ⑥ cloudbaserc.json 已登记 config（部署路径）
 * ============================================================ */
console.log('\n── ⑥ cloudbaserc.json 部署登记');
let rc;
try { rc = JSON.parse(read('cloudbaserc.json')); }
catch (e) { bad('cloudbaserc.json 非合法 JSON'); rc = { functions: [] }; }
const cfgFn = (rc.functions || []).find(f => f.name === 'config');
if (!cfgFn) bad('cloudbaserc.json 未登记 config 函数');
else {
  ok('cloudbaserc.json 已登记 config 函数');
  if (cfgFn.vpc && cfgFn.vpc.vpcId) ok('config 含 vpc（' + cfgFn.vpc.vpcId + '）⇒ 可连库');
  else bad('config 缺少 vpc 配置（无法连生产库）');
  if (cfgFn.runtime === 'Nodejs18.15') ok('config runtime = Nodejs18.15');
  else bad('config runtime 异常：' + cfgFn.runtime);
}

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 远程配置下发（config 云函数 + remote-config 封装）校验通过');
