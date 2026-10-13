// 历史请假筛选 + 按日期分组（1.0.7）
// 行为级门禁：抽真方法体、注入假 this、内存里真跑；末尾带变异自证。
//
// ⚠️ 抽取器踩过的四个坑（都不是源码的锅，写下免得再犯）：
//  ① 不剥注释 → JSDoc 里的 `{...}` 示例被当成方法体起点，切出语法残片；
//  ② 剥了注释却拿原文同下标去切 → 长度变化导致错位（**定位和切片都用 stripped**）；
//  ③ 只切 `{…}` 不带方法名 → 生成 `return _foo() {…}`，语法错误；
//     对象方法简写**只在对象字面量里合法**，必须改写成 `function _foo() {…}`；
//  ④ 用箭头函数包 → 箭头没有自己的 this，页面里是 this.xxx() 调的，会炸。
//     另外 `new Function(dep, …)` 返回的是**工厂**，要先调用它拿函数再 .call。
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();

/* ============ 抽方法 ============ */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/** 抽出 `  name(...) { … }` 整个方法（含方法名与签名） */
function method(fileSrc, name) {
  const st = stripComments(fileSrc);
  const i = st.indexOf('\n  ' + name + '(');
  if (i < 0) throw new Error('找不到方法 ' + name);
  const k = st.indexOf('{', i);
  let d = 0;
  for (let j = k; j < st.length; j++) {
    if (st[j] === '{') d++;
    else if (st[j] === '}') { d--; if (d === 0) return st.slice(i + 1, j + 1).trim(); }
  }
  throw new Error(name + ' 方法体没闭合');
}

/** 对象方法简写 → 普通 function，然后注入依赖编译出来 */
function compile(fileSrc, name, deps) {
  const names = deps || [];
  const raw = method(fileSrc, name);
  const m = /^([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/.exec(raw);
  if (!m) throw new Error('方法签名解析失败：' + raw.slice(0, 60));
  // m[0] 以 `{` 结尾 ⇒ 从 m[0].length - 1 接，别把左花括号丢了
  const plain = 'function ' + m[1] + '(' + m[2] + ') ' + raw.slice(m[0].length - 1);
  const factory = names.length
    ? new Function(names.join(','), 'return (' + plain + ');')
    : new Function('return (' + plain + ');');
  return names.length ? factory.apply(null, [util]) : factory();
}

/* ================= util 真跑（别用假实现，否则测的是假数据） ================= */
const utilSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/util.js'), 'utf8');
function utilMethod(name) {
  const st = stripComments(utilSrc);
  const i = st.indexOf('function ' + name);
  if (i < 0) throw new Error('util 找不到 ' + name);
  const k = st.indexOf('{', i);
  let d = 0;
  for (let j = k; j < st.length; j++) {
    if (st[j] === '{') d++;
    else if (st[j] === '}') { d--; if (d === 0) return st.slice(i, j + 1); }
  }
  throw new Error('util.' + name + ' 没闭合');
}
const util = new Function('module',
  utilMethod('pad') + utilMethod('parseDate') + utilMethod('fmtDate') +
  utilMethod('todayStr') + utilMethod('dateAddDays') +
  'return { todayStr, dateAddDays };')({});

/* ================= 假页面 ================= */
/** 五个方法互相调用（_applyHistoryFilter → _historyFiltered / _histDateLabel → _histWeekday，
 *  _applyHistoryFilter → _histMatch），必须全挂上，少挂一个就报 not a function。 */
const METHODS = [
  ['_historyFiltered', []],
  ['_histWeekday', []],
  ['_histSub', []],
  ['_histDateLabel', ['util']],
  ['_histMatch', []],
  ['_applyHistoryFilter', ['util']]
];

function makePage(data, srcOverride) {
  const fileSrc = srcOverride === undefined ? pageSrc : srcOverride;
  const p = {
    data,
    setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb(); },
    _resizeLeaveSheet() {}
  };
  METHODS.forEach(([n, deps]) => { p[n] = compile(fileSrc, n, deps); });
  return p;
}

/* ================= 固定夹具（今天 = 2026-10-08 周四） =================
 * ⚠️ LIST 必须**严格按后端真实排序**摆放：`start_date DESC, RIGHT(student_no,2) DESC, id DESC`。
 *    分组「组序天然倒序」是**依赖**这个前置排序的（代码里没再排一次）——
 *    夹具随手按「日期聚类」写就会让组序断言失败，而那次失败其实是**夹具不对**、
 *    不是代码错了（本人踩过一次，白查半天）。下面有断言把该契约钉住。 */
const TODAY = '2026-10-08';
const mk = (id, name, seq, start, end) => ({
  leaveId: id, memberId: id, name, seq, studentNo: '20260101' + seq,
  startDate: start, endDate: end, startTime: '', endTime: '',
  state: 'ENDED', stateText: '已结束', hasImage: false, image: '',
  imageArchived: false, clearInDays: null, createdAt: '2026-10-01 10:00'
});
const LIST = [
  mk(3, '王五', '03', '2026-10-08', '2026-10-11'),
  mk(2, '李四', '02', '2026-10-08', '2026-10-09'),
  mk(1, '张三', '01', '2026-10-08', '2026-10-08'),
  mk(4, '赵六', '04', '2026-10-07', '2026-10-07'),
  /* 🔴 2026-10-09 追加两条，为「短学号**归一整段相等** vs 归一后**子串**」造可观测差异。
   * 原有6 条的序号只有 01~06，**没有 10/11/21** ⇒ 无论第2 路写相等还是子串，
   * 搜「1」都只命中 1 条 ⇒ 那条判据**区分不了**（本轮真踩：门禁报"判据失效"）。
   * 加上 11 / 21 之后：归一整段相等 ⇒ 搜「1」**仍只 1 条**；
   *子串写法 ⇒ nz('11')='11'.indexOf('1')=0 ⇒ **命中 3 条**。
   * ⚠️ 必须放在**后端排序的准确位置**（start_date DESC, RIGHT(no,2) DESC, id DESC）：
   *    10-06 在 10-07 之后、10-05 在 10-02 之前。乱插会让「组序严格倒序」那条失败，
   *    而那次失败是**夹具不对**、不是代码错了（上方注释已警告过这点）。 */
  mk(8, '赵八', '11', '2026-10-06', '2026-10-06'),
  mk(9, '钱九', '21', '2026-10-05', '2026-10-05'),
  mk(6, '周八', '06', '2026-10-02', '2026-10-02'),
  mk(5, '孙七', '05', '2026-09-20', '2026-09-20')
];
const MEMBERS = LIST.map((x) => ({ id: x.memberId, name: x.name, seq: x.seq, studentNo: x.studentNo }));

const pageSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/roster/index.js'), 'utf8');

function run(over, srcOverride) {
  const p = makePage(Object.assign({
    leaveHistory: LIST, histToday: TODAY,
    histFrom: '', histTo: '', histRange: '', histKw: '', histMembers: [],
    members: MEMBERS
  }, over || {}), srcOverride);
  p._applyHistoryFilter();
  // 挂回实例本身：断言里偶尔要直接调页面方法（如 _histSub 的边界输入），
  // 只返回 data 会让那些断言写成 false（page._histSub undefined）而不是真失败。
  p.data.__page = p;
  return p.data;
}

/* ================= 全部断言（好样本与变异样本共用同一份） =================
 * ⚠️ 第二个参数 srcOverride：变异自证时整套断言要在**变异源码**上重跑，
 * 所以每一处 run() 都得把它透传下去 —— 只让某一个方法用变异源码是不够的。 */
function allAssertions(chk, srcOverride) {
  const R = (over) => run(over, srcOverride);
  /* ① 按开始日期分组 */
  let d = R();
  chk(d.leaveHistGroups.length === 6, '分成 6 组（10-08/10-07/10-06/10-05/10-02/09-20；⚠️ 10-06 与 10-05 两组是为「短学号归一 vs 子串」加的专属夹具，见 LIST.push 注释）');
  chk(d.leaveHistGroups[0].key === '2026-10-08' && d.leaveHistGroups[0].count === 3, '首组 = 10-08 且 3 条');
  chk(d.leaveHistCount === 8, '总数 8 条（6 条原始夹具 + 11/21 两条差异探针）');
  chk(d.histAny === false, '未筛选时 histAny = false');
  chk(d.leaveHistGroups.map((g) => g.key).join(',') === '2026-10-08,2026-10-07,2026-10-06,2026-10-05,2026-10-02,2026-09-20',
    '组序严格倒序（依赖后端 start_date DESC，代码内不再排一次）');

  /* ② 跨天假只出现一次（分类键 = 开始日期） */
  chk(d.leaveHistGroups[0].items.length === 3, '10-08 组含 3 条（李四/王五的跨天假各只算一次）');
  const lisi = d.leaveHistGroups[0].items.filter((x) => x.name === '李四')[0];
  chk(lisi.startDate === '2026-10-08' && lisi.endDate === '2026-10-09', '跨天假保留完整区间 10-08~10-09');

  /* ③ 今天 / 昨天标签与星期 */
  chk(d.leaveHistGroups[0].label === '今天 · 周四', '今天那组标「今天 · 周四」');
  chk(d.leaveHistGroups[1].label === '昨天 · 周三', '昨天那组标「昨天 · 周三」');
  const g1002 = d.leaveHistGroups.filter((g) => g.key === '2026-10-02')[0];
  chk(g1002 && g1002.label === '10月2日 周五', '更早的标「10月2日 周五」（不写年份）');

  /* ③b 行内日期文本 subText（**逐条**算，同组内不同人的 endDate 可以不同） */
  const g0 = d.leaveHistGroups[0];
  const zhangsan = g0.items.filter((x) => x.name === '张三')[0];
  const lisi2 = g0.items.filter((x) => x.name === '李四')[0];
  const wangwu = g0.items.filter((x) => x.name === '王五')[0];
  chk(zhangsan.subText === '10-08', '单日假行内 = 「10-08」（**去掉年份**，组头已写全）');
  chk(lisi2.subText === '10-08 ~ 10-09', '跨天假行内 = 「10-08 ~ 10-09」');
  chk(wangwu.subText === '10-08 ~ 10-11', '长跨天假行内 = 「10-08 ~ 10-11」');
  chk(zhangsan.subText !== lisi2.subText && lisi2.subText !== wangwu.subText,
    '🔴 同一组内三条 subText 互不相同（按组算一个 sub 会让整组显示成同一范围）');
  chk(g1002 && g1002.items[0].subText === '10-02', '更早那组行内 = 「10-02」');
  chk(d.__page._histSub('2026-09-29', '2027-01-03') === '9-29 ~ 2027-01-03',
    '跨年假行内结束日期**带年份**（否则「今年9月29日到1月3日」读不出跨年）');
  chk(d.__page._histSub('2026-10-08', '') === '10-08' && d.__page._histSub('', '') === '', 'endDate 缺失时退回单日');

  /* ④ 快捷时段：近 7 天（含今天 ⇒ 从 10-02 起） */
  d = R({ histRange: '7' });
  chk(d.leaveHistGroups.length === 5, '近 7 天 = 5 组（10-08/10-07/10-06/10-05/10-02）');
  chk(d.leaveHistCount === 7, '近 7 天 = 7 条（10-08 三条 + 10-07/10-06/10-05 各一条 + 10-02 一条；09-20 被排除）');
  chk(d.histFromShow === '2026-10-02' && d.histToShow === TODAY, 'picker 回显 2026-10-02 → 今天');
  chk(d.histAny === true, 'histAny = true');

  /* ⑤ 近 30 天含全部（09-20 距今 18 天） */
  d = R({ histRange: '30' });
  chk(d.leaveHistCount === 8, '近 30 天 = 8 条（全部）');

  /* ⑥ 日期区间（按开始日期判，与分类键同口径） */
  d = R({ histFrom: '2026-10-08', histTo: '2026-10-08' });
  chk(d.leaveHistCount === 3, '只看 10-08 = 3 条');
  d = R({ histFrom: '2026-10-02', histTo: '2026-10-07' });
  chk(d.leaveHistCount === 4, '10-02~10-07 = 4 条（10-02/10-05/10-06/10-07；10-08 那组被排除）');
  d = R({ histFrom: '2026-09-20', histTo: '2026-09-20' });
  chk(d.leaveHistCount === 1, '09-20 单日 = 1 条（单日假不塌成两行）');

  /* ⑦ 快捷时段优先于区间（交互上互斥，这里兜底） */
  d = R({ histRange: '7', histFrom: '2026-09-20', histTo: '2026-09-20' });
  chk(d.histFromShow === '2026-10-02', '两者都在时以快捷时段为准');

  /* ⑧ 人员筛选（多选） */
  d = R({ histMembers: [1, 4] });
  chk(d.leaveHistCount === 2, '选张三+赵六 = 2 条');
  chk(d.histPickedMap[1] === true && d.histPickedMap[4] === true, 'histPickedMap 标记选中');
  chk(d.histPickedMap[2] === undefined, '未选的人不在 map 里（WXML 用它判高亮，不能调方法）');
  chk(d.histPickedNames.length === 2 && d.histPickedNames[0].name.indexOf('张三') === 0,
    '胶囊回显名字（不是裸 id）');

  /* ⑨ 人员搜索（姓名 / 短学号 / 全学号） */
  d = R({ histKw: '李四' });
  chk(d.leaveHistCount === 1, '搜姓名「李四」= 1 条');
  d = R({ histKw: '03' });
  chk(d.leaveHistCount === 1, '搜短学号「03」= 1 条（王五，不牵连学号里含 03 的其他人）');
  d = R({ histKw: '20260101' });
  chk(d.leaveHistCount === 8, '搜全学号前缀 = 8 条（全员，≥4 位走模糊那路）');
  /* ⚠️ 下面两条是「短学号整段相等」唯一的**可观测**判据：
 *   学号里含同样的数字（2026010101 里就有 '01'），所以「短学号用子串」与
 *   「短学号整段相等」在搜完整学号前缀时**结果完全相同**、互相掩盖。
 *   只有搜**单个序号**（'0' / '1'）这种极短输入才会暴露差异 ——
 *   整段相等时一个人都搜不到（没人的序号恰是 '0'），用子串则捞出一堆。
 *   （变异「短学号退回子串」就是靠这两条被抓到的，别删。） */
  d = R({ histKw: '0' });
  chk(d.leaveHistCount === 0, '搜单字符「0」= 0 条（整段相等：没人的序号恰是 0；若用子串会捞出一堆）');
  /* 🔴 2026-10-09 用户实拍「1 号只能搜 01，而不能只搜 1，1-9 号都是如此」：
   * seq 是 pad2 补零的（1 号 => '01'），所以「输 1」必须与「输 01」**等价**。
   * 判据直接钉这条：两者结果必须完全相同。
   * ⚠️ 这也顺带钉住了「归一不是子串」—— 若实现改成`nz(sq).indexOf(nz(kw)) >= 0`，
   *    输 '1' 会把 01/10/11/21… 全捞出来，下面这条立刻红。 */
  d = R({ histKw: '1' });
  chk(d.leaveHistCount === 1 && d.leaveHistGroups[0].items[0].name === '张三',
    '🔴⚠️⚠️ 搜单字符「1」= 1 条且与搜「01」**完全等价**（用户实拍：1 号不能只搜 1 就搜不到）；'
    + '⚠️ 退化成子串则会把 10/11/21 等一并捞出');
  d = R({ histKw: '01' });
  chk(d.leaveHistCount === 1 && d.leaveHistGroups[0].items[0].name === '张三', '搜完整短号「01」= 1 条（张三；子串写法会把学号含 01 的 5 人都捞出来）');
  // 其余 2~9 号同理：补零输入与裸数字输入必须等价
  ['2', '3', '4', '5', '6', '7', '8', '9'].forEach((n) => {
    const bare = R({ histKw: n });
    const padded = R({ histKw: ('0' + n) });
    chk(bare.leaveHistCount === padded.leaveHistCount,
      '序号「' + n + '」：裸数字与补零写法结果一致（' + bare.leaveHistCount + ' 条）');
  });
  /* 🔴 能唯一区分「归一后**整段相等**」与「归一后**子串**」的判据：
   * 搜「0」在归一整段相等下必须 **0 条**（没人的序号是 0），
   * 而在**子串**写法下 `nz(sq).indexOf('0')` —— 序号 '01'归一成'1'不含 '0'，
   *   看似也 0 条，**区分不了**。
   *   ⇒ 真正能区分的是「**全学号模糊那路**」：它对 '0' 仍然会命中
   *     `sno.indexOf('0') >= 0`（学号 20260101**01** 里含 0），
   *     但那条路有 `kw.length >= 4` 的门槛 ⇒ 单字符不该命中。
   *所以判据落在**单字符 '0' 的结果必须是 0** 这条上：它同时要求
   *   「短学号不相等」且「全学号模糊对单字符不生效」两件事。
   *   ⚠️ 若把第 2 路改成子串，'1' 会命中 '10'/'11'/'21' 等 ⇒ 上面那条
   *      「序号 N 裸数字与补零等价」会被打破吗？不会 —— 两边都变多。
   *      所以再加一条**绝对值**判据：搜 '1' 必须**恰好 1 条**。*/
  chk(R({ histKw: '1' }).leaveHistCount === 1,
    '🔴 搜「1」必须恰好 1 条（子串写法会把序号 10/11/21… 一并捞出 ⇒ 变多条）');
  chk(R({ histKw: '2' }).leaveHistCount === 1,
    '🔴 搜「2」必须恰好 1 条（同上：不能靠子串命中别的序号）');

  /* ⑩ 组合条件（AND 叠加，不是互相覆盖） */
  d = R({ histRange: '7', histMembers: [1, 2, 3] });
  chk(d.leaveHistCount === 3, '近 7 天 ∩ 张三李四王五 = 3 条');
  d = R({ histRange: '7', histKw: '01' });
  chk(d.leaveHistCount === 1, '近 7 天 ∩ 短学号01（张三）= 1 条（短学号整段相等 + 全学号限长）');
  d = R({ histFrom: '2026-10-08', histTo: '2026-10-08', histMembers: [4] });
  chk(d.leaveHistCount === 0, '10-08 ∩ 赵六（他在 10-07）= 0 条（空态可显示）');

  /* ⑪ 空结果 */
  d = R({ histKw: '查无此人' });
  chk(d.leaveHistCount === 0 && d.leaveHistGroups.length === 0, '搜不到 = 0 条 0 组');
  chk(d.histAny === true, '空结果下 histAny 仍为 true（空态要区别「无记录」与「无匹配」）');

  /* ⑫ 候选列表与筛选口径必须一致（同一个人不能「候选里有、结果里没有」） */
  const p = makePage({ members: MEMBERS, histKw: '01', histMembers: [], histFrom: '', histTo: '', histRange: '', leaveHistory: LIST, histToday: TODAY }, srcOverride);
  const cand = (p.data.members || []).filter((m) => p._histMatch(m.name, m.seq, m.studentNo, '01'));
  chk(cand.length === 1 && cand[0].name === '张三', '候选列表与筛选同口径：搜「01」只出张三');
}

/* ================= 跑断言 + 打印 ================= */
let bad = 0;
let printed = false;
function selfTest(override) {
  const fails = [];
  try {
    allAssertions((cond, label) => { if (!cond) fails.push(label); });
  } catch (e) {
    fails.push('运行期异常：' + e.message);
  }
  if (!printed) {
    printed = true;
    // 首次跑把逐条结论打出来（好样本路径）
    let n = 0;
    try {
      allAssertions((cond, label) => { n++; if (!cond) console.log('  ✗ ' + label); });
      console.log('  ✓ ' + n + ' 条断言全部通过（分组 / 区间 / 快捷时段 / 人员多选 / 搜索 / 组合 / 空态 / 候选同口径）');
    } catch (e) { /*上面已报*/ }
  }
  return fails;
}

console.log('── ① 历史请假筛选 + 按日期分组（行为级）');
const goodFails = selfTest();
if (goodFails.length) {
  console.log('');
  console.log('❌ 失败 ' + goodFails.length + ' 项');
  process.exit(1);
}

/* ================= 变异自证 =================
 * 在内存副本上做（不落盘；绝不用 sed -i —— 本机 /tmp 不可写会让变异静默失败、变假通过）。
 * 每条先断言「锚点命中、替换后源码真的变了」，否则是自欺。
 * 比对方式：变异后失败数必须比好样本（0）大。 */
console.log('');
console.log('── ② 变异自证：改坏一处必须被抓到');

const MUT = [
  { name: '区间下界「>= from」改成「> from」（边界当天被漏掉）',
    from: 'if (from && x.startDate < from) return false;',
    to: 'if (from && x.startDate <= from) return false;' },
  { name: '区间上界改用 endDate 判（与分类键 start_date 不同口径 ⇒ 跨天假跑到别的组）',
    from: 'if (to && x.startDate > to) return false;',
    to: 'if (to && x.endDate > to) return false;' },
  { name: '近 N 天少一天（from = today - N，第 7 天整组被漏掉）',
    from: 'from = util.dateAddDays(today, -(n - 1));',
    to: 'from = util.dateAddDays(today, -n);' },
  { name: '快捷时段不再覆盖区间（两套口径打架）',
    from: 'if (d.histRange) {',
    to: 'if (false) {' },
  { name: '人员筛选从「任一命中」改成「全部命中」（多选直接归零）',
    from: 'if (picked.length && picked.indexOf(Number(x.memberId)) < 0) return false;',
    to: 'if (picked.length && picked.indexOf(Number(x.memberId)) < 0) return true;' },
  // ⚠️ 锚点2026-10-09 更新：`_histMatch` 的短学号判定从「字面相等」改成了
  //    **去前导零归一后相等**（修「1 号只能搜 01、不能搜 1」）。改实现必须同步改这里，
  //    否则锚点漂移 ⇒ 这组自证变成假的（本门禁自己报了「锚点已漂移」，是对的）。
  { name: '短学号从「归一整段相等」退回子串（搜 01 捞出全班）',
    from: 'if (nz(sq) === nz(kw)) return true;',
    to: 'if (nz(sq).indexOf(nz(kw)) >= 0) return true;' },
  // 🔴 本轮真 bug 的反向：去掉归一 ⇒ 输「1」搜不到序号 01 的人（用户实拍）
  { name: '短学号去掉「去前导零归一」（输 1 搜不到 01 的人 —— 用户 2026-10-09 实拍）',
    from: 'if (nz(sq) === nz(kw)) return true;',
    to: "if (String(sq) === String(kw)) return true;" },
  { name: '全学号模糊不限长（搜 01 命中所有人，短学号入口失效）',
    from: 'return kw.length >= 4 && sno.indexOf(kw) >= 0;',
    to: 'return sno.indexOf(kw) >= 0;' },
  { name: '分组键从 startDate 改成 endDate（跨天假挪到别的组）',
    from: "const k = x.startDate || '';",
    to: "const k = x.endDate || '';" },
  { name: '分组丢 count（组头数字与组内条数对不上）',
    from: 'count: map[k].length,',
    to: 'count: 0,' },
  { name: '「今天」标签恒不生效',
    from: "if (ds === today) return '今天 · ' + this._histWeekday(ds);",
    to: "if (false) return '今天 · ' + this._histWeekday(ds);" },
  { name: '星期整体偏移一天',
    from: "return '周' + ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];",
    to: "return '周' + ['日', '一', '二', '三', '四', '五', '六'][(d.getDay() + 1) % 7];" },
  // 下面两条守 1.0.7 新增的「行内日期 subText」
  { name: 'subText 退回「按组算一个」（同组内不同人的假显示成同一段范围）',
    from: "items: map[k].map((x) => Object.assign({}, x, {\n        subText: this._histSub(x.startDate, x.endDate)\n      }))",
    to: "items: map[k].map((x) => Object.assign({}, x, {\n        subText: this._histSub(k, k)\n      }))" },
  { name: 'subText 跨年丢年份（今年 9/29 请到明年 1/3 读不出跨年）',
    from: "return s + ' ~ ' + (sy !== ey ? endDate : e);",
    to: "return s + ' ~ ' + e;" }
];

MUT.forEach((c) => {
  if (pageSrc.indexOf(c.from) < 0) {
    console.log('  ✗ 变异「' + c.name + '」锚点已漂移 —— 自证失效，需同步更新锚点');
    bad++;
    return;
  }
  const mutated = pageSrc.split(c.from).join(c.to);
  if (mutated === pageSrc) {
    console.log('  ✗ 变异「' + c.name + '」替换后源码没变（锚点重复？）');
    bad++;
    return;
  }
  // ⚠️ 必须让整套断言在**变异源码**上重跑（run 接受 srcOverride）——
  //只跑一条断言是不够的：「改坏 A 可能只被 B 那条断言发现」。
  const fails = [];
  try {
    allAssertions((cond, label) => { if (!cond) fails.push(label); }, mutated);
  } catch (e) {
    fails.push('运行期异常：' + e.message);
  }
  if (fails.length) console.log('  ✓ 变异「' + c.name + '」被门禁抓到（' + fails.length + ' 条断言翻红）');
  else { console.log('  ✗ 变异「' + c.name + '」未被抓到 —— 判据失效！'); bad++; }
});
if (!bad) console.log('  ✓ ' + MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
console.log(bad ? '❌ 失败 ' + bad + ' 项'
  : '✓ 历史请假筛选 + 分组行为全部符合预期（' + MUT.length + ' 组变异自证通过）');
process.exit(bad ? 1 : 0);