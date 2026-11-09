/**
 * 云开发统一请求层
 * - 统一 cloud.init
 * - 统一 envelope 解包（{errCode:0,data} / {errCode!==0,errMsg}）
 * - 统一错误提示与鉴权事件广播
 */
const ENV_ID = '<YOUR_ENV_ID>';

let inited = false;
function cloudInit() {
  if (inited || typeof wx === 'undefined' || !wx.cloud) return;
  // 多端应用模式(projectArchitecture=multiPlatform)下，客户端独立于小程序运行时，
  // SDK 推不出 appid/envid，必须显式指定，否则 callFunction 全量报 -601002。
  // envid 是多端模式读的键，env 是小程序模式读的键，双写兼容两种架构。
  wx.cloud.init({
    appid: '<YOUR_APPID>',
    envid: ENV_ID,
    env: ENV_ID,
    traceUser: true
  });
  inited = true;
}

const bus = {};
function on(evt, fn) {
  (bus[evt] = bus[evt] || []).push(fn);
}
function emit(evt, payload) {
  (bus[evt] || []).forEach(fn => {
    try { fn(payload); } catch (e) { console.error('[bus]', evt, e); }
  });
}

function mkErr(errCode, errMsg, data) {
  const e = new Error(errMsg || '请求失败');
  e.errCode = errCode;
  e.errMsg = errMsg;
  e.data = data === undefined ? null : data;
  return e;
}

/**
 * 调用云函数
 * @param {string} name   云函数名
 * @param {string} action 动作
 * @param {object} payload 业务参数
 * @param {object} opt    { toast:boolean 默认 true, loading:string|false }
 */
function call(name, action, payload, opt) {
  cloudInit();
  payload = payload || {};
  opt = opt || {};
  const needToast = opt.toast !== false;
  const loadingText = opt.loading;
  // opt.retry：仅对网络/超时类失败（errCode -1，见下方 fail 分支）重试；
  // 业务错误（含 40001/40002 未绑定）一律不重试，避免无意义的重复请求。
  /* 2026-11-08「经常连接服务器失败」通用加固：
   * 云函数冷启动 / 网络瞬断通常是**一次性的**（第二次容器已热就成功），
   * 所以读类请求默认自动重试 1 次。写类请求**绝不**自动重试 —— 第一次可能已经
   * 落库、只是响应在路上丢了，重放会造成重复记录。按 action 命名识别写操作，
   * 调用方仍可用 opt.retry 显式覆盖（0 = 关，1~3 = 指定次数）。 */
  const WRITE_ACTION = /(add|save|set|update|remove|delete|clear|publish|unpublish|apply|import|revert|confirm|cancel|bind|unbind|toggle|move|append|copy|submit|upsert|generate|reassign|swap|handle|track|send|create|mark|reset|upload)/i;
  const defaultRetry = WRITE_ACTION.test(String(action)) ? 0 : 1;
  const maxRetry = opt.retry === undefined
    ? defaultRetry
    : ((opt.retry > 0 && Number.isFinite(opt.retry)) ? Math.min(opt.retry, 3) : 0);

  function invoke() {
    return new Promise((resolve, reject) => {
      if (loadingText) wx.showLoading({ title: loadingText, mask: true });
      wx.cloud.callFunction({
        name,
        data: { action, payload },
        success(res) {
          if (loadingText) wx.hideLoading();
          const r = (res && res.result) || {};
          if (r.errCode === 0) {
            resolve(r.data === undefined ? null : r.data);
            return;
          }
          const err = mkErr(r.errCode, r.errMsg || '请求失败', r.data);
          if (r.errCode === 40001 || r.errCode === 40002) emit('needBind', err);
          if (needToast && r.errCode !== 40001 && r.errCode !== 40002) {
            wx.showToast({ title: err.errMsg || '请求失败', icon: 'none', duration: 2000 });
          }
          reject(err);
        },
        fail(e) {
          if (loadingText) wx.hideLoading();
          const raw = (e && e.errMsg) || '';
          // ⚠️ 2026-10-05：原先这里是
          //   `/cloud|network|fail/i.test(msg) ? '网络异常，请稍后重试' : msg`
          // 而 wx.cloud.callFunction 的 errMsg **几乎总含 'fail'**（request:fail timeout 等）
          // ⇒ 永远命中前一分支 ⇒ 真实原因（超时？云函数不存在？基础库不支持？）被无条件吞掉，
          //    连续三轮排查「网络异常」都拿不到真因就是这里害的。
          // 现在：把原始 errMsg **原样透出**（只对完全空的情况兜底），
          // 并 console.error 落日志。基础库版本问题（3.x 老版本 callFunction 行为差异）
          // 也只有这样才看得见。
          const detail = raw || '请求失败（未返回错误信息）';
          console.error('[request] callFunction fail:', name, action, raw, e);
          // 原始 errMsg 保留在 err.errMsg / 日志里（页面 _errText 能显示真因）。
          // toast 不在这一层弹：还要自动重试，弹了会「失败→又成功」吓人一跳；
          // 统一放到 run() 的最终失败分支，只提示一次。
          const err = mkErr(-1, detail);
          reject(err);
        }
      });
    });
  }

  function run(attempt) {
    return invoke().catch((err) => {
      // 冷启动偶发超时/网络抖动 → errCode -1；短退避重试 1~2 次，避免雪崩
      if (maxRetry > 0 && attempt <= maxRetry && err && err.errCode === -1) {
        const delay = 400 * attempt;
        return new Promise((res) => setTimeout(res, delay)).then(() => run(attempt + 1));
      }
      // 最后一次仍失败：给用户一句能看懂的话 + 说明已经重试过，
      // 别再把 `cloud.callFunction:fail …` 这类原始串直接甩到 toast 上。
      if (needToast && err && err.errCode === -1) {
        const tried = maxRetry > 0 ? '（已自动重试 ' + Math.min(attempt - 1, maxRetry) + ' 次）' : '';
        wx.showToast({
          title: '连接服务器失败' + tried + '，请检查网络后重试',
          icon: 'none', duration: 3000
        });
      }
      throw err;
    });
  }
  return run(1);
}

/** 上传本地文件到云存储 */
function uploadFile(cloudPath, filePath) {
  cloudInit();
  return wx.cloud.uploadFile({ cloudPath, filePath }).then(r => r.fileID);
}

/** 取云存储临时访问链接 */
function getTempFileURL(fileList) {
  cloudInit();
  const list = Array.isArray(fileList) ? fileList : [fileList];
  if (!list.length) return Promise.resolve([]);
  return wx.cloud.getTempFileURL({ fileList: list }).then(r => {
    const map = {};
    (r.fileList || []).forEach(it => {
      if (it.status === 0) map[it.fileID] = it.tempFileURL;
    });
    return map;
  });
}

module.exports = { ENV_ID, cloudInit, call, on, emit, uploadFile, getTempFileURL };
