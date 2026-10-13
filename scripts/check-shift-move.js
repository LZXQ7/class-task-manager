#!/usr/bin/env node
/**
 * 离线自检：批量调课 / 新建课次 的两个易错点（2026-10-07）
 * ------------------------------------------------------------
 * 这两条不是靠读代码能看出来的，是用假 pool 跑真源码跑出来的（见 git log 里那次返工）：
 *
 *   ① `appendSessionSlots` 命中 madeKey 去重时**不能 continue**。
 *      同一门课一周上两次（两个不同节次）时，两个原课次会落进同一批 targets；
 *      去重命中后若直接 `continue`，第二个课次那条值日就永远留在旧日期 + 旧课次上
 *      ⇒ 变成孤儿（课已挪走，值日还挂在原格）。必须让它继续走值日搬迁那段。
 *
 *   ② `moveSessionSlots` 撞「同一天同一人两条值日」时，删的必须是
 *      **目标周上原有那条**，保留**跟着课走这条**（与 `syncDutyForShift` 的 MOVE 分支
 *      同一范式）。反过来删会让值日留在已不在的星期上。
 *
 * 本门禁做两件事：
 *   A. 源码文本判据（剥注释后匹配，防「判据命中注释里同种字面量」）—— 钉死 ① 的结构。
 *   B. 纯逻辑仿真：抽出真函数 eval，喂假 pool，跑 5 组场景 —— 钉死 ① ② 的行为。
 *
 * 变异自证：任一环拆掉 → 必被抓；源码原样 → 不得误报。
 * ⚠️ 变异全在**内存副本**上做（judge(mutated)），自证函数里禁止 fs.writeFileSync。
 * 用法：node scripts/check-shift-move.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/course/index.js'), 'utf8');

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

/** 把注释替换成等长空白（保留换行与行号），避免判据命中注释里的同种字面量 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + m.slice(p1.length).replace(/[^\n]/g, ' '));
}

const CODE = stripComments(SRC);

/* ============ A. 源码结构判据 ============ */
console.log('【A】源码结构判据');

/** 取某个 async function 的完整源码文本（含签名） */
function extractFn(src, name) {
  const head = src.indexOf('async function ' + name + '(');
  const start = head >= 0 ? head : src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const i = src.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return '';
}

const APPEND = stripComments(extractFn(SRC, 'appendSessionSlots'));
const MOVE = stripComments(extractFn(SRC, 'moveSessionSlots'));

/**
 * 抽 `routes` 里的对象方法（形如 `  shiftSet: {` ... 对应的配平 `  },`）。
 * extractFn 只认 `function name(`，抽不到这种写法 ⇒ 早先直接用会拿到空串，
 * 判据「静默全红」而没人知道为什么（2026-10-08 踩）。
 */
function extractRoute(src, name) {
  const key = name + ': {';
  let from = 0;
  for (;;) {
    const at = src.indexOf(key, from);
    if (at < 0) return '';
    const brace = src.indexOf('{', at);
    let depth = 0;
    for (let j = brace; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
    }
    from = at + key.length;
  }
}

// 判据 ①：madeKey 命中后不得 `continue`
const dedupLine = APPEND.split('\n').find(l => /madeKey\[key\]/.test(l) && /continue/.test(l));
check('A1 appendSessionSlots：madeKey 去重处不得出现 continue（会丢值日搬迁）',
  !dedupLine, dedupLine);
// 反向锚点：必须真的用了 madeKey 去重，且用 `let nid = madeKey[key]` 取值
check('A2 appendSessionSlots：madeKey 去重仍在（防止有人把去重整段删掉）',
  /madeKey\[key\]\s*=/.test(APPEND) && /if\s*\(!nid\)/.test(APPEND));
// 判据：值日搬迁循环必须在 for 体外层（对每个 target 都跑），不在 `if (!nid)` 里
const moveIdx = APPEND.indexOf('UPDATE duty SET session_id');
const guardEnd = APPEND.indexOf('}', APPEND.indexOf('if (!nid)'));
check('A3 appendSessionSlots：值日搬迁在去重分支之外（每个 target 都搬）',
  moveIdx > 0 && (guardEnd < 0 || moveIdx > guardEnd));
// 判据 ②：moveSessionSlots 删的是 dupIds（目标周原有那条），保留的是 duties 里跟着挪的
check('A4 moveSessionSlots：删的是 dupIds 那批',
  /DELETE FROM duty WHERE id IN \(\$\{phDup\}\)/.test(MOVE) && /const dupIds = dups\.map/.test(MOVE));
check('A5 moveSessionSlots：跟着挪的那批按 dupIds 过滤后才改日期',
  /if \(dupIds\.indexOf\(Number\(d\.id\)\) >= 0\) continue;/.test(MOVE));

/* ---- A6..A9：date模式「整天挪到另一天、节次不变」的必传/禁传口径 ----
 * 事故（2026-10-08）：用户走完「日期间调课」向导 4 步，点「确认调课」必报
 *   「第 1 条写入失败：请选择改到星期几（前面的已生效）」。
 * 根因链（三处，缺一不可）：
 *   ① 前端 _currentPlanItem 的 date 分支只产 dates + toDate，**没有 toDay**——
 *界面（index.wxml 的 shiftMode==='date' 分支）本来就不渲染星期/节次选择器，
 *      它只有两个日期选择器；
 *   ② onShiftConfirm 无条件 `payload.toDay = it.toDay` ⇒ 把 undefined 发到云端；
 *   ③ 云端 shiftSet 对 kind='MOVE' 无条件要求 toDay∈[1,7]。
 * 三者叠加 ⇒ 一条用户走完整流程也必然失败的死路。
 *
 * 修法（不是回滚，是把三处口径对齐到「缺省 = 保留原值」）：
 *   全链路**早就**是这个语义了，只有 shiftSet 的硬校验与之冲突——
 *     · cloudfunctions/common/week.js  resolveSlot: day: ov.toDay || dayOfWeek
 *     · miniprogram/data/timetable.js    resolveSlot: 同上
 *     · miniprogram/data/timetable.js upsertSessShifts: Number(it.toDay) || null
 *   所以：byDates（按日期定位）时放行缺省；按课次定位（sessionIds/weeks/dayOfWeek）
 *   仍必须给全——那三种方式界面都渲染了星期+节次选择器，缺了就是用户漏填。
 */
const TT = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/timetable/index.js'), 'utf8');
const TT_CODE = stripComments(TT);
const SHIFTSET_RAW = extractRoute(SRC, 'shiftSet');
const SHIFTSET = stripComments(SHIFTSET_RAW);
// 🔴 前置检查：抽不到就明说，绝不静默判红让人猜（抽取失败会让下面所有判据无意义）
check('A0 前置：shiftSet 方法体必须抽得到（否则 A6-A8 的红没有意义）',
  SHIFTSET_RAW.length > 200 && /const kind = payload\.kind/.test(SHIFTSET),
  { len: SHIFTSET_RAW.length });
check('A6 shiftSet：按 dates 定位时放行 toDay/toPeriod 缺省（缺省=保留原值）',
  /const byDates = Array\.isArray\(payload\.dates\)/.test(SHIFTSET)
  && /if \(!byDates && !\(toDay >= 1 && toDay <= 7\)\)/.test(SHIFTSET)
  && /if \(!byDates && !\(toPeriod >= 1 && toPeriod <= 5\)\)/.test(SHIFTSET));
check('A7 shiftSet：传了就必须合法（不许把 undefined 当合法值放行）',
  /payload\.toDay !== undefined[\s\S]{0,200}?!\(toDay >= 1 && toDay <= 7\)/.test(SHIFTSET)
  && /payload\.toPeriod !== undefined[\s\S]{0,200}?!\(toPeriod >= 1 && toPeriod <= 5\)/.test(SHIFTSET));
check('A8 shiftSet：值日重算要用每个 target 的最终落位星期（toDay 缺省时不能传 null）',
  /const effDay = \(toDay >= 1 && toDay <= 7\) \? toDay : Number\(t\.dayOfWeek\)/.test(SHIFTSET)
  && /syncDutyForShift\(conn, cfg, t\.sessionId, t\.week, kind, effDay, stats\)/.test(SHIFTSET));
// ---- A9..A11：已于 2026-10-08 随「C3 四步向导」UI 整体回退而失效 ----
// 背景：用户要求把临时调课回退到 C3 动手前（2026-10-07 09:39）的分段标签形态。
// 这三条判据守的是**向导专属**的 `_currentPlanItem`：向导里「调到哪天」是**日期**
// （`shiftToDate`），必须用 `util.weekdayOfNum()` 折成星期几才能发给云端 —— 漏了就报
// 「请选择改到星期几」，正是上一轮 41001 事故的根因。
// 回退后的旧版**没有 `_currentPlanItem`**，date 模式的 `toDay` 直接来自用户点选的
// `shiftToDay`（本来就是 1-7 的星期几，见 index.js `const toDay = move ? this.data.shiftToDay : null`），
// 那个 bug 在旧版**结构上不可能复现** ⇒ 判据随之移除，不是「门禁被绕过」。
// 🔴 将来若再做回 C3 向导形态，这三条必须一并恢复，并同时恢复 A12-A14 与 C5-C7。
check('A9~A11 已随 C3 向导回退移除（旧版 toDay 直取 shiftToDay，不经日期换算）',
  !/_currentPlanItem/.test(TT_CODE)
  && /const toDay = move \? this\.data\.shiftToDay : null;/.test(TT_CODE));
// ---- A12-A14：同一个死路的**第二个入口**「新建课次后课表」（date + APPEND）----
// 2026-10-08 首轮修复只覆盖了 shiftSet（OVERWRITE），漏了 sessionAppend（APPEND）。
// 二者在界面上都出现在步骤 4「写入方式」，同一个 date 模式可以选任何一个
//⇒ 只修一半 = 用户换个写入方式又撞死路（报「第 1 条：缺目标节次（1-5）」）。
// 这里 normalizePlan 与 appendSessionSlots 是**成对**的：前者放行缺省，
// 后者必须把缺省回退到各课次自己的 s.period（session.period 是必填语义列，
// 写 NULL 会让新课次在课表上读不出来）。
const NORMALIZE = stripComments(extractFn(SRC, 'normalizePlan'));
check('A12 normalizePlan：byDates 时放行 toPeriod 缺省（date+APPEND 同一条死路）',
  /const byDates = item\.dates\.length > 0;/.test(NORMALIZE)
  && /if \(byDates && !hasToPeriod\) item\.toPeriod = null;/.test(NORMALIZE)
  && /if \(!byDates\) \{/.test(NORMALIZE));
check('A13 appendSessionSlots：toPeriod 缺省须回退到该课次自己的 s.period（不能写 NULL）',
  /const effPeriod = \(toPeriod >= 1 && toPeriod <= 5\) \? toPeriod : Number\(s\.period\);/.test(APPEND)
  && /toDay, effPeriod, s\.group_scope, s\.duty_count, note/.test(APPEND));
check('A14 normalizePlan：「传了就必须合法」与「按课次定位必须给全」两条护栏仍在',
  /if \(hasToDay && !\(item\.toDay >= 1 && item\.toDay <= 7\)\)/.test(NORMALIZE)
  && /if \(hasToPeriod && !\(item\.toPeriod >= 1 && item\.toPeriod <= 5\)\)/.test(NORMALIZE)
  && /条：缺目标星期/.test(NORMALIZE));

/* ============ B. 纯逻辑仿真（真源码 + 假 pool） ============ */
console.log('\n【B】纯逻辑仿真');

// 假 week 模块（与 common/week.js 同口径）；termStart 2026-09-14 是周一
// ⚠️ 必须与真源 `cloudfunctions/common/week.js` 保持同口径：真源新增/改签名的 helper
//    后，这里的副本要同步补上，否则本门禁会报 `xxx is not a function`（2026-10-07 加
//    isWeeksBlank 时踩过）。语义真源由 scripts/check-weeks-semantics.js 单独钉死。
const week = {
  getDateOfWeekDay(termStart, wk, dow) {
    const [y, m, d] = termStart.split('-').map(Number);
    const base = Date.UTC(y, m - 1, d) + (wk - 1) * 7 * 86400000 + (dow - 1) * 86400000;
    const t = new Date(base);
    return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0')
      + '-' + String(t.getUTCDate()).padStart(2, '0');
  },
  isWeeksBlank(w) {
    if (w === null || w === undefined) return true;
    return String(w).trim() === '';
  },
  parseWeeks(w) {
    if (this.isWeeksBlank(w)) return [];
    return Array.from(new Set(String(w).split(',').map(s => parseInt(s, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 53))).sort((a, b) => a - b);
  },
  matchesWeekRule(rule, wk) {
    if (rule === 'ODD') return wk % 2 === 1;
    if (rule === 'EVEN') return wk % 2 === 0;
    return true;
  }
};
const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];
const CFG = { termStart: '2026-09-14', totalWeeks: 16 };

const ROLLBACK_SRC = extractFn(SRC, 'rollbackDutyMarkers');
const rollbackDutyMarkers = new Function('DAY_TEXT', ROLLBACK_SRC + '\nreturn rollbackDutyMarkers;')(DAY_TEXT);

function evalFn(name, deps) {
  const text = extractFn(SRC, name);
  if (!text) throw new Error('抽不到函数 ' + name);
  const keys = Object.keys(deps);
  const factory = Function.apply(null, keys.concat([text + '\nreturn ' + name + ';']));
  return factory.apply(null, keys.map(k => deps[k]));
}
const moveSessionSlots = evalFn('moveSessionSlots', { week, rollbackDutyMarkers, DAY_TEXT });
const appendSessionSlots = evalFn('appendSessionSlots', { week, rollbackDutyMarkers, DAY_TEXT });

/** 假 pool：只覆盖被测函数用到的 SQL；未覆盖的 SQL 直接抛（宁可炸也不静默走偏） */
function makePool(seed) {
  const st = {
    session: seed.session.slice(),
    duty: seed.duty.slice(),
    session_shift: seed.session_shift ? seed.session_shift.slice() : [],
    member: seed.member.slice(),
    duty_log: [],
    swap_request: [],
    seq: 1000
  };
  async function query(sql, args) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^SELECT id, day_of_week, period, weeks, week_rule FROM session/i.test(s)) {
      // 按 SQL 里**实际有没有** class_id 过滤来决定是否隔离，
      // 否则去掉守卫的变异体会在模拟器这边被挡住 ⇒ 假自证。
      const hasCls = /WHERE class_id = \?/.test(s);
      const ph = s.match(/id IN \(([^)]*)\)/)[1].split(',').length;
      const off = hasCls ? 1 : 0;
      const cls = hasCls ? Number(args[0]) : null;
      const ids = args.slice(off, off + ph).map(Number);
      return [st.session.filter(r => (!hasCls || Number(r.class_id) === cls)
        && ids.indexOf(Number(r.id)) >= 0)
        .map(r => ({ id: r.id, day_of_week: r.day_of_week, period: r.period, weeks: r.weeks, week_rule: r.week_rule }))];
    }
    if (/^SELECT s\.id, s\.course_id, s\.kind, s\.week_rule, s\.group_scope, s\.duty_count/i.test(s)) {
      const cls = Number(args[0]);
      const ph = s.match(/s\.id IN \(([^)]*)\)/i)[1].split(',').length;
      const ids = args.slice(1, 1 + ph).map(Number);
      return [st.session.filter(r => Number(r.class_id) === cls && ids.indexOf(Number(r.id)) >= 0)
        .map(r => ({ id: r.id, course_id: r.course_id, kind: r.kind, week_rule: r.week_rule,
          group_scope: r.group_scope, duty_count: r.duty_count, day_of_week: r.day_of_week, period: r.period }))];
    }
    if (/^SELECT id, week, member_id, class_date FROM duty/i.test(s)) {
      const sid = Number(args[0]);
      return [st.duty.filter(r => Number(r.session_id) === sid
        && (r.status === 'PENDING' || r.status === 'ONGOING'))
        .map(r => ({ id: r.id, week: r.week, member_id: r.member_id, class_date: r.class_date }))];
    }
    if (/^SELECT id, member_id, week FROM duty/i.test(s)) {
      const [sid, wk] = args.map(Number);
      return [st.duty.filter(r => Number(r.session_id) === sid && Number(r.week) === wk
        && (r.status === 'PENDING' || r.status === 'ONGOING'))
        .map(r => ({ id: r.id, member_id: r.member_id, week: r.week }))];
    }
    if (/^SELECT id, week FROM duty WHERE session_id = \?/i.test(s)) {
      const sid = Number(args[0]);
      return [st.duty.filter(r => Number(r.session_id) === sid
        && (r.status === 'PENDING' || r.status === 'ONGOING'))];
    }
    if (/^SELECT id, member_id FROM duty\s+WHERE week IN \(SELECT week FROM duty WHERE id IN/i.test(s)) {
      const phMem = (s.match(/member_id IN \(([^)]*)\)/i) || ['', ''])[1].split(',').length;
      const phD = (s.match(/id NOT IN \(([^)]*)\)/i) || ['', ''])[1].split(',').length;
      const memIds = args.slice(0, phMem).map(Number);
      const ids = args.slice(phMem, phMem + phD).map(Number);
      const wks = st.duty.filter(r => ids.indexOf(Number(r.id)) >= 0).map(r => Number(r.week));
      return [st.duty.filter(r => wks.indexOf(Number(r.week)) >= 0 && r.status !== 'SWAPPED_OUT'
        && memIds.indexOf(Number(r.member_id)) >= 0 && ids.indexOf(Number(r.id)) < 0)];
    }
    if (/^SELECT id FROM duty\s+WHERE session_id = \? AND week = \?/i.test(s)) {
      const [sid, wk] = args.map(Number);
      const phMem = (s.match(/member_id IN \(([^)]*)\)/i) || ['', ''])[1].split(',').length;
      const phD = (s.match(/id NOT IN \(([^)]*)\)/i) || ['', ''])[1].split(',').length;
      const memIds = args.slice(2, 2 + phMem).map(Number);
      const ids = args.slice(2 + phMem, 2 + phMem + phD).map(Number);
      return [st.duty.filter(r => Number(r.session_id) === sid && Number(r.week) === wk
        && r.status !== 'SWAPPED_OUT'
        && memIds.indexOf(Number(r.member_id)) >= 0 && ids.indexOf(Number(r.id)) < 0)];
    }
    if (/^SELECT member_id, COUNT/i.test(s)) {
      const ph = s.match(/id IN \(([^)]*)\)/)[1].split(',').length;
      const ids = args.slice(0, ph).map(Number);
      const by = {};
      st.duty.filter(r => ids.indexOf(Number(r.id)) >= 0 && r.status !== 'SWAPPED_OUT')
        .forEach(r => { by[r.member_id] = (by[r.member_id] || 0) + 1; });
      return [Object.keys(by).map(k => ({ member_id: Number(k), n: by[k] }))];
    }
    if (/^UPDATE member SET duty_count = GREATEST/i.test(s)) {
      const id = Number(args[1]);
      st.member.forEach(r => { if (Number(r.id) === id) r.duty_count = Math.max(r.duty_count - Number(args[0]), 0); });
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE session SET day_of_week/i.test(s)) {
      // 兼容 4 参（带 class_id 守卫）与 3 参（无守卫，变异体）两种写法
      const hasCls = /WHERE class_id = \?/.test(s);
      const [dow, per, a, b] = args;
      const cls = hasCls ? Number(a) : null;
      const id = Number(hasCls ? b : a);
      let n = 0;
      st.session.forEach(r => {
        if (Number(r.id) !== id) return;
        if (hasCls && Number(r.class_id) !== cls) return;
        r.day_of_week = dow; r.period = per; n++;
      });
      return [{ affectedRows: n }];
    }
    if (/^UPDATE session SET note/i.test(s)) {
      const note = args[0], cls = Number(args[1]);
      const ph = (s.match(/id IN \(([^)]*)\)/i) || ['', ''])[1].split(',').length;
      const ids = args.slice(2, 2 + ph).map(Number);
      let n = 0;
      st.session.forEach(r => {
        if (Number(r.class_id) === cls && ids.indexOf(Number(r.id)) >= 0) { r.note = note; n++; }
      });
      return [{ affectedRows: n }];
    }
    if (/^UPDATE duty SET class_date = \? WHERE id = \?/i.test(s)) {
      const [dt, id] = args;
      let n = 0;
      st.duty.forEach(r => { if (Number(r.id) === Number(id)) { r.class_date = dt; n++; } });
      return [{ affectedRows: n }];
    }
    if (/^UPDATE duty SET session_id = \?/i.test(s)) {
      const [sid, dt, id] = args;
      const nid = Number(sid);
      const self = st.duty.find(x => Number(x.id) === Number(id));
      if (self && st.duty.some(r => Number(r.id) !== Number(id) && Number(r.session_id) === nid
        && Number(r.week) === Number(self.week) && Number(r.member_id) === Number(self.member_id))) {
        const e = new Error("Duplicate entry for key 'uq_duty'");
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      let n = 0;
      st.duty.forEach(r => {
        if (Number(r.id) === Number(id)) { r.session_id = nid; r.class_date = dt; n++; }
      });
      return [{ affectedRows: n }];
    }
    if (/^INSERT INTO session \(/i.test(s)) {
      const [cls, cid, kind, weeks, dow, per, gs, dc, note] = args;
      st.seq += 1;
      st.session.push({ id: st.seq, class_id: cls, course_id: cid, kind, weeks, day_of_week: dow,
        period: per, group_scope: gs, duty_count: dc, note });
      return [{ insertId: st.seq, affectedRows: 1 }];
    }
    if (/^INSERT INTO session_shift/i.test(s)) {
      const [cls, sid, wk, note] = args;
      const hit = st.session_shift.find(r => Number(r.session_id) === sid && Number(r.week) === wk);
      if (hit) { hit.kind = 'OFF'; hit.note = note; }
      else st.session_shift.push({ class_id: cls, session_id: sid, week: wk, kind: 'OFF', note });
      return [{ affectedRows: 1 }];
    }
    if (/^DELETE FROM duty_log/i.test(s)) {
      const ph = s.match(/duty_id IN \(([^)]*)\)/)[1].split(',').length;
      const ids = args.slice(0, ph).map(Number);
      st.duty_log = st.duty_log.filter(r => ids.indexOf(Number(r.id)) < 0);
      return [{ affectedRows: 0 }];
    }
    if (/^UPDATE swap_request/i.test(s)) return [{ affectedRows: 0 }];
    if (/^DELETE FROM duty WHERE id IN/i.test(s)) {
      const ph = s.match(/id IN \(([^)]*)\)/)[1].split(',').length;
      const ids = args.slice(0, ph).map(Number);
      const before = st.duty.length;
      st.duty = st.duty.filter(r => ids.indexOf(Number(r.id)) < 0);
      return [{ affectedRows: before - st.duty.length }];
    }
    throw new Error('假 pool 未覆盖的 SQL：' + s.slice(0, 150));
  }
  return { query, _st: st };
}

/** 5 组场景；moveFn/appendFn 可注入变异版做自证 */
async function runScenarios(moveFn, appendFn) {
  const out = {};

  // 场景 1：批量挪位 —— 改 day/period、weeks 全保留、值日日期跟着重算
  {
    const pool = makePool({
      session: [
        { id: 1, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2,3', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: null, duty_count: 2, note: '' },
        { id: 2, class_id: 3, course_id: 11, kind: 'COURSE', weeks: '', week_rule: 'ALL', day_of_week: 5, period: 1, group_scope: 'A', duty_count: 2, note: '' }
      ],
      duty: [
        { id: 100, session_id: 1, week: 2, class_date: '2026-09-22', member_id: 7, status: 'PENDING' },
        { id: 101, session_id: 1, week: 3, class_date: '2026-09-29', member_id: 8, status: 'PENDING' }
      ],
      member: [{ id: 7, duty_count: 5 }, { id: 8, duty_count: 5 }]
    });
    const stats = { moved: 0, removed: 0, created: 0 };
    const weeks = await moveFn(pool, CFG, 3, [1], 6, 1, stats);
    const s1 = pool._st.session.find(r => r.id === 1);
    out.c1 = s1.day_of_week === 6 && s1.period === 1 && s1.weeks === '2,3'
      && JSON.stringify(weeks) === '[2,3]'
      && pool._st.duty.find(r => r.id === 100).class_date === '2026-09-26'
      && pool._st.duty.find(r => r.id === 101).class_date === '2026-10-03'
      && stats.moved === 2 && weeks.length === 2;
  }

  // 场景 2：批量挪位撞「同一天同一人两条值日」⇒ 删目标周原有的（200），保留跟着挪的（100）
  {
    const pool = makePool({
      session: [
        { id: 1, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: null, duty_count: 2, note: '' }
      ],
      duty: [
        { id: 100, session_id: 1, week: 2, class_date: '2026-09-22', member_id: 7, status: 'PENDING' },
        { id: 200, session_id: 5, week: 2, class_date: '2026-09-26', member_id: 7, status: 'PENDING' }
      ],
      member: [{ id: 7, duty_count: 5 }]
    });
    const stats = { moved: 0, removed: 0, created: 0 };
    await moveFn(pool, CFG, 3, [1], 6, 1, stats);
    const ids = pool._st.duty.map(r => r.id);
    out.c2 = ids.indexOf(200) < 0 && ids.indexOf(100) >= 0 && stats.removed === 1
      && pool._st.member[0].duty_count === 4
      && pool._st.duty.find(r => r.id === 100).class_date === '2026-09-26';
  }

  // 场景 3：新建课次 —— 只覆盖目标周、落新格、复用 course/group/duty_count、带 note、
  //          原课次一行未动、给原课次该周写 OFF、值日搬到新课次
  {
    const pool = makePool({
      session: [
        { id: 1, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2,3', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: 'A', duty_count: 2, note: '' }
      ],
      duty: [{ id: 100, session_id: 1, week: 2, class_date: '2026-09-22', member_id: 7, status: 'PENDING' }],
      member: [{ id: 7, duty_count: 5 }]
    });
    const stats = { moved: 0, removed: 0, created: 0 };
    const created = await appendFn(pool, CFG, 3, [{ sessionId: 1, week: 2, createdBy: 99 }], 6, 1, '节假日调课', stats);
    const news = pool._st.session.filter(r => Number(r.id) !== 1);
    const sh = pool._st.session_shift;
    const d = pool._st.duty.find(r => r.id === 100);
    out.c3 = news.length === 1 && news[0].weeks === '2' && news[0].day_of_week === 6 && news[0].period === 1
      && news[0].course_id === 10 && news[0].group_scope === 'A' && news[0].duty_count === 2
      && news[0].note === '节假日调课'
      && pool._st.session.find(r => r.id === 1).weeks === '2,3'
      && sh.length === 1 && sh[0].session_id === 1 && sh[0].week === 2 && sh[0].kind === 'OFF'
      && d && Number(d.session_id) === Number(created[0]) && d.class_date === '2026-09-26'
      && created.length === 1;
  }

  // 场景 4（① 的现场）：同一门课一周上两次 ⇒ 两个 target 落同一 key ⇒
  //   只建 1 条新课次，但**两条值日都要搬过去**（早先 continue 掉了第二条 ⇒ 孤儿）
  {
    const pool = makePool({
      session: [
        { id: 1, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2,3', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: 'A', duty_count: 2, note: '' },
        { id: 2, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2,3', week_rule: 'ALL', day_of_week: 4, period: 3, group_scope: 'A', duty_count: 2, note: '' }
      ],
      duty: [
        { id: 100, session_id: 1, week: 2, class_date: '2026-09-22', member_id: 7, status: 'PENDING' },
        { id: 101, session_id: 2, week: 2, class_date: '2026-09-23', member_id: 8, status: 'PENDING' }
      ],
      member: [{ id: 7, duty_count: 5 }, { id: 8, duty_count: 3 }]
    });
    const stats = { moved: 0, removed: 0, created: 0 };
    let threw = null;
    try {
      await appendFn(pool, CFG, 3, [
        { sessionId: 1, week: 2, createdBy: 99 },
        { sessionId: 2, week: 2, createdBy: 99 }
      ], 6, 1, '节假日调课', stats);
    } catch (e) { threw = e; }
    const news = pool._st.session.filter(r => Number(r.id) !== 1 && Number(r.id) !== 2);
    out.c4 = threw === null && stats.created === 1 && news.length === 1
      && pool._st.duty.filter(r => Number(r.session_id) === Number(news[0].id)).length === 2
      && stats.moved === 2;
  }

  // 场景 5：跨班隔离 —— 别班的课次 id 传进来也不改
  {
    const pool = makePool({
      session: [
        { id: 1, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: null, duty_count: 2, note: '' },
        { id: 2, class_id: 9, course_id: 10, kind: 'COURSE', weeks: '2', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: null, duty_count: 2, note: '' }
      ],
      duty: [], member: []
    });
    const stats = { moved: 0, removed: 0, created: 0 };
    await moveFn(pool, CFG, 3, [1, 2], 6, 1, stats);
    const other = pool._st.session.find(r => r.id === 2);
    out.c5 = other.day_of_week === 3 && other.period === 2;
  }

  return out;
}

/**
 * 场景 6（2026-10-08 新增）：date 模式 + 「新建课次后课表」。
 * 整日挪到另一天 ⇒ toPeriod 缺省（= 各课次保留自己的节次）。
 *断言：
 *   ① 新课次的 period **不为 NULL**（session.period 是必填语义列，写 NULL 课表读不出来）
 *   ② 且**等于该原课次自己的 period**（节次不变，不是全落到第 1 节）
 *   ③ day_of_week 仍按传入的 toDay 落（只有星期变了）
 * ⚠️ 这一组是 C9 变异的靶子：不回退 s.period 就会① 崩。
 */
async function runDateAppendScenario(appendFn) {
  const pool = makePool({
    session: [
      // 两门课：周三第 2 节 / 周三第 4 节（同日、同一周、节次不同）
      { id: 1, class_id: 3, course_id: 10, kind: 'COURSE', weeks: '2,3', week_rule: 'ALL', day_of_week: 3, period: 2, group_scope: null, duty_count: 2, note: '' },
      { id: 2, class_id: 3, course_id: 11, kind: 'COURSE', weeks: '2,3', week_rule: 'ALL', day_of_week: 3, period: 4, group_scope: null, duty_count: 2, note: '' }
    ],
    duty: [
      { id: 100, session_id: 1, week: 2, class_date: '2026-09-22', member_id: 7, status: 'PENDING' },
      { id: 101, session_id: 2, week: 2, class_date: '2026-09-22', member_id: 8, status: 'PENDING' }
    ],
    member: [{ id: 7, duty_count: 5 }, { id: 8, duty_count: 3 }]
  });
  const stats = { moved: 0, removed: 0, created: 0 };
  // toDay=6（周六）、toPeriod=null ← date 模式「节次不变」
  await appendFn(pool, CFG, 3, [
    { sessionId: 1, week: 2, createdBy: 99 },
    { sessionId: 2, week: 2, createdBy: 99 }
  ], 6, null, '节假日调课', stats);
  const news = pool._st.session.filter(r => Number(r.id) !== 1 && Number(r.id) !== 2);
  const n1 = news.find(r => Number(r.course_id) === 10);
  const n2 = news.find(r => Number(r.course_id) === 11);
  return {
    created2: news.length === 2 && stats.created === 2,
    noNullPeriod: news.length > 0 && news.every(r => Number(r.period) >= 1 && Number(r.period) <= 5),
    keepsOwn2: !!n1 && Number(n1.period) === 2,
    keepsOwn4: !!n2 && Number(n2.period) === 4,
    dayMovedTo6: news.every(r => Number(r.day_of_week) === 6),
    weeksOneWeek: news.every(r => r.weeks === '2')
  };
}

(async function main() {
  const real = await runScenarios(moveSessionSlots, appendSessionSlots);
  check('B1 批量挪位：改格 + weeks 保留 + 值日日期重算', real.c1);
  check('B2 撞同日重复：删目标周原有的、保留跟着挪的、回滚游标', real.c2);
  check('B3 新建课次：单周新课次 + 原课次不动 + OFF + 值日搬迁 + note', real.c3);
  check('B4 同 key 两个 target：只建一条课次，但两条值日都搬（不孤儿）', real.c4);
  check('B5 跨班隔离：别班课次不被改', real.c5);

  // B6（2026-10-08 新增）：date 模式 + 新建课次，toPeriod 缺省 ⇒ 各自保留原节次
  const s6 = await runDateAppendScenario(appendSessionSlots);
  check('B6a date+新建课次：确实建出 2 条新课次（场景本身没坏）', s6.created2, s6);
  check('B6b date+新建课次：新课次 period 不为 NULL（必填语义列）', s6.noNullPeriod, s6);
  check('B6c date+新建课次：各课次保留自己的节次（2 仍是 2、4 仍是 4，不是全落第 1 节）',
    s6.keepsOwn2 && s6.keepsOwn4, s6);
  check('B6d date+新建课次：星期照挪（day_of_week=6）、周次只写目标周',
    s6.dayMovedTo6 && s6.weeksOneWeek, s6);

  /* ---- 变异自证：拆掉任一环必须被抓（变异只在内存副本上做，不写盘） ---- */
  console.log('\n【C】变异自证（不写盘）');

  // 变异 1：还原 ① —— madeKey 命中后 continue（第二个课次的值日不搬 ⇒ 孤儿）
  // 锚点用**真实代码行** `let nid = madeKey[key];`，别用 `if (madeKey[key]) {...}`：
  // 那是修复前的旧写法，源码已改成「先取值再 if (!nid)」，旧 pattern 会静默匹配失败
  // ⇒ 变异没生效 ⇒ 门禁看着在跑、实际是假自证。
  const ANCHOR1 = 'let nid = madeKey[key];';
  if (APPEND.indexOf(ANCHOR1) < 0) {
    check('C1 前置检查：锚点 `' + ANCHOR1 + '` 必须存在（否则变异无效 = 假自证）', false);
  } else {
    const APPEND_M1 = APPEND.replace(ANCHOR1, ANCHOR1 + '\n    if (nid) { continue; }  /* 故意 continue */');
    const appendM1 = new Function('week', 'rollbackDutyMarkers', 'DAY_TEXT',
      APPEND_M1 + '\nreturn appendSessionSlots;')(week, rollbackDutyMarkers, DAY_TEXT);
    const m1 = await runScenarios(moveSessionSlots, appendM1);
    check('C1 变异（去重处 continue）→ 场景4 必须判死', !m1.c4, '未被抓住 = 门禁失效');
  }

  // 变异 2：还原 ② —— 反过来删「跟着课走这条」，保留目标周原有的
  const MOVE_M2 = MOVE
    .replace('const dupIds = dups.map(r => Number(r.id));',
      'const dupIds = dups.map(r => Number(r.id)); const keepFollow = dutyIds; dupIds.length = 0; void keepFollow;')
    .replace(/const dupIds = dups\.map\(r => Number\(r\.id\)\);[\s\S]*?stats\.removed \+= dupIds\.length; \}/,
      'const dupIds = dutyIds.slice(); if (dupIds.length) { await rollbackDutyMarkers(conn, dupIds); await conn.query(`DELETE FROM duty WHERE id IN (${dupIds.join(",")})`, dupIds); stats.removed += dupIds.length; }')
    .replace('if (dupIds.indexOf(Number(d.id)) >= 0) continue;', '');
  const moveM2 = new Function('week', 'rollbackDutyMarkers', 'DAY_TEXT',
    MOVE_M2 + '\nreturn moveSessionSlots;')(week, rollbackDutyMarkers, DAY_TEXT);
  const m2 = await runScenarios(moveM2, appendSessionSlots);
  check('C2 变异（删跟着挪的那条）→ 场景2 必须判死', !m2.c2, '未被抓住 = 门禁失效');

  // 变异 3：把整段 madeKey 去重删掉（防止有人「顺手清理」把同课重复插进去）
  const APPEND_M3 = APPEND.replace(/const madeKey = \{\};/, 'const madeKey = {}; void madeKey;')
    .replace('if (!nid) {', 'if (true) {');
  const appendM3 = new Function('week', 'rollbackDutyMarkers', 'DAY_TEXT',
    APPEND_M3 + '\nreturn appendSessionSlots;')(week, rollbackDutyMarkers, DAY_TEXT);
  const m3 = await runScenarios(moveSessionSlots, appendM3);
  check('C3 变异（去掉 madeKey 去重）→ 场景4 必须判死', !m3.c4, '未被抓住 = 门禁失效');

  // 变异 4：破坏跨班隔离。
  // ⚠️ 必须**同时**去掉 SELECT 和 UPDATE 两处的 class_id 才是真变异 ——
  //    只去掉 SELECT 那一处，UPDATE 的 `WHERE class_id = ?` 仍会挡住写入，
  //    结果依然正确 ⇒ 那种单点变异本来就不该判死（写了才是假自证）。
  const ANCHOR4A = 'WHERE class_id = ? AND id IN (${ph})';
  const ANCHOR4B = 'UPDATE session SET day_of_week = ?, period = ? WHERE class_id = ? AND id = ?';
  if (MOVE.indexOf(ANCHOR4A) < 0 || MOVE.indexOf(ANCHOR4B) < 0) {
    check('C4 前置检查：两处 class_id 锚点必须都在（否则变异无效 = 假自证）', false);
  } else {
    const MOVE_M4 = MOVE
      .replace(ANCHOR4A, 'WHERE id IN (${ph})')
      .replace('[classId].concat(sessionIds)', 'sessionIds')
      .replace(ANCHOR4B, 'UPDATE session SET day_of_week = ?, period = ? WHERE id = ?')
      .replace('[toDay, toPeriod, classId, s.id]', '[toDay, toPeriod, s.id]');
    const moveM4 = new Function('week', 'rollbackDutyMarkers', 'DAY_TEXT',
      MOVE_M4 + '\nreturn moveSessionSlots;')(week, rollbackDutyMarkers, DAY_TEXT);
    const m4 = await runScenarios(moveM4, appendSessionSlots);
    check('C4 变异（SELECT+UPDATE 都不校验 class_id）→ 场景5 必须判死', !m4.c5, '未被抓住 = 门禁失效');
  }

  /* ---- C5..C7：本次「请选择改到星期几」事故的三处口径，拆任一必须判死 ----
   * 变异全在内存副本上做（judge(mutated)），本函数内禁止 fs.writeFileSync。*/
  // 变异 5：把「byDates 时放行缺省」改回「无条件要求 toDay」—— 也就是把修复前的
  // 死路改回来。A6 必须判红。
  const M5 = SHIFTSET.replace(
    /if \(!byDates && !\(toDay >= 1 && toDay <= 7\)\) throw new BizError\(41001, '请选择改到星期几'\);/,
    "if (!(toDay >= 1 && toDay <= 7)) throw new BizError(41001, '请选择改到星期几');");
  check('C5 前置：变异 5 的锚点必须命中（否则是假自证）', M5 !== SHIFTSET);
  check('C5 变异（byDates 放行改回无条件必填）→ A6 判据必须判死',
    !/if \(!byDates && !\(toDay >= 1 && toDay <= 7\)\)/.test(stripComments(M5)), '未被抓住 = 门禁失效');

  // 变异 6：effDay 回退去掉（toDay 缺省时把 null 传进 syncDutyForShift）
  //        ⇒ 值日停在旧日期变孤儿。A8 必须判红。
  const M6 = SHIFTSET.replace(
    /const effDay = \(toDay >= 1 && toDay <= 7\) \? toDay : Number\(t\.dayOfWeek\);/,
    'const effDay = toDay;');
  check('C6 前置：变异 6 的锚点必须命中（否则是假自证）', M6 !== SHIFTSET);
  check('C6 变异（effDay 不回退到 t.dayOfWeek）→ A8 判据必须判死',
    !/const effDay = \(toDay >= 1 && toDay <= 7\)/.test(stripComments(M6)), '未被抓住 = 门禁失效');

  // 变异 7：前端把 date 模式的 toDay 又删掉（回到出事那版）
  //        ⇒ 云端必报「请选择改到星期几」。
  // 2026-10-08：随 C3 向导回退，旧版没有 `toDay: util.weekdayOfNum(d.shiftToDate)`
  // 这行（toDay 直取 shiftToDay），故变异改成「把 `move ? shiftToDay : null` 的
  // move 分支掏空」—— 这才是旧版等价的事故形态：move 时 toDay 变 null ⇒ 同样报
  // 「请选择改到星期几」。守的是同一条不变量：move 路径必须有合法星期几。
  // ⚠️ 旧版里这行出现**两次**（week 单周次 + multi 多周次各一处），`String.replace`
  // 无 /g 只改第一处 ⇒ 变异体里第二处仍在，判据照样通过 = 假自证。必须全量替换。
  const M7 = TT_CODE.replace(
    /const toDay = move \? this\.data\.shiftToDay : null;/g,
    'const toDay = null;');
  check('C7 前置：变异 7 的锚点必须命中（否则是假自证）', M7 !== TT_CODE);
  check('C7 变异（date 模式 move 时 toDay 变 null）→ A9~A11 判据必须判死',
    !/const toDay = move \? this\.data\.shiftToDay : null;/.test(M7), '未被抓住 = 门禁失效');

  // 变异 8：normalizePlan 把 byDates 的 toPeriod 放行删掉（回到首轮修复前的死路）
  //        ⇒ date + APPEND 报「第 N 条：缺目标节次（1-5）」。A12 必须判红。
  const M8 = NORMALIZE.replace(/if \(byDates && !hasToPeriod\) item\.toPeriod = null;/, '');
  check('C8 前置：变异 8 的锚点必须命中（否则是假自证）', M8 !== NORMALIZE);
  check('C8 变异（normalizePlan 不放行 toPeriod 缺省）→ A12 判据必须判死',
    !/if \(byDates && !hasToPeriod\) item\.toPeriod = null;/.test(stripComments(M8)), '未被抓住 = 门禁失效');

  // 变异 9：appendSessionSlots 不回退 s.period（直接把 null 写进 session.period）
  //        ⇒ 新课次节次为 NULL，课表上读不出来。A13 必须判红。
  const M9 = APPEND.replace(
    /const effPeriod = \(toPeriod >= 1 && toPeriod <= 5\) \? toPeriod : Number\(s\.period\);/,
    'const effPeriod = toPeriod;');
  check('C9 前置：变异 9 的锚点必须命中（否则是假自证）', M9 !== APPEND);
  check('C9 变异（effPeriod 不回退 s.period）→ A13 判据必须判死',
    !/const effPeriod = \(toPeriod >= 1 && toPeriod <= 5\)/.test(stripComments(M9)), '未被抓住 = 门禁失效');

  // 变异 10：把「按课次定位必须给全」这条护栏整段删掉
  //         ⇒ week/multi/batch 模式漏填星期/节次会被静默当「保留原值」，把人调了个寂寞。A14 必须判红。
  const M10 = NORMALIZE.replace(/if \(!byDates\) \{[\s\S]*?\n\s*\}/, '');
  check('C10 前置：变异 10 的锚点必须命中（否则是假自证）', M10 !== NORMALIZE);
  check('C10 变异（删掉「按课次定位必须给全」护栏）→ A14 判据必须判死',
    !/条：缺目标星期/.test(stripComments(M10)), '未被抓住 = 门禁失效');

  // 变异 9 复用：除结构判据外，还要**行为层**判死 —— effPeriod 不回退时
  //   新课次 period 变 NULL，场景 6 的 noNullPeriod / keepsOwn* 必须崩。
  //⚠️ 必须把 M9（变异体）真正注入去跑，不能拿未变异的 appendSessionSlots
  //   ——那样等于没变异，自证必然假通过。
  if (M9 === APPEND) {
    check('C9b 前置：变异 9 的文本必须与原体不同（否则自证无意义）', false);
  } else {
    const appendM9 = new Function('week', 'rollbackDutyMarkers', 'DAY_TEXT',
      M9 + '\nreturn appendSessionSlots;')(week, rollbackDutyMarkers, DAY_TEXT);
    const s6m9 = await runDateAppendScenario(appendM9);
    // ⚠️ 极性：变异体注入后，场景 6 的正确性断言必须**不再成立**（被抓住）。
    //   若这里写成 `s6m9.xxx`（要求为 true），等于把「成功抓住变异」报成 FAIL。
    check('C9b 变异（effPeriod 不回退）→ 场景6 行为必须判死',
      !(s6m9.noNullPeriod && s6m9.keepsOwn2 && s6m9.keepsOwn4), '未被抓住 = 门禁失效');
    check('C9b 变异（effPeriod 不回退）→ noNullPeriod 必须崩（定位到具体崩点）',
      s6m9.noNullPeriod === false, 'noNullPeriod 仍为 true = 变异没生效或断言打错位置');
  }

  console.log();
  if (fail) {
    console.log('❌ 失败 ' + fail + ' 项 / 共 ' + (pass + fail));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅（' + pass + ' 项）');
  }
})();
