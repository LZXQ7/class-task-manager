#!/usr/bin/env node
/**
 * 离线自检：**组件 wxss 里禁止出现 `.t-dark` / `.t-light` 选择器**（2026-11-15 立规）
 * --------------------------------------------------------------------------------
 * 为什么要有这条门禁 —— 它是本轮 4 个真 bug 的**同一个根因**：
 *
 *   主题类 `.t-dark` 挂在**页面根节点**（`.page.home.t-dark`），而组件内部的节点
 *   （`.nav-edge` / `.rm-btn` / `.tg-surface` / `.seg` / `.sheet-panel` …）在**自定义组件**里。
 *   小程序自定义组件的 wxss 是**组件作用域**，祖先类跨组件边界**不命中** ——
 *   于是组件里那句 `.t-dark .xxx { … }` 是一段**永真不执行**的死代码，
 *   写它的人以为「深色已经处理了」，实际深色下仍然用浅色值。
 *
 *   本轮实锤的后果：
 *     · `nav-bar` 的 `.t-dark .nav-edge` 不命中 ⇒ 深色状态栏整整一条银白渐变
 *       （0rpx 白 .9 的顶部聚光，正好一个状态栏高）从来没被关掉，用户连报两版；
 *     · `radial-menu` / `tilt-card` / `segmented` / `aura-card` / `bottom-sheet` 各有一条
 *       同样的死规则（深色描边、深色投影、深色背光全都没生效）。
 *
 * 正确写法：**主题令牌**。在 `app.wxss` 的 `.t-light` / `.t-dark` 里各定义一份
 * 自定义属性（如 `--nav-edge-fill` / `--brand-glass` / `--tilt-ring`），
 * 组件里写 `var(--token, <浅色兜底>)`。CSS 自定义属性**会继承进组件**，
 * 主题一换值就生效，完全不需要跨边界的后代选择器。
 *
 * 用法：node scripts/check-theme-token-scope.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMP = path.join(ROOT, 'miniprogram/components');
const APP = path.join(ROOT, 'miniprogram/app.wxss');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/** 去掉 wxss 注释：注释里提到 `.t-dark` 是在解释「为什么不能这么写」，不该判红 */
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }

function walkWxss(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkWxss(p, out);
    else if (e.name.endsWith('.wxss')) out.push(p);
  });
  return out;
}

/** 核心判据（纯函数，变异自证复用）：返回违规列表 [{ file, hit }] */
function scan(files) {
  const bad = [];
  files.forEach((f) => {
    const body = stripComments(fs.readFileSync(f, 'utf8'));
    const re = /\.t-(?:dark|light)\b[^{};]*\{/g;
    const m = body.match(re);
    if (m) bad.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), hit: m.join(' | ') });
  });
  return bad;
}

const FILES = walkWxss(COMP, []);
const BAD = scan(FILES);

console.log('── ① 组件 wxss 不使用主题类选择器（' + FILES.length + ' 个文件）');
if (BAD.length) {
  BAD.forEach((b) => console.log('    · ' + b.file + '  →  ' + b.hit));
} else {
  console.log('    （无违规）');
}
check(BAD.length === 0, '组件里没有 `.t-dark` / `.t-light` 选择器（跨组件边界不命中 ⇒ 死代码）');

console.log('\n── ② 令牌真源存在（app.wxss 的 .t-light / .t-dark 各一份）');
const app = stripComments(fs.readFileSync(APP, 'utf8'));
/** 取某个主题块内的文本（`.t-dark {` 到配对花括号） */
function themeBlock(css, sel) {
  const i = css.indexOf(sel + ' {');
  if (i < 0) return '';
  const s = css.indexOf('{', i);
  let d = 0;
  for (let k = s; k < css.length; k += 1) {
    if (css[k] === '{') d += 1;
    else if (css[k] === '}') { d -= 1; if (!d) return css.slice(s + 1, k); }
  }
  return '';
}
const LIGHT = themeBlock(app, '.t-light');
const DARK = themeBlock(app, '.t-dark');
const TOKENS = ['--nav-edge-fill', '--nav-edge-top', '--nav-edge-bottom', '--nav-line', '--nav-solid',
  '--brand-glass', '--brand-glass-edge', '--brand-glass-shadow', '--tilt-ring', '--float-shadow-color'];
TOKENS.forEach((t) => {
  check(new RegExp('\\' + t + '\\s*:').test(LIGHT), '浅色定义了 ' + t);
  check(new RegExp('\\' + t + '\\s*:').test(DARK), '深色覆盖了 ' + t);
});

console.log('\n── ③ 变异自证（把死规则塞回去 / 令牌缺失，探针必须翻红）');
const MUT = [
  {
    name: 'nav-bar wxss 又写回 `.t-dark .nav-edge`（深色状态栏又露白条）',
    apply: () => [{
      path: path.join(COMP, 'nav-bar/index.wxss'),
      text: '.t-dark .nav-edge { background: none; }\n'
    }]
  },
  {
    name: 'radial-menu wxss 又写回 `.t-dark .rm-btn`（深色按钮又用浅色玻璃）',
    apply: () => [{
      path: path.join(COMP, 'radial-menu/index.wxss'),
      text: '.t-dark .rm-btn { background: #000; }\n'
    }]
  },
  {
    name: '注释里提到 .t-dark 不算违规（防止用「删注释」绕过）',
    apply: () => [{
      path: path.join(COMP, 'tilt-card/index.wxss'),
      text: '/* 说明：不要写 .t-dark .tg-surface { … } */\n'
    }],
    expect: 'clean'
  }
];

MUT.forEach((mu) => {
  const additions = mu.apply();
  // 用内存里的假文件跑同一份 scan：不落盘、零副作用
  const fake = FILES.map((f) => {
    const add = additions.find((a) => a.path === f);
    const text = add ? fs.readFileSync(f, 'utf8') + '\n' + add.text : fs.readFileSync(f, 'utf8');
    return { path: f, text };
  });
  // scan 读磁盘，这里复刻一遍：直接对 fake 文本跑同一条正则
  const bad = fake.filter((f) => /\.t-(?:dark|light)\b[^{};]*\{/.test(stripComments(f.text)));
  if (mu.expect === 'clean') {
    check(bad.length === 0, '变异不被误判：' + mu.name);
  } else {
    check(bad.length > 0, '变异被抓：' + mu.name);
  }
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 主题令牌作用域检查全部通过'));
process.exit(failed ? 1 : 0);
