#!/usr/bin/env node
/**
 * 门禁：源码与发版产物中不得出现明文 API 密钥（2026-11-27）
 * ============================================================
 * 起因：用户问「小程序里的 DeepSeek API key，上传 GitHub 时删了吗」。
 *   核查结论是没有明文泄漏 —— 但原因只是「源码里本来就没写 key」，
 *   而 publish-release.sh 的发布自检并不检查密钥形状，脱敏脚本也没有相关规则。
 *   换句话说：将来谁把 key 硬编码进代码，现存流程不会拦。
 *
 * 本门禁守两条线（缺一不可）：
 *   ① 私有仓受跟踪 + 未跟踪文本文件不得含 sk- 后跟 20 位以上字母数字的明文密钥
 *      （2026-11-27 推演补：只扫受跟踪文件时，新建未跟踪文件里硬编码 key 会假绿）；
 *   ② publish-release.sh 必须保留那道 grep 自检（防止被删 / 被弱化）。
 *
 * ⚠️ 两个必须知道的点：
 *   - 本文件与 publish-release.sh 自身都含密钥模式字面量 ⇒ 扫描时按路径排除，
 *     否则会「自我误报」，门禁永远红。
 *   - 判据锁定完整模式串 'sk-[A-Za-z0-9]{20,}'，不接受「换个写法等价实现」：
 *     安全门禁宁可误报，不可漏放。占位符 sk-… / sk-xxx / <YOUR_API_KEY> 不受影响。
 *
 * 自证：好样本不误报 + 硬编码假密钥必红 + 删掉发布自检整行必红
 *       + 弱化量词（{20,}→{200,}）必红 + 收窄字符类必红。
 *
 * 用法：node scripts/check-no-api-key.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cf = require('./lib/changed-files');

const ROOT = path.resolve(__dirname, '..');
const PUBLISH = path.join(ROOT, 'scripts/publish-release.sh');

const PATTERN_LITERAL = 'sk-[A-Za-z0-9]{20,}';
const KEY_RE = new RegExp(PATTERN_LITERAL);

/** 自身含模式字面量，扫到就是假阳性 —— 按相对路径排除 */
const SELF_EXCLUDE = new Set([
  'scripts/check-no-api-key.js',
  'scripts/publish-release.sh'
]);

/**
 * 纯函数审计，供变异自证复用。
 * @param {{path:string, text:string}[]} files 已读好的受跟踪文本文件
 * @param {string} publishSrc publish-release.sh 源码
 * @returns {string[]} 问题列表（空 = 通过）
 */
function audit(files, publishSrc) {
  const probs = [];
  if (!String(publishSrc || '').includes(PATTERN_LITERAL)) {
    probs.push('publish-release.sh 缺少 sk- 密钥形状自检（可能被删除或量词被弱化）');
  }
  (files || []).forEach((f) => {
    if (SELF_EXCLUDE.has(f.path)) return;
    const m = KEY_RE.exec(String(f.text || ''));
    if (m) probs.push(f.path + '：含明文 API 密钥（sk- 形状，密钥体 ' + (m[0].length - 3) + ' 位）');
  });
  return probs;
}

/** 源文件清单：受跟踪 ∪ 未跟踪，走共享原语（-z 规避中文/空格路径）。
 *  只扫受跟踪文件是同一「表征≠实体」错配：新建未跟踪文件里硬编码 key 会假绿。
 *  --exclude-standard 自动排除 .gitignore 命中的临时文件，避免误报。 */
function listSources() {
  const files = cf.sourceFiles(ROOT);
  return files.length ? files : null;
}

function readTextFiles(paths) {
  const out = [];
  paths.forEach((p) => {
    if (SELF_EXCLUDE.has(p)) return;
    let buf;
    try { buf = fs.readFileSync(path.join(ROOT, p)); } catch (e) { return; }
    // 二进制文件含 NUL 字节，按文本扫会误判 ⇒ 跳过
    if (buf.includes(0)) return;
    out.push({ path: p, text: buf.toString('utf8') });
  });
  return out;
}

/* ================= 跑门禁 ================= */
const sources = listSources();
if (!sources) {
  console.log('✗ 无法读取 git 源文件清单（非 git 环境？）—— 本门禁按失败处理');
  process.exit(1);
}
const realFiles = readTextFiles(sources);
const publishSrc = fs.readFileSync(PUBLISH, 'utf8');
const problems = audit(realFiles, publishSrc);

if (!problems.length) {
  console.log('  ✓ 密钥门禁：' + realFiles.length + ' 个源文件（受跟踪+未跟踪）无明文 API 密钥，发布自检在位');
} else {
  console.log('  ✗ 密钥门禁未通过（' + problems.length + ' 项）：');
  problems.forEach(p => console.log('    · ' + p));
}

/* ================= 变异自证 ================= */
console.log('\n── 自证（改坏一处必须翻红）');
const FAKE_KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'; // 32 位假密钥，仅内存构造，不落盘不外发
const GOOD_FILES = [
  { path: 'ui.js', text: "placeholder: 'sk-…', demo: 'sk-xxx', tpl: '<YOUR_API_KEY>'" },
  { path: 'doc.md', text: 'DeepSeek 官方密钥以 sk- 开头，填到「密钥」栏即可' }
];
const BAD_FILES = [{ path: 'config.js', text: 'const apiKey = ' + JSON.stringify(FAKE_KEY) + ';' }];

let pass = 0, fail = 0;
function chk(cond, name) {
  if (cond) { pass++; console.log('  ✓ 抓到 → ' + name); }
  else { fail++; console.log('  ✗ 漏放 → ' + name); }
}

const good = audit(GOOD_FILES, publishSrc);
if (!good.length) { pass++; console.log('  ✓ 好样本不误报（sk-… / sk-xxx 占位符与说明文字）'); }
else { fail++; console.log('  ✗ 好样本被误报：' + good.join(' | ')); }

chk(audit(BAD_FILES, publishSrc).some(p => /config\.js/.test(p)),
  '变异 1：源码硬编码 32 位假密钥 → 必红');

const guardLine = publishSrc.split('\n').find(l => l.indexOf(PATTERN_LITERAL) >= 0);
const noGuard = guardLine ? publishSrc.replace(guardLine, '') : publishSrc.split(PATTERN_LITERAL).join('');
chk(audit(GOOD_FILES, noGuard).some(p => /publish-release\.sh/.test(p)),
  '变异 2：删掉发布自检整行 → 必红');

const weakQuant = publishSrc.replace('{20,}', '{200,}');
chk(audit(GOOD_FILES, weakQuant).some(p => /publish-release\.sh/.test(p)),
  '变异 3：量词放宽到 200 位 → 必红');

const weakClass = publishSrc.replace('[A-Za-z0-9]', '[A-Z]');
chk(audit(GOOD_FILES, weakClass).some(p => /publish-release\.sh/.test(p)),
  '变异 4：字符类收窄成仅大写 → 必红');

console.log('\n通过=' + pass + ' 失败=' + (fail + problems.length));
process.exit(problems.length || fail ? 1 : 0);
