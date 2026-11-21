/**
 * 页内重取守门（2026-11-16 · 体验规范 L4/L6）
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景：切「全部成员 / 仅班委 / A 组 / B 组」「每页条数」「搜索」「翻页」
 *   原本走 reload() = go(state.view)，而 go() 每次都把 #view 整个换成 loading
 *   spinner 再重播卡片入场 + 数字滚动 ⇒ 用户觉得「切一次筛选整页刷新一次」。
 *
 * 修复：新增 softReload() —— 保留旧内容、不清空、不重播 stagger，只在容器顶部
 *   挂 2px 进度条（.is-refreshing），写完内容自动收起，且恢复滚动位置。
 *
 * 本门禁锁住三件事，防止回退：
 *   ① softReload() 必须存在，且**不**含「清空 #view 为 loading」与「staggerWhenFilled」
 *      （否则它和 reload() 没区别，等于没修）。
 *   ② 用户高频的页内重取入口必须走 softReload()：
 *      成员 scope / 每页条数 / 搜索 / 成员+审计分页 / 课程表分组 / 使用统计范围与对比。
 *   ③ 切班（sel.onchange）仍必须走完整 reload() —— 那是数据范围整体切换，
 *      且被 check-admin-web 锁定，不能被误改成 softReload。
 *   ④ 变异自证：把任一入口改回 reload()、或让 softReload 清空容器，都必须翻红。
 *
 * 退出码：0 = 通过；1 = 有回归或自证失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'cloudfunctions/admin-web/public/app.js');
const CSS = path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css');
const SRC = fs.readFileSync(APP, 'utf8');
const CSSRC = fs.readFileSync(CSS, 'utf8');

let bad = 0;
function check(ok, msg) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) bad++;
}
/** 取函数体（从 function 名到下一个顶层 function 之前，够用即可） */
function bodyOf(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) return '';
  const j = SRC.indexOf('\n  function ', i + 10);
  return SRC.slice(i, j < 0 ? i + 3000 : j);
}

console.log('\n── ① softReload 机制本体');
const soft = bodyOf('softReload');
check(!!soft, '存在 softReload() 函数');
check(/VIEWS\[state\.view\]\.render\(host\)/.test(soft),
  'softReload 只重新执行当前视图 render（不清空容器）');
check(!/innerHTML\s*=/.test(soft),
  'softReload 内不写 host.innerHTML=loading（与 reload 的关键区别）');
check(!/staggerWhenFilled|countUpStats/.test(soft),
  'softReload 不重播入场动画 / 数字滚动');
check(/classList\.add\('is-refreshing'\)/.test(soft) && /classList\.remove\('is-refreshing'\)/.test(soft),
  'softReload 加/移除进度条 class（加载有指示，L4）');
check(/host\.scrollTop/.test(soft), 'softReload 保存并恢复滚动位置（L4 不丢滚动）');

console.log('\n── ② 页内重取入口都走 softReload');
const entries = [
  [/b\.onclick = function \(\) \{ state\.group = b\.dataset\.group; softReload\(\); \}/, '课程表分组切换'],
  [/function \(p\) \{ state\.memberPage = p; softReload\(\); \}/, '成员分页'],
  [/function \(p\) \{ state\.auditPage = p; softReload\(\); \}/, '审计分页'],
  [/state\.memberKw = kw\.value\.trim\(\);[\s\S]{0,80}softReload\(\);/, '成员搜索'],
  [/state\.memberScope = b\.dataset\.scope;[\s\S]{0,500}softReload\(\);/, '成员 scope 筛选'],
  [/state\.memberPageSize = Number\(this\.value\);[\s\S]{0,60}softReload\(\);/, '每页条数'],
  [/state\.usageDays = Number\(b\.dataset\.rg\);[\s\S]{0,80}softReload\(\);/, '使用统计时间范围'],
  [/state\.usageScope = b\.dataset\.ua;[\s\S]{0,80}softReload\(\);/, '使用统计班级范围'],
  [/state\.cmpOn = b\.dataset\.cmp === '1';[\s\S]{0,200}softReload\(\);/, '对比开关'],
  [/if \(state\.view === 'member'\) \{ state\.memberPage = Number\(b\.dataset\.pg\); softReload\(\); \}/, '全局分页代理-成员'],
  [/else if \(state\.view === 'audit'\) \{ state\.auditPage = Number\(b\.dataset\.pg\); softReload\(\); \}/, '全局分页代理-审计']
];
entries.forEach(([re, label]) => check(re.test(SRC), label + ' 走 softReload'));

console.log('\n── ③ 切班仍走完整 reload（数据范围整体切换）');
const sel = /sel\.onchange = function \(\) \{([\s\S]*?)\n    \};/.exec(SRC);
check(!!sel && /reload\(\)/.test(sel[1]) && !/softReload\(\)/.test(sel[1]),
  '切班 onchange 仍是 reload()（未误改）');

console.log('\n── ④ CSS 进度条与降级');
check(/\.view\.is-refreshing::before/.test(CSSRC), '存在 .view.is-refreshing::before 进度条');
check(/@keyframes refresh-bar/.test(CSSRC), '存在进度条动画关键帧');
const infLines = [...CSSRC.matchAll(/animation:\s*([^;]*infinite[^;]*)/g)].map((m) => m[1]);
check(infLines.filter((a) => !/boot-spin/.test(a)).length === 0, '进度条未用 infinite 动画（风格门禁口径）');

console.log('\n── ⑤ 变异自证');
/* 变异 A：把成员 scope 入口改回 reload() ⇒ 判据②必须翻红 */
const mutA = SRC.replace(
  /state\.memberScope = b\.dataset\.scope;[\s\S]{0,500}?softReload\(\);/,
  (m) => m.replace('softReload();', 'reload();')
);
check(mutA !== SRC && !/state\.memberScope = b\.dataset\.scope;[\s\S]{0,500}softReload\(\);/.test(mutA),
  '变异 A：scope 入口改回 reload() 后判据②翻红');
/* 变异 B：给 softReload 注入清空容器的 loading ⇒ 判据①必须翻红 */
const softStart = mutA.indexOf('function softReload(');
const mutB = mutA.slice(0, softStart) + mutA.slice(softStart).replace(
  /var top = host\.scrollTop;/,
  "host.innerHTML = '<div class=\"loading\">加载中…</div>';\n    var top = host.scrollTop;"
);
const mutBSoft = mutB.slice(mutB.indexOf('function softReload('), mutB.indexOf('function softReload(') + 3000);
check(mutB !== mutA && /innerHTML\s*=/.test(mutBSoft), '变异 B：softReload 注入清空容器后判据①翻红');

console.log('\n' + (bad === 0
  ? '✓ 页内重取机制完整；变异自证 2/2 通过'
  : '✗ 失败 ' + bad + ' 项'));
process.exit(bad === 0 ? 0 : 1);
