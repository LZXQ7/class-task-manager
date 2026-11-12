'use strict';
/*
 * 复现验证 v2：多课同格场景下的选修课点击编辑。
 * 注入「口语字母」普通课与两门选修课同占周一第5节，模拟真实课表，再点第一门 personal 课。
 */
function makeChain() {
  const f = function () { return chain; };
  const chain = new Proxy(f, {
    get: (t, p) => { if (p === 'then') return undefined; return chain; },
    apply: () => chain
  });
  return chain;
}
global.wx = makeChain();
let captured = null;
global.Page = (o) => { captured = o; };

const fs = require('fs');
const path = require('path');
const root = process.cwd();
const pagePath = path.resolve(root, 'miniprogram/pages/timetable/index.js');
const ttPath = path.resolve(root, 'miniprogram/data/timetable');

try { require(pagePath); } catch (e) { console.error('REQUIRE page FAILED:', (e && e.stack) || e); process.exit(2); }
let tt;
try { tt = require(ttPath); } catch (e) { console.error('REQUIRE tt FAILED:', (e && e.stack) || e); process.exit(2); }
if (!captured) { console.error('Page not captured'); process.exit(3); }

const P = captured;
const page = Object.assign({}, P);
page.data = JSON.parse(JSON.stringify(P.data || {}));
page.setData = function (patch, cb) {
  if (patch && typeof patch === 'object') Object.assign(this.data, patch);
  if (typeof cb === 'function') { try { cb(); } catch (e) {} }
};

page.termStart = '2026-09-07';
page._personal = [
  { id: 1, name: '大学生积极社交', dayOfWeek: 1, period: 5, weeks: '', weekRule: 'ALL' },
  { id: 2, name: '演讲与口才', dayOfWeek: 4, period: 5, weeks: '', weekRule: 'ALL' }
];
page._holidays = [];
page._shifts = [];
page._dutyMap = {};
page.data.week = 9;
page.data.termStart = '2026-09-07';
page.data.totalWeeks = 18;
page.data.viewGroup = 'A';

let opened = null;
page._openElectiveForm = function (p) { opened = p; console.log('  [onCell→_openElectiveForm]', p && p.name, 'pid=', p && p.id); };

// 真实班级课次 + 同格普通课（周一第5节）
const classCourses = tt.sessionsOfWeek(page.data.week).map(c => Object.assign({}, c));
const normal = {
  sessionId: 9999, name: '口语字母', room: '3号楼111', teacher: '', groupScope: null,
  dayOfWeek: 1, period: 5, weekRule: 'ALL', weeks: '', dutyCount: 0
};
classCourses.push(normal);

console.log('classCourses count:', classCourses.length);
try {
  page._build(page._mergePersonal(classCourses));
} catch (e) { console.error('BUILD FAILED:', (e && e.stack) || e); process.exit(4); }

const grid = page.data.grid || [];
const collect = [];
grid.forEach((row, r) => row.forEach((cell, c) => {
  (cell.courses || []).forEach(co => { if (co.personal) collect.push({ co, r, c }); });
}));
console.log('personal courses rendered:', collect.length);
// 打印周一第5节格子里所有课（验证同格）
grid[4] && grid[4][0] && console.log('周一第5节 cell courses:',
  (grid[4][0].courses || []).map(x => x.name + (x.personal ? '(P)' : '') + ' sid=' + x.sessionId + ' pid=' + x.pid));

function clickIt(item, label) {
  const co = item.co;
  const e = { currentTarget: { dataset: { r: item.r, c: item.c, sid: co.sessionId, personal: co.personal ? 1 : '', pid: co.personal ? co.pid : '' } } };
  opened = null;
  page.onCell(e);
  console.log(label, '=> opened:', opened && opened.name);
}
if (collect.length >= 1) clickIt(collect[0], 'CLICK first (大学生积极社交):');
if (collect.length >= 2) clickIt(collect[1], 'CLICK second (演讲与口才):');
console.log('DONE');
