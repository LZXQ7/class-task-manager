/**
 * 前端远程配置（config 下发）：启动拉取 · 本地缓存 · 按 key 读取。
 *
 * 用途：把「易变文案 / 功能开关」从前端代码抽出来，超管在 mp 后台改 app_config 表即生效、
 *       **免小程序审核**。
 * 机制：
 *   - loadRemoteConfig() 调 config.get，成功后把 {k:v} 写进 storage 缓存；
 *   - getRemote(key, fallback) 读缓存（首屏用上次缓存，本次拉取后下次/回前台生效）；
 *   - 拉取失败静默回退，绝不影响主流程。
 *
 * 示范项：homeBanner（首页顶部横幅文案，空则不显示）。
 */
const STORAGE_KEY = 'app.remoteConfig';
let cache = null;

function readCache() {
  if (cache && typeof cache === 'object') return cache;
  try {
    const v = wx.getStorageSync(STORAGE_KEY);
    cache = (v && typeof v === 'object') ? v : {};
  } catch (e) {
    cache = {};
  }
  return cache;
}

function writeCache(obj) {
  cache = (obj && typeof obj === 'object') ? obj : {};
  try { wx.setStorageSync(STORAGE_KEY, cache); } catch (e) { /* 缓存失败不影响主流程 */ }
}

/**
 * 拉取远程配置（config.get），成功则覆盖本地缓存。
 * @returns {Promise<object>} 最新配置（失败回退本地缓存/空对象）
 */
async function loadRemoteConfig() {
  try {
    const api = require('./api');
    const items = await api.configGet({}, { toast: false });
    if (items && typeof items === 'object') writeCache(items);
    return readCache();
  } catch (e) {
    return readCache();
  }
}

/**
 * 读取某个配置项；未设置 / 缺失时返回 fallback。
 * @param {string} key
 * @param {*} fallback
 */
function getRemote(key, fallback) {
  const c = readCache();
  if (c && Object.prototype.hasOwnProperty.call(c, key)) return c[key];
  return fallback;
}

module.exports = { loadRemoteConfig, getRemote };
