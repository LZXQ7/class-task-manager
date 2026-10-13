#!/usr/bin/env node
/**
 * 门禁 77：青果课表页 HTML 解析器（admin-web/public/timetable-html.js）
 *
 * 背景
 * ------------------------------------------------------------------
 * 本文件对应的解析器是**自研**的。参考对象 Dawn-Course 的 kingosoft.js 是
 * GPL-3.0 且无 SPDX 例外条款，源码不能进本仓；这里吸收的是它**踩出来的行为
 * 规格**，每一行注释里的坑都必须有对应断言，否则后人会把它删掉然后复发。
 *
 * 锁住的规格（逐条对应实现注释）：
 *   ① 周次文本要先剥「节次括号组」再拆区间（否则 "9周(1-2节)" 变怪周次）；
 *   ② 单/双周标记必须带边界（否则 "1-16周 双创楼" 的「双」被当双周）；
 *   ③ 区间写反（"16-9周"）自动交换；周次钳到 1..53；
 *   ④ 星期列用**反向索引**映射（行首多余列 / 表头与正文列数不等时不串位）；
 *   ⑤ 小节 → 大节换算 ceil/floor ÷2，跨大节要拆成多条 session；
 *   ⑥ 只上一周的课（"9周"）必须保留；
 *   ⑦ 解析不出来的条目必须**计数并可提示**，不能静默消失。
 *
 * 第四种版面「打印版（全校课表按班级）」额外锁住的规格（真实样本见 fixtures）：
 *   ⑧ 表头两行 + colspan ⇒ 列位置即 (星期, 大节)；print 必须排在 grid 之前；
 *   ⑨ 单元格是 &ensp; 分隔的扁平一行，末尾数字是**上课人数**要剥掉；
 *   ⑩ 同一条课次被页面渲染两次（title 与正文各一次）⇒ 按六元组去重；
 *   ⑪ 一次查出多个行政班级 ⇒ 直接报错，不能把别班的课写进本班；
 *   ⑫ 只有「我的课表」页写了「课程门数」可做对账，打印版没有 ⇒ 别硬加断言。
 *
 * 另有 13 组变异自证：把实现改坏后本门禁必须变红。
 *
 * ⚠️ 写变异时的两个静默陷阱（都真踩过）：
 *   · 夹具里 37 个空 <td> 属性完全一样，用 String.replace 注入只会命中第一个空单元格
 *     ⇒ 注入到错误的列，变异"看起来通过"其实是假自证。手写夹具才可控。
 *   · 不要拿别人（包括我自己）写在注释里的话当页面证据 —— 「共N个行政班级」
 *     这句只存在于我写的注释里，真实页面没有，据此写的断言恒失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'cloudfunctions', 'admin-web', 'public', 'timetable-html.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + msg);
  return false;
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + msg + '\n      实际=' + a + '\n      期望=' + b);
  return false;
}

const src = fs.readFileSync(SRC, 'utf8');
const T = require(SRC);

// 真实样本（脱敏）：青果「我的课表」页，见 outputs/fixtures/timetable/
const REAL_HTML = fs.readFileSync(
  path.join(ROOT, 'outputs', 'fixtures', 'timetable', 'kingosoft-mykbt-sample.html'), 'utf8');

// 真实样本（脱敏）：青果「主控 → 公共查询 → 全校课表(按班级)」的打印版
const PRINT_HTML = fs.readFileSync(
  path.join(ROOT, 'outputs', 'fixtures', 'timetable', 'kingosoft-class-print-sample.html'), 'utf8');

/* ============ 夹具 ============ */

// ① 网格式：行首「第1-2节」，单元格内含 font 课程名 + 教师 + 周次 + 地点
const GRID_HTML = [
  '<html><body><table border="1">',
  '<tr><td></td><td>星期一</td><td>星期二</td><td>星期三</td><td>星期四</td><td>星期五</td></tr>',
  '<tr>',
  '<td>第1-2节<br>08:00</td>',
  '<td><font>高等数学</font><br>张三<br>1-16周<br>教学楼A101</td>',
  '<td></td>',
  '<td><font>大学英语</font><br>李四<br>1-16[1-2]<br>外语楼203</td>',
  '<td></td>',
  '<td><font>体育</font><br>钱七<br>1-16周<br>操场</td>',
  '</tr>',
  '<tr>',
  '<td>第3-4节<br>10:00</td>',
  '<td></td>',
  '<td><font>数据结构</font><br>王五<br>(单)1-16周<br>实验楼B505</td>',
  '<td></td>',
  '<td><font>线性代数</font><br>赵六<br>9周<br>数学楼301</td>',
  '<td></td>',
  '</tr>',
  '</table></body></html>'
].join('\n');

// ② 网格式 + 正文比表头多一列（真实页面常有「序号」列）——验证反向索引
//    注意：多出来的这列只加在**正文行**，表头行数不变 ⇒ 正向映射会整体串一天。
const GRID_EXTRA_HTML = GRID_HTML
  .replace(/<td>第(\d)-(\d)节/g, '<td>$1</td><td>第$1-$2节');

// ③ 列表式：表头「课程名称/教师/星期/节次/周次/上课地点」
const LIST_HTML = [
  '<table>',
  '<tr><th>课程名称</th><th>教师</th><th>星期</th><th>节次</th><th>周次</th><th>上课地点</th></tr>',
  '<tr><td>形势与政策</td><td>赵六</td><td>星期三</td><td>3-4节</td><td>9周</td><td>报告厅</td></tr>',
  '<tr><td>体育</td><td>钱七</td><td>星期五</td><td>1-4节</td><td>(单)1-16周</td><td>操场</td></tr>',
  '<tr><td>高等数学</td><td>张三</td><td>星期一</td><td>1-2节</td><td>1-8,10-16周</td><td>教学楼A101</td></tr>',
  '</table>'
].join('\n');

// ④ 打印版（全校课表按班级）：表头两行（班级 + 7 个 colspan=5 星期；
//    第二行每天 上午2/下午2/晚上1）⇒ 列位置即 (星期, 大节)，正文一班一行。
//    手写而非改真实样本：真实样本里 37 个空 <td> 属性完全一样，
//    用 String.replace 注入只会命中「第一个」空单元格，注入到错误的列上（真踩过）。
const PRINT_MINI = (function () {
  var days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
  var head = '<tr><td rowspan="2">班&ensp;级</td>' +
    days.map(function (d) { return '<td colspan="5">' + d + '</td>'; }).join('') + '</tr>';
  var sub = '<tr>' + days.map(function () {
    return '<td colspan="2">上午</td><td colspan="2">下午</td><td colspan="1">晚上</td>';
  }).join('') + '</tr>';
  var cells = ['<td>软件工程示例班级C(30)</td>'];
  for (var i = 1; i <= 35; i++) cells.push('<td></td>');
  // 第 N 天第 M 大节 = (N-1)*5 + M
  cells[(1 - 1) * 5 + 1] = '<td title="a">高等数学&ensp;张三&ensp;[1-16]周&ensp;1-2节&ensp;教学楼A101&ensp;60<br></td>';
  // 故意放在**周六第4大节**：网格版面的反向索引会把这一列误认成周一 ⇒ 顺序变异能被抓到
  cells[(6 - 1) * 5 + 4] = '<td title="b">体育&ensp;李四&ensp;[1-8]周&ensp;3-4节&ensp;操场&ensp;30<br></td>';
  return '<table>' + head + sub + '<tr>' + cells.join('') + '</tr></table>';
})();

// ⑤ 打印版里查出**两个**行政班级（把班级正文行复制一份并改班号）
const PRINT_TWO = (function () {
  var start = PRINT_HTML.lastIndexOf('<tr>');
  var end = PRINT_HTML.lastIndexOf('</tr>');
  var body = PRINT_HTML.slice(start, end + 5);
  if (start < 0 || end < start || body.indexOf('示例班级A') < 0) {
    throw new Error('打印版夹具结构变了，PRINT_TWO 构造失败');
  }
  return PRINT_HTML.slice(0, end + 5) + body.replace('示例班级A', '2604班') + PRINT_HTML.slice(end + 5);
})();

/* ============ 单元测试：周次/节次/大节换算 ============ */
console.log('\n[1] 周次解析（第 ①②③ 条规格）');

eq(T.parseWeeks('9周(1-2节)'), [9], '① "9周(1-2节)" 必须只出第 9 周（节次括号组要先剥）');
eq(T.parseWeeks('1-16周(1-2节)'), Array.from({ length: 16 }, (_, i) => i + 1), '① 区间 + 节次括号组不能把周次吃撑/吃没');
eq(T.parseWeeks('5周[1-2节]'), [5], '① 方括号形态同样要先剥');
eq(T.parseWeeks('1-16周'), Array.from({ length: 16 }, (_, i) => i + 1), '① 区间展开');
eq(T.parseWeeks('16-9周'), Array.from({ length: 8 }, (_, i) => i + 9), '③ 区间写反要自动交换');
eq(T.parseWeeks('1-8,10-16周'), [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16], '① 逗号列表');
eq(T.parseWeeks('周次:1-3周'), [1, 2, 3], '① 带「周次:」标签');
eq(T.parseWeeks('第9周'), [9], '① 带「第」前缀的单周');
eq(T.parseWeeks('1-16周(单)'), [1, 3, 5, 7, 9, 11, 13, 15], '② 尾随单周标记');
eq(T.parseWeeks('(双)1-16周'), [2, 4, 6, 8, 10, 12, 14, 16], '② 前置双周标记');
eq(T.parseWeeks('60-70周'), [], '③ 周次越界（>53）应丢空而不是写进库');
eq(T.parseWeeks(''), [], '空输入返回空数组');

console.log('\n[2] 单双周标记的边界（第 ② 条规格）');
eq(T.parseWeeks('1-16周 双创楼'), Array.from({ length: 16 }, (_, i) => i + 1),
  '② "1-16周 双创楼" 的「双」不能被当成双周标记');
eq(T.parseWeeks('教学楼(双创) 1-16周'), Array.from({ length: 16 }, (_, i) => i + 1),
  '② 括号里的非奇偶文本不能被当标记');
eq(T.detectParity('(单)1-16周'), 'ODD', '② detectParity 识别 ODD');
eq(T.detectParity('(双)1-16周'), 'EVEN', '② detectParity 识别 EVEN');
eq(T.detectParity('1-16周'), 'ALL', '② detectParity 无标记=ALL');

console.log('\n[3] 节次与大节换算（第 ⑤ 条规格）');
eq(T.parseSections('1-2节'), [1, 2], '节次区间');
eq(T.parseSections('[3-4]'), [3, 4], '方括号节次');
eq(T.parseSections('5节'), [5], '单节');
eq(T.toPeriods([1, 2]), [1], '小节 1-2 → 大节 1');
eq(T.toPeriods([3, 4]), [2], '小节 3-4 → 大节 2');
eq(T.toPeriods([9, 10]), [5], '小节 9-10 → 大节 5');
eq(T.toPeriods([1, 4]), [1, 2], '跨大节要拆成多条 session（课表所在的每大节都要有）');
eq(T.toPeriods([]), [], '无节次不产出 period（交给调用方计 dropped）');

console.log('\n[4] 星期识别');
eq(T.dayFromText('星期一'), 1, '星期一');
eq(T.dayFromText('周五'), 5, '周五');
eq(T.dayFromText('星期天'), 7, '星期天=周日');
eq(T.dayFromText('3'), 3, '裸数字');

/* ============ 集成测试：三种版面 ============ */
console.log('\n[5] 网格版面');
{
  const r = T.parse(GRID_HTML);
  eq(r.layout, 'grid', '版面识别为 grid');
  const keys = r.sessions.map(s => s.name + '|' + s.dayOfWeek + '|' + s.period).sort();
  eq(keys, [
    '体育|5|1', '数据结构|2|2', '线性代数|4|2', '大学英语|3|1', '高等数学|1|1'
  ].sort(), '⑤⑥ 课次落点（星期/大节）正确，含只上一周的课');
  const dsx = r.sessions.find(s => s.name === '数据结构');
  eq(dsx && dsx.weeks, '1,3,5,7,9,11,13,15', '② 单周课的周次为奇数周');
  const xx = r.sessions.find(s => s.name === '线性代数');
  eq(xx && xx.weeks, '9', '⑥ 只上一周的课程保留');
  const tys = r.sessions.find(s => s.name === '大学英语');
  eq(tys && tys.room, '外语楼203', '地点提取');
  ok(r.courses.length === 5, '课程按 名称|教师 去重后为 5 门，实际=' + r.courses.length);
  ok(r.courses.every(function (c) { return !!c.name && !!c.teacher; }), '每门课都带上了教师');
}

console.log('\n[6] 反向索引：正文比表头多一列时不串位（第 ④ 条规格）');
{
  const r = T.parse(GRID_EXTRA_HTML);
  const keys = r.sessions.map(s => s.name + '|' + s.dayOfWeek + '|' + s.period).sort();
  eq(keys, [
    '体育|5|1', '数据结构|2|2', '线性代数|4|2', '大学英语|3|1', '高等数学|1|1'
  ].sort(), '④ 正文多一列「序号」后星期映射仍然正确（正向映射会串一天）');
}

console.log('\n[7] 列表版面');
{
  const r = T.parse(LIST_HTML);
  eq(r.layout, 'list', '版面识别为 list');
  const keys = r.sessions.map(s => s.name + '|' + s.dayOfWeek + '|' + s.period).sort();
  eq(keys, ['体育|5|1', '体育|5|2', '形势与政策|3|2', '高等数学|1|1'], '⑤⑦ 列表式：跨大节拆两条');
  const ty = r.sessions.filter(s => s.name === '体育');
  eq(ty[0] && ty[0].weeks, '1,3,5,7,9,11,13,15', '列表式单周课');
  const gdsx = r.sessions.find(s => s.name === '高等数学');
  eq(gdsx && gdsx.weeks, '1,2,3,4,5,6,7,8,10,11,12,13,14,15,16', '列表式逗号列表周次');
  eq(gdsx && gdsx.teacher, '张三', '列表式教师列');
  eq(gdsx && gdsx.room, '教学楼A101', '列表式地点列');
}

console.log('\n[8] 丢弃计数必须可见（第 ⑦ 条规格）');
{
  const html = '<table><tr><th>课程名称</th><th>星期</th><th>节次</th><th>周次</th></tr>' +
    '<tr><td>没周次的课</td><td>星期一</td><td>1-2节</td><td></td></tr>' +
    '<tr><td>没星期的课</td><td></td><td>1-2节</td><td>1-16周</td></tr>' +
    '<tr><td>正常的课</td><td>星期二</td><td>1-2节</td><td>1-16周</td></tr></table>';
  const r = T.parse(html);
  eq(r.courses.length, 1, '只剩能落库的一门');
  ok(r.stats.dropped.no_weeks === 1, '⑦ no_weeks 计数=1，实际=' + r.stats.dropped.no_weeks);
  ok(r.stats.dropped.no_day === 1, '⑦ no_day 计数=1，实际=' + r.stats.dropped.no_day);
  ok(r.warnings.length >= 2, '⑦ 每条被跳过的都有中文提示');
}

console.log('\n[9] 垃圾输入必须抛可理解的错');
{
  let e1 = ''; try { T.parse('<html><body>登录页 验证码</body></html>'); } catch (e) { e1 = e.message; }
  ok(/未能|没有识别/.test(e1), '无表格时抛中文错误，实际=' + e1);
  let e2 = ''; try { T.parse('<table><tr><td>空</td></tr></table>'); } catch (e) { e2 = e.message; }
  ok(/未能|没有识别/.test(e2), '有表格但无课时抛中文错误，实际=' + e2);
}

console.log('\n[9b] 外层框架页（iframe 外壳）必须给出可执行指引');
{
  // 真实样本见 outputs/fixtures/timetable/kingosoft-desk-shell-sample.html
  const SHELL = '<!DOCTYPE html><html><head><title>KINGOSOFT高校教学综合管理服务平台</title>' +
    '<meta charset="gbk"></head><body class="blue"><article>' +
    '<div class="row index-right-panel"><iframe width="100%" id="frmDesk" name="frmDesk" src=""></iframe></div>' +
    '<div class="index-left-panel"><ul class="nav"><li>我的功能</li></ul></div></article>' +
    '<script>jwutil.setYearTerm("xn|xn1|xq_m|_xq",InitData);</script></body></html>';
  let e = '';
  try { T.parse(SHELL); } catch (err) { e = err.message; }
  ok(/外层框架页/.test(e), '识别为外层框架页，实际=' + e);
  ok(/frmDesk/.test(e), '指引里给出 iframe 的 id（用户照做就能取到），实际=' + e);
  ok(/contentDocument/.test(e), '指引里给出可直接复制的控制台命令，实际=' + e);
}

console.log('\n[11] 真实样本回归（outputs/fixtures/timetable/kingosoft-mykbt-sample.html）');
{
  const r = T.parse(REAL_HTML);
  eq(r.layout, 'grid', '真实页识别为网格版面');
  // 页面顶部写着「课程门数：12」，用它交叉校验解析出的课程数
  eq(r.courses.length, 12, '课程数必须等于页面顶部「课程门数：12」，实际=' + r.courses.length);
  eq(r.sessions.length, 17, '课次数 17（同格叠两个 div 的按周次拆成两条），实际=' + r.sessions.length);
  eq(r.stats.dropped, { no_weeks: 0, no_sections: 0, no_day: 0 },
    '真实样本不该有任何被丢弃的课次（丢了就是漏课）');
  eq(r.meta.declaredCourseCount, 12, '抓到页面顶部声明的课程门数，用于与解析结果对账');
  eq(r.meta.className, '示例专业A1班', '抓到所在班级（给操作者确认没粘错人）');
  eq(r.warnings, [], '门数对得上 ⇒ 不该有警告');

  const find = (name, day, period) => r.sessions.filter(s =>
    s.name === name && s.dayOfWeek === day && s.period === period);

  // 单/双**独立成词**（"5-12 双 [1-2]"）
  const xszc = find('形势与政策5', 1, 1);
  eq(xszc.length, 1, '形势与政策5 落点 周一第1大节');
  eq(xszc[0] && xszc[0].weeks, '6,8,10,12', '「5-12 双」= 第6/8/10/12周');
  eq(xszc[0] && xszc[0].teacher, '示例老师01', '教师');
  eq(xszc[0] && xszc[0].room, '3号教学楼208', '地点');

  // 同格两个 div：同一门课前半学期 305、后半学期 112
  const sx = find('小学数学课程与教学论', 2, 2).sort((a, b) => a.weeks.localeCompare(b.weeks, 'en'));
  eq(sx.length, 2, '小学数学课程与教学论 拆成两条（换教室）');
  eq(sx[0] && sx[0].weeks, '1,2,3,4', '前半学期周次');
  eq(sx[1] && sx[1].room, '3号教学楼112（科学教育实验室）', '后半学期教室');

  // 逗号列表 + 单周："1,3,5,...,15 单 [5-6]" 与 "2,4,...,16 双 [5-6]"
  const xl = find('小学生心理健康与指导', 3, 3).map(s => s.weeks).sort();
  eq(xl, ['1,3,5,7,9,11,13,15', '2,4,6,8,10,12,14,16'], '逗号列表 + 单双周');

  // 混合列表 "1-12,14-16 单" 与紧贴括号的单周 "13[5-6]"
  const xjp = find('习近平新时代中国特色社会主义思想概论', 4, 3).map(s => s.weeks).sort();
  eq(xjp, ['1,3,5,7,9,11,15', '13'], '「1-12,14-16 单」+「13[5-6]」（第 14、15 周不能丢）');

  // 周末 + 线上教学
  const wlw = find('移动互联网时代的信息安全与防护', 6, 5);
  eq(wlw[0] && wlw[0].weeks, '7,8,9,10,11,12,13,14', '周六第5大节，7-14周');
  eq(wlw[0] && wlw[0].room, '线上教学', '线上课的地点也要带出来');
}

console.log('\n[12] 青果网页特有的周次写法（第 ① 条规格的加强版）');
eq(T.detectParity('5-12 双 [1-2]'), 'EVEN', '独立成词的「双」要识别（青果网页标准写法）');
eq(T.detectParity('1,3,5 单 [5-6]'), 'ODD', '独立成词的「单」要识别');
eq(T.detectParity('1-16周 双创楼'), 'ALL', '「双创楼」仍然不能被误判（边界不能松）');
eq(T.parseWeeks('13[5-6]'), [13], '紧贴括号的单周 "13[5-6]"');
eq(T.parseWeeks('1-12,14-16 单 [5-6]'), [1, 3, 5, 7, 9, 11, 15], '混合列表 + 单周');
eq(T.parseWeeks('1,3,5,7,9,11,13,15 单'), [1, 3, 5, 7, 9, 11, 13, 15], '逗号列表 + 单周');

console.log('\n[13] 打印版版面（全校课表按班级）—— 真实样本回归');
{
  const r = T.parse(PRINT_HTML);
  eq(r.layout, 'print', '识别为 print 版面（不能被网格版面抢走）');
  eq(r.courses.length, 12, '课程 12 门（与「我的课表」页一致），实际=' + r.courses.length);
  eq(r.sessions.length, 25, '课次 25 条，实际=' + r.sessions.length);
  eq(r.stats.deduped, 3, '同一条课次被页面渲染两次 ⇒ 去重 3 条，实际=' + r.stats.deduped);
  eq(r.stats.dropped, { no_weeks: 0, no_sections: 0, no_day: 0 },
    '打印版不该有任何被丢弃的课次');
  eq(r.meta.className, '示例专业A1班', '抓到行政班级（给操作者确认没粘错班）');
  eq(r.meta.declaredCourseCount, undefined,
    '打印版只写学期、不写「课程门数」⇒ 这一版不做门数对账（版面差异，别误加断言）');
  eq(r.warnings, [], '无丢弃、无对账冲突 ⇒ 不该有警告');
  ok(r.sessions.every(function (s) { return !/\s\d+$/.test(s.room); }),
    '教室末尾的「上课人数」必须剥掉（否则会当成教室号的一部分）');

  const at = (day, period) => r.sessions.filter(s => s.dayOfWeek === day && s.period === period);
  const byWeeks = (arr) => arr.slice().sort((a, b) => a.weeks.localeCompare(b.weeks, 'en'));

  // ① 双周独立成词："[5-12]周 双周"
  const xszc = at(1, 1);
  eq(xszc.map(s => s.weeks), ['6,8,10,12'], '① 形势与政策5 = 5-12 双周');
  eq(xszc[0] && xszc[0].room, '3号教学楼208', '① 教室（人数 112 已被剥掉）');
  eq(xszc[0] && xszc[0].teacher, '示例老师01', '① 教师');

  // ② 同一格换教师：示例老师02 1-8 周 / 示例老师04 9-16 周
  const wk = byWeeks(at(1, 4));
  eq(wk.length, 2, '② 周一第4大节 微课设计与制作 拆成两条');
  eq(wk[0] && wk[0].teacher, '示例老师02', '② 前半学期教师');
  eq(wk[0] && wk[0].weeks, '1,2,3,4,5,6,7,8', '② 前半学期周次');
  eq(wk[1] && wk[1].teacher, '示例老师04', '② 后半学期教师');
  eq(wk[1] && wk[1].weeks, '9,10,11,12,13,14,15,16', '② 后半学期周次');

  // ③ 同一格换教室：3号教学楼305 → 3号教学楼112
  const sx = byWeeks(at(2, 2));
  eq(sx.length, 2, '③ 周二第2大节 小学数学课程与教学论 拆成两条');
  eq(sx[0] && sx[0].room, '3号教学楼305', '③ 前 4 周教室');
  eq(sx[0] && sx[0].weeks, '1,2,3,4', '③ 前 4 周');
  eq(sx[1] && sx[1].room, '3号教学楼112（科学教育实验室）', '③ 第 5 周起换教室');
  eq(sx[1] && sx[1].weeks, '5,6,7,8,9,10,11,12,13,14,15,16', '③ 第 5 周起');

  // ④ 单/双周各占一间教室（逗号列表）
  const xl = at(3, 3).map(s => s.weeks).sort();
  eq(xl, ['1,3,5,7,9,11,13,15', '2,4,6,8,10,12,14,16'], '④ 周三第3大节 单双周两间教室');

  // ⑤ 混合列表 + 单周，外加一门只上第 13 周的课（换到精神谱系馆）
  const xjp = byWeeks(at(4, 3));
  eq(xjp.map(s => s.weeks), ['1,3,5,7,9,11,15', '13'], '⑤ 「[1-12,14-16]周 单周」+「[13]周」');
  eq(xjp[1] && xjp[1].room, '精神谱系馆', '⑤ 第 13 周单独换到精神谱系馆');

  // ⑥ 同一门课分布在两个大节
  eq(r.sessions.filter(s => s.name === '三笔字').map(s => s.dayOfWeek + ':' + s.period).sort(),
    ['2:5', '5:1'], '⑥ 三笔字 = 周二第5大节 + 周五第1大节');

  ok(r.sessions.every(function (s) { return s.dayOfWeek <= 5; }), '这一班周六周日没排课');
}

console.log('\n[13b] 打印版 flat 文本解析（&ensp; 分隔的一行 = 一门课）');
{
  // &ensp; 的解码发生在上游 stripTags 里，parseFlatCourse 只吃纯文本 —— 两层各测一次
  eq(T.stripTags('高等数学&ensp;张三&ensp;[5-12]周&ensp;双周'),
    '高等数学 张三 [5-12]周 双周', '&ensp; 必须解码成空格（打印版全靠它分隔字段）');

  const one = T.parseFlatCourse('高等数学 张三 [5-12]周 双周 1-2节 3号教学楼208 112');
  ok(!!one, '能解析一行 flat 文本');
  eq(one && one.name, '高等数学', '课程名');
  eq(one && one.teacher, '张三', '教师');
  eq(one && one.room, '3号教学楼208', '末尾的「112」是上课人数，必须剥掉');
  eq(one && one.weeks, [6, 8, 10, 12], '双周 5-12');
  eq(one && one.periods, [1], '小节 1-2 → 大节 1');

  const two = T.parseFlatCourse('体育 李四 [1-16]周 7-8节 综合实验楼二区302（数码钢琴实训室03） 28');
  eq(two && two.periods, [4], '小节 7-8 → 大节 4（不能算成大节 3）');
  eq(two && two.room, '综合实验楼二区302（数码钢琴实训室03）', '带全角括号的教室名要整段保留');

  const three = T.parseFlatCourse('大学英语 王五 [1-16]周 1-4节 外语楼203 60');
  eq(three && three.periods, [1, 2], '跨大节 1-4节 → 大节 1、2 各一条');

  eq(T.parseFlatCourse('上午'), null, '非课程行（表头「上午」）返回 null，不能当课');
  eq(T.parseFlatCourse(''), null, '空行返回 null');
}

console.log('\n[13c] 打印版：手写夹具验证「列位置 = (星期, 大节)」');
{
  const r = T.parse(PRINT_MINI);
  eq(r.layout, 'print', '手写打印版识别为 print');
  eq(r.sessions.length, 2, '两门课（周一第1大节 + 周六第4大节），实际=' + r.sessions.length);
  const gao = r.sessions.find(s => s.name === '高等数学');
  eq(gao && [gao.dayOfWeek, gao.period], [1, 1], '列 1 = 周一第1大节');
  eq(gao && gao.weeks, '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16', '1-16 周');
  const ty = r.sessions.find(s => s.name === '体育');
  eq(ty && [ty.dayOfWeek, ty.period], [6, 2], '列 29 = 周六第4大节，小节 3-4 → 大节 2');
  eq(ty && ty.weeks, '1,2,3,4,5,6,7,8', '1-8 周');
  eq(ty && ty.room, '操场', '教室');
  eq(r.meta.className, '软件工程示例班级C', '班级名后的「(30)」是人数，要剥掉');
}

console.log('\n[13d] 打印版：查出多个行政班级必须拦住');
{
  let e = '';
  try { T.parse(PRINT_TWO); } catch (err) { e = err.message; }
  ok(/一次只能导入一个班/.test(e), '两个班直接报错，实际=' + e);
  ok(/2604班/.test(e), '报错里要点名是哪几个班（操作者才知道要重选），实际=' + e);
}

/* ============ 变异自证 ============ */
console.log('\n[10] 变异自证（改坏后门禁必须变红）');

const MUT_FILE = path.join(__dirname, '.mut-html-parser.js');

function runMutated(label, from, to, probe) {
  const mutated = src.replace(from, to);
  if (mutated === src) {
    fail++;
    console.log('  ✗ 变异[' + label + '] 锚点未命中，自证无效');
    return;
  }
  try {
    new Function('module', 'exports', 'require', mutated)(
      { exports: {} }, { exports: {} }, require
    );
  } catch (e) {
    fail++;
    console.log('  ✗ 变异[' + label + '] 源码语法非法（等于假自证）：' + e.message);
    return;
  }
  fs.writeFileSync(MUT_FILE, mutated, 'utf8');
  let broken = false;
  try {
    delete require.cache[require.resolve(MUT_FILE)];
    const M = require(MUT_FILE);
    broken = probe(M);
  } catch (e) {
    broken = true;
  } finally {
    try { fs.unlinkSync(MUT_FILE); } catch (e) {}
  }
  ok(broken, '变异[' + label + ']：改坏后门禁应报错（坏实现不能通过）');
}

// M1：不剥「含节次」的括号组（括号里以非数字开头时，只能靠这条规则）
runMutated('周次括号组',
  "      .replace(/[（(\\[][^）)\\]]*节[^）)\\]]*[）)\\]]/g, '')",
  "      .replace(/__NEVER_MATCH__/g, '')",
  (M) => M.parseWeeks('9周(第1-2节)').join(',') !== '9');

// M2：单/双周「独立成词」分支丢掉边界（变成裸关键字匹配）
runMutated('单双周边界',
  "    var reStandalone = /(?:^|[\\s,，;（(])([单双])(?=$|[\\s,，;）)\\]" + "\\[(（])/g;",
  "    var reStandalone = /([单双])/g;",
  (M) => M.parseWeeks('1-16周 双创楼').length !== 16);

// M2b：删掉「独立成词」分支 —— 青果网页的 "5-12 双 [1-2]" 会退化成全周
runMutated('独立成词的单双周',
  "    while ((m = reStandalone.exec(t)) !== null) found = m[1] || found;",
  "    /* mutated */",
  (M) => M.parseWeeks('5-12 双 [1-2]').length !== 4);

// M2c：周次取子串丢了「紧贴节次括号」这条最强规则
//       —— 真实样本里 "13[5-6] 精神谱系馆" 这门单周课会整门消失（17 → 16 条）
runMutated('紧贴括号的周次',
  "    if ((m = reBeforeBracket.exec(raw))) {",
  "    if (false) {",
  (M) => M.weekField('13[5-6] 精神谱系馆') !== '13' ||
    keySet(M.parse(REAL_HTML).sessions).split(' ').length !== 17);

// M3：反向索引改正向
const GRID_KEYS = [
  '体育|5|1', '数据结构|2|2', '线性代数|4|2', '大学英语|3|1', '高等数学|1|1'
].sort().join(' ');
const keySet = (sessions) => sessions.map(s => s.name + '|' + s.dayOfWeek + '|' + s.period).sort().join(' ');

runMutated('反向索引',
  "        var reverseIdx = cells.length - 1 - c;",
  "        var reverseIdx = c;",
  (M) => keySet(M.parse(GRID_EXTRA_HTML).sessions) !== GRID_KEYS);

// M4：大节换算不再跨大节拆分
runMutated('跨大节拆分',
  "  for (var p = ps; p <= pe && p <= MAX_PERIOD; p++) out.push(p);",
  "  out.push(ps);",
  (M) => M.toPeriods([1, 4]).length !== 2 || M.parse(LIST_HTML).sessions.filter(s => s.name === '体育').length !== 2);

// M5：丢弃计数被吞
runMutated('丢弃计数',
  "    drop: function (reason) { this.count[reason] = (this.count[reason] || 0) + 1; }",
  "    drop: function (reason) { }",
  (M) => {
    const html = '<table><tr><th>课程名称</th><th>星期</th><th>节次</th><th>周次</th></tr>' +
      '<tr><td>没周次的课</td><td>星期一</td><td>1-2节</td><td></td></tr>' +
      '<tr><td>正常的课</td><td>星期二</td><td>1-2节</td><td>1-16周</td></tr></table>';
    const r = M.parse(html);
    return r.stats.dropped.no_weeks !== 1;
  });

// M6：课程门数对账被删 —— 漏课会静悄悄通过（这是本门禁最值钱的一条防线）
runMutated('课程门数对账',
  "    if (meta.declaredCourseCount && courseList.length !== meta.declaredCourseCount) {",
  "    if (false) {",
  (M) => {
    const doc = REAL_HTML.replace(
      /<div style='padding-bottom:5px;clear:both;'><font style='font-weight: bolder'>三笔字<\/font>[\s\S]*?<\/div>/,
      '');
    return M.parse(doc).warnings.length === 0;
  });

/* --- 打印版（第四种版面）专属变异 --- */

// M7：打印版与网格的顺序调换 —— 被网格用反向索引抢走会整体错位。
//     夹具 PRINT_MINI 特意把一门课放在「周六第4大节」：网格的反向索引
//     恰好把这一列误认成周一 ⇒ 网格会先产出垃圾并提前结束。
runMutated('打印版先于网格',
  "      ['print', parsePrintLayout],\n      ['grid', parseGridLayout],",
  "      ['grid', parseGridLayout],\n      ['print', parsePrintLayout],",
  (M) => M.parse(PRINT_MINI).layout !== 'print' || M.parse(PRINT_MINI).sessions.length !== 2);

// M8：实体解码丢了 &ensp; —— 打印版全靠 &ensp; 分隔字段，拿掉就一行都切不开
runMutated('ensp 实体解码',
  "    s = s.replace(/&nbsp;|&ensp;|&emsp;|&#13;|&#10;/gi, ' ')",
  "    s = s.replace(/&nbsp;/gi, ' ')",
  (M) => { try { return M.parse(PRINT_HTML).sessions.length !== 25; } catch (e) { return true; } });

// M9：不剥末尾的「上课人数」
runMutated('剥上课人数',
  "    var room = String(m[7] || '').replace(/\\s+\\d+\\s*$/, '').trim();",
  "    var room = String(m[7] || '').trim();",
  (M) => {
    const s = M.parse(PRINT_HTML).sessions.filter(x => x.name === '形势与政策5')[0];
    return !s || s.room !== '3号教学楼208';
  });

// M10：课次去重被删 —— 打印版同一条课次渲染两次，会莫名多出 3 条
runMutated('课次去重',
  "      if (seenSession[skey]) { dup++; continue; }",
  "      /* mutated */",
  (M) => {
    const r = M.parse(PRINT_HTML);
    return r.sessions.length !== 25 || r.stats.deduped !== 3;
  });

// M11：星期格的 colspan 不展开 —— 列→星期整体错位
runMutated('星期 colspan 展开',
  "      for (var k = 0; k < (row1[c].colspan || 1); k++) dayByCol[col++] = d || 0;",
  "      dayByCol[col++] = d || 0;",
  (M) => {
    const r = M.parse(PRINT_MINI);
    const ty = r.sessions.find(s => s.name === '体育');
    return r.sessions.length !== 2 || !ty || ty.dayOfWeek !== 6 || ty.period !== 2;
  });

// M12：副表头（上午/下午/晚上）的 colspan 不展开 —— 列→大节 错位
runMutated('副表头 colspan 展开',
  "      for (var k2 = 0; k2 < (row2[c].colspan || 1); k2++) {",
  "      for (var k2 = 0; k2 < 1; k2++) {",
  (M) => M.parse(PRINT_HTML).sessions.length !== 25);

// M13：查出多个班不拦 —— 别班的课会被写进本班
runMutated('多班级拦截',
  "    if (classRows.length > 1) {",
  "    if (false) {",
  (M) => { try { M.parse(PRINT_TWO); return true; } catch (e) { return false; } });

console.log('\n通过 ' + pass + ' / ' + (pass + fail));
if (fail) {
  console.log('✗ 门禁 77 不通过');
  process.exit(1);
}
console.log('✓ 门禁 77 通过');
