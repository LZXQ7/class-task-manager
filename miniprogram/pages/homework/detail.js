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
    // 「提交作业」按钮三态（后端 myStatus + closed）：只有未提交/被打回可点，
    // 待批阅/已完成/已截止置灰禁用（2026-10-24 用户反馈「提交后按钮还亮着」）
    canSubmit: true,
    submitBtnText: '提交作业',
    picked: {},
    pickedCount: 0,
    // 「全选」态（筛选行右侧按钮文案）：当前筛选下所有「有提交」的成员都被勾选
    allPicked: false,
    // 全量名单（不过滤）：批量下载按它取行 —— 勾选后切筛选，display list 会
    // 过滤空，但已勾的人仍在全量名单里，不能因此下不到（2026-10-24 用户反馈）
    listAll: [],
    // 查看某成员提交的弹层（2026-10-24 用户反馈「发布人员无法点击查看提交的作业」）
    viewShow: false,
    viewMember: null,
    viewFiles: [],
    // 批量下载命名方式：RENAME = 姓名+学号；DEFAULT = 原始文件名
    nameMode: 'RENAME',
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
    // ⚠️ filter 必须随请求带上：onFilter 只改 this.data.filter，早年 _payload 里
    // 从不带它 ⇒ 后端永远按默认 all 返回，「已交/未交」筛选-chip 点了没反应
    // （2026-10-24 用户反馈「下方筛选没有用」）。
    api.homeworkDetail(this._payload({ id: this.data.id, filter: this.data.filter }))
      .then((res) => {
        const h = (res && res.homework) || null;
        const hh = h ? Object.assign({}, h, {
          groupText: (h.groups || []).map(g => g === 'SELF' ? '仅自己' : g + ' 组').join(' / '),
          requireText: REQUIRE_TEXT[h.requireType] || '',
          // 提交弹层按钮可见性（2026-10-24 用户反馈「要求上传图片为什么还有添加文件的按钮」）：
          // IMAGE → 只给「+ 图片」；FILE → 只给「+ 文件」；EITHER/NONE → 两个都给
          canPickImage: h.requireType !== 'FILE',
          canPickFile: h.requireType !== 'IMAGE'
        }) : null;
        // 「提交作业」按钮三态（2026-10-24 用户反馈「提交后按钮还亮着」）：
        // 只有未提交 / 被打回（REJECT）可点；待批阅/已完成置灰；截止后仅打回可重交。
        // 🔴 myStatus/closed 是 detail 响应的**顶层字段**（与 homework 平级，见后端
        //    index.js 的 return 对象）—— 早年把 homework 对象传给 _submitState，
        //    两个字段永远取不到 ⇒ 六态全废、按钮恒为可点「提交作业」（真机截图复现：
        //    本人「已完成」且已截止，按钮还是亮的「提交作业」）。
        const sub = this._submitState({ myStatus: res && res.myStatus, closed: res && res.closed });
        const listAll = (res && res.list) || [];
        const list = listAll.map(x => Object.assign({}, x, {
          statusText: x.status ? (STATUS_TEXT[x.status] || x.status) : '未交',
          statusTone: x.status || 'none',
          fileCount: (x.files || []).length
        }));
        // 勾选态派生量：picked 跨筛选/刷新保留（只同步计数与「全选」态）
        const picked = this.data.picked || {};
        const selectable = list.filter(x => !!x.status);
        this.setData({
          homework: hh,
          // 作业附件（发布时上传）：补 sizeText 人类可读大小 + isImage 缩略图判据；
          // fileId 是 cloud:// 云文件 ID，<image src> 可直接渲染
          attaches: ((res && res.attaches) || []).map(a => Object.assign({}, a, {
            sizeText: humanSize(a.size),
            isImage: isImage(a.name)
          })),
          stats: (res && res.stats) || this.data.stats,
          list: list,
          listAll: listAll,
          canReview: !!(res && res.canReview),
          iAmSubmitter: !!(res && res.iAmSubmitter),
          canSubmit: sub.canSubmit,
          submitBtnText: sub.text,
          pickedCount: Object.keys(picked).length,
          allPicked: selectable.length > 0 && selectable.every(x => picked[Number(x.id)]),
          loaded: true
        });
      })
      .catch(() => this.setData({ loaded: true }));
  },

  /**
   * 提交入口三态（入参 = detail 响应的**顶层** myStatus + closed，调用方负责从
   * res 上取 —— 这两个字段与 homework 平级，不在 homework 对象里）：
   *   未交（null）      → 可点，「提交作业」
   *   被打回（REJECT）  → 可点，「重新提交」（截止也豁免，与后端 submit 同口径）
   *   待批阅（PENDING） → 置灰，「已提交 · 待批阅」；已截止则「已截止」
   *   已完成（DONE）    → 置灰，「作业已完成」；已截止则「已截止」
   */
  _submitState(fields) {
    const f = fields || {};
    const st = f.myStatus ? String(f.myStatus) : '';
    const closed = !!f.closed;
    if (st === 'PENDING') return { canSubmit: false, text: closed ? '已截止' : '已提交 · 待批阅' };
    if (st === 'DONE') return { canSubmit: false, text: closed ? '已截止' : '作业已完成' };
    if (st === 'REJECT') return { canSubmit: true, text: '重新提交' };
    return { canSubmit: !closed, text: closed ? '已截止' : '提交作业' };
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

  /* ---------------- 多选批阅 / 批量导出 ---------------- */
  /**
   * 勾选态派生量同步：pickedCount + allPicked（筛选行「全选」按钮的态）。
   * 所有改动 picked 的地方都走它，避免计数与全选态各算各的、互相漂移。
   */
  _syncPick(nextPicked) {
    const picked = nextPicked || this.data.picked || {};
    const selectable = (this.data.list || []).filter(x => !!x.status);
    const allPicked = selectable.length > 0 && selectable.every(x => picked[Number(x.id)]);
    this.setData({ picked, pickedCount: Object.keys(picked).length, allPicked });
  },

  onTogglePick(e) {
    // ⚠️ id 从**勾选框元素自身**的 dataset 取（wxml 里 data-id 必须写在 pk-box 上，
    //   不能只写在父行 —— catchtap 的 currentTarget 是 pk-box 本身，dataset 不继承父级）
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const picked = Object.assign({}, this.data.picked || {});
    if (picked[id]) delete picked[id]; else picked[id] = true;
    this._syncPick(picked);
  },

  /**
   * 「全选」：一次选完**当前筛选下**所有有提交的成员（未交没有勾选框，不参与）。
   * 2026-10-24 用户反馈「我需要将已完成的人多选后批量导出作业，而不是一个人
   * 一个人查看并保存」——配合「已完成」筛选芯片，两下点完一批人。
   * 再点一次 = 取消全选（清空全部勾选，含别的筛选下勾的，计数归零才符合直觉）。
   */
  onTogglePickAll() {
    const selectable = (this.data.list || []).filter(x => !!x.status);
    if (!selectable.length) { util.toast('当前筛选下没有可导出的提交'); return; }
    const picked = Object.assign({}, this.data.picked || {});
    const allPicked = selectable.every(x => picked[Number(x.id)]);
    if (allPicked) {
      Object.keys(picked).forEach((k) => { delete picked[k]; });
    } else {
      selectable.forEach((x) => { picked[Number(x.id)] = true; });
    }
    this._syncPick(picked);
  },

  /**
   * 点成员行 = 查看该成员提交的作业（2026-10-24 用户反馈：
   * 「成员提交作业后，发布人员无法点击查看提交的作业」）。
   * 多选改由行尾勾选框负责（catchtap 不冒泡）—— 行点击与选人从此分离。
   */
  onRowTap(e) {
    const id = Number(e.currentTarget.dataset.id);
    if (!id) return;
    const row = (this.data.list || []).find(x => Number(x.id) === id);
    if (!row) return;
    if (!(row.files || []).length) {
      util.toast(row.status ? '该成员的提交记录没有文件' : '该成员还没有提交作业');
      return;
    }
    this.setData({
      viewShow: true,
      viewMember: { id: row.id, name: row.name, studentNo: row.studentNo, statusText: row.statusText, statusTone: row.statusTone || 'none' },
      viewFiles: (row.files || []).map(f => Object.assign({}, f, {
        sizeText: humanSize(f.size),
        isImage: f.kind === 'IMAGE' || isImage(f.name)
      }))
    });
    // 弹层先开（即时反馈），临时链接异步补（cloud:// 不能直接预览/下载）
    this._fillViewUrls();
  },

  /** 查看弹层文件列表补临时 http 链接（预览/打开/下载都依赖它） */
  async _fillViewUrls() {
    const files = this.data.viewFiles || [];
    const ids = files.map(f => f.fileId).filter(Boolean);
    if (!ids.length) return;
    try {
      const map = await request.getTempFileURL(ids);
      const next = files.map(f => Object.assign({}, f, { url: map[f.fileId] || '' }));
      // 弹层可能已关：只在还开着时回写
      if (this.data.viewShow) this.setData({ viewFiles: next });
    } catch (e) { /* 取链接失败：url 为空，点击时 toast「加载中」 */ }
  },

  /**
   * 作业附件（发布时上传）图片预览（2026-10-24 用户反馈「作业附件若为图片则可点击预览」）。
   * ⚠️ cloud:// 云文件 ID 不能直接喂 wx.previewImage —— 必须先 getTempFileURL
   *    换临时 http 链接；相册 = 本作业全部图片附件，从被点那张开始。
   */
  async onPreviewAttach(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const list = this.data.attaches || [];
    const cur = list[idx];
    if (!cur || !cur.isImage) return;
    const imgIds = list.filter(a => a.isImage && a.fileId).map(a => a.fileId);
    if (!imgIds.length) { util.toast('附件加载中，请稍后再试'); return; }
    let map = {};
    try {
      map = await request.getTempFileURL(imgIds);
    } catch (err) {
      util.toast('附件加载失败，请稍后重试');
      return;
    }
    const urls = imgIds.map(id => map[id]).filter(Boolean);
    if (!urls.length) { util.toast('附件加载失败，请稍后重试'); return; }
    const current = map[cur.fileId] || urls[0];
    wx.previewImage({ current: current, urls: urls });
  },

  onViewClose() {
    this.setData({ viewShow: false });
  },

  /**
   * 查看弹层内点某个提交文件：图片 → 相册预览（整份提交的图片一个相册）；
   * 文件 → 下载到本地后 openDocument 打开（微信里由用户自选保存/转发）。
   */
  async onViewFile(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const files = this.data.viewFiles || [];
    const f = files[idx];
    if (!f) return;
    if (f.isImage) {
      const urls = files.filter(x => x.isImage).map(x => x.url).filter(Boolean);
      if (!urls.length) { util.toast('图片加载中，请稍后再试'); return; }
      wx.previewImage({ current: f.url || urls[0], urls: urls.length ? urls : [f.url] });
      return;
    }
    if (!f.url) { util.toast('文件加载中，请稍后再试'); return; }
    this.setData({ uploading: true });
    try {
      const ext = extOf(f.name) || 'pdf';
      const savePath = wx.env.USER_DATA_PATH + '/作业-' + Date.now() + '.' + ext;
      const dl = await wx.downloadFile({ url: f.url, filePath: savePath });
      if (dl.statusCode && dl.statusCode >= 400) { util.toast('下载失败'); return; }
      await wx.openDocument({ filePath: savePath, showMenu: true, fileType: ext });
    } catch (err) {
      util.toast('打开失败，请稍后重试');
    } finally {
      this.setData({ uploading: false });
    }
  },

  /** 查看弹层内「保存全部」：把该成员的全部提交文件落手机（图片进相册 / 文件 openDocument） */
  onDownloadMember() {
    const row = this.data.viewMember;
    if (!row) return;
    const files = this.data.viewFiles || [];
    if (!files.length) { util.toast('没有可保存的文件'); return; }
    this._downloadRows([Object.assign({}, row, { files })]);
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
        this.setData({ reviewShow: false });
        this._syncPick({});
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
    // 禁用态双保险：已提交（待批阅）/已完成/已截止时按钮在 wxml 已置灰，
    // 这里再拦一次 —— 防有人去掉 disabled 类后按钮还能把弹层唤起来。
    if (!this.data.canSubmit) return;
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
  /** 切换批量下载的命名方式：RENAME = 姓名+学号；DEFAULT = 保持原始文件名 */
  onToggleNameMode() {
    this.setData({ nameMode: this.data.nameMode === 'RENAME' ? 'DEFAULT' : 'RENAME' });
  },

  /** 取消批量选择（批量操作条右侧） */
  onClearPick() {
    this._syncPick({});
  },

  /**
   * 批量下载：名单上方批量操作条入口（2026-10-24 用户反馈
   * 「发布人员无法批量选择作业（图片/文件）下载」——方法早在、按钮从未接上）。
   * 下载范围 = 勾选框选中的成员；单人「保存全部」复用同一实现。
   * ⚠️ 取行走**全量名单** listAll（不是过滤后的 display list）：勾选后切到别的
   *    筛选芯片，已勾的人不在当前视图里，但仍在全量名单中，不能因此漏下载。
   */
  onBatchDownload() {
    if (this.data.uploading) return;
    const picked = this.data.picked || {};
    const ids = Object.keys(picked).map(Number).filter(Boolean);
    if (!ids.length) { util.toast('请先选择成员'); return; }
    const listAll = this.data.listAll || this.data.list || [];
    const targets = [];
    ids.forEach((id) => {
      const row = listAll.find(x => Number(x.id) === id);
      if (row && (row.files || []).length) targets.push(row);
    });
    if (!targets.length) { util.toast('所选成员还没有提交作业'); return; }
    this._downloadRows(targets);
  },

  /**
   * 把若干成员的提交文件保存到手机（批量下载 / 单人「保存全部」共用实现）。
   *
   * ⚠️ 微信小程序**没有「任意目录 + 自定义文件名」的落盘 API**（沙箱限制），所以按类型分两条路：
   *   · 图片 → `saveImageToPhotosAlbum` 存进系统相册（需 `scope.writePhotosAlbum` 授权）
   *   · 其它文件 → 先 `downloadFile` 到本地并**重命名**，再 `openDocument(showMenu:true)`，
   *     由用户在系统弹窗里自选保存位置 / 转发。
   *   ⇒「保存路径」这件事：图片固定落在相册；文件由用户自选。我们负责把**文件名**整理好。
   * ⚠️ 后端 list/files 行不带 kind（ homework_file.kind 是 ATTACH/SUBMIT 用途列，不是文件类型），
   *    图片判定必须 `kind === 'IMAGE' || isImage(name)` 双兜底 —— 早年只看 kind，
   *    批量下载时图片也走 openDocument，存不进相册。
   */
  async _downloadRows(rows) {
    if (this.data.uploading) return;
    if (!rows.length) { util.toast('没有可保存的文件'); return; }
    this.setData({ uploading: true });
    let saved = 0;
    let failed = 0;
    try {
      for (const row of rows) {
        const files = row.files || [];
        for (const f of files) {
          const isImg = f.kind === 'IMAGE' || isImage(f.name);
          if (!allowExt(extOf(f.name), isImg ? 'IMAGE' : 'FILE')) { failed += 1; continue; }
          let url = '';
          try {
            const map = await request.getTempFileURL([f.fileId]);
            url = map[f.fileId] || '';
          } catch (e) { /* 取链接失败：记一次失败 */ }
          if (!url) { failed += 1; continue; }

          const ext = extOf(f.name) || (isImg ? 'jpg' : 'pdf');
          const base = this.data.nameMode === 'RENAME'
            ? String(row.name || '') + String(row.studentNo || '')
            : String(f.name || '作业').replace(/\.[^.]+$/, '');
          const savePath = wx.env.USER_DATA_PATH + '/' + base + '.' + ext;

          try {
            const dl = await wx.downloadFile({ url: url, filePath: savePath });
            if (dl.statusCode && dl.statusCode >= 400) { failed += 1; continue; }
          } catch (e) { failed += 1; continue; }

          if (isImg) {
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
