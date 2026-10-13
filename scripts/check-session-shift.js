/**
 * 离线仿真「临时调课」的服务端纯逻辑
 * ------------------------------------------------------------
 * `node scripts/check-session-shift.js`
 *
 * 为什么要这么写：MCP 的 invokeFunction 没有 WX 上下文，`shiftSet` 是 needSuper
 * 路由，直接调必然 40001，没法端到端验证。而这两段都是纯逻辑——
 *   · course.expandTargets(pool, cfg, payload)  把「客户端定位条件」展开成 (课次, 周次) 组合
 *   · schedule.validateShiftPlan(ctx, raw)      把模型输出校验成可落库的操作清单
 * 所以从源码里原样抽出函数体 eval，测的就是生产代码本身（同 check-ai-plan.js 的做法）。
 *
 * 覆盖：
 *   ① sessionIds / dayOfWeek / dates 三种定位方式
 *   ② week（单周）与 weeks（多周次）两种范围
 *   ③ 「这一周本来就不上这个课次」必须被跳过
 *   ④ 越界周次、缺参数、不存在的课次
 *   ⑤ 模型输出里的非法 kind / 非法目标 / 重复课次 / 编造课次
 *   ⑥ 撞车预检（同一周同一位子两门课）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* timetable.js 读 wx.Storage，这里给个纯内存存根 */
const store = {};
global.wx = {
  getStorageSync: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; }
};

const week = require(path.join(ROOT, 'cloudfunctions/common/week.js'));
const tt = require(path.join(ROOT, 'miniprogram/data/timetable.js'));

const COURSE_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/course/index.js'), 'utf8');
const SCHED_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/schedule/index.js'), 'utf8');

/**
 * 抽出 `[async] function name(...) { ... }` 整段。
 * 用**大括号配对**而不是「第一个 \n}」，否则会被函数里的嵌套箭头函数骗到。
 * 注意必须连着 `async` 一起切：只匹配 `function name(` 会把 `async` 丢掉，
 * 于是 eval 出来的函数里出现顶层 await 而直接语法报错。
 * 这两个函数体内没有「字符串里出现大括号」的情况，所以直接数字符是安全的。
 */
function extractFn(src, name) {
  const head = src.indexOf('async function ' + name + '(');
  const start = head >= 0 ? head : src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 的大括号不配对');
}

class BizError extends Error {
  constructor(errCode, errMsg) { super(errMsg); this.errCode = errCode; this.errMsg = errMsg; }
}

const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];

const mkExpand = new Function(
  'week', 'BizError',
  extractFn(COURSE_SRC, 'expandTargets') + '\n return expandTargets;'
);
const expandTargets = mkExpand(week, BizError);

const mkValidate = new Function(
  'DAY_TEXT',
  extractFn(SCHED_SRC, 'validateShiftPlan') + '\n return validateShiftPlan;'
);
const validateShiftPlan = mkValidate(DAY_TEXT);

/* ---------------- 假 pool：直接喂真实种子课表（字段名换成库里那份） ---------------- */
const SESSION_ROWS = tt.SEED_SESSIONS.map(s => ({
  id: s.id,
  weeks: s.weeks || '',
  week_rule: 'ALL',
  day_of_week: s.day,
  period: s.period,
  group_scope: s.group || null
}));
const fakePool = {
  query: async (sql) => {
    if (sql.indexOf('FROM session') >= 0) return [SESSION_ROWS];
    throw new Error('假 pool 没实现这条 SQL：' + sql.slice(0, 60));
  }
};
const CFG = { termStart: tt.TERM_START, totalWeeks: tt.TOTAL_WEEKS };

let fail = 0;
function check(label, cond, extra) {
  if (!cond) fail++;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}
const key = p => p.sessionId + '@w' + p.week;
const keys = list => list.map(key).sort().join(' ');

/* ---------------- ① 定位方式 ---------------- */
console.log('--- ① 三种定位方式 ---');

(async () => {
  // sessionIds + 单周
  const a = await expandTargets(fakePool, CFG, { week: 5, sessionIds: [8] });
  check('sessionIds + week=5 → 命中 1 个组合', a.length === 1 && a[0].sessionId === 8 && a[0].week === 5,
    keys(a));
  check('返回项带 dayOfWeek / period / groupScope',
    a[0] && a[0].dayOfWeek === 2 && a[0].period === 1 && a[0].groupScope === 'A',
    a[0] ? JSON.stringify(a[0]) : '');

  // sessionIds + weeks（多周次）
  const b = await expandTargets(fakePool, CFG, { weeks: [5, 6], sessionIds: [8] });
  check('sessionIds + weeks=[5,6] → 2 个组合', b.length === 2, keys(b));
  check('多周次结果按周次去重（重复传同一周只算一次）',
    (await expandTargets(fakePool, CFG, { weeks: [5, 5, 6], sessionIds: [8] })).length === 2);

  // dayOfWeek + week：周一在 seed 里有 5 个课次，但第 5 周只有 3 个真的上
  const c = await expandTargets(fakePool, CFG, { week: 5, dayOfWeek: 1 });
  check('dayOfWeek=1 + week=5 → 只展开这一周真正上的 3 个课次', c.length === 3, keys(c));
  check('dayOfWeek 展开认的是「课次原来的星期」',
    c.every(p => p.dayOfWeek === 1), keys(c));

  // dates：日期自己换算 (第几周, 星期几)
  const d1 = await expandTargets(fakePool, CFG, { dates: ['2026-09-21'] });
  check('dates=[2026-09-21]（第2周周一）→ 3 个组合且都属于第 2 周',
    d1.length === 3 && d1.every(p => p.week === 2 && p.dayOfWeek === 1), keys(d1));

  const d2 = await expandTargets(fakePool, CFG, { dates: ['2026-10-01'] });
  check('dates=[2026-10-01]（第3周周四）→ 3 个组合且都属于第 3 周',
    d2.length === 3 && d2.every(p => p.week === 3 && p.dayOfWeek === 4), keys(d2));

  const d3 = await expandTargets(fakePool, CFG, { dates: ['2026-10-01', '2026-10-05'] });
  check('dates 跨两天（第3周周四 + 第4周周一）→ 6 个组合，落在 2 个周',
    d3.length === 6 && new Set(d3.map(p => p.week)).size === 2,
    keys(d3));

  /* ---------------- ② 「这一周本来就不上」必须跳过 ---------------- */
  console.log();
  console.log('--- ② 周次不匹配的课次必须被跳过 ---');
  // id=1「形势与政策」只在 6,8,10,12 周上
  check('第 2 周的 1 号课次（只在 6/8/10/12 周上）→ 0 个组合',
    (await expandTargets(fakePool, CFG, { week: 2, sessionIds: [1] })).length === 0);
  check('第 6 周的 1 号课次 → 1 个组合',
    (await expandTargets(fakePool, CFG, { week: 6, sessionIds: [1] })).length === 1);
  // id=4 只在 9-16 周上；id=3 只在 1-8 周上，两者同为「周一第4节 B组」
  check('第 2 周周一第4节只命中 1-8 周那条（3 号）',
    keys(await expandTargets(fakePool, CFG, { week: 2, sessionIds: [3, 4] })) === '3@w2');
  check('第 12 周周一第4节只命中 9-16 周那条（4 号）',
    keys(await expandTargets(fakePool, CFG, { week: 12, sessionIds: [3, 4] })) === '4@w12');

  /* ---------------- ③ 越界 / 缺参数 ---------------- */
  console.log();
  console.log('--- ③ 边界与错误 ---');
  check('week=99（超学期）→ 0 个组合',
    (await expandTargets(fakePool, CFG, { week: 99, sessionIds: [8] })).length === 0);
  check('week=17（超出 16 周）→ 0 个组合',
    (await expandTargets(fakePool, CFG, { week: 17, sessionIds: [8] })).length === 0);

  let threw = '';
  try { await expandTargets(fakePool, CFG, { sessionIds: [8] }); } catch (e) { threw = e.errMsg || ''; }
  check('只给 sessionIds 不给周次 → 抛「请选择要调整的周次」', threw.indexOf('周次') >= 0, threw);

  threw = '';
  try { await expandTargets(fakePool, CFG, { week: 5 }); } catch (e) { threw = e.errMsg || ''; }
  // 没有任何定位条件时 expandTargets 返回空数组（不抛），由 shiftSet 兜底成用户可见报错
  check('没有任何定位条件 → expandTargets 返回空数组且不抛异常', threw === '',
    threw || 'ok');
  check('shiftSet 对「展开后为空」给出用户可见报错',
    COURSE_SRC.indexOf('没有找到符合条件的课次') >= 0);

  check('不存在的课次 id 被忽略（不报错、不产出组合）',
    (await expandTargets(fakePool, CFG, { week: 5, sessionIds: [99999] })).length === 0);
  check('合法与非法 id 混传 → 只留下合法的',
    keys(await expandTargets(fakePool, CFG, { week: 5, sessionIds: [8, 99999] })) === '8@w5');

  /* ---------------- ④ validateShiftPlan ---------------- */
  console.log();
  console.log('--- ④ AI 调课方案校验 ---');
  const ctx = {
    sessions: [
      { sessionId: 8, course: '小学人工智能教育', room: '3号楼110', dayOfWeek: 2, period: 1, off: false },
      { sessionId: 22, course: '三笔字', room: '3号楼111', dayOfWeek: 2, period: 5, off: false },
      { sessionId: 12, course: '小学生心理健康指导', room: '3号楼222', dayOfWeek: 3, period: 3, off: false },
      { sessionId: 24, course: '儿童文学', room: '3号楼205', dayOfWeek: 5, period: 3, off: false }
    ]
  };

  const v1 = validateShiftPlan(ctx, {
    operations: [
      { sessionIds: [8, 22], kind: 'OFF', note: '周二整天空出来' },
      { sessionIds: [24], kind: 'MOVE', toDay: 4, toPeriod: 2, note: '儿童文学挪到周四' }
    ],
    notes: '测试'
  });
  check('合法的 OFF + MOVE 被原样接受', v1.operations.length === 2, JSON.stringify(v1.operations));
  check('OFF 操作不吃 toDay / toPeriod',
    v1.operations[0].kind === 'OFF' && v1.operations[0].toDay === null && v1.operations[0].toPeriod === null);
  check('MOVE 操作保留目标格子',
    v1.operations[1].toDay === 4 && v1.operations[1].toPeriod === 2);
  check('preview 覆盖每节课次并给出可读效果文案',
    v1.preview.length === 3
    && v1.preview.find(p => p.sessionId === 8).effect === '本周不上'
    && v1.preview.find(p => p.sessionId === 24).effect === '改到 周四第2节',
    JSON.stringify(v1.preview.map(p => p.sessionId + ':' + p.effect)));

  const v2 = validateShiftPlan(ctx, {
    operations: [
      { sessionIds: [8], kind: 'DELETE' },
      { sessionIds: [24], kind: 'MOVE', toDay: 9, toPeriod: 2 },
      { sessionIds: [24], kind: 'MOVE', toDay: 3, toPeriod: 2 },
      { sessionIds: [77777], kind: 'OFF' },
      { sessionIds: [], kind: 'OFF' }
    ],
    warnings: ['模型自己的提醒']
  });
  check('无法识别的 kind 被忽略', v2.operations.every(o => o.kind === 'OFF' || o.kind === 'MOVE'));
  check('非法目标格子（周9）被忽略', !v2.operations.some(o => o.toDay === 9));
  check('同一课次被安排多次 → 只保留第一条', v2.operations.filter(o => o.sessionIds.indexOf(24) >= 0).length <= 1,
    JSON.stringify(v2.operations));
  check('编造的课次 77777 被剔除', !v2.operations.some(o => o.sessionIds.indexOf(77777) >= 0));
  check('空 sessionIds 的操作不产出空操作', v2.operations.every(o => o.sessionIds.length > 0));
  check('模型自己的 warnings 被带上', v2.warnings.indexOf('模型自己的提醒') >= 0, JSON.stringify(v2.warnings));
  check('非法输入不抛异常', !!v2);

  /* 撞车预检：8 号从周二第1节挪到周三第3节，正好压到 12 号 */
  const v3 = validateShiftPlan(ctx, {
    operations: [{ sessionIds: [8], kind: 'MOVE', toDay: 3, toPeriod: 3 }]
  });
  check('撞车被预检出来',
    v3.warnings.some(w => w.indexOf('两门课') >= 0), JSON.stringify(v3.warnings));
  check('撞车只告警、不丢弃操作', v3.operations.length === 1);

  /* OFF 掉一门课后再挪过去，就不该再报撞车 */
  const v4 = validateShiftPlan(ctx, {
    operations: [
      { sessionIds: [12], kind: 'OFF' },
      { sessionIds: [8], kind: 'MOVE', toDay: 3, toPeriod: 3 }
    ]
  });
  check('先把原占用课次 OFF 掉之后不再报撞车',
    !v4.warnings.some(w => w.indexOf('两门课') >= 0), JSON.stringify(v4.warnings));

  check('空 operations 正常返回', validateShiftPlan(ctx, {}).operations.length === 0);
  check('raw 为 null 不抛异常', validateShiftPlan(ctx, null).operations.length === 0);

  console.log();
  if (fail) {
    console.log('❌ 失败 ' + fail + ' 项');
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
})();
