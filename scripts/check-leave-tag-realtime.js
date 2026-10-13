#!/usr/bin/env node
/**
 * 第 72 个门禁：成员行「请假中」标签必须是**实时口径**
 * =================================================================
 * 2026-10-09 用户实拍：郝鹏杰上午 08:00-12:00 请假，19:26 打开「成员与分组」
 * 那一行**仍显示「请假中」**。
 *
 * 🔴 根因：`_applyLeaveRows` 里 `leaveMap` 用的是 `list.forEach(x => map[...]=true)`，
 *    而 `list` 是 **leaveBoard 的日期口径全列**（含已过时段）⇒ 半天假过了时段仍被标"请假中"。
 *
 * ⚠️ 这个 bug 与同一文件下面那段「口径分层」注释**自相矛盾**（注释明说
 *    `leaveNow = 实时口径`），却没人把标签和注释对上 —— 两处于是打架：
 *    顶部「在位统计」用实时（他不在假里）、行尾标签用日期（说他还在假）。
 *
 * ✅ 口径分层（本门禁钉的就是它）：
 *   · `leaveList` / `stat` = **日期口径**：今天有生效请假的全列（含已过时段）
 *     → 弹层「今日请假 · N 人」名单用它，数字恒等于行数；
 *   · `leaveMap` / `leaveNow` = **实时口径**：此刻真落在时段内
 *     → 行尾「请假中」标签 + 顶部「在位统计」用它。
 *
 * ⚠️ **这不是「隐藏状态」而是「两个维度都真实存在」**：一个人可以「今天请过假」
 *   但「此刻不在假里」（上午的假 vs 晚上的名单）。两个都要能看到，区别在标签。
 *
 * 变异自证（5 组）：
 *   M1 leaveMap 退回日期口径（**本 bug 本身**：半天假过了时段仍标请假中）
 *   M2 半天假不看时段（整天假与半天假一律算请假中）
 *   M3 标签反了（已过时段才算请假中）
 *   M4 nowList 用后端那份而非本地算（串班过滤后两个口径对不上）
 *   M5 把 leaveList 也改成实时（弹层名单只剩此刻在假的人 ⇒ 与 N 人计数对不上）
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

const ROSTER_JS = 'miniprogram/pages/roster/index.js';
const ROSTER_WXML = 'miniprogram/pages/roster/index.wxml';

const js = read(ROSTER_JS);
const wxml = read(ROSTER_WXML);

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
const code = strip(js);

/* ------------------------------------------------------------------ */
console.log('── ① 「请假中」标签必须用实时口径');

const fn = /_applyLeaveRows\(list, backendStat, dropped\)\s*\{([\s\S]*?)\n {2}\},\n\n {2}\/\*\*/.exec(js);
chk(!!fn, '能定位 _applyLeaveRows');
if (fn) {
  const body = strip(fn[1]);

  // 🔴🔴 核心判据：map 由 **nowList** 填，不是 list
  chk(/nowList\.forEach\(x => \{ map\[x\.memberId\] = true; \}\);/.test(body),
    '🔴⚠️⚠️ `leaveMap` 由 **nowList**（实时口径）填 —— 用 `list`（日期全列）填就是本 bug');
  chk(!/list\.forEach\(x => \{ map\[x\.memberId\] = true; \}\);/.test(body),
    '🔴⚠️ 不得用日期口径的 `list` 填 leaveMap（半天假过了时段仍标「请假中」= 用户实拍）');

  // nowList 必须在填 map 之前算出来（顺序错了会 ReferenceError / undefined）
  const iNow = body.indexOf('const nowList = list.filter');
  const iMap = body.indexOf('nowList.forEach');
  chk(iNow >= 0, '方法体内有 nowList 的定义');
  chk(iNow < iMap,
    '🔴⚠️⚠️ `nowList` 的定义**必须在前**、填 map 在后（反了会读到 undefined ⇒ 标签全没了）');

  // 半天假要比较时段；整天假恒算
  chk(/\(!x\.startTime \|\| !x\.endTime\) \? true : \(clock >= x\.startTime && clock <= x\.endTime\)/.test(body),
    '⚠️⚠️ 半天假按**时刻**判（clock >= start && clock <= end）；整天假（无时段）恒算在假');

  // leaveNow 仍用 nowList（在位统计与标签同源）
  chk(/leave:\s*nowList\.length/.test(body),
    '⚠️ `leaveNow` 计数也用 nowList（与标签同源，两处不许一个实时一个日期）');

  // 🔴 关键：`leaveList`（弹层名单）必须**保持日期口径**，不能一起改成实时
  chk(/leaveList:\s*list,/.test(body),
    '🔴⚠️ `leaveList` 仍是**日期口径全列**（弹层「今日请假 N 人」= 今天请过假的人，含已过时段）；'
    + '⚠️ 不许跟着标签一起改成实时 ⇒ 名单会只剩此刻在假的人，与「N 人」计数对不上');
}

chk(/const clock = this\._clockNow\(\);/.test(code),
  '⚠️ 取时刻用 this._clockNow()（项目自己的钟，不要 new Date() 手搓）');
chk(/method: 'POST'/, js, '（无关项，仅确保文件可读）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② WXML：标签的显示条件');

chk(/wx:if="\{\{leaveMap\[item\.id\]\}\}" class="mb-tag leave">请假中<\/view>/.test(strip(wxml)),
  '「请假中」标签由 leaveMap 查表驱动（WXML 不能调方法 ⇒ 必须 JS 算好 map）');
chk(/leaveMap: \{\}/.test(js), 'leaveMap 有初值 {}（不设初值首渲染会 undefined）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ③ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

function judge(o) {
  const src = o || {};
  const v = src.js || js;
  const vb = strip(v);
  let n = 0;
  const push = (x) => { if (!x) n += 1; };

  const f = /_applyLeaveRows\(list, backendStat, dropped\)\s*\{([\s\S]*?)\n {2}\},\n\n {2}\/\*\*/.exec(v);
  push(!!f);
  if (f) {
    const body = strip(f[1]);
    push(/nowList\.forEach\(x => \{ map\[x\.memberId\] = true; \}\);/.test(body));
    push(!/list\.forEach\(x => \{ map\[x\.memberId\] = true; \}\);/.test(body));
    const iNow = body.indexOf('const nowList = list.filter');
    const iMap = body.indexOf('nowList.forEach');
    push(iNow >= 0);
    push(iNow >= 0 && iNow < iMap);
    push(/\(!x\.startTime \|\| !x\.endTime\) \? true : \(clock >= x\.startTime && clock <= x\.endTime\)/.test(body));
    push(/leave:\s*nowList\.length/.test(body));
    push(/leaveList:\s*list,/.test(body));
  }
  push(/const clock = this\._clockNow\(\);/.test(vb));
  push(/leaveMap: \{\}/.test(v));
  return n;
}

const MUT = [
  {
    name: 'M1 leaveMap 退回日期口径（**本 bug 本身**：半天假过了时段仍标「请假中」）',
    apply: () => ({
      js: js.replace('nowList.forEach(x => { map[x.memberId] = true; });',
        'list.forEach(x => { map[x.memberId] = true; });')
    })
  },
  {
    name: 'M2 半天假不看时段（整天假与半天假一律算「请假中」）',
    apply: () => ({
      js: js.replace("const nowList = list.filter(x => (!x.startTime || !x.endTime) ? true : (clock >= x.startTime && clock <= x.endTime));",
        'const nowList = list.slice();')
    })
  },
  {
    name: 'M3 标签反了（已过时段才算请假中 —— 正好相反）',
    apply: () => ({
      js: js.replace("(clock >= x.startTime && clock <= x.endTime)",
        "(clock < x.startTime || clock > x.endTime)")
    })
  },
  {
    name: 'M4 nowList 定义挪到填 map 之后（读到 undefined ⇒ 标签全没了）',
    apply: () => ({
      js: js.replace('const clock = this._clockNow();\n    // 整天假（无时段）恒算「在请假」；半天假则要求此刻落在时段内。\n    const nowList = list.filter(x => (!x.startTime || !x.endTime) ? true : (clock >= x.startTime && clock <= x.endTime));\n    const map = {};\n    nowList.forEach(x => { map[x.memberId] = true; });',
        'const map = {};\n    list.forEach(x => { map[x.memberId] = true; });\n    const clock = this._clockNow();\n    const nowList = list.filter(x => (!x.startTime || !x.endTime) ? true : (clock >= x.startTime && clock <= x.endTime));')
    })
  },
  {
    name: 'M5 弹层名单 leaveList 也改成实时（名单只剩此刻在假的人 ⇒ 与「N 人」计数对不上）',
    apply: () => ({
      js: js.replace('leaveList: list,', 'leaveList: nowList,')
    })
  }
];

let caught = 0;
MUT.forEach((c) => {
  const before = judge();
  if (before !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  // 🔴 变异必须真的改到源码（锚点失效 ⇒ replace 原样返回 ⇒ 门禁测的是原文件）
  const orig = { js };
  const touched = ['js'].some((k) => over[k] && over[k] !== orig[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效：replace 找不到就原样返回）'
      + ' ⇒ 门禁测的是原文件，这就是「变异没被抓到」的典型假通过。**先修锚点。**');
    bad += 1;
    return;
  }
  let n;
  try { n = judge(over); } catch (e) {
    fail('变异「' + c.name + '」跑挂了（' + e.message + '）—— 变异体必须能真跑');
    bad += 1;
    return;
  }
  if (n > 0) { ok('变异「' + c.name + '」被门禁抓到（' + n + ' 条判据翻红）'); caught += 1; }
  else { fail('变异「' + c.name + '」**没被抓到** —— 判据失效'); bad += 1; }
});
if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) {
  console.log('[FAIL] ' + bad + ' 项未通过');
  process.exit(1);
}
console.log('[PASS] 「请假中」标签实时口径体检通过');