/**
 * 2026-11-14「换了辅导员后，切换测试账号里没有辅导员了」生产库**只读**等价验证。
 *
 * 现象：示例成员57（老辅导员，id=72，占位学号 000000000090 —— 特意放在 99 段）
 *      删号后新建陈慧芳（id=294，占位学号 STAFFV7E9FS），
 *      「我的 → 更多 → 切换测试账号」里就再也没有辅导员这一条了。
 *
 * 判据（两处都必须放行，缺一处都等于切不到辅导员视角）：
 *   ① member.testAccountList 的列名单 SQL 必须包含 X 组（教职工），
 *      不能只靠 `student_no LIKE '0000000000%'` —— 新号是 STAFF 前缀，永远匹配不上；
 *   ② auth.switchAccount 的白名单必须放行 X 组，不能只判 isTestNo，
 *      否则列表能看见、点了报「仅允许切换到测试账号」。
 *
 * 断言：可切候选（99 段 ∪ X 组，未停用）必须**全部**出现在列表结果里。
 *
 * 用法：node scripts/_verify_switch_account_20261114.js
 * ⚠️ 全程 --read-only，绝不写生产库；只输出姓名与学号前缀，不输出 openid。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TCBJS = 'C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb';
const ENV = '<YOUR_ENV_ID>';

function q(sql) {
  const r = spawnSync(process.execPath,
    [TCBJS, 'db', 'execute', '-e', ENV, '-r', 'ap-shanghai', '--read-only', '--json', '-s', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = String(r.stdout || '');
  const i = out.indexOf('{');
  if (i < 0) throw new Error('no json: ' + out.slice(0, 400) + ' | ' + String(r.stderr || '').slice(0, 300));
  const j = JSON.parse(out.slice(i));
  const items = j && j.data && j.data.items;
  if (!Array.isArray(items)) throw new Error('unexpected json: ' + JSON.stringify(j).slice(0, 300));
  return items;
}

const ALIVE = "status != 'DISABLED'";

/* ① 目标口径：99 段合成测试账号 ∪ X 组教职工 */
const candidates = q(
  "SELECT id, name, group_tag, position, LEFT(student_no, 10) AS no_prefix FROM member" +
  " WHERE (student_no LIKE '0000000000%' OR group_tag = 'X') AND " + ALIVE + ' ORDER BY id'
);

/* ② 现行 testAccountList 的等价 SQL（当前源码就是只按 99 段过滤） */
const legacyRows = q(
  "SELECT id, name, group_tag FROM member WHERE student_no LIKE '0000000000%' AND " + ALIVE + ' ORDER BY id'
);

/* ③ 读源码：两处判据当前是什么口径 */
const strip = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

const memberSrc = strip('cloudfunctions/member/index.js');
const at = memberSrc.indexOf('testAccountList: {');
const listSeg = at < 0 ? '' : memberSrc.slice(at, memberSrc.indexOf('\n  },', at));
const listHasX = /group_tag\s*=\s*'X'|group_tag='X'/.test(listSeg);

const authSrc = strip('cloudfunctions/auth/index.js');
const swAt = authSrc.indexOf('switchAccount: {');
const swSeg = swAt < 0 ? '' : authSrc.slice(swAt, authSrc.indexOf('\n  },', swAt));
const switchHasX = /group_tag\s*!==\s*'X'|group_tag\s*===\s*'X'/.test(swSeg);

console.log('=== ① 可切候选（99 段 ∪ X 组，未停用）===');
candidates.forEach(r => console.log('  id=' + r.id + '  ' + r.name +
  '  group=' + r.group_tag + '  position=' + (r.position || '-') + '  学号前缀=' + r.no_prefix));
console.log('  合计 = ' + candidates.length);

console.log('\n=== ② 现行口径 ===');
console.log('  仅 99 段（旧 SQL）返回 ' + legacyRows.length + ' 行：' +
  legacyRows.map(r => r.id + ':' + r.name).join('、'));
console.log('  testAccountList 源码含 X 组条件？ ' + (listHasX ? '是' : '否'));
console.log('  switchAccount 白名单放行 X 组？ ' + (switchHasX ? '是' : '否'));

const effective = listHasX ? candidates.length : legacyRows.length;
const missing = candidates.filter(c => !legacyRows.some(r => Number(r.id) === Number(c.id)));

console.log('\n=== ③ 断言 ===');
let pass = true;
if (effective !== candidates.length) {
  pass = false;
  console.log('  ✗ FAIL：列表只显示 ' + effective + ' / ' + candidates.length + ' 位可切身份');
  console.log('    被漏掉的：' + missing.map(m => m.id + ':' + m.name + '(' + m.group_tag + ')').join('、'));
}
if (!switchHasX) {
  pass = false;
  console.log('  ✗ FAIL：switchAccount 只判 isTestNo → 即便列表点得到，切辅导员也会被拒「仅允许切换到测试账号」');
}
if (pass) console.log('  ✓ PASS：' + candidates.length + ' 位可切身份全部可见且可切换（含辅导员）');

process.exit(pass ? 0 : 1);
