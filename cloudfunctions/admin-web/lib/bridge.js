/**
 * 后台 → 小程序云函数的服务端桥接（2026-11-28）
 * ============================================================
 * 后台没有微信上下文，直接 wx.cloud.callFunction 会被 guard 以「无法获取用户身份」
 * 拒绝。本模块用当前后台登录会话签一张 60 秒票据，随 callFunction 送给目标函数，
 * 让共用 guard.getContext(event) 构造出等价 ctx，从而复用原来的 route.handler。
 *
 * 为什么要复用而不是在后台重写一遍 SQL：
 *   值日轮转游标、演讲双游标、通知双记录、审计日志这些写逻辑都有严格时序与
 *   并发约束。后台另写一份，短期能跑通，长期必然与小程序端漂移（M1）。
 *
 * ⚠️ 三条硬约束：
 *   ① 只在服务端调用；raw sid 取自 HttpOnly Cookie，任何情况下都不回传浏览器；
 *   ② 调用方路由必须先过 requirePerm / requireSuper，这里是执行层不是鉴权层；
 *   ③ 票据一次一签、不缓存；目标函数验票会回查会话与成员状态。
 */
/* ⚠️ 惰性加载：本地 e2e / 门禁只 require index.js 做静态检查，本机没有
   wx-server-sdk；顶层 require 会让整个后台加载失败。只有真正发起桥接调用时
   才取 SDK，云函数线上环境自带该依赖。 */
let _cloud = null;
function cloudSdk() {
  if (!_cloud) {
    _cloud = require('wx-server-sdk');
    _cloud.init({ env: _cloud.DYNAMIC_CURRENT_ENV });
  }
  return _cloud;
}

const adminBridge = require('../common/admin-bridge');
const auth = require('./auth');
const { BizError } = require('../common/resp');

/**
 * @param {object} req Express 请求（session2 已由登录中间件挂上）
 * @param {string} fnName 目标云函数名，如 'schedule'
 * @param {string} action 云函数 action，如 'speechGenerate'
 * @param {object} payload 与小程序 api.js 传出的同形参数
 * @param {number|string} [classId] 目标班级；仅超管可覆盖本人主班（验票层强制）
 * @returns {Promise<any>} 云函数返回的 data
 */
async function call(req, fnName, action, payload, classId) {
  const s = req && req.session2;
  if (!s) throw new BizError(40001, '未登录或登录已过期');
  const cookies = auth.parseCookies(req) || {};
  const rawSid = cookies[auth.COOKIE_NAME];
  const ticket = adminBridge.issueTicket(rawSid, s.memberId, classId);
  if (!ticket) throw new BizError(40001, '无法生成后台票据，请重新登录后台');

  let res;
  try {
    res = await cloudSdk().callFunction({
      name: String(fnName),
      data: {
        action: String(action),
        payload: payload || {},
        // 字段名必须与 common/admin-bridge.js 的 TICKET_FIELD 逐字一致
        __wbAdminBridge: ticket
      }
    });
  } catch (e) {
    console.error('[admin-bridge] callFunction failed', fnName, action, (e && e.stack) || e);
    throw new BizError(50000, '服务暂时不可用，请稍后重试');
  }

  const out = res && res.result;
  if (!out || typeof out.errCode !== 'number') {
    console.error('[admin-bridge] bad envelope', fnName, action, out);
    throw new BizError(50000, '云函数返回异常，请稍后重试');
  }
  if (out.errCode !== 0) {
    throw new BizError(out.errCode, out.errMsg || '操作失败', out.data);
  }
  return out.data;
}

module.exports = { call };
