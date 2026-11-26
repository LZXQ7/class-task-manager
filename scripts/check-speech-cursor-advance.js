#!/usr/bin/env node
/**
 * 离线自检：演讲游标必须「生成即推进」，跨周不能再排出同一批人（2026-11-17 用户报）
 * --------------------------------------------------------------------------------
 * 用户原话：「十一周安排过的，十二周又安排了」。
 *
 * 复现（生产库 class_id=3 实测）：
 *   · 第 10 周已发布 ⇒ speech_cursor = A 27 / B 20；
 *   · 第 11 周生成（草稿）⇒ 只把 A 41 / B 40 写进 speech_publish.pending_cursors，
 *     **游标不动**（旧口径「发布才落游标」）；
 *   · 第 12 周生成 ⇒ 又从 27 / 20 起跑 ⇒ 学号 22/24/26/28… 与 11 周逐条重复。
 *
 * 定规（v3）：
 *   ① 生成/智能排班落库时**立即**把新游标写进 speech_cursor（不再等发布）；
 *   ② 同时把「本周生成前的游标」记进 `speech_publish.base_cursors`：
 *      · 同一周重排 ⇒ 起点永远取 base，还是同一批人（幂等，原口径不变）；
 *      · 下一周生成 ⇒ 读到的是上一周推进后的游标 ⇒ 接着往后排，不重复；
 *      · 清空 / 撤回 ⇒ 游标回滚到 base ⇒ 本周等于没排过；
 *   ③ 手工改起点（speechSetSettings）⇒ 作废该班所有 base，否则手动设置不生效；
 *   ④ 旧记录没有 base ⇒ 退回「发布前当前游标」并把 pending 落库（向后兼容）。
 *
 * 用法：node scripts/check-speech-cursor-advance.js
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

const F = {
  js: 'cloudfunctions/schedule/index.js',
  mig: 'scripts/migrate-speech-base-cursors.sql'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = fs.existsSync(path.join(ROOT, F[k])) ? read(F[k]) : ''; });

/** 抽顶层 `function name(...) {...}` 整段（按花括号配对） */
function fnSource(js, name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0;
  let started = false;
  for (let k = i; k < js.length; k += 1) {
    if (js[k] === '{') { d += 1; started = true; }
    else if (js[k] === '}') { d -= 1; if (started && !d) return js.slice(i, k + 1); }
  }
  return '';
}

/** 抽路由对象里 `name: { ... }` 整段（到下一个同缩进的路由键为止） */
function routeBody(js, name) {
  const anchor = '\n  ' + name + ': {';
  const i = js.indexOf(anchor);
  if (i < 0) return '';
  const rest = js.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/* ── 真跑层：把 startCursorsOf 装进沙盒 ───────────────────────────────── */
function loadFn(js, name, deps) {
  const src = fnSource(stripJs(js), name);
  if (!src) return null;
  try {
    const head = (deps || []).map((d) => fnSource(stripJs(js), d)).join('\n');
    // eslint-disable-next-line no-new-func
    return new Function('console', head + '\n' + src + '\nreturn ' + name + ';')(console);
  } catch (e) {
    return null;
  }
}

/* ── 采集 ─────────────────────────────────────────────────────────────── */
function collect(js) {
  const gen = routeBody(js, 'speechGenerate');
  const clr = routeBody(js, 'speechClear');
  const pub = routeBody(js, 'speechPublish');
  const app = routeBody(js, 'speechAiApply');
  const set = routeBody(js, 'speechSetSettings');
  const Fn = loadFn(js, 'startCursorsOf', []);
  const call = (base, cur) => {
    if (!Fn) return null;
    try { return Fn(base, cur); } catch (e) { return { threw: String(e && e.message) }; }
  };
  const firstGen = call(null, { A: 27, B: 20 });
  const reuseBase = call('{"A":41,"B":40}', { A: 27, B: 20 });
  const reuseAgain = call('{"A":41,"B":40}', { A: 27, B: 20 });
  const dirty = call('{oops', { A: 5, B: 6 });
  const partial = call('{"A":7}', { A: 5, B: 6 });
  /* 跨周推进：11 周（base 27/20 → 排完 41/40）之后再排 12 周，起点必须变成 41/40 */
  const nextWeek = call(null, { A: 41, B: 40 });
  return {
    hasFn: !!fnSource(stripJs(js), 'startCursorsOf'),
    mig: /ADD\s+COLUMN\s+base_cursors/i.test(SRC.mig) && /speech_publish/i.test(SRC.mig),

    /* v4（2026-11-26）：生成改走 generationStartOf(base, prevPending, current)，
     * 权威起点取「上一已生成周」的 pending；v3 旧调用仍算通过（兼容旧版判定）。 */
    genReadsBase: /SELECT\s+base_cursors\s+FROM\s+speech_publish/i.test(gen),
    genBaseWins: /generationStartOf\([^)]*base_cursors[^)]*prevRows\[0\][^)]*pending_cursors[^)]*current\)/.test(gen)
      || /startCursorsOf\(pubRows\[0\]\s*&&\s*pubRows\[0\]\.base_cursors,\s*current\)/.test(gen),
    genAssignUsesStart: /speechCore\.assign\(slots,\s*roster,\s*start\.start/.test(gen),
    genSavesCursor: /saveSpeechCursors\(conn,\s*classId,\s*plan\.cursors\)/.test(gen),
    genSavesBase: /base_cursors\s*=\s*VALUES\(base_cursors\)/.test(gen),

    clearRollback: /cur\.reuse/.test(clr) && /saveSpeechCursors\(pool,\s*classId,\s*cur\.start\)/.test(clr),
    clearResetsBase: /base_cursors\s*=\s*NULL/.test(clr),

    publishSnapBase: /startCursorsOf\(pub\[0\]\s*&&\s*pub\[0\]\.base_cursors,\s*before\)/.test(pub),
    publishLegacy: /!snap\.reuse\s*&&\s*pending/.test(pub),

    aiAdvance: /saveSpeechCursors\(conn,\s*classId,\s*\{\s*A:\s*Number\(pending\.A\)/.test(app),
    aiBase: /generationStartOf\([^)]*base_cursors[^)]*prevRows\[0\][^)]*pending_cursors[^)]*current\)/.test(app)
      || /startCursorsOf\(pubRows\[0\]\s*&&\s*pubRows\[0\]\.base_cursors,\s*current\)/.test(app),

    setClearsBase: /UPDATE\s+speech_publish\s+SET\s+base_cursors\s*=\s*NULL(?:\s*,\s*pending_cursors\s*=\s*NULL)?/i.test(set),

    firstGenStart: firstGen && firstGen.start && firstGen.start.A === 27 && firstGen.start.B === 20,
    firstGenFresh: firstGen && firstGen.reuse === false && firstGen.base && firstGen.base.A === 27,
    reuseStart: reuseBase && reuseBase.start && reuseBase.start.A === 41 && reuseBase.start.B === 40,
    reuseFlag: reuseBase && reuseBase.reuse === true,
    idempotent: reuseAgain && reuseBase && reuseAgain.start.A === reuseBase.start.A
      && reuseAgain.start.B === reuseBase.start.B,
    dirtySafe: dirty && !dirty.threw && dirty.start && dirty.start.A === 5 && dirty.start.B === 6
      && dirty.reuse === false,
    partialA: partial && partial.start && partial.start.A === 7,
    nextWeekAdvances: nextWeek && nextWeek.start && nextWeek.start.A === 41 && nextWeek.start.B === 40,
    /* 关键回归：12 周起点（41/40）必须不等于 11 周起点（27/20） */
    crossWeekDiffers: firstGen && nextWeek && firstGen.start.A !== nextWeek.start.A
  };
}

const S = collect(SRC.js);
console.log('── ① 起点决策函数（真跑）');
check(S.hasFn, 'schedule/index.js 有顶层纯函数 startCursorsOf(baseRaw, current)');
check(S.firstGenStart, '本周首次生成：起点 = 当前游标（27/20）');
check(S.firstGenFresh, '首次生成 reuse=false 且把当前游标记成 base');
check(S.reuseStart, '同周重排：起点回到 base（41/40），不跳到别处');
check(S.reuseFlag, '重排时 reuse=true（清空回滚据此判断 base 是否可信）');
check(S.idempotent, '同一 base 反复取起点结果一致（重排幂等）');
check(S.dirtySafe, 'base 是坏 JSON ⇒ 按当前游标起跑，不抛错');
check(S.partialA, 'base 缺字段 ⇒ 缺的那组按 0 处理，不串组');
check(S.nextWeekAdvances, '上一周排到 41/40 后，下一周起点是 41/40');
check(S.crossWeekDiffers, '★ 跨周起点必须不同于首周起点（不许两周都从 27/20 起跑）');

console.log('\n── ② 一键生成');
check(S.genReadsBase, 'speechGenerate 读 speech_publish.base_cursors');
check(S.genBaseWins, '重排同周时起点优先取 base_cursors');
check(S.genAssignUsesStart, '轮转取人用的是 start.start（不是裸游标）');
check(S.genSavesCursor, '生成后立即把新游标写回 speech_cursor（不等发布）');
check(S.genSavesBase, '生成时把「本周之前的游标」写进 base_cursors');

console.log('\n── ③ 清空 / 发布 / 撤回');
check(S.clearRollback, '清空：base 可信时把游标回滚到 base（重排得同一批人）');
check(S.clearResetsBase, '清空：base_cursors 置 NULL，下次生成重新记快照');
check(S.publishSnapBase, '发布：撤回快照取 base_cursors（本周之前的游标）');
check(S.publishLegacy, '发布：旧记录没 base 时才把 pending 落到游标（向后兼容）');

console.log('\n── ④ 智能排班 / 手工改起点');
check(S.aiBase, 'speechAiApply 同样读 base_cursors 决定起点');
check(S.aiAdvance, 'speechAiApply 落库后同样推进 speech_cursor');
check(S.setClearsBase, 'speechSetSettings 作废该班 base（否则手动设置不生效）');

console.log('\n── ⑤ 迁移脚本');
check(S.mig, 'scripts/migrate-speech-base-cursors.sql 给 speech_publish 加 base_cursors');

/* ── 变异自证 ─────────────────────────────────────────────────────────── */
console.log('\n── ⑥ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '生成不读 base（每周都从当前游标重排 ⇒ 又重复）', probe: ['genBaseWins', 'aiBase'],
    apply: (s) => s
      .replace(/generationStartOf\([^)]*base_cursors[^)]*prevRows\[0\][^)]*pending_cursors[^)]*current\)/g,
        'generationStartOf(null, null, current)')
      .split('startCursorsOf(pubRows[0] && pubRows[0].base_cursors, current)')
      .join('startCursorsOf(null, current)') },
  { name: '生成后不推进游标（回到「发布才落」的老口径）', probe: ['genSavesCursor'],
    apply: (s) => s.replace('await saveSpeechCursors(conn, classId, plan.cursors);', '') },
  { name: '生成时不记 base（同周重排会跳到下一批人）', probe: ['genSavesBase'],
    apply: (s) => s.split('base_cursors = VALUES(base_cursors)').join('pending_cursors = VALUES(pending_cursors)') },
  { name: '清空不回滚游标（本周白排的号被永久跳过）', probe: ['clearRollback'],
    apply: (s) => s.replace('if (cur.reuse) await saveSpeechCursors(pool, classId, cur.start);', '') },
  { name: '撤回快照改回「发布前当前游标」（撤回后重排又换人）', probe: ['publishSnapBase'],
    apply: (s) => s.replace('startCursorsOf(pub[0] && pub[0].base_cursors, before)', 'startCursorsOf(null, before)') },
  { name: '智能排班落库不推进游标', probe: ['aiAdvance'],
    apply: (s) => s.replace('await saveSpeechCursors(conn, classId, { A: Number(pending.A) || 0, B: Number(pending.B) || 0 });', '') },
  { name: '手工改起点不作废 base/pending（重排仍从旧位置起跑）', probe: ['setClearsBase'],
    apply: (s) => s.replace('UPDATE speech_publish SET base_cursors = NULL, pending_cursors = NULL WHERE class_id = ?', '') },
  { name: '起点函数忽略 base（恒用当前游标）', probe: ['reuseStart', 'idempotent'],
    apply: (s) => s.replace('return { start: base, base, reuse: true };', 'return { start: cur, base: cur, reuse: true };') },
  { name: 'base 坏 JSON 直接抛（排班整个挂掉）', probe: ['dirtySafe'],
    apply: (s) => s.replace("    } catch (e) {\n      base = null;\n      console.error('base_cursors 解析失败，按当前游标起跑', e && e.message);\n    }",
      '    } catch (e) {\n      throw e;\n    }') }
];

let caught = 0;
MUT.forEach((m) => {
  const mutated = m.apply(SRC.js);
  if (mutated === SRC.js) {
    console.log('  ✗ 变异「' + m.name + '」没改动任何源码（锚点失配）');
    failed += 1;
    return;
  }
  const P = collect(mutated);
  const hit = m.probe.filter((k) => !P[k]);
  if (hit.length) {
    caught += 1;
    console.log('  ✓ 抓住：' + m.name + ' → ' + hit.join(' / '));
  } else {
    console.log('  ✗ 漏抓：' + m.name + '（判据仍全绿）');
    failed += 1;
  }
});
console.log('\n  变异捕获 ' + caught + '/' + MUT.length);

console.log('\n' + (failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'));
process.exit(failed ? 1 : 0);
