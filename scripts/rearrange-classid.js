'use strict';
// 一次性生产迁移：把 小教 三个班的 class_id 按 段→id 重排
//   原 class_id 1(示例班级A) → 3
//   原 class_id 2(示例班级C) → 1
//   原 class_id 3(示例班级B) → 2
// 专升本 9/10 不动。无外键，用两段临时偏移(1→101,2→102,3→103)避免 3-循环碰撞。
// 纪律：先全量备份 20 张表 → 再统一迁移；幂等护栏（bak 已存在则中止）；行数校验。

const { execSync } = require('child_process');
const fs = require('fs');

const TCBJS = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';
const NODE_CMD = 'node'; // 走 shell 解析，与 Bash 工具里直接 `node tcb` 一致（绝对 managed 路径 spawn 在本沙箱会 status=null）
const GUARD = 'bak_class_rearrange_pre_class';
const REPORT = 'outputs/rearrange-classid-report.txt';

const TABLES = [
  { t: 'class', col: 'id' },
  { t: 'course', col: 'class_id' },
  { t: 'duty', col: 'class_id' },
  { t: 'duty_log', col: 'class_id' },
  { t: 'import_batch', col: 'class_id' },
  { t: 'leave_request', col: 'class_id' },
  { t: 'member', col: 'class_id' },
  { t: 'notice', col: 'class_id' },
  { t: 'notice_msg', col: 'class_id' },
  { t: 'notice_msg_class', col: 'class_id' },
  { t: 'notice_msg_delete', col: 'class_id' },
  { t: 'notice_msg_read', col: 'class_id' },
  { t: 'notice_msg_target', col: 'class_id' },
  { t: 'schedule_publish', col: 'class_id' },
  { t: 'schedule_rules', col: 'class_id' },
  { t: 'session', col: 'class_id' },
  { t: 'session_shift', col: 'class_id' },
  { t: 'staff_class', col: 'class_id' },
  { t: 'swap_request', col: 'class_id' },
  { t: 'timetable_apply', col: 'class_id' },
];

const log = [];
function out(s) { log.push(s); console.log(s); }
function flush() { try { fs.mkdirSync('outputs', { recursive: true }); fs.writeFileSync(REPORT, log.join('\n')); } catch (e) {} }

function syncSleep(ms) { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, ms); }

function run(sql, readOnly) {
  const ro = readOnly ? ' --read-only' : '';
  // 复用 Bash 工具里可工作的调用形态：node "<tcb>" db execute -e <env> -r ap-shanghai [-s sql]
  const cmd = NODE_CMD + ' "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai' + ro + ' -s "' + sql + '"';
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const o = execSync(cmd, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      return o;
    } catch (e) {
      lastErr = 'code=' + (e.status == null ? 'null' : e.status) + ' stderr=' + (e.stderr || '') + ' stdout=' + (e.stdout || '');
      if (attempt < 3) syncSleep(1500);
    }
  }
  throw new Error('tcb FAIL sql=[' + sql + '] ' + lastErr);
}

function affected(stdout) {
  const m = stdout.match(/Affected rows:\s*(\d+)/i);
  if (m) return parseInt(m[1], 10);
  const m2 = stdout.match(/i\s*Affected rows:\s*(\d+)/i);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

function countOf(t) {
  const o = run('SELECT COUNT(*) AS c FROM ' + t, true);
  const m = o.match(/(\d+)/);
  return m ? parseInt(m[0], 10) : -1;
}

try {
  out('=== class_id 重排迁移 ===');
  out('node=' + NODE_CMD);
  out('env=' + ENV);
  out('time=' + new Date().toISOString());

  // 预热（忽略失败）：避免 CLI 冷启动导致首个 spawnSync 调用偶发失败
  try { run('SELECT 1', true); out('warmup OK'); } catch (e) { out('warmup skip: ' + e.message); }

  // 0) 幂等护栏
  const guard = run("SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '" + GUARD + "'", true);
  const guardN = (guard.match(/(\d+)/) || [])[1];
  if (guardN === '1') {
    out('!! 护栏命中：' + GUARD + ' 已存在，说明已迁移过，整脚本中止（幂等）。');
    flush();
    process.exit(0);
  }
  out('护栏OK：尚未迁移。');

  // 1) 迁移前快照
  out('\n--- BEFORE: class 主表 ---');
  out(run('SELECT id, name, join_token FROM class ORDER BY id', true).trim());
  out('\n--- BEFORE: member 按 class_id 计数 ---');
  out(run('SELECT class_id, COUNT(*) AS c FROM member GROUP BY class_id ORDER BY class_id', true).trim());

  // 2) 全量备份（先全部备份，再全部迁移）
  out('\n=== 备份阶段 ===');
  const bakCounts = {};
  for (const { t } of TABLES) {
    const bk = 'bak_class_rearrange_pre_' + t;
    run('CREATE TABLE ' + bk + ' LIKE ' + t);
    run('INSERT INTO ' + bk + ' SELECT * FROM ' + t);
    const n = countOf(bk);
    bakCounts[t] = n;
    out('backup ' + bk + ' <- ' + t + ' : ' + n + ' rows');
  }

  // 3) 迁移阶段（两段偏移，避免碰撞）
  out('\n=== 迁移阶段（phase1: 1->101,2->102,3->103）===');
  for (const { t, col } of TABLES) {
    const sql = 'UPDATE ' + t + ' SET ' + col + ' = CASE ' + col +
      " WHEN 1 THEN 101 WHEN 2 THEN 102 WHEN 3 THEN 103 ELSE " + col + ' END' +
      ' WHERE ' + col + ' IN (1,2,3)';
    const o = run(sql);
    out('phase1 ' + t + ' : affected=' + affected(o) + ' (rows in {1,2,3}=' + bakCounts[t] + ' 期望)');
  }
  out('\n=== 迁移阶段（phase2: 101->3,102->1,103->2）===');
  for (const { t, col } of TABLES) {
    const sql = 'UPDATE ' + t + ' SET ' + col + ' = CASE ' + col +
      " WHEN 101 THEN 3 WHEN 102 THEN 1 WHEN 103 THEN 2 ELSE " + col + ' END' +
      ' WHERE ' + col + ' IN (101,102,103)';
    const o = run(sql);
    out('phase2 ' + t + ' : affected=' + affected(o));
  }

  // 4) 校验：行数不变 + 分布正确
  out('\n=== 校验阶段 ===');
  let ok = true;
  for (const { t } of TABLES) {
    const live = countOf(t);
    if (live !== bakCounts[t]) {
      out('!! 行数不一致 ' + t + ' live=' + live + ' bak=' + bakCounts[t]);
      ok = false;
    }
  }
  out('行数校验: ' + (ok ? '全部一致 OK' : '存在不一致 !!'));

  out('\n--- AFTER: class 主表（期望 id1=示例班级C, id2=示例班级B, id3=示例班级A）---');
  out(run('SELECT id, name, join_token FROM class ORDER BY id', true).trim());
  out('\n--- AFTER: member 按 class_id 计数（期望 1=57,2=56,3=60,9=10,10=20）---');
  out(run('SELECT class_id, COUNT(*) AS c FROM member GROUP BY class_id ORDER BY class_id', true).trim());
  out('\n--- AFTER: 示例成员01(id=13) 应在 class_id=3 且 duty_off=1 ---');
  out(run('SELECT id, name, class_id, student_no, duty_off FROM member WHERE id = 13', true).trim());

  out('\n=== 完成。备份表前缀 bak_class_rearrange_pre_ 保留用于回滚 ===');
  flush();
  process.exit(ok ? 0 : 2);
} catch (e) {
  out('\n!!! 异常中止: ' + e.message);
  flush();
  process.exit(1);
}
