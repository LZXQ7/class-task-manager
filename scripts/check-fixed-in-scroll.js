/**
 * 静态校验：固定定位的覆盖层组件不得被包进 <spring-scroll>
 * 历史坑（v0.7.19）：
 *   - nav-bar 放进 spring-scroll → .ss-content 的 transform 创建包含块，fixed 定位失效、随滚动位移；
 *   - bottom-sheet / duty-sheet 放进 spring-scroll → 面板本应从底部固定弹出，结果跑到页面上方或随滚动走。
 * 修复方案：这类组件必须作为 spring-scroll 的兄弟节点，放在页面根节点下。
 */
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'miniprogram', 'pages');
const problems = [];

// 已知根节点用 position:fixed 的覆盖层组件；新增固定定位组件时同步加到这里
const BLACKLIST = new Set(['nav-bar', 'bottom-sheet', 'duty-sheet', 'dialog']);
const VOID = new Set(['image', 'input', 'icon', 'open-data', 'web-view', 'canvas']);

function checkPage(wxml) {
  const t = fs.readFileSync(wxml, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const reTag = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let m;
  const stack = [];
  let inSpring = false;
  let springDepth = 0;

  while ((m = reTag.exec(t))) {
    const raw = m[0];
    const tag = m[1];
    const closing = raw.startsWith('</');
    const selfClose = m[3] === '/' || VOID.has(tag);

    if (closing) {
      if (stack.length) stack.pop();
      if (tag === 'spring-scroll' && inSpring) {
        if (--springDepth <= 0) {
          inSpring = false;
          springDepth = 0;
        }
      }
      continue;
    }

    if (!selfClose) {
      stack.push(tag);
      if (tag === 'spring-scroll') {
        if (!inSpring) inSpring = true;
        springDepth++;
      }
      if (inSpring && BLACKLIST.has(tag)) {
        problems.push(`${wxml}: <${tag}> 出现在 <spring-scroll> 内部，会被 .ss-content 的 transform 包含块破坏 fixed 定位`);
      }
    }
  }
}

if (fs.existsSync(R)) {
  fs.readdirSync(R).forEach((n) => {
    const p = path.join(R, n);
    if (!fs.statSync(p).isDirectory()) return;
    const wxml = path.join(p, 'index.wxml');
    if (fs.existsSync(wxml)) checkPage(wxml);
  });
}

/* 双向自证 */
{
  const bad = `
<view class="page">
  <spring-scroll>
    <bottom-sheet show="{{true}}"></bottom-sheet>
  </spring-scroll>
</view>`;
  const good = `
<view class="page">
  <spring-scroll></spring-scroll>
  <bottom-sheet show="{{true}}"></bottom-sheet>
</view>`;

  const badErrs = [];
  const save = problems.slice();
  problems.length = 0;
  checkPage.__selfcheck = checkPage;
  // 不污染全局，直接在临时字符串上跑同样的解析逻辑
  function runOn(src, sink) {
    const t = src.replace(/<!--[\s\S]*?-->/g, '');
    const reTag = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
    const VOID2 = new Set(['image', 'input', 'icon', 'open-data', 'web-view', 'canvas']);
    let m;
    const stack = [];
    let inSpring = false;
    let springDepth = 0;
    while ((m = reTag.exec(t))) {
      const raw = m[0];
      const tag = m[1];
      const closing = raw.startsWith('</');
      const selfClose = m[3] === '/' || VOID2.has(tag);
      if (closing) {
        if (stack.length) stack.pop();
        if (tag === 'spring-scroll' && inSpring) {
          if (--springDepth <= 0) {
            inSpring = false;
            springDepth = 0;
          }
        }
        continue;
      }
      if (!selfClose) {
        stack.push(tag);
        if (tag === 'spring-scroll') {
          if (!inSpring) inSpring = true;
          springDepth++;
        }
        if (inSpring && BLACKLIST.has(tag)) {
          sink.push(`__selfcheck__: <${tag}> 出现在 <spring-scroll> 内部`);
        }
      }
    }
  }

  const badOut = [];
  runOn(bad, badOut);
  if (!badOut.length) problems.push('check-fixed-in-scroll 自证失败：坏样本 <bottom-sheet> 在 spring-scroll 内未被捕获');

  const goodOut = [];
  runOn(good, goodOut);
  if (goodOut.length) problems.push('check-fixed-in-scroll 自证失败：好样本被误报 → ' + goodOut[0]);

  problems.push(...save);
}

if (problems.length) {
  console.error('FAIL · 固定覆盖层组件位置校验未通过');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('OK · 所有固定覆盖层组件均位于 <spring-scroll> 之外（含双向自证）');
