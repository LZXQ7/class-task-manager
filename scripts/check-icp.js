#!/usr/bin/env node
/**
 * 合规门禁：ICP 备案号必须在「我的 → 关于」真实展示。
 * =================================================================
 * 2026-10-12 小程序备案通过（<ICP_NO>）。工信部/微信对「已完成备案的
 * 小程序」要求在显著位置**真实展示备案号**；而本项目 2026-09-24 曾因是**假占位号**
 * （`苏ICP备00000000号-1`）把整块删掉——所以这里必须换成真号重新挂上，且**不能再被
 * 静默删掉**（删掉 = 下次审核/合规检查直接踩雷，且本地毫无提示）。
 *
 * 本门禁钉死的性质（每条都对应一个真实事故方向）：
 *   ① 备案号**只有一个真源**（`utils/config.js` 的 `ICP_NO`），页面只引用不硬编码
 *      —— 硬编码在 wxml 里，改号时必漏一处。
 *   ② **必须是真号**：不得含 `00000000` 占位、必须匹配「省级简称 + ICP备 + 数字 + 号」。
 *   ③ 关于页**确实渲染** `{{icpNo}}` 且**可点击**（合规要求「可点击」）。
 *   ④ 点击行为 = 复制工信部地址（小程序无法 web-view 打开工信部域名）。
 *   ⑤ 值样式为**主色 + 下划线**（合规要求的「可点击」视觉暗示，别被改成灰字）。
 *
 * 变异自证（3 组，每组都必须被抓）：M1 换回占位号 / M2 关于页去掉备案号 / M3 改错工信部地址。
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const CONFIG_JS = 'miniprogram/utils/config.js';
const MINE_JS = 'miniprogram/pages/mine/index.js';
const MINE_WXML = 'miniprogram/pages/mine/index.wxml';
const MINE_WXSS = 'miniprogram/pages/mine/index.wxss';

const src = {
  config: read(CONFIG_JS),
  mineJs: read(MINE_JS),
  mineWxml: read(MINE_WXML),
  mineWxss: read(MINE_WXSS)
};

/* 剥注释：只判代码形态，注释里提到不算 */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
const code = {};
Object.keys(src).forEach((k) => { code[k] = strip(src[k]); });

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };

/** 真号形态：省级简称(1~2 汉字) + ICP备 + 至少 6 位数字 + 号（允许 -数字X 服务后缀） */
const REAL_ICP = /^[\u4e00-\u9fa5]{1,2}ICP备\d{6,}号(-[0-9A-Za-z]+)?$/;

function judge(o) {
  o = o || {};
  const c = {};
  Object.keys(src).forEach((k) => { c[k] = strip(o[k] != null ? o[k] : src[k]); });
  let n = 0;
  const push = (x) => { if (!x) n += 1; };

  /* ① 真源在 config（页面只能引用，不得硬编码） */
  const mNo = /ICP_NO\s*=\s*'([^']+)'/.exec(c.config);
  push(!!mNo);
  push(/MIIT_URL\s*=\s*'([^']+)'/.test(c.config));
  push(/module\.exports\s*=\s*\{[\s\S]*\bICP_NO\b/.test(c.config));
  push(/module\.exports\s*=\s*\{[\s\S]*\bMIIT_URL\b/.test(c.config));

  /* ② 必须是真号（非占位）—— 开源模板占位 <ICP_NO> 时跳过真号校验，待使用者填入自己的备案号 */
  const no = mNo ? mNo[1] : '';
  const isPlaceholder = no === '<ICP_NO>';
  push(!no.includes('00000000'));
  if (!isPlaceholder) {
    push(REAL_ICP.test(no));
    push(no.length >= 12);
  }

  /* ③ 关于页确实渲染 + 可点击 */
  push(c.mineWxml.includes('{{icpNo}}'));
  push(/bindtap="onIcp"/.test(c.mineWxml));
  push(/ab-icp/.test(c.mineWxml));

  /* ④ 页面从 config 取号 + 点击=复制工信部地址 */
  push(/icpNo:\s*config\.ICP_NO/.test(c.mineJs));
  push(/onIcp\(\)\s*\{/.test(c.mineJs));
  push(/wx\.setClipboardData\(/.test(c.mineJs));
  push(/config\.MIIT_URL/.test(c.mineJs));
  /* 工信部地址形态：必须落在 beian.miit.gov.cn（写错域名等于给了个假查询入口） */
  const mUrl = /MIIT_URL\s*=\s*'([^']+)'/.exec(c.config);
  push(!!mUrl && /^https:\/\/beian\.miit\.gov\.cn\/?$/.test(mUrl[1]));

  /* ⑤ 值样式 = 主色 + 下划线（合规要求的「可点击」暗示） */
  const vBlock = /\.ab-icp-v\s*\{[^}]*\}/.exec(c.mineWxss);
  push(!!vBlock);
  if (vBlock) {
    push(/#3370FF/.test(vBlock[0]));
    push(/text-decoration:\s*underline/.test(vBlock[0]));
  }
  push(/\.ab-icp\s*\{/.test(c.mineWxss));
  push(/\.ab-icp-l\s*\{/.test(c.mineWxss));

  return n;
}

console.log('── ICP 备案号：静态判据');
const n0 = judge();
console.log(n0 === 0 ? 'PASS  全部判据通过' : 'FAIL  ' + n0 + ' 条判据未通过');
if (n0 !== 0) bad += 1;

console.log('');
console.log('── 变异自证：改坏一处必须被抓到（内存副本，不落盘）');
const MUT = [
  {
    name: 'M1 备案号换回占位（00000000 ⇒ 展示的是假号，合规雷）',
    apply: () => ({ config: src.config.replace(/ICP_NO\s*=\s*'[^']+'/, "ICP_NO = '苏ICP备00000000号-1'") })
  },
  {
    name: 'M2 关于页去掉备案号块（界面不再展示 = 违反备案展示要求）',
    apply: () => ({ mineWxml: src.mineWxml.replace(/\{\{icpNo\}\}/, '') })
  },
  {
    name: 'M3 工信部地址写错（给了个打不开/假的查询入口）',
    apply: () => ({ config: src.config.replace('https://beian.miit.gov.cn', 'https://example.com') })
  },
  {
    name: 'M4 值样式改成灰字 + 去掉下划线（「可点击」暗示消失）',
    apply: () => ({ mineWxss: src.mineWxss.replace(/\.ab-icp-v\s*\{[^}]*\}/, '.ab-icp-v { font-size: 28rpx; color: #86909C; }') })
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
  /* 🔴 变异必须真的改到源码：锚点漂移后 String.replace 找不到会原样返回 ⇒ 测的是原文件 = 假自证 */
  const touched = Object.keys(src).some((k) => over[k] && over[k] !== src[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效：replace 找不到就原样返回）⇒ 门禁测的是原文件。先修锚点。');
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
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] ICP 备案号门禁全部通过');
