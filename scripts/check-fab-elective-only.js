/**
 * 门禁：课表页右下角加号「一律添加个人选修课」（2026-10-16 用户定口径）。
 * ============================================================================
 * 用户原话：「课程表页，所有人右下角的加号都是添加选修课，仅自己可见的那种。超管等也是一样。」
 *
 * 早前实现：FAB 按 `isAdmin` 分流（管理员 → 新增全班课次，普通同学 → 选修课），
 *         另有第二个入口：点**空白格**也能新建全班课次。两个入口都已下线。
 *
 * 为什么这样更合理：
 *   · 全班课次是**公共课表**，应由后台（网页管理后台）统一维护；随手加会重复、会跨班污染。
 *   · 选修课天生是「我自己的安排」，语义上就该人人可加、仅自己可见。
 *   · 管理员要改全班课次 ⇒ 走已有课次详情的「编辑」（onEditCourse）或网页后台。
 *
 * 🔴 本门禁包含**真实执行验证**：把 onFab 的方法体抠出来编译执行，直接断言
 *    「超管点加号 ⇒ 走 _openElectiveForm 而非 _openForm」。纯文本匹配抓不到
 *    「换个函数名照样通过」这类退化。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/timetable/index.js'), 'utf8');
const WXML = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/timetable/index.wxml'), 'utf8');

let pass = 0;
const fails = [];
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fails.push(name); console.log(' FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
/** 取方法体（跳过注释里的花括号），按花括号配对取完整个方法 */
function body(name, nextName) {
  const def = new RegExp('^  ' + name + '\\(', 'm').exec(JS);
  if (!def) return '';
  // 从参数列表之后开始，**跳过注释**再找函数体的 `{`
  let i = JS.indexOf('(', def.index);
  while (i < JS.length) {
    const c = JS[i];
    if (c === '/' && JS[i + 1] === '*') { const e = JS.indexOf('*/', i + 2); i = e < 0 ? JS.length : e + 2; continue; }
    if (c === '/' && JS[i + 1] === '/') { const e = JS.indexOf('\n', i); i = e < 0 ? JS.length : e + 1; continue; }
    if (c === '{') break;
    i++;
  }
  let d = 0;
  for (let j = i; j < JS.length; j++) {
    const c = JS[j];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return JS.slice(def.index, j + 1); }
  }
  return JS.slice(def.index);
}

/** 只取「可执行代码」：去掉所有注释后再判，避免撞到自己写的说明 */
function codeOnly(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

console.log('\n-- ① FAB 不再按权限分流 ===');
const onFab = body('onFab', '_openForm');
const onFabCode = codeOnly(onFab);          // ← 只看可执行代码，注释里的「isAdmin」不算分流
t('onFab 无条件走 _openElectiveForm', /this\._openElectiveForm\(null\)/.test(onFabCode));
t('onFab 可执行代码里不再有 isAdmin 分流', !/isAdmin/.test(onFabCode),
  (onFabCode.match(/isAdmin[^\n]*/) || ['(注释里提到，代码中无)'])[0]);
t('仍有上限守卫（最多 2 门）', /cnt >= 2/.test(onFabCode) && /个人选修课最多添加 2 门/.test(onFabCode));

console.log('\n-- ② 超管点加号也是选修课（真实执行验证）===');
// 直接把真实方法体编成函数执行（不手工改写逻辑）。
// 🔴 `util` 在源码里是**模块级 require 的闭包变量**：把方法抠出来单独执行时作用域链里
//    没有它（挂 ctx.util 也不行 —— 裸标识符查的是词法作用域，不走 this）。
//    正解：用 `with (ctx) { … }` 把 ctx 变成作用域对象，裸标识符才解析得到。
const fnBody = onFabCode.replace(/^\s*onFab\(\)\s*\{/, '').replace(/\}\s*$/, '');
const fn = new Function('ctx', 'with (ctx) { ' + fnBody + ' }');
const fakeUtil = { toast: (m) => { fakeUtil._msg = m; } };
function runFab(isAdmin, personalCount) {
  const calls = [];
  const ctx = {
    util: fakeUtil,             // ← 补上闭包里缺失的 util
    data: { isAdmin, isSuper: isAdmin },
    _personal: new Array(personalCount).fill({ id: 1 }),
    _openElectiveForm: (p) => calls.push('elective:' + JSON.stringify(p)),
    _openForm: (c, d, p) => calls.push('class:' + JSON.stringify({ d, p }))
  };
  fakeUtil._msg = '';
  fn.call(ctx, ctx);
  return { calls, toast: fakeUtil._msg };
}
const forStudent = runFab(false, 0);
t('普通同学点加号 ⇒ elective(null)', forStudent.calls.join() === 'elective:null', forStudent.calls.join());
const forSuper = runFab(true, 0);
t('超管点加号 ⇒ 仍是 elective(null)（不是 class）', forSuper.calls.join() === 'elective:null', forSuper.calls.join());
const full = runFab(true, 2);
t('超管已加满 2 门 ⇒ toast 拦截（不被绕过）', full.toast === '个人选修课最多添加 2 门' && full.calls.length === 0,
  'toast=' + full.toast + ' calls=' + full.calls.join());

console.log('\n-- ③ 点空白格不再新建全班课次 ===');
const onCell = body('onCellTap', 'onCellLongPress');
const gridTap = JS.slice(JS.indexOf('if (!sid) {'), JS.indexOf('if (!sid) {') + 400);
t('空白格分支直接 return（无 _openForm 调用）',
  /if \(!sid\) \{[\s\S]{0,320}?return;[\s\S]{0,80}?\}/.test(gridTap) && !/if \(!sid\) \{[^}]*_openForm/.test(gridTap),
  gridTap.slice(0, 160).replace(/\n/g, ' '));
t('全仓已无 _openForm(null, …) 的新建调用', !/_openForm\(null/.test(JS));

console.log('\n-- ④ 加号仍人人可见 ===');
const recompute = body('_recomputeFab', '_personalToCell');
t('fabShow 仍含 hasTimetable（非仅管理员）', /hasTimetable/.test(recompute));
t('fabShow 仍受 _showPersonal 约束（换班看别人班时不显示）', /showPersonal/.test(recompute));
t('wxml 的 fab 仍是 wx:if fabShow && !isCounselor', /wx:if="\{\{fabShow && !isCounselor\}\}"/.test(WXML));

console.log('\n-- ⑤ 注释口径同步（防后人改回）===');
t('wxml 注释已写明「一律是添加个人选修课」', /一律是添加个人选修课/.test(WXML));
t('onFab 注释写明用户口径与「超管等也是一样」', /超管等也是一样|一律「添加个人选修课」/.test(onFab));

console.log('\n结果: ' + pass + ' 过 / ' + fails.length + ' 败');
process.exit(fails.length ? 1 : 0);