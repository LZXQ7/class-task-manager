/**
 * 主题管理器（C-4 深色模式）
 * ============================================================
 * 三种模式：'system'（跟随系统）| 'light' | 'dark'。
 * - 跟随系统时，解析值随 `wx.onThemeChange` 实时变（并走圆形揭示）。
 * - 手动覆盖时，解析值固定为所选，不再跟系统。
 * 解析值（'light' | 'dark'）决定页面挂 `t-light` / `t-dark` 哪个 class。
 *
 * 切换动效（圆形揭示）由 nav-bar 里的 overlay 负责，本模块只管「状态 + 解析值」。
 * 切换的圆心：用户点按钮 = 触点；系统变更 = 屏幕中心（见 nav-bar）。
 */
const { DARK_MODE_ENABLED } = require('./config');

const KEY = 'theme_mode';
let listeners = [];
let currentMode = 'system';
let resolved = 'light';
let inited = false;

function getSystemTheme() {
  try {
    const info = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync();
    return info && info.theme === 'dark' ? 'dark' : 'light';
  } catch (e) {
    return 'light';
  }
}

/**
 * 算出解析值（'light' | 'dark'）。
 * 🔴 开关关闭时**一律浅色**：不跟随系统、也不认手动档（见 config.DARK_MODE_ENABLED 的说明）。
 *    这条是「彻底关闭」的 ③ —— 只藏按钮不锁这里的话，手机深色模式下页面照样变深色。
 */
function resolve() {
  if (!DARK_MODE_ENABLED) {
    resolved = 'light';
    return resolved;
  }
  resolved = currentMode === 'system' ? getSystemTheme() : currentMode;
  return resolved;
}

function loadMode() {
  try {
    currentMode = wx.getStorageSync(KEY) || 'system';
  } catch (e) {
    currentMode = 'system';
  }
  return resolve();
}

function notify() {
  listeners.forEach((fn) => {
    try { fn(resolved, currentMode); } catch (e) { /* ignore */ }
  });
}

// 由 app 在 onLaunch 调用一次
function init() {
  if (inited) return resolved;
  inited = true;
  loadMode();
  try {
    if (wx.onThemeChange) {
      wx.onThemeChange((res) => {
        // 🔴 开关关闭：不跟系统翻（这条路**不经过 resolve()**，是回调里直接赋值，
        //    所以守卫必须写在这里 —— 只在 resolve() 里判的话这里会漏掉）。
        if (!DARK_MODE_ENABLED) return;
        // 仅「跟随系统」时才随系统翻转；手动覆盖不受系统影响
        if (currentMode === 'system') {
          resolved = res && res.theme === 'dark' ? 'dark' : 'light';
          notify();
        }
      });
    }
  } catch (e) { /* ignore */ }
  return resolved;
}

/**
 * 设置模式（'system' | 'light' | 'dark'），返回新的解析值。
 * ⚠️ 开关关闭期间本函数**照常落 storage、只是解析值被强制成 'light'** ——
 *    这是有意的：保留用户原来的选择，改回开关即原样恢复（清档见 config 注释）。
 */
function setMode(mode) {
  currentMode = mode;
  try { wx.setStorageSync(KEY, mode); } catch (e) { /* ignore */ }
  resolve();
  notify();
  return resolved;
}

function themeClass() {
  return resolved === 'dark' ? 't-dark' : 't-light';
}

/**
 * 系统是否要求「减弱动效」。**惰性算一次 + 进程内缓存**。
 * ------------------------------------------------------------
 * 为什么要缓存：`wx.getSystemInfoSync()` 是**同步跨线程调用**，而调用方
 * （nav-bar 的圆形揭示）是「每切一次主题走一次」—— 不缓存就是每点一下白付一次 IPC。
 * 这个值一个App 生命周期内不会变，缓存零代价。
 *
 * ⚠️ 小程序没有 `prefers-reduced-motion` 的 JS API，CSS 侧已用
 *    `@media (prefers-reduced-motion: reduce)` 关掉CSS 动画（各页 wxss 里），
 *    但**JS 驱动的逐帧动画不受 media 管**，必须在这里判。
 * 取不到 / 基础库没给字段时返回 false —— 宁多播一次，也不要把动效永久关掉。
 */
let _reduced = null;
function prefersReducedMotion() {
  if (_reduced !== null) return _reduced;
  _reduced = false;
  try {
    const si = wx.getSystemInfoSync();
    // 部分基础库会在开启「减少动态效果」时置 disableGestureAnimation / 相应标记
    _reduced = !!(si && (si.disableGestureAnimation === true || si.prefersReducedMotion === true));
  } catch (e) {
    _reduced = false;
  }
  return _reduced;
}

function onThemeChange(fn) {
  if (typeof fn === 'function') listeners.push(fn);
}
function offThemeChange(fn) {
  listeners = listeners.filter((x) => x !== fn);
}

/**
 * 把主题 class 挂到页面根节点上，并自动跟随切换。
 * ------------------------------------------------------------
 * 用法（每个页面 onLoad 里调一次）：
 *     const theme = require('../../utils/theme');
 *     onLoad() { theme.mount(this); }
 * 根节点 wxml 须写成 `class="page xxx {{tClass}}"`。
 *
 * 为什么必须由页面自己挂：主题作用域的 class 只能挂在**视图**上
 * （WXSS 的 `page` 只能选元素本身、不能选 class），
 * 而每个页面的根 view 互不相同，没有全局办法能替所有页面设 class。
 *
 * ⚠️ onUnload 必须调 `theme.unmount(this)` —— 否则 listeners 里会一直留着
 *    已销毁的页面实例，切换主题时 setData 到死页面上（内存泄漏 + 无效渲染）。
 */
const mounted = [];   // 已挂载的页面实例（用 onUnload 摘除）

function mount(page) {
  if (!page || !page.setData) return resolved;
  unmount(page);                       // 重复挂载（热重载 / onLoad 重入）先清一次
  try {
    page.setData({ tClass: themeClass() });
  } catch (e) { /* ignore */ }
  const fn = () => {
    try { page.setData({ tClass: themeClass() }); } catch (e) { /* ignore */ }
  };
  onThemeChange(fn);
  mounted.push({ page, fn });
  return resolved;
}

function unmount(page) {
  for (let i = mounted.length - 1; i >= 0; i--) {
    if (mounted[i].page === page) {
      offThemeChange(mounted[i].fn);
      mounted.splice(i, 1);
    }
  }
}

module.exports = {
  KEY,
  init,
  loadMode,
  getSystemTheme,
  setMode,
  getMode: () => currentMode,
  getResolved: () => resolved,
  themeClass,
  prefersReducedMotion,
  mount,
  unmount,
  onThemeChange,
  offThemeChange
};
