/**
 * check-class-order.js ——「班级统一排序」门禁（#54，2026-10-04）
 *
 * 需求（2026-10-04）：全站班级列表按「示例班级C → 示例班级B → 示例班级A → 英语 → 商务英语」排列，
 * 唯一来源 = `miniprogram/utils/util.js` 的 `sortClasses()`。
 *
 * 为什么必须单独守：这个 bug **不报错、不打架**，只是「排序悄悄变成空操作」——
 *   `leaveSummary` 辅导员分支返回的班级对象字段是 **`className`**，而 `class.list` 返回的是 `name`。
 *   比较器只读 `name` 时，拿到 `className` 形状的数据会全部读成空串 → 全部同序 → 返回原顺序。
 *   线上实证：辅导员「各班请假人数」示例班级A 一直在第一位、上传修好后仍不变 —— 就是这么来的。
 *
 * 判据（行为级，直接跑真模块）：
 *   ① className 形状（leaveSummary）→ 输出必须等于期望序；
 *   ② name 形状（class.list）→ 输出必须等于期望序；
 *   ③ 纯函数：不改动入参数组的顺序（内部 slice）；
 *   ④ 关键词「长词在前」：'商务英语…' 不被 '英语' 误捕（rank 2 vs 1）。
 * 变异自证：把源码里 `c.name || c.className` 改成只认 `name`、以及删掉 '商务英语' 优先项，
 *   必须让 ①/④ 断言翻转（证明判据非假通过）。变异只在内存里 `new Function` 加载，不落盘。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UTIL = path.join(ROOT, 'miniprogram', 'utils', 'util.js');
const src = fs.readFileSync(UTIL, 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const assertTrue = (cond, msg) => { if (cond) ok(msg); else bad(msg); };

/** 在内存里加载一份 util 源码（util.js 顶层无 require；wx 只在函数体内用到，此处不触发） */
function loadUtil(code) {
  const module = { exports: {} };
  new Function('module', 'exports', code)(module, module.exports);
  return module.exports;
}

const DESIRED = ['示例班级C', '示例班级B', '示例班级A', '示例专业B2班', '商务示例专业B2班'];

/** leaveSummary 辅导员分支的真实形状：{ classId, className, leave } */
function classNameShaped() {
  return [
    { classId: 9, className: '商务示例专业B2班', leave: 0 },
    { classId: 1, className: '示例班级A', leave: 0 },
    { classId: 3, className: '示例班级B', leave: 2 },
    { classId: 2, className: '示例班级C', leave: 0 },
    { classId: 10, className: '示例专业B2班', leave: 1 }
  ];
}
/** class.list 的真实形状：{ id, name, ... } */
function nameShaped() {
  return classNameShaped().map(c => ({ id: c.classId, name: c.className }));
}

const util = loadUtil(src);

/* ---- ① className 形状（线上辅导员卡就是这个） ---- */
const got1 = util.sortClasses(classNameShaped()).map(c => c.className);
assertTrue(
  JSON.stringify(got1) === JSON.stringify(DESIRED),
  'sortClasses 认 className 字段（leaveSummary 形状）→ 示例班级C/示例班级B/示例班级A/英语/商务英语（实得：' + got1.join(' | ') + '）'
);

/* ---- ② name 形状（class.list / classes 页 / duty chips / 导入选班） ---- */
const got2 = util.sortClasses(nameShaped()).map(c => c.name);
assertTrue(
  JSON.stringify(got2) === JSON.stringify(DESIRED),
  'sortClasses 认 name 字段（class.list 形状）→ 同一期望序（实得：' + got2.join(' | ') + '）'
);

/* ---- ③ 纯函数：不改动入参 ---- */
const input = classNameShaped();
const before = input.map(c => c.className).join('|');
util.sortClasses(input);
assertTrue(
  input.map(c => c.className).join('|') === before,
  'sortClasses 是纯函数（内部 slice，不改动入参数组顺序）'
);

/* ---- ④ 长词在前：商务英语 ≠ 英语 ---- */
assertTrue(
  util.majorRank('商务示例专业B2班') === 2 && util.majorRank('示例专业B2班') === 1,
  "majorRank：'商务英语…'=2 不被 '英语' 误捕（长词在前），'英语…'=1"
);
assertTrue(
  util.majorRank('示例班级C') === 0 && util.majorRank('示例专业B1班') === 0,
  'majorRank：小教 / 小学教育 同组 =0'
);

/* ============================ 变异自证 ============================ */
/** 对源码变异后重新加载模块，断言必须翻转成失败 */
function proveBehavioral(label, mutateCode, predicate) {
  const base = predicate(util);
  let after = null, err = null;
  try { after = predicate(loadUtil(mutateCode(src))); } catch (e) { err = e; }
  if (base && after === false) ok('自证：' + label + ' 坏样本会被抓（判据非假通过）');
  else bad('自证：' + label + ' 变异后未翻转（before=' + base + ' after=' + after + (err ? ' err=' + err.message : '') + '）');
}

// ① 把「两个字段都认」改回「只认 name」 → className 形状断言必须翻红
proveBehavioral(
  '比较器只认 name（漏 className）',
  (s) => s.replace('c && (c.name || c.className)', 'c && (c.name)'),
  (u) => JSON.stringify(u.sortClasses(classNameShaped()).map(c => c.className)) === JSON.stringify(DESIRED)
);

// ④ 删掉 '商务英语' 优先项 → 会被 '英语' 归组，rank 断言必须翻红
proveBehavioral(
  "删掉 '商务英语' 优先项（长词在前被破坏）",
  (s) => s.replace("  ['商务英语', 2],\n", ''),
  (u) => u.majorRank('商务示例专业B2班') === 2 && u.majorRank('示例专业B2班') === 1
);

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
} else {
  console.log('✅ 班级统一排序门禁全部通过');
}
