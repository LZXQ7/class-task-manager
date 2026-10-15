#!/usr/bin/env node
/**
 * 门禁批跑器（跨平台可靠版）
 * ============================================================================
 * 为什么要它：`run_all_gates_bounded.sh` 的 shell `for` 循环在本机会**挂死** ——
 *   现象是 bash 进程还在、却**再也不启动 node**，stdout 停在 0 字节、无任何门禁输出
 *   （2026-10-15 实踩：跑了 16 分钟一个门禁都没跑完，而同样的门禁单跑 3 分钟全过）。
 *   根因是 Windows 上 shell 连续 spawn 80+ 次 node 的稳定性问题，**不是门禁本身慢**。
 *   这里改用 Node 的 `spawnSync` 逐个跑：进程由同一父进程派生、每跑完一个立刻 flush 一行，
 *   既能实时看到卡在哪一个，也不会出现「shell 挂着不干活」。
 *
 * 用法：
 *   node scripts/run-gates-chunk.js            # 跑全部（默认）
 *   node scripts/run-gates-chunk.js 0 30       # 只跑第 1~30 个（按文件名排序）
 *
 * 输出约定（与旧 shell 脚本保持一致，`scripts/check_closeout.sh` 的 D4 靠它判定）：
 *   进度行  `[n/总数] ok|FAIL scripts/check-xxx.js`
 *   收尾    `门禁 通过=N 失败=M` / `问题项: …` / 全绿时打印 `全绿`
 *   退出码  = 失败数（0 = 全绿）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PER = Number(process.env.PER || 90) * 1000;   // 单个门禁超时（秒 → 毫秒）

const files = fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^check-.*\.js$/.test(f))
  .sort()
  .map((f) => 'scripts/' + f);

const start = Number(process.argv[2] || 0);
const count = Number(process.argv[3] || 0) || files.length;
const slice = files.slice(start, start + count);

const run = (f) => spawnSync(process.execPath, [f], { cwd: ROOT, encoding: 'utf8', timeout: PER });

let pass = 0;
const bad = [];
slice.forEach((f, i) => {
  let r = run(f);
  /* 只重试一次：连续 spawn 偶发抖动确实存在，但重试三次会把「真红」的反馈拖到分钟级 */
  if (r.status !== 0 && r.status !== null) r = run(f);
  const okRun = r.status === 0;
  if (okRun) pass += 1;
  else bad.push(f + (r.status === null ? '(卡死>' + (PER / 1000) + 's)' : '(红 rc=' + r.status + ')'));
  process.stdout.write('[' + (start + i + 1) + '/' + files.length + '] ' + (okRun ? 'ok   ' : 'FAIL ') + f + '\n');
});

process.stdout.write('==============================\n');
process.stdout.write('门禁 通过=' + pass + ' 失败=' + bad.length + '\n');
if (bad.length) process.stdout.write('问题项:' + bad.map((b) => ' ' + b).join('') + '\n');
else process.stdout.write('全绿\n');
process.exit(bad.length);
