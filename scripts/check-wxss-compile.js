#!/usr/bin/env node
/**
 * 离线自检：**用微信官方 WXSS 编译器真编译一遍**
 * ------------------------------------------------------------
 * 为什么必须补这一道 —— 项目已经因此栽过两次，而两次门禁都是全绿的：
 *   ① 2026-09-26 v0.7.17：`app.wxss` 用通用兄弟选择器 `~` 做错峰 → 真机
 *      `unexpected token ~` → **整个 wxss 编译失败、全站样式丢失**；
 *   ② 2026-09-26 v0.7.18：`pages/classes/index.wxss` 被脚本改成
 *      `background: rgba(255,255,255,.55);1F2;`（残留的 hex 尾巴）→ IDE 报
 *      「编译 .wxss 文件错误」，而 `check-wxss`（文本正则）完全看不见。
 * 结论写进 MEMORY 的那句话在这里被强制执行：**门禁只跑文本正则，跑不了 WXSS 编译器**。
 *
 * 编译器来源：微信开发者工具自带的 `wcsc.exe`（官方原版二进制）。
 * 它不在项目里（2.7MB 二进制会拖累每次备份），所以本门禁**按已知路径查找**；
 * 找不到就明确 SKIP 并给出开启方法（退出码仍为 0，避免在没装开发者工具的机器上误报红）。
 *
 * 自证（双向）：故意构造两种「历史上真出过」的坏样本，编译器必须报错；
 * 好样本（我们的真实 wxss）不得误报。
 *
 * 用法：node scripts/check-wxss-compile.js
 *       可用环境变量 WX_WCSC 指定编译器绝对路径
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const TMP = path.join(ROOT, '.workbuddy', 'tmp');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function skip(msg) { console.log('SKIP  ' + msg); }

/* ---------------- 找编译器 ---------------- */
function findWcsc() {
  const cands = [];
  if (process.env.WX_WCSC) cands.push(process.env.WX_WCSC);
  const rel = path.join('resources', 'app.asar.unpacked', 'node_modules', 'wcc-exec', 'wcsc.exe');
  const devtoolDirs = [
    'D:\\Tencent\\微信web开发者工具',
    'C:\\Program Files (x86)\\Tencent\\微信web开发者工具',
    'C:\\Program Files\\Tencent\\微信web开发者工具',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', '微信web开发者工具')
  ];
  devtoolDirs.forEach((d) => cands.push(path.join(d, rel)));
  return cands.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

const WCSC = findWcsc();
if (!WCSC) {
  skip('未找到微信开发者工具自带的 wcsc.exe —— 本门禁跳过（不代表通过）');
  skip('开启方式：安装微信开发者工具，或设置环境变量 WX_WCSC=<wcsc.exe 绝对路径>');
  console.log('\n（若长期跳过：请知悉「WXSS 能不能编译」这一层就没人守了）');
  process.exit(0);
}
console.log('编译器: ' + WCSC + '\n');

/* ---------------- 收集目标 ---------------- */
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f, out); }
    // 防御：忽略自证临时文件（正常不该出现在项目里；万一某次运行被中途打断而残留，
    // 也不要让本门禁对着它报一个和真实代码无关的 FAIL）
    else if (e.name.endsWith('.wxss') && !e.name.startsWith('__')) out.push(f);
  });
  return out;
}

/** 编译单个文件；返回 null 表示通过，否则返回错误文本 */
function compile(file) {
  try {
    execFileSync(WCSC, [file], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30000 });
    return null;
  } catch (e) {
    const err = (e.stderr ? e.stderr.toString() : '') + (e.stdout ? e.stdout.toString() : '');
    return String(err).trim() || ('exit=' + e.status);
  }
}

/* ---------------- ① 真编译项目里每个 wxss ---------------- */
console.log('── ① 用官方编译器编译项目里每个 .wxss');
const files = walk(MINI, []);
let badFiles = 0;
files.forEach((f) => {
  const err = compile(f);
  if (err) {
    badFiles += 1;
    bad(path.relative(ROOT, f).replace(/\\/g, '/'));
    err.split(/\r?\n/).filter(Boolean).slice(0, 6).forEach((l) => console.log('        ' + l));
  }
});
if (!badFiles) ok('全部 ' + files.length + ' 个 wxss 通过官方编译器（真编译，不是文本扫描）');

/* ---------------- ② 自证：两次历史事故的坏样本必须被抓 ---------------- */
console.log('\n── 自证：两种「真出过」的写法必须被判死 + 好样本不误报');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const cases = [
  {
    id: '残留 hex 尾巴（v0.7.18 实际事故）',
    src: '.a {\n  color: #E11D48;\n  background: rgba(255, 255, 255, 0.55);1F2;\n}\n',
    mustFail: true
  },
  {
    id: '孤立 `}`（大括号不配平）',
    src: '.a {\n  color: #FFFFFF;\n}\n}\n',
    mustFail: true
  },
  {
    id: '正常写法（好样本）',
    src: '.a {\n  color: #E11D48;\n  background: rgba(255, 255, 255, 0.55);\n  border-radius: 24rpx;\n}\n',
    mustFail: false
  }
];

cases.forEach((c) => {
  const f = path.join(TMP, '__wcsc_selftest__.wxss');
  fs.writeFileSync(f, c.src);
  const err = compile(f);
  try { fs.unlinkSync(f); } catch (e) {}
  if (c.mustFail) {
    if (err) ok(c.id + ' → 编译器报错（被抓住）');
    else bad(c.id + ' → 编译器居然通过了，本门禁失去意义');
  } else {
    if (!err) ok(c.id + ' → 正常通过（不误报）');
    else bad(c.id + ' → 好样本被误杀：' + err.split(/\r?\n/)[0]);
  }
});

/* ---------------- ③ 边界说明：本门禁**不覆盖** `~` ---------------- */
console.log('\n── ③ 覆盖边界（实测，不是推测）');
{
  const f = path.join(TMP, '__wcsc_selftest__.wxss');
  fs.writeFileSync(f, '.a ~ .b {\n  color: #FFFFFF;\n}\n');
  const err = compile(f);
  try { fs.unlinkSync(f); } catch (e) {}
  if (err) {
    ok('本版 wcsc 也会拒绝 `~` 选择器（那样两门禁有重叠，无妨）');
  } else {
    console.log('NOTE  实测本版 wcsc **接受** `~` 选择器 —— 但真机编译会 fatal');
    console.log('      （v0.7.17 的事故：真机 `unexpected token ~` → 全站样式丢失）。');
    console.log('      所以 `check-wxss` 段③ 的「文本级全量禁 ~」**不可删除** ——');
    console.log('      两个门禁是互补的：这里管「能不能编译过」，那里管「真机跑不跑得动」。');
  }
}

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ WXSS 真编译体检全部通过'));
process.exit(failed ? 1 : 0);
