#!/usr/bin/env node
/**
 * 离线自检：深色模式「原生弹窗 / 下拉圆环 / 卡片白光 / 玻璃按钮」四类修复（2026-11-15）
 * --------------------------------------------------------------------------------
 * 用户这一轮实拍报的 7 件事里，有 4 类是有**结构性根因**、容易在后续改动里回潮的：
 *
 * ① **深色模式下原生弹窗永远是白的** —— `wx.showActionSheet` / `wx.showModal` 是
 *    微信客户端自己画的，小程序**没有任何接口**改它的底色（连 backgroundColor 都没有）。
 *    ⇒ 「我的」页的『切换测试账号』『切换为体验版？』『班级绑定入口』必须用站内组件。
 *    判据：这两个 API 在该页 JS 里**彻底不出现**（剥注释后全文扫描）。
 *
 * ② **下拉刷新的小圆环** —— spring-scroll 的 `.ss-indicator / .ss-ring`，深色下是一个
 *    很扎眼的蓝白圆点，用户要求「去掉」。刷新行为保留，只是不再画指示物。
 *
 * ③ **卡片白光闪烁** —— 2026-11-15 先去掉呼吸动画（静态化）仍闪；
 *    2026-11-16 用户真机复报后明确「去掉光吧」⇒ 直接**移除光源**：
 *    `.tg-glare` 节点 + radial-gradient + outline 描边全部删除，3D 倾斜保留。
 *    本门禁反向守「光源不得回潮」（节点/渐变/动画/关键帧都不许再出现）。
 *
 * ④ **圆形浮层按钮统一玻璃** —— 课表「＋」与弧形菜单四个圆形项共用
 *    底栏那套 `--tabbar-bg / -edge / -shadow / -highlight` 令牌（用户 1.0.8.43 口径：
 *    「改成和底栏一样的玻璃效果」）。组件里不许再写实心渐变。
 *
 * 用法：node scripts/check-dark-ui-fixes.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  mineJs: 'miniprogram/pages/mine/index.js',
  mineWxml: 'miniprogram/pages/mine/index.wxml',
  mineJson: 'miniprogram/pages/mine/index.json',
  ssWxml: 'miniprogram/components/spring-scroll/index.wxml',
  ssWxss: 'miniprogram/components/spring-scroll/index.wxss',
  tiltWxss: 'miniprogram/components/tilt-card/index.wxss',
  rmWxss: 'miniprogram/components/radial-menu/index.wxss',
  ttWxss: 'miniprogram/pages/timetable/index.wxss',
  ttWxml: 'miniprogram/pages/timetable/index.wxml'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

/** 取某个选择器的声明体（纯函数，变异自证复用） */
function rule(css, selector) {
  const body = stripCss(css);
  const i = body.indexOf(selector);
  if (i < 0) return '';
  const s = body.indexOf('{', i);
  if (s < 0) return '';
  let d = 0;
  for (let k = s; k < body.length; k += 1) {
    if (body[k] === '{') d += 1;
    else if (body[k] === '}') { d -= 1; if (!d) return body.slice(s + 1, k); }
  }
  return '';
}

/** 契约评估（纯函数） */
function evalAll(s) {
  const mj = stripJs(s.mineJs);
  const mw = stripXml(s.mineWxml);
  const pm = (/<page-meta[^>]*page-style="\{\{([^}]*)\}\}"/.exec(mw) || ['', ''])[1];
  const ssW = stripXml(s.ssWxml);
  const ssC = stripCss(s.ssWxss);
  const glare = rule(s.tiltWxss, '.tg-glare');
  const rmBtn = rule(s.rmWxss, '.rm-btn');
  const fab = rule(s.ttWxss, '.fab ');
  return {
    // ① 原生弹窗退场
    noNativeSheet: !/wx\.showActionSheet\s*\(/.test(mj),
    noNativeModal: !/wx\.showModal\s*\(/.test(mj),
    hasDialogTag: (mw.match(/<dialog[\s>]/g) || []).length >= 2,
    hasAccSheet: /<bottom-sheet[^>]*show="\{\{accSheetShow\}\}"/.test(mw),
    dialogRegistered: /"dialog"\s*:\s*"[^"]*components\/dialog\/index"/.test(s.mineJson),
    lockAll: ['accSheetShow', 'demoConfirmShow', 'bindConfirmShow'].every((x) => pm.indexOf(x) >= 0),
    // ② 下拉圆环已删
    noRingNode: !/ss-indicator/.test(ssW) && !/ss-ring/.test(ssW),
    noRingCss: !/\.ss-ring/.test(ssC) && !/ss-spin/.test(ssC) && !/\.ss-indicator/.test(ssC),
    // ③ 卡片光源整体移除（2026-11-16 用户「去掉光吧」）
    noGlareRule: glare.length === 0 && !/\.tg-glare/.test(stripCss(s.tiltWxss)),
    noRadialGlow: !/radial-gradient/.test(stripCss(s.tiltWxss)) && !/outline\s*:/.test(stripCss(s.tiltWxss)),
    noGlareKeyframes: !/tgGlareBreath/.test(stripCss(s.tiltWxss)),
    // ④ 圆形浮层按钮 = 与底栏同一套玻璃（1.0.8.43 用户口径）
    /* ⚠️ 必须锚到 `background:` 上：`--tabbar-bg` 与 `--tabbar-edge` / `--tabbar-shadow` 同前缀，
       只匹配前缀的话「背景改回实心蓝」也照样命中（本门禁第一次写就这样假通过过）。 */
    rmGlass: /background:\s*var\(--tabbar-bg\b/.test(rmBtn) && !/linear-gradient\(140deg/.test(rmBtn),
    rmFallbacks: /@supports not \(\(backdrop-filter/.test(s.rmWxss) && /prefers-reduced-transparency/.test(s.rmWxss),
    /* 底栏玻璃是中性底 ⇒ 文字必须转品牌色。留着 `color: #FFFFFF` 就是白字压白玻璃，看不见。 */
    rmBrandText: /color:\s*var\(--brand\b/.test(rmBtn),
    fabGlass: /background:\s*var\(--tabbar-bg\b/.test(fab),
    /* 课表「＋」不再用图标：图标库里 plus 只有 white 变体，浅色玻璃上会消失 ⇒ 改成品牌色文字。
       wxss 有 .fab-plus 规则 + wxml 用 <text class="fab-plus">，两边都要对得上。 */
    fabPlusText: /\.fab-plus\s*\{[^}]*color:\s*var\(--brand\b/.test(stripCss(s.ttWxss))
      && /<text class="fab-plus">/.test(stripXml(s.ttWxml))
      && !/name="plus"/.test(stripXml(s.ttWxml))
  };
}

const S = evalAll(SRC);

console.log('── ① 深色原生弹窗 → 站内组件（' + F.mineJs + '）');
check(S.noNativeSheet, '不再调用 wx.showActionSheet（客户端画的，深色必然是白板）');
check(S.noNativeModal, '不再调用 wx.showModal（同因）');
check(S.hasDialogTag, 'wxml 里有 ≥2 个 <dialog>（切换体验版 / 绑定入口）');
check(S.hasAccSheet, '测试账号列表走 bottom-sheet（accSheetShow）');
check(S.dialogRegistered, 'index.json 注册了 dialog 组件');
check(S.lockAll, 'page-meta 的滚动锁把三个新弹层全列进去了（check-scroll-lock 同款要求）');

console.log('\n── ② 下拉刷新的小圆环已整段删除');
check(S.noRingNode, 'spring-scroll wxml 没有 .ss-indicator / .ss-ring 节点');
check(S.noRingCss, 'spring-scroll wxss 没有 .ss-indicator / .ss-ring / ss-spin 关键帧');

console.log('\n── ③ 卡片光源整体移除（真机仍闪 → 用户要求去掉光）');
check(S.noGlareRule, '.tg-glare 规则与节点已删除');
check(S.noRadialGlow, 'radial-gradient 柔光与 outline 描边已删除');
check(S.noGlareKeyframes, 'tgGlareBreath 关键帧不存在');

console.log('\n── ④ 圆形浮层按钮 = 与底栏同一套玻璃');
check(S.rmGlass, '弧形菜单 .rm-btn 用 var(--tabbar-bg)（不再是实心渐变 / 品牌玻璃）');
check(S.rmBrandText, '弧形菜单按钮文字转品牌色（中性玻璃上白字看不见）');
check(S.rmFallbacks, 'radial-menu 补了 @supports not + prefers-reduced-transparency 两条降级');
check(S.fabGlass, '课表 .fab 用 var(--tabbar-bg)（与底栏、弧形菜单同一组令牌）');
check(S.fabPlusText, '课表「＋」是品牌色文字而不是 plus 图标（图标库只有 white 变体）');

/* ---------------- 变异自证 ---------------- */
console.log('\n── ⑤ 变异自证（改坏 → 对应契约必须翻红）');
const MUT = [
  { name: '「我的」页又用 wx.showActionSheet', file: 'mineJs', probe: 'noNativeSheet',
    from: '_showSwitchSheet(accounts) {', to: '_showSwitchSheet(accounts) {\n    wx.showActionSheet({ itemList: [] });' },
  { name: '「我的」页又用 wx.showModal', file: 'mineJs', probe: 'noNativeModal',
    from: 'onSwitchDemo() {', to: 'onSwitchDemo() {\n    wx.showModal({ title: \'x\' });' },
  { name: '测试账号列表退回原生（删掉 bottom-sheet 入口）', file: 'mineWxml', probe: 'hasAccSheet',
    from: 'show="{{accSheetShow}}"', to: 'show="{{accSheetHidden}}"' },
  { name: '新增弹层漏进 page-meta 滚动锁', file: 'mineWxml', probe: 'lockAll',
    from: ' || accSheetShow || demoConfirmShow || bindConfirmShow', to: '' },
  { name: '把下拉刷新圆环加回来（wxml）', file: 'ssWxml', probe: 'noRingNode',
    from: 'class="ss-content"', to: 'class="ss-ring"' },
  { name: '柔光规则回潮（白光又开始闪）', file: 'tiltWxss', probe: 'noGlareRule',
    from: '.tg-surface {\n  position: relative;\n  border-radius: var(--r-md, 24rpx);\n}',
    to: '.tg-surface {\n  position: relative;\n  border-radius: var(--r-md, 24rpx);\n}\n.tg-glare { background: radial-gradient(circle, #fff, transparent); }' },
  { name: '描边/渐变回潮', file: 'tiltWxss', probe: 'noRadialGlow',
    from: '  border-radius: var(--r-md, 24rpx);\n}',
    to: '  border-radius: var(--r-md, 24rpx);\n  outline: 2rpx solid #fff;\n}' },
  { name: '弧形菜单按钮改回实心蓝渐变', file: 'rmWxss', probe: 'rmGlass',
    from: '  background: var(--tabbar-bg, rgba(255, 255, 255, 0.35));',
    to: '  background: linear-gradient(140deg, #5A97FF 0%, #3370FF 100%);' },
  { name: '弧形菜单按钮文字又写死白色', file: 'rmWxss', probe: 'rmBrandText',
    from: '  color: var(--brand, #3370FF);',
    to: '  color: #FFFFFF;' },
  { name: '课表加号改回实心蓝', file: 'ttWxss', probe: 'fabGlass',
    from: '  background: var(--tabbar-bg, rgba(255, 255, 255, 0.35));',
    to: '  background: rgba(51,112,255,0.84);' },
  { name: '课表「＋」改回 white 图标（浅色玻璃上会消失）', file: 'ttWxml', probe: 'fabPlusText',
    from: '<text class="fab-plus">＋</text>',
    to: '<app-icon name="plus" variant="white" size="{{44}}" />' }
];

MUT.forEach((mu) => {
  const before = SRC[mu.file];
  if (before.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中（锚点必须唯一且与真实缩进一致）');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [mu.file]: before.replace(mu.from, mu.to) });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 深色 UI 修复检查全部通过'));
process.exit(failed ? 1 : 0);
