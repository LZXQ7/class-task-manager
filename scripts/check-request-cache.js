#!/usr/bin/env node
/**
 * 离线自检：全站请求缓存层（v1.0.8.75，2026-11-20）
 * --------------------------------------------------------------------------------
 * 用户口径：「已加载内容缓存住，再次切到页面不用重新加载」；确认策略：
 *   ① 读接口命中缓存直接返回旧值、不发请求；无缓存/过期才拉新（TTL 控新鲜度）
 *   ② 缓存 key 含身份（memberId + viewClassId），切账号/切班不串数据
 *   ③ 白名单制：只缓存纯读幂等接口；有副作用却名字像读的（msgRead/leaveApprove）绝不缓存
 *   ④ 写操作成功后清空全部缓存
 *   ⑤ 内存 + Storage 双写（跨重启）；沙盒无 require/wx 时全链路 no-op 不崩
 *
 * 用法：node scripts/check-request-cache.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const REQ = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/request.js'), 'utf8');
const CACHE = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/req-cache.js'), 'utf8');
const CRYPTO = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/cache-crypto.js'), 'utf8');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

/** 在受控沙盒里加载 req-cache 源码；mid/cid 可变以测身份隔离 */
function loadCache(src, opts) {
  opts = opts || {};
  let mid = opts.mid === undefined ? 42 : opts.mid;
  const cid = opts.cid === undefined ? 7 : opts.cid;
  const store = {};
  /* v1.0.8.76：注入 cacheKey（模拟 auth.login 下发）+ require（加载 cache-crypto），
     否则加密版 req-cache 会跳过 Storage，双写断言全假红。 */
  const CK = '0123456789abcdef0123456789abcdef';
  const sandbox = {
    module: { exports: {} }, exports: {}, console: { error() {} },
    Date, Number, String, Object, Array, JSON, isNaN, parseInt, unescape, escape, Math,
    require: (p) => {
      if (p === './cache-crypto') {
        const m = { exports: {} };
        vm.runInNewContext(CRYPTO, Object.assign({}, sandbox, { module: m, exports: m.exports }), { filename: 'cache-crypto.js' });
        return m.exports;
      }
      return null;
    },
    getApp: () => ({ globalData: { profile: { id: mid, demo: 0 }, viewClassId: cid, switched: 0, cacheKey: CK } }),
    wx: {
      getStorageSync: k => (k in store ? store[k] : ''),
      setStorageSync: (k, v) => { store[k] = v; },
      removeStorageSync: k => { delete store[k]; },
      getStorageInfoSync: () => ({ keys: Object.keys(store) })
    }
  };
  vm.runInNewContext(src, sandbox, { filename: 'req-cache.js' });
  return {
    api: sandbox.module.exports,
    setMid: (v) => { mid = v; },
    store
  };
}

/* ============ ① 模块基础 ============ */
console.log('── ① 缓存模块：key 身份隔离 + 稳定序列化');
const M = loadCache(CACHE);
check(typeof M.api.makeKey === 'function' && typeof M.api.read === 'function'
  && typeof M.api.write === 'function' && typeof M.api.clear === 'function',
  'req-cache 导出 makeKey/read/write/clear');
const k1 = M.api.makeKey('fee', 'getSummary', { type: 'class' });
const k2 = M.api.makeKey('fee', 'getSummary', { type: 'class' });
check(k1 === k2, '同接口同参数 key 稳定一致（命中前提）');
check(k1 !== M.api.makeKey('fee', 'getSummary', { type: 'league' }), '不同参数 key 不同（班费/团费不混）');
check(M.api.stable({ a: 1, b: 2 }) === M.api.stable({ b: 2, a: 1 }), '稳定序列化：对象 key 顺序无关');
const before = M.api.makeKey('duty', 'today', {});
M.setMid(99);
const afterMid = M.api.makeKey('duty', 'today', {});
check(before !== afterMid, '身份进 key：切账号(mid) key 不同，不串数据');

/* ============ ② 白名单 ============ */
console.log('\n── ② 白名单：只缓存纯读，有副作用的一律不缓存');
check(M.api.cacheable('fee', 'getSummary') && M.api.cacheable('duty', 'today')
  && M.api.cacheable('member', 'list'), '纯读接口（班费/今日值日/名单）可缓存');
check(!M.api.cacheable('media', 'msgRead') && !M.api.cacheable('media', 'appNoticeSeen')
  && !M.api.cacheable('media', 'msgPopupSeen'), '标记已读类不缓存（否则已读状态卡住）');
check(!M.api.cacheable('adjust', 'leaveApprove') && !M.api.cacheable('course', 'syncFromClass')
  && !M.api.cacheable('member', 'remindReopen'), '有副作用却像读的（审批/同步/提醒）不缓存');
check(!M.api.cacheable('member', 'staffCode') && !M.api.cacheable('member', 'testAccountList')
  && !M.api.cacheable('auth', 'switchAccount'), '一次性凭证/超管名单/身份切换不缓存');

/* ============ ③ TTL + 双写 + 清空 ============ */
console.log('\n── ③ TTL + 双写 + 清空');
const tk = M.api.makeKey('duty', 'today', { x: 1 });
M.api.write(tk, { v: 123 });
check(!!M.api.read(tk, 120000) && M.api.read(tk, 120000).v === 123, '写入后可读回（双写命中）');
const tk0 = M.api.makeKey('duty', 'today', { y: 2 });
M.api.write(tk0, { v: 456 });
check(M.api.read(tk0, 0) === null, 'TTL=0 立即过期（供强制拉新）；写入刚完成也应未命中');
check(Object.keys(M.store).some(k => k.indexOf(M.api.PREFIX) === 0), 'Storage 落了带前缀的持久化键（跨重启）');
M.api.clear();
check(M.api.read(tk, 120000) === null && Object.keys(M.store).length === 0, 'clear() 同时清内存与 Storage');

/* ============ ④ request.js 接线（源码判据） ============ */
console.log('\n── ④ request.js 接线：命中短路 / 写后清空 / 沙盒 no-op');
check(/require\(['"]\.\/req-cache['"]\)/.test(REQ), 'request.js 引入 req-cache');
check(/const cache = \(typeof require === 'function'\)/.test(REQ), 'require 守卫：vm 沙盒下 cache=null');
check(/const doCache = !!\(cache && !isWrite/.test(REQ), '仅读接口（!isWrite）走缓存');
check(/if \(hit !== null && hit !== undefined\) return Promise\.resolve\(hit\)/.test(REQ), '命中缓存直接返回、不发云函数');
check(/if \(isWrite\) cache\.clear\(\)/.test(REQ), '写接口成功后清空缓存');
check(/else if \(doCache\) cache\.write\(cacheKey, data\)/.test(REQ), '读接口成功后写缓存');
check(/opt\.cache !== false/.test(REQ), 'opt.cache=false 可强制绕过（重新加载入口）');

/* 真跑 request.js 在无 require 沙盒：不得崩 */
function loadReqSandbox(src) {
  const calls = [];
  const sandbox = {
    module: { exports: {} }, exports: {}, console: { error() {} },
    setTimeout, clearTimeout, Promise, Date,
    wx: {
      cloud: { init() {}, callFunction(o) { calls.push(o.data.action); o.success({ result: { errCode: 0, data: { ok: 1 } } }); } },
      showToast() {}, showLoading() {}, hideLoading() {}
    }
  };
  vm.runInNewContext(src, sandbox, { filename: 'request.js' });
  return { call: sandbox.module.exports.call, calls };
}

const sb = loadReqSandbox(REQ);
sb.call('fee', 'getSummary', { type: 'class' }, { toast: false }).then(() => {
  check(sb.calls.length === 1, 'vm 沙盒（无 require）下 request 正常发请求、缓存 no-op');

  /* ============ ⑤ 变异自证 ============
   * 每个变异给 probe(next)：返回 true = 「好判据在变异后仍成立」。
   * 变异成功 ⇒ probe 必须翻 false；probe 仍 true = 判据是假的，门禁失效。
   */
  console.log('\n── ⑤ 变异自证（改坏 → 判据必须翻红）');
  const MUTS = [
    { name: '白名单放进 msgRead（已读状态会卡住）', file: 'cache',
      apply: (s) => s.replace("'media.msgRecycleList': 1", "'media.msgRecycleList': 1, 'media.msgRead': 1"),
      probe: (s) => { const mm = loadCache(s); return !mm.api.cacheable('media', 'msgRead'); } },
    { name: '身份维度从 key 去掉（切账号串数据）', file: 'cache',
      apply: (s) => s.replace('id.mid, id.cid, id.demo, id.switched, ', ''),
      probe: (s) => {
        const mm = loadCache(s); const a = mm.api.makeKey('duty', 'today', {});
        mm.setMid(99); return a !== mm.api.makeKey('duty', 'today', {});
      } },
    { name: '写后不清缓存', file: 'req',
      apply: (s) => s.replace('if (isWrite) cache.clear();', 'if (isWrite) void 0;'),
      probe: (s) => /if \(isWrite\) cache\.clear\(\)/.test(s) },
    { name: '命中缓存仍发请求（去掉短路）', file: 'req',
      apply: (s) => s.replace('if (hit !== null && hit !== undefined) return Promise.resolve(hit);', 'if (hit !== null && hit !== undefined) void 0;'),
      probe: (s) => /Promise\.resolve\(hit\)/.test(s) },
    { name: '去掉 require 守卫（沙盒崩）', file: 'req',
      apply: (s) => s.replace("const cache = (typeof require === 'function') ? require('./req-cache') : null;", "const cache = require('./req-cache');"),
      probe: (s) => /typeof require === 'function'.*req-cache/.test(s) }
  ];
  MUTS.forEach((m) => {
    const src = m.file === 'req' ? REQ : CACHE;
    const next = m.apply(src);
    if (next === src) { check(false, '变异「' + m.name + '」锚点失配'); return; }
    check(m.probe(next) === false, '变异被抓：' + m.name);
  });

  console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 全站请求缓存检查全部通过'));
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.log('  ✗ 沙盒调用异常', e && e.message); process.exit(1); });
