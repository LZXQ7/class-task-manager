#!/usr/bin/env node
/**
 * 门禁：启动后预热五个 tab 页首屏数据，切页秒显（2026-11-28）
 * ------------------------------------------------------------------
 * 用户诉求：小程序打开后五个页面都开始加载，而不是点开哪个页面才加载哪个；
 * 首页加载完想看值日/课表还要再等。微信小程序原生机制下 tab 页只有点开才创建，
 * 故采用「登录后预热五页首屏数据到 req-cache / mem / notice」实现切页秒显。
 *
 * 判据（vm 真跑 _prefetchTabs + 变异自证）：
 *   A. 从 app.js 提取 _prefetchTabs 函数体，mock api/mem/notice 在 vm 里真跑，
 *      记录所有 api.* 预热调用（方法名 + payload + opt）。
 *   B. 五页首屏数据都必须被预热：
 *      首页  dutyToday / electiveList / homeworkFeed / msgList
 *      课表  classList / courseAllSessions / electiveList
 *      信息  memberStats / feeSummary / classList / countdownList
 *      值日  scheduleListWeek / speechList（且 classId 与页面同口径）
 *      我的  dutyMyStats
 *   C. 启动不阻塞：所有预热 toast:false、不 await、失败 catch 吞掉。
 *   D. 变异自证：去掉任一页的关键预热 ⇒ 对应断言必须翻红。
 *
 * 用法：node scripts/check-startup-prefetch-tabs.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'miniprogram/app.js');

let fail = 0;
function check(label, cond, extra) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   -> ' + extra : ''));
}

/** 从 app.js 源码提取 _prefetchTabs 的函数体（到下一个方法定义前） */
function extractPrefetch(src) {
  const m = src.match(/  _prefetchTabs\(\) \{([\s\S]*?)\n  \},\n/);
  if (!m) throw new Error('app.js 找不到 _prefetchTabs 函数体');
  return m[1];
}

/**
 * 在 vm 里真跑 _prefetchTabs。
 * @param {string} appSrc app.js 源码
 * @param {object} opt { mutate: (body)=>string } 可选的源码变异，用于自证
 */
function runPrefetch(appSrc, opt) {
  opt = opt || {};
  let body = extractPrefetch(appSrc);
  if (typeof opt.mutate === 'function') body = opt.mutate(body);

  const calls = [];
  const api = {};
  const API_METHODS = [
    'dutyToday', 'electiveList', 'homeworkFeed', 'classList',
    'courseAllSessions', 'memberStats', 'feeSummary', 'countdownList',
    'scheduleListWeek', 'speechList', 'dutyMyStats', 'adjustPending',
    'aiSettingGet', 'testAccountList', 'msgList', 'leaveBoard',
    'leaveSummary', 'pinList', 'appNoticeLatest'
  ];
  API_METHODS.forEach((name) => {
    api[name] = function (payload, options) {
      calls.push({ name, payload: payload || {}, opt: options || {} });
      return Promise.resolve({ __prefetch: name });
    };
  });

  const memStore = {};
  const mem = {
    keys: {
      duty: (w) => 'duty:' + w,
      classinfo: (c) => 'classinfo:' + c,
      classList: () => 'classList',
      myClass: (m) => 'myClass:' + m
    },
    read: (k) => memStore[k] || null,
    write: (k, v) => { memStore[k] = v; }
  };
  const noticeStore = {};
  const notice = {
    read: () => noticeStore.list || null,
    write: (l) => { noticeStore.list = l; }
  };

  const profile = { id: 7, classId: 3, role: 'ADMIN', position: '生活委员', groupTag: 'A' };
  const g = {
    profile,
    config: { currentWeek: 8, classId: 3 },
    viewClassId: 0,
    switched: false,
    demo: false
  };
  const app = { globalData: g };

  const ctx = {
    api, mem, notice,
    getApp: () => app,
    console: { warn() {}, error() {}, log() {} },
    Promise
  };
  vm.createContext(ctx);
  const runner = vm.runInContext(
    '(function(self){ const fn = function(){' + body + '\n}; fn.call(self); })',
    ctx
  );
  runner(app);
  return calls;
}

const appSrc = fs.readFileSync(APP, 'utf8');
const calls = runPrefetch(appSrc);
const names = calls.map((c) => c.name);
const has = (n) => names.indexOf(n) >= 0;

console.log('== 预热调用（原样） ==');
console.log(names.join(', ') || '(空)');
console.log('');

/* ---- B. 五页首屏数据覆盖 ---- */
check('首页 dutyToday 已预热', has('dutyToday'));
check('首页 electiveList 已预热', has('electiveList'));
check('首页 homeworkFeed 已预热', has('homeworkFeed'));
check('首页 msgList 已预热（通知角标/弹窗）', has('msgList'));

check('课表 classList 已预热', has('classList'));
check('课表 courseAllSessions 已预热', has('courseAllSessions'));

check('信息 memberStats 已预热', has('memberStats'));
check('信息 feeSummary 已预热', has('feeSummary'));
check('信息 countdownList 已预热', has('countdownList'));

check('值日 scheduleListWeek 已预热', has('scheduleListWeek'));
check('值日 speechList 已预热', has('speechList'));

check('我的 dutyMyStats 已预热', has('dutyMyStats'));

/* ---- B2. payload 口径 ---- */
const weekCall = calls.find((c) => c.name === 'scheduleListWeek');
check('值日预热 week 与 config.currentWeek 对齐', weekCall && weekCall.payload.week === 8,
  weekCall ? JSON.stringify(weekCall.payload) : '无调用');
const cidCall = calls.find((c) => c.name === 'courseAllSessions');
check('课表预热带 classId（与页面 _afterAuth 同口径）', cidCall && Number(cidCall.payload.classId) === 3,
  cidCall ? JSON.stringify(cidCall.payload) : '无调用');

/* ---- C. 启动不阻塞：全部 toast:false、有 catch ---- */
check('所有预热均 toast:false', calls.length > 0 && calls.every((c) => c.opt.toast === false));
check('_prefetchTabs 函数体用 try/catch 包裹（失败吞掉）',
  /try\s*\{[\s\S]*catch\s*\(/.test(extractPrefetch(appSrc)));

/* ---- C2. req-cache key 一致性：预热 payload 与页面首开逐字对齐 ----
 * 这是「切页秒显」能否真正生效的核心：key 不一致则预热结果页面读不到，白预热。
 * 用真实 req-cache.js 的 makeKey（vm 加载，注入 profile/viewClassId），
 * 逐个比对「预热 payload」与「页面首开 payload」算出的 key。 */
console.log('\n== req-cache key 一致性（预热 vs 页面首开） ==');
const REQCACHE = path.join(ROOT, 'miniprogram/utils/req-cache.js');
try {
  const rcSrc = fs.readFileSync(REQCACHE, 'utf8');
  const rcCtx = {
    getApp: () => ({
      globalData: { profile: { id: 7, classId: 3 }, viewClassId: 0, switched: false, demo: false }
    }),
    Date, console, module: { exports: {} }
  };
  vm.createContext(rcCtx);
  vm.runInContext(rcSrc + '\n;globalThis.__mk = makeKey;', rcCtx);
  const mk = rcCtx.__mk;
  // [标签, name, action, 预热 payload, 页面首开 payload] —— 冷启动普通成员口径(viewClassId=0)
  const KEY_PAIRS = [
    ['首页 dutyToday', 'duty', 'today', { classId: 3 }, { classId: 3 }],
    ['首页 homeworkFeed', 'homework', 'feed', { classId: 3 }, { classId: 3 }],
    ['课表 courseAllSessions', 'course', 'allSessions', { classId: 3 }, { classId: 3 }],
    ['信息 memberStats(普通成员)', 'member', 'stats', {}, {}],
    ['信息 feeSummary(普通成员)', 'fee', 'getSummary', {}, {}],
    ['值日 scheduleListWeek', 'schedule', 'listWeek',
      { week: 8, classId: undefined }, { week: 8, classId: undefined }],
    ['值日 speechList', 'schedule', 'speechList',
      { week: 8, classId: undefined }, { week: 8, classId: undefined }],
    ['我的 dutyMyStats', 'duty', 'myStats', {}, {}]
  ];
  KEY_PAIRS.forEach(([label, n, a, pPre, pPage]) => {
    check('key 对齐：' + label, mk(n, a, pPre) === mk(n, a, pPage));
  });
} catch (e) {
  check('req-cache key 一致性可计算', false, e.message);
}

/* ---- D. 变异自证 ---- */
console.log('\n== 变异自证 ==');
const mutations = [
  {
    label: '去掉值日 scheduleListWeek 预热必须翻红',
    mutate: (b) => b.replace(/api\.scheduleListWeek\(/g, 'api.__noop('),
    expectFail: 'scheduleListWeek'
  },
  {
    label: '去掉课表 courseAllSessions 预热必须翻红',
    mutate: (b) => b.replace(/api\.courseAllSessions\(/g, 'api.__noop('),
    expectFail: 'courseAllSessions'
  },
  {
    label: '去掉信息 memberStats 预热必须翻红',
    mutate: (b) => b.replace(/api\.memberStats\(/g, 'api.__noop('),
    expectFail: 'memberStats'
  },
  {
    label: '去掉我的 dutyMyStats 预热必须翻红',
    mutate: (b) => b.replace(/api\.dutyMyStats\(/g, 'api.__noop('),
    expectFail: 'dutyMyStats'
  }
];
mutations.forEach((m) => {
  try {
    const mutated = runPrefetch(appSrc, { mutate: m.mutate });
    const stillHas = mutated.map((c) => c.name).indexOf(m.expectFail) >= 0;
    check(m.label, !stillHas, stillHas ? '变异后仍存在 ' + m.expectFail : '');
  } catch (e) {
    check(m.label, false, '变异执行抛错：' + e.message);
  }
});

console.log('\n结果：失败 ' + fail + ' 项');
process.exitCode = fail ? 1 : 0;
