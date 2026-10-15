/**
 * 测试账号（唯一真源）
 * ============================================================
 * 学号 0000000000xx 段（id 69+）是**合成测试账号**，不是真人。
 *
 * ## 铁律（2026-10-08 用户定）：所有人员列表一律不展示测试账号
 *   包括超管。之前 member.manage 是「仅超管可见」，现已统一为**一律不显示** ——
 *   留例外只会让「能不能破例」变成一笔糊涂账。
 *
 * ## 为什么必须放 common/（以前是各函数各抄一份）
 *   之前 `TEST_NO_PREFIX` 在 member / adjust / media / schedule 四份文件里各抄一次，
 *   抄漏一个函数就漏一批人（历史上 media 的 COMMITTEE 分支就漏过一次，
 *   测试管理员真收到了通知）。**同一口径只能有一个定义处**，否则「改一处生效」
 *   是假的 —— 以后新写的人员列表必然再抄一遍、也必然再漏一次。
 *
 * ## 怎么用
 *   SQL 里拼条件（**一律走常量、无注入面**）：
 *     const { NOT_TEST } = require('./common/test-account');
 *     pool.query('SELECT ... FROM member WHERE class_id = ? AND ' + NOT_TEST, [id])
 *     JOIN 别名：NOT_TEST('m') → 'm.student_no NOT LIKE '0000000000%''
 *   判断单个号：isTestNo(studentNo)
 *   造数据/调试要放开：IS_TEST / NOT_TEST 的反向条件
 *
 * ## 刻意不做的事
 *   ❌ 不在 SQL 里「顺带过滤」—— 每条人员 SQL 都要显式写 NOT_TEST，
 *      这样漏写能被门禁 grep 出来（见 scripts/check-test-account-hidden.js）。
 *   ❌ 不用 `is_test` 之类的标记列 —— 学号 99 段是既有约定，加列要迁移全部历史数据，
 *      收益为零（99 段本来就不会和真实学号撞）。
 */

/** 测试账号学号前缀（唯一真源，其余地方一律 require 本文件） */
const TEST_NO_PREFIX = '0000000000';

/**
 * 「不是测试账号」的 SQL 条件。
 * @param {string} [alias] 表别名（如 'm'），传给 JOIN 后的 member；不传则用裸列名
 * @returns {string} 形如 "student_no NOT LIKE '0000000000%'" / "m.student_no NOT LIKE '...'"
 */
function NOT_TEST(alias) {
  return (alias ? alias + '.' : '') + "student_no NOT LIKE '" + TEST_NO_PREFIX + "%'";
}

/** 「是测试账号」的 SQL 条件（唯一例外：切换测试账号接口 / 超管手动排班要看到它们） */
function IS_TEST(alias) {
  return (alias ? alias + '.' : '') + "student_no LIKE '" + TEST_NO_PREFIX + "%'";
}

/** 单个学号是不是测试账号（JS 侧过滤用；口径与 SQL 的 NOT_TEST 同源） */
function isTestNo(no) {
  return String(no || '').indexOf(TEST_NO_PREFIX) === 0;
}

module.exports = { TEST_NO_PREFIX, NOT_TEST, IS_TEST, isTestNo };