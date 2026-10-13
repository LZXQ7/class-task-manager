/**
 * 门禁：名单解析（列序自适应）+ 多班级自动分类
 * ------------------------------------------------------------
 * 从 cloudfunctions/member/index.js 正则抽「解析 + 分类」函数体 eval（不写副本，与生产同源）。
 * 校验：
 *   ① 列序自适应：姓名,学号 / 学号,姓名 / 班级,学号,姓名,性别,指导员 都能解析
 *   ② 表头行自动跳过
 *   ③ 真实 199 行名单（.workbuddy/_tmp_roster.csv）解析出 5 组、人数正确
 *   ④ 自动分类：小学教育 2601/示例班级B/示例班级A → class 1/2/3；同班号不同专业标 weak
 * 退出码 0 = 通过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let bad = 0;
const ok = (cond, msg) => { if (cond) console.log('PASS  ' + msg); else { console.log('FAIL  ' + msg); bad++; } };

const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/member/index.js'), 'utf8');

/** 抽取一段可 eval 的源码片段：从 startMark 到 endFn 函数体结束 */
function slice(src, startMark, endFn) {
  const s = src.indexOf(startMark);
  if (s < 0) throw new Error('找不到起始标记: ' + startMark);
  const fi = src.indexOf('function ' + endFn + '(', s);
  if (fi < 0) throw new Error('找不到函数: ' + endFn);
  let i = src.indexOf('{', fi);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(s, i);
}

const code = slice(src, 'const GENDER = [', 'groupOf')
  // loadPrefixMap 依赖 pool，抽出后置空实现（本门禁只测纯函数）
  .replace(/async function loadPrefixMap[\s\S]*?\n\}\n/, 'async function loadPrefixMap(){return {byPrefix:new Map(),byClass:new Map()};}\n');

// 第二批：建班名推导 + 分组（buildGroups 依赖 resolveLabel，与上一段一起 eval）
const code2 = slice(src, 'function deriveClassName', 'buildGroups')
  .replace(/async function allocClassKeys[\s\S]*?\n\}\n/, 'async function allocClassKeys(){return {token:"000000",code:"CLS26A99"};}\n')
  .replace(/async function ensureClass[\s\S]*?\n\}\n/, 'async function ensureClass(){return 0;}\n');

// 第三批：已有班级比对（annotateExisting 依赖 groupOf）
const code3 = slice(src, 'function annotateExisting', 'annotateExisting');

const ctx = {};
// eslint-disable-next-line no-new-func
new Function('exports', code + '\n' + code2 + '\n' + code3 +
  '\nexports.parseRoster=parseRoster;exports.parseLine=parseLine;exports.resolveLabel=resolveLabel;' +
  'exports.classNumberOf=classNumberOf;exports.groupOf=groupOf;exports.deriveClassName=deriveClassName;' +
  'exports.buildGroups=buildGroups;exports.annotateExisting=annotateExisting;'
)(ctx);
const { parseRoster, parseLine, resolveLabel, classNumberOf, groupOf, deriveClassName, buildGroups, annotateExisting } = ctx;

/* ---------- ① 列序自适应 ---------- */
console.log('--- ① 列序自适应 ---');
const r1 = parseRoster('张伟,20230101\n李娜,20230102');
ok(r1.rows.length === 2 && r1.rows[0].name === '张伟' && r1.rows[0].studentNo === '20230101',
  '「姓名,学号」可解析');

const r2 = parseRoster('20230101,张伟');
ok(r2.rows.length === 1 && r2.rows[0].name === '张伟' && r2.rows[0].studentNo === '20230101',
  '「学号,姓名」可解析');

const r3 = parseRoster('示例专业B1班,209901030302,示例成员59,女性,示例成员57');
ok(r3.rows.length === 1 && r3.rows[0].name === '示例成员59' && r3.rows[0].studentNo === '209901030302'
  && r3.rows[0].label === '示例专业B1班',
  '「班级,学号,姓名,性别,指导员」可解析（性别/指导员不误判为姓名）');

const r4 = parseRoster('专业班级,学号,姓名,性别,指导员\n209901030302,示例成员59');
ok(r4.rows.length === 1, '表头行自动跳过（且不记为失败）');
ok(r4.failed.length === 0, '跳过表头不会产生失败行');

const r5 = parseRoster('张三三');
ok(r5.rows.length === 0 && r5.failed.length === 1, '只有姓名没有学号的行进 failed');

/* ---------- ③ 整表（带班级列）解析 ---------- */
console.log('\n--- ③ 整表解析（含表头 + 5 个班级标签） ---');
const SAMPLE = [
  '专业班级,学号,姓名,性别,指导员',
  '商务示例专业B2班,209903020101,示例成员60,女性,示例成员57',
  '商务示例专业B2班,260803020102,示例成员62,女性,示例成员57',
  '示例专业B2班,209903030101,示例成员61,女性,示例成员57',
  '示例专业B1班,209901030302,示例成员59,女性,示例成员57',
  '示例专业B1班,209901030303,示例成员63,女性,示例成员57',
  '示例专业A2班,209901030202,示例成员64,女性,示例成员57',
  '示例专业A1班,209901030102,示例成员65,女性,示例成员57'
].join('\n');
{
  const parsed = parseRoster(SAMPLE);
  const bucket = new Map();
  parsed.rows.forEach(r => {
    const k = r.label || '(无班级)';
    bucket.set(k, (bucket.get(k) || 0) + 1);
  });
  ok(parsed.rows.length === 7, '解析出 7 行（实际 ' + parsed.rows.length + '）');
  ok(parsed.failed.length === 0, '无失败行（实际 ' + parsed.failed.length + '）');
  ok(bucket.size === 5, '分成 5 个班级标签（实际 ' + bucket.size + '）');
  ok(bucket.get('示例专业B1班') === 2 && bucket.get('商务示例专业B2班') === 2,
    '同班号不同专业被分成两组（各 2 人）');
  ok(parsed.rows[0].name === '示例成员60' && parsed.rows[0].studentNo === '209903020101',
    '首行姓名/学号正确（性别、指导员未被误判）');
}

/* 可选：若存在真实名单导出（.workbuddy/_tmp_roster.csv），额外校验 199 行 */
const csvPath = path.join(ROOT, '.workbuddy/_tmp_roster.csv');
if (fs.existsSync(csvPath)) {
  const parsed = parseRoster(fs.readFileSync(csvPath, 'utf8'));
  ok(parsed.rows.length === 199 && parsed.failed.length === 0,
    '真实名单 199 行全部解析成功（实际 ' + parsed.rows.length + ' / 失败 ' + parsed.failed.length + '）');
} else {
  console.log('SKIP  未提供真实名单导出，跳过 199 行校验');
}

/* ---------- ④ 自动分类 ---------- */
console.log('\n--- ④ 自动分类 ---');
const classes = [{ id: 3, name: '示例班级A' }, { id: 1, name: '示例班级C' }, { id: 2, name: '示例班级B' }];
// 存量前缀（与线上一致：2601→1、示例班级B→2、示例班级A→3）
// ⚠️ 2026-06-06 随 class_id 重排迁移更新：示例班级A由 id=1 变为 id=3（学号段↔id 对齐）。
const prefixMaps = {
  byPrefix: new Map([['2099010303', 1], ['2099010302', 2], ['2099010301', 3]]),
  byClass: new Map([[1, new Set(['2099010303'])], [2, new Set(['2099010302'])], [3, new Set(['2099010301'])]])
};
const m2601 = resolveLabel('示例专业B1班', classes, prefixMaps, ['209901030302']);
ok(m2601.classId === 1 && m2601.match === 'prefix' && !m2601.weak, '示例专业B1班 → 示例班级C(id=1) 前缀命中');
const m示例班级B = resolveLabel('示例专业A2班', classes, prefixMaps, ['209901030202']);
ok(m示例班级B.classId === 2 && !m示例班级B.weak, '小学教育示例班级B → 示例班级B(id=2) 前缀命中');
const m示例班级A = resolveLabel('示例专业A1班', classes, prefixMaps, ['209901030102']);
ok(m示例班级A.classId === 3 && !m示例班级A.weak, '小学教育示例班级A → 示例班级A(id=3) 前缀命中');
// 同班号不同专业：只能按班号命中，且与该班已有前缀不符 → weak
const mBiz = resolveLabel('商务示例专业B2班', classes, prefixMaps, ['209903020101']);
ok(mBiz.classId === 1 && mBiz.match === 'number' && mBiz.weak === true,
  '示例专业B3班 → 仅按班号命中并标 weak（需人工确认，防串班）');
// 无班号、无前缀 → 不猜
const mNone = resolveLabel('说不清的一群同学', classes, prefixMaps, ['999999999999']);
ok(mNone.classId === 0 && mNone.match === 'none', '无法判定 → match=none（不硬猜）');

/* ---------- 分组奇偶 ---------- */
console.log('\n--- ⑤ 尾号奇偶分组 ---');
ok(groupOf('209901030301') === 'A' && groupOf('209901030302') === 'B', '尾号奇数→A、偶数→B');

/* ---------- ⑦ 「只有序号没有学号」的名册 ---------- */
console.log('\n--- ⑦ 序号名册（学号待补全） ---');
{
  const a = parseRoster('序号 | 姓名\n1 | 示例成员01\n2 | 示例成员02');
  ok(a.rows.length === 2 && a.rows[0].name === '示例成员01' && a.rows[0].seq === 1 && !a.rows[0].studentNo,
    '「序号|姓名」名册可读出（学号留空待补全）');
  const b = parseRoster('序号,姓名,学号\n1,示例成员01,209901030101');
  ok(b.rows.length === 1 && b.rows[0].studentNo === '209901030101' && b.rows[0].seq === 1,
    '三列名册同时取到学号与序号');
  const c = parseRoster('1.0 | 示例成员01');
  ok(c.rows.length === 1 && c.rows[0].seq === 1, 'Excel 数字序号 1.0 归一为 1');
  const d = parseRoster('示例成员01');
  ok(d.rows.length === 0 && d.failed.length === 1, '既无学号也无序号 → 记失败');
}

/* ---------- ⑧ 真实点名册（可选） ---------- */
console.log('\n--- ⑧ 真实点名册（可选） ---');
{
  const { parseXlsx, sheetToText } = require('../cloudfunctions/member/xlsx-lite');
  const DESK = 'C:/Users/PC/Desktop';
  const cases = [
    { file: '示例班级A点名册.xlsx', rows: 56, hasNo: false, desc: '序号+姓名（无学号）' },
    { file: '示例班级A点名册.xlsx', rows: 56, hasNo: true, desc: '序号+姓名+学号' }
  ];
  let any = false;
  cases.forEach((cs) => {
    const p = path.join(DESK, cs.file);
    if (!fs.existsSync(p)) return;
    any = true;
    const sheets = parseXlsx(fs.readFileSync(p));
    const parsed = parseRoster(sheetToText(sheets[0]));
    ok(parsed.rows.length === cs.rows, cs.file + '（' + cs.desc + '）解析 ' + cs.rows + ' 行（实际 ' + parsed.rows.length + '）');
    ok(cs.hasNo === parsed.rows.every(r => !!r.studentNo), cs.file + ' 学号有无判定正确');
    if (cs.hasNo) ok(parsed.rows[0].studentNo === '209901030101', cs.file + ' 首行学号 = 209901030101');
    else ok(parsed.rows.every(r => r.seq >= 1), cs.file + ' 每行都有序号可补');
  });
  if (!any) console.log('SKIP  桌面未找到点名册样本');

  // 交叉验证：用「序号+姓名」那份按前缀补出的学号，必须与「序号+姓名+学号」那份逐行一致
  const pNo = path.join(DESK, '示例班级A点名册.xlsx');
  const pYes = path.join(DESK, '示例班级A点名册.xlsx');
  if (fs.existsSync(pNo) && fs.existsSync(pYes)) {
    const withNo = parseRoster(sheetToText(parseXlsx(fs.readFileSync(pYes))[0])).rows;
    const noNo = parseRoster(sheetToText(parseXlsx(fs.readFileSync(pNo))[0])).rows;
    const prefix = String(withNo[0].studentNo).slice(0, -2);
    const byName = new Map(withNo.map(r => [r.name, r.studentNo]));
    const mismatch = noNo.filter((r) => {
      const derived = prefix + String(r.seq).padStart(2, '0');
      const real = byName.get(r.name);
      return real && real !== derived;
    });
    ok(noNo.length === withNo.length, '两份点名册行数一致（' + noNo.length + '）');
    ok(mismatch.length === 0,
      '按「前缀' + prefix + ' + 序号」补出的学号与真实学号逐行一致（不一致 ' + mismatch.length + ' 条）');
  }
}
/* ---------- ⑨ 已有班级比对（无问题就跳过） ---------- */
console.log('\n--- ⑨ 已有班级比对 ---');
{
  const rows9 = parseRoster([
    '示例专业B1班,209901030301,示例成员60,女性',      // 库里一致 → same
    '示例专业B1班,209901030302,改过名字,女性',  // 库里同名不同 → diff
    '示例专业B1班,209901030303,示例成员63,女性',      // 库里没有 → fresh
    '示例专业B1班,209901030399,张外部,女性'   // 学号已在别的班 → other
  ].join('\n')).rows;
  const g9 = buildGroups(rows9, {
    classes: [{ id: 1, name: '示例班级C' }], prefixMaps, seqPrefixMap: new Map(),
    fallbackClass: 0, mapping: null, createLabels: null
  });
  const existing9 = new Map([
    ['209901030301', { id: 1, name: '示例成员60', group_tag: 'A', class_id: 1 }],
    ['209901030302', { id: 2, name: '示例成员59', group_tag: 'A', class_id: 1 }],
    ['209901030399', { id: 9, name: '张外部', group_tag: 'A', class_id: 2 }]
  ]);
  annotateExisting(g9, existing9);
  const st = g9[0].stat;
  ok(st.same === 1 && st.diff === 1 && st.fresh === 1 && st.other === 1,
    '比对结果 一致1 / 有差异1 / 新增1 / 归它班1（实际 ' + JSON.stringify(st) + '）');
  ok(g9[0].diffs.length === 1 && g9[0].diffs[0].name === '改过名字',
    '差异清单能指出具体是哪个人');

  // 全部一致 → 前端据此默认不勾选（「无问题就跳过」）
  const rows10 = parseRoster('示例班级C,209901030301,示例成员60,女性').rows;
  const g10 = buildGroups(rows10, {
    classes: [{ id: 1, name: '示例班级C' }], prefixMaps, seqPrefixMap: new Map(),
    fallbackClass: 0, mapping: null, createLabels: null
  });
  annotateExisting(g10, existing9);
  ok(g10[0].stat.fresh === 0 && g10[0].stat.diff === 0 && g10[0].stat.same === 1,
    '整组已一致 → fresh/diff 都为 0（可安全跳过）');
}

/* ---------- ⑥ 自动建班 + 分组 ---------- */
console.log('\n--- ⑥ 自动建班 + 分组 ---');
ok(deriveClassName('示例专业B1班') === '示例专业B1班', '带「班」的标签原样作班名');
ok(deriveClassName('英语2601') === '英语示例班级C', '不带「班」自动补「班」');
{
  const rows = parseRoster(SAMPLE).rows;
  const g1 = buildGroups(rows, {
    classes: [{ id: 1, name: '示例班级C' }], prefixMaps,
    mapping: null, createLabels: ['示例专业B2班'], fallbackClass: 0
  });
  const en = g1.find(g => g.label === '示例专业B2班');
  ok(!!en && en.willCreate === true && en.classId === 0 && en.suggestName === '示例专业B2班',
    '勾选「自动新建」的标签标 willCreate 并给出建议班名');
  const edu = g1.find(g => g.label === '示例专业B1班');
  ok(!!edu && edu.classId === 1 && edu.willCreate === false, '已存在的班级不受建班逻辑影响');
  const g2 = buildGroups(rows, {
    classes: [{ id: 1, name: '示例班级C' }], prefixMaps, mapping: null, createLabels: null, fallbackClass: 0
  });
  const biz = g2.find(g => g.label === '商务示例专业B2班');
  ok(!!biz && biz.classId === 1 && biz.weak === true, '未勾选自动建班时，同班号不同专业仍标 weak（不静默导入）');
  const rows2 = parseRoster('神秘（专升本）2999班,260899990101,某甲,女性').rows;
  const g3 = buildGroups(rows2, {
    classes: [{ id: 1, name: '示例班级C' }], prefixMaps, mapping: null, createLabels: null, fallbackClass: 0
  });
  ok(g3[0].classId === 0 && g3[0].match === 'none' && g3[0].suggestName === '神秘（专升本）2999班',
    '班号匹配不到任何班级时保持未定，并给出建议班名');
}

console.log('\n' + (bad === 0 ? '✅ 名单解析门禁全部通过' : '❌ ' + bad + ' 项不通过'));
process.exitCode = bad === 0 ? 0 : 1;
