/**
 * 门禁：后台使用统计「昨天 + 四板块」（2026-11-09）
 *
 * 守什么：
 *  ① 时间范围新增「昨天」，语义必须是 DATE(ts) = 昨天 0 点~24 点，
 *     **绝不能退化成 INTERVAL 1 DAY（近 24h，会把今天同时段一起算进来）**；
 *  ② -1 是「昨天」的合法值，不能被 parseDays 的 `n <= 0 → 全部` 吃掉，
 *     也不能在 daysCond 里落到 `INTERVAL ? DAY` 带一个负数参数；
 *  ③ 活跃概况（三天分日指标 + 三时点累计用户）、分时趋势（三天 × 24 小时）、
 *     访问类型分布 三条新数据都由后端一次返回，且全部带班级过滤条件；
 *  ④ 前端四板块齐全、分时图固定 24 点、指标可切换、「昨天」按钮与单日时间轴；
 *  ⑤ CSS 有桌面与窄屏样式。
 *
 * 承重方式：静态断言 + **从真实源码抠出 parseDays/daysCond/buildFilter 跑桩**
 *          （断言真实生成的 SQL 与 args，不是抄一份实现）+ 内存变异自证。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function has(s, x) { return String(s).indexOf(x) >= 0; }

const FILES = {
  mod: 'cloudfunctions/admin-web/lib/mod-usage.js',
  app: 'cloudfunctions/admin-web/public/app.js',
  css: 'cloudfunctions/admin-web/public/admin.css'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = read(FILES[k]);

/** 按大括号配对抠出具名函数声明（真实源码承重，不抄实现）
 *  ⚠️ 必须带 `async` 前缀：漏掉它会把 `async function cmpSegment` 抠成普通函数，
 *     塞进 new Function 后 await 直接语法报错（2026-11-09 实踩）。 */
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(src);
  if (!m) throw new Error('extractFn 找不到 ' + name);
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

/** 把三个时间函数从真实源码加载进桩环境 */
function loadTimeFns(modSrc) {
  const parts = ['parseDays', 'daysCond', 'buildFilter']
    .map((n) => extractFn(modSrc, n)).join('\n');
  const y = /const YESTERDAY = (-?\d+);/.exec(modSrc);
  const YESTERDAY = y ? Number(y[1]) : undefined;
  return new Function('YESTERDAY', parts + '\nreturn { parseDays, daysCond, buildFilter };')(YESTERDAY);
}

/** 跑真实时间函数，断言生成的 SQL 与参数 */
function behavior(modSrc, need) {
  let f;
  try { f = loadTimeFns(modSrc); }
  catch (e) { need(false, 'timeFnsLoad:' + e.message); return; }

  need(f.parseDays('-1') === -1, 'parseYesterday');
  need(f.parseDays('1') === 1, 'parseToday');
  need(f.parseDays('0') === 0, 'parseAll');
  need(f.parseDays('abc') === 0, 'parseGarbage');
  need(f.parseDays('9999') === 365, 'parseCap');
  need(f.parseDays('-9') === 0, 'parseNegativeGarbage');

  const y = f.daysCond(-1, 'ts');
  need(y.sql === 'DATE(ts) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)', 'yesterdaySql');
  need(y.args.length === 0, 'yesterdayNoArgs');
  need(!has(y.sql, 'INTERVAL ?'), 'yesterdayNotParamInterval');
  need(f.daysCond(-1, 'e.ts').sql === 'DATE(e.ts) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)', 'yesterdayAlias');
  need(f.daysCond(1, 'ts').sql === 'DATE(ts) = CURDATE()', 'todayUnchanged');
  need(f.daysCond(30, 'ts').args[0] === 30, 'ndaysUnchanged');
  need(f.daysCond(0, 'ts').sql === '', 'allUnchanged');

  const b = f.buildFilter({ days: '-1', classId: '3' });
  need(b.days === -1, 'filterDays');
  need(b.classId === 3, 'filterClass');
  need(has(b.where.join(' AND '), 'DATE(ts) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)'), 'filterWhereSql');
  need(b.args.length === 1 && b.args[0] === 3, 'filterArgsNoMinusOne');
  const b0 = f.buildFilter({ days: '-1' });
  need(b0.args.length === 0, 'filterArgsNoClass');
}

/** 对比相关纯函数/查询从真实源码加载（不抄实现），喂桩 pool 断言生成的 SQL 与 args */
async function behaviorCmp(modSrc, need) {
  let f;
  try {
    const parts = ['parseCmpDate', 'spanDays', 'normalizeCmpSeg', 'cmpSegment']
      .map((n) => extractFn(modSrc, n)).join('\n');
    f = new Function(parts + '\nreturn { parseCmpDate, spanDays, normalizeCmpSeg, cmpSegment };')();
  } catch (e) { need(false, 'cmpFnsLoad:' + e.message); return; }

  // ① 日期归一：纠序 / 单日 / 非法 / 超长
  const n1 = f.normalizeCmpSeg('2026-11-09', '2026-11-03');
  need(n1 && n1.from === '2026-11-03' && n1.to === '2026-11-09' && n1.days === 7, 'cmpNormalizeReverse');
  const n2 = f.normalizeCmpSeg('2026-11-09', 'bad');
  need(n2 && n2.from === '2026-11-09' && n2.to === '2026-11-09' && n2.days === 1, 'cmpNormalizeSingle');
  need(f.normalizeCmpSeg('x', 'y') === null, 'cmpNormalizeBad');
  need(f.normalizeCmpSeg('2020-01-01', '2026-11-09') === null, 'cmpNormalizeTooLong');
  need(f.spanDays('2026-11-01', '2026-11-07') === 7, 'spanDays7');
  need(f.parseCmpDate('2026-13-99') === null, 'cmpDateMonthGuard');

  // ② 段聚合 SQL：两条查询、边界可走索引、无班级时不带 class_id
  const calls = [];
  const stub = {
    query: async (sql, args) => {
      calls.push({ sql: String(sql), args: (args || []).slice() });
      if (/AS evCnt/.test(sql)) {
        return [[{ pv: 12, uv: 3, evCnt: 5, dayCnt: 1, pageViews: 9, opens: 4, actions: 3 }], []];
      }
      return [[{ h: 9, visitUsers: 2, opens: 1, pageViews: 7 }], []];
    }
  };
  const seg = await f.cmpSegment(stub, 0, '2026-11-08', '2026-11-08');
  need(calls.length === 2, 'cmpTwoQueries');
  const agg = calls[0];
  need(/AS evCnt/.test(agg.sql) && /GROUP BY kind|GROUP BY/.test(agg.sql) === false, 'cmpAggSql');
  need(!/class_id = \?/.test(agg.sql), 'cmpNoClassWhenZero');
  need(agg.args.length === 2 && agg.args[0] === '2026-11-08' && agg.args[1] === '2026-11-08', 'cmpArgsNoClass');
  need(/ts >= \?/.test(agg.sql), 'cmpLowerBoundParam');
  need(/ts < DATE_ADD\(\?, INTERVAL 1 DAY\)/.test(agg.sql), 'cmpUpperBoundParam');
  need(!/DATE\(ts\) BETWEEN/.test(agg.sql), 'cmpNoFunctionWrappedColumn');
  need(/GROUP BY HOUR\(ts\)/.test(calls[1].sql), 'cmpHourlyGroupBy');
  need(seg.pv === 12 && seg.uv === 3 && seg.evCnt === 5 && seg.days === 1, 'cmpSegNumbers');
  need(seg.from === '2026-11-08' && seg.to === '2026-11-08', 'cmpSegFromTo');
  need(seg.hourly.length === 1 && seg.hourly[0].h === 9, 'cmpSegHourlyMap');

  // ③ 带 classId：参数顺序必须 classId 在前（否则班级号会被绑进日期比较）
  const seg2 = await f.cmpSegment(stub, 3, '2026-11-01', '2026-11-07');
  const agg2 = calls[calls.length - 2];
  need(/class_id = \?/.test(agg2.sql), 'cmpClassCond');
  need(agg2.args.length === 3 && agg2.args[0] === 3 &&
    agg2.args[1] === '2026-11-01' && agg2.args[2] === '2026-11-07', 'cmpArgsOrder');
  need(seg2.days === 7, 'cmpSegDays7');
}

/** 审计一份源码集合，返回问题 key 数组（async：含对比段桩测） */
async function audit(X) {
  const p = [];
  const need = (cond, key) => { if (!cond) p.push(key); };

  /* ① 后端：昨天时间分支 */
  need(has(X.mod, 'const YESTERDAY = -1;'), 'yesterdayConst');
  need(has(X.mod, 'if (n === YESTERDAY) return YESTERDAY;'), 'parseYesterdayBranch');
  need(has(X.mod, "if (days === YESTERDAY) return { sql: 'DATE(' + col + ') = DATE_SUB(CURDATE(), INTERVAL 1 DAY)', args: [] };"), 'yesterdayCondBranch');
  // -1 是 truthy：留着 `if (days)` 会把昨天错算成 INTERVAL -1 DAY
  need(has(X.mod, "if (days > 0) return { sql: col + ' >= DATE_SUB(NOW(), INTERVAL ? DAY)', args: [days] };"), 'positiveDaysOnly');
  need(!/if \(days\) return \{ sql: col \+ ' >= DATE_SUB/.test(X.mod), 'noTruthyDays');

  /* ② 后端：新数据一次返回，且班级条件不丢 */
  need(has(X.mod, 'insights: {'), 'insightsReturn');
  need(has(X.mod, 'const insightOffset = days === YESTERDAY ? 1 : 0;'), 'insightOffset');
  need(has(X.mod, 'DATEDIFF(CURDATE(), DATE(ts)) IN (0, 1, 7)'), 'hourlyThreeDays');
  need(has(X.mod, "GROUP BY DATEDIFF(CURDATE(), DATE(ts)), HOUR(ts)"), 'hourlyGroupBy');
  need(has(X.mod, "SUM(CASE WHEN kind = 'page_view' AND event = 'home' THEN 1 ELSE 0 END) AS opens"), 'opensMetric');
  need(has(X.mod, "COUNT(DISTINCT CASE WHEN DATEDIFF(CURDATE(), DATE(ts)) >= ? THEN openid END)"), 'cumulativeUsers');
  need(has(X.mod, "GROUP BY DATEDIFF(CURDATE(), DATE(ts))"), 'summaryGroupBy');
  need(has(X.mod, 'GROUP BY kind'), 'kindDistGroupBy');
  // 三条新 SQL 都必须挂班级条件（classId=0 时不能拼出裸 WHERE / 裸 AND）
  const codeOnly = X.mod.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  need(has(codeOnly, "iConds.push('class_id = ?')"), 'hourlyClassFilter');
  need(has(codeOnly, "sConds.push('class_id = ?')"), 'summaryClassFilter');
  need(has(codeOnly, "kConds.push('class_id = ?')"), 'kindClassFilter');
  need(has(codeOnly, "const cWhere = classId ? 'WHERE class_id = ?' : '';"), 'cumulativeClassFilter');
  need(has(codeOnly, "iWhere = 'WHERE ' + iConds.join(' AND ')"), 'noDanglingWhere');
  need(has(codeOnly, "kWhere = kConds.length ? 'WHERE ' + kConds.join(' AND ') : ''"), 'kindEmptyWhere');

  /* ②b 后端：页面级对比（整页使用统计，不只是分时图） */
  need(has(X.mod, 'cmp: cmp,'), 'cmpResultReturn');
  need(has(X.mod, 'async function cmpSegment(pool, classId, from, to)'), 'cmpSegmentFn');
  need(has(X.mod, "function parseCmpDate(s)"), 'cmpDateParse');
  need(has(X.mod, '/^\\d{4}-\\d{2}-\\d{2}$/'), 'cmpDateRegex');
  need(has(X.mod, "String((query && query.cmpOn) || '') === '1'"), 'cmpOnParam');
  need(has(X.mod, "String((query && query.cmpGran) || 'day') === 'range'"), 'cmpGranParam');
  // 日期归一抽成纯函数 normalizeCmpSeg：可被桩测覆盖，且「起止倒置 / 超长区间」只有一处真源
  need(has(X.mod, 'function normalizeCmpSeg('), 'cmpNormalizeFn');
  need(has(X.mod, 'const s = from > to ? to : from;'), 'cmpOrderFix');
  need(has(X.mod, 'if (days > 366) return null;'), 'cmpSpanCap');
  // 时间边界必须可走索引（ts >= ? AND ts < 次日），不能退回 DATE(ts) BETWEEN（函数包列全表扫）
  need(has(X.mod, "'ts < DATE_ADD(?, INTERVAL 1 DAY)'"), 'cmpIndexFriendly');
  need(has(codeOnly, "conds.push('class_id = ?')"), 'cmpClassFilter');
  need(has(X.mod, 'COUNT(DISTINCT event) AS evCnt'), 'cmpSegEvCnt');
  need(has(X.mod, 'GROUP BY HOUR(ts)'), 'cmpSegHourly');
  need(has(X.mod, 'days: spanDays(from, to),'), 'cmpSegDays');

  /* ③ 前端：昨天按钮 + 单日时间轴 */
  need(has(X.app, "{ d: -1, t: '昨天' }"), 'yesterdayButton');
  need(has(X.app, 'if (days === -1) { start = yesterday; end = yesterday; }'), 'yesterdayAxis');
  need(has(X.app, "? '横轴：日期（昨天，每日总次数）'"), 'yesterdayAxisNote');
  need(has(X.app, "var responseInsights = o.insights || {};"), 'readInsights');

  /* ④ 前端：三板块与 24 点分时 */
  need(has(X.app, '访问实时数据'), 'blockRealtime');
  need(has(X.app, '访问来源 Top10'), 'blockSource');
  need(has(X.app, '小程序活跃概况'), 'blockSummary');
  need(has(X.app, 'for (var h = 0; h < 24; h++)'), 'hour24Loop');
  need(has(X.app, "var TREND_METRICS = ['visitUsers', 'opens', 'pageViews'];"), 'trendMetrics');
  need(has(X.app, 'data-tm="'), 'trendMetricChips');

  /* ④b 前端：页面级对比（工具条开关 + 单日/区间 + 对比总览卡 + 分时跟随） */
  need(has(X.app, 'cmpOn: false'), 'cmpOnState');
  need(has(X.app, "cmpGran: 'day',"), 'cmpGranState');
  need(has(X.app, "cmpA1: '',"), 'cmpSegState');
  need(has(X.app, 'function trendCmpSvg('), 'trendCmpSvg');
  need(has(X.app, 'function trendGridMarkup('), 'trendGridHelper');
  need(has(X.app, 'function trendHoverLayer('), 'trendHoverHelper');
  // 对比曲线的数据源必须是 insights.cmp.a / .b（旧版读 cmpHourly 已废弃）
  need(has(X.app, 'bySeg.A[Number(r.h)]'), 'trendCmpSegSource');
  need(has(X.app, '<div class="usage-cmp">'), 'cmpToolbar');
  need(has(X.app, 'data-gran="range"'), 'cmpGranToggle');
  // 判据带后续 cardNote( 调用：只认「对比总览」四个字会被 → 对比总览X 这种变异蒙混（子串假绿）
  need(has(X.app, ">对比总览' + cardNote("), 'cmpOverviewCard');
  need(has(X.app, 'var CMP_METRICS = ['), 'cmpMetricDefs');
  // 总览卡必须真的插进 DOM（写完不挂上去 = 用户看不到，2026-11-09 变异假绿教训）
  need(has(X.app, "(cmpHtml ? '<div class=\"insight-grid\">' + cmpHtml + '</div>' : '')"), 'cmpOverviewInsert');
  need(has(X.app, 'type="date"'), 'cmpDateInput');
  need(has(X.app, 'class="cmp-date"'), 'cmpDateClass');
  need(has(X.app, "'&cmpOn='"), 'cmpFetchOn');
  need(has(X.app, "'&cmpGran='"), 'cmpFetchGran');
  need(has(X.app, "'&cmpA1='"), 'cmpFetchA1');
  need(has(X.app, "'&cmpB2='"), 'cmpFetchB2');
  need(has(X.app, 'state.cmpOn && (ins || {}).cmp && ins.cmp.on'), 'cmpHoverData');
  need(has(X.app, "kind === 'cmp'"), 'cmpExport');
  need(has(X.css, '.usage-cmp {'), 'cssCmpToolbar');
  // 对比控件必须与时间范围同排（2026-11-09 用户要求）：禁止 flex-basis:100% 独占整行
  need(!/\.usage-cmp\s*\{[^}]*flex-basis:\s*100%/.test(X.css), 'cssCmpNoFullRow');
  need(has(X.css, '.cmp-dates {'), 'cssCmpDates');
  need(has(X.css, '.cmp-pct.up'), 'cssCmpPct');
  need(has(X.css, '.seg-btn.active'), 'cssSegActive');

  need(has(X.app, 'data-sm="'), 'sourceMetricChips');
  need(has(X.app, '累计用户数'), 'metricTotalUsers');
  need(has(X.app, '日访问人数'), 'metricVisitUsers');
  need(has(X.app, '日打开次数'), 'metricOpens');
  need(has(X.app, '日访问页面数'), 'metricPageViews');
  need(has(X.app, '较前一日'), 'comparePrev');
  need(has(X.app, '较 7 日前'), 'compare7d');

  /* ⑤ 样式 */
  need(has(X.css, '.insight-grid {'), 'cssInsightGrid');
  need(has(X.css, '.trend-svg {'), 'cssTrendSvg');
  need(has(X.css, '.src-bar {'), 'cssSourceBar');
  need(has(X.css, '@media (max-width: 900px)'), 'cssMobileMedia');
  need(/\.insight-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(X.css), 'cssMobileStack');

  /* ⑥ 动效（2026-11-09）：hover 预览 / 卡片反馈 / chip / 入场
     原则：只动 transform + opacity（clip-path 为唯一豁免），曲线与时长走
     --ease-out 令牌；reduced-motion 与 hover gating 必须与动画同一笔落地。 */
  need(has(X.app, 'id="insight-tip"'), 'insightTipNode');
  need(has(X.app, 'role="tooltip"'), 'tipRole');
  need(has(X.app, 'function showInsightTip('), 'tipShow');
  need(has(X.app, 'function hideInsightTip('), 'tipHide');
  need(has(X.app, 'host.onmousemove = function (e)'), 'tipDelegate');
  need(has(X.app, 'host.onmouseleave = function ()'), 'hideOnLeave');
  need(has(X.app, "closest('[data-tip-kind]')"), 'tipKindDelegate');
  need(has(X.app, 'var TREND_GEOM = {'), 'trendGeomShared');
  need(has(X.app, 'class="trend-hover-layer"'), 'trendHoverLayer');
  need(has(X.app, 'class="trend-crosshair"'), 'trendCrosshair');
  need(has(X.app, 'data-tip-kind="source"'), 'sourceTipData');
  need(has(X.app, 'class="card-hd-action"'), 'cardHoverAction');
  need(has(X.app, 'function downloadCsv('), 'csvExport');
  need(has(X.app, 'function swapIn('), 'metricSwap');
  need(has(X.app, 'is-swapped'), 'swapClass');
  need(has(X.app, '--enter-delay:'), 'staggerDelayVar');

  need(has(X.css, '--ease-out: cubic-bezier(0.23, 1, 0.32, 1);'), 'easeToken');
  need(has(X.css, '.insight-tip.is-visible'), 'tipVisibleRule');
  need(has(X.css, 'transition: opacity .16s var(--ease-out), transform .16s var(--ease-out);'), 'tipMotionProps');
  need(has(X.css, '.trend-crosshair {'), 'crosshairStyle');
  need(has(X.css, '.trend-hover-layer.is-active'), 'crosshairActive');
  need(has(X.css, '.card-insight::after'), 'cardHoverShadow');
  // 用「名称 + 左花括号」精确判据：只查前缀子串会被 `@keyframes card-enter-x` 蒙混过去
  need(/@keyframes card-enter\s*\{/.test(X.css), 'cardEnterKeyframes');
  need(/@keyframes insight-reveal\s*\{/.test(X.css), 'revealKeyframes');
  need(has(X.css, 'animation: card-enter .4s var(--ease-out) backwards;'), 'cardEnterUsed');
  need(has(X.css, 'animation-delay: var(--enter-delay'), 'staggerCss');
  need(has(X.css, '@media (prefers-reduced-motion: reduce)'), 'reducedMotion');
  need(has(X.css, '@media (hover: hover) and (pointer: fine)'), 'hoverGating');
  // 反模式：这些一出现就是评审硬阻塞，不是风格偏好
  need(!/transition\s*:\s*all/.test(X.css), 'noTransitionAll');
  need(!/scale\(0\)/.test(X.css), 'noScaleZero');
  need(!/transition\s*:[^;]*\bease-in(?!-)/.test(X.css), 'noEaseInOnUI');

  /* ⑦ 折线平滑曲线 + 线下渐变面积（对齐 We分析 视觉） */
  need(has(X.app, 'function smoothTrendPath('), 'trendSmoothFn');
  need(has(X.app, 'function trendAreaPath('), 'trendAreaFn');
  need(has(X.app, 'class="trend-area"'), 'trendAreaClass');
  need(has(X.app, '<linearGradient'), 'trendGrad');
  need(has(X.app, "' C '"), 'trendBezierCmd');
  // hover 数据点不再读 points 属性（曲线无该属性），改用同一套 trendX/trendY 映射
  need(has(X.app, "dot.setAttribute('cx', trendX(hh, g)"), 'trendDotX');
  need(has(X.app, "dot.setAttribute('cy', trendY(v, g, maxVh)"), 'trendDotY');

  behavior(X.mod, need);
  await behaviorCmp(X.mod, need);
  return p;
}

/* ---------------- 变异自证：去掉任一环节，审计必须翻红 ---------------- */
const MUTANTS = [
  { key: 'yesterdayConst', file: 'mod', from: 'const YESTERDAY = -1;', to: 'const YESTERDAY = -2;' },
  { key: 'parseYesterdayBranch', file: 'mod', from: 'if (n === YESTERDAY) return YESTERDAY;', to: '' },
  { key: 'yesterdayCondBranch', file: 'mod', from: 'DATE_SUB(CURDATE(), INTERVAL 1 DAY)\', args: [] };', to: 'DATE_SUB(NOW(), INTERVAL 1 DAY)\', args: [] };' },
  { key: 'positiveDaysOnly', file: 'mod', from: 'if (days > 0) return { sql:', to: 'if (days) return { sql:' },
  { key: 'hourlyClassFilter', file: 'mod', from: "iConds.push('class_id = ?');", to: '' },
  { key: 'cumulativeUsers', file: 'mod', from: 'COUNT(DISTINCT CASE WHEN', to: 'COUNT(CASE WHEN' },
  { key: 'hourlyGroupBy', file: 'mod', from: 'GROUP BY DATEDIFF(CURDATE(), DATE(ts)), HOUR(ts)', to: 'GROUP BY HOUR(ts)' },
  { key: 'yesterdayButton', file: 'app', from: "{ d: -1, t: '昨天' }, ", to: '' },
  { key: 'yesterdayAxis', file: 'app', from: 'if (days === -1) { start = yesterday; end = yesterday; }', to: '' },
  { key: 'hour24Loop', file: 'app', from: 'for (var h = 0; h < 24; h++)', to: 'for (var h = 0; h < 12; h++)' },
  { key: 'trendMetrics', file: 'app', from: "var TREND_METRICS = ['visitUsers', 'opens', 'pageViews'];", to: "var TREND_METRICS = ['visitUsers'];" },
  { key: 'insightTipNode', file: 'app', from: 'id="insight-tip"', to: 'id="insight-tip-x"' },
  { key: 'tipDelegate', file: 'app', from: 'host.onmousemove = function (e)', to: 'host.onclick = function (e)' },
  { key: 'hideOnLeave', file: 'app', from: 'host.onmouseleave = function ()', to: 'host.onmouseleave = null;' },
  { key: 'trendCrosshair', file: 'app', from: 'class="trend-crosshair"', to: 'class="trend-crosshair-x"' },
  { key: 'sourceTipData', file: 'app', from: 'data-tip-kind="source"', to: 'data-tip-kind="src"' },
  { key: 'cardHoverAction', file: 'app', from: 'class="card-hd-action"', to: 'class="card-hd-action-x"' },
  { key: 'staggerDelayVar', file: 'app', from: '--enter-delay:', to: '--delay-x:' },
  { key: 'easeToken', file: 'css', from: '--ease-out: cubic-bezier(0.23, 1, 0.32, 1);', to: '--ease-out: ease;' },
  { key: 'tipMotionProps', file: 'css', from: 'transition: opacity .16s var(--ease-out), transform .16s var(--ease-out);', to: 'transition: all .16s;' },
  { key: 'reducedMotion', file: 'css', from: '@media (prefers-reduced-motion: reduce)', to: '@media (prefers-reduced-motion: no-preference)' },
  { key: 'hoverGating', file: 'css', from: '@media (hover: hover) and (pointer: fine)', to: '@media (min-width: 1px)' },
  { key: 'cardEnterKeyframes', file: 'css', from: '@keyframes card-enter', to: '@keyframes card-appear' },
  { key: 'trendSmoothFn', file: 'app', from: 'function smoothTrendPath(', to: 'function smoothTrendPathX(' },
  { key: 'trendBezierCmd', file: 'app', from: "' C '", to: "' L '" },
  { key: 'cmpResultReturn', file: 'mod', from: 'cmp: cmp,', to: 'cmp: null,' },
  { key: 'cmpIndexFriendly', file: 'mod', from: "'ts < DATE_ADD(?, INTERVAL 1 DAY)'", to: "'ts <= ?'" },
  { key: 'cmpOrderFix', file: 'mod', from: 'const s = from > to ? to : from;', to: 'const s = from;' },
  { key: 'cmpSpanCap', file: 'mod', from: 'if (days > 366) return null;', to: 'if (days > 99999) return null;' },
  { key: 'cmpOnParam', file: 'mod', from: "String((query && query.cmpOn) || '') === '1'", to: "String((query && query.cmpOn) || '') === 'x'" },
  { key: 'trendCmpSvg', file: 'app', from: 'function trendCmpSvg(', to: 'function trendCmpSvgX(' },
  { key: 'trendCmpSegSource', file: 'app', from: 'bySeg.A[Number(r.h)]', to: 'bySeg.Z[Number(r.h)]' },
  { key: 'cmpDateInput', file: 'app', from: 'class="cmp-date"', to: 'class="cmp-date-x"' },
  { key: 'cmpOnState', file: 'app', from: 'cmpOn: false', to: 'cmpOnX: false' },
  { key: 'cmpGranToggle', file: 'app', from: 'data-gran="range"', to: 'data-granx="range"' },
  { key: 'cmpOverviewCard', file: 'app', from: ">对比总览' + cardNote(", to: ">对比总览X' + cardNote(" },
  { key: 'cmpOverviewInsert', file: 'app', from: "(cmpHtml ? '<div class=\"insight-grid\">' + cmpHtml + '</div>' : '')", to: "''" },
  { key: 'cmpFetchOn', file: 'app', from: "'&cmpOn='", to: "'&cmpOnX='" },
  { key: 'cmpFetchA1', file: 'app', from: "'&cmpA1='", to: "'&cmpA1X='" },
  { key: 'cmpMetricDefs', file: 'app', from: 'var CMP_METRICS = [', to: 'var CMP_METRICSX = [' },
  { key: 'cmpExport', file: 'app', from: "kind === 'cmp'", to: "kind === 'cmpX'" },
  { key: 'cssCmpToolbar', file: 'css', from: '.usage-cmp {', to: '.usage-cmp-x {' },
  { key: 'cssCmpNoFullRow', file: 'css', from: '.usage-cmp { display: flex;', to: '.usage-cmp { flex-basis: 100%; display: flex;' },
  { key: 'cssCmpPct', file: 'css', from: '.cmp-pct.up', to: '.cmp-pct.is-up' },
  { key: 'cssSegActive', file: 'css', from: '.seg-btn.active', to: '.seg-btn.is-active' },
  { key: 'trendAreaClass', file: 'app', from: 'class="trend-area"', to: 'class="trend-area-x"' },
  { key: 'trendGrad', file: 'app', from: '<linearGradient', to: '<linearGradienx' },
  { key: 'trendDotX', file: 'app', from: "dot.setAttribute('cx', trendX(hh, g)", to: "dot.setAttribute('cx', '0'" }
];

(async function main() {
  const real = await audit(S);
  if (real.length) {
    console.log('✗ 主线源码审计未通过：' + real.length + ' 项');
    real.forEach((k) => console.log('  ✗ ' + k));
    process.exit(1);
  }
  console.log('✓ 主线源码审计通过');

  let caught = 0;
  for (const mu of MUTANTS) {
    const src = S[mu.file];
    if (!has(src, mu.from)) {
      console.log('  ✗ 变异锚点失效（判据已漂移）: ' + mu.key);
      process.exit(1);
    }
    // 全部替换而不是只替第一处：累计用户的 COUNT(DISTINCT CASE WHEN) 在 SQL 里出现三次，
    // 只改一次会被另外两处蒙混过去（变异假绿，2026-11-09 首跑自查发现）。
    const X = Object.assign({}, S, { [mu.file]: src.split(mu.from).join(mu.to) });
    let bad = [];
    try { bad = await audit(X); } catch (e) { bad = ['throw:' + e.message]; }
    if (!bad.length) {
      console.log('  ✗ 变异未被抓到（门禁形同虚设）: ' + mu.key);
      process.exit(1);
    }
    caught++;
    console.log('  ✓ 变异 ' + mu.key + ' → 抓到 ' + bad.slice(0, 3).join(','));
  }
  console.log('✓ 变异自证 ' + caught + '/' + MUTANTS.length + ' 全部抓到');
})().catch((e) => {
  console.error('门禁自身异常：', e && e.stack);
  process.exit(1);
});
