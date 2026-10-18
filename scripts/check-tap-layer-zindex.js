#!/usr/bin/env node
/**
 * 第 73 个门禁：头像点击层（chooseAvatar）+ 头像占位尺寸
 * =================================================================
 * 演进史（三次真机回归，别再走回头路）：
 *   2026-10-09 「透明 button 绝对铺在 avatar-tag 上 + z-index 抬层」⇒ 真机偶发收不到点击。
 *   2026-10-16 改「<button open-type=chooseAvatar> 直接包裹头像」⇒ 点击稳了，但布局坏了。
 *   2026-10-18 「button 内只放内置 <image>」⇒ 空框仍在，用户复报「占位太大、头像要往左」。
 *   2026-10-18(2) 定论：**button 只要在文档流里，就会被撑成「内容宽 + 默认 padding」≈121rpx
 *              的空框**，与内部放什么无关（自定义组件还会被渲染到按钮右侧外面、右移 ~87px）。
 *              ⇒ button 必须**留空 + absolute 脱离文档流**，头像元素走正常流贴左。
 *
 * 新结构不变量：
 *   ① WXML：<view class="avatar-slot"> 内含
 *           <image class="avatar-img">（有头像）/ <view class="avatar-fallback">（回落字符）
 *           + **留空**的 <button class="avatar-btn" open-type=chooseAvatar
 *             bind:chooseavatar=binderror>（内部只允许空白，禁任何子节点）
 *   ② WXSS：.avatar-slot = position:relative + 96rpx 定宽；
 *           .avatar-btn = position:absolute + left/top:0 + 96rpx + transparent + border:none
 *           + ::after border:none；头像图/回落块都是 96rpx 圆形。
 *   ③ 链路：onChooseAvatar → 上传云存储 → api.updateAvatar → refreshAuth + setData。
 *
 * 变异自证（6 组）：
 *   M1 去掉 open-type="chooseAvatar"（面板压根不会弹）
 *   M2 去掉 bind:chooseavatar（选了也不存）
 *   M3 去掉 binderror（隐私拦截时红屏）
 *   M4 .avatar-btn 去掉 position:absolute（回文档流 ⇒ 121rpx 空框 + 头像右移复现）
 *   M5 往空 button 里塞 <image class="avatar-img">（内容撑大按钮的空框复现）
 *   M6 .avatar-slot 去掉 position:relative（绝对按钮失去定位上下文，乱飘压住别处）
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const WXSS = 'miniprogram/pages/mine/index.wxss';
const WXML = 'miniprogram/pages/mine/index.wxml';
const JS = 'miniprogram/pages/mine/index.js';

const wxss = read(WXSS);
const wxml = read(WXML);
const js = read(JS);

/** 取 <button class="avatar-btn" ...> 的内部 HTML */
function btnInner(src) {
  const m = /<button class="avatar-btn"[^>]*>([\s\S]*?)<\/button>/.exec(src);
  return m ? m[1] : null;
}
/** 取某条 CSS 规则的声明体 */
function rule(src, sel) {
  const m = new RegExp(sel.replace(/[.\-:]/g, (c) => '\\' + c) + '\\s*\\{([^}]*)\\}').exec(src);
  return m ? m[1] : null;
}

/**
 * 统一判据：返回 [{ok, msg}]。真跑与变异共用同一份，避免"判据与实现漂移"。
 */
function checks(vX, vM) {
  const out = [];
  const add = (ok, msg) => out.push({ ok: !!ok, msg });
  const btns = vM.match(/<button class="avatar-btn"[^>]*>/g) || [];
  const inner = btnInner(vM);
  const slot = rule(vX, '.avatar-slot');
  const btn = rule(vX, '.avatar-btn');

  /* ① 结构 ---------------------------------------------------------- */
  add(/<view class="avatar-slot">/.test(vM), '有 .avatar-slot 定宽槽位（头像贴左的布局锚点）');
  add(btns.length === 1, '恰好一个 avatar-btn（多一个就会出现一个幽灵空框）');
  add(/<button class="avatar-btn" open-type="chooseAvatar" bind:chooseavatar="onChooseAvatar"/.test(vM),
    '🔴⚠️⚠️ <button open-type="chooseAvatar">（getUserProfile 已被微信回收，只能走这个）');
  add(/<button class="avatar-btn"[^>]*binderror="onAvatarError"/.test(vM),
    'avatar-btn 必须绑 binderror 兜底（隐私检查在微信侧，失败到不了 onChooseAvatar，不兜底就是红屏）');
  add(inner !== null && inner.trim() === '',
    '🔴⚠️⚠️ button 必须**留空**——任何子节点都会把按钮重新撑成 ~121rpx 空框');
  add(/<image[^>]*class="avatar-img"/.test(vM) && /<view[^>]*class="avatar-fallback"/.test(vM),
    '头像图 + 姓氏色块回落都在（无头像 / 加载失败不留空）');
  add(!/<avatar-tag/.test(vM.split('<!-- 我的申请')[0] || ''),
    '🔴 头像位上不用 avatar-tag 自定义组件（本页弹层里照常可用，但别放回头像位）');

  /* ② 样式 ---------------------------------------------------------- */
  add(slot !== null, 'wxss 有 .avatar-slot 规则');
  if (slot) {
    add(/position:\s*relative/.test(slot), '🔴 .avatar-slot 是 relative（否则 absolute 按钮无处可依）');
    add(/width:\s*96rpx/.test(slot) && /height:\s*96rpx/.test(slot),
      '🔴 .avatar-slot 固定 96rpx（头像尺寸 = 点击区，不缩水也不膨胀）');
    add(/flex-shrink:\s*0/.test(slot), '⚠️ flex-shrink:0（窄屏下别把头像压扁）');
  }
  add(btn !== null, 'wxss 有 .avatar-btn 规则');
  if (btn) {
    add(/position:\s*absolute/.test(btn),
      '🔴⚠️⚠️ .avatar-btn 必须 absolute（回文档流 ⇒ 121rpx 空框 + 头像右移复现）');
    add(/left:\s*0/.test(btn) && /top:\s*0/.test(btn), '绝对定位贴槽位左上角');
    add(/width:\s*96rpx/.test(btn) && /height:\s*96rpx/.test(btn), '🔴 点击区 96rpx（= 头像尺寸）');
    add(/background:\s*transparent/.test(btn), '按钮背景透明');
    add(/border:\s*none/.test(btn), '去掉 button 默认边框');
    add(/padding:\s*0/.test(btn), '🔴 padding 归零（默认 14px 横向 padding 是空框变宽的直接来源）');
  }
  add(/\.avatar-btn::after\s*\{[^}]*border:\s*none/.test(vX), '⚠️ 去掉 button::after 默认描边');
  add(!/\.avatar-btn\s*\.avatar-(img|fallback)/.test(vX),
    '⚠️ 头像图/回落块已移出 button，不要再写后代选择器（那是旧结构的残留）');
  add(/\.avatar-slot\s+\.avatar-img\s*\{[^}]*width:\s*96rpx[\s\S]*?height:\s*96rpx/.test(vX),
    '头像图 96rpx 圆形（scoped 在 .avatar-slot 下，避免泄漏进组件）');

  /* ③ 链路 ---------------------------------------------------------- */
  const h = /onChooseAvatar\(e\)\s*\{([\s\S]*?)\n {2}\},/.exec(js);
  const body = h ? h[1] : '';
  add(/onChooseAvatar\(e\)\s*\{/.test(js), 'js 有 onChooseAvatar');
  add(/e\.detail\.avatarUrl/.test(body), '从 e.detail.avatarUrl 取临时路径');
  add(/wx\.cloud\.uploadFile/.test(body), '上传到云存储（image 组件直接支持 cloud:// 显示）');
  add(/api\.updateAvatar\(\{ avatarUrl: fileID \}/.test(body),
    '🔴 调 api.updateAvatar 存库（字段名 avatarUrl，与后端 auth.updateAvatar 对齐）');
  add(/app\.refreshAuth\(\)/.test(body), '⚠️ 保存后 refreshAuth()（否则 profile 还是旧头像）');
  add(/this\.setData\(\{ profile: app\.globalData\.profile[,}]/.test(body),
    '⚠️ 用 globalData.profile 刷新页面 profile（不刷则 UI 停在旧头像）');
  add(/onAvatarImgError\s*\(/.test(js) && /onAvatarError\s*\(/.test(js),
    '图片加载失败 / 按钮级错误都有兜底处理');
  add(/avatarChar/.test(js), '回落字符 avatarChar 由 JS 预计算（WXML 不支持方法调用）');

  /* ④ 后端 ---------------------------------------------------------- */
  let auth = '';
  try { auth = read('cloudfunctions/auth/index.js'); } catch (e) { auth = ''; }
  add(/updateAvatar:\s*\{/.test(auth), '🔴 后端 auth.updateAvatar action 存在（api 打到 auth 函数）');
  add(/UPDATE member SET avatar_url = \? WHERE id = \?/.test(auth), '后端真的写库');
  add(/avatarUrl: m\.avatar_url \|\| ''/.test(auth), '⚠️ auth.login 回 avatarUrl（refreshAuth 后能拿到新头像）');

  return out;
}

/* ------------------------------------------------------------------ */
console.log('── ① 结构 / ② 样式 / ③ 链路 / ④ 后端');
const live = checks(wxss, wxml);
live.forEach((c) => console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.msg));
let bad = live.filter((c) => !c.ok).length;

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ⑤ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

const MUT = [
  {
    name: 'M1 去掉 open-type="chooseAvatar"（面板压根不会弹）',
    apply: () => ({ wxml: wxml.replace('<button class="avatar-btn" open-type="chooseAvatar"', '<button class="avatar-btn"') })
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
    name: 'M4 .avatar-btn 去掉 position:absolute（回文档流 ⇒ 121rpx 空框复现）',
    apply: () => ({
      wxss: wxss.replace('  position: absolute;\n  left: 0;\n  top: 0;\n  z-index: 2;\n',
        '  left: 0;\n  top: 0;\n  z-index: 2;\n')
    })
  },
  {
    name: 'M5 往空 button 里塞 <image>（内容撑大按钮的空框复现）',
    apply: () => ({
      wxml: wxml.replace('binderror="onAvatarError"></button>',
        'binderror="onAvatarError"><image class="avatar-img" src="{{profile.avatarUrl}}" /></button>')
    })
  },
  {
    name: 'M6 .avatar-slot 去掉 position:relative（绝对按钮失去定位上下文，乱飘压住别处）',
    apply: () => ({
      wxss: wxss.replace('.avatar-slot {\n  position: relative;\n', '.avatar-slot {\n')
    })
  }
];

let caught = 0;
MUT.forEach((c) => {
  const before = checks(wxss, wxml).filter((x) => !x.ok).length;
  if (before !== 0) {
    bad += 1;
    console.log('FAIL  变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移');
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    bad += 1;
    console.log('FAIL  变异「' + c.name + '」构造失败：' + e.message);
    return;
  }
  const touched = (over.wxss && over.wxss !== wxss) || (over.wxml && over.wxml !== wxml);
  if (!touched) {
    bad += 1;
    console.log('FAIL  变异「' + c.name + '」**没有真的改到源码**（锚点失效）⇒ 门禁测的是原文件，先修锚点');
    return;
  }
  const n = checks(over.wxss || wxss, over.wxml || wxml).filter((x) => !x.ok).length;
  if (n > 0) { caught += 1; console.log('PASS  变异「' + c.name + '」被抓到（' + n + ' 条判据翻红）'); }
  else { bad += 1; console.log('FAIL  变异「' + c.name + '」**没被抓到** —— 判据失效'); }
});
if (caught === MUT.length) console.log('PASS  ' + MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) {
  console.log('[FAIL] ' + bad + ' 项未通过');
  process.exit(1);
}
console.log('[PASS] 头像点击层体检通过');
