#!/usr/bin/env node
/**
 * 离线自检：课前演讲三项显示/交互口径（1.0.8.66）
 * --------------------------------------------------------------------------------
 * 用户三条诉求：
 *   ① 姓名后面增加学号（口径已确认为「学号后两位」，即排班点名的 N 号；
 *      演讲页发布后全班可见，故**不下发完整学号**，隐私口径不变）；
 *   ② 姓名可点击 = 按钮，按下效果要与页面其它按钮统一（press-dim + hover 0/60）；
 *   ③ 点姓名「换演讲人」弹层 UI 与其它弹层统一（头像 + 姓名/学号 + 分隔线 + tap-hover）。
 *
 * 判据尽量真跑页内纯函数 + 真扫三份源码；每条核心口径都配变异自证（改坏必须翻红）。
 *
 * 用法：node scripts/check-speech-no-and-swap-ui.js
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

/** 从 js 抽顶层 `function <name>(...) {...}` 整段（花括号配对，不靠缩进） */
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

/** 真跑学号楼：沙盒**只装 speechNameCells**，故意不注入 util，
 *  这样「内联算后两位、不依赖外部」本身也成了判据的一部分。 */
function loadFn(js) {
  const src = fnSource(stripJs(js), 'speechNameCells');
  if (!src) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(src + '\nreturn speechNameCells;')();
  } catch (e) {
    return null;
  }
}

function evalAll(s) {
  const w = stripXml(s.wxml);
  const fn = loadFn(s.js);

  let one = null, two = null, zero = null, dirty = null, surrogate = null;
  if (fn) {
    try {
      one = fn({ name: '示例成员01', studentNo: '000000000301' });
      two = fn({ name: '示例成员12', studentNo: '000000000312' });
      zero = fn({ name: '无号', studentNo: '' });
      /* 与 util.seqOf 同口径：'abc-12' 抽出数字 12 是合法号；真正不出号的是完全无数字 */
      dirty = fn({ name: '脏号', studentNo: 'abc' });
      surrogate = fn({ name: '𠮷野', studentNo: '000000000399' });
    } catch (e) {
      one = null;
    }
  }

  /* ① 学号后两位 */
  const seqOk = !!(one && two && one.seqText === '1' && two.seqText === '12'
    && Array.isArray(one.chars) && one.wide === false);
  const seqEmpty = !!(zero && zero.seqText === '' && dirty && dirty.seqText === '');
  const seqSurrogate = !!(surrogate && surrogate.chars && surrogate.chars.length === 2 && surrogate.seqText === '99');
  const noRender = (w.match(/<text class="sp-no">\{\{p\.seqText\}\}<\/text>/g) || []).length === 2;
  const cssNo = (s.wxss.match(/\.sp-no\s*\{[^}]*\}/) || [''])[0];
  const cssPerson = (s.wxss.match(/\.sp-person\s*\{[^}]*\}/) || [''])[0];
  /* 1.0.8.67：学号绝对定位钉在胶囊最右，胶囊用 position:relative 当基准 + 定宽留白 */
  const noFixed = /position:\s*absolute/.test(cssNo) && /right:\s*16rpx/.test(cssNo)
    && /text-align:\s*right/.test(cssNo)
    && /position:\s*relative/.test(cssPerson) && /padding:\s*8rpx 58rpx 8rpx 16rpx/.test(cssPerson);

  /* ② 人名按下效果：两处时段各一个 sp-person，属性齐全 */
  const personTags = w.match(/<view[^>]*class="sp-person"[^>]*>/g) || [];
  const personPress = personTags.length === 2 && personTags.every((t) =>
    /\bdata-pressable\b/.test(t)
    && /hover-class="press-dim"/.test(t)
    && /hover-start-time="0"/.test(t)
    && /hover-stay-time="60"/.test(t));

  /* ③ 换人弹层：只扫该 bottom-sheet 块，不误伤其它弹层 */
  const swapIdx = w.indexOf('show="{{spSwapShow}}"');
  const swapEnd = swapIdx >= 0 ? w.indexOf('</bottom-sheet>', swapIdx) : -1;
  const swap = (swapIdx >= 0 && swapEnd > swapIdx) ? w.slice(swapIdx, swapEnd) : '';
  const swapAvatar = /<avatar-tag[^>]*name="\{\{m\.name\}\}"[^>]*text="\{\{m\.seqText\}\}"[^>]*no-fallback="\{\{true\}\}"[^>]*size="\{\{64\}\}"/.test(swap);
  const swapRows = swap.match(/<view[^>]*class="sp-swap-row"[^>]*>/g) || [];
  const swapHover = swapRows.length === 1
    && /\bdata-pressable\b/.test(swapRows[0])
    && /hover-class="tap-hover"/.test(swapRows[0])
    && /hover-start-time="0"/.test(swapRows[0])
    && /hover-stay-time="60"/.test(swapRows[0]);
  const swapInfo = /<text class="dt-row-name">\{\{m\.name\}\}<\/text>/.test(swap)
    && /<text class="dt-row-sub">\{\{m\.studentNo\}\}<\/text>/.test(swap);
  /* 1.0.8.67：弹层固定高（spring-scroll 才滚）+ 列表去掉 overflow-y/max-height */
  const swapSheetTag = (swapIdx >= 0 ? w.slice(swapIdx, w.indexOf('>', swapIdx) + 1) : '');
  const swapScrollable = /height="\{\{1080\}\}"/.test(swapSheetTag)
    && !/max-height/.test(s.wxss.slice(s.wxss.indexOf('.sp-swap-list'), s.wxss.indexOf('.sp-swap-list') + 160))
    && !/overflow-y/.test(s.wxss.slice(s.wxss.indexOf('.sp-swap-list'), s.wxss.indexOf('.sp-swap-list') + 160));
  const oldSwapGone = !/class="sp-swap-name"/.test(w) && !/class="sp-swap-seq"/.test(w);
  const cssRow = (s.wxss.match(/\.sp-swap-row\s*\{[^}]*\}/) || [''])[0];
  const rowStyled = /min-height:\s*112rpx/.test(cssRow)
    && /padding:\s*16rpx 32rpx/.test(cssRow)
    && /border-bottom:\s*2rpx solid var\(--bg-fill\)/.test(cssRow);
  const rowLast = /\.sp-swap-row:last-child\s*\{[\s\S]*?border-bottom:\s*none/.test(s.wxss);

  return {
    fnOk: !!fn, seqOk, seqEmpty, seqSurrogate, noRender, noFixed,
    personPress, personCount: personTags.length,
    swapFound: !!swap, swapAvatar, swapHover, swapInfo, swapScrollable, oldSwapGone, rowStyled, rowLast
  };
}

const S = evalAll(SRC);

console.log('── ① 姓名后学号（后两位，不下发完整学号）');
check(S.fnOk, 'speechNameCells() 在无外部 util 的沙盒里可执行（口径内联）');
check(S.seqOk, '000000000301 → 「1」；000000000312 → 「12」，逐字 cells / wide 不受影响');
check(S.seqEmpty, '空号 / 脏号 → 不出学号（不显示 0 或乱码）');
check(S.seqSurrogate, '生僻字姓名仍按 Array.from 拆 1 字/字，学号照常出「99」');
check(S.noRender, '上午 / 下午两处姓名胶囊都渲染 {{p.seqText}}（2 处）');
check(S.noFixed, '.sp-no 绝对定位钉胶囊最右 + .sp-person 定宽留白（1/2 位号右边缘成一条竖线）');

console.log('\n── ② 人名按下效果与页面按钮统一');
check(S.personCount === 2, '两处时段各一个可点人名胶囊（找到 ' + S.personCount + ' 个）');
check(S.personPress, '人名胶囊带 data-pressable + press-dim + hover 0/60（同 dt-admin-btn）');

console.log('\n── ③ 换人弹层 UI 统一');
check(S.swapFound, '定位到 spSwapShow 弹层');
check(S.swapAvatar, '列表行有头像（avatar-tag：姓名 + N 号 + no-fallback + 64）');
check(S.swapHover, '列表行带 data-pressable + tap-hover + hover 0/60');
check(S.swapInfo, '行信息仍用 .dt-row-name / .dt-row-sub（与其它弹层同一套）');
check(S.oldSwapGone, '旧的朴素两列文字（.sp-swap-name / .sp-swap-seq）已下线');
check(S.rowStyled, '.sp-swap-row 与 .dt-group-row 同规格（112rpx / 16rpx 32rpx / --bg-fill 分隔线）');
check(S.rowLast, '最后一行去掉分隔线');
check(S.swapScrollable, '换人弹层固定高 1080rpx + 列表无 overflow-y/max-height（交给 spring-scroll 滚）');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '不再算学号后两位', probe: 'seqOk', file: 'js',
    from: "const seqText = (!isNaN(n) && n > 0) ? String(n) : '';", to: "const seqText = '';" },
  { name: '沙盒里改成依赖 util.seqOf（页内没 require 时直接崩）', probe: 'seqOk', file: 'js',
    from: "const raw = String((p && p.studentNo) == null ? '' : p.studentNo).replace(/\\D/g, '');",
    to: "const raw = util.seqOf(p && p.studentNo);" },
  { name: 'wxml 删掉姓名后的学号', probe: 'noRender', file: 'wxml',
    apply: (src) => src.split('<text class="sp-no">{{p.seqText}}</text>').join('') },
  { name: '.sp-no 去掉绝对定位（退回 flex 占位，号位不再成竖线）', probe: 'noFixed', file: 'wxss',
    from: 'position: absolute; right: 16rpx; top: 50%; transform: translateY(-50%); width: 34rpx;',
    to: 'flex: 0 0 34rpx; margin-left: 10rpx;' },
  { name: '.sp-person 去掉 position:relative（学号绝对定位基准丢失）', probe: 'noFixed', file: 'wxss',
    from: 'position: relative; display: flex; align-items: center; padding: 8rpx 58rpx 8rpx 16rpx;',
    to: 'display: flex; align-items: center; padding: 8rpx 16rpx;' },
  { name: '人名胶囊去掉 press-dim 按下反馈', probe: 'personPress', file: 'wxml',
    apply: (src) => src.split(' hover-class="press-dim" hover-start-time="0" hover-stay-time="60"').join('') },
  { name: '换人弹层去掉头像（退回朴素文字行）', probe: 'swapAvatar', file: 'wxml',
    apply: (src) => {
      const i = src.indexOf('show="{{spSwapShow}}"');
      if (i < 0) return src;
      const end = src.indexOf('</bottom-sheet>', i);
      const block = src.slice(i, end);
      const needle = '<avatar-tag name="{{m.name}}" text="{{m.seqText}}" no-fallback="{{true}}" size="{{64}}" />';
      const j = block.indexOf(needle);
      if (j < 0) return src;
      return src.slice(0, i) + block.slice(0, j) + block.slice(j + needle.length) + src.slice(end);
    } },
  { name: '换人弹层去掉 tap-hover（锚点限定在换人弹层内，页面别处也用它）', probe: 'swapHover', file: 'wxml',
    apply: (src) => {
      const i = src.indexOf('show="{{spSwapShow}}"');
      if (i < 0) return src;
      const end = src.indexOf('</bottom-sheet>', i);
      const block = src.slice(i, end);
      const row = block.indexOf('class="sp-swap-row"');
      const needle = 'hover-class="tap-hover"';
      const j = row < 0 ? -1 : block.indexOf(needle, row);
      if (j < 0) return src;
      const fixed = block.slice(0, j) + 'hover-class=""' + block.slice(j + needle.length);
      return src.slice(0, i) + fixed + src.slice(end);
    } },
  { name: '换人弹层退回旧的两列文字样式', probe: 'rowStyled', file: 'wxss',
    from: 'min-height: 112rpx; padding: 16rpx 32rpx;', to: 'padding: 20rpx 8rpx;' },
  { name: '换人弹层去掉固定高（56 人又滚不动）', probe: 'swapScrollable', file: 'wxml',
    apply: (src) => {
      const i = src.indexOf('show="{{spSwapShow}}"');
      if (i < 0) return src;
      const gt = src.indexOf('>', i);
      const tag = src.slice(i, gt + 1);
      const fixed = tag.replace(/height="\{\{1080\}\}"\s*/, '');
      if (fixed === tag) return src;
      return src.slice(0, i) + fixed + src.slice(gt + 1);
    } },
  { name: '换人弹层列表加回 overflow-y（view 上无效、假修复）', probe: 'swapScrollable', file: 'wxss',
    from: '.sp-swap-list { padding: 8rpx 0 24rpx; }',
    to: '.sp-swap-list { max-height: 60vh; overflow-y: auto; padding: 8rpx 0 24rpx; }' }
];

MUT.forEach((mu) => {
  const src = SRC[mu.file];
  if (!mu.apply && src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const nextSrc = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [mu.file]: nextSrc });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲学号 / 按下效果 / 换人弹层检查全部通过'));
process.exit(failed ? 1 : 0);
