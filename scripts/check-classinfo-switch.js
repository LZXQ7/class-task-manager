#!/usr/bin/env node
/**
 * 门禁：班级信息页「教职工切班」（2026-10-28 需求）
 * ============================================================
 * 为什么用**动态执行**而不是静态正则：
 *   这次改动最容易回归的一条是「切班后 onShow 再跑 load 又被弹回主班」——
 *   代码里每个字都合法，静态断言完全看不出来，只有真跑一遍 data 才露馅。
 *   所以这里把 `pages/classinfo/index.js` 的 Page 定义真加载起来，mock 掉 5 个
 *   util 模块与 wx / getApp，然后按真实交互顺序调 load / onClassPick / onOpen。
 *
 * 锁住的六件事：
 *   ① 辅导员（groupTag='X'）：chips 建全、默认落主班、数据按 classId 拉
 *   ② 切班：参数真的换了、班名/人数/班费跟着换、isOtherClass 置位
 *   ③ 🔴 onShow 再跑 load 不被弹回主班（keep 分支）
 *   ④ 看别班时四张子卡 URL 都带 classId；通知额外带短名（后端支持按班查看，
 *      2026-10-28 起不再置灰/拦截）
 *   ⑤ 🔴 看本班时 URL 必须干净 —— roster 里 `otherClass: classId > 0`，
 *      带自己班 id 会被当成「查看别班」，语义就错了
 *   ⑥ 普通成员：不拉班级列表、请求不带 classId、无 chips
 *
 * 末尾带**五组变异自证**（全部在内存字符串上做，绝不写盘 —— 见 MEMORY 铁律）：
 * 每组把关键分支改坏，断言「必须翻红」，证明上面的用例不是空跑。
 *
 * 用法：node scripts/check-classinfo-switch.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'miniprogram/pages/classinfo/index.js');
const SRC = fs.readFileSync(FILE, 'utf8');

/* 生产库真实快照（2026-10-28 查库）：
 *   2601=57(29/28)  示例班级B=56(28/28)  示例班级A=59(30/29)  示例专业B3班=10  英语2601=20
 *   班费：只有 示例班级A 有 class_fund 行（total 280），其余班 loadFund 回落 0 */
const CLASSES = [
  { id: 1, name: '示例专业B1班' },
  { id: 2, name: '示例专业A2班' },
  { id: 3, name: '示例专业A1班' },
  { id: 9, name: '商务示例专业B2班' },
  { id: 10, name: '示例专业B2班' }
];
const STATS = {
  1: { total: 57, groupA: 29, groupB: 28 },
  2: { total: 56, groupA: 28, groupB: 28 },
  3: { total: 59, groupA: 30, groupB: 29 },
  9: { total: 10, groupA: 5, groupB: 5 },
  10: { total: 20, groupA: 10, groupB: 10 }
};
const OWN_示例班级A = '示例专业A1班';

function makeHarness(profile, opts, src) {
  const o = opts || {};
  const calls = { memberStats: [], feeSummary: [], classList: 0, nav: [], track: [], toast: [] };
  const app = {
    globalData: { profile, statusBarHeight: 20 },
    isSuper: () => !!o.isSuper,
    track: { action: (k, v) => calls.track.push([k, v]) },
    setTabBar: () => {}
  };
  const api = {
    classList: () => {
      calls.classList++;
      if (o.oneClass) return Promise.resolve([CLASSES[2]]);   // 只绑 1 个班
      return Promise.resolve(o.emptyClasses ? [] : CLASSES);
    },
    memberStats: (p) => {
      calls.memberStats.push(p || {});
      const id = Number((p && p.classId) || profile.classId || 0);
      return Promise.resolve(STATS[id] || { total: 0, groupA: 0, groupB: 0 });
    },
    feeSummary: (p) => {
      calls.feeSummary.push(p || {});
      const id = Number((p && p.classId) || profile.classId || 0);
      return Promise.resolve({ class: { total: id === 3 ? 280 : 0 } });
    }
  };
  const util = {
    classNameOf: (c) => String((c && c.name) || ''),
    sortClasses: (list) => (list || []).slice().sort((a, b) => a.id - b.id),
    toast: (t) => calls.toast.push(t)
  };
  const mocks = {
    '../../utils/api': api,
    '../../utils/util': util,
    '../../utils/notice': { read: () => null, unackedCount: () => 0 },
    '../../utils/page-anim': { playReady: () => {} },
    '../../utils/theme': { mount: () => {}, unmount: () => {} },
    /* 2026-10-28 性能优化：班级信息页引入 utils/mem 做 SWR 缓存。这里给一个**真实**的内存
     * 存储（每个 harness 一把），既能让 require 解析，也能真正跑一遍缓存逻辑：
     * 切回同一班 / 同班二次 onShow 应当命中缓存、少发请求，且不影响下面 12 个用例的断言。 */
    '../../utils/mem': (() => {
      const s = new Map();
      return {
        read: (k) => (s.has(k) ? s.get(k) : null),
        write: (k, v) => { s.set(k, v); },
        clear: (k) => { if (k) s.delete(k); else s.clear(); },
        keys: {
          home: (d) => 'home:' + d,
          duty: (w) => 'duty:' + w,
          manual: (w) => 'manual:' + w,
          roster: (c, kw) => 'roster:' + (Number(c) || 0) + ':' + (kw || ''),
          classinfo: (c) => 'ci:' + (Number(c) || 0),
          classList: () => 'classList'
        }
      };
    })()
  };
  const requireShim = (p) => {
    if (mocks[p]) return mocks[p];
    throw new Error('unexpected require ' + p);
  };
  const wx = {
    navigateTo: (x) => calls.nav.push(x.url),
    switchTab: (x) => calls.nav.push('TAB:' + x.url)
  };
  let captured = null;
  /* eslint-disable no-new-func */
  new Function('require', 'Page', 'getApp', 'wx', src)(
    requireShim,
    (obj) => { captured = obj; },
    () => app,
    wx
  );
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data));
  page.setData = function (patch) { Object.assign(this.data, patch); };
  return { page, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 12));

async function runAll(src, quiet) {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; if (!quiet) console.log('  ✓ ' + msg); }
    else { fail++; if (!quiet) console.log('  ✗ ' + msg); }
  };
  const head = (t) => { if (!quiet) console.log('\n' + t); };
  const counselor = { id: 72, classId: 3, className: OWN_示例班级A, groupTag: 'X' };

  head('① 辅导员进入页面（主班 示例班级A / id 3）');
  {
    const { page, calls } = makeHarness(counselor, {}, src);
    page.load(); await settle();
    ok(page.data.isStaff === true, 'isStaff = true');
    ok(page.data.classChips.length === 5, 'chips 建满 5 个班（= staffClassIds 范围）');
    ok(page.data.viewClassId === 3, '默认落主班 示例班级A，不是列表第一个');
    ok(page.data.className === OWN_示例班级A, '班名 = 示例班级A');
    ok(JSON.stringify(calls.memberStats[0]) === '{"classId":3}', 'memberStats 首次带 classId=3');
    ok(JSON.stringify(calls.feeSummary[0]) === '{"classId":3}', 'feeSummary 首次带 classId=3');
    ok(page.data.stats.total === 59, '显示 59 人（示例班级A 真实人数）');
    ok(page.data.feeTotal === 280, '班费显示 280');
    ok(page.data.isOtherClass === false, '看本班时 isOtherClass = false');
  }

  head('② 点 chips 切到 2601（id 1）');
  {
    const { page, calls } = makeHarness(counselor, {}, src);
    page.load(); await settle();
    page.onClassPick({ currentTarget: { dataset: { id: 1 } } }); await settle();
    const last = calls.memberStats[calls.memberStats.length - 1];
    ok(JSON.stringify(last) === '{"classId":1}', '切班后 memberStats 带 classId=1');
    ok(page.data.viewClassId === 1, 'viewClassId = 1');
    ok(page.data.className === '示例专业B1班', '班名跟着换成 2601');
    ok(page.data.stats.total === 57, '人数换成 57（与 示例班级A 的 59 不同）');
    ok(page.data.feeTotal === 0, '班费换成 2601 的 0（该班无 class_fund 行）');
    ok(page.data.isOtherClass === true, 'isOtherClass = true');
    ok(calls.track.some((t) => t[0] === 'class_switch'), '埋点 class_switch 已上报');
  }

  head('③ 🔴 onShow 再跑一次 load（切到 1 班后切走又回来）');
  {
    const { page, calls } = makeHarness(counselor, {}, src);
    page.load(); await settle();
    page.onClassPick({ currentTarget: { dataset: { id: 1 } } }); await settle();
    page.load(); await settle();          // onShow 每次都会跑
    ok(page.data.viewClassId === 1, '仍然是 1 班，没有被弹回主班');
    const last = calls.memberStats[calls.memberStats.length - 1];
    ok(JSON.stringify(last) === '{"classId":1}', '重拉的数据也是 1 班的');
  }

  head('④ 看别班时点子卡');
  {
    const { page, calls } = makeHarness(counselor, {}, src);
    page.load(); await settle();
    page.onClassPick({ currentTarget: { dataset: { id: 1 } } }); await settle();
    calls.nav.length = 0;
    ['roster', 'fee', 'homework', 'notice'].forEach((k) =>
      page.onOpen({ currentTarget: { dataset: { key: k } } }));
    ok(calls.nav[0] === '/pages/roster/index?classId=1', '成员页带 classId=1 → ' + calls.nav[0]);
    ok(calls.nav[1] === '/pages/fee/index?classId=1', '班费页带 classId=1 → ' + calls.nav[1]);
    ok(calls.nav[2] === '/pages/homework/index?classId=1', '作业页带 classId=1 → ' + calls.nav[2]);
    /* 2026-10-28：通知不再被拦（后端 msgList 支持按班查看），
     * 切到 2601 点通知 = 看 2601 的通知，URL 上带 id + 短名（导航标题用）。 */
    ok(calls.nav[3] === '/pages/notice/index?classId=1&name=2601%E7%8F%AD',
      '通知页带 classId=1 + 短名 → ' + calls.nav[3]);
    ok(calls.toast.length === 0, '不再弹「通知仅显示本人班级」（四张子卡都跟班走）');
  }

  head('⑤ 🔴 看本班时点子卡（roster 里 classId>0 = 查看别班）');
  {
    const { page, calls } = makeHarness(counselor, {}, src);
    page.load(); await settle();
    calls.nav.length = 0;
    page.onOpen({ currentTarget: { dataset: { key: 'roster' } } });
    page.onOpen({ currentTarget: { dataset: { key: 'notice' } } });
    ok(calls.nav[0] === '/pages/roster/index', '本班进成员页 URL 干净 → ' + calls.nav[0]);
    /* 通知例外：它的 classId 只表示「看哪个班」，本班也带 —— 这样「在 示例班级A 看 示例班级A
     * 的通知」比「不带参数看全部可见」更符合预期（不带参数是超管的全局视角）。 */
    ok(calls.nav[1] === '/pages/notice/index?classId=3&name=示例班级A%E7%8F%AD',
      '本班通知也带 classId（按班查看对本人班同样成立）→ ' + calls.nav[1]);
    ok(calls.toast.length === 0, '没有误弹提示');
  }

  head('⑥ 普通成员（A 组，主班 示例班级A）');
  {
    const { page, calls } = makeHarness({ id: 200, classId: 3, className: OWN_示例班级A, groupTag: 'A' }, {}, src);
    page.load(); await settle();
    ok(page.data.isStaff === false, 'isStaff = false');
    ok(calls.classList === 0, '不拉班级列表（省一次请求）');
    ok(page.data.classChips.length === 0, '没有 chips');
    ok(JSON.stringify(calls.memberStats[0]) === '{}', 'memberStats 不带 classId（后端回落本班）');
    ok(JSON.stringify(calls.feeSummary[0]) === '{}', 'feeSummary 不带 classId');
    ok(page.data.stats.total === 59, '仍然看到本班 59 人');
    ok(page.data.isOtherClass === false, 'isOtherClass = false');
    calls.nav.length = 0;
    page.onOpen({ currentTarget: { dataset: { key: 'roster' } } });
    ok(calls.nav[0] === '/pages/roster/index', '普通成员进成员页 URL 无参数');
  }

  head('⑦ 普通成员但 profile 缺 className（走列表兜底）');
  {
    const { page, calls } = makeHarness({ id: 201, classId: 2, className: '', groupTag: 'B' }, {}, src);
    page.load(); await settle();
    ok(calls.classList === 1, '兜底查了一次班级列表');
    ok(page.data.className === '示例专业A2班', '班名从列表里补上 → ' + page.data.className);
    ok(page.data.stats.total === 56, '拿到 示例班级B 的 56 人');
  }

  head('⑧ 超管（is_super=1，groupTag=A，主班 示例班级A）');
  {
    const { page } = makeHarness({ id: 13, classId: 3, className: OWN_示例班级A, groupTag: 'A' }, { isSuper: true }, src);
    page.load(); await settle();
    ok(page.data.isStaff === true, '超管 isStaff = true（不只 groupTag=X 才算）');
    ok(page.data.classChips.length === 5, '超管能看到全部 5 个班');
    ok(page.data.viewClassId === 3, '默认落主班');
    page.onClassPick({ currentTarget: { dataset: { id: 9 } } }); await settle();
    ok(page.data.isOtherClass === true, '切到商务英语 2601（id 9）后 isOtherClass = true');
    ok(page.data.stats.total === 10, '人数换成 10');
  }

  head('⑨ 边界：class.list 返回空');
  {
    const { page, calls } = makeHarness({ id: 999, classId: 0, className: '', groupTag: 'X' }, { emptyClasses: true }, src);
    page.load(); await settle();
    ok(page.data.classChips.length === 0, '没有 chips');
    ok(page.data.viewClassId === 0, 'viewClassId = 0（退回后端默认本班）');
    ok(calls.memberStats.length === 1 && JSON.stringify(calls.memberStats[0]) === '{}',
      '仍发一次统计请求且不带 classId → 不会卡在 loading 转圈');
    ok(page.data.isOtherClass === false, 'isOtherClass = false');
  }

  /* 2026-10-28 二次调整：横滑 chips 条 → 点班名弹层选班。
   * 弹层这套逻辑全是普通赋值，写错了不会报错，只会「点了没反应」或「弹层关不掉」，
   * 所以同样要真跑一遍。 */
  head('⑩ 班级选择弹层（5 个班 / 超管）');
  {
    const { page, calls } = makeHarness(counselor, { isSuper: true }, src);
    page.load(); await settle();
    ok(page.data.classSheetShow === false, '进页面时弹层是关的');
    ok(page.data.clsSheetH === 130 + 5 * 96 + 40, '弹层高度按 5 行算 = 650rpx（不写死）');
    const before = calls.memberStats.length;
    page.onClassSheetOpen();
    ok(page.data.classSheetShow === true, '点班名 → 弹层打开');
    page.onClassPick({ currentTarget: { dataset: { id: 3 } } });
    ok(page.data.classSheetShow === false, '点当前班也关弹层（用户点它是「确认」，不是「点了没反应」）');
    ok(calls.memberStats.length === before, '点当前班不重复拉数据（省一次请求）');
    page.onClassSheetOpen();
    page.onClassSheetClose();
    ok(page.data.classSheetShow === false, '点遮罩 / 下拉关闭能关上');
  }

  head('⑪ 弹层边界：只绑了 1 个班');
  {
    const { page } = makeHarness({ id: 88, classId: 3, className: OWN_示例班级A, groupTag: 'X' }, { oneClass: true }, src);
    page.load(); await settle();
    ok(page.data.classChips.length === 1, '只绑 1 个班');
    ok(page.data.clsSheetH === 130 + 1 * 96 + 40, '高度按 1 行算 = 266rpx');
    page.onClassSheetOpen();
    ok(page.data.classSheetShow === false, '1 个班时点不开弹层（入口本就不渲染，这里再兜一次底）');
  }

  head('⑫ 静态：弹层装配（wxml / json / wxss）');
  {
    const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/classinfo/index.wxml'), 'utf8');
    const json = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/classinfo/index.json'), 'utf8');
    const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/classinfo/index.wxss'), 'utf8');
    ok(/<bottom-sheet/.test(wxml) && /show="\{\{classSheetShow\}\}"/.test(wxml),
      'wxml 挂上 bottom-sheet 且 show 绑 classSheetShow');
    ok(!/scroll-x/.test(wxml), '横滑 chips 条已移除（用户反馈「左右滑动不太好」）');
    ok(/height="\{\{clsSheetH\}\}"/.test(wxml), '弹层高度接 clsSheetH（不是写死一个数）');
    ok(/page-style="\{\{classSheetShow/.test(wxml), 'page-meta 把 classSheetShow 列进滚动锁');
    ok(/"bottom-sheet"\s*:/.test(json), 'json 注册了 bottom-sheet 组件');
    ok(/wx:key="id"/.test(wxml), '弹层列表 wx:key 用属性名 id（不能写表达式）');
    ok(/\.cs-row/.test(wxss) && /\.ci-name-switch/.test(wxss), 'wxss 有弹层行与「切换」入口样式');
    ok(!/\.ci-chips?\s*\{/.test(wxss), '旧 chips 样式已清干净（留死代码会误导下一个人）');
  }

  return { pass, fail };
}

(async () => {
  const r = await runAll(SRC, false);

  /* ---------------- 变异自证（内存副本，绝不写盘） ---------------- */
  console.log('\n变异自证（每组改坏一处，必须翻红）');
  const MUTANTS = [
    {
      name: '删掉 keep 分支 → 每次 load 无条件落主班',
      from: 'const keep = chips.some(c => c.id === Number(this.data.viewClassId));',
      to: 'const keep = false;'
    },
    {
      name: 'isOtherClass 恒 false',
      from: 'isOtherClass: !!id && !!own && Number(id) !== own,',
      to: 'isOtherClass: false,'
    },
    {
      /* 2026-10-28：通知支路一旦失效，notice 会落进 else（只带 classId、不带短名），
       * 通知页导航标题就没有班名 —— 「切了班但看不出在看哪个班」。 */
      name: '通知卡丢掉短名 / 不走按班支路（切班后标题看不出是哪个班）',
      from: "if (key === 'notice') {",
      to: 'if (false) {'
    },
    {
      name: '请求永远带 classId（普通成员也带）',
      from: 'const arg = classId ? { classId } : {};',
      to: 'const arg = { classId: Number(classId) || 3 };'
    },
    {
      name: '子页面无条件带 classId（本班也带 → roster 误判查看别班）',
      from: 'if (this.data.isOtherClass && this.data.viewClassId) {',
      to: 'if (this.data.viewClassId) {'
    },
    {
      name: '点班后不关弹层（选了没反应，弹层还杵在那）',
      from: '    this.setData({ classSheetShow: false });\n    if (!id || id === Number(this.data.viewClassId)) return;',
      to: '    if (!id || id === Number(this.data.viewClassId)) return;'
    },
    {
      name: '打开弹层不判「至少两个班」',
      from: 'if (this.data.classChips.length < 2) return;',
      to: 'if (false) return;'
    },
    {
      name: '弹层高度写死（2 个班和 5 个班一样高）',
      from: 'return Math.min(900, 130 + rows * 96 + 40);',
      to: 'return 900;'
    }
  ];
  let mPass = 0, mFail = 0;
  for (const mu of MUTANTS) {
    const bad = SRC.split(mu.from).join(mu.to);
    if (bad === SRC) {
      mFail++;
      console.log('  ✗ 变异样本没命中源码（替换串对不上）：' + mu.name);
      continue;
    }
    const rr = await runAll(bad, true);
    if (rr.fail > 0) { mPass++; console.log('  ✓ 抓住 → ' + mu.name + '（翻红 ' + rr.fail + ' 项）'); }
    else { mFail++; console.log('  ✗ 漏放 → ' + mu.name + '（改坏了却仍然全绿）'); }
  }

  const pass = r.pass + mPass;
  const fail = r.fail + mFail;
  console.log('\n通过=' + pass + ' 失败=' + fail);
  if (fail) process.exit(1);
})();
