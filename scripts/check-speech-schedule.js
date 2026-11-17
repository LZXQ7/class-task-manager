#!/usr/bin/env node
/**
 * 门禁：课前演讲排班内核（2026-11-16）
 * ============================================================
 * 用 require 真加载 cloudfunctions/common/speech-core.js（不抄副本），断言用户 grill 定稿的口径：
 *   ① 只挑第1节(AM)/第3节(PM)的课；起始设置之前的时段不排
 *   ② 演讲人组跟随课次 group_scope；全体课走两组混排
 *   ③ A/B 游标独立、跨周续排、到末尾回绕；换人不动游标（云函数层锁）
 *   ④ need_n 非法值回落到 2；起始学号只在首次消费
 * 末尾变异自证：每个口径改坏 → 对应探针翻红，防"拿好样本当坏样本"的假绿。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CORE_PATH = path.join(ROOT, 'cloudfunctions', 'common', 'speech-core.js');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/** 加载指定源码字符串为模块（vm 方式：借 Node Module 包装，真跑 round-robin） */
function loadCore(src) {
  const Module = require('module');
  const m = new Module(CORE_PATH, module);
  m.filename = CORE_PATH;
  m.paths = Module._nodeModulePaths(path.dirname(CORE_PATH));
  m._compile(src, CORE_PATH);
  return m.exports;
}
const CORE_SRC = fs.readFileSync(CORE_PATH, 'utf8');
const core = loadCore(CORE_SRC);

const weekStub = { matchesWeeks: (weeks, wk) => (!weeks ? true : String(weeks).split(',').map(Number).indexOf(wk) >= 0) };

/** 测试名册：A组 1,3,5,7；B组 2,4,6,8（seq 即学号序号） */
function roster() {
  return [
    { id: 101, seq: 1, group: 'A' }, { id: 103, seq: 3, group: 'A' },
    { id: 105, seq: 5, group: 'A' }, { id: 107, seq: 7, group: 'A' },
    { id: 102, seq: 2, group: 'B' }, { id: 104, seq: 4, group: 'B' },
    { id: 106, seq: 6, group: 'B' }, { id: 108, seq: 8, group: 'B' }
  ];
}

/** 探针集合：每个返回 boolean；变异样本要让指定探针翻红 */
function probes(C) {
  const out = {};
  const sessions = [
    { id: 1, day_of_week: 1, period: 1, group_scope: 'A', weeks: '', class_date: '2026-11-16' }, // 周一AM A组
    { id: 2, day_of_week: 1, period: 3, group_scope: 'B', weeks: '', class_date: '2026-11-16' }, // 周一PM B组
    { id: 3, day_of_week: 2, period: 2, group_scope: 'A', weeks: '', class_date: '2026-11-17' }, // 周二第2节→不排
    { id: 4, day_of_week: 3, period: 3, group_scope: null, weeks: '', class_date: '2026-11-18' }  // 周三PM 全体
  ];

  // ① 节次筛选：AM/PM 各一条，第2节不排
  {
    const slots = C.buildSlots(sessions, 1, {}, weekStub);
    out.slotFilter = slots.length === 3 &&
      slots[0].slot === 'AM' && slots[1].slot === 'PM' && slots[2].slot === 'PM' &&
      slots.every(s => s.period !== 2);
  }
  // ①b 起始落点（AI 本次指令）：从周三 PM 起 → 周一/周二都不排
  {
    const slots = C.buildSlots(sessions, 1, { start_weekday: 3, start_slot: 'PM' }, weekStub);
    out.startSlot = slots.length === 1 && slots[0].day === 3 && slots[0].slot === 'PM';
  }
  // ①c 不传起始指令时全排（v2 撤掉固定起始设置；AI 指令才带落点）
  {
    const slots = C.buildSlots(sessions, 1, {}, weekStub);
    out.noFixedStart = slots.length === 3;
  }

  // ② 组别绑定：A组场的演讲人都在A组，B组场都在B组
  {
    const slots = [
      { date: 'd1', slot: 'AM', scope: 'A' },
      { date: 'd1', slot: 'PM', scope: 'B' }
    ];
    const r = C.assign(slots, roster(), { A: 0, B: 0 }, { need_n: 2 });
    const am = r.rows.filter(x => x.slot === 'AM');
    const pm = r.rows.filter(x => x.slot === 'PM');
    out.scopeBind = am.length === 2 && pm.length === 2 &&
      am.every(x => x.group === 'A') && pm.every(x => x.group === 'B');
  }
  // ②b 全体课从两组选（混排，不局限一组）
  {
    const slots = [{ date: 'd1', slot: 'PM', scope: 'ALL' }];
    const r = C.assign(slots, roster(), { A: 0, B: 0 }, { need_n: 2 });
    const groups = new Set(r.rows.map(x => x.group));
    out.allScope = r.rows.length === 2 && groups.size >= 1;
  }

  // ③ 游标续排：第一次排到 A=7/B=8 后，第二次从末尾回绕（回到小号）而非停在末尾
  {
    const slots = [
      { date: 'd1', slot: 'AM', scope: 'A' }, { date: 'd1', slot: 'PM', scope: 'B' }
    ];
    const r1 = C.assign(slots, roster(), { A: 0, B: 0 }, {});
    // A组取最小的2人(1,3)→游标3；B组取(2,4)→游标4
    out.advances = r1.cursors.A === 3 && r1.cursors.B === 4;
    // 第二周续排：A从3后取(5,7)→游标7；B从4后取(6,8)→游标8
    const r2 = C.assign(slots, roster(), r1.cursors, {});
    out.wraps = r2.rows.some(x => x.seq === 5 || x.seq === 7 || x.seq === 6 || x.seq === 8);
    // 第三周：A已到7→回绕取小号；B已到8→回绕
    const r3 = C.assign(slots, roster(), r2.cursors, {});
    out.wraps = out.wraps && r3.rows.some(x => x.seq === 1 || x.seq === 2 || x.seq === 3);
  }

  // ④ need_n 非法回落 2；**起点=传入的双游标**（v2：无起始学号，管理员直接设 A/B 已排到号）
  {
    const slots = [{ date: 'd1', slot: 'AM', scope: 'A' }];
    const r = C.assign(slots, roster(), { A: 0, B: 0 }, { need_n: 9 });
    out.needClamp = r.rows.length === 2;
    // 管理员设「A组已排到5」→ 从 7 起（不再有 start_seq 下限）
    const rFrom = C.assign(slots, roster(), { A: 5, B: 0 }, {});
    out.cursorStart = rFrom.rows.length === 2 && rFrom.rows[0].seq === 7;
  }

  // ④b 单场人数覆盖（v2：智能排班「儿童文学仅1人」→ 指定 slot.need=1）
  {
    const slots = [
      { date: 'd1', slot: 'AM', scope: 'A' },
      { date: 'd2', slot: 'AM', scope: 'A', need: 1 }
    ];
    const r = C.assign(slots, roster(), { A: 0, B: 0 }, {});
    const day1 = r.rows.filter(x => x.date === 'd1');
    const day2 = r.rows.filter(x => x.date === 'd2');
    out.perSlotNeed = day1.length === 2 && day2.length === 1;
  }

  return out;
}

/* ── 云函数接线契约（静态）：演讲写路由必须挂排班权限，且用独立表/独立游标 ── */
const SCH_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js'), 'utf8');
const SQL_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-speech.sql'), 'utf8');
console.log('── ⓐ 云函数接线与权限（静态）');
check(/require\('\.\/common\/speech-core'\)/.test(SCH_SRC), 'schedule 引入 speech-core 真源码');
['speechGenerate', 'speechReassign', 'speechClear', 'speechPublish', 'speechSetSettings',
 'speechAiParse', 'speechAiApply'].forEach(a => {
  /* 2026-11-17：演讲写路由改为独立 speechAuth（超管 | 生活委员 | 学习委员 | 后台单独授予）；
     值日仍走 scheduleAuth —— 两者合并等于把值日权一并给学习委员，见 check-speech-perms.js。 */
  const re = new RegExp(a + ':\\s*\\{[\\s\\S]{0,80}auth:\\s*\\{\\s*speechAuth:\\s*true');
  check(re.test(SCH_SRC), a + ' 挂 speechAuth（超管|生活委员|学习委员|单独授予）');
});
check(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(SCH_SRC.slice(SCH_SRC.indexOf('speechList:'), SCH_SRC.indexOf('speechGenerate:'))), 'speechList 只读走 needBind');
check(/INSERT IGNORE INTO speech\b/.test(SCH_SRC) && /speech_cursor/.test(SCH_SRC) && /speech_publish/.test(SCH_SRC),
      '用独立 speech / speech_cursor / speech_publish 表（与值日隔离）');
check(/CREATE TABLE IF NOT EXISTS speech_cursor/.test(SQL_SRC) && /PRIMARY KEY \(class_id, grp\)/.test(SQL_SRC),
      'speech_cursor 每班每组一条游标');

/* v3 游标契约（静态，2026-11-17 口径变更）：
 *   旧 v2 是「generate 只预演、发布才落游标」。后果：连着生成两周草稿时，两周都从同一个
 *   起点起跑，排出逐条相同的人（用户原话「十一周安排过的，十二周又安排了」）。
 *   新 v3：generate 立即推进 speech_cursor，并把「本周之前的游标」记进
 *   speech_publish.base_cursors —— 同周重排 / 清空回滚都靠 base，
 *   所以「清空后重排不跳过清空前的人」这个原诉求仍然成立。
 *   细节判据（含真跑 startCursorsOf）见 check-speech-cursor-advance.js。 */
const genBody = SCH_SRC.slice(SCH_SRC.indexOf('speechGenerate:'), SCH_SRC.indexOf('speechReassign:'));
const pubBody = SCH_SRC.slice(SCH_SRC.indexOf('speechPublish:'), SCH_SRC.indexOf('speechSetSettings:'));
/* 只看真实 SQL 写语句：忽略注释里的 speech_cursor 字样 */
const genSql = genBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(/saveSpeechCursors\(conn,\s*classId,\s*plan\.cursors\)/.test(genSql),
      'speechGenerate 生成即推进 speech_cursor（否则下一周又从原起点重排同一批人）');
check(/async function saveSpeechCursors[\s\S]{0,400}INSERT INTO speech_cursor/.test(SCH_SRC),
      '写游标的 saveSpeechCursors 真落 SQL（不是空壳）');
check(/base_cursors/.test(genSql), 'speechGenerate 记下本周之前的游标 base_cursors（同周重排幂等）');
check(/base_cursors/.test(pubBody) && /cursor_snapshot/.test(pubBody),
      'speechPublish 撤回快照取 base_cursors（本周之前的游标）');
check(/speechAiParse[\s\S]{0,4000}callAi|callAi[\s\S]{0,6000}speechAiParse/.test(SCH_SRC),
      'AI 智能排班解析走 callAi（ai-proxy）');
check(/单双号|奇数.*A|奇数.*偶数|seq\s*%\s*2/.test(SCH_SRC),
      '组别校验按学号单双号（单=A / 双=B）');

const P = probes(core);
console.log('── ① 节次筛选与起始落点');
check(P.slotFilter, '只排第1节(AM)/第3节(PM)，第2节不排');
check(P.startSlot, 'AI 起始落点之前的时段不排');
check(P.noFixedStart, '无起始指令时全排（已撤固定起始设置）');
console.log('── ② 组别绑定');
check(P.scopeBind, 'A组场选A组人、B组场选B组人');
check(P.allScope, '全体课从全班选');
console.log('── ③ 游标续排与回绕');
check(P.advances, '游标按选中序号前进');
check(P.wraps, '到本组末尾后回绕取小号');
console.log('── ④ 人数与起点');
check(P.needClamp, 'need_n 非法值回落 2');
check(P.cursorStart, '起点=管理员设的双游标（A已排到5 → 从7起）');
check(P.perSlotNeed, '单场人数覆盖（智能排班指定某场1人）');

/* ============================================================
 * 变异自证：把口径改坏，对应探针必须翻红
 * ============================================================ */
console.log('── ⑤ 变异自证');
const MUT = [
  {
    name: '节次映射改成第2节（AM 盯错节）', expect: 'slotFilter',
    from: 'const AM_PERIOD = 1;', to: 'const AM_PERIOD = 2;'
  },
  {
    name: '去掉起始落点过滤（之前时段也排）', expect: 'startSlot',
    from: '  if (useStart) {', to: '  if (false) {'
  },
  {
    name: '组别绑定失效（所有场都当全体课）', expect: 'scopeBind',
    from: "    const scope = s.scope === 'A' ? 'A' : (s.scope === 'B' ? 'B' : null); // ALL→null 走全体混排",
    to: "      const scope = null;"
  },
  {
    name: 'need_n clamp 失效（非法值照单全收）', expect: 'needClamp',
    from: '  if (!(need === 1 || need === 2)) need = 2;', to: '  /* clamp removed */'
  },
  {
    name: '起点双游标失效（忽略传入游标，从0起）', expect: 'cursorStart',
    from: '  const cur = Object.assign({ A: 0, B: 0 }, cursors || {});',
    to: '  const cur = { A: 0, B: 0 };'
  },
  {
    name: '单场人数覆盖失效（指定1人仍按默认2人）', expect: 'perSlotNeed',
    from: '    const needThis = Number(s.need) === 1 || Number(s.need) === 2 ? Number(s.need) : need;',
    to: '    const needThis = need;'
  }
];

MUT.forEach(mu => {
  if (CORE_SRC.indexOf(mu.from) < 0) { bad('变异锚点没命中：' + mu.name); return; }
  const badSrc = CORE_SRC.replace(mu.from, mu.to);
  if (badSrc === CORE_SRC) { bad('变异替换未生效：' + mu.name); return; }
  let badP;
  try { badP = probes(loadCore(badSrc)); }
  catch (e) { ok('变异被抓（抛错）：' + mu.name + ' → ' + e.message); return; }
  if (badP[mu.expect] === false) ok('变异被抓：' + mu.name);
  else bad('变异未翻红（假绿）：' + mu.name + ' → ' + mu.expect);
});

console.log(failed ? '\nFAIL · 课前演讲门禁 ' + failed + ' 项未通过'
                   : '\nOK · 课前演讲排班门禁全部通过');
process.exit(failed ? 1 : 0);
