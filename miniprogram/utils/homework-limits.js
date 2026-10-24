/**
 * 作业模块 · 上传限制（前端镜像，2026-10-24）
 * ------------------------------------------------------------
 * ⚠️ 这是 **cloudfunctions/common/homework-limit.js 的前端镜像**，
 *    数值必须与后端**逐字一致**，由门禁 `scripts/check-homework.js` 强制比对
 *    （与 POSITIONS / GRANTED_POSITIONS 那套同款：前端只负责**提前拦 + 说人话**，
 *     后端才是判官，前端拦不住的（改包、绕过页面直接调云函数）必须被后端拦下）。
 *
 * 为什么镜像而不是单向：微信小程序端**不可能** require 云函数里的 common/，
 * 只能各存一份 + 用门禁把它们钉在一起（这是本项目既有的妥协方案）。
 */
module.exports = {
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
