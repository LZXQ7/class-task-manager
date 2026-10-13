#!/usr/bin/env node
/**
 * 门禁：schedule.generate 运行时可跑通（v0.7.22 需求② · roundFix 作用域事故）
 * ============================================================
 * 事故：`roundFix` 在 generate 的 try 块**内** `const` 声明，而 try/finally **之后**的
 * console.log 与 return 都引用它 → 块级作用域外引用 = ReferenceError（「roundFix is
 * not defined」，用户 toast 里那句「（roundFi…」就是超管诊断透出的开头）。
 * 此时事务**已经 commit**（库里落了行）但响应仍是 50000 —— 表现为「每次生成都失败」。
 *
 * 为什么必须用**运行时**门禁：文本正则查不出「声明在 try 内、引用在 try 外」这种作用域
 * 边界错误（40 个门禁全绿照样上线了它）；只有把生产源码 eval 起来真跑一遍 generate 才能抓到。
 *
 * 做法：`new Function` 抽生产源码，桩掉 wx-server-sdk / common/db / common/guard，
 * 注入假连接池（1 个课次但**无名册** → 走进事务主体、不写任何 duty），调用
 * `exports.main({action:'generate'})`：
 *   A. 好样本：必须 resolve，返回 `{created:0, roundFixed:0, …}`（引用 roundFix 的两处都活着），
 *      且只回报 SHORTAGE、不写 duty；
 *   A5. 需求 D 反面对照：把快照改成**没有课次**（本班没录课程表）→ 必须 41002，
 *      且不得先 DELETE 掉旧值日（「生成成功但表是空的」这类静默失败要能拦住）；
 *   B. 变异自证：把声明搬回 try 内（还原事故写法）→ main 必须 reject ReferenceError；
 *   C. 文本层：generate 段是 `let roundFix`（try 外声明）+ try 内纯赋值；
 *      cron-weekly 的 `const roundFix` 必须声明在其 try 之前（锁住另一条共用链路）。
 */
const fs = require('fs');
const path = require('path');

const R = path.resolve(__dirname, '..');
const SRC = path.join(R, 'cloudfunctions', 'schedule', 'index.js');
const CRON = path.join(R, 'cloudfunctions', 'cron-weekly', 'index.js');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failed++; };
const assert = (cond, m) => (cond ? ok(m) : bad(m));

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

/* 假连接池：按 SQL 形状回答。记录收到的语句供断言。
 * opts.sessions = false → 本班「没有课次骨架」（需求 D 的空集守卫要拦的正是这种班）；
 * 默认给 1 个课次，好让流程真的走进事务主体（否则在第一道守卫就被拦下，等于没测到 roundFix）。 */
function makeFakePool(log, opts) {
  const withSession = !(opts && opts.sessions === false);
  const o = opts || {};
  /* 记录真正写进duty 表的行（member_id），行为层断言靠它。
   * 只认**紧跟「INTO duty (」**的插入 —— duty_week_cursor / duty_log 都不能算进来。 */
  const inserted = o.inserted || [];
  const roster = o.roster || [];
  const manual = o.manual || [];
  const answer = (sql, params) => {
    log.push(sql.replace(/\s+/g, ' ').slice(0, 60));
    const s = sql.replace(/\s+/g, ' ');
    if (/FROM `?class`? WHERE id/i.test(sql)) {
      return [[{ id: 1, name: '测试班', term_start: '2026-09-14', total_weeks: 16, join_token: 't', invite_code: 'i', bind_open: 1, is_active: 1, period_time: '[]' }]];
    }
    if (withSession && /FROM session s WHERE/i.test(sql)) {
      if (Array.isArray(o.sessionList)) return [o.sessionList];
      // weeks 是**逗号分隔**的周次集合（parseWeeks 按 ',' 切分），命中 wk=4
      return [[{ id: 9, week_rule: null, weeks: '1,2,3,4,5', day_of_week: 1, period: 1, group_scope: null, duty_count: 2 }]];
    }
    if (/FROM member WHERE class_id/i.test(sql)) {
      return [roster.map((r, i) => Object.assign({
        id: i + 1, student_no: '2099010301' + String(i + 10).padStart(2, '0'),
        group_tag: 'A', duty_count: 0
      }, r))];
    }
    /* 手动排班查询：generate / cron-weekly 都按 session_id, class_date, member_id 取 */
    if (/source\s*=\s*'MANUAL'/i.test(s)) {
      return [manual.map(m => Object.assign({ session_id: 9, class_date: '2026-09-14', member_id: 1 }, m))];
    }
    if (/^INSERT IGNORE INTO duty \(/i.test(s)) {
      // params = [classId, sessionId, week, classDate, memberId]
      inserted.push(Number((params || [])[4]));
    }
    return [[]]; // 其余一律空集：无调课、无放假
  };
  const conn = {
    query: async (sql, params) => answer(sql, params),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
  };
  return {
    query: async (sql, params) => answer(sql, params),
    getConnection: async () => conn
  };
}

const STUB_GUARD = {
  ADMIN_ROLES: ['ADMIN', 'MONITOR'],
  getContext: async () => ({ openid: 'o-test', appid: 'wx', member: { id: 13, role: 'ADMIN', is_super: 1, class_id: 1, group_tag: 'A' }, realMember: null, impersonated: false }),
  requireBind: (ctx) => ctx.member,
  requireAdmin: (ctx) => ctx.member,
  requireSuper: (ctx) => ctx.member,
  isSuper: (m) => !!(m && m.role === 'ADMIN' && m.is_super === 1),
  isAdmin: (m) => !!(m && (m.role === 'ADMIN' || m.role === 'MONITOR')),
  isCounselor: (m) => !!m && m.group_tag === 'X',
  classIdOf: (ctx) => 1,
  staffClassIds: async () => [1],
  resolveClassId: async () => 1,
  /*
   * 需求 D（2026-09-27）新增的守卫：排班域 = 超管 | 本班生活委员（POSITION_DUTY_ADMIN）。
   * 桩必须同步 —— schedule 的分发处现在调用 `guard.requireScheduleAuth`，桩里没有就成了
   * `is not a function` → 本 gate 会把**正确的生产代码**判红（已由「桩完整性」断言兜住）。
   */
  isDutyAdmin: (m) => !!m && m.group_tag !== 'X' && String(m.position || '') === '生活委员',
  isMonitor: (m) => !!m && m.group_tag !== 'X' && String(m.position || '') === '班长兼团支书',
  requireScheduleAuth: (ctx) => ctx.member,
  requireRosterEdit: (ctx) => ctx.member,
  requirePositionGrant: (ctx) => ctx.member,
  isGrantedPosition: (p) => ['生活委员', '班长兼团支书'].indexOf(String(p || '')) >= 0,
  POSITION_DUTY_ADMIN: '生活委员',
  POSITION_MONITOR: '班长兼团支书'
};

function loadSchedule(src, log, opts) {
  const FN = path.join(R, 'cloudfunctions', 'schedule');
  const stubSdk = { init: () => {}, DYNAMIC_CURRENT_ENV: 'x', getWXContext: () => ({ OPENID: 'o-test' }) };
  const stubDb = { getPool: () => makeFakePool(log, opts) };
  const module_ = { exports: {} };
  const fn = new Function('require', 'module', 'exports', src);
  fn((p) => {
    if (p === 'wx-server-sdk') return stubSdk;
    if (p === './common/db') return stubDb;
    if (p === './common/guard') return STUB_GUARD;
    return require(path.join(FN, p)); // week / resp / schedule-core：无外部依赖，真加载
  }, module_, module_.exports);
  return module_.exports;
}

async function main() {
  console.log('\n===== check-schedule-generate-runtime（generate 可跑通 · v0.7.22 需求②） =====\n');
  const src = fs.readFileSync(SRC, 'utf8');

  /* ---------- A0. 桩完整性：schedule 用到的每个 guard.xxx 都必须在 STUB_GUARD 里 ----------
     schedule 的分发处会按路由调 guard.requireXxx(ctx)。桩是手工维护的清单，
     一旦新增守卫忘了同步，本 gate 就会拿桩去跑**正确的生产代码**并判红
     （2026-09-27 需求 D 的 guard.requireScheduleAuth 就是这样一次假红）。
     这里把「桩必须覆盖生产代码实际用到的全部 guard 成员」变成可执行的断言。 */
  {
    const used = new Set();
    const re = /guard\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) used.add(m[1]);
    const missing = Array.from(used).filter((k) => !(k in STUB_GUARD)).sort();
    assert(missing.length === 0,
      'A0 STUB_GUARD 覆盖 schedule 用到的全部 guard 成员（生产用 ' + used.size
      + ' 个；缺：' + (missing.join('、') || '无') + '）');
  }

  /* ---------- A. 好样本：有课次但无名册 → 必须 resolve，且真的走进事务主体 ----------
     ⚠️ 快照从「全空」改成「1 个课次」：需求 D 给 generate 加了「无课次骨架就报错」的守卫，
     全空快照现在会（正确地）停在 41002，根本走不到 roundFix 那段 = 这个门禁就白测了。 */
  {
    const log = [];
    const mod = loadSchedule(src, log);
    let result = null, threw = null;
    try { result = await mod.main({ action: 'generate', payload: { week: 4 } }); } catch (e) { threw = e; }
    assert(!threw, 'A1 generate 不抛错' + (threw ? '（实际：' + threw.message + '）' : ''));
    /* main 返回的是 ok(data) 包裹：{errCode:0, errMsg:'ok', data:{...}} —— 断言落在 data */
    const d = result && result.data;
    assert(!!d && d.created === 0 && d.roundReset === false && !('roundFixed' in d),
      'A2 返回结构齐整（' + JSON.stringify(result) + '）—— 无 roundFix 字段、轮转状态由游标承载');
    assert(log.some((s) => /DELETE FROM duty/.test(s)) && log.length > 5,
      'A3 事务路径真实走到（收到的 SQL ' + log.length + ' 条，含 DELETE）');
    /* A3b 新契约：生成完成必须把游标落库（saveWeekCursors + syncGlobalCursors），
       否则「轮转位置」会丢失、下次生成从头重排。 */
    assert(log.some((s) => /round_cursor_a/.test(s)) && log.some((s) => /duty_week_cursor/.test(s)),
      'A3b 游标已落库（class.round_cursor_* 写回 + duty_week_cursor 快照）');
    /* 名册为空 → 每个课次都应报「候选不足」，且**一条 duty 都不该写**（证明只是空排，不是写坏库） */
    const wlen = (d && d.warnings) ? d.warnings.length : -1;
    // 注意：duty_week_cursor（游标快照）也是 INSERT IGNORE INTO duty_week_cursor，
    // 必须精确命中「duty 表」（后面紧跟空格+左括号），不能误伤游标落库。
    const hasDutyRow = log.some((s) => /^INSERT IGNORE INTO duty \(/.test(s));
    assert(Array.isArray(d && d.warnings), 'A4a warnings 是数组（实际 ' + wlen + ' 条）');
    assert(wlen === 1, 'A4b 无名册 → 恰好 1 条 SHORTAGE（实际 ' + wlen + ' 条）');
    assert(!hasDutyRow, 'A4c 无名册时不写 duty 行（log 含 duty 行插入=' + hasDutyRow + '）');
  }

  /* ---------- A5. 需求 D 空集守卫：本班没有课次骨架 → 必须明确报错，不能「成功但表是空的」 ----------
     反面对照：若不报错就会静默返回 created=0，前端提示「生成成功」而值日表依旧空白。
     这里既证明守卫存在，也证明它**拦得住**（守卫被删掉这条立刻转红）。 */
  {
    const log = [];
    const mod = loadSchedule(src, log, { sessions: false });
    let result = null;
    try { result = await mod.main({ action: 'generate', payload: { week: 4 } }); } catch (e) { result = { errCode: -1, errMsg: String(e) }; }
    assert(!!result && result.errCode === 41002 && /尚未录入课程表/.test(String(result.errMsg)),
      'A5 无课次 → 41002「本班尚未录入课程表」（errCode=' + (result && result.errCode) + '）');
    assert(!log.some((s) => /^DELETE FROM duty/.test(s)),
      'A6 守卫在 DELETE 之前抛出（空集班不会先被删掉旧值日）');
  }

  /* ---------- B. 变异自证：删掉游标落库调用 → main 必须报错（证明门禁能抓回退） ---------- */
  {
    /* 把 saveWeekCursors 这个落库调用改名成不存在的函数：
       若有人把「轮转位置落库」这条新契约误删，generate 会在事务里抛 ReferenceError，
       被外层 catch 兜成 50000 —— 门禁必须能抓到。 */
    const mutated = src.replace(/saveWeekCursors\(/g, 'saveWeekCursors_MISSING(');
    assert(mutated !== src, 'B1 变异可用（游标落库调用被改成不存在的函数）');
    const mod = loadSchedule(mutated, []);
    let result = null;
    try { result = await mod.main({ action: 'generate', payload: { week: 4 } }); } catch (e) { result = { errCode: -1, errMsg: String(e) }; }
    assert(!!result && result.errCode === 50000 && /saveWeekCursors_MISSING|ReferenceError|is not defined/i.test(String(result.errMsg)),
      'B2 删掉游标落库必被抓：errCode=' + (result && result.errCode) + '、errMsg=' + (result && result.errMsg));
  }

  /* ---------- C. 文本层：旧 accident 构造体已彻底拆除 + 新游标契约就位 ---------- */
  {
    const code = stripComments(src);
    const cronCode = stripComments(fs.readFileSync(CRON, 'utf8'));
    /* 旧事故构造体（rotationPick / roundFix / repairRoundMarks）必须完全不存在 */
    assert(!/rotationPick/.test(code) && !/roundFix/.test(code) && !/repairRoundMarks/.test(code),
      'C1 schedule：旧事故构造体（rotationPick/roundFix/repairRoundMarks）已彻底拆除');
    assert(!/rotationPick/.test(cronCode) && !/roundFix/.test(cronCode) && !/repairRoundMarks/.test(cronCode),
      'C2 cron-weekly：旧事故构造体已彻底拆除');
    /* 新游标契约：两条链路都必须落游标（saveWeekCursors + syncGlobalCursors） */
    assert(/saveWeekCursors/.test(code) && /syncGlobalCursors/.test(code),
      'C3 schedule：新游标契约（saveWeekCursors + syncGlobalCursors）就位');
    assert(/saveWeekCursors/.test(cronCode) && /syncGlobalCursors/.test(cronCode),
      'C4 cron-weekly：新游标契约就位');
  }

  /* ---------- D. 行为层：「已有手动排班 ⇒ 一键生成接着它继续」（2026-10-08 用户口径） ----------
     用户原话：「若我已经有手动排班，则一键生成的值日接着我已有排班继续生成。」
     事故面：旧实现直接 `const n = s.duty_count || 1` 无视该课次已有的手动行，
     于是「手动排 2 人 + 自动再排 2 人 = 4 人」，手动排班被顶成双倍。
     正确口径 = **只补空缺**：课次名额 = duty_count − 已被手动占用的人数；排满则整个课次跳过。
     这里用假池真跑generate 数「实际写进 duty 表的人」——
     纯文本正则查不出「名额算错」这类口径错误（判据写了但没接上，见 D2）。 */
  {
    /* 名册 5 人：学号尾号 11..15 ⇒ seq 1..5（seqOf 取学号后两位后两位，2099010301xx → 1..5）*/
    const roster5 = [
      { student_no: '209901030111' }, { student_no: '209901030112' },
      { student_no: '209901030113' }, { student_no: '209901030114' },
      { student_no: '209901030115' }
    ];
    /* D1：课次 9 的 duty_count=2，已手动排 2 人（seq1、seq2）⇒ 必须一个都不再追加。
     * 修复前：created=2（又排了 seq3、seq4）⇒ 这里会红。 */
    {
      const inserted = [];
      const mod = loadSchedule(src, [], {
        roster: roster5, inserted,
        manual: [{ session_id: 9, class_date: '2026-09-14', member_id: 1 },
          { session_id: 9, class_date: '2026-09-14', member_id: 2 }]
      });
      let r = null, e = null;
      try { r = await mod.main({ action: 'generate', payload: { week: 4 } }); } catch (x) { e = x; }
      const d = (r && r.data) || {};
      assert(!e, 'D1a 手动排满时 generate 不抛错' + (e ? '（' + e.message + '）' : ''));
      assert(inserted.length === 0,
        'D1b 课次已手动排满 → 一个都不追加（实际追加 ' + inserted.length + ' 人：' + inserted.join(',') + '）');
      assert(d.keptManualSessions === 1,
        'D1c 返回 keptManualSessions=1（让前端能告诉用户保留了几节）（实际 ' + d.keptManualSessions + '）');
    }
    /* D2：已手动排 1 人、duty_count=2 ⇒ **只补 1 个**，不能补 2 个。 */
    {
      const inserted = [];
      const mod = loadSchedule(src, [], {
        roster: roster5, inserted,
        manual: [{ session_id: 9, class_date: '2026-09-14', member_id: 1 }]
      });
      let r = null;
      try { r = await mod.main({ action: 'generate', payload: { week: 4 } }); } catch (x) { r = null; }
      assert(inserted.length === 1,
        'D2 部分手动排班 → 只补空缺 1 人（实际补 ' + inserted.length + ' 人：' + inserted.join(',') + '）');
      /* 补上来的必须是**没被手动排走的人**：手动排了 seq1，就不能再排 seq1。
       * 注意这一条**单独抓不住**「手动排的人算不算本轮已排」——
       * pickBySeq 还有一层 `softSeqs`（本周已值过日优先不排、没人时才用）兜着，
       * 即便把 seq1 从 used 里摘掉，他仍会被 softSeqs 挡住 ⇒ D2b 照样绿。
       * 真正能暴露差异的是下面的 D2c（补漏分支）。 */
      assert(inserted.length === 1 && inserted[0] !== 1,
        'D2b 补的人不是手动排过的那位（实际补了 member ' + inserted.join(',') + '）');
      /* 真正暴露差异的：游标已走到后面时，补漏会回头捞小序号的人，
       * 这时 used 是唯一防线。课次 9（duty_count=1）+ 课次 10（duty_count=1），
       * 手动排了 seq1 到课次 9 ⇒ 课次 9 排满跳过（游标停在 0），课次 10 要排 1 人。
       *   正确：seq1 本周已值过日，不该再出现在课次 10；
       *   摘掉 used 之后：课次 10 会把 seq1 排进去 ⇒ 必须判死。*/
      const inserted2 = [];
      const twoSessions = [
        { id: 9, week_rule: null, weeks: '1,2,3,4,5', day_of_week: 1, period: 1, group_scope: null, duty_count: 1 },
        { id: 10, week_rule: null, weeks: '1,2,3,4,5', day_of_week: 2, period: 1, group_scope: null, duty_count: 1 }
      ];
      const mod2 = loadSchedule(src, [], {
        roster: roster5, inserted: inserted2, sessionList: twoSessions,
        manual: [{ session_id: 9, class_date: '2026-09-14', member_id: 1 }]
      });
      try { await mod2.main({ action: 'generate', payload: { week: 4 } }); } catch (x) { /* 断言看inserted */ }
      assert(inserted2.length === 1 && inserted2[0] !== 1,
        'D2c 手动排过的人不在后面的课次里再出现一次（实际排了 member ' + inserted2.join(',') + '）');
    }
    /* D3 无手动排班时的对照：duty_count=2 就该排满 2 人。
     * 防止「修复」写成「一律不排」—— 那样门禁 D1/D2 会绿而功能瘫了。 */
    {
      const inserted = [];
      const mod = loadSchedule(src, [], { roster: roster5, inserted, manual: [] });
      let r = null;
      try { r = await mod.main({ action: 'generate', payload: { week: 4 } }); } catch (x) { r = null; }
      const d = (r && r.data) || {};
      assert(inserted.length === 2 && d.created === 2,
        'D3 无手动排班 → 照常排满 2 人（实际 ' + inserted.length + ' 人 / created=' + d.created + '）');
    }
    /* D4 cron-weekly 同口径：周自动生成也必须只补空缺，否则周日 cron 会把超管手动排的课顶成双倍。
     * 判据直接读源码里那条真实的 `n` 计算式（剥注释，避免命中注释里的字面量）。*/
    {
      const cronCode = stripComments(fs.readFileSync(CRON, 'utf8'));
      assert(/Math\.max\(0,\s*\(Number\(s\.duty_count\)\s*\|\|\s*1\)\s*-\s*alreadyFilled\)/.test(cronCode),
        'D4 cron-weekly 同步只补空缺（Math.max(0, duty_count − alreadyFilled)）');
      assert(/manualFilled\[Number\(m\.session_id\)\]/.test(cronCode),
        'D4b cron-weekly 手动排班也按课次统计占用（manualFilled[session_id]）');
    }
    /* D5 结构判据：三条链路的「名额扣减」必须都在，且旧的无条件写法不得残留。 */
    {
      const code = stripComments(src);
      assert(/const alreadyFilled = \(manualFilled\[Number\(s\.id\)\]\s*\|\|\s*new Set\(\)\)\.size;/.test(code),
        'D5 generate 名额 = duty_count − 手动占用（alreadyFilled 判据在位）');
      assert(!/const n = s\.duty_count \|\| 1;/.test(code),
        'D5b generate 已无「无视手动排班直接取 duty_count」的旧写法');
      /* 手动占用必须排除 SWAPPED_OUT：被换出的历史行还在库里，
       * 若计入占用，会把课次的空缺名额吃掉 → 该课次**排不满**（静默少人）。
       * 🔴 判据必须锚到 generate 独有的 `DISTINCT session_id` 上：
       * 本文件另有 3 处 `source = 'MANUAL'`（writePlan / buildCleaningPlan / reassign），
       * buildCleaningPlan 那条字面量与此处**完全相同** —— 只写
       * `/source = 'MANUAL' AND status <> 'SWAPPED_OUT'/` 会被它顶掉，
       * 变异体改掉 generate 这处后判据仍命中另一处 ⇒ **假自证**（2026-10-08 踩）。*/
      assert(/SELECT DISTINCT session_id, class_date, member_id FROM duty WHERE class_id = \? AND week = \? AND source = 'MANUAL' AND status <> 'SWAPPED_OUT'/.test(code),
        'D5c generate 统计手动占用时排除 SWAPPED_OUT（换出的人不占坑）');
      assert(/if \(q\) state\.used\[seqGroupOf\.get\(q\) \|\| 'A'\]\.add\(q\);/.test(code),
        'D5d 手动排的人计入 state.used（补漏分支才不会把他再排一次）');
    }
  }

  console.log('\n' + (failed === 0
    ? '[PASS] generate 运行时可跑通 + 事故写法必被抓 + 手动排班只补空缺（双向自证通过）'
    : '[FAIL] ' + failed + ' 项未过'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[FAIL] 门禁自身异常：', e); process.exit(1); });
