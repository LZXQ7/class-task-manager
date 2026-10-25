/**
 * 门禁：班委筛选 / 设置班委 / 手动排班可用测试账号（v0.7.9 需求①②④）
 * ------------------------------------------------------------
 * 这三条都是「前端入口 + 后端落库」成对出现的能力，缺任何一半用户都会看到
 * 「点了没反应」或「选了保存失败」，所以按对校验：
 *   ① 查看人员页「全班 / 仅班委 / A 组 / B 组」筛选：viewMembers 只用于展示，members 保持全量供详情查找；
 *   ② 设置班委（超管 + 辅导员）：入口 → util.POSITIONS → api → member.setPosition（role + position）；
 *   ③ 手动排班的选人名册纳入测试账号，但**自动生成不能**被污染。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

const rosWxml = read('miniprogram/pages/roster/index.wxml');
const rosJs = read('miniprogram/pages/roster/index.js');
const rosWxss = read('miniprogram/pages/roster/index.wxss');
const apiSrc = read('miniprogram/utils/api.js');
const memSrc = read('cloudfunctions/member/index.js');
const schSrc = read('cloudfunctions/schedule/index.js');
const manWxml = read('miniprogram/pages/manual/index.wxml');

/* ============================================================
 * ① 分组筛选（全班 / 仅班委 / A 组 / B 组）
 * ============================================================ */
console.log('── ① 查看人员页「全班 / 仅班委 / A组 / B组」筛选');
has(rosJs, /_isCommittee\s*\(/, 'roster 有 _isCommittee 判据');
// 判据只锚「非辅导员」这一半。
// ⚠️ 「非测试账号」那一半已在 2026-10-08 删除：member.list 对测试账号是**服务端一律过滤**，
//    名单里恒无测试账号，判据再要求前端写 !x.test 只会逼人把死代码加回来
//    （那才是真风险：照着判据写的人会以为前端过滤是必须的）。
//    「不显示测试账号」改由 check-test-account-hidden.js 单独守。
has(rosJs, /_isCommittee\(x\)[\s\S]{0,120}?role === 'ADMIN' \|\| x\.role === 'MONITOR'[\s\S]{0,80}?groupTag !== 'X'/,
  '班委判据 = ADMIN/MONITOR 且非辅导员（测试账号由服务端过滤，见 check-test-account-hidden）');
has(rosJs, /_filterRows\s*\(/, 'roster 有 _filterRows 过滤器');
has(rosJs, /viewMembers:\s*this\._filterRows\(rows, this\.data\.groupFilter\)/,
  '_loadMembers 同时算出 viewMembers');
has(rosJs, /committeeCount:\s*rows\.filter\(x => this\._isCommittee\(x\)\)\.length/,
  '统计班委人数（chip 角标）');
has(rosJs, /this\.data\.members\.find\(x => x\.id === id\)/,
  '详情查找仍走全量 members（筛选只影响展示）');
has(rosWxml, /wx:for="\{\{viewMembers\}\}"/, '列表渲染 viewMembers');
/* 2026-10-24：原来只有「全班 / 仅班委」两个 chip（布尔开关），
   加 A/B 组后改成**四选一枚举** `groupFilter`，四个 chip 共用 onFilterScope。 */
has(rosWxml, /data-scope="ALL"[\s\S]{0,90}?全班/, '有「全班」chip 且走 onFilterScope');
has(rosWxml, /data-scope="COMMITTEE"[\s\S]{0,90}?仅班委/, '有「仅班委」chip 且走 onFilterScope');
has(rosWxml, /data-scope="A"[\s\S]{0,90}?A 组/, '有「A 组」chip 且走 onFilterScope');
has(rosWxml, /data-scope="B"[\s\S]{0,90}?B 组/, '有「B 组」chip 且走 onFilterScope');
has(rosJs, /onFilterScope\s*\(/, '四个 chip 共用一个作用域切换入口');
has(rosJs, /groupACount:\s*rows\.filter\(x => x\.groupTag === 'A'\)\.length/, '统计 A 组人数（chip 角标）');
has(rosJs, /groupBCount:\s*rows\.filter\(x => x\.groupTag === 'B'\)\.length/, '统计 B 组人数（chip 角标）');
has(rosJs, /emptyText:\s*EMPTY_TEXT\[this\.data\.groupFilter\]/, '空态文案随作用域变化（不会「筛A组却提示暂无班委」）');
has(rosWxml, /wx:if="\{\{membersLoaded && !viewMembers\.length\}\}"/, '筛选后为空有占位提示（骨架加载完才判空，避免闪现）');
has(rosWxss, /\.mb-chip\.on\s*\{/, '筛选 chip 选中态样式已定义');

/* ============================================================
 * ② 设置班委（超管 + 辅导员）
 * ============================================================ */
console.log('\n── ② 人员详情「设置班委」（超管 + 辅导员）');
has(rosWxml, /canManage && !mDetailIsSelf[\s\S]{0,180}?onOpenPosition/,
  '「设为班委」入口对超管 + 辅导员开放（且排除自己）');
has(rosWxml, /mDetail\.groupTag !== 'X'[\s\S]{0,80}?!mDetail\.isSuper/,
  '「设为班委」排除辅导员与超管');
has(rosWxml, /<bottom-sheet show="\{\{posShow\}\}" title="设置班委"/, '有设置班委弹层');
has(rosWxml, /wx:for="\{\{posList\}\}"[\s\S]{0,200}?bindtap="onPickPosition"/, '弹层里逐项选职位');
has(rosWxml, /bindtap="onCancelPosition"/, '已授权者可在弹层里「取消班委」');
has(rosJs, /util\.POSITIONS\.map\(/, '职位取值来自 util.POSITIONS（不硬编码）');
has(rosJs, /api\.setMemberPosition\([\s\S]{0,80}?memberId: m\.id, position/, '落库调用 api.setMemberPosition');
has(rosJs, /onOpenPosition[\s\S]{0,300}?canManage[\s\S]{0,120}?toast/,
  '前端对无权限者给明确提示（不只是藏按钮）');
has(apiSrc, /setMemberPosition:\s*C\('member', 'setPosition'\)/, 'api 映射 member.setPosition');
has(memSrc, /UPDATE member SET role = \?, position = \? WHERE id = \? AND class_id = \?/,
  'setPosition 同时写 role 与 position');
has(memSrc, /const role = position \? 'ADMIN' : 'MEMBER'/, '选职位=ADMIN，清空=退回 MEMBER');

/* ------------------------------------------------------------
 * 需求 D（2026-09-27）：两个职位（生活委员 / 班长兼团支书）从「头衔」升格为
 * 「授权来源」—— 担任即获得排班权 / 名册编辑权，因此它们的**授予权必须仅超管**。
 * 上一节只守了「入口对超管 + 辅导员开放」，这里补的是「**这两个职位要置灰**」：
 * 少了这段，辅导员任命一个生活委员就等于间接把排班权发出去了。
 * 判据按「前端置灰 + 后端授予权」**成对**校验 —— 只做前端 = 可被绕过。
 * ------------------------------------------------------------ */
console.log('\n── ②b 授权职位（生活委员 / 班长兼团支书）置灰 + 仅超管授予');
const utilSrc = read('miniprogram/utils/util.js');
has(utilSrc, /const GRANTED_POSITIONS = \['生活委员', '班长兼团支书'\]/,
  'util.js 定义 GRANTED_POSITIONS（与云函数 POSITION_DUTY_ADMIN / POSITION_MONITOR 逐字一致）');
// ⚠️ 别写成 /GRANTED_POSITIONS[,}]/ —— 它是 module.exports 列表的**最后一项**，
//    后面直接换行，没有逗号也没有 `}` → 判据恒红（2026-09-27 实测踩到）。
has(utilSrc, /,\s*GRANTED_POSITIONS/, 'util.js 导出 GRANTED_POSITIONS');
has(rosJs, /locked: !canGrant && util\.GRANTED_POSITIONS\.indexOf\(p\) >= 0/,
  '职位项算出 locked 标记（非超管看到的授权职位）');
has(rosWxml, /class="ps-item \{\{item\.on \? 'on' : ''\}\} \{\{item\.locked \? 'locked' : ''\}\}"/,
  '职位项模板带 locked 类');
has(rosWxml, /wx:if="\{\{item\.locked\}\}" class="ps-lock"/, '置灰项标注「超管任命」来源');
has(rosWxss, /\.ps-item\.locked/, '.ps-item.locked 置灰样式已定义');
has(rosJs, /if \(!this\.data\.canGrantPosition && util\.GRANTED_POSITIONS\.indexOf\(position\) >= 0\)/,
  '授予授权职位时前端拦截（不是只藏按钮）');
has(rosJs, /if \(!this\.data\.canGrantPosition && util\.GRANTED_POSITIONS\.indexOf\(String\(m\.position \|\| ''\)\) >= 0\)/,
  '撤销授权职位时同样拦截（堵「辅导员改掉已有生活委员」后门）');
has(rosWxml, /wx:if="\{\{!canGrantPosition\}\}" class="im-tip"/, '弹层里说明授权职位由超管任命');
has(memSrc, /guard\.isGrantedPosition\(position\) \|\| guard\.isGrantedPosition\(t\.position\)/,
  '后端 setPosition 对「新职位」与「目标当前职位」都判授权职位');
has(memSrc, /guard\.requirePositionGrant\(ctx\);/, '后端授予权收紧到超管（requirePositionGrant）');

/* ============================================================
 * ③ 手动排班可用测试账号（自动生成不受影响）
 * ============================================================ */
console.log('\n── ③ 手动排班可选测试账号（自动生成仍排除）');
/* 2026-10-08 起 TEST_NO_PREFIX 的唯一真源是 common/test-account.js（铁律：别各抄一份），
   所以这里判「从 common 取」，而不是判本地写死常量 —— 否则真源收敛反而会被门禁判死。 */
has(schSrc, /require\('\.\/common\/test-account'\)/, 'schedule 从 common/test-account 取测试账号真源（不本地抄一份）');
has(schSrc, /const \{[^}]*TEST_NO_PREFIX[^}]*\} = require\('\.\/common\/test-account'\)/,
  'schedule 确实解构出了 TEST_NO_PREFIX（手动排班名册要靠它放行测试账号）');
has(schSrc, /AND \(status = 'ACTIVE' OR student_no LIKE '" \+ TEST_NO_PREFIX \+ "%'\)/,
  'manualBoard 名册对测试账号放行');
has(schSrc, /test:\s*isTestNo\(m\.student_no\)/, 'manualBoard 回传 test 标记（前端可提示）');
const relax = (schSrc.match(/target\.status !== 'ACTIVE' && !isTestNo\(target\.student_no\)/g) || []).length;
if (relax === 2) ok('addManual / reassign 两处都放行测试账号');
else bad('addManual / reassign 放行不完整（命中 ' + relax + ' 处，期望 2）');
/* 自动生成的三条轮转名册 SQL：必须**同时**满足 ① 排除 X 组 ② 排除 duty_off=1 ③ 排除测试账号。
   ③ 是 2026-10-08 补的 —— 光靠 isTestNo 过滤会漏，SQL 层就得查不出来。 */
const autoRoster = schSrc.match(/FROM member WHERE class_id = \? AND status = 'ACTIVE' AND " \+ NOT_TEST\(\) \+ " AND group_tag <> 'X' AND duty_off = 0/g) || [];
if (autoRoster.length >= 3) ok('自动生成的名册 SQL 三处都排除 X 组 / duty_off / 测试账号（命中 ' + autoRoster.length + ' 处）');
else bad('自动生成的名册 SQL 排除条件不全（命中 ' + autoRoster.length + ' 处，期望 >=3）：要么漏了 NOT_TEST()，要么漏了 X 组 / duty_off');
has(manWxml, /item\.test \? '测试账号 · ' : ''/, '手动排班选人列表标出测试账号');

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 班委 / 设置班委 / 测试账号校验通过');
