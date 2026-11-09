/**
 * 成员管理（模块：member）
 *
 * 铁律：人员列表**一律不显示测试账号**（含超管），唯一真源 common/test-account.js。
 * 每条人员 SQL 都要**显式**拼 NOT_TEST —— 不靠「顺带过滤」，这样漏写能被
 * scripts/check-test-account-hidden.js grep 出来。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { NOT_TEST } = require('../common/test-account');
const { logAction } = require('./audit');
const { FEE_PERM_KEYS, normalizeFeePerms, stringifyFeePerms } = require('../common/fee-perms');

const ROLES = ['ADMIN', 'MONITOR', 'MEMBER'];
const STATUSES = ['ACTIVE', 'LEAVE', 'DISABLED'];
const GROUPS = ['A', 'B', 'X'];
/** 职位白名单：与小程序 member/index.js 的 POSITIONS、utils/util.js 逐字一致（勿改字面）。
 *  check-positions-sync.js 守的是小程序两侧；后台这份靠本注释对齐，改动必须三处同步。 */
const POSITIONS = [
  '班长兼团支书', '副班长', '学习委员', '生活委员',
  '组织宣传委员', '文体委员', '心理委员'
];

function maskMember(r) {
  return {
    id: r.id,
    classId: r.class_id,
    name: r.name,
    studentNo: r.student_no,
    groupTag: r.group_tag,
    role: r.role,
    isSuper: Number(r.is_super) === 1,
    position: r.position || '',
    status: r.status,
    dutyCount: Number(r.duty_count || 0),
    dutyOff: Number(r.duty_off) === 1,
    remindBlock: Number(r.remind_block) === 1,
    // 后台单独授予的班费消费登记权限（只额外授予，职位权限不在这里体现）
    feePerms: normalizeFeePerms(r.fee_perms),
    bound: !!r.openid,
    lastDutyAt: typeof r.last_duty_at === 'string' ? r.last_duty_at.slice(0, 10) : r.last_duty_at
  };
}

/**
 * 成员列表。
 * @param {object} q
 * @param {number} [q.classId]   班级；不给则跨全部班（后台放开跨班）
 * @param {string} [q.keyword]   姓名 / 学号 模糊
 * @param {string} [q.scope]     筛选作用域 ALL / COMMITTEE / A / B（四选一，与小程序名册页一致）
 * @param {number} [q.page]      从 1 起
 * @param {number} [q.pageSize]  10 / 30 / 50；**0 = 全部**（不拼 LIMIT）
 *
 * ⚠️ 两条 SQL 都必须在 .query() 里**显式出现 NOT_TEST_SQL**：
 *    scripts/check-admin-web.js 与 check-test-account-hidden.js 是按 .query() 片段
 *    grep「NOT_TEST」字样兜底的，抽成公共 where 变量会让门禁静默失效。
 */
const MEMBER_SCOPES = ['ALL', 'COMMITTEE', 'A', 'B'];
async function listMembers(q = {}) {
  const pool = getPool();
  // ⚠️ 测试账号过滤必须**显式出现在每条人员 SQL 里**。
  //    这里的 NOT_TEST 以变量形式先存起来是安全的（下面每条 SQL 都把它拼进去），
  //    但**不要**把它藏进一个通用的 where 组装器里 ——
  //    scripts/check-test-account-hidden.js 与 scripts/check-admin-web.js
  //    都是靠 grep 源码里有没有 NOT_TEST 字样来兜底的，藏起来等于让门禁失效。
  const NOT_TEST_SQL = NOT_TEST('m');
  const where = [NOT_TEST_SQL];
  const args = [];
  if (q.classId) {
    where.push('m.class_id = ?');
    args.push(Number(q.classId));
  }
  if (q.status) {
    where.push('m.status = ?');
    args.push(String(q.status));
  }
  if (q.groupTag) {
    where.push('m.group_tag = ?');
    args.push(String(q.groupTag));
  }
  /* 筛选作用域（2026-11-08）：四选一，与小程序 pages/roster 的 _isCommittee 主路径同口径。
   * 「班委」= role 是 ADMIN / MONITOR（封闭枚举里即 <> 'MEMBER'）且不是辅导员 X 组。
   *   刻意写成 <> 而非 IN(...) / OR：后台 e2e 的 SQL mock 只支持 = / <> / LIKE，
   *   用 IN / OR 会让 mock 静默漏掉整个条件（断言假绿）。语义等价且枚举封闭。
   * 门禁 scripts/check-member-filters.js 看守白名单、口径一致性与「全部」分支。 */
  const scopeRaw = String(q.scope || 'ALL');
  const scope = MEMBER_SCOPES.indexOf(scopeRaw) >= 0 ? scopeRaw : 'ALL';
  if (scope === 'COMMITTEE') {
    where.push("m.role <> 'MEMBER' AND m.group_tag <> 'X'");
  } else if (scope === 'A' || scope === 'B') {
    where.push('m.group_tag = ?');
    args.push(scope);
  }
  if (q.keyword) {
    where.push('(m.name LIKE ? OR m.student_no LIKE ?)');
    const kw = '%' + String(q.keyword).trim() + '%';
    args.push(kw, kw);
  }
  // ⚠️ 0 是「全部」的合法值：绝不能 `Number(q.pageSize) || 50`（会把 0 吃掉变默认值）。
  const rawSize = Number(q.pageSize);
  const all = String(q.pageSize) === '0';
  const pageSize = all ? 0 : Math.min(200, Math.max(1, Number.isFinite(rawSize) && rawSize > 0 ? rawSize : 50));
  const page = all ? 1 : Math.max(1, Number(q.page) || 1);
  // 附加条件为空时不拼 ' AND '（跨全部班且无筛选时原写法会生成语法错的空条件）
  const extra = where.slice(1).join(' AND ');
  const suffix = extra ? ' AND ' + extra : '';

  const [[cnt]] = await pool.query(
    'SELECT COUNT(*) AS c FROM member m WHERE ' + NOT_TEST_SQL + suffix,
    args
  );
  const [rows] = await pool.query(
    'SELECT m.* FROM member m WHERE ' + NOT_TEST_SQL + suffix +
    // 学号升序（2026-10-11 用户口径：成员按学号从小到大）。student_no 是定长数字串，
    // 字典序 = 数值序；追加 m.id 做同号兜底（理论上唯一），保证分页顺序稳定。
    ' ORDER BY m.class_id, m.student_no, m.id' + (all ? '' : ' LIMIT ? OFFSET ?'),
    all ? args : args.concat([pageSize, (page - 1) * pageSize])
  );
  return {
    total: Number(cnt.c || 0),
    page,
    pageSize,
    items: rows.map(maskMember)
  };
}

/** 单个成员详情（含备注条数） */
async function memberDetail(id) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT m.* FROM member m WHERE m.id = ? AND ' + NOT_TEST('m') + ' LIMIT 1',
    [id]
  );
  if (!rows[0]) throw new BizError(40404, '成员不存在');
  const [[n]] = await pool.query('SELECT COUNT(*) AS c FROM member_note WHERE member_id = ?', [id]);
  return { ...maskMember(rows[0]), noteCount: Number(n.c || 0) };
}

function validate(patch) {
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new BizError(40001, '姓名不能为空');
    if (n.length > 32) throw new BizError(40001, '姓名过长（最多 32 字）');
    patch.name = n;
  }
  if (patch.studentNo !== undefined) {
    const s = String(patch.studentNo).trim();
    if (!s) throw new BizError(40001, '学号不能为空');
    if (s.length > 32) throw new BizError(40001, '学号过长');
    patch.studentNo = s;
  }
  if (patch.role !== undefined && !ROLES.includes(patch.role)) {
    throw new BizError(40001, '角色不合法');
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) {
    throw new BizError(40001, '状态不合法');
  }
  if (patch.groupTag !== undefined && !GROUPS.includes(patch.groupTag)) {
    throw new BizError(40001, '分组不合法');
  }
  if (patch.position !== undefined) {
    const p = String(patch.position).trim();
    if (p.length > 32) throw new BizError(40001, '职位头衔过长（最多 32 字）');
    // ⚠️ 白名单与小程序 member/index.js 的 POSITIONS、utils/util.js 逐字一致（勿改字面）。
    //    position 已升格为排班/名册的**授权字段**（guard.js isDutyAdmin/isMonitor 按它判权），
    //    自由文本里一个尾随空格就会让授权静默失配，所以后台也收口成固定列表。
    if (p && !POSITIONS.includes(p)) {
      throw new BizError(40001, '职位头衔不合法，请从固定列表中选择');
    }
    patch.position = p;
  }
  /* 单独授予的班费权限：必须是数组 + 白名单内，防止前端伪造任意值写库 */
  if (patch.feePerms !== undefined) {
    if (!Array.isArray(patch.feePerms)) throw new BizError(40001, '权限格式不合法');
    patch.feePerms.forEach(function (k) {
      if (FEE_PERM_KEYS.indexOf(k) < 0) throw new BizError(40001, '权限项不合法：' + k);
    });
    patch.feePerms = normalizeFeePerms(patch.feePerms);
  }
  return patch;
}

/**
 * 改成员基本信息 / 角色 / 状态。
 * 护栏：改 class_id 会让成员换班（影响值日历史口径），单独走 moveMember 且要二次确认；
 * 这里不允许直接改班。
 */
async function updateMember(id, patch, session, req) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT m.* FROM member m WHERE m.id = ? AND ' + NOT_TEST('m') + ' LIMIT 1',
    [id]
  );
  const before = rows[0];
  if (!before) throw new BizError(40404, '成员不存在');
  validate(patch);

  const sets = [];
  const args = [];
  const changed = {};
  const put = (col, val) => { sets.push(col + ' = ?'); args.push(val); changed[col] = val; };

  if (patch.name !== undefined) put('name', patch.name);
  if (patch.studentNo !== undefined) put('student_no', patch.studentNo);
  if (patch.role !== undefined) put('role', patch.role);
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.groupTag !== undefined) put('group_tag', patch.groupTag);
  if (patch.position !== undefined) put('position', patch.position);
  if (patch.dutyOff !== undefined) put('duty_off', patch.dutyOff ? 1 : 0);
  if (patch.feePerms !== undefined) put('fee_perms', stringifyFeePerms(patch.feePerms));

  // is_super 一律走单独的 grant 接口，不在通用 patch 里顺手改 ——
  // 超级管理员是整个后台的权限根，不能当普通字段随手保存。
  if (patch.isSuper !== undefined) {
    throw new BizError(40001, '超级管理员身份请使用「设为超管 / 取消超管」操作');
  }
  if (!sets.length) throw new BizError(40001, '没有要更新的字段');

  args.push(id);
  await pool.query('UPDATE member SET ' + sets.join(', ') + ' WHERE id = ?', args);
  await logAction(session, {
    module: 'member',
    action: 'member.update',
    classId: before.class_id,
    summary: '修改成员 ' + before.name + '（' + before.student_no + '）：' + Object.keys(changed).join('、'),
    detail: {
      memberId: id,
      before: maskMember(before),
      after: changed
    }
  }, req);
  return memberDetail(id);
}

/** 设为 / 取消超级管理员（member 表零结构改动，只翻 is_super） */
async function setSuper(id, isSuper, session, req) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT m.* FROM member m WHERE m.id = ? AND ' + NOT_TEST('m') + ' LIMIT 1',
    [id]
  );
  const before = rows[0];
  if (!before) throw new BizError(40404, '成员不存在');
  if (isSuper && before.role !== 'ADMIN') {
    throw new BizError(40001, '只有 ADMIN 角色才能设为超级管理员');
  }
  // ⚠️ WHERE 里带 NOT_TEST：测试账号是内部造的调试数据，不该被后台授予超管，
  // 否则会把 99 段学号的假账号坐实成真权限根。
  await pool.query('UPDATE member SET is_super = ? WHERE id = ? AND ' + NOT_TEST('m'), [isSuper ? 1 : 0, id]);
  await logAction(session, {
    module: 'member',
    action: isSuper ? 'member.grantSuper' : 'member.revokeSuper',
    classId: before.class_id,
    summary: (isSuper ? '设为超管：' : '取消超管：') + before.name + '（' + before.student_no + '）',
    detail: { memberId: id, name: before.name, studentNo: before.student_no, after: isSuper ? 1 : 0 }
  }, req);
  return memberDetail(id);
}

/** 新增成员 */
async function addMember(data, session, req) {
  const pool = getPool();
  validate(data);
  const classId = Number(data.classId);
  if (!classId) throw new BizError(40001, '请选择班级');
  const [crows] = await pool.query('SELECT id, name FROM `class` WHERE id = ? LIMIT 1', [classId]);
  if (!crows[0]) throw new BizError(40404, '班级不存在');
  const [dup] = await pool.query('SELECT id FROM member WHERE student_no = ? LIMIT 1', [data.studentNo]);
  if (dup.length) throw new BizError(40001, '学号已存在');

  const [r] = await pool.query(
    'INSERT INTO member (class_id, name, student_no, group_tag, role, position, status, fee_perms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      classId,
      data.name,
      data.studentNo,
      data.groupTag || 'A',
      data.role || 'MEMBER',
      data.position || '',
      data.status || 'ACTIVE',
      stringifyFeePerms(data.feePerms)
    ]
  );
  await logAction(session, {
    module: 'member',
    action: 'member.add',
    classId,
    summary: '新增成员 ' + data.name + '（' + data.studentNo + '）到 ' + crows[0].name,
    detail: data
  }, req);
  return memberDetail(r.insertId);
}

/** 删除成员：软删优先。已有值日/请假记录的一律拒绝硬删，避免历史悬空。 */
async function removeMember(id, session, req) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT m.* FROM member m WHERE m.id = ? AND ' + NOT_TEST('m') + ' LIMIT 1',
    [id]
  );
  const m = rows[0];
  if (!m) throw new BizError(40404, '成员不存在');
  const [[d]] = await pool.query('SELECT COUNT(*) AS c FROM duty WHERE member_id = ?', [id]);
  const [[l]] = await pool.query('SELECT COUNT(*) AS c FROM leave_request WHERE member_id = ?', [id]);
  const dutyCnt = Number(d.c || 0);
  const leaveCnt = Number(l.c || 0);
  if (dutyCnt > 0 || leaveCnt > 0) {
    // 有历史就不许硬删 —— 历史数据悬空会让「谁的班」这类问题再也答不清
    return {
      blocked: true,
      dutyCount: dutyCnt,
      leaveCount: leaveCnt,
      suggestion: '该成员已有 ' + dutyCnt + ' 条值日、' + leaveCnt + ' 条请假记录，不能删除；建议改为「停用」。'
    };
  }
  await pool.query('DELETE FROM member WHERE id = ? AND ' + NOT_TEST('m'), [id]);
  await logAction(session, {
    module: 'member',
    action: 'member.remove',
    classId: m.class_id,
    summary: '删除成员 ' + m.name + '（' + m.student_no + '），无历史记录',
    detail: { memberId: id, name: m.name, studentNo: m.student_no }
  }, req);
  return { blocked: false, removed: true };
}

module.exports = {
  listMembers, memberDetail, updateMember, setSuper, addMember, removeMember
};