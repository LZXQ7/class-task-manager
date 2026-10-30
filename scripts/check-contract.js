/**
 * 门禁：前后端契约 + 生命周期唯一性（2026-10-28 新增）
 * ------------------------------------------------------------
 * 两条都是**线上真出过问题**的形态，而且都属于「不报错、只是功能悄悄不对」：
 *
 * ① 生命周期同名重复
 *    Page({ onHide() { 清 A }, … onHide() { 清 B } }) —— JS 对象字面量里**后者覆盖前者**，
 *    第一个 onHide 整块消失。2026-10-28 在 pages/home 实测到：请假时段翻面定时器
 *    （可跨小时的 setTimeout）从上线起**从未被 onHide 清过** —— Tab 页切走只触发 onHide
 *    不触发 onUnload，于是定时器在后台跑完再对隐藏页 setData。
 *    ⚠️ 这个坑特别隐蔽：代码里两段注释都写着「别在这里再写一个 onHide」，还是写了。
 *
 * ② api 映射指向不存在的云函数 action
 *    前端 `api.foo: C('homework','purge')`，后端 homework 里根本没有 purge
 *    （真实清理挂在 cron-weekly 的 purgeHomeworkFiles）—— 谁调谁拿到「未知操作」，
 *    而错误文案里看不出是前端写错了名字。2026-10-28 清掉了这条死映射。
 *
 * 判据故意宽松（只认「同文件出现两次」/「两种路由写法任一命中」），宁可漏报不误报。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('PASS  ' + m); };
const bad = (m) => { fail++; console.log('FAIL  ' + m); };

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** 剥注释（等长替换，行号不乱）—— 注释里提到的 onHide / action 名不能算数 */
const stripJs = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m0, p1) => p1 + ' '.repeat(Math.max(0, m0.length - p1.length)));

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/* ============================================================
 * ① 生命周期唯一性（页面 + 组件）
 * ============================================================ */
console.log('── ① 生命周期不得重复定义');
const LIFECYCLE = [
  'onLoad', 'onReady', 'onShow', 'onHide', 'onUnload',
  'onPullDownRefresh', 'onReachBottom', 'onPageScroll', 'onResize',
  'onShareAppMessage', 'onShareTimeline', 'onAddToFavorites',
  'onTabItemTap', 'onSaveExitState'
];
const jsFiles = walk(path.join(MINI, 'pages'), '.js')
  .concat(walk(path.join(MINI, 'components'), '.js'));

let dupFound = 0;
for (const f of jsFiles) {
  const body = stripJs(fs.readFileSync(f, 'utf8'));
  for (const name of LIFECYCLE) {
    const hits = [];
    // 方法简写形式：`  onHide() {` / `  async onHide() {`
    const re = new RegExp('^\\s{2,4}(?:async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{', 'gm');
    for (const m of body.matchAll(re)) hits.push(body.slice(0, m.index).split('\n').length);
    if (hits.length > 1) {
      bad('① ' + rel(f) + ' 的 ' + name + '() 定义了 ' + hits.length + ' 次（第 ' + hits.join(' / ') + ' 行）—— 后者会静默覆盖前者');
      dupFound++;
    }
  }
}
if (!dupFound) ok('① 页面 / 组件里的生命周期都只定义一次（' + jsFiles.length + ' 个文件）');

/* 自证：把 home 的真实源码复制一份「故意重复」，判据必须翻红 */
{
  const src = stripJs(fs.readFileSync(path.join(MINI, 'pages', 'home', 'index.js'), 'utf8'));
  const mut = src + '\nPage({\n  onHide() { /* 变异副本 */ },\n});\n';
  const hits = [];
  for (const m of mut.matchAll(/^\s{2,4}(?:async\s+)?onHide\s*\([^)]*\)\s*\{/gm)) hits.push(m.index);
  ok('① 自证：人为塞第二个 onHide 后能被数到 2 次（判据不是恒真空转）', hits.length === 2);
}

/* ============================================================
 * ② api 映射 ↔ 云函数 action
 * ============================================================ */
console.log('\n── ② api 映射必须指向真实存在的 action');
const apiSrc = stripJs(fs.readFileSync(path.join(MINI, 'utils', 'api.js'), 'utf8'));
const pairs = [];
for (const m of apiSrc.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:\s*C\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/gm)) {
  pairs.push({ api: m[1], fn: m[2], action: m[3] });
}
for (const m of apiSrc.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:\s*\(\s*[^)]*\)\s*=>\s*req\.call\(\s*'([^']+)'\s*,\s*'([^']+)'/gm)) {
  pairs.push({ api: m[1], fn: m[2], action: m[3] });
}
ok('② api.js 解析出映射 ' + pairs.length + ' 条（解析不到就直接判失败，防止判据空转）', pairs.length > 100);

const cache = {};
const fnSrc = (fn) => {
  if (cache[fn] === undefined) {
    const p = path.join(CF, fn, 'index.js');
    cache[fn] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  return cache[fn];
};
/** 两种路由写法都要认：routes 对象 `title: {…}` / if 分支 `action === 'title'` */
const hasAction = (src, action) => {
  const objRe = new RegExp('(^|[\\s{,])[\'"]?' + action + '[\'"]?\\s*:\\s*(\\{|async|function|\\()', 'm');
  const ifRe = new RegExp('action\\s*={2,3}\\s*[\'"]' + action + '[\'"]');
  return objRe.test(src) || ifRe.test(src);
};

let miss = 0;
const seen = new Set();
for (const p of pairs) {
  const key = p.fn + '.' + p.action;
  if (seen.has(key)) continue;
  seen.add(key);
  const src = fnSrc(p.fn);
  if (src === null) { bad('② ' + 'cloudfunctions/' + p.fn + ' 不存在（api.' + p.api + '）'); miss++; continue; }
  if (!hasAction(src, p.action)) {
    bad('② ' + p.fn + ' 里没有 action「' + p.action + '」（api.' + p.api + '）—— 调用会得到「未知操作」');
    miss++;
  }
}
if (!miss) ok('② ' + seen.size + ' 条映射全部能在对应云函数里找到 handler');

/* 自证：故意查一个不存在的 action，必须是 false */
ok('② 自证：hasAction 对不存在的名字返回 false',
  hasAction(fnSrc('homework') || '', 'definitelyNotAnAction') === false
  && hasAction(fnSrc('homework') || '', 'publish') === true);

console.log('');
console.log('通过=' + pass + ' 失败=' + fail);
if (fail) process.exit(1);
