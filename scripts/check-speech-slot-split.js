#!/usr/bin/env node
/**
 * 离线自检：演讲视图的组别标签必须**统一放行首**、姓名后面不再挂小字（2026-11-17 立规）
 * --------------------------------------------------------------------------------
 * 历史两轮用户现场：
 *   ① 2026-11-20 周五上午：A/B 两组各一门课，4 个人被平铺在一行
 *      「示例成员16 B组｜示例成员18 B组｜示例成员25 A组｜示例成员27 A组」→ 上 1.0.8.55 拆两行；
 *   ② 2026-11-18 周三：同一时段只有同一组（或全体课），组别又退回成**每个名字后面的
 *      小字**「示例成员12 B组｜示例成员14 B组」，与周五那两行的「行首 A组/B组」格式不统一。
 *      用户原话：「这些 A组 B组 全体也放前面，不要每个名字后面加一个组」。
 *
 * 定规（本版口径）：
 *   ① 每个时段都按 scope 归拢成「行」，**行首固定一个组别小标**（A组 / B组 / 全体）；
 *   ② 同时有 A、B 两组 ⇒ 两行，**A 组在上、B 组在下**；
 *   ③ 姓名的胶囊里**只有姓名**，不许再挂组别小字（.sp-scope 已删除）；
 *   ④ 组内顺序 = 后端顺序（按学号），前端不得重排；
 *   ⑤ 纯展示层：不动库、不改云函数、不影响换人/发布链路。
 *
 * 用法：node scripts/check-speech-slot-split.js
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

/** 分组函数的统一名字（页面里唯一实现，门禁按名字抽源码真跑） */
const FN = 'speechSlotGroups';

/** 从页面 js 抽出顶层 `function <name>(...) {...}` 整段（按花括号配对，不靠缩进） */
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

/** 把源码里的纯函数装起来真跑（变异改了内存里的字符串，这里跟着读改后的副本） */
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

/** 取页面方法体（从顶层 `name(` 定义到下一个同缩进顶层方法）
 *  ⚠️ 必须锚 `\n  name(`：页内别处有 `this.loadSpeech();` 这类调用，
 *     直接 indexOf(name + '(') 会命中调用点，方法体被截断成一行 → 判据假红。 */
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
  const fn = loadFn(s.js, FN);

  let mix = null;
  let single = null;
  let allOnly = null;
  let withAll = null;
  let empty = null;
  if (fn) {
    try {
      /* 现场数据：B 组两人在前（学号 52/54）、A 组两人在后（学号 11/13），
         后端就是这么交错返回的 —— 前端要按组归拢但**组内保序**。 */
      mix = fn([
        { name: '示例成员16', scope: 'B' },
        { name: '示例成员18', scope: 'B' },
        { name: '示例成员25', scope: 'A' },
        { name: '示例成员27', scope: 'A' }
      ]);
      single = fn([{ name: 'A1', scope: 'A' }, { name: 'A2', scope: 'A' }]);
      allOnly = fn([{ name: '示例成员20', scope: 'ALL' }]);
      withAll = fn([
        { name: 'B1', scope: 'B' }, { name: 'A1', scope: 'A' }, { name: 'X', scope: null }
      ]);
      empty = fn([]);
    } catch (e) {
      mix = null;
    }
  }
  const names = (g) => (g ? g.map((it) => it.label || it.name).join(',') : '');
  const people = (g) => (g ? g.map((it) => it.name).join(',') : '');

  const slotBodies = w.match(/class="sp-slot[ "]/g) || [];
  const hasAmGroups = /wx:for="\{\{item\.amGroups\}\}"/.test(w);
  const hasPmGroups = /wx:for="\{\{item\.pmGroups\}\}"/.test(w);
  const flatAm = /wx:for="\{\{item\.am\}\}"/.test(w) || /wx:for="\{\{item\.pm\}\}"/.test(w);
  /* 行首组别小标：两处时段都要有，且**无条件显示**（不许再挂 grp.split 之类的守卫，
     否则单组/全体课就退回「每个人名字后面挂小字」的老样子） */
  const labelCount = (w.match(/\{\{grp\.label\}\}/g) || []).length;
  const tagUnguarded = (w.match(/<text[^>]*class="sp-line-tag[^"]*"[^>]*>\{\{grp\.label\}\}<\/text>/g) || [])
    .every((tag) => tag.indexOf('wx:if') < 0 && tag.indexOf('wx:elif') < 0 && tag.indexOf('hidden') < 0);
  /* 姓名胶囊里只许有姓名：两个时段块内不许再出现逐块组别小字
     （⚠️ 只查 sp-slot 时段块：智能排班预览是「一人一行」的流水账，
      行尾挂组别小字是另一套布局，不要连它一起判死） */
  const slotChunks = w.match(/class="sp-slot[^"]*"[\s\S]*?class="sp-none">—<\/view>/g) || [];
  const perNameTag = slotChunks.some((c) => /class="sp-scope/.test(c) || /\{\{p\.scope\}\}/.test(c));
  /* 预览那套仍然要用 .sp-scope（样式别被顺手删掉，否则行尾小字变成默认大字） */
  const previewTag = /class="sp-scope/.test(w) && /\.sp-scope\s*\{/.test(s.wxss);
  const load = methodBody(j, 'loadSpeech');

  return {
    /* 函数存在且可执行 */
    fnOk: !!fn,
    /* 混排 → 恰好两行，A 在上 B 在下 */
    mixOrder: !!(mix && mix.length === 2 && mix[0].scope === 'A' && mix[1].scope === 'B' && names(mix) === 'A组,B组'),
    /* 组内保序：A 组仍是 示例成员25 → 示例成员27；B 组仍是 示例成员16 → 示例成员18 */
    mixKeepOrder: !!(mix && mix[0] && mix[1]
      && people(mix[0].people) === '示例成员25,示例成员27'
      && people(mix[1].people) === '示例成员16,示例成员18'),
    /* 单组（周三那两行）：仍返回一行，带 A组 标签 —— 标签在前，不是挂在名字后 */
    singleLabel: !!(single && single.length === 1 && single[0].label === 'A组'
      && people(single[0].people) === 'A1,A2'),
    /* 全体课（示例成员20）：一行、标签「全体」 */
    allLabel: !!(allOnly && allOnly.length === 1 && allOnly[0].label === '全体'
      && people(allOnly[0].people) === '示例成员20'),
    /* A + B + 未知 scope（脏数据）→ 三行，未知按全体兜底，顺序 A/B/ALL */
    threeRows: !!(withAll && withAll.length === 3 && names(withAll) === 'A组,B组,全体'),
    emptyOk: !!(empty && empty.length === 0),
    /* WXML：两个时段都走分组数组，且不再平铺原始 am/pm */
    wxmlGroups: hasAmGroups && hasPmGroups && !flatAm,
    /* WXML：两处时段各一个行首组别标签 */
    lineTag: labelCount === 2,
    /* WXML：行首标签无条件显示（单组/全体课也要有） */
    tagUnguarded,
    /* WXML：时段块里姓名后面不再挂组别小字 */
    noPerNameTag: slotChunks.length === 2 && !perNameTag,
    /* 预览那套 sp-scope 与样式都还在（别误删） */
    previewTag,
    /* 数据接线：loadSpeech 里给每天算出 amGroups / pmGroups */
    dataWired: /amGroups\s*:/.test(load) && /pmGroups\s*:/.test(load) && new RegExp(FN + '\\s*\\(').test(load),
    /* 样式：分行容器与行首标签都有定义（否则真机就是两坨贴在一起） */
    cssLine: /\.sp-lines\s*\{/.test(s.wxss) && /\.sp-line\s*\{/.test(s.wxss) && /\.sp-line-tag\s*\{/.test(s.wxss),
    slotBodies: slotBodies.length
  };
}

const S = evalAll(SRC);

console.log('── ① 分组纯函数（页内唯一实现，门禁真跑它）');
check(S.fnOk, '存在可执行的 ' + FN + '()');
check(S.mixOrder, 'A/B 混排 → 拆成 2 行，且 **A 组在上、B 组在下**');
check(S.mixKeepOrder, '组内保持后端学号序（A：示例成员25→示例成员27；B：示例成员16→示例成员18），前端不重排');
check(S.singleLabel, '同一时段只有 A 组（周三那种）→ 仍是 1 行，行首标签「A组」，不是挂在名字后');
check(S.allLabel, '全体课 → 1 行，行首标签「全体」');
check(S.threeRows, 'A+B+脏 scope → 3 行，顺序 A→B→全体（未知 scope 兜底成全体）');
check(S.emptyOk, '空场次 → 返回空数组（渲染走「—」占位）');

console.log('\n── ② 页面接线');
check(S.slotBodies === 2, '上午 / 下午两个时段块都在（找到 ' + S.slotBodies + ' 个）');
check(S.dataWired, 'loadSpeech 给每天算出 amGroups / pmGroups（调 ' + FN + '）');
check(S.wxmlGroups, '上午 / 下午两处都按 amGroups / pmGroups 渲染，且不再平铺 item.am / item.pm');
check(S.lineTag, '两处时段各有一个行首组别标签 {{grp.label}}');
check(S.tagUnguarded, '行首标签无条件渲染（不许挂 grp.split 守卫，单组课也要有）');
check(S.noPerNameTag, '时段块里姓名胶囊只剩姓名，不再逐个挂 A组/B组/全体 小字');

console.log('\n── ③ 样式');
check(S.cssLine, '.sp-lines / .sp-line / .sp-line-tag 三条样式齐备');
check(S.previewTag, '智能排班预览那套行尾组别小字（.sp-scope）与样式都还在，没被顺手删掉');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '顺序改成 B 组在上（用户明确要 A 在上）', probe: 'mixOrder', file: 'js',
    from: "[['A', 'A组'], ['B', 'B组'], ['ALL', '全体']]",
    to: "[['B', 'B组'], ['A', 'A组'], ['ALL', '全体']]" },
  { name: '组内按姓名重排（丢掉后端学号序）', probe: 'mixKeepOrder', file: 'js',
    from: '    bucket[s].push(p);',
    to: '    bucket[s].unshift(p);' },
  { name: '行首标签的「全体」写成英文 scope', probe: 'allLabel', file: 'js',
    from: "['ALL', '全体']", to: "['ALL', 'ALL']" },
  { name: '只给第二行起挂标签（第一行裸着，回到「标签不统一」的老样子）', probe: 'singleLabel', file: 'js',
    from: '    out.push({ scope: slot[0], label: slot[1], people: bucket[slot[0]] });',
    to: '    out.push({ scope: slot[0], label: out.length ? slot[1] : \'\', people: bucket[slot[0]] });' },
  { name: '两个时段都退回平铺渲染', probe: 'wxmlGroups', file: 'wxml',
    from: 'wx:for="{{item.amGroups}}"', to: 'wx:for="{{item.am}}"' },
  { name: '去掉行首组别标签', probe: 'lineTag', file: 'wxml',
    from: '{{grp.label}}', to: '{{grp.scope}}' },
  { name: '行首标签又加回 split 守卫（单组课就没标签了）', probe: 'tagUnguarded', file: 'wxml',
    /* 上下午两处都要改坏：只 replace 首处，另一处还裸着 ⇒ 判据仍绿 ⇒ 假通过 */
    apply: (src) => src.split('class="sp-line-tag').join('wx:if="{{grp.split}}" class="sp-line-tag') },
  { name: '姓名后又挂回组别小字', probe: 'noPerNameTag', file: 'wxml',
    apply: (src) => src.split('<text class="sp-name">{{p.name}}</text>')
      .join('<text class="sp-name">{{p.name}}</text><text class="sp-scope">{{p.scope}}</text>') },
  { name: 'loadSpeech 不再算分组数组', probe: 'dataWired', file: 'js',
    apply: (src) => src.replace(/\n\s*amGroups:\s*speechSlotGroups\(d\.am\),\n\s*pmGroups:\s*speechSlotGroups\(d\.pm\)/, '') }
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

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲时段「组别标签统一前置」检查全部通过'));
process.exit(failed ? 1 : 0);
