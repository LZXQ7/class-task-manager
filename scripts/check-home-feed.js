#!/usr/bin/env node
/**
 * 门禁：首页「作业提交播报」（2026-10-28 需求）
 * ============================================================
 * 需求原话：「上面的文字改成：如果有发布作业，谁提交了作业就滚动展示一次，展示完就消失。」
 *
 * 这一块原来是远程配置下发的静态欢迎语（app_config.homeBanner），现在换成动态播报。
 * 看着简单，但**六条容易写错又看不出来的线**：
 *   ① 后端只给能看提交名单的人（班委 / 超管 / 辅导员）——
 *      普通成员在 homework.detail 里看不到别人的提交状态，首页播出来等于绕权限；
 *   ② 「最近动作」必须是 GREATEST(submitted_at, updated_at) ——
 *      重交只刷 updated_at，只认 submitted_at 会让「被打回后重交」不播（最该播的一次）；
 *   ③ 首次没有游标**只记基线不播** —— 否则新装/换机的用户一进首页就被灌 5 条历史提交；
 *   ④ 游标**播完才写** —— 中途切走（onHide 停表）不该算看过，下次要能重播；
 *   ⑤ 游标键含 成员id + 班级id —— 换号 / 切班各记各的，否则 A 看过导致 B 看不到；
 *   ⑥ 拉取必须**在 load() 的 STALE_MS 早退之前** —— 播报是即时信号，
 *      跟着首屏 20s 缓存一起被跳过就永远慢一拍。
 *
 * 纯静态扫描（结构事实：有没有这个分支 / 这个游标），末尾带 7 组变异自证。
 * 用法：node scripts/check-home-feed.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  hw: 'cloudfunctions/homework/index.js',
  api: 'miniprogram/utils/api.js',
  homeJs: 'miniprogram/pages/home/index.js',
  homeWxml: 'miniprogram/pages/home/index.wxml',
  homeWxss: 'miniprogram/pages/home/index.wxss'
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 剥 JS 注释（只认 // 与「斜杠星」，保住 URL 里的 //） */
function stripJs(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
/** 剥 wxml 注释 —— 按 JS 那套剥会把「尖括号叹号」注释原样留着，断言会被注释骗过 */
function stripWxml(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '');
}

const SRC = {};
Object.keys(FILES).forEach((k) => {
  const raw = read(FILES[k]);
  SRC[k] = /\.wxml$/.test(FILES[k]) ? stripWxml(raw) : stripJs(raw);
});

/** 取锚点之间的片段（限定范围做断言，全文搜会把同一个词在别处的出现也算进来） */
function section(src, from, to) {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = src.indexOf(to, i + from.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

/* ============================================================
 * 断言集（返回未通过项数）
 * ============================================================ */
function audit(S) {
  let fail = 0;
  const ok = (m) => { if (!audit.silent) console.log('  ✓ ' + m); };
  const bad = (m) => { fail++; if (!audit.silent) console.log('  ✗ ' + m); };
  const head = (t) => { if (!audit.silent) console.log('\n' + t); };
  const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

  /* ---------------- ① 后端：路由与权限 ---------------- */
  head('── ① homework.feed 路由与可见性');
  has(S.hw, /feed:\s*\{\s*auth:\s*\{\s*needBind:\s*true\s*\},\s*handler:\s*feed\s*\}/,
    'routes 登记 feed 且 needBind');
  const feedFn = section(S.hw, 'async function feed(', '\nconst routes');
  if (feedFn) ok('找到 feed() 实现'); else bad('找不到 feed() 实现（锚点漂移或函数被删）');

  has(feedFn, /role !== 'committee' && role !== 'super' && role !== 'counselor'/,
    '只对 班委 / 超管 / 辅导员 放行（普通成员不播）');
  has(feedFn, /return\s*\{\s*list:\s*\[\],\s*now:/,
    '普通成员**静默返回空数组**（首页首屏不该多一个错误态）');
  if (!/throw new BizError\(40003/.test(feedFn)) ok('普通成员不抛 403（静默降级）');
  else bad('普通成员抛了 403 —— 首页会画失败态，播报不该有这个副作用');

  has(feedFn, /guard\.resolveClassId\(pool,\s*ctx,\s*payload\)/, '班级走 guard.resolveClassId（支持按班看）');
  has(feedFn, /NOT_TEST\('m'\)/, '排除 99 段测试账号（与全站人员口径一致）');

  /* ---------------- ② 「最近动作」口径 ---------------- */
  head('── ② 最近动作时间 = GREATEST(submitted_at, updated_at)');
  has(feedFn, /GREATEST\(s\.submitted_at,\s*s\.updated_at\)/,
    '提交/重交统一按 GREATEST 取最近动作（重交只刷 updated_at）');
  has(feedFn, /UNIX_TIMESTAMP\(GREATEST\(/,
    '返回绝对秒（UNIX_TIMESTAMP），前端游标不依赖墙钟格式');
  has(feedFn, /DATE_SUB\(NOW\(\), INTERVAL \? HOUR\)/, '有时间窗口（只播最近一天，不积压历史）');
  has(feedFn, /LIMIT \?/, '有 LIMIT（单次最多几条）');
  has(S.hw, /const FEED_HOURS = \d+;/, 'FEED_HOURS 常量存在（窗口可调）');
  has(S.hw, /const FEED_MAX = \d+;/, 'FEED_MAX 常量存在（条数可调）');

  /* ---------------- ③ api 契约 ---------------- */
  head('── ③ api.js 映射');
  has(S.api, /homeworkFeed:\s*C\('homework',\s*'feed'\)/, 'homeworkFeed → homework.feed');

  /* ---------------- ④ 前端：拉取与游标 ---------------- */
  head('── ④ 首页拉取与游标（六个坑）');
  has(S.homeJs, /hwFeedShow:\s*false/, 'data 有 hwFeedShow');
  has(S.homeJs, /hwFeedQueue:\s*\[\]/, 'data 有 hwFeedQueue');
  has(S.homeJs, /hwFeedIdx:\s*0/, 'data 有 hwFeedIdx');

  /* ⑥ 拉取必须在 STALE_MS 早退之前：把 load 开头到第一次 return 之间的片段抠出来 */
  const loadHead = section(S.homeJs, 'load(force) {', 'if (!force && this._hasData');
  if (/_loadHwFeed\(\)/.test(loadHead)) {
    ok('_loadHwFeed() 在 STALE_MS 早退**之前**调用（播报不吃首屏缓存）');
  } else {
    bad('_loadHwFeed() 不在 load() 早退之前 —— 切回首页会跟着 20s 缓存一起跳过');
  }

  has(S.homeJs, /this\._feedKey = 'hwfeed:' \+ meId \+ ':' \+ classId/,
    '游标键含 成员id + 班级id（换号 / 换班各记各的）');

  has(S.homeJs, /if \(!prev\) \{ this\._feedSetCursor\(newest\); return; \}/,
    '首次没有游标 → 只记基线不播（新装用户不被灌历史提交）');
  has(S.homeJs, /list\.filter\(x => \(Number\(x\.at\) \|\| 0\) > prev\)/,
    '只播比游标新的那些（播过的不会重播）');

  /* ④ 播完才写游标：_endHwFeed 里必须有 _feedSetCursor
     ⚠️ 收尾锚点用「下一个方法名」而不是 `/**` —— 源码是**剥过注释**的，
        拿注释当锚点会找不到 ⇒ section 退化成「到文件末尾」⇒ 后面 onHwFeedTap
        里的同名调用把这条断言喂成恒真（M6 变异因此漏网过一次）。 */
  const endFn = section(S.homeJs, '_endHwFeed(queue) {', 'onHwFeedTap() {');
  if (/_feedSetCursor\(Number\(last\.at\)/.test(endFn)) ok('游标在 _endHwFeed（播完）里才推进');
  else bad('游标不在 _endHwFeed 里写 —— 中途切走也算看过，那段播报等于被吞了');

  /* ⑤ 定时器清理：onHide 是唯一入口，不清 = 后台对隐藏页 setData。
     ⚠️ 终点必须用 `onShow() {` 而不是 `onUnload`：源码是**剥过注释**的，
        onUnload 那段的注释说明没了，第一个 onUnload 落在文件末尾 ⇒ section 会
        一路吃到 onShow 之后的所有方法（那儿也有 _feedTimer / _feedSetCursor）⇒
        断言恒真。M2 / M6 两条变异都因此漏网过，别改成 onUnload。 */
  const hideFn = section(S.homeJs, 'onHide() {', 'onShow() {');
  if (/_feedTimer/.test(hideFn) && /clearTimeout\(this\._feedTimer\)/.test(hideFn)) {
    ok('onHide 清 _feedTimer（切走 Tab 不在后台空转）');
  } else {
    bad('onHide 没清 _feedTimer —— 定时器会在隐藏页上继续 setData');
  }

  /* 去重：同一人同一份作业只留最近一条 */
  has(S.homeJs, /x\.memberId \+ '-' \+ x\.homeworkId/, '按 成员+作业 去重（重交不播两条一样的）');
  has(S.homeJs, /\.slice\(0, FEED_PLAY_MAX\)\.reverse\(\)/,
    '截断到上限并**反转成正序**（旧的先播，时间线才对）');

  /* 空 catch 铁律：失败必须落 console.error，否则「云函数挂了」会被当成「没人交作业」 */
  const feedLoad = section(S.homeJs, '_loadHwFeed() {', '_feedBuild(list) {');
  has(feedLoad, /console\.error\('\[home\] homeworkFeed/, '拉取失败落 console.error（不写空 catch）');

  /* ---------------- ⑤ wxml / wxss ---------------- */
  head('── ⑤ 播报条结构');
  const wxml = S.homeWxml;
  has(wxml, /wx:if="\{\{hwFeedShow\}\}"/, 'wx:if 按 hwFeedShow 显隐（播完整体移除）');
  has(wxml, /hwFeedOut \? 'home-feed-out' : ''/, '收起时挂 home-feed-out（淡出 + 塌陷）');
  has(wxml, /translateY\(-\{\{hwFeedIdx \* 40\}\}rpx\)/,
    '靠 translateY 上滚（真·滚动，不是逐条淡入）');
  has(wxml, /wx:for="\{\{hwFeedQueue\}\}" wx:key="key"/, 'wx:for 带 wx:key');
  has(wxml, /bindtap="onHwFeedTap"/, '可点开进作业页');
  has(wxml, /\{\{item\.memberName\}\}/, '渲染提交人姓名');
  has(wxml, /\{\{item\.homeworkTitle\}\}/, '渲染作业标题');

  const wxss = S.homeWxss;
  has(wxss, /\.home-feed\s*\{[\s\S]{0,400}?max-height:\s*80rpx/, '.home-feed 有 max-height（收起要能塌陷）');
  has(wxss, /\.home-feed-out\s*\{[\s\S]{0,200}?max-height:\s*0/, '.home-feed-out 塌陷到 0');
  has(wxss, /\.home-feed-body\s*\{[\s\S]{0,160}?overflow:\s*hidden/, '.home-feed-body 裁掉多余行');
  has(wxss, /\.home-feed-track\s*\{[\s\S]{0,120}?transition:\s*transform/, '.home-feed-track 有 transform 过渡');

  /* 首页不应再有旧的静态横幅样式残留（两套样式并存 = 一定有人又加回去了） */
  if (!/\.home-banner\s*\{/.test(wxss)) ok('旧的 .home-banner 样式已清理');
  else bad('.home-banner 样式还在 —— 静态欢迎语与播报会抢同一个位置');

  return fail;
}

/* ============================================================
 * 主流程
 * ============================================================ */
console.log('── 首页作业提交播报：静态判据');
const n = audit(SRC);
console.log(n === 0 ? 'PASS  全部判据通过' : 'FAIL  ' + n + ' 条判据未通过');
if (n !== 0) process.exit(1);

/* ============================================================
 * 变异自证：每改坏一处必须被抓到（内存副本，不落盘）
 * ============================================================ */
console.log('\n── 变异自证：改坏一处必须翻红');
audit.silent = true;
const MUT = [
  {
    name: 'M1 首次没游标也照播（新装用户一进首页被灌 5 条历史提交）',
    apply: () => ({ homeJs: SRC.homeJs.replace(
      "if (!prev) { this._feedSetCursor(newest); return; }",
      'if (!prev) { this._feedSetCursor(newest); }'
    ) })
  },
  {
    name: 'M2 onHide 不清播报定时器（切走后仍在隐藏页上 setData）',
    apply: () => ({ homeJs: SRC.homeJs.replace(
      '    if (this._feedTimer) { clearTimeout(this._feedTimer); this._feedTimer = null; }\n    if (this._audio)',
      '    if (this._audio)'
    ) })
  },
  {
    name: 'M3 只认 submitted_at（被打回后重交不播 —— 恰恰是最该播的一次）',
    apply: () => ({ hw: SRC.hw.split('GREATEST(s.submitted_at, s.updated_at)').join('s.submitted_at') })
  },
  {
    name: 'M4 普通成员也放行（首页播报绕过提交名单权限）',
    apply: () => ({ hw: SRC.hw.replace(
      "if (role !== 'committee' && role !== 'super' && role !== 'counselor') {",
      'if (false) {'
    ) })
  },
  {
    name: 'M5 拉取挪到 STALE_MS 早退之后（播报跟着首屏缓存一起被跳过）',
    apply: () => ({ homeJs: SRC.homeJs.replace(
      '  load(force) {\n',
      '  load(force) {\n    if (!force && this._hasData && this._lastLoad && Date.now() - this._lastLoad < STALE_MS) { return; }\n'
    ) })
  },
  {
    name: 'M6 游标一开始播就写（中途切走看不到，下次也不重播）',
    apply: () => ({ homeJs: SRC.homeJs.replace(
      'const last = queue[queue.length - 1];\n      if (last) this._feedSetCursor(Number(last.at) || 0);',
      '/* 游标挪走了 */'
    ) })
  },
  {
    name: 'M7 去掉去重（重交会连着播两条一模一样的）',
    apply: () => ({ homeJs: SRC.homeJs.replace(
      "const k = x.memberId + '-' + x.homeworkId;\n      if (seen[k]) continue;\n      seen[k] = 1;",
      "const k = x.id;"
    ) })
  }
];

let caught = 0;
MUT.forEach((c) => {
  let over = {};
  try { over = c.apply(); } catch (e) {
    console.log('  ✗ 变异「' + c.name + '」构造失败：' + e.message);
    return;
  }
  /* 🔴 锚点漂移时 String.replace 会原样返回 ⇒ 测的还是原文件 = 假自证 */
  const touched = Object.keys(over).some((k) => over[k] !== SRC[k]);
  if (!touched) {
    console.log('  ✗ 变异「' + c.name + '」**没有真的改到源码**（锚点失效）⇒ 门禁测的是原文件');
    process.exitCode = 1;
    return;
  }
  const merged = Object.assign({}, SRC, over);
  let nf = 0;
  try { nf = audit(merged); } catch (e) {
    console.log('  ✗ 变异「' + c.name + '」跑挂了（' + e.message + '）');
    process.exitCode = 1;
    return;
  }
  if (nf > 0) { console.log('  ✓ 变异「' + c.name + '」被抓到（' + nf + ' 条翻红）'); caught += 1; }
  else { console.log('  ✗ 变异「' + c.name + '」**没被抓到** —— 判据失效'); process.exitCode = 1; }
});
audit.silent = false;

console.log('');
if (caught === MUT.length) console.log('✓ ' + MUT.length + '/' + MUT.length + ' 条变异全部被抓');
else { console.log('[FAIL] 变异自证未全数通过'); process.exitCode = 1; }
console.log(process.exitCode ? '[FAIL] 首页作业提交播报门禁未通过' : 'OK · 首页作业提交播报校验通过');
