/**
 * 班级 / 账号班级 读取与写操作（模块：class）
 *
 * 跨班口径：后台一律**放开跨班**（这是相对小程序的核心价值 —— 小程序侧超管写别的班
 * 仍走 guard.classIdOf 会串到本人班，详见项目 MEMORY「课表多班隔离」）。
 * 后台不需要重建 isCounselor / staffClassIds / resolveClassId：使用者只有超管，
 * 班级由顶部显式选择，每次写操作都把目标 classId 显式落进审计。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { logAction } = require('./audit');
const { syncMainRoomCleaning } = require('./mod-course');

function jsonSafe(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { return v; }
  }
  return v;
}

function maskClass(r) {
  return {
    id: r.id,
    name: r.name,
    joinToken: r.join_token,
    inviteCode: r.invite_code,
    termStart: typeof r.term_start === 'string' ? r.term_start.slice(0, 10) : r.term_start,
    totalWeeks: r.total_weeks,
    bindOpen: Number(r.bind_open) !== 0,
    isActive: Number(r.is_active) !== 0,
    // 演示班（2026-10-28 演示环境隔离）：全虚构数据、只服务审核体验入口。
    // 🔴 它被**刻意**设为 is_active=0（避免出现在真实超管的小程序班级列表里），
    //   后台必须拿到这个标记，否则只能显示成「停用」——语义错、还会误导以为被人停掉了。
    isDemo: Number(r.is_demo) !== 0,
    periodTime: jsonSafe(r.period_time) || [],
    mainRoom: r.main_room || '',
    memberCount: Number(r.cnt || 0)
  };
}

async function listClasses() {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT c.*, (SELECT COUNT(*) FROM member m WHERE m.class_id = c.id) AS cnt ' +
    'FROM `class` c ORDER BY c.id'
  );
  return rows.map(maskClass);
}

/**
 * 后台可见班级（2026-11-16 软删除）。
 * 🔴 软删除的班级就是 is_active=0 且 is_demo=0 —— 列表和顶部选择器都必须过滤，
 *    否则「删了还在下拉里」等于没删；演示班本身就是 is_active=0（刻意停的），
 *    不能被这条规则一起吃掉，仍按 canSeeDemo 单独放行。
 * 两个入口（/api/me 与 /api/classes）必须共用本函数，漏一个就会出现
 * 「列表没了但下拉还在 / 下拉没了但列表还在」的漂移。
 */
function filterAdminVisible(classes, canSeeDemo) {
  return classes
    .filter((c) => Number(c.isActive) !== 0 || !!c.isDemo)
    .filter((c) => canSeeDemo || !c.isDemo);
}

/** 班级详情：连成员数、课次数、值日表规模一起给，前端顶部卡片用 */
async function classDetail(id) {
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT c.*, (SELECT COUNT(*) FROM member m WHERE m.class_id = c.id) AS cnt ' +
    'FROM `class` c WHERE c.id = ? LIMIT 1',
    [id]
  );
  if (!rows[0]) throw new BizError(40404, '班级不存在');
  const base = maskClass(rows[0]);
  const [[sc]] = await pool.query(
    'SELECT COUNT(*) AS sessionCnt, SUM(kind = \'COURSE\') AS courseCnt, SUM(kind = \'CLEAN\') AS cleanCnt ' +
    'FROM session WHERE class_id = ?',
    [id]
  );
  const [[dc]] = await pool.query('SELECT COUNT(*) AS dutyCnt FROM duty WHERE class_id = ?', [id]);
  return {
    ...base,
    stats: {
      sessionCount: Number(sc.sessionCnt || 0),
      courseSessionCount: Number(sc.courseCnt || 0),
      cleanCount: Number(sc.cleanCnt || 0),
      dutyCount: Number(dc.dutyCnt || 0)
    }
  };
}

/**
 * 更新班级。字段级权限（对齐小程序 class.update 的口径，不能因为是后台就放开一切）：
 *   - name：超管可改（会应用到全部成员展示）
 *   - term_start / total_weeks / bind_open / period_time：仅超管
 * 后台使用者本来就只有超管，所以这里不做第二层区分，但**每个字段都显式列出**，
 * 避免「前端传什么就改什么」的越权写。
 */
async function updateClass(id, patch, session, req) {
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [id]);
  const before = rows[0];
  if (!before) throw new BizError(40404, '班级不存在');

  const sets = [];
  const args = [];
  const changed = {};
  const put = (col, val) => {
    sets.push(col + ' = ?');
    args.push(val);
    changed[col] = val;
  };
  if (patch.name !== undefined) {
    const n = String(patch.name).trim();
    if (!n) throw new BizError(40001, '班级名不能为空');
    if (n.length > 64) throw new BizError(40001, '班级名过长');
    put('name', n);
  }
  if (patch.termStart !== undefined) {
    const d = String(patch.termStart).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BizError(40001, '开学日期格式应为 YYYY-MM-DD');
    put('term_start', d);
  }
  if (patch.totalWeeks !== undefined) {
    const n = Number(patch.totalWeeks);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw new BizError(40001, '总周数应为 1~30 的整数');
    put('total_weeks', n);
  }
  if (patch.bindOpen !== undefined) put('bind_open', patch.bindOpen ? 1 : 0);
  if (patch.isActive !== undefined) put('is_active', patch.isActive ? 1 : 0);
  if (patch.periodTime !== undefined) {
    const arr = Array.isArray(patch.periodTime) ? patch.periodTime : null;
    if (!arr) throw new BizError(40001, '大节时间格式不对');
    const norm = arr.map((p, i) => ({
      period: Number(p.period) || i + 1,
      start: String(p.start || ''),
      end: String(p.end || '')
    }));
    for (const p of norm) {
      if (!/^\d{2}:\d{2}$/.test(p.start) || !/^\d{2}:\d{2}$/.test(p.end)) {
        throw new BizError(40001, '大节时间需为 HH:mm 格式');
      }
    }
    put('period_time', JSON.stringify(norm));
  }
  if (patch.mainRoom !== undefined) {
    const r = String(patch.mainRoom == null ? '' : patch.mainRoom).trim();
    if (r.length > 32) throw new BizError(40001, '主教室名过长（≤32 字符）');
    if (/[\r\n\t]/.test(r)) throw new BizError(40001, '主教室名不能含换行/制表符');
    put('main_room', r || null);
  }
  if (!sets.length) throw new BizError(40001, '没有要更新的字段');

  args.push(id);
  await pool.query('UPDATE `class` SET ' + sets.join(', ') + ' WHERE id = ?', args);

  // 主教室改动 ⇒ 同步该班保洁课次名 + 房间（best-effort：同步失败不回滚已落字段，仅记录）
  let mainRoomSync = null;
  if (patch.mainRoom !== undefined &&
      String(before.main_room || '') !== String(changed.main_room || '')) {
    try {
      mainRoomSync = await syncMainRoomCleaning(pool, id, changed.main_room);
    } catch (e) {
      console.error('[syncMainRoomCleaning]', (e && e.stack) || e);
      mainRoomSync = { error: String((e && e.message) || e) };
    }
  }

  await logAction(session, {
    module: 'class',
    action: 'class.update',
    classId: id,
    summary: '修改班级配置：' + Object.keys(changed).join('、'),
    detail: {
      before: maskClass(before),
      after: changed,
      mainRoomSync: mainRoomSync
    }
  }, req);
  return classDetail(id);
}

/** 东八区「本周周一」的 YYYY-MM-DD（云函数容器默认 UTC，不能直接用 new Date().getDate()） */
function thisMonday() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const day = d.getUTCDay() || 7;             // 周日 = 0 → 按 7 算
  const monday = new Date(d.getTime() - (day - 1) * 24 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return monday.getUTCFullYear() + '-' + p(monday.getUTCMonth() + 1) + '-' + p(monday.getUTCDate());
}

/** 默认大节时间（取不到任何现有班级配置时的兜底；与小程序默认 5 节一致） */
const DEFAULT_PERIOD_TIME = [
  { period: 1, start: '08:00', end: '09:40' },
  { period: 2, start: '10:00', end: '11:40' },
  { period: 3, start: '14:00', end: '15:40' },
  { period: 4, start: '16:00', end: '17:40' },
  { period: 5, start: '19:00', end: '20:40' }
];

/** 6 位数字加入口令（与现有班一致）；UNIQUE 冲突就重摇 */
async function nextJoinToken(pool) {
  for (let i = 0; i < 30; i++) {
    const t = String(Math.floor(100000 + Math.random() * 900000));
    const [r] = await pool.query('SELECT id FROM `class` WHERE join_token = ? LIMIT 1', [t]);
    if (!r[0]) return t;
  }
  throw new BizError(50001, '生成加入口令失败，请重试');
}

/** 邀请码：CLS + 两位年 + A01 递增（沿用现有 <INVITE_CODE> 风格）；冲突就往后找 */
async function nextInviteCode(pool) {
  const yy = String(new Date(Date.now() + 8 * 3600 * 1000).getUTCFullYear()).slice(2);
  for (let n = 1; n <= 999; n++) {
    const code = 'CLS' + yy + 'A' + String(n).padStart(2, '0');
    const [r] = await pool.query('SELECT id FROM `class` WHERE invite_code = ? LIMIT 1', [code]);
    if (!r[0]) return code;
  }
  throw new BizError(50001, '邀请码号段已用尽，请手工指定');
}

/**
 * 新增班级（2026-11-16 用户要求：「账号班级增加可添加班级、上传成员名单等功能」）。
 *
 * 口径（用户选「只填班级名，其余自动」）：
 *   · 必填只有 name；学期起始默认**本周周一**、总周数 16、绑定入口开；
 *   · join_token / invite_code 自动生成（都是 UNIQUE，冲突自动重摇）；
 *   · period_time 套用**现有班级**的配置（取最近一个有值的非演示班），取不到用内置 5 节；
 *   · is_demo / review_demo_on 恒为 0 —— 演示班只能由脚本建，接口不给开这个口子。
 * 建完在「配置」里可以改所有字段，所以这里不做「一次填全」的复杂表单。
 */
async function createClass(p, session, req) {
  const pool = getPool();
  const name = String((p && p.name) || '').trim();
  if (!name) throw new BizError(40001, '请填写班级名称');
  if (name.length > 64) throw new BizError(40001, '班级名过长（最多 64 字）');

  const [dup] = await pool.query('SELECT id FROM `class` WHERE name = ? LIMIT 1', [name]);
  if (dup[0] && !p.confirmDup) {
    throw new BizError(40001, '已存在同名班级（id ' + dup[0].id + '），请换个名字或先确认');
  }

  const termStart = (function () {
    const t = String((p && p.termStart) || '').trim();
    if (!t) return thisMonday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) throw new BizError(40001, '学期第一周格式应为 YYYY-MM-DD');
    return t;
  })();
  const totalWeeks = (function () {
    const n = Number((p && p.totalWeeks) || 16);
    if (!Number.isInteger(n) || n < 1 || n > 30) throw new BizError(40001, '总周数应为 1~30 的整数');
    return n;
  })();

  // 大节时间模板：借现有班级的配置，避免新班建出来课表没有节次可选
  let periodTime = null;
  if (Array.isArray(p.periodTime) && p.periodTime.length) {
    periodTime = p.periodTime.map((x, i) => ({
      period: Number(x.period) || i + 1,
      start: String(x.start || ''),
      end: String(x.end || '')
    }));
    for (const x of periodTime) {
      if (!/^\d{2}:\d{2}$/.test(x.start) || !/^\d{2}:\d{2}$/.test(x.end)) {
        throw new BizError(40001, '大节时间需为 HH:mm 格式');
      }
    }
  } else {
    const [tpl] = await pool.query(
      'SELECT period_time FROM `class` WHERE period_time IS NOT NULL AND is_demo = 0 ' +
      'AND JSON_LENGTH(period_time) > 0 ORDER BY id DESC LIMIT 1'
    );
    const raw = tpl[0] ? jsonSafe(tpl[0].period_time) : null;
    periodTime = Array.isArray(raw) && raw.length ? raw : DEFAULT_PERIOD_TIME;
  }

  const joinToken = await nextJoinToken(pool);
  const inviteCode = await nextInviteCode(pool);

  const [ins] = await pool.query(
    'INSERT INTO `class` (name, join_token, invite_code, term_start, total_weeks, bind_open, period_time, is_active, is_demo, review_demo_on) ' +
    'VALUES (?, ?, ?, ?, ?, 1, ?, 1, 0, 0)',
    [name, joinToken, inviteCode, termStart, totalWeeks, JSON.stringify(periodTime)]
  );

  await logAction(session, {
    module: 'class',
    action: 'class.create',
    classId: ins.insertId,
    summary: '新建班级 ' + name + '（口令 ' + joinToken + ' / 邀请码 ' + inviteCode + '）',
    detail: { classId: ins.insertId, name, joinToken, inviteCode, termStart, totalWeeks, periodTime }
  }, req);

  return classDetail(ins.insertId);
}

/** 停用 / 启用班级 */
async function setClassActive(id, isActive, session, req) {
  return updateClass(id, { isActive: !!isActive }, session, req);
}

/**
 * 软删除班级（2026-11-16 用户选定口径）。
 * 只把 is_active 置 0：班级从后台列表 / 顶部选择器 / 小程序端同时消失，
 * 但成员、课表、值日、班费、通知等**一行都不删** —— 误删可改库恢复。
 * 🔴 为什么不硬删：class_id 散落在十几张表（member / session / duty / 班费 / 通知 / 作业
 *    / 使用统计 …），级联清理一旦漏表就留下孤儿数据，且超管成员所在班被删会直接自锁。
 * 演示班（is_demo=1）是审核体验入口，不是真班级，拒绝删除；重复删除直接报错，
 * 避免审计表堆同一条操作、也避免前端重复点击造成误解。
 */
async function softDeleteClass(id, session, req) {
  const cid = Number(id);
  if (!Number.isInteger(cid) || cid <= 0) throw new BizError(40001, '班级 id 不合法');
  const pool = getPool();
  const [rows] = await pool.query('SELECT * FROM `class` WHERE id = ? LIMIT 1', [cid]);
  const before = rows[0];
  if (!before) throw new BizError(40404, '班级不存在');
  if (Number(before.is_demo) !== 0) throw new BizError(40001, '演示班不可删除');
  if (Number(before.is_active) === 0) throw new BizError(40001, '该班级已删除，无需重复操作');

  const [[cnt]] = await pool.query('SELECT COUNT(*) AS cnt FROM member WHERE class_id = ?', [cid]);
  // 用占位符而非字面量 0：e2e 的 mock UPDATE 只认 `SET col = ?`，
  // 写成字面量会「审计写了但班级没改」——假绿比真红更难查。
  await pool.query('UPDATE `class` SET is_active = ? WHERE id = ?', [0, cid]);

  await logAction(session, {
    module: 'class',
    action: 'class.delete',
    classId: cid,
    summary: '软删除班级 ' + before.name + '（仅停用，数据保留）',
    detail: {
      classId: cid,
      name: before.name,
      memberCount: Number((cnt && cnt.cnt) || 0),
      mode: 'soft'
    }
  }, req);

  return { id: cid, name: before.name, isActive: false, mode: 'soft' };
}

module.exports = {
  listClasses, filterAdminVisible, classDetail, updateClass,
  setClassActive, createClass, softDeleteClass
};