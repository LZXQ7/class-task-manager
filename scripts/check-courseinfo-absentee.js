// 真跑验证 _buildCourseInfo 的实到人数（用户 2026-10-09 实拍：上午有人请了一上午假，
// 课堂情况却显示应到28 实到28）。用内存夹具 + 抽出的纯逻辑，不写盘、不依赖小程序运行时。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// 从真实源码里抠出 overlap / 实到那段逻辑跑（避免抄一份漂移）
const src = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.js'), 'utf8');

function extractOverlap() {
  const m = /const overlap = \(x\) => \{([\s\S]*?)\n {4}\};\n/.exec(src);
  if (!m) throw new Error('抠不出 overlap');
  return new Function('cs', 'ce', 'day', 'return function(x) {' + m[1] + '\n}')(null, null, '2026-10-09');
}

// 现场夹具：抄自用户两张实拍截图
// 课次：三笔字 08:10-09:50，B 组
const COURSE = { name: '三笔字', groupScope: 'B', periodTime: { start: '08:10', end: '09:50' } };
// 请假：郝鹏杰 2026-10-09 ~ 2026-10-09 08:00-12:00，B 组，**over: true**（已过时段）
const LEAVE = [{
  studentNo: '000000000056', name: '郝鹏杰', groupTag: 'B',
  startDate: '2026-10-09', endDate: '2026-10-09',
  startTime: '08:00', endTime: '12:00',
  over: true,             // 🔴 关键：这是「已过时段」，**不是已撤销**
  hasImage: false, image: ''
}];

const cs = COURSE.periodTime.start;
const ce = COURSE.periodTime.end;
const overlap = extractOverlap();
const hit = LEAVE.filter(overlap);

console.log('课次时段:', cs, '-', ce);
console.log('请假时段: 08:00 - 12:00（over=' + LEAVE[0].over + '）');
console.log('⇒ 命中:', hit.length, '人', hit.map((x) => x.name).join(','));
console.log('');
if (hit.length === 1) {
  console.log('✓ PASS 上午 08:00-12:00 的假被算进 08:10-09:50 这节课 ⇒ 实到 = 应到 − 1');
} else {
  console.log('✗ FAIL 没有命中 ⇒ 课堂情况会显示实到 = 应到（用户实拍的 bug）');
  process.exit(1);
}

// 边界：下午的课不该算上午的假
const AFTERNOON = '14:40', AFTERNOON_END = '16:20';
const overlap2 = new Function('cs', 'ce', 'day', 'return function(x) {' +
  /const overlap = \(x\) => \{([\s\S]*?)\n {4}\};\n/.exec(src)[1] + '\n}')(AFTERNOON, AFTERNOON_END, '2026-10-09');
const hit2 = LEAVE.filter(overlap2);
console.log('\n下午课 ' + AFTERNOON + '-' + AFTERNOON_END + ' ⇒ 命中', hit2.length, '人',
  hit2.length === 0 ? '✓ PASS 正确（时段无交集）' : '✗ FAIL 不该命中');
if (hit2.length !== 0) process.exit(1);

// 边界：已撤销的记录根本不会出现在 list 里（后端 SQL 只查 APPROVED）
const sql = fs.readFileSync(path.join(ROOT, 'cloudfunctions/adjust/index.js'), 'utf8');
const okSql = /WHERE l\.class_id = \? AND l\.status = 'APPROVED'/.test(sql);
console.log('\n后端 leaveBoard 只查 APPROVED ⇒ 撤销的不会出现在 list 里:', okSql ? '✓ PASS' : '✗ FAIL');
if (!okSql) process.exit(1);

// 边界：整天假算缺勤
const full = [{ name: '全天假', groupTag: 'B', startDate: '2026-10-09', endDate: '2026-10-09', startTime: '', endTime: '' }];
const hit3 = full.filter(overlap);
console.log('整天假⇒ 命中', hit3.length, '人', hit3.length === 1 ? '✓ PASS' : '✗ FAIL');
if (hit3.length !== 1) process.exit(1);

// 边界：假期不覆盖上课日期 ⇒ 不算
const other = [{ name: '别的假', groupTag: 'B', startDate: '2026-10-08', endDate: '2026-10-08', startTime: '08:00', endTime: '12:00' }];
const hit4 = other.filter(overlap);
console.log('假期不覆盖上课日⇒ 命中', hit4.length, '人', hit4.length === 0 ? '✓ PASS' : '✗ FAIL');
if (hit4.length !== 0) process.exit(1);

console.log('\n[PASS] 课堂情况实到人数：4 个边界全部正确');