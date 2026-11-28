/**
 * 后台 → 小程序云函数 · 服务端票据桥接（2026-11-28）
 * ============================================================
 * 为什么需要它：
 *   网页后台跑在 HTTP 云函数里，没有微信上下文，cloud.getWXContext().OPENID 为空。
 *   既有 12 个小程序云函数的写接口全部靠 OPENID 取身份 ⇒ 后台一条都调不了。
 *   过去后台要提供同类编辑能力，只能在 admin-web 里重写一遍写库 SQL ——
 *   于是排班游标、通知双记录、审计日志各有两份实现，改一处漏一处（M1 同源漏改）。
 *
 * 做法：后台在**服务端**用当前登录会话签发一张短时效票据，随 callFunction 传给
 *   目标云函数；共用 guard.getContext(event) 验票后构造与小程序同构的 ctx，
 *   于是原来的 route.handler(payload, ctx) 一行不改就能被后台复用。
 *
 * 安全边界（改之前先读完，四条缺一不可）：
 *   S1 票据只在**服务端**签发：raw sid 来自 HttpOnly Cookie，浏览器 JS 读不到，
 *      小程序端更拿不到。签发函数绝不暴露给前端 API。
 *   S2 验票必须回查 admin_session + admin_user + member 三张表：
 *      会话过期 / 后台账号停用 / 成员被停用或删除，票据立即作废。
 *   S3 票据 60 秒过期：拦截抓包重放；后台每次请求现签一张，不做缓存。
 *   S4 权限判定仍在 admin-web 路由的 requirePerm / requireSuper：
 *      云函数侧只回答「这是一个有效的后台账号」，不自行推导页签权限。
 *      降权后后台路由立刻 403，旧票据即便未过期也越不过闸。
 *
 * ⚠️ 不要把本模块当作小程序侧的身份来源：guard 只在检测到 __wbAdminBridge
 *    字段时走这里，正常小程序请求永远是 OPENID 流程，两者不可混用。
 */
const crypto = require('crypto');

const TICKET_VERSION = 1;
const MAX_AGE_MS = 60 * 1000;
const TICKET_FIELD = '__wbAdminBridge';

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

/**
 * 签发（仅 admin-web 服务端调用，绝不返回给浏览器）
 * @param {string} rawSid  Cookie admin_sid 的原始值
 * @param {number|string} memberId 当前后台登录对应的 member.id
 * @param {number|string} [classId] 目标班级；只有超管可覆盖自己的主班
 * @returns {{v:number,sid:string,memberId:number,classId:number,ts:number}|null}
 */
function issueTicket(rawSid, memberId, classId) {
  const sid = String(rawSid || '');
  const mid = Number(memberId) || 0;
  if (!sid || !mid) return null;
  return { v: TICKET_VERSION, sid, memberId: mid, classId: Number(classId) || 0, ts: Date.now() };
}

/**
 * 验票（云函数侧调用）。失败一律返回 null，由 guard 统一抛 40001。
 * 返回 member 行（字段与 SELECT * FROM member 同构），供 guard 构造 ctx。
 *
 * ⚠️ SQL 只查活动会话；member.status 必须是 ACTIVE；后台账号 status 必须是 1。
 *    ticket.memberId 必须与会话绑定的 member_id 一致 —— 防止拿 A 的 sid
 *    配 B 的 memberId 提权。
 */
async function verifyTicket(ticket, pool) {
  try {
    if (!ticket || typeof ticket !== 'object') return null;
    if (Number(ticket.v) !== TICKET_VERSION) return null;
    if (!ticket.sid || !ticket.memberId) return null;
    const ts = Number(ticket.ts) || 0;
    const age = Date.now() - ts;
    if (!ts || age < 0 || age > MAX_AGE_MS) return null;

    const [rows] = await pool.query(
      'SELECT a.member_id AS admin_member_id, a.status AS admin_status, m.* ' +
      'FROM admin_session s ' +
      'JOIN admin_user a ON a.id = s.admin_id ' +
      'JOIN member m ON m.id = a.member_id ' +
      'WHERE s.sid = ? AND s.expires_at > NOW() LIMIT 1',
      [sha256(ticket.sid)]
    );
    const row = rows && rows[0];
    if (!row) return null;
    if (Number(row.admin_status) !== 1) return null;
    if (Number(row.admin_member_id) !== Number(ticket.memberId)) return null;
    if (String(row.status || '') !== 'ACTIVE') return null;

    // 去掉 join 带来的两个别名，返回的必须是一张干净的 member 行。
    const member = {};
    Object.keys(row).forEach(function (k) {
      if (k !== 'admin_member_id' && k !== 'admin_status') member[k] = row[k];
    });
    if (!member.id) return null;

    /* 目标班级覆盖（S5）：小程序写接口一律用 guard.classIdOf(ctx) 取班，
       后台切换班级选择器时必须让 handler 看到目标班，否则会改错班。
       ⚠️ 只有超管（role=ADMIN 且 is_super=1）能覆盖；其余角色必须锁在自己的
       member.class_id —— 否则后台就变成生活委员跨班排班的越权通道。 */
    const requested = Number(ticket.classId) || 0;
    if (requested) {
      const isSuper = String(member.role || '') === 'ADMIN' && Number(member.is_super) === 1;
      if (!isSuper && Number(member.class_id) !== requested) return null;
      member.class_id = requested;
    }
    return member;
  } catch (e) {
    console.error('[admin-bridge] verify failed', (e && e.message) || e);
    return null;
  }
}

module.exports = {
  TICKET_VERSION, MAX_AGE_MS, TICKET_FIELD,
  sha256, issueTicket, verifyTicket
};
