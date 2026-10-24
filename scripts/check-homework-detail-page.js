#!/usr/bin/env node
/**
 * 作业详情页（detail.js + detail.wxml/wxss）门禁（2026-10-24，四起用户实测反馈）
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
 *  反馈③「作业附件若为图片则可点击预览」：
 *    作业附件区（attaches）此前没有任何 bindtap —— 图片附件看得见点不着。
 *    正解：图片行 bindtap onPreviewAttach → getTempFileURL 换临时链接 →
 *    wx.previewImage 相册预览（cloud:// 云文件 ID 不能直接喂 previewImage）。
 *
 *  反馈④「下方筛选没有用」：
 *    onFilter 改了 this.data.filter 后调 _load，但 _load 的 payload 从来没带
 *    filter —— 后端永远按默认 all 返回，切「已交」名单纹丝不动。
 *
 *  反馈⑤「提交作业后按钮还亮着」：
 *    提交后（待批阅/已完成）底部「提交作业」仍是可点渐变按钮。
 *    产品口径：只有未提交或被打回（REJECT）才可提交；其余置灰禁用
 *    （复用全局 .btn.disabled = --brand-disable），文案随状态变化。
 *
 *  反馈⑥「发布人员无法查看/批量下载提交的作业」：
 *    成员行 bindtap 全部绑在多选上，点行=选人，没有「看这个人交了什么」的入口；
 *    批量下载方法 onBatchDownload 存在但 wxml 里没有任何按钮调用它。
 *    正解：行点击=查看该成员提交（弹层），行尾勾选框=catchtap 多选；
 *    名单上方批量操作条（已选 N 人 → 批量下载/命名切换/取消）。
 *
 * 本门禁加载 detail.js **生产源码**（Module._load 钩子桩掉 5 个依赖 + wx 全局），
 *  在 seam 处断言；wxml/wxss 做静态结构断言。防同类复发。
 *
 * 覆盖：
 *   D1 _load 按 requireType 计算 canPickImage/canPickFile（四态逐一验证）  ← 反馈①回归判据
 *   D2 detail.wxml 两个 fm-act 按钮都被 wx:if 门控（引用上述两个 flag）     ← 反馈①回归判据
 *   D3 detail.wxss .rv-wrap 左右内边距 ≥24rpx（弹层内容不贴边）            ← 反馈②回归判据
 *   D4 onSubmit 前端校验不丢：IMAGE 要求下只选文件 → toast 且不调提交 API
 *   D5 onFilter 后 detail 请求带上 filter（后端才按状态过滤）              ← 反馈④回归判据
 *   D6 图片附件可点击预览（getTempFileURL + previewImage；文件不弹相册）   ← 反馈③回归判据
 *   D7 提交按钮可见性四态（未交/打回=可交；待批阅/已完成=禁交；截止置灰）   ← 反馈⑤回归判据
 *   D8 行点击查看提交 / 勾选框 catchtap 不冒泡 / 批量操作条静态结构         ← 反馈⑥回归判据
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
const calls = { detail: [], submit: [], toast: [], preview: [], openDoc: [], tempUrl: [] };
// 每轮 _load 换一个假响应（D1 四态 / D7 myStatus 五态轮换）
let fakeRes = null;
const apiStub = {
  homeworkDetail: async (p) => { calls.detail.push(p); return fakeRes; },
  homeworkSubmit: async (p) => { calls.submit.push(p); return { ok: true }; },
  homeworkReview: async () => ({ ok: true })
};
const utilStub = { toast: (m) => calls.toast.push(m) };
const requestStub = {
  uploadFile: async (p) => 'cloud://test-env/' + p,
  // 云文件 ID → 临时 http 链接（预览/下载都走这里；cloud:// 不能直接喂 previewImage）
  getTempFileURL: async (list) => {
    const arr = Array.isArray(list) ? list : [list];
    calls.tempUrl.push(arr);
    const map = {};
    arr.forEach((id) => { map[id] = 'https://tmp.example/' + String(id).split('/').pop(); });
    return map;
  }
};
const themeStub = { mount() {}, unmount() {} };

global.wx = {
  showToast: (o) => calls.toast.push(o && o.title),
  chooseMedia: () => {},
  chooseMessageFile: () => {},
  previewImage: (o) => calls.preview.push(o),
  openDocument: (o) => calls.openDoc.push(o),
  navigateBack: () => {},
  switchTab: () => {},
  downloadFile: async () => ({ statusCode: 200 }),
  saveImageToPhotosAlbum: async () => {},
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
  // ⚠️ setData 必须支持回调（onFilter 用第二个参数触发 _load，早年 harness 吞回调）
  p.setData = function (patch, cb) { Object.assign(this.data, patch); if (typeof cb === 'function') cb(); };
  Object.assign(p.data, overrides || {});
  return p;
}

/**
 * detail 假响应。opts.myStatus = 查看者自己的提交状态（null=未交）；
 * opts.closed = 是否已截止；opts.list / opts.attaches 可按场景覆写。
 */
function fakeDetail(requireType, opts) {
  const o = opts || {};
  return {
    homework: {
      id: 1, title: '自测作业', brief: '', dueDate: o.closed ? '2020-10-25 12:00' : '2030-10-25 12:00',
      groups: ['A'], maxImages: 9, maxFiles: 3,
      requireType: requireType, publisherId: 1,
      myStatus: o.myStatus === undefined ? null : o.myStatus,
      closed: !!o.closed
    },
    attaches: o.attaches || [],
    stats: { total: 1, submitted: 0, pending: 1, done: 0, reject: 0 },
    list: o.list || [],
    canReview: o.canReview === undefined ? false : o.canReview,
    iAmSubmitter: o.iAmSubmitter === undefined ? true : o.iAmSubmitter
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

    /* ---------- D5 筛选必须带到请求里（反馈④回归判据） ---------- */
    fakeRes = fakeDetail('NONE');
    const p5 = freshPage({ id: 1, classId: 1 });
    p5._load();
    await flush();
    calls.detail.length = 0;
    // ⚠️ 别预先 setData filter：onFilter 开头有「同 key 早退」，预置就等于测不到 _load
    p5.onFilter({ currentTarget: { dataset: { key: 'submitted' } } });
    await flush();
    const lastReq = calls.detail[calls.detail.length - 1] || {};
    check('D5.1 切换筛选「已交」后 detail 请求带 filter=submitted（后端才按状态过滤）',
      lastReq.filter === 'submitted', JSON.stringify(lastReq));
    p5.onFilter({ currentTarget: { dataset: { key: 'all' } } });
    await flush();
    const allReq = calls.detail[calls.detail.length - 1] || {};
    check('D5.2 切回「全部」请求带 filter=all',
      allReq.filter === 'all', JSON.stringify(allReq));

    /* ---------- D6 图片附件可点击预览（反馈③回归判据） ---------- */
    fakeRes = fakeDetail('NONE', {
      attaches: [
        { id: 1, name: '图片1.jpg', size: 6 * 1024 * 1024, fileId: 'cloud://env/hw/1.jpg' },
        { id: 2, name: '作业说明.pdf', size: 1024, fileId: 'cloud://env/hw/2.pdf' }
      ]
    });
    const p6 = freshPage({ id: 1, classId: 1 });
    p6._load();
    await flush();
    check('D6.1 作业附件 _load 时标 isImage（图片行才绑预览）',
      p6.data.attaches.length === 2 && p6.data.attaches[0].isImage === true && p6.data.attaches[1].isImage === false,
      JSON.stringify(p6.data.attaches.map((a) => [a.name, a.isImage])));
    calls.preview.length = 0; calls.tempUrl.length = 0;
    if (typeof p6.onPreviewAttach !== 'function') {
      check('D6.2 点图片附件 → getTempFileURL 换链接 + previewImage 弹出相册', false, '(detail.js 没有 onPreviewAttach 方法)');
    } else {
      await p6.onPreviewAttach({ currentTarget: { dataset: { idx: 0 } } });
      check('D6.2 点图片附件 → getTempFileURL 换链接 + previewImage 弹出相册',
        calls.tempUrl.length >= 1 && calls.preview.length === 1,
        'tempUrl=' + calls.tempUrl.length + ' preview=' + calls.preview.length);
      check('D6.3 previewImage 的 current/urls 用临时 http 链接（cloud:// 直接喂会白屏）',
        calls.preview.length === 1 && /^https?:\/\//.test(String(calls.preview[0].current || ''))
        && (calls.preview[0].urls || []).every((u) => /^https?:\/\//.test(u)),
        JSON.stringify(calls.preview[0] || null));
    }
    calls.preview.length = 0; calls.tempUrl.length = 0;
    if (typeof p6.onPreviewAttach === 'function') {
      await p6.onPreviewAttach({ currentTarget: { dataset: { idx: 1 } } });
    }
    check('D6.4 点文件附件（pdf）不弹图片相册（文件走打开文档，不按图片预览）',
      calls.preview.length === 0, 'preview=' + calls.preview.length);

    /* ---------- D7 提交按钮可见性（反馈⑤回归判据） ---------- */
    const submitCases = [
      { myStatus: null, closed: false, can: true, text: '提交作业' },
      { myStatus: 'REJECT', closed: false, can: true, text: '重新提交' },
      { myStatus: 'PENDING', closed: false, can: false, text: '已提交' },
      { myStatus: 'DONE', closed: false, can: false, text: '已完成' },
      { myStatus: 'PENDING', closed: true, can: false, text: '已截止' },
      { myStatus: 'REJECT', closed: true, can: true, text: '重新提交' }
    ];
    for (const c of submitCases) {
      fakeRes = fakeDetail('NONE', { myStatus: c.myStatus, closed: c.closed });
      const p7 = freshPage({ id: 1, classId: 1 });
      p7._load();
      await flush();
      check('D7 myStatus=' + c.myStatus + (c.closed ? ' 已截止' : '') + ' → canSubmit=' + c.can + ' 文案含「' + c.text + '」',
        p7.data.canSubmit === c.can && String(p7.data.submitBtnText || '').indexOf(c.text) >= 0,
        'canSubmit=' + p7.data.canSubmit + ' text=' + p7.data.submitBtnText);
    }
    // 禁用态双保险：onOpenSubmit 直接拦（防有人去掉 wxml 的 disabled 类）
    fakeRes = fakeDetail('NONE', { myStatus: 'PENDING' });
    const p7b = freshPage({ id: 1, classId: 1 });
    p7b._load();
    await flush();
    p7b.onOpenSubmit();
    check('D7.7 已提交（待批阅）时 onOpenSubmit 不打开提交弹层（禁用态双保险）',
      p7b.data.submitShow === false);

    /* ---------- D8 行点击查看提交 + 勾选框不冒泡 + 批量条（反馈⑥回归判据） ---------- */
    const members = [
      { id: 11, name: '李同学', studentNo: '2608010011', status: 'PENDING',
        files: [{ id: 1, name: '图片1.jpg', size: 2048, fileId: 'cloud://env/hw/s1.jpg', kind: 'IMAGE' },
          { id: 2, name: '实验报告.pdf', size: 4096, fileId: 'cloud://env/hw/s2.pdf', kind: 'FILE' }] },
      { id: 12, name: '王同学', studentNo: '2608010012', status: null, files: [] }
    ];
    fakeRes = fakeDetail('NONE', { canReview: true, list: members });
    const p8 = freshPage({ id: 1, classId: 1 });
    p8._load();
    await flush();
    if (typeof p8.onRowTap !== 'function') {
      check('D8.1 点有提交的成员行 → 打开查看弹层并带上该成员与其文件', false, '(detail.js 没有 onRowTap 方法)');
      check('D8.2 查看弹层文件带 isImage/sizeText（缩略图与可读大小直接可用）', false, '(同上)');
    } else {
      p8.onRowTap({ currentTarget: { dataset: { id: 11 } } });
      check('D8.1 点有提交的成员行 → 打开查看弹层并带上该成员与其文件',
        p8.data.viewShow === true && p8.data.viewMember && p8.data.viewMember.id === 11
        && (p8.data.viewFiles || []).length === 2,
        'viewShow=' + p8.data.viewShow + ' files=' + (p8.data.viewFiles || []).length);
      check('D8.2 查看弹层文件带 isImage/sizeText（缩略图与可读大小直接可用）',
        p8.data.viewFiles[0].isImage === true && p8.data.viewFiles[1].isImage === false
        && !!p8.data.viewFiles[0].sizeText,
        JSON.stringify(p8.data.viewFiles.map((f) => [f.name, f.isImage, f.sizeText])));
    }
    calls.toast.length = 0;
    if (typeof p8.onRowTap === 'function') {
      p8.onRowTap({ currentTarget: { dataset: { id: 12 } } });
    }
    check('D8.3 点未提交成员行 → toast 提示且不打开弹层',
      calls.toast.join('|').indexOf('还没有提交') >= 0 && p8.data.viewShow === true,
      JSON.stringify(calls.toast));
    // 勾选框多选不冒泡到行（否则点勾选=看提交，没法安心选人）
    const pkTags = wxml.match(/<view[^>]*class="pk-box[^"]*"[^>]*>/g) || [];
    check('D8.4 行尾勾选框 pk-box 用 catchtap="onTogglePick"（不冒泡触发行点击）',
      pkTags.length === 1 && /catchtap="onTogglePick"/.test(pkTags[0]), pkTags[0] || '(未找到)');
    // 行点击必须是 onRowTap（查看提交），不能退回 onTogglePick（选人）——
    // 两种语义共用一行时「查看提交」永远摸不到
    const rowTags = wxml.match(/<view[^>]*class="mb-row"[^>]*>/g) || [];
    check('D8.8 名单行 bindtap="onRowTap"（行=查看提交；选人只走行尾勾选框）',
      rowTags.length === 1 && /bindtap="onRowTap"/.test(rowTags[0]) && !/bindtap="onTogglePick"/.test(rowTags[0]),
      rowTags[0] || '(未找到)');
    // 批量操作条静态结构
    check('D8.5 名单上方有批量操作条（canReview && pickedCount 时才显示）',
      /wx:if="\{\{canReview && pickedCount\}\}"/.test(wxml), '(未找到 batch-bar)');
    check('D8.6 批量操作条含「批量下载」入口（onBatchDownload 从此可触达）',
      /bindtap="onBatchDownload"/.test(wxml), '(未找到 onBatchDownload 绑定)');
    // 查看弹层 + 滚动锁
    check('D8.7 新增查看弹层 viewShow 已进 page-meta 滚动锁表达式',
      /page-style="\{\{\(reviewShow \|\| submitShow \|\| viewShow\)/.test(wxml), '(page-meta 未含 viewShow)');

    /* ---------- D9 提交按钮禁用态静态绑定（反馈⑤ wxml 侧判据） ---------- */
    const btnTags = wxml.match(/<view[^>]*class="btn[^"]*"[^>]*>/g) || [];
    const submitBtns = btnTags.filter((t) => /onOpenSubmit/.test(t));
    check('D9.1 提交作业按钮 class 含 {{canSubmit ? \'\' : \'disabled\'}}（复用全局 .btn.disabled 灰态）',
      submitBtns.length >= 1 && submitBtns.every((t) => /canSubmit \? '' : 'disabled'/.test(t)),
      JSON.stringify(submitBtns));
    // ⚠️ 文案在开标签的 > 之后，标签正则匹配不到 —— 必须按「bindtap + 文案」整体查；
    // 且两处提交按钮（iAmSubmitter 独立行 / 成员 else 分支）都要用 submitBtnText
    const textHits = wxml.match(/bindtap="onOpenSubmit">\{\{submitBtnText\}\}/g) || [];
    check('D9.2 提交作业按钮文案用 submitBtnText（未交=提交作业 / 打回=重新提交 / 已交=置灰提示）',
      textHits.length === 2, '命中 ' + textHits.length + ' 处');
    // 附件预览绑定
    check('D9.3 图片附件行绑 onPreviewAttach（data-idx 定位被点附件）',
      /bindtap="onPreviewAttach"/.test(wxml) && /data-idx="\{\{index\}\}"/.test(wxml), '(未找到 onPreviewAttach 绑定)');

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
