/**
 * 云函数：fee —— 班费 / 团费（2026-10-14）
 *
 * action: getSummary / setTotal / addExpense / deleteRecord
 *
 * 权限口径（与前端首页权限、util.POSITIONS 逐字一致）：
 *   · 总额设置：班费 = 超管 / 生活委员；团费 = 超管 / 班长兼团支书。
 *   · 消费登记 / 删记录：班费 = 班长兼团支书 / 副班长 / 生活委员 / 超管；
 *                       团费 = 班长兼团支书 / 超管。
 *   · 查看（getSummary）：所有已绑定成员（含普通成员，仅展示余额）。
 *   · 余额 = total - SUM(amount)，运行时计算，不落库。
 *
 * 图片：消费图片客户端直传云存储，服务端只存 fileID 数组（JSON）；
 *       删记录时顺手删云存储文件（删不掉不报错）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const { BizError, ok, fail } = require('./common/resp');

const TYPES = ['class', 'league'];
const MAX_IMAGES = 9;
const MAX_NOTE = 200;
const MAX_AMOUNT = 1000000;

/* ---------------- 权限判定（复用 guard 既有职位函数，口径与 MEMORY 铁律一致） ---------------- */

/** 能否登记消费 / 删记录 */
function feeManager(type, m) {
  if (guard.isSuper(m)) return true;
  if (type === 'league') return guard.isMonitor(m);           // 班长兼团支书
  return guard.isMonitor(m) || guard.isViceMonitor(m) || guard.isDutyAdmin(m); // 班长兼团支书 / 副班长 / 生活委员
}

/** 能否设置总额 */
function feeTotalSetter(type, m) {
  if (guard.isSuper(m)) return true;
  if (type === 'league') return guard.isMonitor(m);           // 班长兼团支书
  return guard.isDutyAdmin(m);                                // 生活委员
}

/** JSON 列兼容：JSON 列在 dateStrings=true 下可能返回字符串，统一规整成数组 */
function normImages(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  return [];
}

/* ---------------- 数据读取 ---------------- */

async function loadFund(pool, classId, type) {
  const [rows] = await pool.query(
    'SELECT total FROM class_fund WHERE class_id = ? AND type = ?',
    [classId, type]
  );
  const total = rows.length ? Number(rows[0].total) : 0;
  const [sum] = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) AS expense FROM class_fund_record WHERE class_id = ? AND type = ?',
    [classId, type]
  );
  const expenseTotal = Number(sum[0].expense);
  return { total, expenseTotal, balance: total - expenseTotal };
}

async function loadRecords(pool, classId, type, limit) {
  const [recs] = await pool.query(
    'SELECT id, amount, note, images, operator_id, operator_name, created_at FROM class_fund_record WHERE class_id = ? AND type = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    [classId, type, limit || 50]
  );
  return recs.map(r => ({
    id: r.id,
    amount: Number(r.amount),
    note: r.note || '',
    images: normImages(r.images),
    operatorId: r.operator_id,
    operatorName: r.operator_name || '',
    createdAt: String(r.created_at)
  }));
}

/* ---------------- 路由 ---------------- */

const routes = {
  /** 查看：所有已绑定成员可读（余额 + 明细）。前端按权限决定是否可操作。 */
  getSummary: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = await guard.resolveClassId(getPool(), ctx, payload);
      const pool = getPool();
      const cls = await loadFund(pool, classId, 'class');
      const league = await loadFund(pool, classId, 'league');
      return {
        class: Object.assign({}, cls, { records: await loadRecords(pool, classId, 'class') }),
        league: Object.assign({}, league, { records: await loadRecords(pool, classId, 'league') })
      };
    }
  },

  /** 设置总额（超管 / 生活委员[班费] / 班长兼团支书[团费]）。余额 = total - 已消费，自动联动。 */
  setTotal: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = await guard.resolveClassId(getPool(), ctx, payload);
      const type = TYPES.indexOf(payload.type) >= 0 ? payload.type : null;
      if (!type) throw new BizError(41001, '参数错误');
      if (!feeTotalSetter(type, me)) {
        throw new BizError(40003, type === 'league' ? '仅超级管理员或班长兼团支书可设置团费总额' : '仅超级管理员或生活委员可设置班费总额');
      }
      const total = Number(payload.total);
      if (!Number.isFinite(total) || total < 0) throw new BizError(41001, '总额须为不小于 0 的数字');
      if (total > MAX_AMOUNT) throw new BizError(41001, '总额过大');
      const pool = getPool();
      await pool.query(
        'INSERT INTO class_fund (class_id, type, total) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE total = ?',
        [classId, type, total, total]
      );
      console.log(JSON.stringify({ fn: 'fee', action: 'setTotal', by: me.id, classId, type, total }));
      return { type, total, balance: total };
    }
  },

  /** 登记消费（班委 / 超管；团费仅班长兼团支书 / 超管）。 */
  addExpense: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = await guard.resolveClassId(getPool(), ctx, payload);
      const type = TYPES.indexOf(payload.type) >= 0 ? payload.type : null;
      if (!type) throw new BizError(41001, '参数错误');
      if (!feeManager(type, me)) {
        throw new BizError(40003, type === 'league' ? '仅班长兼团支书或超级管理员可登记团费消费' : '仅班委或超级管理员可登记班费消费');
      }
      const amount = Number(payload.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new BizError(41001, '金额须大于 0');
      if (amount > MAX_AMOUNT) throw new BizError(41001, '金额过大');
      const note = String(payload.note || '').slice(0, MAX_NOTE);
      const images = Array.isArray(payload.images)
        ? payload.images
            .filter(x => typeof x === 'string' && x.indexOf('cloud://') === 0)
            .slice(0, MAX_IMAGES)
        : [];
      const pool = getPool();
      const [r] = await pool.query(
        'INSERT INTO class_fund_record (class_id, type, amount, note, images, operator_id, operator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
        [classId, type, amount, note, JSON.stringify(images), me.id, me.name || '']
      );
      console.log(JSON.stringify({ fn: 'fee', action: 'addExpense', by: me.id, classId, type, amount, imgs: images.length, recId: r.insertId }));
      return { id: r.insertId };
    }
  },

  /** 删除消费记录（同消费登记权限）；连带删云存储图片。 */
  deleteRecord: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = await guard.resolveClassId(getPool(), ctx, payload);
      const type = TYPES.indexOf(payload.type) >= 0 ? payload.type : null;
      if (!type) throw new BizError(41001, '参数错误');
      if (!feeManager(type, me)) {
        throw new BizError(40003, type === 'league' ? '仅班长兼团支书或超级管理员可删除团费记录' : '仅班委或超级管理员可删除班费记录');
      }
      const recId = Number(payload.id);
      if (!recId) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rec] = await pool.query(
        'SELECT id, images FROM class_fund_record WHERE id = ? AND class_id = ? AND type = ?',
        [recId, classId, type]
      );
      if (!rec.length) throw new BizError(41004, '记录不存在');
      const imgs = normImages(rec[0].images);
      await pool.query(
        'DELETE FROM class_fund_record WHERE id = ? AND class_id = ? AND type = ?',
        [recId, classId, type]
      );
      for (const f of imgs) {
        try { await cloud.deleteFile({ fileList: [f] }); } catch (e) { /* 云存储删不掉不影响记录已删 */ }
      }
      console.log(JSON.stringify({ fn: 'fee', action: 'deleteRecord', by: me.id, recId, classId, type }));
      return { id: recId };
    }
  },

  /**
   * 给「已有消费记录」补充凭证图片（班费 / 团费都支持）。
   * 权限同消费登记 / 删除（feeManager）；校验记录属本班 + 该 type、当前图数 < 9、合并后 ≤ 9，
   * 仅追加 images，不动金额 / 备注 / 操作人。班费卡现已对普通成员 view-only，本动作只向管理人开放。
   */
  feeAppendImages: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const me = guard.requireBind(ctx);
      const classId = await guard.resolveClassId(getPool(), ctx, payload);
      const type = TYPES.indexOf(payload.type) >= 0 ? payload.type : null;
      if (!type) throw new BizError(41001, '参数错误');
      if (!feeManager(type, me)) {
        throw new BizError(40003, type === 'league' ? '仅班长兼团支书或超级管理员可补充团费凭证' : '仅班委或超级管理员可补充班费凭证');
      }
      const recId = Number(payload.id);
      if (!recId) throw new BizError(41001, '参数错误');
      const addImgs = Array.isArray(payload.images)
        ? payload.images
            .filter(x => typeof x === 'string' && x.indexOf('cloud://') === 0)
            .slice(0, MAX_IMAGES)
        : [];
      if (!addImgs.length) throw new BizError(41001, '没有可补充的图片');
      const pool = getPool();
      const [rec] = await pool.query(
        'SELECT id, images FROM class_fund_record WHERE id = ? AND class_id = ? AND type = ?',
        [recId, classId, type]
      );
      if (!rec.length) throw new BizError(41004, '记录不存在');
      const cur = normImages(rec[0].images);
      if (cur.length >= MAX_IMAGES) throw new BizError(41001, '图片已达上限（9 张）');
      const merged = cur.concat(addImgs.slice(0, MAX_IMAGES - cur.length));
      await pool.query(
        'UPDATE class_fund_record SET images = ? WHERE id = ? AND class_id = ? AND type = ?',
        [JSON.stringify(merged), recId, classId, type]
      );
      console.log(JSON.stringify({ fn: 'fee', action: 'feeAppendImages', by: me.id, recId, classId, type, added: merged.length - cur.length }));
      return { id: recId, images: merged };
    }
  }
};

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
    console.error('[fee] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
