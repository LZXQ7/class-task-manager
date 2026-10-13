#!/usr/bin/env node
/**
 * 生成动效/观感预览页（v0.7.20 需求②③ ｜ v0.7.21 需求⑤ 规格④ 同步）
 * ------------------------------------------------------------
 * 用途：需求②③ 全是**观感类**验收（用户原话「太僵硬」「太丑了」），
 *   而小程序必须开开发者工具编译才能看到。这里把**真实的组件 wxss**
 *   原样搬进一个浏览器页面（只做 rpx→px ÷2 的单位换算），
 *   让改完立刻能看、能点、能反复对比，不必来回编译。
 *
 * ⚠️ 铁律：CSS **从源文件读**，不在这里重写一份 —— 否则预览会和真机漂移，
 *    变成「预览好看、真机难看」的假证据。这里只做三件事：
 *      ① rpx → px（÷2，375px 视口）；
 *      ② 把 app.wxss 里切周动画那一段（@keyframes wk* / .wk-* 规则）抠出来；
 *      ③ 补一层「浏览器 glue」（:active 模拟 hover-class、手机外框）。
 *    JS 侧的两拍节奏（stretch → settle）与 components/segmented/index.js 的
 *    _sync() 逐行对应，常量（INSET/OVER/IND_MS）也在下面标了出处。
 *
 * 用法：node scripts/gen-anim-preview.js
 * 产物：preview/v0.7.21-segmented-week-header.html
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------- ① 单位换算 + 顶层块解析 ---------------- */
const rpx2px = (css) => css.replace(/(\d+(?:\.\d+)?)rpx/g, (m, n) => (Number(n) / 2) + 'px');

/** 把 css 按顶层 `{}` 配对拆成 [{sel, text}]（处理 @media 里再嵌套一层的情况） */
function topLevelBlocks(css) {
  const blocks = [];
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf('{', i);
    if (start < 0) break;
    const sel = css.slice(i, start).trim();
    let depth = 0;
    let j = start;
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') { depth--; if (!depth) break; }
    }
    blocks.push({ sel, text: css.slice(i, j + 1) });
    i = j + 1;
  }
  return blocks;
}

/** 从 app.wxss 里抠出「切周动画」那一段。
 *  ⚠️ 判据必须同时看**选择器**与**块体**：`@media (prefers-reduced-motion: reduce) { .wk-out-left… }`
 *     的选择器里一个 `wk-` 都没有，只看选择器会把 reduced-motion 兜底整块漏掉。 */
function weekAnimCss(appWxss) {
  return topLevelBlocks(appWxss)
    .filter((b) => /\bwk-/.test(b.text) || /\bwk[A-Z]/.test(b.sel))
    .map((b) => b.text)
    .join('\n');
}

/* ---------------- ② 真样式来源 ---------------- */
const segCss = rpx2px(read('miniprogram/components/segmented/index.wxss'));
const wsCss = rpx2px(read('miniprogram/components/week-switcher/index.wxss'));
const wkCss = rpx2px(weekAnimCss(read('miniprogram/app.wxss')));

/* ---------------- ③ 图标（内联原 SVG，等价于 <app-icon name=arrow-* size=36>） ---------------- */
const iconSvg = (file) => read('miniprogram/assets/icons/' + file)
  .replace('width="24" height="24"', 'width="18" height="18"')
  .replace('<svg ', '<svg class="ic" ');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>v0.7.21 · 观感预览（分段指示器 + 切周）</title>
<style>
  /* ---------- 仅预览用的“浏览器 glue”（不属于小程序代码） ---------- */
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 72px; background: #E9ECF2;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1D2129; font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased;
  }
  .doc { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .lede { font-size: 12.5px; color: #5A6474; margin: 0 0 20px; }
  .lede code { background: #fff; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
  .cols { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  .col { flex: 1 1 340px; min-width: 320px; }
  .cap { font-size: 12px; color: #5A6474; margin: 0 0 8px; font-weight: 600; }
  .cap span { font-weight: 400; color: #8A93A3; }
  /* 手机外框：极光背景必须垫在下面，玻璃/半透明白才有东西可透（对齐 app.wxss 的 page） */
  .phone {
    width: 375px; max-width: 100%; margin: 0 auto;
    border-radius: 26px; overflow: hidden; box-shadow: 0 18px 46px rgba(31,38,135,.18);
    background-color: #F1F4F9;
    background-image: linear-gradient(135deg, #EAF1FF 0%, #DCE8FF 40%, #F3F0FF 100%);
    padding: 0 0 18px; min-height: 300px;
  }
  .navbar {
    height: 44px; display: flex; align-items: center; justify-content: center;
    font-size: 16px; font-weight: 600;
  }
  .stage { padding: 4px 0 10px; }
  .annot { font-size: 11.5px; color: #7A8496; text-align: center; margin: 10px 0 0; }
  .annot b { color: #3370FF; font-weight: 600; }
  /* :active 顶替小程序的 hover-class（真机上是 touchstart 立刻生效） */
  .ws-bubble:active { transform: scale(.92); opacity: .72; }
  .ws-card:active { transform: scale(.985); opacity: .86; }
  .seg-item:active { opacity: .55; }
  /* 模拟课表主体（只为演示切周动画） */
  .demo-board { padding: 0 16px; }
  .demo-grid {
    display: flex; gap: 6px; padding: 10px 12px; border-radius: 16px;
    background: rgba(255,255,255,.42); border: 1px solid rgba(255,255,255,.55);
    box-shadow: 0 8px 24px rgba(31,38,135,.10), inset 0 1px 0 rgba(255,255,255,.9);
  }
  .demo-cell {
    flex: 1; height: 46px; border-radius: 10px; background: rgba(51,112,255,.14);
    display: flex; align-items: center; justify-content: center; font-size: 11px; color: #2A4BA8;
  }
  .demo-hint { text-align: center; font-size: 11.5px; color: #7A8496; padding: 8px 0 0; }
  .btns { display: flex; gap: 8px; justify-content: center; padding: 12px 0 0; }
  .btn {
    font-size: 12px; padding: 6px 12px; border-radius: 999px; cursor: pointer; user-select: none;
    background: #fff; border: 1px solid #D8DEE9; color: #2A4BA8;
  }
  .btn:active { transform: scale(.96); }
  .swatches { display: flex; gap: 14px; flex-wrap: wrap; margin: 18px 0 0; }
  .swatch {
    flex: 1 1 300px; padding: 14px 16px; border-radius: 16px; background: #fff;
    box-shadow: 0 2px 10px rgba(31,38,135,.08);
  }
  .swatch h3 { font-size: 13px; margin: 0 0 6px; }
  .swatch ul { margin: 0; padding-left: 18px; font-size: 12.5px; color: #4E5969; }
  .swatch li { margin: 3px 0; }

  /* ---------- 以下三段 = 真实 wxss（scripts/gen-anim-preview.js 自动抽取，勿手改） ---------- */
  /* ==== components/segmented/index.wxss ==== */
${segCss}
  /* ==== components/week-switcher/index.wxss ==== */
${wsCss}
  /* ==== app.wxss · 切周动画段 ==== */
${wkCss}
</style>
</head>
<body>
<div class="doc">
  <h1>v0.7.21 · 观感预览（分段指示器 + 切周）</h1>
  <p class="lede">
    样式来自真实源文件（<code>components/segmented/index.wxss</code>、<code>components/week-switcher/index.wxss</code>、
    <code>app.wxss</code> 的切周动画段），只做了 rpx→px ÷2；两拍节奏的常量与
    <code>components/segmented/index.js</code> 一致。真机观感以开发者工具为准。
  </p>

  <div class="cols">
    <div class="col">
      <p class="cap">① 分段控件 <span>· 点 A 组 / B 组、按日 / 按人：指示器先冲再弹，字微微变大</span></p>
      <div class="phone">
        <div class="navbar">课表</div>
        <div class="stage">
          <div id="seg1" style="margin:0 auto"></div>
          <p class="annot">width 240rpx（A 组 / B 组）</p>
          <div id="seg2" style="margin:16px auto 0"></div>
          <p class="annot">width 320rpx（按日 / 按人）</p>
          <div id="seg3" style="margin:16px auto 0"></div>
          <p class="annot">width 686rpx（5 项，调课弹层）· 指示器宽度自动等分</p>
          <div class="btns">
            <div class="btn" id="segBurst">连点 4 下（看能不能中途续接）</div>
          </div>
        </div>
      </div>
    </div>

    <div class="col">
      <p class="cap">② 日期头 <span>· 气泡箭头 + 日期卡（右为值日页，带发布状态）</span></p>
      <div class="phone">
        <div class="navbar">课表</div>
        <div class="stage">
          <div class="ws" id="ws1">
            <div class="ws-bubble" data-d="-1">${iconSvg('arrow-left-gray.svg')}</div>
            <div class="ws-card">
              <div class="ws-range">9/14 - 9/20</div>
              <div class="ws-sub">
                <span class="ws-odd">第 2 周 · 双周</span>
                <span class="ws-now"><span class="ws-dot"></span>本周</span>
              </div>
            </div>
            <div class="ws-bubble" data-d="1">${iconSvg('arrow-right-gray.svg')}</div>
          </div>
          <p class="annot">课表页：无状态标签，下行自然居中</p>

          <div class="ws" style="margin-top:18px" id="ws2">
            <div class="ws-bubble off" data-d="-1">${iconSvg('arrow-left-gray.svg')}</div>
            <div class="ws-card">
              <div class="ws-range">9/14 - 9/20</div>
              <div class="ws-sub">
                <span class="ws-odd">第 1 周 · 单周</span>
                <span class="ws-status published">已发布</span>
              </div>
            </div>
            <div class="ws-bubble" data-d="1">${iconSvg('arrow-right-gray.svg')}</div>
          </div>
          <p class="annot">值日页 / 手动排班页：第 1 周，左气泡压暗（到头）</p>
        </div>
      </div>
    </div>
  </div>

  <p class="cap" style="margin-top:22px">③ 课表左右切换动画 <span>· 点气泡箭头：旧内容滑走 → 换数据 → 新内容从反方向滑入（与值日页同一套 keyframes）</span></p>
  <div class="phone" style="min-height:0">
    <div class="navbar">课表</div>
    <div class="ws" id="ws3">
      <div class="ws-bubble" data-d="-1">${iconSvg('arrow-left-gray.svg')}</div>
      <div class="ws-card"><div class="ws-range" id="range3">9/14 - 9/20</div>
        <div class="ws-sub"><span class="ws-odd" id="odd3">第 2 周 · 双周</span></div>
      </div>
      <div class="ws-bubble" data-d="1">${iconSvg('arrow-right-gray.svg')}</div>
    </div>
    <div class="wk-swipe" id="wk3" style="margin-top:14px">
      <div class="demo-board">
        <div class="demo-grid" id="board3">
          <div class="demo-cell">周一</div><div class="demo-cell">周二</div><div class="demo-cell">周三</div>
          <div class="demo-cell">周四</div><div class="demo-cell">周五</div>
        </div>
      </div>
      <div class="demo-hint">（课表主体示意；真机为「节次列 + 可横向滚动的日期格」）</div>
    </div>
  </div>

  <div class="swatches">
    <div class="swatch">
      <h3>改了什么</h3>
      <ul>
        <li><b>segmented</b>：白底从「选中项自己变白」改成<b>独立胶囊指示器</b>，两拍 <code>stretch(140ms 预冲) → settle(220ms 回弹)</code>，与底栏 <code>.tab-ind</code> 同一套曲线。</li>
        <li><b>segmented</b>：选中项字号 26rpx → <b>30rpx</b> + 600 字重，切走缩回；等分格宽固定，变大不会挤动邻项。</li>
        <li><b>week-switcher</b>：去掉通底白条（「太丑」的主因），改成 <b>两枚 76rpx 玻璃气泡箭头 + 中间日期卡</b>。</li>
        <li><b>week-switcher</b>：日期区间升到 32rpx 主体；「本周」由孤点改为圆点+文字；状态标签移到下行末尾。</li>
        <li><b>课表页</b>：左右切换接入 <code>utils/swipe</code> 的方向性动画（<b>不挂触摸手势</b>，避开 scroll-x）。</li>
      </ul>
    </div>
  </div>
</div>

<script>
/* ================= 分段控件：两拍节奏镜像 =================
 * 与 miniprogram/components/segmented/index.js 的 _sync() 逐行对应。
 * 常量出处：INSET_RPX / OVER_RPX / IND_MS（index.js 顶部）。
 * 单位：这里全程用 rpx 计算，写 style 时统一 ÷2 转 px。 */
var INSET_RPX = 3, OVER_RPX = 8, IND_MS = 140;
var px = function (rpx) { return (rpx / 2) + 'px'; };

function mountSeg(rootSel, widthRpx, items, value) {
  var root = document.querySelector(rootSel);
  root.style.width = px(widthRpx);
  root.innerHTML = '<div class="seg-ind"></div>' + items.map(function (it) {
    return '<div class="seg-item' + (it.key === value ? ' on' : '') + '" data-key="' + it.key + '">' + it.text + '</div>';
  }).join('');

  var st = { value: value, cur: undefined, timer: null };
  var ind = root.querySelector('.seg-ind');

  function sync(animateAllowed) {
    var n = items.length || 1;
    var cell = widthRpx / n;                                  // _cell()
    var idx = 0, i;
    for (i = 0; i < items.length; i++) { if (items[i].key === st.value) { idx = i; break; } }
    var normLeft = Math.round(idx * cell + INSET_RPX);
    var normWidth = Math.round(cell - INSET_RPX * 2);
    var prev = st.cur;

    if (prev === idx) {
      if (st.timer) return;                                   // 两拍进行中：重复通知不插手
      place(normLeft, normWidth, '');
      return;
    }
    st.cur = idx;
    if (typeof prev !== 'number' || !animateAllowed) { place(normLeft, normWidth, ''); return; }

    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    place(normLeft + (idx > prev ? OVER_RPX : -OVER_RPX), normWidth, 'stretch');   // 拍 1
    st.timer = setTimeout(function () {                       // 拍 2
      st.timer = null;
      place(normLeft, normWidth, 'settle');
    }, IND_MS);
  }
  function place(left, width, cls) {
    // 与真组件一致：位移走 transform（v0.7.21 需求⑤ 规格④），left 恒为 0
    ind.style.transform = 'translateX(' + px(left) + ')';
    ind.style.width = px(width);
    ind.className = 'seg-ind' + (cls ? ' ' + cls : '');
  }
  function setValue(v) {
    if (v === st.value) return;
    st.value = v;
    Array.prototype.forEach.call(root.querySelectorAll('.seg-item'), function (el) {
      el.className = 'seg-item' + (el.dataset.key === v ? ' on' : '');
    });
    sync(true);
  }

  root.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('.seg-item');
    if (el) setValue(el.dataset.key);
  });
  sync(false);   // 首次定位：直接落位，不做「从最左边滑过来」
  return { root: root, setValue: setValue, st: st };
}

var s1 = mountSeg('#seg1', 240, [{ key: 'A', text: 'A 组' }, { key: 'B', text: 'B 组' }], 'A');
var s2 = mountSeg('#seg2', 320, [{ key: 'day', text: '按日' }, { key: 'person', text: '按人' }], 'day');
var s3 = mountSeg('#seg3', 686, [
  { key: 'week', text: '本周' }, { key: 'multi', text: '多周次' }, { key: 'date', text: '按日期' },
  { key: 'ai', text: 'AI 调课' }, { key: 'list', text: '结果' }
], 'week');

/* 连点：验证「中途改目标不会跳变、跟随最后一次有效选择」 */
document.getElementById('segBurst').addEventListener('click', function () {
  var seq = ['B', 'A', 'B', 'A'], i = 0;
  var t = setInterval(function () {
    if (i >= seq.length) { clearInterval(t); return; }
    s1.setValue(seq[i++]);
  }, 70);
});

/* ================= 气泡箭头 / 切周动画 =================
 * 时序与 miniprogram/utils/swipe.js 的 shift() 一致：out 160ms → 换 → in 220ms。 */
var OUT_MS = 160;
(function () {
  var week = 2, TOTAL = 16;
  var wk = document.getElementById('wk3');
  var range = document.getElementById('range3');
  var odd = document.getElementById('odd3');
  var board = document.getElementById('board3');
  var timer = null;
  function render() {
    // 与 components/week-switcher/index.js 的 _calc() 同口径（这里只示意日期）
    var start = 14 + (week - 1) * 7;
    range.textContent = '9/' + start + ' - 9/' + (start + 6) + '（示意）';
    odd.textContent = '第 ' + week + ' 周 · ' + (week % 2 === 1 ? '单周' : '双周');
  }
  render();

  document.querySelectorAll('#ws1 .ws-bubble, #ws2 .ws-bubble, #ws3 .ws-bubble').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.closest('#ws3')) { shiftWeek(Number(b.dataset.d)); return; }
      // 上面两块只做观感演示：气泡按一下弹回（真机是 hover-class 缩到 .92）
      b.animate([{ transform: 'scale(.92)' }, { transform: 'scale(1)' }],
        { duration: 180, easing: 'cubic-bezier(.32,1.2,.64,1)' });
    });
  });

  function shiftWeek(delta) {
    var next = week + delta;
    var dir = delta > 0 ? 'next' : 'prev';
    if (timer) { clearTimeout(timer); timer = null; }
    if (next < 1 || next > TOTAL) {                       // 越界：只回弹
      wk.className = 'wk-swipe ' + (dir === 'next' ? 'wk-edge-left' : 'wk-edge-right');
      timer = setTimeout(function () { wk.className = 'wk-swipe'; timer = null; }, 220);
      return;
    }
    wk.className = 'wk-swipe ' + (dir === 'next' ? 'wk-out-left' : 'wk-out-right');
    timer = setTimeout(function () {
      wk.className = 'wk-swipe ' + (dir === 'next' ? 'wk-in-right' : 'wk-in-left');
      week = next;
      render();
      board.style.background = (week % 2 ? 'rgba(51,112,255,.14)' : 'rgba(124,92,255,.14)');
      timer = null;
    }, OUT_MS);
  }
})();
</script>
</body>
</html>
`;

const out = path.join(ROOT, 'preview', 'v0.7.21-segmented-week-header.html');
fs.writeFileSync(out, html, 'utf8');
console.log('✅ 已生成 ' + path.relative(ROOT, out).replace(/\\/g, '/'));
console.log('   样式来源：components/segmented/index.wxss + components/week-switcher/index.wxss + app.wxss（切周动画段）');
console.log('   仅做 rpx→px ÷2；两拍常量 INSET_RPX=3 / OVER_RPX=8 / IND_MS=140 与组件 index.js 一致');
