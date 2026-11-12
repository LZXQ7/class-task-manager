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

/**
 * 演示班级「写操作硬闸」名单（2026-11-13）
 * ================================================================
 * 背景（线上实况）：演示班是所有体验者共享的同一个班（class.is_demo=1），
 *   任一人上传的假条 / 附件都会出现在后来的体验者列表里。2026-11-12 先做了前端只读
 *   （util.readonlyBlocked + request 双闸），但**前端拦不住旧客户端**——
 *   实测 2026-11-13 00:23 仍有体验者在演示班成功上传假条并写回 leave_request
 *   （根因：请假走 adjust 云函数，那条链路压根没挂演示闸）。
 *
 * 口径（用户 2026-11-12/13 明确要求）：**演示班级一律只读，任何写操作都不落库**。
 *   宁可审核员少点两下，也不能让违规内容污染共享的演示班被其他人看见。
 *
 * 为什么用「显式写名单 + 默认放行」而不是「写类关键词正则」：
 *   实测正则会把读操作误判成写 —— `swapCandidates`（换班候选列表）、
 *   `getApplyList`、`downloadApply` 全被 /swap|apply/ 命中；反过来 `leaveApprove`
 *   （审批=写）、`staffCode`（生成绑定码=写）、`msgRestore`（恢复=写）不含关键词会漏。
 *   名单是好样本，门禁 check-demo-backend-readonly 反向钉住：凡路由名命中写类关键词
 *   却不在本名单 → 直接红，强迫维护。
 *
 * ⚠️ 刻意**不放**名单的几个「必须放行」：
 *   auth.login / auth.reviewDemo / auth.switchDemo（进演示班）
 *   auth.switchAccount（退出演示班，拦了就卡死在里面出不来）
 *   auth.checkToken / resolveScene / reviewDemoStatus（纯读，状态查询）
 */
const DEMO_WRITE_ACTIONS = [
  /* —— adjust：请假 / 换班 / 倒数日（本次穿透的漏洞就在这）—— */
  'addLeave', 'applyLeave', 'leaveApply', 'leaveImageSet', 'leaveDelete', 'leaveMyCancel',
  'leaveApprove',                         // 审批通过/驳回 = 写（正则漏判的典型）
  'applySwap', 'cancel', 'cancelLeave', 'confirm',
  'countdownAdd', 'countdownDelete',
  /* —— auth：绑定与开关（演示班不允许改任何身份/后门状态）—— */
  'bind', 'bindStaff', 'unbind', 'updateAvatar', 'setBindOpen', 'reviewDemoSet',
  /* —— class：班级结构 —— */
  'create', 'update', 'delete', 'setActive',
  /* —— course：课表 / 选修课 / 调课 —— */
  'electiveSave', 'electiveDelete', 'mySave', 'myDelete', 'myClear', 'myImport',
  'upsert', 'sessionAppend', 'sessionAppendRemove', 'sessionBatchMove',
  'shiftSet', 'shiftRemove', 'saveShift', 'removeShift', 'saveHoliday', 'removeHoliday',
  'importTimetable', 'applyTimetable', 'handleApply', 'publishToClass', 'copyFrom', 'syncFromClass',
  /* —— duty：值日确认 —— */
  'confirm', 'undoConfirm',
  /* —— fee：班费 —— */
  'addExpense', 'deleteRecord', 'feeAppendImages', 'setTotal',
  /* —— homework：作业 —— */
  'publish', 'submit', 'delete', 'review',
  /* —— media：通知 / 附件 —— */
  'msgPublish', 'msgDelete', 'msgRecycleClear', 'publishNotice', 'clearNotices',
  'appNoticePublish', 'deleteAttachment', 'markNoticeRead', 'msgRead', 'msgRestore', 'testRemind',
  /* —— member：成员 / 权限 / 教职工 —— */
  'addMember', 'addStaff', 'staffCode', 'staffBindClasses', 'staffUnbind', 'staffDelete',
  'removeMember', 'setRole', 'setPosition', 'setStatus', 'updateGroup', 'unbind',
  'noteSave', 'noteDelete', 'pinToggle', 'importCsv', 'importExcel', 'importBatches',
  'revertImport', 'remindReopen',
  /* —— schedule：排班生成 / 发布 / 换人 —— */
  'generate', 'publish', 'unpublish', 'clear', 'addManual', 'remove', 'reassign', 'reassignUndo',
  'setRules', 'setSlots',
  'aiApply', 'aiSettingSave', 'aiSettingClear', 'aiSettingTest'
];

const DEMO_WRITE_SET = new Set(DEMO_WRITE_ACTIONS);

/* 演示班 id 集合缓存：演示班结构极少变动，60s 足够；避免每笔写操作都查一次库。
   进程级（云函数容器内）缓存，容器回收即失效，无跨实例不一致风险。 */
let _demoIdsCache = null;
let _demoIdsAt = 0;
async function _demoIds(pool, guard) {
  const now = Date.now();
  if (_demoIdsCache && now - _demoIdsAt < 60000) return _demoIdsCache;
  _demoIdsCache = await guard.demoClassIds(pool);
  _demoIdsAt = now;
  return _demoIdsCache;
}

/**
 * 演示班级写操作硬闸：在**业务云函数** exports.main 取到 ctx 之后调用。
 *
 * 性能：**非写名单的 action 第一行就 return，一次库都不查** —— 读操作零开销；
 *   只有命中写名单才判身份，且演示班 id 集合走 60s 缓存。
 *
 * @param {object} pool  mysql 连接池
 * @param {object} guard cloudfunctions/common/guard.js（传进来避免循环依赖）
 * @param {object} ctx   guard.getContext() 的返回值
 * @param {string} action 本次请求的 action
 * @throws {BizError} 40010（演示身份 + 写操作）
 */
async function gateDemoWrite(pool, guard, ctx, action) {
  const a = String(action || '');
  if (!DEMO_WRITE_SET.has(a)) return false;
  const me = ctx && (ctx.member || ctx.realMember);
  if (!me) return false;
  // 与 guard.isDemoMember 同口径：is_review_demo=1 或生效班级属演示班
  if (Number(me.is_review_demo) === 1) {
    throw new BizError(40010, '演示班级仅预览，操作不会真实保存');
  }
  /* 能力探测：check-*.js 的门禁桩（假 guard）只实现被测成员，未必有 demoClassIds。
     生产 guard 一定有 → 这里只是让门禁沙盒里的写路径不因缺方法抛 TypeError
     （那会把「非演示身份」误判成 50000，反把门禁弄红）。拿不到演示班集合 ⇒ 无法判定 ⇒ 放行。 */
  if (typeof guard.demoClassIds !== 'function') return false;
  const ids = await _demoIds(pool, guard);
  if (!ids.includes(Number(me.class_id))) return false;
  throw new BizError(40010, '演示班级仅预览，操作不会真实保存');
}

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

module.exports = {
  DENY_ACTIONS, isReviewDemo, isDeniedAction, denyDemo,
  DEMO_WRITE_ACTIONS, gateDemoWrite
};
