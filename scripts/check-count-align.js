#!/usr/bin/env node
/**
 * 离线自检：弹层滚动 + 「值日 N 次」三段对齐 + 成员绑定状态与详情权限
 * ------------------------------------------------------------
 * ① 纵向 scroll-view 必须能拿到**显式高度**
 *    用户报「值日详情里上下滑动，滑的是后面的『本周值日』页面」。
 *    根因不是事件，是高度：`.ds-panel` 只有 `max-height` + 子元素 `flex:1`，
 *    WeChat 的 scroll-view **不认这种派生高度** —— 容器滚不动，手势整段穿透到后面的页面。
 *    对照项目里两处能滚的写法：`bottom-sheet` 的 `height` 参数（显式 height 给 .sheet-panel）、
 *    `bind` 页 `.roster-scroll { height: calc(100vh - 320rpx) }`。
 *    ⚠️ 上一轮曾把「滑不动」误判成 `catchtouchmove` 挂错层级；实测只挪事件没用，
 *    真正的判据是「有没有显式 height」。事件那条规则仍然保留（祖先上挂 catchtouchmove 会吞掉列表滑动）。
 *
 * ② 「值日 N 次」必须写成 值日 + <text class="cnt-num">数字</text> + 次
 *    用户报「值日 0 次要对齐」「单位数变双位数也要保持对齐」。
 *    注意：自定义组件默认 styleIsolation: isolated，app.wxss 的 class 进不去，各 wxss 要各写一份。
 *
 * ③ 成员与分组 → 成员详情
 *    · 绑定状态在列表里可见（已绑定 / 未绑定），统计栏有「已绑定」人数；
 *    · 选中**自己**时不提供「设置班委 / 停用」（避免把自己锁在权限外），仅保留调组 + 解绑；
 *    · 「调到 X 组」文案统一为「调至 X 组」；
 *    · 解除微信绑定必须二次确认（解绑自己尤其不可逆）。
 *
 * 用法：node scripts/check-count-align.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readM = (p) => fs.readFileSync(path.join(R, p), 'utf8');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function note(msg) { console.log('  ·   ' + msg); }
function eq(actual, expect, msg) {
  if (actual === expect) ok(msg + '   → ' + JSON.stringify(actual));
  else bad(msg + '   → 实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect));
}
function assertTrue(cond, msg, detail) {
  if (cond) ok(msg);
  else bad(msg + (detail ? '   → ' + detail : ''));
}

/* ============================================================
 * WXML 轻解析：拿到每个 scroll-view 的祖先链
 * ============================================================ */
const VOID = new Set(['image', 'input', 'icon', 'import', 'include', 'open-data', 'web-view']);
const isSelfClose = (raw, tag) => /\/>$/.test(raw) || VOID.has(tag);
const attrsOf = (s) => s || '';
const classesOf = (attrs) => {
  const m = /class="([^"]*)"/.exec(attrs);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
};

/** 返回 [{ file, attrs, ancestors:[attrs...] }]，只含 <scroll-view> 节点 */
function collectScrollViews() {
  const out = [];
  ['pages', 'components', 'custom-tab-bar'].forEach((base) => {
    const b = path.join(R, base);
    if (!fs.existsSync(b)) return;
    fs.readdirSync(b).forEach((n) => {
      const dir = path.join(b, n);
      if (!fs.statSync(dir).isDirectory()) return;
      const file = path.join(dir, 'index.wxml');
      if (!fs.existsSync(file)) return;
      const rel = path.relative(R, file).replace(/\\/g, '/');
      // 去掉注释再解析；属性值可能含 > （如 wx:if="{{a > b}}"），按引号整段吃掉
      const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const re = /<\/?([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
      const stack = [];
      let m;
      while ((m = re.exec(src))) {
        const raw = m[0];
        const tag = m[1];
        const attrs = attrsOf(m[2]);
        if (raw.startsWith('</')) {
          if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
          continue;
        }
        if (tag === 'scroll-view') {
          out.push({ file: rel, attrs, ancestors: stack.map(s => s.attrs) });
        }
        if (isSelfClose(raw, tag)) continue;
        stack.push({ tag, attrs });
      }
    });
  });
  return out;
}

/** 去掉 CSS 注释：规则体里出现 `{...}` 的注释会把「选择器 { 声明 }」的正则切碎 */
const stripCss = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');
/** 文件里所有「带显式 height」的类名（排除 max-height / min-height / line-height） */
function heightClasses(cssRaw) {
  const out = new Set();
  const css = stripCss(cssRaw);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (/(?:^|[;\s])height\s*:/.test(m[2])) {
      (m[1].match(/\.[A-Za-z0-9_-]+/g) || []).forEach(c => out.add(c.slice(1)));
    }
  }
  return out;
}
/** 取某选择器块里的显式 height 值（没有则空串） */
function explicitHeight(wxssRel, sel) {
  const body = new RegExp('\\' + sel + '\\s*\\{([^}]*)\\}').exec(stripCss(readM(wxssRel)));
  if (!body) return '';
  const m = /(?:^|[;\s])height\s*:\s*([^;\n]+)/.exec(body[1]);
  return m ? m[1].trim() : '';
}

const wxmlCache = {};
function wxssOf(rel) { return readM(rel.replace(/index\.wxml$/, 'index.wxss')); }

const scrolls = collectScrollViews();

/* ============================================================
 * ①-a scroll-view 的祖先不许挂 catchtouchmove
 * ============================================================ */
console.log('── ①-a 弹层内 scroll-view 的滑动不被 catchtouchmove 吞掉');

const scrollProblems = [];
scrolls.forEach((s) => {
  s.ancestors.forEach((a) => {
    if (!/catchtouchmove|catch:touchmove/.test(a)) return;
    const cls = classesOf(a);
    scrollProblems.push(s.file + '：<scroll-view> 的祖先'
      + (cls.length ? ' .' + cls[0] : '') + ' 上挂着 catchtouchmove → 该列表会滑不动');
  });
});
eq(scrollProblems.length, 0, '没有任何 scroll-view 的祖先挂着 catchtouchmove');
scrollProblems.forEach(bad);

/* v0.7.32：duty-sheet 已**并入 bottom-sheet**（薄封装）——遮罩 / 面板 / 把手 / 标题栏 /
   开合动画都在共享组件里（那边的防穿透由 check-scroll-lock 与 check-popup-anim 守）。
   这里只断言「确实委派了、没有自建第二套外壳」。 */
const dsWxml = readM('components/duty-sheet/index.wxml');
assertTrue(/<bottom-sheet\b/.test(dsWxml) && /show="\{\{show\}\}"/.test(dsWxml),
  'duty-sheet 已并入 <bottom-sheet>（show 透传，外壳不再自建）');
assertTrue(!/class="ds-mask|class="ds-panel|class="ds-root/.test(dsWxml),
  'duty-sheet 不再自带遮罩/面板外壳（否则会出现两层遮罩）');

/**
 * ①-c 弹层打开时锁住「页面级滚动」。
 * 值日页是 page 滚动（.dt 只有 min-height:100vh），列表滚到底后 touchmove 会继续
 * 冒泡给 page —— 用户报的「滑到底部时后面的『本周值日』还跟着滑」就是这个。
 * 唯一能挡住 page 滚动的是 page-meta 的 page-style（Vant Weapp 同款方案）。
 */
console.log('\n── ①-c 弹层打开时锁页面滚动（防滚动链传导）');
const dutyWxml = readM('pages/duty/index.wxml');
assertTrue(/<page-meta[^>]*page-style="\{\{[^}]*sheetShow[^}]*aiShow[^}]*groupShow[^}]*addShow[^}]*overflow\s*:\s*hidden/.test(dutyWxml),
  'pages/duty 用 page-meta 在弹层打开时给 page 加 overflow:hidden');
assertTrue(/<\/page-meta>/.test(dutyWxml) && dutyWxml.indexOf('<page-meta') < dutyWxml.indexOf('class="page dt'),
  'page-meta 是页面第一个节点（否则不生效）');
/* v0.7.19 spring-scroll 重构：.dt 不再是页面级滚动（height:100vh + overflow:hidden + flex），
 * 滚动收在 spring-scroll 内；弹层锁仍由 page-meta 承担（上面 ①-c 已断言），
 * 这里改为断言「固定视口」这一新架构前提。 */
assertTrue(/class="page dt/.test(dutyWxml) && /\.dt\s*\{[^}]*height\s*:\s*100vh[^}]*overflow\s*:\s*hidden/.test(stripCss(readM('pages/duty/index.wxss'))),
  '值日页是固定视口（.dt height:100vh + overflow:hidden），滚动收在 spring-scroll 内 —— 弹层锁仍靠 page-meta');

/* ============================================================
 * ①-b 纵向 scroll-view 必须拿得到显式高度
 * ============================================================ */
console.log('\n── ①-b 纵向 scroll-view 的高度是「显式」的（否则滚不动、手势穿透）');

const vertical = scrolls.filter(s => /scroll-y/.test(s.attrs));
assertTrue(vertical.length >= 3, '扫到 ' + vertical.length + ' 个 scroll-y 的 scroll-view', String(vertical.length));

const noHeight = [];
vertical.forEach((s) => {
  const css = wxssOf(s.file);
  const own = classesOf(s.attrs);
  const anc = s.ancestors.reduce((a, x) => a.concat(classesOf(x)), []);
  // 1) 元素自身或任一祖先的内联 style 里写了 height（bottom-sheet 就是这么把宿主传的 height 落到 .sheet-panel 上的）
  const inline = [s.attrs].concat(s.ancestors).some(a => /style="[^"]*height\s*:/.test(a));
  // 2) 自身或任一祖先的 class 在对应 wxss 里有显式 height
  const set = heightClasses(css + '\n' + readM('app.wxss'));
  const okCss = own.concat(anc).some(c => set.has(c));
  if (!inline && !okCss) {
    noHeight.push(s.file + '：<scroll-view class="' + (own[0] || '?') + '"> 自身与祖先都没有显式 height');
  }
});
eq(noHeight.length, 0, '所有纵向 scroll-view 都有显式高度来源');
noHeight.forEach(bad);

/* 已知落点逐项对照（写清楚高度是从哪来的，改坏了能一眼看出） */
const HEIGHT_SITES = [
  // v0.7.32：值日详情并入 bottom-sheet 后，它的确定高度来自「传给共享组件的 height」，
  // 不再是自己的 .ds-panel{height:78vh} —— 见下面那条专门的断言。
  ['pages/bind/index.wxss', '.roster-scroll', '绑定页名单：自身 height:calc(100vh - 320rpx)']
];
HEIGHT_SITES.forEach(([wxss, sel, tip]) => {
  const h = explicitHeight(wxss, sel);
  assertTrue(!!h, tip + '（' + sel + ' 有显式 height）', '实际 height: ' + (h || '无'));
});
/* 通用弹层的高度在 wxml 里由宿主传入：bottom-sheet 的 height 参数 → .sheet-panel 内联 height */
const bsWxml = readM('components/bottom-sheet/index.wxml');
assertTrue(/class="sheet-panel[^"]*"[\s\S]*?style="[^"]*\{\{height \? 'height:' \+ height \+ 'rpx' : ''\}\}/.test(bsWxml),
  '通用弹层：宿主传入的 height 会以内联 height 落到 .sheet-panel（有它，.sheet-body 才滚得动）');
/* v0.7.32：值日详情的「确定高度」改由「传给共享组件的 height」提供 ——
   判据随之改成「确实把高度传下去了 + 仍按 78vh 口径换算」，而不是继续要求它自己写
   .ds-panel{height:78vh} / .ds-body{flex:1;min-height:0}（那会锁死实现、阻碍合并）。 */
assertTrue(/height="\{\{sheetH\}\}"/.test(dsWxml),
  '值日详情：把高度传给 <bottom-sheet>（.sheet-panel 拿到显式 height，body 才滚得动）');
assertTrue(/wh\s*\*\s*0\.78/.test(readM('components/duty-sheet/index.js')),
  '值日详情：sheetH 仍按 78vh 口径换算（与并入前同高）');
assertTrue(!/\.ds-body\s*\{/.test(stripCss(readM('components/duty-sheet/index.wxss'))),
  '值日详情：不再自带滚动容器样式（滚动交给 bottom-sheet 的 .sheet-body）');
note('bottom-sheet 只在传 height 的弹层里有确定高度：未传 height 的（我的申请 / 关于）内容超长时同样滚不动，暂未暴露');

/* ============================================================
 * ② 「值日 N 次」三段对齐
 * ============================================================ */
console.log('\n── ② 「值日 N 次」= 值日 + 定宽数字 + 次');

/* [wxml, 期望的「值日 + 数字」段数, 期望的「本周 + 数字」段数, 对应 wxss]
   ⚠️ 2026-09-26：成员与分组已从「我的」页迁到 pages/roster，展示位置随之搬家。 */
const COUNT_SITES = [
  ['pages/duty/index.wxml', 1, 1, 'pages/duty/index.wxss'],
  ['pages/roster/index.wxml', 2, 0, 'pages/roster/index.wxss'],
  ['components/duty-sheet/index.wxml', 1, 0, 'components/duty-sheet/index.wxss']
];

COUNT_SITES.forEach(([wxml, nDuty, nWeek, wxss]) => {
  const t = readM(wxml);
  const parts = (t.match(/class="cnt-num"/g) || []).length;
  eq(parts, nDuty + nWeek, wxml + ' 的定宽数字槽数量');

  const dutyHits = (t.match(/值日<\/text><text class="cnt-num">\{\{[^}]+\}\}<\/text><text>次<\/text>/g) || []).length;
  const weekHits = (t.match(/本周<\/text><text class="cnt-num">\{\{[^}]+\}\}<\/text><text>次<\/text>/g) || []).length;
  eq(dutyHits, nDuty, wxml + ' 的「值日 + 数字 + 次」三段结构');
  eq(weekHits, nWeek, wxml + ' 的「本周 + 数字 + 次」三段结构');

  const bare = t.match(/(?:值日|本周)\s*\{\{/g);
  eq(bare ? bare.length : 0, 0, wxml + ' 没有「值日/本周 {{n}} 次」的旧写法');

  const onText = (t.match(/<text class="cnt-num">/g) || []).length;
  eq(onText, nDuty + nWeek, wxml + ' 定宽数字槽都写在 <text> 上');

  const css = readM(wxss);
  const rule = /\.cnt-num\s*\{([^}]*)\}/.exec(css);
  assertTrue(!!rule, wxss + ' 定义了 .cnt-num');
  if (rule) {
    const b = rule[1];
    assertTrue(/display\s*:\s*inline-block/.test(b), wxss + ' .cnt-num 是 inline-block');
    assertTrue(/text-align\s*:\s*center/.test(b), wxss + ' .cnt-num 数字居中');
    const w = /min-width\s*:\s*(\d+)rpx/.exec(b);
    assertTrue(!!w && Number(w[1]) >= 40, wxss + ' .cnt-num 定宽 ≥40rpx（够放两位数字）',
      w ? w[1] + 'rpx' : '没有 min-width');
  }
});

assertTrue(/\.dt-progress\s*\{[^}]*min-width\s*:\s*\d+rpx/.test(readM('pages/duty/index.wxss')),
  'pages/duty .dt-progress 有固定 min-width（否则点数变化把尾部计数顶得左右漂移）');

/* ============================================================
 * ③ 成员绑定状态 + 成员详情权限
 * ============================================================
 * ⚠️ 2026-09-26：成员与分组整体迁到 `pages/roster/index`（「我的」页只剩个人卡与入口），
 *    本节的读取目标随之下移，断言也同步到**当前设计**：
 *    「解除微信绑定」不对自己开放（自保）→ 不再有 self 双确认 / _doUnbind 那套。
 * ============================================================ */
console.log('\n── ③ 成员绑定状态与成员详情权限');

const rosWxml = readM('pages/roster/index.wxml');
const rosJs = readM('pages/roster/index.js');
const rosWxss = readM('pages/roster/index.wxss');

/* 绑定状态 */
assertTrue(/class="mb-nameline"/.test(rosWxml), '成员行有 mb-nameline（姓名 + 绑定状态同一行）');
assertTrue(/class="mb-bind \{\{item\.bound \? 'on' : ''\}\}"/.test(rosWxml), '绑定状态用 mb-bind 渲染');
assertTrue(/已绑定/.test(rosWxml) && /未绑定/.test(rosWxml), '已绑定 / 未绑定两种状态都在模板里');
assertTrue(!/mb-tag[^>]*\{\{item\.bound/.test(rosWxml),
  '绑定状态没有塞进右侧 mb-tag 标签区（避免挤窄「学号 · 值日 N 次」）');
assertTrue(/\.mb-bind\s*\{/.test(rosWxss), '.mb-bind 样式已定义');
assertTrue(/boundCount/.test(rosJs), 'roster/index.js 统计了已绑定人数');
assertTrue(/if \(!kw\) patch\.boundCount/.test(rosJs), '只在未搜索时统计已绑定人数（搜索结果不能当全班）');
assertTrue(/boundCount/.test(rosWxml) && /memberStats\.total/.test(rosWxml), '弹层里显示了已绑定 / 总人数');
assertTrue(/role: r\.role, status: r\.status, bound: !!r\.openid/.test(read('cloudfunctions/member/index.js')),
  'member.list(public=manage) 仍回传 bound 字段');

/* 选中自己：不给设置班委 / 停用 / 解绑；v0.7.19 起停用还收紧为「超管或辅导员」 */
assertTrue(/wx:if="\{\{!mDetailIsSelf && \(isSuper \|\| isCounselor\)\}\}"/.test(rosWxml), '停用/恢复按钮按「非自己且超管或辅导员」显示（自保 + 权限双闸）');
assertTrue(/mDetailIsSelf/.test(rosJs), 'roster/index.js 计算了 mDetailIsSelf');
assertTrue(/globalData && app\.globalData\.profile/.test(rosJs) || /globalData\.profile/.test(rosJs),
  'mDetailIsSelf 与登录身份（profile.id）比对');
assertTrue(/调至 \{\{mDetail\.groupTag === 'A' \? 'B' : 'A'\}\} 组/.test(rosWxml),
  '按钮文案为「调至 X 组」');
assertTrue(!/调到 \{\{mDetail\.groupTag/.test(rosWxml), '已无「调到 X 组」旧文案');
assertTrue(/这是你自己的账号/.test(rosWxml), '选中自己时有提示文案说明为何少了几个操作');

/* 解绑：只对他人开放，且必有一次确认（自保设计：不给自己解绑入口） */
const unbind = /onUnbindMember\(\)\s*\{([\s\S]*?)\n  \}/.exec(rosJs);
assertTrue(!!unbind, '找得到 onUnbindMember');
if (unbind) {
  const body = unbind[1];
  eq((body.match(/util\.confirm\(/g) || []).length, 1, 'onUnbindMember 有一次 util.confirm');
  assertTrue(/mDetailIsSelf[\s\S]{0,60}?return/.test(body), 'onUnbindMember 自身也挡住「解绑自己」');
  assertTrue(/api\.unbindMember\(/.test(body), 'onUnbindMember 调 member.unbind');
}
assertTrue(/wx:if="\{\{isSuper && !mDetailIsSelf\}\}"[^>]*bindtap="onUnbindMember"/.test(rosWxml),
  '「解除微信绑定」按钮只对他人显示（不给自己，避免把自己锁在外面）');
assertTrue(/canManage && !mDetailIsSelf[\s\S]{0,80}onRemoveMember/.test(rosWxml),
  '「移出班级」按钮同样排除自己');

console.log('\n' + (failed ? '❌ 失败 ' + failed + ' 项' : '全部通过 ✅'));
process.exit(failed ? 1 : 0);
