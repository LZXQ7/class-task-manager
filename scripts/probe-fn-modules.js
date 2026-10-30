/**
 * 探针：逐个 invoke 线上云函数，看是否「模块加载失败」（node_modules 未随包部署）。
 * 判据：触发一个不存在的 action —— 正常包会返回业务码 41001「未知操作」；
 *       缺依赖的包会在 require 阶段崩，返回 "Cannot find module"。
 * 只读：未知 action 在任何函数的 exports.main 里都在 handler 之前返回，不碰库、无副作用。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TCBJS = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';
const REGION = 'ap-shanghai';

const root = path.join(__dirname, '..', 'cloudfunctions');
const fns = fs.readdirSync(root).filter((d) => {
  try { return fs.statSync(path.join(root, d)).isDirectory(); } catch (e) { return false; }
});

const PARAMS = JSON.stringify({ action: '__probe_none_zzz' });
const out = [];
for (const fn of fns) {
  const r = spawnSync('node', [TCBJS, 'fn', 'invoke', fn, '-e', ENV, '-r', REGION, '--params', PARAMS], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true
  });
  const txt = String((r && r.stdout) || '') + String((r && r.stderr) || '');
  const m = /Cannot find module '([^']+)'/.exec(txt);
  const biz = /"code":\s*41001|未知操作/.test(txt) || /41001/.test(txt);
  let verdict = 'UNKNOWN';
  if (m) verdict = 'MISSING_MODULE:' + m[1];
  else if (biz) verdict = 'OK';
  else if (/40001/.test(txt)) verdict = 'OK(no-wx-ctx)';
  else if (/call succeeded/.test(txt)) verdict = 'OK(other)';
  else verdict = 'ERROR?';
  out.push(verdict.padEnd(28) + fn);
  process.stdout.write(verdict.padEnd(28) + fn + '\n');
}
fs.writeFileSync(path.join(__dirname, '_probe_fn_modules.txt'), out.join('\n'), 'utf8');
