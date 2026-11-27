#!/usr/bin/env node
/**
 * 门禁：M4「口径未钉死就动手」的可追溯性防线（2026-11-27）
 * ============================================================
 * 背景：30 天复盘里返工量最大的一类是「做完被用户推翻」。上一轮把 M4 写成
 *   规则（AskUserQuestion 前置确认），但自动化承载写了「无」——纯靠记得遵守，
 *   与元根因「规则只写在文本里，高压下必然漏」同族。本门禁是 M4 的自动化承载。
 *
 * ⚠️ 能力边界（刻意不越界，否则就是 M2 假绿）：
 *   本门禁只查「呈现类改动有没有对应的口径记录」——即可追溯性。
 *   它**不查**记录内容对不对。正确性靠用户动手前点头（AskUserQuestion），
 *   一个无法自动化的判断伪装成自动检查只会制造假绿。
 *
 * 判据（4 条）：
 *   ① DECISIONS.md 存在、足够长、含表头与格式说明；
 *   ② 至少一条 `## YYYY-MM-DD · 标题` 记录；
 *   ③ 每条记录四要素齐全：需求原话 / 我理解的口径 / 触发文件 / 确认结果；
 *   ④ 呈现类文件改动（工作区 ∪ 最近一次提交）必须被某条记录的「触发文件」覆盖。
 *
 * 触发边界（只对用户可感知的呈现/行为改动生效）：
 *   - miniprogram 下 *.wxml / *.wxss
 *   - cloudfunctions/admin-web/public/ 下所有文件
 *   - miniprogram/pages|components 下 *.js 且 diff 含导航/原生弹窗 API
 *   纯逻辑修复、门禁脚本、发版脚本、文档改动不触发——避免假红导致门禁被弃用。
 *
 * 自证（改坏必翻红）：
 *   删 DECISIONS.md / 删记录 / 删四要素之一 / 改呈现文件但无记录覆盖 ⇒ 红；
 *   纯逻辑改动、被记录覆盖的呈现改动 ⇒ 绿（不误报）。
 * 用法：node scripts/check-decisions.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DECISIONS = path.join(ROOT, 'DECISIONS.md');

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

/** 取改动文件：三路信号并集——
 *   ① 工作区相对 HEAD 的已跟踪改动；
 *   ② 最近一次提交的改动（避免「提交后工作区干净 ⇒ 永远绿」）；
 *   ③ **未跟踪文件**（`git ls-files --others --exclude-standard`）。
 * ① 的 git diff 看不见未跟踪文件，而「口径未钉死就动手」最高发场景恰恰是
 *   新建页面/新交互（返回 untracked）——防护若只挂 git diff 就会在最该触发时假绿。
 *   这不是再叠一层门禁，而是修正检测信号源本身（表征 ≠ 实体）。
 *   .gitignore 命中的临时文件（如 .wb_tmp/）由 --exclude-standard 自动排除。 */
function changedFiles() {
  const out = [];
  const cmds = [
    ['diff', '--name-only', 'HEAD'],
    ['diff', '--name-only', 'HEAD~1', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard']
  ];
  cmds.forEach(args => {
    try {
      const txt = cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      txt.split('\n').forEach(f => { if (f && out.indexOf(f) < 0) out.push(f); });
    } catch (e) {
      console.error('  [warn] git ' + args.join(' ') + ' 失败: ' + e.message);
    }
  });
  return out;
}

/** 取指定文件的 diff 新增行（含 + 前缀去掉），用于判定 .js 是否改了呈现行为。 */
function addedLinesOf(file) {
  try {
    const txt = cp.execFileSync('git', ['diff', 'HEAD', '--', file], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return txt.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n');
  } catch (e) {
    console.error('  [warn] git diff ' + file + ' 失败: ' + e.message);
    return '';
  }
}

const NAV_APIS = /navigateTo|redirectTo|switchTab|reLaunch|navigateBack|showModal|showActionSheet|showToast|showLoading|setNavigationBar|setTabBar/;

/** 判定一个改动文件是否属于「用户可感知的呈现/行为」触发边界。 */
function isPresentation(file, added) {
  if (/^miniprogram\/.*\.(wxml|wxss)$/.test(file)) return true;
  if (/^cloudfunctions\/admin-web\/public\//.test(file)) return true;
  if (/^miniprogram\/(pages|components)\/.*\.js$/.test(file)) return NAV_APIS.test(added || '');
  return false;
}

/** 解析 DECISIONS.md 中的记录。返回 [{date,title,body,files}] */
function parseRecords(doc) {
  const parts = doc.split(/^## (\d{4}-\d{2}-\d{2}) · (.+)$/m);
  const recs = [];
  for (let i = 1; i < parts.length; i += 3) {
    const date = parts[i], title = parts[i + 1], body = parts[i + 2] || '';
    const files = [];
    // 同一行抓取：用 [^\n]* 吃到行尾，但不能跟 \n? + 非贪婪组合——
    // 否则被紧邻的 **确认结果** 行拦住，m[1] 为空 ⇒ 覆盖判定永远假绿（M2）。
    const m = body.match(/\*\*触发文件\*\*([^\n]*)/);
    if (m) {
      (m[1].match(/`([^`]+)`/g) || []).forEach(t => files.push(t.slice(1, -1).trim()));
    }
    recs.push({ date, title, body, files });
  }
  return recs;
}

const FIELDS = ['需求原话', '我理解的口径', '触发文件', '确认结果'];

function audit(X) {
  const bad = [];
  const need = (name, cond) => { if (!cond) bad.push(name); };

  // 检测层守卫：未跟踪文件那一路若被移除，新建页面假绿 ⇒ 直接翻红
  need('signalUntracked', X.signalUntracked === true);
  need('decisionsFile', X.decisions.length > 800);
  need('decisionsHeader', X.decisions.indexOf('# 口径决策记录') >= 0);
  need('formatDoc', X.decisions.indexOf('能力边界') >= 0 && X.decisions.indexOf('check-decisions.js') >= 0);

  const recs = parseRecords(X.decisions);
  need('hasRecord', recs.length >= 1);
  recs.forEach((r, i) => {
    FIELDS.forEach(f => need('field_' + i + '_' + f, r.body.indexOf('**' + f + '**') >= 0));
  });

  // 覆盖判定：每个呈现类改动文件，须被某条记录「触发文件」中的路径前缀覆盖
  const covered = [];
  recs.forEach(r => r.files.forEach(p => covered.push(p)));
  need('coverAllMarker', covered.indexOf('all') >= 0 || covered.indexOf('全部') >= 0 || covered.length > 0);

  const pres = (X.changedFiles || []).filter(f => isPresentation(f, (X.added && X.added[f]) || ''));
  pres.forEach(f => {
    const ok = covered.some(p => f === p || f.indexOf(p) === 0);
    need('covered::' + f, ok);
  });
  return bad;
}

function collect() {
  const files = changedFiles();
  const added = {};
  files.forEach(f => {
    if (/^miniprogram\/(pages|components)\/.*\.js$/.test(f)) added[f] = addedLinesOf(f);
  });
  return { decisions: read(DECISIONS), changedFiles: files, added };
}

const S = collect();
// 信号源守卫：`changedFiles()` 必须包含未跟踪文件那一路，否则新建页面会假绿。
// 读自身源码断言那一路仍在位——避免它像 CRLF 那样被改回去而无人察觉（M2 假绿）。
const UNTRACKED_SIGNAL = "['ls-files', '--others', '--exclude-standard']";
S.signalUntracked = fs.readFileSync(__filename, 'utf8').indexOf(UNTRACKED_SIGNAL) >= 0;

const problems = audit(S);
if (!problems.length) {
  console.log('  ✓ 口径门禁：DECISIONS.md 结构完好，' + S.changedFiles.length + ' 个改动文件中呈现类均被覆盖');
} else {
  console.log('  ✗ 口径门禁未通过（' + problems.length + ' 项）：');
  problems.forEach(p => console.log('    · ' + p));
  console.log('    → 呈现类改动须先在 DECISIONS.md 留一条当日口径记录（需求原话/我理解的口径/触发文件/确认结果）');
}

/* ================= 变异自证 ================= */
console.log('\n── 自证（改坏一处必须翻红）');
let pass = 0, fail = 0;
function chk(cond, name) {
  if (cond) { pass++; console.log('  ✓ 抓到 → ' + name); }
  else { fail++; console.log('  ✗ 漏放 → ' + name); }
}

const M = [
  { name: '删掉 DECISIONS.md', patch: { decisions: '' }, judge: b => b.some(x => /decisionsFile/.test(x)) },
  { name: '删掉全部记录', patch: { decisions: S.decisions.split(/^## \d{4}-\d{2}-\d{2} · .*$/m).join('## 无记录 · 已删除') }, judge: b => b.some(x => /hasRecord/.test(x)) },
  // 锚点必须唯一：**确认结果** 在格式说明区也出现一次，直接 replace 会打到说明区（M2 前缀命中）。
  // 用记录体内独有的整行内容做锚。
  { name: '删掉记录体的「确认结果」要素', patch: { decisions: S.decisions.replace('- **确认结果**：「按推荐来」→「我不知道三个都有什么区别，按最优的来」→「确认，开始执行 (Recommended)」。', '- **答复结果**：「按推荐来」。') }, judge: b => b.some(x => /field_0_确认结果/.test(x)) },
  { name: '删掉「能力边界」说明（弱化自我约束）', patch: { decisions: S.decisions.replace('能力边界', '说明') }, judge: b => b.some(x => /formatDoc/.test(x)) },
  { name: '改了呈现文件但无记录覆盖', patch: { changedFiles: ['miniprogram/pages/duty/index.wxml'], added: {} }, judge: b => b.some(x => /covered::miniprogram\/pages\/duty\/index\.wxml/.test(x)) },
  { name: '改了后台呈现文件但无记录覆盖', patch: { changedFiles: ['cloudfunctions/admin-web/public/app.js'], added: {} }, judge: b => b.some(x => /covered::cloudfunctions/.test(x)) },
  { name: '改了页面 js 的导航 API 但无记录覆盖', patch: { changedFiles: ['miniprogram/pages/mine/index.js'], added: { 'miniprogram/pages/mine/index.js': 'wx.navigateTo({url:...})' } }, judge: b => b.some(x => /covered::miniprogram\/pages\/mine\/index\.js/.test(x)) },
  // 第一性原理实例：新建页面（未跟踪呈现文件）无记录必须翻红——这是本次本质修复的回归测试
  { name: '新建未跟踪 wxml 页面无记录覆盖', patch: { changedFiles: ['miniprogram/pages/newfeature/index.wxml'], added: {} }, judge: b => b.some(x => /covered::miniprogram\/pages\/newfeature\/index\.wxml/.test(x)) },
  { name: '删掉未跟踪文件信号源（假绿命门）', patch: { signalUntracked: false }, judge: b => b.some(x => /signalUntracked/.test(x)) }
];
M.forEach(mu => {
  const X = Object.assign({}, S, mu.patch);
  chk(mu.judge(audit(X)), mu.name);
});

// 好样本不误报：纯逻辑改动 + 被记录覆盖的呈现改动
chk(!audit(Object.assign({}, S, {
  changedFiles: ['cloudfunctions/ai-proxy/index.js', 'scripts/check-wxml.js'],
  added: {}
})).some(x => /^covered::/.test(x)), '纯逻辑改动不误报');
chk(!audit(Object.assign({}, S, {
  changedFiles: ['DECISIONS.md'], added: {}
})).some(x => /^covered::/.test(x)), '文档改动不误报');

console.log('\n通过=' + pass + ' 失败=' + (fail + problems.length));
process.exit(problems.length || fail ? 1 : 0);
