/**
 * 后台页签权限真源（网页管理后台 · 2026-11-15）
 * ============================================================
 * 背景：后台原先只有「超管能登录，登录即全权限」一条线。
 *   用户要求「给现有人员开后台管理，权限和小程序某人账号现有权限相同」——
 *   也就是生活委员进后台只能管排班规则与值日，辅导员不该碰操作审计。
 *   所以权限从「是不是超管」细化成**页签级**。
 *
 * 三条设计取舍（改之前先读完）：
 *   ① `admin_user.perms` 为空 = **不写死**，实时按职位模板推导。
 *      这样以后调整矩阵（或某人升职）自动生效，无需回填每一行。
 *      显式配了 perms 才以配置为准，用于「例外授权」。
 *   ② `audit`（操作审计）与 `accounts`（后台账号）**永远只给超管**：
 *      即使 perms 字段里写了也过滤掉。否则等于「让人自己给自己提权」，
 *      审计表本身也会被非超管看见（里面含全站操作流水）。
 *   ③ 模板按**职责**而不是「官大官小」：
 *      · 生活委员 → 班费 + 值日 + 排班规则（他要真排得动班，就得能改规则）
 *      · 副班长 → 不管钱、不管规则，管人和临时调换
 *      · 学习委员 → 不碰钱和值日，只碰成员/请假/课程表
 *      这和小程序里 `util.feeRights()` 的分工保持同一口径（生活委员管班费）。
 *
 * 与小程序的关系：**不是同一套代码**（网页拿不到 WX 上下文），
 *   但「谁能管什么」的语义必须一致，否则同一个人在两端看到的权限会打架。
 */

/** 页签定义。
 * **顺序口径（2026-11-16 用户要求）：标题字数越少越靠上，同字数保持原相对顺序**——
 *   2 字（概览/成员/请假/班费）→ 3 字（倒数日/课程表）→ 4 字（值日记录/换班申请/
 *   账号班级/排班规则/使用统计/操作审计/后台账号）。前端实际导航顺序由
 *   `public/app.js` 的 VIEWS 对象声明顺序决定（那里另有「系统配置」共用 class 权限），
 *   本数组主要供权限解析/navFor 使用，两处顺序须保持一致，改一处必改另一处。 */
const VIEWS = [
  { key: 'overview',  label: '概览',     desc: '首页总览与今日值班' },
  { key: 'members',   label: '成员',     desc: '成员档案、分组、停用、固定' },
  { key: 'leave',     label: '请假',     desc: '请假记录、代登记、审批' },
  { key: 'fee',       label: '班费',     desc: '班费 / 团费总额与消费流水' },
  { key: 'countdown', label: '倒数日',   desc: '谁添加了哪些日子（只读）' },
  { key: 'course',    label: '课程表',   desc: '课程与课次维护' },
  { key: 'duty',      label: '值日记录', desc: '值日明细、状态与换人' },
  { key: 'swap',      label: '换班申请', desc: '换班 / 请假代班的申请与审批' },
  { key: 'class',     label: '账号班级', desc: '班级信息与教职工账号' },
  { key: 'rules',     label: '排班规则', desc: '值日轮转规则与发布' },
  { key: 'usage',     label: '使用统计', desc: '活跃度与功能使用分布' },
  { key: 'audit',     label: '操作审计', desc: '谁在后台改了什么' },
  { key: 'accounts',  label: '后台账号', desc: '开通 / 收回后台登录权限' }
];

const ALL_VIEWS = VIEWS.map((v) => v.key);

/** 超管专属：任何情况下都不随 perms 下发 */
const SUPER_ONLY = ['audit', 'accounts'];

/**
 * 职位 → 页签模板。
 * 每个角色都给 `overview`：进后台总得有个落地页，否则登录后一片空白。
 */
const POSITION_PERMS = {
  // 辅导员：看全局、管人管请假管钱，但不参与班委的值日排班，也看不到审计
  '辅导员': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'usage'],
  // 班长兼团支书：班里实际的总负责人，班委能做的事他都要能兜底
  '班长兼团支书': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'rules', 'usage'],
  '班长': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'rules', 'usage'],
  '团支书': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'rules', 'usage'],
  // 副班长：管人与临时调换；**不碰钱、不改排班规则**（规则改动影响所有人的轮次）
  '副班长': ['overview', 'members', 'leave', 'course', 'duty', 'swap', 'countdown'],
  // 学习委员：学业相关（成员、请假、课程表），不碰值与钱
  '学习委员': ['overview', 'members', 'leave', 'course', 'countdown'],
  // 生活委员：用户点名——班费 + 排班规则 + 值日记录（顺带给换班，他要知道谁跟谁换了）
  '生活委员': ['overview', 'fee', 'duty', 'rules', 'swap'],
  // 文体委员：活动现场执行，值日与调换
  '文体委员': ['overview', 'duty', 'swap', 'countdown'],
  // 组织宣传委员 / 心理委员：以信息收集为主，只读型
  '组织宣传委员': ['overview', 'members', 'leave', 'countdown'],
  '心理委员': ['overview', 'members', 'leave', 'countdown'],
  // 兼容历史/别名写法
  '文艺委员': ['overview', 'duty', 'swap', 'countdown'],
  '纪律委员': ['overview', 'members', 'duty', 'swap']
};

/** 没配职位的 ADMIN 角色（如演示班管理员）给最小集合；普通 MEMBER 一律无后台权限 */
const FALLBACK_ADMIN = ['overview', 'members'];

function isSuper(member) {
  return !!member && Number(member.is_super) === 1;
}

/** 把 admin_user.perms 字符串解析成数组，并去掉非法值 */
function parsePerms(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && ALL_VIEWS.indexOf(s) >= 0);
}

/**
 * 解析某人的后台权限。
 * @param {object} member  member 行，至少含 is_super / position / group_tag / role
 * @param {string} rawPerms admin_user.perms 原始字符串（'' 表示按模板推导）
 * @returns {string[]} 有权访问的页签 key
 */
function resolve(member, rawPerms) {
  if (!member) return [];
  // 超管：全量，且不受 perms 字段影响（也就不存在「超管被自己配窄」的风险）
  if (isSuper(member)) return ALL_VIEWS.slice();

  const custom = parsePerms(rawPerms);
  if (custom.length) {
    // 例外授权：仍需挡掉超管专属，防止越权写入
    return custom.filter((k) => SUPER_ONLY.indexOf(k) < 0);
  }

  // 辅导员用 group_tag='X' 标识（position 可能就是「辅导员」，但历史数据有空值的情况）
  if (member.group_tag === 'X') {
    return POSITION_PERMS['辅导员'].slice();
  }
  const pos = String(member.position || '').trim();
  if (pos && POSITION_PERMS[pos]) return POSITION_PERMS[pos].slice();

  // 职位为空但角色是 ADMIN：给最小可用集合（否则这类账号登录后白屏）
  if (member.role === 'ADMIN' || member.role === 'MONITOR') return FALLBACK_ADMIN.slice();
  return [];
}

/** 是否有某个页签权限 */
function has(perms, key) {
  if (!perms) return false;
  if (perms.indexOf('*') >= 0) return true;
  return perms.indexOf(key) >= 0;
}

/** 是否可见演示班级（只有超管能看见，避免辅导员在班级下拉里看到假班） */
function canSeeDemo(member) {
  return isSuper(member);
}

/** 前端导航要用：把页签定义过滤成这个人能看的白名单 */
function navFor(perms) {
  return VIEWS.filter((v) => has(perms, v.key)).map((v) => ({ key: v.key, label: v.label }));
}

module.exports = {
  VIEWS, ALL_VIEWS, SUPER_ONLY, POSITION_PERMS, FALLBACK_ADMIN,
  isSuper, parsePerms, resolve, has, canSeeDemo, navFor
};
