#!/usr/bin/env node
/**
 * 离线自检：辅导员「关注的学生 · 固定到主页」（v0.7.17 需求⑥）
 * ------------------------------------------------------------
 * 三段：
 *   ① 静态审计：路由/权限/上限/前后端接线
 *   ② **运行时**：把 `cloudfunctions/member/index.js` 原样 eval（桩化 require + 假连接池），
 *      真跑 pinList / pinToggle 的关键分支 —— 判据落在「拼出来的 SQL 与参数」上，
 *      而不是只在源码里找关键字（源码里写了过滤条件 ≠ 真的拼进 SQL）。
 *   ③ 变异必抓：把过滤/上限/权限任一环拆掉，①或②必须翻车。
 *
 * 为什么这一条值得单独门禁：
 *   `pinList` 会给教职工返回**学生姓名 + 最新一条备注正文**。备注是隐私内容
 *   （家庭情况等）。若班级过滤失效，辅导员就会看到自己没绑定的班级的学生与备注 ——
 *   这是越权读隐私，必须在离线阶段拦住，不能等真机回归。
 *
 * 用法：node scripts/check-staff-pin.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readM = (p) => fs.readFileSync(path.join(ROOT, 'miniprogram', p), 'utf8');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function chk(cond, msg) { if (cond) ok(msg); else bad(msg); }

const MEMBER_SRC = read('cloudfunctions/member/index.js');
const HOME_WXML = readM('pages/home/index.wxml');
const HOME_JS = readM('pages/home/index.js');
const ROSTER_WXML = readM('pages/roster/index.wxml');
const API_JS = readM('utils/api.js');

/* ============================================================
 * ① 静态审计（纯函数：吃源码文本，吐问题列表）
 * ============================================================ */
function auditStatic(src) {
  const p = [];
  const pinBlk = /pinList:\s*\{[\s\S]*?pinToggle:\s*\{[\s\S]*?\n  \},/.exec(src);
  if (!pinBlk) return ['member 里找不到 pinList / pinToggle 路由'];
  const blk = pinBlk[0];

  if (!/const PIN_MAX = \d+/.test(src)) p.push('缺少 PIN_MAX 常量（上限没有单一来源）');
  if (!/staffClassIds\s*\(/.test(blk)) p.push('pinList 没有用 staffClassIds 收窄班级范围：教职工会看到未绑定班级的学生与备注（越权读隐私）');
  if (!/m\.class_id IN \(/.test(blk)) p.push('pinList 没有把 class_id IN (…) 拼进 SQL：过滤条件算出来却没用上');
  // v0.7.18 需求①：主页关注**仅辅导员**（超管不再可见）→ 两个路由都必须自己卡这一道
  if (!/pinList[\s\S]*?if \(!guard\.isCounselor\(me\)\)/.test(src) || !/pinToggle[\s\S]*?if \(!guard\.isCounselor\(who\)\)/.test(src)) {
    p.push('pinList / pinToggle 没有单独卡「仅辅导员」（noteScopeOk 允许超管，不能当这道门）→ 超管仍会看到主页关注');
  }
  if (!/COUNT\(\*\) AS n FROM staff_pin WHERE staff_id = \?/.test(blk)) p.push('pinToggle 没有统计当前关注数，上限无从判断');
  if (!/>= PIN_MAX/.test(blk)) p.push('pinToggle 没有拦住超过 PIN_MAX 的情况');
  if (!/INSERT INTO staff_pin/.test(blk) || !/DELETE FROM staff_pin/.test(blk)) p.push('pinToggle 缺少新增/取消两个分支');
  if (!/noteScopeOk\(pool, ctx, memberId, '关注'\)/.test(blk)) p.push('pinToggle 没复用语义同源的 noteScopeOk 做范围校验（权限口子会与备注不一致）');
  return p;
}

console.log('── ① 静态审计：路由 / 权限 / 上限 / 接线');
{
  const probs = auditStatic(MEMBER_SRC);
  if (probs.length) probs.forEach(x => bad(x));
  else ok('member 的 pinList / pinToggle：staffClassIds 收窄 + class_id IN 拼入 + PIN_MAX 上限 + 增删两分支 + 复用 noteScopeOk');

  chk(/pinList: C\('member', 'pinList'\)/.test(API_JS) && /pinToggle: C\('member', 'pinToggle'\)/.test(API_JS),
    '前端 api.js 已登记 pinList / pinToggle');
  chk(/固定到主页/.test(ROSTER_WXML) && /onTogglePin/.test(ROSTER_WXML),
    '成员详情有「固定到主页」按钮');
  chk(/关注的学生/.test(HOME_WXML) && /onPinTap/.test(HOME_WXML),
    '首页有「关注的学生」卡片且可点开');
  // 可见范围（v0.7.18 需求①）：**仅辅导员**。两端同源，不会出现「能钉却看不到」
  chk(/const showPins = isCounselor;/.test(HOME_JS),
    '首页卡片只对辅导员渲染（showPins = isCounselor，不再跟着超管走）');
  chk(/pinVisible: isCounselor/.test(readM('pages/roster/index.js')) &&
      /wx:if="\{\{pinVisible && !mDetailIsSelf\}\}"/.test(ROSTER_WXML),
    '详情「固定到主页」按钮按 pinVisible（仅辅导员）门控，与后端同口径');
  chk(/noteVisible = isCounselor \|\|/.test(readM('pages/roster/index.js')),
    '备注（noteVisible）仍保留超管可见 —— 与「关注」是两套口径，不要连坐');

  // 孤儿清理
  chk(/DELETE FROM staff_pin WHERE staff_id = \?/.test(MEMBER_SRC) && /DELETE FROM staff_pin WHERE member_id = \?/.test(MEMBER_SRC),
    '删教职工 / 移出成员时清理 staff_pin（不留孤儿行）');
}

/* ============================================================
 * ② 运行时：原样 eval member/index.js，只替换 require 的目标
 *    假连接池按 SQL 形状作答，并记录每条语句 —— 判据看「真拼出来的 SQL 与 args」
 * ============================================================ */
const NOW_STR = '2026-09-26';
const ADMIN_SUPER = { id: 13, name: '示例成员01', role: 'ADMIN', is_super: 1, group_tag: 'A', class_id: 1 };
const COUNSELOR = { id: 72, name: '示例成员57', role: 'ADMIN', is_super: 0, group_tag: 'X', class_id: 0 };
const STUDENT = { id: 30, name: '张三', role: 'MEMBER', is_super: 0, group_tag: 'A', class_id: 1 };

function makePool(opts) {
  const o = opts || {};
  const stmts = [];
  return {
    stmts,
    async query(sql, args) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      stmts.push({ sql: s, args: args || [] });
      if (/^SELECT id, class_id FROM member WHERE id = \? LIMIT 1$/.test(s)) {
        return [o.target ? [{ id: o.target.id, class_id: o.target.classId }] : []];
      }
      if (/^SELECT member_id FROM staff_pin WHERE staff_id = \? AND member_id = \? LIMIT 1$/.test(s)) {
        return [o.pinned ? [{ member_id: args[1] }] : []];
      }
      if (/^SELECT COUNT\(\*\) AS n FROM staff_pin WHERE staff_id = \?$/.test(s)) {
        return [[{ n: o.count || 0 }]];
      }
      if (/FROM staff_pin p JOIN member m/.test(s)) return [o.rows || []];
      if (/^INSERT INTO staff_pin/.test(s)) { o.count = (o.count || 0) + 1; o.pinned = true; return [{ affectedRows: 1 }]; }
      if (/^DELETE FROM staff_pin WHERE staff_id = \? AND member_id = \?$/.test(s)) {
        o.count = Math.max(0, (o.count || 0) - 1); o.pinned = false; return [{ affectedRows: 1 }];
      }
      return [[]];
    }
  };
}

function loadMember(pool, me, allowed) {
  const mod = { exports: {} };
  const BizError = class BizError extends Error {
    constructor(code, msg, data) { super(msg); this.errCode = code; this.errMsg = msg; this.data = data; }
  };
  const guard = {
    getContext: async () => ({ openid: 'oTest', appid: '', member: me, realMember: me, impersonated: false }),
    requireBind(ctx) { if (!ctx.member) throw new BizError(40001, '未绑定班级'); return ctx.member; },
    requireAdmin(ctx) { const m = guard.requireBind(ctx); if (!['ADMIN', 'MONITOR'].includes(m.role)) throw new BizError(40003, '仅管理员可操作'); return m; },
    requireSuper(ctx) { const m = guard.requireBind(ctx); if (!guard.isSuper(m)) throw new BizError(40003, '仅超级管理员可操作'); return m; },
    isAdmin(m) { return !!(m && ['ADMIN', 'MONITOR'].includes(m.role)); },
    isSuper(m) { return !!(m && m.role === 'ADMIN' && m.is_super === 1); },
    isCounselor(m) { return !!(m && m.group_tag === 'X'); },
    classIdOf(ctx) {
      const m = ctx && (ctx.member || ctx.realMember);
      if (m && m.group_tag === 'X') return Number(m.class_id) || 0;
      return Number(m && m.class_id) || 1;
    },
    staffClassIds: async () => allowed,
    resolveClassId: async () => 1,
    ADMIN_ROLES: ['ADMIN', 'MONITOR']
  };
  const req = (id) => {
    if (id === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test' };
    if (id === './common/db') return { getPool: () => pool };
    if (id === './common/guard') return guard;
    if (id === './common/week') return { todayStr: () => NOW_STR, dateStr: x => String(x || ''), getConfig: async () => ({ termStart: '2026-09-14', totalWeeks: 16 }) };
    if (id === './common/audit') return { log: async () => {} };
    if (id === './xlsx-lite') return { parseXlsx: () => ({}), sheetToText: () => '' };
    if (id === './common/resp') return { BizError, ok: d => ({ errCode: 0, data: d }), fail: (c, m, d) => ({ errCode: c, errMsg: m, data: d }) };
    // 测试账号条件是 common 唯一真源（无状态、无副作用）⇒ 直接 require 真的，
    // 绝不在门禁里抄第二份：抄了就会漂移，而漂移的方向恰好是「门禁自己先失效」。
    if (id === './common/test-account') return require(path.join(ROOT, 'cloudfunctions', 'common', 'test-account.js'));
    // 演示态拦截模块（v1.0.6.4）：无状态纯函数，直接 require 真的（本用例非演示身份 ⇒ 全放行）
    if (id === './common/review-demo') return require(path.join(ROOT, 'cloudfunctions', 'common', 'review-demo.js'));
    throw new Error('门禁未桩化 require：' + id);
  };
  new Function('exports', 'require', 'module', 'console', MEMBER_SRC)(mod.exports, req, mod, { log() {}, error() {} });
  return mod.exports.main;
}

const call = (pool, me, allowed, action, payload) => loadMember(pool, me, allowed)({ action, payload: payload || {} });
const pinSqlOf = (pool) => {
  const hit = pool.stmts.filter(x => /FROM staff_pin p JOIN member m/.test(x.sql));
  return hit.length ? hit[hit.length - 1] : null;
};

(async () => {
  console.log('\n── ② 运行时：真跑 pinList / pinToggle（抽 member/index.js eval + 假连接池）');
  const rt = (id, cond, msg) => { if (cond) ok('[rt] ' + msg); else bad('[rt-' + id + '] ' + msg); };

  {
    // 教职工带 2 个绑定班 → 过滤必须真的拼进 SQL
    const pool = makePool({ rows: [{ member_id: 30, name: '张三', group_tag: 'A', class_id: 2, className: '示例班级B', avatar_url: '', latestNote: '家庭困难', noteCount: 1 }] });
    const r = await call(pool, COUNSELOR, [1, 2], 'pinList');
    const hit = pinSqlOf(pool);
    rt('c1', !!hit && /AND m\.class_id IN \(\?,\?\)/.test(hit.sql), '教职工查询按绑定班级收窄（SQL 里真出现 class_id IN (?,?)）');
    rt('c2', !!hit && JSON.stringify(hit.args) === JSON.stringify([72, 1, 2]), '参数顺序正确（staff_id=72 在前，班级 1/2 在后）');
    rt('c3', r.errCode === 0 && r.data.list.length === 1 && r.data.list[0].className === '示例班级B', '结果原样回给前端（含班级名与最新备注摘要）');
    rt('c4', r.data.limit === 8, '回传上限（前端显示「n/8」）');
  }

  {
    // 教职工一个班都没绑定 → 绝不能退化成「查全部」
    const pool = makePool({ rows: [{ member_id: 30 }] });
    const r = await call(pool, COUNSELOR, [], 'pinList');
    rt('c5', r.errCode === 0 && r.data.list.length === 0, '无绑定班的教职工拿到空列表');
    rt('c6', pinSqlOf(pool) === null, '无绑定班时**根本不发**无约束查询（不是「查了再滤」）');
  }

  {
    // v0.7.18 需求①：超管不再有主页关注（此前是「超管 ∨ 辅导员」）
    const pool = makePool({ rows: [] });
    const r = await call(pool, ADMIN_SUPER, [1], 'pinList');
    rt('c7', r.errCode === 40003, '超管被拒（40003）：主页关注仅辅导员可见');
    rt('c7b', pinSqlOf(pool) === null, '超管被拒时**根本没发查询**（不是查了再藏）');
  }

  {
    // 关注：新增
    const pool = makePool({ target: { id: 30, classId: 2 }, count: 0, pinned: false });
    const r = await call(pool, COUNSELOR, [2], 'pinToggle', { memberId: 30 });
    rt('c8', r.errCode === 0 && r.data.pinned === true && r.data.count === 1, '关注成功：返回 pinned=true 与新的计数');
    rt('c9', pool.stmts.some(x => /^INSERT INTO staff_pin/.test(x.sql)), '落库写了 INSERT');
  }

  {
    // 关注：上限
    const pool = makePool({ target: { id: 31, classId: 2 }, count: 8, pinned: false });
    const r = await call(pool, COUNSELOR, [2], 'pinToggle', { memberId: 31 });
    rt('c10', r.errCode === 41001, '第 9 个人被拦住（41001）');
    rt('c11', !pool.stmts.some(x => /^INSERT INTO staff_pin/.test(x.sql)), '被拦住时确实没写库');
  }

  {
    // 取消关注
    const pool = makePool({ target: { id: 30, classId: 2 }, count: 2, pinned: true });
    const r = await call(pool, COUNSELOR, [2], 'pinToggle', { memberId: 30 });
    rt('c12', r.errCode === 0 && r.data.pinned === false && r.data.count === 1, '取消关注：返回 pinned=false 与新的计数');
    rt('c13', pool.stmts.some(x => /^DELETE FROM staff_pin WHERE staff_id/.test(x.sql)), '落库写了 DELETE');
  }

  {
    // 越权：目标学生不在自己绑定的班里
    const pool = makePool({ target: { id: 40, classId: 3 }, count: 0, pinned: false });
    const r = await call(pool, COUNSELOR, [2], 'pinToggle', { memberId: 40 });
    rt('c14', r.errCode === 40003, '跨班关注被拒（40003）');
    rt('c15', !pool.stmts.some(x => /^INSERT INTO staff_pin/.test(x.sql)), '被拒时没有写库');
  }

  {
    // 越权：学生身份根本不该能用这个功能
    const pool = makePool({ target: { id: 30, classId: 1 }, count: 0, pinned: false });
    const r = await call(pool, STUDENT, [1], 'pinToggle', { memberId: 30 });
    rt('c16', r.errCode === 40003, '学生身份被拒（40003）：学生不可关注同学');
    const r2 = await call(makePool({}), STUDENT, [1], 'pinList');
    rt('c17', r2.errCode === 40003, '学生身份连列表都拿不到（40003）');
    // 超管同样不能关注（v0.7.18：仅辅导员）
    const r3 = await call(makePool({ target: { id: 30, classId: 1 }, count: 0, pinned: false }), ADMIN_SUPER, [1], 'pinToggle', { memberId: 30 });
    rt('c18', r3.errCode === 40003, '超管也不能关注（40003）：该功能是辅导员专属');
  }

  console.log('\n── ③ 变异必抓（拆掉任一环必须翻车）');
  {
    // 变异 1：去掉班级过滤拼接
    const m1 = MEMBER_SRC.replace("        sql += ' AND m.class_id IN (' + allowed.map(() => '?').join(',') + ')';\n", '');
    chk(m1 !== MEMBER_SRC && auditStatic(m1).length > 0, '变异 1：删掉 class_id IN 拼接 → 静态审计翻车');

    // 变异 2：上限判断失效
    const m2 = MEMBER_SRC.replace('if (Number(cnt[0].n) >= PIN_MAX) {', 'if (false) {');
    chk(m2 !== MEMBER_SRC && auditStatic(m2).length > 0, '变异 2：上限判断被短路 → 静态审计翻车');

    // 变异 3：权限校验降级成「只要绑定了就行」
    const m3 = MEMBER_SRC.replace("const me = await noteScopeOk(pool, ctx, memberId, '关注');", 'const me = guard.requireBind(ctx);');
    chk(m3 !== MEMBER_SRC && auditStatic(m3).length > 0, '变异 3：不再复用 noteScopeOk → 静态审计翻车');

    // 变异 4（运行时）：真把过滤条件删掉后，运行时判据是否也翻车
    const pool = makePool({ rows: [{ member_id: 30 }] });
    const main = (() => {
      const mod = { exports: {} };
      const BizError = class extends Error { constructor(c, m) { super(m); this.errCode = c; this.errMsg = m; } };
      const guard = {
        getContext: async () => ({ openid: 'o', member: COUNSELOR, realMember: COUNSELOR }),
        requireBind: c => c.member, requireAdmin: c => c.member, requireSuper: c => c.member,
        isAdmin: () => true, isSuper: () => false, isCounselor: () => true,
        classIdOf: () => 0, staffClassIds: async () => [2], resolveClassId: async () => 2, ADMIN_ROLES: []
      };
      const req = (id) => {
        if (id === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 't' };
        if (id === './common/db') return { getPool: () => pool };
        if (id === './common/guard') return guard;
        if (id === './common/resp') return { BizError, ok: d => ({ errCode: 0, data: d }), fail: (c, m) => ({ errCode: c, errMsg: m }) };
        if (id === './common/review-demo') return { isReviewDemo: () => false, denyDemo: () => {} };
        return { todayStr: () => NOW_STR, dateStr: x => String(x), getConfig: async () => ({}), log: async () => {}, parseXlsx: () => ({}), sheetToText: () => '' };
      };
      new Function('exports', 'require', 'module', 'console', m1)(mod.exports, req, mod, { log() {}, error() {} });
      return mod.exports.main;
    })();
    await main({ action: 'pinList', payload: {} });
    const hit = pinSqlOf(pool);
    chk(!!hit && !/class_id IN/.test(hit.sql), '变异 4：过滤被删后，运行时 SQL 里确实不再有 class_id IN（证明运行时判据盯的就是真 SQL）');
  }

  console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 主页关注（staff_pin）体检全部通过'));
  process.exit(failed ? 1 : 0);
})();
