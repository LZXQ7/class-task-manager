/**
 * 云函数：config —— 前端可远程配置项下发（2026-10-26）
 *
 * action: get —— 公开读 app_config 全表，返回 { k: v }；v 若像 JSON（以 { / [ 开头）则自动解析，否则原样返回字符串。
 * 用途：把「易变文案 / 功能开关」从前端代码抽出来，超管改库即生效，**免小程序审核**。
 *   示范项：homeBanner（首页顶部横幅文案，空则不显示）。
 *   后续可扩：功能开关、运营位、活动提示等任何适合「改了不用重发版」的内容。
 *
 * ⚠️ 与 class / auth 等带登录态的函数不同：本函数**公开读**（未绑定也能拉），
 *    因为配置项本身就是给前端展示的、无敏感信息。
 *    写入暂不提供云函数接口——超管直接在 mp 后台「云数据库 / 云开发」面板改 app_config 表即可（免审）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const { ok, fail } = require('./common/resp');

const TABLE = 'app_config';

/**
 * 智能还原：v 以 { 或 [ 开头且能 JSON.parse 则解析为对象/数组，否则原样返回字符串。
 * 这样手改数据库最友好：纯文案直接填文字，结构化配置填 JSON。
 */
function decodeValue(raw) {
  if (typeof raw !== 'string') return raw;
  const t = raw.trim();
  if ((t[0] === '{' && t[t.length - 1] === '}') || (t[0] === '[' && t[t.length - 1] === ']')) {
    try { return JSON.parse(t); } catch (e) { /* 不是合法 JSON：原样返回，避免吞掉内容 */ }
  }
  return raw;
}

async function getConfig() {
  const pool = getPool();
  const [rows] = await pool.query('SELECT k, v FROM ' + TABLE);
  const items = {};
  for (const r of rows) items[r.k] = decodeValue(r.v);
  return items;
}

const routes = {
  /** 公开读全表 → { k: v } */
  get: {
    auth: null,
    handler: async () => getConfig()
  }
};

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const data = await route.handler((event && event.payload) || {}, {});
    return ok(data);
  } catch (e) {
    console.error('[config] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
