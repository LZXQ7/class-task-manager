/**
 * 作业模块 · 上传限制 + 校验（唯一真源，2026-10-24）
 * ------------------------------------------------------------
 * ⚠️ 本文件是**后端权威**口径，云函数 homework 的所有校验都从这里取。
 * ⚠️ 前端镜像：miniprogram/utils/homework-limits.js —— 两边**常量数值**必须逐字一致，
 *    由门禁 `scripts/check-homework.js` 比对（与 POSITIONS / feeRights 同套打法：
 *    前端只做「提前拦截 + 友好提示」，真正的判定权在后端，防绕过）。
 *
 * 为什么定这几个数（个人版云存储仅 **2GB**，是硬约束）：
 *   · 单图 10MB：微信原图常 3–8MB，客户端压缩后落到 0.2–2MB，上限宽松又不失控。
 *   · 单文件 20MB：课程作业（pdf/docx/pptx/zip）绝大多数 <20MB。
 *   · 单次总量 50MB：堵住「多张图各 10MB」钻单文件上限空子的刷法。
 *   · 视频一律不进白名单：1 分钟视频就 100MB+，是撑爆配额的头号杀手
 *     （与之前定的「视频走外链」一致）。
 */
const LIMIT = {
  /** 单张图片上限：10 MB */
  IMAGE_MAX_BYTES: 10 * 1024 * 1024,
  /** 单个文件上限：20 MB */
  FILE_MAX_BYTES: 20 * 1024 * 1024,
  /** 单次提交总量上限：50 MB */
  SUBMIT_TOTAL_MAX_BYTES: 50 * 1024 * 1024,
  /** 图片张数可设区间的上限：9 */
  IMAGE_COUNT_CEILING: 9,
  /** 文件个数可设区间的上限：3 */
  FILE_COUNT_CEILING: 3,
  /** 图片默认张数：3 */
  IMAGE_COUNT_DEFAULT: 3,
  /** 文件默认个数：1 */
  FILE_COUNT_DEFAULT: 1,
  /** 图片扩展名白名单 */
  IMAGE_EXTS: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  /** 文件（非图片）扩展名白名单 */
  FILE_EXTS: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'zip', 'rar'],
  /** 截止后保留天数：7 */
  PURGE_AFTER_DAYS: 7,
  /** 防御上限：单次提交文件个数（即便班委配置越界也不失控） */
  HARD_MAX_FILES: 24
};

/** 取扩展名（小写，不含点）；无扩展名返回空串 */
function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  return i < 0 ? '' : s.slice(i + 1).toLowerCase();
}

/** 格式白名单：图片走 IMAGE_EXTS，其余走 FILE_EXTS（视频类一律不在白名单内） */
function allowExt(ext, kind) {
  const e = String(ext || '').toLowerCase();
  if (kind === 'IMAGE') return LIMIT.IMAGE_EXTS.indexOf(e) >= 0;
  return LIMIT.FILE_EXTS.indexOf(e) >= 0;
}

function humanMB(bytes) {
  return Math.round(Number(bytes) / 1024 / 1024) + 'MB';
}

/**
 * 校验一批文件（后端权威校验；前端镜像用于提前提示）。
 * @param {Array} files [{fileId,name,size,kind}]
 * @param {{maxImages?:number,maxFiles?:number}} cfg 班委设定的数量上限
 * @param {'SUBMIT'|'ATTACH'} scope 学生提交才校验张数/个数
 * @returns {{ok:boolean,msg:string}}
 */
function validateFiles(files, cfg, scope) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { ok: false, msg: '请上传作业内容' };
  if (list.length > LIMIT.HARD_MAX_FILES) {
    return { ok: false, msg: '最多上传 ' + LIMIT.HARD_MAX_FILES + ' 个文件' };
  }
  const c = cfg || {};
  if (scope === 'SUBMIT') {
    const maxImages = Math.min(Math.max(1, Number(c.maxImages) || LIMIT.IMAGE_COUNT_DEFAULT), LIMIT.IMAGE_COUNT_CEILING);
    const maxFiles = Math.min(Math.max(1, Number(c.maxFiles) || LIMIT.FILE_COUNT_DEFAULT), LIMIT.FILE_COUNT_CEILING);
    let nImg = 0;
    let nFile = 0;
    list.forEach(f => { if (f && f.kind === 'IMAGE') nImg += 1; else nFile += 1; });
    if (nImg > maxImages) return { ok: false, msg: '最多上传 ' + maxImages + ' 张图片' };
    if (nFile > maxFiles) return { ok: false, msg: '最多上传 ' + maxFiles + ' 个文件' };
  }

  let total = 0;
  for (const f of list) {
    if (!f || typeof f.fileId !== 'string' || f.fileId.indexOf('cloud://') !== 0) {
      return { ok: false, msg: '文件地址异常，请重新上传' };
    }
    const kind = f.kind === 'IMAGE' ? 'IMAGE' : 'FILE';
    const ext = extOf(f.name);
    if (!allowExt(ext, kind)) {
      return {
        ok: false,
        msg: (kind === 'IMAGE' ? '图片' : '文件') + '格式不支持，仅支持 '
          + (kind === 'IMAGE' ? LIMIT.IMAGE_EXTS.join('/') : LIMIT.FILE_EXTS.join('/'))
      };
    }
    const size = Number(f.size) || 0;
    const cap = kind === 'IMAGE' ? LIMIT.IMAGE_MAX_BYTES : LIMIT.FILE_MAX_BYTES;
    if (size > cap) {
      return { ok: false, msg: (kind === 'IMAGE' ? '单张图片' : '单个文件') + '不能超过 ' + humanMB(cap) };
    }
    total += size;
  }
  if (total > LIMIT.SUBMIT_TOTAL_MAX_BYTES) {
    return { ok: false, msg: '本次提交总大小不能超过 ' + humanMB(LIMIT.SUBMIT_TOTAL_MAX_BYTES) };
  }
  return { ok: true, msg: '' };
}

module.exports = { LIMIT, extOf, allowExt, validateFiles, humanMB };
