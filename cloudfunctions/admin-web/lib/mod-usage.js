/**
 * 使用统计（2026-10-16）
 * ------------------------------------------------------------
 * 聚合 usage_event 表：
 *   · 按 event 统计 PV（浏览/点击次数）与 UV（去重人数），支持按班级 + 时间范围过滤；
 *   · 给出 Top 事件近 N 日逐日趋势，以及整体每日活跃总览（每日总 PV）。
 * 仅超管可用（admin-web 全局已拦登录态；这里不再二次鉴权，调用方已确保 isSuper）。
 */
const { getPool } = require('../common/db');
// 🔴 铁律：所有人员列表一律不展示测试账号（学号 0000000000xx 段），NOT_TEST 是唯一真源
const { NOT_TEST } = require('../common/test-account');

/** -1 是「昨天」的专用哨兵值：0 已被「全部」占用，正数才是「近 N 天」 */
const YESTERDAY = -1;

/** 解析时间范围：0 表示不限；-1 表示昨天；正数上限 365 天防止误传超大值 */
function parseDays(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return 0;
  if (n === YESTERDAY) return YESTERDAY;
  if (n <= 0) return 0;
  return Math.min(n, 365);
}

/**
 * 时间范围条件（col 带表别名前缀，如 'ts' / 'e.ts'）。
 *  · days <= 0：不限；
 *  · days === 1：今天（本地时区当天 0 点起，DATE(col)=CURDATE()），
 *    而非 INTERVAL 1 DAY（那是「近 24h」，会把昨天同时段也算进来，与「今天」语义不符）；
 *  · days === YESTERDAY：昨天一整天（DATE(col)=CURDATE()-1 天）。
 *    ⚠️ 同样不能用「近 24h」糊弄：那会横跨昨天下午 + 今天上午，数字对不上日历日；
 *  · 其它正数：col >= NOW() - days 天，与前端「近 N 天」连续轴一致。
 * 上限 365 由 parseDays 保证。
 * 🔴 最后一个分支必须判 `days > 0`：-1 也是 truthy，若沿用旧的 truthy 判断，
 *    昨天会被当成近 N 天，拼出 INTERVAL -1 DAY（等于查未来），静默返回空数据。
 */
function daysCond(days, col) {
  if (days === 1) return { sql: 'DATE(' + col + ') = CURDATE()', args: [] };
  if (days === YESTERDAY) return { sql: 'DATE(' + col + ') = DATE_SUB(CURDATE(), INTERVAL 1 DAY)', args: [] };
  if (days > 0) return { sql: col + ' >= DATE_SUB(NOW(), INTERVAL ? DAY)', args: [days] };
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

/** 校验日期字符串 YYYY-MM-DD（避免把脏值拼进 SQL；参数化只是兜底，这里再挡一层） */
function parseCmpDate(s) {
  if (typeof s !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return s;
}

/** 区间天数（含首尾）。用 Date.parse 的 UTC 毫秒差，避免本地时区/夏令时干扰 */
function spanDays(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
}

/**
 * 归一一段对比日期（2026-11-09）：
 *  · 起点非法 → 整段作废（返回 null，调用方据此关掉对比，绝不拼半截 SQL）；
 *  · 终点缺省/非法 → 视为单日（终点 = 起点）；
 *  · 起止倒置自动纠序（否则 WHERE 恒假、查出来两段全是 0，用户以为没数据）；
 *  · 跨度上限 366 天，防误传把整表扫爆。
 */
function normalizeCmpSeg(a1, a2) {
  const from = parseCmpDate(a1);
  if (!from) return null;
  const to = parseCmpDate(a2) || from;
  const s = from > to ? to : from;
  const e = from > to ? from : to;
  const days = spanDays(s, e);
  if (days > 366) return null;
  return { from: s, to: e, days: days };
}

/**
 * 对比段聚合（2026-11-09 页面级对比）。
 *  · 口径全部来自 usage_event 自建埋点，与明细表同一真源；
 *  · 时间边界用 `ts >= from AND ts < to+1天`（可走索引），不用 DATE(ts) BETWEEN（函数包列会全表扫）；
 *  · 分时按 HOUR(ts) 聚合：单日段 = 当天分时；区间段 = 区间内每个整点的**合计**
 *    （⚠️ UV 是每个小时各自去重后相加，跨小时会重复计人，前端必须标注，不能当去重人数看）。
 */
async function cmpSegment(pool, classId, from, to) {
  const conds = [];
  const sArgs = [];
  if (classId) { conds.push('class_id = ?'); sArgs.push(classId); }
  conds.push('ts >= ?', 'ts < DATE_ADD(?, INTERVAL 1 DAY)');
  sArgs.push(from, to);
  const w = 'WHERE ' + conds.join(' AND ');
  const [aggRows] = await pool.query(
    `SELECT COUNT(*) AS pv,
            COUNT(DISTINCT openid) AS uv,
            COUNT(DISTINCT event) AS evCnt,
            COUNT(DISTINCT DATE(ts)) AS dayCnt,
            SUM(CASE WHEN kind = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
            SUM(CASE WHEN kind = 'page_view' AND event = 'home' THEN 1 ELSE 0 END) AS opens,
            SUM(CASE WHEN kind = 'action' THEN 1 ELSE 0 END) AS actions
     FROM usage_event ${w}`,
    sArgs
  );
  const [hourRows] = await pool.query(
    `SELECT HOUR(ts) AS h,
            COUNT(DISTINCT openid) AS visitUsers,
            SUM(CASE WHEN kind = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
            SUM(CASE WHEN kind = 'page_view' AND event = 'home' THEN 1 ELSE 0 END) AS opens
     FROM usage_event ${w}
     GROUP BY HOUR(ts)`,
    sArgs
  );
  const a = aggRows[0] || {};
  return {
    from: from,
    to: to,
    days: spanDays(from, to),
    pv: Number(a.pv || 0),
    uv: Number(a.uv || 0),
    evCnt: Number(a.evCnt || 0),
    dayCnt: Number(a.dayCnt || 0),
    pageViews: Number(a.pageViews || 0),
    opens: Number(a.opens || 0),
    actions: Number(a.actions || 0),
    hourly: hourRows.map((r) => ({
      h: Number(r.h || 0),
      visitUsers: Number(r.visitUsers || 0),
      opens: Number(r.opens || 0),
      pageViews: Number(r.pageViews || 0)
    }))
  };
}

async function usage(query) {
  const { days, classId, where, args } = buildFilter(query);
  const w = whereClause(where);
  const pool = getPool();
  /* 页面级对比（2026-11-09 用户要求：对比的是**整个使用统计**，不是分时那一张图）。
   *  · cmpOn=1 才查；cmpGran=day 每段单日（a2/b2 缺省等于 a1/b1），range 每段区间；
   *  · 任一段日期非法/区间倒置→自动纠正；纠正后仍非法或超 366 天 → 整块不查，返回 on:false，
   *    绝不因为一个脏参数把整个使用统计打成 500。 */
  const cmpOn = String((query && query.cmpOn) || '') === '1';
  const cmpGran = String((query && query.cmpGran) || 'day') === 'range' ? 'range' : 'day';
  const segAReq = cmpOn ? normalizeCmpSeg(query && query.cmpA1, query && query.cmpA2) : null;
  const segBReq = cmpOn ? normalizeCmpSeg(query && query.cmpB1, query && query.cmpB2) : null;
  let cmp = { on: false, gran: cmpGran };
  if (segAReq && segBReq) {
    const segA = await cmpSegment(pool, classId, segAReq.from, segAReq.to);
    const segB = await cmpSegment(pool, classId, segBReq.from, segBReq.to);
    cmp = { on: true, gran: cmpGran, a: segA, b: segB };
  }

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

  /* ---------------- 使用统计增强（2026-11-09）：活跃概况 / 分时趋势 / 访问类型 ----------------
   * 口径说明（对齐微信「小程序数据助手」的四个板块，全部由自建埋点可算的近似值）：
   *   · 日访问人数   = 当日 COUNT(DISTINCT openid)
   *   · 日打开次数   = 当日首页 page_view 次数（现有埋点没有专门的「启动」事件）
   *   · 日访问页面数 = 当日 page_view 总次数
   *   · 累计用户数   = 截至该日出现过的去重 openid
   *   · 「访问平台分布」按访问类型（页面浏览 / 功能点击）替代：现有埋点**未采集设备平台**，
   *     前端必须如实标注，不得冒称 Android/iPhone 数据。
   * 🔴 所有相对日一律用 DATEDIFF(CURDATE(), DATE(ts)) 在 SQL 里算：云函数跑 UTC、
   *    DB 跑本地时区、浏览器又是用户时区，三方各算一遍日期必然差一天。
   * 🔴 only_full_group_by：GROUP BY 的表达式必须与 SELECT 的非聚合列**逐字一致**。
   */
  const insightOffset = days === YESTERDAY ? 1 : 0;
  const num = (v) => Number(v || 0);

  // ① 分时趋势：今天 / 昨天 / 7 天前，按小时聚三个指标。
  //    固定三天对比，不跟随时间范围（截图里的「1 天前 / 7 天前」是固定参照线）。
  const iConds = [];
  const iArgs = [];
  if (classId) { iConds.push('class_id = ?'); iArgs.push(classId); }
  iConds.push('DATEDIFF(CURDATE(), DATE(ts)) IN (0, 1, 7)');
  const iWhere = 'WHERE ' + iConds.join(' AND ');
  const [hourlyRows] = await pool.query(
    `SELECT DATEDIFF(CURDATE(), DATE(ts)) AS offDay, HOUR(ts) AS h,
            COUNT(DISTINCT openid) AS visitUsers,
            SUM(CASE WHEN kind = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
            SUM(CASE WHEN kind = 'page_view' AND event = 'home' THEN 1 ELSE 0 END) AS opens
     FROM usage_event ${iWhere}
     GROUP BY DATEDIFF(CURDATE(), DATE(ts)), HOUR(ts)`,
    iArgs
  );

  // ② 活跃概况：目标日 / 前一日 / 7 日前。选「昨天」时目标日整体后移一天。
  const sConds = [];
  const sArgs = [];
  if (classId) { sConds.push('class_id = ?'); sArgs.push(classId); }
  sConds.push('DATEDIFF(CURDATE(), DATE(ts)) IN (?, ?, ?)');
  sArgs.push(insightOffset, insightOffset + 1, insightOffset + 7);
  const sWhere = 'WHERE ' + sConds.join(' AND ');
  const [summaryRows] = await pool.query(
    `SELECT DATEDIFF(CURDATE(), DATE(ts)) AS offDay,
            COUNT(DISTINCT openid) AS visitUsers,
            SUM(CASE WHEN kind = 'page_view' THEN 1 ELSE 0 END) AS pageViews,
            SUM(CASE WHEN kind = 'page_view' AND event = 'home' THEN 1 ELSE 0 END) AS opens
     FROM usage_event ${sWhere}
     GROUP BY DATEDIFF(CURDATE(), DATE(ts))`,
    sArgs
  );

  // ③ 三个时点的累计用户数（截至该日出现过的去重 openid）。
  //    ⚠️ 参数顺序按 SQL 文本里 ? 的先后：SELECT 里的三个 ? 在 WHERE class_id=? 之前，
  //       所以日期偏移必须排在 classId 前面，否则 mysql2 会把班级号绑进第一个 >= 比较。
  const cWhere = classId ? 'WHERE class_id = ?' : '';
  const cArgs = classId ? [classId] : [];
  const offsets = [insightOffset, insightOffset + 1, insightOffset + 7];
  const [cumRows] = await pool.query(
    `SELECT COUNT(DISTINCT CASE WHEN DATEDIFF(CURDATE(), DATE(ts)) >= ? THEN openid END) AS u0,
            COUNT(DISTINCT CASE WHEN DATEDIFF(CURDATE(), DATE(ts)) >= ? THEN openid END) AS u1,
            COUNT(DISTINCT CASE WHEN DATEDIFF(CURDATE(), DATE(ts)) >= ? THEN openid END) AS u7
     FROM usage_event ${cWhere}`,
    offsets.concat(cArgs)
  );

  // ④ 访问类型分布（页面浏览 / 功能点击）：跟随当前时间范围与班级范围。
  const kConds = [];
  const kArgs = [];
  if (classId) { kConds.push('class_id = ?'); kArgs.push(classId); }
  const dk = daysCond(days, 'ts');
  if (dk.sql) { kConds.push(dk.sql); kArgs.push(...dk.args); }
  const kWhere = kConds.length ? 'WHERE ' + kConds.join(' AND ') : '';
  const [kindRows] = await pool.query(
    `SELECT kind, COUNT(*) AS pv, COUNT(DISTINCT openid) AS uv
     FROM usage_event ${kWhere}
     GROUP BY kind`,
    kArgs
  );

  return {
    insights: {
      targetOffset: insightOffset,
      hourly: hourlyRows.map((r) => ({
        offDay: num(r.offDay), h: num(r.h),
        visitUsers: num(r.visitUsers), opens: num(r.opens), pageViews: num(r.pageViews)
      })),
      summary: {
        days: summaryRows.map((r) => ({
          offDay: num(r.offDay), visitUsers: num(r.visitUsers),
          opens: num(r.opens), pageViews: num(r.pageViews)
        })),
        cumulative: {
          u0: num((cumRows[0] || {}).u0),
          u1: num((cumRows[0] || {}).u1),
          u7: num((cumRows[0] || {}).u7)
        }
      },
      cmp: cmp,
      kindDist: kindRows.map((r) => ({ kind: r.kind, pv: num(r.pv), uv: num(r.uv) }))
    },
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

// 除 usage 外还导出对比相关纯函数：门禁与一次性校验脚本用真实源码跑桩，
// 不再各自抄一份 SQL（2026-11-09）
module.exports = { usage, cmpSegment, parseCmpDate, spanDays, normalizeCmpSeg };
