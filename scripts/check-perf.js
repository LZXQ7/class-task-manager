#!/usr/bin/env node
/**
 * 离线自检：导航延迟（切 Tab 卡 / 进二级页卡一下）
 * ------------------------------------------------------------
 * 起因（2026-09-25 用户反馈）：
 *   ①「首次打开小程序，底部选项切换会很慢，感觉卡卡的」
 *   ②「打开新页面的选项感觉都会先卡一下，例如"我的"页面的通知、手动排班这种」
 *
 * 定位出四条真因，本脚本把对应的不变量全部锁死，防止以后改回去：
 *
 *   R1 点 tabBar 没有乐观选中 —— 图标要等目标页 onShow 才亮，
 *      而 switchTab 到首次访问的 Tab 页要等页面注入 + 首帧，那段空窗期毫无反馈。
 *   R2 导航关键路径上有同步 IPC —— nav-bar / bottom-sheet 的每个实例都调
 *      `wx.getMenuButtonBoundingClientRect()` / `wx.getWindowInfo()`（同步跨线程），
 *      再 setData 触发二次渲染；而弹层即使没打开，实例也在页面组件树里。
 *   R3 数据页无条件 `loading: true` —— Tab 页实例在切换时不销毁，屏幕上本来就有内容，
 *      却被整页替换成骨架再换回来 = 「切一下卡一下」。
 *   R4 二级页 navigateBack 即销毁，「上次的内容」无缓存 → 再进必等一次云函数。
 *
 * 用法：node scripts/check-perf.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

const read = (rel) => fs.readFileSync(path.join(MINI, rel), 'utf8');

/** 去掉注释再匹配：这些文件的注释里就写着反面示例，不剥离会把文档判成 bug */
function stripComments(src, kind) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  if (kind === 'wxml') s = s.replace(/<!--[\s\S]*?-->/g, '');
  else s = s.replace(/^\s*\/\/.*$/gm, '');
  return s;
}

/**
 * 取 `key` 这个属性在某个方法名之后的**同一行**内容。
 * 这里只做「顺序」判断，够用且不会误伤注释。
 */
function indexAfter(src, anchor, needle) {
  const i = src.indexOf(anchor);
  if (i < 0) return -1;
  const j = src.indexOf(needle, i);
  return j < 0 ? -1 : j - i;
}

/* ------------------------------------------------------------------ */
/* R1  tabBar 乐观选中 + 按下反馈                                       */
/* ------------------------------------------------------------------ */
console.log('--- R1 tabBar 乐观选中与按下反馈 ---');
{
  const js = stripComments(read('custom-tab-bar/index.js'), 'js');
  const wxml = stripComments(read('custom-tab-bar/index.wxml'), 'wxml');
  const wxss = stripComments(read('custom-tab-bar/index.wxss'), 'css');

  // 必须「先 setData({active}) 再 wx.switchTab」——顺序反了就等于没做乐观选中。
  // ⚠️ 只匹配前缀 `setData({ active: index`：乐观选中后来还顺带置了 popIndex
  //    （弹跳动画只给用户点的那一项），钉死整串 `})` 会变成假失败。
  const aSet = indexAfter(js, 'onChange(e)', 'setData({ active: index');
  const aSw = indexAfter(js, 'onChange(e)', 'wx.switchTab(');
  if (aSet > 0 && aSw > 0 && aSet < aSw) ok('onChange 先乐观 setData({active}) 再 switchTab（点下去图标立刻就亮）');
  else bad('onChange 未做到「先乐观选中再切页」（顺序反了 = 空窗期仍然没有反馈）');

  // 切失败必须把选中态退回去
  if (/_syncActiveFromRoute\s*\(\)/.test(js) && /fail\s*:/.test(js)) {
    ok('switchTab fail 分支回退选中态（不会让图标停在一个没打开的页上）');
  } else bad('switchTab 缺少 fail 分支 / 未回退选中态');

  // 守卫不得再依赖组件内部 active（历史坑：脱节 → 点击静默失效）
  if (/curRoute\s*&&\s*curRoute\s*===\s*item\.url/.test(js)) ok('同页守卫走「真实路由」而非组件内部 active');
  else bad('同页守卫不是基于真实路由（active 脱节时会静默失效）');

  if (/hover-class="tab-item-hover"/.test(wxml) && /hover-start-time="0"/.test(wxml)) {
    ok('tabBar 项配了 hover-class + hover-start-time=0（按下立刻有反馈）');
  } else bad('tabBar 项缺按下反馈（hover-class / hover-start-time）');

  if (/\.tab-item-hover\s*\{/.test(wxss)) ok('hover 样式已定义');
  else bad('hover-class="tab-item-hover" 没有对应样式（按下不会有任何变化）');
}

/* ------------------------------------------------------------------ */
/* R2  导航关键路径上不得有同步 IPC                                     */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R2 导航关键路径上的同步 IPC ---');
{
  const app = stripComments(read('app.js'), 'js');

  if (/navMetrics\s*\(\)/.test(app) && /sheetMetrics\s*\(\)/.test(app)) {
    ok('app.js 提供 navMetrics() / sheetMetrics()（度量算一次、全局缓存）');
  } else bad('app.js 缺 navMetrics() / sheetMetrics()');

  // 胶囊位置过早拿不到：只有拿到有效值才许写缓存，否则会把 0 锁死一整个生命周期
  if (/mb\s*&&\s*mb\.left\s*>\s*0/.test(app) && /if\s*\(valid\)\s*g\._navMetrics\s*=/.test(app)) {
    ok('navMetrics 仅在拿到有效胶囊位置时才缓存（不会把 0 锁死）');
  } else bad('navMetrics 未做「有效才缓存」保护（过早调用会把 padRight=0 固化）');

  const targets = [
    { rel: 'components/nav-bar/index.js', fn: 'navMetrics' },
    { rel: 'components/bottom-sheet/index.js', fn: 'sheetMetrics' }
  ];
  targets.forEach((t) => {
    const src = stripComments(read(t.rel), 'js');
    const syncCalls = [
      ['wx.getMenuButtonBoundingClientRect(', /wx\.getMenuButtonBoundingClientRect\(/],
      ['wx.getWindowInfo(', /wx\.getWindowInfo\(/],
      ['wx.getSystemInfoSync(', /wx\.getSystemInfoSync\(/]
    ].filter(x => x[1].test(src)).map(x => x[0]);

    const viaApp = new RegExp('app\\.' + t.fn + '\\(').test(src);
    const skipsSame = /===\s*this\.data\.|this\.data\.[A-Za-z]+\s*===/.test(src);

    if (!syncCalls.length && viaApp) ok(t.rel + '：不再自己调同步 API，改走 app.' + t.fn + '()');
    else if (!viaApp) bad(t.rel + '：没有走 app.' + t.fn + '()（度量仍在各实例里各算一遍）');
    else bad(t.rel + '：attached 里仍有同步跨线程调用 ' + syncCalls.join(' / '));

    if (skipsSame) ok(t.rel + '：值相同则跳过 setData（省掉一次二次渲染）');
    else bad(t.rel + '：没有「值相同不 setData」的判断');
  });

  /*
   * R2b 加动效时最容易重新踩的坑（2026-10-07 深色模式实测踩中）：
   *   给 nav-bar 加「主题按钮的垂直居中偏移」需要窗口宽度，当时图省事在 attached 里
   *   写了 `wx.getWindowInfo()` —— 正是上面 R2 骂的那种每实例同步 IPC。
   *
   * 🔴 所以这里**显式锁死「组件文件全文不得出现同步度量API」**：
   *   上面的判据是被动的（靠 syncCalls 数组顺带扫到），没有专门判据 + 没有变异自证，
   *   容易被「那几处在方法里不在 attached 里，应该不算吧」这种自我说服绕过去。
   *   判据扫的是**全文**（含 methods），这与 R2 的立意一致：
   *   这些 API 同步跨线程，在组件里任何位置调都是白付。
   */
  {
    const FORBIDDEN = [
      ['wx.getWindowInfo(', /wx\.getWindowInfo\(\s*\)?/],
      ['wx.getSystemInfoSync(', /wx\.getSystemInfoSync\(\s*\)?/],
      ['wx.getMenuButtonBoundingClientRect(', /wx\.getMenuButtonBoundingClientRect\(\s*\)?/]
    ];
    targets.concat([{ rel: 'components/nav-bar/index.js', fn: 'navMetrics' }])
      .filter((v, i, arr) => arr.findIndex((x) => x.rel === v.rel) === i)
      .forEach((t) => {
        // 剥注释：这些文件的注释里就写着 `wx.getWindowInfo()` 当反面示例，
        // 不剥会把文档判成 bug（与本脚本 stripComments 的口径一致）。
        const src = stripComments(read(t.rel), 'js');
        const hits = FORBIDDEN.filter((f) => f[1].test(src)).map((f) => f[0]);
        if (!hits.length) {
          ok(t.rel + '：全文无同步度量 API（连 methods 里也没有—— 加动效要窗口尺寸请走 app.' + t.fn + '()');
        } else {
          bad(t.rel + '：methods 里仍有同步度量 API ' + hits.join(' / ')
            + ' —— 需要窗口尺寸请让 app.' + t.fn + '() 多带一个字段，不要在组件里自己取');
        }
      });

    // app.navMetrics 必须真的把 windowWidth / windowHeight 带出来（否则组件只能自己去取）
    const appRaw = read('app.js');
    const navM = (appRaw.match(/navMetrics\s*\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
    if (/windowWidth/.test(navM) && /windowHeight/.test(navM)) {
      ok('app.navMetrics() 带出 windowWidth / windowHeight（组件要窗口尺寸有正规出口，不必自己同步取）');
    } else bad('app.navMetrics() 没有带出 windowWidth / windowHeight —— 组件会为了拿尺寸去调同步 API');

    // 变异自证：把一处同步调用塞回 methods 里，必须被抓到（否则上面这条判据是装饰品）
    const mutated = stripComments(read('components/nav-bar/index.js'), 'js')
      .replace('_centerX() {', '_centerX() { const _w = wx.getWindowInfo().windowWidth;');
    const mutantHits = FORBIDDEN.filter((f) => f[1].test(mutated)).map((f) => f[0]);
    if (mutated !== stripComments(read('components/nav-bar/index.js'), 'js') && mutantHits.length) {
      ok('自证：methods 里塞回 wx.getWindowInfo() 会被 R2b 抓到（' + mutantHits.join(' / ') + '）');
    } else bad('自证失败：methods 里塞回同步 API 没被抓到 ⇒ R2b 判据是装饰品');
  }

  // setTabBar：必须从 getCurrentPages() 取当前页拿 tabBar，同值跳过
  const setTabSrc = (app.match(/setTabBar\s*\(index\)\s*\{[\s\S]*?\n  \}/) || [''])[0];
  if (/getCurrentPages\(\)/.test(setTabSrc) && /cur\.getTabBar\(\)/.test(setTabSrc)) {
    ok('app.setTabBar 从「当前页」取 tabBar（App 实例上没有 getTabBar，用 this.getTabBar() 会静默空转）');
  } else bad('app.setTabBar 没走 getCurrentPages() 取当前页的 tabBar（会静默空转，选中态不同步）');

  if (!/typeof\s+this\.getTabBar/.test(setTabSrc)) ok('app.setTabBar 没有误用 this.getTabBar');
  else bad('app.setTabBar 仍在使用 this.getTabBar —— App 实例上该方法不存在，恒为 false');

  /*
   * ⚠️ 2026-09-26 v0.7.15 改判据（原判据是**错的**，它把 bug 当成了性能优化）：
   * 旧断言要求 app.setTabBar 里写 `tb.data && tb.data.active === index` → return。
   * 但点击时 tabBar 会把 active **乐观预置**成目标格，于是目标页实例的 active 早已等于
   * index —— 这个「同值跳过」守卫会让 syncActive 永远收不到「跨页指示器交接」，
   * 指示灯只能瞬移到目标格（用户：「从首页直接点我的，动画直接消失，蓝色遮罩瞬间出现」）。
   * 正确取值：**setTabBar 无条件委托 syncActive**，去重下沉到组件内部
   * （syncActive 自身判重，不会产生多余 setData，性能诉求并未丢失）。
   */
  if (/tb\.syncActive\s*\(index\)/.test(setTabSrc) && !/tb\.data\.active\s*===\s*index/.test(setTabSrc)) {
    ok('app.setTabBar 无条件委托 syncActive（同值跳过下沉到组件：旧守卫会吃掉跨页指示器交接 → 指示器瞬移）');
  } else bad('app.setTabBar 仍在用「active 同值就跳过」当守卫 —— 它会吃掉跨页指示器交接，指示器只能瞬移');

  // 去的值必须由组件自己判重（性能诉求不能丢）
  {
    const tbJs = stripComments(read('custom-tab-bar/index.js'), 'js');
    const syncBody = (tbJs.match(/syncActive\s*\(index\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
    if (/this\.data\.active\s*===\s*index/.test(syncBody) && /indLeft/.test(syncBody)) {
      ok('syncActive 自带「状态已一致则不 setData」判重（跨页交接之外仍省掉二次渲染）');
    } else bad('syncActive 没有判重 —— 每次 onShow 都会白 setData 一次');
  }

  // 四个 Tab 页统一走 app.setTabBar，且不得再各自 setData active
  ['home', 'timetable', 'duty', 'mine'].forEach((p, i) => {
    const src = stripComments(read('pages/' + p + '/index.js'), 'js');
    const usesApi = new RegExp('app\\.setTabBar\\(' + i + '\\)').test(src);
    const legacy = /getTabBar\(\)\.setData\(\{\s*active/.test(src);
    if (usesApi && !legacy) ok('pages/' + p + ' 用 app.setTabBar(' + i + ') 同步选中态');
    else bad('pages/' + p + ' 未统一走 app.setTabBar(' + i + ')'
      + (legacy ? '（仍有 getTabBar().setData({active}) 旧写法）' : ''));
  });
}

/* ------------------------------------------------------------------ */
/* R3  数据页不得无条件闪骨架                                           */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R3 数据页「有内容就不退回骨架」 ---');
{
  const pages = ['home', 'duty', 'manual'];
  pages.forEach((p) => {
    const src = stripComments(read('pages/' + p + '/index.js'), 'js');
    // 反面：load() 里第一句就是无条件 loading: true
    const unconditional = /load\s*\([^)]*\)\s*\{\s*this\.setData\(\{\s*loading:\s*true/.test(src);
    /*
     * 守卫有两种合法写法，都要认：
     *   a) const hasContent = …; this.setData({ loading: !hasContent, … })
     *   b) const hasContent = …; if (hasContent) 先画缓存; else this.setData({ loading: true, … })
     * （第二种是 manual 的写法：命中缓存走 _paint，未命中才显骨架。）
     */
    const definesFlag = /const hasContent\s*=/.test(src);
    const guarded = definesFlag && (
      /loading:\s*!\s*hasContent/.test(src)
      || /if\s*\(\s*!\s*hasContent\s*\)/.test(src)
      || /if\s*\(\s*hasContent\s*\)/.test(src)
    );
    if (!unconditional && guarded) ok('pages/' + p + '：load() 先判 hasContent，有内容则保持内容并静默刷新');
    else if (unconditional) bad('pages/' + p + '：load() 仍然无条件 loading: true（每次进页都会闪骨架）');
    else bad('pages/' + p + '：没有 hasContent 守卫');
  });

  // 切周 = 换一份数据，必须让骨架回来，否则拿上周名单冒充本周
  const duty = stripComments(read('pages/duty/index.js'), 'js');
  if (/onWeekChange[\s\S]{0,400}this\._hasData\s*=\s*false/.test(duty)) {
    ok('值日页换周时重置 _hasData（不会用上一周的名单冒充这一周）');
  } else bad('值日页换周未重置 _hasData（会显示上一周的内容）');

  const manual = stripComments(read('pages/manual/index.js'), 'js');
  if (/require\('\.\.\/\.\.\/utils\/mem'\)/.test(manual) && /mem\.read\(key\)/.test(manual) && /mem\.write\(key,\s*r\)/.test(manual)) {
    ok('手动排班页走 utils/mem 内存缓存（二级页销毁后仍能立刻渲染上次内容）');
  } else bad('手动排班页没有接内存缓存（再进必然重等一次云函数）');

  // 缓存键必须带归属（周次），否则跨周拿旧数据；键由 mem.keys 统一构造
  if (/mem\.keys\.manual\(this\.data\.week\)/.test(manual)) {
    ok('手动排班缓存键走 mem.keys.manual(week)（带周次，跨周自动失效）');
  } else bad('手动排班缓存键没走 mem.keys.manual(week)（可能拿上周名单冒充本周，或与预热不同源）');
}

/* ------------------------------------------------------------------ */
/* R4  内存缓存模块本身                                                 */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R4 utils/mem.js ---');
{
  const memSrc = stripComments(read('utils/mem.js'), 'js');
  const hasApi = /function read\(/.test(memSrc) && /function write\(/.test(memSrc) && /function clear\(/.test(memSrc);
  const onGlobal = /app\.globalData/.test(memSrc);
  const noStorage = !/setStorageSync|setStorage\(/.test(memSrc);
  if (hasApi && onGlobal) ok('utils/mem.js 提供 read/write/clear，挂在 app.globalData 上');
  else bad('utils/mem.js 接口不全或没有挂在 app.globalData 上');
  if (noStorage) ok('utils/mem.js 不落 storage（班务数据不在本地留副本）');
  else bad('utils/mem.js 写了 storage（与 utils/notice.js 的策略不一致）');
}

/* ------------------------------------------------------------------ */
/* R5  按下反馈的全局样式                                               */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R5 按下反馈样式 ---');
{
  const appCss = stripComments(read('app.wxss'), 'css');
  const mineWxml = stripComments(read('pages/mine/index.wxml'), 'wxml');
  if (/\.tap-hover\s*\{/.test(appCss)) ok('app.wxss 定义了全局 .tap-hover');
  else bad('app.wxss 缺 .tap-hover（hover-class 指过去没有样式）');

  const rows = (mineWxml.match(/class="mn-row"/g) || []).length;
  const hooked = (mineWxml.match(/class="mn-row"\s+hover-class="tap-hover"/g) || []).length;
  if (rows > 0 && rows === hooked) ok('「我的」页 ' + rows + ' 个入口行全部带按下反馈');
  else bad('「我的」页入口行按下反馈漏了：' + hooked + '/' + rows);
}

/* ------------------------------------------------------------------ */
/* 自证                                                                */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- 自证 ---');
{
  const badTabJs = 'onChange(e) { wx.switchTab({ url: x }); this.setData({ active: index }); }';
  const badOrder = indexAfter(badTabJs, 'onChange(e)', 'setData({ active: index })')
    > indexAfter(badTabJs, 'onChange(e)', 'wx.switchTab(');
  if (badOrder) ok('自证：「先 switchTab 再选中」的样本会被判为问题');
  else bad('自证失败：顺序写反的样本没被识别');

  const badLoad = 'load() { this.setData({ loading: true, failed: false }); }';
  const caught = /load\s*\([^)]*\)\s*\{\s*this\.setData\(\{\s*loading:\s*true/.test(badLoad);
  if (caught) ok('自证：无条件 loading: true 的样本会被抓到');
  else bad('自证失败：无条件骨架的样本没被抓到');

  const badSheet = 'attached() { const w = wx.getWindowInfo(); this.setData({ w }); }';
  const sheetCaught = /wx\.getWindowInfo\(/.test(badSheet);
  if (sheetCaught) ok('自证：组件里自带 wx.getWindowInfo() 的样本会被抓到');
  else bad('自证失败：同步 IPC 的样本没被抓到');
}

/* ------------------------------------------------------------------ */
/* R6  写操作必须作废依赖它的缓存                                       */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R6 写操作后作废缓存 ---');
{
  // 会改动值日表的接口：跑完必须让值日页 / 手动排班页的缓存失效
  const MUT = /api\.schedule(Generate|Publish|Unpublish|Clear|AiApply|AddManual|Reassign|Remove)\(/g;
  const LOOKBACK = 600;   // 同一个 handler 内，作废调用就在写调用之前不远处

  [['duty', '_invalidateManual'], ['manual', '_invalidateDuty']].forEach(([p, fn]) => {
    const src = stripComments(read('pages/' + p + '/index.js'), 'js');
    const hits = [];
    let m;
    MUT.lastIndex = 0;
    while ((m = MUT.exec(src))) {
      const before = src.slice(Math.max(0, m.index - LOOKBACK), m.index);
      // 作废可以直接调 mem.*，也可以走页面自己的包装（_invalidateManual / _invalidateDuty）
      if (!/(mem\.(clear|invalidateSchedule)\(|_invalidate(Manual|Duty)\()/.test(before)) hits.push(m[1]);
    }
    if (!hits.length) ok('pages/' + p + '：所有改动值日表的写操作都先作废了缓存');
    else bad('pages/' + p + '：这些写操作没有作废缓存 → ' + hits.join(' / '));

    if (new RegExp(fn + '\\(\\)').test(src)) ok('pages/' + p + ' 定义了 ' + fn + '()');
    else bad('pages/' + p + ' 缺 ' + fn + '()');
  });

  // 集中式入口：mem.invalidateSchedule 必须同时作废两个键
  const memSrc = stripComments(read('utils/mem.js'), 'js');
  if (/function invalidateSchedule[\s\S]{0,260}keys\.duty\(week\)[\s\S]{0,120}keys\.manual\(week\)/.test(memSrc)) {
    ok('mem.invalidateSchedule 同时作废值日页与手动排班页两个键');
  } else bad('mem.invalidateSchedule 没有把两个键都作废（会留下一个旧名单）');

  // 值日页的「换人 / 请假」都从 duty-sheet 组件发起，页面靠 changed 事件汇流
  const duty = stripComments(read('pages/duty/index.js'), 'js');
  if (/onSheetChanged\(\)\s*\{\s*this\._invalidateManual\(\)/.test(duty)) {
    ok('duty-sheet 的 changed 事件汇流处也作了作废（换人 / 请假不会被漏掉）');
  } else bad('onSheetChanged 没有作废手动排班页的缓存（换人 / 请假后会看到旧名单）');
}

/* ------------------------------------------------------------------ */
/* R7  Tab 数据预热                                                     */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R7 Tab 数据预热 ---');
{
  const app = stripComments(read('app.js'), 'js');
  if (/_prefetchTabs\s*\(\)/.test(app) && /this\._prefetchTabs\(\)/.test(app)) {
    ok('登录成功后调用 _prefetchTabs()（把冷启动等待挪到用户还在首页的时候）');
  } else bad('登录成功后没有预热 Tab 数据');

  if (/api\.scheduleListWeek\(/.test(app) && /mem\.keys\.duty\(/.test(app)) {
    ok('预热的是值日页那一次 schedule.listWeek（课表本地渲染、我的无骨架，都不需要）');
  } else bad('预热目标不是值日页数据（要么没预热，要么预热了不需要预热的页）');

  if (/\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(app) || /\.catch\(\(\)\s*=>\s*\{\}\).*$/m.test(app)) {
    ok('预热失败被吞掉（纯优化，不能影响启动）');
  } else bad('预热没有吞掉失败（可能把启动搞挂）');

  // 键的唯一来源：页面与预热必须用同一套构造器，否则「预热了但页面读不到」
  const memSrc = stripComments(read('utils/mem.js'), 'js');
  const keyUsers = ['app.js', 'pages/duty/index.js', 'pages/manual/index.js'];
  const rawKeys = keyUsers.filter((rel) => {
    const s = stripComments(read(rel), 'js');
    return /'duty:'\s*\+|'manual:'\s*\+|"duty:"\s*\+|"manual:"\s*\+/.test(s);
  });
  if (/keys\s*=\s*\{/.test(memSrc) && !rawKeys.length) {
    ok('缓存键只在 utils/mem 的 keys 里定义（页面 / 预热都引用同一套）');
  } else bad('有地方自己拼缓存键（' + (rawKeys.join(', ') || 'keys 未定义') + '）→ 预热会写过、页面读不到');
}

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
}
console.log('✅ 导航延迟相关不变量检查全部通过');
