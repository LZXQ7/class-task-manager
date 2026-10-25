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
 * 反馈⑦「无法选择成员了 / 提交后按钮没置灰」（2026-10-24 深夜真机截图）：
 *   ⑦-a 勾选框 pk-box 上有 catchtap="onTogglePick"，但 data-id 只写在父行
 *      .mb-row 上 —— catchtap 的 e.currentTarget 是 pk-box **本身**（dataset
 *      不继承父级），onTogglePick 取不到 id ⇒ Number(undefined)=NaN ⇒ 守卫
 *      return，点勾选框毫无反应。静态锁：同一开标签必须同时有 catchtap 与 data-id。
 *   ⑦-b _load 把 homework 对象传给 _submitState，但 myStatus/closed 是 detail
 *      响应的**顶层字段**（与 homework 平级，见后端 index.js 的 return 对象）⇒
 *      六态全废，按钮恒为可点的「提交作业」。**门禁假响应早年把这两个字段放在
 *      homework 对象里，与现实形状不一致 → 测了空枪**（本门禁最大教训：
 *      fake 响应必须逐字段对齐真实后端，flow 门禁验后端形状、本门禁验前端映射）。
 *   ⑦-c 用户要「将已完成的人多选后批量导出」：逐个点勾选框太累，筛选行加
 *      「全选」入口（一次选完当前筛选下所有有提交的成员）。
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
 *   D7 提交按钮可见性六态（假响应用**顶层** myStatus/closed，对齐真实后端）  ← 反馈⑤回归判据
 *   D8 行点击查看提交 / 勾选框 catchtap 不冒泡 / 批量操作条静态结构         ← 反馈⑥回归判据
 *   D9 提交按钮禁用态 + 文案 + 附件预览的 wxml 静态绑定                    ← 反馈⑤回归判据
 *   D10 勾选框 pk-box 同一标签带 data-id（点勾选框真正能选人）             ← 反馈⑦-a 回归判据
 *   D11 「全选」行为：只勾有提交的成员 / 再点全清 / 勾齐置 allPicked        ← 反馈⑦-c 回归判据
 *   D12 批量下载按全量名单取行（勾选后切筛选仍下得到已勾的人）             ← 反馈⑦-c 回归判据
 *   D13 筛选行「全选」入口 wxml 接线（canReview 时才显示）                  ← 反馈⑦-c 回归判据
 *   D14 批量操作条仅「已完成」筛选下展示（非 done 筛选不出现下载入口）      ← 反馈⑧-a 回归判据
 *   D15 _load 把后端顶层 myRemark/myFiles 写入 data（学生看老师批语）       ← 反馈⑧-b 回归判据
 *   D16 学生视角「我的提交」块含「老师批语」并绑定 myRemark                  ← 反馈⑧-b 回归判据
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
const calls = { detail: [], submit: [], review: [], toast: [], preview: [], openDoc: [], tempUrl: [] };
// 每轮 _load 换一个假响应（D1 四态 / D7 myStatus 五态轮换）
let fakeRes = null;
const apiStub = {
  homeworkDetail: async (p) => { calls.detail.push(p); return fakeRes; },
  homeworkSubmit: async (p) => { calls.submit.push(p); return { ok: true }; },
  homeworkReview: async (p) => { calls.review.push(p); return { ok: true }; }
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
 *
 * 🔴 myStatus / closed 是**顶层字段**（与 homework 平级）—— 逐字段对齐
 *    cloudfunctions/homework/index.js detail 的 return 对象。早年门禁把这两个
 *    字段塞进 homework 对象里，与真实形状不一致：_submitState 从 homework 上
 *    取永远取不到，六态全废而门禁全绿（2026-10-24 真机截图复现，反馈⑦-b）。
 *    fake 响应必须与现实同形，否则就是测空枪。
 */
function fakeDetail(requireType, opts) {
  const o = opts || {};
  return {
    homework: {
      id: 1, title: '自测作业', brief: '', dueDate: o.closed ? '2020-10-25 12:00' : '2030-10-25 12:00',
      groups: ['A'], maxImages: 9, maxFiles: 3,
      requireType: requireType, publisherId: 1
    },
    myStatus: o.myStatus === undefined ? null : o.myStatus,
    myRemark: o.myRemark === undefined ? '' : o.myRemark,
    myFiles: o.myFiles === undefined ? [] : o.myFiles,
    closed: !!o.closed,
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
    check('D8.5 名单上方有批量操作条（canReview && pickedCount && filter===\'done\' 时才显示）',
      /wx:if="\{\{canReview && pickedCount && filter === 'done'\}\}"/.test(wxml), '(未找到 batch-bar 或条件未含 filter===\'done\')');
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
    check('D9.2 提交作业按钮文案用 submitBtnText（合并为一处：提交入口只在底部；批阅已移入查看弹层）',
      textHits.length === 1, '命中 ' + textHits.length + ' 处');
    // 附件预览绑定
    check('D9.3 图片附件行绑 onPreviewAttach（data-idx 定位被点附件）',
      /bindtap="onPreviewAttach"/.test(wxml) && /data-idx="\{\{index\}\}"/.test(wxml), '(未找到 onPreviewAttach 绑定)');

    /* ---------- D10 勾选框必须自带 data-id（反馈⑦-a 回归判据） ---------- */
    // 2026-10-24 用户反馈「无法选择成员了」：pk-box 上有 catchtap="onTogglePick"，
    // 但 data-id 只写在父行 .mb-row 上 —— catchtap 的 e.currentTarget 是 pk-box
    // 本身（dataset 不继承父级），onTogglePick 里 Number(undefined)=NaN ⇒ 守卫
    // return，点勾选框毫无反应。行为测试直接调 onTogglePick 并传 dataset 是
    // **测不到这条路径**的（id 是测试塞进去的），必须静态锁同一个开标签上的接线。
    const pkBoxTags = wxml.match(/<view[^>]*class="pk-box[^"]*"[^>]*>/g) || [];
    check('D10.1 勾选框 pk-box 与 catchtap="onTogglePick" 在**同一个标签**上带 data-id="{{item.id}}"',
      pkBoxTags.length === 1
      && /catchtap="onTogglePick"/.test(pkBoxTags[0])
      && /data-id="\{\{item\.id\}\}"/.test(pkBoxTags[0]),
      pkBoxTags[0] || '(未找到 pk-box)');
    // 行为侧锁勾选/取消语义（配合上面的静态接线才是完整闭环）
    fakeRes = fakeDetail('NONE', { canReview: true, list: members });
    const p10 = freshPage({ id: 1, classId: 1 });
    p10._load();
    await flush();
    p10.onTogglePick({ currentTarget: { dataset: { id: 11 } } });
    check('D10.2 点勾选框 → picked[11]=true 且 pickedCount=1（选人真正生效）',
      !!(p10.data.picked && p10.data.picked[11] === true) && p10.data.pickedCount === 1,
      'picked=' + JSON.stringify(p10.data.picked) + ' count=' + p10.data.pickedCount);
    p10.onTogglePick({ currentTarget: { dataset: { id: 11 } } });
    check('D10.3 再点同一个勾选框 → 取消勾选，pickedCount=0',
      !(p10.data.picked && p10.data.picked[11]) && p10.data.pickedCount === 0,
      'picked=' + JSON.stringify(p10.data.picked) + ' count=' + p10.data.pickedCount);
    // 勾选态联动批量操作条：选上才显示（D8.5 已锁静态条件，这里锁行为）
    p10.onTogglePick({ currentTarget: { dataset: { id: 11 } } });
    check('D10.4 onClearPick 清空勾选且 pickedCount 归零（批量条右侧「取消」）',
      (p10.onClearPick(), p10.data.pickedCount === 0 && Object.keys(p10.data.picked || {}).length === 0),
      'count=' + p10.data.pickedCount);

    /* ---------- D11 「全选」：一次选完当前筛选下所有有提交的成员（反馈⑦-c） ---------- */
    const members3 = [
      { id: 11, name: '李同学', studentNo: '2608010011', status: 'PENDING',
        files: [{ id: 1, name: '图片1.jpg', size: 2048, fileId: 'cloud://env/hw/s1.jpg', kind: 'IMAGE' }] },
      { id: 12, name: '王同学', studentNo: '2608010012', status: null, files: [] },
      { id: 13, name: '示例成员65', studentNo: '2608010013', status: 'DONE',
        files: [{ id: 3, name: '报告.pdf', size: 4096, fileId: 'cloud://env/hw/s3.pdf', kind: 'FILE' }] }
    ];
    fakeRes = fakeDetail('NONE', { canReview: true, list: members3 });
    const p11 = freshPage({ id: 1, classId: 1 });
    p11._load();
    await flush();
    if (typeof p11.onTogglePickAll !== 'function') {
      check('D11.0 detail.js 有 onTogglePickAll 方法', false, '(缺少 onTogglePickAll)');
    } else {
      check('D11.0 detail.js 有 onTogglePickAll 方法', true);
      p11.onTogglePickAll();
      check('D11.1 全选 → 只勾「有提交」的成员（未交没有勾选框），pickedCount=2 且 allPicked=true',
        p11.data.pickedCount === 2 && p11.data.allPicked === true
        && !!(p11.data.picked || {})[11] && !!(p11.data.picked || {})[13] && !(p11.data.picked || {})[12],
        'picked=' + JSON.stringify(p11.data.picked) + ' allPicked=' + p11.data.allPicked);
      p11.onTogglePickAll();
      check('D11.2 再点一次（取消全选）→ 全部清空，pickedCount=0 且 allPicked=false',
        p11.data.pickedCount === 0 && p11.data.allPicked === false
        && Object.keys(p11.data.picked || {}).length === 0,
        'picked=' + JSON.stringify(p11.data.picked) + ' allPicked=' + p11.data.allPicked);
      p11.onTogglePick({ currentTarget: { dataset: { id: 11 } } });
      p11.onTogglePick({ currentTarget: { dataset: { id: 13 } } });
      check('D11.3 手动逐个勾齐 → allPicked=true（按钮文案切「取消全选」）',
        p11.data.allPicked === true && p11.data.pickedCount === 2,
        'allPicked=' + p11.data.allPicked);
      p11.onClearPick();
      check('D11.4 取消勾选后 allPicked 回 false',
        p11.data.allPicked === false, 'allPicked=' + p11.data.allPicked);
    }

    /* ---------- D12 批量下载按全量名单取行（勾选后切筛选仍下得到已勾的人） ---------- */
    fakeRes = fakeDetail('NONE', { canReview: true, list: members });
    const p12 = freshPage({ id: 1, classId: 1 });
    p12._load();
    await flush();
    p12.onTogglePick({ currentTarget: { dataset: { id: 11 } } });
    // 模拟切到看不到 11 号的筛选：display list 被过滤空，但勾选还在
    p12.setData({ list: [] });
    calls.toast.length = 0;
    p12.onBatchDownload();
    await flush();   // _downloadRows 内部是 await 链，等它落地
    check('D12 勾选后切换筛选（名单被过滤空）→ 批量下载仍按全量名单找到该成员（不误报「还没有提交」）',
      calls.toast.indexOf('所选成员还没有提交作业') < 0
      && calls.toast.join('|').indexOf('已保存') >= 0,
      JSON.stringify(calls.toast));

    /* ---------- D13 筛选行「全选」入口 wxml 接线（反馈⑦-c） ---------- */
    const flAllTags = wxml.match(/<view[^>]*class="fl-all[^"]*"[^>]*>/g) || [];
    check('D13.1 筛选行有「全选」入口且仅 canReview 显示',
      flAllTags.length === 1 && /wx:if="\{\{canReview\}\}"/.test(flAllTags[0])
      && /bindtap="onTogglePickAll"/.test(flAllTags[0]),
      flAllTags[0] || '(未找到 fl-all)');
    check('D13.2 「全选」文案随 allPicked 切换（全选 / 取消全选）',
      /\{\{allPicked \? '取消全选' : '全选'\}\}/.test(wxml), '(未找到 allPicked 三元文案)');

    /* ---------- D14 批量操作条仅「已完成」筛选下展示（反馈⑧-a） ---------- */
    const batchTags = wxml.match(/<view[^>]*class="batch-bar"[^>]*>/g) || [];
    check('D14.1 批量操作条 wx:if 含 filter === \'done\'（仅在「已完成」筛选下展示下载入口）',
      batchTags.length === 1 && /filter === 'done'/.test(batchTags[0]), batchTags[0] || '(未找到 batch-bar)');

    /* ---------- D15 _load 把后端 myRemark/myFiles 写入 data（反馈⑧-b） ---------- */
    // 学生（!canReview）也能收到自己的提交批语与文件：后端 detail 在**顶层**返回
    // myRemark（老师批语）/ myFiles（本人提交的附件）。fakeDetail 对齐真实形状。
    fakeRes = fakeDetail('NONE', {
      canReview: false,
      myStatus: 'REJECT',
      myRemark: '字迹潦草请重抄一遍',
      myFiles: [
        { id: 9, name: '图片1.jpg', size: 2048, fileId: 'cloud://env/hw/mine.jpg' },
        { id: 10, name: '说明.pdf', size: 4096, fileId: 'cloud://env/hw/mine.pdf' }
      ],
      // 非特权：list 只含本人一行（后端已按 id 过滤）
      list: [{ id: 11, name: '宋同学', studentNo: '000000000301', status: 'REJECT',
        remark: '字迹潦草请重抄一遍', files: [] }]
    });
    const p15 = freshPage({ id: 1, classId: 1 });
    p15._load();
    await flush();
    check('D15.1 学生收到 myRemark 并写入 data（老师批语可见）',
      p15.data.myRemark === '字迹潦草请重抄一遍', 'myRemark=' + p15.data.myRemark);
    check('D15.2 学生收到 myFiles 并标 isImage/sizeText（本人提交可预览）',
      (p15.data.myFiles || []).length === 2
      && p15.data.myFiles[0].isImage === true && p15.data.myFiles[1].isImage === false
      && !!p15.data.myFiles[0].sizeText,
      JSON.stringify((p15.data.myFiles || []).map((f) => [f.name, f.isImage, f.sizeText])));
    check('D15.3 学生提交状态文本/色调按 myStatus 计算（已完成/有问题 显色）',
      p15.data.myStatusText === '有问题' && p15.data.myStatusTone === 'REJECT',
      'text=' + p15.data.myStatusText + ' tone=' + p15.data.myStatusTone);

    /* ---------- D16 学生视角「我的提交」块含「老师批语」（反馈⑧-b wxml 侧） ---------- */
    check('D16.1 学生视角展示「我的提交」块（!canReview && myStatus 时显示）',
      /wx:if="\{\{!canReview && myStatus\}\}"/.test(wxml), '(未找到我的提交块)');
    // ⚠️ 必须锚定「学生块」专属的 my-sub-remark 类：view 弹层(s) 与提交弹层也含
    // 「老师批语」/{{myRemark}}，若只查这两个 token 会误判通过（变异漏检）。
    check('D16.2 「我的提交」块内展示「老师批语」且绑定 myRemark（学生块专属 my-sub-remark）',
      /my-sub-remark-lab">老师批语/.test(wxml) && /\{\{myRemark\}\}/.test(wxml),
      '(未找到 我的提交块 老师批语 绑定)');
    check('D16.3 「我的提交」块文件行 bindtap="onViewMy"（点文件看自己的提交）',
      /class="my-sub-files"[\s\S]*?bindtap="onViewMy"/.test(wxml), '(未找到 my-sub 文件绑定 onViewMy)');

    /* ---------- D17 批阅入口内移：详情页底部不再展示，点进成员提交后才可标记（2026-10-24 用户反馈） ---------- */
    // 17.1 「外面」的批量批阅按钮已移除：wxml 不再引用 onReviewOpen
    check('D17.1 详情页底部不再有「标记已完成/有问题」入口（onReviewOpen 已移除）',
      !/onReviewOpen/.test(wxml), '(仍引用 onReviewOpen)');
    // 17.2/17.3 查看提交弹层 footer 提供单条批阅按钮，绑 onReviewFromView（DONE / REJECT）
    check('D17.2 查看弹层 footer 含「标记已完成」(data-status=DONE) 且绑 onReviewFromView',
      /bindtap="onReviewFromView" data-status="DONE"/.test(wxml), '(未找到 标记已完成 内移入口)');
    check('D17.3 查看弹层 footer 含「标记有问题」(data-status=REJECT) 且绑 onReviewFromView',
      /bindtap="onReviewFromView" data-status="REJECT"/.test(wxml), '(未找到 标记有问题 内移入口)');
    // 17.4 仅真实成员（viewMember.id>0）展示；「我的提交」id=0 不展示
    check('D17.4 批阅按钮仅在 canReview && viewMember.id 时展示（「我的提交」id=0 不显示）',
      /wx:if="\{\{canReview && viewMember\.id\}\}"/.test(wxml), '(未找到 内移批阅按钮的展示条件)');
    // 17.5~17.7 行为：点成员行 → 打开查看弹层(viewMember.id=11) → 点标记 → reviewShow + reviewTargetId=11
    //           → 确认 → homeworkReview(memberIds=[11]) 并关闭两层弹层
    fakeRes = fakeDetail('NONE', { canReview: true, list: members });
    const p17 = freshPage({ id: 1, classId: 1 });
    p17._load();
    await flush();
    p17.onRowTap({ currentTarget: { dataset: { id: 11 } } });
    check('D17.5 点成员行打开查看弹层后 viewMember.id=11',
      p17.data.viewShow === true && p17.data.viewMember && p17.data.viewMember.id === 11,
      JSON.stringify(p17.data.viewMember));
    if (typeof p17.onReviewFromView !== 'function') {
      check('D17.6 点「标记已完成」→ 打开批阅层并锁定该成员(reviewTargetId=11) 且关掉当前查看弹层(viewShow=false，让批阅层浮到最前)', false, '(缺少 onReviewFromView)');
      check('D17.7 确认标记 → homeworkReview 针对该成员单条(memberIds=[11]) 并关闭弹层', false, '(同上)');
    } else {
      p17.onReviewFromView({ currentTarget: { dataset: { status: 'DONE' } } });
      check('D17.6 点「标记已完成」→ 打开批阅层并锁定该成员(reviewTargetId=11) 且关掉当前查看弹层(viewShow=false，让批阅层浮到最前)',
        p17.data.reviewShow === true && p17.data.reviewTargetId === 11 && p17.data.reviewStatus === 'DONE'
        && p17.data.viewShow === false,
        'reviewShow=' + p17.data.reviewShow + ' target=' + p17.data.reviewTargetId + ' viewShow=' + p17.data.viewShow);
      calls.review.length = 0;
      await p17.onReviewConfirm();
      await flush();
      check('D17.7 确认标记 → homeworkReview 针对该成员单条(memberIds=[11]) 并关闭两层弹层',
        calls.review.length === 1
        && JSON.stringify((calls.review[0] || {}).memberIds) === JSON.stringify([11])
        && p17.data.reviewShow === false && p17.data.viewShow === false && p17.data.reviewTargetId === 0,
        'review=' + JSON.stringify(calls.review.map((r) => r.memberIds))
        + ' reviewShow=' + p17.data.reviewShow + ' viewShow=' + p17.data.viewShow);
    }
    // 17.8 查看弹层 footer 不再有「关闭」按钮（点外面 / 点右上角叉号即可关闭，无需冗余按钮）
    check('D17.8 查看弹层 footer 已移除「关闭」按钮（bindtap="onViewClose">关闭 不再出现）',
      !/bindtap="onViewClose">关闭/.test(wxml), '(仍含 关闭 按钮)');

    /* ---------- D18 主按钮主题化：去掉高饱和蓝紫粉渐变，改用品牌蓝（用户反馈「按钮颜色太过艳丽」） ---------- */
    const wxss18 = fs.readFileSync(WXSS_PATH, 'utf8');
    check('D18.1 作业详情页主按钮(.hw .btn.f-save)被主题化覆盖为品牌蓝 var(--brand)（与 chip/状态色同色系，降低艳丽感）',
      /\.hw\s+\.btn\.f-save\s*\{[^}]*background:\s*var\(--brand\)/.test(wxss18),
      '(未找到 .hw .btn.f-save 覆盖为 var(--brand))');
    check('D18.2 主按钮覆盖不使用 linear-gradient 高饱和渐变（排除全局 .btn 的蓝紫粉渐变）',
      !/\.hw\s+\.btn\.f-save\s*\{[^}]*linear-gradient/.test(wxss18),
      '(覆盖里仍用了渐变)');

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
