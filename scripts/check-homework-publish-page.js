#!/usr/bin/env node
/**
 * 发布页（publish.js）页面逻辑门禁（2026-10-24，锁死「点发布没反应」bug）
 * ============================================================
 *  bug 复盘：onSubmit 调 `this._payload(...)` 但 publish.js **漏定义该方法**
 *  （index.js/detail.js 都有、唯独发布页没有）⇒ TypeError 抛在 try 内被 onSubmit 的
 *  静默 catch（"api 层已 toast"）吞掉 ⇒ 用户点「发布」毫无反应也无 toast；
 *  而「取消」走 onBack 不依赖任何东西所以正常返回。
 *  根因类别：**前端页面方法未定义 + 静默 catch**，后端测试门禁完全覆盖不到。
 *
 *  本门禁加载 publish.js **生产源码**（Module._load 钩子桩掉 5 个依赖模块 + wx 全局），
 *  在页面方法级 seam 断言，防同类复发。
 *
 * 覆盖：
 *   P1 _payload 方法存在且返回 { classId, ...extra }   ← 本 bug 的回归判据
 *   P2 合法表单 onSubmit → api.homeworkPublish 收到正确 payload（含 SELF 分组 / 带时分截止 / requireType）
 *   P3 空标题 / 无分组 / 无截止 → 各自 toast 且不调发布（用户提示不丢）
 *   P4 onBack → wx.navigateBack（取消可返回）
 *   P5 选图：可读名「图片N.ext」+ kind/path/sizeText（缩略图数据）+ 无后缀临时路径兜底
 *   P6 选文件：真实文件名 + kind + sizeText
 *   P7 数量选择（picker 选项式，禁手动 input）：options range / 索引同步 / 非法下标不破坏状态
 *
 * 退出码：全过 0；任一不过 1（由 scripts/run_all_gates.sh 的 glob 自动纳入）。
 */
'use strict';
const path = require('path');
const Module = require('module');

/* ---------- 依赖桩 ---------- */
const calls = { publish: [], toast: [], back: [] };
const apiStub = { homeworkPublish: async (p) => { calls.publish.push(p); return { ok: true }; } };
const utilStub = { toast: (m) => calls.toast.push(m) };
const requestStub = { uploadFile: async (p) => 'cloud://test-env/' + p };
const themeStub = { mount() {}, unmount() {} };
const choosers = { media: null, file: null };   // 可触发的微信选择器桩（P5/P6 用）

global.wx = {
  navigateBack: (o) => calls.back.push(o && o.delta),
  switchTab: () => calls.back.push('switchTab'),
  showToast: (o) => calls.toast.push(o && o.title),
  chooseMedia: (o) => { choosers.media = o; },
  chooseMessageFile: (o) => { choosers.file = o; }
};

const PUB_PATH = path.resolve(__dirname, '../miniprogram/pages/homework/publish.js');
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
require(PUB_PATH);
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

(async () => {
  try {
    if (!cfg) { console.error('FAIL: publish.js 未注册 Page'); process.exit(1); }
    console.log('== 发布页页面逻辑（publish.js 生产源码） ==');

    /* ---------- P1 _payload 存在性（本 bug 回归判据） ---------- */
    const p0 = freshPage({ classId: 7 });
    check('P1.1 onSubmit 依赖的 _payload 方法已定义（漏定义=点发布静默无反应）',
      typeof p0._payload === 'function');
    const pl = p0._payload({ title: 'x' });
    check('P1.2 _payload 返回 { classId, ...extra }',
      !!pl && pl.classId === 7 && pl.title === 'x', JSON.stringify(pl));

    /* ---------- P2 合法表单 → 发布链路通畅 ---------- */
    calls.publish.length = 0; calls.toast.length = 0;
    const p2 = freshPage({
      classId: 1, title: '自测作业', brief: '自己发给自己',
      dueDate: '2030-10-25', dueTime: '12:00',
      groupA: false, groupB: false, groupSelf: true,
      maxImages: 3, maxFiles: 1, requireType: 'IMAGE', attaches: []
    });
    await p2.onSubmit();
    check('P2.1 合法表单 onSubmit 走到 api.homeworkPublish（点发布有反应）',
      calls.publish.length === 1, '调用次数=' + calls.publish.length + ' toast=' + JSON.stringify(calls.toast));
    const pay = calls.publish[0] || {};
    check('P2.2 payload 正确（classId / 带时分截止 / groups 含 SELF / requireType=IMAGE）',
      pay.classId === 1 && pay.dueDate === '2030-10-25 12:00'
      && Array.isArray(pay.groups) && pay.groups.indexOf('SELF') >= 0
      && pay.requireType === 'IMAGE' && pay.title === '自测作业',
      JSON.stringify(pay));
    check('P2.3 发布成功后 toast「作业已发布」', calls.toast.indexOf('作业已发布') >= 0, JSON.stringify(calls.toast));

    /* ---------- P3 表单校验提示不丢 ---------- */
    calls.publish.length = 0; calls.toast.length = 0;
    const p3a = freshPage({ title: '', dueDate: '2030-10-25', dueTime: '12:00', groupA: true });
    await p3a.onSubmit();
    check('P3.1 空标题 toast「请填写作业标题」且不调发布',
      calls.toast.indexOf('请填写作业标题') >= 0 && calls.publish.length === 0);

    calls.toast.length = 0;
    const p3b = freshPage({ title: 't', dueDate: '', dueTime: '12:00', groupA: true });
    await p3b.onSubmit();
    check('P3.2 无截止日期 toast「请选择截止日期」且不调发布',
      calls.toast.indexOf('请选择截止日期') >= 0 && calls.publish.length === 0);

    calls.toast.length = 0;
    const p3c = freshPage({ title: 't', dueDate: '2030-10-25', dueTime: '12:00', groupA: false, groupB: false, groupSelf: false });
    await p3c.onSubmit();
    check('P3.3 无分组 toast「请选择需提交作业的分组」且不调发布',
      calls.toast.indexOf('请选择需提交作业的分组') >= 0 && calls.publish.length === 0);

    /* ---------- P4 取消可返回 ---------- */
    calls.back.length = 0;
    const p4 = freshPage({});
    p4.onBack();
    check('P4.1 onBack 调 wx.navigateBack（取消可返回）', calls.back.indexOf(1) >= 0, JSON.stringify(calls.back));

    /* ---------- P5 选图：可读名 + 缩略图数据 + 无后缀兜底 ---------- */
    const p5 = freshPage({ classId: 1 });
    p5.onPickImage();
    check('P5.1 onPickImage 走 wx.chooseMedia 且限定 image',
      !!choosers.media && (choosers.media.mediaType || []).indexOf('image') >= 0);
    // 模拟微信返回：临时路径末段是哈希串（早年直接把它当文件名显示，用户看到乱码）
    choosers.media.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_9f8e7d6c.jpg', size: 2048 }] });
    const at = p5.data.attaches || [];
    check('P5.2 图片附件：可读名「图片1.jpg」+ kind=IMAGE + path=临时路径（缩略图 src）',
      at.length === 1 && at[0].kind === 'IMAGE' && at[0].name === '图片1.jpg'
      && at[0].path === 'wxfile://tmp_9f8e7d6c.jpg',
      JSON.stringify(at));
    check('P5.3 sizeText 人类可读（2048B → 2KB）', at.length === 1 && at[0].sizeText === '2KB', at[0] && at[0].sizeText);

    // 部分机型 tempFilePath 无后缀：早年 extOf('') 命中不了 IMAGE_EXTS ⇒ 误报「图片格式不支持」
    const p5b = freshPage({ classId: 1 });
    p5b.onPickImage();
    choosers.media.success({ tempFiles: [{ tempFilePath: 'wxfile://tmp_nosuffix', size: 2048 }] });
    const at2 = p5b.data.attaches || [];
    check('P5.4 临时路径无后缀兜底为 图片1.jpg（不误报格式不支持）',
      at2.length === 1 && at2[0].name === '图片1.jpg' && at2[0].kind === 'IMAGE', JSON.stringify(at2));

    /* ---------- P6 选文件：真实文件名 ---------- */
    const p6 = freshPage({ classId: 1 });
    p6.onPickFile();
    check('P6.1 onPickFile 走 wx.chooseMessageFile 且限定 file',
      !!choosers.file && choosers.file.type === 'file');
    choosers.file.success({ tempFiles: [{ path: 'wxfile://tmp_doc', name: '实验报告.pdf', size: 10240 }] });
    const ft = p6.data.attaches || [];
    check('P6.2 文件附件：真实文件名「实验报告.pdf」+ kind=FILE',
      ft.length === 1 && ft[0].kind === 'FILE' && ft[0].name === '实验报告.pdf', JSON.stringify(ft));
    check('P6.3 sizeText 人类可读（10240B → 10KB）', ft.length === 1 && ft[0].sizeText === '10KB', ft[0] && ft[0].sizeText);

    /* ---------- P7 数量改选项式（picker），不再手动输入 ---------- */
    // 背景：input type=number 在部分真机上数字删不掉、改不动（用户 2026-10-24 反馈）
    const p7 = freshPage({ classId: 1 });
    const d7 = p7.data;
    check('P7.1 maxImagesOptions = [1..9] 且默认索引指向默认值 3',
      Array.isArray(d7.maxImagesOptions) && d7.maxImagesOptions.length === 9
      && d7.maxImagesOptions[0] === '1' && d7.maxImagesOptions[8] === '9'
      && d7.maxImagesIdx === 2 && d7.maxImages === 3,
      JSON.stringify({ opts: d7.maxImagesOptions, idx: d7.maxImagesIdx, val: d7.maxImages }));
    check('P7.2 maxFilesOptions = [1..3] 且默认索引指向默认值 1',
      Array.isArray(d7.maxFilesOptions) && d7.maxFilesOptions.length === 3
      && d7.maxFilesOptions[0] === '1' && d7.maxFilesOptions[2] === '3'
      && d7.maxFilesIdx === 0 && d7.maxFiles === 1,
      JSON.stringify({ opts: d7.maxFilesOptions, idx: d7.maxFilesIdx, val: d7.maxFiles }));
    p7.onMaxImagesChange({ detail: { value: 4 } });
    check('P7.3 onMaxImagesChange 按 picker 下标取值（idx=4 → 5 张，索引同步）',
      p7.data.maxImages === 5 && p7.data.maxImagesIdx === 4,
      JSON.stringify({ val: p7.data.maxImages, idx: p7.data.maxImagesIdx }));
    p7.onMaxFilesChange({ detail: { value: 2 } });
    check('P7.4 onMaxFilesChange 按 picker 下标取值（idx=2 → 3 个，索引同步）',
      p7.data.maxFiles === 3 && p7.data.maxFilesIdx === 2,
      JSON.stringify({ val: p7.data.maxFiles, idx: p7.data.maxFilesIdx }));
    const before = p7.data.maxImages;
    p7.onMaxImagesChange({ detail: { value: 99 } });
    check('P7.5 非法 picker 下标不改状态（防 NaN 入库）',
      p7.data.maxImages === before && p7.data.maxImagesIdx === 4,
      JSON.stringify({ val: p7.data.maxImages, idx: p7.data.maxImagesIdx }));

    /* ---------- 汇总 ---------- */
    console.log('\n==============================');
    console.log('发布页页面逻辑门禁 通过=' + pass + ' 失败=' + fail);
    if (fail > 0) { console.log('失败项: ' + failed.join(' / ')); process.exit(1); }
    console.log('全绿');
    process.exit(0);
  } catch (e) {
    console.error('[check-homework-publish-page] 运行异常:', e);
    process.exit(1);
  }
})();
