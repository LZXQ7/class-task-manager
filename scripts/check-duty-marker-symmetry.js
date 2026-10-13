#!/usr/bin/env node
/**
 * 离线自检：删值日行必须回滚轮转游标（v0.7.26）
 * ------------------------------------------------------------
 * 背景（2026-09-27 用户报「按序号轮转排班，到第六周为什么没有 1 号了」）：
 *
 * `member.duty_count` 是**轮转位置的唯一来源**（见 schedule-core.js 顶部说明）。
 * 它是一个「本轮已排次数」标记，被 `rotationPick` 按 `(duty_count ASC, 序号 ASC)`
 * 取人。所以任何「删掉 duty 行但不把 duty_count 减回去」的路径都会让它**单向漂移**
 * （只增不减）：被删的人「明明没值日却被记成已排过」→ 在队列里被往后推。
 *
 * 线上实锤：1 号 示例成员01 `duty_count` = 3，而 02~54 号是 2。
 * 第 6 周需要 48 人，队列 = [55, 56, 02, 03, …, 54, 01] —— 1 号被这一个差额
 * 排到了 **56 人队列的队尾**，取到第 48 位（47 号）名额就满了 → 1 号整周消失。
 * 旁证：1 号全班唯一有 3 条 CANCEL（CANCEL 只由 schedule.remove 写出），
 * 且 `last_duty_at` 停在 2026-09-28（第 3 周周一）却没有任何第 3 周存活行 ——
 * 那正是「手动加进第 3 周某课次 → 又取消」留下的化石。
 *
 * 两条泄漏路径（本门禁守的就是它们）：
 *   ① `schedule.remove` 旧版写成 `if (rows[0].source === 'AUTO')` 才回滚 ——
 *      与写入侧不对称：`addManual` **无条件** +1（注释原话「手动加人也算本轮已排」），
 *      `reassign` 又把该行 source 改成 'MANUAL' 并给换上的人 +1。
 *      于是「手动加人 → 取消」每次让该成员游标永久 +1。
 *   ② `course.syncDutyForShift` 的两处删除（OFF 整节取消 / MOVE 撞上同日重复）原先裸删。
 *
 * 本门禁守住 5 件事：
 *   ① 全仓**每一个** `DELETE FROM duty` 站点，其**所在函数体**内必须能看到轮转标记
 *      回滚证据（或在 EXEMPT 里显式登记豁免理由）；
 *   ② `schedule.remove` 不得再用 `source === 'AUTO'` 当回滚条件，必须按
 *      `status !== 'SWAPPED_OUT'` 无条件回滚；
 *   ③ `schedule.addManual` 仍**无条件** +1（写入侧一动，对称性又破）；
 *   ④ `course.rollbackDutyMarkers` 存在，且八处删除分支各 `await` 一次：OFF / MOVE-dup / importTimetable 提交覆盖 / publishToClass / moveSessionSlots 批量挪位撞同日重复 / appendSessionSlots 搬迁撞 `uq_duty` / sessionAppendRemove 搬回撞 `uq_duty` / sessionAppendRemove 找不到原课次只能删（2026-10-05 青果重导入新增第三处；2026-10-07 批量课程调课 + 新建课次/撤销新增其余四处）；
 *   ⑤ 该 helper 自己要把 `SWAPPED_OUT` 的历史行排除在外（它在换出时已回滚过）。
 *
 * 自证（双向）：任一环拆掉 → 必被抓；源码原样 → 不得误报。
 * 用法：node scripts/check-duty-marker-symmetry.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 把注释替换成**等长空白**（保留换行与行号）。
 * 用等长而非 `''`：① 行号不漂，报错能直接指到源文件那一行；
 * ② 注释里写的反例（本文件上方就贴了 `source === 'AUTO'`）不会顶掉真判据。
 */
const blank = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function chk(cond, msg) { if (cond) ok(msg); else bad(msg); }

/** 取「{ … }」配对区间；-1 不能省（见 check-unbind-route.js 的踩坑注释） */
function braceSpan(src, from) {
  const s = src.indexOf('{', from);
  if (s < 0) return null;
  let depth = 0;
  for (let i = s; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (!depth) return { start: s, end: i, body: src.slice(s + 1, i) };
    }
  }
  return null;
}
function bodyOf(src, nameRe) {
  const m = nameRe.exec(src);
  if (!m) return null;
  const sp = braceSpan(src, m.index + m[0].length - 1);
  return sp ? sp.body : null;
}
/** 收集「函数体区间」：顶层 `async function name() {` 与路由 `  key: {` 两种写法 */
function blocksOf(src) {
  const out = [];
  const push = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const sp = braceSpan(src, m.index + m[0].length - 1);
      if (sp) out.push(sp);
    }
  };
  push(/^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/gm);
  push(/^  [A-Za-z_$][\w$]*\s*:\s*\{/gm);
  return out;
}
/** idx 落在的最内层函数体 */
function enclosingBody(blocks, idx) {
  let best = null;
  for (const b of blocks) {
    if (b.start <= idx && idx <= b.end && (!best || (b.end - b.start) < (best.end - best.start))) best = b;
  }
  return best ? best.body : null;
}
function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

/** 扫这四个函数 —— 删值日的站点全在这里（第 8 处已在 EXEMPT 登记） */
const SCAN_FILES = [
  'cloudfunctions/schedule/index.js',
  'cloudfunctions/course/index.js',
  'cloudfunctions/cron-weekly/index.js',
  'cloudfunctions/member/index.js',
  // 课表导入写库（2026-10-10 抽出）：importTimetable 覆盖重导的删行回滚在这里
  'cloudfunctions/common/timetable-import.js'
];

/**
 * 「这一行占过轮转标记，删掉就会把它的位置丢掉」的可接受证据。
 * ⚠️ 必须点名到具体写法，不能松到 `ownAuto` 这种变量名 —— 否则把
 *    `- (ownAuto.get(id) || 0)` 改成 `+ 0`（变量名还在）就查不出来了（变异 4 实测）。
 */
const COMPENSATION = [
  /rollbackDutyMarkers\s*\(/,                    // course：删行前按成员扣
  /duty_count\s*-\s*\?/,                         // writePlan / clear：按本周占用数扣
  /duty_count\s*=\s*duty_count\s*-\s*1/,         // remove：删一行扣一次
  /-\s*\(\s*ownAuto\.get\(/                      // generate / cron-weekly：先扣本周自己的 AUTO
];

/** 显式豁免：删的行不属于任何**活着**的人的轮转位置 */
const EXEMPT = [
  {
    file: 'cloudfunctions/member/index.js',
    sql: /DELETE FROM duty WHERE member_id = \? AND class_id = \? AND status = 'PENDING' AND class_date >= \?/,
    why: 'removeMember：只删即将被移出班级的成员**本人**的未来值日，紧接着 member 行本身也被删 —— 游标已无意义'
  }
];

const F_SCHEDULE = 'cloudfunctions/schedule/index.js';
const F_COURSE = 'cloudfunctions/course/index.js';
const F_MEMBER = 'cloudfunctions/member/index.js';
/**
 * 课表导入写库逻辑（2026-10-10 抽出，course 云函数与网页后台共用）。
 * ⚠️ importTimetable「提交覆盖重导」那一处删行回滚**已经搬到这里**，
 *    course/index.js 里只剩 7 处 await。加进来一起数，总数仍须为 8。
 *    漏了这个文件会误报「只有 7 处」，而真删掉 common 那处又会静默通过 ——
 *    正是 MEMORY 记的「变异锚点漂移 = 静默假通过」。
 */
const F_TT_IMPORT = 'cloudfunctions/common/timetable-import.js';

/** 纯函数审计（变异自证复用）：吃一份「源码快照」，吐问题列表 */
function audit(raw) {
  const p = [];
  const s = {};
  SCAN_FILES.forEach(f => { s[f] = blank(raw[f] || ''); });

  // ① 每个删值日站点的所在函数体里必须有回滚证据（或命中显式豁免）
  const siteRe = /DELETE\s+FROM\s+duty\b(?!_log)/g;
  SCAN_FILES.forEach((f) => {
    const src = s[f];
    const blocks = blocksOf(src);
    siteRe.lastIndex = 0;
    let m;
    while ((m = siteRe.exec(src))) {
      const head = src.slice(m.index, m.index + 220);
      if (EXEMPT.some(e => e.file === f && e.sql.test(head))) continue;
      const body = enclosingBody(blocks, m.index);
      if (!body) {
        p.push(f + ' 第 ' + lineOf(src, m.index) + ' 行：删值日站点不在任何函数体内（无法审计）');
      } else if (!COMPENSATION.some(r => r.test(body))) {
        p.push(f + ' 第 ' + lineOf(src, m.index) + ' 行：删值日却看不到轮转标记回滚'
          + '（duty_count 只增不减 → 该成员在轮转队列里被往后推，最终整周排不上）');
      }
    }
  });

  // ② schedule.remove 必须无条件回滚（不得再拿 source === 'AUTO' 当门）
  {
    const rm = bodyOf(s[F_SCHEDULE], /remove\s*:\s*\{/);
    if (!rm) {
      p.push('schedule：找不到 remove 路由');
    } else {
      if (/source\s*===\s*'AUTO'/.test(rm)) {
        p.push('schedule.remove：又拿 source === \'AUTO\' 当回滚条件了 —— '
          + '手动加人（addManual）与换人（reassign）产生的行同样是 +1 过的，取消时不回滚 → 游标永久 +1');
      }
      if (!/status\s*!==\s*'SWAPPED_OUT'/.test(rm)) {
        p.push('schedule.remove：回滚条件不是 status !== \'SWAPPED_OUT\'（SWAPPED_OUT 历史行不该重复扣）');
      }
      if (!/duty_count\s*=\s*duty_count\s*-\s*1/.test(rm)) {
        p.push('schedule.remove：没有把该成员的 duty_count 减回去');
      }
    }
  }

  // ③ 写入侧保持「手动加人也算本轮已排」—— 一动就不对称了
  {
    const add = bodyOf(s[F_SCHEDULE], /addManual\s*:\s*\{/);
    if (!add || !/duty_count\s*=\s*duty_count\s*\+\s*1/.test(add)) {
      p.push('schedule.addManual：不再无条件 duty_count + 1；'
        + '若写入侧不算「本轮已排」，则 remove 的无条件回滚会反向漂移（两处必须成对）');
    }
  }

  // ④ course 的删行 helper：存在 + 四处删除分支各 await 一次
  //    （2026-10-05 青果重导入第三处；2026-10-06 班委「发布到全班」覆盖重导第四处）
  {
    const course = s[F_COURSE];
    if (!/async\s+function\s+rollbackDutyMarkers\s*\(/.test(course)) {
      p.push('course：缺 rollbackDutyMarkers() —— 临时调课删值日会再开一条游标泄漏通道');
    } else {
      // 只数 `await` 调用（定义体里的 `rollbackDutyMarkers(conn, ids)` 不算）
      // 计数跨两个文件：course 内 7 处 + common/timetable-import 内 1 处 = 8
      const CALL_RE = /await\s+rollbackDutyMarkers\s*\(\s*conn\s*,/g;
      const callsInCourse = (course.match(CALL_RE) || []).length;
      const callsInImport = ((s[F_TT_IMPORT] || '').match(CALL_RE) || []).length;
      const calls = callsInCourse + callsInImport;
      if (calls !== 8) {
        p.push('course：rollbackDutyMarkers 的 await 调用是 ' + calls + ' 处'
          + '（course/index.js ' + callsInCourse + ' + common/timetable-import.js ' + callsInImport
          + '；应为 8：'
          + 'OFF 整节取消 / MOVE 撞上同日重复 / importTimetable 提交覆盖重导（在 common 里）/ '
          + 'publishToClass 班委发布覆盖重导 / moveSessionSlots 批量挪位撞同日重复 / '
          + 'appendSessionSlots 搬迁撞唯一键 / sessionAppendRemove 搬回撞唯一键 / '
          + 'sessionAppendRemove 找不到原课次只能删，八处删除分支都要先回滚）');
      }
      // ⑦ 抽出 common 后必须仍有一处（否则上面那句 '应为 8' 会因 course 侧多写一处而蒙混过关）
      if (callsInImport !== 1) {
        p.push('common/timetable-import.js：writeTimetable 的删行前回滚应恰好 1 处（实为 '
          + callsInImport + ' 处）—— importTimetable 覆盖重导删课次不回滚值日标记 = 轮转游标单向漂移');
      }
      // ⑤ helper 自身要把 SWAPPED_OUT 排除在外
      const helper = bodyOf(course, /async\s+function\s+rollbackDutyMarkers\s*\([^)]*\)\s*\{/);
      if (!helper || !/status\s*<>\s*'SWAPPED_OUT'/.test(helper)) {
        p.push('course.rollbackDutyMarkers：没有排除 status = \'SWAPPED_OUT\' 的历史行（会把已回滚过的又扣一遍）');
      }
    }
  }
  return p;
}

console.log('── 值日轮转游标「删行必回滚」体检');
const SRC = {
  [F_SCHEDULE]: read(F_SCHEDULE),
  [F_COURSE]: read(F_COURSE),
  'cloudfunctions/cron-weekly/index.js': read('cloudfunctions/cron-weekly/index.js'),
  [F_MEMBER]: read(F_MEMBER),
  [F_TT_IMPORT]: read(F_TT_IMPORT)
};

const problems = audit(SRC);
if (problems.length) problems.forEach(x => bad(x));
else {
  ok('① 全仓 7 个「删值日」站点的所在函数体内都有轮转标记回滚（第 8 处 = removeMember，已登记豁免）');
  ok('② schedule.remove 按 status !== \'SWAPPED_OUT\' 无条件回滚（不再只认 AUTO）');
  ok('③ schedule.addManual 仍无条件 +1（写入侧与回滚侧对称）');
  ok('④ course 的八处删除分支都 await rollbackDutyMarkers');
  ok('⑤ rollbackDutyMarkers 自己排除了 SWAPPED_OUT 历史行');
}

console.log('\n── 自证：拆掉任一环必被抓（变异必抓 + 好样本不误报）');
{
  chk(audit(SRC).length === 0, '好样本：现有源码无问题（不误报）');

  const S = F_SCHEDULE;
  const C = F_COURSE;
  const CW = 'cloudfunctions/cron-weekly/index.js';
  /**
   * ⚠️ 变异必须**全量**替换：schedule/index.js 里
   *   `- (ownAuto.get(Number(m.id)) || 0)`（buildCleaningPlan 与 generate 各一处）与
   *   `UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?`
   *   （reassign 与 addManual 各一处）都是**逐字相同**的两处 ——
   *   用 String.replace 只会命中前一处，变异没落在被审计的站点上 → 假通过（本门禁实测踩到过）。
   */
  const all = (s, a, b) => s.split(a).join(b);

  // 变异 1：remove 退回「只对 AUTO 回滚」（本次事故的原样）
  const m1 = Object.assign({}, SRC, {
    [S]: SRC[S].replace("if (rows[0].status !== 'SWAPPED_OUT') {", "if (rows[0].source === 'AUTO') {")
  });
  chk(m1[S] !== SRC[S] && audit(m1).length > 0, '变异 1：remove 退回「只对 AUTO 回滚」→ 被抓住');

  // 变异 2：course 的 OFF 分支去掉回滚
  const m2 = Object.assign({}, SRC, {
    [C]: SRC[C].replace('    await rollbackDutyMarkers(conn, ids);\n', '')
  });
  chk(m2[C] !== SRC[C] && audit(m2).length > 0, '变异 2：course OFF 分支去掉回滚 → 被抓住');

  // 变异 3：course 的 MOVE-dup 分支去掉回滚
  const m3 = Object.assign({}, SRC, {
    [C]: SRC[C].replace('    await rollbackDutyMarkers(conn, dupIds);\n', '')
  });
  chk(m3[C] !== SRC[C] && audit(m3).length > 0, '变异 3：course MOVE-dup 分支去掉回滚 → 被抓住');

  // 变异 4：generate 不再扣「本周自己的 AUTO」——变量名还在，等于抹掉补偿
  const m4 = Object.assign({}, SRC, {
    [S]: all(SRC[S], '- (ownAuto.get(Number(m.id)) || 0)', '+ 0')
  });
  chk(m4[S] !== SRC[S] && audit(m4).length > 0, '变异 4：generate 不再扣本周 AUTO（标记重复累加）→ 被抓住');

  // 变异 5：cron-weekly 同款
  const m5 = Object.assign({}, SRC, {
    [CW]: all(SRC[CW], '- (ownAuto.get(Number(m.id)) || 0)', '+ 0')
  });
  chk(m5[CW] !== SRC[CW] && audit(m5).length > 0, '变异 5：cron-weekly 不再扣本周 AUTO → 被抓住');

  // 变异 6：removeMember 的删除被放大成「删别人的行」→ 豁免失效，必须报出来
  const m6 = Object.assign({}, SRC, {
    [F_MEMBER]: SRC[F_MEMBER].replace(
      "DELETE FROM duty WHERE member_id = ? AND class_id = ? AND status = 'PENDING' AND class_date >= ?",
      "DELETE FROM duty WHERE class_id = ? AND status = 'PENDING' AND class_date >= ?")
  });
  chk(m6[F_MEMBER] !== SRC[F_MEMBER] && audit(m6).length > 0, '变异 6：removeMember 的删除范围被放大 → 豁免失效、被抓住');

  // 变异 7：addManual 不再 +1（写入侧一动，对称性反向破）
  const m7 = Object.assign({}, SRC, {
    [S]: all(SRC[S], 'UPDATE member SET duty_count = duty_count + 1, last_duty_at = ? WHERE id = ?',
      'UPDATE member SET last_duty_at = ? WHERE id = ?')
  });
  chk(m7[S] !== SRC[S] && audit(m7).length > 0, '变异 7：addManual 不再 +1 → 被抓住');

  // 变异 8：把回滚证据挪到**别的函数**里（同文件、但不在删行所在函数体）→ 仍要抓住
  const m8 = Object.assign({}, SRC, {
    [C]: SRC[C].replace('    await rollbackDutyMarkers(conn, dupIds);\n', '')
  });
  chk(m8[C] !== SRC[C] && audit(m8).length > 0, '变异 8：MOVE-dup 分支的回滚被移走（同文件别处还在）→ 仍被抓住');

  // 变异 9：班委「发布到全班」覆盖重导时不再回滚值日标记 → 必须判死（发布是第 4 处删行站点）
  const m9 = Object.assign({}, SRC, {
    [C]: all(SRC[C],
      "          if (duties.length) await rollbackDutyMarkers(conn, duties.map(r => Number(r.id)));\n          await conn.query(\n            `DELETE d FROM duty d JOIN session s ON s.id = d.session_id\n              WHERE s.id IN (${ph}) AND s.class_id = ? AND d.status IN ('PENDING','ONGOING') AND d.class_date >= ?`,\n            ids.concat([classId, week.todayStr()])\n          );\n          try { await conn.query(`DELETE FROM session_shift WHERE class_id = ? AND session_id IN (${ph})`, [classId].concat(ids)); } catch (e) { /* 表未建 */ }\n          await conn.query(`DELETE FROM session WHERE id IN (${ph})`, ids);\n        }\n        // ③ 孤立课程清理",
      "          await conn.query(\n            `DELETE d FROM duty d JOIN session s ON s.id = d.session_id\n              WHERE s.id IN (${ph}) AND s.class_id = ? AND d.status IN ('PENDING','ONGOING') AND d.class_date >= ?`,\n            ids.concat([classId, week.todayStr()])\n          );\n          try { await conn.query(`DELETE FROM session_shift WHERE class_id = ? AND session_id IN (${ph})`, [classId].concat(ids)); } catch (e) { /* 表未建 */ }\n          await conn.query(`DELETE FROM session WHERE id IN (${ph})`, ids);\n        }\n        // ③ 孤立课程清理")
  });
  chk(m9[C] !== SRC[C] && audit(m9).length > 0, '变异 9：publishToClass 覆盖重导不回滚值日标记 → 被抓住');

  // 变异 10：撤销「新建课次后课表」时删值日不回滚游标 → 必须判死（sessionAppendRemove 是第 5 处删行站点）
  const m10 = Object.assign({}, SRC, {
    [C]: all(SRC[C],
      '                await rollbackDutyMarkers(conn, dIds);',
      '                /* 故意不回滚 */')
  });
  chk(m10[C] !== SRC[C] && audit(m10).length > 0, '变异 10：sessionAppendRemove 删值日不回滚游标 → 被抓住');

  // 变异 11（2026-10-10）：importTimetable 的回滚已搬进 common/timetable-import.js，
  //   那里若被改回「直接删课次不回滚」，importTimetable 覆盖重导就会开出游标漂移通道。
  //   ⚠️ 必须单独给 common 配一个变异 —— 只在 course 上做变异的话，
  //   common 那一处被删光时门禁仍可能因 course 侧数字对得上而**静默通过**。
  const TT = F_TT_IMPORT;
  const m11 = Object.assign({}, SRC, {
    [TT]: all(SRC[TT],
      'if (duties.length) await rollbackDutyMarkers(conn, duties.map((r) => Number(r.id)));',
      'if (duties.length) { /* 故意不回滚 */ }')
  });
  chk(m11[TT] !== SRC[TT] && audit(m11).length > 0,
    '变异 11：common/timetable-import 的删课次前回滚被去掉 → 被抓住');

  // 变异 12：把 common 那处回滚搬去 course 的**无关函数**里（凑够 8 处）→ 语义仍错，必须判死。
  //   这是「数字对上了但证据搬错了地方」的典型假通过。
  const m12 = Object.assign({}, SRC, {
    [TT]: all(SRC[TT],
      'if (duties.length) await rollbackDutyMarkers(conn, duties.map((r) => Number(r.id)));',
      'if (duties.length) { /* 搬走了 */ }'),
    [C]: SRC[C] + '\nasync function __dummyHolder() {\n  const c = { query: null };\n  if (c) await rollbackDutyMarkers(c, [1]);\n}\n'
  });
  chk(audit(m12).length > 0,
    '变异 12：回滚被挪到无关函数凑数（总数仍为 8）→ 仍被抓住');
}

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 轮转游标对称性体检全部通过'));
process.exit(failed ? 1 : 0);
