/**
 * 门禁：班委职位（POSITIONS）前后端同步
 * ------------------------------------------------------------
 * 背景（2026-09-26，v0.7.9 需求②）：
 *   「设置班委」的职位是**枚举**：前端只让人选这 7 个，后端只接受这 7 个。
 *   一旦两侧漂移（前端加了新职位、后端没加），用户会看到「选了却保存失败」，
 *   而且报错文案还很抽象（41001 参数错误）。所以把「两份清单必须逐字一致」变成门禁。
 *
 * 同时校验：
 *   ① 云函数 member 的 POSITIONS 与 miniprogram/utils/util.js 的 POSITIONS 完全一致；
 *   ② 前端不允许再各写一份职位字面量（home / roster 都必须走 util.POSITIONS）；
 *   ③ member.setPosition 存在，且带有两道保护（不改超管、不改辅导员）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };

function extractPositions(src, label) {
  const m = /const\s+POSITIONS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return null;
  const list = (m[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1));
  if (!list.length) { bad(label + ' 的 POSITIONS 解析为空'); return null; }
  return list;
}

console.log('── ① 前后端职位清单逐字一致');
const beSrc = read('cloudfunctions/member/index.js');
const feSrc = read('miniprogram/utils/util.js');

const be = extractPositions(beSrc, 'cloudfunctions/member');
const fe = extractPositions(feSrc, 'utils/util.js');

if (!be) bad('cloudfunctions/member/index.js 找不到 POSITIONS');
if (!fe) bad('miniprogram/utils/util.js 找不到 POSITIONS');

if (be && fe) {
  if (be.length === fe.length && be.every((x, i) => x === fe[i])) {
    ok('两份清单一致（' + be.length + ' 项：' + be.join(' / ') + '）');
  } else {
    bad('职位清单不一致！\n      后端: ' + be.join(' / ') + '\n      前端: ' + fe.join(' / '));
  }
  // 与库里实际口径对齐（示例班级A 7 名班委职位，2026-09-26 核对）
  const EXPECT = ['班长兼团支书', '副班长', '学习委员', '生活委员', '组织宣传委员', '文体委员', '心理委员'];
  if (be && EXPECT.every((x, i) => be[i] === x) && be.length === EXPECT.length) {
    ok('与库内实际职位口径一致');
  } else if (be) {
    bad('与库内实际职位口径不一致（期望 ' + EXPECT.join(' / ') + '）');
  }
}

console.log('\n── ② 前端不得再各写一份职位字面量');
// ⚠️ 2026-10-27 归位：NOTICE_POSITION_PRESETS 随发布表单搬到 pages/notice/publish
[['miniprogram/pages/notice/publish/index.js', 'NOTICE_POSITION_PRESETS'],
['miniprogram/pages/roster/index.js', 'posList']].forEach(([p, name]) => {
  const s = read(p);
  if (/util\.POSITIONS/.test(s)) ok(p + ' 复用 util.POSITIONS');
  else bad(p + ' 没有使用 util.POSITIONS（职位清单禁止在本页硬编码）');
  // 页面上不应再出现职位字面量的数组（除注释）
  const literal = /\[[^\]]*'班长兼团支书'[^\]]*\]/.test(s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''));
  if (literal) bad(p + ' 仍存在职位字面量数组（应改为 util.POSITIONS）');
  else ok(p + ' 无硬编码职位数组（' + name + '）');
});

console.log('\n── ③ member.setPosition 存在且带保护');

/**
 * 取 `anchor` 之后第一个配对花括号块。
 * 为什么必须这么做（2026-09-27，需求 D）：旧判据拿**整份文件**匹配
 * `/requireSuperOrCounselor\(ctx\)/`，于是「只要别处出现过这个串」就算通过 ——
 * 需求 D 把两个授权职位（生活委员 / 班长兼团支书）的**授予权单独收紧到超管**后，
 * 这条判据依然绿（else 分支还留着一个 `requireSuperOrCounselor`），
 * 但它已经**不再描述意图**：授予权被整段删掉也查不出来。判据必须限定在函数体内。
 */
function braceBlockOf(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  /*
   * ⚠️ -1 不能省：anchor 自己就以 `{` 结尾，起点必须**正好落在那个 `{`** 上。
   * 若写成 `indexOf('{', i + anchor.length)` 就会往后找，命中路由对象里的
   * 第一个小括号块（`auth: { needBind: true }`）→ 拿到的「函数体」只有
   * `{ needBind: true }` → 判据全数假红（2026-09-27 实测踩到）。
   */
  const open = i + anchor.length - 1;
  if (src[open] !== '{') return '';
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}

/**
 * 「setPosition 授权保护」维度的判据（源码入 → 失败码数组出）。
 * 抽成函数是为了让 §④ 的变异自证能复用**同一套判据**（自证抽生产源码，不写副本）。
 */
function judgeGrant(src) {
  const out = [];
  const blk = braceBlockOf(src, '\n  setPosition: {');
  if (!blk) { out.push('route'); return out; }
  if (!/requireSuperOrCounselor\(ctx\)/.test(blk)) out.push('base-tier');
  if (!/guard\.isGrantedPosition\(\s*position\s*\)/.test(blk)) out.push('grant-new');
  if (!/guard\.isGrantedPosition\(\s*t\.position\s*\)/.test(blk)) out.push('grant-target');
  if (!/guard\.requirePositionGrant\(\s*ctx\s*\)/.test(blk)) out.push('grant-only-super');
  // 授予权校验必须在**写库之前**（先放行再补校验 = 后门照样通）
  const gi = blk.indexOf('isGrantedPosition');
  const ui = blk.indexOf('UPDATE member SET role');
  if (gi < 0 || ui < 0 || gi > ui) out.push('order');
  return out;
}

const grantFails = judgeGrant(beSrc);
const grantOk = code => !grantFails.includes(code);

if (grantOk('route')) ok('member 有 setPosition 路由'); else bad('member 缺少 setPosition 路由');
if (/position\s*&&\s*POSITIONS\.indexOf\(position\)\s*<\s*0/.test(beSrc)) ok('setPosition 校验职位是否在枚举内');
else bad('setPosition 没有校验职位枚举');
if (/is_super\s*===\s*1\)\s*throw/.test(beSrc)) ok('setPosition 拒绝修改超级管理员');
else bad('setPosition 缺少「不改超管」保护');
if (/group_tag\s*===\s*'X'\)\s*throw/.test(beSrc)) ok('setPosition 拒绝修改辅导员');
else bad('setPosition 缺少「不改辅导员」保护');
if (grantOk('base-tier')) ok('setPosition 基础权限为超管 + 辅导员');
else bad('setPosition 基础权限校验缺失（requireSuperOrCounselor 须在函数体内）');
if (grantOk('grant-new')) ok('setPosition 对新职位取授予权校验');
else bad('setPosition 缺授予权：新职位是授权职位时未走 isGrantedPosition');
if (grantOk('grant-target')) ok('setPosition 对「目标当前职位」也取授予权校验（堵撤职后门）');
else bad('setPosition 只看新职位 → 辅导员可把已有生活委员改掉（间接撤权后门）');
if (grantOk('grant-only-super')) ok('授权职位（生活委员 / 班长兼团支书）仅超管可授予');
else bad('授权职位授予权未收紧到超管（requirePositionGrant 缺失）');
if (grantOk('order')) ok('授予权校验在写库之前');
else bad('授予权校验晚于写库（先更新再校验 = 后门仍可通）');

/* ============================================================
 * ④ 变异自证：把上面这套判据指向**变异后的生产源码**，每条都必须翻红。
 *    好样本（真实源码）必须零失败，否则判据本身过严/写错。
 * ============================================================ */
console.log('\n── ④ 变异自证（判据真的能抓到回归吗）');
if (grantFails.length === 0) ok('真实源码零失败（好样本不误报）');
else bad('真实源码被判红 → 判据写错了：' + grantFails.join(', '));

const once = (src, from, to) => {
  const i = src.indexOf(from);
  if (i < 0) return null;
  return src.slice(0, i) + to + src.slice(i + from.length);
};
/*
 * 变异必须**限定在 setPosition 块内**：`requireSuperOrCounselor(ctx);` 这类串在
 * member 的多条路由里都出现，直接 `once(beSrc, …)` 会删掉**别的路由**那一处
 * → 待测函数毫发无损 → 变异「没翻红」但其实是锚点打偏（2026-09-27 实测踩到）。
 */
const onceIn = (anchor, from, to) => {
  const s = beSrc.indexOf(anchor);
  if (s < 0) return null;
  const head = beSrc.slice(0, s);
  const tail = beSrc.slice(s);
  if (tail.indexOf(from) < 0) return null;
  return head + tail.replace(from, to);
};
const POS_ANCHOR = '\n  setPosition: {';
const MUT = [
  ['grant-target', '删掉「目标当前职位」判定（复原撤职后门）',
    onceIn(POS_ANCHOR, ' || guard.isGrantedPosition(t.position)', '')],
  ['grant-only-super', '把授予权校验摘掉（辅导员即可任命生活委员）',
    onceIn(POS_ANCHOR, 'guard.requirePositionGrant(ctx);', ';')],
  ['grant-new', '新职位不再判授权职位',
    onceIn(POS_ANCHOR, 'guard.isGrantedPosition(position) || ', '')],
  ['base-tier', '基础权限校验被整段删除',
    onceIn(POS_ANCHOR, 'requireSuperOrCounselor(ctx);', ';')],
];
MUT.forEach(([code, label, mutated]) => {
  if (mutated === null) { bad('自证：[' + code + '] 变异锚点未命中（源码已变，需同步判据）'); return; }
  const f = judgeGrant(mutated);
  if (f.includes(code)) ok('自证：' + label + ' → 判据翻红 ✓');
  else bad('自证：' + label + ' 竟未翻红（期望 ' + code + '，实得 [' + f.join(',') + ']）');
});

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('OK · 职位清单同步校验通过');
