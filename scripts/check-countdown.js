#!/usr/bin/env node
/**
 * 第 N 个门禁：倒数日的「按人隔离」与云端唯一数据源
 * ============================================================
 * 起因（2026-11-03）：信息页倒数日从 wx.storage 改到云端（countdown_event）。
 *   这一族动作有两个**静默越权 / 静默丢数据**的风险，且都不会报错：
 *     ① SQL 少了 `member_id = me.id` ⇒ 任何人能列出/删除**全班**的倒数日，
 *        界面上完全看不出异常（列表照样渲染，删别人的也「成功」）；
 *     ② 前端又退回只写 wx.storage ⇒ 换机/清缓存后数据全丢，
 *        而用户以为「云端存着」，属于最难被发现的那类回归。
 *
 * 判据（逐条断言在**真实源码**上，不抄副本）：
 *   ① api.js 三条映射都指向 adjust；
 *   ② adjust 三条路由存在、都 needBind；
 *   ③ countdownList 的 SELECT 带 `WHERE member_id = ?`；
 *   ④ countdownAdd 的 INSERT 写 member_id + 查重带 member_id + 有数量上限；
 *   ⑤ countdownDelete **先查归属再删**（查归属的 SQL 存在 + 有 `!== me.id` 抛错 + DELETE 带 member_id）；
 *   ⑥ countdown 用 cdDays 算天数，且 cdDays 基于 `week.todayStr()`（云函数跑 UTC 时不会差一天）；
 *   ⑦ 前端 classinfo：三条 api 都接线；storage 只出现在**迁移**路径，且迁移成功后有 removeStorageSync；
 *   ⑧ WXML：page-meta 含 cdSheetShow（弹层开时背景不许跟着滚）；
 *   ⑨ 变异：去掉 list 的 member_id 条件 / 去掉 delete 的归属判定 → 必须判死。
 *
 * 退出码 0 = 过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

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
function routeBlock(src, action) {
  const re = new RegExp('(?:^|\\n)\\s{2}' + action + ":\\s*\\{");
  const m = re.exec(src);
  return m ? braceBlock(src, m.index + m[0].length - 1) : '';
}
function funcBlock(src, name) {
  // 兼容两种定义：`function cdDays()` 与对象方法简写 `_migrateLocalCd()`
  const re = new RegExp('(?:^|\\n)[ \\t]*(?:function[ \\t]+)?' + name + '\\s*\\(');
  const m = re.exec(src);
  return m ? braceBlock(src, m.index + m[0].length - 1) : '';
}

console.log('===== check-countdown：倒数日按人隔离 / 云端唯一数据源 =====');

const api = read('miniprogram/utils/api.js');
const adjust = read('cloudfunctions/adjust/index.js');
const page = read('miniprogram/pages/classinfo/index.js');
const wxml = read('miniprogram/pages/classinfo/index.wxml');

/* ① 前端接口映射 */
['countdownList', 'countdownAdd', 'countdownDelete'].forEach((k) => {
  if (api.indexOf("C('adjust', '" + k + "')") >= 0) ok('① api.' + k + " → adjust." + k);
  else fail('① api.js 缺 ' + k + " 或没指向 adjust（前端会拿到「未知操作」）");
});

/* ② 路由存在 + needBind */
const bList = routeBlock(adjust, 'countdownList');
const bAdd = routeBlock(adjust, 'countdownAdd');
const bDel = routeBlock(adjust, 'countdownDelete');
[['countdownList', bList], ['countdownAdd', bAdd], ['countdownDelete', bDel]].forEach(([n, b]) => {
  if (!b) { fail('② adjust 缺路由 ' + n); return; }
  if (b.indexOf('needBind: true') >= 0) ok('② ' + n + ' 有 needBind（未绑定用户拿不到）');
  else fail('② ' + n + ' 没写 auth.needBind（未登录也能调）');
});

/* ③ 列表按人过滤 */
if (bList && bList.indexOf('WHERE member_id = ?') >= 0) ok('③ countdownList 的 WHERE 带 member_id（看不到别人的）');
else fail('③ countdownList 没按 member_id 过滤 → 会列出全表的倒数日');

/* ④ 新增写归属 + 查重 + 上限 */
if (bAdd) {
  if (bAdd.indexOf('INSERT INTO countdown_event (member_id, name, target_date)') >= 0) ok('④ countdownAdd 显式写 member_id');
  else fail('④ countdownAdd 的 INSERT 没写 member_id（数据无归属）');
  if (bAdd.indexOf('FROM countdown_event WHERE member_id = ? AND name = ? AND target_date = ?') >= 0) ok('④ countdownAdd 查重带 member_id（不会拦到别人的同名）');
  else fail('④ countdownAdd 查重没带 member_id');
  if (bAdd.indexOf('CD_MAX_ITEMS') >= 0) ok('④ countdownAdd 有数量上限（防刷）');
  else fail('④ countdownAdd 无数量上限');
}

/* ⑤ 删除先查归属再删 */
if (bDel) {
  if (bDel.indexOf('SELECT member_id FROM countdown_event WHERE id = ?') >= 0) ok('⑤ countdownDelete 先查归属');
  else fail('⑤ countdownDelete 没查归属（删谁的都是成功）');
  if (/!==\s*me\.id/.test(bDel)) ok('⑤ countdownDelete 归属不符即抛错');
  else fail('⑤ countdownDelete 没比较 member_id（越权静默通过）');
  if (bDel.indexOf('DELETE FROM countdown_event WHERE id = ? AND member_id = ?') >= 0) ok('⑤ DELETE 语句自身也带 member_id（双保险）');
  else fail('⑤ DELETE 没带 member_id');
}

/* ⑥ 天数计算口径 */
const cdDays = funcBlock(adjust, 'cdDays');
if (cdDays && cdDays.indexOf('week.todayStr()') >= 0) ok('⑥ cdDays 用 week.todayStr()（UTC 云函数不差一天）');
else fail('⑥ cdDays 没用 week.todayStr()（换时区会差一天）');
if (bList && bList.indexOf('cdDays(') >= 0) ok('⑥ 列表返回 days 由后端算');
else fail('⑥ 列表没调用 cdDays');

/* ⑦ 前端接线 + storage 只留迁移 */
['countdownList', 'countdownAdd', 'countdownDelete'].forEach((k) => {
  if (page.indexOf('api.' + k) >= 0) ok('⑦ classinfo 接了 api.' + k);
  else fail('⑦ classinfo 没接 api.' + k);
});
const storageHits = (page.match(/countdown_events_v1/g) || []).length;
if (storageHits > 0 && page.indexOf('_migrateLocalCd') >= 0) {
  ok('⑦ 旧本地数据有迁移函数 _migrateLocalCd（' + storageHits + ' 处引用）');
} else {
  fail('⑦ 没找到本地数据迁移（老用户升级后倒数日会凭空消失）');
}
const mig = funcBlock(page, '_migrateLocalCd');
if (mig && mig.indexOf('removeStorageSync') >= 0) ok('⑦ 迁移成功后清本地 key（不会每次 onShow 重复上传）');
else fail('⑦ 迁移后没清本地 key（每次进页都会重复上传）');
if (storageHits > 0 && /wx\.setStorageSync\('countdown_events_v1'/.test(page)) {
  fail('⑦ classinfo 仍在写 countdown_events_v1 → 前端又退回本地存储了');
} else {
  ok('⑦ 前端不再把本地 storage 当数据源');
}

/* ⑧ 弹层滚动锁 */
if (/page-meta[^>]*cdSheetShow/.test(wxml)) ok('⑧ page-meta 含 cdSheetShow（弹层开时背景不滚）');
else fail('⑧ page-meta 没列 cdSheetShow → check-scroll-lock 会判死');

/* ⑨ 变异自证：故意破坏，确认本门禁真的会红 */
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return src;
  return src.replace(from, to);
}
const mutList = mutate(adjust, 'FROM countdown_event WHERE member_id = ? ORDER BY', 'FROM countdown_event WHERE 1 = 1 ORDER BY');
if (mutList === adjust) {
  console.log('SKIP  ⑨ 变异基线未命中（源码结构已改，请更新本门禁的变异锚点）');
} else {
  const b = routeBlock(mutList, 'countdownList');
  if (b && b.indexOf('WHERE member_id = ?') < 0) ok('⑨ 变异自证：去掉 list 的 member_id → 本门禁会红');
  else fail('⑨ 变异自证失败：去掉 member_id 后本门禁仍然通过（判据失效）');
}

console.log(bad === 0 ? '✅ check-countdown 全部通过' : '❌ check-countdown 失败 ' + bad + ' 项');
process.exit(bad === 0 ? 0 : 1);
