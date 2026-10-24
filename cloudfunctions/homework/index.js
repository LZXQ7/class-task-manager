/**
 * 云函数：homework —— 作业提交与管理（2026-10-24）
 * ------------------------------------------------------------
 * action:
 *   publish  班委发布作业（标题 / 说明 / 截止日期 / 需交分组 / 附件）
 *   list     作业列表（成员只看本组作业；班委 / 辅导员看本班全部）
 *   detail   作业详情（含提交名单、已交未交统计、按状态筛选）
 *   submit   提交作业（覆盖式重交；截止后仅被打回者可交）
 *   review   批量批阅（多选标记 DONE / REJECT，REJECT 即打回）
 *   delete   删除作业（侧滑删除；仅发布者本人或超管，级联删记录与云存储文件）
 *   purge    清理截止满 N 天的文件实体（由 cron-weekly 定时调用）
 *
 * 🔴 存储铁律（个人版云存储仅 2GB）：
 *   · 二进制**永不经过云函数** —— 小程序端用 `wx.cloud.uploadFile` 直传云存储，
 *     云函数只收 fileID 字符串。256MB 内存 / 60s 超时因此完全不构成瓶颈。
 *   · 大小与格式**后端必须再校验一次**（前端那次只是提前拦 + 说人话，可被绕过）。
 *   · 过期文件由 `purge` 物理删除云存储对象，但**保留提交记录与状态**。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const { BizError, ok, fail } = require('./common/resp');
/* 测试账号唯一真源（见 common/test-account.js）：统计与名单口径一律排除，
 * 与 member.list / duty / fee 同套铁律。 */
const { NOT_TEST } = require('./common/test-account');
/* 上传限制唯一真源：与 miniprogram/utils/homework-limits.js 逐字一致，
 * 由 scripts/check-homework.js 强制比对。 */
const { LIMIT, extOf, allowExt, validateFiles } = require('./common/homework-limit');

const MAX_TITLE = 64;
const MAX_BRIEF = 500;
const VALID_GROUPS = ['A', 'B', 'SELF'];

/** 规范化分组：去重、过滤非法、排序、逗号拼接；非法返回空串 */
function normGroups(arr) {
  const set = {};
  (Array.isArray(arr) ? arr : []).forEach(g => {
    const s = String(g || '').toUpperCase();
    if (VALID_GROUPS.indexOf(s) >= 0) set[s] = 1;
  });
  return Object.keys(set).sort().join(',');
}

/** 班委判定：与 common/guard.js 的 isCommittee 同口径（ADMIN / MONITOR 且非辅导员） */
function isCommitteeMember(m) {
  return !!m && (m.role === 'ADMIN' || m.role === 'MONITOR') && m.group_tag !== 'X';
}

/** 角色：committee 班委 / super 超管 / counselor 辅导员 / member 普通成员 */
function roleOf(m) {
  if (!m) return 'member';
  if (m.group_tag === 'X') return 'counselor';
  if (guard.isSuper(m)) return 'super';
  if (isCommitteeMember(m)) return 'committee';
  return 'member';
}

/** 是否有批阅权：班委 / 超管（辅导员只读） */
function canReview(m) {
  const r = roleOf(m);
  return r === 'committee' || r === 'super';
}

/** 当前时间的 'YYYY-MM-DD HH:mm:ss'（用于截止比较：DATEIME 串按字典序即可比较先后） */
function nowFull() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

const REQUIRE_TYPES = ['NONE', 'IMAGE', 'FILE', 'EITHER'];
function normRequireType(v) {
  const s = String(v || 'NONE').toUpperCase();
  return REQUIRE_TYPES.indexOf(s) >= 0 ? s : 'NONE';
}

/* ============================================================
 * 发布 / 列表 / 详情
 * ============================================================ */

async function publish(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  if (!canReview(m)) throw new BizError(40003, '仅班委可发布作业');
  const classId = await guard.resolveClassId(getPool(), ctx, payload);

  const title = String(payload.title || '').trim().slice(0, MAX_TITLE);
  if (!title) throw new BizError(41001, '请填写作业标题');
  const brief = String(payload.brief || '').trim().slice(0, MAX_BRIEF);

  const dueDate = String(payload.dueDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dueDate)) throw new BizError(41001, '请选择截止日期与时间');

  const groups = normGroups(payload.groups);
  if (!groups) throw new BizError(41001, '请选择需提交作业的分组');

  const maxImages = Math.min(Math.max(1, Number(payload.maxImages) || LIMIT.IMAGE_COUNT_DEFAULT), LIMIT.IMAGE_COUNT_CEILING);
  const maxFiles = Math.min(Math.max(1, Number(payload.maxFiles) || LIMIT.FILE_COUNT_DEFAULT), LIMIT.FILE_COUNT_CEILING);
  const requireType = normRequireType(payload.requireType);

  const attaches = Array.isArray(payload.attaches) ? payload.attaches : [];
  if (attaches.length > maxFiles) throw new BizError(41001, '附件最多 ' + maxFiles + ' 个');
  // ⚠️ 仅在有附件时校验：validateFiles 对空列表返回「请上传作业内容」，
  //    而发布作业的附件是**可选的**（前端允许 uploaded=[] 直发）——
  //    早年不判长度导致「不带附件的作业根本发布不了」（2026-10-24 门禁 S1.6 抓出）。
  if (attaches.length) {
    const av = validateFiles(attaches.map(a => ({
      fileId: a.fileId, name: a.name, size: a.size,
      // 🔴 透传真实类型：早年这里硬编码 kind:'FILE'，图片附件被按**文件白名单**校验
      //    ⇒ 真机「添加图片却报：文件格式不支持，仅支持 pdf/doc/docx/...」（2026-10-24 用户反馈）
      kind: a.kind === 'IMAGE' ? 'IMAGE' : 'FILE'
    })), { maxImages, maxFiles });
    if (!av.ok) throw new BizError(41001, av.msg);
  }

  const pool = getPool();
  const [ins] = await pool.query(
    `INSERT INTO homework (class_id, title, brief, due_date, target_groups, max_images, max_files, require_type, publisher_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [classId, title, brief, dueDate, groups, maxImages, maxFiles, requireType, Number(m.id) || 0]
  );
  const hwId = Number(ins.insertId) || 0;

  for (const a of attaches) {
    await pool.query(
      `INSERT INTO homework_file (class_id, homework_id, member_id, kind, file_id, name, mime, size)
       VALUES (?, ?, 0, 'ATTACH', ?, ?, ?, ?)`,
      [classId, hwId, String(a.fileId || ''), String(a.name || '').slice(0, 255),
        String(a.mime || '').slice(0, 64), Number(a.size) || 0]
    );
  }
  return { id: hwId };
}

async function list(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  const classId = await guard.resolveClassId(getPool(), ctx, payload);
  const pool = getPool();

  // 普通成员：只看「指定分组包含自己 group_tag」的作业，外加「仅自己」且自己是发布者的；
  // 班委：本班全部（含所有人的仅自己）
  const mine = String((m && m.group_tag) || '');
  const sql = canReview(m)
    ? 'SELECT * FROM homework WHERE class_id = ? ORDER BY due_date DESC, id DESC'
    : `SELECT * FROM homework WHERE class_id = ? AND (target_groups LIKE CONCAT('%', ?, '%') OR (target_groups LIKE '%SELF%' AND publisher_id = ?)) ORDER BY due_date DESC, id DESC`;
  const args = canReview(m) ? [classId] : [classId, mine, Number(m.id) || 0];
  const [rows] = await pool.query(sql, args);

  // 我的提交状态（一个人一条）
  const [subs] = await pool.query(
    'SELECT homework_id, status, submitted_at FROM homework_submit WHERE class_id = ? AND member_id = ?',
    [classId, Number(m.id) || 0]
  );
  const map = {};
  subs.forEach(s => { map[Number(s.homework_id)] = s; });

  const now = nowFull();

  return {
    list: rows.map(h => ({
      id: h.id,
      title: h.title,
      brief: h.brief,
      dueDate: String(h.due_date || '').slice(0, 16),   // 'YYYY-MM-DD HH:mm'
      groups: String(h.target_groups || '').split(',').filter(Boolean),
      maxImages: Number(h.max_images) || 0,
      maxFiles: Number(h.max_files) || 0,
      requireType: String(h.require_type || 'NONE'),
      publisherId: Number(h.publisher_id) || 0,
      // 侧滑删除权限（前端露不露删除区按这个字段）：仅发布者本人或超管。
      // 班委也不能删别人发的作业——发布者对内容负责（2026-10-24 用户需求）。
      canDelete: Number(h.publisher_id) === (Number(m.id) || 0) || guard.isSuper(m),
      purged: !!Number(h.purged),
      myStatus: map[h.id] ? map[h.id].status : null,      // null = 未交
      mySubmittedAt: map[h.id] ? map[h.id].submitted_at : null,
      closed: String(h.due_date) < now,   // 已截止（精确到分钟）
      overdue: String(h.due_date) < now
    })),
    // 🔴 前端列表页的「发布作业」按钮依赖这个字段（index.js: canReview = !!(res.canReview)）。
    //    此前 list 直接返回数组、未带 canReview，导致班委也看不到发布入口（补 2026-10-24）。
    canReview: canReview(m)
  };
}

async function detail(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  const hwId = Number(payload.id) || 0;
  if (!hwId) throw new BizError(41001, '参数错误');
  const pool = getPool();
  const classId = await guard.resolveClassId(pool, ctx, payload);

  const [hwRows] = await pool.query(
    'SELECT * FROM homework WHERE id = ? AND class_id = ?', [hwId, classId]
  );
  if (!hwRows.length) throw new BizError(41001, '作业不存在');
  const h = hwRows[0];
  const targets = String(h.target_groups || '').split(',').filter(Boolean);

  const viewerRole = roleOf(m);
  // 普通成员：只能看「指定给本组」的作业，外加「仅自己」且自己是发布者的；且只能看自己的提交（不含名单）
  const isPrivileged = viewerRole === 'committee' || viewerRole === 'super' || viewerRole === 'counselor';
  if (!isPrivileged) {
    const gt = String(m.group_tag || '');
    const selfVisible = targets.indexOf('SELF') >= 0 && Number(h.publisher_id) === Number(m.id);
    if (targets.indexOf(gt) < 0 && !selfVisible) {
      throw new BizError(40003, '该作业未要求你所在分组提交');
    }
  }

  const [attach] = await pool.query(
    "SELECT id, name, mime, size, file_id, created_at FROM homework_file WHERE homework_id = ? AND kind = 'ATTACH' ORDER BY id",
    [hwId]
  );

  // 需交成员 = 本班 ACTIVE 且非 X 组、group_tag ∈ targets（测试账号由 NOT_TEST 排除）
  const [memRows] = await pool.query(
    'SELECT id, name, student_no, group_tag FROM member WHERE class_id = ? AND status = \'ACTIVE\' AND '
    + NOT_TEST() + ' AND group_tag <> \'X\'', [classId]
  );
  // 「仅自己」作业：发布者本人也要进需交名单 —— 自己发给自己测提交/批阅流程
  // （2026-10-24 用户反馈：发布仅自己的作业后详情页「该筛选下没有成员」，自己没法交）。
  // 注意发布者可能是班委/超管，group_tag 未必在 targets 里，必须显式补。
  const members = memRows.filter(x =>
    targets.indexOf(String(x.group_tag)) >= 0
    || (targets.indexOf('SELF') >= 0 && Number(x.id) === Number(h.publisher_id)));

  const [subs] = await pool.query(
    'SELECT * FROM homework_submit WHERE homework_id = ? AND class_id = ?', [hwId, classId]
  );
  const subMap = {};
  subs.forEach(s => { subMap[Number(s.member_id)] = s; });

  const hwFileRows = h.purged ? [] : await (async () => {
    const [r] = await pool.query(
      "SELECT id, homework_id, member_id, name, mime, size, file_id, created_at FROM homework_file WHERE homework_id = ? AND kind = 'SUBMIT' ORDER BY id",
      [hwId]
    );
    return r;
  })();
  const filesByMember = {};
  hwFileRows.forEach(f => {
    const k = Number(f.member_id);
    (filesByMember[k] = filesByMember[k] || []).push({
      id: f.id, name: f.name, mime: f.mime, size: Number(f.size) || 0, fileId: f.file_id
    });
  });

  const now = nowFull();
  const closed = String(h.due_date) < now;

  // 提交名单：班委 / 辅导员看全部；普通成员只看自己
  // files（提交的附件）：特权角色看全部；普通成员至少能看自己交的（预览/下载用）
  const list = members.map(x => {
    const s = subMap[Number(x.id)];
    return {
      id: x.id, name: x.name, studentNo: x.student_no, groupTag: x.group_tag,
      status: s ? s.status : null,           // null = 未交
      remark: s ? s.remark : '',
      submittedAt: s ? s.submitted_at : null,
      files: (isPrivileged || Number(x.id) === Number(m.id))
        ? (filesByMember[Number(x.id)] || []) : []
    };
  });

  // 筛选：all / submitted / pending / done / reject
  const filter = String(payload.filter || 'all');
  let view = list;
  if (filter === 'submitted') view = list.filter(x => !!x.status);
  else if (filter === 'pending') view = list.filter(x => !x.status);
  else if (filter === 'done') view = list.filter(x => x.status === 'DONE');
  else if (filter === 'reject') view = list.filter(x => x.status === 'REJECT');

  if (!isPrivileged) {
    view = view.filter(x => Number(x.id) === Number(m.id));
  }

  const submitted = list.filter(x => !!x.status).length;
  const done = list.filter(x => x.status === 'DONE').length;
  const reject = list.filter(x => x.status === 'REJECT').length;
  const pending = list.filter(x => !x.status).length;

  return {
    homework: {
      id: h.id,
      title: h.title,
      brief: h.brief,
      dueDate: String(h.due_date || '').slice(0, 16),   // 'YYYY-MM-DD HH:mm'
      groups: targets,
      maxImages: Number(h.max_images) || 0,
      maxFiles: Number(h.max_files) || 0,
      requireType: String(h.require_type || 'NONE'),
      publisherId: Number(h.publisher_id) || 0,
      purged: !!Number(h.purged)
    },
    attaches: h.purged ? [] : attach.map(f => ({
      id: f.id, name: f.name, mime: f.mime, size: Number(f.size) || 0, fileId: f.file_id
    })),
    stats: { total: list.length, submitted, pending, done, reject },
    list: view,
    canReview: canReview(m),
    // 查看者自己的提交状态（null=未交）+ 是否已截止：前端「提交作业」按钮
    // 只有未提交 / 被打回（REJECT）时可点，待批阅/已完成/已截止一律置灰
    // （2026-10-24 用户反馈「提交作业后按钮还亮着，只有未提交或被打回的才可点」）
    myStatus: (function () {
      const s = subMap[Number(m.id)];
      return s ? s.status : null;
    })(),
    closed: closed,
    // 本人是否也要提交这份作业：分组命中 或 「仅自己」且我是发布者。
    // 班委发的作业若本人也在目标分组（或仅自己自测），底部要同时给「提交作业」入口，
    // 否则发布者自己无法测试提交（2026-10-24 用户反馈）。
    iAmSubmitter: (function () {
      const gt = String(m.group_tag || '');
      return targets.indexOf(gt) >= 0
        || (targets.indexOf('SELF') >= 0 && Number(h.publisher_id) === Number(m.id));
    })()
  };
}

/* ============================================================
 * 提交 / 批阅 / 清理
 * ============================================================ */

async function submit(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  const hwId = Number(payload.homeworkId) || 0;
  if (!hwId) throw new BizError(41001, '参数错误');
  const pool = getPool();

  const [hwRows] = await pool.query('SELECT * FROM homework WHERE id = ?', [hwId]);
  if (!hwRows.length) throw new BizError(41001, '作业不存在');
  const h = hwRows[0];
  const classId = Number(h.class_id) || 0;
  if (classId !== (Number(m.class_id) || 0) && !isCommitteeMember(m)) {
    throw new BizError(40003, '无权提交该作业');
  }

  const targets = String(h.target_groups || '').split(',').filter(Boolean);
  // 「仅自己」作业：发布者本人可提交（自己发给自己测流程的场景）
  const selfTarget = targets.indexOf('SELF') >= 0 && Number(h.publisher_id) === Number(m.id);
  if (targets.indexOf(String(m.group_tag || '')) < 0 && !selfTarget) {
    throw new BizError(40003, '该作业未要求你所在分组提交');
  }

  const now = nowFull();
  const [oldSub] = await pool.query(
    'SELECT id, status FROM homework_submit WHERE homework_id = ? AND member_id = ? LIMIT 1',
    [hwId, Number(m.id) || 0]
  );
  const closed = String(h.due_date) < now;
  const wasRejected = oldSub.length && oldSub[0].status === 'REJECT';
  if (closed && !wasRejected) {
    throw new BizError(41001, '作业已截止，无法提交');
  }

  const files = Array.isArray(payload.files) ? payload.files : [];
  const requireType = normRequireType(h.require_type);
  if (requireType === 'NONE') {
    // 不强制附件：允许 0 文件（纯文字提交）；有文件则照常校验
    if (files.length) {
      const v0 = validateFiles(files, { maxImages: h.max_images, maxFiles: h.max_files }, 'SUBMIT');
      if (!v0.ok) throw new BizError(41001, v0.msg);
    }
  } else {
    // 有类型要求：空文件 / 类型不匹配都走下方「至少 1 个对应类型」判定，
    // 错误文案按类型说人话（早年先抛通用「请上传作业内容」，提示不精确）
    const nImg = files.filter(f => f && f.kind === 'IMAGE').length;
    const nFile = files.length - nImg;
    const ok = requireType === 'IMAGE' ? nImg >= 1
      : requireType === 'FILE' ? nFile >= 1
      : (nImg + nFile) >= 1;
    if (!ok) {
      const label = requireType === 'IMAGE' ? '本作业要求至少上传 1 张图片'
        : requireType === 'FILE' ? '本作业要求至少上传 1 个文件'
        : '本作业要求至少上传 1 个图片或文件';
      throw new BizError(41001, label);
    }
    const v = validateFiles(files, { maxImages: h.max_images, maxFiles: h.max_files }, 'SUBMIT');
    if (!v.ok) throw new BizError(41001, v.msg);
  }

  // 覆盖式重交：先摘掉旧文件（云存储对象 + 文件记录），再落新的
  const [oldFiles] = await pool.query(
    'SELECT file_id FROM homework_file WHERE homework_id = ? AND member_id = ? AND kind = \'SUBMIT\'',
    [hwId, Number(m.id) || 0]
  );
  const oldIds = oldFiles.map(f => String(f.file_id || '')).filter(Boolean);
  if (oldIds.length) {
    try { await cloud.deleteFile({ fileList: oldIds }); } catch (e) { /* 已删/不存在：照样清记录 */ }
    await pool.query(
      'DELETE FROM homework_file WHERE homework_id = ? AND member_id = ? AND kind = \'SUBMIT\'',
      [hwId, Number(m.id) || 0]
    );
  }

  for (const f of files) {
    await pool.query(
      `INSERT INTO homework_file (class_id, homework_id, member_id, kind, file_id, name, mime, size)
       VALUES (?, ?, ?, 'SUBMIT', ?, ?, ?, ?)`,
      [classId, hwId, Number(m.id) || 0, String(f.fileId || ''),
        String(f.name || '').slice(0, 255), String(f.mime || '').slice(0, 64), Number(f.size) || 0]
    );
  }

  // 一人一作业一条：已存在则覆盖状态回 PENDING（重交即重新待批）
  await pool.query(
    `INSERT INTO homework_submit (class_id, homework_id, member_id, status, remark)
     VALUES (?, ?, ?, 'PENDING', '')
     ON DUPLICATE KEY UPDATE status = 'PENDING', remark = '', updated_at = CURRENT_TIMESTAMP`,
    [classId, hwId, Number(m.id) || 0]
  );

  return { ok: true };
}

async function review(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  if (!canReview(m)) throw new BizError(40003, '仅班委可批阅作业');
  const hwId = Number(payload.homeworkId) || 0;
  const ids = (Array.isArray(payload.memberIds) ? payload.memberIds : [])
    .map(Number).filter(Boolean);
  const status = String(payload.status || '').toUpperCase();
  if (!hwId || !ids.length) throw new BizError(41001, '参数错误');
  if (status !== 'DONE' && status !== 'REJECT') throw new BizError(41001, '未知的批阅状态');

  const pool = getPool();
  const [hwRows] = await pool.query('SELECT class_id FROM homework WHERE id = ?', [hwId]);
  if (!hwRows.length) throw new BizError(41001, '作业不存在');
  const classId = Number(hwRows[0].class_id) || 0;
  if (classId !== (Number(m.class_id) || 0) && !guard.isSuper(m)) {
    throw new BizError(40003, '无权批阅其它班级的作业');
  }

  const remark = String(payload.remark || '').trim().slice(0, 200);
  // 只允许标记「已提交过」的成员（避免凭空造一条 DONE 记录）
  const ph = ids.map(() => '?').join(',');
  await pool.query(
    `UPDATE homework_submit SET status = ?, remark = ?, updated_at = CURRENT_TIMESTAMP
      WHERE homework_id = ? AND member_id IN (${ph})`,
    [status, remark, hwId].concat(ids)
  );
  return { ok: true };
}

/**
 * 删除作业（侧滑删除，2026-10-24 用户需求「和通知页面一样」）
 * ------------------------------------------------------------
 * 权限：**仅发布者本人或超管**。班委也不能删别人发的作业（发布者对内容负责）；
 *       普通成员连别人的作业都看不到，更谈不上删。
 * 级联：homework_submit / homework_file 记录全删 + 云存储文件物理删
 *       （附件 + 各成员提交的文件都占 2GB 配额，记录走了文件必须跟着走）。
 * ⚠️ 不可恢复：删除前前端必须 wx.showModal 二次确认。
 */
async function del(payload, ctx) {
  guard.requireBind(ctx);
  const m = ctx.member;
  const hwId = Number(payload.homeworkId || payload.id) || 0;
  if (!hwId) throw new BizError(41001, '参数错误');

  const pool = getPool();
  const [hwRows] = await pool.query('SELECT * FROM homework WHERE id = ?', [hwId]);
  if (!hwRows.length) throw new BizError(41001, '作业不存在');
  const h = hwRows[0];
  const classId = Number(h.class_id) || 0;
  if (classId !== (Number(m.class_id) || 0) && !guard.isSuper(m)) {
    throw new BizError(40003, '无权删除其它班级的作业');
  }
  const isOwner = Number(h.publisher_id) === (Number(m.id) || 0) && Number(h.publisher_id) > 0;
  if (!isOwner && !guard.isSuper(m)) {
    throw new BizError(40003, '只有发布者或超管可以删除作业');
  }

  // 先收 file_id（附件 + 提交文件），记录删完再清云存储
  const [fileRows] = await pool.query(
    'SELECT file_id FROM homework_file WHERE homework_id = ?', [hwId]
  );
  const fileIds = fileRows.map(r => String(r.file_id || '')).filter(Boolean);

  await pool.query('DELETE FROM homework_file WHERE homework_id = ?', [hwId]);
  await pool.query('DELETE FROM homework_submit WHERE homework_id = ?', [hwId]);
  await pool.query('DELETE FROM homework WHERE id = ?', [hwId]);

  // 云存储删除失败不阻塞（记录已删；孤儿文件由 cron 清理策略兜底）
  if (fileIds.length) {
    try { await cloud.deleteFile({ fileList: fileIds }); } catch (e) { /* 已删/不存在 */ }
  }
  return { id: hwId, files: fileIds.length };
}

const routes = {
  publish: { auth: { needBind: true }, handler: publish },
  list: { auth: { needBind: true }, handler: list },
  detail: { auth: { needBind: true }, handler: detail },
  submit: { auth: { needBind: true }, handler: submit },
  review: { auth: { needBind: true }, handler: review },
  delete: { auth: { needBind: true }, handler: del }
};

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[homework] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
