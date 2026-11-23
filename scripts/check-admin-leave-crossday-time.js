#!/usr/bin/env node
/**
 * 门禁：后台请假时间口径 —— 跨天「首日开始/末日结束」不得被同一天校验拦下（2026-11-22）
 * --------------------------------------------------------------------------------
 * 用户报：后台编辑跨天请假，起始 11/22、结束 11/24、开始 19:00、结束 08:00，
 *   保存报「开始时间须早于结束时间」。但口径是「开始=首日开始、结束=末日结束」
 *   （与小程序 adjust 的 1.0.8.77 跨天连续口径一致），跨天 start>=end 完全合法。
 *
 * 根因：admin-web mod-leave 的 updateLeave/createLeave 无条件 `start>=end → 抛错`，
 *   那是"同一天内时段"的旧假设。修复：抽出 assertTimeOrder，仅单日(start==end)才校验先后。
 *
 * 反馈回路：vm 加载真实 mod-leave.js + mock pool，调 updateLeave/createLeave，
 *   断言跨天 19:00/08:00 能保存、单日 19:00/08:00 仍被拒；再变异源码把 helper
 *   改回无条件校验，确认判据翻红（不是假绿）。
 *
 * 用法：node scripts/check-admin-leave-crossday-time.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'cloudfunctions/admin-web/lib/mod-leave.js');
const SRC = fs.readFileSync(FILE, 'utf8');

let failed = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg + (extra ? '  ' + extra : ''));
  if (!cond) failed++;
};

class BizError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

function loadMod(src) {
  const queries = [];
  const pool = {
    query: async (sql, args) => {
      queries.push({ sql: String(sql), args });
      if (/SELECT l\.\*/i.test(sql)) {
        return [[{
          id: 7, member_id: 13, member_class_id: 3,
          start_date: '2026-11-22', end_date: '2026-11-24',
          start_time: '19:00:00', end_time: '08:00:00', status: 'APPROVED'
        }]];
      }
      if (/FROM member/i.test(sql)) return [[{ id: 13, name: '测试', class_id: 3 }]];
      if (/FROM duty/i.test(sql)) return [[]];
      if (/INSERT INTO leave_request/i.test(sql)) return [{ insertId: 8 }];
      if (/UPDATE leave_request/i.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    }
  };
  const req = (rel) => {
    if (rel === '../common/db') return { getPool: () => pool };
    if (rel === './audit') return { logAction: async () => {} };
    if (rel === '../common/resp') return { BizError };
    if (rel === '../common/test-account') return { NOT_TEST: () => '1=1' };
    return {};
  };
  const m = { exports: {} };
  new Function('require', 'module', 'exports', src)(req, m, m.exports);
  return { mod: m.exports, queries };
}

async function tryUpdate(mod, startDate, endDate, startTime, endTime) {
  try {
    await mod.updateLeave(
      { id: 7, startDate, endDate, startTime, endTime, status: 'APPROVED' },
      { memberId: 1 }, {}
    );
    return null;
  } catch (e) { return e.message; }
}
async function tryCreate(mod, startDate, endDate, startTime, endTime) {
  try {
    await mod.createLeave(
      { classId: 3, memberId: 13, startDate, endDate, startTime, endTime, status: 'APPROVED' },
      { memberId: 1 }, {}
    );
    return null;
  } catch (e) { return e.message; }
}

(async () => {
  console.log('\n【1】静态：helper 存在且两处调用都走它');
  ok(/function assertTimeOrder\(startTime, endTime, startDate, endDate\)/.test(SRC), 'assertTimeOrder 定义存在');
  ok((SRC.match(/assertTimeOrder\(startTime, endTime, startDate, endDate\)/g) || []).length >= 2,
    'updateLeave 与 createLeave 两处都调用 helper');
  ok(/startDate === endDate/.test(SRC), '仅单日(start===end)才判先后');
  ok(!/if \(startTime && endTime && startTime >= endTime\) throw/.test(SRC),
    '旧的 unconditional start>=end 抛错已清除');

  const { mod, queries } = loadMod(SRC);

  console.log('\n【2】编辑跨天请假（用户场景）');
  const cross = await tryUpdate(mod, '2026-11-22', '2026-11-24', '19:00', '08:00');
  ok(!cross, '跨天 19:00/08:00 保存不报错', cross || '');
  ok(queries.some(q => /UPDATE leave_request/i.test(q.sql)), '确实执行了 UPDATE');

  console.log('\n【3】边界：单日仍拒、跨天其它组合合法');
  ok((await tryUpdate(mod, '2026-11-22', '2026-11-22', '19:00', '08:00')) === '开始时间须早于结束时间',
    '单日 19:00/08:00 仍被拒');
  ok(!(await tryUpdate(mod, '2026-11-22', '2026-11-24', '08:00', '19:00')), '跨天 08:00/19:00 可保存');
  ok(!(await tryUpdate(mod, '2026-11-22', '2026-11-24', '09:00', '09:00')), '跨天相等时刻可保存');

  console.log('\n【4】后台代登记跨天同样口径');
  ok(!(await tryCreate(mod, '2026-11-22', '2026-11-24', '19:00', '08:00')), 'create 跨天 19:00/08:00 可保存');
  ok((await tryCreate(mod, '2026-11-22', '2026-11-22', '19:00', '08:00')) === '开始时间须早于结束时间',
    'create 单日 19:00/08:00 仍被拒');

  console.log('\n【5】变异自证：把 helper 改回无条件校验 ⇒ 判据翻红');
  const mutant = SRC.replace(
    'if (startTime && endTime && startDate === endDate && startTime >= endTime) {',
    'if (startTime && endTime && startTime >= endTime) {'
  );
  ok(mutant !== SRC, '变异锚点命中源码');
  const mMod = loadMod(mutant);
  const mCross = await tryUpdate(mMod.mod, '2026-11-22', '2026-11-24', '19:00', '08:00');
  ok(mCross === '开始时间须早于结束时间',
    '变异：无条件校验 ⇒ 跨天又被拒（判据翻红）', mCross || '(未拒绝)');

  console.log('\n结果: ' + (failed === 0 ? '全部通过' : failed + ' 项失败'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('门禁自身异常:', e && e.stack); process.exit(1); });
