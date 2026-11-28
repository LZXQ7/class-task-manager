/**
 * 全站请求缓存层（v1.0.8.75，2026-11-20）
 * --------------------------------------------------------------------------------
 * 目标：已加载过的内容缓存住，再次切到该页面不用重新请求、秒显；跨重启仍保留。
 *
 * 策略（用户确认口径）：
 *   · **读接口命中缓存直接返回旧值、不发请求**（SWR 的「stale」半边）；无缓存或
 *     超过 TTL 才真发请求。新鲜度由 TTL 控制（默认 120s，opt.cacheTtl 可覆盖）。
 *   · **写操作成功后清空全部缓存**（见 request.js：WRITE_ACTION 成功分支调 clear()）。
 *   · key = 接口(name+action) + 稳定序列化的 payload + 当前成员 id + viewClassId，
 *     **身份维度进 key**（用户确认「必须包含」），切账号 / 切班自动隔离、不串数据。
 *   · 内存 + Storage 双写：内存命中最快（本次运行），Storage 命中跨重启保留。
 *
 * ⚠️ 隐私：班务数据（含姓名/学号）会落本地 Storage —— 用户明确要「跨重启保留」。
 *    Storage 单 key ≤1MB / 总量 ≤10MB；本模块只缓存结构化 JSON 且单条超限不写。
 * ⚠️ 沙盒安全：门禁 check-network-retry 在**无 require / 桩 wx**的 vm 里加载 request.js；
 *    本模块所有 getApp / wx.getStorageSync 都做存在性判断，缺失时纯内存或 no-op，绝不抛错。
 */
const PREFIX = 'rqc:';
const DEFAULT_TTL = 120 * 1000;      // 2 分钟
const MAX_BYTES = 900 * 1024;        // 单条上限（Storage 单 key 1MB，留余量）
/* v1.0.8.76：本地缓存加密 —— 门禁在无 require 的 vm 里加载 request.js，故做存在性守卫 */
const crypto = (typeof require === 'function') ? require('./cache-crypto') : null;

/**
 * 取加密密钥：auth.login 下发、app.js 只存**内存**（app.globalData.cacheKey）。
 * 绝不落 Storage —— 锁和钥匙不能放一起。
 * 拿不到 ⇒ 返回 ''，调用方跳过 Storage（内存缓存仍可用，功能不受影响）。
 */
function cacheKeyOf() {
  try {
    if (typeof getApp !== 'function') return '';
    const app = getApp();
    return (app && app.globalData && app.globalData.cacheKey) || '';
  } catch (e) { return ''; }
}

/**
 * ⚠️ 可缓存的**只读白名单**（精确匹配 name.action）——v1.0.8.75 收紧为白名单制。
 * 最初设想「读接口全部缓存」，但盘点 66 个读接口发现多个**有副作用却名字不含写关键词**：
 *   msgRead / appNoticeSeen / msgPopupSeen（标记已读）、leaveApprove（审批）、
 *   syncFromClass（同步写库）、remindReopen（重开提醒）、testRemind（发提醒）——
 * 这些一旦被缓存，已读/审批状态会停在上次的值，是真会误事的 bug。
 * 所以只放**纯读、幂等、切页会重复拉**的接口；其余一律不缓存（不追求覆盖率，先保证安全）。
 */
const ALLOW = {
  'member.stats': 1, 'member.list': 1,
  'course.listWeek': 1, 'course.allSessions': 1, 'course.calendar': 1,
  'schedule.listWeek': 1, 'schedule.manualBoard': 1, 'schedule.speechBoard': 1,
  'duty.today': 1, 'duty.myStats': 1, 'duty.detail': 1, 'duty.myList': 1,
  'adjust.leaveBoard': 1, 'adjust.leaveSummary': 1, 'adjust.leaveMyList': 1,
  'adjust.leavePendingList': 1, 'adjust.countdownList': 1,
  'media.msgList': 1, 'media.msgRecycleList': 1,
  'class.list': 1, 'class.detail': 1,
  'fee.getSummary': 1,
  'config.get': 1
};

/** 该接口是否允许缓存（精确白名单 + 非写 action 双重判定由 request.js 保证） */
function cacheable(name, action) {
  return !!ALLOW[String(name) + '.' + String(action)];
}

/** 身份维度：当前成员 id + 正在查看的班级 id（拿不到时 0，沙盒下也安全） */
function identity() {
  let app = null;
  try {
    if (typeof getApp === 'function') app = getApp();
  } catch (e) { app = null; }
  const g = (app && app.globalData) || {};
  const p = g.profile || {};
  return {
    mid: Number(p.id) || 0,
    cid: Number(g.viewClassId) || 0,
    demo: p.demo ? 1 : 0,
    switched: g.switched ? 1 : 0
  };
}

/** 稳定序列化：对象 key 排序，避免 {a,b} 与 {b,a} 生成不同 key */
function stable(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => k + ':' + stable(v[k])).join(',') + '}';
  }
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/** 生成缓存 key（身份 + 接口 + 参数） */
function makeKey(name, action, payload) {
  const id = identity();
  return PREFIX + [name, action, id.mid, id.cid, id.demo, id.switched, stable(payload || {})].join('|');
}

/** Storage 是否可用（vm 沙盒里 wx 是桩，没有 getStorageSync） */
function storageOk() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function';
}

/** 读缓存：内存优先，其次 Storage；带 TTL。命中返回 data，否则 null */
function read(key, ttl) {
  if (!key) return null;
  /* ttl=0 ⇒ 立即过期（等价于本次绕过缓存，供 opt.cacheTtl=0 强制拉新）；负值/缺省 ⇒ 默认 TTL */
  const maxAge = Number(ttl) === 0 ? 0 : (Number(ttl) > 0 ? Number(ttl) : DEFAULT_TTL);
  const now = Date.now();

  /* ① 内存：同样带时间戳（getApp 拿不到时跳过） */
  let memSlot = null;
  try {
    if (typeof getApp === 'function') {
      const app = getApp();
      if (app) {
        const g = app.globalData || (app.globalData = {});
        memSlot = g._reqCache || (g._reqCache = {});
      }
    }
  } catch (e) { memSlot = null; }
  if (memSlot && memSlot[key] && now - memSlot[key].t < maxAge) return memSlot[key].v;

  /* ② Storage：跨重启，存的是**密文**。过期条目 / 老版本明文残留顺手删掉。 */
  if (storageOk()) {
    const ck = cacheKeyOf();
    try {
      const raw = wx.getStorageSync(key);
      if (raw && typeof raw === 'object' && typeof raw.t === 'number') {
        /* 密文形状 = {n,c,t}；旧版明文 = {t,v}（v 非字符串密文）——一律当未命中并清除，
           绝不能把升级前落的明文读出来用，否则加密等于没做。 */
        const isCipher = typeof raw.n === 'string' && typeof raw.c === 'string';
        if (!isCipher || !ck || !crypto) { wx.removeStorageSync(key); if (memSlot && memSlot[key]) delete memSlot[key]; return null; }
        if (now - raw.t < maxAge) {
          const plain = crypto.decrypt(raw.n, raw.c, ck);
          let rec = null;
          if (plain) { try { rec = JSON.parse(plain); } catch (e) { rec = null; } }
          if (rec && typeof rec.t === 'number' && rec.v !== undefined) {
            if (memSlot) memSlot[key] = rec;   // 回填内存（明文只在进程内）
            return rec.v;
          }
          wx.removeStorageSync(key);   // 解密失败 / 内容损坏 ⇒ 删掉，下次重新拉
        } else {
          wx.removeStorageSync(key);
        }
      }
    } catch (e) { /* Storage / 解密异常当未命中 */ }
  }
  if (memSlot && memSlot[key]) delete memSlot[key];
  return null;
}

/** 写缓存：内存 + Storage 双写 */
function write(key, data) {
  if (!key) return;
  const rec = { t: Date.now(), v: data };
  try {
    if (typeof getApp === 'function') {
      const app = getApp();
      if (app) {
        const g = app.globalData || (app.globalData = {});
        const memSlot = g._reqCache || (g._reqCache = {});
        memSlot[key] = rec;
      }
    }
  } catch (e) { /* 内存不可用不影响 Storage */ }
  if (storageOk()) {
    const ck = cacheKeyOf();
    /* 密钥缺失（未登录 / 老版本 auth 未下发）⇒ 不写明文！宁可失去跨重启缓存，也不裸奔。 */
    if (ck && crypto) {
      try {
        const plain = JSON.stringify(rec);
        if (plain.length * 2 <= MAX_BYTES) {
          const enc = crypto.encrypt(plain, ck);
          if (enc) wx.setStorageSync(key, { n: enc.nonce, c: enc.ct, t: rec.t });
        }
      } catch (e) { /* 超限 / Storage 满 / 加密失败：静默跳过，缓存是纯优化 */ }
    }
  }
}

/**
 * 清空全部缓存（写操作成功后 / 身份切换时调用）。
 * 内存整体清；Storage 只清本模块前缀的键，不碰其它业务 Storage。
 */
function clear() {
  try {
    if (typeof getApp === 'function') {
      const app = getApp();
      if (app && app.globalData) app.globalData._reqCache = {};
    }
  } catch (e) { /* no-op */ }
  if (storageOk()) {
    try {
      const info = wx.getStorageInfoSync && wx.getStorageInfoSync();
      const keys = (info && info.keys) || [];
      keys.forEach(k => {
        if (typeof k === 'string' && k.indexOf(PREFIX) === 0) {
          try { wx.removeStorageSync(k); } catch (e) { /* no-op */ }
        }
      });
    } catch (e) { /* no-op */ }
  }
}

module.exports = { PREFIX, DEFAULT_TTL, ALLOW, cacheable, identity, stable, makeKey, read, write, clear };
