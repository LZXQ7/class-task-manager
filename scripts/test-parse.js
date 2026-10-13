const fs = require('fs');
const path = require('path');
const { parseTimetableXlsx } = require('../cloudfunctions/course/import-parse');

const buf = fs.readFileSync(path.resolve(__dirname, 'fixtures/timetable-示例班级A.xlsx'));
const res = parseTimetableXlsx(buf, 16);

const expectNames = ['形势与政策5', '小学人工智能教育', '微课设计与制作', '小学数学课程与教学论',
  '小学语文课程与教学论', '小学综合实践活动设计', '习近平新时代中国特色社会主义思想概论',
  '小学生心理健康与指导', '儿童文学', '三笔字', '音乐基础'];
const got = res.courses.map(c => c.name);
const missing = expectNames.filter(n => !got.includes(n));
const extra = got.filter(n => !expectNames.includes(n));

let fail = 0;
function check(cond, msg) { if (!cond) { fail++; console.log('  ✗ ' + msg); } else console.log('  ✓ ' + msg); }

console.log('courses =', res.courses.length, '(期望 11)');
console.log('sessions =', res.sessions.length, '(期望 16)');
console.log('warnings =', JSON.stringify(res.warnings));
console.log('missing courses =', JSON.stringify(missing));
console.log('extra courses   =', JSON.stringify(extra));
check(res.courses.length === 11, 'courses === 11');
check(res.sessions.length === 16, 'sessions === 16');
check(missing.length === 0, '无缺失课程');
check(extra.length === 0, '无多余课程');

// 形势与政策5：星期一 [1-2] weeks 6,8,10,12
const sp = res.sessions.find(s => s.name === '形势与政策5');
check(sp && sp.dayOfWeek === 1 && sp.period === 1 && sp.weeks === '6,8,10,12',
  '形势与政策5 = 星期一/节次1/weeks 6,8,10,12  (得 ' + JSON.stringify(sp && { d: sp.dayOfWeek, p: sp.period, w: sp.weeks }) + ')');

// 习思想：星期一(1-16) + 星期四(拆成 1-12,14-16 与 13 两条)，共 3 条；period 均为 3
const x = res.sessions.filter(s => s.name === '习近平新时代中国特色社会主义思想概论');
check(x.length === 3, '习思想 = 3 条课次 (得 ' + x.length + ')');
check(x.every(s => s.period === 3), '习思想 全部 period=3');
check(x.some(s => s.dayOfWeek === 1 && s.weeks === '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16'), '习思想 含 星期一 全周');
// 星期四两条合并应覆盖奇周 1,3,5,7,9,11,13,15（1-12,14-16 单 + 13）
const thu = x.filter(s => s.dayOfWeek === 4);
const thuUnion = Array.from(new Set(thu.flatMap(s => s.weeks.split(',').map(Number)))).sort((a, b) => a - b);
check(thuUnion.join(',') === '1,3,5,7,9,11,13,15', '习思想 星期四 = 奇周 1,3,5,7,9,11,13,15 (得 ' + thuUnion.join(',') + ')');

// 小学数学课程与教学论：星期二(dayOfWeek=2) weeks 1-4 与 weeks 5-16 两条，去重为 1 门课
const xs = res.sessions.filter(s => s.name === '小学数学课程与教学论');
check(xs.length === 2, '小学数学 = 2 条课次 (得 ' + xs.length + ')');
check(xs.every(s => s.dayOfWeek === 2 && s.period === 2), '小学数学 全部 星期二/节次2');
check(xs.some(s => s.weeks === '1,2,3,4') && xs.some(s => s.weeks === '5,6,7,8,9,10,11,12,13,14,15,16'), '小学数学 weeks 拆成 1-4 与 5-16');

// 小学语文课程与教学论：跨 节次一(星期四) + 节次二(星期四)，去重 1 门
const xy = res.sessions.filter(s => s.name === '小学语文课程与教学论');
check(xy.length === 2 && xy.some(s => s.period === 1) && xy.some(s => s.period === 2), '小学语文 跨两个节次(1 与 2)');

// 三笔字/音乐基础：节次五(period 5) 星期二/星期三
const sb = res.sessions.find(s => s.name === '三笔字');
const yy = res.sessions.find(s => s.name === '音乐基础');
check(sb && sb.dayOfWeek === 2 && sb.period === 5, '三笔字 = 星期二/节次5 (得 ' + JSON.stringify(sb && { d: sb.dayOfWeek, p: sb.period }) + ')');
check(yy && yy.dayOfWeek === 3 && yy.period === 5, '音乐基础 = 星期三/节次5 (得 ' + JSON.stringify(yy && { d: yy.dayOfWeek, p: yy.period }) + ')');

console.log(fail === 0 ? '\n全部通过 ✅' : '\n失败 ' + fail + ' 项 ❌');

fs.writeFileSync(path.resolve(__dirname, 'fixtures/_parsed.json'), JSON.stringify(res, null, 1), 'utf8');
process.exit(fail === 0 ? 0 : 1);
