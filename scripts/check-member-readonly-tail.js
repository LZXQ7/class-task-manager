#!/usr/bin/env node
/**
 * 离线自检：普通成员（只读视角）在「成员与分组」页也要能看到学号尾号（2026-11-18 立规）
 * ================================================================================
 * 用户报障：其他人（普通成员）打开「成员与分组」，姓名下面没有「X 号」——
 *   只有超管 / 班委看得到，其他人看不到尾号。
 *
 * 背景口径（2026-10-28 定）：member.list 的 public='read' 分支为了隐私，
 *   只回姓名 / 组别 / 职务，**故意不回完整学号 / 绑定态 / 值日次数**。
 *   前端 wxml 的「X 号 · 值日 N 次」小字因此被 `!item.readOnly` 整行挡住。
 *
 * 本次口径变更（用户 2026-11-18 定，AskUserQuestion 两问）：
 *   · 只放开**尾号**（两位，如 01/28），不放开完整学号 / 值日次数 / 绑定态；
 *   · 显示在**姓名下方加一行小字**，头像保持姓氏字不变。
 *
 * 定规：
 *   ① 后端 read 分支在返回体带 `seq`（仅后两位数字），仍不带 studentNo / bound / role / isSuper；
 *   ② 前端 _loadMembers 的 seq 优先取后端值（read 行不能被 seqOf(undefined)=0 覆盖）；
 *   ③ wxml 只读行有独立的尾号小字分支 `item.readOnly && item.seq`，显示「X 号」；
 *      该分支**不含**值日次数（cnt-num），也不碰绑定态 / 完整学号；
 *   ④ 管理视图（!readOnly）的「X 号 · 值日 N 次」分支保持原样（回归护栏）。
 *
 * 判据：真跑 wxml 的 wx:if/wx:elif 条件（new Function）+ 扫后端/前端源码，4 变异自证。
 * 用法：node scripts/check-member-readonly-tail.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WXML = read('miniprogram/pages/roster/index.wxml');
const JS = read('miniprogram/pages/roster/index.js');
const MEMBER = read('cloudfunctions/member/index.js');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}
function strip(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

/** 取 read 分支源码 */
function readBlock(src) {
  const i = src.indexOf("payload.public === 'read'");
  const j = src.indexOf("payload.public === 'manage'", i < 0 ? 0 : i);
  return (i < 0 || j < 0) ? '' : src.slice(i, j);
}

/** 真跑一个 wxml 布尔表达式（表达式里是 item.xxx，注入一个 item 对象即可） */
function testExpr(expr, item) {
  if (!expr) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function('item', 'return (' + expr + ');')(item);
  } catch (e) {
    return null;
  }
}
/** 抓 mb-sub 三个分支的条件与内容（按出现顺序：X组 / 只读尾号 / 管理值日） */
function subBranches(wxml) {
  const re = /<view\s+wx:(if|elif)="\{\{([^}]*)\}\}"\s+class="mb-sub">([\s\S]*?)<\/view>/g;
  const out = [];
  let m;
  while ((m = re.exec(wxml))) out.push({ kind: m[1], cond: m[2], body: m[3] });
  return out;
}

const RB = readBlock(strip(MEMBER));
const brs = subBranches(WXML);
const roBranch = brs.find((b) => /readOnly/.test(b.cond) && /seq/.test(b.cond));
const mgBranch = brs.find((b) => /!item\.readOnly/.test(b.cond));

console.log('── ① 后端 read 分支：只回尾号 seq，不回完整学号/绑定态/权限位');
check(/seq\s*:\s*\w+/.test(RB), 'read 分支返回体带 seq（仅尾号）');
check(!/studentNo\s*:/.test(RB) && !/bound\s*:/.test(RB), 'read 分支仍不回完整 studentNo / bound');
check(!/\brole\s*:/.test(RB) && !/isSuper\s*:/.test(RB), 'read 分支仍不回 role / isSuper');
check(/readOnly\s*:\s*true/.test(RB), 'read 分支仍带 readOnly 标记');
// 尾号只能取后两位：真跑取值函数对长学号只产出两位数
const tailBody = (strip(MEMBER).match(/function\s+seqTail\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/) || []);
if (tailBody.length === 3) {
  // eslint-disable-next-line no-new-func
  const tail = new Function(tailBody[1], tailBody[2]);
  check(String(tail('000000000128')) === '28', 'seqTail 对长学号取后两位（000000000128 → 28）');
  check(String(tail('000000000101')) === '1' || String(tail('000000000101')) === '01',
    'seqTail 对 01 号产出 1 或 01（前端展示成「1 号」）');
} else {
  check(false, '后端存在 seqTail 取值函数（供门禁真跑验证尾号口径）');
}

console.log('\n── ② 前端 _loadMembers：read 行的 seq 不被覆盖成 0');
check(/x\.seq\s*(!==|!=)\s*(null|undefined)/.test(JS) && /util\.seqOf/.test(JS),
  '_loadMembers 的 seq 优先取后端值、无值时才回退 util.seqOf（read 行不再恒 0）');

console.log('\n── ③ wxml：只读尾号小字分支（真跑条件）');
check(!!roBranch, '存在只读行尾号小字分支（带 readOnly && seq 条件）');
if (roBranch) {
  const show = testExpr(roBranch.cond, { readOnly: true, seq: 28, groupTag: 'A' });
  const hideNoSeq = testExpr(roBranch.cond, { readOnly: true, seq: 0, groupTag: 'A' });
  const hideAdmin = testExpr(roBranch.cond, { readOnly: false, seq: 28, groupTag: 'A' });
  check(!!show, '普通成员有尾号 → 显示「28 号」小字');
  check(!hideNoSeq, '尾号为 0（无学号，如教职工占位）→ 不显示半截「0 号」');
  check(!hideAdmin, '管理视图不走只读分支（避免与「值日 N 次」重复）');
  check(/\{\{\s*item\.seq\s*\}\}\s*号/.test(roBranch.body), '小字内容是「{{item.seq}} 号」');
  check(!/cnt-num|值日/.test(roBranch.body), '只读尾号小字不含值日次数（用户只放开尾号）');
  check(!/studentNo|bound|已绑定/.test(roBranch.body), '只读尾号小字不含完整学号/绑定态');
}
check(!!mgBranch && /!item\.readOnly/.test(mgBranch.cond) && /cnt-num/.test(mgBranch.body),
  '管理视图「X 号 · 值日 N 次」分支保持原样（回归护栏）');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
/** 在内存副本上改，绝不写盘 */
const TAIL_RE = /function\s+seqTail\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/;
function tailFnFrom(src) {
  const m = src.match(TAIL_RE);
  if (!m) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(m[1], m[2]);
  } catch (e) {
    return null;
  }
}
const goodTail = tailFnFrom(strip(MEMBER));
const mutatedSrc = strip(MEMBER).replace(TAIL_RE,
  'function seqTail(no) {\n  return String(no).slice(0, 2);\n}'); // 改成「前两位」的坏口径（保留换行供 TAIL_RE 抽取）
const badTail = tailFnFrom(mutatedSrc);
check(!!goodTail && String(goodTail('000000000128')) === '28'
  && !!badTail && String(badTail('000000000128')) !== '28',
  '变异被抓：seqTail 改成「前两位」→ 真跑值不再等于 28');
const mWxml = WXML.replace(/wx:elif="\{\{[^}]*item\.readOnly[^}]*item\.seq[^}]*\}\}"\s+class="mb-sub"/,
  'wx:elif="{{false}}" class="mb-sub"');
check(mWxml !== WXML && !subBranches(mWxml).some((b) => /readOnly/.test(b.cond) && /seq/.test(b.cond)),
  '变异被抓：删掉只读尾号分支 → wxml 找不到该分支');
const mJs = JS.replace(/x\.seq\s*(!==|!=)\s*(null|undefined)\s*\?\s*x\.seq\s*:\s*/,
  '$1');
check(!/x\.seq\s*(!==|!=)\s*(null|undefined)\s*\?\s*x\.seq/.test(mJs),
  '变异被抓：seq 不再优先取后端值 → read 行又变 0');

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 普通成员学号尾号检查全部通过'));
process.exit(failed ? 1 : 0);
