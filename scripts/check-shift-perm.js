#!/usr/bin/env node
/**
 * 门禁：后台单独授予「临时调课」权（member.shift_perm，2026-11-28）
 * ============================================================
 * 用户口径（原话）：
 *   「后台页面要和小程序相照应，就是我在后台给谁权限，谁的小程序页面
 *     就会有相应权限的按钮，而不是每次都要更新小程序再上传审核。」
 *
 * 所以判据不是「后台有勾选框」就算完，必须锁住整条实时链路：
 *   ① 列：member.shift_perm（迁移脚本可重复执行前先探测）
 *   ② 内核：guard.hasShiftPerm / canShift / requireShiftAuth，且 17 份副本不漂移
 *   ③ 写路由：course.shiftSet / shiftRemove 改挂 needShiftAuth
 *   ④ 下发：auth.login 每次启动把 canShift 写进 profile（前端不吃缓存职位）
 *   ⑤ 后台：成员编辑可勾/回显，受 members.grant 双闸
 *   ⑥ 小程序：课表页 FAB「临时调课」入口 + 保存守卫都读 profile.canShift
 *
 * 末尾 5 组变异自证：任一环节改回旧写法必须翻红。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = {
  sql: R('scripts/migrate-shift-perm.sql'),
  guard: R('cloudfunctions/common/guard.js'),
  course: R('cloudfunctions/course/index.js'),
  auth: R('cloudfunctions/auth/index.js'),
  mod: R('cloudfunctions/admin-web/lib/mod-member.js'),
  app: R('cloudfunctions/admin-web/public/app.js'),
  tt: R('miniprogram/pages/timetable/index.js'),
  ttwxml: R('miniprogram/pages/timetable/index.wxml')
};
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const has = (s, frag) => String(s).indexOf(frag) >= 0;

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(open + 1, i); }
  }
  return null;
}

function audit(s) {
  const out = [];
  if (!has(s.sql, 'ADD COLUMN shift_perm TINYINT NOT NULL DEFAULT 0')) out.push('缺 shift_perm 迁移列');
  if (has(s.sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n'), 'IF NOT EXISTS')) out.push('迁移用了 TDSQL 不支持的 IF NOT EXISTS');

  const guardHas = extractFn(s.guard, 'hasShiftPerm');
  const guardCan = extractFn(s.guard, 'canShift');
  if (!guardHas || !has(guardHas, 'Number(member.shift_perm) === 1')) out.push('guard 未读 member.shift_perm');
  if (!guardCan || !has(guardCan, 'hasShiftPerm(member)')) out.push('guard.canShift 未并入单独授予');
  if (!has(extractFn(s.guard, 'requireShiftAuth') || '', 'canShift(m)')) out.push('requireShiftAuth 未用 canShift');
  if (!/module\.exports\s*=\s*\{[\s\S]*?hasShiftPerm[\s\S]*?canShift[\s\S]*?requireShiftAuth/.test(s.guard)) out.push('guard 导出不全');

  if (!/shiftSet:\s*\{[\s\S]{0,160}?needShiftAuth:\s*true/.test(s.course)) out.push('shiftSet 未改挂 needShiftAuth');
  if (!/shiftRemove:\s*\{[\s\S]{0,160}?needShiftAuth:\s*true/.test(s.course)) out.push('shiftRemove 未改挂 needShiftAuth');
  if (!has(s.course, 'route.auth.needShiftAuth) guard.requireShiftAuth(ctx)')) out.push('course 路由未分派 needShiftAuth');

  if (!has(s.auth, 'canShift: !!(guard.isSuper(m) || guard.hasShiftPerm(m))')) out.push('auth.login 未实时下发 canShift');

  if (!has(s.mod, 'shiftPerm: Number(r.shift_perm) === 1')) out.push('后台列表未回显 shiftPerm');
  if (!has(s.mod, "if (patch.shiftPerm !== undefined)") || !has(s.mod, "typeof patch.shiftPerm !== 'boolean'")) out.push('后台未校验 shiftPerm 布尔');
  if (!has(s.mod, 'delete patch.shiftPerm;')) out.push('无 members.grant 未剥离 shiftPerm');
  if (!has(s.mod, "put('shift_perm', patch.shiftPerm ? 1 : 0)")) out.push('后台 UPDATE 未写 shift_perm');
  if (!/INSERT INTO member[^;]*shift_perm\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?\)/.test(s.mod)) out.push('后台 INSERT 未带 shift_perm');

  if (!has(s.app, 'id="f-perm-shift"')) out.push('成员编辑缺「可临时调课」勾选框');
  if (!has(s.app, '+临时调课')) out.push('成员列表缺 +临时调课 标签');
  if (!has(s.app, 'body.shiftPerm =')) out.push('成员编辑未提交 shiftPerm');

  if (!has(s.tt, 'canShift: false')) out.push('课表页 data 缺 canShift');
  if (!has(s.tt, 'canShift: !!(p.canShift || isSuper)')) out.push('课表页未按登录下发重算 canShift');
  if (!has(s.tt, 'this.data.canShift) items.push({ key: \'SHIFT\'')) out.push('FAB 入口未读 canShift');
  if (!has(s.tt, '!this.data.canShift) { util.toast(')) out.push('保存守卫未读 canShift');
  if (!has(s.ttwxml, 'canShift && hasTimetable')) out.push('长按提示未读 canShift');
  return out;
}

(async function main() {
  console.log('=== 后台单独授予「临时调课」权门禁 ===');
  const problems = audit(SRC);
  ok('全链路静态接线', problems.length === 0, problems.join('；'));

  // 17 份 common 副本漂移检查（云函数不能跨函数 require）
  const copies = fs.readdirSync(path.join(ROOT, 'cloudfunctions'))
    .map(d => path.join(ROOT, 'cloudfunctions', d, 'common', 'guard.js'))
    .filter(f => fs.existsSync(f) && !f.endsWith(path.join('common', 'guard.js') + '.skip'));
  const drifted = copies.filter(f => {
    const t = fs.readFileSync(f, 'utf8');
    return !has(t, 'hasShiftPerm') || !has(t, 'canShift') || !has(t, 'requireShiftAuth');
  }).map(f => f.replace(path.join(ROOT) + path.sep, ''));
  ok('common/guard.js 副本无漂移（' + copies.length + ' 份）', drifted.length === 0, drifted.join(','));

  // 行为层：真跑提取出来的内核函数
  const bh = extractFn(SRC.guard, 'hasShiftPerm');
  const bc = extractFn(SRC.guard, 'canShift');
  let canShift = null;
  if (bh && bc) {
    try {
      /* eslint-disable no-new-func */
      const make = new Function('isSuper', 'isCommittee',
        'function hasShiftPerm(member){' + bh + '}\n' +
        'function canShift(member){' + bc + '}\nreturn canShift;');
      canShift = make(m => !!m && Number(m.is_super) === 1,
        m => !!m && ['ADMIN', 'MONITOR'].includes(m.role) && m.group_tag !== 'X');
    } catch (e) { canShift = null; }
  }
  ok('内核可真跑', !!canShift);
  if (canShift) {
    ok('普通成员无授权 ⇒ 不能调课', canShift({ shift_perm: 0, role: 'MEMBER' }) === false);
    ok('后台勾上 shift_perm=1 ⇒ 立刻可调课', canShift({ shift_perm: 1, role: 'MEMBER' }) === true);
    ok('超管恒可（旧行为不回退）', canShift({ is_super: 1, shift_perm: 0 }) === true);
    ok('原有班委后端权限不回退', canShift({ role: 'ADMIN', group_tag: 'A', shift_perm: 0 }) === true);
  }

  // 变异自证：任一环节改回旧写法，audit 必须报出来
  const muts = [
    ['guard.canShift 去掉单独授予', () => ({ ...SRC, guard: SRC.guard.replace(' || hasShiftPerm(member)', '') })],
    ['shiftSet 改回 needCommittee', () => ({ ...SRC, course: SRC.course.replace('shiftSet: {\n    auth: { needShiftAuth: true }', 'shiftSet: {\n    auth: { needCommittee: true }') })],
    ['auth.login 不下发 canShift', () => ({ ...SRC, auth: SRC.auth.replace('canShift: !!(guard.isSuper(m) || guard.hasShiftPerm(m))', 'canShift: false') })],
    ['后台 UPDATE 漏写 shift_perm', () => ({ ...SRC, mod: SRC.mod.replace("if (patch.shiftPerm !== undefined) put('shift_perm', patch.shiftPerm ? 1 : 0);", '') })],
    ['小程序保存守卫退回 isSuper', () => ({ ...SRC, tt: SRC.tt.replace('if (!this.data.canShift) { util.toast(', 'if (!this.data.isSuper) { util.toast(') })]
  ];
  muts.forEach(([name, build]) => {
    const bad = build();
    const mutated = Object.keys(SRC).some(k => bad[k] !== SRC[k]);
    ok('变异·' + name + ' 必翻红', mutated && audit(bad).length > 0);
  });

  console.log('check-shift-perm: 通过 ' + pass + ' / 失败 ' + fail);
  process.exitCode = fail ? 1 : 0;
})();
