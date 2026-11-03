#!/usr/bin/env node
/**
 * 主题切换逻辑测试（深色模式 C-4）——「是否真的能切到深色」的离线证据
 * ------------------------------------------------------------
 * 直接 require 真实的 utils/theme.js（CommonJS），用假 wx 注入：
 *   · 存储（getStorageSync/setStorageSync）
 *   · 系统主题（getWindowInfo/getSystemInfoSync 的 theme 字段）
 *   · 系统主题变更回调（onThemeChange）
 * 验证三种模式（system / light / dark）的解析值是否如预期，
 * 尤其确认「选了深色 → resolved 真的是 'dark'」（即开关打开后不再是浅色）。
 *
 * 用法：node scripts/test-theme.cjs
 */
const assert = require('assert');

/* ---------- 假 wx ---------- */
const store = {};
let systemTheme = 'light';
let themeCbs = [];
global.wx = {
  getStorageSync: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : ''),
  setStorageSync: (k, v) => { store[k] = v; },
  getWindowInfo: () => ({ theme: systemTheme }),
  getSystemInfoSync: () => ({ theme: systemTheme }),
  onThemeChange: (cb) => { if (typeof cb === 'function') themeCbs.push(cb); }
};

const theme = require('../miniprogram/utils/theme.js');
const config = require('../miniprogram/utils/config.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; console.log('  ✓ ' + name); }
  catch (e) { fail += 1; console.log('  ✗ ' + name + '  →  ' + e.message); }
}

console.log('── 主题切换逻辑（DARK_MODE_ENABLED = ' + config.DARK_MODE_ENABLED + '）\n');

t('修复前提：主开关已打开（否则一切切换都会被强制成浅色）', () => {
  assert.strictEqual(config.DARK_MODE_ENABLED, true);
});

t('默认进入 = 跟随系统，且当前系统为浅色 ⇒ 解析为 light', () => {
  theme.init();
  assert.strictEqual(theme.getMode(), 'system');
  assert.strictEqual(theme.getResolved(), 'light');
  assert.strictEqual(theme.themeClass(), 't-light');
});

t('选「深色」⇒ resolved 真的是 dark、落库 theme_mode=dark、themeClass=t-dark', () => {
  theme.setMode('dark');
  assert.strictEqual(theme.getMode(), 'dark');
  assert.strictEqual(theme.getResolved(), 'dark');
  assert.strictEqual(theme.getResolved() !== 'light', true);   // 关键：确实不是浅色
  assert.strictEqual(theme.themeClass(), 't-dark');
  assert.strictEqual(store['theme_mode'], 'dark');
});

t('选「浅色」⇒ 固定 light（不跟系统）', () => {
  theme.setMode('light');
  assert.strictEqual(theme.getResolved(), 'light');
  assert.strictEqual(theme.themeClass(), 't-light');
  assert.strictEqual(store['theme_mode'], 'light');
});

t('选「跟随系统」+ 系统浅色 ⇒ light', () => {
  systemTheme = 'light';
  theme.setMode('system');
  assert.strictEqual(theme.getResolved(), 'light');
});

t('选「跟随系统」+ 系统深色 ⇒ dark（跟随系统真生效）', () => {
  systemTheme = 'dark';
  theme.setMode('system');
  assert.strictEqual(theme.getResolved(), 'dark');
  assert.strictEqual(theme.themeClass(), 't-dark');
});

t('跟随系统期间，系统从浅色翻深色 ⇒ 通过 onThemeChange 实时跟翻', () => {
  systemTheme = 'light';
  theme.setMode('system');
  assert.strictEqual(theme.getResolved(), 'light');
  systemTheme = 'dark';
  themeCbs.forEach((cb) => cb({ theme: 'dark' }));     // 模拟 wx 系统主题变更广播
  assert.strictEqual(theme.getResolved(), 'dark');
});

t('手动选「深色」后，系统再翻浅色 ⇒ 不跟随（保持深色）', () => {
  theme.setMode('dark');
  systemTheme = 'light';
  themeCbs.forEach((cb) => cb({ theme: 'light' }));
  assert.strictEqual(theme.getResolved(), 'dark');   // 手动覆盖不受系统影响
});

t('订阅回调在切换时被调用（页面据此刷新 tClass）', () => {
  let called = false;
  const fn = () => { called = true; };
  theme.onThemeChange(fn);
  theme.setMode('light');
  assert.strictEqual(called, true);
  theme.offThemeChange(fn);
});

console.log('\n── 结果：' + pass + ' 通过 / ' + fail + ' 失败 ──');
process.exit(fail ? 1 : 0);
