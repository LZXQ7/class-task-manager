/**
 * 成员表「删除」按钮对齐门禁（2026-11-18）
 * ═══════════════════════════════════════════════════════════════════════════
 * 背景（真实 bug）：
 *   成员表第一行（示例成员01，受保护超管）与只读行的中间元素是静态说明文字，
 *   此前复用 .muted-note（padding:12px 16px），把操作列撑宽 ⇒ 在整列右对齐下，
 *   「删除」按钮右边缘比其它行右偏 9px（截图像素实测 1211 vs 1202）。
 *   其它行中间是 .link 按钮（padding:4px 8px），基准不同。
 *
 * 修法（本门禁固化）：
 *   ① 成员表 td 加类 td-ops-members，CSS 用 flex + justify-content:flex-end
 *      锁定整列基准，中间元素再宽也不影响「删除」贴右；
 *   ② 静态说明由 .muted-note 换成轻量 .ops-note（无大 padding），行高与按钮行一致。
 *   只作用于成员表，不波及请假/值日等其它 .td-ops。
 *
 * 验证手段：
 *   静态断言（本门禁，CI 可跑）+ 开发期 Chrome headless 真实渲染实测 delta=0。
 *   渲染回路见当日 memory 日志；本门禁保证源码里的修复标记不被回退。
 *
 * 变异自证：
 *   把 CSS 的 display:flex / flex-end 与 JS 的 td-ops-members / ops-note 改回坏写法，
 *   对应断言必须翻红，证明扫描器真的在扫、不是恒绿。
 *
 * 退出码：0 = 修复标记齐全；1 = 有标记缺失 / 自证失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css');
const APP_PATH = path.join(ROOT, 'cloudfunctions/admin-web/public/app.js');

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

console.log('== 成员表操作列对齐修复 ==');
let CSS = fs.readFileSync(CSS_PATH, 'utf8');
let APP = fs.readFileSync(APP_PATH, 'utf8');

// ① CSS：成员表专用 flex 右对齐类
check(/\.td-ops-members\s*\{[^}]*display:\s*flex/.test(CSS), 'CSS .td-ops-members 用 display:flex 锁定列基准');
check(/\.td-ops-members\s*\{[^}]*justify-content:\s*flex-end/.test(CSS), 'CSS .td-ops-members 用 justify-content:flex-end（删除贴右）');
check(/\.td-ops-members\s*\{[^}]*align-items:\s*center/.test(CSS), 'CSS .td-ops-members 用 align-items:center（行高一致）');
// ② CSS：轻量 ops-note（无 16px padding）
check(/\.td-ops \.ops-note\s*\{[^}]*font-size:\s*13px/.test(CSS), 'CSS .td-ops .ops-note 存在且为轻量字号');
// ops-note 规则体内不得出现大 padding（12px 16px 这类会再次撑宽）
const opsNoteBody = (CSS.match(/\.td-ops \.ops-note\s*\{([^}]*)\}/) || [])[1] || '';
check(!/padding:\s*1[0-9]px/.test(opsNoteBody), 'CSS .ops-note 无大 padding（不会再次撑宽列）');

// ③ JS：成员表 td 与两处静态说明
check(APP.indexOf('td-ops td-ops-members') >= 0, 'JS 成员表 td 带 td-ops-members 类');
check(/class="ops-note" title="最高管理员/.test(APP), 'JS 受保护行用 ops-note（非 muted-note）');
check(/<span class="ops-note">只读<\/span>/.test(APP), 'JS 只读行用 ops-note（非 muted-note）');
// 成员表操作列 td 不得再用裸 class="td-ops"（必须带 members 类）
check(!/<td class="td-ops">[\s\S]{0,120}data-m-del=/.test(APP), 'JS 带删除按钮的 td 不再是裸 td-ops（已全员带 members 类）');

// ④ 不波及：其它表格（请假/值日）操作列仍可用裸 td-ops（避免误伤）
check((APP.match(/class="td-ops"/g) || []).length >= 1, 'JS 其它表格仍保留裸 td-ops（本修复聚焦成员表）');

// ── 变异自证：改回坏写法，断言必须翻红 ──
console.log('== 变异自证（改坏必须被抓）==');
function mut(label, badCss, badApp, expectSnippet) {
  const c = badCss !== undefined ? badCss : CSS;
  const a = badApp !== undefined ? badApp : APP;
  const hit = expectSnippet(c, a);
  if (hit) { fail++; console.log('  ✗ 漏抓：' + label); }
  else { pass++; console.log('  ✓ 抓红：' + label); }
}
// 去掉 display:flex
mut('CSS 去掉 display:flex',
  CSS.replace(/\.td-ops-members\s*\{[^}]*\}/, '.td-ops-members { justify-content: flex-end; }'),
  undefined,
  (c) => /\.td-ops-members\s*\{[^}]*display:\s*flex/.test(c));
// 去掉 flex-end
mut('CSS 去掉 justify-content:flex-end',
  CSS.replace(/\.td-ops-members\s*\{[^}]*\}/, '.td-ops-members { display: flex; }'),
  undefined,
  (c) => /\.td-ops-members\s*\{[^}]*justify-content:\s*flex-end/.test(c));
// JS td 回退成裸 td-ops
mut('JS 成员表 td 回退裸 td-ops',
  undefined,
  APP.replace('td-ops td-ops-members', 'td-ops'),
  (c, a) => a.indexOf('td-ops td-ops-members') >= 0);
// JS 受保护行回退 muted-note
mut('JS 受保护行回退 muted-note',
  undefined,
  APP.replace(/class="ops-note" title="最高管理员/, 'class="muted-note" title="最高管理员'),
  (c, a) => /class="ops-note" title="最高管理员/.test(a));

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 红');
process.exit(fail ? 1 : 0);
