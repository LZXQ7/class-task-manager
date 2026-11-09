/**
 * 排班内核 —— 轮转取人 + 当日占用 + 游标持久化
 * ============================================================
 * 为什么单独抽一个文件：这条规则被两个入口共用
 *   · `cloudfunctions/schedule`   → 超管在值日页点「一键生成 / AI 生成」（手动触发）
 *   · `cloudfunctions/cron-weekly` → 每周日 20:00 的 `weekly` 触发器（自动生成草稿）
 * 之前两边各写了一套：schedule 用序号轮转，cron-weekly 用
 * 「duty_count 排序 + Math.random() 打破平局」，于是自动生成的那份会
 * 把同一个人排进多个课次（用户 2026-09-24 报的 bug）。现在统一在这里。
 *
 * ⚠️ 本文件是源，改完必须跑 `node scripts/sync-common.js` 再部署；
 *    各函数目录下的 `common/` 只是副本，会被静默覆盖。
 *
 * ────────────────────────────────────────────────────────────
 * 2026-10-07 v2：轮转位置改成**独立游标**
 * ────────────────────────────────────────────────────────────
 * 旧的 `rotationPick` + `repairRoundMarks` 把游标寄存在 `member.duty_count` 里
 * （「本轮已排次数」靠相对大小间接表达位置），已整体删除，实现见 `round-robin.js`。
 * 现在 `member.duty_count` **只保留统计语义**（累计值日次数，须与实际 duty 行对称），
 * 轮转位置改由 `class.round_cursor_a` / `class.round_cursor_b` 两个数字承载。
 * 本文件因此只负责三件与数据库有关的事：当日占用、游标读出（经 week.getConfig）、游标写回。
 */

const { pickBySeq, inferCursor, buildState } = require('./round-robin');

/**
 * 当日已有的值日者 / 已请假者。
 * 与轮转取人放在一起：两个入口（手动生成 / 每周自动生成）都要用，
 * 且必须用同一份口径，否则「同日不重复」的判定会不一致。
 *
 * @param {object} conn      数据库连接（pool 或事务中的 conn 都可以）
 * @param {string} classDate 'YYYY-MM-DD'
 * @returns {{busy:Set, onLeave:Set}} 成员 id 集合
 */
async function loadDayBlocks(conn, classDate) {
  const [todayDuties] = await conn.query(
    "SELECT DISTINCT member_id FROM duty WHERE class_date = ? AND status <> 'SWAPPED_OUT'", [classDate]
  );
  const [leaves] = await conn.query(
    "SELECT member_id FROM leave_request WHERE status = 'APPROVED' AND start_date <= ? AND end_date >= ?",
    [classDate, classDate]
  );
  return {
    busy: new Set(todayDuties.map(d => Number(d.member_id))),
    onLeave: new Set(leaves.map(l => Number(l.member_id)))
  };
}

/**
 * 取本班轮转游标。
 *
 * 游标的权威存储在 `class.round_cursor_a` / `class.round_cursor_b`，
 * 由 `week.getConfig()` 的 `SELECT * FROM class` 顺带读出来（不额外查库），
 * 这里只是把它整理成 `{A, B}` 的形状。
 *
 * @param {object} cfg  week.getConfig() 的返回值
 * @returns {{A:number, B:number}}
 */
function loadCursors(cfg) {
  return {
    A: Number(cfg && cfg.cursorA) || 0,
    B: Number(cfg && cfg.cursorB) || 0
  };
}

/**
 * 回写轮转游标。
 *
 * ⚠️ 只能由「生成完成」的那一刻调用一次（generate / 保洁补齐 / AI 应用 / cron 周生成）。
 *    中途调用会让「本轮走到哪」和「实际落库的行」对不上。
 *
 * @param {object} conn     数据库连接（pool 或事务中的 conn 都可以）
 * @param {number} classId
 * @param {{A:number,B:number}} cursors
 */
async function saveCursors(conn, classId, cursors) {
  const c = cursors || {};
  await conn.query(
    'UPDATE `class` SET round_cursor_a = ?, round_cursor_b = ? WHERE id = ?',
    [Number(c.A) || 0, Number(c.B) || 0, Number(classId) || 1]
  );
}

/**
 * 从「上一个有值日数据的周」的实际排班反推本轮起点游标（兜底 / 自愈）。
 * ----------------------------------------------------------------
 * 2026-10-23 实锤的 bug：v2 游标系统上线前由旧 duty_count 轮转生成的周没有
 * `duty_week_cursor` 快照，且 `class.round_cursor_*` 从未被写过（恒为 0）→ 这些周
 * 的下一周「一键生成」会把 fallback 的全局游标当成 0/0，整周从 1 号重排。
 * 没有任何快照可参考时，只能从「上一周实际落库的 duty 行」反推游标：
 *   · v2 代码生成的周：INSERT 顺序 = 轮转取人顺序 ⇒ 同组 AUTO 行里 id 最大那条，
 *     就是本轮最后一个被轮到的人，其序号即该组结束游标。
 *   · 旧代码生成的周：INSERT 顺序不可靠，反推只是近似，但**仍保证「接着排」而非「重排」**。
 * 取「上一周实际落库排班」推算：AUTO 的非保洁课次 + 全部 MANUAL（含手动保洁）。
 * MANUAL 必须计入 —— 否则「清空值日表→重生成」走反推链会把手动续排的人忘掉，
 * 下周从已排过的人重排（2026-10-23 复发的根因）。
 *
 * @param {object} conn
 * @param {number} classId
 * @param {number} wk
 * @returns {Promise<{A:number,B:number,hasSnapshot:boolean,inferred:boolean}|null>}
 */
async function inferStartFromPrevWeek(conn, classId, wk) {
  const cid = Number(classId) || 1;
  const w = Number(wk) || 0;
  const [pwRows] = await conn.query(
    'SELECT MAX(week) AS pw FROM duty WHERE class_id = ? AND week < ?', [cid, w]
  );
  const pw = pwRows[0] && pwRows[0].pw;
  if (!pw) return null;
  // 🔴 2026-10-23 复发修复：反推**必须计入 MANUAL 排班**（含手动保洁），
  //    否则「清空值日表→重生成」走反推链时会把手动 5/7 之类忘掉，下周又从 5/7 重排。
  //    仅排除 AUTO 的 CLEAN（系统自动保洁不参与课程轮转）；MANUAL 一律计入，
  //    与 bumpCursorForManual 口径一致。仍用 MAX(id) 取每组「最后落库」那行 = 轮转终点
  //    （手动行后插、id 更大，正好吃到手动续排的人）。
  const [rows] = await conn.query(
    `SELECT m.group_tag AS g, MAX(d.id) AS max_id
       FROM duty d JOIN member m ON m.id = d.member_id
       LEFT JOIN session s ON s.id = d.session_id
      WHERE d.class_id = ? AND d.week = ?
        AND ((d.source = 'AUTO' AND (s.kind IS NULL OR s.kind <> 'CLEAN'))
             OR d.source = 'MANUAL')
      GROUP BY m.group_tag`,
    [cid, Number(pw)]
  );
  if (!rows.length) return null;
  const ids = rows.map(r => Number(r.max_id)).filter(Boolean);
  if (!ids.length) return null;
  const [seqRows] = await conn.query(
    `SELECT m.group_tag AS g, m.student_no
       FROM duty d JOIN member m ON m.id = d.member_id
      WHERE d.id IN (${ids.join(',')})`,
    []
  );
  if (!seqRows.length) return null;
  // 序号与 week.seqOf / seqNum 同口径：取学号末两位数字（忽略非数字字符）
  const cur = { A: 0, B: 0, hasSnapshot: false, inferred: true };
  seqRows.forEach((r) => {
    const g = r.g === 'B' ? 'B' : 'A';
    cur[g] = seqNum(r.student_no);
  });
  return cur;
}

/**
 * 取某一周的「起始游标」。
 *
 * 🔴 为什么必须有按周快照：只有一个全局游标时，下面这个真实时序会翻车 ——
 *      周日 20:00 cron 自动生成「下周」→ 全局游标前进；
 *      之后超管对「本周」再点一次一键生成 → 全局游标已经走过了，本周会被排成
 *      完全不同的一批人（旧版靠「从 duty_count 里扣掉本周 AUTO 行」规避，
 *      v2 的游标是显式数字，没有这个回扣的余地）。
 *    记录每 W「生成前的游标」后，**重复生成同一周永远从同一个起点开始** ⇒ 幂等。
 *
 * 兜底链（2026-10-23 加固）：快照 → 上一周实际排班反推 → 全局游标。
 * 这样即使某周的快照缺失 / 全局游标被清空成 0，也只会「接着上周排」，
 * 绝不会「从 1 号重排」（旧版冷启动就是这个坑）。
 *
 * @param {object} conn
 * @param {number} classId
 * @param {number} wk
 * @param {{A:number,B:number}} fallback 该周没有快照时的起点（= 全局当前游标）
 * @returns {{A:number, B:number, hasSnapshot:boolean, inferred?:boolean}}
 */
async function loadWeekCursors(conn, classId, wk, fallback) {
  const cid = Number(classId) || 1;
  const w = Number(wk) || 0;
  // ① 本周已有快照 → 幂等起点（重复生成同一周永远从同一个起点开始）
  const [rows] = await conn.query(
    'SELECT start_a, start_b FROM duty_week_cursor WHERE class_id = ? AND week = ?',
    [cid, w]
  );
  if (rows.length) {
    return { A: Number(rows[0].start_a) || 0, B: Number(rows[0].start_b) || 0, hasSnapshot: true };
  }
  // ② 无快照（首次生成该周）：优先取「上一周快照的结束游标」。
  //    generate 已正确写入 end_a/end_b，syncGlobalCursors 也已把全局游标对齐到
  //    「最大周的结束游标」，二者等价，都是对本链「接着上周排」最准确的定义。
  //    🔴 这一句必须排在 inferStartFromPrevWeek 之前：旧版把反推（MAX(d.id) 那行的序号）
  //    放在最前，导致只要存在任意上一周 duty 行，反推就非空、正确的全局游标兜底被篡夺，
  //    新周起点被错置成「插入顺序最后的人的序号」→ 表现为「下周重复开头 / 又从 1 号附近排」
  //    （2026-10-25 实锤：第 8 周按序号轮转又从第 7 周最后的 1&55 开头）。
  const [prev] = await conn.query(
    'SELECT end_a, end_b FROM duty_week_cursor WHERE class_id = ? AND week < ? ORDER BY week DESC LIMIT 1',
    [cid, w]
  );
  if (prev.length) {
    return { A: Number(prev[0].end_a) || 0, B: Number(prev[0].end_b) || 0, hasSnapshot: false };
  }
  // ③ 仍取不到（v2 上线前的周：既无快照、全局游标又被清零成 0）→ 从上一周实际落库排班
  //    反推起点，至少「接着上周排」而非「从 1 号重排」；仍取不到（全无历史）才退回全局游标。
  const inferred = await inferStartFromPrevWeek(conn, classId, wk);
  if (inferred) return inferred;
  return { A: Number(fallback.A) || 0, B: Number(fallback.B) || 0, hasSnapshot: false };
}

/**
 * 写回某一周的游标快照。
 *
 * ⚠️ **start 只在首次生成时写入**：重复生成同一周必须沿用最初的起点，
 *    否则第二次生成会接着上一次的终点走，名单就变了（幂等性靠这一条）。
 *
 * @param {object} conn
 * @param {number} classId
 * @param {number} wk
 * @param {{A:number,B:number}} start 生成前的游标
 * @param {{A:number,B:number}} end   生成后的游标
 */
async function saveWeekCursors(conn, classId, wk, start, end) {
  const cid = Number(classId) || 1;
  const w = Number(wk) || 0;
  const [rows] = await conn.query(
    'SELECT week FROM duty_week_cursor WHERE class_id = ? AND week = ?', [cid, w]
  );
  if (rows.length) {
    await conn.query(
      'UPDATE duty_week_cursor SET end_a = ?, end_b = ? WHERE class_id = ? AND week = ?',
      [Number(end.A) || 0, Number(end.B) || 0, cid, w]
    );
    return;
  }
  await conn.query(
    'INSERT IGNORE INTO duty_week_cursor (class_id, week, start_a, start_b, end_a, end_b) VALUES (?, ?, ?, ?, ?, ?)',
    [cid, w, Number(start.A) || 0, Number(start.B) || 0, Number(end.A) || 0, Number(end.B) || 0]
  );
}

/**
 * 把全局游标（`class.round_cursor_*`）对齐到「已生成的最大周次的结束游标」。
 *
 * 为什么要对齐而不是直接用本次生成的 end：重新生成一个**较早**的周时，
 * 本次 end 会小于全局游标（那一周本来就排在前面）。若把它写回全局，
 * 下一周就会回头重复排一批人。取「最大周次的 end」才始终是对的。
 *
 * @param {object} conn
 * @param {number} classId
 * @returns {{A:number, B:number}} 对齐后的全局游标
 */
async function syncGlobalCursors(conn, classId) {
  const [rows] = await conn.query(
    'SELECT end_a, end_b FROM duty_week_cursor WHERE class_id = ? ORDER BY week DESC LIMIT 1',
    [Number(classId) || 1]
  );
  const cur = {
    A: rows.length ? (Number(rows[0].end_a) || 0) : 0,
    B: rows.length ? (Number(rows[0].end_b) || 0) : 0
  };
  await saveCursors(conn, classId, cur);
  return cur;
}

/**
 * 清空某周后同步清理游标快照。
 *
 * 被清的那周及其之后的周次快照全部作废 —— 它们的 start 是沿着
 * 「被清掉那周排过的人」串下来的，留着会让后续周次跳过一批根本没值过日的人。
 * 清完之后全局游标自动回落到「剩下的最大周次的结束游标」。
 *
 * @param {object} conn
 * @param {number} classId
 * @param {number} wk
 */
async function dropWeekCursorsFrom(conn, classId, wk) {
  await conn.query(
    'DELETE FROM duty_week_cursor WHERE class_id = ? AND week >= ?',
    [Number(classId) || 1, Number(wk) || 0]
  );
  return syncGlobalCursors(conn, classId);
}

/**
 * 把「成员 id 集合」翻译成「序号集合」。
 *
 * 轮转内核只用序号（AI 上下文的名册里没有 id），而 DB 查出来的占用都是 id，
 * 两条链路都得做一次映射，收在这里避免各处手写出错。
 *
 * @param {Iterable|Set} ids
 * @param {Map} seqById  memberId -> seq
 * @returns {Set<number>}
 */
function toSeqSet(ids, seqById) {
  const out = new Set();
  if (!ids) return out;
  ids.forEach((id) => {
    const q = seqById.get(Number(id));
    if (q) out.add(Number(q));
  });
  return out;
}

/**
 * 手动排班（addManual）后推进轮转游标。
 * ----------------------------------------------------------------
 * 背景（2026-10-23）：v2 游标系统用 `class.round_cursor_*` 承载轮转位置，
 * 而 `addManual` 只 `+1` 旧版 `duty_count`（已退化为纯统计），不再影响轮转 ⇒
 * 手动加的人会被紧接着的自动生成再次排到（用户实锤：手动 5/7 后又在第七周开头重排）。
 * 修复：手动新增一条值日 = 占用了该组「下一个轮转槽位」，应把周快照 end 推进到该同学 seq，
 *       使后续生成从「该同学之后」续排，不再重复。
 * - 只推进「当前周快照 end」；全局游标由下次 generate 的 syncGlobalCursors 对齐。
 * - 仅当手动同学 seq 在该组轮转顺序中「不落后于」当前 end 才推进（避免回退 / 跨周误推）。
 * - reassign / 换人 是「原地替换槽位里的人」，槽位 seq 不变 ⇒ 不调用本函数（见 schedule/reassign）。
 *
 * @param {object} conn
 * @param {number} classId
 * @param {number} memberId
 * @param {number} week
 */
async function bumpCursorForManual(conn, classId, memberId, week) {
  const cid = Number(classId) || 1;
  const wk = Number(week) || 0;
  const [[m]] = await conn.query(
    'SELECT student_no, group_tag FROM member WHERE id = ?', [Number(memberId) || 0]
  );
  if (!m) return;
  const seq = seqNum(m.student_no);
  if (!seq) return;
  const g = (m.group_tag === 'B') ? 'B' : 'A';
  const [rows] = await conn.query(
    'SELECT end_a, end_b FROM duty_week_cursor WHERE class_id = ? AND week = ?', [cid, wk]
  );
  if (!rows.length) return; // 该周尚未生成快照：生成时会自行从上一周推断，无需手动推进
  const end = { A: Number(rows[0].end_a) || 0, B: Number(rows[0].end_b) || 0 };
  if (isAheadInRotation(seq, g, end[g])) {
    end[g] = seq;
    await conn.query(
      'UPDATE duty_week_cursor SET end_a = ?, end_b = ? WHERE class_id = ? AND week = ?',
      [end.A, end.B, cid, wk]
    );
  }
}

/** 学号末两位数字（与 week.seqOf / inferStartFromPrevWeek 同口径） */
function seqNum(s) {
  const x = String(s == null ? '' : s).replace(/\D/g, '');
  const n = parseInt(x.slice(-2), 10);
  return isNaN(n) ? 0 : n;
}

/** 组内轮转位置：A 组 seq 1,3,5..55 → 0..27；B 组 seq 2,4..56 → 0..27 */
function rotPos(seq, g) {
  const base = (g === 'B') ? 2 : 1;
  let p = (Number(seq) - base) / 2;
  p = ((p % 28) + 28) % 28;
  return p;
}

/** 手动 seq 是否「在轮转顺序中正向不落后于」当前游标：用于推进而非回退。
 *  轮转是 28 人的环，向前距离 dp = (rotPos(seq)-rotPos(cur)) mod 28：
 *   · dp=0      同一人 → 保持（无操作）；
 *   · 0<dp<=14  正向更近 ⇒ 视为「下一个该轮到的人被手动占用」→ 推进游标到 seq；
 *   · dp>14     回绕更近 ⇒ 该人其实已在本次周期内排过（被手动复用），不推进游标，
 *                避免把中间 14+ 人整体跳过。 */
function isAheadInRotation(seq, g, cur) {
  if (!cur) return true;                                  // 游标未初始化：任何 seq 都算推进
  if (Number(seq) === Number(cur)) return true;            // 同一人：保持
  const dp = (((rotPos(seq, g) - rotPos(cur, g)) % 28) + 28) % 28;
  return dp > 0 && dp <= 14;
}

/* ============================================================
 * 2026-10-30：排班「每节应排人数」+ 岗位槽 + AI 轮转兜底 单一真源
 * ============================================================
 * 之前 generate（schedule）/ cron-weekly / AI 校验（validatePlan 的 fillByRotation）
 * 三处各自写了一份「duty_count=0→不排、否则取槽位 needN」的口径，AI 路径还漏读
 * duty_slot、且把 0 误判成 1（`|| 1`）。现收口到 resolveNeed，三处都调它，杜绝再分叉。
 * loadSlots / slotOf 原在 schedule 与 cron-weekly 各写一份（逐字相同），也收口到此。
 */

/**
 * 计算某课次「本轮应排人数」。
 *
 * 口径（与 schedule.generate / cron-weekly.generateWeek 逐字一致）：
 *   · duty_count = 0  → 课次级显式「不排值日」（书香校园等），连槽位也不排，返回 0；
 *   · 否则匹配到岗位槽 → 取槽位 needN；
 *   · 没槽位 → 回落 duty_count（课次级默认值，多数 2）。
 * 再减去 alreadyFilled（已被手动排班占用的人数）→ 自动生成只补空缺。
 *
 * ⚠️ 用 `?? 1` 窄化 0，绝不用 `|| 1`（会把合法的 0 误当 1 排 1 人——这是 AI 排班
 *   「设了不排值日仍安排」的根因）。
 *
 * @param {object} session       课次行（需含 duty_count）
 * @param {Array}  slots         duty_slot 列表（空数组 = 未启用槽位制）
 * @param {number} alreadyFilled 本课次已被手动排班占用的人数
 * @param {number} weekday       实际生效的星期（slot.day，已含调休 MOVE）
 * @param {number} period        实际生效的节次（slot.period）
 * @param {string} kind          'CLEAN' | 'NORMAL'
 */
function resolveNeed(session, slots, alreadyFilled, weekday, period, kind) {
  const dc = Number((session && session.duty_count) ?? 1);
  const slotRec = (slots && slots.length) ? slotOf(slots, weekday, period, kind) : null;
  const base = dc === 0 ? 0 : (slotRec ? slotRec.needN : dc);
  return Math.max(0, base - (Number(alreadyFilled) || 0));
}

/**
 * 取本班岗位槽（duty_slot）。
 * @param {object} conn     数据库连接
 * @param {number} classId
 */
async function loadSlots(conn, classId) {
  const [rows] = await conn.query(
    "SELECT id, weekday, `period`, need_n, fixed_seq, kind, sort_order FROM duty_slot WHERE class_id = ? ORDER BY sort_order, weekday, `period`",
    [Number(classId) || 1]
  );
  return rows.map(r => ({
    id: Number(r.id),
    weekday: Number(r.weekday),
    /* null = 承包全天（当天所有节次共用这一批人） */
    period: r.period === null ? null : Number(r.period),
    needN: Math.max(1, Number(r.need_n) || 1),
    /* 固定某人的学号序号；null = 参与轮转 */
    fixedSeq: r.fixed_seq === null ? null : Number(r.fixed_seq),
    kind: r.kind === 'CLEAN' ? 'CLEAN' : 'NORMAL',
    sortOrder: Number(r.sort_order) || 0
  }));
}

/**
 * 给一个课次匹配槽位。匹配优先级：
 *   ① CLEAN 课次 → 优先找 CLEAN 专用槽（大扫除单独成槽，不消耗常规轮转）
 *   ② 精确 (星期, 节次)
 *   ③ 同星期的「全天槽」(period = null)
 * 都匹配不到 → null（该课次回落原逻辑，不会被吞掉）
 *
 * ⚠️ weekday 用 **实际生效的星期（slot.day）**，不是 session.day_of_week ——
 *    调休 MOVE 后后者不变，用它会排到错误的那天。
 */
function slotOf(slots, weekday, period, kind) {
  if (!slots || !slots.length) return null;
  const wd = Number(weekday);
  const pd = Number(period);
  if (kind === 'CLEAN') {
    const c = slots.find(x => x.kind === 'CLEAN' && x.weekday === wd && (x.period === null || x.period === pd));
    if (c) return c;
  }
  return slots.find(x => x.kind !== 'CLEAN' && x.weekday === wd && x.period === pd)
    || slots.find(x => x.kind !== 'CLEAN' && x.weekday === wd && x.period === null)
    || null;
}

/**
 * 轮转取人 —— 与 schedule.generate / cron-weekly **共用同一个内核**（round-robin 的
 * pickBySeq），三条链路必然给出同一份名单。从 validatePlan 收口而来（2026-10-30）。
 *
 * 负责把「本轮已排的人」推进到 day（当天占用）与 usedInPlan（跨天全局唯一），
 * 并返回本次取到的名单 + 是否发生过回绕。
 *
 * 🔴 兜底分支（名额多于人数，本组本轮已排满）：必须保留 usedInPlan 作为 avoidSeqs。
 *    旧版把它改成「仅本节已选」，等于把别的课次已排过的人重新拎回来
 *    → AI 排班里 53/55 这类人「反复排好几遍」。保留 usedInPlan 后，人手不足时
 *    内核自动开新一轮从最小序号续上，绝不重复。
 *
 * @param {Array}  roster  名册 [{seq, group, id?, name?}]
 * @param {string} scope   'A' | 'B' | null
 * @param {number} need    本节需要人数
 * @param {object} state   buildState() 产物（会被就地推进）
 * @param {object} opts    { usedInPlan, day, skipSeqs, avoidSameDay, busySeqs, pairAvoid, sectionTaken }
 */
function fillByRotation(roster, scope, need, state, opts) {
  const o = opts || {};
  const usedInPlan = o.usedInPlan || new Set();
  const day = o.day || new Set();
  const skipSet = new Set(o.skipSeqs || []);
  const avoidSameDay = !!o.avoidSameDay;
  /* 「同一课次互斥对」透传给 pickBySeq：sectionTaken 是同一个 Set 引用，
   * 兜底第二批取人时会把第一批并进来，互斥约束跨两批仍然成立。 */
  const pairAvoid = o.pairAvoid || null;
  const sectionTaken = o.sectionTaken || new Set();
  /* 跨天全局唯一护栏（一轮里每人最多排一次）。
   * 🔴 兜底分支复用同一份 base（avoidSeqs 始终是 usedInPlan），绝不撤掉它。
   * softSeqs：与 generate 同口径——avoidSameDay 关闭时退化为「软避让」（优先不排、没人时才用），
   *   保证旧行为（同日已排的人仍被尽量避开）不丢；avoidSameDay 开启时 busySeqs 硬护栏生效。 */
  const base = {
    avoidSeqs: usedInPlan,
    busySeqs: o.busySeqs || new Set(),
    avoidSameDay,
    softSeqs: o.softSeqs || null,
    skipSeqs: skipSet,
    pairAvoid,
    sectionTaken
  };
  let res = pickBySeq(roster, scope, need, state, base);
  let picked = res.chosen;
  if (res.short > 0) {
    /* 兜底：本组本轮已排满 → 保留 usedInPlan 开新一轮从最小序号续上，绝不重复。
     * 🔴 第二批取人前必须先把第一批并进 usedInPlan（= avoidSeqs）：
     *    pickBySeq 的「同课次不重复」只靠**调用内**的 localTaken，跨调用不保留；
     *    而兜底路径可能回绕并 clear() state.used，若不并入 avoidSeqs，
     *    同一节课就会把刚取过的人再取一次 —— 这是「示例成员56、示例成员56」的机制级来源。 */
    picked.forEach(r => { usedInPlan.add(r.seq); sectionTaken.add(r.seq); });
    const extra = pickBySeq(roster, scope, res.short, state, base);
    picked = picked.concat(extra.chosen);
  }
  picked.forEach(r => { day.add(r.seq); usedInPlan.add(r.seq); });
  return { picked, wrapped: res.wrapped };
}

/* ============================================================
 * 2026-10-31：AI 排班「去重加固」+ 「X号替换Y号」替班指令
 * ============================================================
 * 从 schedule/index.js 的 validatePlan 收口到此（与 generate/cron 同处单一真源），
 * 这样门禁脚本能直接 require 本文件做纯函数验证，无需云函数运行环境。
 */

/**
 * 解析「从几号开始排」的起点指令：使用者最常见的说法之一。
 * 支持：「a组从53」「a组从53号开始」「b组52号开始」「B组由12起」。
 *
 * 返回 { A: 53, B: 52 }（「从该号开始」；缺某组则不含该键）。
 *
 * ⚠️ 为什么不让模型去理解：
 *   2026-10-31 用户原话「a组从53，b组从52开始」，模型按提示词把它当成
 *   「53 号之前都排过了」写进 skipSeqs（1…51），把候选池抽干，19 节课 16 节未排。
 *   这句话本质是**轮转起点**，与游标同义，完全可以确定性解析，不必过模型。
 *
 * ⚠️ 只认「组 + 从/起/开始」的强信号：像「A组5号请假」这类不会被误判成起点。
 *
 * @param {string} text 使用者自由文本
 * @param {Array}  roster [{seq, group}]
 */
function parseStartSeqs(text, roster) {
  const out = {};
  if (!text) return out;
  const valid = new Set((roster || []).map(r => Number(r.seq)));
  const t = String(text);
  const put = (g, n) => {
    const G = String(g || '').toUpperCase();
    if (G !== 'A' && G !== 'B') return;
    const q = Number(n);
    if (!(q > 0) || !valid.has(q)) return;
    out[G] = q;
  };
  let m;
  // ① 「A组从53」「B组由12」——带从/由/自
  const re1 = /([A-Za-z])\s*组\s*(?:从|由|自)\s*(\d+)/g;
  while ((m = re1.exec(t))) put(m[1], m[2]);
  // ② 「A组53号开始」「B组52起」——带开始/起/往后
  const re2 = /([A-Za-z])\s*组\s*(\d+)\s*号?\s*(?:开始|起|往后)/g;
  while ((m = re2.exec(t))) put(m[1], m[2]);
  return out;
}

/**
 * 把「从 N 开始」落到轮转状态上：该组游标推进到 N-1，并把序号 < N 的人标记为本轮已排。
 *
 * 🔴 游标只前进不后退（沿用 round-robin 的铁律）：N 比当前游标还小就原样不动，
 *    否则一旦有人手滑说「从 1 号开始」，整轮会倒着重排。
 *
 * @returns {Array<string>} 实际生效的 ['A:53','B:52']，用于回显给使用者
 */
function applyStartFrom(ctx, startFrom) {
  const bumped = [];
  if (!startFrom || !ctx || !ctx.state) return bumped;
  const st = ctx.state;
  if (!st.cursors) st.cursors = { A: 0, B: 0 };
  if (!st.used) st.used = { A: new Set(), B: new Set() };
  ['A', 'B'].forEach((g) => {
    const n = Number(startFrom[g]);
    if (!(n > 0)) return;
    const floor = n - 1;                       // 「从 N 开始」= 本轮已排到 N-1
    const cur = Number(st.cursors[g]) || 0;
    if (floor <= cur) return;                  // 只前进，不后退
    (ctx.roster || []).forEach((r) => {
      const rg = r && r.group === 'B' ? 'B' : 'A';
      if (rg !== g) return;
      if (Number(r.seq) <= floor) st.used[g].add(Number(r.seq));
    });
    st.cursors[g] = floor;
    bumped.push(g + ':' + n);
  });
  // 快照起点也跟着走，保证「首次生成起点」与本次实际起点一致
  if (bumped.length && ctx.startCursors) {
    ctx.startCursors = { A: st.cursors.A, B: st.cursors.B };
  }
  return bumped;
}

/**
 * 解析「替班」指令：使用者用自然语言写的「X号替换Y号」类要求。
 * 支持写法：主动「1号替换9号 / 1号代替9号 / 1号替9号 / 1号顶9号 / 用1号换9号」，
 *          被动「9号被1号替换」。
 * 返回 { [被替换者seq]: 替班者seq } —— 即「轮到 Y 时改排 X，Y 本轮不值日」。
 * 不在名册里的序号一律忽略，绝不瞎排。
 *
 * @param {string} text 使用者自由文本
 * @param {Array<number>|Set<number>} rosterSeqs 合法序号集合
 */
function parseSubMap(text, rosterSeqs) {
  const valid = new Set(rosterSeqs || []);
  const out = {};
  if (!text) return out;
  const t = String(text);
  const push = (replacer, replaced) => {
    const x = Number(replacer), y = Number(replaced);
    if (!x || !y || x === y) return;
    if (!valid.has(x) || !valid.has(y)) return; // 不在名册 → 忽略
    out[y] = x;                                 // 轮到 y 时改排 x
  };
  let m;
  // 主动：「X号替换/代替/替/顶(替)/换Y号」（可夹「用/掉/了」）
  const re1 = /(\d+)\s*号?\s*(?:替换|代替|替|顶(?:替)?|换)\s*(?:用|掉|了)?\s*(\d+)\s*号?/g;
  while ((m = re1.exec(t))) push(m[1], m[2]);
  // 被动：「Y号被X号替换」
  const re2 = /(\d+)\s*号?\s*被\s*(\d+)\s*号?\s*(?:替换|代替|替|顶|换)/g;
  while ((m = re2.exec(t))) push(m[2], m[1]);
  return out;
}

/**
 * 解析「X 号和 Y 号不要排在同一节课」的互斥要求（2026-11-08 用户反馈）。
 *
 * 🔴 为什么必须本地确定性解析：
 *   旧版提示词的输出结构只有 assignments / unchanged / skipSeqs / notes，
 *   完全没有承载「两人不能同课次」的字段；而 assignments 又明确**不被采信**
 *   （validatePlan 一律按「课次先后 + 序号从小到大」重新配对）。
 *   于是无论模型怎么理解、前端怎么显示，落库时都是连续取号 —— 1、2 号
 *   在全体课里必然被排进同一节课。跟 parseStartSeqs 同理：这类硬约束
 *   交给模型既表达不了、也验证不了，只能自己解析。
 *
 * 支持写法：
 *   「1号和2号不安排在同一节课」「1号2号不要排一起」
 *   「1号、2号不能同时值日」「1号和2号、3号和4号不要排一起」
 *   「5号和6号分开」「1号跟2号不排一节」
 * 明确不认（避免把别类指令误判成互斥对）：起点「从N号开始」、替班「X号替换Y号」、
 *   跳过「N号不值日/请假/免排」。
 *
 * @param {string} text 使用者自由文本
 * @param {Array<number>|Set<number>} rosterSeqs 合法序号集合
 * @returns {Array<[number,number]>} 去重后的无序互斥对
 */
function parseAvoidPairs(text, rosterSeqs) {
  const valid = new Set((rosterSeqs || []).map(Number));
  const out = [];
  const seen = new Set();
  if (!text) return out;
  const push = (a, b) => {
    const x = Number(a), y = Number(b);
    if (!valid.has(x) || !valid.has(y) || x === y) return;
    const key = Math.min(x, y) + '-' + Math.max(x, y);
    if (seen.has(key)) return;
    seen.add(key);
    out.push([Math.min(x, y), Math.max(x, y)]);
  };
  String(text).split(/[，,；;。\n]+/).forEach((seg) => {
    const s = String(seg || '').trim();
    if (!s) return;
    // 起点 / 替班 / 跳过 这类句式里的数字不是互斥对
    if (/替换|代替|顶替|顶\s*\d|换|请假|不值日|跳过|免排|从\s*\d|开始|起排|往后/.test(s)) return;
    const negative = /不|别|勿|不能|不要|不可|避免|分开|错开|隔开/.test(s);
    const sameSection = /同一节|一节|同节|一节课|同一个|同一次|一起|同时|排一起|安排在一起|同班值日|同个值日|分开|错开|隔开/.test(s);
    if (!negative || !sameSection) return;
    let m;
    // ①「1号和2号」「1号、2号」——按连接词成对，避免过度两两组合
    const linked = /(\d+)\s*号?\s*(?:和|与|及|跟|、|连同)\s*(\d+)\s*号?/g;
    const linkedPairs = [];
    while ((m = linked.exec(s))) linkedPairs.push([m[1], m[2]]);
    if (linkedPairs.length) {
      linkedPairs.forEach(p => push(p[0], p[1]));
      return;
    }
    // ②「1号2号不要排一起」——句内所有带「号」的合法序号两两互斥
    const nums = [];
    const re = /(\d+)\s*号/g;
    while ((m = re.exec(s))) {
      const q = Number(m[1]);
      if (valid.has(q) && nums.indexOf(q) === -1) nums.push(q);
      if (nums.length >= 6) break;
    }
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) push(nums[i], nums[j]);
    }
  });
  return out;
}

/** 把 [[1,2],[3,4]] 变成双向邻接表，供 pickBySeq 的「同课次互斥」过滤用 */
function buildPairMap(pairs) {
  const m = new Map();
  (pairs || []).forEach((p) => {
    const a = Number(p && p[0]), b = Number(p && p[1]);
    if (!(a > 0) || !(b > 0) || a === b) return;
    if (!m.has(a)) m.set(a, new Set());
    if (!m.has(b)) m.set(b, new Set());
    m.get(a).add(b);
    m.get(b).add(a);
  });
  return m.size ? m : null;
}

/**
 * 把各课次「已有值日」并入去重集合。
 *
 * 🔴 2026-10-31 修复：旧版只把「保持原样」课次的人并入 usedInPlan，
 *    其余课次已有的（手动或 AUTO）值日者没并入 ⇒ 轮转内核会再把他们排进别的课次
 *    （手动预排的人被又排一遍 / 53·55 类反复排）。现在全部并入，
 *    本轮/本次计划内每人最多一次。
 */
function seedUsedFromExisting(usedInPlan, stateUsed, sessions, rosterBySeq) {
  (sessions || []).forEach(s => {
    /* ⚠️ 2026-10-31 修复（用户截图实锤）：旧实现把 existingDutySeqs **全量**并入，
     *   某课次历史数据里塞了超过名额的人数时（旧版 `|| 1` 事故遗留 / 同一人重复行），
     *   去重集合会被瞬间抽干 ⇒ 其余课次全部「未排 / 候选人不足」。
     *   现按 dutyCount 截断 + 去重，seed 与 validatePlan 的 keep 口径完全一致，
     *   不再出现「占了去重名额却不显示」的幽灵占用。 */
    const cap = Number(s.dutyCount) || 0;
    const seen = new Set();
    (s.existingDutySeqs || []).forEach(q => {
      if (!q || seen.has(q)) return;
      if (cap > 0 && seen.size >= cap) return;
      seen.add(q);
      usedInPlan.add(q);
      const r = rosterBySeq && rosterBySeq.get(q);
      if (r && stateUsed) stateUsed[r.group === 'B' ? 'B' : 'A'].add(q);
    });
  });
}

/**
 * 替班替换：把计划里所有 fromSeq 换成 toSeq。
 * 若 toSeq 已在本课次（X 自己的班就是这节课），不重复替换、保留原 fromSeq，
 * 避免一节课同一个人排两次。
 */
function applySubstitution(memberSeqs, subMap) {
  if (!subMap || !Object.keys(subMap).length) return memberSeqs;
  const out = [];
  memberSeqs.forEach((q) => {
    const to = subMap[q];
    /* 目标人已在本课次（不管是最初就有的，还是前面刚被换进来的）→ 保留原值，
     * 否则两个人替同一个人时会产出 [X, X]（一节课同一个人两次）。 */
    if (to != null && out.indexOf(to) === -1 && memberSeqs.indexOf(to) === -1) out.push(to);
    else out.push(q);
  });
  return out;
}

/**
 * AI 计划校验/落地：AI 只决定「哪些课次不动 / 哪些人本轮跳过」，
 * 「谁配到哪节课」一律由本地按「日期 + 节次」先后取最小可用号决定（见 fillByRotation）。
 *
 * 2026-10-31 加固：
 *   ① seedUsedFromExisting —— 已有值日（手动 + AUTO）全部并入去重，杜绝重复排；
 *   ② 非「保持原样」课次改为「保留已有 + 补空缺」（手动预排的人留在原位，AI 只填剩下的坑），
 *      与一键生成口径一致，不再把手动预排的人又排一遍；
 *   ③ subMap（「X号替换Y号」）—— 轮到 Y 时改排 X，Y 本轮不值日（X 可因此值日两次，属预期）。
 *   ④ skipSeqs 收口 —— 剔除「本轮已轮过 / 本周已有值日」的冗余跳过项 + 可行性兜底，
 *      防止模型把「已轮过的号」写进 skipSeqs 后把候选池抽干（大片「未排」的根因）。
 *
 * @param {object} ctx  buildAiContext 的产物（sessions/roster/state/idBySeq/avoidSameDay）
 * @param {object} raw  { assignments?, unchanged?, skipSeqs?, notes? }
 * @param {object} [subMap]  parseSubMap 的结果 { fromSeq: toSeq }
 * @param {Array}  [avoidPairs] parseAvoidPairs 的结果 [[1,2],[3,4]]（同课次互斥）
 */
function validatePlan(ctx, raw, subMap, avoidPairs) {
  const warnings = [];
  let wrappedAny = false;
  const sessions = ctx.sessions;
  const byId = new Map(sessions.map(s => [s.sessionId, s]));
  const rosterBySeq = new Map(ctx.roster.map(r => [r.seq, r]));
  const pairAvoid = buildPairMap(avoidPairs);
  /* 「别排同一节课」≠「本轮别值日」。模型常把这件事误写进 skipSeqs，
   * 把人从候选池里删掉（两人干脆不值日了）⇒ 这里按本地解析结果兜底剔除。 */
  const pairSeqs = new Set();
  (avoidPairs || []).forEach(p => { pairSeqs.add(Number(p[0])); pairSeqs.add(Number(p[1])); });
  const hasPairInRow = (seqs) => !!pairAvoid && seqs.some(q => {
    const s = pairAvoid.get(q);
    return s && seqs.some(x => s.has(x));
  });

  // AI 建议的人选仅用于事后解释，不参与配对
  const suggested = new Set();
  (Array.isArray(raw && raw.assignments) ? raw.assignments : []).forEach((it) => {
    const sid = Number(it && it.sessionId);
    if (!byId.has(sid)) { warnings.push('AI 返回了不存在的课次 #' + sid + '，已忽略'); return; }
    (Array.isArray(it.memberSeqs) ? it.memberSeqs : []).forEach((v) => {
      const q = Number(v);
      if (rosterBySeq.has(q)) suggested.add(q);
    });
  });

  const keptIds = new Set(
    (Array.isArray(raw && raw.unchanged) ? raw.unchanged : [])
      .map(Number).filter(sid => byId.has(sid))
  );
  const skipRaw = (Array.isArray(raw && raw.skipSeqs) ? raw.skipSeqs : [])
    .map(Number).filter(n => rosterBySeq.has(n) && !pairSeqs.has(n));
  if (pairSeqs.size && Array.isArray(raw && raw.skipSeqs)
      && raw.skipSeqs.map(Number).some(n => pairSeqs.has(n))) {
    warnings.push('「不排同一节课」的两人由程序分开安排，未把他们从本轮跳过');
  }

  const usedSameDay = {};
  const usedInPlan = new Set();
  const plan = [];

  // 🔴 ① 全部已有值日并入去重（手动 + AUTO），本轮计划内每人最多一次
  seedUsedFromExisting(usedInPlan, ctx.state && ctx.state.used, sessions, rosterBySeq);

  /* 🔴 ② skipSeqs 收口（2026-10-31 用户截图实锤：19 节里 16 节「未排」，56 号被反复排）
   * ──────────────────────────────────────────────────────────────
   * 病根：提示词曾让模型把 roster 里 `dutyCountThisRound=1`（本轮已轮过）的人写进 skipSeqs，
   *   而 pickBySeq 会把 skipSeqs 的人**从候选池物理删除**。1~51 号一删，A 组只剩 53/55，
   *   38 个名额必然排不满，剩下的号又被反复取（「56 号被排了多次」）。
   *
   * 语义上也根本不需要：轮转游标本身就保证「一轮每人一次」，把「已轮过」的号再「跳过」
   *   是纯冗余，却会把候选池抽干。所以这里剔除两类冗余跳过项：
   *     ① 本轮已排（序号 ≤ 游标，见 state.used）；② 本周已有值日（已在 usedInPlan）。
   *
   * 再加一道可行性兜底：即便剩下的都是「真跳过」，若人数不足以填满全部名额，
   *   从**大号往回**逐个解禁（小的号更像使用者点名的具体人），保证计划一定能排满。 */
  const skipSet = new Set();
  const redundantSkip = [];
  skipRaw.forEach((q) => {
    const r = rosterBySeq.get(q);
    const g = r && r.group === 'B' ? 'B' : 'A';
    const usedG = (ctx.state && ctx.state.used && ctx.state.used[g]) || null;
    if ((usedG && usedG.has(q)) || usedInPlan.has(q)) redundantSkip.push(q);
    else skipSet.add(q);
  });
  const totalNeed = sessions.reduce((a, s) => a + (Number(s.dutyCount) || 0), 0);
  const relaxedSkip = [];
  if (skipSet.size) {
    const byDesc = Array.from(skipSet).sort((a, b) => b - a);
    while (skipSet.size && (ctx.roster.length - skipSet.size) < totalNeed) {
      const q = byDesc.shift();
      skipSet.delete(q);
      relaxedSkip.push(q);
    }
  }
  const skipSeqs = Array.from(skipSet).sort((a, b) => a - b);

  /* 轮转流 = 课程课次 + 保洁课次（若 ctx 提供 cleanSessions），按
   * 「日期 → 节次 → 保洁压在同节次之后 → 课次 id」排序。
   * ⚠️ 必须与 generate 的 rotatePlan 同口径（schedule/index.js generate 内的 rotatePlan.sort），
   *    否则 AI 排班的保洁号与「一键生成」不一致：保洁被甩到整周末尾（33/34/35…）。
   * 保洁行只进 cleanPlan（前端单独渲染），但**共用同一个游标** —— 这才是「按序号连续」。
   * 旧口径保留：`unchanged` 起点之前的保洁不补（「从周四第二节开始排」时周一二三的打扫不动）。 */
  const items = sessions.map(s => Object.assign({}, s, { isClean: false }))
    .concat((ctx.cleanSessions || []).map(s => Object.assign({}, s, { isClean: true })));
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : (Number(a.period) - Number(b.period))
      || ((a.isClean ? 1 : 0) - (b.isClean ? 1 : 0))
      || (Number(a.sessionId) - Number(b.sessionId))));
  let cleanBoundary = null;
  if (keptIds.size) {
    const firstOpen = items.find(i => !keptIds.has(i.sessionId));
    if (firstOpen) cleanBoundary = { date: firstOpen.date, period: Number(firstOpen.period) };
  }
  const cleanPlan = [];

  // 「保持原样」课次：原样回填，不参与本次挑选（其人已并入 usedInPlan）
  items.forEach((s) => {
    if (!keptIds.has(s.sessionId)) return;
    const dayKeep = (usedSameDay[s.date] = usedSameDay[s.date] || new Set(s.busySameDaySeqs));
    /* 去重后再截断：同一课次历史数据里可能有重复行（同一个人出现两次，如「示例成员56、示例成员56」），
     * 原样 slice 会把重复原封不动显示出来。 */
    const keep = Array.from(new Set(s.existingDutySeqs || [])).slice(0, s.dutyCount);
    keep.forEach(q => { dayKeep.add(q); usedInPlan.add(q); });
    plan.push({
      sessionId: s.sessionId, date: s.date, period: s.period, dayText: s.dayText,
      course: s.course, room: s.room, groupScope: s.groupScope, dutyCount: s.dutyCount,
      memberSeqs: keep, memberIds: keep.map(q => ctx.idBySeq.get(q)),
      names: keep.map(q => (rosterBySeq.get(q) || {}).name || ''),
      reason: '保持原样', kept: true, rejected: []
    });
  });

  // 其余课次：保留已有值日 + 按课次先后补最小可用号
  items.forEach((s) => {
    if (keptIds.has(s.sessionId)) return;
    // 起点之前的保洁不补（「从周四第二节开始排」→ 周一二三的打扫保持不动）
    if (s.isClean && cleanBoundary
      && (s.date < cleanBoundary.date
        || (s.date === cleanBoundary.date && Number(s.period) < cleanBoundary.period))) return;
    const day = (usedSameDay[s.date] = usedSameDay[s.date] || new Set(s.busySameDaySeqs));
    // ② 保留本课次已有值日（手动预排的人留在原位），只补空缺名额
    //    去重后再截断：防同一课次重复行把「示例成员56、示例成员56」原样带出来
    const keep = Array.from(new Set(s.existingDutySeqs || [])).slice(0, s.dutyCount);
    const need = Math.max(0, s.dutyCount - keep.length);
    let picked = [];
    if (need > 0) {
      const r = fillByRotation(ctx.roster, s.groupScope, need, ctx.state, {
        usedInPlan, day, skipSeqs, avoidSameDay: !!ctx.avoidSameDay, busySeqs: day, softSeqs: day,
        pairAvoid, sectionTaken: new Set(keep)
      });
      if (r.wrapped) wrappedAny = true;
      picked = r.picked;
      if (picked.length < need) {
        warnings.push('周' + s.dayText.replace('周', '') + '第' + s.period + '节候选人不足（还差 '
          + (need - picked.length) + ' 人）');
      }
    }
    const memberSeqs = keep.concat(picked.map(m => m.seq));
    const row = {
      sessionId: s.sessionId, date: s.date, period: s.period, dayText: s.dayText,
      course: s.course, room: s.room, groupScope: s.groupScope, dutyCount: s.dutyCount,
      memberSeqs, memberIds: memberSeqs.map(q => ctx.idBySeq.get(q)),
      names: memberSeqs.map(q => (rosterBySeq.get(q) || {}).name || ''),
      reason: keep.length ? '保留已有并补 ' + picked.length + ' 人' : '',
      kept: false, rejected: []
    };
    // 保洁单独给前端（渲染在「18点前 · 410」那一行），但轮转号码与课程同一条流
    if (s.isClean) { row.isClean = true; cleanPlan.push(row); } else plan.push(row);
  });

  // ③ 替班替换（「X号替换Y号」）：轮到 Y 改排 X，Y 本轮不值日
  if (subMap && Object.keys(subMap).length) {
    const beforeSub = new Map(plan.map(p => [p.sessionId, p.memberSeqs.slice()]));
    plan.forEach(p => { p.memberSeqs = applySubstitution(p.memberSeqs, subMap); });
    /* 替班可能把某人换成其互斥伙伴（本课次已有 1 号，替换又带进 2 号）⇒
     * 破坏「不排同一节课」。这类课次整体回退替换：宁可替班不生效，也不破坏硬约束。 */
    if (pairAvoid) {
      let rolled = 0;
      plan.forEach(p => {
        if (hasPairInRow(p.memberSeqs)) {
          p.memberSeqs = beforeSub.get(p.sessionId);
          rolled++;
        }
      });
      if (rolled) warnings.push('为避免与「不排同一节课」冲突，' + rolled + ' 个课次的替班未生效');
    }
    plan.forEach(p => {
      p.memberIds = p.memberSeqs.map(q => ctx.idBySeq.get(q));
      p.names = p.memberSeqs.map(q => (rosterBySeq.get(q) || {}).name || '');
    });
  }

  // 重复自检（替班者出现两次属预期，跳过 subMap 的 value 集合再判）
  const subVals = new Set(Object.values(subMap || {}));
  const seenOnce = new Set();
  const repeated = [];
  plan.concat(cleanPlan).forEach(p => p.memberSeqs.forEach(q => {
    if (subVals.has(q)) return; // 替班者值日两次是设计预期
    if (seenOnce.has(q)) repeated.push(q); else seenOnce.add(q);
  }));

  if (redundantSkip.length) {
    warnings.push('本轮已轮过的 ' + redundantSkip.length
      + ' 人无需再跳过（轮转本身就会跳过），已忽略这部分跳过设置');
  }
  if (relaxedSkip.length) {
    warnings.push('跳过人数过多会导致课次排不满，已把 ' + relaxedSkip.length
      + ' 人重新纳入轮转（' + relaxedSkip.slice(0, 10).join('、')
      + (relaxedSkip.length > 10 ? ' 等' : '') + '）');
  }
  if (skipSeqs.length) warnings.push('本轮跳过 ' + skipSeqs.join('、') + ' 号');
  if (keptIds.size) warnings.push('有 ' + keptIds.size + ' 个课次按你的要求保持原样');
  const localSeqs = new Set();
  const keptSeqs = new Set();
  plan.forEach(p => p.memberSeqs.forEach(q => { (p.kept ? keptSeqs : localSeqs).add(q); }));
  const aiOnly = Array.from(suggested).filter(q => !localSeqs.has(q) && !keptSeqs.has(q));
  if (aiOnly.length) {
    warnings.push('AI 建议的 ' + aiOnly.sort((a, b) => a - b).join('、')
      + ' 号与「按课次先后取最小可用号」的顺位不一致，已按序号顺序重新配对');
  }
  if (avoidPairs && avoidPairs.length) {
    warnings.unshift('已按你的要求把 ' + avoidPairs.map(p => p.join('、') + ' 号').join(' / ')
      + '分开，不安排在同一节课');
  }
  const keptPairRows = pairAvoid ? plan.filter(p => p.kept && hasPairInRow(p.memberSeqs)) : [];
  if (keptPairRows.length) {
    warnings.push('有 ' + keptPairRows.length + ' 个「保持原样」的课次原本就排了这几个人，按你的要求未改动');
  }
  if (wrappedAny) warnings.push('本轮 56 人已轮到一遍，已开启新一轮，按序号继续往后排');
  if (repeated.length) {
    warnings.push('注意：' + Array.from(new Set(repeated)).sort((a, b) => a - b).join('、')
      + ' 号在本次计划里被排了多次（候选人数不够，属放宽处理）');
  }

  plan.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
  cleanPlan.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
  return { plan, cleaningPlan: cleanPlan, warnings, skipSeqs, notes: String((raw && raw.notes) || '').slice(0, 120) };
}

module.exports = {
  pickBySeq,
  inferCursor,
  buildState,
  loadDayBlocks,
  loadCursors,
  saveCursors,
  loadWeekCursors,
  inferStartFromPrevWeek,
  saveWeekCursors,
  syncGlobalCursors,
  dropWeekCursorsFrom,
  bumpCursorForManual,
  toSeqSet,
  resolveNeed,
  loadSlots,
  slotOf,
  fillByRotation,
  parseSubMap,
  parseStartSeqs,
  parseAvoidPairs,
  buildPairMap,
  applyStartFrom,
  seedUsedFromExisting,
  applySubstitution,
  validatePlan
};
