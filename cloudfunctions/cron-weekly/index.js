/**
 * 云函数：cron-weekly —— 定时任务（开发文档 8.2 #10）
 * 触发器（CloudBase 7 段 cron，部署时经 API 创建，**整体覆盖语义，须一次传齐全部**）：
 *   weekly    周日 20:00  生成下周草稿（幂等）
 *   daily     每日 06:00  过期扫描（昨日未确认 → EXPIRED）
 *   hourly    每小时      换班申请超时撤销 / AUDITING 超 24h 未回调 → BLOCKED
 *   remind    每日 21:00  次日值日订阅提醒（当晚预告：明天有你的值日）
 *   remindAM  每日 07:00  当日值日订阅提醒（当天早上：今天有你的值日）★ v0.7.15 新增
 *
 * ⚠️ 提醒为什么要两条（2026-09-26 用户需求②）：
 *   21:00 那条是「预告」，学生可能已经睡了或没看手机；早上 7:00 那条是「临场」，
 *   出门前能看到具体第几节、哪个教室。两条共用 `remindDuty()`，只在「日期」与
 *   「今天/明天」用词上不同 —— 文案与字段拼装必须同源，禁止再抄第二份。
 * ⚠️ 一次性订阅额度：「同意一次 = 1 条」。**一天两条 = 每人每天要 2 条额度**，
 *   所以前端「开启微信提醒」入口要引导学生多点几次累积额度（见 utils/subscribe.js）。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const { getPool } = require('./common/db');
const week = require('./common/week');
// 轮转取人内核：与 schedule 的「一键生成」共用同一份实现（禁止再写第二套算法）
const {
  pickBySeq, buildState, loadDayBlocks, loadCursors, toSeqSet,
  loadWeekCursors, saveWeekCursors, syncGlobalCursors
} = require('./common/schedule-core');
/* 测试账号唯一真源（见 common/test-account.js）：
 * 自动排班的轮转名册**必须**过滤测试账号 —— 每周 cron 是无人值守的，
 * 一旦把测试账号排进课次，超管手动排班的「测试账号只在手动时存在」这个前提就破了。 */
const { NOT_TEST } = require('./common/test-account');

const DAY_MS = 86400000;
const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 每周自动生成（weekly 触发器，周日 20:00 生成下周草稿）。
 *
 * ⚠️ 取人必须与超管手动「一键生成」完全同源 —— `common/schedule-core.js` 的 rotationPick。
 * 旧版这里自己写了一套「按 duty_count 排序 + `Math.random()` 打破平局」的算法，有两个致命问题：
 *   ① 不可复现：同一份数据每次跑出来的人不一样；
 *   ② **会把同一个人排进多个课次** —— duty_count 相同的一批人被随机打散到不同的天，
 *      于是同一个人周一、周三各值一次（2026-09-24 用户报的「一键生成会重复安排」）。
 * 另外旧版直接用 `getDateOfWeekDay` 算日期，不看校历、不看临时调课，
 * 会自动给中秋节 / 国庆当天排值日，也不认「这周这节课不上」。这些现在都补齐了。
 */
async function generateWeek(pool, wk, classId) {
  const cfg = await week.getConfig(pool, classId);
  if (wk > cfg.totalWeeks) return { skipped: true, reason: 'week overflow' };
  const [rulesRows] = await pool.query('SELECT * FROM schedule_rules WHERE class_id = ? ORDER BY id LIMIT 1', [classId]);
  const rules = rulesRows[0] || {};
  const avoidSameDay = !!rules.avoid_same_day;
  const conn = await pool.getConnection();
  let created = 0;
  let roundReset = false;
  let holidaySkipped = 0;
  let shiftSkipped = 0;
  let cursorStr = '';
  const warnings = [];
  try {
    await conn.beginTransaction();
    const cal = await week.loadCalendar(conn);
    const shifts = await week.loadSessionShifts(conn);
    const [sessRows] = await conn.query(
      `SELECT s.id, s.weeks, s.week_rule, s.day_of_week, s.period, s.group_scope, s.duty_count
         FROM session s WHERE s.class_id = ? ORDER BY s.day_of_week, s.period`, [classId]
    );
    // 只排「这一周实际上课」的课次（weeks 数组 + week_rule 双条件）
    const sessions = sessRows.filter(s => week.matchesWeeks(s.weeks, wk, s.week_rule));

    // ── 轮转名册 ──
    // 本周已有的 AUTO 值日马上会被下面的 DELETE 删掉，先扣掉它们 —— duty_count 是
    // 统计口径（累计值日次数），重复生成同一周不能把它算重。
    const [memRows] = await conn.query(
      "SELECT id, student_no, group_tag, duty_count FROM member WHERE class_id = ? AND status = 'ACTIVE' AND " + NOT_TEST() + " AND group_tag <> 'X' AND duty_off = 0", [classId]
    );
    const [oldAuto] = await conn.query(
      "SELECT member_id, COUNT(*) AS n FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO' GROUP BY member_id", [classId, wk]
    );
    const ownAuto = new Map(oldAuto.map(r => [Number(r.member_id), Number(r.n) || 0]));
    const roster = memRows.map(m => ({
      id: m.id,
      seq: week.seqOf(m.student_no),
      group: m.group_tag,
      // mark 只是 duty_count 的搬运工，**不参与选人**（轮转位置由游标承载）
      mark: Math.max(0, (Number(m.duty_count) || 0) - (ownAuto.get(Number(m.id)) || 0))
    })).sort((a, b) => (a.seq - b.seq) || (a.id - b.id));
    const seqById = new Map(roster.map(r => [r.id, r.seq]));
    /* 轮转起点 = 本周快照（重复生成同一周 ⇒ 幂等）；无快照则接着全局游标。 */
    const curStart = await loadWeekCursors(conn, classId, wk, loadCursors(cfg));
    const state = buildState(roster, curStart);

    await conn.query("DELETE FROM duty WHERE class_id = ? AND week = ? AND source = 'AUTO'", [classId, wk]);
    // v0.7.25：作废全部「悬空申请」（引用的 duty 已不存在）—— 排班重建/删除会不断产生这种幽灵，
    // 它们永远无法被确认却一直计入「待确认」提醒（§73）。每周重建时顺带清一次，保证计数=列表。
    await conn.query(
      `UPDATE swap_request SET status = 'CANCELLED'
        WHERE status IN ('PENDING_PEER','PENDING_ADMIN')
          AND NOT EXISTS (SELECT 1 FROM duty d WHERE d.id = duty_id)`
    );

    // 手动排班视为已占用：不重排他，也算「本周已经值过日」（一轮里每人只排一次）
    const [manualRows] = await conn.query(
      "SELECT DISTINCT session_id, class_date, member_id FROM duty WHERE class_id = ? AND week = ? AND source = 'MANUAL' AND status <> 'SWAPPED_OUT'",
      [classId, wk]
    );
    const assignedByDate = {};
    const assignedWeek = new Set();
    /* 已被手动排班占用的课次 -> 人（2026-10-08：手动排满的课次要原样保留，只补空缺）。
     * 与 schedule.generate / buildCleaningPlan 三处同口径，改一处必须同步另两处。 */
    const manualFilled = {};
    const seqGroupOf = new Map(roster.map(r => [r.seq, r.group === 'B' ? 'B' : 'A']));
    manualRows.forEach(m => {
      const date = String(m.class_date).slice(0, 10);
      (assignedByDate[date] = assignedByDate[date] || new Set()).add(Number(m.member_id));
      assignedWeek.add(Number(m.member_id));
      (manualFilled[Number(m.session_id)] = manualFilled[Number(m.session_id)] || new Set()).add(Number(m.member_id));
      // 手动排的人算「本轮已排」，周自动生成从他之后接着往下排
      const q = seqById.get(Number(m.member_id));
      if (q) state.used[seqGroupOf.get(q) || 'A'].add(q);
    });

    /* 轮转取人顺序 = 实际上课日期顺序（同日按节次、课次 id）。
     * ⚠️ 与 schedule.generate 同一道坑（2026-10-05 国庆调休 10/7→10/10 实锤）：
     * 不能按 SQL 的 day_of_week 顺序迭代 —— 调休（MOVE）只是把「周三的课」挪到周六，
     * session 的 day_of_week 仍是 3，于是调来的 10/10 被排在 10/8、10/9 前面分配序号。
     * 自动生成与手动「一键生成」必须同口径，否则两条链路给出的名单不一致。 */
    const rotatePlan = [];
    for (const s of sessions) {
      // 临时调课优先：OFF → 本周这节课不上；MOVE → 用调课后的星期 / 节次算日期
      const slot = week.resolveSlot(s.id, s.day_of_week, s.period, wk, shifts);
      if (!slot) { shiftSkipped += 1; continue; }
      // 法定放假且无调课 → 本周不上，不排值日
      const classDate = week.classDateOf(cfg, wk, slot.day, cal);
      if (!classDate) { holidaySkipped += 1; continue; }
      rotatePlan.push({ s, slot, classDate });
    }
    rotatePlan.sort((a, b) => (
      a.classDate < b.classDate ? -1
        : a.classDate > b.classDate ? 1
          : (Number(a.slot.period) - Number(b.slot.period)) || (a.s.id - b.s.id)
    ));

    for (const { s, slot, classDate } of rotatePlan) {
      // 名额 = 应排人数 − 已被手动排班占用的人数；排满则整课次跳过（游标也不为它前进）
      const alreadyFilled = (manualFilled[Number(s.id)] || new Set()).size;
      // duty_count=0 = 不排值日：?? 窄化让 0 保持 0（|| 1 会把 0 误当 1 排 1 人）
      const n = Math.max(0, Number(s.duty_count ?? 1) - alreadyFilled);
      if (n <= 0) continue;
      const blocks = await loadDayBlocks(conn, classDate);
      // 取人 = 与超管手动「一键生成」完全同源（`common/schedule-core.js` 的 pickBySeq）。
      // 旧版这里的 rotationPick 已被删除（v0.7.31 轮转位置彻底改成显式游标）。
      const picked = pickBySeq(roster, s.group_scope, n, state, {
        avoidSeqs: toSeqSet(assignedByDate[classDate] || new Set(), seqById),
        busySeqs: toSeqSet(blocks.busy, seqById),
        inBatchSeqs: toSeqSet(assignedByDate[classDate] || new Set(), seqById),
        avoidSameDay: !!avoidSameDay,
        // 本周已值过日的人（含手动排班）优先不排，没人时才用
        softSeqs: toSeqSet(assignedWeek, seqById)
      });
      if (picked.wrapped) roundReset = true;
      picked.chosen.forEach(m => { assignedWeek.add(m.id); });
      // duty_count 是统计口径（累计值日次数），每排一人 +1，须与实际 duty 行对称
      picked.chosen.forEach(m => { m.mark += 1; });
      if (picked.short > 0) {
        warnings.push('周' + (DAY_TEXT[slot.day - 1] || '?') + '第' + slot.period
          + '节候选不足（还需 ' + picked.short + ' 人）');
      }
      for (const m of picked.chosen) {
        try {
          const ins = await conn.query(
            `INSERT IGNORE INTO duty (class_id, session_id, week, class_date, member_id, status, source)
             VALUES (?, ?, ?, ?, ?, 'PENDING', 'AUTO')`, [classId, s.id, wk, classDate, m.id]
          );
          // 已存在同课次同人 → 幂等跳过；**不能**在这里给 duty_count 加一，
          // 否则这一行被 IGNORE 掉了却仍然计数（旧版就是无条件 +1）
          if (!ins[0] || !ins[0].affectedRows) continue;
          await conn.query('UPDATE member SET last_duty_at = ? WHERE id = ?', [classDate, m.id]);
          created += 1;
          (assignedByDate[classDate] = assignedByDate[classDate] || new Set()).add(m.id);
        } catch (e) { /* 幂等 */ }
      }
    }

    // 回写统计口径 duty_count（累计值日次数，须与实际 duty 行对称；TDSQL 一次只允许一条语句）。
    // ⚠️ 这里只回写「统计」，轮转位置由下方游标落库承载，二者彻底解耦。
    if (roster.length) {
      const caseSql = 'UPDATE member SET duty_count = CASE id '
        + roster.map(r => `WHEN ${Number(r.id)} THEN ${Number(r.mark)}`).join(' ')
        + ' END WHERE id IN (' + roster.map(r => Number(r.id)).join(',') + ')';
      await conn.query(caseSql);
    }
    /* 落游标：先写本周快照（start 只在首次落，保证重复生成幂等），
     * 再把全局游标对齐到「已生成的最大周次的结束游标」。 */
    const curEnd = { A: state.cursors.A, B: state.cursors.B };
    cursorStr = curStart.A + '/' + curStart.B + ' → ' + curEnd.A + '/' + curEnd.B;
    await saveWeekCursors(conn, classId, wk, curStart, curEnd);
    await syncGlobalCursors(conn, classId);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  return { created, week: wk, roundReset, holidaySkipped, shiftSkipped, cursor: cursorStr, warnings };
}

/** 每日：昨日未确认 → EXPIRED */
async function markExpired(pool) {
  const today = week.todayStr();
  const [r] = await pool.query(
    "UPDATE duty SET status = 'EXPIRED' WHERE status IN ('PENDING','ONGOING') AND class_date < ?", [today]
  );
  return { expired: r.affectedRows };
}

/**
 * 假条图片回收站清理（每日 06:00，幂等）。
 * 清的是什么：请假**结束**后假条就没用了，留 7 天当「后悔药」，到期物理删除云存储文件。
 *   · APPROVED：end_date 次日 0 点进归档态（前端显示「N 天后清除」），
 *     清除日 = end_date + 8 天（归档起算满 7 天）
 *     例：请到 10-08 → 10-09 凌晨归档 → 10-16 凌晨删除
 *   · CANCELLED：撤销即归档，清除日 = cancelled_at + 7 天
 * ⚠️ 必须**先删云存储再清列**，且两者都要做 —— 只清列会让云存储只涨不减。
 * ⚠️ 与本函数里的「值日 / 换班 / 审核」清理互不干涉，删失败不影响其它任务。
 */
async function purgeLeaveImages(pool) {
  const [rows] = await pool.query(
    `SELECT id, leave_image FROM leave_request
      WHERE leave_image IS NOT NULL AND leave_image <> ''
        AND (
          (status = 'APPROVED'  AND end_date <= DATE_SUB(CURDATE(), INTERVAL 8 DAY))
       OR (status = 'CANCELLED' AND cancelled_at <= DATE_SUB(NOW(), INTERVAL 7 DAY))
        )
      LIMIT 200`
  );
  let deleted = 0;
  let cleared = 0;
  for (const r of rows) {
    try {
      await cloud.deleteFile({ fileList: [r.leave_image] });
      deleted += 1;
    } catch (e) { /* 文件可能已被手工删掉：照样清列，避免下次再捞一遍 */ }
    const [u] = await pool.query('UPDATE leave_request SET leave_image = NULL WHERE id = ?', [r.id]);
    cleared += Number(u.affectedRows) || 0;
  }
  return { scanned: rows.length, fileDeleted: deleted, columnCleared: cleared };
}

/**
 * 作业附件回收站清理（每日一趟，幂等）：
 * 截止满 `LIMIT.PURGE_AFTER_DAYS` 天的作业，**物理删除**其全部云存储文件实体，
 * 但**保留**提交记录与状态（只把 `homework_file` 行删掉、`homework.purged` 置 1）。
 *
 * ⚠️ 删的是文件实体，`homework_submit` 一行不动 —— 班委事后仍能查「完成情况」，
 *    只是打不开原始文件（这正是需求里的「仅保留提交记录与状态」）。
 * ⚠️ 幂等：`purged=1` 后不再重复处理；中途失败下次 daily 会重试。
 */
async function purgeHomeworkFiles(pool) {
  const { LIMIT } = require('./common/homework-limit');
  const [rows] = await pool.query(
    `SELECT h.id FROM homework h
      WHERE h.purged = 0 AND h.due_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [LIMIT.PURGE_AFTER_DAYS]
  );
  let filesDeleted = 0;
  let assignmentsPurged = 0;
  for (const h of rows) {
    const [files] = await pool.query(
      'SELECT id, file_id FROM homework_file WHERE homework_id = ?', [Number(h.id)]
    );
    const ids = files.map(f => String(f.file_id || '')).filter(Boolean);
    if (ids.length) {
      try {
        await cloud.deleteFile({ fileList: ids });
        filesDeleted += ids.length;
      } catch (e) { /* 文件可能已被手工删掉：照样清记录 */ }
    }
    await pool.query('DELETE FROM homework_file WHERE homework_id = ?', [Number(h.id)]);
    await pool.query('UPDATE homework SET purged = 1 WHERE id = ?', [Number(h.id)]);
    assignmentsPurged += 1;
  }
  return { scanned: rows.length, filesDeleted, assignmentsPurged };
}

/** 每小时：超时申请撤销 + 审核超时下架 */
async function hourlyJobs(pool) {
  const now = week.nowStamp();
  const [sw] = await pool.query(
    "UPDATE swap_request SET status = 'CANCELLED' WHERE status = 'PENDING_PEER' AND expire_at < ?", [now]
  );
  const cutoff = week.stampOf(Date.now() - 24 * 3600 * 1000);
  const [atts] = await pool.query(
    "SELECT id, file_id FROM attachment WHERE audit_status = 'AUDITING' AND created_at < ?", [cutoff]
  );
  let blocked = 0;
  for (const a of atts) {
    await pool.query("UPDATE attachment SET audit_status = 'BLOCKED' WHERE id = ?", [a.id]);
    try { await cloud.deleteFile({ fileList: [a.file_id] }); } catch (e) { /* 忽略 */ }
    blocked += 1;
  }
  return { swapCancelled: sw.affectedRows, auditBlocked: blocked };
}

/* ---------- 订阅消息（值日提醒） ---------- */

/**
 * 订阅消息关键词字段名。必须与公众平台所选模板的关键词**数量与类型**一致，
 * 模板不同时只改这组环境变量即可，不用动代码。
 *
 * 当前线上模板（编号 17406「日程提醒」/ 类目：信息查询）：
 *   日程主题 thing1 · 备注 thing5 · 课程名称 thing8   ← 三个都是 thing 类，各限 20 字符
 * 对应关系（2026-09-27 实测：模板 jU9_n9F15wuTab9dQyehEGrd9fprneyXTiYt3dm0xok 的关键词是 thing1/thing5/thing8）：
 *   TEMPLATE_REMIND_F_TITLE    默认 thing1  日程主题  ← 「明天有 N 项值日」
 *   TEMPLATE_REMIND_F_DIGEST   应配 thing5   备注      ← 具体值日内容（18点前打扫410、第2节大学英语）
 *   TEMPLATE_REMIND_F_COURSE   应配 thing8   课程名称  ← 第一门课程名（纯保洁日填课次名：周二=410大扫除，其余=打扫410）
 *   TEMPLATE_REMIND_F_DATE     默认未配置             ← 模板若带「日期」关键词才需要设（如 date2）
 *
 * ⚠️ 只填模板里真实存在的关键词。多传一个不存在的字段（例如模板没有 date 却传了 date2）
 *    会直接 47003 发送失败，所以日期字段默认留空、按需开启。
 */
const REMIND_FIELDS = {
  title: process.env.TEMPLATE_REMIND_F_TITLE || 'thing1',
  // 模板 jU9_n9F15wuTab9dQyehEGrd9fprneyXTiYt3dm0xok 真实关键词为 thing1/thing5/thing8；
  // env 已将上述字段映射到正确关键词，默认兜底也用 thing5/thing8 防止 env 丢失时发错格。
  digest: process.env.TEMPLATE_REMIND_F_DIGEST || 'thing5',
  course: process.env.TEMPLATE_REMIND_F_COURSE || 'thing8',
  date: process.env.TEMPLATE_REMIND_F_DATE || ''
};

/** 截断：thing 类关键词上限 20 个字符，超长会导致整条消息发送失败 */
function cut20(s) {
  const t = String(s == null ? '' : s);
  return t.length <= 20 ? t : t.slice(0, 19) + '…';
}

/** 日期类关键词用中文格式，如 2026年09月25日 */
function cnDate(dateStr) {
  const p = String(dateStr).split('-');
  return p.length === 3 ? (p[0] + '年' + p[1] + '月' + p[2] + '日') : String(dateStr);
}

/**
 * 值日订阅提醒（21:00 预告明天 / 07:00 提醒今天，**同源实现**）。
 *
 * 规则（2026-09-24 定稿，2026-09-26 加「当天早上」与「教室」）：
 *  1. 只提醒「该日有值日」的同学；`when='tomorrow'` 取明天、`'today'` 取今天。
 *  2. 一人一条：一次性订阅「同意一次 = 1 条额度」，一人当天多节课/还有保洁时必须
 *     合并成一条发，否则第二条一定失败。
 *  3. 未配置 TEMPLATE_REMIND 直接跳过，不影响其它定时任务。
 *  4. 43101 = 用户未订阅或额度用尽，属正常情况，静默计数不上报错误。
 *  5. 保洁（session.kind = 'CLEAN'）统一写「18点前+课次名」（周二=410大扫除，其余=打扫410），不写「第4节」——
 *     它挂在第 4 节上只是为了有个排班位，学生看到「第 4 节打扫 410」会以为是去上课。
 *  6. **具体课次 + 教室**（用户需求②原话：「提醒第二天有你的值日，具体课次和教室」）：
 *     「备注」这一格放「时间地点」= 第N节 + 教室，「课程名称」那一格放课程名。
 *     两格分装是必要的 —— thing 类关键词每格上限 20 字符，课次+教室+课名塞一格
 *     必然被截断（`cut20` 会补省略号，学生看到的是「第2节大学英语(4…」）。
 *
 * @param {'tomorrow'|'today'} when 提醒的是哪一天的值日
 */
async function remindDuty(pool, when) {
  const templateId = process.env.TEMPLATE_REMIND;
  if (!templateId) return { skipped: true, reason: 'no template' };
  const isToday = when === 'today';
  // 东八区「今天 / 明天」：fmtDate 内部已 +8h，这里只加一天。重复再加 8h 会算成后天（曾踩过）。
  const date = isToday ? week.todayStr() : week.fmtDate(new Date(Date.now() + DAY_MS));
  const lead = isToday ? '今天' : '明天';
  const [rows] = await pool.query(
    `SELECT d.id, m.id AS memberId, m.openid, m.name, s.period, s.kind AS sessionKind,
            c.name AS courseName, c.room AS room
       FROM duty d
       JOIN member m ON m.id = d.member_id
       JOIN session s ON s.id = d.session_id
       JOIN course c ON c.id = s.course_id
      WHERE d.class_date = ? AND d.status IN ('PENDING','ONGOING')
        AND m.openid IS NOT NULL AND m.status = 'ACTIVE'
      ORDER BY m.id, s.period`,
    [date]
  );
  if (!rows.length) return { when, date, receivers: 0, sent: 0, refused: 0, failed: 0 };

  // 按 openid 聚合：一个人当天可能既上课值日、又要打扫 410
  const byOpenid = new Map();
  rows.forEach((r) => {
    const cur = byOpenid.get(r.openid) || { name: r.name, memberIds: [], items: [], courses: [], cleanCourses: [] };
    if (!cur.memberIds.includes(Number(r.memberId))) cur.memberIds.push(Number(r.memberId));
    if (r.sessionKind === 'CLEAN') {
      // 保洁课次名来自课次对应的 course（周二=「410大扫除」、其余=「打扫410」），
      // 不再写死「打扫410」，保证「每周二全校大扫除」的对外名称正确。
      cur.items.push('18点前' + (r.courseName || '打扫410'));
      /* 「课程名称」格的保洁兜底也必须是**这条课次自己的名字**：
       * 纯保洁日 courses 为空，只能拿课次名顶格 —— 若统一写「打扫410」，
       * 周二同学收到的通知就会说成「打扫410」，与「410大扫除」的对外口径冲突。
       * 单独收一条 cleanCourses，只在 courses 为空时才用（混合日仍是纯课程名，
       * 周一/三/四/五的既有表现一字不变）。 */
      cur.cleanCourses.push(r.courseName || '打扫410');
    } else {
      // 「第2节410」= 具体课次 + 教室。教室字段（course.room）可能为空 ——
      // 空着就只写节次，不允许拿课程名去顶（课名另有「课程名称」那一格，不必重复）。
      const room = r.room ? String(r.room).trim() : '';
      cur.items.push('第' + r.period + '节' + room);
      if (r.courseName) cur.courses.push(r.courseName);
    }
    byOpenid.set(r.openid, cur);
  });

  const f = REMIND_FIELDS;
  let sent = 0, refused = 0, failed = 0;
  const okOpenids = [], refOpenids = [];
  for (const [openid, info] of byOpenid) {
    const data = {};
    data[f.title] = { value: cut20(lead + '有 ' + info.items.length + ' 项值日') };
    data[f.digest] = { value: cut20(info.items.join('、')) };
    // 纯保洁日没有课程名，「课程名称」这一格不能空着 —— 用**当天保洁课次名**顶上
    // （周二=「410大扫除」，其余=「打扫410」）；混合日仍只写课程名，与既有表现一致。
    data[f.course] = { value: cut20(info.courses.join('、') || info.cleanCourses.join('、') || '打扫410') };
    if (f.date) data[f.date] = { value: cnDate(date) };
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId,
        page: process.env.TEMPLATE_REMIND_PAGE || 'pages/duty/index',
        miniprogramState: process.env.TEMPLATE_REMIND_STATE || 'formal',
        lang: 'zh_CN',
        data
      });
      sent += 1;
      okOpenids.push(openid);
    } catch (e) {
      const code = Number((e && (e.errCode || e.errcode)) || 0);
      if (code === 43101) { refused += 1; refOpenids.push(openid); }
      else {
        failed += 1;
        console.error('[cron-weekly] remind send fail', code, String((e && e.errMsg) || e).slice(0, 160));
      }
    }
  }

  /*
   * 「额度耗尽」标记（v0.7.15）：一次性订阅没有长期通道，额度用尽后发送静默失败，
   * 学生完全无感知 —— 必须把这件事写回库里，前端才能把人拉回来重新授权。
   *   发送成功 → remind_block = 0（说明他还有额度，之前误标的一并纠正）
   *   43101    → remind_block = 1（首页据此弹「微信提醒已失效，点此重新开启」）
   * 其它错误码不动标记（可能是模板/权限问题，不是学生的额度问题）。
   */
  if (okOpenids.length) {
    await pool.query(
      'UPDATE member SET remind_block = 0 WHERE openid IN (' + okOpenids.map(() => '?').join(',') + ')', okOpenids
    );
  }
  if (refOpenids.length) {
    await pool.query(
      'UPDATE member SET remind_block = 1 WHERE openid IN (' + refOpenids.map(() => '?').join(',') + ')', refOpenids
    );
  }
  return { when, date, receivers: byOpenid.size, sent, refused, failed, blockSet: refOpenids.length, blockClear: okOpenids.length };
}

exports.main = async (event) => {
  const pool = getPool();
  const trigger = (event && (event.TriggerName || event.triggerName)) || '';
  const result = { trigger, at: week.nowStamp() };
  try {
    if (trigger === 'weekly') {
      // 多班级（§43）：遍历所有启用班级，逐个生成下周草稿
      const [classes] = await pool.query('SELECT id, term_start, total_weeks FROM `class` WHERE is_active = 1 ORDER BY id');
      const perClass = [];
      for (const c of classes) {
        const classId = Number(c.id);
        const [rulesRows] = await pool.query('SELECT cron_enabled FROM schedule_rules WHERE class_id = ? ORDER BY id LIMIT 1', [classId]);
        const enabled = !rulesRows.length || !!rulesRows[0].cron_enabled;
        if (!enabled) {
          perClass.push({ classId, skipped: true, reason: 'cron disabled' });
          continue;
        }
        const nextWeek = week.currentWeek({ term_start: week.fmtDate(new Date(c.term_start)), total_weeks: c.total_weeks }) + 1;
        try {
          const r = await generateWeek(pool, nextWeek, classId);
          perClass.push({ classId, ...r });
        } catch (e) {
          perClass.push({ classId, error: String((e && e.message) || e) });
        }
      }
      result.weekly = { classes: perClass };
    } else if (trigger === 'daily') {
      result.daily = await markExpired(pool);
      // 假条图片回收站：结束后满 7 天物理清除（与过期扫描同一趟，幂等）
      result.leaveImagePurge = await purgeLeaveImages(pool);
      // 作业附件回收站：截止满 7 天物理清除（只删文件实体，保留提交记录与状态）
      result.homeworkPurge = await purgeHomeworkFiles(pool);
    } else if (trigger === 'remind') {
      // 每日 21:00：预告明天
      result.remind = await remindDuty(pool, 'tomorrow');
    } else if (trigger === 'remindAM') {
      /*
       * ⚠️ 额度优化（2026-10-12）：一次性订阅**一条额度换一条消息**，而 21:00 与 07:00
       *    **共用同一个模板**（`TEMPLATE_REMIND`）⇒ 两条一起发 = **每天烧 2 个额度**。
       *    一学期 18 周 × 5 天 ≈ 90 天 ⇒ 需要 180 次授权，学生不可能点得到；
       *    这正是「43101 额度耗尽 → remind_block=1」的根因。
       *    默认只发 21:00（当晚预告：今晚就知道明天第几节、哪个教室，**行动价值最高**
       *    —— 今晚就能把东西准备好；早上那条虽离出发更近，但来不及准备）。
       *    ⚠️ 触发器**保留不删**：dispatch 要靠它进这个分支，且触发器是**整体覆盖**语义；
       *    这里只是不发消息。切换：环境变量 `REMIND_MODE`
       *    = evening（默认，只 21:00）/ morning（只 07:00）/ both（恢复两条）。
       */
      const rmode = String(process.env.REMIND_MODE || 'evening');
      if (rmode === 'morning' || rmode === 'both') {
        result.remindAM = await remindDuty(pool, 'today');
      } else {
        result.remindAM = { skipped: true, reason: 'REMIND_MODE=' + rmode + '：额度优化，每天只发一条' };
      }
    } else {
      // hourly 与手动触发：跑全部幂等任务，保证任何入口都收敛
      result.hourly = await hourlyJobs(pool);
      result.daily = await markExpired(pool);
      result.leaveImagePurge = await purgeLeaveImages(pool);
    }
    console.log(JSON.stringify({ fn: 'cron-weekly', result }));
    return { errCode: 0, errMsg: 'ok', data: result };
  } catch (e) {
    console.error('[cron-weekly] failed', trigger, e);
    return { errCode: 50000, errMsg: String(e && e.message || e), data: result };
  }
};
