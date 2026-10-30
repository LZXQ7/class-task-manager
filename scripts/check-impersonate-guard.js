#!/usr/bin/env node
/**
 * 离线自检：「切换测试账号」模拟态必须有全局醒目护栏（v1.0.5）
 * ------------------------------------------------------------
 * 背景（真实风险，不是假想）：超管在「我的」页点「切换测试账号」后，
 * `common/guard.js` 的 getContext() 会把**所有云函数的生效身份**替换成目标账号，
 * 于是后续操作（发通知 / 排班 / 成员增删 / 操作日志）全部记在**目标账号名下**。
 *
 * 而可切换目标里有**一位真人持有**的账号：示例成员57 · 辅导员（学号 000000000090，
 * 特意放在 99 段供超管进入辅导员视角）。没有醒目提示 = 会以她的名义静默操作。
 *
 * 旧实现的护栏只在「我的」页有一枚小标签 —— 离开「我的」页（去首页发通知、
 * 去值日页排班、去课表页调课）就完全无感知。
 *
 * 本门禁守住 6 件事：
 *   ① 4 个 tab 页都渲染了 danger 横幅 + 「恢复本人」按钮；
 *   ② 4 个 tab 页都在 json 里注册了 notice-bar（漏注册 = 组件静默不渲染）；
 *   ③ 横幅在**身份套用处**同步（登录晚于 onShow 完成时也能补上）；
 *   ④ 横幅必须在 spring-scroll **之外**（进去会被 .ss-content 的 transform 建包含块、且跟着滚走）；
 *   ⑤ recover() 走「清 impersonation → 刷新登录态 → reLaunch」，不是原地打补丁；
 *   ⑥ 「不与真人冲突」的两个技术前提仍在：switchAccount 用 realMember 鉴权、
 *      impersonation 按**调用者 openid** 键（不是按目标 member）。
 *
 * 自证（双向）：任一环拆掉 → 必被抓；源码原样 → 不得误报。
 *
 * 用法：node scripts/check-impersonate-guard.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function chk(cond, msg) { if (cond) ok(msg); else bad(msg); }

/** 取「名字(参数) { … }」的花括号配对函数体；-1 不能省（见 check-unbind-route.js 的踩坑注释） */
function braceBlock(src, from) {
  const s = src.indexOf('{', from);
  if (s < 0) return null;
  let depth = 0;
  for (let i = s; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (!depth) return src.slice(s + 1, i);
    }
  }
  return null;
}
function bodyOf(src, nameRe) {
  const m = nameRe.exec(src);
  if (!m) return null;
  return braceBlock(src, m.index + m[0].length - 1);
}

/** 4 个 tab 页（tabBar 全集）—— 用户口径就是「这 4 页都要看到」 */
const TABS = [
  { key: 'home', label: '首页', json: 'miniprogram/pages/home/index.json' },
  { key: 'tt', label: '课表', json: 'miniprogram/pages/timetable/index.json' },
  { key: 'duty', label: '值日', json: 'miniprogram/pages/duty/index.json' },
  { key: 'mine', label: '我的', json: 'miniprogram/pages/mine/index.json' }
];

/**
 * 纯函数审计（变异自证复用）：吃一份「源码快照」，吐问题列表。
 * s = { homeWxml, homeJs, ttWxml, ttJs, dutyWxml, dutyJs, mineWxml, mineJs,
 *       impersonate, auth, guard, homeJson, ttJson, dutyJson, mineJson }
 */
function audit(s) {
  const p = [];
  const wxmlOf = { home: s.homeWxml, tt: s.ttWxml, duty: s.dutyWxml, mine: s.mineWxml };
  const jsOf = { home: s.homeJs, tt: s.ttJs, duty: s.dutyJs, mine: s.mineJs };
  const jsonOf = { home: s.homeJson, tt: s.ttJson, duty: s.dutyJson, mine: s.mineJson };

  // ① + ④ 每个 tab 页都渲染护栏横幅，且位置在滚动容器之外
  TABS.forEach(({ key, label }) => {
    const wxml = wxmlOf[key];
    if (!/impersonateBanner/.test(wxml)) {
      p.push(label + '：没有渲染「模拟中」横幅（离开「我的」页就完全无感知）');
      return;
    }
    if (!/<notice-bar[\s\S]{0,240}?type="danger"[\s\S]{0,240}?text="\{\{impersonateBanner\}\}"[\s\S]{0,240}?btnText="恢复本人"/.test(wxml)) {
      p.push(label + '：横幅不是 danger 醒目样式，或缺 text/btnText（护栏不够醒目 = 等于没加）');
    }
    if (!/bind:action="onRecoverSelf"/.test(wxml)) {
      p.push(label + '：横幅没接 bind:action="onRecoverSelf"，「恢复本人」点了没反应');
    }
    const bi = wxml.indexOf('impersonateBanner');
    const si = wxml.indexOf('<spring-scroll');
    if (si >= 0 && bi > si) {
      p.push(label + '：横幅落在 spring-scroll 之内（会被 .ss-content 的 transform 建包含块、还会跟着内容滚走）');
    }
  });

  // ② notice-bar 必须在本页 json 注册 —— 漏注册时组件静默不渲染，页面白留一条空
  TABS.forEach(({ key, label }) => {
    if (!/"notice-bar"\s*:/.test(jsonOf[key])) {
      p.push(label + '：index.json 没注册 notice-bar 组件（横幅会静默不渲染）');
    }
  });

  // ③ 身份套用处同步：登录晚于 onShow 完成时也要补上横幅
  {
    const homeApply = bodyOf(strip(s.homeJs), /_\s*applyIdentity\s*\([^)]*\)\s*\{/);
    if (!homeApply || !/impersonate\.sync\s*\(\s*this\s*\)/.test(homeApply)) {
      p.push('首页：_applyIdentity 里没有 impersonate.sync(this)（登录晚到时横幅不会出现）');
    }
    ['tt', 'duty'].forEach((key) => {
      const label = key === 'tt' ? '课表' : '值日';
      const apply = bodyOf(strip(jsOf[key]), /applyAuth\s*=\s*\([^)]*\)\s*=>\s*\{/)
        || bodyOf(strip(jsOf[key]), /applyAuth\s*\([^)]*\)\s*\{/);
      if (!apply || !/impersonate\.sync\s*\(\s*this\s*\)/.test(apply)) {
        p.push(label + '：applyAuth 里没有 impersonate.sync(this)（app.ready() 补套身份时横幅不会出现）');
      }
    });
    const mineJs = strip(s.mineJs);
    const mineOnShow = bodyOf(mineJs, /onShow\s*\([^)]*\)\s*\{/) || '';
    const mineAfter = bodyOf(mineJs, /_\s*afterSwitch\s*\([^)]*\)\s*\{/) || '';
    if (!/impersonate\.bannerText\s*\(\s*\)/.test(mineOnShow)) {
      p.push('我的：onShow 没有 impersonate.bannerText()，切回来横幅不刷新');
    }
    if (!/impersonate\.bannerText\s*\(\s*\)/.test(mineAfter)) {
      p.push('我的：_afterSwitch 没有 impersonate.bannerText()，刚切换完横幅不出现');
    }
    // ⑥-补 同一页不得出现第二个「恢复本人」入口（双入口看起来像 bug）
    if (/onSwitchBack/.test(s.mineJs) || /点此恢复本人/.test(s.mineWxml)) {
      p.push('我的：卡片里还留着第二个「恢复本人」入口，与顶部横幅重复');
    }
  }

  // ⑤ recover()：清 impersonation → 刷新登录态 → reLaunch，而不是原地打补丁
  {
    const rec = bodyOf(strip(s.impersonate), /function\s+recover\s*\([^)]*\)\s*\{/);
    if (!rec) {
      p.push('utils/impersonate.js 缺 recover()');
    } else {
      if (!/memberId\s*:\s*0/.test(rec)) p.push('recover() 没有传 memberId: 0（清不掉 impersonation 映射）');
      if (!/refreshAuth\s*\(/.test(rec)) p.push('recover() 没有刷新登录态（globalData.switched 仍为 true）');
      if (!/reLaunch\s*\(/.test(rec)) p.push('recover() 不是 reLaunch：模拟态切走后权限/可见范围整体变了，原地补丁会漏页面');
    }
    if (!/function\s+bannerText\s*\(/.test(s.impersonate) || !/g\.switched/.test(s.impersonate)) {
      p.push('utils/impersonate.js 的 bannerText() 没有读 globalData.switched（横幅永远不出现）');
    }
  }

  // ⑥ 「不与辅导员本人冲突」的两个技术前提
  {
    const sw = bodyOf(strip(s.auth), /switchAccount\s*:\s*\{/);
    if (!sw || !/ctx\.realMember/.test(sw)) {
      p.push('auth.switchAccount 不再用 ctx.realMember 鉴权：切到测试账号后会被模拟身份的权限锁死、切不回来');
    }
    // ⚠️ 必须锚定到 impersonation 这条查询上：guard.js 里另有一处
    //    `SELECT * FROM member WHERE openid = ?`，只写 /WHERE openid = ?/ 会被它顶掉 →
    //    把 impersonation 改成按 member_id 键的变异**查不出来**（本门禁变异 7 实测踩到过）。
    if (!/FROM\s+impersonation\s+WHERE\s+openid\s*=\s*\?/.test(s.guard)) {
      p.push('guard.getContext 的 impersonation 查询不再按调用者 openid 键：会波及目标账号本人（真人在用会串号）');
    }
  }
  return p;
}

console.log('── 「切换测试账号」模拟态护栏体检');
const SRC = {
  homeWxml: read('miniprogram/pages/home/index.wxml'),
  homeJs: read('miniprogram/pages/home/index.js'),
  ttWxml: read('miniprogram/pages/timetable/index.wxml'),
  ttJs: read('miniprogram/pages/timetable/index.js'),
  dutyWxml: read('miniprogram/pages/duty/index.wxml'),
  dutyJs: read('miniprogram/pages/duty/index.js'),
  mineWxml: read('miniprogram/pages/mine/index.wxml'),
  mineJs: read('miniprogram/pages/mine/index.js'),
  impersonate: read('miniprogram/utils/impersonate.js'),
  auth: read('cloudfunctions/auth/index.js'),
  guard: read('cloudfunctions/common/guard.js'),
  homeJson: read('miniprogram/pages/home/index.json'),
  ttJson: read('miniprogram/pages/timetable/index.json'),
  dutyJson: read('miniprogram/pages/duty/index.json'),
  mineJson: read('miniprogram/pages/mine/index.json')
};

const problems = audit(SRC);
if (problems.length) problems.forEach(x => bad(x));
else ok('① 4 个 tab 页（首页/课表/值日/我的）都渲染 danger 横幅 + 「恢复本人」');
if (!problems.length) ok('② 4 页 json 都注册了 notice-bar 组件');
if (!problems.length) ok('③ 横幅在身份套用处同步（登录晚到也补上）');
if (!problems.length) ok('④ 横幅在 spring-scroll 之外（不被 transform 包含块吞掉、不跟着滚）');
if (!problems.length) ok('⑤ recover() = 清 impersonation → refreshAuth → reLaunch');
if (!problems.length) ok('⑥ switchAccount 用 realMember 鉴权 + impersonation 按调用者 openid 键');

console.log('\n── 自证：拆掉任一环必被抓（变异必抓 + 好样本不误报）');
{
  chk(audit(SRC).length === 0, '好样本：现有源码无问题（不误报）');

  // 变异 1：值日页不再渲染横幅
  const m1 = Object.assign({}, SRC, {
    dutyWxml: SRC.dutyWxml.replace(/<notice-bar[\s\S]*?bind:action="onRecoverSelf"\s*\/>/, '')
  });
  chk(m1.dutyWxml !== SRC.dutyWxml && audit(m1).length > 0, '变异 1：值日页摘掉横幅 → 被抓住');

  // 变异 2：课表页不再在 applyAuth 里同步横幅
  const m2 = Object.assign({}, SRC, {
    ttJs: SRC.ttJs.replace('impersonate.sync(this);', '')
  });
  chk(m2.ttJs !== SRC.ttJs && audit(m2).length > 0, '变异 2：课表页 applyAuth 不同步横幅 → 被抓住');

  // 变异 3：横幅被挪进 spring-scroll 之内（模拟「位置放错」）
  const m3 = Object.assign({}, SRC, { homeWxml: '<spring-scroll class="x">' + SRC.homeWxml });
  chk(audit(m3).length > 0, '变异 3：横幅落进 spring-scroll 之内 → 被抓住');

  // 变异 4：漏注册 notice-bar 组件
  const m4 = Object.assign({}, SRC, { mineJson: SRC.mineJson.replace(/"notice-bar"\s*:\s*"[^"]*"\s*,?/, '') });
  chk(m4.mineJson !== SRC.mineJson && audit(m4).length > 0, '变异 4：我的页漏注册 notice-bar → 被抓住');

  // 变异 5：recover() 改回原地刷新（不 reLaunch）。
  // ⚠️ 2026-10-29：recover() 现按「是否未绑定」分流到 bind/home，锚点改用正则匹配整个 reLaunch 调用。
  const m5 = Object.assign({}, SRC, {
    impersonate: SRC.impersonate.replace(/wx\.reLaunch\([^)]*\);/, '// noop')
  });
  chk(m5.impersonate !== SRC.impersonate && audit(m5).length > 0, '变异 5：recover() 不再 reLaunch → 被抓住');

  // 变异 6：switchAccount 改用生效身份鉴权（切过去就切不回来）
  const m6 = Object.assign({}, SRC, {
    auth: SRC.auth.replace('const me = ctx.realMember;', 'const me = ctx.member;')
  });
  chk(m6.auth !== SRC.auth && audit(m6).length > 0, '变异 6：switchAccount 用 ctx.member 鉴权 → 被抓住');

  // 变异 7：impersonation 不再按调用者 openid 键（会波及真人）。
  // ⚠️ 2026-10-29：guard.getContext 现有 **两处** 同形 impersonation 查询（已绑定 / 未绑定分支）⇒
  //    必须全局替换，否则第一处被改、第二处仍在，审计照样能搜到 ⇒ 变异抓不到（假自证）。
  const m7 = Object.assign({}, SRC, {
    guard: SRC.guard.replace(/FROM impersonation WHERE openid = \?/g, 'FROM impersonation WHERE member_id = ?')
  });
  chk(m7.guard !== SRC.guard && audit(m7).length > 0, '变异 7：impersonation 查询不再按 openid 键 → 被抓住');
}

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 模拟态护栏体检全部通过'));
process.exit(failed ? 1 : 0);
