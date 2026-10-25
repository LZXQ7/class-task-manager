#!/usr/bin/env node
/**
 * 回归门禁：值日轮转「按序号连续轮转、绝不从 1 号重排」。
 * =================================================================
 * 2026-10-23 实锤 bug：class 3 第 7 周一键生成从 1 号重新开始（截图证实），
 * 而第 6 周实际结束于 a组7号 / b组10号。根因：v2 游标系统上线前的周没有
 * `duty_week_cursor` 快照，且 `class.round_cursor_*` 从未被写过（恒为 0），
 * 导致这些周的下一周「一键生成」把 fallback 全局游标当成 0/0，整周从 1 号重排。
 *
 * 修复（见 cloudfunctions/common/schedule-core.js 的 inferStartFromPrevWeek）：
 *   loadWeekCursors 的兜底链 = 快照 → 上一周实际落库排班反推 → 全局游标。
 *   任何「无快照且全局游标为 0」的情况都改为「从上一周实际排班接着排」，
 *   永不从 1 号重排。
 *
 * 本门禁用 mock conn 验证这套逻辑，不依赖生产库，可离线秒级跑：
 *   T1  无快照 + 有上周实际排班  ⇒ 反推上周结束游标（a=7/b=10），inferred=true
 *   T2  T1 的结果绝不是 {0,0}（即旧的「从 1 号重排」bug 已修）
 *   T3  无任何历史（连上周都没有）⇒ 退回全局游标 fallback
 *   T4  有快照 ⇒ 直接返回快照，不再反推
 *   T5  跨周连续性集成：用真实 round-robin 内核连跑 4 周，
 *       第 N+1 周起点 === 第 N 周结束点，且第 2 周绝不从 1 号起。
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const path = require('path');
const SCORE = require(path.resolve(__dirname, '../cloudfunctions/common/schedule-core.js'));

const seqOf = (s) => {
  const x = String(s == null ? '' : s).replace(/\D/g, '');
  const n = parseInt(x.slice(-2), 10);
  return isNaN(n) ? 0 : n;
};

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); failures += 1; }
}

/**
 * 构造一个 mock conn，按 SQL 子串返回预设数据。
 * @param {object} sc 场景：
 *   snapshot: [{start_a,start_b}] | []             duty_week_cursor 行
 *   prevWeek: number|null                          SELECT MAX(week) ... week<?
 *   maxIdRows: [{g,max_id}]                       上周 AUTO 行分组 MAX(d.id)
 *   seqById: { [id]: {g, student_no} }             按 id 查学号
 */
function mockConn(sc) {
  return {
    async query(sql, args) {
      if (/FROM duty_week_cursor/.test(sql)) {
        return [sc.snapshot || []];
      }
      if (/MAX\(week\) AS pw FROM duty/.test(sql)) {
        return [[{ pw: sc.prevWeek ?? null }]];
      }
      if (/MAX\(d\.id\) AS max_id/.test(sql)) {
        return [sc.maxIdRows || []];
      }
      if (/WHERE d\.id IN/.test(sql)) {
        const rows = Object.keys(sc.seqById || {}).map(id => ({
          g: sc.seqById[id].g,
          student_no: sc.seqById[id].student_no
        }));
        return [rows];
      }
      return [[]];
    }
  };
}

(async () => {
  console.log('T1 无快照 + 有上周实际排班 ⇒ 反推上周结束游标');
  {
    const conn = mockConn({
      snapshot: [],
      prevWeek: 6,
      maxIdRows: [{ g: 'A', max_id: 601 }, { g: 'B', max_id: 602 }],
      seqById: { 601: { g: 'A', student_no: '000000000307' }, 602: { g: 'B', student_no: '000000000310' } }
    });
    const r = await SCORE.loadWeekCursors(conn, 3, 7, { A: 0, B: 0 });
    assert(r.A === 7 && r.B === 10, 'week7 起点反推为 a=7/b=10（接第6周结束），实际 ' + JSON.stringify(r));
    assert(r.inferred === true, '标记 inferred=true（来自上周实际排班反推）');
    assert(r.hasSnapshot === false, 'hasSnapshot=false（无快照）');
  }

  console.log('T2 T1 结果绝不是 {0,0}（旧「从1号重排」bug 已修）');
  {
    const conn = mockConn({
      snapshot: [],
      prevWeek: 6,
      maxIdRows: [{ g: 'A', max_id: 601 }, { g: 'B', max_id: 602 }],
      seqById: { 601: { g: 'A', student_no: '000000000307' }, 602: { g: 'B', student_no: '000000000310' } }
    });
    const r = await SCORE.loadWeekCursors(conn, 3, 7, { A: 0, B: 0 });
    assert(!(r.A === 0 && r.B === 0), 'week7 起点不是 0/0（否则会重排到 1 号）');
  }

  console.log('T3 无任何历史（连上周都没有）⇒ 退回全局游标 fallback');
  {
    const conn = mockConn({ snapshot: [], prevWeek: null, maxIdRows: [], seqById: {} });
    const r = await SCORE.loadWeekCursors(conn, 3, 7, { A: 0, B: 0 });
    assert(r.A === 0 && r.B === 0 && r.inferred !== true, '无历史时退回 fallback 0/0，不反推');
  }

  console.log('T4 有快照 ⇒ 直接返回快照，不再反推');
  {
    const conn = mockConn({
      snapshot: [{ start_a: 7, start_b: 10 }],
      prevWeek: 6,
      maxIdRows: [{ g: 'A', max_id: 999 }],
      seqById: { 999: { g: 'A', student_no: '000000000399' } }
    });
    const r = await SCORE.loadWeekCursors(conn, 3, 7, { A: 0, B: 0 });
    assert(r.A === 7 && r.B === 10 && r.hasSnapshot === true && r.inferred !== true, '有快照直接返回 7/10，不触发反推');
  }

  console.log('T6 回归：无快照+上一周有快照+有 legacy duty 行 ⇒ 取上一周快照结束游标，不被 MAX(id) 反推篡夺');
  {
    // 上一周(7)有快照 end=53/54；同时该周有 legacy duty 行会让 inferStartFromPrevWeek 反推出错值 7/10。
    // 修复前：loadWeekCursors(8) 先走 inferStartFromPrevWeek → 返回 7/10（错）；
    // 修复后：先读上一周快照结束游标 → 返回 53/54（对）。
    const conn = (() => {
      const snaps = { '3:7': { start_a: 1, start_b: 2, end_a: 53, end_b: 54 } };
      // 🔴 所有分支必须返回 [rows, fields] 形状（mysql2 约定），否则 loadWeekCursors
      //    里 `const [rows] = await conn.query(...)` 会解构成 undefined → 翻车。
      return {
        async query(sql, args) {
          if (/SELECT start_a, start_b FROM duty_week_cursor WHERE class_id = \? AND week = \?/.test(sql)) {
            const k = args[0] + ':' + args[1];
            return [snaps[k] ? [{ start_a: snaps[k].start_a, start_b: snaps[k].start_b }] : []];
          }
          if (/SELECT end_a, end_b FROM duty_week_cursor WHERE class_id = \? AND week < \? ORDER BY week DESC LIMIT 1/.test(sql)) {
            const cid = args[0], wk = Number(args[1]);
            let best = null;
            for (const key of Object.keys(snaps)) {
              if (key.startsWith(cid + ':')) {
                const w = Number(key.split(':')[1]);
                if (w < wk && (best === null || w > best)) best = w;
              }
            }
            return [best !== null ? [{ end_a: snaps[cid + ':' + best].end_a, end_b: snaps[cid + ':' + best].end_b }] : []];
          }
          if (/MAX\(week\) AS pw FROM duty/.test(sql)) return [[{ pw: 7 }]];
          if (/MAX\(d\.id\) AS max_id/.test(sql)) return [[{ g: 'A', max_id: 7001 }, { g: 'B', max_id: 7002 }]];
          if (/WHERE d\.id IN/.test(sql)) return [[{ g: 'A', student_no: '000000000307' }, { g: 'B', student_no: '000000000310' }]];
          return [[]];
        }
      };
    })();
    const r = await SCORE.loadWeekCursors(conn, 3, 8, { A: 0, B: 0 });
    assert(r.A === 53 && r.B === 54, 'week8 起点=上一周(7)快照结束游标 53/54（接第7周结束），实际 ' + JSON.stringify(r));
    assert(r.hasSnapshot === false, 'week8 无快照但仍沿用上一周结束游标（hasSnapshot=false）');
    assert(r.inferred !== true, '未触发 inferStartFromPrevWeek 反推（否则会被错置成 7/10）');
  }

  console.log('T5 跨周连续性集成（真实 loadWeekCursors/saveWeekCursors/syncGlobalCursors）');
  {
    // 名册：A 组 1..12、B 组 1..10（模拟序号，学号末两位=序号）
    const roster = [];
    for (let i = 1; i <= 12; i++) roster.push({ id: 1000 + i, group: 'A', seq: i, student_no: 'x' + String(i).padStart(2, '0') });
    for (let i = 1; i <= 10; i++) roster.push({ id: 2000 + i, group: 'B', seq: i, student_no: 'y' + String(i).padStart(2, '0') });

    // 内存版「按周快照 + 全局游标」，模拟 duty_week_cursor 表；**直接用真实落库函数**
    const { buildState, pickBySeq, loadWeekCursors, saveWeekCursors, syncGlobalCursors } = SCORE;
    const snaps = {}; // `${classId}:${wk}` -> {start_a,start_b,end_a,end_b}
    // 全局游标（class.round_cursor_*）：作为 step③ 兜底。本测试靠快照链续接，
    // 这里给冷启动 0/0 即可（第 1 周无历史时的起点），不参与后续周次续接。
    let globalCur = { A: 0, B: 0 };
    const fakeConn = {
      async query(sql, args) {
        if (/SELECT start_a, start_b FROM duty_week_cursor WHERE class_id = \? AND week = \?/.test(sql)) {
          const k = args[0] + ':' + args[1];
          return [snaps[k] ? [{ start_a: snaps[k].start_a, start_b: snaps[k].start_b }] : []];
        }
        if (/SELECT end_a, end_b FROM duty_week_cursor WHERE class_id = \? AND week < \? ORDER BY week DESC LIMIT 1/.test(sql)) {
          const cid = args[0], wk = Number(args[1]);
          let best = null;
          for (const key of Object.keys(snaps)) {
            if (key.startsWith(cid + ':')) {
              const w = Number(key.split(':')[1]);
              if (w < wk && (best === null || w > best)) best = w;
            }
          }
          return [best !== null ? [{ end_a: snaps[cid + ':' + best].end_a, end_b: snaps[cid + ':' + best].end_b }] : []];
        }
        // syncGlobalCursors 取「最大周次的结束游标」对齐全局游标
        if (/SELECT end_a, end_b FROM duty_week_cursor WHERE class_id = \? ORDER BY week DESC LIMIT 1/.test(sql)) {
          const cid = args[0];
          let best = null;
          for (const key of Object.keys(snaps)) {
            if (key.startsWith(cid + ':')) {
              const w = Number(key.split(':')[1]);
              if (best === null || w > best) best = w;
            }
          }
          return [best !== null ? [{ end_a: snaps[cid + ':' + best].end_a, end_b: snaps[cid + ':' + best].end_b }] : []];
        }
        if (/SELECT week FROM duty_week_cursor WHERE class_id = \? AND week = \?/.test(sql)) {
          const k = args[0] + ':' + args[1];
          return [snaps[k] ? [{ week: args[1] }] : []];
        }
        if (/INSERT IGNORE INTO duty_week_cursor/.test(sql)) {
          snaps[args[0] + ':' + args[1]] = { start_a: args[2], start_b: args[3], end_a: args[4], end_b: args[5] };
          return [{ insertId: 1 }];
        }
        if (/UPDATE duty_week_cursor SET end_a/.test(sql)) {
          const k = args[2] + ':' + args[3];
          if (snaps[k]) { snaps[k].end_a = args[0]; snaps[k].end_b = args[1]; }
          return [{ affectedRows: 1 }];
        }
        // 让 inferStartFromPrevWeek 落到空（模拟无 legacy duty 行），隔离 step② 行为
        if (/MAX\(week\) AS pw FROM duty/.test(sql)) return [[{ pw: null }]];
        // UPDATE class SET round_cursor_* （saveCursors）— 本测试不校验全局游标本身，吞掉
        if (/UPDATE `class` SET round_cursor/.test(sql)) return [{ affectedRows: 1 }];
        return [[]];
      }
    };
    async function generateWeek(wk) {
      const start = await loadWeekCursors(fakeConn, 3, wk, globalCur);
      const state = buildState(roster, start);
      // 每个课次取 2 人（A 组课 / B 组课 交替），共 6 节课
      const scopes = ['A', 'B', 'A', 'B', 'A', 'B'];
      for (const scope of scopes) {
        pickBySeq(roster, scope, 2, state, {});
      }
      const end = { A: state.cursors.A, B: state.cursors.B };
      await saveWeekCursors(fakeConn, 3, wk, start, end);
      await syncGlobalCursors(fakeConn, 3);
      return { start, end };
    }

    const w1 = await generateWeek(1);
    const w2 = await generateWeek(2);
    const w3 = await generateWeek(3);
    const w4 = await generateWeek(4);

    assert(w2.start.A === w1.end.A && w2.start.B === w1.end.B,
      `第2周起点==第1周结束 (${w1.end.A}/${w1.end.B} → ${w2.start.A}/${w2.start.B})`);
    assert(w3.start.A === w2.end.A && w3.start.B === w2.end.B,
      `第3周起点==第2周结束 (${w2.end.A}/${w2.end.B} → ${w3.start.A}/${w3.start.B})`);
    assert(w4.start.A === w3.end.A && w4.start.B === w3.end.B,
      `第4周起点==第3周结束 (${w3.end.A}/${w3.end.B} → ${w4.start.A}/${w4.start.B})`);
    // 关键：第2周绝不从 1 号起（除非第1周恰好排满整组回到0，但本模拟不会发生）
    assert(!(w2.start.A === 0 && w2.start.B === 0), '第2周没有从 0/0（=1号）重排');
    assert(w2.start.A > 0 || w2.start.B > 0, '第2周起点延续自第1周（>0）');
  }

  console.log('');
  if (failures === 0) { console.log('✅ 全部通过：值日轮转连续性自证通过'); process.exit(0); }
  else { console.log('❌ ' + failures + ' 项失败'); process.exit(1); }
})().catch(e => { console.error('CHECK ERROR', e); process.exit(1); });
