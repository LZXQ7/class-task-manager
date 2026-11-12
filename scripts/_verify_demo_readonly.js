/**
 * 演示班只读守卫 · 等价验证（Node mock wx / getApp）
 *
 *   node scripts/_verify_demo_readonly.js demo   演示班身份（demo=true，**故意用 release 环境**）
 *                                                → 上传/写 必须被拦(40099)、读放行
 *   node scripts/_verify_demo_readonly.js real   正式版真实身份（demo=false, release）
 *                                                → 上传/写/读 全部放行（正式使用零影响）
 *   node scripts/_verify_demo_readonly.js trial  体验版环境但未进演示班（demo=false, trial）
 *                                                → 上传/写 被拦（环境兜底）
 *
 * demo 场景刻意把 envVersion 设为 release：只有 isDemo()（globalData.demo）真正生效
 * 才拦得住 —— 若有人把判定退回「只看 trial」，这条会立刻 FAIL。
 * 退出码 0 = 该模式符合预期。
 */
const mode = process.argv[2] || 'demo';

const DEMO = mode === 'demo';
// demo 场景用 release：证明拦截来自「演示班身份」而非「体验版环境」
const ENV_VERSION = (mode === 'trial') ? 'trial' : 'release';

global.wx = {
  getAccountInfoSync: () => ({ miniProgram: { envVersion: ENV_VERSION } }),
  showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
  cloud: {
    init: () => {},
    uploadFile: (o) => Promise.resolve({ fileID: 'cloud://x/' + o.cloudPath }),
    // request.call 走 callback 风格（success/fail），必须回调 success 才会 resolve
    callFunction: (o) => {
      const r = { result: { errCode: 0, data: { ok: true, action: o.data.action } } };
      setTimeout(() => o.success(r), 0);
      return Promise.resolve(r);
    },
    getTempFileURL: () => Promise.resolve({ fileList: [] })
  }
};
// util.isDemo() 的真源：app.globalData.demo
global.getApp = () => ({ globalData: { demo: DEMO } });

const request = require('../miniprogram/utils/request');

(async () => {
  let uploadErr = null;
  try { await request.uploadFile('leave/1.jpg', '/tmp/a.jpg'); } catch (e) { uploadErr = e; }
  let writeErr = null;
  try { await request.call('course', 'electiveSave', {}); } catch (e) { writeErr = e; }
  let readOk = false;
  try { const r = await request.call('course', 'electiveList', {}); readOk = !!(r && r.ok); } catch (e) { readOk = false; }

  const uploadBlocked = !!(uploadErr && uploadErr.errCode === 40099);
  const writeBlocked = !!(writeErr && writeErr.errCode === 40099);

  console.log('mode=' + mode + ' env=' + ENV_VERSION + ' demo=' + DEMO
    + '  uploadBlocked=' + uploadBlocked + '  writeBlocked=' + writeBlocked + '  readOk=' + readOk);

  const expectBlocked = (mode === 'demo' || mode === 'trial');
  if (expectBlocked) {
    const ok = uploadBlocked && writeBlocked && readOk;
    console.log(ok ? '[PASS] ' + mode + '：上传/写被拦、读放行' : '[FAIL] ' + mode + ' 守卫不符预期');
    process.exitCode = ok ? 0 : 1;
  } else {
    const ok = !uploadBlocked && !writeBlocked && readOk;
    console.log(ok ? '[PASS] real：上传/写/读 全部放行（正式使用零影响）' : '[FAIL] real 放行不符预期');
    process.exitCode = ok ? 0 : 1;
  }
})();
