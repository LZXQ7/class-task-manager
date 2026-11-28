#!/usr/bin/env node
/**
 * 门禁：演讲排班页「同一时段两节课」修复（1.0.8.68）
 * --------------------------------------------------------------------------------
 * 用户报：演讲排班页周三下午「小学生心理健康」出现两条（全体 + A组），
 * 周四下午「习近平新时代」出现两条空场。真因两层：
 *   ① loadSpeechSessions（speechBoard 场次骨架来源）漏了 week.matchesWeeks 过滤 ——
 *      隔周课单周/双周各一条 session 全被列出（生成端 speechCore.buildSlots 有这层，展示端没有）；
 *   ② speechBoard 的人按 date|slot 归组、丢了 scope —— A/B 组同场会串人。
 * 修法：① 源头过滤周次；② 归组 key 带 scope，取人 key 同步。
 *
 * 判据覆盖 + 变异自证：改坏任一处 → 对应判据翻红。
 * 用法：node scripts/check-speech-board-week-filter.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = 'cloudfunctions/schedule/index.js';
const SRC = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/** 抽顶层 `function name(...) {...}` 整段（按花括号配对） */
function fnBodyOf(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) return { body: '', start: -1, end: -1 };
  let d = 0, started = false;
  for (let k = s; k < src.length; k += 1) {
    if (src[k] === '{') { d += 1; started = true; }
    else if (src[k] === '}') { d -= 1; if (started && !d) return { body: src.slice(s, k + 1), start: s, end: k + 1 }; }
  }
  return { body: '', start: -1, end: -1 };
}

function evalAll(src) {
  /* 2026-11-28：周次过滤实体从 loadSpeechSessions 内联抽到共享落位函数
     speechSessionSlot（三处同源）。判据绑「实体」：过滤在落位函数里 + loadSpeechSessions
     调用该函数；不再绑具体函数名/位置，避免重构后假红。 */
  const slotBody = fnBodyOf(src, 'speechSessionSlot').body;
  const lsBody = fnBodyOf(src, 'loadSpeechSessions').body;

  const sbStart = src.indexOf('  speechBoard: {');
  const re = /\n  [A-Za-z_$][\w$]*:\s*\{/g;
  re.lastIndex = sbStart + 1;
  const sbNext = re.exec(src);
  const sbBody = sbStart < 0 ? '' : src.slice(sbStart, sbNext ? sbNext.index : undefined);
  const byKeyBlock = (sbBody.match(/const byKey = \{[\s\S]*?\n      \}\);/) || [''])[0];

  return {
    lsHasFilter: /week\.matchesWeeks\s*\(\s*s\.weeks\s*,\s*wk\s*,\s*s\.week_rule\s*\)/.test(slotBody),
    lsFilterBeforePush: filterBeforeReturn(slotBody),
    loadUsesSlot: /speechSessionSlot\s*\(/.test(lsBody),
    byKeyHasScope: /const scope = r\.scope\s*===\s*'A'/.test(byKeyBlock)
      && /const key = date \+ '\|' \+ r\.slot \+ '\|' \+ scope/.test(byKeyBlock),
    memberUsesScope: /byKey\[date \+ '\|' \+ slot \+ '\|' \+ scope\]/.test(sbBody),
    noOldKey: !/byKey\[date \+ '\|' \+ slot\]/.test(sbBody)
  };
}
function filterBeforeReturn(body) {
  const i = body.indexOf('matchesWeeks');
  const j = body.indexOf('return Object.assign');
  if (i >= 0 && j >= 0) return i < j;
  // 兼容旧内联形态（out.push）
  const k = body.indexOf('out.push');
  return i >= 0 && k >= 0 && i < k;
}

const S = evalAll(SRC);

console.log('── ① 演讲场次源头过滤周次（隔周课不再重复）');
check(S.lsHasFilter, '共享落位函数 speechSessionSlot 调用 week.matchesWeeks(s.weeks, wk, s.week_rule)');
check(S.lsFilterBeforePush, '周次过滤在构造场次项之前（非本周课次不进骨架）');
check(S.loadUsesSlot, 'loadSpeechSessions 复用共享落位函数（三处同源，杜绝 drift）');

console.log('\n── ② speechBoard 人归组带 scope（A/B 组不串人）');
check(S.byKeyHasScope, 'byKey 归组 key = date|slot|scope（scope 由 r.scope 派生 A/B/ALL）');
check(S.memberUsesScope, '取人 key 带 scope，与归组一致');
check(S.noOldKey, '没有残留只按 date|slot 的旧取人写法');

console.log('\n── ③ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '去掉共享落位函数的周次过滤（隔周课又变两条）', probe: 'lsHasFilter',
    apply: (src) => {
      const { body, start, end } = fnBodyOf(src, 'speechSessionSlot');
      return start < 0 ? src : src.slice(0, start) + body.replace(/if \(!week\.matchesWeeks\(s\.weeks, wk, s\.week_rule\)\) return null;/, '') + src.slice(end);
    } },
  { name: '把周次过滤挪到构造场次项之后（形同虚设）', probe: 'lsFilterBeforePush',
    apply: (src) => {
      const { body, start, end } = fnBodyOf(src, 'speechSessionSlot');
      const needle = '  if (!week.matchesWeeks(s.weeks, wk, s.week_rule)) return null;';
      if (start < 0 || body.indexOf(needle) < 0) return src;
      // 插到 return 语句之后（不可达位置），模拟「过滤形同虚设」
      const moved = body.replace(needle + '\n', '').replace('  }, extra || {});\n}', '  }, extra || {});\n' + needle + '\n}');
      return src.slice(0, start) + moved + src.slice(end);
    } },
  { name: 'loadSpeechSessions 不再复用共享落位函数（退回内联 drift）', probe: 'loadUsesSlot',
    apply: (src) => {
      const { body, start, end } = fnBodyOf(src, 'loadSpeechSessions');
      return start < 0 ? src : src.slice(0, start) + body.replace(/speechSessionSlot\s*\(s, wk, cfg, cal, shifts, \{ courseName: s\.courseName \|\| '' \}\)/, 'null') + src.slice(end);
    } },
  { name: 'byKey 归组去掉 scope 段（A/B 组串人）', probe: 'byKeyHasScope',
    from: "const key = date + '|' + r.slot + '|' + scope;", to: "const key = date + '|' + r.slot;" },
  { name: '取人 key 退回不带 scope', probe: 'memberUsesScope',
    from: "byKey[date + '|' + slot + '|' + scope]", to: "byKey[date + '|' + slot]" }
];

MUT.forEach((mu) => {
  const nextSrc = mu.apply ? mu.apply(SRC) : SRC.replace(mu.from, mu.to);
  if (nextSrc === SRC) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中或未改变源码');
    failed += 1;
    return;
  }
  check(evalAll(nextSrc)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲排班页周次过滤与 scope 归组检查全部通过'));
process.exit(failed ? 1 : 0);
