#!/usr/bin/env node
/**
 * 离线自检：保洁（打扫 410）的对外口径
 * ------------------------------------------------------------
 * 保洁是 5 条 session(kind='CLEAN')，挂在周一~周五第 4 节上，只是为了有个排班位。
 * 对外一律说「18点前」——学生看到「第 4 节打扫 410」会以为是去上课。
 *
 * 这个脚本把口径钉死在几个容易改回去的地方：
 *   ① util.whenText() 的映射；
 *   ② 云函数提醒文案（cron-weekly）+ 订阅模板字段名（thing1/thing5/thing8）；
 *   ③ 前端模板 ID 与文档里的 ID 是否一致（两处不一致 = 用户授权 A 却发 B，报 47003）。
 *
 * 用法：node scripts/check-clean-label.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function eq(actual, expect, msg) {
  if (actual === expect) ok(msg + '   → ' + JSON.stringify(actual));
  else bad(msg + '   → 实际 ' + JSON.stringify(actual) + '，期望 ' + JSON.stringify(expect));
}

/* ---------- ① util.whenText ---------- */
console.log('── 前端文案单一来源 miniprogram/utils/util.js');
const util = require(path.join(ROOT, 'miniprogram/utils/util.js'));
eq(typeof util.whenText, 'function', 'util.whenText 已导出');
[1, 2, 3, 4, 5].forEach((p) => {
  eq(util.whenText('CLEAN', p), '18点前', '保洁第 ' + p + ' 节一律显示「18点前」');
});
[1, 3, 5].forEach((p) => {
  eq(util.whenText('COURSE', p), '第' + p + '节', '普通课程第 ' + p + ' 节显示「第N节」');
});
eq(util.whenText(undefined, 4), '第4节', 'kind 缺失时按普通课程处理（老数据兜底）');

/* ---------- ② 云函数提醒文案 + 模板字段 ---------- */
console.log('\n── 服务端提醒 cloudfunctions/cron-weekly/index.js');
const cron = read('cloudfunctions/cron-weekly/index.js');

if (/'CLEAN'\)\s*\{\s*[\s\S]{0,160}cur\.items\.push\('18点前'/.test(cron)) {
  ok('保洁提醒文案动态拼接 courseName（周二=410大扫除，其余=打扫410）');
} else {
  bad('保洁提醒文案没有以「18点前」开头（被人改回「第N节」或删了拼接？）');
}
if (/'18点前'\s*\+\s*\(?\s*r\.courseName\s*\|\|\s*'打扫410'\s*\)?/.test(cron)) {
  ok('保洁提醒文案取自 r.courseName（不再写死「打扫410」）');
} else {
  bad('保洁提醒文案没有用 r.courseName 拼装（写死会导致周二不显示「410大扫除」）');
}
if (!/第'\s*\+\s*r\.period\s*\+\s*'节.*sessionKind === 'CLEAN'/.test(cron)) {
  ok('提醒里没有「第N节」+保洁的旧拼接');
} else {
  bad('提醒里仍有「第N节」拼接保洁的旧写法');
}

const fields = /const REMIND_FIELDS = \{([\s\S]*?)\};/.exec(cron);
if (!fields) {
  bad('找不到 REMIND_FIELDS 定义');
} else {
  const body = fields[1];
  eq(/title:\s*process\.env\.TEMPLATE_REMIND_F_TITLE\s*\|\|\s*'([^']+)'/.exec(body)?.[1], 'thing1', '默认字段 日程主题 = thing1');
  eq(/digest:\s*process\.env\.TEMPLATE_REMIND_F_DIGEST\s*\|\|\s*'([^']+)'/.exec(body)?.[1], 'thing5', '默认字段 备注 = thing5');
  eq(/course:\s*process\.env\.TEMPLATE_REMIND_F_COURSE\s*\|\|\s*'([^']+)'/.exec(body)?.[1], 'thing8', '默认字段 课程名称 = thing8');
  eq(/date:\s*process\.env\.TEMPLATE_REMIND_F_DATE\s*\|\|\s*'([^']*)'/.exec(body)?.[1], '', '日期字段默认留空（多传模板没有的字段会 47003）');
}
if (/if \(f\.date\) data\[f\.date\]/.test(cron)) {
  ok('日期字段按需发送（未配置就不发送）');
} else {
  bad('日期字段是无条件发送的：模板没有该关键词时会 47003');
}

/* ---------- ③ 模板 ID 前后端/文档一致 ---------- */
console.log('\n── 订阅模板 ID 三处一致');
const cfg = read('miniprogram/utils/config.js');
const doc = read('docs/微信订阅消息接入指引.md');
const cfgId = /const SUBSCRIBE_TEMPLATE_ID = '([^']*)'/.exec(cfg)?.[1] || '';
if (!cfgId) bad('miniprogram/utils/config.js 的 SUBSCRIBE_TEMPLATE_ID 为空（所有提醒入口会静默降级）');
else ok('前端模板 ID 已配置   → ' + cfgId);
if (cfgId && doc.includes(cfgId)) ok('文档 docs/微信订阅消息接入指引.md 里的模板 ID 与前端一致');
else bad('文档里的模板 ID 与前端不一致');

/* ---------- ④ 保洁展示落点没有残留硬编码 ---------- */
console.log('\n── 展示落点残留扫描');
const suspects = [
  ['miniprogram/pages/duty/index.wxml', /\{\{x\.period\}\}|\{\{z\.period\}\}/, '值日页应改用 whenText'],
  ['miniprogram/pages/duty/index.js', /'第' \+ x\.period \+ '节/, '导出长图应改用 whenText'],
  ['miniprogram/pages/manual/index.wxml', /\{\{s\.period\}\}/, '手动排班页应改用 whenText'],
  ['miniprogram/components/duty-sheet/index.wxml', /detail\.duty\.period\}/, '值日详情应改用 whenText'],
  ['miniprogram/pages/home/index.js', /'第 ' \+ myDuty\.period \+ ' 节'/, '首页 Hero 应改用 whenText']
];
suspects.forEach(([file, re, tip]) => {
  const src = read(file);
  if (re.test(src)) bad(file + ' 仍有 «第N节» 硬编码 —— ' + tip);
  else ok(file + ' 已无 «第N节» 硬编码');
});

/* ---------- ⑤ 后端确实回了 kind ---------- */
console.log('\n── 后端 kind 字段（前端据此判断保洁）');
const dutySrc = read('cloudfunctions/duty/index.js');
// 意图（不锁实现别名）：返回对象的 kind 必须来自 session 表的 kind 列。
// duty 表**没有** kind 列，SQL 必须 `s.kind AS <别名>`，代码读 `d.<别名>`；写成 `d.kind` 会 1054。
// 这里从源码里解析出别名再数读取点 → 换别名不会误红，但「删掉 kind 回传」或「读错列」仍翻红。
const kindAlias = (/s\.kind\s+AS\s+(\w+)/i.exec(dutySrc) || [])[1] || '';
const dutyKindHits = kindAlias
  ? (dutySrc.match(new RegExp("kind:\\s*d\\." + kindAlias + "\\s*\\|\\|\\s*'COURSE'", 'g')) || []).length
  : 0;
if (!/s\.kind/.test(dutySrc)) bad('cloudfunctions/duty/index.js 的 SELECT 没取 s.kind');
else if (dutyKindHits >= 2) ok('duty.today/myList/detail 回传了 kind（读别名 d.' + kindAlias + '）   → ' + dutyKindHits + ' 处');
else bad('cloudfunctions/duty/index.js 只回了 ' + dutyKindHits + ' 处 kind（应读别名 d.' + kindAlias + '），today 与 detail 应各一处');

const kindSites = [
  ['cloudfunctions/schedule/index.js', /kind: s\.kind \|\| 'COURSE'/, 'schedule.manualBoard 的 session 回传 kind'],
  ['cloudfunctions/adjust/index.js', /kind: r\.sessionKind \|\| 'COURSE'/, 'adjust.listMine 回传 kind']
];
kindSites.forEach(([file, re, tip]) => {
  if (re.test(read(file))) ok(tip);
  else bad(file + ' 未回传 kind —— ' + tip);
});

/* ---------- ⑥ 值日提醒双时段（v0.7.15：21:00 预告明天 + 07:00 提醒今天） ---------- */
console.log('\n── 值日提醒双时段（21:00 明天 / 07:00 今天）');

if (/async function remindDuty\(pool, when\)/.test(cron)) {
  ok('提醒实现收敛为 remindDuty(pool, when)（两条提醒同源，不各抄一份）');
} else {
  bad('找不到 remindDuty(pool, when) —— 两条提醒若各写一份，文案与字段必然漂移');
}
if (!/remindTomorrow/.test(cron)) ok('旧函数名 remindTomorrow 已无残留（不会留下两套实现）');
else bad('仍有 remindTomorrow 残留（新旧两套并存）');

if (/result\.remind = await remindDuty\(pool, 'tomorrow'\)/.test(cron)) ok('触发分支 remind → remindDuty(tomorrow)');
else bad('remind 分支没有走 remindDuty(tomorrow)');
/*
 * `remindAM` 分支形态（2026-10-12 额度优化后变了）：
 *   原来是一行 `result.remindAM = await remindDuty(pool, 'today')`，
 *   现在套了 `REMIND_MODE` 开关（默认 evening = 每天只发一条，省额度），
 *   中间多了一大段注释 ⇒ 旧的 `[\s\S]{0,300}` 窗口**会被注释顶出窗口**而假红。
 * ⚠️ 所以这里放宽窗口，并且**额外锁住开关本身**：默认必须不发（省额度），
 *    且 morning/both 仍能打开 —— 三件事都判，否则「省额度」和「还能切回去」会被回退掉。
 */
const amBranch = /trigger === 'remindAM'\) \{([\s\S]*?)\n    \} else/.exec(cron);
if (amBranch && /remindDuty\(pool, 'today'\)/.test(amBranch[1])) {
  ok('触发分支 remindAM 仍会调 remindDuty(today)（REMIND_MODE 打开时 07:00 那条能跑到）');
} else {
  bad('缺少 remindAM → remindDuty(today)（07:00 的提醒永远发不出去）');
}
if (/process\.env\.REMIND_MODE \|\| 'evening'/.test(cron)) {
  ok('额度优化开关存在：REMIND_MODE 默认 evening（每天只发一条 ⇒ 额度需求减半）');
} else {
  bad('没有 REMIND_MODE 开关（或默认值不是 evening）—— 21:00 与 07:00 会各烧一个额度');
}
if (/rmode === 'morning' \|\| rmode === 'both'/.test(cron)) {
  ok('REMIND_MODE 保留了 morning / both（想恢复两条随时可切，不必改代码）');
} else {
  bad('REMIND_MODE 没保留 morning/both ⇒ 一旦要改回两条提醒只能改代码重新部署');
}
if (/c\.room AS room/.test(cron)) ok('提醒 SQL 取出了 course.room（教室的唯一来源）');
else bad('提醒 SQL 没有取 course.room —— 文案里的「教室」会一直缺失');
// 触发器清单（文档与线上必须一致；createFunctionTrigger 是整体覆盖语义，漏传即被删）
const deployMd = read('scripts/deploy.md');
if (/remindAM/.test(deployMd) && /0 0 7 \* \* \* \*/.test(deployMd)) ok('部署手册登记了 remindAM / `0 0 7 * * * *`');
else bad('部署手册没登记 remindAM 触发器（补建时会漏传 → 07:00 不生效）');

/* —— 「额度耗尽」回环（v0.7.15）：一次性订阅没有长期通道，额度用尽后发送静默失败，
      学生完全无感知 —— 必须把失败写回库，前端才能把人拉回来重新授权。 —— */
console.log('  ── 额度耗尽回环（remind_block）');
if (/UPDATE member SET remind_block = 0/.test(cron) && /UPDATE member SET remind_block = 1/.test(cron)) {
  ok('cron-weekly 写 remind_block：发送成功清 0、43101 置 1');
} else {
  bad('cron-weekly 没有维护 remind_block（额度耗尽后学生无感知，07:00 那条会一直静默失败）');
}
if (/remindReopen/.test(read('cloudfunctions/member/index.js'))) ok('member.remindReopen：学生重新授权后自助清标记（只写自己的行，无越权面）');
else bad('缺少 member.remindReopen（重新授权后标记清不掉，提示会一直挂着）');
if (/remindReopen/.test(read('miniprogram/utils/api.js'))) ok('前端 api.remindReopen 已登记（check-api 校验过云函数路由映射）');
else bad('前端 api.js 缺 remindReopen（点了「重新开启」标记清不掉）');
if (/remindBlock/.test(read('cloudfunctions/duty/index.js'))) ok('duty.today 回传 member.remindBlock（首页读取通道）');
else bad('duty.today 没回传 remindBlock（首页拿不到失效状态）');
if (/remindBlock/.test(read('cloudfunctions/auth/index.js'))) ok('auth.login 回传 member.remindBlock（「我的」页读取通道）');
else bad('auth.login 没回传 remindBlock（「我的」页拿不到失效状态）');
/* 2026-10-16：系统日历 + 值日微信提醒 + 首页通知入口已整体下线（用户反馈从未生效）。
 * 后端 member.remind_block / remindReopen 字段与云函数逻辑暂留（死数据，零迁移风险），
 * 由上方 duty.today / auth.login 的 remindBlock 静态断言 + member.remindReopen 变异自证继续看守。 */

/*
 * 运行时自证：桩化 require 后**真跑 exports.main**。
 * 用真源码（不是副本）+ 真 week 模块（日期时区口径不重写），
 * 只有 DB / 云调用 / 排班内核被替换成桩 —— 这样文案与聚合逻辑是"真"的。
 */
(async () => {
  const realWeek = require(path.join(ROOT, 'cloudfunctions/common/week.js'));
  const cronSrc = read('cloudfunctions/cron-weekly/index.js');

  const dutyRows = [
    { id: 1, openid: 'oA', name: '甲', period: 2, sessionKind: 'COURSE', courseName: '大学英语', room: '410' },
    { id: 2, openid: 'oA', name: '甲', period: 4, sessionKind: 'CLEAN',  courseName: '打扫410', room: '410' },
    { id: 3, openid: 'oB', name: '乙', period: 3, sessionKind: 'COURSE', courseName: '高等数学', room: null }
  ];

  /** 跑一次真实 exports.main({TriggerName})；返回 { result, sends, dates } */
  async function run(trigger, opts) {
    const o = opts || {};
    const sends = [];
    const dates = [];
    const stmts = [];
    const pool = {
      query: (sql, args) => {
        if (/FROM duty/.test(sql)) { dates.push(String(args[0])); return Promise.resolve([o.rows || dutyRows]); }
        stmts.push({ sql: String(sql), args: args || [] });
        return Promise.resolve([{ affectedRows: 1 }]);
      }
    };
    const cloudStub = {
      DYNAMIC_CURRENT_ENV: 'dyn',
      init() {},
      openapi: {
        subscribeMessage: {
          send: (payload) => {
            if (o.fail) { const e = new Error('user refuse'); e.errCode = 43101; throw e; }
            sends.push(payload);
          }
        }
      }
    };
    const fakeRequire = (name) => {
      if (name === 'wx-server-sdk') return cloudStub;
      if (name === './common/db') return { getPool: () => pool };
      if (name === './common/week') return realWeek;
      if (name === './common/schedule-core') {
        return { rotationPick: () => ({ chosen: [], short: 0, wrapped: false }), loadDayBlocks: () => Promise.resolve([]) };
      }
      // 测试账号条件是 common 唯一真源（无状态）⇒ 直接 require 真的，不在门禁里抄第二份
      if (name === './common/test-account') {
        return require(path.join(ROOT, 'cloudfunctions', 'common', 'test-account.js'));
      }
      throw new Error('意外的 require：' + name);
    };
    const saved = {
      tpl: process.env.TEMPLATE_REMIND,
      t1: process.env.TEMPLATE_REMIND_F_TITLE,
      t5: process.env.TEMPLATE_REMIND_F_DIGEST,
      t8: process.env.TEMPLATE_REMIND_F_COURSE,
      rmode: process.env.REMIND_MODE
    };
    if (o.noTemplate) process.env.TEMPLATE_REMIND = '';
    else process.env.TEMPLATE_REMIND = 'TPL_TEST';
    // 走默认字段名（thing1/thing5/thing8），确保断言的键名就是线上默认口径
    delete process.env.TEMPLATE_REMIND_F_TITLE;
    delete process.env.TEMPLATE_REMIND_F_DIGEST;
    delete process.env.TEMPLATE_REMIND_F_COURSE;
    /*
     * 额度优化开关 REMIND_MODE（2026-10-12）：不传 = 删除该变量 ⇒ 走代码默认
     * （`|| 'evening'` = 每天只发一条 21:00）；传 'both'/'morning' 才恢复 07:00 那条。
     * ⚠️ 断言 07:00 那条的**文案**时必须显式传 remindMode:'both'，否则默认态根本不发消息、
     *    断言会在 undefined 上崩（或变异断言假通过）。
     */
    if (o.remindMode === undefined) delete process.env.REMIND_MODE;
    else process.env.REMIND_MODE = o.remindMode;
    const mod = { exports: {} };
    try {
      new Function('require', 'module', 'exports', 'process', 'console', o.src || cronSrc)(
        fakeRequire, mod, mod.exports, process, { log() {}, error() {} }
      );
      const result = await mod.exports.main({ TriggerName: trigger });
      return { result, sends, dates, stmts };
    } finally {
      const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
      put('TEMPLATE_REMIND', saved.tpl);
      put('TEMPLATE_REMIND_F_TITLE', saved.t1);
      put('TEMPLATE_REMIND_F_DIGEST', saved.t5);
      put('TEMPLATE_REMIND_F_COURSE', saved.t8);
      put('REMIND_MODE', saved.rmode);
    }
  }

  const TOMORROW = realWeek.fmtDate(new Date(Date.now() + 86400000));
  const TODAY = realWeek.todayStr();
  const EXPECT_A = '第2节410、18点前打扫410';

  const r1 = await run('remind');
  eq(r1.dates[0], TOMORROW, '21:00 那条取的是「明天」（东八区）');
  eq(r1.sends.length, 2, '一人一条：2 位同学 → 2 条推送（同人两节课 + 保洁已合并）');
  const a1 = (r1.sends.find(s => s.touser === 'oA') || {}).data || {};
  const b1 = (r1.sends.find(s => s.touser === 'oB') || {}).data || {};
  eq((a1.thing1 || {}).value, '明天有 2 项值日', '21:00：日程主题 =「明天有 N 项值日」');
  eq((a1.thing5 || {}).value, EXPECT_A, '21:00：备注(thing5) = 具体课次 + 教室（保洁仍走「18点前打扫410」口径）');
  eq((a1.thing8 || {}).value, '大学英语', '21:00：课程名单独放「课程名称(thing8)」格（与课次/教室分装，避免 20 字截断）');
  eq((b1.thing5 || {}).value, '第3节', '教室为空时只写节次，不拿课程名去顶');
  eq((b1.thing8 || {}).value, '高等数学', '教室为空的同学，课程名照旧保留在「课程名称(thing8)」格');
  eq((r1.sends[0] || {}).page, 'pages/duty/index', '点击通知落到值日页');

  /* 周二保洁（courseName=410大扫除）：提醒文案应为「18点前410大扫除」，而非「18点前打扫410」 */
  {
    const tueRows = [
      { id: 9, openid: 'oT', name: '丁', period: 4, sessionKind: 'CLEAN', courseName: '410大扫除', room: '410' }
    ];
    const rt = await run('remind', { rows: tueRows });
    const tData = ((rt.sends.find(s => s.touser === 'oT') || {}).data || {});
    eq(tData.thing5.value, '18点前410大扫除', '周二保洁提醒文案=「18点前410大扫除」');
    /* 「课程名称」格：纯保洁日 courses 为空 → 必须拿当天保洁课次名顶格，
       不能退回「打扫410」（否则周二同学收到的通知仍是旧名）。 */
    eq(tData.thing8.value, '410大扫除', '周二纯保洁日：课程名称(thing8) 顶格=「410大扫除」');
  }

  /* 周一保洁（courseName=打扫410）：口径必须保持原样，不能被周二的改动带跑 */
  {
    const monRows = [
      { id: 10, openid: 'oM', name: '戊', period: 4, sessionKind: 'CLEAN', courseName: '打扫410', room: '410' }
    ];
    const rm = await run('remind', { rows: monRows });
    const mData = ((rm.sends.find(s => s.touser === 'oM') || {}).data || {});
    eq(mData.thing5.value, '18点前打扫410', '周一保洁提醒文案仍是「18点前打扫410」');
    eq(mData.thing8.value, '打扫410', '周一纯保洁日：课程名称(thing8) 仍是「打扫410」');
  }

  /* 混合日（课程值日 + 周二保洁）：「课程名称」格只写课程名，不能被保洁名污染 */
  {
    const mixRows = [
      { id: 11, openid: 'oX', name: '己', period: 2, sessionKind: 'COURSE', courseName: '大学英语', room: '410' },
      { id: 12, openid: 'oX', name: '己', period: 4, sessionKind: 'CLEAN', courseName: '410大扫除', room: '410' }
    ];
    const rx = await run('remind', { rows: mixRows });
    const xData = ((rx.sends.find(s => s.touser === 'oX') || {}).data || {});
    eq(xData.thing8.value, '大学英语', '混合日：课程名称(thing8) 只写课程名（保洁名不进这一格）');
    eq(xData.thing5.value, '第2节410、18点前410大扫除', '混合日：备注(thing5) 同时含课次与周二保洁名');
  }

  /* 07:00 那条：额度优化后**默认不发**，所以内容断言必须显式打开开关（REMIND_MODE=both），
     否则会在 undefined 上崩；而「默认不发」本身要单独断言（那才是省额度的落点）。 */
  const r2off = await run('remindAM');
  eq(r2off.sends.length, 0, '默认（REMIND_MODE 未设 = evening）：07:00 那条**不发**，额度不被二次消耗');
  eq((r2off.result.data.remindAM || {}).skipped, true, '默认态返回 skipped（可观测，不是静默不出声）');

  const r2 = await run('remindAM', { remindMode: 'both' });
  eq(r2.dates[0], TODAY, '开关打开时：07:00 那条取的是「今天」（东八区）');
  eq(((r2.sends.find(s => s.touser === 'oA') || {}).data || {}).thing1.value, '今天有 2 项值日', '开关打开时：07:00 日程主题 =「今天有 N 项值日」');
  eq(r2.sends.length, 2, '开关打开时：07:00 那条同样一人一条（不重复发）');

  const r3 = await run('remind', { fail: true });
  eq((r3.result.data.remind || {}).refused, 2, '43101（未订阅 / 额度用尽）计入 refused');
  eq((r3.result.data.remind || {}).failed, 0, '43101 不当作错误上报');

  const r4 = await run('remind', { rows: [] });
  eq(r4.sends.length, 0, '当天没人值日 → 一条都不发');
  eq((r4.result.data.remind || {}).receivers, 0, 'receivers = 0');

  const r5 = await run('remind', { noTemplate: true });
  eq((r5.result.data.remind || {}).skipped, true, 'TEMPLATE_REMIND 未配置 → 安全跳过，不影响其它定时任务');

  /* 变异必抓：把「教室」从文案拼装里去掉，上面那条期望值必须不再成立 */
  const mutant = await run('remind', { src: cronSrc.replace("'第' + r.period + '节' + room", "'第' + r.period + '节'") });
  const am = ((mutant.sends.find(s => s.touser === 'oA') || {}).data || {}).thing5 || {};
  if (am.value && am.value !== EXPECT_A) ok('变异必抓：去掉教室拼接后备注变成「' + am.value + '」—— 与期望值不同，断言确实在守它');
  else bad('变异校验失效：改掉教室拼接后输出没变（断言抓不住）');

  /* 变异必抓：把 07:00 那条误写成「明天」（必须开着开关跑，否则变异体会因「不发消息」而假通过） */
  const mutant2 = await run('remindAM', { remindMode: 'both', src: cronSrc.replace("await remindDuty(pool, 'today')", "await remindDuty(pool, 'tomorrow')") });
  if (mutant2.dates[0] !== TODAY) ok('变异必抓：07:00 那条若误用「明天」，取到的日期就不是今天 → 被抓');
  else bad('变异校验失效：07:00 用错日期也看不出来');

  /* —— 「额度耗尽回环」运行时自证：发送后库里必须有对应的 remind_block 写入 —— */
  console.log('  ── 额度耗尽回环（运行时：发送 → 写 remind_block）');
  const blockStmt = (stmts, val) => stmts.find((s) => new RegExp('UPDATE member SET remind_block = ' + val + ' WHERE openid').test(s.sql));
  eq((r1.result.data.remind || {}).blockClear, 2, '发送成功 → 返回体 blockClear = 2');
  eq((r1.result.data.remind || {}).blockSet, 0, '发送成功 → 返回体 blockSet = 0');
  const clearStmt = blockStmt(r1.stmts, 0);
  if (clearStmt) {
    eq(clearStmt.args.join(','), 'oA,oB', '发送成功后清标记：批量 UPDATE 只圈中发送成功的 openid');
  } else {
    bad('发送成功后没有写 remind_block = 0（之前误标的学生永远解除不了「已失效」状态）');
  }
  if (!blockStmt(r1.stmts, 1)) ok('全部发送成功时，不会误置任何人的 remind_block = 1');
  else bad('发送成功却写了 remind_block = 1（成功被当成额度耗尽）');

  eq((r3.result.data.remind || {}).blockSet, 2, '全部 43101 → 返回体 blockSet = 2');
  const setStmt = blockStmt(r3.stmts, 1);
  if (setStmt) {
    eq(setStmt.args.join(','), 'oA,oB', '43101 后置标记：批量 UPDATE 圈中所有被拒的 openid');
  } else {
    bad('43101 后没有写 remind_block = 1（额度耗尽回环断裂，学生永远无感知）');
  }
  if (!blockStmt(r3.stmts, 0)) ok('全部被拒时，不会误清任何人的 remind_block');
  else bad('43101 却写了 remind_block = 0（失效状态被洗掉）');

  /* 变异必抓：删掉 remind_block = 1 的写入，上面的运行时断言必须不再成立 */
  const mutSrc3 = cronSrc.replace('UPDATE member SET remind_block = 1 WHERE openid', 'UPDATE member SET remind_x = 1 WHERE openid');
  const mutant3 = await run('remind', { fail: true, src: mutSrc3 });
  if (!blockStmt(mutant3.stmts, 1)) ok('变异必抓：删掉置 1 写入后 stmts 里再无 remind_block = 1 → 被抓');
  else bad('变异校验失效：置 1 写入被删也看不出来');

  /* 变异必抓：静态断言守 member.remindReopen —— 把真实源码里的 remindReopen 摘掉，断言必须翻车 */
  {
    const memberSrc = read('cloudfunctions/member/index.js');
    const mutMember = memberSrc.split('remindReopen').join('remindOpen');
    if (!/remindReopen/.test(mutMember) && /remindReopen/.test(memberSrc)) {
      ok('变异必抓：member 源码摘掉 remindReopen 后静态断言不再命中（证明该断言真的在读文件）');
    } else {
      bad('变异校验失效：remindReopen 静态断言对源码变化不敏感');
    }
  }

  console.log('\n' + (failed ? '❌ 失败 ' + failed + ' 项' : '全部通过 ✅'));
  process.exit(failed ? 1 : 0);
})();
