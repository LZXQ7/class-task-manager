/**
 * 审核演示态（review demo）—— 破坏性动作拦截闸（2026-10-12 · v1.0.6.4）
 * ================================================================
 * 背景：微信审核**每个版本都要走**，「审核体验入口」（auth.reviewDemo）让审核员凭口令
 *   一键绑到 99 段**测试超管**（role=ADMIN, is_super=1）。好处是前端所有入口都能渲染、
 *   功能可完整体验；代价是 —— **它本身就是一个完整超管**，口令一旦泄露，来人可做任何
 *   超管操作（删成员、改权限、清空通知…）。
 *
 * 本模块的口径（用户 2026-10-12 拍板「演示身份改制度，但功能都展示」）：
 *   · 演示身份**照旧绑超管** ⇒ 前端所有入口可见可点、功能都能演示（行为不变）；
 *   · 但演示态下**禁止执行「破坏性 / 授权性 / 全站性」写操作** —— 命中即抛 40010，
 *     前端统一 toast「演示模式：该操作不会真实执行」，**不落任何生产数据**。
 *   即：把「能看得见、点得动」与「能真改生产」切开。
 *
 * 判定「演示态」：member.is_review_demo = 1。该列由 auth.reviewDemo 绑定成功时置 1；
 *   审核通过后关闭脚本把它与 openid 一起清零。普通成员 / 真实超管该列为 0 ⇒ 完全不受影响。
 *
 * ⚠️ 为什么放在 main 里逐函数调用、而不是复用某个现有守卫：
 *   ① media 的 main 根本没有 needSuper 分支（clearNotices 只靠学号前缀兜底）⇒ 挂在
 *      needSuper 上会漏；② 破坏性动作散落在 needSuper / needAdmin / needBind 多种声明里 ⇒
 *      只挂某一类必漏。逐函数在 ctx 之后显式判，覆盖面最可控、也最容易被门禁钉死。
 */
const { BizError } = require('./resp');

/**
 * 演示态禁止执行的动作（action 名，与各云函数 routes 的键逐字一致）。
 *
 * 选取标准 —— **不可逆 / 授权 / 全站级 ⇒ 拦**；**可逆的日常业务写 ⇒ 放行**：
 *   放行：值日与换班、请假登记/撤销、单条课次增删改、排班生成、班级通知发布、成员单条增改
 *         —— 这些正是审核员要「体验」的主功能，拦了就变成「功能展示不全」。
 *   拦截：删成员/停用/解绑他人、授予与撤销职位（授权来源）、教职工名册、班级增删停用、
 *         绑定入口开关、清空通知、发全员公告、校历与调课配置、课表全量导入、撤回导入。
 */
const DENY_ACTIONS = [
  /* —— 成员与权限（授权来源 / 不可逆）—— */
  'member.setRole',            // 提权 / 撤管理员
  'member.setPosition',        // 授予 / 撤销班委职位（排班权、名册权的授权来源）
  'member.unbind',             // 解绑**他人**微信
  'member.setStatus',          // 停用 / 恢复成员
  'member.removeMember',       // 移出班级（删成员 + 未开始值日）
  'member.revertImport',       // 撤回导入（不可逆）
  'member.importCsv',          // 名册批量导入
  'member.importExcel',
  /* —— 教职工名册（全局账号，超管专属）—— */
  'member.addStaff',
  'member.staffCode',
  'member.staffBindClasses',
  'member.staffUnbind',
  'member.staffDelete',
  /* —— 调试工具（会泄露「可切换的身份清单」）—— */
  'member.testAccountList',
  /* —— 班级管理（全站结构）—— */
  'class.create',
  'class.update',
  'class.delete',
  'class.setActive',           // 停用班级
  /* —— 绑定入口开关（关掉即锁死全班）—— */
  'auth.setBindOpen',
  /* —— 审核体验入口开关（2026-10-15）：演示身份**不得**自己开关这道后门 ——
       否则审核员可以自己换一条口令出来，这个「仅预览通道」就不再是超管可控的。 */
  'auth.reviewDemoSet',
  /* —— 同上：查询也拦 —— 演示身份不该拿到任何一条体验口令（哪怕只是回显给自己看）—— */
  'auth.reviewDemoStatus',
  /* —— 全站通知（不可恢复 / 全员弹窗）—— */
  'media.clearNotices',        // 清空全部历史通知（不可恢复）
  'media.appNoticePublish',    // 发全员更新公告
  /* —— 校历 / 调课（影响全班值日）—— */
  'course.saveHoliday',
  'course.removeHoliday',
  'course.saveShift',
  'course.removeShift',
  /* —— 课表全量导入 / 适配处理（覆盖全班课次）—— */
  'course.importTimetable',
  'course.handleApply'
];

const DENY_SET = new Set(DENY_ACTIONS);

/** 是否演示态身份（member.is_review_demo = 1） */
function isReviewDemo(member) {
  return !!(member && Number(member.is_review_demo) === 1);
}

/** 该 action 是否在演示态拦截清单内 */
function isDeniedAction(action) {
  return DENY_SET.has(String(action || ''));
}

/**
 * 演示态拦截入口：在**受影响云函数**的 exports.main 里、取到 ctx 之后调用。
 *   命中（演示身份 + 禁止动作）→ 抛 BizError(40010)，**不进入 handler**；
 *   非演示身份 / 非禁止动作 → 静默返回（不影响正常鉴权链路）。
 */
function denyDemo(member, action) {
  if (isReviewDemo(member) && DENY_SET.has(String(action || ''))) {
    throw new BizError(40010, '演示模式：该操作不会真实执行');
  }
}

module.exports = { DENY_ACTIONS, isReviewDemo, isDeniedAction, denyDemo };
