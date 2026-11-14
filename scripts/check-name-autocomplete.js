#!/usr/bin/env node
/**
 * 门禁：姓名自动补全组件（2026-11-14 用户要求）
 * ================================================================
 * 「人名等选项多的字段用自动补全，输入时实时列出匹配项，并高亮匹配的文字。」
 * 为什么不能只做静态正则：
 *   · 高亮片段算错（index 差一位）⇒ 高亮落在错的字上；
 *   · 过滤用 `startsWith` 而不是 `includes` ⇒ 搜"张"搜不到"小张三"；
 *   · 不实时过滤（要等失焦）⇒ 用户看不到匹配项；
 *   · 命中判定只看姓名 ⇒ 按学号搜不到人。
 * 所以这里用 vm 真加载组件 index.js，造一个假实例逐个调方法做行为断言。
 *
 * 末尾的变异自证全部在内存字符串里替换、绝不写盘；每组要求对应探针翻红，
 * 且先断言「锚点命中 + 替换生效」，防止拿好样本当坏样本的自欺式假绿。
 *
 * 用法：node scripts/check-name-autocomplete.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'miniprogram', 'components', 'name-autocomplete');
const MANUAL_WXML = path.join(ROOT, 'miniprogram', 'pages', 'manual', 'index.wxml');
const MANUAL_JSON = path.join(ROOT, 'miniprogram', 'pages', 'manual', 'index.json');
const read = p => fs.readFileSync(p, 'utf8');

const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const WXML = stripHtml(read(path.join(DIR, 'index.wxml')));
const WXSS = stripJs(read(path.join(DIR, 'index.wxss')));
const JS = stripJs(read(path.join(DIR, 'index.js')));
const JSON_SRC = read(path.join(DIR, 'index.json'));
const MANUAL_WXML_RAW = read(MANUAL_WXML);
const MANUAL_JSON_RAW = read(MANUAL_JSON);

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

function loadComponent(src) {
  const desc = {};
  const sandbox = {
    module: { exports: {} },
    require: () => ({}),
    Component: (d) => { Object.assign(desc, d); },
    wx: {},
    console, Math, Object, Array, Number, String, JSON, setTimeout, clearTimeout
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'name-autocomplete/index.js' });
  return desc;
}

function makeInst(desc, passed) {
  /* ⚠️ 必须把 property **描述符解包成默认值**：小程序里 properties.x 是值，
     描述符对象是恒真的对象 —— 不解包的话 `if (this.properties.showAll)` 永远为真，
     门禁会拿一个"永远走错分支"的假实例去判（踩过一次）。 */
  const props = {};
  Object.keys(desc.properties || {}).forEach(k => {
    const d = desc.properties[k];
    props[k] = (d && typeof d === 'object' && 'value' in d) ? d.value : d;
  });
  const inst = {
    data: JSON.parse(JSON.stringify(desc.data || {})),
    properties: Object.assign(props, passed || {}),
    events: [],
    setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb(); },
    triggerEvent(name, detail) { this.events.push({ name, detail: detail || {} }); }
  };
  Object.keys(desc.methods || {}).forEach(k => { inst[k] = desc.methods[k].bind(inst); });
  return inst;
}

const CANDS = [
  { id: 1, name: '张小明', sub: '3 号 · A 组' },
  { id: 2, name: '李四', sub: '12 号 · B 组' },
  { id: 3, name: '王小红', sub: '28 号 · A 组' },
  { id: 4, name: '赵六', sub: '56 号 · B 组' }
];

function behaviorProbes() {
  const desc = loadComponent(JS);
  const out = {};

  const inst = makeInst(desc, { items: CANDS, max: 8 });
  // 输入「小」⇒ 实时列出匹配项（不用失焦、不用回车）
  inst.onInput({ detail: { value: '小' } });
  const list = inst.data.list || [];
  out.liveFilter = list.length === 2 && list[0].name === '张小明' && list[1].name === '王小红';
  out.open = inst.data.open === true;

  // 高亮：命中的那段被标出来，位置必须正确
  const p = (list[0].parts || []);
  out.highlight = p.length === 3 && p[1].hl === true && p[1].t === '小' &&
    p[0].t === '张' && p[2].t === '明';

  // 按学号搜（命中 sub 而不是 name）⇒ 高亮落在 sub 上
  const inst2 = makeInst(desc, { items: CANDS, max: 8 });
  inst2.onInput({ detail: { value: '12' } });
  const l2 = inst2.data.list || [];
  out.matchSub = l2.length === 1 && l2[0].name === '李四';
  out.highlightSub = (l2[0].subParts || []).some(x => x.hl && x.t === '12');

  // 关键词为空（且未开 showAll）⇒ 不列任何项
  const inst3 = makeInst(desc, { items: CANDS, max: 8 });
  inst3.onInput({ detail: { value: '' } });
  out.emptyNoList = (inst3.data.list || []).length === 0;

  // showAll 时空关键词列出全部
  const inst4 = makeInst(desc, { items: CANDS, max: 8, showAll: true });
  inst4.onInput({ detail: { value: '' } });
  out.showAll = (inst4.data.list || []).length === CANDS.length;

  // max 限制
  const inst5 = makeInst(desc, { items: CANDS, max: 2 });
  inst5.onInput({ detail: { value: '组' } });
  out.maxLimit = (inst5.data.list || []).length === 2;

  // 选中：抛 pick 事件带 id
  const inst6 = makeInst(desc, { items: CANDS, max: 8 });
  inst6.onInput({ detail: { value: '王' } });
  inst6.onPick({ currentTarget: { dataset: { id: 3 } } });
  const pick = inst6.events.filter(e => e.name === 'pick');
  out.pick = pick.length === 1 && pick[0].detail.id === 3;

  // 输入事件也要抛给页面（页面要同步关键词）
  out.inputEvent = inst6.events.filter(e => e.name === 'input').length === 1;

  return out;
}

function staticProbes() {
  return {
    highlightStyle: /\.ac-hl\s*\{[^}]*background/.test(WXSS) && /\.ac-hl\s*\{[^}]*color/.test(WXSS),
    listShown: /wx:if="\{\{open\}\}"/.test(WXML),
    partsLoop: /item\.parts/.test(WXML) && /item\.subParts/.test(WXML),
    comp: /"component"\s*:\s*true/.test(JSON_SRC),
    usedInManual: /<name-autocomplete/.test(MANUAL_WXML_RAW) &&
      /"name-autocomplete"\s*:/.test(MANUAL_JSON_RAW)
  };
}

console.log('── ① 组件结构');
const sp = staticProbes();
Object.keys(sp).forEach(k => check(sp[k], '静态契约 ' + k));

console.log('── ② 行为（vm 真加载组件）');
const bp = behaviorProbes();
check(bp.liveFilter, '输入即实时列出匹配项（不用失焦/回车）');
check(bp.open, '输入后下拉自动展开');
check(bp.highlight, '姓名里的命中片段被正确高亮');
check(bp.matchSub, '按学号（sub）也能搜到人');
check(bp.highlightSub, 'sub 里的命中片段被高亮');
check(bp.emptyNoList, '关键词为空且未开 showAll 时不列项');
check(bp.showAll, 'showAll 时空关键词列出全部候选');
check(bp.maxLimit, '最多显示 max 条');
check(bp.pick, '点某项抛出 pick 事件并带 id');
check(bp.inputEvent, '输入变化抛 input 事件给页面');

console.log('── ③ 变异自证');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
const mutants = [
  {
    name: '高亮位置算错（index 少 1）', expect: 'highlight',
    build: () => {
      const m = mutate(JS, '{ t: name.slice(i, i + q.length), hl: true },', '{ t: name.slice(i + 1, i + q.length), hl: true },');
      return m === null ? null : { js: m };
    }
  },
  {
    name: '命中判定只看姓名（按学号搜不到人）', expect: 'matchSub',
    build: () => {
      const m = mutate(JS, 'return name.indexOf(q) >= 0 || sub.indexOf(q) >= 0;', 'return name.indexOf(q) >= 0;');
      return m === null ? null : { js: m };
    }
  },
  {
    name: '不再实时过滤（要等 focus 才列）', expect: 'liveFilter',
    build: () => {
      const m = mutate(JS, 'this._filter(kw);', '');
      return m === null ? null : { js: m };
    }
  },
  {
    name: '高亮样式被去掉（匹配了但不显眼）', expect: 'highlightStyle',
    build: () => {
      const m = mutate(WXSS, '  background: var(--brand-light, #F0F5FF);', '');
      return m === null ? null : { wxss: m };
    }
  },
  {
    name: '页面不再使用组件（功能回退）', expect: 'usedInManual',
    build: () => {
      const m = mutate(MANUAL_WXML_RAW, '<name-autocomplete', '<name-autocomplete-x');
      return m === null ? null : { ttwxml: m };
    }
  }
];

function runWith(over) {
  const js = over.js || JS;
  const wxss = over.wxss || WXSS;
  const ttwxml = over.ttwxml || MANUAL_WXML_RAW;
  const res = {};
  res.highlightStyle = /\.ac-hl\s*\{[^}]*background/.test(wxss) && /\.ac-hl\s*\{[^}]*color/.test(wxss);
  res.usedInManual = /<name-autocomplete[\s>]/.test(ttwxml);
  const desc = loadComponent(js);
  const inst = makeInst(desc, { items: CANDS, max: 8 });
  inst.onInput({ detail: { value: '小' } });
  const list = inst.data.list || [];
  res.liveFilter = list.length === 2;
  const p = list[0] && (list[0].parts || []);
  res.highlight = !!(p && p.length === 3 && p[1] && p[1].hl === true && p[1].t === '小');
  const inst2 = makeInst(desc, { items: CANDS, max: 8 });
  inst2.onInput({ detail: { value: '12' } });
  res.matchSub = (inst2.data.list || []).length === 1;
  return res;
}

mutants.forEach(mt => {
  const over = mt.build();
  if (!over) { bad('变异锚点没命中源码：' + mt.name); return; }
  const changed = Object.keys(over).some(k => over[k] !== (k === 'js' ? JS : k === 'wxss' ? WXSS : MANUAL_WXML_RAW));
  if (!changed) { bad('变异替换没生效：' + mt.name); return; }
  const r = runWith(over);
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0 ? '\nOK · 姓名自动补全（实时匹配 / 高亮命中 / 选中）门禁全部通过'
  : '\nFAIL · 姓名自动补全门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
