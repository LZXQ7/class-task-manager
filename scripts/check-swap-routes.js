#!/usr/bin/env node
/**
 * 门禁：双向对调（1.0.8.69）——值日 dutySwap + 演讲 speechSwap。
 * 用户口径：A 这节课有事，跟其他课已排的 B 对调：A 去 B 的课、B 去 A 的课。
 * 技术要点：speech/duty 唯一键不含 status，两行直接互换 member_id 有中间态撞键 ⇒
 *   必须两阶段 UPDATE（先把 A 行临时负值挪开）+ 事务，且不动游标/发布态。
 * 用法：node scripts/check-swap-routes.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let failed = 0;
function check(cond, msg) { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) failed++; }

const F = {
  sch: 'cloudfunctions/schedule/index.js',
  api: 'miniprogram/utils/api.js',
  manual: 'miniprogram/pages/manual/index.js',
  speech: 'miniprogram/pages/speech/index.js',
  duty: 'miniprogram/pages/duty/index.js',
  dutyWxml: 'miniprogram/pages/duty/index.wxml',
  demo: 'cloudfunctions/common/review-demo.js'
};
const S = {};
Object.keys(F).forEach(k => { S[k] = fs.existsSync(path.join(ROOT, F[k])) ? read(F[k]) : ''; });

function routeBlock(src, name) {
  const start = src.indexOf('\n  ' + name + ': {');
  if (start < 0) return '';
  const re = /\n  [A-Za-z_$][\w$]*:\s*\{/g;
  re.lastIndex = start + 1;
  const m = re.exec(src);
  return m ? src.slice(start, m.index) : src.slice(start);
}
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); }

const dSwap = routeBlock(S.sch, 'dutySwap');
const sSwap = routeBlock(S.sch, 'speechSwap');
const dSwapC = stripComments(dSwap);
const sSwapC = stripComments(sSwap);

console.log('── ① 两条对调路由存在 + 权限');
check(!!dSwap, 'schedule 有 dutySwap 路由');
check(!!sSwap, 'schedule 有 speechSwap 路由');
check(/auth:\s*\{\s*scheduleAuth:\s*true\s*\}/.test(dSwap), 'dutySwap 挂 scheduleAuth');
check(/auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(sSwap), 'speechSwap 挂 speechAuth');

console.log('\n── ② 两阶段 UPDATE（避开唯一键中间态）+ 事务');
check(/beginTransaction\(\)/.test(dSwapC) && /commit\(\)/.test(dSwapC), 'dutySwap 用事务');
check(/beginTransaction\(\)/.test(sSwapC) && /commit\(\)/.test(sSwapC), 'speechSwap 用事务');
check(/member_id\s*=\s*\?/.test(dSwapC) && (dSwapC.match(/UPDATE duty SET member_id/g) || []).length >= 3,
  'dutySwap 至少 3 次 UPDATE duty SET member_id（临时挪开 + 两次归位）');
check((sSwapC.match(/UPDATE speech SET member_id/g) || []).length >= 3,
  'speechSwap 至少 3 次 UPDATE speech SET member_id');
check(/-\s*dutyIdA|-\s*idA|tempMember|tmpMember/.test(dSwapC), 'dutySwap 有临时负值/临时槽位');
check(/-\s*idA|tempMember|tmpMember/.test(sSwapC), 'speechSwap 有临时负值/临时槽位');

console.log('\n── ③ 不动游标/发布态');
check(!/speech_cursor|base_cursors|pending_cursors/.test(sSwapC) && !/saveSpeechCursors\s*\(/.test(sSwapC),
  'speechSwap 不动演讲游标/发布态');
check(!/round_cursor|round_cursor_a|bumpCursor/.test(dSwapC), 'dutySwap 不动值日游标');

console.log('\n── ④ 同班隔离 + 故障回退');
check(/rollback\(\)/.test(dSwapC) && /rollback\(\)/.test(sSwapC), '两条路由都有 rollback（异常不半途留脏数据）');
check((dSwapC.match(/class_id = \?/g) || []).length >= 2, 'dutySwap 按 class_id 隔离两条 duty');
check((sSwapC.match(/class_id = \?/g) || []).length >= 2, 'speechSwap 按 class_id 隔离两条 speech');

console.log('\n── ⑤ api.js + 三处前端接线');
check(/scheduleSwap:\s*C\('schedule',\s*'dutySwap'\)/.test(S.api), 'api.js 暴露 scheduleSwap → dutySwap');
check(/speechSwap:\s*C\('schedule',\s*'speechSwap'\)/.test(S.api), 'api.js 暴露 speechSwap → speechSwap');
check(/api\.scheduleSwap\(/.test(S.manual), '值日排班页调用 api.scheduleSwap');
check(/api\.speechSwap\(/.test(S.speech), '演讲排班页调用 api.speechSwap');
check(/api\.speechSwap\(/.test(S.duty), '课前演讲页调用 api.speechSwap');

console.log('\n── ⑥ 演示班只读白名单');
check(/'dutySwap'/.test(S.demo) && /'speechSwap'/.test(S.demo), '两个新写 action 进 DEMO_WRITE_ACTIONS');

console.log('\n── ⑥b 三处菜单对调项 + 取消文案（只取消本场、不影响一键排班）');
check(/itemList:\s*\['换人',\s*'双向对调',\s*'移除值日'\]/.test(S.manual), '值日排班页菜单含「双向对调」');
check(/itemList:\s*\['换人',\s*'双向对调',\s*'取消演讲'\]/.test(S.speech), '演讲排班页菜单含「双向对调」');
check(/onSpActionExchange/.test(S.duty) && /onSpActionExchange/.test(S.dutyWxml), '课前演讲页动作菜单含「双向对调」handler + 渲染项');
check(/不影响其它场次和后续一键排班/.test(S.duty) && /不影响其它场次和后续一键排班/.test(S.speech),
  '两处取消确认文案说明「只取消本场、不影响后续一键排班」');

console.log('\n── ⑦ 变异自证');
const SRC0 = Object.assign({}, S);
function evalMut(overrides) {
  const x = Object.assign({}, SRC0, overrides);
  const d = stripComments(routeBlock(x.sch, 'dutySwap'));
  const s = stripComments(routeBlock(x.sch, 'speechSwap'));
  return {
    dTwoPhase: (d.match(/UPDATE duty SET member_id/g) || []).length >= 3,
    sNoCursor: !/speech_cursor|base_cursors|pending_cursors/.test(s) && !/saveSpeechCursors\s*\(/.test(s),
    dAuth: /auth:\s*\{\s*scheduleAuth:\s*true\s*\}/.test(d),
    apiBoth: /speechSwap:\s*C\('schedule',\s*'speechSwap'\)/.test(x.api),
    dutyUses: /api\.speechSwap\(/.test(x.duty),
    manualMenuSwap: /itemList:\s*\['换人',\s*'双向对调',\s*'移除值日'\]/.test(x.manual),
    cancelText: /不影响其它场次和后续一键排班/.test(x.duty) && /不影响其它场次和后续一键排班/.test(x.speech)
  };
}
const MUT = [
  { name: 'dutySwap 去掉临时挪开（只剩 2 次 UPDATE，撞唯一键）', probe: 'dTwoPhase',
    apply: (sch) => {
      const b = routeBlock(sch, 'dutySwap');
      // 删掉第一次 UPDATE（临时负值那句，含 “- dutyIdA” 或 “tmpMember”）
      const lines = b.split('\n');
      const idx = lines.findIndex(l => /UPDATE duty SET member_id/.test(l) && /-\s*dutyIdA|tmpMember|tempMember/.test(l));
      if (idx < 0) return sch;
      lines.splice(idx, 1);
      return sch.replace(b, lines.join('\n'));
    }, file: 'sch' },
  { name: 'speechSwap 误加游标推进', probe: 'sNoCursor',
    apply: (sch) => {
      const b = routeBlock(sch, 'speechSwap');
      return b ? sch.replace(b, b.replace('return {};', 'await saveSpeechCursors(pool, classId, { A: 0, B: 0 });\n      return {};')) : sch;
    }, file: 'sch' },
  { name: 'dutySwap 退回 scheduleAuth→speechAuth（权限串）', probe: 'dAuth',
    apply: (sch) => {
      const b = routeBlock(sch, 'dutySwap');
      return b ? sch.replace(b, b.replace('auth: { scheduleAuth: true }', 'auth: { speechAuth: true }')) : sch;
    }, file: 'sch' },
  { name: 'api.js 删掉 speechSwap', probe: 'apiBoth',
    apply: (api) => api.replace(/speechSwap:\s*C\('schedule',\s*'speechSwap'\),?\n?/, ''), file: 'api' },
  { name: '课前演讲页去掉对调调用', probe: 'dutyUses',
    apply: (duty) => duty.replace(/api\.speechSwap\([^)]*\)/g, ''), file: 'duty' },
  { name: '值日页菜单去掉「双向对调」项', probe: 'manualMenuSwap', file: 'manual',
    apply: (manual) => manual.replace("itemList: ['换人', '双向对调', '移除值日']", "itemList: ['换人', '移除值日']") },
  { name: '取消文案改回旧的（不说清只取消本场）', probe: 'cancelText', file: 'duty',
    apply: (duty) => duty.replace('只取消这一场（如临时请假），不影响其它场次和后续一键排班。', '取消后该同学不再参与这场课前演讲') }
];
MUT.forEach(mu => {
  const next = mu.apply(SRC0[mu.file]);
  if (next === SRC0[mu.file]) { console.log('  ✗ 变异「' + mu.name + '」锚点没命中'); failed++; return; }
  const over = {}; over[mu.file] = next;
  check(evalMut(over)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 双向对调路由检查全部通过'));
process.exit(failed ? 1 : 0);
