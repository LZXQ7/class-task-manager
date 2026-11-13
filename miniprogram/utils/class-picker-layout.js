/**
 * 班级下拉浮层的「以当前选中项为中心」定位（纯函数，2026-11-14）
 * ============================================================
 * 用户需求：「所有下拉选择框改为，展开时列表以当前选中项为中心对齐」。
 * 解释口径（与原生 select / macOS 菜单一致）：展开的列表**围绕当前选中项**排布 ——
 * 让「已选中那一行」的垂直中心与「字段行」的垂直中心重合，其余选项分布在它的上下；
 * 而不是老样子整块从字段下方往下掉（那样选中项永远在第一行，且总是往下遮内容）。
 *
 * 为什么要抽成纯函数：组件里用 createSelectorQuery 拿到的都是运行时像素，
 * 直接写在组件方法里没法在 Node 门禁里跑。抽出来后，门禁可以对「居中 / 视口边界 /
 * 长列表退化」逐项断言，并做变异自证（见 scripts/check-class-picker.js）。
 *
 * 单位约定：入参里所有位置/尺寸是 **px**（boundingClientRect / getWindowInfo 的口径），
 * 返回值 top / height 是 **rpx**（组件内联 style 用 rpx）。换算 scale = winW / 750。
 *
 * ⚠️ 不做「程序设定初始滚动位置」：浮层是 view + overflow-y:auto，不是 scroll-view，
 *    JS 设不了 scrollTop。所以列表超过 520rpx（约 7 个班）时**主动退化为普通下拉**，
 *    由用户手指滚 —— 这时硬要居中会把选中项算到被裁掉的区域里，比不居中更糟。
 *    实际口径：教职工绑定班级 ≤ 6，恒走精确居中分支。
 */
'use strict';

/* 必须与 components/class-picker/index.wxss 的行高口径一致 */
const OPT_H = 72;        // rpx：.cp-opt padding 18+18 + line-height 34 + .cp-opt+.cp-opt margin 2
const POP_PAD = 8;       // rpx：.cp-pop 上下 padding 各 8
const POP_MAX_H = 520;   // rpx：.cp-pop max-height
const GAP = 10;          // rpx：未测量时普通下拉与字段的间距（.cp-pop margin-top）
const SAFE_TOP = 88;     // px：状态栏 + 导航栏下沿，浮层不许钻到 nav-bar 底下
const SAFE_BOTTOM = 16;  // px：视口底部留白

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

/**
 * @param {Object} c
 * @param {number} c.fieldTop   px  字段在视口中的 top（boundingClientRect().top）
 * @param {number} c.fieldH     px  字段高度
 * @param {number} c.winH       px  窗口高度
 * @param {number} c.winW       px  窗口宽度（rpx→px 换算基准）
 * @param {number} c.index      当前选中项在列表中的下标（找不到时传 0）
 * @param {number} c.count      选项总数
 * @param {number} [c.safeTop]     px 顶部安全区
 * @param {number} [c.safeBottom]  px 底部安全区
 * @returns {{ top:number, height:number, centerOffset:number, centered:boolean }}
 *          top          rpx  浮层相对 .cp-field 顶部的 top（可为负 = 向上展开）
 *          height       rpx  浮层显式高度
 *          centerOffset rpx  选中项中心 − 字段中心（0 = 完全居中；被边界夹住时非 0）
 *          centered     bool 是否真的精确居中（长列表 / 空间不足时为 false）
 */
function layoutPop(c) {
  const winW = Number(c.winW) || 375;
  const winH = Number(c.winH) || 667;
  const fieldTop = Number(c.fieldTop) || 0;
  const fieldH = Number(c.fieldH) || 30;
  const count = Math.max(1, Math.floor(Number(c.count) || 1));
  const index = clamp(Math.floor(Number(c.index) || 0), 0, count - 1);
  const scale = winW / 750;
  const safeTop = Number.isFinite(c.safeTop) ? c.safeTop : SAFE_TOP;
  const safeBottom = Number.isFinite(c.safeBottom) ? c.safeBottom : SAFE_BOTTOM;

  const contentH = 2 * POP_PAD + count * OPT_H;
  const height = Math.min(contentH, POP_MAX_H);
  const overflow = contentH > POP_MAX_H;
  const fieldHrpx = fieldH / scale;

  /* 选中项中心距浮层顶部（内容未滚动时） */
  const centerInPop = POP_PAD + index * OPT_H + OPT_H / 2;

  /* 目标：把浮层整体上移，使「选中项中心」正好落在「字段中心」 */
  const target = fieldHrpx / 2 - centerInPop;

  /* 视口边界（换算成 rpx）：浮层既不能钻到 nav-bar 底下，也不能掉出屏幕下沿 */
  const minTop = (safeTop - fieldTop) / scale;
  const maxTop = (winH - safeBottom - fieldTop) / scale - height;
  const below = fieldHrpx + GAP;   /* 普通下拉：字段下方 + 10rpx */

  let top;
  let centered = false;
  if (overflow || maxTop < minTop) {
    /* 列表太长 / 视口放不下整张列表：退回普通下拉，浮层自身可手滚 */
    top = below;
  } else {
    top = clamp(target, minTop, maxTop);
    centered = Math.abs(top - target) < 0.001;
  }

  return {
    top: Math.round(top * 10) / 10,
    height,
    centerOffset: Math.round((fieldHrpx / 2 - (top + centerInPop)) * 10) / 10,
    centered
  };
}

module.exports = {
  layoutPop,
  OPT_H,
  POP_PAD,
  POP_MAX_H,
  GAP,
  SAFE_TOP,
  SAFE_BOTTOM
};
