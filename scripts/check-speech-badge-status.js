#!/usr/bin/env node
/**
 * 离线自检：值日页顶部日期条的状态徽章必须跟「当前视图」的状态字段走（2026-11-18 立规）
 * --------------------------------------------------------------------------------
 * 用户报障（截图 2026-11-30–12-06 · 第 12 周，课前演讲视图）：
 *   演讲已经发布（「撤回发布」按钮都已出现），但顶部日期条仍挂「草稿」。
 *
 * 根因：<week-switcher> 是纯展示组件，徽章文案由页面传入。duty/index.wxml 的
 *   status-text / status-type 只绑了值日字段 `status`（load() 里赋值），
 *   而演讲视图的发布状态在**另一个字段** `speechStatus`（loadSpeech() 里赋值）。
 *   两套视图共用一枚徽章：演讲切到 PUBLISHED 后，按钮跟着 speechStatus 变了，
 *   徽章却还读值日的 status（草稿）—— 静默显示错，不报错、不 toast。
 *
 * 定规：
 *   ① status-text / status-type 必须按 viewMode 选源：
 *      viewMode==='speech' ? speechStatus : status；
 *   ② 演讲视图不得被值日 status 带偏（值日已发布、演讲仍草稿 ⇒ 必须「草稿」）；
 *   ③ 值日视图回归：status=PUBLISHED ⇒「已发布」，archived ⇒「已归档」；
 *   ④ PUBLISHED 优先于 archived（已发布的周即便归档仍显示「已发布」）。
 *
 * 判据不是字符串匹配：直接把 wxml 里的三元表达式抽出来用 new Function 真跑，
 * 对 6 个场景同时断言 statusText 与 statusType，再做 4 组变异自证。
 *
 * 用法：node scripts/check-speech-badge-status.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FILE = 'miniprogram/pages/duty/index.wxml';
const SRC = read(FILE);

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/** 抽 status-text / status-type 的 {{...}} 表达式（wxml 表达式本身是合法 JS：三元 + === + 括号） */
function extractExpr(wxml, attr) {
  const m = wxml.match(new RegExp(attr + '="\\{\\{([\\s\\S]*?)\\}\\}"'));
  return m ? m[1] : null;
}

/** 真跑表达式：注入当前视图 + 两个状态字段 + 归档位 */
function build(expr) {
  if (!expr) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function('viewMode', 'status', 'speechStatus', 'archived',
      'return (' + expr + ');');
  } catch (e) {
    return null;
  }
}

const SCENES = [
  { name: '演讲已发布 / 值日草稿 → 已发布（用户报障场景）', v: 'speech', s: 'DRAFT', sp: 'PUBLISHED', a: false, t: '已发布', y: 'published' },
  { name: '演讲草稿 / 值日已发布 → 草稿（不被值日带偏）', v: 'speech', s: 'PUBLISHED', sp: 'DRAFT', a: false, t: '草稿', y: 'draft' },
  { name: '值日已发布 → 已发布（值日回归）', v: 'duty', s: 'PUBLISHED', sp: 'DRAFT', a: false, t: '已发布', y: 'published' },
  { name: '值日草稿 + 归档 → 已归档（值日回归）', v: 'duty', s: 'DRAFT', sp: 'DRAFT', a: true, t: '已归档', y: 'archived' },
  { name: '演讲草稿 + 归档 → 已归档', v: 'speech', s: 'DRAFT', sp: 'DRAFT', a: true, t: '已归档', y: 'archived' },
  { name: '演讲已发布 + 归档 → 已发布（发布优先）', v: 'speech', s: 'PUBLISHED', sp: 'PUBLISHED', a: true, t: '已发布', y: 'published' }
];

function evalAll(src) {
  const ft = build(extractExpr(src, 'status-text'));
  const fy = build(extractExpr(src, 'status-type'));
  return SCENES.map((sc) => ({
    name: sc.name, wantT: sc.t, wantY: sc.y,
    gotT: ft ? ft(sc.v, sc.s, sc.sp, sc.a) : '<无表达式>',
    gotY: fy ? fy(sc.v, sc.s, sc.sp, sc.a) : '<无表达式>'
  }));
}

const GOOD_T = extractExpr(SRC, 'status-text');
const GOOD_Y = extractExpr(SRC, 'status-type');

console.log('── ① 顶部徽章按当前视图选状态字段（真跑 wxml 表达式）');
const R = evalAll(SRC);
R.forEach((r, i) => {
  check(r.gotT === r.wantT && r.gotY === r.wantY,
    '场景' + (i + 1) + ' ' + r.name + '：期望 ' + r.wantT + '/' + r.wantY + '，得到 ' + r.gotT + '/' + r.gotY);
});

console.log('\n── ② 表达式结构（不是靠碰巧取到值）');
check(!!GOOD_T && /viewMode/.test(GOOD_T) && /speechStatus/.test(GOOD_T),
  'status-text 表达式按 viewMode 在 status / speechStatus 间选源');
check(!!GOOD_Y && /viewMode/.test(GOOD_Y) && /speechStatus/.test(GOOD_Y),
  'status-type 表达式按 viewMode 在 status / speechStatus 间选源');

console.log('\n── ③ 变异自证（改坏 → 对应场景必须翻红）');
/** 用「文件名 + 属性整串」做锚点替换，限定只改这一处 */
function mutate(newT, newY) {
  return SRC
    .replace('status-text="{{' + GOOD_T + '}}"', 'status-text="{{' + newT + '}}"')
    .replace('status-type="{{' + GOOD_Y + '}}"', 'status-type="{{' + newY + '}}"');
}
function mutCheck(name, newT, newY, probeIdx) {
  const src2 = mutate(newT, newY);
  if (src2 === SRC) {
    check(false, '变异「' + name + '」锚点没命中（表达式没被换掉）');
    return;
  }
  const r2 = evalAll(src2)[probeIdx];
  check(r2.gotT !== r2.wantT || r2.gotY !== r2.wantY,
    '变异被抓：' + name + '（场景' + (probeIdx + 1) + ' 得到 ' + r2.gotT + '/' + r2.gotY + '）');
}
const OLD_T = "status === 'PUBLISHED' ? '已发布' : (archived ? '已归档' : '草稿')";
const OLD_Y = "status === 'PUBLISHED' ? 'published' : (archived ? 'archived' : 'draft')";
const PICK_T = "(viewMode === 'speech' ? speechStatus : status) === 'PUBLISHED' ? '已发布' : (archived ? '已归档' : '草稿')";
const PICK_Y = "(viewMode === 'speech' ? speechStatus : status) === 'PUBLISHED' ? 'published' : (archived ? 'archived' : 'draft')";
const REV_T = "(viewMode === 'duty' ? speechStatus : status) === 'PUBLISHED' ? '已发布' : (archived ? '已归档' : '草稿')";
const REV_Y = "(viewMode === 'duty' ? speechStatus : status) === 'PUBLISHED' ? 'published' : (archived ? 'archived' : 'draft')";
const AFIRST_T = "archived ? '已归档' : ((viewMode === 'speech' ? speechStatus : status) === 'PUBLISHED' ? '已发布' : '草稿')";
const AFIRST_Y = "archived ? 'archived' : ((viewMode === 'speech' ? speechStatus : status) === 'PUBLISHED' ? 'published' : 'draft')";

mutCheck('退回旧状：徽章只读值日 status（本 bug）', OLD_T, OLD_Y, 0);
mutCheck('只改文案不改类型：status-type 仍读 status', PICK_T, OLD_Y, 0);
mutCheck('选源写反：值日视图读了 speechStatus', REV_T, REV_Y, 2);
mutCheck('归档抢在发布前：已发布 + 归档显示成已归档', AFIRST_T, AFIRST_Y, 5);

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 顶部状态徽章跟随当前视图检查全部通过'));
process.exit(failed ? 1 : 0);
