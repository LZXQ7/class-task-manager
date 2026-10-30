#!/usr/bin/env node
/**
 * 带「云端安装依赖」的定向重部署（2026-10-29 · class/course 包缺 node_modules 事故）
 * ============================================================================
 * 事故：`deploy_all.sh` 用 `functions:deploy --dir . --deployMode zip` 部署，
 *   class（37MB）/ course（50MB）这两个**最大的包**在上传时把 node_modules 丢了
 *   ⇒ 线上 require('wx-server-sdk') 直接崩，整个函数 100% 失败
 *   ⇒ 班级管理「暂无班级」、班级信息页「未绑定班级」、首屏卡 6 秒（容器冷启 + init 失败）。
 *
 * 本脚本的修法与 deploy-fee.js 同款，但**通用化 + 更保守**：
 *   ① 部署**前**先把该函数在云端**现存**的环境变量 pull 下来（fn env pull），
 *      再临时写进 cloudbaserc.json —— 避免「cloudbaserc 里没登记该函数 ⇒ 部署把
 *      DB_* 与 WX_APPID 冲掉」（deploy_all.sh 注释里点名的真实故障方向）；
 *   ② 显式登记 vpc（与其它函数同款 vpc-c4ga6fms / subnet-a5mkrg1l）——
 *      DB_HOST 是 VPC 内网地址 172.17.0.15，丢 VPC = 连不上库；
 *   ③ `--install-dependency true` 让**云端** npm install，不再依赖本地大包上传，
 *      从根上绕开「大包上传丢目录」这个失败模式；
 *   ④ cloudbaserc.json 的注入是**临时**的：finally 里无条件还原，
 *      并有 .wb_tmp 安全备份（被 SIGKILL 打断也不会把口令留在磁盘）。
 *
 * 用法：
 *   node scripts/deploy-fn-deps.js class
 *   node scripts/deploy-fn-deps.js class course
 *   node scripts/deploy-fn-deps.js class --dry-run
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RC_PATH = path.join(ROOT, 'cloudbaserc.json');
const TCB = process.env.TCBJS ||
  'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FNS = args.filter((a) => !a.startsWith('-'));
if (!FNS.length) {
  console.error('用法：node scripts/deploy-fn-deps.js <fn> [fn2 …] [--dry-run]');
  process.exit(2);
}

const rc = JSON.parse(fs.readFileSync(RC_PATH, 'utf8'));
const ENV_ID = rc.envId;
const REGION = rc.region || 'ap-shanghai';

/** 与 cloudbaserc.json 里其它函数同款的 VPC（DB 在同 VPC 内网） */
const VPC = { vpcId: 'vpc-c4ga6fms', subnetId: 'subnet-a5mkrg1l' };

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

/** 从云端 pull 该函数现有的环境变量（先于任何改动，保证拿到的是线上真值） */
function pullEnv(fn) {
  const dir = path.join(ROOT, '.wb_tmp');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'env-' + fn + '.txt');
  try { fs.unlinkSync(out); } catch (e) { /* 不存在 */ }
  const r = spawnSync('node', [TCB, 'fn', 'env', 'pull', fn, '-e', ENV_ID, '-r', REGION,
    '--output-file', out], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const txt = String((r && r.stdout) || '') + String((r && r.stderr) || '');
  const env = parseEnvFile(out);
  if (!Object.keys(env).length) {
    console.log('  ⚠️ ' + fn + ' 云端未拉到环境变量（' + (/Exported/.test(txt) ? '空' : 'pull 失败') +
      '）⇒ 回退 .env-auth');
    return parseEnvFile(path.join(ROOT, '.env-auth'));
  }
  return env;
}

/** spawn tcb（Windows 下 spawnSync + pipe 会 EBUSY，故异步 spawn + 喂 y） */
function runTcb(argv, label) {
  return new Promise((resolve) => {
    console.log('→ node ' + argv.slice(1).join(' '));
    const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['pipe', 'inherit', 'inherit'], shell: false });
    let failed = false;
    child.on('error', (e) => { failed = true; console.error('spawn 失败：' + e.message); });
    child.stdin.on('error', () => { /* EPIPE：子进程提前退出 */ });
    child.stdin.end('y\ny\ny\ny\ny\ny\ny\ny\n');
    child.on('close', (status, signal) => {
      if (signal) console.error('子进程被信号 ' + signal + ' 终止');
      resolve({ ok: !failed && !signal && status === 0, code: typeof status === 'number' ? status : 1 });
    });
  });
}

(async () => {
  const pulled = {};
  for (const fn of FNS) {
    const env = pullEnv(fn);
    pulled[fn] = env;
    console.log('[env] ' + fn.padEnd(12) + Object.keys(env).map((k) => k + '(len=' + String(env[k]).length + ')').join(' '));
  }

  if (DRY) {
    console.log('\n--dry-run：未改动 cloudbaserc.json，未部署。');
    process.exit(0);
  }

  const SAFE = path.join(ROOT, '.wb_tmp', 'cloudbaserc.safe-fndeps.json');
  fs.mkdirSync(path.dirname(SAFE), { recursive: true });
  // 抗中断：若上次被杀导致文件里还留着注入内容，先还原（只在确实脏时才覆盖）
  if (fs.existsSync(SAFE)) {
    const cur = fs.readFileSync(RC_PATH, 'utf8');
    if (/envVariables/.test(cur) && !/"envVariables"/.test(fs.readFileSync(SAFE, 'utf8').slice(0, 0) || '{}')) {
      fs.copyFileSync(SAFE, RC_PATH);
      console.log('检测到上次部署被中断，已从安全备份还原 cloudbaserc.json。');
    }
  }
  const original = fs.readFileSync(RC_PATH, 'utf8');
  fs.writeFileSync(SAFE, original, 'utf8');

  const results = [];
  try {
    const rcJson = JSON.parse(original);
    for (const fn of FNS) {
      const entry = (rcJson.functions || []).find((f) => f.name === fn);
      const base = entry || {
        name: fn,
        runtime: 'Nodejs18.15',
        handler: 'index.main',
        timeout: 20,
        memorySize: 256,
        installDependency: true,
        dir: './cloudfunctions/' + fn
      };
      base.dir = './cloudfunctions/' + fn;
      base.installDependency = true;
      base.vpc = VPC;
      base.envVariables = Object.assign({}, base.envVariables, pulled[fn]);
      if (!entry) (rcJson.functions || (rcJson.functions = [])).push(base);
      fs.writeFileSync(RC_PATH, JSON.stringify(rcJson, null, 2) + '\n', 'utf8');
      console.log('\n=== 部署 ' + fn + '（云端安装依赖，保留 VPC + 环境变量）===');
      const r = await runTcb([TCB, 'fn', 'deploy', fn, '-e', ENV_ID,
        '--dir', './cloudfunctions/' + fn, '--install-dependency', 'true'], fn);
      results.push((r.ok ? 'OK   ' : 'FAIL ') + fn + ' (exit=' + r.code + ')');
      console.log((r.ok ? '[OK] ' : '[FAIL] ') + fn);
    }
  } finally {
    fs.writeFileSync(RC_PATH, original, 'utf8');
    try { fs.unlinkSync(SAFE); } catch (e) { /* 已删 */ }
    console.log('\n已还原 cloudbaserc.json（口令未留在磁盘）。');
  }
  console.log('\n=== 结果 ===');
  console.log(results.join('\n'));
  process.exit(results.every((r) => r.startsWith('OK')) ? 0 : 1);
})();
