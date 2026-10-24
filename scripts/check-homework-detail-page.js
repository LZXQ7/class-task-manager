#!/usr/bin/env node
/**
 * 作业详情页（detail.js + detail.wxml/wxss）门禁（2026-10-24 晚，两起用户实测反馈）
 * ============================================================
 *  反馈①「要求上传图片为什么还有添加文件的按钮」：
 *    提交弹层无条件渲染「+ 图片」「+ 文件」两个按钮 —— 发布时 requireType=IMAGE
 *    （只需图片）的作业，学生照样能选文件，与「本作业要求上传：图片」提示自相矛盾。
 *    正解：IMAGE → 只给图片按钮；FILE → 只给文件按钮；EITHER/NONE → 两个都给。
 *
 *  反馈②「说了很多遍了，文字/按钮等要和手机边缘有距离，不要贴边」：
 *    提交弹层内容容器 .rv-wrap 只有 `padding: 8rpx 8rpx 0` —— 要求提示文字与
 *    两个选择按钮几乎贴着屏幕边缘（全站铁律：按钮/文字距屏幕边缘 ≥24rpx，
 *    参照 .f-actions 的 24rpx 与 sheet-footer 的 32rpx）。
 *
 *  本门禁加载 detail.js **生产源码**（Module._load 钩子桩掉 5 个依赖 + wx 全局），
 *  在 seam 处断言；wxml/wxss 做静态结构断言。防同类复发。
 *
 * 覆盖：
 *   D1 _load 按 requireType 计算 canPickImage/canPickFile（四态逐一验证）  ← 反馈①回归判据
 *   D2 detail.wxml 两个 fm-act 按钮都被 wx:if 门控（引用上述两个 flag）     ← 反馈①回归判据
 *   D3 detail.wxss .rv-wrap 左右内边距 ≥24rpx（弹层内容不贴边）            ← 反馈②回归判据
 *   D4 onSubmit 前端校验不丢：IMAGE 要求下只选文件 → toast 且不调提交 API
 *
 * 退出码：全过 0；任一不过 1（由 scripts/run_all_gates.sh 的 glob 自动纳入）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const DET_PATH = path.join(ROOT, 'miniprogram', 'pages', 'homework', 'detail.js');
const WXML_PATH = path.join(ROOT, 'miniprogram', 'pages', 'homework', 'detail.wxml');
const WXSS_PATH = path.join(ROOT, 'miniprogram', 'pages', 'homework', 'detail.wxss');

/* ---------- 依赖桩 ---------- */
const calls = { detail: [], submit: [], toast: [] };
// 每轮 _load 换一个 requireType 的假响应（D1 四态轮换）
let fakeRes = null;
const apiStub = {
  homeworkDetail: async (p) => { calls.detail.push(p); return fakeRes; },
  homeworkSubmit: async (p) => { calls.submit.push(p); return { ok: true }; },
  homeworkReview: async () => ({ ok: true })
};
const utilStub = { toast: (m) => calls.toast.push(m) };
const requestStub = { uploadFile: async (p) => 'cloud://test-env/' + p, getTempFileURL: async () => ({}) };
const themeStub = { mount() {}, unmount() {} };

global.wx = {
  showToast: (o) => calls.toast.push(o && o.title),
  chooseMedia: () => {},
  chooseMessageFile: () => {},
  previewImage: () => {},
  navigateBack: () => {},
  switchTab: () => {},
  downloadFile: async () => ({ statusCode: 200 }),
  saveImageToPhotosAlbum: async () => {},
  openDocument: () => {},
  env: { USER_DATA_PATH: 'wxfile://usr' }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (e) { /* noop */ }
  if (/utils[/\\]api(\.js)?$/.test(resolved || '')) return apiStub;
  if (/utils[/\\]util(\.js)?$/.test(resolved || '')) return utilStub;
  if (/utils[/\\]request(\.js)?$/.test(resolved || '')) return requestStub;
  if (/utils[/\\]theme(\.js)?$/.test(resolved || '')) return themeStub;
  return origLoad.apply(this, arguments);
};

let cfg = null;
global.Page = (c) => { cfg = c; };
require(DET_PATH);
Module._load = origLoad;

/* ---------- 断言框架 ---------- */
let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [OK] ' + name); }
  else { fail += 1; failed.push(name); console.log('  [NG] ' + name + (extra === undefined ? '' : '  => ' + extra)); }
}

function freshPage(overrides) {
  const p = Object.assign({}, cfg, { data: JSON.parse(JSON.stringify(cfg.data)) });
  p.setData = function (patch) { Object.assign(this.data, patch); };
  Object.assign(p.data, overrides || {});
  return p;
}

function fakeDetail(requireType) {
  return {
    homework: {
      id: 1, title: '自测作业', brief: '', dueDate: '2030-10-25 12:00',
      groups: ['A'], maxImages: 9, maxFiles: 3,
      requireType: requireType, publisherId: 1
    },
    attaches: [], stats: { total: 1, submitted: 0, pending: 1, done: 0, reject: 0 },
    list: [], canReview: false, iAmSubmitter: true
  };
}

/** 等 _load 的 Promise 链落地（stub 是 async，.then 在微任务里跑） */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 解析 wxss 里 .rv-wrap 的 padding 四向值（rpx）；找不到返回 null */
function rvWrapPad(wxss) {
  const m = wxss.match(/\.rv-wrap\s*\{([^}]*)\}/);
  if (!m) return null;
  const pm = m[1].match(/padding\s*:\s*([^;]+)/);
  if (!pm) return null;
  const v = pm[1].trim().split(/\s+/).map((s) => parseFloat(s));
  if (v.some((n) => isNaN(n))) return null;
  if (v.length === 1) return { top: v[0], right: v[0], bottom: v[0], left: v[0] };
  if (v.length === 2) return { top: v[0], right: v[1], bottom: v[0], left: v[1] };
  if (v.length === 3) return { top: v[0], right: v[1], bottom: v[2], left: v[1] };
  return { top: v[0], right: v[1], bottom: v[2], left: v[3] };
}

(async () => {
  try {
    if (!cfg) { console.error('FAIL: detail.js 未注册 Page'); process.exit(1); }
    console.log('== 作业详情页门禁（detail.js 生产源码 + wxml/wxss 静态结构） ==');

    /* ---------- D1 requireType → 按钮可见性 flag（反馈①回归判据） ---------- */
    const expect = {
      NONE: { img: true, file: true },
      IMAGE: { img: true, file: false },
      FILE: { img: false, file: true },
      EITHER: { img: true, file: true }
    };
    for (const rt of Object.keys(expect)) {
      fakeRes = fakeDetail(rt);
      const p = freshPage({ id: 1, classId: 1 });
      p._load();
      await flush();
      const h = p.data.homework || {};
      check('D1.' + rt + ' canPickImage=' + expect[rt].img + ' / canPickFile=' + expect[rt].file,
        h.canPickImage === expect[rt].img && h.canPickFile === expect[rt].file,
        JSON.stringify({ rt: h.requireType, img: h.canPickImage, file: h.canPickFile }));
    }

    /* ---------- D2 wxml：两个 fm-act 按钮都被 wx:if 门控 ---------- */
    const wxml = fs.readFileSync(WXML_PATH, 'utf8');
    // 属性顺序不固定（wx:if 可能在 class 前），按「含 class="fm-act" 的 view 开标签」匹配
    const actTags = wxml.match(/<view[^>]*class="fm-act"[^>]*>/g) || [];
    check('D2.1 提交弹层存在两个 fm-act 按钮', actTags.length === 2, '实际 ' + actTags.length + ' 个');
    const imgTag = actTags.find((t) => /onChooseFile/.test(t)) || '';
    const fileTag = actTags.find((t) => /onChooseDoc/.test(t)) || '';
    check('D2.2 「+ 图片」按钮带 wx:if="{{homework.canPickImage}}"（IMAGE 要求时不出现文件按钮的先决条件）',
      /wx:if="\{\{homework\.canPickImage\}\}"/.test(imgTag), imgTag);
    check('D2.3 「+ 文件」按钮带 wx:if="{{homework.canPickFile}}"',
      /wx:if="\{\{homework\.canPickFile\}\}"/.test(fileTag), fileTag);

    /* ---------- D3 wxss：.rv-wrap 左右内边距 ≥24rpx（反馈②回归判据） ---------- */
    const pad = rvWrapPad(fs.readFileSync(WXSS_PATH, 'utf8'));
    check('D3.1 .rv-wrap 有 padding 声明且可解析', !!pad, JSON.stringify(pad));
    check('D3.2 .rv-wrap 左/右内边距 ≥24rpx（弹层内文字与按钮不贴屏幕边缘）',
      !!pad && pad.left >= 24 && pad.right >= 24,
      'left=' + (pad && pad.left) + ' right=' + (pad && pad.right));

    /* ---------- D4 onSubmit 前端校验不丢（既有行为，防修复踩坏） ---------- */
    fakeRes = fakeDetail('IMAGE');
    const p4 = freshPage({ id: 1, classId: 1 });
    p4._load();
    await flush();
    calls.submit.length = 0; calls.toast.length = 0;
    p4.setData({ files: [{ path: 'wxfile://x', kind: 'FILE', name: '实验报告.pdf', size: 1024, sizeText: '1KB' }] });
    await p4.onSubmit();
    check('D4.1 IMAGE 要求下只选文件 → toast「本作业要求至少上传 1 张图片」且不调提交 API',
      calls.toast.indexOf('本作业要求至少上传 1 张图片') >= 0 && calls.submit.length === 0,
      JSON.stringify(calls.toast));

    calls.toast.length = 0;
    p4.setData({ files: [{ path: 'wxfile://y', kind: 'IMAGE', name: '图片1.jpg', size: 2048, sizeText: '2KB' }] });
    p4.onSubmit();
    await flush();   // onSubmit 内部是 Promise.all(upload).then 链，等它落地
    check('D4.2 IMAGE 要求下选了图片 → 正常走到 api.homeworkSubmit（不误拦）',
      calls.submit.length === 1 && calls.toast.indexOf('提交成功') >= 0,
      'submit=' + calls.submit.length + ' toast=' + JSON.stringify(calls.toast));

    /* ---------- 汇总 ---------- */
    console.log('\n==============================');
    console.log('作业详情页门禁 通过=' + pass + ' 失败=' + fail);
    if (fail > 0) { console.log('失败项: ' + failed.join(' / ')); process.exit(1); }
    console.log('全绿');
    process.exit(0);
  } catch (e) {
    console.error('[check-homework-detail-page] 运行异常:', e);
    process.exit(1);
  }
})();
