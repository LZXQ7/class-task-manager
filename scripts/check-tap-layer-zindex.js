#!/usr/bin/env node
/**
 * 第 73 个门禁：透明点击层不能被兄弟节点盖住
 * =================================================================
 * 2026-10-09 用户报「点击头像更换微信头像好像失效了」。
 *
 * 🔴 根因：`.avatar-wrap` 里的 `avatar-tag` **组件**与那个透明 `<button open-type="chooseAvatar">`
 *    是**同级兄弟**（组件无定位、页面 wxss 全文**一处 z-index 都没有**）
 *    ⇒ 同 z-index 时**后渲染的节点盖在前面之上** ⇒ 透明按钮收不到点击 ⇒ 点头像没反应。
 *
 * ⚠️ **这类 bug 最阴的地方：`check-wxss-compile` 真编译全绿**（语法完全合法），
 *   门禁也看不出来 —— 只能靠"点击行为"发现。
 *   ⇒ 本门禁把「透明点击层必须显式抬层」钉成静态判据，防止回退。
 *
 * 🔴 通用规律（不止头像这一处）：
 *   「绝对定位的透明点击层」+「同级视觉节点」⇒ 必须给点击层显式 `z-index`。
 *   父级要有 `position: relative`（否则 z-index 不生效 —— 相对定位才是定位上下文）。
 *   **不要**靠调 opacity / 尺寸 / 层级顺序去绕，那类改动治标不治本且容易连带破坏布局。
 *
 * 变异自证（4 组）：
 *   M1 去掉 z-index（本 bug 本身：点击层被盖住）
 *   M2 去掉父级的 position:relative（z-index 随之失效）
 *   M3 去掉 width/height 铺满（点击区缩水）
 *   M4 去掉 open-type="chooseAvatar"（面板压根不会弹）
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
console.log('── ① 结构：透明 button 盖在头像上');

chk(/<view class="avatar-wrap">/.test(wxml), '有 .avatar-wrap 容器');
chk(/<button class="avatar-btn" open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar"/.test(wxml),
  '🔴⚠️⚠️ 用 <button open-type="chooseAvatar">（getUserProfile 已被微信回收，只能走这个）');
chk(/<button class="avatar-btn"[^>]*binderror="onAvatarError"/.test(wxml),
  'avatar-btn 必须绑 binderror 兜底（隐私接口检查在微信侧，失败到不了 onChooseAvatar，不兜底就是红屏）');
chk(/class="avatar-wrap">[\s\S]*?<avatar-tag[\s\S]*?\/>/.test(wxml) ||
  /<avatar-tag[^>]*\/>[\s\S]*?class="avatar-btn"/.test(wxml),
  'avatar-tag 与 avatar-btn 同在 .avatar-wrap 内（**兄弟关系** ⇒ 才需要 z-index 抬层）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② 样式：点击层必须显式抬层（本 bug 的核心）');

const wrapRule = /\.avatar-wrap\s*\{([^}]*)\}/.exec(wxss);
chk(!!wrapRule, 'wxss 有 .avatar-wrap 规则');
if (wrapRule) {
  chk(/position:\s*relative/.test(wrapRule[1]),
    '🔴⚠️⚠️ .avatar-wrap 有 `position: relative`'
    + '（**z-index 的前提**：没有相对定位，点击层就找不到定位上下文，z-index 写了也不生效）');
}

const btnRule = /\.avatar-btn\s*\{([^}]*)\}/.exec(wxss);
chk(!!btnRule, 'wxss 有 .avatar-btn 规则');
if (btnRule) {
  const b = btnRule[1];
  chk(/position:\s*absolute/.test(b), '🔴 .avatar-btn 是 absolute（脱离文档流、脱离 avatar-tag 的绘制顺序）');
  chk(/z-index:\s*[1-9]/.test(b),
    '🔴⚠️⚠️🔴 .avatar-btn 有**显式 z-index ≥ 1**（本 bug 的正解：'
    + '无 z-index 时后渲染的 avatar-tag 组件会盖在透明按钮上 ⇒ 点头像没反应；'
    + '⚠️ WXSS 真编译不会报错，只能靠本判据防回退）');
  chk(/width:\s*100%/.test(b) && /height:\s*100%/.test(b),
    '⚠️ 点击层**铺满** .avatar-wrap（否则点击区缩水、边缘点不到）');
  chk(/background:\s*transparent/.test(b), '按钮背景透明（视觉归 avatar-tag）');
  chk(/border:\s*none/.test(b), '去掉 button 默认边框');
}
chk(/\.avatar-btn::after\s*\{[^}]*border:\s*none/.test(wxss),
  '⚠️ 去掉 button::after 的默认边框（否则会有一圈可见描边）');

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ③ 处理链路完整（点了要有反应，不能只修样式）');

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
    '⚠️ 保存成功后 `refreshAuth()` —— 否则 profile 还是旧头像，看着像"没生效"');
  chk(/this\.setData\(\{ profile: app\.globalData\.profile \}/.test(b),
    '⚠️ 用 globalData.profile 刷新页面 profile（不刷则 UI 停在旧头像）');
}
// 后端 action 存在
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

  const w = /\.avatar-wrap\s*\{([^}]*)\}/.exec(vX);
  push(!!w);
  if (w) push(/position:\s*relative/.test(w[1]));
  const b = /\.avatar-btn\s*\{([^}]*)\}/.exec(vX);
  push(!!b);
  if (b) {
    push(/position:\s*absolute/.test(b[1]));
    push(/z-index:\s*[1-9]/.test(b[1]));
    push(/width:\s*100%/.test(b[1]) && /height:\s*100%/.test(b[1]));
    push(/background:\s*transparent/.test(b[1]));
    push(/border:\s*none/.test(b[1]));
  }
  push(/\.avatar-btn::after\s*\{[^}]*border:\s*none/.test(vX));
  push(/<button class="avatar-btn" open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar"/.test(vM));
  push(/<button class="avatar-btn"[^>]*binderror="onAvatarError"/.test(vM));
  return n;
}

const MUT = [
  {
    name: 'M1 去掉 z-index（**本 bug 本身**：点击层被 avatar-tag 盖住 ⇒ 点头像没反应）',
    apply: () => ({ wxss: wxss.replace(/  z-index: 2;\n/, '') })
  },
  {
    name: 'M2 去掉父级的 position:relative（z-index 随之失效 —— 找不到定位上下文）',
    apply: () => ({ wxss: wxss.replace('.avatar-wrap {\n  position: relative;', '.avatar-wrap {') })
  },
  {
    name: 'M3 点击层不铺满（width/height 去掉 ⇒ 点击区缩水、边缘点不到）',
    apply: () => ({
      wxss: wxss.replace('  width: 100%;\n  height: 100%;\n  /* 🔴🔴 必须显式抬层', '  /* 🔴🔴 必须显式抬层')
    })
  },
  {
    name: 'M4 去掉 open-type="chooseAvatar"（面板压根不会弹）',
    apply: () => ({
      wxml: wxml.replace('<button class="avatar-btn" open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar" binderror="onAvatarError"></button>',
        '<button class="avatar-btn" bind:chooseavatar="onChooseAvatar" binderror="onAvatarError"></button>')
    })
  },
  {
    name: 'M5 去掉 binderror 兜底（2026-10-09 实拍红屏：chooseAvatar:fail api scope is not declared in the privacy agreement —— 隐私检查在微信侧，失败走 binderror，不兜底就是 MiniProgramError 红屏）',
    apply: () => ({
      wxml: wxml.replace(' binderror="onAvatarError"></button>', '></button>')
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
console.log('[PASS] 透明点击层体检通过');