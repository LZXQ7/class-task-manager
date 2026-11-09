/**
 * 门禁：连接失败自动重试（2026-11-08「经常连接服务器失败」通用加固）
 * ------------------------------------------------------------
 * 三处真源码、零副本：
 *   ① miniprogram/utils/request.js —— 云函数调用失败（errCode -1）自动重试
 *   ② cloudfunctions/admin-web/public/app.js —— 后台 api() 网络层失败重试
 *   ③ cloudfunctions/schedule/index.js —— 慢模型 15s 提前中止 + 中文归因
 *
 * 铁律：写类请求**绝不**自动重试（第一次可能已落库、只是响应丢了）；
 * 读类只重试网络/超时类失败；toast 只在最终失败弹一次；业务错误不重试。
 * 用 vm 加载真实源码函数体并桩掉 wx / fetch，另做源码级变异自证。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FILE_REQ = path.join(ROOT, 'miniprogram/utils/request.js');
const FILE_ADMIN = path.join(ROOT, 'cloudfunctions/admin-web/public/app.js');
const FILE_SCHEDULE = path.join(ROOT, 'cloudfunctions/schedule/index.js');

let fail = 0;
function check(label, cond, extra) {
  const okFlag = !!cond;
  if (!okFlag) fail++;
  console.log((okFlag ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   -> ' + extra : ''));
}

/* ---------------- ① 小程序统一请求层 ---------------- */
function loadRequest(src) {
  const toasts = [];
  const calls = [];
  let failFirst = 0;
  let bizError = null;
  const sandbox = {
    module: { exports: {} }, exports: {},
    console: { error() {} },
    setTimeout, clearTimeout,
    wx: {
      cloud: {
        init() {},
        callFunction(o) {
          calls.push({ name: o.name, action: o.data && o.data.action });
          if (calls.length <= failFirst) { o.fail({ errMsg: 'request:fail timeout' }); return; }
          if (bizError) { o.success({ result: { errCode: bizError.errCode, errMsg: bizError.errMsg } }); return; }
          o.success({ result: { errCode: 0, data: { ok: 1 } } });
        }
      },
      showToast(o) { toasts.push(o.title); },
      showLoading() {}, hideLoading() {}
    }
  };
  vm.runInNewContext(src, sandbox, { filename: FILE_REQ });
  return {
    call: sandbox.module.exports.call,
    toasts, calls,
    setFail: n => { failFirst = n; },
    setBiz: e => { bizError = e; }
  };
}
const reqSrc = fs.readFileSync(FILE_REQ, 'utf8');

async function testRequest() {
  console.log('\n=== ① 小程序 request.js ===');
  // 读类：第一次网络失败 → 自动重试 → 成功，且全程不弹错误提示
  let h = loadRequest(reqSrc);
  h.setFail(1);
  let got = null, err = null;
  try { got = await h.call('duty', 'today', {}, {}); } catch (e) { err = e; }
  check('读类网络失败 → 自动重试 1 次并成功', !err && got && got.ok === 1 && h.calls.length === 2,
    'calls=' + h.calls.length + ' err=' + (err && err.errMsg));
  check('重试成功时不弹「失败」toast（不吓人一跳）', h.toasts.length === 0, h.toasts.join('|'));

  // 写类：不重试
  h = loadRequest(reqSrc);
  h.setFail(1);
  err = null;
  try { await h.call('schedule', 'addManual', {}, {}); } catch (e) { err = e; }
  check('写类（addManual）失败绝不重试', h.calls.length === 1, 'calls=' + h.calls.length);
  check('写类最终失败提示含「连接服务器失败」', h.toasts.length === 1 && /连接服务器失败/.test(h.toasts[0]), h.toasts.join('|'));
  check('原始 errMsg 仍留在 err 上（页面可显示真因）', !!err && /request:fail timeout/.test(err.errMsg));

  // 读类连续失败：只重试一次，提示里说明已重试
  h = loadRequest(reqSrc);
  h.setFail(99);
  err = null;
  try { await h.call('course', 'listWeek', {}, {}); } catch (e) { err = e; }
  check('读类连续失败最多重试 1 次（不雪崩）', h.calls.length === 2, 'calls=' + h.calls.length);
  check('最终失败提示说明「已自动重试 1 次」', h.toasts.length === 1 && /已自动重试 1 次/.test(h.toasts[0]), h.toasts.join('|'));

  // 业务错误不重试
  h = loadRequest(reqSrc);
  h.setBiz({ errCode: 40003, errMsg: '无权操作' });
  err = null;
  try { await h.call('member', 'list', {}, {}); } catch (e) { err = e; }
  check('业务错误 40003 不重试', h.calls.length === 1 && err && err.errCode === 40003, 'calls=' + h.calls.length);
  check('业务错误提示保留原文', h.toasts.length === 1 && h.toasts[0] === '无权操作', h.toasts.join('|'));

  // 显式关闭
  h = loadRequest(reqSrc);
  h.setFail(99);
  try { await h.call('duty', 'today', {}, { retry: 0 }); } catch (e) { /* 预期 */ }
  check('opt.retry=0 可显式关闭自动重试', h.calls.length === 1, 'calls=' + h.calls.length);

  // 变异自证：把「默认读类重试」改成 0，读类断言必须翻红
  const mut = reqSrc.replace('? defaultRetry\n', '? 0\n');
  check('变异 A 确实改到了源码', mut !== reqSrc);
  const hm = loadRequest(mut);
  hm.setFail(1);
  let mutOk = false;
  try { await hm.call('duty', 'today', {}, {}); mutOk = true; } catch (e) { /* 预期 */ }
  check('变异 A：去掉默认重试 → 读类不再自动恢复（断言承重）', !mutOk && hm.calls.length === 1,
    'calls=' + hm.calls.length);
}

/* ---------------- ② 后台 api() ---------------- */
function loadAdminApi(src) {
  const start = src.indexOf('function api(pathname, options) {');
  const end = src.indexOf('\n  function needAuth(', start);
  if (start < 0 || end < 0) throw new Error('app.js 里找不到 api() 函数体');
  const fnSrc = src.slice(start, end);
  const calls = [];
  let failFirst = 0;
  const sandbox = {
    API_BASE: '/admin/api',
    currentClass: () => null,
    AbortController,
    setTimeout, clearTimeout,
    fetch() {
      calls.push(1);
      if (calls.length <= failFirst) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve('{"ok":true,"data":{}}')
      });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSrc + '\nthis.__api = api;', sandbox, { filename: FILE_ADMIN });
  return { api: sandbox.__api, calls, setFail: n => { failFirst = n; } };
}
const adminSrc = fs.readFileSync(FILE_ADMIN, 'utf8');

async function testAdmin() {
  console.log('\n=== ② 后台 admin-web api() ===');
  let h = loadAdminApi(adminSrc);
  h.setFail(1);
  let d = await h.api('/overview');
  check('GET 网络失败 → 自动重试 1 次并成功', d && d.ok === true && h.calls.length === 2,
    'calls=' + h.calls.length + ' errMsg=' + (d && d.errMsg));

  h = loadAdminApi(adminSrc);
  h.setFail(1);
  d = await h.api('/save', { method: 'POST', body: { a: 1 } });
  check('POST 失败绝不重试（避免重复提交）', h.calls.length === 1, 'calls=' + h.calls.length);
  check('POST 失败仍返回可解释的「无法连接服务器」', d && d.ok === false && /无法连接服务器/.test(d.errMsg), d && d.errMsg);

  h = loadAdminApi(adminSrc);
  h.setFail(99);
  d = await h.api('/overview');
  check('GET 连续失败最多重试 1 次', h.calls.length === 2, 'calls=' + h.calls.length);
  check('最终文案说明「已自动重试 1 次」', /已自动重试 1 次/.test(String(d && d.errMsg)), d && d.errMsg);

  const mut = adminSrc.replace("? ((options.method || 'GET') === 'GET' ? 1 : 0) : options.retry", '? 0 : options.retry');
  check('变异 B 确实改到了源码', mut !== adminSrc);
  const hm = loadAdminApi(mut);
  hm.setFail(1);
  const dm = await hm.api('/overview');
  check('变异 B：去掉后台默认重试 → 失败不再恢复（断言承重）', dm && dm.ok === false && hm.calls.length === 1,
    'calls=' + hm.calls.length);
}

/* ---------------- ③ AI 链路快速失败 ---------------- */
function testAiTimeout() {
  console.log('\n=== ③ schedule AI 链路 ===');
  const s = fs.readFileSync(FILE_SCHEDULE, 'utf8');
  check('函数间调用超时由 55s 收到 15s（客户端最多等 20s）', /timeout: AI_CALL_TIMEOUT_MS/.test(s)
    && /AI_CALL_TIMEOUT_MS = 15000/.test(s));
  check('直连路径超时默认 15s', /DEEPSEEK_TIMEOUT_MS \|\| 15000/.test(s));
  check('超时错误给出中文归因 + 明确建议', /模型 15 秒内没有返回/.test(s) && /deepseek-chat/.test(s));
}

(async () => {
  try {
    await testRequest();
    await testAdmin();
    testAiTimeout();
  } catch (e) {
    fail++;
    console.log('FAIL  门禁自身异常: ' + (e && e.stack || e));
  }
  console.log('\n=== ' + (fail ? 'RED: ' + fail + ' 项失败' : 'GREEN: 全部通过') + ' ===');
  process.exit(fail ? 1 : 0);
})();
