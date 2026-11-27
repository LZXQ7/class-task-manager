#!/usr/bin/env node
/**
 * 门禁：30 天复盘沉淀物必须仍在位（2026-11-27）
 * ============================================================
 * 背景：复盘得出 6 类复发模式，写成 RULES-RECURRENCE.md + 两处自动化
 *   （runner 强制 normalize-eol、密钥形状门禁）。但「写下来的东西」
 *   和「写规则仍复发」的历史一样，会在后续某次改动里被删掉/绕过而无人察觉。
 *   本门禁把「沉淀物本身」变成被守对象：删掉或弱化任一，立即翻红。
 *
 * 判据（5 条）：
 *   ① RULES-RECURRENCE.md 存在且 M1~M6 六节齐全；
 *   ② 元根因节仍在（否则退化为流水账，失去「规则必须自动化」的约束）；
 *   ③ run_all_gates.sh 开头强制调用 normalize-eol（CRLF 假绿防线）；
 *   ④ check-no-api-key.js 存在且 publish-release.sh 保留密钥形状拦截；
 *   ⑤ 项目 MEMORY.md 顶部指向 RULES-RECURRENCE.md（入口不断链）；
 *   ⑥ 共享原语 scripts/lib/changed-files.js 在位且三处门禁都从它取信号源
 *      （防各自改回本地 git 命令，重演 M1 同源多点漏改）。
 *
 * 自证：删任一节 / 删归一化调用 / 删密钥拦截 / 删索引 / 删共享原语接入，必须翻红。
 * 用法：node scripts/check-recurrence-rules.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = {
  rules: path.join(ROOT, 'RULES-RECURRENCE.md'),
  runner: path.join(ROOT, 'scripts/run_all_gates.sh'),
  keygate: path.join(ROOT, 'scripts/check-no-api-key.js'),
  decgate: path.join(ROOT, 'scripts/check-decisions.js'),
  shared: path.join(ROOT, 'scripts/lib/changed-files.js'),
  eolgate: path.join(ROOT, 'scripts/normalize-eol.js'),
  decisions: path.join(ROOT, 'DECISIONS.md'),
  publish: path.join(ROOT, 'scripts/publish-release.sh'),
  memory: path.join(ROOT, '.workbuddy/memory/MEMORY.md'),
  readme: path.join(ROOT, 'README.md')
};
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
const S = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, read(p)]));

const PATTERN_LITERAL = 'sk-[A-Za-z0-9]{20,}';
const SECTIONS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

function audit(X) {
  const bad = [];
  const need = (name, cond) => { if (!cond) bad.push(name); };

  need('rulesFile', X.rules.length > 2000);
  // 锚到「完整标题行」而非前缀：否则 `## M4x` 也会命中 `## M4`（本次自证实测漏放）
  SECTIONS.forEach(m => need('section_' + m, new RegExp('^## ' + m + ' · ', 'm').test(X.rules)));
  need('metaRootCause', X.rules.indexOf('元根因') >= 0 && X.rules.indexOf('规则升级路径') >= 0);
  need('runnerNormalize', /node scripts\/normalize-eol\.js/.test(X.runner));
  need('runnerFatalGuard', /normalize-eol 失败/.test(X.runner));
  need('keygateExists', X.keygate.length > 1000);
  need('publishKeyGuard', X.publish.indexOf(PATTERN_LITERAL) >= 0);
  // M4 的自动化承载（2026-11-27 补）：口径门禁 + 决策记录 + 规则文件里的指向，三者缺一即 M4 退回「无承载」
  need('decGateExists', X.decgate.length > 2000 && X.decgate.indexOf('isPresentation') >= 0);
  need('sharedSourceExists', X.shared.length > 1500 && X.shared.indexOf('function changedFiles(') >= 0 && X.shared.indexOf('function sourceFiles(') >= 0);
  // 三处消费者必须都从共享原语取文件集；任一处退回本地 git 命令即 M1 复发。
  need('sharedWired', X.decgate.indexOf('cf.changedFiles(ROOT)') >= 0 &&
    X.keygate.indexOf('cf.sourceFiles(ROOT)') >= 0 &&
    X.eolgate.indexOf('cf.sourceFiles(ROOT)') >= 0);
  need('decisionsFile', X.decisions.length > 800 && X.decisions.indexOf('# 口径决策记录') >= 0);
  need('rulesPointToDecGate', X.rules.indexOf('check-decisions.js') >= 0);
  // 双仓索引入口不同：私有仓 .workbuddy/memory/MEMORY.md，公开仓不含 .workbuddy ⇒ README.md
  const indexSrc = X.memory.length > 0 ? X.memory : X.readme;
  need('indexEntry', indexSrc.indexOf('RULES-RECURRENCE.md') >= 0);
  return bad;
}

const problems = audit(S);
if (!problems.length) {
  console.log('  ✓ 复盘沉淀物门禁：规则六节 + 元根因 + 行尾归一化 + 密钥拦截 + 记忆索引 全部在位');
} else {
  console.log('  ✗ 复盘沉淀物门禁未通过（' + problems.length + ' 项）：');
  problems.forEach(p => console.log('    · ' + p));
}

/* ================= 变异自证 ================= */
console.log('\n── 自证（改坏一处必须翻红）');
let pass = 0, fail = 0;
function chk(cond, name) {
  if (cond) { pass++; console.log('  ✓ 抓到 → ' + name); }
  else { fail++; console.log('  ✗ 漏放 → ' + name); }
}
const M = [
  { name: '删掉规则文件', patch: { rules: '' }, judge: b => b.some(x => /rulesFile/.test(x)) },
  { name: '删掉 M4（用户口径节）', patch: { rules: S.rules.replace('## M4 · 用户口径未钉死就动手（返工量最大）', '## M4x · 用户口径未钉死就动手（返工量最大）') }, judge: b => b.some(x => /section_M4/.test(x)) },
  { name: '删掉元根因节', patch: { rules: S.rules.split('元根因').join('上游原因') }, judge: b => b.some(x => /metaRootCause/.test(x)) },
  { name: '删掉 runner 的 normalize-eol 调用', patch: { runner: S.runner.replace('node scripts/normalize-eol.js >/dev/null 2>&1', 'true') }, judge: b => b.some(x => /runnerNormalize/.test(x)) },
  { name: '删掉发布脚本的密钥拦截', patch: { publish: S.publish.split(PATTERN_LITERAL).join('sk-[a-z]{4}') }, judge: b => b.some(x => /publishKeyGuard/.test(x)) },
  { name: '删掉索引里的规则入口', patch: { memory: S.memory.split('RULES-RECURRENCE.md').join('RECURRENCE-RULES.md'), readme: S.readme.split('RULES-RECURRENCE.md').join('RECURRENCE-RULES.md') }, judge: b => b.some(x => /indexEntry/.test(x)) },
  { name: '删掉口径门禁', patch: { decgate: '' }, judge: b => b.some(x => /decGateExists/.test(x)) },
  { name: '删掉 DECISIONS.md', patch: { decisions: '' }, judge: b => b.some(x => /decisionsFile/.test(x)) },
  { name: '删掉规则里指向口径门禁的承载说明', patch: { rules: S.rules.split('check-decisions.js').join('decision-check.js') }, judge: b => b.some(x => /rulesPointToDecGate/.test(x)) },
  { name: '删掉共享原语', patch: { shared: '' }, judge: b => b.some(x => /sharedSourceExists/.test(x)) },
  { name: '口径门禁改回本地 git 命令（绕过共享原语）', patch: { decgate: S.decgate.split('cf.changedFiles(ROOT)').join('localGitChanged()') }, judge: b => b.some(x => /sharedWired/.test(x)) },
  { name: '密钥门禁改回本地 git 命令（绕过共享原语）', patch: { keygate: S.keygate.split('cf.sourceFiles(ROOT)').join('localGitFiles()') }, judge: b => b.some(x => /sharedWired/.test(x)) },
  { name: '行尾归一化改回本地 git 命令（绕过共享原语）', patch: { eolgate: S.eolgate.split('cf.sourceFiles(ROOT)').join('localGitFiles()') }, judge: b => b.some(x => /sharedWired/.test(x)) }
];
M.forEach(mu => {
  const X = Object.assign({}, S, mu.patch);
  chk(mu.judge(audit(X)), mu.name);
});

console.log('\n通过=' + pass + ' 失败=' + (fail + problems.length));
process.exit(problems.length || fail ? 1 : 0);
