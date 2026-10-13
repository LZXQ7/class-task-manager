/**
 * check-duty-ended.js ——「本周值日 · 已结束折叠」门禁（#55，2026-10-04）
 *
 * 需求（2026-10-04）：本周值日的「按日」列表里，**早于今天**的日子收进顶部「已结束」弹层，
 *   不占主列表。今天是 9/29 → 9/28 及以前进「已结束」。
 *
 * 为什么必须单独守：这条功能**不报错、不崩溃**，坏掉的样子只是「过去的日子又回来占位」。
 *   真实 lanes 有三条，每条都能被一次无辜的改动悄悄拨回去：
 *     ① 渲染源被改回 `days`（主列表就又把整周画出来，已结束形同虚设）；
 *     ② `String(d.date) < today` 被写成 `<=` 或去掉等号那一侧（**今天被折走**，当天的值日要看还得进弹层）；
 *     ③ `isCurrentWeek ? … : …` 被揉平（切到历史周时被抽成空列表 —— 历史周本就是回顾，不该被折叠）。
 *   另外 `_toPersons(days)` 必须用**整周** days：按人视图的规矩是「整周不变」，
 *   若手滑喂了 activeDays，周初那几天的人会从按人视图里凭空消失。
 *
 * 判据：
 *   A（结构）「按日」区块的渲染源是 activeDays，且其中不得出现 wx:for="{{days}}"；
 *   B（结构）「已结束」入口：同一节点上同时挂着 bindtap="onEndedOpen" 与
 *           含 mode === 'day' 和 pastDays.length 的 wx:if（写在 JS 里的互斥条件不许缺）；
 *   C（结构）弹层内的 pastDays 卡不含「加值日生」（过去的日子不再补排）；
 *   D（结构）JS 侧有 onEndedOpen / onEndedClose，且空列表时直接 return（不弹空层）；
 *   E～G（**行为级**，把真实 `_paint` 源码抽出来在内存里跑）：
 *     E 本周 → 早于今天进 pastDays、今天及以后进 activeDays（今天必须留在主列表）；
 *     F 非本周 → pastDays 为空、activeDays 为整周；
 *     G `_toPersons` 在两种情况下都收到**整周** days，且 setData 仍下发整周 days。
 *
 * 变异自证（全部在内存里重写源码字符串，**绝不落盘**）：
 *   `< today` → `<= today`（今天被折走）            → E 翻红
 *   三元 folds 成无条件过滤（历史周也被折）         → F 翻红
 *   `_toPersons(days)` → `_toPersons(activeDays)`   → G 翻红
 *   主列表 `wx:for="{{activeDays}}"` → `{{days}}`    → A 翻红
 *   入口去掉 mode === 'day' 条件                     → B 翻红
 *   弹层里塞回 onAddOpen                             → C 翻红
 *   onEndedOpen 去掉空列表 guard                     → D 翻红
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'miniprogram', 'pages', 'duty', 'index.js');
const WXML = path.join(ROOT, 'miniprogram', 'pages', 'duty', 'index.wxml');

const jsSrc = fs.readFileSync(JS, 'utf8');
const wxmlRaw = fs.readFileSync(WXML, 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const assertTrue = (cond, msg) => { if (cond) ok(msg); else bad(msg); };

/* ---------------- 通用小工具 ---------------- */

/** 剥掉 WXML 注释（注释里会「引用」真实标签，不剥会被当成真节点 → 假通过/假失败） */
function stripComments(s) { return String(s || '').replace(/<!--[\s\S]*?-->/g, ''); }
const wxml = stripComments(wxmlRaw);

/** 从 startIdx 起做花括号配对，返回完整块文本（含首尾花括号） */
function braceBlock(src, startIdx) {
  const open = src.indexOf('{', startIdx);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/** 取一个以 head（必须自带 '{'）开头的方法的完整源码文本 */
function methodSrc(src, head) {
  const hs = src.indexOf(head);
  if (hs < 0) return '';
  const body = braceBlock(src, hs);
  if (!body) return '';
  return src.slice(hs, hs + (head.length - 1) + body.length);
}

/** 按 <!-- --> 无关的方式取 WXML 两个标记之间的片段 */
function between(text, from, to) {
  const i = text.indexOf(from);
  if (i < 0) return '';
  const j = text.indexOf(to, i + from.length);
  return j < 0 ? text.slice(i + from.length) : text.slice(i + from.length, j);
}

/* ============================ A. 主列表渲染源 ============================ */
const dayBlock = between(wxml, '<block wx:if="{{mode === \'day\'}}">', '<block wx:else>');
assertTrue(
  dayBlock.length > 0,
  'A0 找到「按日」区块（<block wx:if="{{mode === \'day\'}}"> … <block wx:else>）'
);
assertTrue(
  /wx:for\s*=\s*"\{\{activeDays\}\}"/.test(dayBlock),
  'A1 「按日」主列表的渲染源是 activeDays（不是整周 days）'
);
assertTrue(
  !/wx:for\s*=\s*"\{\{days\}\}"/.test(dayBlock),
  'A2 「按日」区块里没有再用整周 days 做渲染源（否则过去的日子会重新占位）'
);

/* ============================ B. 已结束入口 ============================ */
/** 找出所有含 bindtap="onEndedOpen" 的标签文本 */
function tagsWith(text, attrRe) {
  const out = [];
  const re = /<view\b[\s\S]*?>/g;
  let m;
  while ((m = re.exec(text))) { if (attrRe.test(m[0])) out.push(m[0]); }
  return out;
}
const entryTags = tagsWith(wxml, /bindtap\s*=\s*"onEndedOpen"/);
assertTrue(entryTags.length === 1, 'B0 页面上恰好一个「已结束」入口（实得 ' + entryTags.length + ' 个）');
const entryTag = entryTags[0] || '';
assertTrue(
  /wx:if\s*=\s*"[^"]*mode\s*===\s*'day'[^"]*"/.test(entryTag)
  || /wx:if\s*=\s*"[^"]*mode === \\?'day\\?'[^"]*"/.test(entryTag),
  "B1 入口有 mode === 'day' 条件（「按人」视图不显示这个入口）"
);
assertTrue(
  /wx:if\s*=\s*"[^"]*pastDays\.length[^"]*"/.test(entryTag),
  'B2 入口有 pastDays.length 条件（没有已结束的日子时不渲染空入口）'
);

/* ============================ C. 弹层不含「加值日生」 ============================ */
const endedSheet = between(wxml, '<bottom-sheet show="{{endedSheetShow}}"', '</bottom-sheet>');
assertTrue(endedSheet.length > 0, 'C0 找到「已结束」弹层（bottom-sheet show="{{endedSheetShow}}"）');
assertTrue(
  /wx:for\s*=\s*"\{\{pastDays\}\}"/.test(endedSheet),
  'C1 弹层内渲染的是 pastDays'
);
assertTrue(
  !/onAddOpen/.test(endedSheet),
  'C2 弹层里没有「加值日生」入口（过去的日子不再补排）'
);

/* ============================ D. JS 侧开关 ============================ */
const openSrc = methodSrc(jsSrc, 'onEndedOpen() {');
const closeSrc = methodSrc(jsSrc, 'onEndedClose() {');
assertTrue(
  /endedSheetShow\s*:\s*true/.test(openSrc),
  'D1 onEndedOpen 打开弹层（endedSheetShow: true）'
);
assertTrue(
  /endedSheetShow\s*:\s*false/.test(closeSrc),
  'D2 onEndedClose 收起弹层（endedSheetShow: false）——拖下关闭走 bind:close，别把它删了'
);
assertTrue(
  /pastDays\.length/.test(openSrc),
  'D3 onEndedOpen 对空列表有 guard（没有已结束的日子时不弹空层）'
);

/* ============================ E~G. 行为级（跑真 _paint） ============================ */
const paintSrc = methodSrc(jsSrc, '_paint(r) {');
assertTrue(paintSrc.length > 0, 'BG0 取到 pages/duty 的 _paint 方法体（锚点带花括号）');

const TODAY = '2026-09-29';
const WEEK_DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];

/**
 * 在内存里加载一段 _paint 源码，用一个假 this 真跑一遍，返回它喂出来的东西。
 * @param {string} src  _paint 的完整源码文本
 * @param {object} ctx  { week, current, days }
 */
function runPaint(src, ctx) {
  const utilStub = { fmtDate: () => TODAY };
  const fn = new Function('util', '"use strict"; return function ' + src + ';')(utilStub);
  const got = { patch: null, personsArg: null, decorated: null };
  const self = {
    data: { week: ctx.week, current: ctx.current },
    _hasData: false,
    _decorate: (d) => { got.decorated = d; return d; },
    _toPersons: (d) => { got.personsArg = d; return []; },
    setData: (patch) => { got.patch = patch; },
    _resizeMain: () => {}
  };
  fn.call(self, { days: ctx.days });
  return got;
}

const mkDays = () => WEEK_DAYS.map(d => ({ date: d }));

/** 本周转出来的划分必须恰好是：past=[昨天]，active=[今天、明天、后天]（**完整划分**判据） */
function weekSplitInvariant(src) {
  const r = runPaint(src, { week: 5, current: 5, days: mkDays() });
  const past = JSON.stringify((r.patch.pastDays || []).map(d => d.date));
  const active = JSON.stringify((r.patch.activeDays || []).map(d => d.date));
  return past === JSON.stringify(['2026-09-28'])
    && active === JSON.stringify(['2026-09-29', '2026-09-30', '2026-10-01']);
}

/* E：本周 → 今天及以后留在主列表，早于今天进弹层 */
const cur = runPaint(paintSrc, { week: 5, current: 5, days: mkDays() });
const pastDates = (cur.patch.pastDays || []).map(d => d.date);
const activeDates = (cur.patch.activeDays || []).map(d => d.date);
assertTrue(
  JSON.stringify(pastDates) === JSON.stringify(['2026-09-28']),
  'E1 本周：早于今天的日子进入 pastDays（实得 ' + JSON.stringify(pastDates) + '）'
);
assertTrue(
  JSON.stringify(activeDates) === JSON.stringify(['2026-09-29', '2026-09-30', '2026-10-01']),
  'E2 本周：**今天必须留在主列表**（实得 ' + JSON.stringify(activeDates) + '）'
);

/* F：非本周 → 不折，整周全量进主列表 */
const hist = runPaint(paintSrc, { week: 3, current: 5, days: mkDays() });
assertTrue(
  (hist.patch.pastDays || []).length === 0,
  'F1 历史周：pastDays 为空（切到历史周不该再折，历史周本身就是回顾）'
);
assertTrue(
  JSON.stringify((hist.patch.activeDays || []).map(d => d.date)) === JSON.stringify(WEEK_DAYS),
  'F2 历史周：整周都进主列表'
);

/* G：两种情况下 _toPersons 都拿整周，且 setData 仍下发整周 days */
assertTrue(
  JSON.stringify((cur.personsArg || []).map(d => d.date)) === JSON.stringify(WEEK_DAYS)
  && JSON.stringify((hist.personsArg || []).map(d => d.date)) === JSON.stringify(WEEK_DAYS),
  'G1 按人视图用**整周** days 取数（本周与历史周一致，不可喂 activeDays）'
);
assertTrue(
  JSON.stringify((cur.patch.days || []).map(d => d.date)) === JSON.stringify(WEEK_DAYS)
  && JSON.stringify((hist.patch.days || []).map(d => d.date)) === JSON.stringify(WEEK_DAYS),
  'G2 底层 days 保持整周不动（各处 handler 依赖它）'
);

/* ============================ 变异自证 ============================ */
/** 行为级变异：改源码重跑，断言必须翻红 */
function proveBehavioral(label, mutate, predicate) {
  const before = predicate(paintSrc);
  const mutated = mutate(paintSrc);
  if (mutated === paintSrc) { bad('自证：' + label + ' 变异没生效（源码没被改动，等于没自证）'); return; }
  let after = null, err = null;
  try { after = predicate(mutated); } catch (e) { err = e; }
  if (before === true && after === false) ok('自证：' + label + ' 坏样本会被抓（判据非假通过）');
  else bad('自证：' + label + ' 变异后未翻转（before=' + before + ' after=' + after + (err ? ' err=' + err.message : '') + '）');
}

/* ---- 变异：今天的归属必须唯一（既不能被折走，也不能两边都丢） ----
   注意：单看 activeDays 是抓不到「pastDays 的 < 写成 <=」的（今天会出现在**两个**列表里，
   activeDays 那侧压根没变）—— 所以这里的判据取 **past + active 的完整划分**，不许任何一侧独立通过。 */
proveBehavioral(
  '今天被折走 / 两边重复（pastDays 的 < 写成 <=）',
  (s) => s.replace('String(d.date) < today', 'String(d.date) <= today'),
  weekSplitInvariant
);

proveBehavioral(
  '今天两边都丢（activeDays 的 >= 写成 >）',
  (s) => s.replace('String(d.date) >= today', 'String(d.date) > today'),
  weekSplitInvariant
);

proveBehavioral(
  '历史周也被折（三元揉平，不看是否本周）',
  (s) => s.replace(
    'const pastDays = isCurrentWeek ? days.filter(d => String(d.date) < today) : [];',
    'const pastDays = days.filter(d => String(d.date) < today);'
  ),
  (s) => runPaint(s, { week: 3, current: 5, days: mkDays() }).patch.pastDays.length === 0
);

proveBehavioral(
  '按人视图被喂 activeDays（喂不该截断的数据）',
  (s) => s.replace('persons: this._toPersons(days)', 'persons: this._toPersons(activeDays)'),
  (s) => {
    const r = runPaint(s, { week: 5, current: 5, days: mkDays() });
    return JSON.stringify((r.personsArg || []).map(d => d.date)) === JSON.stringify(WEEK_DAYS);
  }
);

/** 结构级变异：改 WXML 重判，断言必须翻红 */
function proveStructural(label, mutate, predicate) {
  const before = predicate(wxml);
  const mutated = mutate(wxml);
  if (mutated === wxml) { bad('自证：' + label + ' 变异没生效（源码没被改动，等于没自证）'); return; }
  const after = predicate(mutated);
  if (before === true && after === false) ok('自证：' + label + ' 坏样本会被抓（判据非假通过）');
  else bad('自证：' + label + ' 变异后未翻转（before=' + before + ' after=' + after + '）');
}

proveStructural(
  '主列表改回渲染整周 days',
  (t) => t.replace('wx:for="{{activeDays}}" wx:key="date" class="dt-daycard card"',
    'wx:for="{{days}}" wx:key="date" class="dt-daycard card"'),
  (t) => {
    const blk = between(t, '<block wx:if="{{mode === \'day\'}}">', '<block wx:else>');
    return /wx:for\s*=\s*"\{\{activeDays\}\}"/.test(blk) && !/wx:for\s*=\s*"\{\{days\}\}"/.test(blk);
  }
);

proveStructural(
  "入口去掉 mode === 'day' 条件",
  (t) => t.replace('wx:if="{{mode === \'day\' && pastDays.length}}"', 'wx:if="{{pastDays.length}}"'),
  (t) => {
    const tags = tagsWith(t, /bindtap\s*=\s*"onEndedOpen"/);
    const tag = tags[0] || '';
    return (/\bmode\s*===\s*'day'/.test(tag)) && /pastDays\.length/.test(tag);
  }
);

proveStructural(
  '弹层塞回「加值日生」入口',
  // 用「同一把尺子」注入：先用 between 量出弹层本体再贴回去，保证注入点落在判据量的那段里
  (t) => {
    const sh = between(t, '<bottom-sheet show="{{endedSheetShow}}"', '</bottom-sheet>');
    return t.replace(sh, sh + '\n<view bindtap="onAddOpen">加值日生</view>');
  },
  (t) => {
    const sh = between(t, '<bottom-sheet show="{{endedSheetShow}}"', '</bottom-sheet>');
    return !/onAddOpen/.test(sh);
  }
);

/* 上面 4 条 proveBehavioral / 3 条 proveStructural 覆盖了 A~C 与 E~G。
   D 的 guard 在 JS 里，结构性变异套路不适用，单列一段： */
(function proveGuard() {
  const before = /pastDays\.length/.test(openSrc);
  const mutated = openSrc.replace(/if \(!this\.data\.pastDays\.length\) return;/, '');
  const after = /pastDays\.length/.test(mutated);
  // 严格一点：mutation 生效 + 判据翻转
  if (mutated === openSrc) { bad('自证：onEndedOpen guard 变异没生效（匹配不到 guard 源码）'); return; }
  if (before === true && after === false) ok('自证：onEndedOpen 去掉空列表 guard 会被抓');
  else bad('自证：onEndedOpen guard 变异未翻转（before=' + before + ' after=' + after + '）');
})();

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
} else {
  console.log('✅ 本周值日「已结束」折叠门禁全部通过');
}
