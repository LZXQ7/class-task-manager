/**
 * 使用统计（2026-10-16）
 * ------------------------------------------------------------
 * 聚合 usage_event 表：
 *   · 按 event 统计 PV（浏览/点击次数）与 UV（去重人数），支持按班级 + 时间范围过滤；
 *   · 给出 Top 事件近 N 日逐日趋势，以及整体每日活跃总览（每日总 PV）。
 * 仅超管可用（admin-web 全局已拦登录态；这里不再二次鉴权，调用方已确保 isSuper）。
 */
const { getPool } = require('../common/db');
// 🔴 铁律：所有人员列表一律不展示测试账号（学号 2608057499xx 段），NOT_TEST 是唯一真源
const { NOT_TEST } = require('../common/test-account');

/** 解析时间范围：<=0 表示不限；上限 365 天防止误传超大值 */
function parseDays(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(n, 365);
}

/**
 * 时间范围条件（col 带表别名前缀，如 'ts' / 'e.ts'）。
 *  · days <= 0：不限；
 *  · days === 1：今天（本地时区当天 0 点起，DATE(col)=CURDATE()），
 *    而非 INTERVAL 1 DAY（那是「近 24h」，会把昨天同时段也算进来，与「今天」语义不符）；
 *  · 其它：col >= NOW() - days 天，与前端「近 N 天」连续轴一致。
 * 上限 365 由 parseDays 保证。
 */
function daysCond(days, col) {
  if (days === 1) return { sql: 'DATE(' + col + ') = CURDATE()', args: [] };
  if (days) return { sql: col + ' >= DATE_SUB(NOW(), INTERVAL ? DAY)', args: [days] };
  return { sql: '', args: [] };
}

/** 构造 WHERE 与参数（classId=0 表示全部班级） */
function buildFilter(query) {
  const days = parseDays(query && query.days);
  const classId = parseInt((query && query.classId) || '0', 10) || 0;
  const where = [];
  const args = [];
  if (classId) { where.push('class_id = ?'); args.push(classId); }
  const dc = daysCond(days, 'ts');
  if (dc.sql) { where.push(dc.sql); args.push(...dc.args); }
  return { days, classId, where, args };
}

function whereClause(where) {
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

async function usage(query) {
  const { days, classId, where, args } = buildFilter(query);
  const w = whereClause(where);
  const pool = getPool();

  // 总计（PV / UV）
  const [tot] = await pool.query(
    `SELECT COUNT(*) AS pv, COUNT(DISTINCT openid) AS uv FROM usage_event ${w}`,
    args
  );

  // 明细排行（按 event+kind+ref 分组，按 PV 降序）
  //  · ref 参与分组：仅 fee_open 会带 ref（class|league），据此区分「班费」「团费」；
  //    其余事件 ref 为空串，不会多拆行。
  //  · 日期一律 DATE_FORMAT 成字符串再返回：mysql2 会把 DATE/DATETIME 转 JS Date，
  //    再 JSON 序列化成 UTC ISO ⇒ 跨时区后日期会整体偏一天，前端对不上轴。
  const [rows] = await pool.query(
    `SELECT event, kind, ref, COUNT(*) AS pv, COUNT(DISTINCT openid) AS uv,
            DATE_FORMAT(MAX(ts), '%Y-%m-%d %H:%i') AS lastTs
     FROM usage_event ${w}
     GROUP BY event, kind, ref
     ORDER BY pv DESC`,
    args
  );

  // 趋势天数：原样回显（0 = 不限/全部）。
  // ⚠️ 别写 `days || 30`：0 是 falsy 会被改成 30，前端曾拿它渲染轴说明
  // （2026-10-18 修：改为前端按 days 自行判断，此处只保证回显诚实）
  const trendDays = days;

  // Top 事件（按 PV）列表，用于逐日趋势
  const [top] = await pool.query(
    `SELECT event FROM usage_event ${w} GROUP BY event ORDER BY COUNT(*) DESC LIMIT 8`,
    args
  );
  const topEvents = top.map((r) => r.event);

  let series = [];
  let daily = [];
  if (topEvents.length) {
    // 逐日趋势：Top 事件各自每日 PV
    const trendWhere = where.concat(['event IN (?)']);
    const trendArgs = args.concat([topEvents]);
    const [tr] = await pool.query(
      `SELECT event, DATE_FORMAT(DATE(ts), '%Y-%m-%d') AS d, COUNT(*) AS pv
       FROM usage_event ${whereClause(trendWhere)}
       GROUP BY event, DATE_FORMAT(DATE(ts), '%Y-%m-%d')
       ORDER BY d`,
      trendArgs
    );
    const map = {};
    tr.forEach((r) => { (map[r.event] = map[r.event] || {})[r.d] = r.pv; });
    series = topEvents.map((ev) => ({
      event: ev,
      points: Object.keys(map[ev] || {}).map((d) => ({ d, pv: map[ev][d] }))
    }));
  }

  // 整体每日总 PV（活跃度趋势）
  const [dailyRows] = await pool.query(
    `SELECT DATE_FORMAT(DATE(ts), '%Y-%m-%d') AS d, COUNT(*) AS pv
     FROM usage_event ${w}
     GROUP BY DATE_FORMAT(DATE(ts), '%Y-%m-%d')
     ORDER BY d`,
    args
  );
  daily = dailyRows.map((r) => ({ d: r.d, pv: r.pv }));

  // 成员使用明细（按人聚合）：「总使用人数」要能看到具体是谁在用。
  //  · requireBind 已保证上报者必是已绑定成员，LEFT JOIN 仍保留兜底（防历史脏数据）。
  //  · 🔴 NOT_TEST 铁律：测试账号（学号 99 段）一律不展示；m.id IS NULL 是未绑定兜底。
  //  · 🔴 本查询 JOIN 了 member / class，而 **member 也有 class_id 列** ⇒ 不能复用
  //    buildFilter 的裸列名条件（`class_id = ?`），否则报 Error 1052 二义。
  //    必须自建带 `e.` 前缀的条件（2026-10-18 实踩：classId=0 时不触发，一选班级就 500）。
  const memberConds = [];
  const memberArgs = [];
  if (classId) { memberConds.push('e.class_id = ?'); memberArgs.push(classId); }
  const dcM = daysCond(days, 'e.ts');
  if (dcM.sql) { memberConds.push(dcM.sql); memberArgs.push(...dcM.args); }
  memberConds.push('(m.id IS NULL OR ' + NOT_TEST('m') + ')');
  const memberWhere = 'WHERE ' + memberConds.join(' AND ');
  const [mem] = await pool.query(
    `SELECT e.openid, e.class_id,
            COALESCE(m.name, '（未绑定）') AS memberName,
            COALESCE(m.student_no, '') AS studentNo,
            COALESCE(c.name, '—') AS className,
            COUNT(*) AS pv,
            COUNT(DISTINCT DATE(e.ts)) AS activeDays,
            DATE_FORMAT(MAX(e.ts), '%Y-%m-%d %H:%i') AS lastTs
     FROM usage_event e
     LEFT JOIN member m ON m.openid = e.openid
     LEFT JOIN class c ON c.id = e.class_id
     ${memberWhere}
     GROUP BY e.openid, e.class_id, m.name, m.student_no, c.name
     ORDER BY pv DESC
     LIMIT 200`,
    memberArgs
  );

  // 成员功能点次细分（每个成员各功能点了多少次）：
  //   把上面 top 200 成员的 (openid, event, ref) 各自 COUNT(*) 出来，
  //   前端据此渲染「课程表 ×5 · 值日 ×2 · 团费 ×8」。
  //  · 同样带 `e.` 前缀条件 + NOT_TEST（openid 已被 top 列表过滤，这里只是兜底）。
  //  · 🔴 仍受 only_full_group_by 约束：GROUP BY 必须覆盖 SELECT 全部非聚合列
  //    （e.openid, e.event, e.ref 全在）。
  const topOpenids = mem.map((r) => r.openid);
  let eventsBreakdown = {};
  if (topOpenids.length) {
    const bc = ['e.openid IN (?)'];
    const ba = [topOpenids];
    if (classId) { bc.push('e.class_id = ?'); ba.push(classId); }
    const dcB = daysCond(days, 'e.ts');
    if (dcB.sql) { bc.push(dcB.sql); ba.push(...dcB.args); }
    bc.push('(m.id IS NULL OR ' + NOT_TEST('m') + ')');
    const [bcRows] = await pool.query(
      `SELECT e.openid, e.event, e.ref, COUNT(*) AS cnt
       FROM usage_event e
       LEFT JOIN member m ON m.openid = e.openid
       WHERE ${bc.join(' AND ')}
       GROUP BY e.openid, e.event, e.ref`,
      ba
    );
    bcRows.forEach((r) => {
      const bucket = (eventsBreakdown[r.openid] = eventsBreakdown[r.openid] || {});
      const key = (r.ref && r.ref !== '') ? r.event + '/' + r.ref : r.event;
      bucket[key] = r.cnt;
    });
  }

  return {
    total: tot[0] || { pv: 0, uv: 0 },
    rows: rows.map((r) => ({
      event: r.event,
      kind: r.kind,
      ref: r.ref || '',
      pv: r.pv,
      uv: r.uv,
      lastTs: r.lastTs || ''
    })),
    trend: { days: trendDays, series, daily },
    members: mem.map((r) => ({
      openid: r.openid,
      classId: r.class_id,
      memberName: r.memberName,
      studentNo: r.studentNo,
      className: r.className,
      pv: r.pv,
      activeDays: r.activeDays,
      lastTs: r.lastTs || '',
      eventsBreakdown: eventsBreakdown[r.openid] || {}
    }))
  };
}

module.exports = { usage };
