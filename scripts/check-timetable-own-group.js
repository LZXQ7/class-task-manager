#!/usr/bin/env node
/**
 * 门禁：课表「所有账号默认只看自己所在的组」（2026-11-15 用户口径）
 * ================================================================
 * 用户口径（经弹窗确认）：
 *   ① 只统一**默认视图** —— 左下角弧形菜单「全部 / A 组 / B 组」手动切换保留；
 *   ② 没有 A/B 分组的账号（辅导员、超管、未分组班委）默认**只看全体课**，
 *      与首页「今日/明日课次」的 _filterSessions 口径一致。
 *
 * 事故背景：旧 `applyAuth` 写 `patch.viewGroup = ownGroup || 'ALL'`，
 * 无 A/B 组的账号（含副班长）默认拿到 'ALL'；`_filterByGroup` 又把
 * `if (!g || g === 'ALL') return courses` 的「无组」和「全部」混为一谈
 * ⇒ 打开课表即显示 A 组 + B 组全部课次（用户实锤）。
 *
 * 本门禁**真抽取源码里的两个方法体**用 vm 构造对象后跑行为断言（不是抄副本），
 * 末尾变异自证在内存字符串里替换、绝不写盘；每组要求对应探针翻红，
 * 且先断言「锚点命中 + 替换生效」，防止拿好样本当坏样本的假绿。
 *
 * 用法：node scripts/check-timetable-own-group.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const TT_JS = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.js');
const TT_WXML = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.wxml');
const HOME_JS = path.join(ROOT, 'miniprogram', 'pages', 'home', 'index.js');
const read = p => fs.readFileSync(p, 'utf8');

const SRC = read(TT_JS);
const WXML = read(TT_WXML);
const HOME = read(HOME_JS);

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/** 抽出 `name(arg) { ... }\n  },` 的真实方法体；方法内不得有顶层 `  }` 块（这两个方法都没有） */
function bodyOf(src, name, arg) {
  const re = new RegExp('\\b' + name + '\\(' + arg + '\\)\\s*\\{([\\s\\S]*?)\\n  \\}');
  const m = re.exec(src);
  return m ? m[1] : null;
}

/** 用真实方法体构造一个最小页面对象；两个方法只依赖 this.data 与 Array.filter，不需要 wx 桩 */
function buildMethods(src) {
  const fFilter = bodyOf(src, '_filterByGroup', 'courses');
  const fDefault = bodyOf(src, '_defaultViewGroup', 'p');
  if (!fFilter || !fDefault) return null;
  const code = 'const o = { data: { viewGroup: "" },\n'
    + ' _filterByGroup: function(courses){' + fFilter + '\n},\n'
    + ' _defaultViewGroup: function(p){' + fDefault + '\n} };\n o;';
  try { return vm.runInNewContext(code, { console }); } catch (e) { return null; }
}

const COURSES = [
  { name: '全体1', groupScope: null },
  { name: 'A课', groupScope: 'A' },
  { name: 'B课', groupScope: 'B' },
  { name: '全体2', groupScope: '' }
];

function probes(src, wxml) {
  const o = buildMethods(src);
  if (!o) return null;
  const names = g => { o.data.viewGroup = g; return o._filterByGroup(COURSES).map(c => c.name).join(','); };
  return {
    // 默认视图：A/B 各归其位；无 A/B 组一律 ''，绝不 'ALL'
    defaultA: o._defaultViewGroup({ groupTag: 'A' }) === 'A',
    defaultB: o._defaultViewGroup({ groupTag: 'B' }) === 'B',
    defaultX: o._defaultViewGroup({ groupTag: 'X' }) === '',
    defaultEmpty: o._defaultViewGroup({}) === '',
    defaultNoAll: ['A', 'B', 'X', '', undefined, null].every(t => o._defaultViewGroup({ groupTag: t }) !== 'ALL'),
    // 过滤：A/B 只看本组 + 全体；无组只看全体；手动 ALL 仍全显
    filterA: names('A') === '全体1,A课,全体2',
    filterB: names('B') === '全体1,B课,全体2',
    filterNone: names('') === '全体1,全体2',
    filterAll: names('ALL') === '全体1,A课,B课,全体2',
    // 接线：applyAuth 必须调 _defaultViewGroup，且不得再有 `|| 'ALL'` 兜底
    wired: /const ownGroup = this\._defaultViewGroup\(p\)\s*;/.test(src) &&
      /patch\.viewGroup = ownGroup\s*;/.test(src),
    noAllFallback: !/patch\.viewGroup = ownGroup \|\| 'ALL'/.test(src) &&
      /if \(!this\._groupPicked\)/.test(src),
    // 手动切换能力保留（用户口径：只统一默认视图，四按钮不动）
    manualKept: /_groupPicked/.test(src) && /onMenuGroup\s*\(/.test(src) &&
      /key: 'ALL', label: '全部'/.test(src),
    // 无组视图的入口标签要写清楚，不能再误显示成「A 组」
    labelNone: /viewGroup === 'A' \? 'A 组' : '全体课'/.test(wxml),
    // 首页「今日课次」口径仍是「空组 ⇒ 只保留全体课」，防止两端口径漂移
    homeAligned: /: list\.filter\(s => !s\.groupScope\);/.test(HOME)
  };
}

/* ============================================================
 * ① 逐条断言
 * ============================================================ */
console.log('── ① 默认视图（所有账号一律按自己组，无组只看全体课）');
const base = probes(SRC, WXML);
if (!base) { console.log('✗ 没能从源码抽出 _defaultViewGroup / _filterByGroup 真方法体'); process.exit(1); }
check(base.defaultA, 'A 组账号默认视图 = A');
check(base.defaultB, 'B 组账号（含副班长）默认视图 = B');
check(base.defaultX, "辅导员（groupTag='X'）默认视图 = ''（只看全体课）");
check(base.defaultEmpty, '未分组 / 超管账号默认视图 = \'\'（只看全体课）');
check(base.defaultNoAll, "任何账号的默认视图都**不是** 'ALL'（A+B 全显示）");

console.log('── ② 分组过滤（手动切换能力保留）');
check(base.filterA, 'A 视图 = 全体课 + A 组课，不含 B 组');
check(base.filterB, 'B 视图 = 全体课 + B 组课，不含 A 组');
check(base.filterNone, "无组视图（''）= 只有全体课，不显示任何分组课");
check(base.filterAll, "手动选「全部」('ALL') 仍显示 A+B+全体课");

console.log('── ③ 静态契约');
check(base.wired, 'applyAuth 调用 _defaultViewGroup 且直接下发 ownGroup');
check(base.noAllFallback, "applyAuth 无 `|| 'ALL'` 兜底，且 _groupPicked 守卫还在");
check(base.manualKept, '弧形菜单「全部 / A / B」手动切换保留（四按钮不变）');
check(base.labelNone, '无组账号左下角标签显示「全体课」，不误显示「A 组」');
check(base.homeAligned, '首页今日课次仍与「空组 ⇒ 只保留全体课」同口径');

/* ============================================================
 * ② 变异自证（好样本必须能被改成坏样本并翻红）
 * ============================================================ */
console.log('── ④ 变异自证');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
const mutants = [
  {
    name: '无组账号默认又回落成 ALL（打开课表又看到 A+B）',
    expect: 'defaultNoAll', scope: 'js',
    build: () => {
      const m = mutate(SRC, "return (tag === 'A' || tag === 'B') ? tag : '';",
        "return (tag === 'A' || tag === 'B') ? tag : 'ALL';");
      return m === null ? null : { js: m };
    }
  },
  {
    name: "过滤退回旧写法 `if (!g || g === 'ALL') return courses`（无组又看两组）",
    expect: 'filterNone', scope: 'js',
    build: () => {
      const old = "    if (g === 'ALL') return courses;\n"
        + "    if (g === 'A' || g === 'B') return courses.filter(c => !c.groupScope || c.groupScope === g);\n"
        + "    return courses.filter(c => !c.groupScope);";
      const bad = "    if (!g || g === 'ALL') return courses;\n"
        + "    return courses.filter(c => !c.groupScope || c.groupScope === g);";
      const m = mutate(SRC, old, bad);
      return m === null ? null : { js: m };
    }
  },
  {
    name: "applyAuth 又写回 `ownGroup || 'ALL'`",
    expect: 'wired', scope: 'js',
    build: () => {
      const m = mutate(SRC, 'patch.viewGroup = ownGroup;', "patch.viewGroup = ownGroup || 'ALL';");
      return m === null ? null : { js: m };
    }
  },
  {
    name: 'applyAuth 不再调 _defaultViewGroup（默认值写死）',
    expect: 'wired', scope: 'js',
    build: () => {
      const m = mutate(SRC, 'const ownGroup = this._defaultViewGroup(p);', "const ownGroup = '';");
      return m === null ? null : { js: m };
    }
  },
  {
    name: '弧形菜单把「全部」按钮删掉（手动切换能力丢失）',
    expect: 'manualKept', scope: 'js',
    build: () => {
      const m = mutate(SRC, "{ key: 'ALL', label: '全部' }, ", '');
      return m === null ? null : { js: m };
    }
  },
  {
    name: '左下角标签又退回「A 组」兜底（无组账号显示错组）',
    expect: 'labelNone', scope: 'wxml',
    build: () => {
      const m = mutate(WXML, "(viewGroup === 'A' ? 'A 组' : '全体课')", "'A 组'");
      return m === null ? null : { wxml: m };
    }
  }
];

mutants.forEach(mt => {
  const over = mt.build();
  if (!over) { bad('变异锚点没命中源码：' + mt.name); return; }
  const changed = Object.keys(over).some(k => over[k] !== (k === 'js' ? SRC : WXML));
  if (!changed) { bad('变异替换没生效：' + mt.name); return; }
  const r = probes(over.js || SRC, over.wxml || WXML);
  if (!r) { bad('变异后方法体抽取失败：' + mt.name); return; }
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0
  ? '\nOK · 课表默认分组（全员只看本组 / 无组只看全体课 / 手动切换保留）门禁全部通过'
  : '\nFAIL · 课表默认分组门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
