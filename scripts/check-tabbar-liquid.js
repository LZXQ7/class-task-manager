/**
 * 门禁：液态 Tab 指示器（v0.7.14，第 32 个门禁）
 * ------------------------------------------------------------
 * 背景：截图①（Liquid Tab Indicator）要求独立胶囊指示背景在标签间移动，
 * 「先拉长、再收拢」+ 微回弹；连续点击从当前可见位置续接；文字/命中区不动。
 *
 * 为什么值得上门禁：
 *   · 指示器两拍（stretch → settle）靠 setTimeout 接力，时长写在 JS（IND_MS）、
 *     节奏写在 CSS（.tab-ind.stretch 的 .14s）—— 改一处忘另一处不会报错，
 *     只是回弹手感对不上（stretch 拍提前被 settle 覆盖 = 拉长看不见）；
 *   · 「先拉长再收拢」的命门是 settle 用 overshoot 曲线（第二控制点 >1）——
 *     谁把它改回普通 ease-out，回弹就没了，静态看不出来；
 *   · 指示器节点必须在 tab-item **之前**（天然垫底）：挪到后面又忘加 z-index
 *     就会盖住图标 —— 这类「层级靠 DOM 顺序」的约定最容易被无意破坏；
 *   · 切失败回退必须连指示器一起归位，否则胶囊停在一个没打开的 tab 上。
 *
 * v0.7.14 第 3 次调整（2026-09-26 用户截图「位置不对 / 上方有空白 / 收窄底栏」）后新增三条铁律：
 *   · ⚠️ **定位基准是胶囊内容宽（750 − 2×SIDE_RPX），不是写死 750rpx**。
 *     JS 的 `SIDE_RPX` 必须与 wxss 的 `margin` 左右值一致（本门禁绑定校验）。
 *     历史 bug：第 3 轮把左右内缩设成 40rpx（可用宽 670rpx），JS 却仍按 750/4 算
 *     → 指示器整条右偏，最后一格偏右 84rpx（截图里压在「我的」文字右半边、顶到胶囊右缘）。
 *     改一处忘另一处看不出来，所以这条绑定必须由门禁守。
 *   · ⚠️ 第 4 次调整（同日稍后，用户反馈「两边不要留白」）：`SIDE_RPX` 归 0、左右贴边铺满，
 *     所以**不要再把 40 当成正确值写死在断言里** —— 具体值只由 JS/CSS 绑定一致来保证。
 *   · ⚠️ 第 6 轮（用户「整体都小一点，左右上下，内部图标文字都小一点」）：`SIDE_RPX` 125→143、
 *     胶囊 104→92rpx、占位 112→98rpx，圆角 52→46rpx。本次给两条一直没人守的约定补了断言：
 *     ① **`SIDE_RPX` 必须取奇数**（`750 − 2S` 才能被 5 整除 → 格宽为整数；取 144 时
 *        462/5 = 92.4，`normLeft(4)+格宽 ≠ 内容宽`，零留白硬断言必然失败）；
 *     ② **胶囊占位一变，6 处让位值必须整体同步**（home/timetable×2/duty-sheet/`_fitHeight()`/`app.js`）
 *        —— 少改一处的表现是「悬浮按钮被底栏压住」或「弹层底部被遮」，肉眼要滑到底才发现。
 *   · ⚠️ `.tab-ind` 必须 `top:0 + bottom:0` 铺满胶囊高度，**不许写死 height** ——
 *     写死就会在胶囊高度变化时留下「上方空白」（用户同日反馈的原话）。
 *   · ⚠️ `.tab-item` 必须 `justify-content:center` 垂直居中。旧的 `padding-top:16rpx`
 *     把图标+文字整体下压，形成「上方空、下方贴底」的不对称留白。
 *
 * v0.7.15 第 7 次调整（2026-09-26 用户：「四个按钮两两相邻之间点击还有动画效果，
 * 但是我如果从首页直接点我的，动画就直接消失了，蓝色遮罩变成瞬间出现在选择的页面位置，
 * 而不是滑动过去」）——**相邻能看到动画、隔三格看不到**，是同一处设计缺陷的两种表现：
 *   custom-tab-bar 是**每个 Tab 页各一个实例**。旧实现把两拍起在「点击时所在的那个实例」上，
 *   而 `wx.switchTab` 立刻把该页隐藏 → 动画只播了个开头就消失；屏幕上真正显示的是
 *   **目标页实例**，它要么首帧就画在终点（首次访问），要么因为 `active` 早在 click 那刻
 *   就被乐观预置成同值、被 `app.setTabBar` 的「值相同就跳过」守卫挡回（缓存页）。
 *   距离一格时视觉差仅 116rpx，看着像「滑过去了」；隔三格 348rpx 就暴露成「瞬移」。
 * 修法：模块级 `HANDOFF` 交接 + `INSTANCES` 注册表 + 只预置落地页实例 + `syncActive` 消费交接。
 * ⚠️ 因此本门禁的**行为自证从「onChange 起拍」改成「点击 → 交接 → 落地页实例播放两拍」**：
 * 若只断言「点击后有 stretch」，正是这个 bug 能通过的形态（旧实现同样满足）。
 * 同时新增**对照反证**：拿掉交接后新建实例必须落在**终点格**——证明断言真能区分新旧行为。
 *
 * 自证：① 完整链路（离场实例不起拍 → 落地页实例被预置到起点格 → 消费交接播三拍）；
 *       ② 几何：stretch 胶囊必须完整覆盖目标格中心，且不越出**胶囊内容宽**。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

/** 剥注释：注释里提到的类名/数值不能算数（本项目踩过两次误报） */
const stripComments = (t) => t.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const wxml = stripComments(read('miniprogram/custom-tab-bar/index.wxml'));
const wxss = stripComments(read('miniprogram/custom-tab-bar/index.wxss'));
const js = read('miniprogram/custom-tab-bar/index.js');

/* ============================================================
 * ① wxml：指示器节点 + 位置（tab-item 之前 = 垫底）
 * ============================================================ */
console.log('── ① wxml 结构');
has(wxml, /class="tab-ind \{\{indCls\}\}"/, '指示器 class 绑定 indCls（两拍换速）');
has(wxml, /left:\{\{indLeft\}\}rpx;width:\{\{indWidth\}\}rpx/, '指示器 left/width 由 JS 下发（rpx）');
const indPos = wxml.indexOf('tab-ind');
const itemPos = wxml.indexOf('tab-item');
if (indPos >= 0 && itemPos >= 0 && indPos < itemPos) ok('指示器在 tab-item 之前（DOM 顺序垫底，不遮图标）');
else bad('指示器必须在 tab-item 之前（挪到后面会盖住图标）');

/* ============================================================
 * ② wxss：两拍节奏 + 回弹曲线 + 层级 + reduced-motion
 * ============================================================ */
console.log('\n── ② wxss 节奏');
has(wxss, /\.tab-ind\s*\{[^}]*position:\s*absolute/, '.tab-ind 绝对定位（不占布局，文字/命中区不动）');
has(wxss, /\.tab-ind\.stretch\s*\{[^}]*transition:\s*left[^}]*width/, '.stretch 同时声明 left/width 过渡（第 5 轮起 width 恒为整格，实际只 left 产生位移；过渡保留以备将来形态动画）');
has(wxss, /\.tab-ind\.settle\s*\{[^}]*transition:\s*left[^}]*width/, '.settle 同时过渡 left 与 width（收拢落位）');
// 回弹命门：settle 的曲线 y1（第二个数）必须 >1（overshoot）；stretch 不许 overshoot
const settleBez = (/\.tab-ind\.settle\s*\{[^}]*cubic-bezier\(([^)]*)\)/.exec(wxss) || [])[1] || '';
const settleParts = settleBez.split(',').map(Number);
if (settleParts.length === 4 && settleParts[1] > 1 && settleParts[3] <= 1) {
  ok('.settle 用 overshoot 回弹曲线（cubic-bezier(' + settleBez + ')，y1 >1 越过再落回）');
} else bad('.settle 曲线没有 overshoot（回弹消失）：cubic-bezier(' + settleBez + ')');
const stretchBez = (/\.tab-ind\.stretch\s*\{[^}]*cubic-bezier\(([^)]*)\)/.exec(wxss) || [])[1] || '';
const stretchParts = stretchBez.split(',').map(Number);
if (stretchParts.length === 4 && stretchParts[1] <= 1 && stretchParts[3] <= 1) ok('.stretch 用加速曲线（先慢后快，像被目标吸过去）');
else bad('.stretch 曲线不应带 overshoot（拉长段回弹会抖）');
if (settleBez !== stretchBez) ok('两拍曲线不同（第 5 轮起无宽度拉伸，节奏差异体现在 left 的快进 / 回弹）');
else bad('两拍曲线相同（无法形成「先拉长再收拢」轮廓）');
// stretch 拍时长与 JS IND_MS 一致（⚠️ CSS .14s 的换算：Number('0.' + '14') * 1000）
const stretchRaw = (/\.tab-ind\.stretch\s*\{[^}]*left\s+\.?([\d.]+)s/.exec(wxss) || [])[1];
const stretchMs = stretchRaw ? Math.round(Number('0.' + String(stretchRaw).replace(/^0?\./, '')) * 1000) : 0;
if (stretchMs === 140) ok('.stretch 时长 140ms（与 JS IND_MS 一致）');
else bad('.stretch 时长应为 140ms（与 JS IND_MS 一致），实得 ' + stretchMs + 'ms');
has(wxss, /\.tabbar\s*\{[^}]*position:\s*relative/, '.tabbar 是定位基准（指示器随 tabBar 而不随视口）');
has(wxss, /\.tab-item\s*\{[^}]*z-index:\s*1/, 'tab-item 抬到 z-index:1（内容永远在指示器之上）');
has(wxss, /prefers-reduced-motion[\s\S]{0,200}?\.tab-ind\.stretch/, '尊重 prefers-reduced-motion');

/* 第 3 次调整的三条铁律（都对应 2026-09-26 用户截图里的真实故障） */
has(wxss, /\.tab-ind\s*\{[^}]*top:\s*0[;\s}]/, '.tab-ind top:0（从胶囊顶边起，不留上方空白）');
has(wxss, /\.tab-ind\s*\{[^}]*bottom:\s*0[;\s}]/, '.tab-ind bottom:0（铺满胶囊高度，与底栏等高）');
if (!/\.tab-ind\s*\{[^}]*height\s*:/.test(wxss)) ok('.tab-ind 没有写死 height（等高由 top/bottom 决定，胶囊改高不会再留空白）');
else bad('.tab-ind 写死了 height —— 胶囊高度一变就会重新出现「上方空白」');
if (/\.tab-ind\s*\{[^}]*border-radius:\s*46rpx/.test(wxss)) ok('.tab-ind 圆角 46rpx = 胶囊半径（四角同心，不顶出圆角）');
else bad('.tab-ind 圆角应与胶囊半径一致（46rpx）');
has(wxss, /\.tab-item\s*\{[^}]*justify-content:\s*center/, '.tab-item 垂直居中（消除「上方有空白」的不对称留白）');
if (!/\.tab-item\s*\{[^}]*padding-top/.test(wxss)) ok('.tab-item 没有 padding-top 下压内容（改用居中）');
else bad('.tab-item 仍有 padding-top，会把内容下压成不对称留白');
// 胶囊左右内缩量必须与 JS 的 SIDE_RPX 一致（否则指示器整条偏移）
// ⚠️ 第二个值可能写成无单位的 `0`（`margin: 0 0 8rpx`），所以单位要可选
const sideM = (/\.tabbar\s*\{[^}]*margin:\s*0\s+(\d+)(?:rpx)?\s/.exec(wxss) || [])[1];
const sideJs = Number((/SIDE_RPX\s*=\s*(\d+)/.exec(js) || [])[1]);
if (sideM !== undefined && !Number.isNaN(sideJs) && Number(sideM) === sideJs) ok('胶囊左右内缩 JS(' + sideJs + 'rpx)/CSS(' + sideM + 'rpx) 一致');
else bad('胶囊左右内缩 JS(' + sideJs + 'rpx) 与 CSS(' + sideM + 'rpx) 不一致 —— 指示器会整条偏移');

/* ============================================================
 * ③ js：几何常量 + 跨页交接 + 两拍接力（真实行为自证）
 * ============================================================ */
console.log('\n── ③ js 行为自证');
has(js, /SIDE_RPX\s*=\s*\d+\s*;/, '几何：SIDE_RPX 为显式常量（具体值只由 JS/CSS 绑定一致保证，不写死）');
has(js, /BAR_W_RPX\s*=\s*750\s*-\s*SIDE_RPX\s*\*\s*2/, '几何：可用宽 = 750 − 2×内缩（= 胶囊内容宽）');
has(js, /CELL_RPX\s*=\s*BAR_W_RPX\s*\/\s*5/, '几何：按胶囊内容宽五等分（不是 750/5）');
// v0.7.14 第 5 轮：指示器常态宽 = 整格宽（两侧零留白）
has(js, /NORM_W_RPX\s*=\s*CELL_RPX/, '几何：常态宽 = 整格宽（满足「指示器边缘与胶囊边缘零留白」）');
has(js, /OVER_RPX\s*=\s*\d+\s*;/, '手感：OVER_RPX 为显式预冲常量');
has(js, /normLeft\s*=\s*\(i\)\s*=>\s*Math\.round\(i\s*\*\s*CELL_RPX\)/, '几何：常态 left = i×格宽（不做格内居中，首/末格因此贴边）');
has(js, /stretchLeft\s*=\s*\(i,\s*from\)/, '手感：预冲方向由起拍格决定（stretchLeft 收 from）');
has(js, /_indMove\(index,\s*from\)/, '起拍时把「起拍格」传给 _indMove（预冲方向正确）');
has(js, /IND_MS\s*=\s*140/, '两拍接力：IND_MS = 140（与 wxss .stretch 时 left 时长一致）');
// 两拍：stretch 先行、settle 由定时器接力（窗口放宽到 340 —— 第 5 轮 stretch 拍多带了 from 参数）
has(js, /indCls:\s*'stretch'[\s\S]{0,340}indCls:\s*'settle'/, '两拍接力：stretch 先行 → settle 落位');
has(js, /if\s*\(this\._indTimer\)\s*\{\s*clearTimeout\(this\._indTimer\)/, '连续点击清掉在途定时器（旧拍不覆盖新拍）');
// 回退归位
has(js, /_syncActiveFromRoute[\s\S]{0,600}indCls:\s*''/, '切失败回退时指示器归位（indCls 清空 = 无过渡瞬移）');
has(js, /detached\(\)[\s\S]{0,120}clearTimeout\(this\._indTimer\)/, 'detached 清理定时器');

/* —— v0.7.15 跨页交接：修「首页直接点我的 = 瞬移」—— */
console.log('  ── 跨页交接（v0.7.15）');
has(js, /let\s+HANDOFF\s*=\s*null/, '跨页交接：HANDOFF 是**模块级**变量（同一 JS 模块在所有页面实例间共享，上方 LIST 已证明这点）');
has(js, /HANDOFF\s*=\s*\{\s*to:\s*index,\s*from,\s*at:\s*Date\.now\(\)\s*\}/, 'onChange 写入交接 {to, from, at}');
has(js, /const\s+INSTANCES\s*=\s*new\s+Set\(\)/, '实例注册表 INSTANCES（每个 Tab 页一个实例，须登记才能定位落地页）');
has(js, /INSTANCES\.add\(this\)/, 'attached 注册实例');
has(js, /INSTANCES\.delete\(this\)/, 'detached 注销实例（防引用泄漏）');
has(js, /this\._route\s*=\s*this\._currentRoute\(\)/, 'attached 记下所属页面路由（预置时用它挑出「落地页那一个实例」）');
has(js, /inst\._route\s*!==\s*url/, '_preplace 只动路由相符的实例（不广播给全部：否则隐藏页留陈旧位置，从二级页回来会闪一下）');
has(js, /freshHandoff\s*=\s*\(index\)\s*=>/, '交接有**过期**语义（switchTab 失败 / 用户中途离开后不会误播）');
has(js, /syncActive\(index\)\s*\{[\s\S]{0,400}_takeHandoff\(index\)/, 'syncActive 先消费交接再走普通路径');
has(js, /popIndex:\s*index,\s*indCls:\s*''[\s\S]{0,140}?=>\s*this\._indMove\(index,\s*h\.from\)/, '交接消费分两拍：先无过渡画在起点格 → 渲染回调里起拍（塞进同一次 setData 会退化成瞬移）');
has(js, /HANDOFF\s*=\s*null;[\s\S]{0,160}_syncActiveFromRoute\(\)/, 'switchTab fail 同时作废交接（否则下次无关 onShow 会从旧起点再滑一遍）');
has(js, /popIndex:\s*index/, 'popIndex 改在落地页实例的 syncActive 里置位（弹跳必须发生在屏幕上这一个实例；旧实现置在离场实例上等于没置）');
// 命门：onChange 自身不得再碰指示器 class —— 它所在的实例马上会被 switchTab 隐藏
{
  const onChStart = js.indexOf('onChange(e)');
  const swStart = js.indexOf('wx.switchTab(', onChStart);
  const onChBody = (onChStart >= 0 && swStart > onChStart) ? js.slice(onChStart, swStart) : '';
  if (onChBody && !/indCls/.test(onChBody)) {
    ok('onChange 自身不再碰指示器 class（旧 bug：在即将被隐藏的实例上起拍，动画随页面一起消失）');
  } else bad('onChange 仍在离场实例上操作 indCls —— 动画会被 switchTab 吃掉');
}

// 完整链路自证：点击 → 交接 → 落地页实例播三拍
{
  const timers = [];
  const sandbox = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    wx: { switchTab: () => {} }
  };
  const get = () => ({ data: '' });   // icons 桩（模块顶部的 require 已被剥掉）
  const getApp = () => null;          // attached 里读 safeBottom，自证用不到
  const src = js
    .replace(/const\s*\{[^}]*\}\s*=\s*require\([^)]*\);?/, '')
    .replace(/\bsetTimeout\b/g, 'sandbox.setTimeout')
    .replace(/\bclearTimeout\b/g, 'sandbox.clearTimeout')
    .replace(/\bwx\./g, 'sandbox.wx.')
    // 暴露模块内部状态：追加的代码与 INSTANCES/HANDOFF 同处一个作用域，可直接闭包读到
    + '\nsandbox.INSTANCES = INSTANCES;'
    + '\nsandbox.setHandoff = (h) => { HANDOFF = h; };'
    + '\nsandbox.getHandoff = () => HANDOFF;';
  let compDef = null;
  const Component = (def) => { compDef = def; };
  new Function('sandbox', 'get', 'getApp', 'Component', '"use strict";' + src)(sandbox, get, getApp, Component);

  if (!compDef) { bad('自证失败：没能从 index.js 解析出 Component 定义'); }
  else {
    const sideV = Number((/SIDE_RPX\s*=\s*(\d+)/.exec(js) || [])[1]);
    const barW = 750 - sideV * 2;
    const cell = barW / 5;
    const nw = cell;                                              // 常态宽 = 整格宽
    const ov = Number((/OVER_RPX\s*=\s*(\d+)/.exec(js) || [])[1]);
    const nL = i => Math.round(i * cell);
    const sL = (i, from) => Math.round(i * cell + (i >= from ? ov : -ov));

    /** 造一个假实例：data 深拷贝 + 指定路由；setData 记录补丁并收集渲染回调（两拍接力靠它） */
    const mk = (route, active) => {
      const inst = { data: JSON.parse(JSON.stringify(compDef.data)), sets: [], cbs: [], _route: route };
      inst.data.active = active;
      inst.data.indLeft = nL(active);
      inst.setData = (o, cb) => {
        Object.assign(inst.data, o);
        inst.sets.push(o);
        if (typeof cb === 'function') inst.cbs.push(cb);
      };
      ['_indMove', '_preplace', 'onChange', '_takeHandoff', '_syncActiveFromRoute', 'syncActive']
        .forEach(k => { inst[k] = compDef.methods[k]; });
      inst._currentRoute = () => route;
      return inst;
    };

    const home = mk('/pages/home/index', 0);      // 当前显示中的页（点击发生在它身上）
    // ⚠️ 「我的」现在是索引 4（2026-10-27 导航重排：首页·课表·班级信息·值日·我的）。
    //    旧值 3 是四 Tab 时代的「我的」；写死旧索引会让 _preplace 找不到落地页实例
    //    （它按 TABS[index].url 匹配 _route），整条自证会假红。
    const mine = mk('/pages/mine/index', 4);      // 已缓存的目标页：旧实现里它的 active 早就是 4 → 被守卫挡回
    sandbox.INSTANCES.add(home);
    sandbox.INSTANCES.add(mine);

    /* —— 点击「我的」（首页 → 我的，跨 4 格 = 用户截图那一路）—— */
    home.onChange({ currentTarget: { dataset: { index: 4 } } });

    if (home.data.active === 4 && !home.sets.some(s => s.indCls === 'stretch')) {
      ok('自证：点击后离场实例只置 active、**不起拍**（旧 bug 正是「在被隐藏的实例上起拍」）');
    } else bad('自证：离场实例仍在起拍 / 未置 active —— ' + JSON.stringify(home.sets));

    if (mine.data.indLeft === nL(0) && mine.data.active === 4) {
      ok('自证：落地页实例被预置到**起点格** left=' + mine.data.indLeft + 'rpx（不是终点 ' + nL(4) + '）');
    } else bad('自证：落地页实例未被预置到起点格，实得 left=' + mine.data.indLeft + '（期望 ' + nL(0) + '）');

    // 预置补丁本身必须无过渡（indCls === ''）—— 带上 transition 会从旧位置滑一下，等于多播一段
    const preCard = mine.sets[0] || {};
    if (preCard.indCls === '' && preCard.indLeft === nL(0) && preCard.indWidth === nw && preCard.active === 4) {
      ok('自证：预置补丁 = {active:4, indCls:\'\', indLeft:' + preCard.indLeft + '}（无过渡瞬移，不额外播动画）');
    } else bad('自证：预置补丁不对，实得 ' + JSON.stringify(preCard));

    const h1 = sandbox.getHandoff();
    if (h1 && h1.to === 4 && h1.from === 0) ok('自证：交接 {to:4, from:0} 已写入模块级状态（跨实例可见）');
    else bad('自证：交接未写入 / 内容不对：' + JSON.stringify(h1));

    /* —— 落地页 onShow → app.setTabBar(4) → syncActive(4)：必须播完整三拍 —— */
    const tBefore = timers.length;
    mine.sets.length = 0;                          // 清掉预置补丁，下面按节拍取下标
    mine.syncActive(4);

    const beat1 = mine.sets[0] || {};
    if (beat1.indCls === '' && beat1.indLeft === nL(0) && beat1.popIndex === 4) {
      ok('自证：第一拍无过渡画在起点格（left=' + beat1.indLeft + '）并置 popIndex（弹跳落在屏幕上这个实例）');
    } else bad('自证：第一拍不是「无过渡画在起点格」，实得 ' + JSON.stringify(beat1));

    mine.cbs.splice(0).forEach(f => f());          // 渲染回调 = 起点格已落地 → 起拍
    const beat2 = mine.sets[1] || {};
    if (beat2.indCls === 'stretch' && beat2.indLeft === sL(4, 0) && beat2.indWidth === nw) {
      ok('自证：第二拍 stretch 起拍并预冲 ' + ov + 'rpx（left=' + beat2.indLeft + ' = 目标 ' + nL(4) + ' + ' + ov + '）');
    } else bad('自证：第二拍不是 stretch 起拍，实得 ' + JSON.stringify(beat2));

    const t1 = timers[tBefore];
    if (t1 && t1.ms === 140) {
      t1.fn();                                     // 140ms 后 settle 落位
      const beat3 = mine.sets[2] || {};
      if (beat3.indCls === 'settle' && beat3.indLeft === nL(4)) {
        ok('自证：第三拍 settle 回落到格位 left=' + beat3.indLeft + 'rpx（跨 4 格全程可见）');
      } else bad('自证：settle 未落位，实得 ' + JSON.stringify(beat3));
    } else bad('自证：stretch 拍没有挂上 140ms 的 settle 定时器（实得 ' + JSON.stringify(t1 || null) + '）');

    if (!sandbox.getHandoff()) ok('自证：交接被一次性消费（后来的无关 onShow 不会重复播放）');
    else bad('自证：交接消费后未清空');

    const setsAfter = mine.sets.length;
    mine.syncActive(4);
    if (mine.sets.length === setsAfter) ok('自证：状态已一致时 syncActive 不产生多余 setData（去重职责已从 app.js 下沉到这里）');
    else bad('自证：syncActive 重复 setData（每次 onShow 都白渲染一次）');

    /* —— 首次访问该 Tab（实例还不存在）也要能续接：起点只能来自交接 —— */
    sandbox.setHandoff(null);
    home.data.active = 0;
    home.onChange({ currentTarget: { dataset: { index: 1 } } });
    const tt = mk('/pages/timetable/index', 0);
    compDef.lifetimes.attached.call(tt);
    if (tt.data.indLeft === nL(0) && tt.data.active === 1) {
      ok('自证：**新建**实例首帧也画在起点格（left=' + tt.data.indLeft + 'rpx），不会先闪在终点再回头');
    } else bad('自证：新建实例未按交接定位，实得 left=' + tt.data.indLeft + '（期望 ' + nL(0) + '）');

    /* —— 对照反证：拿掉交接后必须落在**终点格**，说明上面两条断言真能区分新旧行为 —— */
    sandbox.setHandoff(null);
    const tt2 = mk('/pages/timetable/index', 0);
    compDef.lifetimes.attached.call(tt2);
    if (tt2.data.indLeft === nL(1)) {
      ok('对照（反证）：无交接时新建实例直接落在终点格 ' + nL(1) + 'rpx ≠ 有交接时的 ' + nL(0) + 'rpx —— 断言确实能抓住这个 bug');
    } else bad('对照失败：无交接时定位异常，实得 ' + tt2.data.indLeft + '（期望 ' + nL(1) + ' = 课程表格）');

    /* —— 过期交接不播放（switchTab 失败 / 用户中途离开）—— */
    sandbox.setHandoff({ to: 2, from: 0, at: Date.now() - 5000 });
    mine.data.active = 4; mine.data.indLeft = nL(4);
    mine.sets.length = 0;
    mine.syncActive(2);
    if (mine.sets.length === 1 && 'indCls' in mine.sets[0] && mine.sets[0].indCls === '' && mine.sets[0].indLeft === nL(2)) {
      ok('自证：过期交接按「无交接」处理 —— 只瞬移归位、不播动画（回调里不会再起拍）');
    } else bad('自证：过期交接行为不对：' + JSON.stringify(mine.sets));
    if (mine.cbs.length === 0) ok('自证：过期交接不触发起拍回调（无动画）');
    else bad('自证：过期交接仍触发了起拍');

    /* —— 几何：零留白 / 覆盖格中心 / 预冲幅度 —— */
    if (Number.isInteger(cell)) ok('自证：格宽为整数 ' + cell + 'rpx（SIDE_RPX=' + sideV + ' 为奇数 → 750−2S 被 5 整除）');
    else bad('自证：格宽 ' + cell + 'rpx 非整数 —— SIDE_RPX 必须取奇数，否则零留白断言必然失败');
    let flushOk = true;
    if (nL(0) !== 0) flushOk = false;                        // 首页：左缘贴胶囊左缘
    if (nL(4) + nw !== barW) flushOk = false;                // 我的（末格）：右缘贴胶囊右缘
    for (let i = 0; i < 5; i++) {
      const center = i * cell + cell / 2;
      if (!(nL(i) < center && center < nL(i) + nw)) flushOk = false;   // 常态覆盖格中心
    }
    if (flushOk) ok('自证：5 档零留白（首格 left=0、末格 right=' + barW + '，常态各覆盖本格中心）');
    else bad('自证：指示器未与胶囊边缘零留白（首格 left=' + nL(0) + '，末格右缘=' + (nL(4) + nw) + '，应为 0 / ' + barW + '）');
    // 预冲幅度：朝外（首格向左 / 末格向右）时允许为负/越界，由胶囊裁剪；幅度必须恒为 OVER_RPX
    let ovOk = true;
    for (let i = 0; i < 5; i++) {
      for (let f = 0; f < 5; f++) {
        const d = Math.abs(sL(i, f) - nL(i));
        if (d !== ov) ovOk = false;
      }
    }
    if (ovOk) ok('自证：预冲幅度恒为 ' + ov + 'rpx（16 组起拍/目标组合全等）');
    else bad('自证：预冲幅度不恒等于 OVER_RPX');
    // 自证（回归保护）：JS 的 SIDE_RPX 若与真实内缩不符，末格必须能被判为明显偏心。
    // ⚠️ 正确值随轮次变化（第 6 轮 = 143），所以不写死「正确内缩」，只构造一个「错的内缩值」。
    const trueRight = barW;                       // 末格右缘应等于胶囊右缘
    const wrongSide = sideV === 0 ? 40 : 0;
    const wrongBar = 750 - wrongSide * 2;
    const bugOff = Math.abs(wrongBar - trueRight);
    if (bugOff > 20) ok('自证：内缩量算错时（' + sideV + ' → ' + wrongSide + 'rpx）末格右缘偏 ' + Math.round(bugOff) + 'rpx，可被零留白校验抓住');
    else bad('自证失败：内缩量算错的偏差只有 ' + bugOff.toFixed(1) + 'rpx，零留白校验抓不住这个 bug');
  }
}

/* ============================================================
 * ④ 底栏占位联动（第 6 轮新增）
 * 胶囊尺寸一变，**所有给底栏让位的数值必须整体同步**。
 * 约定：每处让位值 = 胶囊占位 + 固定余量（余量是历史遗留，不随轮次变）。
 * 少改一处的表现：悬浮按钮被底栏压住 / 弹层底部被遮 / 课表算少一行 —— 都要滑到底才看得见。
 * ============================================================ */
console.log('\n── ④ 底栏占位联动');
{
  const barH = Number((/\.tabbar\s*\{[^}]*height:\s*(\d+)rpx/.exec(wxss) || [])[1]);
  const barB = Number((/\.tabbar\s*\{[^}]*margin:\s*0\s+\d+(?:rpx)?\s+(\d+)rpx/.exec(wxss) || [])[1]);
  const occOk = barH > 0 && barB >= 0;
  const occ = occOk ? barH + barB : NaN;
  if (occOk) ok('胶囊占位 = 高 ' + barH + ' + 底部悬空 ' + barB + ' = ' + occ + 'rpx');
  else bad('没能从 wxss 解析出胶囊高 / 底部悬空（占位联动无法校验）');

  // 4 处 wxss 让位值：占位 + 固定余量
  const RPX_SPOTS = [
    // 2026-10-16：首页 .remind-fab（系统日历/值日微信提醒悬浮胶囊）整体下线（需求①），
    //   首页已无底部 fixed 元素需让位，故移除该项断言（否则正则失配恒红）。
    ['pages/timetable/index.wxss',       /\.fab\s*\{[\s\S]*?bottom:\s*calc\((\d+)rpx/,               40,  'timetable .fab'],
    ['pages/timetable/index.wxss',       /\.fab-menu\s*\{[\s\S]*?bottom:\s*calc\((\d+)rpx/,         46,  'timetable .fab-menu'],
    ['components/duty-sheet/index.wxss', /\.ds-foot\s*\{[\s\S]*?padding-bottom:\s*calc\((\d+)rpx/,   16,  'duty-sheet .ds-foot']
  ];
  RPX_SPOTS.forEach(([file, re, gap, name]) => {
    const m = re.exec(read('miniprogram/' + file));
    if (!m) { bad(name + '：没能解析出让位值（正则失配）'); return; }
    const v = Number(m[1]);
    if (!occOk) { bad(name + ' = ' + v + 'rpx（占位未知，无法判定）'); return; }
    if (v === occ + gap) ok(name + ' = ' + v + 'rpx = 占位 ' + occ + ' + ' + gap);
    else bad(name + ' = ' + v + 'rpx，应为 ' + (occ + gap) + 'rpx（占位 ' + occ + ' + ' + gap + '）—— 底栏改尺寸后忘了同步这一处');
  });

  // 2 处 js 让位值
  const reserve = Number((/const\s+reserve\s*=\s*(\d+)/.exec(read('miniprogram/pages/timetable/index.js')) || [])[1]);
  if (!reserve) bad('timetable _fitHeight()：没能解析出 reserve');
  else if (occOk && reserve === occ + 108) ok('timetable _fitHeight() reserve = ' + reserve + ' = 占位 ' + occ + ' + 108');
  else bad('timetable _fitHeight() reserve = ' + reserve + '，应为 ' + (occ + 108) + '（占位 ' + occ + ' + 108）');

  const appJs = read('miniprogram/app.js');
  const tbPx = Number((/tabbarPx:\s*Math\.round\((\d+)\s*\*/.exec(appJs) || [])[1]);
  if (occOk && tbPx === occ) ok('app.js sheetMetrics().tabbarPx 换算基准 = ' + occ + 'rpx（与胶囊占位一致）');
  else bad('app.js sheetMetrics().tabbarPx 基准 = ' + tbPx + 'rpx，应为 ' + occ + 'rpx');

  const bsJs = read('miniprogram/components/bottom-sheet/index.js');
  const bsPx = Array.from(bsJs.matchAll(/tabbarPx:\s*(\d+)/g)).map(m => Number(m[1]));
  const wantPx = occOk ? Math.round(occ * 375 / 750) : NaN;
  if (!bsPx.length) bad('bottom-sheet：没能解析出兜底 tabbarPx');
  else if (bsPx.every(v => v === wantPx)) ok('bottom-sheet 兜底 tabbarPx = ' + wantPx + 'px（两处一致；' + occ + 'rpx @375px 屏）');
  else bad('bottom-sheet 兜底 tabbarPx 应为 ' + wantPx + 'px（' + occ + 'rpx @375），实得 ' + JSON.stringify(bsPx));
}

/* ------------------------------------------------------------------
 * ⑤ 无安全区机型的底部兜底留白（1.0.5 需求①「安卓底栏贴着屏幕底」）
 * ------------------------------------------------------------------
 * 现象：`.tabbar-wrap` 的 `padding-bottom` 只取 `safeBottom`（= screenHeight − safeArea.bottom）。
 *   · iPhone（Home Indicator）safeBottom ≈ 34 ⇒ 胶囊下沿离屏幕底 ~37px（用户认可的观感）；
 *   · 安卓绝大多数无安全区 ⇒ 0 ⇒ 胶囊**紧贴屏幕底** —— 用户报的 bug。
 * 修法：`max(safeBottom, TABBAR_LIFT_PX)` —— iPhone 取安全区（不动），安卓兜底。
 * ⚠️ 这是一个**跨 4 个文件共享的单值**：组件常量 ↔ app.js globalData 必须相等，
 *    且 4 处让位值都要带 `max(env(safe-area-inset-bottom), <lift>px)` 兜底 ——
 *    否则安卓上按钮/页脚会被抬高后的胶囊压住。
 * ------------------------------------------------------------------ */
console.log('\n── ⑤ 无安全区兜底留白（安卓底栏贴底修复）');
{
  const compJs = read('miniprogram/custom-tab-bar/index.js');
  const compWxml = read('miniprogram/custom-tab-bar/index.wxml');
  const lift = Number((/const\s+TABBAR_LIFT_PX\s*=\s*(\d+)/.exec(compJs) || [])[1]);
  if (!lift) bad('custom-tab-bar：没能解析出 TABBAR_LIFT_PX（兜底留白丢了？）');
  else ok('custom-tab-bar 的 TABBAR_LIFT_PX = ' + lift + 'px');

  if (/tabbarPad:\s*Math\.max\(sb,\s*TABBAR_LIFT_PX\)/.test(compJs)) ok('施加值用 Math.max(sb, TABBAR_LIFT_PX)（iPhone 完全不动）');
  else bad('custom-tab-bar 没有用 Math.max(sb, TABBAR_LIFT_PX) —— 有安全区的机型会被额外顶高');

  if (/padding-bottom:\{\{tabbarPad\}\}px/.test(compWxml)) ok('wxml 的 padding-bottom 绑定 tabbarPad');
  else bad('custom-tab-bar/index.wxml 的 .tabbar-wrap 没有绑定 tabbarPad（兜底留白不会生效）');

  const appSrc = read('miniprogram/app.js');
  const appLift = Number((/tabbarLiftPx:\s*(\d+)/.exec(appSrc) || [])[1]);
  if (lift && appLift === lift) ok('app.js globalData.tabbarLiftPx = ' + appLift + '（与组件常量一致，单值来源）');
  else bad('app.js tabbarLiftPx = ' + appLift + '，应与组件 TABBAR_LIFT_PX = ' + lift + ' 相等');

  // 取 sheetMetrics 里那一行 tabbarPx（含 Math.round 的那处），再按**意图**判：
  // 必须同时出现「无安全区判断」「叠加 tabbarLiftPx」两个要素。
  // ⚠️ 不用一条大正则去描述整行：`Math.round(98 * (g.windowWidth || 375) / 750)` 有嵌套括号，
  //    窗口式正则会因 `[^)]*` 提前截断而**假红**（本轮实测）。
  const tbLine = (appSrc.split('\n').find(l => /tabbarPx:/.test(l) && /Math\.round/.test(l)) || '');
  const liftOk = /g\.safeBottom\s*>\s*0/.test(tbLine) && /g\.tabbarLiftPx/.test(tbLine);
  if (liftOk && /tabbarPx:\s*Math\.round\(/.test(tbLine)) {
    ok('sheetMetrics().tabbarPx 含「无安全区时叠加 lift」（弹层 body 让位同步）');
  } else bad('app.js sheetMetrics().tabbarPx 没有叠加无安全区的 lift —— 弹层内容会被抬高后的胶囊压住');

  const LIFT_SPOTS = [
    // 2026-10-16：.remind-fab 已随需求①整体移除，对应 LIFT_SPOTS 断言同步下线。
    ['pages/timetable/index.wxss', /\.fab\s*\{[\s\S]*?\}/, 'timetable .fab'],
    ['pages/timetable/index.wxss', /\.fab-menu\s*\{[\s\S]*?\}/, 'timetable .fab-menu'],
    ['components/duty-sheet/index.wxss', /\.ds-foot\s*\{[\s\S]*?\}/, 'duty-sheet .ds-foot']
  ];
  LIFT_SPOTS.forEach(([file, re, name]) => {
    const block = (re.exec(read('miniprogram/' + file)) || [])[0] || '';
    if (!block) { bad(name + '：没能解析出规则块（正则失配）'); return; }
    const maxRe = new RegExp('max\\(env\\(safe-area-inset-bottom\\),\\s*' + lift + 'px\\)');
    const envCount = (block.match(/env\(safe-area-inset-bottom\)/g) || []).length;
    if (!maxRe.test(block)) bad(name + '：缺少 `max(env(safe-area-inset-bottom), ' + lift + 'px)` 兜底 —— 安卓上会被抬高后的胶囊压住');
    else if (envCount < 2) bad(name + '：兜底行覆盖了回退行（必须**保留** `calc(… + env(…))` 原行做老引擎回退）');
    else ok(name + '：带 max(env(…), ' + lift + 'px) 兜底 + 保留 env 回退行');
  });

  // 变异自证：把组件的常量改掉 → 与 app.js 不一致必须判死
  const mutated = compJs.replace(/const\s+TABBAR_LIFT_PX\s*=\s*\d+/, 'const TABBAR_LIFT_PX = ' + (lift + 8));
  const mLift = Number((/const\s+TABBAR_LIFT_PX\s*=\s*(\d+)/.exec(mutated) || [])[1]);
  if (mLift && appLift && mLift !== appLift) ok('变异（组件常量 ' + lift + '→' + mLift + '）→ 与 app.js 不一致会被判死');
  else bad('变异自证失败：常量不一致时判据仍放行');
}

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 液态 Tab 指示器校验通过');
