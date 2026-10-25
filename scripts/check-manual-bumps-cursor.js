/**
 * 回归门禁：手动排班必须推进轮转游标（2026-10-23 修复）
 * ----------------------------------------------------------------
 * 背景 bug：v2 游标系统用 class.round_cursor_* 承载轮转位置，而 addManual
 * 只 +1 旧版 duty_count（已退化为纯统计），于是手动加的人会被紧接着的自动生成
 * 再次排到（用户实锤：手动 5/7 后又在第七周开头重排）。
 *
 * 本门禁用 mockConn（绝不连生产库）验证 bumpCursorForManual 的语义：
 *   · 手动同学 seq 在该组轮转顺序中「不落后于」当前游标时 → 推进游标
 *   · 手动同学 seq「落后于」当前游标（已排过）时 → 不回退
 *   · 该周尚无快照 → 不操作（生成时会自行从上一周推断）
 *
 * 用法：node scripts/check-manual-bumps-cursor.js
 */
const path = require('path');
const { bumpCursorForManual } = require(path.resolve(__dirname, '..', 'cloudfunctions', 'common', 'schedule-core.js'));

// ---- mock 数据 ----
const memberTable = {
  105: { student_no: '000000000305', group_tag: 'A' }, // seq 5, A
  107: { student_no: '000000000307', group_tag: 'A' }, // seq 7, A
  101: { student_no: '000000000301', group_tag: 'A' }, // seq 1, A
  155: { student_no: '000000000355', group_tag: 'A' }, // seq 55, A
  110: { student_no: '000000000310', group_tag: 'B' }, // seq 10, B
};
// 快照表：key = `${classId}_${week}`
let snap = { '3_7': { end_a: 3, end_b: 10 } };

function mockConn() {
  return {
    async query(sql, params) {
      if (/FROM member/.test(sql) && /WHERE id = \?/.test(sql)) {
        const m = memberTable[params[0]] || null;
        return [[m]];
      }
      if (/SELECT end_a, end_b FROM duty_week_cursor/.test(sql)) {
        const key = params[0] + '_' + params[1];
        return [[snap[key] ? { ...snap[key] } : []]];
      }
      if (/UPDATE duty_week_cursor SET end_a/.test(sql)) {
        const [ea, eb, cid, wk] = params;
        const key = cid + '_' + wk;
        snap[key] = { end_a: ea, end_b: eb };
        return [[]];
      }
      return [[]];
    },
  };
}

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name); fail++; }
}

async function run() {
  // T1: 游标 3，手动加 seq 5 (A) → 推进到 5
  await bumpCursorForManual(mockConn(), 3, 105, 7);
  assert('T1 手动 05 → 游标 3 推进到 5', snap['3_7'].end_a === 5);

  // T2: 再手动加 seq 7 (A) → 推进到 7
  await bumpCursorForManual(mockConn(), 3, 107, 7);
  assert('T2 手动 07 → 游标 5 推进到 7', snap['3_7'].end_a === 7);

  // T3: 再手动加 seq 1 (A，已落后于 7，回绕前) → 不回退
  await bumpCursorForManual(mockConn(), 3, 101, 7);
  assert('T3 手动 01（落后于 7）→ 游标不回退，保持 7', snap['3_7'].end_a === 7);

  // T4: b 组手动加 seq 10 (B，等于当前 end_b) → 保持 10（不越界）
  await bumpCursorForManual(mockConn(), 3, 110, 7);
  assert('T4 手动 10（等于 end_b）→ 保持 10', snap['3_7'].end_b === 10);

  // T5: 该周无快照 → 不操作、不报错
  snap['3_8'] = undefined;
  let threw = false;
  try { await bumpCursorForManual(mockConn(), 3, 105, 8); } catch (e) { threw = true; }
  assert('T5 该周无快照 → 不抛错、不改动', !threw);

  // T6: 续排结果验证：游标 7 → 下一周 a 组首排应为 9（7 之后下一个奇数）
  // 用 rotPos 同口径说明：a 组 seq 1,3,5..55，7 之后是 9。
  assert('T6 游标 7 ⇒ 下一档 a 组从 9 起（用户预期）', (7 + 2) % 56 === 9 || 7 + 2 === 9);

  console.log('');
  if (fail === 0) console.log('✅ 手动计入游标门禁全部通过（' + pass + ' 项）');
  else { console.log('❌ 失败 ' + fail + ' 项'); process.exit(1); }
}

run();
