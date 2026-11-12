#!/usr/bin/env node
/**
 * 门禁：演示班级只读（demo 态）+ 体验版兜底
 * =============================================================
 * 2026-11-12 需求（用户澄清口径）：所谓「体验版」= **演示班级** ——
 *   没绑定班级的人在口令页点「一键体验」进入的 class 104 演示班，
 *   不是微信的 envVersion === 'trial'。
 *
 * 为什么必须只读：演示班虽然是全虚拟数据，但**所有体验者共享同一个班**，
 *   谁传的假条 / 作业附件，后来的体验者都能在列表里看到（违规图事件即源于此）。
 *   ⚠️ 后端 review-demo.js 的 DENY 清单**故意放行**「请假登记 / 撤销」等日常写
 *   （为了让审核员能体验主功能）⇒ 这类写会真的落到演示班，必须在前端拦。
 *
 * ✅ 本门禁钉的不变式：
 *   ① 工具层 util.js：isDemo()（真源 app.globalData.demo，**不可缓存**）、
 *      isTrial()（环境兜底）、isReadonly()（两者取或）、readonlyBlocked(msg)；四者均导出；
 *   ② 网络层 request.js 双闸：uploadFile / 写类 call 在只读态 reject(40099)；
 *   ③ 各模块上传/写 handler 入口有 util.readonlyBlocked() 守卫 —— 点击即提示、不弹选择器；
 *   ④ 回归防线：isReadonly() 若退化成「只看 isTrial()」，本门禁必须变红。
 *
 * 退出码 0 = 过；非 0 = 有问题。
 * 用法：node scripts/check-demo-readonly.js            正常校验
 *      node scripts/check-demo-readonly.js --self-test 变异自证（须全部被抓）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => {
  try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; }
};

const FILES = {
  util: 'miniprogram/utils/util.js',
  request: 'miniprogram/utils/request.js',
  leave: 'miniprogram/pages/leave/index.js',
  home: 'miniprogram/pages/home/index.js',
  fee: 'miniprogram/pages/fee/index.js',
  homework: 'miniprogram/pages/homework/detail.js',
  mine: 'miniprogram/pages/mine/index.js',
  roster: 'miniprogram/pages/roster/index.js',
  classes: 'miniprogram/pages/classes/index.js'
};

/** handler 定义起点的前 N 个字符内是否出现 readonlyBlocked（守卫在入口处） */
function hasGuard(src, marker, win) {
  const i = src.indexOf(marker);
  if (i < 0) return false;
  return /readonlyBlocked/.test(src.slice(i, i + (win || 300)));
}

/** 取函数体（从 `function name(` 起 400 字符），用于判函数内部实现 */
function bodyOf(src, name, win) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  return src.slice(i, i + (win || 400));
}

/** 判据：传入各文件内容，返回未通过条数 */
function judge(f) {
  let n = 0;
  const push = (c, m) => { if (!c) { n += 1; console.log('FAIL  ' + m); } else { console.log('PASS  ' + m); } };

  // ① 工具层
  push(/function isDemo\s*\(/.test(f.util), 'util.js 定义 isDemo()');
  push(/globalData\s*&&\s*\w+\.globalData\.demo|\w+\.globalData\.demo/.test(bodyOf(f.util, 'isDemo')),
    'isDemo 真源 = app.globalData.demo（演示班身份）');
  push(!/let\s+_demo|var\s+_demo|_demoFlag|_demoCache/.test(f.util),
    'isDemo 结果不缓存（切换正式版后须立即失效）');
  push(/function isTrial\s*\(/.test(f.util), 'util.js 定义 isTrial()（环境兜底）');
  push(/function isReadonly\s*\(/.test(f.util), 'util.js 定义 isReadonly()');
  push(/isDemo\(\)\s*\|\|\s*isTrial\(\)/.test(bodyOf(f.util, 'isReadonly')),
    'isReadonly = isDemo() || isTrial()（两口径取或，不得只看 trial）');
  push(/function readonlyBlocked\s*\(/.test(f.util), 'util.js 定义 readonlyBlocked()');
  push(/演示班级仅预览/.test(f.util), 'readonlyBlocked 有演示班专属文案（不是只写体验版）');
  push(/isDemo\s*[,)]/.test(f.util) && /isReadonly\s*[,)]/.test(f.util) && /readonlyBlocked\s*[,)]/.test(f.util),
    'util.js 导出 isDemo / isReadonly / readonlyBlocked');

  // ② 网络层双闸
  push(/if \(util && util\.isReadonly\(\)\)\s*\{?\s*\n?\s*return Promise\.reject\(mkErr\(40099/.test(f.request)
    || /if \(util && util\.isReadonly\(\)\) return Promise\.reject\(mkErr\(40099/.test(f.request),
    'request.uploadFile 只读态 reject(40099)，文件不真正上传');
  push(/if \(util && util\.isReadonly\(\) && WRITE_ACTION\.test\(/.test(f.request),
    'request.call 只读态写类 action reject，写操作不上报');

  // ③ 各模块 handler 入口守卫
  push(hasGuard(f.leave, 'onPickImage() {'), 'leave.onPickImage 入口守卫（不选图/不上传）');
  push(hasGuard(f.leave, 'onSubmitApply() {'), 'leave.onSubmitApply 入口守卫（不提交）');
  push(hasGuard(f.home, '_uploadLeaveImage(leaveId) {'), 'home._uploadLeaveImage 入口守卫');
  push(hasGuard(f.fee, 'onFeeSubmit() {'), 'fee.onFeeSubmit 入口守卫（不登记消费）');
  push(hasGuard(f.fee, 'onFeePickImage() {'), 'fee.onFeePickImage 入口守卫（不选图）');
  push(hasGuard(f.fee, 'onFeeAppendTap(e) {'), 'fee.onFeeAppendTap 入口守卫');
  push(hasGuard(f.homework, 'onSubmit() {'), 'homework.onSubmit 入口守卫（不提交）');
  push(hasGuard(f.homework, 'onChooseFile() {'), 'homework.onChooseFile 入口守卫（不选图）');
  push(hasGuard(f.homework, 'onChooseDoc() {'), 'homework.onChooseDoc 入口守卫（不选文件）');
  push(hasGuard(f.mine, 'onPickAvatar() {'), 'mine.onPickAvatar 入口守卫（不上传头像）');
  push(hasGuard(f.roster, '_uploadLeaveImage(leaveId) {'), 'roster._uploadLeaveImage 入口守卫');
  push(hasGuard(f.roster, 'onImportPickFile() {'), 'roster.onImportPickFile 入口守卫（不导入）');
  push(hasGuard(f.classes, 'onWbPickFile() {'), 'classes.onWbPickFile 入口守卫（不导入）');

  // ④ 旧 API 不得残留（改名未完成会让守卫静默失效）
  const legacy = ['trialBlocked'].filter((k) => Object.keys(f).some((f2) => f[f2].indexOf(k) >= 0));
  push(!legacy.length, '无残留 trialBlocked 调用/定义（' + (legacy.join(',') || '干净') + '）');

  return n;
}

function loadAll() {
  const out = {};
  Object.keys(FILES).forEach((k) => { out[k] = read(FILES[k]); });
  return out;
}

/** 变异自证：每条变异都应让 judge() 由 0 变 >0 */
function selfTest() {
  const base = loadAll();
  const muts = [
    ['去掉 uploadFile 只读闸', 'request',
      (s) => s.replace(/if \(util && util\.isReadonly\(\)\)\s*\{?\s*\n?\s*return Promise\.reject\(mkErr\(40099/, 'if (false) return Promise.reject(mkErr(40099')],
    ['去掉 call 写类闸', 'request',
      (s) => s.replace(/if \(util && util\.isReadonly\(\) && WRITE_ACTION\.test\(/, 'if (false && WRITE_ACTION.test(')],
    ['isReadonly 退化成只看 trial（核心回归）', 'util',
      (s) => s.replace(/isDemo\(\)\s*\|\|\s*isTrial\(\)/, 'isTrial()')],
    ['isDemo 改为读缓存（切正式版后失效）', 'util',
      (s) => s.replace(/function isDemo\s*\(/, 'let _demoFlag = null;\nfunction isDemo(')],
    ['删 util.isDemo 定义', 'util',
      (s) => s.replace(/function isDemo\s*\(/, 'function isDemo_BROKEN(')],
    ['去掉 leave.onPickImage 守卫', 'leave',
      (s) => s.replace(/(onPickImage\(\) \{\s*\n)\s*if \(util\.readonlyBlocked\(\)\) return;[^\n]*\n/, '$1')],
    ['去掉 homework.onSubmit 守卫', 'homework',
      (s) => s.replace(/(onSubmit\(\) \{\s*\n)\s*if \(util\.readonlyBlocked\(\)\) return;[^\n]*\n/, '$1')]
  ];
  let bad = 0;
  muts.forEach((it) => {
    const [name, key, fn] = it;
    const f = Object.assign({}, base);
    const before = f[key];
    f[key] = fn(before);
    if (f[key] === before) { console.log('SELFTEST SKIP 变异未生效：' + name); bad += 1; return; }
    const n = judge(f);
    if (n > 0) { console.log('SELFTEST PASS 抓红(' + n + ')：' + name); }
    else { console.log('SELFTEST FAIL 漏抓：' + name); bad += 1; }
  });
  return bad;
}

if (require.main === module) {
  if (process.argv.indexOf('--self-test') >= 0) {
    console.log('── 变异自证（每条都应被抓）');
    const bad = selfTest();
    console.log('');
    if (bad) { console.log('[FAIL] ' + bad + ' 条自证异常'); process.exit(1); }
    console.log('[PASS] 变异自证全部被抓');
    process.exit(0);
  }
  console.log('── 演示班级只读（上传 / 写操作全部拦截）');
  const bad = judge(loadAll());
  console.log('');
  if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
  console.log('[PASS] 演示班级只读守卫完整');
}

module.exports = { judge };
