#!/usr/bin/env node
/**
 * 离线自检：课前演讲「逐行进度」（已演讲 / 未演讲，1.0.8.83）
 * ============================================================
 * 用户口径纠正：「是像值日一样在后面显示，已演讲、未演讲这样的」——
 * 不要顶部汇总卡（1.0.8.82 做错了），要在**每一行姓名后面**跟一枚状态 pill。
 *
 * 判据：
 *   ① 页内纯函数 `speechDoneOf(date, slot, now)` 真跑：
 *      - 上午场 08:10 结束、下午场 14:40 结束；过了结束时刻 = 已演讲；
 *      - 同一时刻：上午已讲但下午未讲（时段边界正确）；
 *      - 脏日期 / 非法 now 不崩、回落「未演讲」；
 *   ② loadSpeech 按 day×slot 派生 done 写到每个 group 上（不改分组数组本身）；
 *   ③ wxml 上午/下午两处 sp-line 行尾都有 status-pill，文案「已演讲 / 未演讲」；
 *   ④ 顶部汇总卡 .sp-progress 已移除（用户明确不要）。
 *
 * 变异自证：改坏函数/接线/文案/把汇总卡加回来，对应判据必须翻红。
 *
 * 用法：node scripts/check-speech-progress.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  wxml: 'miniprogram/pages/duty/index.wxml',
  js: 'miniprogram/pages/duty/index.js',
  wxss: 'miniprogram/pages/duty/index.wxss'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

const FN = 'speechDoneOf';

function fnSource(js, name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0;
  let started = false;
  for (let k = i; k < js.length; k += 1) {
    if (js[k] === '{') { d += 1; started = true; }
    else if (js[k] === '}') {
      d -= 1;
      if (started && !d) return js.slice(i, k + 1);
    }
  }
  return '';
}

function loadFn(js, name) {
  const src = fnSource(stripJs(js), name);
  if (!src) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(src + '\nreturn ' + name + ';')();
  } catch (e) {
    return null;
  }
}

function methodBody(js, name) {
  let i = js.indexOf('\n  ' + name + '(');
  if (i < 0) i = js.indexOf(name + '(');
  if (i < 0) return '';
  const rest = js.slice(i);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 契约评估（变异自证复用） */
function evalAll(s) {
  const w = stripXml(s.wxml);
  const j = stripJs(s.js);
  const fn = loadFn(j, FN);

  /* 服务端时钟口径（1.0.8.84）：clock = {today, hhmm}，与设备时钟无关 */
  const C = (today, hhmm) => ({ today, hhmm });
  let amDoneBefore = null;
  let pmNotDoneAt9 = null;
  let notDoneAt730 = null;
  let bothDoneAt15 = null;
  let pastDayDone = null;      // 用户报的问题：过去的日期必须已演讲（哪怕时钟 hhmm 很早）
  let futureDayNot = null;
  let dirtyDate = null;
  let dirtyNow = null;
  let fallbackOk = null;
  if (fn) {
    try {
      /* 同一天 2026-11-25 09:00：上午 08:10 已过、下午 14:40 未到 */
      amDoneBefore = fn('2026-11-25', 'am', C('2026-11-25', '09:00'));
      pmNotDoneAt9 = fn('2026-11-25', 'pm', C('2026-11-25', '09:00'));
      /* 14:30 下午场还没结束 */
      notDoneAt730 = fn('2026-11-25', 'pm', C('2026-11-25', '14:30'));
      /* 15:00 两场都过了结束时刻 */
      bothDoneAt15 = fn('2026-11-25', 'am', C('2026-11-25', '15:00'))
        && fn('2026-11-25', 'pm', C('2026-11-25', '15:00'));
      /* 🔴 用户报障核心：11-23 是过去的日子，即使今天 00:01（hhmm 更早）也必须已演讲 */
      pastDayDone = fn('2026-11-23', 'am', C('2026-11-26', '00:01'))
        && fn('2026-11-23', 'pm', C('2026-11-26', '00:01'))
        && fn('2026-11-25', 'pm', C('2026-11-26', '00:01'));
      /* 未来日子未演讲 */
      futureDayNot = fn('2026-11-27', 'am', C('2026-11-26', '23:59')) === false;
      /* 脏入参不崩 */
      dirtyDate = fn('not-a-date', 'am', C('2026-11-26', '09:00'));
      dirtyNow = fn('2026-11-25', 'am', C('', ''));
      /* 兼容回落：无服务端时钟时用 Date 毫秒，仍按本地时刻判定 */
      fallbackOk = fn('2026-11-25', 'am', new Date(2026, 10, 25, 9, 0).getTime()) === true
        && fn('2026-11-25', 'pm', new Date(2026, 10, 25, 9, 0).getTime()) === false;
    } catch (e) {
      amDoneBefore = null;
    }
  }

  const load = methodBody(j, 'loadSpeech');
  /* wxml：两处 sp-line 行尾的 status-pill（用 text 属性给「已演讲 / 未演讲」文案） */
  const pills = w.match(/<status-pill[^>]*\/>/g) || [];
  const rowPills = pills.filter((p) => /grp\.done \? 'DONE' : 'PENDING'/.test(p));
  const noSummaryCard = !/class="sp-progress"/.test(w) && !/\.sp-progress\s*\{/.test(s.wxss);
  /* 派生接线：保留原 amGroups/pmGroups 两行（既有门禁的变异锚点），另起一步写 done */
  const keepsGroups = /amGroups:\s*speechSlotGroups\(d\.am\)/.test(load)
    && /pmGroups:\s*speechSlotGroups\(d\.pm\)/.test(load);
  const amWired = /\(d\.amGroups \|\| \[\]\)\.forEach\(\(g\) => \{ g\.done = amDone/.test(load);
  const pmWired = /\(d\.pmGroups \|\| \[\]\)\.forEach\(\(g\) => \{ g\.done = pmDone/.test(load);
  const deriveAm = /speechDoneOf\(d\.date, 'am', speechClock\)/.test(load);
  const derivePm = /speechDoneOf\(d\.date, 'pm', speechClock\)/.test(load);
  const srvClock = /const speechClock = \(r && r\.clock\) \|\| Date\.now\(\)/.test(load);

  return {
    fnOk: !!fn,
    amDoneBefore: amDoneBefore === true,
    pmNotDoneAt9: pmNotDoneAt9 === false,
    notDoneAt730: notDoneAt730 === false,
    bothDoneAt15: bothDoneAt15 === true,
    dirtyDate: dirtyDate === false,
    dirtyNow: dirtyNow === false,
    pastDayDone: pastDayDone === true,
    futureDayNot: futureDayNot === true,
    fallbackOk: fallbackOk === true,
    pills: rowPills.length === 2,
    pillText: rowPills.length === 2 && rowPills.every((p) => /已演讲/.test(p) && /未演讲/.test(p)),
    noSummaryCard: noSummaryCard,
    keepsGroups: keepsGroups,
    wired: amWired && pmWired && deriveAm && derivePm && srvClock
  };
}

const S = evalAll(SRC);

console.log('\n── ① 纯函数真跑（speechDoneOf）');
check(S.fnOk, '页内存在可执行的 speechDoneOf 纯函数');
check(S.amDoneBefore, '上午场 09:00 已过 08:10 ⇒ 已演讲');
check(S.pmNotDoneAt9, '同一时刻下午场 14:40 未到 ⇒ 未演讲（时段边界正确）');
check(S.notDoneAt730, '下午 14:30 场未结束 ⇒ 未演讲');
check(S.bothDoneAt15, '15:00 两场均已结束 ⇒ 都已演讲');
check(S.pastDayDone, '🔴 过去的日子（11-23/24/25）即便今天 00:01 也全部已演讲');
check(S.futureDayNot, '未来日子未演讲');
check(S.fallbackOk, '无服务端时钟时按 Date 毫秒回落仍正确（兼容旧缓存）');
check(S.dirtyDate, '脏日期不崩，回落未演讲');
check(S.dirtyNow, '空服务端时钟不崩，回落未演讲');

console.log('\n── ② 页面接线');
check(S.keepsGroups, '保留 amGroups/pmGroups 原样（既有分组门禁的变异锚点不被破坏）');
check(S.wired, 'loadSpeech 优先取服务端 clock 按 day×slot 派生 done 写到每组');

console.log('\n── ③ 渲染');
check(S.pills, '上午/下午两处 sp-line 行尾各有一枚 status-pill');
check(S.pillText, 'pill 文案为「已演讲 / 未演讲」');
check(S.noSummaryCard, '1.0.8.82 的顶部汇总卡已移除（用户明确不要）');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '把服务端时钟分支的日期比较改成恒 false（过去日子又变未演讲）', probe: 'pastDayDone', file: 'js',
    from: '    if (d < srvToday) return true;', to: '    if (d < srvToday) return false;' },
  { name: '上午结束时刻改成 23:59（当天的上午场永远未演讲）', probe: 'amDoneBefore', file: 'js',
    from: "    const endHHmm = slot === 'pm' ? '14:40' : '08:10';", to: "    const endHHmm = slot === 'pm' ? '14:40' : '23:59';" },
  { name: '下午结束时刻改成 08:10（当天 09:00 下午场被误判已讲）', probe: 'pmNotDoneAt9', file: 'js',
    from: "    const endHHmm = slot === 'pm' ? '14:40' : '08:10';", to: "    const endHHmm = slot === 'pm' ? '08:10' : '08:10';" },
  { name: '下午结束时刻改成 14:00（14:30 被误判已讲）', probe: 'notDoneAt730', file: 'js',
    from: "    const endHHmm = slot === 'pm' ? '14:40' : '08:10';", to: "    const endHHmm = slot === 'pm' ? '14:00' : '08:10';" },
  { name: '未来日期也被当已演讲', probe: 'futureDayNot', file: 'js',
    from: '    if (d > srvToday) return false;', to: '    if (d > srvToday) return true;' },
  { name: '脏日期返回 true（脏数据被当已演讲）', probe: 'dirtyDate', file: 'js',
    from: "  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return false;", to: "  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return true;" },
  { name: '不再用服务端时钟（回退成设备时钟，用户报障重现）', probe: 'wired', file: 'js',
    from: '        const speechClock = (r && r.clock) || Date.now();', to: '        const speechClock = Date.now();' },
  { name: '去掉上午场派生（amDone 恒 false）', probe: 'wired', file: 'js',
    from: "          const amDone = speechDoneOf(d.date, 'am', speechClock);", to: '          const amDone = false;' },
  { name: '下午组不再写 done（下午行永远未演讲）', probe: 'wired', file: 'js',
    from: '          (d.pmGroups || []).forEach((g) => { g.done = pmDone; });', to: '          /* dropped */' },
  { name: 'wxml 去掉下午场 pill', probe: 'pills', file: 'wxml',
    apply: (src) => src.replace(/\s*<!-- 演讲进度（1\.0\.8\.83）：下午场同上午，行尾一枚 status-pill -->\s*<status-pill[^>]*\/>/, '') },
  { name: 'pill 文案写回「已值日/待值日」（值日口径）', probe: 'pillText', file: 'wxml',
    apply: (src) => src.split("'已演讲' : '未演讲'").join("'已值日' : '待值日'") },
  { name: '把顶部汇总卡加回来（用户明确不要）', probe: 'noSummaryCard', file: 'wxml',
    apply: (src) => src.replace('<view class="sp-legend">', '<view class="sp-progress">汇总</view>\n    <view class="sp-legend">') }
];

MUT.forEach((mu) => {
  const file = mu.file || 'js';
  const src = SRC[file];
  if (!mu.apply && src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const nextSrc = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码（锚点命中但替换无效）');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [file]: nextSrc });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲逐行进度检查全部通过'));
process.exit(failed ? 1 : 0);
