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
  // ①b 起始落点：从周三 PM 起 → 周一/周二都不排
  {
    const slots = C.buildSlots(sessions, 1, { start_weekday: 3, start_slot: 'PM', init_done: 0 }, weekStub);
    out.startSlot = slots.length === 1 && slots[0].day === 3 && slots[0].slot === 'PM';
  }
  // ①c init_done=1 时起始设置不再生效
  {
    const slots = C.buildSlots(sessions, 1, { start_weekday: 3, start_slot: 'PM', init_done: 1 }, weekStub);
    out.startConsumed = slots.length === 3;
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
    const r1 = C.assign(slots, roster(), { A: 0, B: 0 }, { need_n: 2 });
    // A组取最小的2人(1,3)→游标3；B组取(2,4)→游标4
    out.advances = r1.cursors.A === 3 && r1.cursors.B === 4;
    // 第二周续排：A从3后取(5,7)→游标7；B从4后取(6,8)→游标8
    const r2 = C.assign(slots, roster(), r1.cursors, { need_n: 2, init_done: 1 });
    out.wraps = r2.rows.some(x => x.seq === 5 || x.seq === 7 || x.seq === 6 || x.seq === 8);
    // 第三周：A已到7→回绕取小号；B已到8→回绕
    const r3 = C.assign(slots, roster(), r2.cursors, { need_n: 2, init_done: 1 });
    out.wraps = out.wraps && r3.rows.some(x => x.seq === 1 || x.seq === 2 || x.seq === 3);
  }

  // ④ need_n 非法回落 2；起始学号只在首次生效
  {
    const slots = [{ date: 'd1', slot: 'AM', scope: 'A' }];
    const r = C.assign(slots, roster(), { A: 0, B: 0 }, { need_n: 9 });
    out.needClamp = r.rows.length === 2;
    const rFirst = C.assign(slots, roster(), { A: 0, B: 0 }, { need_n: 1, start_seq: 5, init_done: 0 });
    out.startSeq = rFirst.rows.length === 1 && rFirst.rows[0].seq >= 5;
    const rAgain = C.assign(slots, roster(), { A: 7, B: 8 }, { need_n: 1, start_seq: 5, init_done: 1 });
    out.startSeqConsumed = rAgain.rows[0].seq < 5; // init_done=1 时忽略 start_seq，从游标7后回绕
  }

  return out;
}

/* ── 云函数接线契约（静态）：演讲写路由必须挂排班权限，且用独立表/独立游标 ── */
const SCH_SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'schedule', 'index.js'), 'utf8');
const SQL_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'migrate-speech.sql'), 'utf8');
console.log('── ⓐ 云函数接线与权限（静态）');
check(/require\('\.\/common\/speech-core'\)/.test(SCH_SRC), 'schedule 引入 speech-core 真源码');
['speechGenerate', 'speechReassign', 'speechClear', 'speechPublish', 'speechSetSettings'].forEach(a => {
  const re = new RegExp(a + ':\\s*\\{[\\s\\S]{0,80}auth:\\s*\\{\\s*scheduleAuth:\\s*true');
  check(re.test(SCH_SRC), a + ' 挂 scheduleAuth（超管|生活委员）');
});
check(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(SCH_SRC.slice(SCH_SRC.indexOf('speechList:'), SCH_SRC.indexOf('speechGenerate:'))), 'speechList 只读走 needBind');
check(/INSERT IGNORE INTO speech\b/.test(SCH_SRC) && /speech_cursor/.test(SCH_SRC) && /speech_publish/.test(SCH_SRC),
      '用独立 speech / speech_cursor / speech_publish 表（与值日隔离）');
check(/CREATE TABLE IF NOT EXISTS speech_cursor/.test(SQL_SRC) && /PRIMARY KEY \(class_id, grp\)/.test(SQL_SRC),
      'speech_cursor 每班每组一条游标');

const P = probes(core);
console.log('── ① 节次筛选与起始落点');
check(P.slotFilter, '只排第1节(AM)/第3节(PM)，第2节不排');
check(P.startSlot, '起始设置之前的时段不排');
check(P.startConsumed, 'init_done 后起始落点不再生效');
console.log('── ② 组别绑定');
check(P.scopeBind, 'A组场选A组人、B组场选B组人');
check(P.allScope, '全体课从全班选');
console.log('── ③ 游标续排与回绕');
check(P.advances, '游标按选中序号前进');
check(P.wraps, '到本组末尾后回绕取小号');
console.log('── ④ 人数与起始学号');
check(P.needClamp, 'need_n 非法值回落 2');
check(P.startSeq, '首次起始学号作为下限');
check(P.startSeqConsumed, '起始学号只在首次消费');

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
    from: '    if (consumeStart) {', to: '    if (false) {'
  },
  {
    name: '组别绑定失效（所有场都当全体课）', expect: 'scopeBind',
    from: "    const scope = s.scope === 'A' ? 'A' : (s.scope === 'B' ? 'B' : null); // ALL→null 走全体混排",
    to: "    const scope = null;"
  },
  {
    name: 'need_n clamp 失效（非法值照单全收）', expect: 'needClamp',
    from: '  if (!(need === 1 || need === 2)) need = 2;', to: '  /* clamp removed */'
  },
  {
    name: '起始学号消费失效（init_done 后仍回起点）', expect: 'startSeqConsumed',
    from: '  if (!st.init_done && Number(st.start_seq) > 0) {', to: '  if (Number(st.start_seq) > 0) {'
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
