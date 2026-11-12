#!/usr/bin/env node
/**
 * 门禁：请假申请表单「假条」字段
 * =============================================================
 * 2026-11-12 用户反馈：体验版请假页，已选假条的**预览缩略图**是黄色的
 * （实际是黄底假条照片本身的预览），要删掉这张预览图、只保留「上传假条照片」按钮。
 *
 * ✅ 本门禁钉的不变式：
 *   1. 表单 WXML **不再**渲染假条缩略图（lv-img-row / lv-img / lv-img-del / onRemoveImage 全部消失）；
 *   2. 表单 WXML **仍保留**上传按钮 lv-upload，且文案含「上传假条照片」「重新上传假条照片」；
 *   3. 对应 JS 不再有 onRemoveImage（删除链接已随缩略图一起删）；
 *   4. WXSS 不再有 .lv-img* 死样式。
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; }
};

const WXML = 'miniprogram/pages/leave/index.wxml';
const WXSS = 'miniprogram/pages/leave/index.wxss';
const JS = 'miniprogram/pages/leave/index.js';

/** 判据函数：传入三个文件内容（字符串），返回未通过条数 */
function judge(wxml, wxss, js) {
  let n = 0;
  const push = (c, m) => { if (!c) { n += 1; console.log('FAIL  ' + m); } else { console.log('PASS  ' + m); } };

  // ① 缩略图相关节点/事件全部消失
  push(!/class="lv-img-row"/.test(wxml), 'WXML 不得再有 lv-img-row（假条缩略图整行）');
  push(!/class="lv-img"/.test(wxml), 'WXML 不得再有 lv-img（假条缩略图）');
  push(!/class="lv-img-del"/.test(wxml), 'WXML 不得再有 lv-img-del（删除链接）');
  push(!/onRemoveImage/.test(wxml), 'WXML 不得再绑定 onRemoveImage');
  push(!/onRemoveImage/.test(js), 'JS 不得再有 onRemoveImage 处理函数');

  // ② 上传按钮保留
  push(/class="lv-upload"/.test(wxml), 'WXML 必须保留 lv-upload 上传按钮容器');
  push(/上传假条照片/.test(wxml), 'WXML 上传按钮文案含「上传假条照片」');
  push(/重新上传假条照片/.test(wxml), 'WXML 已选图后按钮应显示「重新上传假条照片」');

  // ③ WXSS 死样式清除
  push(!/\.lv-img-row/.test(wxss), 'WXSS 不得再有 .lv-img-row');
  push(!/\.lv-img\b/.test(wxss), 'WXSS 不得再有 .lv-img');
  push(!/\.lv-img-del/.test(wxss), 'WXSS 不得再有 .lv-img-del');

  return n;
}

if (require.main === module) {
  const wxml = read(WXML);
  const wxss = read(WXSS);
  const js = read(JS);

  console.log('── 请假表单「假条」预览图移除、上传按钮保留');
  const bad = judge(wxml, wxss, js);
  console.log('');
  if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
  console.log('[PASS] 请假表单假条预览已移除，上传按钮保留');
}

module.exports = { judge };
