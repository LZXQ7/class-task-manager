/**
 * 云函数：course —— 课表（开发文档 8.2 #3）
 * action: listWeek / upsert / delete / copyFrom
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const reviewDemo = require('./common/review-demo');
const week = require('./common/week');
const audit = require('./common/audit');
const { BizError, ok, fail } = require('./common/resp');
// 课表导入写库核心（2026-10-10 抽出，与网页后台共用「一份定义」）。
// ⚠️ 本文件内的 rollbackDutyMarkers / toDraftWeeks 仍被其它 12 处调课逻辑使用，
//    所以**保留**它们；importTimetable 这条路径改走共用模块以保证两边规则一致。
const timetableImport = require('./common/timetable-import');
const { repointSessionRoom } = require('./common/repoint-room');
// ⚠️ import-parse 惰性 require（2026-10-05）：它在模块顶层会 require xlsx（SheetJS，数 MB）。
// 顶层直接 import ⇒ 连课表页日常的 listWeek 冷启动都得载整个 SheetJS，
// 导入时更会「冷启+载库+下载+解析」叠加撞 timeout（前端表现为「网络异常，请稍后重试」）。
// 改成只在真正导入时才加载；Node 模块缓存保证同一冷启动内只载一次。
let _parseTimetableXlsx = null;
function parseTimetableXlsx(...args) {
  if (!_parseTimetableXlsx) _parseTimetableXlsx = require('./import-parse').parseTimetableXlsx;
  return _parseTimetableXlsx(...args);
}

const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];

async function loadWeekRows(pool, wk, classId) {
  const [rows] = await pool.query(
    `SELECT s.id AS sessionId, s.course_id, s.week_rule, s.weeks, s.day_of_week, s.period, s.group_scope, s.duty_count, s.note,
            c.name, c.teacher, c.room, c.course_type
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.class_id = ?
      ORDER BY s.day_of_week, s.period`, [classId]
  );
  return rows.filter(r => week.matchesWeeks(r.weeks, wk, r.week_rule));
}

/* ============================================================
 * 临时调课（session_shift）辅助
 * ============================================================ */

/**
 * 把「客户端给的定位条件」展开成真正要写的 (课次, 周次) 组合。
 * 三种定位方式可以混用，结果去重：
 *   ① sessionIds[] + week / weeks[]  → 点名某些课次
 *   ② dayOfWeek + week / weeks[]     → 按星期几展开该周真正上课的课次
 *   ③ dates[]                        → 每个日期自己换算成 (第几周, 星期几)
 * 只有「这一周真的会上这个课次」的组合才会被写进去（放假周 / 非该周次的课次自动跳过）。
 */
async function expandTargets(pool, cfg, payload) {
  const total = cfg.totalWeeks || 18;
  const classId = cfg.classId || 1;
  const [all] = await pool.query(
    'SELECT id, weeks, week_rule, day_of_week, period, group_scope FROM session WHERE class_id = ?', [classId]
  );
  const maxWeek = Math.max(total, 0);
  const pairs = new Map();   // 'sid#wk' → 目标
  const add = (s, wk) => {
    if (!(wk >= 1 && wk <= maxWeek)) return;
    if (!week.matchesWeeks(s.weeks, wk, s.week_rule)) return;
    pairs.set(s.id + '#' + wk, {
      sessionId: Number(s.id),
      week: Number(wk),
      dayOfWeek: Number(s.day_of_week),
      period: Number(s.period),
      groupScope: s.group_scope || null
    });
  };

  const wkList = [];
  const one = Number(payload.week);
  if (Number.isInteger(one) && one >= 1) wkList.push(one);
  (Array.isArray(payload.weeks) ? payload.weeks : []).forEach((v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 1 && n <= maxWeek) wkList.push(n);
  });
  const weeks = Array.from(new Set(wkList)).sort((a, b) => a - b);

  const ids = (Array.isArray(payload.sessionIds) ? payload.sessionIds : [])
    .map(Number).filter(Boolean);
  if (ids.length) {
    if (!weeks.length) throw new BizError(41001, '请选择要调整的周次');
    const idSet = new Set(ids);
    all.filter(s => idSet.has(Number(s.id))).forEach(s => weeks.forEach(wk => add(s, wk)));
  }

  const dow = Number(payload.dayOfWeek);
  if (dow >= 1 && dow <= 7) {
    if (!weeks.length) throw new BizError(41001, '请选择要调整的周次');
    all.filter(s => Number(s.day_of_week) === dow).forEach(s => weeks.forEach(wk => add(s, wk)));
  }

  (Array.isArray(payload.dates) ? payload.dates : []).forEach((raw) => {
    const d = week.dateStr(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const wk = week.getWeek(cfg.termStart, d);
    const dd = week.weekdayOf(d);
    all.filter(s => Number(s.day_of_week) === dd).forEach(s => add(s, wk));
  });

  return Array.from(pairs.values());
}

/** 某一周每个课次的最终落位（已套用临时调课）——用于查「目标格子撞车」 */
async function weekOccupants(pool, wk, shifts, classId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period, c.name
       FROM session s JOIN course c ON c.id = s.course_id
      WHERE s.class_id = ?`, [classId]
  );
  const out = [];
  rows.forEach((r) => {
    if (!week.matchesWeeks(r.weeks, wk, r.week_rule)) return;
    const slot = week.resolveSlot(r.id, r.day_of_week, r.period, wk, shifts);
    if (!slot) return;
    out.push({ sessionId: r.id, name: r.name, day: slot.day, period: slot.period });
  });
  return out;
}

/**
 * 删除值日行前，先按成员回滚轮转标记 `member.duty_count`。
 *
 * 为什么需要（v0.7.26）：轮转位置唯一来源是 `member.duty_count`，任何「删行但不回滚」
 * 的路径都会让它**单向漂移**（只增不减）。下面 syncDutyForShift 的两处删除（OFF 整节取消、
 * MOVE 撞上同日重复）原先都是裸删 —— 被删的人「明明没值日却被记成已排过」。
 * 2026-09-27 线上实锤：1 号因同类漂移在第 6 周被挤到队尾而整周消失。
 *
 * 口径与 `schedule.remove` / `schedule.clear` 完全一致：
 *   · 删一行 = -1；一个人被删多行就 -N；
 *   · `status = 'SWAPPED_OUT'` 的历史行不计（它在换出时已回滚过，见 schedule.reassign）。
 * 该不变量由 scripts/check-duty-marker-symmetry.js 守着（含变异自证）。
 *
 * ⚠️ 必须在 `DELETE FROM duty` **之前**调用（删完就查不到 member_id 了）。
 * TDSQL 一次只允许一条语句 → 逐人一条 UPDATE。
 */
async function rollbackDutyMarkers(conn, ids) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!list.length) return;
  const ph = list.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT member_id, COUNT(*) AS n FROM duty
      WHERE id IN (${ph}) AND status <> 'SWAPPED_OUT' GROUP BY member_id`,
    list
  );
  for (const r of rows) {
    await conn.query(
      'UPDATE member SET duty_count = GREATEST(duty_count - ?, 0) WHERE id = ?',
      [Number(r.n) || 0, Number(r.member_id)]
    );
  }
}

/**
 * 课次在某周被临时调整后，同步已有的值日。
 *   OFF  → 删掉未完成的值日（已完成 / 已请假的留作历史）
 *   MOVE → 日期跟着走，人不动。duty 表**不存节次**，展示用的节次由 week.resolveSlot
 *          在读取时解析，所以这里只需要把 class_date 改到新日期。
 *          如果撞上该成员当天已有的另一条值日（违反「同一天不重复」硬规则），
 *          就把跟着挪过来的那条删掉并计入 removed，交回超管用「手动排班」补人。
 */
async function syncDutyForShift(conn, cfg, sessionId, wk, kind, toDay, stats) {
  const [rows] = await conn.query(
    `SELECT id, member_id FROM duty WHERE session_id = ? AND week = ? AND status IN ('PENDING','ONGOING')`,
    [sessionId, wk]
  );
  if (!rows.length) return;
  const ids = rows.map(r => Number(r.id));
  const memIds = rows.map(r => Number(r.member_id));
  const phIds = ids.map(() => '?').join(',');
  const phMem = memIds.map(() => '?').join(',');

  if (kind === 'OFF') {
    await conn.query(`DELETE FROM duty_log WHERE duty_id IN (${phIds})`, ids);
    // v0.7.25：删除值日前先作废引用中的待确认申请 —— 否则申请悬空成幽灵，
    // 永远无法确认却一直计入「待确认」提醒（§73）
    await conn.query(
      `UPDATE swap_request SET status = 'CANCELLED'
        WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id IN (${phIds})`, ids
    );
    // 删行前先回滚轮转标记（见 rollbackDutyMarkers：删行不回滚 = 游标单向漂移）
    await rollbackDutyMarkers(conn, ids);
    await conn.query(`DELETE FROM duty WHERE id IN (${phIds})`, ids);
    stats.removed += ids.length;
    return;
  }

  const date = week.getDateOfWeekDay(cfg.termStart, wk, toDay);
  // 目标日期上已经存在的、属于这批人的其它值日 → 跟着挪过来就会同日重复
  const [dup] = await conn.query(
    `SELECT id FROM duty
      WHERE week = ? AND class_date = ? AND status <> 'SWAPPED_OUT'
        AND member_id IN (${phMem}) AND id NOT IN (${phIds})`,
    [wk, date].concat(memIds).concat(ids)
  );
  const dupIds = dup.map(r => Number(r.id));
  if (dupIds.length) {
    const phDup = dupIds.map(() => '?').join(',');
    await conn.query(`DELETE FROM duty_log WHERE duty_id IN (${phDup})`, dupIds);
    // v0.7.25：同上 —— 删值日前先作废引用中的待确认申请（§73）
    await conn.query(
      `UPDATE swap_request SET status = 'CANCELLED'
        WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id IN (${phDup})`, dupIds
    );
    // 删行前先回滚轮转标记（同 OFF 分支：跟着挪过来却撞上同日重复 → 这一轮名额要还回去）
    await rollbackDutyMarkers(conn, dupIds);
    await conn.query(`DELETE FROM duty WHERE id IN (${phDup})`, dupIds);
    stats.removed += dupIds.length;
  }
  const keepIds = ids.filter(id => dupIds.indexOf(id) < 0);
  if (keepIds.length) {
    const phKeep = keepIds.map(() => '?').join(',');
    await conn.query(`UPDATE duty SET class_date = ? WHERE id IN (${phKeep})`, [date].concat(keepIds));
    stats.moved += keepIds.length;
  }
}

/** 课表内容变了 → 这些周若已发布就退回草稿（否则班级看到「已发布」却是旧内容） */
async function toDraftWeeks(pool, weeks, classId) {
  let reset = false;
  for (const wk of weeks) {
    try {
      const [r] = await pool.query(
        `UPDATE schedule_publish SET status = 'DRAFT' WHERE class_id = ? AND week = ? AND status = 'PUBLISHED'`, [classId, wk]
      );
      if (r && r.affectedRows) reset = true;
    } catch (e) { /* 表未建：忽略 */ }
  }
  return reset;
}

/* ============================================================
 * 批量课程调课 / 新建课次（参考图 05、写入方式「新建课次后课表」）
 * ============================================================ */

/**
 * 「批次计划」归一化。
 * 前端 4 步向导允许「加入计划，再选一条」攒多条，最后一次性写入；
 * 这里把单条 / 多条统一成数组，并逐条校验必填项。
 * 每条：{ mode:'MOVE'|'OFF', sessionIds[], week|weeks[], dates[], toDay, toPeriod, note }
 */
function normalizePlan(payload) {
  const raw = Array.isArray(payload.items) ? payload.items : [payload];
  const out = [];
  raw.forEach((it, i) => {
    const mode = it && it.mode === 'OFF' ? 'OFF' : 'MOVE';
    const item = {
      mode,
      sessionIds: (Array.isArray(it && it.sessionIds) ? it.sessionIds : []).map(Number).filter(Boolean),
      week: Number(it && it.week),
      weeks: (Array.isArray(it && it.weeks) ? it.weeks : []).map(Number).filter(n => Number.isInteger(n) && n >= 1),
      dates: (Array.isArray(it && it.dates) ? it.dates : []).slice(0, 40),
      toDay: Number(it && it.toDay),
      toPeriod: Number(it && it.toPeriod),
      note: String((it && it.note) || '').slice(0, 64)
    };
    if (mode === 'MOVE') {
      // 🔴 与 shiftSet 同一口径（2026-10-08）：按 dates 定位 = 「整天挪到另一天，
      //   节次不变」，界面（index.wxml 的 shiftMode==='date' 分支）**不渲染**
      //   星期/节次选择器，只有两个日期选择器 ⇒ toPeriod 缺省是**正常输入**不是漏填。
      //   早先这里无条件要求 toPeriod∈[1,5]，于是 date +「新建课次后课表」也成了
      //   走不通的死路（报「第 N 条：缺目标节次（1-5）」）。
      //   缺省时由 appendSessionSlots 回退到**各课次自己的 s.period**
      //   （session.period 是必填语义列，不能写 NULL）。
      //   按 sessionIds / weeks 定位（界面都渲染了选择器）仍必须给全。
      const byDates = item.dates.length > 0;
      const hasToDay = it && it.toDay !== undefined && it.toDay !== null && it.toDay !== '';
      const hasToPeriod = it && it.toPeriod !== undefined && it.toPeriod !== null && it.toPeriod !== '';
      // 「传了就必须合法」
      if (hasToDay && !(item.toDay >= 1 && item.toDay <= 7)) {
        throw new BizError(41001, '第 ' + (i + 1) + ' 条：目标星期非法');
      }
      if (hasToPeriod && !(item.toPeriod >= 1 && item.toPeriod <= 5)) {
        throw new BizError(41001, '第 ' + (i + 1) + ' 条：目标节次非法（1-5）');
      }
      // 「按课次定位却没给星期/节次」= 用户漏填了选择器，当场拦
      if (!byDates) {
        if (!(item.toDay >= 1 && item.toDay <= 7)) throw new BizError(41001, '第 ' + (i + 1) + ' 条：缺目标星期');
        if (!(item.toPeriod >= 1 && item.toPeriod <= 5)) throw new BizError(41001, '第 ' + (i + 1) + ' 条：缺目标节次（1-5）');
      }
      // byDates 且 toPeriod 缺省 ⇒ 标记为「各自保留原节次」，交给写入侧回退
      if (byDates && !hasToPeriod) item.toPeriod = null;
    }
    if (!item.sessionIds.length && !item.dates.length) {
      throw new BizError(41001, '第 ' + (i + 1) + ' 条：没有选中要调整的课次');
    }
    out.push(item);
  });
  if (!out.length) throw new BizError(41001, '调课计划为空');
  return out;
}

/**
 * 「整门课永久挪位」：直接改 session 的 day_of_week / period，周次（weeks）完全保留。
 * 与 session_shift 的区别：这是**改课表本身**，对每一周都生效，不是「某一周的例外」。
 * 因此要同步所有周的已排值日（duty.class_date 跟着新星期重算）。
 * 返回受影响的周次集合。
 *
 * ⚠️ 下面按 session_id / duty.id 做的行级限定是安全的：
 *    session_id 全部来自上文 `WHERE s.class_id = ? AND s.id IN (...)` 的查询结果，
 *    天然只含本班课次（与既有 syncDutyForShift 同一范式，不是跨班漏过滤）。
 */
async function moveSessionSlots(conn, cfg, classId, sessionIds, toDay, toPeriod, stats) {
  const ph = sessionIds.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT id, day_of_week, period, weeks, week_rule FROM session
      WHERE class_id = ? AND id IN (${ph})`, [classId].concat(sessionIds)
  );
  const weeks = new Set();
  for (const s of rows) {
    // 先按旧星期算好该课次每周的值日日期，再改 session。
    // 与 syncDutyForShift 的 MOVE 分支**同一范式**：课次挪到新星期后，
    // 若这批人在「目标那一周」已另有别的值日，就会撞上「同一天不重复」硬规则。
    // 处理口径与 MOVE 一致：**删掉目标周上原有那条**，保留跟着课走这条
    // （课次是本次调课的主动方，它的人该跟过去），缺口交回超管用「手动排班」补。
    // 绝不能反过来删跟着挪的这条 —— 那会让值日留在已不在的星期上。
    const [duties] = await conn.query(
      `SELECT id, week, member_id, class_date FROM duty
        WHERE session_id = ? AND status IN ('PENDING','ONGOING')`, [s.id]
    );
    const memIds = duties.map(d => Number(d.member_id)).filter(Boolean);
    const phMem = memIds.map(() => '?').join(',');
    const dutyIds = duties.map(d => Number(d.id));
    const phDuty = dutyIds.map(() => '?').join(',');
    const [dups] = memIds.length
      ? await conn.query(
        `SELECT id, member_id FROM duty
          WHERE week IN (SELECT week FROM duty WHERE id IN (${phDuty}))
            AND status <> 'SWAPPED_OUT'
            AND member_id IN (${phMem}) AND id NOT IN (${phDuty})`,
        memIds.concat(dutyIds)
      )
      : [[]];
    const dupIds = dups.map(r => Number(r.id));
    if (dupIds.length) {
      const phDup = dupIds.map(() => '?').join(',');
      await conn.query(`DELETE FROM duty_log WHERE duty_id IN (${phDup})`, dupIds);
      await conn.query(
        `UPDATE swap_request SET status = 'CANCELLED'
          WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id IN (${phDup})`, dupIds
      );
      // 删行前先回滚轮转标记（与 OFF / MOVE-dup 同一范式）
      await rollbackDutyMarkers(conn, dupIds);
      await conn.query(`DELETE FROM duty WHERE id IN (${phDup})`, dupIds);
      stats.removed += dupIds.length;
    }
    for (const d of duties) {
      if (dupIds.indexOf(Number(d.id)) >= 0) continue;
      const nd = week.getDateOfWeekDay(cfg.termStart, Number(d.week), toDay);
      if (!nd || nd === String(d.class_date).slice(0, 10)) continue;
      const [r] = await conn.query(
        `UPDATE duty SET class_date = ? WHERE id = ?`, [nd, d.id]
      );
      if (r && r.affectedRows) stats.moved += 1;
    }
    await conn.query(
      `UPDATE session SET day_of_week = ?, period = ? WHERE class_id = ? AND id = ?`,
      [toDay, toPeriod, classId, s.id]
    );
    // 这门课现在覆盖的所有周次都要重算
    // 🔴 weeks 非空但全非法（如 '99' = 这批课次不上）⇒ 它不覆盖任何周次，
    //    不能回落成「按 week_rule 铺满整个学期」，否则会把一堆无关周次标成待重算。
    if (week.isWeeksBlank(s.weeks)) {
      for (let w = 1; w <= (cfg.totalWeeks || 18); w++) {
        if (week.matchesWeekRule(s.week_rule, w)) weeks.add(w);
      }
    } else {
      week.parseWeeks(s.weeks).forEach(w => weeks.add(w));
    }
  }
  return Array.from(weeks).sort((a, b) => a - b);
}

/**
 * 「新建课次后课表」：不动原 session 行，另 INSERT 一条只覆盖目标周次的新课次。
 * 新课次复用同一个 course_id / group_scope / duty_count，
 * weeks 写死成目标周次列表 ⇒ 原课表一行不动，随时可整批删掉回退。
 */
async function appendSessionSlots(conn, cfg, classId, targets, toDay, toPeriod, note, stats) {
  const ph = targets.map(() => '?').join(',');
  const [src] = await conn.query(
    `SELECT s.id, s.course_id, s.kind, s.week_rule, s.group_scope, s.duty_count, s.day_of_week, s.period
       FROM session s WHERE s.class_id = ? AND s.id IN (${ph})`,
    [classId].concat(targets.map(t => t.sessionId))
  );
  const byId = {};
  src.forEach(r => { byId[Number(r.id)] = r; });
  const created = [];
  // 落到**同一个目标格**的同一个 (course_id, group_scope, 周次) 只建一条新课次，
  // 避免课表上同一天同一节出现两门同名的课。
  // ⚠️ 但命中重复时**不能 continue** —— 同一门课一周上两次（两个不同节次）时，
  //    第二个原课次也在这批 targets 里，它的值日同样要搬到那条已建的新课次上。
  //    早先这里直接 continue，导致那批值日留在旧日期、旧课次上，变成孤儿。
  const madeKey = {};
  for (const t of targets) {
    const s = byId[t.sessionId];
    if (!s) continue;
    const key = [s.course_id, s.group_scope || '', t.week].join(':');
    let nid = madeKey[key];
    if (!nid) {
      // 🔴 toPeriod 为 null = 「各自保留原节次」（date 模式：整天挪走、节次不变）。
      //   session.period 是必填语义列，写 NULL 会让新课次在课表上读不出来，
      //   所以这里回退到**这个原课次自己的 s.period**——
      //   同一个 madeKey（同 course_id + 同 group_scope + 同周）只建一条，
      //   用首个撞上该 key 的课次的节次。
      const effPeriod = (toPeriod >= 1 && toPeriod <= 5) ? toPeriod : Number(s.period);
      const [r] = await conn.query(
        `INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count, note)
VALUES (?,?,?,'ALL',?,?,?,?,?,?)`,
        [classId, s.course_id, s.kind, String(t.week), toDay, effPeriod, s.group_scope, s.duty_count, note]
      );
      nid = Number(r.insertId);
      madeKey[key] = nid;
      created.push(nid);
      stats.created += 1;
    }
    // 原课次在这一周让位：写一条 OFF 例外（原行不删，但本周不再显示）
    await conn.query(
      `INSERT INTO session_shift (class_id, session_id, week, kind, note, created_by)
       VALUES (?,?,?,'OFF',?,?)
       ON DUPLICATE KEY UPDATE kind = 'OFF', note = VALUES(note)`,
      [classId, t.sessionId, t.week, note, t.createdBy || 0]
    );
    // 原课次该周的值日跟着搬到新课次上（人不变、日期改到新星期）。
    // ⚠️ 必须先查冲突：uq_duty(session_id, week, member_id) 唯一，
    //    目标新课次同一周若已有同一人的值日，直接 UPDATE 会撞 1062 把整个事务打断。
    //    撞上的那条删掉（值日跟着课走，课挪走了这周就不该还留在原地）并计入 removed。
    const [duties] = await conn.query(
      `SELECT id, member_id, week FROM duty
        WHERE session_id = ? AND week = ? AND status IN ('PENDING','ONGOING')`,
      [t.sessionId, t.week]
    );
    const memIds = duties.map(d => Number(d.member_id)).filter(Boolean);
    const phMem = memIds.map(() => '?').join(',');
    const dutyIds = duties.map(d => Number(d.id));
    const phDuty = dutyIds.map(() => '?').join(',');
    const [clash] = memIds.length
      ? await conn.query(
        `SELECT id FROM duty
          WHERE session_id = ? AND week = ? AND status <> 'SWAPPED_OUT'
            AND member_id IN (${phMem}) AND id NOT IN (${phDuty})`,
        [nid, t.week].concat(memIds).concat(dutyIds)
      )
      : [[]];
    const clashIds = clash.map(r => Number(r.id));
    if (clashIds.length) {
      const phClash = clashIds.map(() => '?').join(',');
      await conn.query(`DELETE FROM duty_log WHERE duty_id IN (${phClash})`, clashIds);
      await conn.query(
        `UPDATE swap_request SET status = 'CANCELLED'
          WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id IN (${phClash})`, clashIds
      );
      await rollbackDutyMarkers(conn, clashIds);
      await conn.query(`DELETE FROM duty WHERE id IN (${phClash})`, clashIds);
      stats.removed += clashIds.length;
    }
    for (const d of duties) {
      if (clashIds.indexOf(Number(d.id)) >= 0) continue;
      const nd = week.getDateOfWeekDay(cfg.termStart, t.week, toDay);
      await conn.query('UPDATE duty SET session_id = ?, class_date = ? WHERE id = ?', [nid, nd, d.id]);
      stats.moved += 1;
    }
  }
  return created;
}

const routes = {
  /** 返回本周实际课次（已按周规则展开，扣除法定放假 / 应用调课），含该课次已排值日名单 */
  listWeek: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk || wk < 1) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = await guard.resolveClassId(pool, ctx, payload);
      const cfg = await week.getConfig(pool, classId);
      const cal = await week.loadCalendar(pool);
      const shifts = await week.loadSessionShifts(pool);
      const rows = await loadWeekRows(pool, wk, classId);
      // 值日名单只用于展示：查询失败不应让整张课表打不开
      let duties = [];
      try {
        const [d] = await pool.query(
          `SELECT d.id, d.session_id, s.period AS period, d.class_date, d.status, d.member_id,
                  m.name AS memberName, m.group_tag, m.student_no AS memberNo
             FROM duty d JOIN member m ON m.id = d.member_id
                          JOIN session s ON s.id = d.session_id
            WHERE d.week = ? AND d.class_id = ? ORDER BY d.id`, [wk, classId]
        );
        duties = d;
      } catch (e) {
        console.error('[course] listWeek duties skipped', e && e.message);
      }
      const periods = week.periodMap(cfg);
      const bySession = {};
      duties.forEach(d => {
        (bySession[d.session_id] = bySession[d.session_id] || []).push({
          id: d.id,
          memberId: d.member_id,
          name: d.memberName,
          groupTag: d.group_tag,
          seq: week.seqOf(d.memberNo),
          status: week.effectiveStatus({ status: d.status, class_date: d.class_date, period: d.period || 0 }, periods),
          classDate: String(d.class_date).slice(0, 10)
        });
      });
      const list = [];
      rows.forEach(r => {
        // 临时调课优先：OFF → 本周这个课次不上（整条不出现在课表里）；
        // MOVE → 先换到调课后的「星期几 / 第几节」，再按星期几算日期。
        const slot = week.resolveSlot(r.sessionId, r.day_of_week, r.period, wk, shifts);
        if (!slot) return;
        const base = week.getDateOfWeekDay(cfg.termStart, wk, slot.day);
        const to = cal.shiftFrom[base];
        // 法定放假且没有调课记录 → 本周该次课不上
        if (!to && cal.off.has(base)) return;
        list.push({
          sessionId: r.sessionId,
          courseId: r.course_id,
          name: r.name,
          teacher: r.teacher || '',
          room: r.room || '',
          weekRule: r.week_rule,
          weeks: r.weeks || '',
          dayOfWeek: slot.day,
          period: slot.period,
          classDate: to || base,
          originalDate: week.getDateOfWeekDay(cfg.termStart, wk, r.day_of_week),
          shifted: slot.shifted || !!to,
          shiftKind: slot.shifted ? 'SESSION' : (to ? 'DAY' : ''),
          groupScope: r.group_scope,
          dutyCount: r.duty_count,
          note: r.note || '',
          duties: bySession[r.sessionId] || []
        });
      });
      // 本周校历（周一 ~ 周日）
      const monday = week.weekStart(cfg.termStart, wk);
      const sunday = week.getDateOfWeekDay(cfg.termStart, wk, 7);
      const inWeek = d => d >= monday && d <= sunday;
      // 本周生效的临时调课（客户端本地已有一份，这里用于跨设备对齐）
      const sessionShifts = [];
      rows.forEach(r => {
        const ov = shifts[week.shiftKey(r.sessionId, wk)];
        if (!ov) return;
        sessionShifts.push({
          sessionId: r.sessionId,
          name: r.name,
          dayOfWeek: Number(r.day_of_week),
          period: Number(r.period),
          kind: ov.kind,
          toDay: ov.toDay,
          toPeriod: ov.toPeriod,
          note: ov.note || ''
        });
      });
      return {
        list,
        weekStart: monday,
        holidays: cal.holidays.filter(h => inWeek(h.date)),
        shifts: cal.shifts.filter(s => inWeek(s.from) || inWeek(s.to)),
        sessionShifts
      };
    }
  },

  /**
   * 全班**全部**课次（不做周过滤）—— 把课表真源同步到小程序本地。
   *
   * 为什么需要（2026-10-07 用户实锤）：
   *   课表页过去只读 `miniprogram/data/timetable.js` 里那份 **2026-09-24 硬编码快照**，
   *   而 `session` 表（班委发布 / 青果导入）才是真源。后果有三条：
   *     ① 班委在 App 里改课表 / 导入课表，**页面要等本地缓存过期才变**；
   *     ② 「全体课表」显示 3号楼303、同步出来的课表显示一区212（同一门课两个来源打架）；
   *     ③ 首页「明日课次」把同一节课显示两遍（一条 A组、一条 全体）。
   *
   * 返回**与本地种子同构**的字段（day/period/group/weeks/cid…），
   * 前端写进 Storage 后 `data/timetable.js` 的日期 / 放假 / 调课解析逻辑**原样复用**，
   * 不用改渲染层 —— 这是风险最低的接真源方式。
   */
  allSessions: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const classId = await guard.resolveClassId(pool, ctx, payload);
      const [rows] = await pool.query(
        `SELECT s.id, s.course_id, c.name, c.teacher, c.room,
                s.day_of_week, s.period, s.group_scope, s.weeks, s.week_rule, s.note,
                s.duty_count
           FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ?
          ORDER BY s.day_of_week, s.period, s.id`, [classId]
      );
      return {
        list: rows.map(r => ({
          id: Number(r.id),
          cid: Number(r.course_id),
          name: r.name,
          teacher: r.teacher || '',
          room: r.room || '',
          day: Number(r.day_of_week),
          period: Number(r.period),
          group: r.group_scope || null,
          weeks: r.weeks || '',
          weekRule: r.week_rule || 'ALL',
          // 🔴 必须回传 duty_count：不排值日的课（duty_count=0）在端上曾被写死成 2
          //   （SQL 漏取该列 ⇒ 端上无从得知），点开课次会显示「2 人值日」（2026-10-14）。
          dutyCount: r.duty_count == null ? 2 : Number(r.duty_count),
          note: r.note || ''
        }))
      };
    }
  },

  /** 本周的调课清单（临时调课 + 按天调课），全班可读 */
  shiftList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const wk = Number(payload.week);
      if (!wk) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const cal = await week.loadCalendar(pool);
      const shifts = await week.loadSessionShifts(pool);
      const [rows] = await pool.query(
        `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period,
                s.group_scope, c.name, c.room, c.teacher
           FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ?
          ORDER BY s.day_of_week, s.period`, [classId]
      );
      const items = [];
      rows.forEach((r) => {
        const ov = shifts[week.shiftKey(r.id, wk)];
        if (!ov || !week.matchesWeeks(r.weeks, wk, r.week_rule)) return;
        // 展示用的实际日期：OFF → 空；MOVE → 调课后的那一天
        const day = ov.kind === 'OFF' ? null : (ov.toDay || Number(r.day_of_week));
        const date = day === null ? '' : week.classDateOf(cfg, wk, day, cal);
        items.push({
          sessionId: Number(r.id),
          name: r.name,
          room: r.room || '',
          teacher: r.teacher || '',
          dayOfWeek: Number(r.day_of_week),
          period: Number(r.period),
          groupScope: r.group_scope || null,
          kind: ov.kind,
          toDay: ov.toDay,
          toPeriod: ov.toPeriod,
          note: ov.note || '',
          date: date || ''
        });
      });
      return {
        week: wk,
        items,
        dayShifts: cal.shifts
      };
    }
  },

  /**
   * 临时调课：写入「某一周」的课次例外。原始课表一行不动，随时可撤销。
   * payload 里用 sessionIds / dayOfWeek / dates 三种方式之一（可混用）定位，
   * kind='OFF' 本周不上；kind='MOVE' 改到 toDay / toPeriod。
   * 同时把已排的值日跟着挪（或删掉），并让已发布的周退回草稿。
   */
  shiftSet: {
    auth: { needCommittee: true },
    handler: async (payload, ctx) => {
      const kind = payload.kind === 'MOVE' ? 'MOVE' : 'OFF';
      const note = String(payload.note || '').slice(0, 64);
      const toDay = kind === 'MOVE' ? Number(payload.toDay) : null;
      const toPeriod = kind === 'MOVE' ? Number(payload.toPeriod) : null;
      //🔴 「按日期定位」（dates 有值）= 「整天挪到另一天」，节次不变。
      //   这种调用**本就不带 toDay/toPeriod**：前端界面（index.wxml 的
      //   shiftMode==='date' 分支）根本不渲染星期 / 节次选择器，只有
      //   两个日期选择器。toDay 的真实值由前端从「调到这天」推出来一起传。
      //   早先这里对 kind='MOVE' 无条件要求 toDay∈[1,7] 且 toPeriod∈[1,5]，
      //   于是 date 模式必然 41001「请选择改到星期几」—— 一个用户走完整流程
      //   也必然失败的死路（2026-10-08 定位）。
      //   正确口径：**缺省即保留原值**，与全链路既有实现完全一致——
      //     · common/week.js resolveSlot:  day: ov.toDay || dayOfWeek
      //     · miniprogram/data/timetable.js resolveSlot: 同上
      //     · upsertSessShifts:  Number(it.toDay) || null
      //   所以这里只校验「传了就必须在合法区间」，不传就放行给 resolveSlot 回退。
      //   ⚠️ 但 sessionIds / weeks / dayOfWeek 定位（按课次挑）**仍必须给全**：
      //     那三种方式界面上都渲染了星期 + 节次选择器，缺了就是用户漏填，
      //     静默当「保留原值」会把人调了个寂寞。靠 byDates 区分这两类调用。
      const byDates = Array.isArray(payload.dates) && payload.dates.length > 0;
      if (kind === 'MOVE') {
        if (payload.toDay !== undefined && payload.toDay !== null && payload.toDay !== ''
          && !(toDay >= 1 && toDay <= 7)) {
          throw new BizError(41001, '请选择改到星期几');
        }
        if (payload.toPeriod !== undefined && payload.toPeriod !== null && payload.toPeriod !== ''
          && !(toPeriod >= 1 && toPeriod <= 5)) {
          throw new BizError(41001, '请选择改到第几节');
        }
        // 按课次定位却不给星期 / 节次 ⇒ 用户漏填了选择器，当场拦（别默默当保留原值）
        if (!byDates && !(toDay >= 1 && toDay <= 7)) throw new BizError(41001, '请选择改到星期几');
        if (!byDates && !(toPeriod >= 1 && toPeriod <= 5)) throw new BizError(41001, '请选择改到第几节');
      }
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const targets = await expandTargets(pool, cfg, payload);
      if (!targets.length) throw new BizError(41001, '没有找到符合条件的课次，请检查周次 / 课次');

      // 撞车预检：套用本次改动后，同一周同一个「星期 + 节次」是否挤了两门课
      const warnings = [];
      const pre = await week.loadSessionShifts(pool);
      const merged = Object.assign({}, pre);
      targets.forEach(t => {
        merged[week.shiftKey(t.sessionId, t.week)] = { kind, toDay, toPeriod, note };
      });
      const weeks = Array.from(new Set(targets.map(t => t.week))).sort((a, b) => a - b);
      for (const wk of weeks) {
        const occ = await weekOccupants(pool, wk, merged, cfg.classId || 1);
        const seen = {};
        occ.forEach(o => {
          const key = o.day + '-' + o.period;
          if (seen[key] && seen[key] !== o.name) {
            warnings.push('第 ' + wk + ' 周 周' + (DAY_TEXT[o.day - 1] || '?') + '第 ' + o.period
              + ' 节有《' + seen[key] + '》和《' + o.name + '》两门课');
          }
          seen[key] = o.name;
        });
      }

      const conn = await pool.getConnection();
      const stats = { moved: 0, removed: 0 };
      try {
        await conn.beginTransaction();
        for (const t of targets) {
          // 🔴 toDay / toPeriod 缺省 = 「保留原值」（见上方 byDates 说明）。
          //   写库必须写null 而不是原值，否则前端 resolveSlot 分不清
          //   「这周例外挪到 X」和「这周例外挪到原本自己的格子」——
          //   后者语义上等于没调，却会在课表上留下一条 shift 记录并挂上 note。
          //   值日那边则要**用最终落位的星期**重算 class_date：
          //   toDay 缺省时每个 target 保留自己的 t.dayOfWeek（不同课可能不同），
          //   若统一拿toDay=null 去算，getDateOfWeekDay 会拿到空日期，
          //   值日就会停在旧日期上变成孤儿（课已挪走、值日没跟）。
          const effDay = (toDay >= 1 && toDay <= 7) ? toDay : Number(t.dayOfWeek);
          await conn.query(
            `INSERT INTO session_shift (class_id, session_id, week, kind, to_day, to_period, note, created_by)
             VALUES (?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE kind = VALUES(kind), to_day = VALUES(to_day),
                                     to_period = VALUES(to_period), note = VALUES(note)`,
            [classId, t.sessionId, t.week, kind, toDay, toPeriod, note, ctx.member.id]
          );
          await syncDutyForShift(conn, cfg, t.sessionId, t.week, kind, effDay, stats);
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      const resetPublish = await toDraftWeeks(pool, weeks, classId);
      console.log(JSON.stringify({
        fn: 'course', action: 'shiftSet', member: ctx.member.id, classId, kind,
        count: targets.length, weeks, moved: stats.moved, removed: stats.removed
      }));
      return {
        written: targets.length,
        weeks,
        kind,
        moved: stats.moved,
        removed: stats.removed,
        warnings,
        resetPublish
      };
    }
  },

  /**
   * 撤销临时调课：把这些 (课次, 周次) 的例外清掉，课表恢复原样。
   * 撤销后还要把跟着挪走的值日 class_date 改回「课次原本那天的日期」，
   * 否则课表已经复原、值日却还留在被挪到的那一天上。
   */
  shiftRemove: {
    auth: { needCommittee: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const cal = await week.loadCalendar(pool);
      const ids = (Array.isArray(payload.sessionIds) ? payload.sessionIds : [])
        .map(Number).filter(Boolean);
      const weeks = Array.from(new Set(
        (Array.isArray(payload.weeks) ? payload.weeks : [Number(payload.week)])
          .map(Number).filter(n => Number.isInteger(n) && n >= 1)
      )).sort((a, b) => a - b);
      if (!weeks.length) throw new BizError(41001, '请选择要撤销的周次');
      const phWk = weeks.map(() => '?').join(',');

      // 先记下本周「真正被本次撤销影响」的课次，撤销后据此复位值日日期
      let touchedIds = ids.slice();
      if (!touchedIds.length) {
        const [rows] = await pool.query(
          `SELECT DISTINCT session_id FROM session_shift WHERE class_id = ? AND week IN (${phWk})`, [classId].concat(weeks)
        );
        touchedIds = rows.map(r => Number(r.session_id));
      }

      let deleted = 0;
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        const [r] = await pool.query(
          `DELETE FROM session_shift WHERE class_id = ? AND week IN (${phWk}) AND session_id IN (${ph})`,
          [classId].concat(weeks).concat(ids)
        );
        deleted += (r && r.affectedRows) || 0;
      } else {
        const [r] = await pool.query(
          `DELETE FROM session_shift WHERE class_id = ? AND week IN (${phWk})`, [classId].concat(weeks)
        );
        deleted += (r && r.affectedRows) || 0;
      }

      // 复位值日日期：课次原星期 → 该周的实际日期（仍会尊重「按天调课」）
      let restored = 0;
      if (touchedIds.length) {
        const phId = touchedIds.map(() => '?').join(',');
        const [sess] = await pool.query(
          `SELECT id, day_of_week FROM session WHERE class_id = ? AND id IN (${phId})`, [classId].concat(touchedIds)
        );
        for (const s of sess) {
          for (const wk of weeks) {
            const d = week.classDateOf(cfg, wk, s.day_of_week, cal) ||
              week.getDateOfWeekDay(cfg.termStart, wk, s.day_of_week);
            const [r] = await pool.query(
              `UPDATE duty SET class_date = ? WHERE session_id = ? AND week = ? AND class_id = ?
                 AND status IN ('PENDING','ONGOING') AND class_date <> ?`,
              [d, s.id, wk, classId, d]
            );
            restored += (r && r.affectedRows) || 0;
          }
        }
      }

      const resetPublish = await toDraftWeeks(pool, weeks, classId);
      console.log(JSON.stringify({
        fn: 'course', action: 'shiftRemove', member: ctx.member.id, classId, deleted, restored, weeks
      }));
      return { deleted, restored, weeks, resetPublish };
    }
  },

  /**
   * 批量课程调课（参考图 05）：把若干门课**永久**改到同一个星期 + 同一个节次，
   * 周次（weeks）完全保留 —— 即「改课程本身的时段」，不是按周的例外。
   * 与 shiftSet 的区别：shiftSet 写 session_shift（原始课表不动，某一周挪一下）；
   * 本 action 直接 UPDATE session.day_of_week / period（对每一周都生效）。
   * payload: { sessionIds:[], toDay, toPeriod, note }
   */
  sessionBatchMove: {
    auth: { needCommittee: true },
    handler: async (payload, ctx) => {
      const toDay = Number(payload.toDay);
      const toPeriod = Number(payload.toPeriod);
      if (!(toDay >= 1 && toDay <= 7)) throw new BizError(41001, '请选择改到星期几');
      if (!(toPeriod >= 1 && toPeriod <= 5)) throw new BizError(41001, '请选择改到第几节（1-5）');
      const ids = (Array.isArray(payload.sessionIds) ? payload.sessionIds : []).map(Number).filter(Boolean);
      if (!ids.length) throw new BizError(41001, '请选择要调整的课次');
      const note = String(payload.note || '').slice(0, 64);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);

      // 撞车预检：把要挪的课先从原位置拿走，看目标格子有没有别的课
      const ph = ids.map(() => '?').join(',');
      const [before] = await pool.query(
        `SELECT s.id, s.day_of_week, s.period, s.weeks, s.week_rule, s.group_scope, c.name
           FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ? AND s.id IN (${ph})`, [classId].concat(ids)
      );
      if (!before.length) throw new BizError(41001, '没有找到要调整的课次');
      const moveIds = before.map(r => Number(r.id));
      const warnings = [];
      const seen = {};
      before.forEach(r => { seen[r.day_of_week + '-' + r.period] = null; });
      const [others] = await pool.query(
        `SELECT s.day_of_week, s.period, c.name FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ? AND s.id NOT IN (${ph})`,
        [classId].concat(ids)
      );
      others.forEach(o => {
        const key = o.day_of_week + '-' + o.period;
        if (key in seen) seen[key] = o.name;
      });
      Object.keys(seen).forEach((k) => {
        if (seen[k]) {
          const p = k.split('-');
          warnings.push('改到 周' + (DAY_TEXT[Number(p[0]) - 1] || '?') + '第 ' + p[1]
            + ' 节会和《' + seen[k] + '》长期撞车');
        }
      });

      const conn = await pool.getConnection();
      const stats = { moved: 0, removed: 0, created: 0 };
      let weeks = [];
      try {
        await conn.beginTransaction();
        weeks = await moveSessionSlots(conn, cfg, classId, moveIds, toDay, toPeriod, stats);
        if (note) {
          const ph2 = moveIds.map(() => '?').join(',');
          await conn.query(
            `UPDATE session SET note = ? WHERE class_id = ? AND id IN (${ph2})`,
            [note, classId].concat(moveIds)
          );
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      const resetPublish = await toDraftWeeks(pool, weeks, classId);
      console.log(JSON.stringify({
        fn: 'course', action: 'sessionBatchMove', member: ctx.member.id, classId,
        count: moveIds.length, toDay, toPeriod, weeks: weeks.length, moved: stats.moved
      }));
      return { moved: moveIds.length, toDay, toPeriod, weeks, warnings, resetPublish };
    }
  },

  /**
   * 新建课次后课表（参考图写入方式②）：**保留原课表**，另存一份。
   * 原 session 行一行不动；另 INSERT 只覆盖目标周次的新课次（复用同一 course_id），
   * 并给原课次目标周写 OFF 例外让它那周让位；已排值日搬到新课次上。
   * payload: { items:[{ sessionIds[], week|weeks[], toDay, toPeriod, note }] | 单条 }
   * 返回 createdSessionIds，供「撤销新建课次」精确回退。
   */
  sessionAppend: {
    auth: { needCommittee: true },
    handler: async (payload, ctx) => {
      const plan = normalizePlan(payload);
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const conn = await pool.getConnection();
      const stats = { moved: 0, removed: 0, created: 0 };
      const createdSessionIds = [];
      const weeks = new Set();
      try {
        await conn.beginTransaction();
        for (const item of plan) {
          const targets = await expandTargets(pool, cfg, item);
          if (!targets.length) continue;
          targets.forEach(t => { t.createdBy = ctx.member.id; weeks.add(t.week); });
          const ids = await appendSessionSlots(
            conn, cfg, classId, targets, item.toDay, item.toPeriod, item.note, stats
          );
          ids.forEach(id => { if (createdSessionIds.indexOf(id) < 0) createdSessionIds.push(id); });
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      if (!createdSessionIds.length) {
        throw new BizError(41001, '没有找到符合条件的课次，请检查周次 / 课次');
      }
      const weekList = Array.from(weeks).sort((a, b) => a - b);
      const resetPublish = await toDraftWeeks(pool, weekList, classId);
      console.log(JSON.stringify({
        fn: 'course', action: 'sessionAppend', member: ctx.member.id, classId,
        created: createdSessionIds.length, weeks: weekList, moved: stats.moved
      }));
      return {
        created: createdSessionIds.length,
        createdSessionIds,
        weeks: weekList,
        moved: stats.moved,
        resetPublish
      };
    }
  },

  /**
   * 撤销「新建课次后课表」：删掉那批新建的 session 行，
   * 并把原课次目标周的 OFF 例外清掉、值日搬回原课次。
   * payload: { sessionIds: [新建的 session.id] }
   */
  sessionAppendRemove: {
    auth: { needCommittee: true },
    handler: async (payload, ctx) => {
      const ids = (Array.isArray(payload.sessionIds) ? payload.sessionIds : []).map(Number).filter(Boolean);
      if (!ids.length) throw new BizError(41001, '参数错误：缺少新建课次 id');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const ph = ids.map(() => '?').join(',');
      const [rows] = await pool.query(
        `SELECT id, course_id, group_scope, weeks, note FROM session
          WHERE class_id = ? AND id IN (${ph})`, [classId].concat(ids)
      );
      if (!rows.length) throw new BizError(41001, '没有找到这些新建课次');

      const conn = await pool.getConnection();
      const stats = { moved: 0, removed: 0, created: 0 };
      const weeks = new Set();
      try {
        await conn.beginTransaction();
        for (const r of rows) {
          const wks = week.parseWeeks(r.weeks);
          if (!wks.length) continue;   // weeks 为空=每周都上，不是一批课次建的 ⇒ 不认
          for (const wk of wks) {
            weeks.add(wk);
            // 值日搬回同 course_id + 同 group_scope 的原课次。
            // ⚠️ 必须取原课次**真实的 day_of_week** 来算 class_date ——
            //    早先这里硬写了 1（周一），会把搬回的值日全钉到周一。
            const [orig] = await conn.query(
              `SELECT id, day_of_week FROM session
                WHERE class_id = ? AND course_id = ? AND id <> ?
                  AND ((group_scope IS NULL AND ? IS NULL) OR group_scope = ?)
                ORDER BY id LIMIT 1`,
              [classId, r.course_id, r.id, r.group_scope, r.group_scope]
            );
            const [ds] = await conn.query(
              `SELECT id, week FROM duty WHERE session_id = ? AND status IN ('PENDING','ONGOING')`, [r.id]
            );
            if (orig.length) {
              const osid = Number(orig[0].id);
              const odow = Number(orig[0].day_of_week) || 1;
              // ⚠️ 搬回原课次也要先查冲突：uq_duty(session_id, week, member_id) 唯一，
              //    原课次该周若已有同一人的值日，直接 UPDATE 会撞 1062 把事务打断。
              //    撞上的删掉（这次是真的重复排了，人不该同一天值两次）。
              const memIds = ds.map(d => Number(d.member_id)).filter(Boolean);
              const phMem = memIds.map(() => '?').join(',');
              const dsIds = ds.map(d => Number(d.id));
              const phDs = dsIds.map(() => '?').join(',');
              const [clash] = memIds.length
                ? await conn.query(
                  `SELECT id FROM duty
                    WHERE session_id = ? AND week = ? AND status <> 'SWAPPED_OUT'
                      AND member_id IN (${phMem}) AND id NOT IN (${phDs})`,
                  [osid, wk].concat(memIds).concat(dsIds)
                )
                : [[]];
              const clashIds = clash.map(r => Number(r.id));
              if (clashIds.length) {
                const phClash = clashIds.map(() => '?').join(',');
                await conn.query(`DELETE FROM duty_log WHERE duty_id IN (${phClash})`, clashIds);
                await conn.query(
                  `UPDATE swap_request SET status = 'CANCELLED'
                    WHERE status IN ('PENDING_PEER','PENDING_ADMIN') AND duty_id IN (${phClash})`, clashIds
                );
                await rollbackDutyMarkers(conn, clashIds);
                await conn.query(`DELETE FROM duty WHERE id IN (${phClash})`, clashIds);
                stats.removed += clashIds.length;
              }
              for (const d of ds) {
                if (clashIds.indexOf(Number(d.id)) >= 0) continue;
                const nd = week.getDateOfWeekDay(cfg.termStart, Number(d.week), odow);
                await conn.query(
                  'UPDATE duty SET session_id = ?, class_date = ? WHERE id = ?',
                  [osid, nd || null, d.id]
                );
                stats.moved += 1;
              }
              await conn.query(
                `DELETE FROM session_shift WHERE class_id = ? AND session_id = ? AND week = ? AND kind = 'OFF'`,
                [classId, osid, wk]
              );
            } else {
              const dIds = ds.map(d => Number(d.id));
              if (dIds.length) {
                const phD = dIds.map(() => '?').join(',');
                await rollbackDutyMarkers(conn, dIds);
                await conn.query(`DELETE FROM duty WHERE id IN (${phD})`, dIds);
                stats.removed += dIds.length;
              }
            }
          }
        }
        const [r2] = await conn.query(
          `DELETE FROM session WHERE class_id = ? AND id IN (${ph})`, [classId].concat(ids)
        );
        await conn.commit();
        var deleted = (r2 && r2.affectedRows) || 0;
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      const weekList = Array.from(weeks).sort((a, b) => a - b);
      const resetPublish = await toDraftWeeks(pool, weekList, classId);
      console.log(JSON.stringify({
        fn: 'course', action: 'sessionAppendRemove', member: ctx.member.id, classId, deleted
      }));
      return { deleted, weeks: weekList, moved: stats.moved, removed: stats.removed, resetPublish };
    }
  },

  /** 校历：节假日 / 调休 / 调课（全班可读） */
  calendar: {
    auth: { needBind: true },
    handler: async () => {
      const cal = await week.loadCalendar(getPool());
      return { holidays: cal.holidays, shifts: cal.shifts };
    }
  },

  /** 新增/修改节假日（OFF=放假不上课，MAKEUP=调休上班） */
  saveHoliday: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const date = week.dateStr(payload.date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BizError(41001, '请选择日期');
      const name = String(payload.name || '').trim().slice(0, 32) || (payload.kind === 'MAKEUP' ? '调休上班' : '放假');
      const kind = payload.kind === 'MAKEUP' ? 'MAKEUP' : 'OFF';
      await getPool().query(
        `INSERT INTO holiday (holiday_date, name, kind, created_by) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), kind = VALUES(kind)`,
        [date, name, kind, ctx.member.id]
      );
      return { date, name, kind };
    }
  },

  /** 删除节假日 */
  removeHoliday: {
    auth: { needSuper: true },
    handler: async (payload) => {
      const date = week.dateStr(payload.date);
      if (!date) throw new BizError(41001, '参数错误');
      await getPool().query('DELETE FROM holiday WHERE holiday_date = ?', [date]);
      return {};
    }
  },

  /** 按天整体调课：把 from 这一天的课全部挪到 to 那天上 */
  saveShift: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const from = week.dateStr(payload.from);
      const to = week.dateStr(payload.to);
      if (!from || !to) throw new BizError(41001, '请选择调课日期');
      if (from === to) throw new BizError(41001, '调出与调入不能是同一天');
      const pool = getPool();
      const cfg = await week.getConfig(pool);
      const fw = week.getWeek(cfg.termStart, from);
      if (fw < 1 || fw > cfg.totalWeeks) throw new BizError(41001, '调出日期不在本学期内');
      const tw = week.getWeek(cfg.termStart, to);
      if (tw < 1 || tw > cfg.totalWeeks) throw new BizError(41001, '调入日期不在本学期内');
      /*
       * 防呆（v0.7.16，事故：day_shift 误录 10/6→9/20，第 4 周值日被生成到已过去的
       * 9/20，面板上出现一组「已结束」的幽灵值日）：
       * ① 调入日期不得已过去 —— 值日一生成就是「已结束」，谁看到都以为是 bug；
       *    真实的「假期课提前到调休上班日」只要发生在未来仍然允许（不校验先后方向）。
       * ② 跨周强提示 —— 值日按「调出日期所在周」入库（day_shift.week = 调出周），
       *    跨周时调入日的周面板看不到这批值日，必须前端弹确认、显式带 confirm=true 重发。
       */
      if (to < week.todayStr()) throw new BizError(41001, '调入日期已过去，不能把课调到过去的那天');
      if (fw !== tw && payload.confirm !== true) {
        return {
          needConfirm: true,
          fromWeek: fw,
          toWeek: tw,
          message: '调出日在第 ' + fw + ' 周、调入日在第 ' + tw + ' 周（跨周调课）。这批值日会记在调出周，请确认这样安排是对的'
        };
      }
      await pool.query(
        `INSERT INTO day_shift (week, from_date, to_date, note, created_by) VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE week = VALUES(week), to_date = VALUES(to_date), note = VALUES(note)`,
        [fw, from, to, String(payload.note || '').slice(0, 64), ctx.member.id]
      );
      return { week: fw };
    }
  },

  /** 取消某条调课（按 id 或 from 日期） */
  removeShift: {
    auth: { needSuper: true },
    handler: async (payload) => {
      const pool = getPool();
      const id = Number(payload.id);
      if (id) { await pool.query('DELETE FROM day_shift WHERE id = ?', [id]); return {}; }
      const from = week.dateStr(payload.from);
      if (!from) throw new BizError(41001, '参数错误');
      await pool.query('DELETE FROM day_shift WHERE from_date = ?', [from]);
      return {};
    }
  },

  /** 新增/编辑课次；冲突返回 50010（force=true 覆盖） */
  upsert: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const c = payload.course || {};
      const name = String(c.name || '').trim();
      const teacher = String(c.teacher || '').trim().slice(0, 32);
      const room = String(c.room || '').trim().slice(0, 32);
      const courseType = c.courseType === 'GROUP' ? 'GROUP' : 'ALL';
      const weekRule = ['ALL', 'ODD', 'EVEN'].includes(c.weekRule) ? c.weekRule : 'ALL';
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      // 上课周次：客户端传 weeks（周次数组），空数组表示每周都上
      const weeksRaw = Array.isArray(c.weeks) ? c.weeks : [];
      const weeksNums = weeksRaw
        .map(Number)
        .filter(n => Number.isInteger(n) && n >= 1 && n <= (cfg.totalWeeks || 18));
      const weeks = Array.from(new Set(weeksNums)).sort((a, b) => a - b);
      const weeksStr = weeks.join(',');
      const dayOfWeek = Number(c.dayOfWeek);
      const period = Number(c.period);
      // duty_count=0 = 不排值日（2026-10-14 书香校园口径）：0 是合法值。
      // 旧写法 Number(c.dutyCount) || 2 把 0 误当「未填」⇒ 钳出 2，且 max(...,1) 更不让 0 落地。
      const dcRaw = Number(c.dutyCount);
      const dutyCount = Math.min(Math.max(Number.isFinite(dcRaw) ? dcRaw : 2, 0), 4);
      const groupScope = courseType === 'GROUP' ? (c.groupScope === 'B' ? 'B' : 'A') : null;
      if (!name) throw new BizError(41001, '请填写课程名');
      // 允许周六 / 周日：调休（周末补课）要能把课次直接排在周末
      if (!(dayOfWeek >= 1 && dayOfWeek <= 7)) throw new BizError(41001, '请选择上课时间');
      // 大节数按**本班配置**（class.period_time）校验，不再写死 5：
      // 某些班要加「书香校园」这类 45 分钟短课，得能排到第 6 节（2026-10-14）。
      const nPeriods = week.periodCount(cfg);
      if (!(period >= 1 && period <= nPeriods)) throw new BizError(41001, '请选择节次（1-' + nPeriods + '）');

      const auditRes = await audit.msgSecCheck(ctx.openid, [name, teacher, room].filter(Boolean).join(' '));
      if (!auditRes.pass) throw new BizError(43001, '课程内容包含违规信息，请修改后重试');

      const currentWk = week.currentWeek(cfg);

      // 冲突检查：同学期同星期同节次的其他课次
      const [conflicts] = await pool.query(
        `SELECT s.id AS sessionId, c.name FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ? AND s.day_of_week = ? AND s.period = ? AND s.id != ? LIMIT 1`,
        [classId, dayOfWeek, period, Number(payload.sessionId) || 0]
      );
      if (conflicts.length && !payload.force) {
        throw new BizError(50010, '该时间已有《' + conflicts[0].name + '》', { conflictName: conflicts[0].name });
      }
      if (conflicts.length && payload.force && conflicts[0].sessionId) {
        // 覆盖：删除旧课次及其未开始的值日
        await pool.query(
          `DELETE d FROM duty d JOIN session s ON s.id = d.session_id
            WHERE s.id = ? AND d.status IN ('PENDING','ONGOING') AND d.class_date >= ?`,
          [conflicts[0].sessionId, week.todayStr()]
        );
        const [old] = await pool.query('SELECT course_id FROM session WHERE id = ?', [conflicts[0].sessionId]);
        try {
          await pool.query('DELETE FROM session_shift WHERE session_id = ?', [conflicts[0].sessionId]);
        } catch (e) { /* 表未建 */ }
        await pool.query('DELETE FROM session WHERE id = ?', [conflicts[0].sessionId]);
        if (old.length) {
          await pool.query('DELETE FROM course WHERE id = ? AND id NOT IN (SELECT course_id FROM session)', [old[0].course_id]);
        }
      }

      let sessionId = Number(payload.sessionId) || 0;
      if (sessionId) {
        const [ex] = await pool.query('SELECT course_id FROM session WHERE id = ? AND class_id = ?', [sessionId, classId]);
        if (!ex.length) throw new BizError(41001, '课次不存在');
        // ⚠️ room 碰撞修复：改教室/课名/教师不能动共享课程行（否则同课名其它课次的
        //   教室一起被改）。改用 repoint —— 把该课次改挂到 (name,teacher,room) 课程行，
        //   没有就新建；旧课程行若已无人引用则清理。
        await repointSessionRoom(pool, {
          classId, sessionId, name, teacher, newRoom: room,
          courseType, dutyCount, memberId: ctx.member.id
        });
        await pool.query(
          'UPDATE session SET week_rule=?, weeks=?, day_of_week=?, period=?, group_scope=?, duty_count=? WHERE id=?',
          [weekRule, weeksStr, dayOfWeek, period, groupScope, dutyCount, sessionId]
        );
      } else {
        const [r1] = await pool.query(
          'INSERT INTO course (class_id, name, teacher, room, course_type, duty_count, created_by) VALUES (?,?,?,?,?,?,?)',
          [classId, name, teacher, room, courseType, dutyCount, ctx.member.id]
        );
        const [r2] = await pool.query(
          'INSERT INTO session (class_id, course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES (?,?,?,?,?,?,?,?)',
          [classId, r1.insertId, weekRule, weeksStr, dayOfWeek, period, groupScope, dutyCount]
        );
        sessionId = r2.insertId;
      }
      console.log(JSON.stringify({ fn: 'course', action: 'upsert', member: ctx.member.id, sessionId, currentWk }));
      return { sessionId };
    }
  },

  /** 批量删除课次（连同未开始值日与孤立课程） */
  delete: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const ids = (payload.sessionIds || []).map(Number).filter(Boolean);
      if (!ids.length) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const cfg = await week.getConfig(pool, classId);
      const placeholders = ids.map(() => '?').join(',');
      await pool.query(
        `DELETE d FROM duty d JOIN session s ON s.id = d.session_id
          WHERE s.id IN (${placeholders}) AND s.class_id = ? AND d.status IN ('PENDING','ONGOING') AND d.class_date >= ?`,
        ids.concat([classId, week.todayStr()])
      );
      const [rows] = await pool.query(`SELECT course_id FROM session WHERE class_id = ? AND id IN (${placeholders})`, [classId].concat(ids));
      // 连带清掉这些课次的临时调课记录，避免留下孤儿行
      try { await pool.query(`DELETE FROM session_shift WHERE class_id = ? AND session_id IN (${placeholders})`, [classId].concat(ids)); } catch (e) { /* 表未建 */ }
      await pool.query(`DELETE FROM session WHERE class_id = ? AND id IN (${placeholders})`, [classId].concat(ids));
      for (const r of rows) {
        await pool.query('DELETE FROM course WHERE id = ? AND id NOT IN (SELECT course_id FROM session)', [r.course_id]);
      }
      return {};
    }
  },

  /** 复制上周课次（模板原样复制，跳过目标冲突格） */
  copyFrom: {
    auth: { needAdmin: true },
    handler: async (payload, ctx) => {
      const fromWeek = Number(payload.fromWeek);
      const toWeek = Number(payload.toWeek);
      if (!fromWeek || !toWeek) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const classId = guard.classIdOf(ctx);
      const src = await loadWeekRows(pool, fromWeek, classId);
      const dst = await loadWeekRows(pool, toWeek, classId);
      const occupied = new Set(dst.map(r => r.day_of_week + '-' + r.period));
      let copied = 0;
      for (const r of src) {
        if (occupied.has(r.day_of_week + '-' + r.period)) continue;
        const [r1] = await pool.query(
          'INSERT INTO course (class_id, name, teacher, room, course_type, duty_count, created_by) VALUES (?,?,?,?,?,?,?)',
          [classId, r.name, r.teacher, r.room, r.course_type || 'ALL', r.duty_count, ctx.member.id]
        );
        await pool.query(
          'INSERT INTO session (class_id, course_id, week_rule, weeks, day_of_week, period, group_scope, duty_count) VALUES (?,?,?,?,?,?,?,?)',
          [classId, r1.insertId, r.week_rule, r.weeks || '', r.day_of_week, r.period, r.group_scope, r.duty_count]
        );
        occupied.add(r.day_of_week + '-' + r.period);
        copied += 1;
      }
      return { copied };
    }
  },

  /**
   * 青果课表导入（需求 D-2 / 门禁 #57）：解析云存储里的 .xlsx，预览或事务全量覆盖本班课次。
   *   commit=false → 只解析校验，返回课程/课次统计与警告（不改库）；
   *   commit=true  → 事务内清空本班全部 COURSE 课次（保留 kind='CLEAN' 保洁），写回新课程与课次。
   * 班级隔离用 resolveClassId：超管可指定 classId，生活委员恒本班（needScheduleAuth 已先卡角色）。
   */
  importTimetable: {
    auth: { needScheduleAuth: true },
    handler: async (payload, ctx) => {
      // ⚠️ 分阶段计时（2026-10-05 真机「网络异常」排查专用，定位后请移除）。
      //    现象：客户端 `errCode -504005` "invoking task timed out after 20 seconds"，
      //    云端 `FUNCTIONS_TIME_LIMIT_EXCEEDED`、`Duration` 22~25s。
      //    已排除：解析（本地基准 10ms）、内存（MemUsage 20MB / 上限 512MB）、
      //            部署（Status=Active 且与本地 diff 一致）、基础库（3.17.3 已排除，见下）。
      //    ⇒ 高度怀疑是**串行数据库往返**：一次导入要跑
      //      getContext(1~3 次查询) → resolveClassId(1) → getConfig(1) → 写库(多次)，
      //      `common/db.js` 的 connectTimeout=8000，冷启动首连慢时 2~3 次就顶满 20s。
      //    每步都立刻打（不等结束）—— 函数被强杀时已打印的步仍能看到。
      const __t0 = Date.now();
      const __lap = (tag) => console.log(JSON.stringify({
        fn: 'course', action: 'importTimetable', lap: tag, ms: Date.now() - __t0
      }));
      __lap('enter');
      // ⚠️ 2026-10-05 23:2x 真因修复：**base64 直传优先**。
      //   云函数绑在 VPC 内，`cloud.downloadFile` 回云存储取文件**极慢**（20 秒打不完，
      //   客户端 errCode -504005 "invoking task timed out after 20 seconds"）。
      //   `pages/classes` 的名单导入早就踩过这个坑并绕过（那里注释写着
      //   「跳过云函数在 VPC 内回下载云存储那一步（极秒）」）；本功能当时没沿用。
      //   课表 .xlsx 一般几十 KB，base64 直传完全够；fileID 仅作大文件兜底。
      //   口径与 `member` 的头像上传一致：先 base64、退化到 fileId 下载。
      const b64 = String(payload.base64 || '').trim();
      const fileID = String(payload.fileID || '').trim();
      const commit = payload.commit === true;
      if (!b64 && !fileID) throw new BizError(41001, '请先选择课表文件');
      // 组别（2026-10-05）：青果的 A 组 / B 组是**两个独立文件**，文件内部没有任何组别标记，
      // 所以组别完全由导入者选择，且**必填 A 或 B** —— 前端不提供「全体课」选项。
      // 「全体课」不是手选的，而是**比对出来的**（见下方第 ④ 步）：
      // 两次导入后，若同一天/同一节/同一地点/同一门课在 A、B 两组都出现，就自动降为全体课。
      const rawGroup = String(payload.group == null ? '' : payload.group).trim().toUpperCase();
      if (rawGroup !== 'A' && rawGroup !== 'B') throw new BizError(41001, '请选择要导入的组别（A 或 B）');
      const groupScope = rawGroup;
      const pool = getPool();
      __lap('getPool');
      const classId = await guard.resolveClassId(pool, ctx, payload);
      __lap('resolveClassId');
      const cfg = await week.getConfig(pool, classId);
      const totalWeeks = Number(cfg.totalWeeks) || 16;
      __lap('getConfig');
      // 取文件内容：base64 直传（快）或 fileID 下载（VPC 内极慢，仅兜底）
      let fileContent = null;
      if (b64) {
        try {
          fileContent = Buffer.from(b64, 'base64');
        } catch (e) {
          throw new BizError(41002, '课表文件内容损坏，请重新选择文件');
        }
      } else {
        try {
          const dl = await cloud.downloadFile({ fileID });
          fileContent = dl.fileContent;
        } catch (e) {
          throw new BizError(41002, '课表文件下载失败，请改用「选择文件」重新上传（不要直接提交旧文件）');
        }
      }
      __lap('getFile:' + (fileContent ? fileContent.length : 0) + 'B');
      let parsed;
      try {
        parsed = parseTimetableXlsx(fileContent, totalWeeks);
      } catch (e) {
        throw new BizError(41002, '课表解析失败：' + (e && e.message ? e.message : '文件格式不正确'));
      }
      const { courses, sessions, warnings } = parsed;
      if (!sessions.length) throw new BizError(41002, '未从文件中解析到任何课次，请确认是青果导出的教学安排表');
      __lap('parseXlsx:' + sessions.length + 'sessions');

      // 预览：不改库，直接返回统计与明细供前端确认
      if (!commit) {
        __lap('previewDone');
        return {
          preview: true,
          classId,
          groupScope: groupScope,
          groupLabel: groupScope + ' 组',
          courseCount: courses.length,
          sessionCount: sessions.length,
          warnings,
          courses: courses.map(c => ({ name: c.name, teacher: c.teacher, room: c.room })),
          sessions: sessions.map(s => ({ name: s.name, dayOfWeek: s.dayOfWeek, period: s.period, weeks: s.weeks }))
        };
      }

      // 提交：事务内**只覆盖同组** COURSE 课次（分两次导入 A / B，自动合并成一整张课表）
      // ⚠️ 2026-10-10：写入逻辑已抽到 common/timetable-import.js，由网页后台共用。
      //    「A/B 重复自动降全体课」「删课次回滚 duty_count」这两条业务规则**只允许有一份定义处**。
      const conn = await pool.getConnection();
      let writeResult;
      try {
        await conn.beginTransaction();
        writeResult = await timetableImport.writeTimetable(
          conn,
          { classId, groupScope, courses, sessions, warnings },
          { memberId: ctx.member.id }
        );
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      const importWarnings = writeResult.warnings;
      // 已发布周退回草稿（课表内容变了）
      const resetPublish = await timetableImport.toDraftWeeks(pool, Array.from({ length: totalWeeks }, (_, i) => i + 1), classId);
      __lap('commitDone');
      console.log(JSON.stringify({
        fn: 'course', action: 'importTimetable', member: ctx.member.id, classId,
        courses: writeResult.courses, sessions: writeResult.imported, commit: true
      }));
      return {
        imported: writeResult.imported,
        courses: writeResult.courses,
        warnings: importWarnings,
        resetPublish
      };
    }
  },

  /**
   * 成员申请适配课表（需求 D-2 / 门禁 #59）：上传 .xlsx 后建 PENDING 申请，超管后续适配。
   * 班级与成员都锁本人（普通成员恒本班，忽略传入 classId）。同班已有 PENDING 则拦截重复。
   * 文件名固定【class.name】-教学安排表。解析失败直接打回，让成员重传正确文件。
   */
  applyTimetable: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      // ⚠️ 2026-10-05：与 importTimetable 同口径 —— **base64 直传优先**。
      //   云函数在 VPC 内回下载云存储极慢（20s 打不完 ⇒ 客户端 -504005）。
      //   申请要留给超管后续适配，所以**把 base64 存进 DB**（MEDIUMTEXT），
      //   整条链路（成员提交 → 超管适配）都不再经过云存储下载。
      const b64 = String(payload.base64 || '').trim();
      const fileID = String(payload.fileID || '').trim();
      if (!b64 && !fileID) throw new BizError(41001, '请先选择课表文件');
      // 组别（2026-10-05）：与 importTimetable 同口径 —— **必填 A / B**
      // 「全体课」不是手选项，是两次导入后按「同时间+同地点+同课」自动判出来的。
      const rawGroup = String(payload.group == null ? '' : payload.group).trim().toUpperCase();
      if (rawGroup !== 'A' && rawGroup !== 'B') throw new BizError(41001, '请选择课表组别（A 或 B）');
      const groupScope = rawGroup;
      const pool = getPool();
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      // 同班同组重复 PENDING 拦截（A 组和 B 组是两份独立申请，各判各的）
      const [dup] = await pool.query(
        'SELECT id FROM timetable_apply WHERE class_id = ? AND status = ? AND group_scope = ? LIMIT 1',
        [classId, 'PENDING', groupScope]
      );
      if (dup.length) throw new BizError(41010, '本班该组已有待处理的适配申请，请等待超管处理');
      // 解析（即时校验文件可用性，避免把坏文件丢给超管）
      let fileContent = null;
      if (b64) {
        try { fileContent = Buffer.from(b64, 'base64'); }
        catch (e) { throw new BizError(41002, '课表文件内容损坏，请重新选择文件'); }
      } else {
        try { const dl = await cloud.downloadFile({ fileID }); fileContent = dl.fileContent; }
        catch (e) { throw new BizError(41002, '文件下载失败，请改用「选择文件」重新上传'); }
      }
      let parsed;
      try { parsed = parseTimetableXlsx(fileContent, 16); }
      catch (e) { throw new BizError(41002, '课表解析失败：' + (e && e.message ? e.message : '请确认是青果导出的 .xlsx')); }
      if (!parsed.sessions.length) throw new BizError(41002, '未从文件中解析到任何课次，请确认是青果导出的教学安排表');
      // 班级名（用于文件名）
      const [cls] = await pool.query('SELECT name FROM `class` WHERE id = ? LIMIT 1', [classId]);
      const className = cls.length ? cls[0].name : ('class' + classId);
      // ⚠️ 文件名带组别后缀（2026-10-05）：A/B 组是两个独立文件，同名的话
      //    超管在列表里分不清哪份是哪组。
      //    门禁 #59 只锁「'【' + className + '】-教学安排表'」这个前缀仍在，格式未被破坏。
      const fileName = '【' + className + '】-教学安排表-' + groupScope + '组';
      const summary = JSON.stringify({
        courseCount: parsed.courses.length,
        sessionCount: parsed.sessions.length,
        groupScope: groupScope,
        warnings: parsed.warnings
      });
      const [r] = await pool.query(
        'INSERT INTO timetable_apply (class_id, member_id, file_id, file_b64, file_name, group_scope, status, summary) VALUES (?,?,?,?,?,?,?,?)',
        // ⚠️ file_id 存 'b64:' 前缀占位：该列是 NOT NULL，但真数据在 file_b64 里
        //    （云函数在 VPC 内下载云存储极慢，改直传存库）。留 file_id 是为了兼容旧数据/查看原文件。
        [classId, member.id, fileID || ('b64:' + Date.now()), b64 || null, fileName, groupScope, 'PENDING', summary]
      );
      console.log(JSON.stringify({
        fn: 'course', action: 'applyTimetable', member: member.id, classId, applyId: r.insertId, fileName,
        groupScope: groupScope
      }));
      return { applyId: r.insertId, file_name: fileName, groupScope: groupScope, status: 'PENDING', summary: parsed };
    }
  },

  /**
   * 🔍 自诊断（2026-10-05 排查「网络异常 / -504005」临时加的，定位后请删）。
   * 真因定位靠它：`fn log` 拉不到（环境未开通 CLS），所以**把耗时直接算好返回给前端**。
   *
   * ⚠️ 已知结论（2026-10-05 23:09 实测）：**数据库不是瓶颈** ——
   *   start 0ms / getPool 0ms / queryMember 4ms / queryClass 2ms / query3x 7ms
   *   ⇒ 一次导入要走的 4~6 次库往返总共十几毫秒，`connectTimeout` 从 8s 降到 3s 毫无必要。
   *   剩下唯一没量到的一步就是 **`cloud.downloadFile`（从云存储拉文件）** ⇒ 本 action 新增了
   *   ① 用**当前时间戳当 fileID**（必然失败，但能测出「失败要多久」）② 真传 fileID 时测下载+解析。
   *   ⚠️ 若「下载失败耗时」接近 20s，就是它 —— 说明云函数连云存储的通道有问题（网络/权限），
   *      而**不是**代码逻辑慢。
   */
  /* ================================================================
   * 个人课表（2026-10-06）
   * ------------------------------------------------------------
   * 需求：所有人可自行编辑**自己**的课表（仅自己可见）；班长/副班长可
   * 「发布到全班」覆盖 session（= 全班课表）。班委自己那份发布后，全班人看
   * 到的是同一份；别人的个人课表互不可见。
   *
   * 为什么独立成 member_timetable 表、而不是在 session 上加 owner 字段：
   * session 是**全班课表**，被课表页、值日生成（generate/buildCleaningPlan/
   * cron-weekly）、课次跨班隔离门禁(course.listWeek) 等一大圈逻辑依赖；给它
   * 加「个人行」会让这些查询混进只属于某个人的课次（跨班隔离门禁 #51 也会
   * 被动破裂），且个人课次没有值日语义。独立表是「只增新查询、不动老查询」，
   * 风险最低。
   *
   * 数据边界（权限）：
   *   · my* 一律用 guard.classIdOf(ctx) + ctx.member.id —— **不采信 payload 里的
   *     memberId/classId**，否则可改他人课表（越权）。
   *   · publish 一律 requireTimetablePublish（超管/班长/副班长）+ classIdOf。
   * ================================================================ */

  /** 读我的个人课表（按 周次 → 星期 → 节次 排序；前端直接渲染网格） */
  myList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, name, teacher, room, day_of_week, period, weeks, week_rule, kind, updated_at
           FROM member_timetable
          WHERE class_id = ? AND member_id = ?
          ORDER BY day_of_week, period, id`,
        [classId, member.id]
      );
      return {
        list: rows.map(r => ({
          id: Number(r.id),
          name: r.name,
          teacher: r.teacher || '',
          room: r.room || '',
          dayOfWeek: Number(r.day_of_week),
          period: Number(r.period),
          weeks: r.weeks || '',
          weekRule: r.week_rule || 'ALL',
          kind: r.kind || 'COURSE',
          updatedAt: r.updated_at
        }))
      };
    }
  },

  /**
   * 新增/更新一条**我的**课次。
   * payload.item = { id?, name, teacher, room, dayOfWeek, period, weeks, weekRule }
   * 带 id = 更新（且必须属于本人，否则 41001），不带 = 新增。
   */
  mySave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, classId);
      const it = payload.item || {};
      const name = String(it.name || '').trim();
      const teacher = String(it.teacher || '').trim().slice(0, 32);
      const room = String(it.room || '').trim().slice(0, 32);
      const dayOfWeek = Number(it.dayOfWeek);
      const period = Number(it.period);
      if (!name) throw new BizError(41001, '请填写课程名');
      if (!(dayOfWeek >= 1 && dayOfWeek <= 7)) throw new BizError(41001, '请选择星期（周一~周日）');
      // 大节数按本班配置校验（与 upsert 同口径，见上方 upsert 里的 nPeriods）
      const nPeriods2 = week.periodCount(cfg);
      if (!(period >= 1 && period <= nPeriods2)) throw new BizError(41001, '请选择节次（1-' + nPeriods2 + '）');
      const weekRule = ['ALL', 'ODD', 'EVEN'].includes(it.weekRule) ? it.weekRule : 'ALL';
      // 周次：数组 → 去重升序 → CSV（与 session.weeks 同口径）；空 = 每周
      const weeks = Array.isArray(it.weeks)
        ? Array.from(new Set(it.weeks.map(Number)
          .filter(n => Number.isInteger(n) && n >= 1 && n <= (cfg.totalWeeks || 18))))
          .sort((a, b) => a - b)
        : [];
      const weeksStr = weeks.join(',');
      const kind = it.kind === 'CLEAN' ? 'CLEAN' : 'COURSE';

      const secRes = await audit.msgSecCheck(ctx.openid, [name, teacher, room].filter(Boolean).join(' '));
      if (!secRes.pass) throw new BizError(43001, '课程内容包含违规信息，请修改后重试');

      const id = Number(it.id) || 0;
      if (id) {
        // 更新必须命中「本人行」：用 member_id 兜住，绝不按 id 裸改
        const [r] = await pool.query(
          `UPDATE member_timetable SET name=?, teacher=?, room=?, day_of_week=?, period=?,
             weeks=?, week_rule=?, kind=?, updated_at=NOW()
           WHERE id=? AND member_id=? AND class_id=?`,
          [name, teacher, room, dayOfWeek, period, weeksStr, weekRule, kind, id, member.id, classId]
        );
        if (!r || !r.affectedRows) throw new BizError(41001, '课次不存在或不属于你');
        return { id: id, updated: true };
      }
      const [r] = await pool.query(
        `INSERT INTO member_timetable (class_id, member_id, name, teacher, room, day_of_week, period, weeks, week_rule, kind)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [classId, member.id, name, teacher, room, dayOfWeek, period, weeksStr, weekRule, kind]
      );
      return { id: Number(r.insertId), updated: false };
    }
  },

  /** 删除**我的**一条课次（同款「必须属于本人」守卫） */
  myDelete: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const id = Number(payload.id) || 0;
      if (!id) throw new BizError(41001, '参数错误');
      const [r] = await getPool().query(
        'DELETE FROM member_timetable WHERE id = ? AND member_id = ? AND class_id = ?',
        [id, member.id, classId]
      );
      if (!r || !r.affectedRows) throw new BizError(41001, '课次不存在或不属于你');
      return { deleted: true };
    }
  },

  /**
   * 清空「我的课表」（2026-10-06）：删本人 member_timetable 全部行。
   *
   * 人人可用（只清自己的），不需要班委权限；DELETE 带 member_id 锁，绝不会清到别人。
   * 个人课表不驱动值日，所以不必回滚 duty 标记（那是 session 表的职责，syncFromClass 单向同步也不会反向影响）。
   */
  myClear: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const [r] = await getPool().query(
        'DELETE FROM member_timetable WHERE class_id = ? AND member_id = ?',
        [classId, member.id]
      );
      return { cleared: Number(r.affectedRows) || 0 };
    }
  },

  /* ================================================================
   * 个人选修课（2026-10-15）
   * ------------------------------------------------------------
   * 需求：课表页右下角加课按钮对**所有人**可见，但每人最多添加 2 门选修课；
   * 添加的课**仅自己可见、仅自己可编辑**（每个人的选修课时间都不一样）。
   *
   * 为什么独立成 personal_course 表、而不是塞进 member_timetable / session：
   *   · session 是全班课表，被课表页、值日生成、跨班隔离门禁等一大圈逻辑依赖；
   *   · member_timetable 是「可发布到全班」的完整个人课表（kind=COURSE/CLEAN），
   *     publishToClass 会按 kind='COURSE' 覆盖全班 session —— 若把选修课混进去，
   *     发布流程会把 2 门选修课当全班课表发出去、清空全班课表。
   *   独立表 + 独立 action，**所有查询都带 member_id = 当前登录人**，绝不采信
   *   payload 里的 memberId/classId（否则可改他人选修课，越权）。
   * ================================================================ */

  /** 读「我」的选修课（服务端按 member_id 锁，天然仅本人可见） */
  electiveList: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT id, name, teacher, room, day_of_week, period, weeks, week_rule, created_at
           FROM personal_course
          WHERE class_id = ? AND member_id = ?
          ORDER BY day_of_week, period, id`,
        [classId, member.id]
      );
      return {
        list: rows.map(r => ({
          id: Number(r.id),
          name: r.name,
          teacher: r.teacher || '',
          room: r.room || '',
          dayOfWeek: Number(r.day_of_week),
          period: Number(r.period),
          weeks: r.weeks || '',
          weekRule: r.week_rule || 'ALL'
        }))
      };
    }
  },

  /**
   * 新增 / 更新「我」的一门选修课。
   * payload.item = { id?, name, teacher, room, dayOfWeek, period, weeks, weekRule }
   * 带 id = 更新（且必须属于本人，否则 41001）；不带 = 新增（每人最多 2 门，服务端强制）。
   * 与 member_timetable / session 完全隔离（独立表），不驱动值日、不影响全班课表。
   */
  electiveSave: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, classId);
      const it = payload.item || {};
      const name = String(it.name || '').trim();
      const teacher = String(it.teacher || '').trim().slice(0, 32);
      const room = String(it.room || '').trim().slice(0, 32);
      const dayOfWeek = Number(it.dayOfWeek);
      const period = Number(it.period);
      if (!name) throw new BizError(41001, '请填写课程名');
      if (!(dayOfWeek >= 1 && dayOfWeek <= 7)) throw new BizError(41001, '请选择星期（周一~周日）');
      const nPeriods = week.periodCount(cfg);
      if (!(period >= 1 && period <= nPeriods)) throw new BizError(41001, '请选择节次（1-' + nPeriods + '）');
      const weekRule = ['ALL', 'ODD', 'EVEN'].includes(it.weekRule) ? it.weekRule : 'ALL';
      const weeks = Array.isArray(it.weeks)
        ? Array.from(new Set(it.weeks.map(Number)
          .filter(n => Number.isInteger(n) && n >= 1 && n <= (cfg.totalWeeks || 18))))
          .sort((a, b) => a - b)
        : [];
      const weeksStr = weeks.join(',');
      const secRes = await audit.msgSecCheck(ctx.openid, [name, teacher, room].filter(Boolean).join(' '));
      if (!secRes.pass) throw new BizError(43001, '课程内容包含违规信息，请修改后重试');

      const id = Number(it.id) || 0;
      if (id) {
        // 更新必须命中「本人行」：用 member_id 兜住，绝不按 id 裸改
        const [r] = await pool.query(
          `UPDATE personal_course SET name=?, teacher=?, room=?, day_of_week=?, period=?,
             weeks=?, week_rule=?, updated_at=NOW()
           WHERE id=? AND member_id=? AND class_id=?`,
          [name, teacher, room, dayOfWeek, period, weeksStr, weekRule, id, member.id, classId]
        );
        if (!r || !r.affectedRows) throw new BizError(41001, '选修课不存在或不属于你');
        return { id: id, updated: true };
      }
      // 新增：每人最多 2 门（服务端强制，前端仅做友好提示）
      const [cnt] = await pool.query(
        'SELECT COUNT(*) AS n FROM personal_course WHERE class_id = ? AND member_id = ?',
        [classId, member.id]
      );
      if (Number(cnt[0].n) >= 2) throw new BizError(41001, '每人最多添加 2 门选修课');
      const [r] = await pool.query(
        `INSERT INTO personal_course (class_id, member_id, name, teacher, room, day_of_week, period, weeks, week_rule)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [classId, member.id, name, teacher, room, dayOfWeek, period, weeksStr, weekRule]
      );
      return { id: Number(r.insertId), updated: false };
    }
  },

  /** 删除「我」的一门选修课（同款「必须属于本人」守卫） */
  electiveDelete: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const id = Number(payload.id) || 0;
      if (!id) throw new BizError(41001, '参数错误');
      const [r] = await getPool().query(
        'DELETE FROM personal_course WHERE id = ? AND member_id = ? AND class_id = ?',
        [id, member.id, classId]
      );
      if (!r || !r.affectedRows) throw new BizError(41001, '选修课不存在或不属于你');
      return { deleted: true };
    }
  },

  /**
   * 选文件导入 → **我的**个人课表（覆盖式：先清空我的，再写入解析结果）。
   *
   * 与 importTimetable 的差别只有两点：① 写 member_timetable（个人）而不是
   * course+session（全班）；② 不需要班委权限 —— 谁都能导自己的。
   * 解析器复用 import-parse（青果 .xlsx），**不重复实现**。
   *
   * ⚠️ commit=true 才落库（默认只预览，弹层展示「将导入 N 条」给用户确认）。
   * ⚠️ base64 直传：云函数在 VPC 内回下载云存储极慢（20s 超时）——前端一律
   *    getFileSystemManager().readFile({encoding:'base64'})，这里只收 base64。
   */
  myImport: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      const cfg = await week.getConfig(pool, classId);
      const b64 = String(payload.base64 || '');
      if (!b64) throw new BizError(41001, '未收到文件内容，请重新选择');
      let parsed;
      try {
        parsed = parseTimetableXlsx(Buffer.from(b64, 'base64'), cfg.totalWeeks || 16);
      } catch (e) {
        throw new BizError(41002, '课表解析失败：' + ((e && e.message) || '请确认是青果导出的 .xlsx'));
      }
      if (!parsed.sessions.length) throw new BizError(41002, '未从文件中解析到任何课次，请确认是青果导出的教学安排表');
      // 只保留 COURSE（个人课表不承载保洁值日；保洁由超管在课表页维护）
      const mine = parsed.sessions.filter(s => (s.kind || 'COURSE') === 'COURSE');
      if (!mine.length) throw new BizError(41002, '文件中没有课程课次（仅保洁行不会导入）');
      const preview = mine.slice(0, 200).map(s => ({
        name: s.name, teacher: s.teacher || '', room: s.room || '',
        dayOfWeek: Number(s.dayOfWeek), period: Number(s.period), weeks: s.weeks || ''
      }));
      if (!payload.commit) {
        return { preview: preview, total: mine.length, warnings: parsed.warnings || [] };
      }
      // 覆盖式：先清空我的，再批量写（多行 INSERT 一次，避开 TDSQL 一次一条）
      await pool.query('DELETE FROM member_timetable WHERE class_id = ? AND member_id = ?', [classId, member.id]);
      const VALUES = mine.map(s => '(' + [
        classId, member.id,
        "'" + String(s.name).replace(/'/g, "''") + "'",
        "'" + String(s.teacher || '').replace(/'/g, "''") + "'",
        "'" + String(s.room || '').replace(/'/g, "''") + "'",
        Number(s.dayOfWeek), Number(s.period),
        "'" + String(s.weeks || '').replace(/'/g, "''") + "'",
        "'" + (s.weekRule || 'ALL') + "'",
        "'COURSE'"
      ].join(',') + ')').join(',');
      await pool.query(
        'INSERT INTO member_timetable (class_id, member_id, name, teacher, room, day_of_week, period, weeks, week_rule, kind) VALUES ' + VALUES
      );
      console.log(JSON.stringify({
        fn: 'course', action: 'myImport', member: member.id, classId, imported: mine.length
      }));
      return { imported: mine.length, warnings: parsed.warnings || [] };
    }
  },

  /**
   * 【一键同步】把**本班课表**拷成我的个人课表（覆盖式：先清空我的，再写）。
   *
   * 用途：班委导入完全班课表后，普通同学一键拿到基底，再在此基础上改自己的
   * （A/B 组分班、个人周次不同 → 同一个班课表当起点最省事）。
   *
   * ⚠️ 按同步者所在组过滤（2026-10-06 真机反馈）：A 组同学只拿「全体课 + A 组课」，
   *    B 组只拿「全体课 + B 组课」。A/B 是两个独立课次，全量拷会把同一 (星期,节次)
   *    格里的 A、B 两门课都塞进个人课表 ⇒ 课表页一格叠两门、文字重叠。
   *    group_tag 不是 A/B（教职工/测试账号 group_tag='X'）⇒ 只拿全体课。
   * ⚠️ 写入前按（课名+星期+节次+周次+规则）去重：session 表里同一门课同一格可能有
   *    「NULL 全体课 + 组课」两行完全相同的记录（青果导入同名未复用遗留），不去重
   *    会在个人课表里同格叠两门。
   * ⚠️ 只拷 **COURSE**（保洁值日课次是班级公共事务，不进个人课表）。
   * ⚠️ 覆盖式 = 会清掉我已有的个人课次，**必须前端二次确认**（弹「将覆盖你现在的 N 节」）。
   * ⚠️ 与 publishToClass 的方向相反：那个是「个人 → 全班」（需班委权），
   *    这个是「全班 → 个人」（人人可用），两条链路别搞混。
   */
  syncFromClass: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);
      const pool = getPool();
      // 我的组：group_tag ∈ {A, B} 才参与分组过滤；其它（'X' 教职工 / 空）只看全体课
      const myGroup = (member.group_tag === 'A' || member.group_tag === 'B') ? member.group_tag : '';
      // 组过滤条件：全体课(group_scope IS NULL) + 本组课(group_scope = 我的组)
      const grpCond = myGroup ? '(s.group_scope IS NULL OR s.group_scope = ?)' : 's.group_scope IS NULL';
      const grpArgs = myGroup ? [classId, myGroup] : [classId];
      // 一次取全，去重后既供预览计数、也供正式写入（COUNT(*) 数不出 JS 去重）
      const [rows] = await pool.query(
        `SELECT c.name, c.teacher, c.room, s.day_of_week, s.period, s.weeks, s.week_rule
           FROM session s JOIN course c ON c.id = s.course_id
          WHERE s.class_id = ? AND s.kind = 'COURSE' AND ${grpCond}
          ORDER BY s.day_of_week, s.period, s.id`,
        grpArgs
      );
      // 去重（2026-10-06 真机反馈）：session 表里同一门课同一格可能有两行——
      // 青果导入「同名课程未复用」遗留：一行 group_scope=NULL(全体课) + 一行 =组课，
      // 内容（周次/教室/教师）完全相同 ⇒ 个人课表同一格叠两门、文字重叠。
      // 按（课名|星期|节次|周次|规则）去重保留第一条；周次不同（接力课）不受影响。
      const seen = {};
      const uniq = [];
      rows.forEach(r => {
        const k = [r.name, r.day_of_week, r.period, r.weeks, r.week_rule].join('|');
        if (seen[k]) return;
        seen[k] = 1;
        uniq.push(r);
      });
      const willWrite = uniq.length;
      if (!payload.commit) {
        const [mineCnt] = await pool.query(
          'SELECT COUNT(*) AS n FROM member_timetable WHERE class_id = ? AND member_id = ?',
          [classId, member.id]
        );
        return { willWrite: willWrite, willReplace: Number(mineCnt[0].n) || 0 };
      }
      if (!willWrite) throw new BizError(41001, '本班还没有课表，无法同步');
      // 覆盖式：先清空我的，再多行 INSERT（TDSQL 一次一条 ⇒ 必须合并成一条 VALUES）
      await pool.query('DELETE FROM member_timetable WHERE class_id = ? AND member_id = ?', [classId, member.id]);
      if (uniq.length) {
        const VALUES = uniq.map(r => '(' + [
          classId, member.id,
          "'" + String(r.name || '').replace(/'/g, "''") + "'",
          "'" + String(r.teacher || '').replace(/'/g, "''") + "'",
          "'" + String(r.room || '').replace(/'/g, "''") + "'",
          Number(r.day_of_week), Number(r.period),
          "'" + String(r.weeks || '').replace(/'/g, "''") + "'",
          "'" + (r.week_rule || 'ALL') + "'",
          "'COURSE'"
        ].join(',') + ')').join(',');
        await pool.query(
          'INSERT INTO member_timetable (class_id, member_id, name, teacher, room, day_of_week, period, weeks, week_rule, kind) VALUES ' + VALUES
        );
      }
      console.log(JSON.stringify({
        fn: 'course', action: 'syncFromClass', member: member.id, classId, synced: uniq.length
      }));
      return { synced: uniq.length };
    }
  },

  /**
   * 【班委】把我的个人课表发布到全班：覆盖本班全部 COURSE 课次（course+session）。
   *
   * ⚠️ 覆盖前必须回滚被删课次占用的值日轮转标记（deleteDutyForSessions 语义同
   *    importTimetable）——删 session 不回滚 duty_count 会让游标单向漂移。
   * 二次确认由前端负责（前端弹窗「将覆盖当前 N 条」），这里只做权限与数据一致性。
   */
  publishToClass: {
    auth: { needTimetablePublish: true },
    handler: async (payload, ctx) => {
      const member = guard.requireBind(ctx);
      const classId = guard.classIdOf(ctx);   // 班委仅本班，忽略 payload.classId
      const pool = getPool();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // ① 源：我的个人课表（只取 COURSE，保洁课次仍由超管在课表页维护）
        const [mine] = await conn.query(
          `SELECT name, teacher, room, day_of_week, period, weeks, week_rule
             FROM member_timetable
            WHERE class_id = ? AND member_id = ? AND kind = 'COURSE'
            ORDER BY day_of_week, period, id`,
          [classId, member.id]
        );
        if (!mine.length) throw new BizError(41001, '你的个人课表还没有课次，无法发布');
        // ② 目标：本班现有 COURSE 课次 → 先删（连带回滚未开始的 PENDING/ONGOING 值日 + 清调课）
        const [cur] = await conn.query(
          `SELECT id FROM session WHERE class_id = ? AND kind = 'COURSE'`, [classId]
        );
        const ids = cur.map(r => Number(r.id));
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          const [duties] = await conn.query(
            `SELECT id FROM duty WHERE session_id IN (${ph}) AND status IN ('PENDING','ONGOING') AND class_date >= ?`,
            ids.concat([week.todayStr()])
          );
          if (duties.length) await rollbackDutyMarkers(conn, duties.map(r => Number(r.id)));
          await conn.query(
            `DELETE d FROM duty d JOIN session s ON s.id = d.session_id
              WHERE s.id IN (${ph}) AND s.class_id = ? AND d.status IN ('PENDING','ONGOING') AND d.class_date >= ?`,
            ids.concat([classId, week.todayStr()])
          );
          try { await conn.query(`DELETE FROM session_shift WHERE class_id = ? AND session_id IN (${ph})`, [classId].concat(ids)); } catch (e) { /* 表未建 */ }
          await conn.query(`DELETE FROM session WHERE id IN (${ph})`, ids);
        }
        // ③ 孤立课程清理（只删本班已无人引用的；CLEAN 课次引用的课程被保住）
        await conn.query(
          `DELETE FROM course WHERE class_id = ? AND id NOT IN (SELECT course_id FROM session WHERE class_id = ?)`,
          [classId, classId]
        );
        // ④ 同名同教师同教室复用 course 行（room 是课程身份一部分，避免同课不同教室被压平）
        const courseIdByKey = new Map();
        for (const co of mine) {
          const key = String(co.name) + ' ' + String(co.teacher || '') + ' ' + String(co.room || '');
          if (courseIdByKey.has(key)) continue;
          const [exist] = await conn.query(
            'SELECT id FROM course WHERE class_id = ? AND name = ? AND teacher = ? AND room = ? LIMIT 1',
            [classId, co.name, co.teacher || '', co.room || '']
          );
          if (exist.length) { courseIdByKey.set(key, Number(exist[0].id)); continue; }
          const [r1] = await conn.query(
            'INSERT INTO course (class_id, name, teacher, room, course_type, duty_count, created_by) VALUES (?,?,?,?,?,?,?)',
            [classId, co.name, co.teacher || '', co.room || '', 'ALL', 2, member.id]
          );
          courseIdByKey.set(key, Number(r1.insertId));
        }
        // ⑤ 写课次（duty_count 沿用课程默认值 2）
        let created = 0;
        for (const co of mine) {
          const courseId = courseIdByKey.get(String(co.name) + ' ' + String(co.teacher || '') + ' ' + String(co.room || ''));
          await conn.query(
            `INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count)
             VALUES (?,?,?,?,?,?,?,NULL,2)`,
            [classId, courseId, 'COURSE', co.week_rule || 'ALL', co.weeks || '',
              Number(co.day_of_week), Number(co.period)]
          );
          created += 1;
        }
        await conn.commit();
        console.log(JSON.stringify({
          fn: 'course', action: 'publishToClass', member: member.id, classId,
          created, replaced: ids.length
        }));
        return { created, replaced: ids.length, publishToWeek: week.currentWeek(await week.getConfig(pool, classId)) };
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
    }
  },

  diag: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const steps = [];
      let t = Date.now();
      const mark = (name, extra) => {
        const s = { step: name, ms: Date.now() - t };
        if (extra !== undefined) s.info = String(extra).slice(0, 120);
        steps.push(s);
        t = Date.now();
      };
      mark('start');
      const pool = getPool();
      mark('getPool');
      const [m1] = await pool.query('SELECT id, class_id FROM member WHERE id = ? LIMIT 1', [ctx.member.id]);
      mark('queryMember');
      const [c1] = await pool.query('SELECT id, total_weeks FROM `class` WHERE id = ? LIMIT 1', [ctx.member.class_id || 1]);
      mark('queryClass');
      for (let i = 0; i < 3; i++) await pool.query('SELECT 1 AS n');
      mark('query3x');

      // ① 云存储连通性探测（2026-10-05 修：上一版用「不存在的 fileID」去 downloadFile，
      //    SDK 会为无效路径反复重试 → 探针自己就耗掉 20s，把整个 diag 拖超时，纯属自伤）。
      //    现在改成**自己掐表**：无论成功失败，超过 3000ms 立刻放弃并如实记录。
      //    这样既能看出「下载慢」，又不会把诊断本身变成 20 秒超时。
      const withTimeout = (p, ms, tag) => Promise.race([
        Promise.resolve(p).then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e })),
        new Promise((r) => setTimeout(() => r({ ok: false, timeout: true }), ms))
      ]).then((r) => { mark(tag, r.timeout ? ('超时 >' + ms + 'ms') : (r.ok ? 'ok' : ((r.e && (r.e.errMsg || r.e.message)) || 'err'))); return r; });

      await withTimeout(cloud.downloadFile({ fileID: 'cloud://probe-' + Date.now() + '.xlsx' }), 3000, 'downloadProbe(3s上限)');

      // ② 真传 fileID 时测下载 + 解析（同样 8s 上限）
      if (payload.fileID) {
        const r = await withTimeout(cloud.downloadFile({ fileID: String(payload.fileID) }), 8000, 'download(8s上限)');
        const dl = r && r.ok ? r.v : null;
        if (dl && dl.fileContent) {
          mark('bytes', dl.fileContent.length);
          try { const x = parseTimetableXlsx(dl.fileContent, 16); mark('parseXlsx', 'sessions=' + x.sessions.length); }
          catch (e) { mark('parseXlsx(失败)', (e && e.message) || 'unknown'); }
        }
      }
      console.log(JSON.stringify({ fn: 'course', action: 'diag', steps }));
      return { steps, member: ctx.member.id, classId: ctx.member.class_id, classRow: c1.length, memberRow: m1.length };
    }
  },

  /** 超管查看待处理适配申请列表（仅超管） */
  getApplyList: {
    auth: { needSuper: true },
    handler: async (payload) => {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT ta.id, ta.class_id, ta.member_id, ta.file_id, ta.file_name, ta.group_scope, ta.status, ta.summary, ta.created_at,
                ta.file_b64,
                c.name AS className, m.name AS memberName
           FROM timetable_apply ta
           JOIN class c ON c.id = ta.class_id
           JOIN member m ON m.id = ta.member_id
          WHERE ta.status = 'PENDING'
          ORDER BY ta.created_at DESC`
      );
      return {
        list: rows.map(r => ({
          id: Number(r.id),
          classId: Number(r.class_id),
          memberId: Number(r.member_id),
          fileId: r.file_id,
          // ⚠️ 一并返回 base64：超管适配时**不要再走云存储下载**（VPC 内极慢，会 20s 超时）
          fileB64: r.file_b64 || '',
          fileName: r.file_name,
          groupScope: r.group_scope || null,
          status: r.status,
          summary: safeJson(r.summary),
          createdAt: String(r.created_at),
          className: r.className,
          memberName: r.memberName
        }))
      };
    }
  },

  /** 超管获取申请文件的临时下载链接（仅超管） */
  downloadApply: {
    auth: { needSuper: true },
    handler: async (payload) => {
      const id = Number(payload.id);
      if (!id) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [rows] = await pool.query('SELECT file_id FROM timetable_apply WHERE id = ?', [id]);
      if (!rows.length) throw new BizError(41001, '申请不存在');
      let res;
      try { res = await cloud.getTempFileURL({ fileList: [rows[0].file_id] }); }
      catch (e) { throw new BizError(41002, '临时链接获取失败'); }
      const url = res && res.fileList && res.fileList[0] && res.fileList[0].tempFileURL;
      if (!url) throw new BizError(41002, '临时链接获取失败');
      return { url };
    }
  },

  /**
   * 超管处理适配申请（需求 D-2）：标记 DONE / REJECTED，handled_at 落库。
   * 适配动作本身由 importTimetable（带 apply.fileId + apply.classId）完成，这里只更新申请状态，
   * 避免「已适配的申请」一直挂在待处理列表里。
   */
  handleApply: {
    auth: { needSuper: true },
    handler: async (payload) => {
      const id = Number(payload.id);
      const status = payload.status === 'REJECTED' ? 'REJECTED' : 'DONE';
      if (!id) throw new BizError(41001, '参数错误');
      const pool = getPool();
      const [r] = await pool.query(
        "UPDATE timetable_apply SET status = ?, handled_at = NOW() WHERE id = ? AND status = 'PENDING'",
        [status, id]
      );
      if (r.affectedRows === 0) throw new BizError(41001, '申请已处理或不存在');
      console.log(JSON.stringify({ fn: 'course', action: 'handleApply', id, status }));
      return { id, status };
    }
  }
};

/** 安全解析 JSON 摘要（可能为 NULL 或损坏） */
function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    reviewDemo.denyDemo(ctx.member, action);   // 演示态：拦截破坏性动作（v1.0.6.4）
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    if (route.auth && route.auth.needAdmin) guard.requireAdmin(ctx);
    if (route.auth && route.auth.needScheduleAuth) guard.requireScheduleAuth(ctx);
    if (route.auth && route.auth.needTimetablePublish) guard.requireTimetablePublish(ctx);
    if (route.auth && route.auth.needCommittee) guard.requireCommittee(ctx);
    if (route.auth && route.auth.needSuper) guard.requireSuper(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[course] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
