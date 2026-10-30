/**
 * 演示环境隔离补丁（2026-10-28）：为所有云函数下的 common/guard.js 增加
 * 演示身份检测助手（demoClassIds / isDemoMember）并在 resolveClassId 顶部锁定
 * 演示身份只能访问演示班，彻底屏蔽真实班级数据。
 *
 * 用法（shell 恢复后执行）：
 *   node scripts/patch-demo-isolation.js
 *
 * 18 份 guard.js 经核验 resolveClassId 与 module.exports 逐字一致，故同一条变换可统一落地。
 * 每个替换都断言命中次数 === 1，命中不符直接报错退出，避免静默半改。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GUARDS = [];
const cfDir = path.join(ROOT, 'cloudfunctions');
for (const fn of fs.readdirSync(cfDir)) {
  const g = path.join(cfDir, fn, 'common', 'guard.js');
  if (fs.existsSync(g)) GUARDS.push(g);
}
// 也包含根模板 cloudfunctions/common/guard.js（若存在）
const tpl = path.join(cfDir, 'common', 'guard.js');
if (fs.existsSync(tpl) && !GUARDS.includes(tpl)) GUARDS.push(tpl);

const HELPERS = `
/**
 * 演示班级集合（2026-10-28 演示环境隔离）：class.is_demo=1 的班级。
 * 「演示班级」范畴 = 审核体验班级 + 免密体验班级，二者最终都落到同一批演示班。
 */
async function demoClassIds(pool) {
  const [rows] = await pool.query('SELECT id FROM \`class\` WHERE is_demo = 1');
  return rows.map(r => Number(r.id));
}

/**
 * 当前生效身份是否为「演示身份」（2026-10-28 演示环境隔离）。
 * 判定：member.is_review_demo=1（体验入口/免密体验写入），或生效身份所属班级为演示班。
 * 演示身份全程只可见演示班数据，彻底屏蔽真实班级。
 * @returns {Promise<boolean>}
 */
async function isDemoMember(pool, ctx) {
  const me = ctx && (ctx.member || ctx.realMember);
  if (!me) return false;
  if (me.is_review_demo === 1) return true;
  const ids = await demoClassIds(pool);
  return ids.includes(Number(me.class_id));
}

`;

const LOCK = `  const own = classIdOf(ctx);
  // 演示身份锁定：演示环境只能看演示班，屏蔽任何真实班级（防越权拉真实数据）
  if (await isDemoMember(pool, ctx)) return own;
  const req = Number(payload && payload.classId) || 0;`;

const OLD_LOCK = `  const own = classIdOf(ctx);
  const req = Number(payload && payload.classId) || 0;`;

let ok = 0, fail = 0;
for (const file of GUARDS) {
  let s = fs.readFileSync(file, 'utf8');
  const before = s;

  // 1) 在 resolveClassId 定义前插入助手
  const defAnchor = 'async function resolveClassId(pool, ctx, payload) {';
  const n1 = s.split(defAnchor).length - 1;
  if (n1 !== 1) { console.error('FAIL def-anchor !=1:', file, n1); fail++; continue; }
  s = s.replace(defAnchor, HELPERS + defAnchor);

  // 2) resolveClassId 内锁定（own 之后、req 之前）
  const n2 = s.split(OLD_LOCK).length - 1;
  if (n2 !== 1) { console.error('FAIL lock-anchor !=1:', file, n2); fail++; continue; }
  s = s.replace(OLD_LOCK, LOCK);

  // 3) 导出新增助手
  const expAnchor = 'resolveClassId, ADMIN_ROLES';
  const n3 = s.split(expAnchor).length - 1;
  if (n3 !== 1) { console.error('FAIL export-anchor !=1:', file, n3); fail++; continue; }
  s = s.replace(expAnchor, 'resolveClassId, isDemoMember, demoClassIds, ADMIN_ROLES');

  if (s === before) { console.error('FAIL no change:', file); fail++; continue; }
  fs.writeFileSync(file, s);
  console.log('PATCHED', path.relative(ROOT, file));
  ok++;
}

console.log(`\n=== done: patched=${ok} failed=${fail} total=${GUARDS.length} ===`);
process.exit(fail ? 1 : 0);
