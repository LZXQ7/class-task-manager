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
  toSeqSet
};
