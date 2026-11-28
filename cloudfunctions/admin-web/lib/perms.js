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
 *   2 字（概览/成员/请假/班费/通知/作业）→ 3 字（倒数日/课程表）→ 4 字（值日记录/换班申请/
 *   账号班级/排班规则/使用统计/课前演讲/操作审计/后台账号）。前端实际导航顺序由
 *   `public/app.js` 的 VIEWS 对象声明顺序决定（那里另有「系统配置」共用 class 权限），
 *   本数组主要供权限解析/navFor 使用，两处顺序须保持一致，改一处必改另一处。 */
const VIEWS = [
  { key: 'overview',  label: '概览',     desc: '首页总览与今日值班' },
  { key: 'members',   label: '成员',     desc: '成员档案、分组、停用、固定' },
  { key: 'leave',     label: '请假',     desc: '请假记录、代登记、审批' },
  { key: 'fee',       label: '班费',     desc: '班费 / 团费总额与消费流水' },
  { key: 'notice',    label: '通知',     desc: '班级通知发布、删除与回执统计' },
  { key: 'homework',  label: '作业',     desc: '作业发布、批改与删除' },
  { key: 'countdown', label: '倒数日',   desc: '谁添加了哪些日子（只读）' },
  { key: 'course',    label: '课程表',   desc: '课程与课次维护' },
  { key: 'duty',      label: '值日记录', desc: '值日明细、状态与换人' },
  { key: 'swap',      label: '换班申请', desc: '换班 / 请假代班的申请与审批' },
  { key: 'class',     label: '账号班级', desc: '班级信息与教职工账号' },
  { key: 'rules',     label: '排班规则', desc: '值日轮转规则与发布' },
  { key: 'usage',     label: '使用统计', desc: '活跃度与功能使用分布' },
  { key: 'speech',    label: '课前演讲', desc: '演讲名单 / 发布态 / 发布撤回' },
  { key: 'audit',     label: '操作审计', desc: '谁在后台改了什么' },
  { key: 'accounts',  label: '后台账号', desc: '开通 / 收回后台登录权限' }
];

const ALL_VIEWS = VIEWS.map((v) => v.key);

/**
 * 成员页的**操作级**权限位（2026-11-16 用户要求）。
 * ============================================================
 * 原状态：`members` 是一个开关 —— 能进成员页就等于能改资料、能停用、能设超管、能删人。
 *   实际使用中这些人往往不是同一个人：辅导员需要看名单，副班长需要改分组，
 *   但「设超管 / 删成员」是不该顺手给的。
 *
 * 设计（沿用 `common/fee-perms.js` 的先例：**窄字段 + 白名单 + 逗号串**）：
 *   · 存在 admin_user.perms 里，与页签 key 同一个字段（少一列、少一套审计）；
 *   · 前端把「成员」显示成一个分组，下面 6 个复选框；
 *   · 存储只写被勾的项，父级 `members` 由 resolve() 按下面的规则补齐。
 *
 * 兼容规则（改之前先读，写错会让老账号突然失权或突然全权）：
 *   ① perms 里**只有** `members`、没有任何子项 ⇒ 老数据，视为**拥有全部 6 项**（行为不变）。
 *   ② perms 里有任一子项 ⇒ 自动补 `members`（能进页面）+ `members.view`（看是操作的前提），
 *      **不**补其余子项 —— 用户勾了什么就是什么。
 *   ③ 职位模板（POSITION_PERMS）都只写 `members` ⇒ 模板等同「成员页全权」，与改造前一致。
 *
 * ⚠️ `members` 本身从此只表示「能进成员页 / 能读名单」，不再代表能做任何写操作。
 *    后端所有写接口必须挂具体子项（members.edit / members.remove / members.super / …），
 *    scripts/check-admin-member-ops.js 逐条守。
 */
const MEMBER_OPS = [
  { key: 'members.view',   label: '查看成员名单',   desc: '进成员页、看列表与详情、搜索筛选' },
  { key: 'members.add',    label: '新增成员',       desc: '手工添加单个成员（含初始分组/职位）' },
  { key: 'members.edit',   label: '编辑资料 / 停用恢复', desc: '改姓名学号分组职位状态、班费额外权限' },
  { key: 'members.import', label: '导入成员名单',   desc: '批量导入 xlsx/csv/文本（后台特有）' },
  { key: 'members.remove', label: '删除成员',       desc: '硬删无历史记录的人（不可撤回）' },
  { key: 'members.super',  label: '设为 / 取消超管', desc: '把成员提为超级管理员（极高权限）' },
  // 单独授权（2026-11-18 用户要求）：编辑成员弹窗里的三项「单独设置」——
  //   不参与值日轮换(duty_off) / 单独授予班费消费权(fee_perms) / 单独授予课前演讲排班权(speech_perm)。
  //   这三项能给成员本人带来实际权限，故独立于「编辑资料」单独控制：
  //   没勾此项的账号，即使有 members.edit 也只能改姓名/分组/职位/状态，碰不到这三项。
  //   ⚠️ 放在数组末尾是有意的——expandMembers 规则①会把「只有父级 members」的老账号
  //   展开成全部位（含本项），老账号不会被突然夺权；显式勾了子项的账号才需单独勾它。
  { key: 'members.grant',  label: '单独授权',       desc: '改「不排值日 / 班费消费授权 / 课前演讲授权」三项单独设置' }
];
const MEMBER_OP_KEYS = MEMBER_OPS.map((o) => o.key);

/** 全部合法权限 key（页签 + 成员操作位）—— 存储层白名单的唯一真源 */
const ALL_PERM_KEYS = ALL_VIEWS.concat(MEMBER_OP_KEYS);

/** key 是否合法（页签或成员操作位） */
function isValidPermKey(key) {
  return ALL_PERM_KEYS.indexOf(String(key || '').trim()) >= 0;
}

/**
 * 成员权限的父子上卷/下发展开（规则见 MEMBER_OPS 注释 ①②③）。
 * 幂等：重复调用不会重复追加。
 */
function expandMembers(list) {
  const out = (list || []).slice();
  const has = (k) => out.indexOf(k) >= 0;
  const kids = MEMBER_OP_KEYS.filter(has);
  if (has('members')) {
    if (!kids.length) {
      // ① 老数据 / 职位模板：只有父级 ⇒ 全权（保持改造前行为）
      MEMBER_OP_KEYS.forEach((k) => out.push(k));
    } else {
      // ② 显式配了子项：看是操作的前提，缺了就补上（但不放开其余操作）
      if (!has('members.view')) out.push('members.view');
    }
  } else if (kids.length) {
    // ③ 只勾了子项：补父级，否则连页签都进不去
    out.push('members');
    if (!has('members.view')) out.push('members.view');
  }
  return out;
}

/** 超管专属：任何情况下都不随 perms 下发 */
const SUPER_ONLY = ['audit', 'accounts'];

/** 受保护的最高管理员账号（唯一 SUPER，示例成员01 / 后台用户名 admin）。
 *  2026-11-18 用户口径：「admin 是最大的权限，给老师等其他人开通后台账号，
 *  需要让他们无法取消我的权限」——任何人（含其他超管、含本人误操作）都不得
 *  取消他的超管身份，也不得停用/删除他的成员或后台账号（那些都等价于夺权）。
 *  双标识：member id + 学号，任一命中即保护（单一字段变动不致保护失效）。 */
const PROTECTED_SUPER = { memberId: 13, studentNo: '000000000301' };
function isProtectedSuper(member) {
  if (!member) return false;
  return Number(member.id) === PROTECTED_SUPER.memberId ||
    String(member.student_no || member.studentNo || '') === PROTECTED_SUPER.studentNo;
}

/**
 * 职位 → 页签模板。
 * 每个角色都给 `overview`：进后台总得有个落地页，否则登录后一片空白。
 */
const POSITION_PERMS = {
  // 辅导员：看全局、管人管请假管钱，但不参与班委的值日排班，也看不到审计
  '辅导员': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'usage', 'notice', 'homework'],
  // 班长兼团支书：班里实际的总负责人，班委能做的事他都要能兜底
  '班长兼团支书': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'rules', 'usage', 'homework'],
  '班长': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'rules', 'usage', 'homework'],
  '团支书': ['overview', 'members', 'leave', 'fee', 'course', 'class', 'duty', 'swap', 'countdown', 'rules', 'usage', 'homework'],
  // 副班长：管人与临时调换；**不碰钱、不改排班规则**（规则改动影响所有人的轮次）
  '副班长': ['overview', 'members', 'leave', 'course', 'duty', 'swap', 'countdown'],
  // 学习委员：学业相关（成员、请假、课程表），不碰值与钱
  // 学习委员不列 homework：小程序 homework.canReview 只认超管 / 班委，后台页签不能突破端上能力
  '学习委员': ['overview', 'members', 'leave', 'course', 'countdown', 'speech'],
  // 生活委员：用户点名——班费 + 排班规则 + 值日记录（顺带给换班，他要知道谁跟谁换了）
  '生活委员': ['overview', 'fee', 'duty', 'rules', 'swap', 'speech'],
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

/** 把 admin_user.perms 字符串解析成数组，并去掉非法值（页签 + 成员操作位都收） */
function parsePerms(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && ALL_PERM_KEYS.indexOf(s) >= 0);
}

/**
 * 解析某人的后台权限。
 * @param {object} member  member 行，至少含 is_super / position / group_tag / role
 * @param {string} rawPerms admin_user.perms 原始字符串（'' 表示按模板推导）
 * @returns {string[]} 有权访问的页签 key + 成员操作位（已按 MEMBER_OPS 规则展开）
 */
function resolve(member, rawPerms) {
  if (!member) return [];
  // 超管：全量（含成员页全部操作位），且不受 perms 字段影响
  if (isSuper(member)) return expandMembers(ALL_VIEWS.slice());

  const custom = parsePerms(rawPerms);
  if (custom.length) {
    // 例外授权：仍需挡掉超管专属，防止越权写入
    return expandMembers(custom.filter((k) => SUPER_ONLY.indexOf(k) < 0));
  }

  // 辅导员用 group_tag='X' 标识（position 可能就是「辅导员」，但历史数据有空值的情况）
  if (member.group_tag === 'X') {
    return expandMembers(POSITION_PERMS['辅导员'].slice());
  }
  const pos = String(member.position || '').trim();
  if (pos && POSITION_PERMS[pos]) return expandMembers(POSITION_PERMS[pos].slice());

  // 职位为空但角色是 ADMIN：给最小可用集合（否则这类账号登录后白屏）
  if (member.role === 'ADMIN' || member.role === 'MONITOR') return expandMembers(FALLBACK_ADMIN.slice());
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
  VIEWS, ALL_VIEWS, SUPER_ONLY, PROTECTED_SUPER, POSITION_PERMS, FALLBACK_ADMIN,
  MEMBER_OPS, MEMBER_OP_KEYS, ALL_PERM_KEYS, expandMembers, isValidPermKey,
  isSuper, isProtectedSuper, parsePerms, resolve, has, canSeeDemo, navFor
};
