#!/usr/bin/env node
/**
 * 第 73 个门禁：头像点击层（chooseAvatar）
 * =================================================================
 * 2026-10-09 用户报「点击头像更换微信头像失效」：旧实现是「透明 button 绝对铺在
 *   avatar-tag 上 + z-index 抬层」，自定义组件与原生 button 的层级在真机仍偶发错位
 *   ⇒ 透明按钮收不到点击 ⇒ 点头像没反应。
 * 2026-10-16 重构：改为「<button open-type=chooseAvatar> 直接包裹 avatar-tag」，
 *   点击区域就是 button 本身，无叠层歧义。本门禁同步改判据，锁死新结构。
 *
 * 新结构不变量：
 *   ① 结构：button(class=avatar-btn, open-type=chooseAvatar) 内含 avatar-tag（父子，非兄弟）；
 *           必须绑 bind:chooseavatar + binderror。
 *   ② 样式：.avatar-btn 重置为 80rpx 圆形 flex 容器（display:flex / width:80rpx /
 *           height:80rpx / border-radius:50% / background:transparent / border:none /
 *           ::after border:none）；**禁止** position:absolute + z-index（那是旧坏模式，
 *           回退到它就会被 M4 抓到）。
 *   ③ 链路：onChooseAvatar 从 e.detail.avatarUrl 取临时路径 → 上传云存储 →
 *           api.updateAvatar 存库 → refreshAuth + setData 刷新页面。
 *
 * 变异自证（4 组）：
 *   M1 去掉 open-type="chooseAvatar"（面板压根不会弹）
 *   M2 去掉 bind:chooseavatar（选了也不存）
 *   M3 去掉 binderror（隐私拦截时红屏）
 *   M4 回退旧坏模式：给 .avatar-btn 加 position:absolute + z-index（被"禁止 absolute/z-index"抓到）
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

const WXSS = 'miniprogram/pages/mine/index.wxss';
const WXML = 'miniprogram/pages/mine/index.wxml';
const JS = 'miniprogram/pages/mine/index.js';

const wxss = read(WXSS);
const wxml = read(WXML);
const js = read(JS);

/* ------------------------------------------------------------------ */
console.log('── ① 结构：button 直接包裹 avatar-tag（父子，非兄弟叠层）');

chk(/<button class="avatar-btn" open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar"/.test(wxml),
  '🔴⚠️⚠️ 用 <button open-type="chooseAvatar"> 包裹头像（getUserProfile 已被微信回收，只能走这个）');
chk(/<button class="avatar-btn"[^>]*binderror="onAvatarError"/.test(wxml),
  'avatar-btn 必须绑 binderror 兜底（隐私接口检查在微信侧，失败到不了 onChooseAvatar，不兜底就是红屏）');
// avatar-tag 必须位于 button 内部（button 开标签 → avatar-tag → </button>）
chk(/<button class="avatar-btn"[^>]*>[\s\S]*?<avatar-tag[\s\S]*?<\/button>/.test(wxml),
  '🔴 avatar-tag 必须位于 button **内部**（父子关系 ⇒ 点击区就是按钮本身，无叠层歧义）');
chk(!/<view class="avatar-wrap">/.test(wxml),
  '⚠️ 不再用「透明按钮叠在 avatar-wrap 上」的旧结构（真机偶发失效，已废弃）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② 样式：button 重置为 80rpx 圆形 flex 容器，且不许回退到 absolute 叠层');

const btnRule = /\.avatar-btn\s*\{([^}]*)\}/.exec(wxss);
chk(!!btnRule, 'wxss 有 .avatar-btn 规则');
if (btnRule) {
  const b = btnRule[1];
  chk(/display:\s*flex/.test(b), '🔴 .avatar-btn 是 flex 容器（内部 avatar-tag 居中铺满）');
  chk(/width:\s*80rpx/.test(b) && /height:\s*80rpx/.test(b),
    '🔴 .avatar-btn 固定 80rpx（点击区 = 头像尺寸，不缩水）');
  chk(/border-radius:\s*50%/.test(b), '圆形（与头像一致）');
  chk(/background:\s*transparent/.test(b), '按钮背景透明');
  chk(/border:\s*none/.test(b), '去掉 button 默认边框');
  chk(/\.avatar-btn::after\s*\{[^}]*border:\s*none/.test(wxss),
    '⚠️ 去掉 button::after 默认边框（否则可见描边）');
  chk(!/position:\s*absolute/.test(b),
    '🔴⚠️⚠️ 禁止 position:absolute（那是旧坏模式：透明层叠在组件上，真机偶发收不到点击）');
  chk(!/z-index/.test(b),
    '🔴⚠️⚠️ 禁止 z-index（新结构靠父子包裹，不靠层级抬升；回退到旧模式必被变异 M4 抓到）');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ③ 处理链路完整（点了要有反应，不能只修结构）');

chk(/onChooseAvatar\(e\)\s*\{/.test(js), 'js 有 onChooseAvatar');
const h = /onChooseAvatar\(e\)\s*\{([\s\S]*?)\n {2}\},/.exec(js);
chk(!!h, '能定位 onChooseAvatar');
if (h) {
  const b = h[1];
  chk(/e\.detail\.avatarUrl/.test(b), '从 e.detail.avatarUrl 取临时路径');
  chk(/wx\.cloud\.uploadFile/.test(b), '上传到云存储（小程序 image 组件直接支持 cloud:// 显示）');
  chk(/api\.updateAvatar\(\{ avatarUrl: fileID \}/.test(b),
    '🔴⚠️ 调 api.updateAvatar 存库（字段名 avatarUrl，与后端 auth.updateAvatar 对齐）');
  chk(/app\.refreshAuth\(\)/.test(b),
    '⚠️ 保存成功后 refreshAuth()（否则 profile 还是旧头像，看着像"没生效"）');
  chk(/this\.setData\(\{ profile: app\.globalData\.profile \}/.test(b),
    '⚠️ 用 globalData.profile 刷新页面 profile（不刷则 UI 停在旧头像）');
}
const auth = read('cloudfunctions/auth/index.js');
chk(/updateAvatar:\s*\{/.test(auth), '🔴 后端 auth.updateAvatar action 存在（api 打到 auth 函数）');
chk(/UPDATE member SET avatar_url = \? WHERE id = \?/.test(auth), '后端真的写库');
chk(/avatarUrl: m\.avatar_url \|\| ''/.test(auth),
  '⚠️ auth.login 回 avatarUrl（否则 refreshAuth 之后页面仍拿不到新头像）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ④ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

function judge(o) {
  o = o || {};
  const vX = o.wxss || wxss;
  const vM = o.wxml || wxml;
  let n = 0;
  const push = (x) => { if (!x) n += 1; };

  push(/<button class="avatar-btn" open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar"/.test(vM));
  push(/<button class="avatar-btn"[^>]*binderror="onAvatarError"/.test(vM));
  push(/<button class="avatar-btn"[^>]*>[\s\S]*?<avatar-tag[\s\S]*?<\/button>/.test(vM));
  push(!/<view class="avatar-wrap">/.test(vM));

  const b = /\.avatar-btn\s*\{([^}]*)\}/.exec(vX);
  push(!!b);
  if (b) {
    push(/display:\s*flex/.test(b[1]));
    push(/width:\s*80rpx/.test(b[1]) && /height:\s*80rpx/.test(b[1]));
    push(/border-radius:\s*50%/.test(b[1]));
    push(/background:\s*transparent/.test(b[1]));
    push(/border:\s*none/.test(b[1]));
    push(!/position:\s*absolute/.test(b[1]));
    push(!/z-index/.test(b[1]));
  }
  push(/\.avatar-btn::after\s*\{[^}]*border:\s*none/.test(vX));
  return n;
}

const MUT = [
  {
    name: 'M1 去掉 open-type="chooseAvatar"（面板压根不会弹）',
    apply: () => ({ wxml: wxml.replace(' open-type="chooseAvatar"', '') })
  },
  {
    name: 'M2 去掉 bind:chooseavatar（选了头像也不存库）',
    apply: () => ({ wxml: wxml.replace(' bind:chooseavatar="onChooseAvatar"', '') })
  },
  {
    name: 'M3 去掉 binderror 兜底（隐私拦截时 MiniProgramError 红屏）',
    apply: () => ({ wxml: wxml.replace(' binderror="onAvatarError"', '') })
  },
  {
    name: 'M4 回退旧坏模式：给 .avatar-btn 加 position:absolute + z-index（叠层偶发失效）',
    apply: () => ({
      wxss: wxss.replace('  line-height: 1;\n  overflow: hidden;\n}',
        '  line-height: 1;\n  overflow: hidden;\n  position: absolute;\n  top: 0;\n  left: 0;\n  z-index: 2;\n}')
    })
  }
];

let caught = 0;
MUT.forEach((c) => {
  const before = judge();
  if (before !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  const orig = { wxss, wxml };
  const touched = ['wxss', 'wxml'].some((k) => over[k] && over[k] !== orig[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效：replace 找不到就原样返回）⇒ 门禁测的是原文件。**先修锚点。**');
    bad += 1;
    return;
  }
  let n;
  try { n = judge(over); } catch (e) {
    fail('变异「' + c.name + '」跑挂了（' + e.message + '）');
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
console.log('[PASS] 头像点击层体检通过');
