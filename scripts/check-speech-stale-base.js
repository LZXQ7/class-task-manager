#!/usr/bin/env node
/**
 * 离线自检：演讲「未来周被提前生成」留下的陈旧 base 不得压过真实续排位置（2026-11-26 用户报）
 * --------------------------------------------------------------------------------
 * 用户原话：「十二周却从 b 组 22 号 a 组 49 号开始了」。
 *
 * 生产实证（class_id=3，只读查询）：
 *   wk11 pending {A:41,B:40} / wk12 pending {A:5,B:52}（已发布，真实排完位置）
 *   wk13 base {A:47,B:20}（wk10 提前生成留下的陈旧快照）⇒ 起点被拽回 ⇒ B22/A49
 *   离线全量名册回放（scripts/_repro_stale_base.js）逐条复现截图：12-07 B22/24、12-08 A49/51。
 *
 * 定规（v4）：生成起点 = 「周次小于本周、已生成过的最大那周」的 pending_cursors。
 *   · 同周重排：上一周 pending 不变 ⇒ 还是同一批人（幂等）；
 *   · 跨周续排：上一周排完的位置 ⇒ 接着排，不重复；
 *   · 未来周提前生成：自身 base 陈旧被无视，按上一周 pending 重排；
 *   · 手工改起点：speechSetSettings 同时清 base_cursors + pending_cursors ⇒ 新起点生效。
 *   · 清空 / 撤回回滚仍走 startCursorsOf(v3)，本门禁反向锁定不许误改。
 *
 * 用法：node scripts/check-speech-stale-base.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/* 2026-11-28 抽共享层：游标纯函数上移到 speech-core.js。
 * 拼接两份源码：函数体真跑/变异从 speech-core 命中，路由体判据从 schedule 命中。 */
const JS = read('cloudfunctions/schedule/index.js') + '\n' + read('cloudfunctions/common/speech-core.js');

function fnSource(js, name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, started = false;
  for (let k = i; k < js.length; k += 1) {
    if (js[k] === '{') { d += 1; started = true; }
    else if (js[k] === '}') { d -= 1; if (started && !d) return js.slice(i, k + 1); }
  }
  return '';
}
function routeBody(js, name) {
  const i = js.indexOf('\n  ' + name + ': {');
  if (i < 0) return '';
  const rest = js.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
function loadFns(js, names) {
  try {
    const head = names.map(n => fnSource(stripJs(js), n)).filter(Boolean).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function('console', head + '\nreturn {' + names.join(',') + '};')(console);
  } catch (e) { return null; }
}

const F = loadFns(JS, ['parseCursorPair', 'generationStartOf']);
const call = (base, prev, current) => {
  if (!F || !F.generationStartOf) return null;
  try { return F.generationStartOf(base, prev, current); } catch (e) { return { threw: String(e && e.message) }; }
};

/* 生产回放（prev = wk12 pending；base = wk13 的陈旧 base；current = 被 wk13 写脏的游标） */
const stale = call('{"A":47,"B":20}', '{"A":5,"B":52}', { A: 5, B: 40 });
/* 同周重排（prev 仍 wk12 pending）⇒ 必须仍是同一批人 */
const sameWeek = call('{"A":47,"B":20}', '{"A":5,"B":52}', { A: 31, B: 4 });
/* 倒回去重排 wk12：prev = wk11 pending A41/B40 ⇒ 与 wk12 原 base 一致（幂等不被破坏） */
const replayOld = call('{"A":41,"B":40}', '{"A":41,"B":40}', { A: 5, B: 52 });
/* 首周：没有上一已生成周，也没有自身 base ⇒ 用当前游标 */
const first = call(null, null, { A: 3, B: 2 });
/* 脏 prev（坏 JSON）⇒ 安全回落当前游标，不抛错 */
const dirtyPrev = call('{"A":47,"B":20}', '{oops', { A: 5, B: 40 });
/* 手工改起点：base/pending 都被清 ⇒ 用当前（新设的）游标 */
const manualStart = call(null, null, { A: 3, B: 54 });

const gen = routeBody(JS, 'speechGenerate');
const ai = routeBody(JS, 'speechAiApply');
const set = routeBody(JS, 'speechSetSettings');
const clr = routeBody(JS, 'speechClear');

console.log('── ① 起点决策函数（真跑生产回放）');
check(!!F && !!F.generationStartOf, 'speech-core.js 有纯函数 generationStartOf(base, prev, current)（共用真源）');
check(stale && !stale.threw && stale.start && stale.start.A === 5 && stale.start.B === 52,
  '★ 陈旧 base A47/B20 被 wk12 pending A5/B52 纠正（否则 B22/A49 重现）');
check(stale && stale.reuse === true && stale.stale === true, '陈旧 base 标 stale=true（日志可追）但仍采纳权威 prev');
check(sameWeek && sameWeek.start && sameWeek.start.A === 5 && sameWeek.start.B === 52,
  '同周重排不因游标已被后续周改动而换人（幂等保持）');
check(replayOld && replayOld.start && replayOld.start.A === 41 && replayOld.start.B === 40,
  '倒回去重排旧周（wk12）仍是原起点 A41/B40（向后重排不破坏幂等）');
check(first && first.start && first.start.A === 3 && first.start.B === 2,
  '首周无 prev 无 base ⇒ 按当前游标起跑');
check(dirtyPrev && dirtyPrev.start && dirtyPrev.start.A === 5 && dirtyPrev.start.B === 40 && !dirtyPrev.threw,
  'prev 是脏 JSON ⇒ 安全回落当前游标，不抛错');
check(manualStart && manualStart.start && manualStart.start.A === 3 && manualStart.start.B === 54,
  '手工改起点后按新游标续排');

console.log('\n── ② 生成/智能排班接线');
check(/SELECT\s+base_cursors\s+FROM\s+speech_publish\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+week\s*=\s*\?/.test(gen),
  'speechGenerate 读本周 base_cursors');
check(/SELECT\s+pending_cursors\s+FROM\s+speech_publish\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+week\s*<\s*\?[\s\S]{0,120}ORDER\s+BY\s+week\s+DESC\s+LIMIT\s+1/.test(gen),
  'speechGenerate 取上一已生成周的 pending_cursors（权威起点）');
check(/generationStartOf\(pubRows\[0\]\s*&&\s*pubRows\[0\]\.base_cursors\s*,\s*prevRows\[0\]\s*&&\s*prevRows\[0\]\.pending_cursors\s*,\s*current\)/.test(gen),
  'speechGenerate 把 prev 传给 generationStartOf');
check(/speechCore\.assign\(slots,\s*roster,\s*start\.start/.test(gen), '轮转取人用 start.start');
check(/saveSpeechCursors\(conn,\s*classId,\s*plan\.cursors\)/.test(gen), '生成即推进游标');
check(/SELECT\s+pending_cursors\s+FROM\s+speech_publish\s+WHERE\s+class_id\s*=\s*\?\s+AND\s+week\s*<\s*\?/.test(ai)
  && /generationStartOf\(pubRows\[0\]\s*&&\s*pubRows\[0\]\.base_cursors\s*,\s*prevRows\[0\]\s*&&\s*prevRows\[0\]\.pending_cursors\s*,\s*current\)/.test(ai),
  'speechAiApply 同口径取 prev 并接线');

console.log('\n── ③ 手工改起点 / 回滚路径');
check(/UPDATE\s+speech_publish\s+SET\s+base_cursors\s*=\s*NULL,\s*pending_cursors\s*=\s*NULL\s+WHERE\s+class_id\s*=\s*\?/i.test(set),
  '手工改起点同时清 base 与 pending（否则新起点被 prev 冲掉）');
check(/startCursorsOf\(pub\[0\]\s*&&\s*pub\[0\]\.base_cursors,\s*\{ A: 0, B: 0 \}\)/.test(clr),
  'speechClear 仍用 startCursorsOf 回滚到 base');
check(/startCursorsOf\(pub\[0\]\s*&&\s*pub\[0\]\.base_cursors,\s*before\)/.test(JS),
  'speechPublish 撤回快照仍用 startCursorsOf');

/* ── 变异自证 ─────────────────────────────────────────────────────────── */
const MUT_ANCHOR = '  const expected = prev || base;';
console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '退回 v3：无视 prev 只用自身 base（用户报的 bug 原样复现）', probe: ['staleSafe'],
    apply: (s) => s.replace(MUT_ANCHOR, '  const expected = base;') },
  { name: '无视 prev 与 base，恒用当前游标（同周重排换人）', probe: ['sameWeekIdem'],
    apply: (s) => s.replace(MUT_ANCHOR, '  const expected = cur;') },
  { name: '脏 prev 不设防（解析失败仍继续）', probe: ['dirtySafe'],
    apply: (s) => s.replace('  if (prevRaw && !prev) return { start: cur, base: cur, reuse: false, stale: true };', '') },
  { name: '生成仍用本周 pending 当权威（未来周自证清白）', probe: ['genPrevWired'],
    apply: (s) => s.split('prevRows[0] && prevRows[0].pending_cursors, current)')
      .join('pubRows[0] && pubRows[0].pending_cursors, current)') },
  { name: '手工改起点只清 base 不清 pending', probe: ['setClearsBoth'],
    apply: (s) => s.replace('UPDATE speech_publish SET base_cursors = NULL, pending_cursors = NULL WHERE class_id = ?',
      'UPDATE speech_publish SET base_cursors = NULL WHERE class_id = ?') }
];
const collect = (js) => {
  const f = loadFns(js, ['parseCursorPair', 'generationStartOf']);
  const cg = (b, p, c) => {
    if (!f || !f.generationStartOf) return null;
    try { return f.generationStartOf(b, p, c); } catch (e) { return { threw: 1 }; }
  };
  const s = cg('{"A":47,"B":20}', '{"A":5,"B":52}', { A: 5, B: 40 });
  const w = cg('{"A":47,"B":20}', '{"A":5,"B":52}', { A: 31, B: 4 });
  const d = cg('{"A":47,"B":20}', '{oops', { A: 5, B: 40 });
  const g = routeBody(js, 'speechGenerate');
  return {
    staleSafe: !!(s && s.start && s.start.A === 5 && s.start.B === 52),
    sameWeekIdem: !!(w && w.start && w.start.A === 5 && w.start.B === 52),
    dirtySafe: !!(d && d.start && d.start.A === 5 && d.start.B === 40 && !d.threw),
    genPrevWired: /generationStartOf\(pubRows\[0\]\s*&&\s*pubRows\[0\]\.base_cursors\s*,\s*prevRows\[0\]\s*&&\s*prevRows\[0\]\.pending_cursors\s*,\s*current\)/.test(g),
    setClearsBoth: /UPDATE\s+speech_publish\s+SET\s+base_cursors\s*=\s*NULL,\s*pending_cursors\s*=\s*NULL\s+WHERE\s+class_id\s*=\s*\?/i.test(routeBody(js, 'speechSetSettings'))
  };
};
let caught = 0;
MUT.forEach((m) => {
  const mutated = m.apply(JS);
  if (mutated === JS) { console.log('  ✗ 变异「' + m.name + '」锚点失配，未改动源码'); failed += 1; return; }
  const P = collect(mutated);
  const hit = m.probe.filter(k => !P[k]);
  if (hit.length) { caught += 1; console.log('  ✓ 抓住：' + m.name + ' → ' + hit.join(' / ')); }
  else { console.log('  ✗ 漏抓：' + m.name); failed += 1; }
});
console.log('\n  变异捕获 ' + caught + '/' + MUT.length);
console.log('\n' + (failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'));
process.exit(failed ? 1 : 0);
