/**
 * 门禁：值日页 / 手动排班页的「左右滑动切周」
 * ------------------------------------------------------------
 * 背景（2026-09-26，v0.7.10）：
 *   ① 值日页「长按周切换条可快速跳转」的提示去掉；
 *   ② 值日页 + 手动排班页支持左右滑动切换上/下一周（共用 utils/swipe.js）。
 *
 * 为什么值得上门禁：
 *   · 手势是「看不见的入口」——被删掉/被覆盖时不会有任何报错，只是「滑不动了」；
 *   · 弹层 DOM 就在页面根节点里，一旦漏挡，在弹层里横滑会**偷偷换周**（数据被换掉，
 *     用户还以为是自己点错了）——这一条比「滑不动」更危险，必须断言存在；
 *   · 课表页主体是 scroll-x，绝不能挂这个手势（会抢横向滚动），也要断言「没挂」。
 *
 * 自证：直接 require `utils/swipe.js`，用合成 touch 事件跑真实判定
 *      （左滑→next / 右滑→prev / 位移太小→'' / 斜滑以纵向为主→''）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = p => fs.existsSync(path.join(ROOT, p));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

/* ============================================================
 * ① 手势工具本体：真实行为自证
 * ============================================================ */
console.log('── ① utils/swipe.js 行为自证');
let swipe = null;
if (!exists('miniprogram/utils/swipe.js')) bad('缺少 miniprogram/utils/swipe.js');
else {
  swipe = require(path.join(ROOT, 'miniprogram/utils/swipe.js'));
  if (typeof swipe.begin === 'function' && typeof swipe.end === 'function') ok('导出 begin / end');
  else bad('缺少 begin / end 导出');

  const run = (x0, y0, x1, y1) => {
    const page = {};
    swipe.begin(page, { touches: [{ clientX: x0, clientY: y0 }] });
    return swipe.end(page, { changedTouches: [{ clientX: x1, clientY: y1 }] });
  };
  const cases = [
    [200, 400, 120, 400, 'next', '左滑 → 下一周'],
    [120, 400, 200, 400, 'prev', '右滑 → 上一周'],
    [200, 400, 180, 400, '', '位移太小 → 不动'],
    [200, 400, 150, 560, '', '斜滑（纵向为主）→ 让给页面滚动'],
    [200, 400, 400, 400, 'prev', '大位移右滑 → 上一周']
  ];
  cases.forEach(([x0, y0, x1, y1, expect, label]) => {
    const got = run(x0, y0, x1, y1);
    if (got === expect) ok(label + '（' + (expect || '不动') + '）');
    else bad(label + '：期望 ' + (expect || '不动') + '，实得 ' + (got || '不动'));
  });
  // 起止缺失时不得抛异常
  const empty = swipe.end({}, { changedTouches: [{ clientX: 10, clientY: 10 }] });
  if (empty === '') ok('没有 touchstart 时安全返回（不抛异常）');
  else bad('缺少起点时返回值异常：' + empty);
}

/* ============================================================
 * ② 两个页面：挂载 + 弹层挡板
 * ============================================================ */
console.log('\n── ② 页面挂载与弹层挡板');
[['pages/duty', '值日页'], ['pages/manual', '手动排班页']].forEach(([p, label]) => {
  const wxml = read('miniprogram/' + p + '/index.wxml');
  const js = read('miniprogram/' + p + '/index.js');
  has(wxml, /bindtouchstart="onSwipeStart"/, label + ' 根节点挂了 onSwipeStart');
  has(wxml, /bindtouchend="onSwipeEnd"/, label + ' 根节点挂了 onSwipeEnd');
  has(js, /require\('\.\.\/\.\.\/utils\/swipe'\)/, label + ' 引入 utils/swipe');
  has(js, /onSwipeEnd\(e\)\s*\{[\s\S]{0,240}?return;[\s\S]{0,200}?swipe\.end\(this, e\)/,
    label + ' onSwipeEnd 里先挡弹层再判方向');
  has(js, /_shiftWeek\(delta\)\s*\{[\s\S]{0,160}?onWeekChange\(\{ detail: \{ week: Number\(this\.data\.week\) \+ delta \} \}\)/,
    label + '_shiftWeek 复用 onWeekChange（含边界校验）');
});
has(read('miniprogram/pages/duty/index.js'), /sheetShow \|\| this\.data\.aiShow \|\| this\.data\.groupShow/,
  '值日页挡掉全部三个弹层（详情 / 一键生成 / 合并行成员）');
has(read('miniprogram/pages/manual/index.js'), /if \(this\.data\.pickerShow\) return;/,
  '手动排班页挡掉选人弹层');

/* ============================================================
 * ③ 提示已移除 + 课表页不得挂手势
 * ============================================================ */
console.log('\n── ③ 旧提示移除 / 课表页不被误加');
let leaked = false;
if (exists('miniprogram/pages/duty/index.js')) {
  const s = read('miniprogram/pages/duty/index.js');
  if (/长按周切换条可快速跳转/.test(s)) bad('值日页仍残留「长按周切换条可快速跳转」提示');
  else ok('值日页已无「长按周切换条可快速跳转」提示');
  if (/onWeekPick/.test(s)) bad('值日页仍残留 onWeekPick 死代码');
  else ok('值日页 onWeekPick 死代码已清除');
}
if (/长按周切换条可快速跳转/.test(read('miniprogram/pages/duty/index.wxml'))) { leaked = true; }
['miniprogram/pages/duty/index.wxml', 'miniprogram/pages/manual/index.wxml'].forEach((f) => {
  if (/bind:pick=/.test(read(f))) { leaked = true; bad(f + ' 仍绑定 bind:pick（已无处理函数）'); }
});
if (!leaked) ok('两个页面都没有残留 bind:pick / 旧提示');

const tt = read('miniprogram/pages/timetable/index.wxml');
if (/onSwipeStart/.test(tt)) bad('课表页挂了切周手势（会与 scroll-x 抢横向滚动）');
else ok('课表页未挂切周手势（与 scroll-x 不冲突）');

/* ============================================================
 * ④ 切周动画（v0.7.11）：时序 + 样式 + 挂载
 * ============================================================
 * 动画是「看不见的契约」：JS 改了时长、CSS 忘了同步，或者谁把 fixed 元素
 * 挪进动画容器（transform 会创建包含块 → fixed 跟着一起飘），都不会报错，
 * 只会表现为「动画怪怪的 / 底部条跟着晃」。这些只能靠断言守住。
 */
console.log('\n── ④ 切周动画（utils/swipe.js + app.wxss + 页面容器）');

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** 假页面：记录每一次 setData，便于回放真实的动画时序 */
function fakePage(data) {
  const p = { data: Object.assign({}, data), calls: [] };
  p.setData = (o) => { Object.assign(p.data, o); p.calls.push(JSON.parse(JSON.stringify(o))); };
  return p;
}
/** 当前生效的动画 class —— 取 data 里的最新值（最后一次 setData 可能不带这个字段） */
const lastCls = p => p.data.swipeCls || '';

(async () => {
  /* --- 4.1 方向 → class 映射 --- */
  if (swipe) {
    if (swipe.animOut('next') === 'wk-out-left' && swipe.animIn('next') === 'wk-in-right') ok('左滑（下一周）：out-left → in-right');
    else bad('左滑动画 class 不对：' + swipe.animOut('next') + ' / ' + swipe.animIn('next'));
    if (swipe.animOut('prev') === 'wk-out-right' && swipe.animIn('prev') === 'wk-in-left') ok('右滑（上一周）：out-right → in-left');
    else bad('右滑动画 class 不对：' + swipe.animOut('prev') + ' / ' + swipe.animIn('prev'));
    if (swipe.animEdge('next') === 'wk-edge-left' && swipe.animEdge('prev') === 'wk-edge-right') ok('到头回弹 class 与方向一致');
    else bad('回弹动画 class 不对');

    /* --- 4.2 时序：先滑走旧内容，再换数据 --- */
    let went = null;
    const p1 = fakePage({ week: 3, totalWeeks: 16 });
    const r1 = swipe.shift(p1, 1, (w) => { went = w; });
    if (r1 === true) ok('正常切周返回 true');
    else bad('正常切周应返回 true，实得 ' + r1);
    if (lastCls(p1) === 'wk-out-left') ok('同步阶段：先播离场动画（旧内容滑走）');
    else bad('同步阶段应播 wk-out-left，实得 ' + lastCls(p1));
    if (went === null) ok('离场动画期间**不换数据**（不会先白一下再动）');
    else bad('离场动画期间就换了数据（会先白一下再动）');
    await sleep((swipe.OUT_MS || 160) + 90);
    if (went === 4) ok('离场结束后才换数据（3 → 4）');
    else bad('离场结束后应切到第 4 周，实得 ' + went);
    if (lastCls(p1) === 'wk-in-right') ok('换数据的同时播入场动画（新内容滑入）');
    else bad('换数据时应播 wk-in-right，实得 ' + lastCls(p1));

    // 反向
    let went2 = null;
    const p2 = fakePage({ week: 9, totalWeeks: 16 });
    swipe.shift(p2, -1, (w) => { went2 = w; });
    if (lastCls(p2) === 'wk-out-right') ok('右滑同步阶段播 wk-out-right');
    else bad('右滑同步阶段应播 wk-out-right，实得 ' + lastCls(p2));
    await sleep((swipe.OUT_MS || 160) + 90);
    if (went2 === 8 && lastCls(p2) === 'wk-in-left') ok('右滑：9 → 8，入场 wk-in-left');
    else bad('右滑时序不对：week=' + went2 + ' cls=' + lastCls(p2));

    /* --- 4.3 越界：只回弹，不换数据 --- */
    let went3 = null;
    const p3 = fakePage({ week: 16, totalWeeks: 16 });
    const r3 = swipe.shift(p3, 1, (w) => { went3 = w; });
    if (r3 === false) ok('最后一周继续左滑：返回 false（不切换）');
    else bad('越界应返回 false，实得 ' + r3);
    if (lastCls(p3) === 'wk-edge-left') ok('越界播回弹动画（滑到头有反馈，不再静默）');
    else bad('越界应播 wk-edge-left，实得 ' + lastCls(p3));
    await sleep((swipe.EDGE_MS || 220) + 90);
    if (went3 === null) ok('越界全程不换数据');
    else bad('越界竟然换了数据：' + went3);
    if (lastCls(p3) === '') ok('回弹结束后 class 清空（不残留 will-change）');
    else bad('回弹结束后应清空 class，实得 ' + lastCls(p3));

    let went4 = null;
    const p4 = fakePage({ week: 1, totalWeeks: 16 });
    swipe.shift(p4, -1, (w) => { went4 = w; });
    if (lastCls(p4) === 'wk-edge-right') ok('第 1 周继续右滑：回弹 wk-edge-right');
    else bad('第 1 周右滑应播 wk-edge-right，实得 ' + lastCls(p4));
    await sleep((swipe.EDGE_MS || 220) + 90);
    if (went4 === null) ok('第 1 周右滑不换数据');
    else bad('第 1 周右滑竟然换了数据');

    /* --- 4.4 cancel：页面销毁后不得再 setData --- */
    let went5 = null;
    const p5 = fakePage({ week: 5, totalWeeks: 16 });
    swipe.shift(p5, 1, (w) => { went5 = w; });
    swipe.cancel(p5);
    await sleep((swipe.OUT_MS || 160) + 90);
    if (went5 === null) ok('cancel 后定时器不再触发（页面销毁安全）');
    else bad('cancel 之后定时器仍然触发了换数据');
  } else bad('swipe 未加载，跳过动画时序自证');

  /* --- 4.5 CSS：6 个 class + 时长与 JS 一致 --- */
  const css = read('miniprogram/app.wxss');
  [['wk-out-left', 'wkOutLeft'], ['wk-out-right', 'wkOutRight'],
   ['wk-in-left', 'wkInLeft'], ['wk-in-right', 'wkInRight'],
   ['wk-edge-left', 'wkEdgeLeft'], ['wk-edge-right', 'wkEdgeRight']].forEach(([cls, kf]) => {
    const reRule = new RegExp('\\.' + cls + '\\s*\\{[^}]*animation:\\s*' + kf + '\\s');
    const reKf = new RegExp('@keyframes\\s+' + kf + '\\s*\\{');
    if (reRule.test(css) && reKf.test(css)) ok('app.wxss 定义了 .' + cls + ' → @keyframes ' + kf);
    else bad('app.wxss 缺少 .' + cls + ' 或 @keyframes ' + kf);
  });
  // 只动 GPU 属性：keyframes 里出现 width/left/margin/height 就是掉帧信号
  const kfBlock = (css.match(/@keyframes\s+wk(Out|In|Edge)\w*\s*\{[\s\S]*?\}\s*\}/g) || []).join('\n');
  if (kfBlock && !/animation-fill|width|height|margin|left|right|top|bottom/.test(kfBlock)) ok('切周 keyframes 只动 transform / opacity');
  else if (kfBlock) bad('切周 keyframes 动了布局属性（width/left/margin…），长列表会掉帧');
  else bad('没解析到切周 keyframes');
  // 时长一致性：JS 改了 OUT_MS / IN_MS，CSS 必须同步（否则动画被截断或空等）
  const dur = (cls) => {
    const m = new RegExp('\\.' + cls + '\\s*\\{\\s*animation:\\s*\\w+\\s+\\.?([\\d.]+)s').exec(css);
    return m ? Math.round(parseFloat('0.' + String(m[1]).replace(/^0?\./, '')) * 1000) : null;
  };
  const outCss = dur('wk-out-left');
  const inCss = dur('wk-in-right');
  if (swipe && outCss === swipe.OUT_MS) ok('离场时长 JS/CSS 一致（' + outCss + 'ms）');
  else bad('离场时长不一致：JS ' + (swipe && swipe.OUT_MS) + 'ms vs CSS ' + outCss + 'ms');
  if (swipe && inCss === swipe.IN_MS) ok('入场时长 JS/CSS 一致（' + inCss + 'ms）');
  else bad('入场时长不一致：JS ' + (swipe && swipe.IN_MS) + 'ms vs CSS ' + inCss + 'ms');
  if (/prefers-reduced-motion[\s\S]{0,200}?wk-out-left/.test(css)) ok('尊重 prefers-reduced-motion（系统减弱动效时关闭）');
  else bad('切周动画没有 prefers-reduced-motion 兜底');

  /* --- 4.6 两页：容器挂载 + fixed 元素在容器外 --- */
  [['pages/duty', '值日页', '<duty-sheet', '值日详情弹层'],
   ['pages/manual', '手动排班页', 'class="ms-bar"', '底部固定条']].forEach(([p, label, fixedMark, fixedName]) => {
    const wxml = read('miniprogram/' + p + '/index.wxml');
    const js = read('miniprogram/' + p + '/index.js');
    has(wxml, /<view class="wk-swipe \{\{swipeCls\}\}">/, label + ' 数据区套了 wk-swipe 动画容器');
    has(js, /swipeCls:\s*''/, label + ' data 里初始化 swipeCls');
    has(js, /swipe\.shift\(this, delta,/, label + ' 换周走 swipe.shift（带动画）');
    has(js, /_applyWeek\(wk\)\s*\{/, label + ' 抽出 _applyWeek（动画播完才换数据）');
    has(js, /onUnload\(\)\s*\{[\s\S]{0,120}?swipe\.cancel\(this\)/, label + ' onUnload 清掉动画定时器');
    // fixed 元素必须在动画容器闭合之后（容器内放 fixed 会被 transform 变成包含块）
    // 匹配元素本身（class="…"），别把注释里提到的类名算进去
    const closeAt = wxml.indexOf('</block>\n  </view>');
    const fixedAt = wxml.indexOf(fixedMark);
    if (closeAt >= 0 && fixedAt > closeAt) ok(label + ' 的 ' + fixedName + '（' + fixedMark + '）在动画容器外');
    else bad(label + ' 的 ' + fixedName + ' 位置可疑：必须在 wk-swipe 容器之外（fixed 会被 transform 捕获）');
  });

  /* --- 4.7 页面接线：直接 eval 页面源码里的 onWeekChange / _applyWeek 跑一遍 ---
   * 形态断言只能证明「写了这几行」，证明不了「接对了」。这里把真实源码抽出来执行，
   * 看它是不是真的先播动画、再换数据、最后调 load —— 不写副本，避免与生产漂移。 */
  const methodBody = (src, name) => {
    const m = new RegExp('\\n  ' + name + '\\(([^)]*)\\)\\s*\\{').exec(src);
    if (!m) return null;
    const start = src.indexOf('{', m.index);
    let depth = 0; let j = start;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (!depth) break; }
    }
    return { args: m[1], body: src.slice(start, j + 1) };
  };
  // 把真实的 swipe 模块注入闭包（页面源码里用的是模块级 `swipe`，不注入就是 undefined）
  const compile = (src, name) => {
    const f = methodBody(src, name);
    return f ? new Function('swipe', 'return function ' + name + '(' + f.args + ')' + f.body)(swipe) : null;
  };

  for (const item of [['pages/duty', '值日页'], ['pages/manual', '手动排班页']]) {
    const p = item[0]; const label = item[1];
    const src = read('miniprogram/' + p + '/index.js');
    const onWeekChange = compile(src, 'onWeekChange');
    const applyWeek = compile(src, '_applyWeek');
    if (!onWeekChange || !applyWeek) { bad(label + ' 抽不出 onWeekChange / _applyWeek 源码'); continue; }
    const loaded = [];
    const page = fakePage({ week: 3, totalWeeks: 16, expandId: 7 });
    page.load = () => loaded.push(page.data.week);
    page._hasData = true;
    page._applyWeek = applyWeek;
    onWeekChange.call(page, { detail: { week: 4 } });
    if (page.data.week === 3 && loaded.length === 0) ok(label + ' 点箭头：动画期间 week 未变、未刷新（' + lastCls(page) + '）');
    else bad(label + ' 点箭头竟然立刻换了数据（week=' + page.data.week + '）');
    if (lastCls(page) === 'wk-out-left') ok(label + ' 点箭头也走方向性动画（与滑动同一条路）');
    else bad(label + ' 点箭头没有播动画，实得 ' + lastCls(page));

    // 等动画 out 段结束（必须 await，否则下面的断言会跑在定时器之前）
    await sleep((swipe.OUT_MS || 160) + 90);
    if (page.data.week === 4) ok(label + ' 动画结束后切到第 4 周');
    else bad(label + ' 动画结束后 week 应为 4，实得 ' + page.data.week);
    if (loaded.length === 1 && loaded[0] === 4) ok(label + ' 切周后重新拉了数据（load 一次）');
    else bad(label + ' load 调用异常：' + JSON.stringify(loaded));
    if (lastCls(page) === 'wk-in-right') ok(label + ' 新数据带入场动画 wk-in-right');
    else bad(label + ' 新数据入场动画不对：' + lastCls(page));
    // 越界：点第 17 周（totalWeeks=16）不得换数据
    const p2 = fakePage({ week: 16, totalWeeks: 16 });
    p2.load = () => loaded.push(99);
    p2._applyWeek = applyWeek;
    onWeekChange.call(p2, { detail: { week: 17 } });
    if (p2.data.week === 16) ok(label + ' 越界周次被拦下（week 仍是 16）');
    else bad(label + ' 越界周次没拦住：week=' + p2.data.week);
    await sleep((swipe.EDGE_MS || 220) + 90);
    if (!loaded.includes(99)) ok(label + ' 越界不触发刷新');
    else bad(label + ' 越界竟然触发了刷新');
  }

  console.log('');
  if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
  console.log('OK · 左右滑动切周校验通过');
})();
