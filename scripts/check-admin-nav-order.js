#!/usr/bin/env node
/**
 * 后台导航顺序门禁（2026-11-16 用户要求）
 *
 * 用户原话：「文字越少越靠上，值日记录和换班申请放在课程表下面」。
 * 真实导航顺序有两个来源，必须同口径：
 *   · 前端 `public/app.js` 的 VIEWS 对象**声明顺序**（renderNav→allowedViews→Object.keys）
 *   · 权限真源 `lib/perms.js` 的 VIEWS 数组（注释自称「顺序即前端导航顺序」）
 * 口径 = 标题字数升序，同字数保持原相对顺序；「值日记录(4)/换班申请(4)」落在「课程表(3)」下面。
 *
 * 判据全读真实源码，从声明里解析 key+title，按字数算；末尾变异自证保证判据不是摆设。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('cloudfunctions/admin-web/public/app.js');
const PERMS = read('cloudfunctions/admin-web/lib/perms.js');
const HTML = read('cloudfunctions/admin-web/public/index.html');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

/** 汉字/字符数：按 Unicode 码点计，去掉空白。数字/字母也算 1 字，这里全是中文标题。 */
function titleLen(s) { return Array.from(String(s).replace(/\s/g, '')).length; }

/** 从 app.js 抠出 `var VIEWS = { ... };` 的对象体，按出现顺序解析 key + title。 */
function parseAppViews(src) {
  const m = /var\s+VIEWS\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(src);
  if (!m) return null;
  const body = m[1];
  const re = /(\w+):\s*\{\s*title:\s*'([^']+)'/g;
  const out = [];
  let x;
  while ((x = re.exec(body))) out.push({ key: x[1], title: x[2] });
  return out;
}

/** 从 perms.js 抠出 `const VIEWS = [ ... ];` 数组，按出现顺序解析 key + label。 */
function parsePermViews(src) {
  const m = /const\s+VIEWS\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!m) return null;
  const re = /\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'/g;
  const out = [];
  let x;
  while ((x = re.exec(m[1]))) out.push({ key: x[1], title: x[2] });
  return out;
}

const appViews = parseAppViews(APP);
const permViews = parsePermViews(PERMS);

/* ① 前端 VIEWS 解析 + 字数升序 */
section('① 前端 app.js VIEWS 声明顺序 = 标题字数升序');
check(!!appViews && appViews.length === 17, '解析到前端 VIEWS 共 17 项（实得 ' + (appViews ? appViews.length : 0) + '）');
if (appViews) {
  const titles = appViews.map((v) => v.title);
  const lens = titles.map(titleLen);
  check(lens.every((n, i) => i === 0 || n >= lens[i - 1]),
    '标题字数非递减：' + titles.map((t, i) => t + '(' + lens[i] + ')').join(' → '));
  // 关键相对位置
  const idx = (t) => titles.indexOf(t);
  check(idx('倒数日') < idx('课程表'), '倒数日(3) 在 课程表(3) 之前');
  check(idx('课程表') < idx('值日记录') && idx('课程表') < idx('换班申请'),
    '值日记录 / 换班申请 落在课程表下面');
  check(idx('值日记录') < idx('换班申请'), '值日记录 在 换班申请 之前（保持原相对顺序）');
  check(idx('班费') < idx('倒数日'), '班费(2) 在 倒数日(3) 之前');
  check(idx('概览') === 0 && idx('成员') === 1 && idx('请假') === 2 && idx('班费') === 3,
    '2 字组顺序：概览/成员/请假/班费');
  check(idx('后台账号') === titles.length - 1, '后台账号 仍在最后');
  // 前端 key 不可改（localStorage 依赖）
  ['overview', 'member', 'leave', 'fee', 'notice', 'homework', 'countdown', 'timetable', 'duty', 'swap',
   'class', 'config', 'rules', 'usage', 'speech', 'audit', 'accounts'].forEach((k) =>
    check(appViews.some((v) => v.key === k), '前端 key 保留 ' + k));
}

/* ② 权限真源 VIEWS 与前端同口径 */
section('② 权限真源 perms.js VIEWS 顺序与前端一致');
check(!!permViews && permViews.length === 16, '解析到 perms VIEWS 共 16 项（实得 ' + (permViews ? permViews.length : 0) + '）');
if (permViews && appViews) {
  const pLens = permViews.map((v) => titleLen(v.title));
  check(pLens.every((n, i) => i === 0 || n >= pLens[i - 1]),
    'perms 标题字数非递减：' + permViews.map((v, i) => v.title + '(' + pLens[i] + ')').join(' → '));
  // 共有项（前端去掉 config）的相对顺序须一致。
  // ⚠️ 按 title 比、不按 key —— member↔members / timetable↔course 是历史命名差异，
  //    按 key 比永远不等（这正是门禁第一版写错、误报红的地方）。
  const appSeq = appViews.map((v) => v.title).filter((t) => t !== '系统配置');
  const permSeq = permViews.map((v) => v.title);
  check(JSON.stringify(appSeq) === JSON.stringify(permSeq),
    '两处共有 16 项按标题顺序完全一致');
  const pTitle = permViews.map((v) => v.title);
  check(pTitle.indexOf('课程表') < pTitle.indexOf('值日记录'), 'perms：值日记录在课程表下面');
}

/* ③ 注释里的顺序口径同步 */
section('③ 注释顺序口径已同步（避免下次改错）');
check(/按字数升序|字数越少越靠上|标题字数越少越靠上/.test(HTML), 'index.html 注释标注新口径');
check(/字数越少越靠上/.test(PERMS) && /字数越少越靠上/.test(APP), 'perms.js 与 app.js 注释标注新口径');
check(!/顺序即前端导航顺序，改顺序只需改这里/.test(PERMS), 'perms.js 旧注释「顺序即前端导航顺序，改顺序只需改这里」已改写（避免误导只改一处）');

/* ④ 变异自证 */
section('④ 变异自证（改坏 → 判据必须翻红）');
if (appViews) {
  // 4.1 把「倒数日」与「值日记录」对调 → 字数升序被破坏
  const t = appViews.map((v) => ({ ...v }));
  const a = t.findIndex((v) => v.title === '倒数日');
  const b = t.findIndex((v) => v.title === '值日记录');
  [t[a], t[b]] = [t[b], t[a]];
  const tLens = t.map((v) => titleLen(v.title));
  check(!tLens.every((n, i) => i === 0 || n >= tLens[i - 1]),
    '变异被抓：倒数日与值日记录对调 → 字数升序判据翻红');
  // 4.2 把值日记录挪到课程表上面 → 相对位置判据翻红
  const t2 = appViews.map((v) => ({ ...v }));
  const i2 = t2.findIndex((v) => v.title === '值日记录');
  const j2 = t2.findIndex((v) => v.title === '课程表');
  const [moved] = t2.splice(i2, 1);
  t2.splice(j2, 0, moved);
  const t2Title = t2.map((v) => v.title);
  check(!(t2Title.indexOf('课程表') < t2Title.indexOf('值日记录')),
    '变异被抓：值日记录挪到课程表上方 → 相对位置判据翻红');
  // 4.3 改掉前端 key → key 保留判据翻红
  const badKey = APP.replace(/timetable:\s*\{\s*title:\s*'课程表'/, "xxxKEY: { title: '课程表'");
  check(!/timetable:\s*\{\s*title:\s*'课程表'/.test(badKey) && !parseAppViews(badKey).some((v) => v.key === 'timetable'),
    '变异被抓：改前端 timetable key → key 保留判据翻红');
  // 4.4 perms 顺序打乱 → 两处一致判据翻红
  if (permViews) {
    const p = permViews.map((v) => ({ ...v }));
    const pi = p.findIndex((v) => v.key === 'duty');
    const pj = p.findIndex((v) => v.key === 'countdown');
    [p[pi], p[pj]] = [p[pj], p[pi]];
    check(JSON.stringify(p.map((v) => v.title)) !== JSON.stringify(appViews.map((v) => v.title).filter((t) => t !== '系统配置')),
      '变异被抓：perms 顺序打乱 → 两处一致判据翻红');
  }
}

console.log('\n结果：' + (fail ? '失败 ' + fail + ' / 通过 ' + pass : '全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);
