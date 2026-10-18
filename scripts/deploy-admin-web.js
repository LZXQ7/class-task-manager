#!/usr/bin/env node
/**
 * cloudbaserc.json 内 admin-web 的部署脚本（含 DB 环境变量注入）
 *
 * 为什么需要这个脚本
 * ------------------------------------------------------------------
 * `cloudfunctions/common/db.js` 的全部连接配置都来自**环境变量**
 * （DB_HOST / DB_PORT / DB_USER / DB_PWD / DB_NAME）。新建的 admin-web
 * 函数默认一个环境变量都没有（`tcb fn env pull admin-web` 拉到空文件），
 * 于是 createPool 拿到 host=undefined → 连不上 → 登录接口 500「服务暂
 * 时不可用」。而 CloudBase CLI 3.8.4 **没有 `fn env set` 子命令**，
 * 只有 `fn env pull`；能写环境变量的路径是 `tcb fn deploy` 应用
 * cloudbaserc.json 里的 `functions[].envVariables`。
 *
 * 但明文口令写进 cloudbaserc.json = 明文进版本库，绝对不能那么干。
 * 所以本脚本走「临时注入 → 部署 → 还原」：
 *   1. 从 .env-course（本地拉取、已 gitignore）读出 5 个 DB_* 的真值；
 *   2. 备份 cloudbaserc.json → 注入 envVariables；
 *   3. `tcb deploy --only functions`；
 *   4. 无论成败都把 cloudbaserc.json 还原成不含口令的原样。
 * 还原用 finally 兜，Ctrl+C / 部署报错都不会把口令留在磁盘上。
 *
 * 用法：
 *   node scripts/deploy-admin-web.js            # 注入 + 部署 + 还原
 *   node scripts/deploy-admin-web.js --dry-run  # 只打印将要注入的键名，不部署
 *
 * 依赖前置（只在拉不到 .env-course 时才需要）：
 *   node "<tcb>" fn env pull course -e <envId> --output-file .env-course
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

/** admin-web 需要哪些变量（WX_APPID 是微信上下文用的，后台网页不需要） */
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
//    ETIMEDOUT 打崩 ⇒ 残留的**旧备份**在下次启动时把之后的所有编辑（新增的 grab
//    函数条目）冲掉，且脚本崩在恢复路径、部署根本没跑。两条修定：
//    ① **只有当前文件里还有注入的 envVariables 才恢复**（那才是"上次被中断"的
//       现场）；当前文件干净时绝不覆盖——避免旧备份冲掉后续编辑；
//    ② 清理一律 try/catch（垫片间歇性打崩 unlinkSync，清理失败不判死）。
const SAFE_BACKUP = path.join(ROOT, '.wb_tmp', 'cloudbaserc.safe.json');
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

const fn = (rc.functions || []).find((f) => f.name === 'admin-web');
if (!fn) fail('cloudbaserc.json 里找不到 functions[name=admin-web]');

fn.envVariables = Object.assign({}, fn.envVariables, inject);

fs.writeFileSync(RC_PATH, JSON.stringify(rc, null, 2) + '\n', 'utf8');
console.log('\n已临时注入 envVariables，开始部署…');

/**
 * 跑 tcb deploy 直到结束，stdin 持续喂 y。
 *
 * 为什么不用 spawnSync：Windows 上 `spawnSync node.exe` 带 stdio pipe 会抛
 * `EBUSY`（2026-10-10 实测，spawnSync 静默失败只返回 error 对象，
 * 若只取 status 会被误判成「tcb 部署失败」）。改异步 spawn。
 *
 * 为什么必须喂 y：tcb deploy 覆盖已存在的函数会问
 * 「Function admin-web already exists. Overwrite and update? (Y/n)」。
 * 后台执行时父进程 stdin 关闭 ⇒ 永远等下去（实测卡 5 分钟无任何输出）。
 */
function runDeploy() {
  return new Promise((resolve) => {
    // 必须用 `tcb deploy --only functions`（读 cloudbaserc 完整配置，含 admin-web 的
    // HTTP 类型 / gatewayPath），不能用单函数 `tcb fn deploy admin-web`（不带 HTTP 配置，
    // 会报 ProtocolType 取值不符）。--yes 跳过全部 Overwrite 确认。会连 fee/stat 一起
    // 重发，但 fn detail 已复核它们云上的 DB_* 仍在，重发不会清空。
    const child = spawn(process.execPath, [TCB, 'deploy', '--only', 'functions', '--yes'], {
      cwd: ROOT,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false
    });
    let failed = false;
    child.on('error', (e) => {
      failed = true;
      console.error('spawn 失败：' + e.message);
    });
    // 一次性喂足够多的 y，覆盖全部函数（admin-web / fee / stat）的 Overwrite 确认
    child.stdin.on('error', () => { /* 子进程提前退出时忽略 EPIPE */ });
    child.stdin.end('y\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\ny\n');
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
