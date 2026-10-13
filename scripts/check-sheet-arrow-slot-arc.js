#!/usr/bin/env node
/**
 * 第 68 个门禁：弹层左上角箭头 / 请假时段三选一 / 归档角标宽度
 * =================================================================
 * 2026-10-09 用户实拍三条需求合设。三条都**没有报错、没有异常**，
 * 每一条都能"看起来做完了"却在某处静默失效，所以本门禁守的是**性质**不是像素。
 *
 * ① 弹层左上角箭头（用户原话：「所有弹窗左上角都有个箭头」）
 *    ------------------------------------------------------------------
 *    ⚠️ **箭头不是弹层里的元素** —— bottom-sheet / duty-sheet / dialog 三个组件
 *       内部都没有任何箭头。它是**页面 nav-bar 的返回按钮**从弹层左上角透出来。
 *    🔴 **物理上遮不住**：遮罩是 rgba(0,0,0,0.45)，**盖不暗一个亮色图标**；
 *       面板本身是半透明玻璃（rgba(255,255,255,0.72) + blur），
 *       把面板上移过去也只是把箭头从「遮罩后」挪到「玻璃后」，**仍然隐约可见**。
 *       （用户一开始选的正是「面板上移盖住」，实测不可行后才改成隐藏。）
 *    ✅ 唯一真解法 = **弹层打开时不渲染返回键**：nav-bar 组件加 `sheetOpen` 属性，
 *       wxml 判据 `showBack && !sheetOpen`。
 *    ⚠️ 本条最容易的失效方式：**某个带 show-back 的页面忘了接 sheet-open**
 *       ⇒ 那个页面的箭头又冒出来，而其他页都正常 ⇒ 极难联想到是漏接一行。
 *       所以下面按源码扫**全部**带 show-back 的页面，一个都不许漏。
 *
 * ② 请假时段：全天 / 上午 / 下午 / 晚上 四选一（前三档用户：「很多人都用不明白」；晚上 2026-10-12 补）
 *    ------------------------------------------------------------------
 *    · 钟点**写死**（上午 08:00–12:00 / 下午 13:00–18:00 / 晚上 18:00–21:00），页面只存 key。
 *    · 🔴 **判据极性 = 选中值必须先过白名单**：`setData({ leaveSlot: e.detail.key })`
 *      会让任意 key 写进 leaveSlot，而 `slotOf()` 对未知 key **回落到「全天」**
 *      —— 看着是安全兜底，实际是把「用户点了个不存在的档位」静默变成整天假。
 *    · 🔴 `<segmented>` 的契约是 `triggerEvent('change', { key })`，handler **必须读
 *      `e.detail.key`**。读 `.value` / `dataset` 拿到 undefined ⇒「点了没反应」
 *      （首页「查看名单」踩过；check-segmented.js 也守这条，本门禁做交叉确认）。
 *    · ⚠️ 后端口径**不变**（start_time/end_time 仍是区间内每天相同时段，两列空 = 整天）
 *      ⇒ 这是**纯前端**改动，**不需要重新部署云函数**。本门禁钉住「没碰后端」。
 *    · ⚠️ 历史行也要显示短标签，而 WXML **不能调方法** ⇒ 必须有 `slotText` 字段
 *      （在 JS 里算好）。少了它则新 UI 显示短标签、历史显示旧长串，两处不一致。
 *
 * ③ 归档角标「N 天清除」（用户：「7 天后清除这条太长了」）
 *    ------------------------------------------------------------------
 *    · `.lv-arc` 是 `display:inline-block` 且**本来没有宽度上限** ⇒ 文案变长就无限
 *      撑开，把同一行右侧的假条缩略图顶到边上（用户截图里就是这么花的）。
 *    · 缩短文案只是治标（天数将来若改，同一处穿帮再来一次）⇒ 必须同时钉 `max-width`。
 *
 * 变异自证（8 组，每组都必须被抓，否则是自欺）：
 *   M1 nav-bar 判据去掉 `!sheetOpen`（箭头又透出来）
 *   M2 某个页面漏接 sheet-open（逐页抽）
 *   M3 onLeaveSlot 去掉白名单校验（任意 key 都能写进 leaveSlot）
 *   M4 onLeaveSlot 改读 dataset（segmented 只 emit key ⇒ 点了没反应）
 *   M5 钟点写死改成可被外部改写（leaveSlot 不再是唯一真源）
 *   M6 历史行缺 slotText（新旧两处显示不一致）
 *   M7 .lv-arc 去掉 max-width（长文案又撑开挤掉缩略图）
 *   M8 文案改回「N 天后清除」（用户实拍过的宽度问题回归）
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

const NAV_WXML = 'miniprogram/components/nav-bar/index.wxml';
const NAV_JS = 'miniprogram/components/nav-bar/index.js';
const ROSTER_JS = 'miniprogram/pages/roster/index.js';
const ROSTER_WXML = 'miniprogram/pages/roster/index.wxml';
const ROSTER_WXSS = 'miniprogram/pages/roster/index.wxss';

const navWxml = read(NAV_WXML);
const navJs = read(NAV_JS);
const js = read(ROSTER_JS);
const wxml = read(ROSTER_WXML);
const wxss = read(ROSTER_WXSS);

/* ------------------------------------------------------------------ */
console.log('── ① 弹层左上角箭头：物理上遮不住，只能不渲染');

chk(/sheetOpen:\s*\{\s*type:\s*Boolean,\s*value:\s*false\s*\}/.test(navJs),
  'nav-bar 有 sheetOpen 属性且**默认 false**（默认关 ⇒ 没弹层的页不受影响）');
chk(/wx:if="\{\{showBack && !sheetOpen\}\}"/.test(navWxml),
  '⚠️⚠️ 返回键判据是 `showBack && !sheetOpen`（弹层开着就不渲染 —— 遮罩/玻璃都遮不住它）');
chk(!/wx:if="\{\{showBack\}\}"/.test(navWxml),
  '⚠️⚠️ 不存在裸的 `wx:if="{{showBack}}"`（那会把 sheetOpen 白改，箭头照样透出来）');

/* ⚠️ 本门禁最重要的一条：**所有**带 show-back 的页面都必须接 sheet-open。
 * 漏一个 ⇒ 那个页面箭头又冒出来，而其他页正常 ⇒ 极难联想到是漏接一行。 */
const pagesDir = path.join(ROOT, 'miniprogram/pages');
const pageFiles = fs.readdirSync(pagesDir)
  .filter((d) => fs.existsSync(path.join(pagesDir, d, 'index.wxml')))
  .map((d) => 'miniprogram/pages/' + d + '/index.wxml');

const backPages = [];
const missingSheet = [];
const noSheetNeeded = [];
pageFiles.forEach((f) => {
  const t = read(f);
  // 带返回按钮 = nav-bar 标签里出现 show-back（无论 true 还是插值）
  const m = /<nav-bar\b[\s\S]*?>/.exec(t);
  if (!m) return;
  if (!/show-back/.test(m[0])) return;
  // 🔴 只有「**贴左上角的底部弹层**」才需要 sheet-open：
  //    `<dialog>` 是**居中**弹窗（z-index 1100），面板不贴左上角 ⇒ 不会穿出箭头。
  if (!/<bottom-sheet\b/.test(t) && !/<duty-sheet\b/.test(t)) {
    noSheetNeeded.push(f.split('/')[2]);
    return;
  }
  backPages.push(f);
  if (!/sheet-open/.test(m[0])) missingSheet.push(f);
});
chk(backPages.length >= 5,
  '扫到「带 show-back 且有底部弹层」的页面 ' + backPages.length + ' 个（'
  + backPages.map((f) => f.split('/')[2]).join('/') + '）');
chk(missingSheet.length === 0,
  '⚠️⚠️ 每个「带 show-back 且有底部弹层」的页面都接了 sheet-open —— 漏接：'
  + (missingSheet.length ? missingSheet.map((f) => f.split('/')[2]).join(', ') : '无'));
// 反向自证：确实存在「带返回键但**不需要** sheet-open」的页
//   （bind 用的是居中 dialog、doc 根本没弹层）
// ⇒ 证明上面那条判据做了区分，不是「一律要求接」蒙对的。
chk(noSheetNeeded.indexOf('doc') >= 0,
  '自证：doc 页（带 show-back 但**无任何弹层**）被正确排除，不判它漏接');
chk(noSheetNeeded.indexOf('bind') >= 0,
  '自证：bind 页（带 show-back 但用的是**居中 dialog**）被正确排除');

/* 页面上的 sheet-open 表达式必须覆盖该页**全部**弹层标志。
 * 判据：与同页 page-meta 的表达式比对（page-meta 已列了全部 show 标志，是现成真源）。
 * ⚠️ page-meta 的表达式**可能没有外层括号**（单标志时作者常写成
 *    `{{pickerShow ? ... }}`），所以要把「有括号」和「无括号」两种形态都认掉，
 *    否则 manual 页会被误判成「没有 page-meta 可核对」（第一版就踩了）。 */
pageFiles.forEach((f) => {
  const t = read(f);
  const m = /<nav-bar\b[\s\S]*?>/.exec(t);
  if (!m || !/sheet-open/.test(m[0])) return;
  const page = f.split('/')[2];
  // 两种形态：{{(a || b)}} 与 {{a}}
  let flags = null;
  let m1 = /page-meta[^>]*page-style="\{\{\(([^)]*)\)/.exec(t);
  if (m1) flags = m1[1].match(/[A-Za-z]+Show/g) || [];
  else {
    const m2 = /page-meta[^>]*page-style="\{\{\s*([A-Za-z]+Show)\s*\?/.exec(t);
    if (m2) flags = [m2[1]];
  }
  if (!flags) {
    fail(page + '：sheet-open 接了，但本页没有 page-meta 表达式可核对（无法确认覆盖全）');
    return;
  }
  const navExpr = /sheet-open="\{\{([^}]*)\}\}"/.exec(m[0]);
  const navTxt = navExpr ? navExpr[1] : '';
  const lack = flags.filter((x) => navTxt.indexOf(x) < 0);
  chk(lack.length === 0,
    page + '：sheet-open 覆盖 page-meta 里全部 ' + flags.length + ' 个弹层标志'
    + (lack.length ? '（漏：' + lack.join(', ') + '）' : ''));
});

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② 请假时段 = 全天 / 上午 / 下午 / 晚上 四选一');

chk(/const LEAVE_SLOTS = \[/.test(js),
  'LEAVE_SLOTS 是时段档位的**唯一真源**（页面只存 key，钟点写死在这里）');
const slotBlock = /const LEAVE_SLOTS = \[([\s\S]*?)\n\];/.exec(js);
chk(!!slotBlock, '能定位 LEAVE_SLOTS 数组');
if (slotBlock) {
  const b = slotBlock[1];
  chk(/key:\s*'all'/.test(b) && /key:\s*'am'/.test(b) && /key:\s*'pm'/.test(b) && /key:\s*'eve'/.test(b),
    "四档齐全：'all' / 'am' / 'pm' / 'eve'（2026-10-12 补「晚上」）");
  chk(/key:\s*'am'[\s\S]*start:\s*'08:00'[\s\S]*end:\s*'12:00'/.test(b),
    "⚠️ 上午 = 08:00–12:00（用户 2026-10-09 定的作息）");
  chk(/key:\s*'pm'[\s\S]*start:\s*'13:00'[\s\S]*end:\s*'18:00'/.test(b),
    "⚠️ 下午 = 13:00–18:00");
  chk(/key:\s*'eve'[\s\S]*start:\s*'18:00'[\s\S]*end:\s*'21:00'/.test(b),
    "⚠️⚠️ 晚上 = 18:00–21:00（2026-10-12 用户定）；钟点写错整档就废了");
  // ⚠️ 档序断言：必须 all → am → pm → eve。`wx:elif` 分支与 slotLabel 的回退遍历都依赖这个顺序。
  const order = (b.match(/key:\s*'(\w+)'/g) || []).map((s) => s.replace(/[^']*'(\w+)'.*/, '$1'));
  chk(order.join(',') === 'all,am,pm,eve',
    '档序必须是 all,am,pm,eve（wxml 的 wx:elif 与 slotLabel 的遍历都按序匹配）');

  /*
   * 运行时真跑 slotLabel —— 加「晚上」这一档的**核心价值**就在这里：
   * 历史请假记录里存的是 `18:00–21:00`，要能反推显示成「晚上」而不是原文钟点。
   * 静态断言（档位齐全 / 钟点写对）覆盖不到这段运行时行为，必须真跑一次。
   * 做法：从源码原样抠出 LEAVE_SLOTS 与 slotLabel，用 new Function 组装执行
   *      （不在门禁里抄第二份实现，否则改了真源门禁还在绿 = 假闸）。
   */
  const lblFn = /function slotLabel\(startTime, endTime\) \{[\s\S]*?\n\}/.exec(js);
  chk(!!lblFn, '能定位 slotLabel 函数（历史时段 → 短标签）');
  if (lblFn) {
    try {
      const f = new Function('const LEAVE_SLOTS = [' + b + '\n];\n' + lblFn[0] + '\nreturn slotLabel;')();
      chk(f('18:00', '21:00') === '晚上', '真跑：18:00–21:00 → 「晚上」（新档的核心）');
      chk(f('08:00', '12:00') === '上午', '真跑：08:00–12:00 → 「上午」（没被新档挤掉）');
      chk(f('13:00', '18:00') === '下午', '真跑：13:00–18:00 → 「下午」（没被新档挤掉）');
      chk(f('', '') === '', '真跑：整天假（两列空）不显示时段');
      chk(f('08:30', '11:30') === '08:30–11:30', '真跑：旧数据任意钟点未命中档位 → 显示原文（不谎报成某一档）');
    } catch (e) {
      bad('slotLabel 真跑抛错（档位数组或函数体形态变了）：' + e.message);
    }
  }
}

/* ⚠️ 加到第四档后 `<segmented>` 的 width 必须显式给足：组件默认 320rpx 等分，
 *    三档 107rpx/格 → 四档只剩 80rpx/格，「全天」两字在选中态（30rpx 字号）左右只剩 ~10rpx。 */
const segSlot = /<segmented[^>]*items="\{\{leaveSlotOpts\}\}"[\s\S]*?\/>/.exec(wxml);
chk(!!segSlot, '能定位请假时段的 <segmented>');
if (segSlot) {
  chk(/width="\{\{440\}\}"/.test(segSlot[0]),
    '⚠️⚠️ 请假时段 segmented 显式 width=440（四档 × 110rpx ≈ 原三档密度；漏了会挤到「全天」两字放不下）');
}
/* `pm` 必须显式 wx:elif：否则晚上档会被 wx:else 接住、显示成下午的文案 */
chk(/wx:elif="\{\{leaveSlot === 'pm'\}\}"/.test(wxml),
  "⚠️⚠️ 下午是显式 wx:elif（新增「晚上」后 wx:else 归晚上；不显式写 pm 会被 else 吃掉）");
chk(/wx:elif="\{\{leaveSlot === 'eve'\}\}"/.test(wxml) || /晚上 = 每天 18:00–21:00/.test(wxml),
  '晚上档的提示文案存在（wx:else 兜底即可，但文案必须写对钟点）');

/* 旧的三件套必须**彻底消失**（不是留着当死代码） */
const dead = ['leaveHalf', 'leaveStartTime', 'leaveEndTime', 'onLeaveTimeOpen', 'onLeaveAllDay'];
// 注释里可以提（说明历史），但不能出现在**代码**里：剥掉注释后再查
const stripCode = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
const jsCode = stripCode(js);
const wxmlCode = stripCode(wxml);
dead.forEach((d) => {
  chk(jsCode.indexOf(d) < 0 && wxmlCode.indexOf(d) < 0,
    '⚠️ 旧字段/旧 handler `' + d + '` 已彻底删除（不是留着当死代码）');
});
chk(/<picker mode="time"/.test(wxmlCode) === false,
  '⚠️ 两个 time picker 已移除（三选一后没有手动选时分的入口）');

/* handler：必须读 e.detail.key + 必须过白名单 */
const slotFn = /onLeaveSlot\(e\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!slotFn, '能定位 onLeaveSlot');
if (slotFn) {
  const b = slotFn[1];
  chk(/e\.detail\s*\?\s*e\.detail\.key/.test(b),
    '⚠️ 读 e.detail.key（segmented 只 emit key；读 dataset ⇒ 永远 undefined ⇒ 点了没反应）');
  chk(!/currentTarget/.test(b),
    '⚠️⚠️ 不读 currentTarget.dataset（segmented 不把 key 放 dataset，这里读了恒为空）');
  chk(/LEAVE_SLOTS[\s\S]*indexOf\(k\)\s*<\s*0\s*\)\s*return/.test(b),
    '⚠️⚠️ 选中值**先过白名单**再 setData（否则任意 key 写进 leaveSlot ⇒ slotOf 静默回落成整天假）');
  chk(/this\.setData\(\{ leaveSlot: k \}/.test(b),
    'setData 的是白名单校验**之后**的 k');
  chk(/_resizeLeaveSheet\(\)/.test(b),
    '改档位后补一次 resizeScroll（弹层内容高度变了）');
}

/* UI：用全站同一套 <segmented>，且 items 契约是 [{key, text}] */
chk(/<segmented\b[\s\S]*?value="\{\{leaveSlot\}\}"/.test(wxml),
  'UI 用 <segmented value="{{leaveSlot}}">（与全站同一套控件，动画手感一致）');
chk(/items="\{\{leaveSlotOpts\}\}"/.test(wxml),
  '⚠️ items 来自 data 字段 leaveSlotOpts（**不能内联数组字面量** ⇒ 每次 setData 生成新数组会打断 segmented 两拍动画）');
chk(/bind:change="onLeaveSlot"/.test(wxml), 'bind:change 接到 onLeaveSlot');
chk(/label: s\.label/.test(js) || /text: s\.label/.test(js),
  '⚠️ leaveSlotOpts 的字段映射用 label（LEAVE_SLOTS 里是 label，映射到 segmented 要 text）');
chk(/text: s\.label/.test(js), "⚠️ leaveSlotOpts 映射成 { key, text }（segmented 的契约字段是 **text**，不是 label）");

/* 提交：钟点来自 slotOf(leaveSlot)，且后端字段名不变 */
const pickFn = /onLeavePick\(e\)\s*\{([\s\S]*?)\n  \},\n/.exec(js);
chk(!!pickFn, '能定位 onLeavePick');
if (pickFn) {
  const b = pickFn[1];
  chk(/const slot = slotOf\(leaveSlot\);/.test(b),
    '⚠️ 提交前 `const slot = slotOf(leaveSlot)` 字面取档位（**不能**写成 `this.data.leaveTimes || slotOf(...)` —— 那样页面又持有第二份时段数据，前端变成第二个真源）');
  chk(/startTime:\s*slot\.start/.test(b) && /endTime:\s*slot\.end/.test(b),
    '⚠️ payload 用 slot.start / slot.end（钟点只有一个来源 ⇒ 前端不存具体时分）');
  chk(!/leaveEndTime <= leaveStartTime/.test(jsCode),
    "⚠️ 旧的「结束时间必须晚于开始时间」校验已删除（钟点写死后恒不成立 ⇒ 死代码）");
chk(!/leaveTimes/.test(jsCode),
    '⚠️ 页面 data 里不再持有任何具体时分字段（钟点唯一真源是 LEAVE_SLOTS）');
}

/* 历史行：必须有 slotText（WXML 不能调方法） */
chk(/slotText:\s*slotLabel\(/.test(js),
  '⚠️ JS 里算好 slotText = slotLabel(...)（WXML 不能调方法，不算就没有这个字段）');
const slotTxtUse = (wxmlCode.match(/\{\{item\.slotText \? ' ' \+ item\.slotText : ''\}\}/g) || []).length;
chk(slotTxtUse >= 4,
  '⚠️ wxml 用 {{item.slotText}} 渲染时段（' + slotTxtUse + ' 处；仍是旧写法 {{item.startTime}} 的行会显示长串）');
chk(!/item\.startTime \? ' ' \+ item\.startTime/.test(wxmlCode),
  '⚠️⚠️ 不再有 `{{item.startTime}}` 拼钟点的旧写法（那样新 UI 显示短标签、历史显示长串，两处不一致）');

/* slotLabel 的反推规则：命中档位用短标签，没命中回原文（不能谎报） */
const labelFn = /function slotLabel\(startTime, endTime\)\s*\{([\s\S]*?)\n\}/.exec(js);
chk(!!labelFn, '能定位 slotLabel');
if (labelFn) {
  const b = labelFn[1];
  chk(/if \(!s && !e\) return '';/.test(b),
    "⚠️ 整天假（两列都空）返回空串 ⇒ 行内不显示任何时段后缀");
  chk(/for\s*\(let i = 1;/.test(b),
    '⚠️ 反推**从第 1 档开始**（跳过 all：整天没有钟点，撞上会误标）');
  chk(/return s \+ '–' \+ e;/.test(b),
    '⚠️ 没命中任何档位时**回显原钟点**（旧数据是用户手输的任意时间，匹配不上不能谎报成半天）');
}

/* ⚠️ 纯前端改动 ⇒ 后端不该被碰 */
chk(!/LEAVE_SLOTS|leaveSlot|slotLabel/.test(read('cloudfunctions/adjust/index.js')),
  '⚠️ 后端 adjust 未被改动（后端口径不变 ⇒ 这是纯前端改动，不需要重新部署云函数）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ③ 归档角标「N 天清除」');

const arcFn = /\.lv-arc\s*\{([^}]*)\}/.exec(wxss);
chk(!!arcFn, 'wxss 有 .lv-arc 规则');
if (arcFn) {
  const b = arcFn[1];
  chk(/max-width:\s*\d+rpx/.test(b),
    '⚠️⚠️ .lv-arc 有 max-width（它是 inline-block，没上限就会随文案撑开、把右侧缩略图挤出去）');
  chk(/overflow:\s*hidden/.test(b) && /white-space:\s*nowrap/.test(b) && /text-overflow:\s*ellipsis/.test(b),
    '⚠️ 配套 overflow:hidden + nowrap + ellipsis（只写 max-width 不会省略，会被容器裁出半个字）');
}
chk(/clearInDays > 0 \? \(x\.clearInDays \+ ' 天清除'\)/.test(jsCode),
  "⚠️⚠️ 文案是「N 天清除」而不是「N 天后清除」（用户实拍「这条太长了」）");
chk(!/天后清除/.test(jsCode),
  '⚠️ 不再出现「天后清除」（文案改回去了 = 宽度问题回归）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ④ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

/** 跑判据，返回失败条数；只用于变异对比 */
function judge(over) {
  const o = over || {};
  const vNavWxml = o.navWxml || navWxml;
  const vNavJs = o.navJs || navJs;
  const vJs = o.js || js;
  const vWxml = o.wxml || wxml;
  const vWxss = o.wxss || wxss;
  const vPages = o.pages || null;
  let n = 0;
  const push = (c) => { if (!c) n += 1; };

  // ① nav-bar
  push(/sheetOpen:\s*\{\s*type:\s*Boolean,\s*value:\s*false\s*\}/.test(vNavJs));
  push(/wx:if="\{\{showBack && !sheetOpen\}\}"/.test(vNavWxml));
  push(!/wx:if="\{\{showBack\}\}"/.test(vNavWxml));
  // 逐页：带 show-back 且有**底部弹层**的都必须接 sheet-open
  //（dialog 居中不贴左上角 ⇒ 不需要，否则 bind 页会被误判成漏接）
  // ⚠️ `vPages` 既是**文件列表**（基线）又是**内容覆盖表**（页面级变异），
  //    两种形态都支持：`Array.isArray` 分开走，否则下面的 forEach 会挂在对象上。
  //    （第一版只写了数组一种，页面级变异一跑就 `scan.forEach is not a function`。）
  const files = vPages && !Array.isArray(vPages) ? pageFiles : (vPages || pageFiles);
  const table = (vPages && !Array.isArray(vPages)) ? vPages : null;
  let missing = 0;
  files.forEach((f) => {
    const t = (table && table[f]) ? table[f] : read(f);
    const m = /<nav-bar\b[\s\S]*?>/.exec(t);
    if (!m) return;
    if (!/show-back/.test(m[0])) return;
    if (!/<bottom-sheet\b/.test(t) && !/<duty-sheet\b/.test(t)) return;
    if (!/sheet-open/.test(m[0])) missing += 1;
  });
  push(missing === 0);

  // ② 时段
  const sb = /const LEAVE_SLOTS = \[([\s\S]*?)\n\];/.exec(vJs);
  push(!!sb);
  if (sb) {
    const b = sb[1];
    push(/key:\s*'all'/.test(b) && /key:\s*'am'/.test(b) && /key:\s*'pm'/.test(b));
    push(/key:\s*'am'[\s\S]*start:\s*'08:00'[\s\S]*end:\s*'12:00'/.test(b));
    push(/key:\s*'pm'[\s\S]*start:\s*'13:00'[\s\S]*end:\s*'18:00'/.test(b));
  }
  const vCode = stripCode(vJs);
  const vWxmlCode = stripCode(vWxml);
  ['leaveHalf', 'leaveStartTime', 'leaveEndTime', 'onLeaveTimeOpen', 'onLeaveAllDay']
    .forEach((d) => push(vCode.indexOf(d) < 0 && vWxmlCode.indexOf(d) < 0));
  push(!/<picker mode="time"/.test(vWxmlCode));
  const hf = /onLeaveSlot\(e\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!hf);
  if (hf) {
    const b = hf[1];
    push(/e\.detail\s*\?\s*e\.detail\.key/.test(b));
    push(!/currentTarget/.test(b));
    push(/LEAVE_SLOTS[\s\S]*indexOf\(k\)\s*<\s*0\s*\)\s*return/.test(b));
    push(/_resizeLeaveSheet\(\)/.test(b));
  }
  push(/<segmented\b[\s\S]*?value="\{\{leaveSlot\}\}"/.test(vWxml));
  push(/items="\{\{leaveSlotOpts\}\}"/.test(vWxml));
  push(/bind:change="onLeaveSlot"/.test(vWxml));
  push(/text: s\.label/.test(vJs));
  const pf = /onLeavePick\(e\)\s*\{([\s\S]*?)\n  \},\n/.exec(vJs);
  push(!!pf);
  if (pf) {
    const b = pf[1];
    // ⚠️ 判据必须**字面**要求 `const slot = slotOf(leaveSlot);` 这一句。
    //    「含有 slotOf(leaveSlot) 字样」太宽：写成
    //    `const slot = this.data.leaveTimes || slotOf(leaveSlot)` 仍能通过，
    //    但那样**页面又持有了第二份时段数据**（前端变成第二个真源）⇒ 判据失效。
    push(/const slot = slotOf\(leaveSlot\);/.test(b));
    push(/startTime:\s*slot\.start/.test(b) && /endTime:\s*slot\.end/.test(b));
    // 钟点只能来自 LEAVE_SLOTS（页面 data 里不许再存具体时分）
    push(!/leaveStartTime|leaveEndTime|leaveTimes/.test(b));
  }
  // 全局：页面 data 里不再持有任何具体时分字段
  push(!/leaveTimes/.test(vCode));
  push(!/leaveEndTime <= leaveStartTime/.test(vCode));
  push(/slotText:\s*slotLabel\(/.test(vJs));
  const stu = (vWxmlCode.match(/\{\{item\.slotText \? ' ' \+ item\.slotText : ''\}\}/g) || []).length;
  push(stu >= 4);
  push(!/item\.startTime \? ' ' \+ item\.startTime/.test(vWxmlCode));
  const lf = /function slotLabel\(startTime, endTime\)\s*\{([\s\S]*?)\n\}/.exec(vJs);
  push(!!lf);
  if (lf) {
    const b = lf[1];
    push(/if \(!s && !e\) return '';/.test(b));
    push(/for\s*\(let i = 1;/.test(b));
    push(/return s \+ '–' \+ e;/.test(b));
  }

  // ③ 角标
  const af = /\.lv-arc\s*\{([^}]*)\}/.exec(vWxss);
  push(!!af);
  if (af) {
    const b = af[1];
    push(/max-width:\s*\d+rpx/.test(b));
    push(/overflow:\s*hidden/.test(b) && /white-space:\s*nowrap/.test(b) && /text-overflow:\s*ellipsis/.test(b));
  }
  push(/clearInDays > 0 \? \(x\.clearInDays \+ ' 天清除'\)/.test(vCode));
  push(!/天后清除/.test(vCode));
  return n;
}

const MUT = [
  {
    name: 'M1 nav-bar 判据去掉 !sheetOpen（箭头又从弹层左上角透出来）',
    apply: () => ({ navWxml: navWxml.replace('showBack && !sheetOpen', 'showBack') })
  },
  {
    // ⚠️ 这模拟的是最真实的事故形态：**只漏一页**，其他页都正常 ⇒
    //    线上表现是「成员页有箭头、首页没有」，极难联想到是漏接一行。
    //    （用**单页覆盖表**而不是全局 replace —— 全局改会让 5 页一起红，
    //     判据就测不出「漏一页」这个真实场景。）
    //
    // 🔴 变异手法必须是**删掉整个属性**而不是改名（`sheet-open=` → `sheet-opened=`）：
    //    改名之后 `/sheet-open/` 判据**仍然为真**（它是 `sheet-opened` 的子串）⇒
    //    变异体没被真正改坏，门禁测不到「漏接」⇒ 假自证。第一版就栽在这。
    name: 'M2 只漏 roster 一页的 sheet-open（单页漏接 ⇒ 该页箭头又冒出来，其他页正常）',
    pagesMutate: (t, f) => (f.indexOf('/roster/') >= 0
      ? t.replace(/\s+sheet-open="\{\{[^}]*\}\}"/, '')
      : t)
  },
  {
    name: 'M3 onLeaveSlot 去掉白名单校验（任意 key 都能写进 leaveSlot ⇒ slotOf 静默回落成整天假）',
    apply: () => ({
      js: js.replace(/if \(LEAVE_SLOTS\.map\(\(s\) => s\.key\)\.indexOf\(k\) < 0\) return;.*\n/, '')
    })
  },
  {
    name: 'M4 onLeaveSlot 改读 currentTarget.dataset（segmented 只 emit key ⇒ 恒为空 ⇒ 点了没反应）',
    apply: () => ({
      js: js.replace('const k = e.detail ? e.detail.key : \'\';',
        'const k = (e.currentTarget && e.currentTarget.dataset) ? e.currentTarget.dataset.k : \'\';')
    })
  },
  {
    name: 'M5 钟点不再写死（改成页面自己持有 leaveTimes ⇒ 前端成了第二个真源）',
    apply: () => ({
      js: js.replace('const slot = slotOf(leaveSlot);',
        'const slot = this.data.leaveTimes || slotOf(leaveSlot);')
    })
  },
  {
    name: 'M6 历史行缺 slotText（新 UI 显示短标签、历史显示旧长串 ⇒ 两处不一致）',
    apply: () => ({
      wxml: wxml.replace(/\{\{item\.slotText \? ' ' \+ item\.slotText : ''\}\}/g, "{{item.startDate}}")
    })
  },
  {
    name: 'M7 .lv-arc 去掉 max-width（长文案又撑开、把右侧假条缩略图挤出去）',
    apply: () => ({ wxss: wxss.replace(/max-width: 200rpx;\n/, '') })
  },
  {
    name: 'M8 角标文案改回「N 天后清除」（用户实拍过的宽度问题回归）',
    apply: () => ({ js: js.replace("+ ' 天清除'", "+ ' 天后清除'") })
  }
];

let caught = 0;
MUT.forEach((c) => {
  // ⚠️ **每组变异跑之前先确认基线为 0**：基线非 0 说明「判据与实现已漂移」，
  //    此时「抓到变异」毫无意义（可能是那条本来就红的判据在背锅）⇒ 单独判死。
  const before = judge();
  if (before !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try {
    // ⚠️ 绝不用 sed -i（本机 Git Bash 的 /tmp 不可写 ⇒ 变异静默失败 ⇒ **假自证**）。
    //    一律在**内存**里改写后交给 judge。
    if (c.pagesMutate) {
      // 页面级变异：整页内容改写成覆盖表，judge 用 vPages 读它
      const patched = {};
      pageFiles.forEach((f) => { patched[f] = c.pagesMutate(read(f), f); });
      over.pages = patched;
    }
    if (c.apply) over = Object.assign(over, c.apply());
  } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  let n;
  try {
    n = judge(over);
  } catch (e) {
    fail('变异「' + c.name + '」跑挂了（' + e.message + '）—— 变异体必须能真跑');
    bad += 1;
    return;
  }
  if (n > 0) { ok('变异「' + c.name + '」被门禁抓到（' + n + ' 条判据翻红）'); caught += 1; }
  else { fail('变异「' + c.name + '」**没被抓到** —— 判据失效'); bad += 1; }
});

if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) {
  console.log('[FAIL] ' + bad + ' 项未通过');
  process.exit(1);
}
console.log('[PASS] 弹层箭头/请假时段/归档角标体检全部通过');