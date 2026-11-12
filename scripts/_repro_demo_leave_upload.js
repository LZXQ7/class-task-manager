/**
 * 复现/验证：演示班（demo 态）下请假页「上传假条」是否被前端守卫拦住。
 * 用真实 miniprogram/pages/leave/index.js 逻辑层跑，mock wx / getApp。
 *
 * 用法：node scripts/_repro_demo_leave_upload.js demo|real
 *   demo → 期望 chooseMedia 未被调用、toast 提示「演示班级仅预览」
 *   real → 期望 chooseMedia 被调用（正常身份行为不变）
 *
 * 只做逻辑层断言，不触网、不写库。
 */
const path = require('path');
const Module = require('module');

const MODE = process.argv[2] === 'real' ? 'real' : 'demo';
const ROOT = path.join(__dirname, '..');

const calls = { chooseMedia: 0, toast: [], uploadFile: [], call: [] };

global.wx = {
  showToast: (o) => calls.toast.push((o && o.title) || ''),
  hideToast: () => {},
  showLoading: () => {},
  hideLoading: () => {},
  showModal: () => {},
  chooseMedia: (o) => { calls.chooseMedia += 1; if (o && o.success) o.success({ tempFiles: [{ tempFilePath: '/tmp/x.jpg' }] }); },
  getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
  getStorageSync: () => '',
  setStorageSync: () => {},
  removeStorageSync: () => {},
  getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 812, platform: 'android', safeArea: { top: 0, bottom: 0 } }),
  getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, safeArea: { top: 0, bottom: 0 } }),
  getAppBaseInfo: () => ({ theme: 'light', SDKVersion: '3.0.0' }),
  onThemeChange: () => {},
  offThemeChange: () => {},
  cloud: {
    init: () => {},
    uploadFile: (o) => { calls.uploadFile.push(o && o.cloudPath); return Promise.resolve({ fileID: 'cloud://x/' + (o && o.cloudPath) }); },
    callFunction: (o) => { calls.call.push(o && o.data && o.data.action); if (o && o.success) o.success({ result: { errCode: 0, data: {} } }); },
    getTempFileURL: (o) => { if (o && o.success) o.success({ fileList: [] }); }
  },
  nextTick: (fn) => fn && fn()
};

// 演示态真源：app.globalData.demo
global.getApp = () => ({ globalData: { demo: MODE === 'demo' } });

// 拦截外部模块：api / request / theme 用桩，util 用真实（它只依赖 wx / getApp）
const origLoad = Module._load;
const utilPath = path.join(ROOT, 'miniprogram', 'utils', 'util.js');
Module._load = function (request, parent, isMain) {
  const fromLeave = parent && parent.filename && parent.filename.includes(path.join('pages', 'leave'));
  if (fromLeave && /utils[\\/]api$/.test(request)) {
    return { leaveApply: () => Promise.resolve({}), leaveMyCancel: () => Promise.resolve({}), leaveApprove: () => Promise.resolve({}) };
  }
  if (fromLeave && /utils[\\/]request$/.test(request)) {
    return { uploadFile: (p) => { calls.uploadFile.push(p); return Promise.resolve('cloud://x/' + p); } };
  }
  if (fromLeave && /utils[\\/]theme$/.test(request)) {
    return { themeClass: () => 't-light', init: () => {}, mount: () => 't-light' };
  }
  return origLoad.apply(this, arguments);
};

// 捕获 Page 配置
let pageCfg = null;
global.Page = (cfg) => { pageCfg = cfg; };

require(utilPath);
require(path.join(ROOT, 'miniprogram', 'pages', 'leave', 'index.js'));

if (!pageCfg) { console.log('[FAIL] 未捕获 Page 配置'); process.exitCode = 1; return; }

// 构造假页面实例
const inst = Object.create(null);
Object.assign(inst, pageCfg);
inst.data = Object.assign({}, pageCfg.data);
inst.setData = function (patch) { Object.assign(this.data, patch || {}); };

// 触发「上传假条」
inst.onPickImage();

const blocked = calls.chooseMedia === 0;
const uploadBlocked = calls.uploadFile.length === 0;
const demoToast = calls.toast.some(t => String(t).indexOf('演示班级') >= 0);

if (MODE === 'demo') {
  const ok = blocked && uploadBlocked && demoToast;
  console.log(ok
    ? '[PASS] demo：不弹选图器、不上传，并提示「演示班级仅预览，操作不会真实保存」'
    : `[FAIL] demo：chooseMedia=${calls.chooseMedia} uploadFile=${calls.uploadFile.length} toast=${JSON.stringify(calls.toast)}`);
  if (!ok) process.exitCode = 1;
} else {
  const ok = !blocked && !demoToast;
  console.log(ok
    ? '[PASS] real：正常身份照旧弹选图器并上传（行为不变）'
    : `[FAIL] real：chooseMedia=${calls.chooseMedia} toast=${JSON.stringify(calls.toast)}`);
  if (!ok) process.exitCode = 1;
}
