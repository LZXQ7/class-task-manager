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

/** 停用 / 启用班级 */
async function setClassActive(id, isActive, session, req) {
  return updateClass(id, { isActive: !!isActive }, session, req);
}

module.exports = { listClasses, classDetail, updateClass, setClassActive };