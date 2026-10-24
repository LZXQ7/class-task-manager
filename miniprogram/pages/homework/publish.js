/**
 * P7 · 发布作业（仅班委，2026-10-24）
 * ------------------------------------------------------------
 * 表单：标题 / 说明 / 截止日期+时间（默认当前时刻）/ 需交分组（A / B / 仅自己，可多选）/
 *      要求提交材料（不要求 / 图片 / 文件 / 图片或文件）/
 *      最多图片张数（1–9，默认 3）/ 最多文件个数（1–3，默认 1）/ 附件
 *
 * 🔴 附件走小程序端 **直传云存储**（request.uploadFile），云函数只收 fileID 字符串。
 *    前端先按 LIMIT 预校验（即时提示，不用等上传完才报错），后端再判一次防绕过。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const request = require('../../utils/request');
const theme = require('../../utils/theme');
const LIMIT = require('../../utils/homework-limits.js');

function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i + 1).toLowerCase();
}

function allowExt(ext, kind) {
  const e = String(ext || '').toLowerCase();
  return kind === 'IMAGE'
    ? LIMIT.IMAGE_EXTS.indexOf(e) >= 0
    : LIMIT.FILE_EXTS.indexOf(e) >= 0;
}

function ymd(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function hm(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 人类可读大小：附件行显示用（早年直接渲染字节数，用户看到 2048 这种） */
function humanSize(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return Math.round(b / 1024 / 1024) + 'MB';
  if (b >= 1024) return Math.round(b / 1024) + 'KB';
  return b + 'B';
}

/** 生成 picker range：['1','2',...,'n'] */
function rangeArr(n) {
  const a = [];
  for (let i = 1; i <= n; i++) a.push(String(i));
  return a;
}

Page({
  data: {
    classId: 0,
    title: '',
    brief: '',
    dueDate: '',
    dueTime: '23:59',
    // 分组多选：A / B / SELF（仅自己，发布者本人可见可交）
    groupA: true,
    groupB: false,
    groupSelf: false,
    maxImages: LIMIT.IMAGE_COUNT_DEFAULT,
    maxFiles: LIMIT.FILE_COUNT_DEFAULT,
    // 数量改**选项式**（picker selector，2026-10-24 用户要求「不要手动输入」）：
    // options 为可选项 range，idx 为当前选中下标（WXML 不做算术，索引 JS 预计算）
    maxImagesOptions: rangeArr(LIMIT.IMAGE_COUNT_CEILING),   // ['1'..'9']
    maxFilesOptions: rangeArr(LIMIT.FILE_COUNT_CEILING),     // ['1'..'3']
    maxImagesIdx: LIMIT.IMAGE_COUNT_DEFAULT - 1,
    maxFilesIdx: LIMIT.FILE_COUNT_DEFAULT - 1,
    // 要求提交材料类型：NONE 不要求 / IMAGE 图片 / FILE 文件 / EITHER 图片或文件
    requireType: 'NONE',
    attaches: [],
    submitting: false,
    limit: {
      image: LIMIT.IMAGE_COUNT_CEILING,        // 9
      file: LIMIT.FILE_COUNT_CEILING,          // 3
      imageDefault: LIMIT.IMAGE_COUNT_DEFAULT, // 3
      fileDefault: LIMIT.FILE_COUNT_DEFAULT,   // 1
      total: Math.round(LIMIT.SUBMIT_TOTAL_MAX_BYTES / 1024 / 1024)
    },
    requireOptions: [
      { key: 'NONE', label: '不要求' },
      { key: 'IMAGE', label: '图片' },
      { key: 'FILE', label: '文件' },
      { key: 'EITHER', label: '图片或文件' }
    ]
  },

  onLoad(options) {
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    const classId = Number(options && options.classId) || 0;
    // 默认截止 = **当前日期 + 当前时间**（用户 2026-10-24 要求：打开页面即显示此刻，
    // 发布人再按需往后再调；截止判断已精确到分钟，见后端 nowFull()）
    const now = new Date();
    this.setData({ classId, dueDate: ymd(now), dueTime: hm(now) });
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅
  },

  onTitleInput(e) { this.setData({ title: String(e.detail.value || '') }); },
  onBriefInput(e) { this.setData({ brief: String(e.detail.value || '') }); },
  onDateChange(e) { this.setData({ dueDate: String(e.detail.value || '') }); },
  onTimeChange(e) { this.setData({ dueTime: String(e.detail.value || '23:59') }); },
  onRequireType(e) {
    const k = String(e.currentTarget.dataset.k || 'NONE');
    this.setData({ requireType: k });
  },

  onToggleGroup(e) {
    const g = String(e.currentTarget.dataset.g || '');
    if (g === 'A') this.setData({ groupA: !this.data.groupA });
    else if (g === 'B') this.setData({ groupB: !this.data.groupB });
    else if (g === 'SELF') this.setData({ groupSelf: !this.data.groupSelf });
  },

  /** 图片数量选择（picker：e.detail.value 是 range 下标） */
  onMaxImagesChange(e) {
    const idx = Number(e.detail.value);
    const n = Number(this.data.maxImagesOptions[idx]);
    if (!n) return;
    this.setData({ maxImages: n, maxImagesIdx: idx });
  },

  /** 文件数量选择（picker：e.detail.value 是 range 下标） */
  onMaxFilesChange(e) {
    const idx = Number(e.detail.value);
    const n = Number(this.data.maxFilesOptions[idx]);
    if (!n) return;
    this.setData({ maxFiles: n, maxFilesIdx: idx });
  },

  /** 选择附件：图片 */
  onPickImage() {
    if ((this.data.attaches || []).length >= LIMIT.FILE_COUNT_CEILING) {
      util.toast('附件最多 ' + LIMIT.FILE_COUNT_CEILING + ' 个'); return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        // chooseMedia 已限定 mediaType=image：临时路径无后缀时兜底 'jpg'，
        // 否则 extOf('') 命中不了 IMAGE_EXTS，会把图片误判成「图片格式不支持」
        const ext = extOf(f.tempFilePath) || 'jpg';
        // 显示名用可读的「图片N.ext」，不用临时路径末段（wxfile://tmp_xxx 这种哈希串）
        const n = (this.data.attaches || []).length + 1;
        this._addAttach(f.tempFilePath, '图片' + n + '.' + ext, f.size || 0, 'IMAGE');
      }
    });
  },

  /** 选择附件：文件 */
  onPickFile() {
    if ((this.data.attaches || []).length >= LIMIT.FILE_COUNT_CEILING) {
      util.toast('附件最多 ' + LIMIT.FILE_COUNT_CEILING + ' 个'); return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        this._addAttach(f.path, f.name || '文件', f.size || 0, 'FILE');
      }
    });
  },

  /**
   * 加入附件前**先本地校验**（大小 + 格式），不等上传完才报错 ——
   * 否则同学录了 3 分钟视频上传完才被告知超大，体验极差。
   */
  _addAttach(path, name, size, kind) {
    const ext = extOf(name);
    if (!allowExt(ext, kind)) {
      util.toast((kind === 'IMAGE' ? '图片' : '文件') + '格式不支持');
      return;
    }
    const cap = kind === 'IMAGE' ? LIMIT.IMAGE_MAX_BYTES : LIMIT.FILE_MAX_BYTES;
    if (Number(size) > cap) {
      util.toast((kind === 'IMAGE' ? '单张图片' : '单个文件') + '不能超过 ' + Math.round(cap / 1024 / 1024) + 'MB');
      return;
    }
    const attaches = (this.data.attaches || []).concat([{
      path, name, size, kind, sizeText: humanSize(size)
    }]);
    this.setData({ attaches });
  },

  onRemoveAttach(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const attaches = (this.data.attaches || []).slice();
    if (idx < 0 || idx >= attaches.length) return;
    attaches.splice(idx, 1);
    this.setData({ attaches });
  },

  /**
   * 云函数调用payload：带上本页 classId（与 index.js / detail.js 同模式）。
   * 🔴 本页曾漏定义该方法却 onSubmit 里调用 ⇒ TypeError 被静默 catch 吞掉 ⇒
   *    真机「点发布毫无反应」（2026-10-24 bug，回归门禁 check-homework-publish-page.js）。
   */
  _payload(extra) {
    const p = { classId: this.data.classId };
    return Object.assign(p, extra || {});
  },

  async onSubmit() {
    const t = String(this.data.title || '').trim();
    if (!t) { util.toast('请填写作业标题'); return; }
    if (!this.data.dueDate) { util.toast('请选择截止日期'); return; }
    if (!this.data.groupA && !this.data.groupB && !this.data.groupSelf) { util.toast('请选择需提交作业的分组'); return; }
    if (this.data.submitting) return;

    this.setData({ submitting: true });
    try {
      // 附件直传云存储（不经云函数）
      const uploaded = [];
      for (const a of (this.data.attaches || [])) {
        const ext = extOf(a.name) || (a.kind === 'IMAGE' ? 'jpg' : 'pdf');
        const cloudPath = 'homework/' + this.data.classId + '/att-' + Date.now()
          + '-' + Math.floor(Math.random() * 10000) + '.' + ext;
        const fileId = await request.uploadFile(cloudPath, a.path);
        uploaded.push({ fileId: fileId, name: a.name, size: a.size, kind: a.kind });
      }
      const groups = [];
      if (this.data.groupA) groups.push('A');
      if (this.data.groupB) groups.push('B');
      if (this.data.groupSelf) groups.push('SELF');
      await api.homeworkPublish(this._payload({
        title: t,
        brief: String(this.data.brief || '').trim(),
        dueDate: (this.data.dueDate + ' ' + this.data.dueTime).trim(),
        groups: groups,
        maxImages: this.data.maxImages,
        maxFiles: this.data.maxFiles,
        requireType: this.data.requireType,
        attaches: uploaded
      }));
      util.toast('作业已发布');
      setTimeout(() => wx.navigateBack({ delta: 1 }), 600);
    } catch (e) {
      /* api 层已 toast；但页面自身异常（如方法未定义）不经 api 层，
         这里兜底提示，避免「点了没反应」的静默失败（2026-10-24 真机 bug） */
      const msg = (e && e.errMsg) || '';
      if (!msg) util.toast('发布失败，请稍后重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  }
});
