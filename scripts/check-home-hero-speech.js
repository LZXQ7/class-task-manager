#!/usr/bin/env node
/**
 * 离线自检：首页 Hero 卡「明天值日 + 课前演讲」（1.0.8.84）
 * ============================================================
 * 用户口径：
 *   ③「首页显示值日的卡片增加，如果第二天有值日也显示，明天值日，如果明天内没有则
 *      像现在一样显示今日没有你的值日」
 *   ④「首页第一个值日卡片增加课前演讲显示」
 *
 * 判据：
 *   ① 后端 duty.today 下发 myTomorrowDuty（明天本人值日，与 myDuty 同口径）+ mySpeech
 *      （今天/明天已发布演讲，done 用服务端东八区时钟派生）；
 *   ② 前端 load 里 heroDuty = myDuty || tomorrowDuty，heroTomorrow = !myDuty && !!tomorrowDuty，
 *      今天优先、明天补位、两天都没有才走「今天没有你的值日」；
 *   ③ wxml Hero 卡显示 mySpeech 的 dayText/slotText/doneText，且 wxss 有对应样式、深色安全；
 *   ④ 缓存写入含新字段（冷启动不丢）。
 *
 * 变异自证：改坏任一处 → 对应判据翻红。
 *
 * 用法：node scripts/check-home-hero-speech.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  homeJs: 'miniprogram/pages/home/index.js',
  homeWxml: 'miniprogram/pages/home/index.wxml',
  homeWxss: 'miniprogram/pages/home/index.wxss',
  dutyCloud: 'cloudfunctions/duty/index.js'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

/** 用真实源码片段复现「补位 + 演讲文案派生」的纯逻辑并真跑 */
function evalLogic(s) {
  const j = stripJs(s.homeJs);
  /* 抽 load 里那一段（从 const myDuty 到 groupTag 之前） */
  const i = j.indexOf('        const myDuty = r.myDuty || null;');
  const k = j.indexOf('        const groupTag = ', i);
  /* 需要把 hero 计算段也包含进来（到 this._hasData 之前），验证标题补位 */
  const k2 = j.indexOf('        this._hasData = true;', i);
  const seg = i >= 0 && k > i && k2 > k ? j.slice(i, k2) : '';
  const HEROTXT = { PENDING: { title: '今天你值日', status: '待值日' } };
  let run = null;
  try {
    // eslint-disable-next-line no-new-func
    run = new Function('r', 'HERO', 'util', seg + '\nreturn { heroDuty, heroTomorrow, mySpeech, hero, heroSub, periodText, myDuty };');
  } catch (e) {
    run = null;
  }
  const util = { fmtRoom: (x) => x || '', whenText: (kind, p) => '第' + p + '节' };
  const base = { today: '2026-11-26', tomorrow: '2026-11-27', currentWeek: 11, member: { groupTag: 'A' } };
  let todayOnly = null, tomorrowOnly = null, neither = null, speech = null;
  if (run) {
    try {
      todayOnly = run(Object.assign({}, base, { myDuty: { status: 'PENDING', period: 1, room: '410', courseName: '语文', groupScope: 'A', kind: 'COURSE', peers: [] }, myTomorrowDuty: { status: 'PENDING' }, mySpeech: [] }), HEROTXT, util);
      tomorrowOnly = run(Object.assign({}, base, { myDuty: null, myTomorrowDuty: { status: 'PENDING', period: 3, room: '410', courseName: '数学', groupScope: 'B', kind: 'COURSE', peers: [] }, mySpeech: [] }), HEROTXT, util);
      neither = run(Object.assign({}, base, { myDuty: null, myTomorrowDuty: null, mySpeech: [] }), HEROTXT, util);
      speech = run(Object.assign({}, base, { myDuty: null, myTomorrowDuty: null, mySpeech: [
        { id: 1, date: '2026-11-26', slot: 'am', time: '08:00', done: true },
        { id: 2, date: '2026-11-27', slot: 'pm', time: '14:30', done: false }
      ] }), HEROTXT, util);
    } catch (e) {
      todayOnly = null;
    }
  }

  const w = stripXml(s.homeWxml);
  const css = s.homeWxss;
  const cloud = stripJs(s.dutyCloud);
  return {
    fnOk: !!run,
    /* 补位口径 */
    todayPriority: !!(todayOnly && todayOnly.heroDuty && todayOnly.heroDuty.courseName === '语文' && !todayOnly.heroTomorrow),
    tomorrowFallback: !!(tomorrowOnly && tomorrowOnly.heroDuty && tomorrowOnly.heroDuty.courseName === '数学' && tomorrowOnly.heroTomorrow === true),
    tomorrowTitle: !!(tomorrowOnly && tomorrowOnly.hero && tomorrowOnly.hero.title === '明天你值日'),
    neitherEmpty: !!(neither && !neither.heroDuty && !neither.hero),
    /* 演讲文案派生 */
    speechDayText: !!(speech && speech.mySpeech.length === 2 && speech.mySpeech[0].dayText === '今天' && speech.mySpeech[1].dayText === '明天'),
    speechSlotText: !!(speech && speech.mySpeech[0].slotText === '上午' && speech.mySpeech[1].slotText === '下午'),
    speechDoneText: !!(speech && speech.mySpeech[0].doneText === '已演讲' && speech.mySpeech[1].doneText === '未演讲'),
    /* wxml：Hero 卡渲染 */
    heroBranch: /wx:if="\{\{myDuty \|\| tomorrowDuty\}\}"/.test(w),
    nodutyKept: /今天没有你的值日/.test(w),
    speechBlock: /class="hero-speech"/.test(w),
    speechLoop: /wx:for="\{\{mySpeech\}\}"/.test(w),
    speechBinds: /\{\{item\.dayText\}\}/.test(w) && /\{\{item\.slotText\}\}/.test(w) && /\{\{item\.doneText\}\}/.test(w),
    /* wxss */
    cssSpeech: /\.hero-speech\s*\{/.test(css) && /\.hero-speech-done\.done\s*\{/.test(css),
    cssToken: /\.hero-speech-day\s*\{[^}]*color:\s*var\(--brand\)/.test(css),
    darkSafe: !/\.hero-speech[^{}]*\{[^}]*#(?:F7F8FA|1D2129|4E5969|86909C)/i.test(css),
    /* 缓存 */
    cacheNew: /tomorrowDuty: patch\.tomorrowDuty, heroTomorrow: patch\.heroTomorrow, mySpeech: patch\.mySpeech/.test(j),
    /* 后端 */
    cloudTomorrow: /myTomorrowDuty/.test(cloud) && /d\.class_date = \?/.test(cloud),
    cloudSpeech: /mySpeech/.test(cloud) && /publishStatus/.test(cloud),
    cloudClock: /nowHHmm\(\)/.test(cloud),
    cloudReturn: /myTomorrowDuty,[\s\S]{0,80}mySpeech,/.test(cloud)
  };
}

const S = evalLogic(SRC);

console.log('\n── ① 补位逻辑真跑（今天优先 / 明天补位 / 都没有）');
check(S.fnOk, '能从真源码抽出并运行 Hero 派生段');
check(S.todayPriority, '今天有值日 ⇒ 显示今天、heroTomorrow=false');
check(S.tomorrowFallback, '今天没有、明天有 ⇒ 显示明天值日');
check(S.tomorrowTitle, '明天补位时标题改为「明天你值日」');
check(S.neitherEmpty, '两天都没有 ⇒ hero 为空（走「今天没有你的值日」）');

console.log('\n── ② 演讲文案派生真跑');
check(S.speechDayText, '今天/明天分别派生 dayText');
check(S.speechSlotText, '上午/下午分别派生 slotText');
check(S.speechDoneText, '已演讲/未演讲分别派生 doneText');

console.log('\n── ③ 渲染与样式');
check(S.heroBranch, 'Hero 卡按 myDuty || tomorrowDuty 显示');
check(S.nodutyKept, '「今天没有你的值日」兜底文案还在');
check(S.speechBlock && S.speechLoop, 'Hero 卡内有课前演讲区并遍历 mySpeech');
check(S.speechBinds, '演讲行渲染 dayText / slotText / doneText');
check(S.cssSpeech, '.hero-speech / .hero-speech-done.done 样式有定义');
check(S.cssToken, '演讲区走 var(--brand) 等令牌');
check(S.darkSafe, '演讲区未写死浅底深字');

console.log('\n── ④ 缓存与后端');
check(S.cacheNew, '首页缓存写入含明天值日/演讲新字段');
check(S.cloudTomorrow, 'duty.today 下发 myTomorrowDuty（按明天日期查 duty 表）');
check(S.cloudSpeech, 'duty.today 下发 mySpeech（只回已发布场次）');
check(S.cloudClock, 'mySpeech.done 用服务端 nowHHmm 派生');
check(S.cloudReturn, '两个新字段都进了 duty.today 返回体');

console.log('\n── ⑤ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '去掉明天补位（只认今天）', probe: 'tomorrowFallback', file: 'homeJs',
    from: '        const heroDuty = myDuty || tomorrowDuty;', to: '        const heroDuty = myDuty;' },
  { name: '明天补位但标题仍写「今天你值日」', probe: 'tomorrowTitle', file: 'homeJs',
    from: "          if (heroTomorrow) hero = Object.assign({}, hero, { title: '明天你值日' });", to: '          /* dropped */' },
  { name: '演讲 dayText 恒空', probe: 'speechDayText', file: 'homeJs',
    from: "          dayText: x.date === r.today ? '今天' : (x.date === r.tomorrow ? '明天' : x.date),", to: "          dayText: ''," },
  { name: '演讲 doneText 恒「未演讲」', probe: 'speechDoneText', file: 'homeJs',
    from: "          doneText: x.done ? '已演讲' : '未演讲'", to: "          doneText: '未演讲'" },
  { name: 'wxml Hero 只认今天（明天卡消失）', probe: 'heroBranch', file: 'homeWxml',
    from: 'wx:if="{{myDuty || tomorrowDuty}}"', to: 'wx:if="{{myDuty}}"', after: (s) => s },
  { name: 'wxml 去掉演讲遍历', probe: 'speechLoop', file: 'homeWxml',
    from: 'wx:for="{{mySpeech}}"', to: 'wx:for="{{[]}}"' },
  { name: '后端不再下发明天值日', probe: 'cloudReturn', file: 'dutyCloud',
    from: '        myTomorrowDuty,\n        mySpeech,', to: '        /* dropped */' },
  { name: '缓存漏写新字段（冷启动丢失）', probe: 'cacheNew', file: 'homeJs',
    from: '          tomorrowDuty: patch.tomorrowDuty, heroTomorrow: patch.heroTomorrow, mySpeech: patch.mySpeech,\n', to: '' }
];

MUT.forEach((mu) => {
  const file = mu.file;
  const src = SRC[file];
  if (src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const nextSrc = src.replace(mu.from, mu.to);
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [file]: nextSrc });
  check(evalLogic(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 首页 Hero 明天值日 + 课前演讲检查全部通过'));
process.exit(failed ? 1 : 0);
