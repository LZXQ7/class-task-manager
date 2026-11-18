#!/usr/bin/env node
/**
 * 课堂情况新模板门禁（2026-11-18 需求2）
 * =============================================================
 * 真跑 home/index.js 的 _buildCourseInfo 函数体（抽源码 + 桩 setData/util），
 * 验证新模板：日期星期 / 大节 / 课程 / 请假人员(姓名 学号) / 公假人员 / 空段省略 / 末行。
 * 不写盘、不依赖小程序运行时。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.js'), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

// 抽 bigPeriodText 的映射常量与函数（模块级纯函数）
const constBlock = /const PERIOD_BIG_TEXT = \[([^\]]*)\];/.exec(js);
chk(!!constBlock, '有 PERIOD_BIG_TEXT 大节映射常量');
const cnBlock = /const CN_NUM = \[([^\]]*)\];/.exec(js);
chk(!!cnBlock, '有 CN_NUM 中文数字兜底');

// 抽 _buildCourseInfo 函数体，真跑
const m = /_buildCourseInfo\(s, roster, leaveList\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!m, '能抽到 _buildCourseInfo 函数体');
if (!m) { console.log('[FAIL] 无法继续'); process.exit(1); }

// 拼一个可在内存里跑的构造器：注入依赖，返回 setData 捕获
// bigPeriodText 用源码里抽出的常量重建（避免抄一份漂移）
const bigText = constBlock ? ('[' + constBlock[1] + ']') : "['','上午第一大节','上午第二大节','下午第一大节','下午第二大节','晚上第一大节']";
const cnNum = cnBlock ? ('[' + cnBlock[1] + ']') : "['','一','二','三','四','五','六','七','八','九','十']";
const makeRunner = new Function(
  'util', 'bigPeriodText',
  'return function(s, roster, leaveList) {'
  + '  var out = null; var self = { data: {}, setData: function(o){ out = o; } };'
  + '  (function(){' + m[1].replace(/this\.setData/g, 'self.setData') + '\n  }).call(self, s, roster, leaveList);'
  + '  return out; };'
);
// util 桩：todayStr / md / weekdayShort / todayWeekday
const utilStub = {
  todayStr: () => '2026-11-18',
  md: (s) => { const p = String(s).split('-'); return (+p[1]) + '月' + (+p[2]) + '日'; },
  weekdayShort: (n) => ['一', '二', '三', '四', '五', '六', '日'][n - 1] || '',
  todayWeekday: () => 3
};
// 真跑 bigPeriodText（用源码常量）
const bpt = new Function('return ' + bigText + ';')();
const cnn = new Function('return ' + cnNum + ';')();
const bigPeriodText = new Function('bigText', 'cnn',
  'return function(p){ var n = Number(p)||0; return bigText[n] || ("第" + (cnn[n]||n) + "大节"); };'
)(bpt, cnn);

const run = makeRunner(utilStub, bigPeriodText);

// 夹具：11-18 周三，第3大节(下午第一大节)，课名儿童文学
const s = { period: 3, name: '儿童文学', groupScope: '' };
const roster = [{ id: 1, groupTag: 'A', studentNo: '000000000301' }];
const today = '2026-11-18';
const mkLeave = (name, no, reason) => ({
  name, studentNo: no, groupTag: 'A', reason,
  startDate: today, endDate: today, startTime: '', endTime: '', periods: []
});

// 场景1：无请假 → 只有头3行 + 末行，空段省略
let out = run(s, roster, []);
let lines = out.courseInfoText.split('\n');
console.log('\n[场景1 无人请假]');
console.log(lines.join('\n'));
chk(lines[0] === '【11月18日星期三', '第一行 = 【M月D日星期X');
chk(lines[1] === '下午第一大节', 'period=3 → 下午第一大节（映射口径）');
chk(lines[2] === '课程:儿童文学', '第三行 = 课程:课程名');
chk(!lines.some((l) => l.indexOf('请假人员：') >= 0), '空段省略：无请假人员时不写标题');
chk(!lines.some((l) => l.indexOf('公假人员:') >= 0), '空段省略：无公假人员时不写标题');
chk(lines[lines.length - 1] === '无迟到旷课情况】', '末行 = 无迟到旷课情况】');

// 场景2：1 病假 + 1 公假 → 分两段，每行「姓名 学号」
out = run(s, roster, [
  mkLeave('示例成员01', '000000000301', 'SICK'),
  mkLeave('张三', '000000000346', 'PUBLIC')
]);
lines = out.courseInfoText.split('\n');
console.log('\n[场景2 病假+公假]');
console.log(lines.join('\n'));
const leaveIdx = lines.indexOf('请假人员：');
const pubIdx = lines.indexOf('公假人员:');
chk(leaveIdx >= 0 && pubIdx > leaveIdx, '有请假人员段且排在公假人员段前');
chk(lines[leaveIdx + 1] === '示例成员01 000000000301', '请假人员行 = 姓名 空格 完整学号');
chk(lines[pubIdx + 1] === '张三 000000000346', '公假人员行 = 姓名 空格 完整学号');
chk(!lines.some((l) => /000000000301/.test(l) && l.indexOf('公假') >= 0), '病假者不进公假段');

// 场景3：老数据无 reason → 算请假人员（不进公假）；仅公假 → 请假段整段省略
out = run(s, roster, [mkLeave('李四', '000000000350', '')]);
lines = out.courseInfoText.split('\n');
chk(lines.indexOf('请假人员：') >= 0 && lines.indexOf('公假人员:') < 0,
  '老数据无 reason 算请假人员，公假段省略');

// 场景4：大节映射 1/2/4/5
[
  [1, '上午第一大节'], [2, '上午第二大节'], [4, '下午第二大节'], [5, '晚上第一大节']
].forEach(([p, want]) => {
  const o = run({ period: p, name: 'X', groupScope: '' }, [], []);
  const got = o.courseInfoText.split('\n')[1];
  chk(got === want, 'period=' + p + ' → ' + want);
});

// 变异自证：把 isPublic 判定改坏（PUBLIC 不算公假）必须被场景2抓到
const badSrc = m[1].replace("=== 'PUBLIC'", "=== 'NEVER'");
chk(badSrc !== m[1], '变异锚点命中（isPublic 判定可替换）');
const badRunner = new Function(
  'util', 'bigPeriodText',
  'return function(s, roster, leaveList) {'
  + '  var out = null; var self = { data: {}, setData: function(o){ out = o; } };'
  + '  (function(){' + badSrc.replace(/this\.setData/g, 'self.setData') + '\n  }).call(self, s, roster, leaveList);'
  + '  return out; };'
)(utilStub, bigPeriodText);
const badOut = badRunner(s, roster, [mkLeave('张三', '000000000346', 'PUBLIC')]);
const badLines = badOut.courseInfoText.split('\n');
chk(badLines.indexOf('公假人员:') < 0 && badLines.indexOf('请假人员：') >= 0,
  '变异「PUBLIC 不算公假」被抓：公假人员段消失、该人落到请假段');

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 课堂情况新模板 真跑 + 变异自证 全部通过');
