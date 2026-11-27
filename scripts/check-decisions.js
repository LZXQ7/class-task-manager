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
const cf = require('./lib/changed-files');

const ROOT = path.resolve(__dirname, '..');
const DECISIONS = path.join(ROOT, 'DECISIONS.md');

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }

/** 改动文件集与新增行均取自共享原语（检测信号源唯一真源）：
 *   ① 工作区已跟踪改动 ∪ 最近一次提交 ∪ 未跟踪文件；
 *   ② 新建 js 的「新增行」= 全文（git diff 对未跟踪返回 0 字节，曾致导航 API 判定假绿）。
 * 本门禁不再自行拼 git 命令——新信号形态只改 scripts/lib/changed-files.js 一处。 */
function changedFiles() { return cf.changedFiles(ROOT); }
function addedLinesOf(file) { return cf.addedLinesOf(file, ROOT); }

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
  // 判定层守卫：未跟踪 js 若退回 git diff（返回空串），导航 API 判定假绿 ⇒ 翻红
  need('untrackedJsFullText', X.untrackedJsFullText === true);
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
// 信号源守卫（两处缺一即翻红）：
//   ① 共享原语里未跟踪那一路仍在位（数组字面量，防被改回去）；
//   ② 本门禁确实从共享原语取信号（防有人改回本地 git diff、绕过原语）。
// 不再只读自身源码——信号实现已下沉，守卫必须跟着下沉，否则就是新的 M2 假绿。
const UNTRACKED_SIGNAL = "['ls-files', '--others', '--exclude-standard']";
const sharedSrc = read(require.resolve('./lib/changed-files'));
S.signalUntracked =
  sharedSrc.indexOf(UNTRACKED_SIGNAL) >= 0 &&
  fs.readFileSync(__filename, 'utf8').indexOf("cf.changedFiles(ROOT)") >= 0;
// 判定层守卫：addedLinesOf 必须先问 isUntracked、再读全文；删任一步则新建 js 的导航 API 判定失效。
S.untrackedJsFullText =
  sharedSrc.indexOf('isUntracked(file, cwd)') >= 0 &&
  sharedSrc.indexOf("fs.readFileSync(path.join(cwd, file), 'utf8')") >= 0;

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
  { name: '新建未跟踪 js 含导航 API 无记录覆盖（判定残留回归）', patch: { changedFiles: ['miniprogram/pages/newfeature/index.js'], added: { 'miniprogram/pages/newfeature/index.js': 'wx.navigateTo({url:...})' } }, judge: b => b.some(x => /covered::miniprogram\/pages\/newfeature\/index\.js/.test(x)) },
  { name: '删掉未跟踪文件信号源（假绿命门）', patch: { signalUntracked: false }, judge: b => b.some(x => /signalUntracked/.test(x)) },
  { name: '删掉未跟踪 js 读全文判定（新增回归）', patch: { untrackedJsFullText: false }, judge: b => b.some(x => /untrackedJsFullText/.test(x)) }
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
