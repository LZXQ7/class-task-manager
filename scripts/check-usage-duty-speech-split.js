#!/usr/bin/env node
/**
 * 门禁：使用统计里「值日页」必须细分成 值日 / 课前演讲 两项（1.0.8.87）
 * ============================================================
 * 用户口径：值日页现在分为「值日」和「课前演讲」两段，后台使用统计却只有一个大类「值日」，
 *           要细分。埋点不拆，后端再怎么聚合也拆不出来 —— 所以真源在小程序上报。
 *
 * 守什么：
 *  ① duty 页有纯函数 dutyViewEvent(mode)：duty → duty、speech → speech，未知兜底 duty；
 *  ② onShow 按当前段上报（不是写死 duty）；切段 onViewMode 也上报新段，
 *     否则用户只在段间切换（Tab 页常驻不销毁）时演讲侧永远是 0；
 *  ③ 后台 EVENT_LABEL 有 speech:'课前演讲'，否则统计页裸奔成英文 key；
 *  ④ 后端 rows 仍按 event 分组、eventsBreakdown 仍按 e.event 细分（两项才会各占一行）。
 *
 * 承重方式：从真实源码抠出纯函数跑桩 + 静态断言 + 内存变异自证（不写真文件）。
 * 用法：node scripts/check-usage-duty-speech-split.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const FILES = {
  duty: 'miniprogram/pages/duty/index.js',
  app: 'cloudfunctions/admin-web/public/app.js',
  mod: 'cloudfunctions/admin-web/lib/mod-usage.js',
  speech: 'miniprogram/pages/speech/index.js'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = read(FILES[k]);

/** 按大括号配对抠出具名函数（真实源码承重，不抄实现） */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

/** 跑全部判据，返回失败名列表（空 = 全过）。变异自证复用同一套判据。 */
function checkAll(src) {
  const out = [];
  const need = (cond, name) => { if (!cond) out.push(name); };

  // ① 纯函数运行时：从真实源码抠出来跑，不抄实现
  const fnSrc = extractFn(src.duty, 'dutyViewEvent');
  if (!fnSrc) {
    need(false, 'dutyViewEventMissing');
  } else {
    let f;
    try { f = new Function(fnSrc + '\nreturn dutyViewEvent;')(); }
    catch (e) { need(false, 'dutyViewEventLoad:' + e.message); f = null; }
    if (f) {
      need(f('duty') === 'duty', 'dutyModeMapsToDuty');
      need(f('speech') === 'speech', 'speechModeMapsToSpeech');
      need(f(undefined) === 'duty', 'unknownModeFallsBackDuty');
      need(f('weird') === 'duty', 'garbageModeFallsBackDuty');
    }
  }

  // ② onShow 按当前段上报 + 切段上报新段（两个调用点缺一不可）
  need(/track\.pageView\(dutyViewEvent\(this\.data\.viewMode\)\)/.test(src.duty),
    'onShowUsesViewMode');
  need(/track\.pageView\(dutyViewEvent\(mode\)\)/.test(src.duty),
    'onViewModeTracksNewMode');
  need(/if \(mode === this\.data\.viewMode\) return;/.test(src.duty),
    'sameModeNoDuplicateTrack');

  // ③ 后台中文映射
  need(/speech\s*:\s*'课前演讲'/.test(src.app), 'eventLabelSpeech');

  // ④ 后端仍按 event 拆行（否则两个事件会塌成一行）
  need(/GROUP BY event, kind, ref/.test(src.mod), 'rowsGroupByEvent');
  need(/GROUP BY e\.openid, e\.event, e\.ref/.test(src.mod), 'breakdownGroupByEvent');
  need(/r\.event \+ '\/' \+ r\.ref/.test(src.mod), 'breakdownKeyUsesEvent');

  // 独立的演讲排班页仍在报 speech（与值日页演讲段共用一个统计项）
  need(/track\.pageView\('speech'\)/.test(src.speech), 'speechPageKeepsEvent');
  return out;
}

const problems = checkAll(S);
if (problems.length) {
  console.log('\n✗ 使用统计细分门禁失败 ' + problems.length + ' 项：');
  problems.forEach((p) => console.log('  · ' + p));
} else {
  console.log('\n✓ 使用统计「值日 / 课前演讲」细分门禁全部通过');
}

/* ================= 变异自证：改坏一处必须翻红 ================= */
function mutate(name, file, from, to, expect) {
  if (S[file].indexOf(from) < 0) {
    console.log('  ✗ 锚点丢失 → ' + name + '（变异没生效，不能算抓住）');
    return false;
  }
  const s2 = Object.assign({}, S, { [file]: S[file].replace(from, to) });
  const bad = checkAll(s2);
  const hit = bad.some((x) => x === expect);
  if (hit) console.log('  ✓ 抓住 → ' + name + '（' + expect + '）');
  else console.log('  ✗ 漏放 → ' + name + '（实际失败：' + (bad.join(', ') || '无') + '）');
  return hit;
}

console.log('\n── 自证（改坏一处必须翻红）');
const muts = [
  mutate('纯函数把演讲段也当成值日', 'duty',
    "return mode === 'speech' ? 'speech' : 'duty';", "return 'duty';",
    'speechModeMapsToSpeech'),
  mutate('onShow 写死上报 duty（切回演讲页还是算值日）', 'duty',
    "app.track.pageView(dutyViewEvent(this.data.viewMode))", "app.track.pageView('duty')",
    'onShowUsesViewMode'),
  mutate('切段不上报（演讲侧永远 0）', 'duty',
    "if (app.track) app.track.pageView(dutyViewEvent(mode));", '',
    'onViewModeTracksNewMode'),
  mutate('后台漏翻 speech（统计页裸奔英文）', 'app',
    "speech: '课前演讲',", '', 'eventLabelSpeech'),
  mutate('后端 rows 不再按 event 分组（两项塌成一行）', 'mod',
    'GROUP BY event, kind, ref', 'GROUP BY kind, ref', 'rowsGroupByEvent')
];
const caught = muts.filter(Boolean).length;
console.log('\n变异捕获 ' + caught + '/' + muts.length);
process.exit(problems.length || caught !== muts.length ? 1 : 0);
