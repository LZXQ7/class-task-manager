/**
 * 门禁：教职工一次性绑定码（v0.7.14 第 6 轮，第 33 个门禁）
 * ------------------------------------------------------------
 * 背景：辅导员 / 老师**没有班级、没有学号**。原有绑定链路（班级口令 → 名单选人 → 学号后 4 位）
 * 三重都不适用：
 *   ① 名单里没有他的条目（既有辅导员 ID72 的占位学号 00000000000 落在 99 段，被 NOT_TEST 过滤）；
 *   ② 教职工不在 A/B 分组，按名字选人对不上；
 *   ③ 没有学号，后 4 位无从验证。
 * 所以另开一条：管理员现场发 8 位一次性码（member.addStaff / member.staffCode），
 * 本人在绑定页选「我是老师 / 辅导员」输入即绑定（auth.bindStaff）。
 *
 * 为什么值得上门禁 —— 这些约定**改动一处都不会报错**，只会静默出事：
 *   · `.tabbar` 那类视觉问题肉眼可见，但下面这些全是「静默」的：
 *     - `loadSeqPrefix` 少写一次 `group_tag <> 'X'` → 占位学号把整班前缀判定顶掉，
 *       「序号名册补学号」功能**无声失效**（用户只会觉得「怎么补不上了」）；
 *     - `stats` 少写一次 → 班级人数被教职工顶高 1，没人会发现；
 *     - `staffList` 顺手把码回给前端 → 普通班委也能抄走码去冒充教职工（越权）；
 *     - `addStaff` 的 role 写成 MEMBER → 辅导员所有管理接口全被 needAdmin 拦死；
 *     - `bindStaff` 里加一句 `assertGlobalOk` → 几条瞎试的教职工码会把**全体学生**的
 *       入班通道一起关掉（全局熔断是给「4 位学号可推算」准备的，码是高熵串不该享用它）。
 *
 * 自证：把上面每一条**真的改坏**一次，确认门禁逐条抓得住（坏样本必被抓），
 *       同时真实源码必须全过（好样本不误报）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** ⚠️ 统一成 LF：本机文件是 CRLF，含 `\n` 的锚点会全部失配（定位不到 = 断言静默失效） */
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };

/** 剥块注释与 HTML 注释（注释里写到的 SQL 片段 / 类名不算数 —— 本项目踩过两次误报） */
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '');
const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');

const MEMBER = stripJs(read('cloudfunctions/member/index.js'));
const AUTH = stripJs(read('cloudfunctions/auth/index.js'));
const API = stripJs(read('miniprogram/utils/api.js'));
const BIND_JS = stripJs(read('miniprogram/pages/bind/index.js'));
const BIND_WXML = stripHtml(read('miniprogram/pages/bind/index.wxml'));
const CLS_JS = stripJs(read('miniprogram/pages/classes/index.js'));
const CLS_WXML = stripHtml(read('miniprogram/pages/classes/index.wxml'));

/** 取 s 中 [a, b) 之间的片段；找不到 b 就取到结尾；a 找不到返回 '' */
function between(s, a, b) {
  const i = s.indexOf(a);
  if (i < 0) return '';
  if (!b) return s.slice(i);
  const j = s.indexOf(b, i + a.length);
  return j < 0 ? s.slice(i) : s.slice(i, j);
}
/** 出现次数 */
const count = (s, re) => (s.match(re) || []).length;

/* ============================================================
 * 审计：全部断言集中在这里，好让「真实源码」与「故意改坏的源码」跑同一套判据
 * 每条失败信息以 [id] 开头，便于自证段按 id 断言
 * ============================================================ */
function audit(src) {
  const f = [];
  const need = (cond, id, msg) => { if (!cond) f.push('[' + id + '] ' + msg); };

  const m = src.MEMBER, a = src.AUTH, api = src.API;
  const bjs = src.BIND_JS, bwxml = src.BIND_WXML;
  const cjs = src.CLS_JS, cwxml = src.CLS_WXML;

  /* ---------- ① 码本身的口径 ---------- */
  const charset = (/'([A-Z0-9]{20,})'/.exec(between(m, 'const STAFF_CODE_CHARS', ';')) || [])[1] || '';
  need(!!charset, 'charset', 'member 里应有 STAFF_CODE_CHARS 常量');
  need(charset && !/[IO01]/.test(charset), 'charset-ambiguous',
    '绑定码字符集不能含 I/O/0/1（码要口头念或手抄给人）实得「' + charset + '」');
  need(charset.length >= 30, 'charset-space', '字符集空间过小（会降低爆破成本）实得 ' + charset.length + ' 个字符');

  const codeLen = Number((/STAFF_CODE_LEN\s*=\s*(\d+)/.exec(m) || [])[1]);
  need(codeLen === 8, 'code-len', 'STAFF_CODE_LEN 应为 8，实得 ' + codeLen);
  need(/STAFF_CODE_HOURS\s*=\s*\d+/.test(m), 'code-hours', 'STAFF_CODE_HOURS 应为显式常量');

  // 前端 maxlength / slice 必须与后端码长一致（差一位就是「输不完」或「永远校验不过」）
  need(bwxml.indexOf('maxlength="' + codeLen + '"') >= 0, 'code-len-fe-be',
    '绑定页输入框 maxlength 必须等于 STAFF_CODE_LEN（' + codeLen + '）');
  need(bjs.indexOf('.slice(0, ' + codeLen + ')') >= 0, 'code-slice-fe-be',
    'bind 页 onStaffInput 的 slice 上限必须等于 STAFF_CODE_LEN（' + codeLen + '）');
  need(bjs.indexOf('.toUpperCase()') >= 0, 'code-upper',
    'bind 页输入要统一转大写（码的字符集是大写字母 + 数字）');

  /* ---------- ② member.addStaff ---------- */
  const addBlk = between(m, '  addStaff: {', '  staffCode: {');
  need(addBlk.length > 0, 'add-exists', 'member 应有 addStaff action');
  // v0.7.16 改判：教职工名册收归**仅超管**（原口径 super-or-counselor）。
  // 用户裁决「教职工管理权限 = 仅超管」；两种写法都接受是为了防手滑回退到更宽的口径。
  need(/guard\.requireSuper\(ctx\)|requireSuperOrCounselor\(ctx\)/.test(addBlk), 'add-auth',
    'addStaff 必须限超管（guard.requireSuper，v0.7.16 收紧；旧 requireSuperOrCounselor 仍兼容）'
    + '—— 否则普通班委能造教职工身份');
  need(/needAdmin:\s*true/.test(addBlk), 'add-needadmin', 'addStaff 应声明 auth:{needAdmin:true}');
  need(/\\'X\\',\s*\\'ADMIN\\'/.test(addBlk), 'add-insert-x-admin',
    'addStaff 的 INSERT 必须把 group_tag 写死 \'X\'、role 写死 \'ADMIN\''
    + '（给 MEMBER 会让辅导员被 needAdmin 全线拦死）');
  need(!/is_super/.test(addBlk), 'add-no-super',
    'addStaff 不应写 is_super（教职工不是超管，保持默认 0）');
  need(/genUniqueStaffNo\(pool\)/.test(addBlk), 'add-placeholder-no',
    'addStaff 必须用 STAFF 前缀占位学号（member.student_no 是 UNIQUE NOT NULL，不能留空）');
  need(/genUniqueStaffCode\(pool\)/.test(addBlk), 'add-unique-code',
    'addStaff 必须生成全局唯一的码（staff_code 上有索引，要查重后重试）');
  need(/staff_code_expire/.test(addBlk), 'add-expire', 'addStaff 必须写入 staff_code_expire');

  /* ---------- ③ member.staffCode（重发） ---------- */
  const reissueBlk = between(m, '  staffCode: {', '  staffList: {');
  need(reissueBlk.length > 0, 'reissue-exists', 'member 应有 staffCode action');
  // v0.7.16 改判：staffCode 收归仅超管（同 addStaff，见上）
  need(/guard\.requireSuper\(ctx\)|requireSuperOrCounselor\(ctx\)/.test(reissueBlk), 'reissue-auth',
    'staffCode 必须限超管（guard.requireSuper，v0.7.16 收紧）');
  need(t_hasX(reissueBlk), 'reissue-only-staff',
    'staffCode 只对 group_tag===\'X\' 的账号生效（不能给学生发教职工码）');
  need(/t\.openid/.test(reissueBlk), 'reissue-not-bound',
    'staffCode 必须拒绝已绑定的账号（新码会指向已有 openid 的账号，本人白跑一趟）');

  /* ---------- ④ member.staffList（不外泄码） ---------- */
  const listBlk = between(m, '  staffList: {', '  /**\n   * 移出班级');
  need(listBlk.length > 0, 'stafflist-exists', 'member 应有 staffList action');
  need(/hasCode:/.test(listBlk) && /codeExpire:/.test(listBlk), 'stafflist-status',
    'staffList 应回「有无待用码 / 何时过期」的状态而不是码本身');
  need(!/staffCode\s*:/.test(listBlk), 'stafflist-no-code',
    'staffList **绝不能回 staff_code 本身** —— 普通班委抄走码即可冒充教职工');
  need(/requireSuperOrCounselor\(ctx\)/.test(listBlk), 'stafflist-auth', 'staffList 必须限超管 / 辅导员');

  /* ---------- ⑤ 新增 X 组不能污染既有统计 / 名单口径 ---------- */
  const seqBlk = between(m, 'async function loadSeqPrefix', '\nfunction pad2');
  need(seqBlk.length > 0, 'seq-exists', '应能定位 loadSeqPrefix');
  need(seqBlk.indexOf("AND group_tag <> 'X'") >= 0, 'seq-exclude-x',
    'loadSeqPrefix 必须排除 X 组：占位学号 STAFF… 会把 pfx/lens 顶成 2 →'
    + ' 整班判定为「前缀不可推导」→ 序号名册补学号**静默失效**');

  const rosterBlk = between(m, "if (payload.public === 'roster')", "if (payload.public === 'manage')");
  need(rosterBlk.length > 0, 'roster-exists', '应能定位 list 的 roster 分支');
  need(rosterBlk.indexOf("AND group_tag <> 'X'") >= 0, 'roster-exclude-x',
    'roster 必须排除 X 组：教职工现在走独立绑定码入口，不该出现在学生选人名单里');

  const statsBlk = between(m, '  stats: {', '  importCsv: {');
  // ⚠️ 必须匹配 `COUNT(*) AS total`：紧邻的那行注释里也写了「COUNT(*) 会把它们算进 total」，
  //    只写 COUNT(*) 会先命中注释行 → 断言恒为假（本项目踩过同类误报）。
  const totalLine = (statsBlk.match(/COUNT\(\*\) AS total[^\n]*/) || [''])[0];
  need(totalLine.indexOf("AND group_tag <> 'X'") >= 0, 'stats-exclude-x',
    'stats 的 COUNT(*) 必须排除 X 组：SUM(group_tag=\'A\'/\'B\') 天然不含 X，'
    + '但 COUNT(*) 会把教职工算进「总人数」');

  const xGuardCount = count(m, /AND group_tag <> 'X'/g);
  need(xGuardCount >= 4, 'x-guard-count',
    'member 里至少 4 处按班级的名单 / 统计查询要排除 X 组，实得 ' + xGuardCount + ' 处');

  /* ---------- ⑥ auth.bindStaff ---------- */
  const bindBlk = between(a, '  bindStaff: {', '  unbind: {');
  need(bindBlk.length > 0, 'bindstaff-exists', 'auth 应有 bindStaff action');
  need(/auth:\s*null/.test(bindBlk), 'bindstaff-public',
    'bindStaff 必须免登录可调（auth:null）—— 本人还没绑定，任何 needBind 都会把它挡在门外');
  need(!/assertGlobalOk/.test(bindBlk), 'bindstaff-no-global',
    'bindStaff **不得**调 assertGlobalOk：全局熔断会顺手关掉所有班级的绑定入口，'
    + '几条瞎试的教职工码不该把全体学生的入班通道一起关停');
  need(/assertNotLocked/.test(bindBlk), 'bindstaff-locked',
    'bindStaff 仍要按 openid 限流（assertNotLocked + 失败计数）');
  need(/staff_code_expire/.test(bindBlk), 'bindstaff-expire', 'bindStaff 必须校验过期时间');
  need(/staff_code = NULL/.test(bindBlk), 'bindstaff-once',
    'bindStaff 必须一次性作废码（绑成功即把 staff_code 清空）');
  need(/WHERE openid = \?/.test(bindBlk), 'bindstaff-one-identity',
    'bindStaff 要先查「当前微信是否已绑定别的身份」（member.openid 是 UNIQUE，'
    + '直接 UPDATE 会撞唯一键、报错不可读）');

  /* ---------- ⑦ 前端接线 ---------- */
  need(/bindStaff:\s*C\('auth',\s*'bindStaff'\)/.test(api), 'api-bindstaff', 'api.js 应暴露 bindStaff');
  need(/addStaff:\s*C\('member',\s*'addStaff'\)/.test(api), 'api-addstaff', 'api.js 应暴露 addStaff');
  need(/staffCode:\s*C\('member',\s*'staffCode'\)/.test(api), 'api-staffcode', 'api.js 应暴露 staffCode');
  need(/staffList:\s*C\('member',\s*'staffList'\)/.test(api), 'api-stafflist', 'api.js 应暴露 staffList');

  need(/staffMode:\s*false/.test(bjs), 'bind-mode', 'bind 页应有 staffMode 开关');
  const submitBlk = between(bjs, 'onStaffSubmit()', '\n  onLockedKnow');
  need(submitBlk.length > 0, 'bind-submit-exists', 'bind 页应有 onStaffSubmit');
  need(/if\s*\(!this\.data\.agreed\)/.test(submitBlk), 'bind-agree',
    '教职工绑定同样要先勾选《用户协议》《隐私政策》（隐私合规红线，不得默认同意）');
  need(/api\.bindStaff\(/.test(submitBlk), 'bind-call', 'onStaffSubmit 应调 api.bindStaff');
  need(bwxml.indexOf('bindtap="onStaffSubmit"') >= 0, 'bind-wxml-submit', 'wxml 应绑定 onStaffSubmit');
  need(bwxml.indexOf('bindtap="onEnterStaff"') >= 0, 'bind-wxml-enter', 'wxml 应提供「我是老师 / 辅导员」入口');

  // v0.7.16 改判：教职工管理入口收归**仅超管**（onOpenStaffMgr → onOpenStaffMgr 关闭），
  // 新独立按钮按 isSuper 门控；旧「onOpenStaff + canCross」口径一并兼容（防手滑回退到更宽）。
  const newGate = /onOpenStaffMgr/.test(cjs) && /isSuper/.test(between(cjs, 'onOpenStaffMgr()', 'onCloseStaffMgr'));
  const oldGate = /onOpenStaff/.test(cjs) && /canCross/.test(between(cjs, 'onOpenStaff(e)', 'onCloseStaff'));
  need(newGate || oldGate, 'cls-gate',
    '班级管理页的「教职工管理」入口必须按 isSuper（v0.7.16 收紧）或 canCross（旧口径）门控');

  // ⚠️ 断言必须**限定在 page-meta 那一行**里找 staffShow：
  //    只写 `cwxml.indexOf('staffShow') >= 0` 会被 `<bottom-sheet show="{{staffShow}}">` 命中，
  //    于是「新增弹层却忘了加进滚动锁」这个 bug 永远抓不到。
  //    顺手做成通用规则：页面里**每一个**弹层 show 标志都得进表达式。
  const pmTag = (cwxml.match(/<page-meta[^>]*>/) || [''])[0];
  need(pmTag.length > 0, 'cls-pagemeta', '班级管理页应有 page-meta（滚动锁）');
  const layerFlags = [];
  const flagRe = /show="\{\{([A-Za-z_$][\w$]*)\}\}"/g;
  let fm;
  while ((fm = flagRe.exec(cwxml))) layerFlags.push(fm[1]);
  const missingFlags = layerFlags.filter(x => pmTag.indexOf(x) < 0);
  need(missingFlags.length === 0, 'cls-pagemeta',
    '班级管理页所有弹层 show 标志都要进 page-meta 滚动锁表达式，缺：'
    + (missingFlags.join(' / ') || '（没解析到任何弹层标志，锚点可能已失效）'));

  return f;
}

/** staffCode 里必须出现 group_tag !== 'X' 的守卫（兼容单双引号两种写法） */
function t_hasX(blk) {
  return /group_tag\s*!==\s*'X'/.test(blk) || /group_tag\s*!==\s*"X"/.test(blk);
}

/* ============================================================
 * 跑真实源码
 * ============================================================ */
const REAL = {
  MEMBER, AUTH, API, BIND_JS, BIND_WXML, CLS_JS, CLS_WXML
};

console.log('── ① 真实源码审计');
const realFails = audit(REAL);
if (!realFails.length) ok('全部约定成立（未发现违规）');
else realFails.forEach(x => bad(x));

/* ============================================================
 * 自证：逐条把约定改坏，必须被抓到（坏样本必被抓）
 * 每条 = [期望失败的 id, 变异后的源码, 说明]
 * ============================================================ */
console.log('\n── ② 自证：改坏一处必须被抓');

function mutate(base, patch) {
  return Object.assign({}, base, patch);
}

const CASES = [
  { id: 'seq-exclude-x', extra: ['x-guard-count'],
    desc: '把 loadSeqPrefix 的 group_tag <>\'X\' 删掉（占位学号会顶掉整班前缀判定）',
    // ⚠️ 锚点里的 NOT_TEST 必须带括号()：2026-10-08 已从常量形态改成函数形态，
    //    锚点一旦漂移 REPLACE_ONCE 会静默返回原串 ⇒ 变异不生效 ⇒ 自证假通过。
    src: mutate(REAL, { MEMBER: REPLACE_ONCE(MEMBER, " WHERE \" + NOT_TEST() + \" AND group_tag <> 'X' GROUP BY class_id", ' WHERE " + NOT_TEST() + " GROUP BY class_id') }) },

  { id: 'roster-exclude-x', extra: ['x-guard-count'],
    desc: '把 roster 的排除 X 删掉（教职工会出现在学生的选人名单里）',
    src: mutate(REAL, { MEMBER: REPLACE_ONCE(MEMBER, "\" AND group_tag <> 'X'\";", '";') }) },

  { id: 'stats-exclude-x', extra: ['x-guard-count'],
    desc: '把 stats 的 COUNT(*) 排除 X 删掉（班级人数被教职工顶高）',
    src: mutate(REAL, { MEMBER: REPLACE_ONCE(MEMBER, '+ " AND group_tag <> \'X\'",', '+ "",') }) },

  { id: 'add-insert-x-admin', extra: [],
    desc: '把 addStaff 的 group_tag/role 改成 A/MEMBER（辅导员权限会被全线拦死）',
    src: mutate(REAL, { MEMBER: REPLACE_ONCE(MEMBER, "\\'X\\', \\'ADMIN\\'", "\\'A\\', \\'MEMBER\\'") }) },

  { id: 'stafflist-no-code', extra: [],
    desc: '让 staffList 顺手把码回给前端（班委可抄走冒充教职工）',
    src: mutate(REAL, { MEMBER: REPLACE_ONCE(MEMBER, '        hasCode: !r.openid', '        staffCode: r.staff_code,\n        hasCode: !r.openid') }) },

  { id: 'bindstaff-no-global', extra: [],
    desc: '在 bindStaff 里加 assertGlobalOk（教职工码瞎试会关停全体学生入班）',
    src: mutate(REAL, { AUTH: REPLACE_ONCE(AUTH, '      const pool = getPool();\n      await assertNotLocked(pool, ctx.openid);', '      const pool = getPool();\n      await assertGlobalOk(pool);\n      await assertNotLocked(pool, ctx.openid);') }) },

  { id: 'bind-agree', extra: [],
    desc: '去掉教职工绑定的隐私协议勾选校验',
    src: mutate(REAL, { BIND_JS: REPLACE_ONCE(BIND_JS, '    if (!this.data.agreed) {\n      util.toast(\'请先阅读并同意《用户协议》与《隐私政策》\');\n      return;\n    }\n    if (this.data.staffCode.length !== 8) {',
      '    if (false) {\n      util.toast(\'\');\n      return;\n    }\n    if (this.data.staffCode.length !== 8) {') }) },

  { id: 'cls-pagemeta', extra: [],
    desc: '新增 staffMgrShow 却没同步进 page-meta 滚动锁',
    src: mutate(REAL, { CLS_WXML: REPLACE_ONCE(CLS_WXML, ' || staffMgrShow)', ')') }) },

  { id: 'code-len-fe-be', extra: [],
    desc: '绑定页 maxlength 与后端码长脱钩（改成 6）',
    src: mutate(REAL, { BIND_WXML: REPLACE_ONCE(BIND_WXML, 'maxlength="8"', 'maxlength="6"') }) },

  { id: 'charset-ambiguous', extra: [],
    desc: '把易混的 I/O/0/1 放回字符集',
    src: mutate(REAL, { MEMBER: REPLACE_ONCE(MEMBER, "const STAFF_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';", "const STAFF_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';") }) }
];

let selfOk = 0;
CASES.forEach((c) => {
  const got = audit(c.src);
  if (got.some(x => x.indexOf('[' + c.id + ']') === 0)) { selfOk++; ok('改坏后被抓：' + c.desc); }
  else bad('自证失败：' + c.desc + ' —— 门禁没抓住（期望 [' + c.id + ']，实得 ' + JSON.stringify(got) + '）');
});

/* 好样本不误报：变异只应触发「它自己那条 + 明确相关的连带条」，其余判据必须保持沉默。
 * （删掉一处 group_tag <> 'X' 会连带把「至少 4 处」的计数断言打下来，这是设计内的连带） */
let noiseTotal = 0;
CASES.forEach((c) => {
  const allow = [c.id].concat(c.extra || []);
  const noise = audit(c.src).filter(x => allow.indexOf((x.match(/^\[([^\]]+)\]/) || [])[1]) < 0);
  if (noise.length) {
    noiseTotal += noise.length;
    bad('自证：[' + c.id + '] 的变异产生了连带误报 → ' + noise.join(' | '));
  }
});
if (!noiseTotal) ok('自证：' + CASES.length + ' 组变异都没有连带误报（判据精准，好样本不会被误伤）');

/* ============================================================
 * ③ 运行时行为自证：把 auth.bindStaff 从**部署源码**里抽出来，用假 DB 跑分支
 * ------------------------------------------------------------
 * 静态断言只能证明「代码里写了这句话」，证明不了「这句话真的拦得住」。
 * bindStaff 的三条命门全是**行为**层面的：一次性（绑完即失效）、过期拒绝、
 * 一个微信只能一个身份 —— 所以这里用假的 pool / guard / week 把整个 handler 跑起来。
 * 源码从 cloudfunctions/auth/index.js 原样 eval（不写副本），改坏了这里立刻会红。
 * ============================================================ */
async function runtimeSelfTest() {
  console.log('\n── ③ 运行时行为自证（auth.bindStaff 真实 handler）');

  const NOW = '2026-09-26 20:00:00';
  const RESULT = [];

  function makeFixture() {
    const rows = [
      /* 待绑的教职工：码 STAFF1 有效；STAFF2 已过期；STAFF3 被别的微信占了 */
      { id: 101, name: '王老师', group_tag: 'X', role: 'ADMIN', status: 'ACTIVE', openid: null,
        staff_code: 'STAFF1AA', staff_code_expire: '2026-09-28 20:00:00' },
      { id: 102, name: '李老师', group_tag: 'X', role: 'ADMIN', status: 'ACTIVE', openid: null,
        staff_code: 'STAFF2BB', staff_code_expire: '2026-09-20 20:00:00' },
      { id: 103, name: '赵老师', group_tag: 'X', role: 'ADMIN', status: 'ACTIVE', openid: 'oOther',
        staff_code: 'STAFF3CC', staff_code_expire: '2026-09-28 20:00:00' },
      /* 一个已经绑定过的普通学生：用于「一个微信只能一个身份」分支 */
      { id: 104, name: '张三', group_tag: 'A', role: 'MEMBER', status: 'ACTIVE', openid: 'oMine',
        staff_code: null, staff_code_expire: null }
    ];
    const log = { fails: 0, countUps: 0, cleared: 0 };
    const pool = {
      async query(sql, args) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        const a = args || [];
        if (s.indexOf('SELECT * FROM member WHERE openid = ?') === 0) return [rows.filter(r => r.openid === a[0])];
        if (s.indexOf('SELECT * FROM member WHERE staff_code = ?') === 0) return [rows.filter(r => r.staff_code === a[0])];
        if (s.indexOf('SELECT id, name FROM member WHERE openid = ?') === 0) return [rows.filter(r => r.openid === a[0]).map(r => ({ id: r.id, name: r.name }))];
        if (s.indexOf('SELECT fail_count, locked_until FROM bind_attempt') === 0) return [[]];
        if (s.indexOf('INSERT INTO bind_fail_log') === 0) { log.fails++; return [{}]; }
        if (s.indexOf('DELETE FROM bind_fail_log') === 0) return [{}];
        if (s.indexOf('INSERT INTO bind_attempt') === 0) { log.countUps++; return [{}]; }
        if (s.indexOf('SELECT fail_count FROM bind_attempt') === 0) return [[{ fail_count: 1 }]];
        if (s.indexOf('UPDATE bind_attempt') === 0) return [{}];
        if (s.indexOf('DELETE FROM bind_attempt') === 0) { log.cleared++; return [{}]; }
        if (s.indexOf('UPDATE member SET openid = ?') === 0) {
          const r = rows.find(x => x.id === a[1]);
          if (!r || (r.openid && r.openid !== a[0])) return [{ affectedRows: 0 }];
          r.openid = a[0]; r.staff_code = null; r.staff_code_expire = null;
          return [{ affectedRows: 1 }];
        }
        if (s.indexOf('SELECT openid, staff_code FROM member WHERE id = ?') === 0) {
          const r = rows.find(x => x.id === a[0]);
          return [r ? [{ openid: r.openid, staff_code: r.staff_code }] : []];
        }
        if (s.indexOf('UPDATE member SET avatar_url') === 0) return [{}];
        throw new Error('门禁的假 DB 没覆盖这条 SQL：' + s);
      }
    };
    return { rows, log, pool };
  }

  /** 原样 eval cloudfunctions/auth/index.js，只替换 require 的目标 */
  function loadAuth(pool) {
    const src = read('cloudfunctions/auth/index.js');
    const mod = { exports: {} };
    const BizError = class BizError extends Error {
      constructor(code, msg, data) { super(msg); this.errCode = code; this.errMsg = msg; this.data = data; }
    };
    const FAKE = { openid: '', member: null };
    const guard = {
      getContext: async () => ({ openid: FAKE.openid, appid: '', member: FAKE.member, realMember: FAKE.member, impersonated: false }),
      requireBind(ctx) { if (!ctx.member) throw new BizError(40001, '未绑定班级'); return ctx.member; },
      requireAdmin(ctx) { const m = guard.requireBind(ctx); if (!['ADMIN', 'MONITOR'].includes(m.role)) throw new BizError(40003, '仅管理员可操作'); return m; },
      requireSuper(ctx) { const m = guard.requireBind(ctx); if (!(m.role === 'ADMIN' && m.is_super === 1)) throw new BizError(40003, '仅超级管理员可操作'); return m; },
      isSuper(m) { return !!(m && m.role === 'ADMIN' && m.is_super === 1); },
      isCounselor(m) { return !!(m && m.group_tag === 'X'); },
      classIdOf(ctx) { const m = ctx && (ctx.member || ctx.realMember); return Number(m && m.class_id) || 1; },
      ADMIN_ROLES: ['ADMIN', 'MONITOR']
    };
    const req = (id) => {
      if (id === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'test' };
      if (id === './common/db') return { getPool: () => pool };
      if (id === './common/guard') return guard;
      if (id === './common/week') return { nowStamp: () => NOW, addMinutes: () => NOW };
      if (id === './common/resp') return { BizError, ok: d => ({ ok: true, data: d }), fail: (c, m, d) => ({ ok: false, errCode: c, errMsg: m, data: d }) };
      // 测试账号条件是 common 唯一真源（无状态）⇒ 直接 require 真的，不在门禁里抄第二份
      if (id === './common/test-account') {
        return require(path.join(ROOT, 'cloudfunctions', 'common', 'test-account.js'));
      }
      // 演示态拦截模块（v1.0.6.4）：无状态纯函数，直接 require 真的（本用例非演示身份 ⇒ 全放行）
      if (id === './common/review-demo') {
        return require(path.join(ROOT, 'cloudfunctions', 'common', 'review-demo.js'));
      }
      throw new Error('门禁未桩化 require：' + id);
    };
    new Function('exports', 'require', 'module', 'console', src)(mod.exports, req, mod, { log() {}, error() {} });
    return { main: mod.exports.main, FAKE };
  }

  /** 跑一次 bindStaff；openid/member 由本次调用决定 */
  async function call(pool, openid, member, payload) {
    const { main, FAKE } = loadAuth(pool);
    FAKE.openid = openid;
    FAKE.member = member || null;
    return main({ action: 'bindStaff', payload });
  }

  const fx = makeFixture();
  const okCase = (id, cond, msg) => { if (cond) { RESULT.push(id); ok(msg); } else bad('[rt-' + id + '] ' + msg); };

  const fresh = () => { const f = makeFixture(); return f; };

  /* 1. 格式非法 */
  {
    const f = fresh();
    const r = await call(f.pool, 'oNew', null, { staffCode: 'abc' });
    okCase('fmt', r.errCode === 41001, '格式非法（abc）被挡在 41001，实得 ' + JSON.stringify(r));
  }
  /* 2. 不存在的码 */
  {
    const f = fresh();
    const r = await call(f.pool, 'oNew', null, { staffCode: 'NOPE1234' });
    okCase('unknown', r.errCode === 40004 && f.log.fails === 1 && f.log.countUps === 1,
      '不存在的码返回 40004 且计入失败日志（fails=' + f.log.fails + ', countUps=' + f.log.countUps + '）');
  }
  /* 3. 过期码 */
  {
    const f = fresh();
    const r = await call(f.pool, 'oNew', null, { staffCode: 'STAFF2BB' });
    okCase('expired', r.errCode === 40004 && f.rows.find(x => x.id === 102).openid === null,
      '过期码被拒（40004）且不产生绑定，实得 errCode=' + r.errCode);
  }
  /* 4. 码已被别人用了 */
  {
    const f = fresh();
    const r = await call(f.pool, 'oNew', null, { staffCode: 'STAFF3CC' });
    okCase('taken', r.errCode === 40004 && f.rows.find(x => x.id === 103).openid === 'oOther',
      '别人已绑定的码被拒（40004）且不夺走原绑定');
  }
  /* 5. 一个微信只能一个身份 */
  {
    const f = fresh();
    const r = await call(f.pool, 'oMine', f.rows.find(x => x.id === 104), { staffCode: 'STAFF1AA' });
    okCase('one-identity', r.errCode === 40006 && f.rows.find(x => x.id === 101).openid === null,
      '当前微信已绑定学生身份时拒绝再绑教职工（40006），实得 errCode=' + r.errCode);
  }
  /* 6. 正常绑定 + 一次性 */
  {
    const f = fresh();
    const r = await call(f.pool, 'oNew', null, { staffCode: 'STAFF1AA' });
    const t = f.rows.find(x => x.id === 101);
    okCase('success',
      r.ok === true && r.data && r.data.isStaff === true && t.openid === 'oNew' && t.staff_code === null && t.staff_code_expire === null,
      '合法码绑定成功；码被一次性作废（openid=' + t.openid + ', staff_code=' + t.staff_code + '）');
    /* 7. 同一个码再用一次必须失败 */
    const r2 = await call(f.pool, 'oAnother', null, { staffCode: 'STAFF1AA' });
    okCase('reuse', r2.errCode === 40004 && f.rows.find(x => x.id === 101).openid === 'oNew',
      '同一码第二次使用被拒（40004），且不会改掉已绑定的 openid');
  }

  return RESULT.length;
}

console.log('');
(async () => {
  let rtOk = 0;
  try {
    rtOk = await runtimeSelfTest();
  } catch (e) {
    bad('运行时自证崩了：' + (e && e.stack || e));
  }
  console.log('');
  if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
  console.log('OK · 教职工一次性绑定码校验通过（真实源码全过 + '
    + selfOk + '/' + CASES.length + ' 条变异被抓 + 运行时 ' + rtOk + '/7 条分支）');
})();

/** 只替换第一次出现；没替换到就原样返回（自证段自己保证锚点存在） */
function REPLACE_ONCE(s, a, b) {
  const i = s.indexOf(a);
  if (i < 0) return s;
  return s.slice(0, i) + b + s.slice(i + a.length);
}
