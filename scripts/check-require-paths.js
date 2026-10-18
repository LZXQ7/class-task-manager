/**
 * 静态校验：云函数里所有「本地相对 require」的目标是否真实存在
 * ------------------------------------------------------------------
 * 触发事故（2026-10-18）：新增 cloudfunctions/admin-web/lib/mod-usage.js 时，
 * 把 `require('../common/db')` 误写成 `require('./common/db')`。
 *   · `node --check` 只查语法，**查不出 require 路径错**；
 *   · 本地 e2e 跑 `127.0.0.1` 时若未真正 require 到这个文件也可能漏；
 *   · 结果：部署成功（Deployment completed），但函数一被调用就
 *     `Error: Cannot find module './common/db'` 进程崩溃 ⇒ SCF 返回 443 ⇒
 *     整个后台打不开。排查花了半小时，根因却是 1 个点号。
 * 本门禁把这类错误挡在上线前：扫描 cloudfunctions/<fn>/ 下全部 .js
 * （排除 node_modules），逐条校验 `require('./x')` / `require('../x')`。
 *
 * ⚠️ 必须**先剥注释**再匹配：common/test-account.js 的文档注释里有
 *    `require('./common/test-account')` 示例，直接正则扫会误报。
 */
const fs = require('fs');
const path = require('path');

const LF = String.fromCharCode(10);
const ROOT = path.join(__dirname, '..', 'cloudfunctions');

const problems = [];
let scannedFiles = 0;
let scannedRequires = 0;

/** 逐行剥掉块注释与行注释（够用即可，不追求完整 JS 词法） */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split(LF)) {
    let s = line;
    if (inBlock) {
      const end = s.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      s = s.slice(end + 2);
      inBlock = false;
    }
    let res = '';
    let i = 0;
    while (i < s.length) {
      if (s[i] === '/' && s[i + 1] === '/') break;
      if (s[i] === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2);
        if (end === -1) { inBlock = true; break; }
        i = end + 2;
        continue;
      }
      res += s[i];
      i += 1;
    }
    out.push(res);
  }
  return out.join(LF);
}

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* 不存在 */ }
  }
  return null;
}

const REQ_RE = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function scanDir(dir, sink) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of ents) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === '.wb_tmp') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { scanDir(p, sink); continue; }
    if (!ent.name.endsWith('.js')) continue;
    scannedFiles += 1;
    const code = stripComments(fs.readFileSync(p, 'utf8'));
    let m;
    REQ_RE.lastIndex = 0;
    while ((m = REQ_RE.exec(code)) !== null) {
      scannedRequires += 1;
      if (!resolveLocal(p, m[1])) {
        sink.push(path.relative(path.join(ROOT, '..'), p) + '  ->  ' + m[1]);
      }
    }
  }
}

/* ---------- 自证：坏样本必须被抓、好样本不得误报 ---------- */
{
  const tmp = path.join(__dirname, '..', '.workbuddy', 'check-require-paths-tmp');
  const good = path.join(tmp, 'good');
  const bad = path.join(tmp, 'bad');
  for (const d of [good, bad]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 垫片抖动不判死 */ }
    fs.mkdirSync(path.join(d, 'common'), { recursive: true });
    fs.mkdirSync(path.join(d, 'lib'), { recursive: true });
  }
  fs.writeFileSync(path.join(good, 'common', 'db.js'), 'module.exports={};' + LF, 'utf8');
  fs.writeFileSync(path.join(good, 'lib', 'ok.js'), "require('../common/db');" + LF, 'utf8');
  fs.writeFileSync(path.join(bad, 'common', 'db.js'), 'module.exports={};' + LF, 'utf8');
  fs.writeFileSync(path.join(bad, 'lib', 'bad.js'), "require('./common/db');" + LF, 'utf8');
  // 注释里的错误路径不得误报
  fs.writeFileSync(path.join(good, 'lib', 'note.js'),
    '/* const x = require("./common/nope"); */' + LF + '// require("../common/nope")\n' + 'module.exports=1;' + LF, 'utf8');

  const goodSink = [];
  const badSink = [];
  scanDir(good, goodSink);
  scanDir(bad, badSink);
  const selfOk = goodSink.length === 0 && badSink.length === 1;
  if (!selfOk) {
    problems.push('自证失败：好样本误报 ' + goodSink.length + ' 条 / 坏样本漏报 ' + badSink.length + ' 条（期望 0 / 1）');
  }
}

/* ---------- 正式扫描 ---------- */
scanDir(ROOT, problems);

if (problems.length) {
  console.error('✗ require 路径校验失败（' + problems.length + ' 处）：');
  problems.forEach((p) => console.error('   ' + p));
  console.error('  提示：lib/ 下引用根目录 common/ 应写 ../common/xxx，不是 ./common/xxx。');
  process.exit(1);
}

console.log('✓ require 路径校验通过：' + scannedFiles + ' 个 .js / ' + scannedRequires + ' 条本地 require，全部命中真实文件。');
