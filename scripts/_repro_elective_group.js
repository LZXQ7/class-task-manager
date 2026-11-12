'use strict';
/*
 * 复现验证 Bug1：选修课按 group_tag 在 A/B 组视图过滤。
 * mock 三门课：A组×2 + B组×1。viewGroup='A' 应只见 A 组课；viewGroup='B' 应只见 B 组课。
 */
function makeChain() {
  const f = function () { return chain; };
  const chain = new Proxy(f, { get: (t, p) => (p === 'then' ? undefined : chain), apply: () => chain });
  return chain;
}
global.wx = makeChain();
let captured = null;
global.Page = (o) => { captured = o; };

const path = require('path');
const root = process.cwd();
try { require(path.resolve(root, 'miniprogram/pages/timetable/index.js')); }
catch (e) { console.error('REQUIRE FAILED:', (e && e.stack) || e); process.exit(2); }
if (!captured) { console.error('Page not captured'); process.exit(3); }

const P = captured;
const page = Object.assign({}, P);
page.data = JSON.parse(JSON.stringify(P.data || {}));
page.setData = function (patch, cb) { if (patch && typeof patch === 'object') Object.assign(this.data, patch); if (typeof cb === 'function') { try { cb(); } catch (e) {} } };

page.termStart = '2026-09-07';
page._personal = [
  { id: 2, name: '演讲与口才', dayOfWeek: 4, period: 5, weeks: '', weekRule: 'ALL', groupTag: 'A' },
  { id: 3, name: '大学生积极社交', dayOfWeek: 1, period: 5, weeks: '', weekRule: 'ALL', groupTag: 'A' },
  { id: 1, name: 'AIGC', dayOfWeek: 2, period: 3, weeks: '', weekRule: 'ALL', groupTag: 'B' }
];
page._holidays = [];
page._shifts = [];
page._dutyMap = {};
page.data.week = 9;
page.data.termStart = '2026-09-07';
page.data.totalWeeks = 18;

function countPersonal() {
  let n = 0; const names = [];
  (page.data.grid || []).forEach(row => row.forEach(cell => (cell.courses || []).forEach(co => {
    if (co.personal) { n++; names.push(co.name + '(' + co.groupScope + ')'); }
  })));
  return { n, names };
}

function run(view) {
  page.data.viewGroup = view;
  page._rebuildWithPersonal();
  const r = countPersonal();
  console.log('viewGroup=' + view + ' => personal shown:', r.n, '|', r.names.join(', '));
  return r.n;
}

const a = run('A');
const b = run('B');
const all = run('ALL');

let pass = true;
if (a !== 2) { console.error('FAIL viewGroup=A 应显示 2 门(A组)'); pass = false; }
if (b !== 1) { console.error('FAIL viewGroup=B 应显示 1 门(B组)'); pass = false; }
if (all !== 3) { console.error('FAIL viewGroup=ALL 应显示 3 门'); pass = false; }
console.log(pass ? 'PASS: 选修课按组过滤正确' : 'FAIL');
process.exit(pass ? 0 : 1);
