/**
 * 云函数：stat —— 小程序端使用埋点（2026-10-16）
 *
 * action: track
 *   接收小程序批量上报的事件，写入 usage_event 表。
 *   事件维度：kind ∈ {page_view, action}；event 为功能/页面键；ref 为可选子键。
 *
 * 设计取舍：
 *   · 任何已绑定成员都可上报（needBind），不限制角色——埋点要覆盖所有人。
 *   · 上报失败不影响主流程（前端 track 层已静默丢弃），这里只管落库。
 *   · 批量插入（VALUES ?），前端按防抖合并上报，降低调用次数。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const { BizError, ok, fail } = require('./common/resp');

const KINDS = { page_view: 1, action: 1 };
const MAX_BATCH = 50;
const MAX_LEN = 64;

async function track(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  const openid = (m && m.openid) || ctx.openid || '';
  const classId = (m && m.class_id) || 0;
  const list = Array.isArray(payload.events) ? payload.events : [];
  if (!list.length) return { ok: true, n: 0 };
  if (list.length > MAX_BATCH) list.length = MAX_BATCH;

  const rows = [];
  const now = new Date();
  for (const it of list) {
    if (!it || typeof it.event !== 'string' || !it.event) continue;
    const kind = KINDS[it.kind] ? it.kind : 'action';
    const event = it.event.slice(0, MAX_LEN);
    const ref = typeof it.ref === 'string' ? it.ref.slice(0, MAX_LEN) : '';
    rows.push([openid, classId, kind, event, ref, now]);
  }
  if (!rows.length) return { ok: true, n: 0 };

  const pool = getPool();
  await pool.query(
    'INSERT INTO usage_event (openid, class_id, kind, event, ref, ts) VALUES ?',
    [rows]
  );
  return { ok: true, n: rows.length };
}

const routes = { track: { auth: { needBind: true }, handler: track } };

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[stat] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
