#!/usr/bin/env node
/**
 * 后台权限体系门禁（2026-11-15）
 * ============================================================
 * 挡的四类事故：
 *   ① **新加接口忘了挂权限** —— 后台从「只允许超管」放开成「按职位分页签」之后，
 *      任何一个漏挂的写接口都是**越权口**（生活委员能改班费/删成员）。
 *      这是本轮最大的回归风险，必须逐条静态扫。
 *   ② 职位模板退化成「一刀切」—— 生活委员又拿到 members，或辅导员又看到审计。
 *   ③ 前端把导航写死回 index.html —— 那样「没权限的页签不出现」就失效了。
 *   ④ 权限判断只在前端做 —— 前端过滤只是体验，安全边界必须在后端。
 *
 * 用法：node scripts/check-admin-perms.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'cloudfunctions/admin-web');
const read = (p) => fs.readFileSync(path.join(MINI, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

const PERMS = read('lib/perms.js');
const AUTH = read('lib/auth.js');
const IDX = read('index.js');
const APP = read('public/app.js');
const HTML = read('public/index.html');
const ACCOUNTS = read('lib/mod-accounts.js');

/* 真跑 perms.js：模板对不对必须由它自己的实现回答，不是靠正则猜 */
const sandbox = { module: { exports: {} }, exports: {}, console };
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
vm.runInContext(PERMS, sandbox, { filename: 'perms.js' });
const P = sandbox.module.exports;

/* ============================================================
 * ① 职位模板
 * ============================================================ */
section('① 职位模板按职责分配（不是按官大官小）');

const T = P.POSITION_PERMS;
[['辅导员'], ['班长兼团支书'], ['副班长'], ['学习委员'], ['生活委员'], ['文体委员'],
 ['组织宣传委员'], ['心理委员']].forEach(([pos]) => {
  const t = T[pos] || [];
  check(t.length > 0 && t.indexOf('overview') >= 0, '职位「' + pos + '」有模板且含概览');
});

// 用户点名：生活委员 = 排班规则 + 值日记录
const dutyPos = T['生活委员'] || [];
check(dutyPos.indexOf('rules') >= 0 && dutyPos.indexOf('duty') >= 0,
  '生活委员含「排班规则 + 值日记录」（用户点名口径）');
check(dutyPos.indexOf('fee') >= 0, '生活委员管班费（与小程序 util.feeRights 同口径）');
check(dutyPos.indexOf('members') < 0, '生活委员不管成员档案（避免与「管人」的副班长权责重叠）');

// 用户点名：辅导员 6 项
const cons = T['辅导员'] || [];
['overview', 'members', 'leave', 'fee', 'course', 'class'].forEach((k) => {
  check(cons.indexOf(k) >= 0, '辅导员含「' + k + '」（用户点名）');
});
check(cons.indexOf('accounts') < 0 && cons.indexOf('audit') < 0,
  '辅导员不含后台账号 / 操作审计（这两项是超管专属）');

/* 超管专属页签任何模板都不许出现 */
const SUPER_ONLY = P.SUPER_ONLY;
check(SUPER_ONLY.indexOf('audit') >= 0 && SUPER_ONLY.indexOf('accounts') >= 0,
  'SUPER_ONLY 含 audit + accounts');
let leak = [];
Object.keys(T).forEach((pos) => {
  SUPER_ONLY.forEach((k) => {
    if (T[pos].indexOf(k) >= 0) leak.push(pos + ':' + k);
  });
});
check(leak.length === 0, '所有职位模板都不含超管专属页签' + (leak.length ? '（泄漏：' + leak.join(',') + '）' : ''));

/* ============================================================
 * ② 权限解析：越权写入必须被过滤
 * ============================================================ */
section('② resolve()：显式授权不能抬成超管权限');

const normalMember = { is_super: 0, position: '生活委员', group_tag: 'A', role: 'ADMIN' };
check(P.resolve(normalMember, '').join(',') === (T['生活委员'] || []).join(','),
  'perms 为空 → 按职位模板实时推导（改职位即改权限，无需回填每行）');

const custom = P.resolve(normalMember, 'fee,audit,accounts,nonexistent');
check(custom.indexOf('audit') < 0 && custom.indexOf('accounts') < 0,
  '显式 perms 里写 audit/accounts 会被过滤（防自我提权）');
check(custom.indexOf('nonexistent') < 0, '非法页签名被过滤');

check(P.resolve({ is_super: 1, position: '', role: 'ADMIN' }, '').length === P.ALL_VIEWS.length,
  '超管恒为全量（不因 perms 字段被配窄）');
check(P.resolve({ is_super: 0, position: '', group_tag: 'A', role: 'MEMBER' }, '').length === 0,
  '普通成员没有任何后台权限（开通后台后降职会立刻失权）');
check(P.resolve({ is_super: 0, position: '', group_tag: 'X', role: 'ADMIN' }, '').indexOf('leave') >= 0,
  'group_tag=X 即使 position 空也按辅导员模板（历史数据有空职位）');

check(P.canSeeDemo({ is_super: 1 }) === true && P.canSeeDemo({ is_super: 0 }) === false,
  '演示班只对超管可见（辅导员的下拉里不出现假班）');

/* ============================================================
 * ③ 后端：每个 API 都必须有权限中间件
 * ============================================================ */
section('③ 后端每个接口都挂了权限（漏一个就是越权口）');

const IDX_CODE = stripJs(IDX);
const routeRe = /app\.(get|post|put|delete)\(\s*'(\/api\/[^']*)'\s*,\s*([^)]*)/g;
/* 这三个不挂权限中间件，各自的理由必须写清楚，不许再加白名单：
 *   · /api/auth/login  —— 还没登录，挂权限就永远进不来
 *   · /api/auth/logout —— 登出必须人人可用
 *   · /api/me          —— 登录态自身，要返回 perms 给前端渲染导航
 *   · GET /api/classes —— 顶部班级选择器，**每个页签都要用**（含只读页签），
 *     挂 class 权限会让生活委员连班级都选不了；数据侧已按 canSeeDemo 过滤演示班。 */
const NO_PERM_OK = ['/api/auth/login', '/api/auth/logout', '/api/me', '/api/classes'];
let routes = 0, unguarded = [];
let m;
while ((m = routeRe.exec(IDX_CODE))) {
  const method = m[1].toUpperCase();
  const p = m[2];
  // m[3] 是路由声明的**第三个参数开头**：有权限中间件时必然以 requirePerm(/requireAnyPerm( 开头。
  // 不用「往后 N 个字符里搜」——那样会把下一个路由的中间件算成这一个的（假通过）。
  const guarded = /^requirePerm\(|^requireAnyPerm\(/.test(m[3].trim());
  if (NO_PERM_OK.indexOf(p) >= 0) {
    if (guarded) unguarded.push(p + '（该接口不应挂权限中间件）');
    continue;
  }
  routes++;
  if (!guarded) unguarded.push(method + ' ' + p);
}
check(routes >= 20, '扫到 ' + routes + ' 个需要鉴权的接口（预期 ≥20，太少说明正则失配）');
check(unguarded.length === 0, '所有业务接口都挂了 requirePerm/requireAnyPerm' +
  (unguarded.length ? '（漏：' + unguarded.join(' / ') + '）' : ''));

check(/function requirePerm\(/.test(IDX) && /function requireAnyPerm\(/.test(IDX),
  'requirePerm 与 requireAnyPerm 都实现了');
check(/perms\.has\(s\.perms, key\)/.test(IDX), '权限判定走 lib/perms.js 的 has()（单一真源）');
check(/res\.status\(403\)/.test(IDX), '无权限返回 403（不是 404/401，前端才能区分）');

/* 权限真源必须每次请求重算，不能缓存在会话里 */
check(/permsMod\.resolve\(m, row\.perms\)/.test(AUTH),
  '每次请求都按 member + perms 重算权限（降职/停用立刻生效）');
check(/if \(!perms\.length\) return null/.test(AUTH),
  '权限被收回后会话直接失效（不是等 12 小时过期）');

/* 开通/改权限要吊销会话 */
check(/DELETE FROM admin_session WHERE admin_id = \?/.test(ACCOUNTS),
  '开通/改权限/停用后吊销该账号所有会话');
check(/hashPassword\(pwd\)/.test(ACCOUNTS) && !/detail:\s*\{[^}]*password:\s*pwd/.test(ACCOUNTS),
  '初始密码只存哈希，明文不进审计表');
check(/不能停用自己的账号|不能删除自己的账号/.test(ACCOUNTS) && /最后一个超管账号/.test(ACCOUNTS),
  '禁止自锁：不能停用/删除自己，也不能删最后一个超管');

/* ============================================================
 * ④ 前端：导航按权限动态渲染
 * ============================================================ */
section('④ 前端导航动态渲染（写死就会漏出没权限的页签）');

check(/function renderNav\(/.test(APP), 'app.js 有 renderNav()');
check(/state\.perms\.indexOf\(VIEWS\[k\]\.perm\) >= 0/.test(APP),
  'allowedViews() 按 VIEWS[k].perm 过滤');
check(/perms: me\.perms \|\| \[\]/.test(APP) || /state\.perms = me\.perms \|\| \[\]/.test(APP),
  'showMain 写入 state.perms');
// index.html 的 nav 里不许再有写死的 nav-item
const navBlock = (HTML.match(/<nav[^>]*id="nav"[^>]*>([\s\S]*?)<\/nav>/) || [])[1] || '';
check(!/class="nav-item"/.test(navBlock), 'index.html 的 nav 里没有写死的 nav-item（由 JS 全量重绘）');
check(!/VIEWS\[view\]\.render\(host\)/.test(stripJs(APP)) || /if \(!canView\(view\)\)/.test(APP),
  'go() 有前端权限守卫（localStorage 里的旧 view 不会硬渲染）');

const viewKeys = (APP.match(/^\s{4}(\w+):\s*\{\s*title:/gm) || []).length;
check(viewKeys >= 14, 'VIEWS 注册了 ' + viewKeys + ' 个视图（预期 ≥14）');
['renderDuty', 'renderSwap', 'renderCountdown', 'renderAccount'].forEach((fn) => {
  check(new RegExp('function ' + fn + '\\(').test(APP), '前端有 ' + fn);
});

/* ============================================================
 * ⑤ 变异自证
 * ============================================================ */
section('⑤ 变异自证（改坏 → 判据必须翻红）');

// 5.1 给生活委员偷偷加 members
const T2src = PERMS.replace(
  "'生活委员': ['overview', 'fee', 'duty', 'rules', 'swap'],",
  "'生活委员': ['overview', 'members', 'fee', 'duty', 'rules', 'swap'],"
);
const sb2 = { module: { exports: {} }, exports: {}, console };
sb2.exports = sb2.module.exports;
vm.createContext(sb2);
vm.runInContext(T2src, sb2, { filename: 'perms-mut.js' });
const P2 = sb2.module.exports;
check(P2.POSITION_PERMS['生活委员'].indexOf('members') >= 0 &&
  (P.POSITION_PERMS['生活委员'].indexOf('members') < 0),
  '变异被抓：生活委员加了 members → 模板判据会翻红');

// 5.2 把超管专属从 SUPER_ONLY 拿掉 → resolve 不再过滤，下面这条必须红
const P3src = PERMS.replace("const SUPER_ONLY = ['audit', 'accounts'];", 'const SUPER_ONLY = [];');
const sb3 = { module: { exports: {} }, exports: {}, console };
sb3.exports = sb3.module.exports;
vm.createContext(sb3);
vm.runInContext(P3src, sb3, { filename: 'perms-mut2.js' });
const P3 = sb3.module.exports;
check(P3.resolve(normalMember, 'audit,accounts').indexOf('audit') >= 0,
  '变异被抓：SUPER_ONLY 清空 → 越权页签不再被过滤');

// 5.3 删掉一个接口的权限中间件 → 路由判据必须翻红
const mutatedIdx = IDX_CODE.replace(
  "app.get('/api/fee', requirePerm('fee'), (req, res) => handle(res, () =>",
  "app.get('/api/fee', (req, res) => handle(res, () =>"
);
function scanUnguarded(code) {
  const re = /app\.(get|post|put|delete)\(\s*'(\/api\/[^']*)'\s*,\s*([^)]*)/g;
  const bad = [];
  let mm;
  while ((mm = re.exec(code))) {
    const p = mm[2];
    if (NO_PERM_OK.indexOf(p) >= 0) continue;
    // 与主判据同一套逻辑：只看第三个参数开头
    if (!/^requirePerm\(|^requireAnyPerm\(/.test(mm[3].trim())) bad.push(p);
  }
  return bad;
}
check(scanUnguarded(mutatedIdx).indexOf('/api/fee') >= 0,
  '变异被抓：摘掉 /api/fee 的 requirePerm → 判据点名（实测 ' + JSON.stringify(scanUnguarded(mutatedIdx)) + '）');

// 5.4 导航写死回 HTML → 判据翻红
const htmlMut = HTML.replace('</nav>', '<button class="nav-item" data-view="fee">班费</button></nav>');
const navBlockMut = (htmlMut.match(/<nav[^>]*id="nav"[^>]*>([\s\S]*?)<\/nav>/) || [])[1] || '';
check(/class="nav-item"/.test(navBlockMut), '变异被抓：把导航写死回 index.html → 判据翻红');

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n── 汇总');
console.log(fail ? '结果：失败 ' + fail + ' 项 / 通过 ' + pass + ' 项' : '结果：全部通过（' + pass + ' 项）');
process.exit(fail ? 1 : 0);
