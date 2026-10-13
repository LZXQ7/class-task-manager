#!/usr/bin/env node
/**
 * 离线自检：全站多选标签「挤开」动画（2026-09-26 / v0.7.13 需求④）
 * ------------------------------------------------------------
 * 用户原话：「所有的多选标签（发布通知里选班级、选职位……）都用这个动画 ——
 *   标签扩大占用宽度，邻项跟随新的位置移动，切换选项，列表同步更新。」
 *
 * 这个需求有四个**静默失败点**，光靠肉眼在模拟器上点两下发现不了：
 *
 *  ① 过渡了 transform 而不是 padding。
 *     scaleX 只改绘制、不改布局 → 邻项根本不动，看着像「标签自己胖了一下、
 *     旁边纹丝不动」，比原来的硬切还怪。必须过渡 padding（布局属性）才会带动邻项。
 *
 *  ② 加了 .chip-motion 却没给 .on 的目标 padding。
 *     有过渡、没有目标值 → 宽度压根没变 → 动画看不见，还以为「加上了」。
 *
 *  ③ chip 自己的类里又写了一条 transition。
 *     页面 wxss 排在 app.wxss 之后，同特异性（都是单类）**后者胜出** ——
 *     于是共享的过渡被整条覆盖，动画静默消失。
 *
 *  ④ .on 凭空多出 border（原来 .f-chip / .wk-chip 就是这样）。
 *     选中瞬间盒子被撑大 4rpx，整行抖一下。必须默认就挂一圈 transparent 边框 +
 *     box-sizing: border-box，选中时只换 border-color。
 *
 * 用法：node scripts/check-chip-anim.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (rel) => fs.readFileSync(path.join(MINI, rel), 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : bad(m));

/* ------------------------------------------------------------------ */
console.log('── ① 共享动画类 .chip-motion（唯一来源：app.wxss）');
/* ------------------------------------------------------------------ */
const appWxss = read('app.wxss');
{
  const m = /\.chip-motion\s*\{([^}]*)\}/.exec(appWxss);
  chk(!!m, 'app.wxss 定义了 .chip-motion');
  const body = m ? m[1] : '';
  chk(/transition:[^;]*\bpadding\b/.test(body),
    '过渡的是 **padding**（布局属性）—— 邻项才会跟着让位，而不是只改绘制');
  chk(/transition:[^;]*\btransform\b/.test(body),
    '过渡列表里有 transform（选中轻微顶起的手感）');
  chk(/transition:[^;]*background-color/.test(body) && /transition:[^;]*color/.test(body),
    '过渡列表里有颜色（选中态换色不再硬切）');
  chk(!/transition:\s*all/.test(body),
    '没有用 transition: all（会把 margin/height 一起过渡，整行逐帧重排）');
  /* 布局属性一律不许进过渡列表：这几个属性一过渡，每次切换都要重排整行 */
  ['height', 'width', 'margin', 'top', 'left'].forEach((p) => {
    chk(!new RegExp('transition:[^;]*\\b' + p + '\\b').test(body),
      '过渡列表里没有 ' + p + '（布局属性，会触发整行重排）');
  });

  const on = /\.chip-motion\.on\s*\{([^}]*)\}/.exec(appWxss);
  chk(!!on && /transform:\s*scale\(/.test(on[1]),
    '.chip-motion.on 有 scale（选中的那一下「顶起来」）');
  chk(!/\.chip-motion\s*\{[^}]*will-change/.test(appWxss),
    '没有常驻 will-change（这个类挂在 50+ 个成员格上，常驻提示层白吃内存）');

  const rm = /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.chip-motion[\s\S]*?\}\s*\}/.exec(appWxss);
  chk(!!rm, '开启「减少动态效果」时标签动画退化为瞬时（无障碍兜底）');
}

/* ------------------------------------------------------------------ */
console.log('\n── ② 每一族多选标签：挂了 class + 给了变宽目标值');
/* ------------------------------------------------------------------ */

/** 全站的多选 / 选择类标签。kind: grow = 真的变宽挤开邻项；pop = 固定宽，只顶起 */
const CHIPS = [
  { page: 'home', cls: 'np-cls', kind: 'grow', what: '发布通知 · 发送班级' },
  { page: 'home', cls: 'np-chip', kind: 'grow', what: '发布通知 · 按职位' },
  { page: 'home', cls: 'np-abtn', kind: 'grow', what: '发布通知 · A/B 组一键选' },
  { page: 'home', cls: 'np-cell', kind: 'pop', what: '发布通知 · 成员网格' },
  { page: 'roster', cls: 'mb-chip', kind: 'grow', what: '名册 · 全班/仅班委筛选' },
  { page: 'timetable', cls: 'f-chip', kind: 'grow', what: '课表表单 · 分组/星期/节次/周次/调课' },
  { page: 'timetable', cls: 'wk-chip', kind: 'pop', what: '课表 · 周次选择' }
];

/** 取规则里的**横向** padding（rpx；padding 声明的最后一个值） */
function padRpx(src, selector) {
  const re = new RegExp('\\.' + selector.replace('.', '\\.') + '\\s*\\{([^}]*)\\}');
  const m = re.exec(src);
  if (!m) return NaN;
  const p = /padding:\s*([^;]+);?/.exec(m[1]);
  if (!p) return NaN;
  const nums = (p[1].match(/(\d+(?:\.\d+)?)rpx/g) || []).map((x) => parseFloat(x));
  return nums.length ? nums[nums.length - 1] : NaN;
}

/** 该族标签在 wxml 里出现的每一处（精确匹配类名边界，避免 np-chip 命中 np-chips） */
function occurrences(wxml, cls) {
  const re = new RegExp('class="' + cls + '(?=[\\s"])([^"]*)"', 'g');
  const out = [];
  let m;
  while ((m = re.exec(wxml))) out.push(m[1]);
  return out;
}

CHIPS.forEach((c) => {
  const wxml = read('pages/' + c.page + '/index.wxml');
  const wxss = read('pages/' + c.page + '/index.wxss');
  const occ = occurrences(wxml, c.cls);
  chk(occ.length > 0, c.page + ' · .' + c.cls + '（' + c.what + '）在 wxml 里有使用（' + occ.length + ' 处）');
  const missing = occ.filter((rest) => !/\bchip-motion\b/.test(rest));
  chk(missing.length === 0,
    c.page + ' · .' + c.cls + ' 每一处都挂了 chip-motion（漏挂 ' + missing.length + ' 处）');

  /* ③ 页面自己的类不许再写 transition —— 同特异性、页面 wxss 在后，会整条覆盖共享过渡 */
  const own = new RegExp('\\.' + c.cls + '\\s*\\{([^}]*)\\}').exec(wxss);
  const ownBody = own ? own[1] : '';
  const onBody = (new RegExp('\\.' + c.cls + '\\.on\\s*\\{([^}]*)\\}').exec(wxss) || [])[1] || '';
  chk(!/transition\s*:/.test(ownBody),
    c.page + ' · .' + c.cls + ' 自己没有再写 transition（写了会覆盖 .chip-motion，动画静默消失）');

  if (c.kind === 'grow') {
    const base = padRpx(wxss, c.cls);
    const on = padRpx(wxss, c.cls + '.on');
    chk(!Number.isNaN(base) && !Number.isNaN(on) && on > base,
      c.page + ' · .' + c.cls + ' 选中后横向 padding 变大（' + base + 'rpx → ' + on
      + 'rpx）—— 没有目标值 = 宽度没变 = 动画看不见');
  } else {
    /* 固定宽度的格子：改 padding/宽度会整片重排（成员网格 50+ 个），
       所以只吃 .chip-motion.on 的 scale，不参与挤开。这里钉住「它确实是固定宽」。 */
    chk(/width:\s*\d+rpx/.test(ownBody),
      c.page + ' · .' + c.cls + ' 是固定宽格子（只轻微顶起、不挤开邻项，避免 50+ 格整片重排）');
    chk(!/transform\s*:/.test(onBody),
      c.page + ' · .' + c.cls + '.on 没有自己的 transform（会盖掉 .chip-motion.on 的 scale）');
  }

  /* ④ .on 不许凭空长边框：要么默认就挂一圈同宽透明边框，要么 .on 也不加 border */
  if (/border\s*:/.test(onBody)) {
    chk(/border:\s*\d+rpx solid transparent/.test(ownBody) || /box-sizing:\s*border-box/.test(ownBody),
      c.page + ' · .' + c.cls + ' 默认挂透明边框 / border-box（选中只换颜色，盒子不会被凭空撑大 4rpx）');
  }
});

/* ------------------------------------------------------------------ */
console.log('\n── ③ 有意排除的：单选且等分的 segmented（不是多选标签）');
/* ------------------------------------------------------------------ */
{
  const seg = read('components/segmented/index.wxss');
  const segItem = /\.seg-item\s*\{([^}]*)\}/.exec(seg);
  /* 它是**单选 + 等分固定宽**（v0.7.20 起格宽 = `flex:1` 等分，指示器尺寸由组件 JS 按
     width/n 下发），「挤开邻项」对它没有意义，所以不要求挂 chip-motion；
     但要确认切换时至少不是硬切（已有 background/color 过渡）。 */
  chk(!!segItem && /transition:[^;]*background/.test(segItem[1]),
    'segmented：单选等分，不参与挤开；已有 background/color 过渡（切换不是硬切）');
}

/* ------------------------------------------------------------------ */
console.log('\n── ④ 双向自证');
/* ------------------------------------------------------------------ */
{
  /* 坏样本 1：只过渡 transform，不过渡 padding → 邻项不会动 */
  const badMotion = '.chip-motion { transition: transform .22s ease; }';
  chk(!/transition:[^;]*\bpadding\b/.test(badMotion),
    '自证：只过渡 transform 的样本会被判「邻项不会让位」');

  /* 坏样本 2：挂了 class 但 .on 没给目标 padding */
  const badWxss = '.np-cls { padding: 0 24rpx; }\n.np-cls.on { color: #FFF; background: #3370FF; }';
  chk(Number.isNaN(padRpx(badWxss, 'np-cls.on')),
    '自证：.on 没给 padding 的样本会被抓到（动画等于没加）');

  /* 坏样本 3：wxml 里漏挂 class */
  const badWxml = '<view class="np-cls {{noticeAllClasses ? \'on\' : \'\'}}">全部班级</view>';
  chk(occurrences(badWxml, 'np-cls').filter((r) => !/\bchip-motion\b/.test(r)).length === 1,
    '自证：wxml 漏挂 chip-motion 的样本会被抓到');

  /* 好样本不得误报：np-chip 不能被 np-chips 误伤 */
  const goodWxml = '<view class="np-chips"><view class="np-chip chip-motion {{on ? \'on\' : \'\'}}">x</view></view>';
  chk(occurrences(goodWxml, 'np-chip').length === 1,
    '自证：.np-chips（容器）不会被误当成 .np-chip（标签）');
}

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('✅ 多选标签「挤开」动画校验通过（覆盖 ' + CHIPS.length + ' 族标签）');
