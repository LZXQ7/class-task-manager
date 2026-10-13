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
 * 取某一周的「起始游标」。
 *
 * 🔴 为什么必须有按周快照：只有一个全局游标时，下面这个真实时序会翻车 ——
 *      周日 20:00 cron 自动生成「下周」→ 全局游标前进；
 *      之后超管对「本周」再点一次一键生成 → 全局游标已经走过了，本周会被排成
 *      完全不同的一批人（旧版靠「从 duty_count 里扣掉本周 AUTO 行」规避，
 *      v2 的游标是显式数字，没有这个回扣的余地）。
 *    记录每 W「生成前的游标」后，**重复生成同一周永远从同一个起点开始** ⇒ 幂等。
 *
 * @param {object} conn
 * @param {number} classId
 * @param {number} wk
 * @param {{A:number,B:number}} fallback 该周没有快照时的起点（= 全局当前游标）
 * @returns {{A:number, B:number, hasSnapshot:boolean}}
 */
async function loadWeekCursors(conn, classId, wk, fallback) {
  const [rows] = await conn.query(
    'SELECT start_a, start_b FROM duty_week_cursor WHERE class_id = ? AND week = ?',
    [Number(classId) || 1, Number(wk) || 0]
  );
  if (rows.length) {
    return { A: Number(rows[0].start_a) || 0, B: Number(rows[0].start_b) || 0, hasSnapshot: true };
  }
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

module.exports = {
  pickBySeq,
  inferCursor,
  buildState,
  loadDayBlocks,
  loadCursors,
  saveCursors,
  loadWeekCursors,
  saveWeekCursors,
  syncGlobalCursors,
  dropWeekCursorsFrom,
  toSeqSet
};
