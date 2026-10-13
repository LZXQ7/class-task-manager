#!/usr/bin/env node
/**
 * 第 49 个门禁：`duty.myStats` 与 `duty.myList` 必须**同源**
 * ============================================================
 * 起因（2026-09-29，1.0.5 需求③）：
 *   用户截图 —— 「我的」页顶部显示「待值日 4 / 已结束 0」，点开弹层却是「3 / 1」。
 *   根因：状态是**读时派生**的（common/week.js 的 effectiveStatus），而库里 `duty.status`
 *   恒为 'PENDING'。`myStats` 却自己写 SQL 数那个列：
 *     SUM(status IN ('PENDING','ONGOING')) AS pending, SUM(status IN ('EXPIRED','DONE')) AS past
 *   ⇒ 恒得「pending = 全部、past = 0」，与 myList（走 effectiveStatus）必然对不上。
 *   ⇒ 顶部数字与弹层条数**永远是两个口径**，谁改谁错。
 *
 * 判据（锁意图：计数与列表只能有一条派生链）：
 *   ① duty/index.js 必须存在 `dutyBucket()` 与 `deriveMyDuties()` 两个唯一来源；
 *   ② `myStats` handler 体内**不得**再出现 SQL 计数（`SUM(status` / `COUNT(*) AS term`），
 *      且必须调用 `deriveMyDuties(`；
 *   ③ `myList` 必须调用 `deriveMyDuties(`，分桶必须走 `dutyBucket(`，
 *      不得再自己写 `['PENDING','ONGOING'].includes(`；
 *   ④ 行为层：把 `dutyBucket` 抽出来真跑一遍（纯函数），断言六种状态的分桶；
 *   ⑤ 变异：把 myStats 改回 SQL 计数 → ②必须判死。
 *
 * 退出码 0 = 过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DUTY = path.join(ROOT, 'cloudfunctions', 'duty', 'index.js');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

/** 从 `idx`（指向 'function'/'async function' 的 f）开始的整块函数体（花括号配对） */
function braceBlock(src, idx) {
  const open = src.indexOf('{', idx);
  if (open < 0) return '';
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') d++;
    else if (c === '}') { d--; if (!d) return src.slice(idx, i + 1); }
  }
  return '';
}
/** 取名为 name 的函数体（function / async function 定义） */
function fnBody(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  return m ? braceBlock(src, m.index) : '';
}
/** 取 routes 里某个 action 的 handler 体（单引号/无引号键都认） */
function routeHandler(src, action) {
  const re = new RegExp('(?:^|\\n)\\s{2}' + action + ":\\s*\\{");
  const m = re.exec(src);
  if (!m) return '';
  const block = braceBlock(src, m.index + m[0].length - 1);
  return block;
}

/* ---------------- 审计函数（真源与变异源共用） ---------------- */
function audit(src) {
  const problems = [];
  if (!fnBody(src, 'dutyBucket')) problems.push('缺少唯一的 dutyBucket() 分桶函数');
  if (!fnBody(src, 'deriveMyDuties')) problems.push('缺少唯一的 deriveMyDuties() 派生链');

  const stats = routeHandler(src, 'myStats');
  const list = routeHandler(src, 'myList');
  if (!stats) problems.push('找不到 myStats 路由');
  if (!list) problems.push('找不到 myList 路由');

  if (stats) {
    if (/SUM\s*\(\s*status\s+IN/i.test(stats) || /COUNT\s*\(\s*\*\s*\)\s*AS\s+term/i.test(stats)) {
      problems.push('myStats 又自己写 SQL 数 duty.status 了（库里该列恒为 PENDING）');
    }
    if (!/deriveMyDuties\s*\(/.test(stats)) problems.push('myStats 没有走 deriveMyDuties()（与明细不同源）');
  }
  if (list) {
    if (!/deriveMyDuties\s*\(/.test(list)) problems.push('myList 没有走 deriveMyDuties()');
    if (!/dutyBucket\s*\(/.test(list)) problems.push('myList 的分桶没有走 dutyBucket()');
    if (/\[\s*'PENDING'\s*,\s*'ONGOING'\s*\]\s*\.includes/.test(list)) {
      problems.push('myList 里又出现了内联分桶 [\'PENDING\',\'ONGOING\'].includes(...)（分桶必须唯一）');
    }
  }
  return problems;
}

const src = fs.readFileSync(DUTY, 'utf8');

console.log('── ① 唯一来源存在');
const problems = audit(src);
problems.forEach(fail);
if (!problems.length) ok('dutyBucket() / deriveMyDuties() 齐备，myStats 与 myList 同源');

console.log('\n── ② 行为层：dutyBucket 真跑一遍（纯函数）');
const bucketSrc = fnBody(src, 'dutyBucket');
if (!bucketSrc) fail('拿不到 dutyBucket 源码');
else {
  let bucket;
  try { bucket = new Function('return (' + bucketSrc + ')')(); }
  catch (e) { fail('dutyBucket 源码无法执行：' + e.message); }
  if (bucket) {
    const want = {
      PENDING: 'pending', ONGOING: 'pending',
      EXPIRED: 'past', DONE: 'past', LEAVE: 'past',
      SWAPPED_OUT: 'other'
    };
    const wrong = Object.keys(want).filter(k => bucket(k) !== want[k]);
    if (wrong.length) fail('分桶不符：' + wrong.map(k => k + '→' + bucket(k) + '(应 ' + want[k] + ')').join('，'));
    else ok('六种状态分桶正确（待值日/进行中 → pending；已结束/已请假 → past；换走 → other）');
    // 用户截图那组数字：3 条待值日 + 1 条已过期
    const rows = ['PENDING', 'PENDING', 'EXPIRED', 'PENDING'];
    const p = rows.filter(s => bucket(s) === 'pending').length;
    const q = rows.filter(s => bucket(s) === 'past').length;
    if (p === 3 && q === 1) ok('复刻截图场景：4 条值日 → 待值日 3 / 已结束 1（不再出现 4 / 0）');
    else fail('复刻截图场景失败：得到 ' + p + ' / ' + q);
  }
}

console.log('\n── ③ 变异自证：把 myStats 改回 SQL 计数 → 必须判死');
const mutated = src.replace(
  /const list = await deriveMyDuties\(pool, classId, me\.id\);/,
  "const list = await pool.query(`SELECT COUNT(*) AS term, SUM(status IN ('PENDING','ONGOING')) AS pending FROM duty WHERE member_id = ?`, [me.id]);"
);
if (mutated === src) fail('变异没生效（锚点失配）→ 自证无效');
else {
  const mp = audit(mutated);
  if (mp.some(x => x.indexOf('SQL') >= 0)) ok('变异被抓：' + mp[0]);
  else fail('变异未被抓住（判据被削弱）：' + JSON.stringify(mp));
}

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 值日统计同源体检通过');
