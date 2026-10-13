/**
 * 页面注册表一致性体检
 * ============================================================
 * 为什么需要它（2026-10-07 两次连续踩坑）：
 *   ① 删掉 `pages/timetable-apply/` 后，开发者工具报
 *      `ENOENT ... pages/timetable-apply/index.wxml`；
 *   ② 把该目录放回磁盘但 `app.json` 不注册，又报
 *      `Framework inner error (expect FLUSH_INITIAL_CREATION and but got FLOW_CREATE_MODE)`。
 * 两者根因相同：**`miniprogram/pages/` 下的目录与 `app.json` 的 `pages[]` 不一致**，
 * 而开发者工具会扫描目录、据此拼自己的页面清单，与注册表对不上就崩。
 * 更早还撞过 `project.config.json` 的 `condition.list` 里引用了**根本不存在的**
 * `pages/poster/index` —— 选中那个编译条件就会 ENOENT。
 *
 * 所以这里锁三条：
 *   ① `app.json` 每个注册页都必须有 index.js/json/wxml/wxss 四个文件；
 *   ② `condition.list[].pathName` 指向的页面必须真实存在；
 *   ③ `pages/` 下每个目录都必须有 index.json（否则是残留空壳），
 *      并且**未注册目录要么不存在、要么文件完整**（完整才不会有 ENOENT 风险）。
 *
 * ⚠️ 「有未注册目录」本身不判失败 —— 页面下线后为了兼容开发者工具的陈旧缓存，
 *    允许保留文件；但它必须**文件完整**，否则工具一启动就报缺失。
 *    等工具重启、缓存清空后可以再删，门禁不会因此变红。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(ROOT, 'miniprogram/pages');
/** app.json 的 page 形如 `pages/home/index`，对应文件是**同级**的 `pages/home/index.js` */
const PAGE_EXTS = ['js', 'json', 'wxml', 'wxss'];
/** 页面文件绝对路径：`miniprogram/` + pagePath + '.' + ext */
const pageFile = (pagePath, ext) => path.join(ROOT, 'miniprogram', pagePath + '.' + ext);

let fail = 0;
function check(label, cond, extra) {
  if (!cond) fail++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}

/* ---------- app.json ---------- */
const appJsonPath = path.join(ROOT, 'miniprogram/app.json');
const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
const registered = appJson.pages || [];

console.log('=== ① app.json 注册页文件完整性（缺文件 = 开发者工具 ENOENT）===');
const missingFiles = [];
registered.forEach(p => {
  PAGE_EXTS.forEach(ext => {
    if (!fs.existsSync(pageFile(p, ext))) missingFiles.push(p + '.' + ext);
  });
});
check(`${registered.length} 个注册页的 js/json/wxml/wxss 全部存在`,
  missingFiles.length === 0, missingFiles.join(', ') || '无缺失');

const dup = registered.filter((p, i) => registered.indexOf(p) !== i);
check('app.json 没有重复注册的页面', dup.length === 0, [...new Set(dup)].join(', ') || '无重复');

/* ---------- pages 目录 vs 注册表 ---------- */
console.log('\n=== ② pages 目录 ↔ app.json 注册表 ===');
const dirs = fs.existsSync(PAGES_DIR)
  ? fs.readdirSync(PAGES_DIR).filter(d => fs.statSync(path.join(PAGES_DIR, d)).isDirectory())
  : [];
/* ⚠️ 2026-10-12：页面路径允许嵌套（pages/grab/index + pages/grab/admin 同目录），
 *    所以注册名取 `pages/` 后的**第一段目录名**，不再要求整段等于目录名 ——
 *    「注册页的文件都在」由上面 ① 逐文件验（任何嵌套深度都覆盖），
 *    这里只保证「注册页的顶层目录没被删」。 */
const regNames = registered.map(p => p.replace(/^pages\//, '').split('/')[0]);

const orphanDirs = dirs.filter(d => !regNames.includes(d));
const missingDirs = regNames.filter(r => !dirs.includes(r));

/** 目录里必须有 index.json，否则是残留空壳 */
const shellDirs = dirs.filter(d => !fs.existsSync(path.join(PAGES_DIR, d, 'index.json')));

check('每个注册页都有对应目录', missingDirs.length === 0, missingDirs.join(', ') || '无缺失');
check('每个 pages 目录都有 index.json（无残留空壳）', shellDirs.length === 0, shellDirs.join(', ') || '无空壳');

/* 未注册目录：文件完整才允许存在（兼容工具陈旧缓存），否则必然 ENOENT */
const brokenOrphan = orphanDirs.filter(d => PAGE_EXTS.some(ext =>
  !fs.existsSync(path.join(PAGES_DIR, d, 'index.' + ext))));
check('未注册目录要么不存在、要么文件完整（否则工具启动即 ENOENT）',
  brokenOrphan.length === 0,
  brokenOrphan.length
    ? brokenOrphan.join(', ') + ' ← 文件不全，删掉或补齐'
    : (orphanDirs.length ? '（' + orphanDirs.join(', ') + ' 为兼容陈旧缓存保留，文件完整 ✓）' : '无未注册目录'));

/* ---------- 编译条件 ---------- */
console.log('\n=== ③ project.config.json 编译条件指向的页面必须存在 ===');
const projCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
const conditions = ((projCfg.condition || {}).miniprogram || {}).list || [];
/* ⚠️ pathName 形如 `pages/home/index`（不带扩展名），对应文件是**同级**的 `pages/home/index.js`。
 *    早先两次都拼错：一次当成子目录 `pages/home/index/index.js`（全判缺失），
 *    一次直接查无扩展名的 `pages/home/index`（也判缺失）—— 判据路径拼错会伪装成「代码有问题」。 */
const brokenCond = conditions.filter(c => c.pathName && !fs.existsSync(pageFile(c.pathName, 'js')));
check(`${conditions.length} 个编译条件指向的页面都存在`,
  brokenCond.length === 0, brokenCond.map(c => c.pathName).join(', ') || '全部有效');

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);