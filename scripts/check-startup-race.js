#!/usr/bin/env node
/**
 * 门禁：启动期「首页没加载好就切页 → 连接失败」竞态（2026-11-28）
 * ------------------------------------------------------------------
 * 用户症状：小程序打开后，首页还没加载好就切到别的 Tab，经常弹「连接失败」、
 * 要点「重新加载」/「重试」才好。根因是启动期请求风暴 + auth 未就绪就发请求：
 *   ① home.onShow 第 276 行无条件 load()，此时 authChecked=false（登录在飞）；
 *      登录完成后仅在「身份指纹变化」时才重拉 —— 老用户缓存 profile 指纹不变 ⇒
 *      冷启动那次失败的请求没有兜底重拉 ⇒ 卡在错误态。
 *   ② request.js 无 in-flight 去重：login + 首页 load(dutyToday/personal/leave/notice)
 *      + prefetchTabs(3) + recheckAuth 并发打向冷启动容器，同一 action 重复发，
 *      超时后各自 retry ⇒ 放大成雪崩。
 *
 * 判据（vm 真跑 + 变异自证）：
 *   A. 加载真实 home/index.js 的 onShow 函数体，mock 依赖，模拟冷启动
 *      （authChecked=false + 缓存 profile 指纹不变 + 首屏失败）：
 *      A1 auth 未就绪时不得立即 load；A2 ready 后必须无条件兜底重拉。
 *   B. 加载真实 request.js，两次并发同 action 读请求，断言底层 callFunction 只发 1 次
 *      （in-flight 去重）；写完释放后可再次发起。
 *   C. 变异自证：去掉门控 / 去掉兜底重拉 / 去掉去重，对应判据必须翻红。
 *
 * 用法：node scripts/check-startup-race.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const HOME = path.join(ROOT, 'miniprogram/pages/home/index.js');
const REQ = path.join(ROOT, 'miniprogram/utils/request.js');

let fail = 0;
function check(label, cond, extra) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   -> ' + extra : ''));
}

/* ============ A. home.onShow 时序 harness ============ */
function extractOnShow(src) {
  const m = src.match(/^  onShow\(\) \{([\s\S]*?)\n  \},/m);
  if (!m) throw new Error('home/index.js 找不到 onShow 函数体');
  return m[1];
}

function runOnShow(homeSrc) {
  const body = extractOnShow(homeSrc);
  let authResolved = false;
  let resolveReady;
  const readyPromise = new Promise((res) => { resolveReady = res; });
  const loads = [];
  const app = {
    globalData: {
      authChecked: false,
      // 老用户冷启动：缓存同步还原的 profile（登录返回后指纹不变）
      profile: { id: 7, classId: 3, role: 'MEMBER', position: '', groupTag: 'A' },
      viewClassId: 0, swapDirty: false, dutyDirty: false, rosterDirty: false
    },
    track: { pageView() {} },
    setTabBar() {}, isSuper() { return false; }, canLeave() { return false; },
    ready() { return readyPromise; },
    recheckAuth() { return Promise.resolve(false); }
  };
  let identityCalls = 0;
  const ctx = {
    getApp: () => app,
    console: { error() {}, warn() {} },
    setTimeout, clearTimeout,
    pageAnim: { playReady() {} },
    notice: { read() { return null; } },
    util: { roleTag() { return null; } },
    impersonate: { sync() {} }
  };
  vm.createContext(ctx);
  const runner = vm.runInContext(
    '(function(self){ const onShow = function(){' + body + '\n}; onShow.call(self); })',
    ctx
  );
  const self = {
    data: {},
    setData() {},
    _applyIdentity() { identityCalls++; return app.globalData.profile; },
    _identityFpOf(p) {
      return p ? (p.id + '/' + (p.isSuper ? 1 : 0) + '/' + (p.role || '') + '/' + (p.position || '') + '/' + (p.classId || 1)) : 'none';
    },
    _refreshNoticeBadge() {},
    _refreshDoneFlags() {}, _scheduleDoneTimer() {}, _scheduleLeaveWindowTimer() {},
    load(force) { loads.push({ force: !!force, atAuthReady: authResolved }); }
  };
  runner(self);
  return {
    loads,
    async finishLogin() {
      authResolved = true;
      app.globalData.authChecked = true;
      // 登录返回的 profile 各维度与缓存一致 ⇒ 指纹不变
      app.globalData.profile = { id: 7, classId: 3, role: 'MEMBER', position: '', groupTag: 'A' };
      resolveReady();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
  };
}

async function testAuthGate() {
  console.log('\n=== A. home.onShow 启动竞态（真实函数体） ===');
  const src = fs.readFileSync(HOME, 'utf8');
  let h = runOnShow(src);
  check('A1 auth 未就绪时不得立即发首屏请求', h.loads.length === 0,
    'loads=' + JSON.stringify(h.loads));
  await h.finishLogin();
  check('A2 登录完成后必须无条件兜底重拉一次（失败不再卡错误态）',
    h.loads.some(x => x.atAuthReady), 'loads=' + JSON.stringify(h.loads));

  // 变异自证：拿掉门控标记（让下面 load 不再跳过）⇒ A1 必须翻红
  const mutA1 = src.replace('if (!this._authGatePending) {', 'if (true) {');
  check('A-anchor 门控锚点存在（变异目标）', mutA1 !== src);
  const hm1 = runOnShow(mutA1);
  check('变异 A1：拿掉 auth 门控 → 立即发请求（判据承重）', hm1.loads.some(x => !x.atAuthReady),
    'loads=' + JSON.stringify(hm1.loads));

  // 变异自证：登录完成后不兜底重拉（退回旧逻辑「仅指纹变化时重拉」）⇒ A2 必须翻红
  const mutA2 = src.replace('        this.load(true);   // 无条件兜底重拉：登录前那次若失败，这里必补回来',
    '        if (fp2 !== this._identityFp) { this._identityFp = fp2; this.load(true); }');
  check('A-anchor 兜底重拉锚点存在（变异目标）', mutA2 !== src);
  const hm2 = runOnShow(mutA2);
  await hm2.finishLogin();
  check('变异 A2：指纹不变时不重拉 → 失败卡错误态（判据承重）',
    !hm2.loads.some(x => x.atAuthReady), 'loads=' + JSON.stringify(hm2.loads));
}

/* ============ B. request.js in-flight 去重 harness ============ */
function loadRequest(src) {
  const calls = [];
  let release = [];
  let autoResolve = false;
  const ctx = {
    module: { exports: {} }, exports: {},
    console: { error() {}, warn() {} },
    setTimeout, clearTimeout,
    wx: {
      cloud: {
        init() {},
        // request.js 的 invoke() 走 success/fail 回调，不是 Promise 返回值 —— mock 必须一致
        callFunction(o) {
          calls.push({ name: o.name, action: o.data && o.data.action, payload: o.data && o.data.payload });
          const ok = () => o.success({ result: { errCode: 0, data: { ok: 1 } } });
          if (autoResolve) { ok(); return; }
          release.push(ok);
        }
      },
      showToast() {}, showLoading() {}, hideLoading() {}
    }
  };
  vm.runInNewContext(src, ctx, { filename: REQ });
  return {
    call: ctx.module.exports.call,
    calls,
    resolveAll() { const r = release; release = []; r.forEach(fn => fn()); },
    setAuto(v) { autoResolve = v; }
  };
}

async function testInflight() {
  console.log('\n=== B. request.js 并发去重（真实源码） ===');
  const src = fs.readFileSync(REQ, 'utf8');
  const h = loadRequest(src);
  h.setAuto(false);
  // 同一 read action + 同一 payload 并发两次
  const p1 = h.call('duty', 'today', { classId: 3 }, { toast: false });
  const p2 = h.call('duty', 'today', { classId: 3 }, { toast: false });
  await new Promise((r) => setImmediate(r));
  check('B1 并发相同读请求底层只发 1 次（去重）', h.calls.length === 1,
    'calls=' + h.calls.length);
  h.resolveAll();
  await Promise.all([p1, p2]);
  // 释放后可再次发起
  h.setAuto(true);
  await h.call('duty', 'today', { classId: 3 }, { toast: false });
  check('B2 在飞请求释放后可再次发起（去重不过度）', h.calls.length === 2,
    'calls=' + h.calls.length);

  // 变异自证：去掉 in-flight 去重（跳过索引查找）⇒ B1 必须翻红
  const mut = src.replace('    if (pending) return pending;', '    if (false && pending) return pending;');
  check('B-anchor 去重锚点存在（变异目标）', mut !== src);
  const hm = loadRequest(mut);
  hm.setAuto(false);
  hm.call('duty', 'today', { classId: 3 }, { toast: false });
  hm.call('duty', 'today', { classId: 3 }, { toast: false });
  await new Promise((r) => setImmediate(r));
  check('变异 B1：去掉去重 → 并发请求发 2 次（判据承重）', hm.calls.length === 2,
    'calls=' + hm.calls.length);
}

(async () => {
  try {
    await testAuthGate();
    await testInflight();
  } catch (e) {
    fail++;
    console.log('FAIL  门禁自身异常: ' + (e && e.stack || e));
  }
  console.log('\n=== ' + (fail ? 'RED: ' + fail + ' 项失败' : 'GREEN: 全部通过') + ' ===');
  process.exit(fail ? 1 : 0);
})();
