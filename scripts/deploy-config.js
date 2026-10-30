#!/usr/bin/env node
/**
 * cloudbaserc.json 内 config 的部署脚本（含 DB 环境变量注入）
 *
 * 与 scripts/deploy-fee.js 同一套「临时注入 → 部署 → 还原」模式，
 * 区别只有目标函数是 config（前端远程配置下发，2026-10-26 新增）。
 *
 * ⚠️ 为什么必须走这套而不是裸 `tcb fn deploy config`：
 *   config 是**全新函数**，cloudbaserc.json 的 config 条目里没有 envVariables，
 *   裸部署出来的函数不含 DB_HOST / DB_USER / ... ⇒ 运行时 pool.query 拿到
 *   host=undefined 直接抛错。本脚本从 .env-course 注入后才能连库。
 *
 * 前置：
 *   · .env-course（已 gitignore）含 DB_HOST / DB_PORT / DB_USER / DB_PWD / DB_NAME；
 *   · cloudbaserc.json functions[] 里已登记 config（含 vpc，与 fee/stat/auth 同款）。
 *
 * 部署后必须人工复核（本脚本不替你做）：
 *   node "<tcb>" fn detail config -e <envId>
 *   → Network configuration 应显示 vpc-c4ga6fms / subnet-a5mkrg1l；
 *   → Environment variables 应非空。
 *
 * 用法：
 *   node scripts/deploy-config.js            # 注入 + 部署 + 还原
 *   node scripts/deploy-config.js --dry-run  # 只打印将要注入的键名，不部署
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_PATH = path.join(ROOT, 'cloudbaserc.json');
const ENV_COURSE = path.join(ROOT, '.env-course');
// Git Bash 下 `which tcb` 指向的是 npm 的 sh 包装脚本（不是 js），node 跑不了，
// 所以默认直接指向 CLI 实体入口；可用环境变量 TCBJS 覆盖。
const TCB = process.env.TCBJS ||
  'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const DRY = process.argv.includes('--dry-run');
const FN_NAME = 'config';

/** config 需要哪些变量（common/db.js 全部从 process.env 读） */
const WANT = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PWD', 'DB_NAME'];

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

/** 极简 .env 解析：KEY=VALUE，忽略空行与 # 注释，值不去引号（口令里可能有符号） */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const env = parseEnvFile(ENV_COURSE);
const missing = WANT.filter((k) => !env[k]);
if (missing.length) {
  fail(
    '缺少环境变量：' + missing.join(', ') +
    '\n  来源文件 ' + ENV_COURSE +
    '\n  先执行：node "<tcb>" fn env pull course -e <envId> --output-file .env-course'
  );
}

const inject = {};
for (const k of WANT) inject[k] = env[k];

console.log('待注入环境变量（只打印键名与长度，不打印值）：');
for (const k of WANT) console.log('  ' + k + '  len=' + String(env[k]).length);

if (DRY) {
  console.log('\n--dry-run：未改动任何文件。');
  process.exit(0);
}

main().then((code) => process.exit(code));

async function main() {
// 抗中断备份：进程被 SIGTERM/SIGKILL 杀掉时 finally 不会执行，
// 口令会留在 cloudbaserc.json 里。所以注入**之前**先把原样另存一份，
// 下次启动第一件事就是把这份备份恢复回去（幂等）。
// ⚠️ 顺序铁律：恢复必须发生在 `original = readFileSync` **之前**。
//    反过来的话 original 抓到的是「上一轮残留的含口令版本」，
//    末尾还原时又把它写回去 ⇒ 越还原越脏（2026-10-10 实踩）。
// 🔴 2026-10-12 实踩（数据丢失事故）：无条件恢复 + unlinkSync 被安全删除垫片
//    ETIMEDOUT 打崩 ⇒ 残留的**旧备份**在下次启动时把之后的所有编辑冲掉。
//    两条修定（从 deploy-admin-web.js 原样继承）：
//    ① **只有当前文件里还有注入的 envVariables 才恢复**（那才是"上次被中断"的
//       现场）；当前文件干净时绝不覆盖——避免旧备份冲掉后续编辑；
//    ② 清理一律 try/catch（垫片间歇性打崩 unlinkSync，清理失败不判死）。
const SAFE_BACKUP = path.join(ROOT, '.wb_tmp', 'cloudbaserc.safe-config.json');
fs.mkdirSync(path.dirname(SAFE_BACKUP), { recursive: true });
function cleanupSafeBackup() {
  try { fs.unlinkSync(SAFE_BACKUP); } catch (e) { /* 垫片间歇失败：留着无害，见 ① */ }
}
if (fs.existsSync(SAFE_BACKUP)) {
  const cur = fs.readFileSync(RC_PATH, 'utf8');
  if (/envVariables/.test(cur)) {
    fs.copyFileSync(SAFE_BACKUP, RC_PATH);
    console.log('检测到上次部署被中断（cloudbaserc.json 里还有注入的 envVariables），已从安全备份还原。');
  } else {
    console.log('安全备份存在，但当前 cloudbaserc.json 是干净的（无 envVariables）⇒ 不覆盖，避免旧备份冲掉后续编辑。');
  }
  cleanupSafeBackup();
}

const original = fs.readFileSync(RC_PATH, 'utf8');
fs.writeFileSync(SAFE_BACKUP, original, 'utf8');

let rc;
try {
  rc = JSON.parse(original);
} catch (e) {
  fail('cloudbaserc.json 不是合法 JSON：' + e.message);
}

const ENV_ID = rc.envId;
if (!ENV_ID) fail('cloudbaserc.json 里没有 envId');

const fn = (rc.functions || []).find((f) => f.name === FN_NAME);
if (!fn) fail('cloudbaserc.json 里找不到 functions[name=' + FN_NAME + ']');

fn.envVariables = Object.assign({}, fn.envVariables, inject);

fs.writeFileSync(RC_PATH, JSON.stringify(rc, null, 2) + '\n', 'utf8');
console.log('\n已临时注入 envVariables，开始部署 ' + FN_NAME + ' …');

/**
 * 跑 tcb fn deploy 直到结束，stdin 持续喂 y。
 * 为什么不用 spawnSync：Windows 上 `spawnSync node.exe` 带 stdio pipe 会抛
 * EBUSY（deploy-admin-web.js 2026-10-10 实测）。改异步 spawn + 喂 y。
 */
function runDeploy() {
  return new Promise((resolve) => {
    const args = [TCB, 'fn', 'deploy', FN_NAME, '-e', ENV_ID,
      '--dir', './cloudfunctions/' + FN_NAME, '--install-dependency', 'true'];
    console.log('→ node ' + args.slice(1).join(' '));
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false
    });
    let failed = false;
    child.on('error', (e) => {
      failed = true;
      console.error('spawn 失败：' + e.message);
    });
    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
    child.stdin.end('y\ny\ny\ny\ny\ny\ny\ny\n');
    child.on('close', (status, signal) => {
      if (signal) console.error('子进程被信号 ' + signal + ' 终止');
      resolve(failed || signal ? 2 : (typeof status === 'number' ? status : 1));
    });
  });
}

let code = 1;
try {
  code = await runDeploy();
} finally {
  fs.writeFileSync(RC_PATH, original, 'utf8');
  try { fs.unlinkSync(SAFE_BACKUP); } catch (e) { /* 已删 */ }
  console.log('\n已还原 cloudbaserc.json（口令未留在磁盘）。');
}
return code;
}
