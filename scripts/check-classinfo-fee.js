/**
 * 门禁：班级信息页（P5）与班费页 —— 数据流与两起线上事故的回归锁
 * ============================================================
 * 锁的是 2026-10-28 真机上报的两起故障，两者同源：**JS 异常被空 catch 吞掉，
 * 成功响应当成失败渲染**。
 *
 * 事故① 班级信息页恒显「未绑定班级」
 *   根因：utils/util.js 的 module.exports 漏导出 classNameOf，
 *        classinfo 调 util.classNameOf(...) 抛 TypeError，被 .catch(()=>{}) 吞掉。
 *
 * 事故② 班费页恒显「数据没加载出来」
 *   根因：pages/fee/index.js _loadFee 的 setData 把局部量 canManage 写成 feeCanManage，
 *        ReferenceError 被 .catch(()=>{}) 吞掉 ⇒ 云函数明明 errCode 0，页面却进失败态。
 *
 * 因此本门禁**不只要数据对，还要能翻红**：
 *   · 静态层：直接钉死上面两处「历史原样」，有人改回去立刻红；
 *   · 运行层：用生产环境实拉的响应跑真实页面代码，断言渲染结果；
 *   · 变异层：在内存里把依赖打坏（不碰磁盘），断言必须翻红，证明断言是承重的。
 *
 * 响应体来源（不是我编的）：
 *   tcb fn invoke fee   -e <env> --params '{"action":"getSummary","payload":{}}'
 *   tcb fn invoke class -e <env> --params '{"action":"list","payload":{"all":true}}'
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const FEE_FILE = path.join(ROOT, 'pages', 'fee', 'index.js');
const FEE_WXML = path.join(ROOT, 'pages', 'fee', 'index.wxml');
const FEE_WXSS = path.join(ROOT, 'pages', 'fee', 'index.wxss');
const UTIL_FILE = path.join(ROOT, 'utils', 'util.js');

/* ---------------- 线上实拉的响应（2026-10-28） ---------------- */
const REAL_CLASS_LIST = [
  { id: 1, name: '示例专业B1班' },
  { id: 2, name: '示例专业A2班' },
  { id: 3, name: '示例专业A1班' },
  { id: 9, name: '商务示例专业B2班' },
  { id: 10, name: '示例专业B2班' }
];
const REAL_FEE_SUMMARY = {
  class: { total: 280, expenseTotal: 6.1, balance: 273.9, records: [{ id: 2, amount: 1.1, note: '打印长征精神团日活动', images: [], operatorName: '示例成员36', createdAt: '2026-10-25 21:37:30' }] },
  league: { total: 0, expenseTotal: 0, balance: 0, records: [] }
};
const REAL_MEMBER_STATS = { total: 56, groupA: 28, groupB: 28 };

/** 线上 auth.login 下发的 member（member id=13 示例成员01：class_id=3 / is_super=1 / 生活委员） */
const SUPER = {
  id: 13, name: '示例成员01', groupTag: 'A', role: 'ADMIN', isSuper: true, status: 'ACTIVE',
  position: '生活委员', avatarUrl: '', remindBlock: false, classId: 3
  // ⚠️ 线上 login **没有** className 字段 —— 页面必须靠 classList 兜底拿到名字
};
/** 普通成员：class_id=3 / 非超管 / 无职位 */
const MEMBER = {
  id: 62, name: '示例成员50', groupTag: 'B', role: 'MEMBER', isSuper: false, status: 'ACTIVE',
  position: '', avatarUrl: '', remindBlock: false, classId: 3
};

/* ---------------- 运行时桩 ---------------- */
let failFee = false;
function makeWx() {
  return {
    cloud: {
      init() {},
      callFunction(o) {
        const name = o.name, action = (o.data || {}).action;
        let data = null;
        if (name === 'class' && action === 'list') data = REAL_CLASS_LIST;
        else if (name === 'member' && action === 'stats') data = REAL_MEMBER_STATS;
        else if (name === 'fee' && action === 'getSummary') data = REAL_FEE_SUMMARY;
        else data = {};
        if (name === 'fee' && action === 'getSummary' && failFee) {
          const e = new Error('request:fail timeout');
          e.errMsg = 'request:fail timeout';
          setTimeout(() => o.fail && o.fail(e), 0);
          return;
        }
        setTimeout(() => o.success && o.success({ result: { errCode: 0, errMsg: 'ok', data } }), 0);
      },
      uploadFile() { return Promise.resolve({ fileID: 'cloud://x' }); },
      getTempFileURL() { return Promise.resolve({ fileList: [] }); }
    },
    getStorageSync() { return null; }, setStorageSync() {}, removeStorageSync() {},
    showLoading() {}, hideLoading() {}, showToast() {}, showModal() {},
    onThemeChange() {}, offThemeChange() {}, onWindowResize() {}, offWindowResize() {},
    getSystemInfoSync() { return { statusBarHeight: 20, windowWidth: 375, windowHeight: 812, screenHeight: 812, safeArea: { bottom: 812 } }; },
    getWindowInfo() { return { statusBarHeight: 20, windowWidth: 375, windowHeight: 812, pixelRatio: 2 }; },
    getDeviceInfo() { return { platform: 'devtools' }; },
    getAppBaseInfo() { return { SDKVersion: '3.0.0', theme: 'light' }; },
    getSystemSetting() { return {}; },
    getMenuButtonBoundingClientRect() { return { top: 48, height: 32, width: 87, right: 320, bottom: 80, left: 233 }; },
    switchTab() {}, navigateTo() {}, reLaunch() {}, redirectTo() {}, navigateBack() {},
    setNavigationBarTitle() {}, pageScrollTo() {},
    createSelectorQuery() { return { select() { return this; }, selectAll() { return this; }, boundingClientRect() { return this; }, in() { return this; }, fields() { return this; }, exec(cb) { cb && cb([]); } }; },
    nextTick(cb) { cb && cb(); }, canIUse() { return true; }, setClipboardData() {}
  };
}

function loadPage(pagePath, profile) {
  Object.keys(require.cache).forEach((k) => { if (k.indexOf(ROOT) === 0) delete require.cache[k]; });
  global.wx = makeWx();
  global.Component = function () {};
  global.Page = function (def) { global.__pageDef = def; };
  global.getApp = function () {
    return {
      globalData: { profile, statusBarHeight: 20, systemInfo: { statusBarHeight: 20 } },
      setTabBar() {},
      isSuper() { return !!(profile && profile.isSuper); },
      track: null
    };
  };
  require(path.join(ROOT, pagePath));
  const def = global.__pageDef;
  const inst = Object.assign({}, def);
  inst.data = JSON.parse(JSON.stringify(def.data || {}));
  inst.setData = function (patch) { Object.assign(inst.data, patch); };
  Object.keys(def).forEach((k) => { if (typeof def[k] === 'function') inst[k] = def[k].bind(inst); });
  return inst;
}

const flush = () => new Promise((r) => setTimeout(r, 30));
async function settle(p) { await flush(); await flush(); return p; }

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/**
 * 班费页**版式**静态审计（纯函数，吃源码文本吐问题列表）。
 * 2026-10-27 用户连着报了两个纯视觉问题，编译/WXML 检查都发现不了：
 *   ① 顶部「没用的形状」= segmented 的 items 写成 { value, label }，
 *      而组件契约是 { key, text } → 文字取不到，渲染成一个**没有字的空胶囊**；
 *   ② 消费明细贴屏幕边 = 容器写成 class="wrap"，但 `.wrap{padding:24rpx 32rpx}`
 *      只定义在 home 的 wxss 里，**页面级样式不跨页生效**，本页只命中了
 *      app.wxss 那条 flex 工具类 `.wrap{flex-wrap:wrap}` ⇒ 内边距为 0。
 * 这两条都属于「没有报错、只是长错」，只能靠静态契约检查守住。
 */
function auditFeeLayout(js, wxml, wxss) {
  const problems = [];
  // ⚠️ 必须先剥注释：本页 wxml 里就写着「历史事故：这里写的是 class="wrap"…」，
  //    不剥的话注释会被当成真标签扫进去 —— check-segmented 踩过同一个坑。
  const wxmlClean = String(wxml || '').replace(/<!--[\s\S]*?-->/g, '');
  if (!/\bkey:\s*'class'/.test(js)) {
    problems.push('segmented items 没用 { key, text } 契约 → 会渲染成没有字的空胶囊');
  }
  if (/\blabel:\s*'/.test(js)) {
    problems.push("segmented items 里出现了 label 字段（组件只认 text）");
  }
  if (/class="wrap"/.test(wxmlClean)) {
    problems.push('内容容器写成 class="wrap"（本页没有该类的内边距 → 整页贴边）');
  }
  if (!/class="fee-wrap"/.test(wxmlClean)) {
    problems.push('内容容器没有 .fee-wrap（缺左右 32rpx 内边距）');
  }
  if (!/\.fee-wrap\s*\{[^}]*padding:\s*[^;}]*32rpx/.test(wxss)) {
    problems.push('.fee-wrap 没有左右 32rpx 内边距');
  }
  if (!/class="card fee-rec/.test(wxmlClean)) {
    problems.push('消费明细不是卡片（.fee-rec 缺 .card）');
  }
  return problems;
}

(async function main() {
  /* ---------- 静态层：钉死两处历史原样，改回去立刻红 ---------- */
  const utilSrc = fs.readFileSync(UTIL_FILE, 'utf8');
  ok('静态·utils/util.js 导出 classNameOf（事故①根因不得复发）',
    /module\.exports\s*=\s*\{[\s\S]*?\bclassNameOf\b/.test(utilSrc));

  const feeSrc = fs.readFileSync(FEE_FILE, 'utf8');
  ok('静态·fee 页 _loadFee 的 setData 不再写 feeCanManage（事故②根因不得复发）',
    !/feeClass,\s*feeLeague,\s*feeActive,\s*feeCanManage/.test(feeSrc));
  ok('静态·fee 页 _loadFee 的 setData 写的是局部量 canManage',
    /feeClass,\s*feeLeague,\s*feeActive,\s*canManage/.test(feeSrc));
  ok('静态·fee 页 _loadFee 的 catch 不再空吞（必须落 console.error）',
    /\.catch\(\(e\)\s*=>\s*\{[^}]*console\.error/.test(feeSrc.replace(/\s+/g, (m) => m.includes('\n') ? ' ' : m)));

  const feeWxml = fs.readFileSync(FEE_WXML, 'utf8');
  const feeWxss = fs.readFileSync(FEE_WXSS, 'utf8');
  const layoutProblems = auditFeeLayout(feeSrc, feeWxml, feeWxss);
  ok('静态·班费页版式：分段契约 / 不贴边 / 明细卡片',
    layoutProblems.length === 0, layoutProblems.join('；'));

  // 自证（变异）：直接拿**真实源码**把三处旧写法改回去，审计必须全部报出来。
  //   比造一个假样本更硬 —— 证明这套正则在真实文件上承重，而不是只认得手写的样例。
  const mutatedLayout = auditFeeLayout(
    // ⚠️ 必须带 g：`key: 'class'` 在 fee/index.js 里出现**两次**（data 默认值 + _applyIdentity），
    //    只替第一个的话那份默认值还在，审计就查不出「空胶囊」—— 自证会假通过。
    feeSrc.replace(/key:\s*'class'/g, "value: 'class', label: '班费'"),
    feeWxml.replace(/class="fee-wrap"/g, 'class="wrap"').replace(/class="card fee-rec/g, 'class="fee-rec'),
    feeWxss
  );
  ok('自证·真实源码变异后「空胶囊 + 整页贴边 + 非卡片」必被抓到',
    mutatedLayout.some((m) => /空胶囊/.test(m))
    && mutatedLayout.some((m) => /贴边/.test(m))
    && mutatedLayout.some((m) => /卡片/.test(m)),
    '实得 ' + mutatedLayout.length + ' 项：' + mutatedLayout.join('；'));

  /* ---------- 运行层：真实页面代码 + 线上真实响应 ---------- */
  const ci = await settle((() => {
    const p = loadPage('pages/classinfo/index.js', SUPER);
    p.onLoad({}); p.onShow(); return p;
  })());
  ok('班级信息·超管拿到班级名（不再显示「未绑定班级」）',
    ci.data.className === '示例专业A1班', '实得 ' + JSON.stringify(ci.data.className));
  ok('班级信息·成员统计仍然正常',
    ci.data.stats && ci.data.stats.total === 56 && ci.data.stats.groupA === 28 && ci.data.stats.groupB === 28);
  ok('班级信息·班费总额仍然正常', ci.data.feeTotal === 280, '实得 ' + ci.data.feeTotal);
  ok('班级信息·超管可见「班级管理」入口', ci.data.canManageClass === true);

  const ciMember = await settle((() => {
    const p = loadPage('pages/classinfo/index.js', MEMBER);
    p.onLoad({}); p.onShow(); return p;
  })());
  ok('班级信息·普通成员看不到「班级管理」入口', ciMember.data.canManageClass === false);
  ok('班级信息·普通成员同样能拿到班级名', ciMember.data.className === '示例专业A1班');

  const fee = await settle((() => {
    const p = loadPage('pages/fee/index.js', SUPER);
    p.onLoad({}); p.onShow(); return p;
  })());
  ok('班费页·不再进失败态（failed=false）', fee.data.failed === false);
  ok('班费页·余额取自线上真实响应（273.9）',
    fee.data.feeActive && fee.data.feeActive.balanceText === '273.9',
    '实得 ' + (fee.data.feeActive && fee.data.feeActive.balanceText));
  ok('班费页·消费明细条数正确', fee.data.feeActive && fee.data.feeActive.records.length === 1);

  /* ---------- 变异层：证明上面的断言能翻红 ---------- */
  // 变异 A（内存）：把 util.classNameOf 从导出上摘掉 = 还原事故①的线上状态
  const mutCi = await settle((() => {
    const p = loadPage('pages/classinfo/index.js', SUPER);
    delete require(path.join(ROOT, 'utils', 'util.js')).classNameOf;
    p.onLoad({}); p.onShow(); return p;
  })());
  ok('变异A·摘掉 classNameOf 导出后，班级名必须为空（断言承重）',
    !mutCi.data.className, '实得 ' + JSON.stringify(mutCi.data.className));

  // 变异 B（内存）：把 fee 请求打成失败 = 还原事故②的线上表现
  failFee = true;
  const mutFee = await settle((() => {
    const p = loadPage('pages/fee/index.js', SUPER);
    p.onLoad({}); p.onShow(); return p;
  })());
  failFee = false;
  ok('变异B·班费请求失败时，页面必须进失败态（断言承重）', mutFee.data.failed === true);

  console.log('check-classinfo-fee: 通过 ' + pass + ' / 失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
