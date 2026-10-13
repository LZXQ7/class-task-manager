#!/usr/bin/env node
/**
 * 门禁 76 · 后台静态资源与 API 路径前缀（gatewayPath 前缀丢失）
 * ======================================================
 * 钉死 2026-10-10 线上事故：
 *   gatewayPath="/admin" ⇒ 网关**只转发 /admin 前缀**（实测 /admin/api/me=401，
 *   而 /api/me=404）。index.html 当时写 /app.js、/admin.css ⇒ 两个资源全 404
 *   ⇒ app.js 没加载 ⇒ #login-form 的 submit 监听器没绑上
 *   ⇒ 点「登录」退化成浏览器原生表单 GET 提交，页面刷新无提示（= 用户说的「点了没反应」），
 *     且**口令被拼进 URL** 落进浏览器历史。
 *   而当时 43 项 e2e 全绿 —— 因为 e2e 跑 http://127.0.0.1/ **根路径**，
 *   测的根本不是线上这套路径形态。这条门禁的判据据此设计。
 *
 * 三类判据：
 *   A. index.html 里不许出现根路径资源引用（/app.js、/admin.css 这类不带 /admin 的）
 *   B. app.js 的 API_BASE 必须存在且**从 location 运行时推导**（不许写死常量）
 *   C. 变异自证：把前缀改回根路径，判据必须转红
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin-web/public/index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin-web/public/app.js'), 'utf8');
// gatewayPath 的真源是 cloudbaserc.json（config.json 里没有这个字段）——
// ⚠️ 判据必须从真源读，写死 '/admin' 会让改前缀时门禁静默失效。
const RC = JSON.parse(fs.readFileSync(path.join(ROOT, 'cloudbaserc.json'), 'utf8'));
const CFG = RC.functions.find(f => f.name === 'admin-web');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
function section(t) { console.log('\n[' + t + ']'); }

const GW = CFG.gatewayPath; // '/admin'
const GW_TAIL = String(GW || '').replace(/\/$/, ''); // '/admin'
section('A · index.html 静态资源必须带 ' + GW + ' 前缀');
// ⚠️ 判据自身踩过的两个坑（别再犯，都是"静默假通过/误报"）：
//    ① 期望值不能拼成 GW_TAIL + '/' + r —— r 本身已带 /admin 时会得到 /admin/admin/app.js，
//       把正确写法判成错。正确判据是「r 必须以 GW_TAIL + '/' 开头」。
//    ② 必须先**剥 HTML 注释**，否则注释里举例的 "/app.js" 被当成真资源引用。
function stripHtmlComments(s) { return s.replace(/<!--[\s\S]*?-->/g, ''); }
const HTML_LIVE = stripHtmlComments(HTML);
const refs = [];
const re = /(?:href|src)\s*=\s*"([^"]+)"/g;
let m;
while ((m = re.exec(HTML_LIVE)) !== null) refs.push(m[1]);
const localRefs = refs.filter(r => !/^(https?:)?\/\//.test(r));
ok('cloudbaserc.json 里 admin-web 声明了 gatewayPath', !!GW, '找不到 gatewayPath，前缀判据无从谈起');
ok('index.html 存在本地资源引用（夹具自检）', localRefs.length >= 2, '实际 ' + localRefs.length + ' 个: ' + localRefs.join(','));
localRefs.forEach(r => {
  if (/^data:/.test(r)) return;
  // 必须以 /admin/ 开头；根路径 /app.js 与相对路径 app.js 都要判红。
  ok('资源带 ' + GW + ' 前缀：' + r, r.indexOf(GW_TAIL + '/') === 0);
});

/* ---------- B. API_BASE 运行时推导 ---------- */
section('B · app.js 的 API_BASE 必须从 location 运行时推导');
const declMatch = APP.match(/var\s+API_BASE\s*=\s*([^;]+);/);
ok('app.js 声明了 API_BASE', !!declMatch, '未找到 `var API_BASE = ...`');
if (declMatch) {
  const expr = declMatch[1];
  ok('API_BASE 引用了 location（运行时推导，不许写死）', /location\.pathname/.test(expr), '实际: ' + expr.trim());
  ok('API_BASE 对 ' + GW + ' 前缀做了判断', expr.indexOf(GW_TAIL) !== -1, '实际: ' + expr.trim());
  // 写死成字符串常量 = 线上能用但本地 e2e 全挂（曾经正是这个盲区）
  ok('API_BASE 不是写死的字符串常量', !/^['"]/.test(expr.trim()), '写死会让本地 43 项 e2e 全红');
}
ok('fetch 走了 API_BASE 前缀拼接', /fetch\(\s*API_BASE\s*\+\s*pathname/.test(APP));
ok('业务调用仍写 /api/xxx（读起来与后端路由一致）', APP.indexOf("api('/api/") !== -1);

/* ---------- C. e2e 必须走 /admin 而非根路径 ---------- */
section('C · e2e 必须从 /admin 进入（与线上路径形态一致）');
const e2e = fs.readFileSync(path.join(ROOT, 'scripts/verify-admin-web.js'), 'utf8');
const baseMatch = e2e.match(/const\s+BASE\s*=\s*([^;]+);/);
ok('e2e 有 BASE 常量', !!baseMatch);
if (baseMatch) {
  ok('e2e BASE 末尾是 ' + GW, baseMatch[1].indexOf("'" + GW + "'") !== -1, '实际: ' + baseMatch[1].trim());
}
ok('e2e 不再用 BASE + / 根路径 goto', e2e.indexOf("BASE + '/'") === -1);

/* ---------- D. index.js 服务端侧的两条配套 ---------- */
section('D · index.js：资源 404 必须原样 404 + API 前缀归一化');
// 这两条是事故的**第二层根因**：页面写对了 /admin/app.js 后，
//   ① express.static 挂根 ⇒ /admin/app.js 找不到 ⇒ 落到 SPA 兜底被当 JS 返回 HTML
//      ⇒ 浏览器报 Unexpected token '<' ⇒ app.js 一行没执行（本地当场抓到过这个报错）
//   ② 本地没有网关剥前缀 ⇒ /admin/api/* 打不到路由（本地 404）
// 只修前端不同步修这两处，会从「线上挂」变成「本地挂」，等于把 bug 挪了个位置。
const IDX = fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin-web/index.js'), 'utf8');
ok('静态资源挂到 ' + GW + ' 前缀', IDX.indexOf("app.use('" + GW_TAIL + "', express.static") !== -1);
// ⚠️ 判据写法提醒：这里刻意用**字符串包含**而不是正则。
//    正则要同时匹配 `/\.[a-z0-9]+$/i` 这种含反斜杠的源码文本，
//    转义层级一多就容易把「看起来对」写成「语义相反」的假判据（本轮就踩了一次 SyntaxError）。
ok('SPA 兜底排除带扩展名的资源（否则 HTML 被当 JS/CSS 返回）',
  IDX.indexOf('return next()') !== -1 && IDX.indexOf('\\.[a-z0-9]') !== -1);
// ⚠️ 判据写法提醒（两条，都是这轮踩的）：
//  ① 判据用**字符串包含**而不是正则：要匹配的源码里含 `/\.[a-z0-9]+$/i` 这种
//     带反斜杠的文本，转义层级一多就写成语义相反的假判据（本轮踩到 SyntaxError）。
//  ② 读源码字面量时**必须照抄源码里的转义形态**：index.js 里是**正则字面量**
//     `/^\/admin(?=\/api\/)/`，所以源码文本是 `(?=\/api\/)` —— 正则字面体内
//     斜杠必须转义。判据若写 `(?=/api/)` 永远匹配不上，会造成「门禁常红」假象。
ok('存在 API 前缀归一化中间件', IDX.indexOf('req.url = req.url.replace') !== -1);
ok('归一化只作用于 /api 段（不能整条剥前缀）',
  IDX.indexOf(String.raw`(?=\/api\/)`) !== -1 || IDX.indexOf('(?=/api/)') !== -1);

/* ---------- E. 变异自证 ---------- */
section('E · 变异自证（判据必须能抓回退）');
function apiBaseExpr(src) {
  const r = src.match(/var\s+API_BASE\s*=\s*([^;]+);/);
  return r ? r[1].trim() : null;
}
const origExpr = apiBaseExpr(APP);
// 变异 1：写死成 '/admin'（本地 e2e 会挂，线上能用 —— 曾经正是这个盲区）
const mut1 = APP.replace(/var\s+API_BASE\s*=\s*[^;]+;/, "var API_BASE = '/admin';");
ok('变异1 真的落地了', mut1 !== APP);
ok('变异1 被「不许写死常量」抓住', apiBaseExpr(mut1) !== null && /^['"]/.test(apiBaseExpr(mut1)));
ok('变异1 被「必须引用 location」抓住', !/location\.pathname/.test(apiBaseExpr(mut1)));
// 变异 2：把 location 判断去掉，等价于线上路径丢失
const mut2 = APP.replace(/var\s+API_BASE\s*=\s*[^;]+;/, "var API_BASE = '';");
ok('变异2 真的落地了', mut2 !== APP);
ok('变异2 被「必须引用 location」抓住', !/location\.pathname/.test(apiBaseExpr(mut2)));
ok('变异2 被「必须判断 /admin 前缀」抓住', apiBaseExpr(mut2).indexOf(GW_TAIL) === -1);
// 变异 3：HTML 资源改回根路径（= 事故原始状态）
const mutHtml = HTML_LIVE.replace(/href="\/admin\/admin\.css"/, 'href="/admin.css"');
ok('变异3 真的落地了', mutHtml !== HTML);
const mutRefs = [];
const re3 = /(?:href|src)\s*=\s*"([^"]+)"/g;
let m3;
while ((m3 = re3.exec(mutHtml)) !== null) mutRefs.push(m3[1]);
const bad = mutRefs.filter(r => !/^(https?:)?\/\//.test(r) && r.indexOf(GW_TAIL + '/') !== 0);
ok('变异3 被「资源须带前缀」抓住（' + bad.join(',') + '）', bad.length > 0);
// 变异 4：服务端删掉 /admin 前缀的 static 挂载
const mutIdx1 = IDX.replace("app.use('" + GW_TAIL + "', express.static", "app.use('/__gone', express.static");
ok('变异4 真的落地了', mutIdx1 !== IDX);
ok('变异4 被「静态挂 /admin」抓住', mutIdx1.indexOf("app.use('" + GW_TAIL + "', express.static") === -1);
// 变异 5：SPA 兜底不再排除扩展名（把 HTML 当 JS 返回 = 本地抓到的真凶）
const mutIdx2 = IDX.replace('return next()', '/* 去掉 */');
ok('变异5 真的落地了', mutIdx2 !== IDX);
ok('变异5 被「兜底排除资源」抓住', mutIdx2.indexOf('return next()') === -1);
// 变异 6：归一化整条剥前缀（会把 /admin/app.js 变成 /app.js 而错落兜底）
const mutIdx3 = IDX.replace(String.raw`(?=\/api\/)`, '');
ok('变异6 真的落地了', mutIdx3 !== IDX);
ok('变异6 被「归一化只限 /api」抓住',
  mutIdx3.indexOf(String.raw`(?=\/api\/)`) === -1 && mutIdx3.indexOf('(?=/api/)') === -1);

console.log('\n======================================');
if (fails.length) {
  console.log('门禁76 失败：通过=' + pass + ' 失败=' + fails.length);
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('门禁76 通过=' + pass + ' 失败=0');
console.log('全绿');
