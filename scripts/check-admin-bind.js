#!/usr/bin/env node
/**
 * 后台前端「按钮点了没反应」防回归门禁
 *
 * 背景（2026-11-15 真实事故）：
 *   新增班费页与请假代登记时，绑定列表元素写成了
 *       $('[data-fee-type]', host).forEach(...)
 *   `$` 是 querySelector 的简写，返回**单个元素**，元素上没有 forEach
 *   ⇒ 抛 `TypeError: ...forEach is not a function`。
 *   而这段代码位于 `bind()` 的**第一行**，innerHTML 早已写完
 *   ⇒ 页面渲染完全正常、一个报错都不显示，但**后面所有 onclick 全部没绑上**
 *   ⇒ 用户看到的就是「请假和班费页面，按钮点击没反应」。
 *
 * 判据：
 *   ① 源码里不许出现 `$('...').forEach(` —— 集合遍历必须用 `$$`
 *   ② 每个 `render*` 函数体里 `id="xxx"` 声明的元素，bind 段必须出现 `#xxx`
 *      （防止「新加按钮忘了绑」，症状与本次完全相同：点了没反应）
 *   ③ 变异自证：把 $$ 改回 $、删掉一处绑定 → 判据必须翻红
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'cloudfunctions/admin-web/public/app.js');
const src = fs.readFileSync(APP, 'utf8');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function stripComments(s) {
  // 行注释 + 块注释，保留行结构
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const code = stripComments(src);

/** 纯函数：返回违规行（变异自证复用同一份判据） */
function scanDollarForEach(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    // $('...'....).forEach  但排除 $$('...')
    if (/(^|[^$])\$\(\s*'[^']*'[^)]*\)\s*\.forEach/.test(line)) out.push({ line: i + 1, text: line.trim() });
    if (/(^|[^$])\$\(\s*"[^"]*"[^)]*\)\s*\.forEach/.test(line)) out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

/* ============================================================
 * ① 集合遍历必须用 $$
 * ============================================================ */
console.log('── ① 列表绑定必须用 $$（querySelectorAll），不许用 $ 后接 .forEach');
const badLoop = scanDollarForEach(code);
badLoop.forEach((b) => console.log('     ' + b.line + '  ' + b.text));
check(badLoop.length === 0, '没有 $(\'...\').forEach 写法（命中 ' + badLoop.length + ' 处）');

/* ============================================================
 * ② 声明的 id 必须被绑定引用
 *    render* 函数体 → 收集 id="xxx" → 同函数体内必须出现 '#xxx'
 * ============================================================ */
console.log('\n── ② render 里声明的按钮 id 必须真的被绑定');

/** 用花括号配平抽出函数体（源码是 2 空格缩进的 IIFE 内函数） */
function bodyOf(text, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (!depth) return text.slice(i + 1, k); }
  }
  return null;
}

/** 交互元素才要求绑定：button / input / select / a，且带 id */
function interactiveIds(body) {
  const ids = new Set();
  const re = /<(button|input|select|a)\b[^>]*\bid="([a-zA-Z][\w-]*)"/g;
  let m;
  while ((m = re.exec(body))) ids.add(m[2]);
  return ids;
}

const RENDER_FNS = ['renderFee', 'renderLeave', 'renderDuty', 'renderSwap', 'renderCountdown', 'renderAccount'];
let idChecked = 0;
RENDER_FNS.forEach((fn) => {
  const body = bodyOf(code, fn);
  if (!body) return; // 本版尚未实现的模块跳过
  const ids = interactiveIds(body);
  const missing = [...ids].filter((id) => body.indexOf("'#" + id + "'") < 0 && body.indexOf('"#' + id + '"') < 0);
  idChecked += ids.size;
  check(missing.length === 0, fn + '：' + ids.size + ' 个交互 id 全部有绑定引用' +
    (missing.length ? '（未绑定：' + missing.join(', ') + '）' : ''));
});

/* ============================================================
 * ③ 变异自证
 * ============================================================ */
console.log('\n── ③ 变异自证（改坏 → 判据必须翻红）');

// 3.1 把 $$ 改回 $：取代码里第一处 $$('[data-... 或 $$('#...
const firstLoop = /\$\$\('[^']*'/;
const mLoop = firstLoop.exec(code);
if (mLoop) {
  const mutated = code.slice(0, mLoop.index) + mLoop[0].slice(1) + code.slice(mLoop.index + mLoop[0].length);
  check(scanDollarForEach(mutated).length > 0,
    '变异被抓：$$ 改回 $ → 判据翻红（' + mLoop[0].slice(1) + '）');
} else {
  check(false, '变异夹具失效：源码里找不到 $$(\'...\')');
}

// 3.2 好样本不误报
check(scanDollarForEach("$$('[data-x]', host).forEach(function (b) {});").length === 0,
  '好样本不误报：$$(...).forEach 放行');

// 3.3 删掉一处绑定 → id 判据必须翻红
const feeBody = bodyOf(code, 'renderFee');
if (feeBody) {
  const dropTarget = "      var ba = $('#fee-add', host);";
  if (code.indexOf(dropTarget) >= 0) {
    const broken = code.replace(dropTarget, '      var ba = null;');
    const bBody = bodyOf(broken, 'renderFee');
    const ids = [...interactiveIds(bBody)];
    const missing = ids.filter((id) => bBody.indexOf("'#" + id + "'") < 0);
    check(missing.indexOf('fee-add') >= 0,
      '变异被抓：删掉 #fee-add 绑定 → 判据点名 fee-add（实测 ' + JSON.stringify(missing) + '）');
  } else {
    check(false, '变异夹具失效：找不到 #fee-add 绑定行');
  }
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('\n── 汇总：交互 id 共校验 ' + idChecked + ' 个');
console.log(fail ? '\n结果：失败 ' + fail + ' 项 / 通过 ' + pass + ' 项' : '\n结果：全部通过（' + pass + ' 项）');
process.exit(fail ? 1 : 0);
