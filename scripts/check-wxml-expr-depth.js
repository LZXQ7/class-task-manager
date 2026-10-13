#!/usr/bin/env node
/**
 * 离线自检：WXML 表达式的嵌套三元层数上限（2026-10-07）
 * ------------------------------------------------------------
 * 背景（真机/开发者工具编译期报错，用户 2026-10-07 报）：
 *   `Bad attr "title" with message: error at token !`
 *   定位在 `miniprogram/pages/timetable/index.wxml` 的 4 步向导 `bottom-sheet` 的 `title`。
 *
 * 根因：该 `title` 用了 **4 层嵌套三元**（152 字符）查「调课方式 → 标题」。
 *   WXML 表达式解析器（wcc）对嵌套三元的**层数有上限**，
 *   超了就在编译期抛 `error at token <某个运算符>`。
 *   🔴 **`!` 是误导性定位** —— 它是解析器失败位置回读到的一个运算符 token，
 *      不是「你的表达式里有 `!`」。按「去查 `!`」方向排查会完全跑偏（本次就绕了一圈）。
 *
 * 判据取「≤3 层」而不是某个魔数长度，依据是**实测对照**：
 *   3 层（96 字符）在本项目 4 个页面 + 1 个组件里长期存在且线上正常；
 *   唯一的 4 层（152 字符）必然编译失败。
 *   长度不是判据 —— 也有 108 / 102 字符的表达式一直跑得好好的。
 *
 * 修法不是把三元拆短，而是**标题在 JS 里算好**（`data.shiftTitle`）——
 * 这也符合项目既有铁律「WXML 不做逻辑，派生值一律 JS 预计算」。
 *
 * 自证：造一条 4 层表达式喂给 judge → 必须判死；扫源码原样 → 不得误报。
 * ⚠️ 判据要在**内存副本**上做，绝不写盘。
 * 用法：node scripts/check-wxml-expr-depth.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

/** 递归收集所有 .wxml（跳过 node_modules / .workbuddy） */
function collectWxml(dir, out) {
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (f === 'node_modules' || f === '.workbuddy') return;
      collectWxml(p, out);
    } else if (f.endsWith('.wxml')) out.push(p);
  });
  return out;
}

/**
 * 判断一行里是否有嵌套三元层数超限。
 *
 * 🔴 **层数算法必须用括号栈，不能用「遇到 `:` 就降」的压平计数**：
 *   三元是**右结合**的（`a ? 1 : b ? 2 : 3` 相当于 `a?1:(b?2:3)`），
 *   而 `:` 出现次序是「外层先、内层后」，按出现顺序一降就把嵌套压平成 1 层。
 *   本门禁第一版就栽在这里 ⇒ 造了 4 层变异却算出 1 层，**变异自证假通过**。
 *   现算法：层数 = 遇到 `?` 时的「已开启括号数 + 1」的峰值。
 *   校准用例见 `_verify`（已验证 7/7 一致，含项目真实表达式）。
 *
 * ⚠️ 必须**跳过字符串字面量**，否则文案里的 `?` / `!` / 括号会被当成运算符。
 * 返回超限的表达式数组。
 */
function ternDepth(s) {
  const stack = [];
  let paren = 0;
  let max = 0;
  let inStr = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (c === inStr) inStr = null; continue; }
    if (c === "'" || c === '"') { inStr = c; continue; }
    if (c === '(') { stack.push(1); paren++; continue; }
    if (c === ')') { paren = stack.length ? stack.pop() - 1 : 0; continue; }
    if (c === '?') { if (paren + 1 > max) max = paren + 1; }
  }
  return max;
}

function judgeLine(line, maxDepth) {
  const hits = [];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(line))) {
    const expr = m[1];
    const d = ternDepth(expr);
    if (d > maxDepth) hits.push({ expr: expr.trim().slice(0, 90), depth: d });
  }
  return hits;
}

const MAX_DEPTH = 3;
const files = collectWxml(MINI, []);

console.log('【A】扫源码：嵌套三元不得超过 ' + MAX_DEPTH + ' 层');
let total = 0;
files.forEach(f => {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const hits = judgeLine(line, MAX_DEPTH);
    if (hits.length) {
      total += hits.length;
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      console.log('  FAIL  ' + rel + ' L' + (i + 1) + ' depth=' + hits.map(h => h.depth).join(',')
        + ' | ' + hits[0].expr);
    }
  });
});
check('A1 全仓无超过 ' + MAX_DEPTH + ' 层的嵌套三元', total === 0, total + ' 处超限');

console.log('\n【B】变异自证（内存副本，不写盘）');
// 变异 1：**本项目真实的报错表达式**（2026-10-07 线上编译失败的那一条，原文照抄）
const realBad = "{{shiftMode === 'date' ? '日期间调课' : (shiftMode === 'week' ? '单周次调课' : (shiftMode === 'multi' ? '批量周次调课' : (shiftMode === 'batch' ? '批量课程调课' : 'AI 智能调课'))))}}";
check('B1 变异（项目真实 4 层表达式）必须判死', judgeLine(realBad, MAX_DEPTH).length === 1,
  JSON.stringify(judgeLine(realBad, MAX_DEPTH)));
// 前置检查：这条必须真的算出 4 层，否则说明判据本身坏了（此时 B1 的「判死」是假的）
check('B1b 前置检查：真实表达式层数确为 4', ternDepth(realBad.slice(2, -2)) === 4,
  ternDepth(realBad.slice(2, -2)));

// 3 层：项目现状（4 个页面 + 1 个组件长期跑通）⇒ 不得误报
const realOk3 = "{{paReady ? (animSeq === 0 ? 'pa-first' : (animSeq === 1 ? 'pa-lite-a' : 'pa-lite-b')) : 'pa-hold'}}";
check('B2 项目真实 3 层表达式不得误报', judgeLine(realOk3, MAX_DEPTH).length === 0,
  '算出 ' + ternDepth(realOk3.slice(2, -2)));

// 层数算法本身（三种错误算法都会在这里露馅）
check('B3 右结合压平成 1 层要能识破：a ? 1 : (b ? 2 : (c ? 3 : (d ? 4 : 5))) = 4 层',
  ternDepth("a === 1 ? 'x' : (b === 2 ? 'y' : (c === 3 ? 'z' : (d === 4 ? 'w' : 'v')))") === 4);
check('B4 括号内单三元 = 2 层', ternDepth("(a ? '1' : '2')") === 2);
check('B5 平铺三元 = 1 层', ternDepth("a ? '1' : '2'") === 1);

// 文案里的问号 / 括号不得被当成运算符
const realStr = "{{shiftMode === 'batch' ? '改的是课程本身的时段，周次保留 —— 对每一周都生效' : '只改上课的星期与节次'}}";
check('B6 字符串字面量里的标点不计入层数', judgeLine(realStr, MAX_DEPTH).length === 0,
  '算出 ' + ternDepth(realStr.slice(2, -2)));

// 非三元长表达式（|| 串联）不受限
const realOr = "{{(detailShow || formShow || weekPickerShow || shiftMenuShow || shiftShow || calShow) ? 'overflow:hidden' : ''}}";
check('B7 长 || 串联表达式不误报', judgeLine(realOr, MAX_DEPTH).length === 0,
  '算出 ' + ternDepth(realOr.slice(2, -2)));

// 同行多表达式：只报超限那个
const two = "{{a ? '1' : '2'}} x {{p === 1 ? 'y' : (q === 2 ? 'z' : (r === 3 ? 'w' : (s === 4 ? 'q' : 'r'))))}}";
check('B8 同行多表达式只报超限那个', judgeLine(two, MAX_DEPTH).length === 1,
  judgeLine(two, MAX_DEPTH).length);

console.log();
if (fail) {
  console.log('❌ 失败 ' + fail + ' 项 / 共 ' + (pass + fail));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✅（' + pass + ' 项）');
}
