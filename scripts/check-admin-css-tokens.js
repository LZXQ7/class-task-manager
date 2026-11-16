#!/usr/bin/env node
/**
 * 后台 CSS 令牌健康度门禁（2026-11-16 焕新）
 * ============================================================
 * 为什么需要它：本次焕新实测出**两类门禁抓不到的问题**——
 *   ① 变量被引用但从未定义 ⇒ 整条声明静默失效（"点了没反应"/"效果没出现"的隐藏成因）；
 *   ② 变量被定义两次 ⇒ 后者覆盖前者，前者等于白写；
 *   ③ 彩色文字对比度不足 WCAG AA（4.5:1）⇒ 无障碍硬伤，门禁全绿也照样存在。
 * 这三类都能在源码层静态判定，所以做进门禁，防止后续迭代再犯。
 *
 * 判据全部读真实源码，不写死期望值（除阈值外）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css'), 'utf8');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

/* ── 取 :root 里定义的令牌 ───────────────────────────── */
const rootMatch = /:root\s*\{([\s\S]*?)\n\}/.exec(CSS);
if (!rootMatch) {
  console.log('✗ 找不到 :root 块');
  process.exit(1);
}
const rootBody = rootMatch[1];
const defs = [];   // { name, value, line }
/* ⚠️ 一行可能定义多个令牌（如 `--ok: #12A150;  --ok-soft: #E7F7EE;  --ok-line: …`），
   所以不能按行拆 —— 要按**分号**拆，再逐个匹配 `--name: value`。
   第一版按行解析，导致这些多变量行全部漏检（假绿），必须按分号拆。 */
rootBody.split(';').forEach((chunk, i) => {
  const m = /(--[a-z0-9-]+)\s*:\s*([^;]+)/.exec(chunk);
  if (m) defs.push({ name: m[1], value: m[2].trim(), line: i + 1 });
});
const defNames = defs.map((d) => d.name);

/* ── ① 被引用但未定义的变量 ───────────────────────────── */
section('① 被引用但从未定义的变量（整条声明会静默失效）');
/* ⚠️ 两种合法例外，必须放行，否则门禁会误报：
 *   ① 运行时注入的变量：--enter-delay（app.js 的 stagger() 用
 *      el.style.setProperty('--enter-delay', ...) 逐张写入），
 *      且 CSS 侧写成 var(--enter-delay, 0ms) 带兜底；
 *   ② 已有兜底值的引用：var(--x, #fff) —— 变量未定义也不影响生效。
 * 判据：未定义 ⇒ 必须**带兜底** 或 **在白名单里**，否则整条声明静默失效。 */
const RUNTIME_VARS = ['--enter-delay'];   // JS 运行时注入
const used = [...new Set([...CSS.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)].map((m) => m[1]))];
/* 找出所有"未定义且无兜底"的引用 */
const noFallback = [];
const usedRe = /var\(\s*(--[a-z0-9-]+)\s*([,)])/g;
let um;
while ((um = usedRe.exec(CSS))) {
  const name = um[1];
  if (defNames.includes(name)) continue;
  if (RUNTIME_VARS.includes(name)) continue;
  // um[2] 是 ',' 或 ')'：',' 表示后面还有兜底值
  if (um[2] === ',') continue;
  noFallback.push(name);
}
const undefNoFallback = [...new Set(noFallback)];
check(undefNoFallback.length === 0,
  '所有被引用的变量都已定义或带兜底' + (undefNoFallback.length ? '（缺：' + undefNoFallback.join(' ') + '）' : ''));
/* 运行时变量必须带兜底，否则 JS 没跑到时整条声明失效 */
check(/var\(--enter-delay\s*,\s*0ms\)/.test(CSS), '--enter-delay 由 JS 运行时注入，CSS 侧带 0ms 兜底');

/* ── ② 重复定义的变量 ─────────────────────────────────── */
section('② 重复定义的变量（后者覆盖前者，前者白写）');
const counts = {};
defs.forEach((d) => { counts[d.name] = (counts[d.name] || 0) + 1; });
const dup = Object.keys(counts).filter((k) => counts[k] > 1);
check(dup.length === 0, '没有重复定义的变量' + (dup.length ? '（重复：' + dup.map((k) => k + '×' + counts[k]).join(' ') + '）' : ''));

/* ── ③ 禁用色（紫 / 粉）──────────────────────────────── */
section('③ 禁用色：紫色与粉色不得进入令牌体系');
/* 视觉规范 §1.4：紫色仅保留 .tag-demo 一处（演示班的语义实色）；
   粉色与小程序端已废弃的 #F472B6 同色域，一律禁用。 */
const VIOLET = ['#8B5CF6', '#7C5CFF', '#6B3FD4', '#A78BFA', '#9F7AEA'];
const PINK = ['#F471A0', '#F472B6', '#EC4899', '#DB2777'];
const tokenViolet = defs.filter((d) => VIOLET.some((v) => d.value.toUpperCase().includes(v.toUpperCase())));
const tokenPink = defs.filter((d) => PINK.some((v) => d.value.toUpperCase().includes(v.toUpperCase())));
check(tokenPink.length === 0, '令牌体系里没有粉色' + (tokenPink.length ? '（' + tokenPink.map((d) => d.name).join(' ') + '）' : ''));
check(tokenViolet.length === 0, '令牌体系里没有紫色' + (tokenViolet.length ? '（' + tokenViolet.map((d) => d.name).join(' ') + '）' : ''));

/* ── ④ 对比度（WCAG AA）───────────────────────────────── */
section('④ 彩色文字对比度 ≥ 4.5:1（WCAG AA）');

function hex2rgb(h) {
  h = h.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lum(rgb) {
  const a = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
}
function ratio(fg, bg) {
  const l1 = lum(fg), l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** 从令牌值里解析出颜色（支持 #hex 与 var(--x) 引用） */
function resolveColor(v, depth) {
  depth = depth || 0;
  if (!v || depth > 4) return null;
  if (/^#[0-9a-fA-F]{3,6}$/.test(v)) return hex2rgb(v);
  const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(v);
  if (ref) {
    const d = defs.find((x) => x.name === ref[1]);
    return d ? resolveColor(d.value, depth + 1) : null;
  }
  return null;
}
/** 扫描器专用：把任意声明值解析成颜色。
 *  ⚠️ resolveColor 只认「纯 var(--x)」，而扫描到的值常是
 *     `linear-gradient(...)` / `var(--x)` 带兜底等形态 ⇒ 需要更宽松的取值：
 *     ① 纯 hex → 直接用；② 纯 var(--x) → 查令牌；③ 复合值里含 var(--x) → 取该令牌。
 *  第一版扫描命中 0 处，就是因为这里只处理了 ①② 而实际值形态更杂。 */
function scanColor(v, depth) {
  depth = depth || 0;
  if (!v || depth > 4) return null;
  const hexM = /#[0-9a-fA-F]{3,6}/.exec(v);
  if (hexM && /^\s*#/.test(v)) return hex2rgb(hexM[0]);
  const varM = /var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/.exec(v);
  if (varM) {
    const d = defs.find((x) => x.name === varM[1]);
    return d ? scanColor(d.value, depth + 1) : null;
  }
  return null;
}

/* ── 饱和色档：图形色（基础档）与文字色（ink 档）的分工 ──────────────
   规则来源：设计规范 §2.5
     · --brand / --ok / --warn / --err / --chart-1..5 = **图形色**，饱和
       ⇒ 当**文字色**用时不达 AA，正文必须改用对应的 *-ink 档
     · --*-ink = **文字色**档（保证可读）
   ⚠️ 必须定义在 scanContrast **之前**（const 不会提升，提前引用会 TDZ 报错）。 */
const SAT_BASE_TOKENS = ['--brand', '--ok', '--warn', '--err'];
/** 前景色的**字面形态**是否就是某个饱和色档（只认纯 var(--x)） */
function satBaseAsText(colorVal) {
  if (!colorVal) return null;
  const m = /^\s*var\(\s*(--[a-z0-9-]+)\s*\)\s*$/i.exec(colorVal);
  if (!m) return null;
  const t = m[1];
  if (SAT_BASE_TOKENS.indexOf(t) >= 0) return t;
  if (/^--chart-[1-5]$/.test(t)) return t;   /* 图表序列色同样是饱和色 */
  return null;
}
/** 饱和色档 → 应改用的文字色档（用于报错提示） */

/* 已知的前景/背景搭配（前景色令牌 → 背景色令牌），来自设计规范 §2.5 */
const PAIRS = [
  ['--ok-ink', '--ok-soft'],
  ['--warn-ink', '--warn-soft'],
  ['--err-ink', '--err-soft'],
  ['--brand-ink', '--brand-soft'],
  ['--text-2', '--sunken'],
  ['--text-3', '--surface'],
  ['--text-2', '--surface'],
  ['--text-3', '--sunken'],
  ['--side-text-2', '--surface'],
  ['--demo-ink', '--demo-bg'],
  ['--chart-5', '--surface'],
];
PAIRS.forEach(([fgName, bgName]) => {
  const fgD = defs.find((d) => d.name === fgName);
  const bgD = defs.find((d) => d.name === bgName);
  if (!fgD || !bgD) {
    check(false, fgName + ' / ' + bgName + '：令牌缺失（无法校验）');
    return;
  }
  const fg = resolveColor(fgD.value);
  const bg = resolveColor(bgD.value);
  if (!fg || !bg) {
    check(false, fgName + ' / ' + bgName + '：颜色无法解析（' + fgD.value + ' / ' + bgD.value + '）');
    return;
  }
  const r = ratio(fg, bg);
  check(r >= 4.5, fgName + ' on ' + bgName + ' = ' + r.toFixed(2) + ':1' + (r < 4.5 ? '  ✗ 低于 AA 4.5' : ''));
});

/* ── ⑤ 动效性能纪律 ───────────────────────────────────── */
section('⑤ 动效纪律（门禁同款禁止项，防回归）');
check(!/transition\s*:\s*all/.test(CSS), '没有 transition: all');
check(!/scale\(0\)/.test(CSS), '没有 scale(0)');
check(!/transition\s*:[^;]*\bease-in(?!-)/.test(CSS), '没有 ease-in 入场曲线');
/* 无限循环动画只允许 spinner 类 */
const infinite = [...CSS.matchAll(/animation:\s*([^;]*infinite[^;]*)/g)].map((m) => m[1].trim());
const badInf = infinite.filter((a) => !/boot-spin/.test(a));
check(badInf.length === 0, '无限循环动画只有 spinner' + (badInf.length ? '（异常：' + badInf.join(' | ') + '）' : ''));
/* reduced-motion 段必须覆盖 spinner */
const rmBlock = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS);
check(!!rmBlock, '存在 prefers-reduced-motion 降级段');
if (rmBlock) {
  check(/\.boot-spinner[^}]*animation:\s*none/.test(rmBlock[1]), '降级段覆盖 .boot-spinner（无限旋转）');
  check(/\.loading::before[^}]*animation:\s*none/.test(rmBlock[1]), '降级段覆盖 .loading::before（页内旋转环）');
  check(/\.ua-mobile \.side[^}]*transition:\s*none/.test(rmBlock[1]), '降级段覆盖 .ua-mobile .side（抽屉滑动）');
}

/* ── ⑥ 圆角收敛度（老气的一级来源）───────────────────────
   原 admin.css 圆角有 12 档（6/4/14/5/10/8px 混用）⇒ 视觉上没有秩序感。
   焕新后应收敛到少数几档（--r-sm/--r-md/--r-lg/--r-xl/--r-full）。
   判据：写死的 px 圆角 ≤ 3 种（少量特例如 50% 药丸 / 2px 指示条不算）。 */
section('⑥ 圆角收敛度（写死 px 圆角 ≤ 3 种）');
const pxRadii = {};
[...CSS.matchAll(/border-radius:\s*([^;]+)/g)].forEach((m) => {
  const v = m[1].trim();
  const pm = /^(\d+)px/.exec(v);
  if (pm) {
    const n = pm[1] + 'px';
    pxRadii[n] = (pxRadii[n] || 0) + 1;
  }
});
const pxList = Object.keys(pxRadii).sort();
check(pxList.length <= 3,
  '写死 px 圆角只有 ' + pxList.length + ' 种（' + (pxList.join(', ') || '无') + '）'
  + (pxList.length > 3 ? ' ⇒ 应收敛到 --r-* 令牌' : ''));

/* ── ⑦ 饱和底 + 白字扫描（设计师实测发现的高频坑）─────────
   危险/品牌按钮用主色档（--err #E5484D / --brand #3370FF）配白字，
   对比度只有 3.91 / 4.28，**低于 AA 4.5**。
   实心按钮底必须用 ink 档（--err-ink / --brand-strong）。

   🔴🔴 第三类漏网（体验设计师实测发现，比前两类更隐蔽）：
     **修饰类继承基础类的白字** —— 两个类名在**不同规则块**里：
       .cmp-tag   { color: #fff; font-size: 10px; }   ← 基础类给颜色
       .cmp-tag-a { background: var(--chart-1); }    ← 修饰类只给底色
     ⇒ 只扫「同一规则块内同时有 bg 和 color」会**完全扫不到**。
     必须做**跨规则解析**：修饰类 (.cmp-tag-a) → 借基础类 (.cmp-tag) 的 color。
   ⚠️ 第一版扫描正则写成 /([.#][\w-]+...)\{/ 只吃到了选择器的**最后一段**，
      且要求 body 里同时出现 background 与 color ⇒ 扫出 0 处（形同虚设）。
      现在改成：① 收集**所有**规则的选择器与声明；② 逐个选择器解析
      「自己的 background」+「自己的 color，否则继承同前缀基础类的 color」。 */
section('⑦ 饱和底 + 白字扫描（实心按钮底必须用 ink 档）');

/* 收集所有规则：选择器数组 → 声明体
   ⚠️ 两处必须剥注释（体验设计师第六轮实测：剥之前扫出 30 处、剥之后 9 处）：
     ① **选择器**里混着注释（本文件注释常紧贴选择器）；
     ② **声明体**里也混着注释（background 后面跟一段说明文字），
        不剥会把注释里提到的 hex 当成真声明 ⇒ 误判。
   ⚠️⚠️ 写这段注释时踩过坑：**注释里绝不能再出现成对的注释起止符**，
      否则会提前闭合外层注释块 ⇒ 整段代码变成"语法错误"且报错位置极难定位
      （本轮就为这个排查了十几分钟）。 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}
const rules = [];
const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
let rm;
while ((rm = ruleRe.exec(CSS))) {
  const sels = stripComments(rm[1]).split(',').map((x) => x.trim()).filter(Boolean);
  const body = stripComments(rm[2]);
  rules.push({ sels: sels, body: body });
}
function declOf(body, prop) {
  /* ⚠️ 不要用「前面必须是 ^ 或分号或花括号」这种正则来定位属性：
     声明体里属性之间只有**换行 + 缩进**，没有分号分隔
     （CSS 允许省略最后一条声明的分号），前导空白虽在空白类里，
     但当属性前面是花括号或注释残片时仍会漏。
     这里改成：先把声明体按分号 / 换行拆成「一条条声明」，逐条找；
     **后写的覆盖先写的**（CSS 层叠语义）⇒ 命中即返回。 */
  const decls = body.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  let found = null;
  for (let i = 0; i < decls.length; i++) {
    /* ⚠️ 属性名必须**精确匹配**（2026-11-16 第十轮实测修）：
     *   旧实现用「冒号前的 head 匹配 /^[-a-z]+$/」判断"这条声明的属性是不是我要的"，
     *   但 `border-color:` 的 head 是 "border-"，**同样能匹配 ^[-a-z]+$**（连字符在字符类里）
     *   ⇒ `declOf(body,'color')` 会把 **border-color 的值当成前景色**返回！
     *   实测：旧实现下 declOf('border-color: var(--brand)','color') 返回 'var(--brand)'（应为 null）；
     *   `border-top-color:` / `background-color:` 同样串味。
     *   ⇒ 正确做法：从声明开头解析出**真正的属性名**，与 prop **严格相等**才算命中。 */
    const pm = /^\s*([-\w]+)\s*:/.exec(decls[i]);
    if (!pm || pm[1] !== prop) continue;
    found = decls[i].slice(pm[0].length).trim();
  }
  return found;
}
/** 取某选择器的**全部**声明体并合并（倒序，后写的覆盖前面的）。
 *  ⚠️ 不能只取最后一条：同一个选择器可能出现在多处
 *     （如 `.toast` 既在主规则里、又出现在 reduced-motion 段里），
 *     只取最后一条会拿到「只有 animation:none 没有 color/background」的那条
 *     ⇒ 前景色/背景色双双解析为 null，扫描命中 0 处（第一版就是这么废的）。 */
function bodyOf(sel) {
  const parts = [];
  for (let i = rules.length - 1; i >= 0; i--) {
    if (rules[i].sels.indexOf(sel) >= 0) parts.unshift(rules[i].body);
  }
  return parts.length ? parts.join(';\n') : null;
}
/** 解析某选择器的有效前景色：自己的 color，否则借基础类（.cmp-tag-a → .cmp-tag） */
function fgOf(sel) {
  let b = bodyOf(sel);
  if (!b) return null;
  let c = declOf(b, 'color');
  if (c) return c;
  // 跨规则继承：修饰类去掉末尾的 -a/-b 等后缀，找基础类
  const base = sel.replace(/-[a-z0-9]+$/, '');
  if (base !== sel) {
    const bb = bodyOf(base);
    if (bb) c = declOf(bb, 'color');
  }
  return c;
}
function bgOf(sel) {
  const b = bodyOf(sel);
  if (!b) return null;
  return declOf(b, 'background') || declOf(b, 'background-color');
}
/* ⚠️ 统一走 scanContrast() —— 与 ⑨ 变异自证**同一个实现**。
   之前这里是一份**独立的**「外层扫描器」，导致：
     · 变异自证测的是内层、活门禁跑的是外层 ⇒ **两套实现、两套结论**
       （内层修了 rgba 合成 / 渐变多端点 / 伪类，外层没修 ⇒ 活门禁照样漏判）
     · 外层的前景判白是**字符串匹配 #fff** ⇒ `var(--text-on-brand)`（也是白）被漏掉
   ⇒ 现在**只有一份实现**，改一处两处同时生效。 */
const whiteRes = scanContrast(CSS, 'white');
check(whiteRes.scanned > 0,
  '扫描器实际命中了 ' + whiteRes.scanned + ' 处「饱和底 + 白字」组合（>0 才说明扫描器有效）');
check(whiteRes.bad.length === 0,
  '实心底白字组合均达 AA 4.5:1'
  + (whiteRes.bad.length ? ' ⇒ 不达标：' + whiteRes.detail.join('、') : ''));

/* ── ⑦b 饱和【主色档】当【文字色】用 ⇒ 判红 ──────────────────
   根因（2026-11-16 第十轮变异实测发现）：
     原 §⑦ 的前景白名单只含 #fff/#ffffff
     ⇒ **所有非白色前景被整体排除** ——
     而「饱和主色当文字色」恰恰是本次真实发生 **8 处**的违规类型
     （.dry-warn 2.63 / .login-err 3.43 / .metric-delta.* 3.37~3.91 / .seg-btn.active 3.81 …），
     在旧门禁眼里**全是全绿** ⇒ 这是**假绿**，比没门禁更危险。
   规则来源：设计规范 §2.5「基础色（--brand/--ok/--warn/--err）是图形色，
     文字色只能用 *-ink 档」。
   ⚠️ **必须同时实时解析字号**（正文 4.5:1 / 大字 3:1）：
     阈值不能写死成结论 ——「.fee-sum-bal 28px/700 达大字阈值」写死后，
     字号一改成 22px/600 就**悄悄过期**且没有任何门禁报红（真实发生过）。 */
section('⑦b 饱和主色档（--brand/--ok/--warn/--err）当文字色用 ⇒ 必须达 WCAG 阈值');
/** 字号/字重 ⇒ 是否 WCAG 大字（≥24px，或 ≥18.66px 且粗体 ≥700）⇒ 阈值 3 还是 4.5。
 *  字号可能定义在**基础类**上（如 .fee-sum-bal 的字号在 .fee-sum-v）⇒ 沿修饰类→基础类回退。 */
function typeNeedOf(sel) {
  let px = 0, bold = false;
  const read = (body) => {
    if (!body) return;
    if (!px) { const fsv = declOf(body, 'font-size'); if (fsv) { const pm = /^([\d.]+)px/.exec(fsv); if (pm) px = parseFloat(pm[1]); } }
    if (!bold) { const fwv = declOf(body, 'font-weight'); if (fwv) bold = (parseInt(fwv, 10) >= 700 || fwv === 'bold'); }
  };
  read(bodyOf(sel));
  if (!px || !bold) {
    const base = sel.replace(/-[a-z0-9]+$/, '');
    if (base !== sel) read(bodyOf(base));
  }
  return { px: px, bold: bold, need: (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5 };
}
/* 「饱和主色档当文字色」的违规判定 —— **两个条件取或**，缺一不可：
 *   (a) **映射式**：令牌在 SAT_FORBIDDEN_AS_TEXT 里 ⇒ 判红。
 *       ✅ 不需要解析背景 ⇒ 不会因「背景解析不出来」而**静默漏报**
 *          （背景解析有三处已知弱点：父级继承 T7 / 半透明合成 T8 / 渐变端点 T9）。
 *   (b) **比率式**：背景能解析且实算不达 WCAG 阈值 ⇒ 判红。
 *       ✅ 能覆盖**映射表之外**的饱和色（将来新增令牌时自动兜住）。
 *   两者都受**大字豁免**约束（≥24px，或 ≥18.66px 且粗体 ≥700 ⇒ 阈值降到 3:1）。
 *   ⚠️ 字号**必须实时解析** ——「.fee-sum-bal 28px/700 达大字阈值」写死成结论后，
 *      字号一改成 22px/600 就悄悄过期且无人报错（真实发生过）。 */
const SAT_FORBIDDEN_AS_TEXT = {
  '--brand': '--brand-ink', '--ok': '--ok-ink', '--warn': '--warn-ink', '--err': '--err-ink',
  '--chart-1': '--brand-ink', '--chart-2': '--chart-2', '--chart-3': '--chart-3',
  '--chart-4': '--chart-4', '--chart-5': '--chart-5'
};
const satRes = scanContrast(CSS, 'saturated');
check(satRes.bad.length === 0,
  '正文文字未使用饱和主色档（当前命中 ' + satRes.scanned + ' 处）'
  + (satRes.bad.length ? ' ⇒ 违规：' + satRes.detail.join('、') : '')
  + '　⚠️ 扫描器有效性由 ⑨ 的变异自证保证（活 CSS 里 0 处违规与「扫描器没在工作」在输出上无法区分）');

/* ── ⑦c 通用形态：**任何**文字色 vs 它的背景都要达 WCAG 阈值 ──
   §⑦ 只看「白字 + 饱和底」、§⑦b 只看「主色档当文字色」——
   这两类都太窄：像 `.nav-item:hover { color: var(--brand-strong); background: var(--side-hover) }`
   这种「非白、非主色档」的组合两段都漏。
   ⇒ 补一条通用扫描（**实算比率**，不依赖令牌映射），把「文字 vs 背景」整体兜住。 */
const anyRes = scanContrast(CSS, 'any');
check(anyRes.bad.length === 0,
  '所有「文字色 vs 背景」组合均达 WCAG 阈值（正文 4.5:1 / 大字 3:1；当前命中 ' + anyRes.scanned + ' 处）'
  + (anyRes.bad.length ? ' ⇒ 不达标：' + anyRes.detail.join('、') : ''));

/* ── ⑧-2 infinite 动画降级 ───────────────────────────────── */
const rmBlock2 = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(CSS);
const infSelectors = [...new Set([...CSS.matchAll(/([.#][A-Za-z0-9_\-:]*[^{}]*)\{[^}]*animation:[^;]*infinite/g)]
  .map((m) => m[1].trim().split(/[\s,>+~]/).pop()))];
const notCovered = infSelectors.filter((sel) => {
  if (!rmBlock2) return true;
  // 降级段里必须有该选择器 + animation:none
  const safe = sel.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
  const re = new RegExp(safe + '[^}]*animation:\\s*none');
  return !re.test(rmBlock2[1]);
});
check(notCovered.length === 0,
  '全部 infinite 动画都有 reduced-motion 降级（共 ' + infSelectors.length + ' 个）'
  + (notCovered.length ? ' ⇒ 未覆盖：' + notCovered.join(', ') : ''));

/* ── ⑨ 变异自证（把 CSS 改坏 → 判据必须翻红）──────────────
   为什么必须有：这套判据全是**自研解析**（跨规则继承 + 颜色合成），
   一旦解析器本身有 bug，最典型的表现就是「永远绿」——
   即：CSS 真有问题但判据扫不出来，等于门禁形同虚设。
   ⇒ 至少要证明「判据确实会红」：改几处已知问题，判据必须抓到。 */
section('⑨ 变异自证（解析器必须会红，不能永远绿）');

/** 扫描器（抽成可复用的纯函数，变异自证要用 ⇒ 绝不能改全局 CSS 变量）
 *  ⚠️ 前景「谓词」由调用方给：
 *     · §⑦  → 前景是白色（饱和底 + 白字）
 *     · §⑦b → 前景是饱和主色档（主色当文字色）
 *  ⚠️ 阈值**实时解析字号/字重**（正文 4.5 / 大字 3）——
 *     写死 4.5 会把大字误判；把「大字已达标」写成结论则会在字号变化后悄悄过期。 */
function scanContrast(cssText, fgKind) {
  const rules2 = [];
  const re2 = /([^{}]+)\{([^{}]*)\}/g;
  let m2;
  while ((m2 = re2.exec(cssText))) {
    const sels = stripComments(m2[1]).split(',').map((x) => x.trim()).filter(Boolean);
    rules2.push({ sels: sels, body: stripComments(m2[2]) });
  }
  function declOf2(body, prop) {
    const decls = body.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
    let found = null;
    for (let i = 0; i < decls.length; i++) {
      /* ⚠️ 属性名**精确匹配**：`border-color:` 的 head 是 "border-"，
       *   同样能匹配 /^[-a-z]+$/ ⇒ 旧写法会把 **border-color 的值当成 color** 返回。
       *   真实后果：`.field input:focus { border-color: var(--brand) }`
       *   被当成「前景 = var(--brand)」⇒ 4.28:1 ⇒ **假警报**（门禁永远红）。
       *   与外层 declOf 同一个坑，两处都要修。 */
      const pm = /^\s*([-\w]+)\s*:/.exec(decls[i]);
      if (!pm || pm[1] !== prop) continue;
      found = decls[i].slice(pm[0].length).trim();
    }
    return found;
  }
  function bodyOf2(sel) {
    const parts = [];
    for (let i = rules2.length - 1; i >= 0; i--) {
      if (rules2[i].sels.indexOf(sel) >= 0) parts.unshift(rules2[i].body);
    }
    return parts.length ? parts.join(';\n') : null;
  }
  /** 去掉伪类/伪元素，得到"这条规则真正作用的元素"：
   *  .nav-item:hover:not(.active) ⇒ .nav-item  ⇒ 才能找到它的 font-size */
  function stripPseudo(sel) {
    return sel.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').trim();
  }
  function fgOf2(sel) {
    const b = bodyOf2(sel);
    if (b) {
      const c = declOf2(b, 'color');
      if (c) return c;
    }
    /* 回退链：去伪类 ⇒ 去修饰后缀（.cmp-tag-a ⇒ .cmp-tag）*/
    const cands = [];
    const sp = stripPseudo(sel);
    if (sp && sp !== sel) cands.push(sp);
    const base = sel.replace(/-[a-z0-9]+$/, '');
    if (base !== sel) cands.push(base);
    const spBase = stripPseudo(base);
    if (spBase && spBase !== base) cands.push(spBase);
    for (const cs of cands) {
      const bb = bodyOf2(cs);
      if (bb) {
        const c = declOf2(bb, 'color');
        if (c) return c;
      }
    }
    return null;
  }
  function bgOf2(sel) {
    const b = bodyOf2(sel);
    if (!b) return null;
    return declOf2(b, 'background') || declOf2(b, 'background-color');
  }
  /* 令牌表也从 cssText 里现取 ⇒ 变异若改了 :root 的值，判定会跟着变 */
  const defs2 = [];
  const rootM2 = /:root\s*\{([\s\S]*?)\n\}/.exec(cssText);
  if (rootM2) {
    const dre = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let dm;
    while ((dm = dre.exec(rootM2[1]))) defs2.push({ name: dm[1], value: dm[2].trim() });
  }
  function scanColor2(v, depth) {
    depth = depth || 0;
    if (!v || depth > 4) return null;
    const hexM = /#[0-9a-fA-F]{3,6}/.exec(v);
    if (hexM && /^\s*#/.test(v)) return hex2rgb(hexM[0]);
    /* ⚠️ rgba 带 alpha：**必须合成**，不能当不透明色。
     *   真实反例：--side-hover = rgba(51,112,255,.07)（侧栏上的 7% 蓝）
     *   · 当不透明算 ⇒ --brand-strong 文字落在 #3370FF 上 = 1.26 ❌（假警报）
     *   · 合成到白底  ⇒ 落在近白上 ≈ 5.09 ✅（真值）
     *   · alpha 改成 1 ⇒ 合成结果变化 ⇒ 应当被抓出来（见 harness A6） */
    const rgbM = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/i.exec(v);
    if (rgbM) {
      const c = [+rgbM[1], +rgbM[2], +rgbM[3]];
      const a = rgbM[4] === undefined ? 1 : Math.min(1, Math.max(0, +rgbM[4]));
      if (a >= 1) return c;
      return c.map((x) => Math.round(x * a + 255 * (1 - a)));   /* 合成到白底 */
    }
    const varM = /var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)/.exec(v);
    if (varM) {
      const d = defs2.find((x) => x.name === varM[1]);
      return d ? scanColor2(d.value, depth + 1) : null;
    }
    return null;
  }
  /** 背景的**全部候选色**：
   *   · 渐变 ⇒ 逐个 stop 取色（取最差的那个判定）—— 见 harness A7
   *   · 普通值 ⇒ 单个候选
   *   ⚠️ 渐变只取第一个 stop 会漏判：.btn-primary 的白字在某个 stop 上不达标却看不出来。 */
  function bgCandidates2(bgV) {
    const out = [];
    if (/gradient\(/i.test(bgV)) {
      const re = /#[0-9a-fA-F]{3,8}|var\(\s*(--[a-z0-9-]+)\s*\)|rgba?\([^)]*\)/g;
      let m;
      while ((m = re.exec(bgV))) {
        const c = scanColor2(m[0]);
        if (c) out.push(c);
      }
    } else {
      const c = scanColor2(bgV);
      if (c) out.push(c);
    }
    return out;
  }
  /** 字号/字重 ⇒ WCAG 大字 ⇒ 阈值 3 还是 4.5（实时解析，含基础类回退） */
  function need2(sel) {
    let px = 0, bold = false;
    const read = (body) => {
      if (!body) return;
      if (!px) { const fsv = declOf2(body, 'font-size'); if (fsv) { const pm = /^([\d.]+)px/.exec(fsv); if (pm) px = parseFloat(pm[1]); } }
      if (!bold) { const fwv = declOf2(body, 'font-weight'); if (fwv) bold = (parseInt(fwv, 10) >= 700 || fwv === 'bold'); }
    };
    const cands = [sel, stripPseudo(sel)];
    const base = sel.replace(/-[a-z0-9]+$/, '');
    if (base !== sel) { cands.push(base); cands.push(stripPseudo(base)); }
    for (const cs of cands) {
      read(bodyOf2(cs));
      if (px && bold) break;
    }
    return (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
  }
  /* ⚠️ `bad` 里**只能放纯选择器名**：变异自证用 `bad.indexOf(sel)` 做**精确元素匹配**，
   *   一旦把说明文字拼进元素里，indexOf 永远返回 -1 ⇒ 断言变成假绿。
   *   说明文字另放 `detail`。 */
  const bad = [];
  const detail = [];
  let n = 0;
  rules2.forEach((r) => {
    r.sels.forEach((sel) => {
      if (sel.indexOf('@') >= 0) return;
      if (/::(before|after)/.test(sel)) return;    /* 伪元素不是文本 */
      const fgV = fgOf2(sel);
      if (!fgV) return;
      const fgR = scanColor2(fgV);
      if (!fgR) return;
      /* ⚠️ 「是不是白」必须**解析后**判断，不能字符串匹配 #fff：
       *   `color: var(--text-on-brand)` 就是白色，但字符串里没有 '#fff'
       *   ⇒ 旧写法漏判（.cmp-tag / .cmp-tag-a / .cmp-tag-b 全都漏）—— 见 harness A8。 */
      const isWhite = fgR[0] === 255 && fgR[1] === 255 && fgR[2] === 255;
      if (fgKind === 'white' && !isWhite) return;
      const satTok = fgKind === 'saturated' ? satBaseAsText(fgV) : null;
      if (fgKind === 'saturated' && !satTok) return;
      const need = need2(sel);
      const isLarge = need === 3;      /* 大字豁免：阈值降到 3:1 */
      /* (a) **映射式**：饱和色档当文字色 ⇒ 直接判红。
       *     ✅ **不需要解析背景** ⇒ 不会因「背景继承/半透明/渐变解析不出来」而静默漏报。
       *        （harness A1/A5 的根因就是背景解析不出来 ⇒ 被跳过 ⇒ 漏判） */
      if (satTok && SAT_FORBIDDEN_AS_TEXT.hasOwnProperty(satTok) && !isLarge) {
        n++;
        bad.push(sel);
        detail.push(sel + '（用 ' + satTok + '，应改 ' + SAT_FORBIDDEN_AS_TEXT[satTok]
          + '；字号 ' + need2(sel).px + 'px）');
        return;
      }
      /* (b) **比率式**：背景能解析时实算，覆盖映射表之外的组合 */
      const bgV = bgOf2(sel);
      if (!bgV) return;
      const bgs = bgCandidates2(bgV);
      if (!bgs.length) return;
      n++;
      for (let i = 0; i < bgs.length; i++) {
        const rr = ratio(fgR, bgs[i]);
        if (rr < need) {
          bad.push(sel);
          detail.push(sel + '（' + rr.toFixed(2) + ':1，需 ' + need + '，底 ' + bgV + '）');
          break;
        }
      }
    });
  });
  return { bad: bad, detail: detail, scanned: n };
}
/** §⑦ 用：饱和底 + 白字 */
function scanWhiteOnSaturated(cssText) {
  return scanContrast(cssText, 'white');
}
/** §⑦b 用：饱和主色档当文字色 */
function scanSatAsText(cssText) {
  return scanContrast(cssText, 'saturated');
}
/** §⑦c 用：**任何**文字色 vs 它的背景（关系断言的通用形态） */
function scanAnyTextOnBg(cssText) {
  return scanContrast(cssText, 'any');
}

/* 9.1 把 .toast-err 的底色从 ink 档改回主色档 → 应被判不达标 */
const mutToast = CSS.replace('.toast-err { background: var(--err-ink); }',
  '.toast-err { background: var(--err); }');
const rToast = scanWhiteOnSaturated(mutToast);
check(mutToast !== CSS && rToast.bad.indexOf('.toast-err') >= 0,
  '变异被抓：.toast-err 底色改回主色档 → 对比度判据翻红'
  + (mutToast === CSS ? '（⚠️ 变异没生效：源码里找不到待变异的那一行）' : ''));

/* 9.2 跨规则继承自证（修饰类只给底色、字色在基础类里）——
   .cmp-tag 给字色（var(--text-on-brand) = 白）、.cmp-tag-a 给底色（--series-a）。
   把基础类的字色改成深色 ⇒ 修饰类继承后不再算「白字 + 饱和底」。 */
const mutCmp = CSS.replace(/(\.cmp-tag \{[\s\S]*?)color:\s*var\(--text-on-brand\)/,
  '$1color: var(--text)');
const rCmp = scanWhiteOnSaturated(mutCmp);
check(mutCmp !== CSS && rCmp.bad.indexOf('.cmp-tag-a') === -1,
  '变异被抓：.cmp-tag 基础类字色改深 → 修饰类不再被判「白字 + 饱和底」（跨规则继承生效）'
  + (mutCmp === CSS ? '（⚠️ 变异没生效：源码里找不到 .cmp-tag 的字色声明）' : ''));

/* 9.3 未定义变量检测器自证：注入一个未定义变量 → 应被抓 */
const mutVar = CSS.replace('.boot-text {', '.boot-text { color: var(--__probe_undefined__);');
/* 判据：注入的变量在 :root 里没有定义，且引用处没有兜底值 */
const probeDefined = /--__probe_undefined__\s*:/.test(mutVar);
const probeHasFallback = /var\(\s*--__probe_undefined__\s*,/.test(mutVar);
const probeUndef = probeDefined ? false : true;
check(mutVar !== CSS && probeUndef && !probeHasFallback,
  '变异被抓：注入未定义变量 → 悬空变量检测翻红'
  + (mutVar === CSS ? '（⚠️ 变异没生效）' : ''));

/* 9.4 饱和主色当文字色 ⇒ §⑦b 必须抓到（这是旧门禁漏掉的那一类）*/
function appendDecl(css, selector, decl) {
  const re = new RegExp('(' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{)([^}]*)(\\})');
  const m = re.exec(css);
  if (!m) return null;
  return css.replace(re, (s2, a, body, c) => a + body + '\n  ' + decl + '\n' + c);
}
const mutSat = appendDecl(CSS, '.login-err', 'color: var(--err);');
const rSat = mutSat ? scanSatAsText(mutSat) : { bad: [], detail: [], scanned: 0 };
check(mutSat && rSat.bad.length > 0,
  '变异被抓：饱和主色档当文字色（.login-err color:var(--err)）⇒ §⑦b 翻红'
  + (!mutSat ? '（⚠️ 变异没生效：找不到 .login-err 规则）' : ''));

/* 9.5 大字豁免：字号 24px 时 3:1 合法 ⇒ **必须不报**（证明阈值分档真的生效，
   不是「一律 4.5」也不是「一律放过」）*/
/* 9.5 大字（24px）用主色档 ⇒ 阈值降到 3:1 ⇒ **不判红**（阈值分档生效）
   ⚠️ 选 .metric-delta.up（字色在白底上，--err/--ok 这类主色档在白底上 3.67~3.91 ≥ 3）；
     不能用 .login-err —— 它的底色是 --err-soft（浅粉底），
     主色档在浅粉底上只有 3.43 < 3，连大字都判红 ⇒ 前提不同，结论也不同。 */
const mutLarge = appendDecl(CSS, '.metric-delta.up', 'color: var(--err);\n  font-size: 24px;');
const rLarge = mutLarge ? scanSatAsText(mutLarge) : { bad: [], detail: [], scanned: 0 };
check(mutLarge && rLarge.bad.length === 0,
  '变异被抓：大字（24px）用主色档 ⇒ 阈值降到 3:1 ⇒ **不判红**（阈值分档生效）'
  + (!mutLarge ? '（⚠️ 变异没生效）' : ''));

/* 9.6 字号缩到 12px ⇒ 大字豁免失效 ⇒ 必须重新判红
   （这正是「豁免写死字号会悄悄过期」的实证）*/
const mutSmall = appendDecl(CSS, '.login-err', 'color: var(--err);\n  font-size: 12px;');
const rSmall = mutSmall ? scanSatAsText(mutSmall) : { bad: [], detail: [], scanned: 0 };
check(mutSmall && rSmall.bad.length > 0,
  '变异被抓：字号缩到 12px ⇒ 大字豁免失效 ⇒ §⑦b 重新翻红'
  + (!mutSmall ? '（⚠️ 变异没生效）' : ''));

/* 9.7 declOf 边界：border-color 不得被当成 color 返回
   （旧实现会把 'border-color: var(--brand)' 当成前景色 ⇒ 假警报）*/
check(declOf('border-color: var(--brand)', 'color') === null
  && declOf('border-top-color: var(--brand)', 'color') === null
  && declOf('color: var(--text)', 'color') === 'var(--text)',
  'declOf 边界：border-color / border-top-color 不会被当成 color 返回（属性名精确匹配）');

console.log('\n结果：' + (fail ? '失败 ' + fail + ' / 通过 ' + pass : '全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);
