#!/usr/bin/env node
/**
 * 后台「开通后台」选人方式门禁（2026-11-15）
 *
 * 两条真实诉求合成一道门：
 *   ① 展示方式：账号页不许再把候选成员铺成底部大表格，改成「开通后台」按钮 +
 *      搜索/过滤弹层；点选某人再进原来的开通弹层。
 *   ② 辅导员可见：辅导员是 class_id=0 / group_tag='X' 的全校账号，
 *      候选 SQL 若只写 m.class_id = ? 就会把辅导员挡在候选外（2026-11-15 实锤）。
 *
 * 判据全部读真实源码；末尾 4 条变异自证保证判据不是摆设。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('cloudfunctions/admin-web/public/app.js');
const MOD = read('cloudfunctions/admin-web/lib/mod-accounts.js');
const CSS = read('cloudfunctions/admin-web/public/admin.css');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

function bodyOf(text, name) {
  const m = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{').exec(text);
  if (!m) return null;
  let i = m.index + m[0].length - 1, depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (!depth) return text.slice(i + 1, k); }
  }
  return null;
}

/* ① 展示方式 */
section('① 账号页：单按钮 + 搜索弹层，不再铺大表格');
const ra = bodyOf(APP, 'renderAccount') || '';
check(/id="acc-open"/.test(ra) && /开通后台/.test(ra), 'renderAccount 有「开通后台」按钮 #acc-open');
check(!/data-acc-add/.test(ra) && !/可开通的成员/.test(ra), '底部候选大表格已移除（无 data-acc-add / 「可开通的成员」标题）');
check(/var op = \$\('#acc-open', host\)/.test(ra), '#acc-open 有点击绑定');
const pick = bodyOf(APP, 'openAccountPickDialog') || '';
check(!!pick, '存在 openAccountPickDialog 选人弹层');
check(/id="pick-kw"/.test(pick) && /\$\('#pick-kw', dlg\)\.oninput/.test(pick), '弹层有搜索框且绑定 oninput');
check(/\$\('#pick-kw', dlg\)\.focus\(\)/.test(pick), '打开弹层自动聚焦搜索框');
check(/\[c\.memberName, c\.studentNo, c\.position, c\.groupTag/.test(pick), '过滤覆盖 姓名/学号/职位/分组');
check(/\$\$\('\[data-pick-member\]', list\)\.forEach/.test(pick), '候选项用 $$ 绑定（非 $ 单元素 forEach）');
check(/openAccountCreateDialog\(c, done\)/.test(pick), '点选后进入原开通弹层');
check(/c\.groupTag === 'X'/.test(pick) && /教职工/.test(pick), '辅导员/教职工在列表里有醒目标注');
check(/\.pick-list/.test(CSS) && /\.pick-item:hover/.test(CSS), 'admin.css 有选人列表样式与 hover');

/* ①-b 上方身份筛选：全部 / 教职工 / 班委（2026-11-15 用户要求） */
section('①-b 选人弹层上方身份筛选（全部 / 教职工 / 班委）');
['all', 'staff', 'committee'].forEach((k) =>
  check(new RegExp('data-pick-kind="' + k + '"').test(pick), '筛选按钮含 ' + k));
check(/function isStaff\(c\)\s*\{\s*return c\.groupTag === 'X';\s*\}/.test(pick),
  '教职工判定 = group_tag=X');
check(/function isCommittee\(c\)\s*\{\s*return c\.groupTag !== 'X' && c\.role !== 'MEMBER';\s*\}/.test(pick),
  '班委判定 = 非教职工且非普通成员');
check(/if \(kind === 'staff' && !isStaff\(c\)\) return false;/.test(pick) &&
  /if \(kind === 'committee' && !isCommittee\(c\)\) return false;/.test(pick),
  'renderList 按 kind 过滤教职工/班委');
check(/\$\$\('\[data-pick-kind\]', dlg\)\.forEach/.test(pick),
  '筛选按钮用 $$ 绑定（非 $ 单元素 forEach）');
check(/\.classList\.toggle\('active', x === b\)/.test(pick), '点击筛选切换 active 高亮');
check(/oninput = function \(e\) \{ renderList\(e\.target\.value, curKind\); \}/.test(pick),
  '搜索框与筛选联动（带上 curKind 重绘）');
check(/\.pick-filter/.test(CSS), 'admin.css 有 .pick-filter 样式');

/* ①-c 全部视图教职工置顶 + 班委标签（2026-11-16 用户要求） */
section('①-c 全部视图教职工置顶 + 班委名字后标签');
check(/if \(kind === 'all'\) \{[\s\S]*?isStaff\(a\.c\)/.test(pick),
  '「全部」视图对候选做教职工置顶排序（isStaff 参与比较）');
check(/ka === kb \? a\.i - b\.i/.test(pick),
  '置顶排序稳定：同组保持后端原顺序（按原始序号 i）');
check(/isCommittee\(c\) \? ' <span class="tag tag-ok">班委<\/span>'/.test(pick),
  '班委成员名字后加绿色「班委」标签（tag-ok，区别于教职工蓝色 tag-all）');
check(/isStaff\(c\) \? ' <span class="tag tag-all">教职工<\/span>'/.test(pick),
  '教职工标签改用 isStaff 判定（与筛选口径一致）');

/* ② 辅导员进候选 */
section('② 后端候选取消 class_id 硬过滤，放行教职工 group_tag=X');
const listFn = bodyOf(MOD, 'listAccounts') || '';
// 注意：源码里 SQL 是单引号字符串，内部引号写成 \' —— 正则要匹配反斜杠+引号
check(/m\.group_tag = \\'X\\'/.test(listFn),
  '候选 SQL 用 (m.class_id = ? OR m.group_tag = \'X\') 放行辅导员');
check(!/WHERE m\.class_id = \?\s+AND/.test(listFn), '不再只按 WHERE m.class_id = ? 硬过滤');
check(/NOT_TEST\('m'\)/.test(listFn), '仍保留测试账号过滤');
check(/m\.status <> \\'DISABLED\\'/.test(listFn), '仍保留停用成员过滤');

/* ③ 权限档位不变（辅导员 10 项，无 audit/accounts/rules） */
section('③ 辅导员权限档位（用户拍板 10 项）');
const PERMS = read('cloudfunctions/admin-web/lib/perms.js');
const tplMatch = /'辅导员':\s*\[([^\]]*)\]/.exec(PERMS);
const tpl = tplMatch ? tplMatch[1] : '';
const keys = (tpl.match(/'[\w]+'/g) || []).map((s) => s.replace(/'/g, ''));
['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'usage']
  .forEach((k) => check(keys.indexOf(k) >= 0, '辅导员含 ' + k));
check(keys.indexOf('audit') < 0 && keys.indexOf('accounts') < 0,
  '辅导员不含 audit / accounts（超管专属）');
check(keys.indexOf('rules') < 0, '辅导员不含 rules（排班规则仍归班委/超管）');

/* ④ 变异自证 */
section('④ 变异自证（改坏 → 判据必须翻红）');
// 4.1 SQL 改回只按 class_id → 放行判据翻红
const badSql = listFn.replace(/m\.group_tag = \\'X\\'/, "m.group_tag = \\'NEVER\\'");
check(badSql !== listFn && !/m\.group_tag = \\'X\\'/.test(badSql),
  '变异被抓：SQL 去掉 group_tag=X → 辅导员放行判据翻红');
// 4.2 把搜索框删掉 → oninput 判据翻红
const badPick = pick.replace(/id="pick-kw"/, 'id="pick-x"');
check(!/id="pick-kw"/.test(badPick), '变异被抓：删搜索框 → pick-kw 判据翻红');
// 4.3 把 $$ 改回 $ → forEach 判据翻红（全局替换，源码里可能有多处）
const badDollar = pick.replace(/\$\$\('\[data-pick-member\]', list\)\.forEach/g,
  () => "$('[data-pick-member]', list).forEach");
check(!/\$\$\('\[data-pick-member\]', list\)\.forEach/.test(badDollar),
  '变异被抓：$$ 改回 $ → 绑定判据翻红');
// 4.4 给辅导员模板塞 audit → 权限判据翻红
const badTpl = PERMS.replace(/'辅导员':\s*\[([^\]]*)\]/, (m0, g1) => "'辅导员': [" + g1 + ", 'audit']");
check(/'辅导员':\s*\[[^\]]*'audit'/.test(badTpl), '变异被抓：辅导员模板加 audit → 权限判据翻红');
// 4.5 删掉「班委」筛选按钮 → 筛选判据翻红
const badKind = pick.replace(/data-pick-kind="committee"/, 'data-pick-kind="xxx"');
check(!/data-pick-kind="committee"/.test(badKind), '变异被抓：删班委筛选按钮 → 筛选判据翻红');
// 4.6 班委判定改成"含普通成员" → 判定判据翻红
const badCommittee = pick.replace(
  /function isCommittee\(c\)\s*\{\s*return c\.groupTag !== 'X' && c\.role !== 'MEMBER';\s*\}/,
  "function isCommittee(c) { return true; }");
check(!/function isCommittee\(c\)\s*\{\s*return c\.groupTag !== 'X' && c\.role !== 'MEMBER';\s*\}/.test(badCommittee),
  '变异被抓：班委判定放宽 → 判定判据翻红');
// 4.7 筛选按钮 $$ 改回 $ → 绑定判据翻红（两处：外层点击 + 内层切 active，须全局替换）
const badPickKind = pick.replace(/\$\$\('\[data-pick-kind\]', dlg\)\.forEach/g,
  () => "$('[data-pick-kind]', dlg).forEach");
check(!/\$\$\('\[data-pick-kind\]', dlg\)\.forEach/.test(badPickKind),
  '变异被抓：筛选按钮 $$ 改回 $ → 绑定判据翻红');
// 4.8 去掉教职工置顶（把 isStaff(a.c) 换成常量）→ 置顶判据翻红
const badSort = pick.replace(/var ka = isStaff\(a\.c\) \? 0 : 1;/, 'var ka = 1;');
check(!/if \(kind === 'all'\) \{[\s\S]*?isStaff\(a\.c\)/.test(badSort),
  '变异被抓：去掉教职工置顶 → 置顶判据翻红');
// 4.9 删掉班委标签 → 班委标签判据翻红
const badTag = pick.replace(/isCommittee\(c\) \? ' <span class="tag tag-ok">班委<\/span>'/, "''");
check(!/isCommittee\(c\) \? ' <span class="tag tag-ok">班委<\/span>'/.test(badTag),
  '变异被抓：删班委标签 → 标签判据翻红');

console.log('\n结果：' + (fail ? '失败 ' + fail + ' / 通过 ' + pass : '全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);
