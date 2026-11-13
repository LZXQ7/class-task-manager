/**
 * 模拟态下「可切班级」的收窄口径（唯一真源）
 * ============================================================
 * 铁律：切换测试账号 / 切换体验版后，**只能看目标账号所在的班级**
 *   （演示与审核隔离：绝不能点进真实班级）。
 *
 * 🔴 2026-11-14 真实报障：超级管理员切到辅导员身份后，课表页的「查看班级」
 *   只剩 1 个班（应为 5 个绑定班）。
 *   根因：收窄用的是 `profile.classId`，而**辅导员是全局账号、class_id 恒为 0**；
 *   auth.login 对这类账号会把「第一个绑定班」当成 classId 下发 ⇒ effId=1
 *   ⇒ 5 个班被 filter 成只剩 2601。班费 / 值日 / 班级信息都没这道收窄，
 *   所以只有课表页塌成了 1 个。
 *
 * 判据：**只有单班身份才收窄**。
 *   · 辅导员（groupTag='X'）—— 多班身份，保留全部绑定班（否则「切班查看」这个功能自相矛盾）
 *   · 演示班超管（groupTag='A' + is_super=1 + classId=104）—— 仍收窄到 104，隔离不变
 *   · 测试超管 / 测试成员（99 段，classId=3）—— 仍收窄，与改造前一致
 *
 * ⚠️ 不能按 isSuper 判断「能不能切班」：演示班超管也是超管，但它必须被锁在 104。
 *    这里只认「是不是教职工」。
 */

/**
 * @param {Array<{id:number|string}>} chips 全部候选班级
 * @param {{switched?:boolean, profile?:{classId?:number, groupTag?:string}}} gData getApp().globalData
 * @returns {Array} 收窄后的候选（未进入模拟态时原样返回）
 */
function narrowByImpersonation(chips, gData) {
  const list = Array.isArray(chips) ? chips : [];
  const g = gData || {};
  if (!g.switched) return list;
  const p = g.profile || {};
  // 教职工是多班身份：模拟成辅导员时仍要能切所有绑定班
  if (p.groupTag === 'X') return list;
  const effId = Number(p.classId) || 0;
  if (!effId) return list;
  // 目标班级不在候选里（身份映射失同步）：保留原样，别把切班条抹成空
  if (!list.some(c => Number(c.id) === effId)) return list;
  return list.filter(c => Number(c.id) === effId);
}

module.exports = { narrowByImpersonation };
