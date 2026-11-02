#!/usr/bin/env node
/**
 * scripts/check-leave-period-text.js
 * 请假时段文案体检（2026-11-03）
 *
 * 守两件事，防止老毛病复发：
 *  ① **顺序固定**：文案必须按 上午→下午→晚上 输出，与点选先后无关。
 *     历史 bug：hint 用点选数组 `norm.map()` 直接拼串，先点「下午」再点「上午」
 *     就显示成「下午 13:00–18:00；上午 08:00–12:00」，顺序乱跳（用户截图报过）。
 *  ② **相邻合并**：am+pm 必须显示 `08:00–18:00`、pm+eve 必须 `13:00–21:00`；
 *     只有跳段（am+eve）才分开说明成「上午 …；晚上 …」。
 *
 * 三处实现同口径，全部要过：pages/leave（自助申请）、pages/roster（代登记）、
 * cloudfunctions/adjust 的 periodsText（通知文案）。
 *
 * 手法：用 vm + 桩**直接加载真实源码**取内部函数（不抄副本，抄了就等于没守）。
 * Page/wx/getApp 全桩掉，只跑顶层常量与函数定义，不执行任何 handler。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadPeek(file, expr) {
  let src = fs.readFileSync(file, 'utf8');
  src += '\n;module.exports.__peek = function(){ return (' + expr + '); };';
  const sandbox = {
    module: { exports: {} }, console, setTimeout, clearTimeout,
    require: (p) => {
      if (String(p).indexOf('wx-server-sdk') >= 0) {
        return { init: () => {}, database: () => ({}), DYNAMIC_CURRENT_ENV: 'env', getWXContext: () => ({}) };
      }
      return {
        toast: () => {}, confirmStrict: () => Promise.resolve(''),
        uploadFile: () => Promise.resolve(''), getTempFileURL: () => Promise.resolve({})
      };
    },
    Page: () => {}, App: () => {},
    getApp: () => ({ globalData: {}, canApprove: () => false, canLeave: () => false }),
    wx: {}
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  return sandbox.module.exports.__peek();
}

let pass = 0;
const problems = [];
function eq(actual, expect, label) {
  if (actual === expect) { pass++; return; }
  problems.push(label + ' → 实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect));
}

/* 期望值：注意提前/延后点选的乱序输入，输出必须与正序一致 */
const CASES = [
  [[], '全天'],
  [['am'], '上午 08:00–12:00'],
  [['pm'], '下午 13:00–18:00'],
  [['eve'], '晚上 18:00–21:00'],
  [['pm', 'am'], '08:00–18:00'],                          // 先下午后上午 → 顺序不能反
  [['eve', 'pm'], '13:00–21:00'],                         // 先晚上后下午
  [['eve', 'am'], '上午 08:00–12:00；晚上 18:00–21:00'],   // 跳段 → 分开说明
  [['pm', 'eve', 'am'], '08:00–21:00'],                   // 乱序全选
  [['am', 'pm', 'eve'], '08:00–21:00'],
  [['am', 'pm'], '08:00–18:00']
];

/* ---- 1) 自助申请页 ---- */
const leave = loadPeek(path.join(ROOT, 'miniprogram/pages/leave/index.js'), '{ periodRangeText, reasonDisplay, REASON_OPTS }');
CASES.forEach(([input, expect]) => eq(leave.periodRangeText(input), expect, 'leave ' + JSON.stringify(input)));

/* 事由四分类 + 「其他」手填拼接 */
eq(leave.REASON_OPTS.map(o => o.key).join(','), 'PUBLIC,SICK,PERSONAL,OTHER', 'leave 事由 key');
eq(leave.REASON_OPTS.map(o => o.text).join(','), '公假,病假,事假,其他', 'leave 事由中文');
eq(leave.reasonDisplay('OTHER', '发烧'), '其他：发烧', 'leave 其他带说明');
eq(leave.reasonDisplay('OTHER', ''), '其他', 'leave 其他无说明');
eq(leave.reasonDisplay('PUBLIC', ''), '公假', 'leave 公假');

/* ---- 2) 代登记页 ---- */
const roster = loadPeek(path.join(ROOT, 'miniprogram/pages/roster/index.js'), '{ periodRangeText, leavePeriodText }');
CASES.forEach(([input, expect]) => eq(roster.periodRangeText(input), expect, 'roster ' + JSON.stringify(input)));
// 旧记录（迁移前手工钟点）必须回显钟点，不能谎报全天
eq(roster.leavePeriodText({ periods: '', startTime: '08:30', endTime: '11:30' }), '08:30–11:30', 'roster 旧钟点回显');
eq(roster.leavePeriodText({ periods: '', startTime: '', endTime: '' }), '全天', 'roster 真空=全天');
eq(roster.leavePeriodText({ periods: 'pm,am' }), '08:00–18:00', 'roster 逗号串入参');

/* ---- 3) 云函数通知文案 ---- */
const adj = loadPeek(path.join(ROOT, 'cloudfunctions/adjust/index.js'), '{ periodsText }');
CASES.forEach(([input, expect]) => eq(adj.periodsText(input), expect, 'adjust ' + JSON.stringify(input)));

if (problems.length) {
  console.log('[FAIL] 请假时段文案体检：' + problems.length + ' 项不符');
  problems.forEach(p => console.log('       ✗ ' + p));
  process.exit(1);
}
console.log('[PASS] 请假时段文案固定顺序 + 相邻合并体检通过（' + pass + ' 项断言）');
