#!/usr/bin/env node
/**
 * 门禁：课前演讲排班权下放给「学习委员」（2026-11-17 用户要求）
 * ------------------------------------------------------------
 * 用户口径（已确认）：
 *   ① 课前演讲权限也放进后台管理页面 —— 后台「成员」编辑里加一个
 *      「可排课前演讲」勾选项（与「可登记班费消费」同一排，只额外授予）；
 *   ② **直接给学习委员加上权限**，让学习委员能直接排班；
 *   ③ 只给课前演讲，**值日仍归生活委员**（不给学习委员值日排班权）。
 *
 * 为什么不能图省事直接把演讲路由留在 scheduleAuth：
 *   `scheduleAuth` = 超管 | 生活委员，值日与演讲共用。若为了让学习委员能排演讲
 *   就去放宽 requireScheduleAuth，等于**顺手把值日排班也给了学习委员** —— 与用户
 *   明确口径相反。所以演讲写路由必须改用独立守卫 `speechAuth`。
 *
 * 判据（后端守卫 + 能力位 + 前端入口 + 后台开关，四段成对）：
 *   ① guard：isStudyAdmin / hasSpeechPerm / canSpeech / requireSpeechAuth；
 *   ② schedule：9 条演讲写路由挂 speechAuth（1.0.8.67 加 speechAdd/Remove），值日路由仍是 scheduleAuth（计数不变）；
 *      派发器必须接线，声明了不校验 = 裸奔；
 *   ③ auth.login 下发 canSpeech，小程序 app.js 提供 canSpeech()，演讲按钮按它显隐；
 *   ④ 后台成员编辑有 speech_perm 开关（读写 + 迁移脚本 + 列表回显）。
 *
 * 用法：node scripts/check-speech-perms.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed += 1; console.log('  ✗ ' + m); };
const chk = (c, m) => (c ? ok(m) : bad(m));

/** 演讲写路由清单（与 check-speech-schedule.js 的接线段保持同一份口径） */
const SPEECH_WRITES = ['speechGenerate', 'speechReassign', 'speechSwap', 'speechAdd', 'speechRemove', 'speechClear',
  'speechPublish', 'speechSetSettings', 'speechAiParse', 'speechAiApply'];
/* speechBoard 是演讲排班页的读接口，但同样只允许排班者看（草稿态 + 名册），故挂 speechAuth */
const SPEECH_BOARD = 'speechBoard';

/** 取某路由块（从 `name: {` 到下一个同级路由声明之前），用于判权限声明。
 *  ⚠️ 不能按「第一个缩进 2 空格的换行」截断 —— 块内每行都缩进 4 空格，
 *     宽松匹配会把整个块截成一行，判据永远拿不到 auth 字段（假红/假绿）。 */
function routeBlock(src, name) {
  const start = src.indexOf('\n  ' + name + ': {');
  if (start < 0) return '';
  const re = /\n  [A-Za-z_$][\w$]*:\s*\{/g;
  re.lastIndex = start + 1;
  const m = re.exec(src);
  return m ? src.slice(start, m.index) : src.slice(start);
}

/** 单文件审计（纯函数，变异自证复用同一份判据） */
function audit(s) {
  const out = [];

  /* ---- ① guard.js：职位常量 + 三个函数 + 导出 ---- */
  if (!/const POSITION_STUDY = '学习委员';/.test(s.guard)) out.push('guard 缺 POSITION_STUDY 常量');
  if (!/function isStudyAdmin\(member\)\s*\{[\s\S]{0,200}?position \|\| ''\)\.trim\(\) === POSITION_STUDY|function isStudyAdmin\(member\)\s*\{[\s\S]{0,200}?String\(member\.position \|\| ''\)\.trim\(\) === POSITION_STUDY/.test(s.guard)) {
    out.push('guard 缺 isStudyAdmin（按 position 判，需 trim）');
  }
  if (!/function isStudyAdmin\(member\)\s*\{[\s\S]{0,200}?group_tag !== 'X'/.test(s.guard)) {
    out.push('isStudyAdmin 未排除教职工（X 组不是学生班委）');
  }
  if (!/speech_perm/.test(s.guard)) out.push('guard 未读 member.speech_perm（后台单独授予的开关落不了地）');
  if (!/function canSpeech\(member\)\s*\{[\s\S]{0,400}?isSuper\(member\)[\s\S]{0,200}?isDutyAdmin\(member\)[\s\S]{0,200}?isStudyAdmin\(member\)[\s\S]{0,200}?hasSpeechPerm\(member\)/.test(s.guard)) {
    out.push('canSpeech 判定不完整（应为 超管 | 生活委员 | 学习委员 | 单独授予）');
  }
  if (!/function requireSpeechAuth\(ctx\)\s*\{[\s\S]{0,300}?canSpeech\(m\)[\s\S]{0,200}?BizError\(40003/.test(s.guard)) {
    out.push('requireSpeechAuth 不存在或未按 canSpeech 判 / 未抛 40003');
  }
  ['canSpeech', 'requireSpeechAuth', 'isStudyAdmin', 'hasSpeechPerm', 'POSITION_STUDY'].forEach((k) => {
    if (!new RegExp('module\\.exports[\\s\\S]*\\b' + k + '\\b').test(s.guard)) out.push('guard 未导出 ' + k);
  });

  /* ---- ② schedule：演讲写路由走 speechAuth，值日仍 scheduleAuth ---- */
  SPEECH_WRITES.forEach((a) => {
    const b = routeBlock(s.sch, a);
    if (!b) { out.push('schedule 缺路由 ' + a); return; }
    if (!/auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(b)) out.push(a + ' 未挂 speechAuth（学习委员排不了）');
    if (/auth:\s*\{\s*scheduleAuth:\s*true\s*\}/.test(b)) out.push(a + ' 仍挂 scheduleAuth（值日权被一并放宽）');
  });
  const boardB = routeBlock(s.sch, SPEECH_BOARD);
  if (!boardB) out.push('schedule 缺路由 speechBoard（演讲排班页列不出空场次）');
  else if (!/auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(boardB)) out.push('speechBoard 未挂 speechAuth');

  const dutyAuthCount = (s.sch.match(/auth:\s*\{\s*scheduleAuth:\s*true\s*\}/g) || []).length;
  if (dutyAuthCount !== 24) out.push('值日排班域路由数应为 24（含 dutySwap；实得 ' + dutyAuthCount + '）：演讲写路由必须移出 scheduleAuth');
  if (!/if \(route\.auth && route\.auth\.speechAuth\) guard\.requireSpeechAuth\(ctx\);/.test(s.sch)) {
    out.push('schedule 派发器未接线 speechAuth（声明了不校验 = 裸奔）');
  }
  /* speechList：草稿态可见 + 名册/换人权限都要按 canSpeech，否则学习委员进去是空壳 */
  const list = routeBlock(s.sch, 'speechList');
  if (!/guard\.canSpeech\(ctx\.member\)/.test(list)) out.push('speechList 未按 canSpeech 下发（学习委员看不到名册/换人）');

  /* ---- ③ 能力位与前端入口 ---- */
  if (!/canSpeech:\s*!!guard\.canSpeech\(m\)/.test(s.auth)) out.push('auth.login 未下发 canSpeech');
  if (!/canSpeech\(\)\s*\{/.test(s.app)) out.push('app.js 缺 canSpeech()');
  if (!/canSpeech:\s*!!\(app && app\.canSpeech && app\.canSpeech\(\)\)/.test(s.dutyJ)) {
    out.push('值日页未把 canSpeech 放进 data（入口显隐没依据）');
  }
  /* v4（2026-11-20）：一键生成/智能排班合并为 onSpGenOpen；轮转/智能排班两个动作
     收进弹层内部（弹层只有可排者能打开），顶部只校验 4 个按钮按 canSpeech 显隐。 */
  ['onSpClear', 'onSpGenOpen', 'onSpUnpublish', 'onSpPublish'].forEach((h) => {
    const tag = new RegExp('<view[^>]*bindtap="' + h + '"[^>]*>').exec(s.dutyW);
    if (!tag) { out.push('值日页缺演讲按钮 ' + h); return; }
    if (!/wx:if="\{\{[^"]*canSpeech[^"]*\}\}"/.test(tag[0])) out.push('演讲按钮 ' + h + ' 未按 canSpeech 显隐');
  });
  /* 值日按钮必须仍然是 canSchedule —— 防止改漏把值日权也换成 canSpeech */
  ['onClear', 'onAiOpen', 'onUnpublish', 'onPublish'].forEach((h) => {
    const tag = new RegExp('<view[^>]*bindtap="' + h + '"[^>]*>').exec(s.dutyW);
    if (!tag) { out.push('值日页缺值日按钮 ' + h); return; }
    if (!/wx:if="\{\{[^"]*canSchedule[^"]*\}\}"/.test(tag[0])) out.push('值日按钮 ' + h + ' 未按 canSchedule 显隐');
  });

  /* ---- ④ 后台开关（成员编辑） ---- */
  if (!/speechPerm:\s*Number\(r\.speech_perm\) === 1/.test(s.modMember)) out.push('后台 maskMember 未回显 speechPerm');
  if (!/patch\.speechPerm !== undefined[\s\S]{0,200}?typeof patch\.speechPerm !== 'boolean'/.test(s.modMember)) {
    out.push('后台未校验 speechPerm 必须是布尔');
  }
  if (!/put\('speech_perm'/.test(s.modMember)) out.push('后台 UPDATE 未写 speech_perm');
  if (!/INSERT INTO member[^;]*speech_perm/.test(s.modMember)) out.push('后台 INSERT 未带 speech_perm');
  if (!/id="f-perm-speech"/.test(s.appJs)) out.push('后台成员编辑弹层缺「可排课前演讲」勾选框');
  if (!/f-perm-speech'[\s\S]{0,80}?\.checked/.test(s.appJs)) out.push('后台 readMemberForm 未读取该勾选框');
  if (!/ALTER TABLE member[\s\S]{0,200}?speech_perm/.test(s.sql)) out.push('缺 member.speech_perm 迁移脚本');

  /* ---- ⑤ common 副本一致性（改 guard 不同步 = 各函数行为不一致） ---- */
  if (s.guardDrift.length) out.push('guard.js 副本漂移：' + s.guardDrift.join(','));

  return out;
}

/* ---------- 读数 ---------- */
function loadSources() {
  const srcGuard = md5('cloudfunctions/common/guard.js');
  const copies = fs.readdirSync(path.join(ROOT, 'cloudfunctions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'common')
    .map((d) => 'cloudfunctions/' + d.name + '/common/guard.js')
    .filter((p) => fs.existsSync(path.join(ROOT, p)));
  return {
    guard: read('cloudfunctions/common/guard.js'),
    sch: read('cloudfunctions/schedule/index.js'),
    auth: read('cloudfunctions/auth/index.js'),
    app: read('miniprogram/app.js'),
    dutyW: read('miniprogram/pages/duty/index.wxml'),
    dutyJ: read('miniprogram/pages/duty/index.js'),
    modMember: read('cloudfunctions/admin-web/lib/mod-member.js'),
    appJs: read('cloudfunctions/admin-web/public/app.js'),
    sql: fs.existsSync(path.join(ROOT, 'scripts/migrate-speech-perm.sql'))
      ? read('scripts/migrate-speech-perm.sql') : '',
    guardDrift: copies.filter((p) => md5(p) !== srcGuard)
  };
}

console.log('── ① 好样本：当前源码');
const GOOD = loadSources();
const problems = audit(GOOD);
problems.forEach(bad);
if (!problems.length) ok('学习委员演讲排班权：守卫 / 路由 / 能力位 / 入口 / 后台开关 六段全过');

console.log('\n── ② 变异自证：撤掉任一段必须翻红');
function mutant(name, patch, needle) {
  const s = Object.assign({}, GOOD, patch);
  const changed = Object.keys(patch).some((k) => String(s[k]) !== String(GOOD[k]));
  if (!changed) { bad(name + '：变异没生效（别拿好样本当坏样本）'); return; }
  const out = audit(s);
  chk(out.some((p) => p.indexOf(needle) >= 0), name + ' → 被抓住');
}

mutant('变异1：canSpeech 去掉学习委员', {
  guard: GOOD.guard.replace(/\s*\|\|\s*isStudyAdmin\(member\)/, '')
}, 'canSpeech 判定不完整');

mutant('变异2：演讲路由退回 scheduleAuth', {
  sch: GOOD.sch.replace('speechGenerate: {\n    auth: { speechAuth: true }', 'speechGenerate: {\n    auth: { scheduleAuth: true }')
}, 'speechGenerate 仍挂 scheduleAuth');

mutant('变异3：派发器不校验 speechAuth', {
  sch: GOOD.sch.replace('if (route.auth && route.auth.speechAuth) guard.requireSpeechAuth(ctx);',
    'if (route.auth && route.auth.speechAuth) void 0;')
}, '派发器未接线 speechAuth');

mutant('变异4：auth 不下发 canSpeech', {
  auth: GOOD.auth.replace('canSpeech: !!guard.canSpeech(m),', '')
}, 'auth.login 未下发 canSpeech');

mutant('变异5：演讲一键生成入口退回 canSchedule', {
  dutyW: GOOD.dutyW.replace(
    'wx:if="{{canSpeech}}" class="dt-admin-btn ghost" hover-class="press-dim" hover-start-time="0" hover-stay-time="60" bindtap="onSpGenOpen"',
    'wx:if="{{canSchedule}}" class="dt-admin-btn ghost" hover-class="press-dim" hover-start-time="0" hover-stay-time="60" bindtap="onSpGenOpen"')
}, '演讲按钮 onSpGenOpen 未按 canSpeech 显隐');

mutant('变异6：后台删掉勾选框', {
  appJs: GOOD.appJs.replace('id="f-perm-speech"', 'id="f-perm-speech-x"')
}, '缺「可排课前演讲」勾选框');

mutant('变异7：后台 UPDATE 漏写 speech_perm', {
  modMember: GOOD.modMember.replace("if (patch.speechPerm !== undefined) put('speech_perm', patch.speechPerm ? 1 : 0);", '')
}, 'UPDATE 未写 speech_perm');

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 课前演讲权限体检全部通过'));
process.exit(failed ? 1 : 0);
