/**
 * 班费「额外授予」权限位（2026-11-08）
 *
 * 背景：班费权限原本 100% 由 member.position 推导（guard.isMonitor / isViceMonitor / isDutyAdmin）。
 *      现在允许后台在成员编辑里**单独**给某人加「登记班费消费 / 登记团费消费」，
 *      不动他的职位，也**不撤销**职位自带的任何权限（用户口径：只额外授予）。
 *
 * 存储：member.fee_perms VARCHAR(128) NOT NULL DEFAULT ''，逗号分隔的 key 白名单，例如 'class,league'。
 *      不用 JSON 列 —— 本项目 TDSQL 在 dateStrings=true 下 JSON 列可能返回字符串
 *      （见 fee/index.js 的 normImages 二态兼容），徒增解析分支。
 *
 * ⚠️ 白名单的**唯一真源**就是本文件。后台 admin-web/lib/mod-member.js、public/app.js、
 *    小程序 utils/util.js 的字面量由 scripts/check-fee-perms.js 守一致。
 *    以后新增权限项只需扩 FEE_PERM_KEYS + 后台 UI：小程序前端读后端下发的能力位，
 *    **不用再发版**（这正是 2026-11-08 改前端的意义）。
 *
 * ⚠️ 只覆盖「消费登记」：addExpense / deleteRecord / feeAppendImages 三者共用 feeManager，
 *    所以勾一项 = 这三项动作都放行（与职位口径完全一致：原来能登记的人也能删、能补图）。
 *    「设置总额」走 feeTotalSetter，本轮用户明确**不**单独授予，仍按职位。
 */
'use strict';

const FEE_PERM_KEYS = ['class', 'league'];

const FEE_PERM_LABELS = {
  class: '登记班费消费',
  league: '登记团费消费'
};

/** 把任意来源（数组 / 逗号串 / JSON 串 / null）规整成去重后的合法 key 数组 */
function normalizeFeePerms(v) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.charAt(0) === '[') {
      try { arr = JSON.parse(s); } catch (e) { return []; }
    } else {
      arr = s.split(',');
    }
  } else return [];
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const k = String(x).trim();
    if (FEE_PERM_KEYS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
  }
  return out;
}

/** 落库格式：逗号串。非法 key 一律被过滤，绝不写脏值。 */
function stringifyFeePerms(v) {
  return normalizeFeePerms(v).join(',');
}

/** member 行（SELECT * 出来的）是否被单独授予了 type 的消费登记权 */
function hasFeePerm(m, type) {
  if (!m || FEE_PERM_KEYS.indexOf(type) < 0) return false;
  return normalizeFeePerms(m.fee_perms).indexOf(type) >= 0;
}

module.exports = {
  FEE_PERM_KEYS,
  FEE_PERM_LABELS,
  normalizeFeePerms,
  stringifyFeePerms,
  hasFeePerm
};
