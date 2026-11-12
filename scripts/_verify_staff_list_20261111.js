/**
 * 2026-11-11「教职工管理里教职工不见了」生产库**只读**等价验证。
 *
 * 用生产库真值 + 生产源码复算「教职工管理」面板到底会显示几行：
 *   ① X 组、未停用的在册教职工数（面板应该显示这么多）；
 *   ② 现行 staffList SQL（含 NOT_TEST）实际返回几行；
 *   ③ 读源码判定当前是否仍在按学号过滤，算出「当前生效的列表行数」；
 *   ④ 断言：生效行数 === 在册数。过滤掉任何一个在册教职工都是 bug。
 *
 * 用法：node scripts/_verify_staff_list_20261111.js
 * ⚠️ 全程 --read-only，绝不写生产库；不输出学号全文/姓名以外的 PII。
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

const BASE = "FROM member WHERE group_tag = 'X'";
const alive = q('SELECT id, name, position, status, LEFT(student_no, 10) AS no_prefix ' + BASE +
  " AND status != 'DISABLED' ORDER BY id");
const nAll = q('SELECT COUNT(*) AS n ' + BASE + " AND status != 'DISABLED'")[0].n;
const nFiltered = q('SELECT COUNT(*) AS n ' + BASE +
  " AND student_no NOT LIKE '0000000000%' AND status != 'DISABLED'")[0].n;

const src = fs.readFileSync(path.join(ROOT, 'cloudfunctions/member/index.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const at = src.indexOf('staffList: {');
const seg = src.slice(at, src.indexOf('\n  },', at));
const usesNotTest = /NOT_TEST\s*\(/.test(seg);
const effective = usesNotTest ? Number(nFiltered) : Number(nAll);

console.log('=== ① 在册教职工（X 组且未停用）===');
alive.forEach(r => console.log('  id=' + r.id + '  ' + r.name + '  position=' + (r.position || '-') +
  '  status=' + r.status + '  学号前缀=' + r.no_prefix));
console.log('  在册数 = ' + nAll);

console.log('\n=== ② 现行 staffList 的过滤口径 ===');
console.log('  源码仍按 NOT_TEST() 过滤？ ' + (usesNotTest ? '是' : '否'));
console.log('  带过滤 SQL 返回 ' + nFiltered + ' 行；不带过滤返回 ' + nAll + ' 行');
console.log('  ⇒ 面板当前生效行数 = ' + effective);

console.log('\n=== ③ 断言：在册教职工必须全部出现在列表 ===');
const pass = effective === Number(nAll);
if (pass) {
  console.log('  ✓ PASS：' + effective + ' / ' + nAll + ' 在册教职工可见');
} else {
  console.log('  ✗ FAIL：' + (Number(nAll) - effective) + ' 位在册教职工被过滤掉了（面板显示 ' +
    effective + ' 行，用户看到「教职工没有了」）');
  const hidden = q('SELECT id, name, LEFT(student_no, 10) AS no_prefix ' + BASE +
    " AND student_no LIKE '0000000000%' AND status != 'DISABLED' ORDER BY id");
  console.log('  被误判为测试账号的教职工：' + JSON.stringify(hidden));
}
process.exit(pass ? 0 : 1);
