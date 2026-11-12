#!/usr/bin/env node
/**
 * 门禁：「更多」里两枚超管专属入口的可见性（2026-11-13）
 * =============================================================
 * 用户需求原文：**除非超管从「我的」页面 → 更多进入体验版，其他从口令页进入演示班级的，
 *   在「我的 → 更多」中不显示「切换测试账号」和「切换正式版」。**
 *
 * 为什么不能只看 profile.isSuper：进演示班有两条路，**生效身份都是演示班超管**（is_super=1）
 *   ① 超管「我的 → 更多 → 切换体验版」→ auth.switchDemo（要求**真实身份**是超管）；
 *   ② 口令页 / 一键体验 → auth.reviewDemo（只允许**未绑定**微信，realMember 恒为 null）。
 *   两条最终都写同一张 impersonation 表 ⇒ 第二类体验者的 profile.isSuper 也是真
 *   ⇒ 他们会白看到这两枚按钮，点下去 switchAccount / switchDemo 一律报「仅超级管理员可切换」。
 *
 * ✅ 本门禁钉的不变式：
 *   ① 后端 login 下发 `realIsSuper`，口径必须是 `ctx.realMember && guard.isSuper(ctx.realMember)`
 *      （与 switchDemo / switchAccount 的校验逐字一致；绝不能用生效身份 ctx.member）；
 *   ② 前端 app.js：globalData 有 realIsSuper、login 后赋值、落身份缓存、**进身份指纹**、
 *      解绑时清零；每处 writeCachedAuth(profile,...) 都必须带上它；
 *   ③ 「我的」页 data 有 realIsSuper，且 4 个身份刷新点全部同步（首屏 / ready / recheck / afterSwitch）；
 *   ④ WXML：两行 `wx:if="{{isSuper && realIsSuper}}"`；「返回登录页」条件含 `!realIsSuper`
 *      —— 普通体验者拿不到「切换正式版」，必须留一个退出口（否则正式版里卡在演示班）。
 *
 * 退出码 0 = 过；非 0 = 有问题。
 * 用法：node scripts/check-demo-entry-visibility.js             正常校验
 *      node scripts/check-demo-entry-visibility.js --self-test  变异自证（须全部被抓）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; }
};

const FILES = {
  auth: 'cloudfunctions/auth/index.js',
  app: 'miniprogram/app.js',
  mineJs: 'miniprogram/pages/mine/index.js',
  mineWxml: 'miniprogram/pages/mine/index.wxml'
};

/** 从 marker 起取 len 个字符（用于判某个函数体内的实现） */
function sliceFrom(src, marker, len) {
  const i = src.indexOf(marker);
  return i < 0 ? '' : src.slice(i, i + (len || 800));
}

/** 判据：传入各文件内容，返回未通过条数 */
function judge(f) {
  let n = 0;
  const push = (c, m) => { if (!c) { n += 1; console.log('FAIL  ' + m); } else { console.log('PASS  ' + m); } };

  /* ① 后端口径 —— 只看真实身份，不看生效身份 */
  push(/realIsSuper\s*:\s*!!\(\s*ctx\.realMember\s*&&\s*guard\.isSuper\(\s*ctx\.realMember\s*\)\s*\)/.test(f.auth),
    'auth.login 下发 realIsSuper，口径 = ctx.realMember && guard.isSuper(ctx.realMember)');
  push(!/realIsSuper\s*:\s*!!\(\s*ctx\.member\b/.test(f.auth),
    'realIsSuper 不得用生效身份 ctx.member 判（口令页体验者也是演示班超管）');

  /* ② app.js：赋值 / 缓存 / 指纹 / 解绑清零 */
  push(/realIsSuper:\s*false/.test(f.app), 'app.js globalData 声明 realIsSuper（默认 false）');
  push(/realIsSuper/.test(sliceFrom(f.app, 'async _bootstrap(', 1400)),
    '_bootstrap 内按 login 结果赋值 realIsSuper');
  push(/realIsSuper/.test(sliceFrom(f.app, 'async refreshAuth(', 800)),
    'refreshAuth 内按 login 结果赋值 realIsSuper（切换身份后要跟着变）');
  const cacheCalls = f.app.match(/writeCachedAuth\(g\.profile,[^)]*\)/g) || [];
  push(cacheCalls.length >= 2 && cacheCalls.every((s) => /realIsSuper/.test(s)),
    '每处 writeCachedAuth(g.profile,…) 都带上 realIsSuper（共 ' + cacheCalls.length + ' 处）');
  push(/g\.realIsSuper\s*\?\s*1\s*:\s*0/.test(sliceFrom(f.app, '_identitySig()', 900)),
    '_identitySig 含 realIsSuper（否则升级首启要等切页才出按钮）');
  push(/g\.realIsSuper\s*=\s*false/.test(sliceFrom(f.app, '_handleUnbound()', 700)),
    '_handleUnbound 清零 realIsSuper（解绑后不得继承给下一位绑定者）');
  push(/isRealSuper\s*\(\s*\)\s*\{/.test(f.app), 'app.js 提供 isRealSuper() 供页面使用');

  /* ③ 「我的」页 JS：data + 4 个身份刷新点 */
  push(/realIsSuper:\s*false/.test(f.mineJs), 'mine/index.js data 声明 realIsSuper（默认 false）');
  const sets = (f.mineJs.match(/realIsSuper:\s*!!\(app\.globalData\.realIsSuper\)/g) || []).length;
  push(sets >= 4, 'mine 的 4 个身份刷新点（首屏 / ready / recheck / afterSwitch）均同步 realIsSuper（实得 ' + sets + ' 处）');

  /* ④ WXML 可见性 */
  push(/wx:if="\{\{isSuper && realIsSuper\}\}"[^>]*bindtap="onMoreSwitch"/.test(f.mineWxml),
    '「切换测试账号」行条件 = isSuper && realIsSuper');
  push(/wx:if="\{\{isSuper && realIsSuper\}\}"[^>]*bindtap="onMoreSwitchDemo"/.test(f.mineWxml),
    '「切换体验版 / 切换正式版」行条件 = isSuper && realIsSuper');
  push(!/wx:if="\{\{isSuper\}\}"[^>]*bindtap="onMoreSwitch(Demo)?"/.test(f.mineWxml),
    '两行不得退回只看 isSuper（口令页体验者会白看到）');
  push(/wx:if="\{\{demo && \(!realIsSuper \|\| isTrial\)\}\}"[^>]*bindtap="onBackToLogin"/.test(f.mineWxml),
    '「返回登录页」= demo && (!realIsSuper || isTrial)：普通体验者必须有退出口');
  return n;
}

function loadAll() {
  const out = {};
  Object.keys(FILES).forEach((k) => { out[k] = read(FILES[k]); });
  return out;
}

/** 变异自证：每条变异都应让 judge() 由 0 变 >0 */
function selfTest() {
  const base = loadAll();
  const muts = [
    ['login 口径换成生效身份 ctx.member', 'auth',
      (s) => s.replace(/ctx\.realMember && guard\.isSuper\(ctx\.realMember\)/, 'ctx.member && guard.isSuper(ctx.member)')],
    ['login 不再下发 realIsSuper', 'auth',
      (s) => s.replace(/\n\s*realIsSuper: !!\(ctx\.realMember && guard\.isSuper\(ctx\.realMember\)\),/, '')],
    ['两行 WXML 退回只看 isSuper（核心回归）', 'mineWxml',
      (s) => s.replace(/\{\{isSuper && realIsSuper\}\}/g, '{{isSuper}}')],
    ['「返回登录页」退回只看 isTrial', 'mineWxml',
      (s) => s.replace('{{demo && (!realIsSuper || isTrial)}}', '{{demo && isTrial}}')],
    ['身份缓存不落 realIsSuper', 'app',
      (s) => s.replace(/writeCachedAuth\(g\.profile, g\.switched, g\.demo, g\.realIsSuper\)/g, 'writeCachedAuth(g.profile, g.switched, g.demo)')],
    ['身份指纹漏掉 realIsSuper', 'app',
      (s) => s.replace(', g.switched ? 1 : 0, g.realIsSuper ? 1 : 0]', ', g.switched ? 1 : 0]')],
    ['解绑不清 realIsSuper', 'app',
      (s) => s.replace(/\n\s*g\.realIsSuper = false;[^\n]*/, '')],
    ['我的页少同步一个刷新点', 'mineJs',
      (s) => s.replace(/realIsSuper: !!\(app\.globalData\.realIsSuper\),\n/, '')]
  ];
  let bad = 0;
  muts.forEach((it) => {
    const [name, key, fn] = it;
    const f = Object.assign({}, base);
    const before = f[key];
    f[key] = fn(before);
    if (f[key] === before) { console.log('SELFTEST SKIP 变异未生效：' + name); bad += 1; return; }
    const n = judge(f);
    if (n > 0) { console.log('SELFTEST PASS 抓红(' + n + ')：' + name); }
    else { console.log('SELFTEST FAIL 漏抓：' + name); bad += 1; }
  });
  return bad;
}

if (require.main === module) {
  if (process.argv.indexOf('--self-test') >= 0) {
    console.log('── 变异自证（每条都应被抓）');
    const bad = selfTest();
    console.log('');
    if (bad) { console.log('[FAIL] ' + bad + ' 条自证异常'); process.exit(1); }
    console.log('[PASS] 变异自证全部被抓');
    process.exit(0);
  }
  console.log('── 演示班入口可见性（仅本人是超管才给「切换测试账号 / 切换正式版」）');
  const bad = judge(loadAll());
  console.log('');
  if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
  console.log('[PASS] 演示班入口可见性口径正确');
}

module.exports = { judge };
