#!/usr/bin/env node
/**
 * 门禁：「我的」页赞赏组件 <reward /> 的视觉 / 唯一性约束（2026-11-12）
 * ------------------------------------------------------------
 * 起因（用户真机实拍反馈「为什么有个白底」）：
 *   `<reward theme="white" />` 会让组件按官方文档画 **#FFFFFF 纯白实底卡片**，
 *   而「我的」页是淡蓝紫玻璃卡片背景 —— 页尾出现一块边界生硬的白矩形。
 *   theme="transparent"（默认）才是「无背景」，组件自绘内容直接落在页面底色上。
 *
 * 同时钉住官方硬限制：**同一个小程序只允许一个页面放 <reward />**，
 * 多放时只有第一个展示的页面渲染、其他页静默不展示（排查成本极高）。
 *
 * 判据可注入变异体（judge()），带双向自证，防止「拿好样本当坏样本」的假通过。
 * 用法：node scripts/check-reward-theme.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('PASS  ' + m); };
const bad = (m) => { fail++; console.log('FAIL  ' + m); };

const stripWxml = (t) => t.replace(/<!--[\s\S]*?-->/g, '');
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

/** 可注入的判据：输入 wxml / wxss 文本，返回问题列表 */
function judge(wxml, wxss) {
  const problems = [];
  const code = stripWxml(wxml);
  const tags = code.match(/<reward\b[^>]*>/g) || [];
  if (!tags.length) problems.push('找不到 <reward /> 标签');
  const tag = tags[0] || '';

  // 文档：theme=white → 白底 #FFFFFF；light 为 white 的同义写法
  if (/\b(?:white|light)\b/.test(tag)) {
    problems.push('theme 含 white / light → 组件画 #FFFFFF 纯白实底，与页面玻璃背景割裂');
  }
  if (!/wx:if="\{\{rewardSupported\}\}"/.test(code)) {
    problems.push('缺少低版本基础库门控 wx:if="{{rewardSupported}}"');
  }
  const block = (stripCss(wxss).match(/\.mn-reward\s*\{[^}]*\}/) || [''])[0];
  if (/background\s*:/.test(block)) {
    problems.push('.mn-reward 容器不应写死背景色（底色交给组件 theme）');
  }
  return problems;
}

/** 收集所有 wxml（页面 + 组件） */
function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      collect(p, out);
    } else if (e.name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

/* ---------- ① 真实源码 ---------- */
console.log('── ① 全仓库 <reward /> 唯一性 + 页尾视觉约束');
const files = collect(MINI);
const withReward = files.filter((f) => /<reward[\s/>]/.test(stripWxml(fs.readFileSync(f, 'utf8'))));
if (withReward.length === 1) ok('全仓库只有 1 个页面放 <reward />：' + path.relative(ROOT, withReward[0]).replace(/\\/g, '/'));
else bad('应有且仅有 1 个页面放 <reward />，实得 ' + withReward.length + ' 个：' + withReward.map((f) => path.relative(ROOT, f)).join(', '));

const wxmlPath = path.join(MINI, 'pages', 'mine', 'index.wxml');
const wxssPath = path.join(MINI, 'pages', 'mine', 'index.wxss');
const problems = judge(fs.readFileSync(wxmlPath, 'utf8'), fs.readFileSync(wxssPath, 'utf8'));
if (!problems.length) ok('页尾赞赏组件约束全部满足（无纯白实底 / 有低版本门控 / 容器不写死背景）');
else problems.forEach((p) => bad('① ' + p));

/* ---------- ② 双向自证 ---------- */
console.log('\n── ② 双向自证（判据必须能抓坏样本、不误伤好样本）');
const goodCss = '.mn-reward { margin: 40rpx 32rpx 0; }';
const good = '<view wx:if="{{rewardSupported}}" class="mn-reward"><reward theme="transparent" /></view>';
const cases = [
  ['坏样本：theme="white" 必须被抓', judge(good.replace('transparent', 'white'), goodCss).some((x) => /纯白实底/.test(x))],
  ['坏样本：动态 theme 的 light 分支必须被抓', judge(good.replace('transparent', "{{x ? 'dark' : 'light'}}"), goodCss).some((x) => /纯白实底/.test(x))],
  ['好样本：theme="transparent" 不得误报', judge(good, goodCss).length === 0],
  ['坏样本：删掉 wx:if 门控必须被抓', judge(good.replace(' wx:if="{{rewardSupported}}"', ''), goodCss).length > 0],
  ['坏样本：容器写死 background 必须被抓', judge(good, '.mn-reward { background: #FFFFFF; }').length > 0],
  ['坏样本：完全没有 <reward> 必须被抓', judge('<view class="mn-reward"></view>', goodCss).length > 0]
];
cases.forEach(([label, cond]) => (cond ? ok(label) : bad(label)));

console.log('');
if (fail) { console.error('❌ 失败 ' + fail + ' 项'); process.exit(1); }
console.log('OK · 赞赏组件视觉 / 唯一性校验通过（' + pass + ' 项）');
