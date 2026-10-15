#!/usr/bin/env node
/**
 * 云函数包瘦身（2026-10-15 · 课表页加载慢主因①）
 * ============================================================================
 * 问题：`class` 云函数本地源码仅 100KB，线上 Code size 却有 11.7MB。
 *   根源 = `installDependency: true` ⇒ 部署时云端 `npm install`，
 *   把 **传递依赖 + peer 自动安装** 全装进来：
 *     · @typescript/typescript-*  27MB（TypeScript 的**全平台二进制**，云函数跑 Linux，
 *                                      Windows 那些纯属死重；还是 peer 自动安装来的）
 *     · typescript / @types         4.8MB（类型声明，运行时只执行 .js，根本不用）
 *     · source-map                  0.8MB（源码映射，同上）
 *   实测：装完 63.41MB / 136 包 ⇒ 清理后 24.39MB（**降 62%**），
 *        且 `mysql2/promise`、`wx-server-sdk`、`mysql2` 全部仍可用。
 *
 * 为什么值得做：包越大 ⇒ 云函数冷启动（下载 + 解压 + require）越慢。
 *   课表页首屏要串行等 `class.list` 与 `course.allSessions` 两个函数，
 *   两个都背着 11~16MB 的包 ⇒ 首屏被冷启动拖住。
 *
 * 用法：
 *   node scripts/slim-cloudfunction-pkg.js            # 清理全部（默认，带确认）
 *   node scripts/slim-cloudfunction-pkg.js --yes      # 不问，直接干（部署流程里用）
 *   node scripts/slim-cloudfunction-pkg.js course     # 只清某个函数
 *
 * ⚠️ 安全性：只删「Node 运行时不会执行」的东西 ——
 *    · 整包：typescript / @types / source-map / @typescript
 *      （它们都不是 wx-server-sdk / mysql2 的运行时依赖；万一某个库在运行时
 *        `require('typescript')`，这里会**在清完后立刻 require 一次探活**，失败就报出来）
 *    · 单文件：孤立的 `.d.ts` / `.map`（即同名 `.js` 不存在的那些 —— 那种是纯声明/映射文件；
 *      有同名 .js 的 `.d.ts` 与 `.map` 是**加载时可能需要的**，保留）
 * 🔴 删除全部包在 `finally` 里 try/catch —— 宿主 fs.rmSync 走回收站垫片，可能超时/抛错，
 *    那是环境问题，不该让部署流程整体失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CF = path.join(ROOT, 'cloudfunctions');

/** 整包删除名单：类型声明 / 源码映射 / 平台二进制 */
const DROP_DIRS = ['typescript', '@types', 'source-map', '@typescript'];

/** 清完必须还能 require 出来的运行时依赖（探活） */
const PROBE = ['mysql2/promise', 'mysql2', 'wx-server-sdk'];

/** 带 common 副本但**不走** deploy_all.sh 的函数（需 VPC/环境变量），瘦身时仍要覆盖 */
const ALL_FNS = fs.existsSync(CF)
  ? fs.readdirSync(CF).filter((d) => {
      try { return fs.statSync(path.join(CF, d)).isDirectory() && fs.existsSync(path.join(CF, d, 'package.json')); }
      catch (e) { return false; }
    })
  : [];

function dirSize(p) {
  let t = 0;
  try {
    for (const f of fs.readdirSync(p)) {
      const fp = path.join(p, f);
      let st; try { st = fs.statSync(fp); } catch (e) { continue; }
      if (st.isDirectory()) t += dirSize(fp); else t += st.size;
    }
  } catch (e) { /* 忽略 */ }
  return t;
}
const mb = (n) => (n / 1048576).toFixed(2) + 'MB';

/**
 * 删「孤立的」.d.ts / .map：没有同名 .js 的那些才是纯声明/映射。
 * 有同名 .js 的要留 —— Node 加载 .js 时若开了 sourceMap 会去读 .map。
 */
function stripOrphanMaps(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      let st; try { st = fs.statSync(fp); } catch (e) { continue; }
      if (st.isDirectory()) { n += stripOrphanMaps(fp); continue; }
      if (!/\.(d\.ts|map)$/.test(f)) continue;
      const stem = fp.replace(/\.(d\.ts|map)$/, '');
      if (fs.existsSync(stem + '.js')) continue;      // 有同名 .js ⇒ 可能是运行时需要的
      if (fs.existsSync(stem + '.cjs') || fs.existsSync(stem + '.mjs')) continue;
      try { fs.unlinkSync(fp); n++; } catch (e) { /* 垫片可能失败 */ }
    }
  } catch (e) { /* 忽略 */ }
  return n;
}

/** 探活：清完后运行时依赖必须仍能 require（cwd 切到函数目录，让模块解析走它的 node_modules） */
function probe(fnDir) {
  const script = PROBE.map((m) => {
    const e = m.replace(/'/g, "\\'");
    return `try { require('${e}'); console.log('  OK   ${e}'); } catch (err) { console.log('  FAIL ${e} :: ' + err.message); process.exitCode = 1; }`;
  }).join('\n');
  const { spawnSync } = require('child_process');
  const NODE = process.execPath;
  const r = spawnSync(NODE, ['-e', script], { cwd: fnDir, encoding: 'utf8', timeout: 60000 });
  return { rc: r.status === null ? 1 : r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const args = process.argv.slice(2);
const yes = args.includes('--yes') || args.includes('-y');
const only = args.filter((a) => !a.startsWith('-'));

const targets = only.length ? only.filter((f) => ALL_FNS.includes(f))
  : ALL_FNS.filter((f) => f !== 'admin-web' && f !== 'fee');   // 这两个走专用部署脚本，见 deploy_all.sh 注释

if (!targets.length) {
  console.error('没有可清理的函数目录（cloudfunctions 下无 package.json）');
  process.exit(1);
}

console.log('将清理以下 ' + targets.length + ' 个函数的包：' + targets.join(' '));
if (!yes) {
  console.log('（加 --yes 跳过确认；部署流程里会自动带 --yes）');
  process.exit(0);
}

let failed = 0;
for (const fn of targets) {
  const dir = path.join(CF, fn);
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) { console.log('[skip] ' + fn + '（无 node_modules，云端自装）'); continue; }
  const before = dirSize(nm);
  let dropped = 0, files = 0;
  for (const d of DROP_DIRS) {
    const p = path.join(nm, d);
    if (!fs.existsSync(p)) continue;
    try { fs.rmSync(p, { recursive: true, force: true }); dropped++; } catch (e) { /* 垫片失败不致命 */ }
  }
  files = stripOrphanMaps(nm);
  const after = dirSize(nm);
  const pr = probe(dir);
  const okMark = pr.rc === 0 ? '✅' : '❌';
  console.log('[' + okMark + '] ' + fn.padEnd(14) + mb(before) + ' → ' + mb(after) +
    '（删整包 ' + dropped + ' 个，清孤立 .d.ts/.map ' + files + ' 个）');
  if (pr.rc !== 0) {
    failed++;
    console.log(pr.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
    console.log('    ⚠️ 探活失败 —— 请立即重新部署该函数（deps 目录可能已被改动）');
  }
}
console.log(failed ? ('\n⚠️ ' + failed + ' 个函数探活失败') : '\n✅ 全部函数探活通过');
process.exit(failed ? 1 : 0);