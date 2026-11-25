#!/usr/bin/env node
/**
 * 离线自检：课前演讲「进度显示」（轮转位置 + 本周完成，1.0.8.82）
 * ============================================================
 * 用户口径：「课前演讲增加和值日一样的进度，现在只有安排，没有具体显示」。
 * 值日页有「值日 N 次」的进度感，演讲视图此前只有每天上午/下午谁讲，
 * 看不到「轮到几号了 / 本周排了多少」。本门禁钉死三件事：
 *   ① 页内有纯函数 speechProgressOf(setting, days)，真跑它验数字与文案：
 *      - 轮转位置取 setting.cursorA/cursorB（speech_cursor 双游标）；
 *      - 本周人次 = days[].am/pm 人数之和；场数按 date|slot 去重；
 *      - 0 是合法游标值，文案照显数字，不能当空吞掉；脏入参不崩。
 *   ② loadSpeech 真把 speechList 的 setting/days 接线到 speechProgress；
 *   ③ wxml 顶部进度卡渲染 positionText / 人次 / 场数，wxss 走令牌（深色安全）。
 *
 * 变异自证：改坏函数/接线/文案/样式，对应判据必须翻红。
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

const FN = 'speechProgressOf';

/** 抽顶层 `function <name>(...) {...}` 整段（花括号配对） */
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

/** 真跑纯函数（变异改内存里的源码字符串，这里跟着读改后的副本） */
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

/** 取页面方法体（锚 \n 两空格缩进，避开调用点） */
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
  const css = s.wxss;
  const fn = loadFn(j, FN);

  let normal = null;
  let zero = null;
  let dirty = null;
  let oneCell = null;
  if (fn) {
    try {
      /* 生产口径：A41/B40，一周三天：周一上午 2 人、周三上午 2 人、周五下午 1 人 */
      normal = fn({ cursorA: 41, cursorB: 40 }, [
        { date: '2026-11-23', am: [{ name: 'a' }, { name: 'b' }], pm: [] },
        { date: '2026-11-25', am: [{ name: 'c' }, { name: 'd' }], pm: [] },
        { date: '2026-11-27', am: [], pm: [{ name: 'e' }] }
      ]);
      /* 0 是合法游标值（从头开始），不能当空吞掉 */
      zero = fn({ cursorA: 0, cursorB: 0 }, []);
      /* 脏入参不崩 */
      dirty = fn(null, null);
      /* 同一天上午两人 + 下午一人 = 2 场（按 date|slot 去重，人次 3） */
      oneCell = fn({ cursorA: 3, cursorB: 4 }, [
        { date: '2026-11-24', am: [{ id: 1 }, { id: 2 }], pm: [{ id: 3 }] }
      ]);
    } catch (e) {
      normal = null;
    }
  }

  const load = methodBody(j, 'loadSpeech');
  const progressCard = (w.match(/class="sp-progress"/g) || []).length === 1;
  const posBind = /\{\{speechProgress\.positionText\}\}/.test(w);
  const peopleBind = (w.match(/\{\{speechProgress\.people\}\}/g) || []).length === 1;
  const sessBind = (w.match(/\{\{speechProgress\.sessions\}\}/g) || []).length === 1;
  const cssProg = /\.sp-progress\s*\{[^}]*\}/.test(css);
  const cssNum = /\.sp-progress-done-num\s*\{[^}]*color:\s*var\(--brand\)/.test(css);
  const cssFill = /\.sp-progress\s*\{[^}]*background:\s*var\(--fill-soft\)/.test(css);
  /* 进度卡不许写死浅底 / 深字（深色会翻不回来） */
  const hardLight = /\.sp-progress[^{}]*\{[^}]*#(?:F7F8FA|FFFFFF|1D2129|4E5969|86909C)/i.test(css);

  return {
    fnOk: !!fn,
    /* 轮转游标取对 */
    cursorA: !!(normal && normal.cursorA === 41),
    cursorB: !!(normal && normal.cursorB === 40),
    /* 本周 5 人次 / 3 场 */
    people: !!(normal && normal.people === 5),
    sessions: !!(normal && normal.sessions === 3),
    /* 文案含数字，0 也照显 */
    posText: !!(normal && /A组已排到 41 号/.test(normal.positionText) && /B组已排到 40 号/.test(normal.positionText)),
    doneText: !!(normal && /本周已排 5 人次 · 3 场/.test(normal.doneText)),
    zeroKeep: !!(zero && zero.cursorA === 0 && zero.cursorB === 0 && /0 号/.test(zero.positionText)),
    dirtySafe: !!(dirty && dirty.people === 0 && dirty.sessions === 0 && dirty.cursorA === 0),
    /* 场数按 date|slot 去重（同一天上午两人仍算 1 场） */
    dedupSessions: !!(oneCell && oneCell.people === 3 && oneCell.sessions === 2),
    /* 接线：loadSpeech 里派生并写进 data */
    wired: /speechProgress:\s*speechProgressOf\(/.test(load),
    dataInit: /speechProgress:\s*speechProgressOf\(\{ cursorA: 0, cursorB: 0 \}, \[\]\)/.test(stripJs(j)),
    /* wxml / wxss */
    card: progressCard,
    posBind: posBind,
    binds: peopleBind && sessBind,
    css: cssProg,
    cssNum: cssNum,
    cssFill: cssFill,
    noHardLight: !hardLight
  };
}

const S = evalAll(SRC);

console.log('\n── ① 纯函数真跑（speechProgressOf）');
check(S.fnOk, '页内存在可执行的 speechProgressOf 纯函数');
check(S.cursorA, '轮转位置 A 组游标取 setting.cursorA（=41）');
check(S.cursorB, '轮转位置 B 组游标取 setting.cursorB（=40）');
check(S.people, '本周人次 = days[].am/pm 人数之和（5 人次）');
check(S.sessions, '本周场数按 date|slot 去重（3 场）');
check(S.dedupSessions, '同一天上午两人+下午一人 = 3 人次 / 2 场（场按 date|slot 去重）');
check(S.posText, '位置文案含双游标数字「A组已排到 41 号 · B组已排到 40 号」');
check(S.doneText, '完成文案含「本周已排 5 人次 · 3 场」');
check(S.zeroKeep, '0 是合法游标：A/B 都是 0 时文案照显「0 号」，不当空吞掉');
check(S.dirtySafe, 'setting/days 传 null 不崩，回落全 0');

console.log('\n── ② 页面接线');
check(S.wired, 'loadSpeech 把 speechList 的 setting/days 接进 speechProgress');
check(S.dataInit, 'data 初值用 speechProgressOf 派生（首帧不空、无 undefined）');

console.log('\n── ③ 渲染与样式');
check(S.card, 'wxml 有且仅有一块 .sp-progress 进度卡');
check(S.posBind, '进度卡渲染 speechProgress.positionText');
check(S.binds, '进度卡渲染人次与场数两个数字');
check(S.css, '.sp-progress 样式有定义');
check(S.cssNum, '进度数字走 var(--brand)（深浅色自动翻）');
check(S.cssFill, '进度卡底板走 var(--fill-soft) 令牌');
check(S.noHardLight, '进度卡未写死浅底/深字');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '轮转游标改读别的字段（丢掉 setting.cursorA）', probe: 'cursorA', file: 'js',
    from: 'const a = Number(s.cursorA) || 0;', to: 'const a = 0;' },
  { name: '本周人次改恒 0（不累加 am/pm）', probe: 'people', file: 'js',
    from: '      people += arr.length;', to: '      people += 0;' },
  { name: '场数不去重（每人都算一场）', probe: 'dedupSessions', file: 'js',
    from: '  const sessions = Object.keys(slots).length;', to: '  const sessions = people;' },
  { name: '0 游标被当空吞掉（文案改成「未开始」）', probe: 'zeroKeep', file: 'js',
    from: "positionText: 'A组已排到 ' + a + ' 号 · B组已排到 ' + b + ' 号',",
    to: "positionText: (a ? 'A组已排到 ' + a + ' 号' : 'A组未开始') + ' · ' + (b ? 'B组已排到 ' + b + ' 号' : 'B组未开始')," },
  { name: '完成文案数字被去掉', probe: 'doneText', file: 'js',
    from: "doneText: '本周已排 ' + people + ' 人次 · ' + sessions + ' 场'",
    to: "doneText: '本周已排'" },
  { name: 'loadSpeech 不再接线 speechProgress', probe: 'wired', file: 'js',
    apply: (src) => src.replace(/\n\s*speechProgress: speechProgressOf\(\(r && r\.setting\) \|\| \{\}, \(r && r\.days\) \|\| \[\]\),/, '') },
  { name: 'wxml 去掉进度卡', probe: 'card', file: 'wxml',
    apply: (src) => src.replace(/<view class="sp-progress">[\s\S]*?<\/view>\s*<\/view>\n/, '') },
  { name: 'wxml 去掉位置文案绑定', probe: 'posBind', file: 'wxml',
    from: '{{speechProgress.positionText}}', to: '演讲进度' },
  { name: 'wxss 数字改回写死深色', probe: 'cssNum', file: 'wxss',
    from: '.sp-progress-done-num { font-size: 34rpx; font-weight: 700; color: var(--brand); line-height: 1.1; }',
    to: '.sp-progress-done-num { font-size: 34rpx; font-weight: 700; color: #1D2129; line-height: 1.1; }' }
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

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲进度显示检查全部通过'));
process.exit(failed ? 1 : 0);
