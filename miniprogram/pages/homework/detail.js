/**
 * P7 · 作业详情（2026-10-24）
 * ------------------------------------------------------------
 * · 班委：看提交名单 + 已交/未交统计 + 按状态筛选 + 多选批量批阅（已完成 / 有问题=打回）
 * · 成员：看作业与附件，提交 / 重新提交（覆盖原记录）
 *
 * 🔴 存储铁律：文件由小程序端 **直传云存储**（request.uploadFile），
 *    云函数只收 fileID 字符串 —— 二进制绝不经过云函数。
 */
const api = require('../../utils/api');
const util = require('../../utils/util');
const request = require('../../utils/request');
const theme = require('../../utils/theme');
const LIMIT = require('../../utils/homework-limits.js');

const STATUS_TEXT = { PENDING: '待批阅', DONE: '已完成', REJECT: '有问题' };
const REQUIRE_TEXT = { NONE: '', IMAGE: '图片', FILE: '文件', EITHER: '图片或文件' };

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pending', label: '未交' },
  { key: 'submitted', label: '已交' },
  { key: 'done', label: '已完成' },
  { key: 'reject', label: '有问题' }
];

function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i + 1).toLowerCase();
}

function isImage(name) {
  return LIMIT.IMAGE_EXTS.indexOf(extOf(name)) >= 0;
}

/** 人类可读大小：附件/已选文件行显示用（早年直接渲染字节数） */
function humanSize(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return Math.round(b / 1024 / 1024) + 'MB';
  if (b >= 1024) return Math.round(b / 1024) + 'KB';
  return b + 'B';
}

/** 格式白名单：图片走 IMAGE_EXTS，其余走 FILE_EXTS（视频类一律不在白名单内） */
function allowExt(ext, kind) {
  const e = String(ext || '').toLowerCase();
  return kind === 'IMAGE'
    ? LIMIT.IMAGE_EXTS.indexOf(e) >= 0
    : LIMIT.FILE_EXTS.indexOf(e) >= 0;
}

Page({
  data: {
    id: 0,
    classId: 0,
    homework: null,
    attaches: [],
    stats: { total: 0, submitted: 0, pending: 0, done: 0, reject: 0 },
    list: [],
    filters: FILTERS,
    filter: 'all',
    loaded: false,
    canReview: false,
    // 本人是否也需提交这份作业（后端 iAmSubmitter）：班委发的「仅自己」自测作业、
    // 或班委本人也在目标分组时，底部要同时给「提交作业」入口（2026-10-24 用户反馈）
    iAmSubmitter: false,
    picked: {},
    pickedCount: 0,
    files: [],
    uploading: false,
    reviewShow: false,
    reviewStatus: 'DONE',
    reviewText: '',
    submitShow: false
  },

  onLoad(options) {
    theme.mount(this);   // 深色模式（C-4）：挂 t-light / t-dark 到本页根节点
    const id = Number(options && options.id) || 0;
    const classId = Number(options && options.classId) || 0;
    this.setData({ id, classId });
  },

  onShow() {
    this._load();
  },

  onUnload() {
    theme.unmount(this);   // 深色模式（C-4）：摘掉主题订阅
  },

  _load() {
    if (!this.data.id) { this.setData({ loaded: true }); return; }
    api.homeworkDetail(this._payload({ id: this.data.id }))
      .then((res) => {
        const h = (res && res.homework) || null;
        const hh = h ? Object.assign({}, h, {
          groupText: (h.groups || []).map(g => g === 'SELF' ? '仅自己' : g + ' 组').join(' / '),
          requireText: REQUIRE_TEXT[h.requireType] || ''
        }) : null;
        this.setData({
          homework: hh,
          // 作业附件（发布时上传）：补 sizeText 人类可读大小 + isImage 缩略图判据；
          // fileId 是 cloud:// 云文件 ID，<image src> 可直接渲染
          attaches: ((res && res.attaches) || []).map(a => Object.assign({}, a, {
            sizeText: humanSize(a.size),
            isImage: isImage(a.name)
          })),
          stats: (res && res.stats) || this.data.stats,
          list: ((res && res.list) || []).map(x => Object.assign({}, x, {
            statusText: x.status ? (STATUS_TEXT[x.status] || x.status) : '未交',
            statusTone: x.status || 'none',
            fileCount: (x.files || []).length
          })),
          canReview: !!(res && res.canReview),
          iAmSubmitter: !!(res && res.iAmSubmitter),
          loaded: true
        });
      })
      .catch(() => this.setData({ loaded: true }));
  },

  _payload(extra) {
    const p = { classId: this.data.classId };
    return Object.assign(p, extra || {});
  },

  /* ---------------- 按状态筛选 ---------------- */
  onFilter(e) {
    const key = String(e.currentTarget.dataset.key || 'all');
    if (key === this.data.filter) return;
    this.setData({ filter: key }, () => this._load());
  },

  /* ---------------- 多选批阅 ---------------- */
  onTogglePick(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const picked = Object.assign({}, this.data.picked);
    if (picked[id]) delete picked[id]; else picked[id] = true;
    const n = Object.keys(picked).length;
    this.setData({ picked, pickedCount: n });
  },

  onReviewOpen(e) {
    const status = String(e.currentTarget.dataset.status || 'DONE');
    if (!this.data.pickedCount) { util.toast('请先选择成员'); return; }
    this.setData({ reviewShow: true, reviewStatus: status, reviewText: '' });
  },

  onReviewClose() {
    this.setData({ reviewShow: false });
  },

  onReviewConfirm() {
    const ids = Object.keys(this.data.picked).map(Number);
    if (!ids.length) { util.toast('请先选择成员'); return; }
    const status = this.data.reviewStatus;
    api.homeworkReview(this._payload({
      homeworkId: this.data.id, memberIds: ids,
      status: status, remark: this.data.reviewText
    }))
      .then(() => {
        util.toast(status === 'DONE' ? '已标记完成' : '已打回');
        this.setData({ reviewShow: false, picked: {}, pickedCount: 0 });
        this._load();
      })
      .catch(() => {});
  },

  onReviewRemark(e) {
    this.setData({ reviewText: String(e.detail.value || '') });
  },

  /* ---------------- 学生提交 ---------------- */

  /** 打开提交弹层（选图 / 选文件 / 提交） */
  onOpenSubmit() {
    this.setData({ submitShow: true });
  },

  onSubmitClose() {
    this.setData({ submitShow: false });
  },
  onChooseFile() {
    const h = this.data.homework || {};
    const cur = this.data.files || [];
    const nImg = cur.filter(f => f.kind === 'IMAGE').length;
    const nFile = cur.filter(f => f.kind === 'FILE').length;
    if (nImg >= (Number(h.maxImages) || LIMIT.IMAGE_COUNT_DEFAULT)) {
      util.toast('最多上传 ' + (Number(h.maxImages) || LIMIT.IMAGE_COUNT_DEFAULT) + ' 张图片'); return;
    }
    if (nFile >= (Number(h.maxFiles) || LIMIT.FILE_COUNT_DEFAULT)) {
      util.toast('最多上传 ' + (Number(h.maxFiles) || LIMIT.FILE_COUNT_DEFAULT) + ' 个文件'); return;
    }
    // 图片走 chooseMedia；文件走 chooseMessageFile（微信会话文件）
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        // chooseMedia 已限定图片：临时路径无后缀兜底 'jpg'；显示名用可读「图片N.ext」
        const ext = extOf(f.tempFilePath) || 'jpg';
        const n = cur.filter(x => x.kind === 'IMAGE').length + 1;
        this._pushFile({
          path: f.tempFilePath, kind: 'IMAGE',
          name: '图片' + n + '.' + ext, size: f.size || 0
        });
      }
    });
  },

  onChooseDoc() {
    const h = this.data.homework || {};
    const cur = this.data.files || [];
    const nFile = cur.filter(f => f.kind === 'FILE').length;
    if (nFile >= (Number(h.maxFiles) || LIMIT.FILE_COUNT_DEFAULT)) {
      util.toast('最多上传 ' + (Number(h.maxFiles) || LIMIT.FILE_COUNT_DEFAULT) + ' 个文件'); return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        this._pushFile({
          path: f.path, kind: 'FILE',
          name: f.name || this._nameOf(f.path, 'FILE'), size: f.size || 0
      });
      }
    });
  },

  _nameOf(path, kind) {
    const s = String(path || '');
    const seg = s.split('/').pop() || '';
    // 文件走微信返回的真实名（seg 即文件名）；兜底名带真实后缀，别让 extOf 落空
    return seg || ('作业.' + (kind === 'IMAGE' ? 'jpg' : 'pdf'));
  },

  _pushFile(file) {
    const ext = extOf(file.name);
    if (!allowExt(ext, file.kind)) {
      util.toast((file.kind === 'IMAGE' ? '图片' : '文件') + '格式不支持');
      return;
    }
    const cap = file.kind === 'IMAGE' ? LIMIT.IMAGE_MAX_BYTES : LIMIT.FILE_MAX_BYTES;
    if (Number(file.size) > cap) {
      util.toast((file.kind === 'IMAGE' ? '单张图片' : '单个文件') + '不能超过 ' + Math.round(cap / 1024 / 1024) + 'MB');
      return;
    }
    const files = (this.data.files || []).concat([Object.assign({}, file, { sizeText: humanSize(file.size) })]);
    let total = 0;
    files.forEach(f => { total += Number(f.size) || 0; });
    if (total > LIMIT.SUBMIT_TOTAL_MAX_BYTES) {
      util.toast('本次提交总大小不能超过 ' + Math.round(LIMIT.SUBMIT_TOTAL_MAX_BYTES / 1024 / 1024) + 'MB');
      return;
    }
    this.setData({ files });
  },

  onRemoveFile(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const files = (this.data.files || []).slice();
    if (idx < 0 || idx >= files.length) return;
    files.splice(idx, 1);
    this.setData({ files });
  },

  onSubmit() {
    const files = this.data.files || [];
    const rt = String((this.data.homework || {}).requireType || 'NONE');
    // 要求提交材料校验（与后端 submit 同口径）：NONE 不强制；其余至少 1 个指定类型
    if (rt !== 'NONE') {
      if (!files.length) { util.toast('请上传作业内容'); return; }
      const nImg = files.filter(f => f.kind === 'IMAGE').length;
      const nFile = files.length - nImg;
      const ok = rt === 'IMAGE' ? nImg >= 1
        : rt === 'FILE' ? nFile >= 1
        : (nImg + nFile) >= 1;
      if (!ok) {
        const label = rt === 'IMAGE' ? '本作业要求至少上传 1 张图片'
          : rt === 'FILE' ? '本作业要求至少上传 1 个文件'
          : '本作业要求至少上传 1 个图片或文件';
        util.toast(label);
        return;
      }
    }
    if (this.data.uploading) return;
    this.setData({ uploading: true });
    const hw = this.data.homework || {};
    const uploadOne = (f) => {
      const ext = extOf(f.name) || (f.kind === 'IMAGE' ? 'jpg' : 'pdf');
      const cloudPath = 'homework/' + this.data.classId + '/' + this.data.id + '/'
        + Date.now() + '-' + Math.floor(Math.random() * 10000) + '.' + ext;
      return request.uploadFile(cloudPath, f.path);
    };
    const tasks = files.map(uploadOne);
    Promise.all(tasks)
      .then((ids) => {
        const payload = files.map((f, i) => ({
          fileId: ids[i], name: f.name, size: f.size, kind: f.kind
        }));
        return api.homeworkSubmit(this._payload({ homeworkId: this.data.id, files: payload }));
      })
      .then(() => {
        util.toast('提交成功');
        this.setData({ uploading: false, files: [], submitShow: false });
        this._load();
      })
      .catch(() => {
        this.setData({ uploading: false });
      });
  },

  /* ---------------- 查看与下载 ---------------- */
  /**
   * 在线预览图片：整份作业里所有图片作为一个相册，从被点那张开始。
   * ⚠️ current 必须是 urls 里**真实存在**的那一项，否则真机白屏 ——
   *    所以这里直接用被点图片的 src 当 current（它必然在 urls 里）。
   */
  onPreview(e) {
    const url = String(e.currentTarget.dataset.src || '');
    const all = String(e.currentTarget.dataset.all || '').split('|').filter(Boolean);
    if (!url) return;
    wx.previewImage({ current: url, urls: all.length ? all : [url] });
  },

  /** 切换批量下载的命名方式：RENAME = 姓名+学号；DEFAULT = 保持原始文件名 */
  onToggleNameMode() {
    this.setData({ nameMode: this.data.nameMode === 'RENAME' ? 'DEFAULT' : 'RENAME' });
  },

  /**
   * 批量下载所选成员的作业到手机。
   *
   * ⚠️ 微信小程序**没有「任意目录 + 自定义文件名」的落盘 API**（沙箱限制），所以按类型分两条路：
   *   · 图片 → `saveImageToPhotosAlbum` 存进系统相册（需 `scope.writePhotosAlbum` 授权）
   *   · 其它文件 → 先 `downloadFile` 到本地并**重命名**，再 `openDocument(showMenu:true)`，
   *     由用户在系统弹窗里自选保存位置 / 转发。
   *   ⇒「保存路径」这件事：图片固定落在相册；文件由用户自选。我们负责把**文件名**整理好。
   */
  async onBatchDownload() {
    if (this.data.uploading) return;
    const picked = this.data.picked || {};
    const ids = Object.keys(picked).map(Number).filter(Boolean);
    if (!ids.length) { util.toast('请先选择成员'); return; }

    const list = this.data.list || [];
    const targets = [];
    ids.forEach((id) => {
      const row = list.find(x => Number(x.id) === id);
      if (row && (row.files || []).length) targets.push(row);
    });

    if (!targets.length) { util.toast('所选成员还没有提交作业'); return; }

    this.setData({ uploading: true });
    let saved = 0;
    let failed = 0;
    try {
      for (const row of targets) {
        const files = row.files || [];
        for (const f of files) {
          if (!allowExt(extOf(f.name), f.kind === 'IMAGE' ? 'IMAGE' : 'FILE')) { failed += 1; continue; }
          let url = '';
          try {
            const map = await request.getTempFileURL([f.fileId]);
            url = map[f.fileId] || '';
          } catch (e) { /* 取链接失败：记一次失败 */ }
          if (!url) { failed += 1; continue; }

          const ext = extOf(f.name) || 'pdf';
          const base = this.data.nameMode === 'RENAME'
            ? String(row.name || '') + String(row.studentNo || '')
            : String(f.name || '作业').replace(/\.[^.]+$/, '');
          const savePath = wx.env.USER_DATA_PATH + '/' + base + '.' + ext;

          try {
            const dl = await wx.downloadFile({ url: url, filePath: savePath });
            if (dl.statusCode && dl.statusCode >= 400) { failed += 1; continue; }
          } catch (e) { failed += 1; continue; }

          if (f.kind === 'IMAGE') {
            try {
              await wx.saveImageToPhotosAlbum({ filePath: savePath });
            saved += 1;
            } catch (e) { failed += 1; }
          } else {
            try {
              await wx.openDocument({ filePath: savePath, showMenu: true, fileType: ext });
            saved += 1;
            } catch (e) { failed += 1; }
          }
        }
      }
      if (saved) util.toast('已保存 ' + saved + ' 个文件' + (failed ? '，失败 ' + failed + ' 个' : ''));
      else util.toast('保存失败，请检查存储权限');
    } finally {
      this.setData({ uploading: false });
    }
  },

  onBack() {
    wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/home/index' }) });
  }
});
