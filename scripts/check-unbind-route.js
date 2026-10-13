#!/usr/bin/env node
/**
 * 离线自检：身份失效（被解绑 / 未绑定）必须能自动回到绑定页（v0.7.17 需求④）
 * ------------------------------------------------------------
 * 用户报的故障：被解绑后，「首页」自己 catch 到 40001 画出「未绑定」，
 * 但「我的」页照旧显示原账号；只有**杀掉小程序重进**才会进绑定页。
 *
 * 根因（真实存在过，不是假想）：
 *   ① `utils/request.js` 收到 40001/40002 时会 `emit('needBind')`，
 *      但**一个监听者都没有** —— 事件发出去就蒸发了；
 *   ② App 只在 onLaunch 里判一次身份，回前台**不重新核对**，
 *      而课表页是 100% 本地渲染、一次云调用都不发 → 停在课表上被解绑，永远没有信号。
 *
 * 这个链路有 4 个环节，缺任何一环都会退回「必须重启小程序」：
 *   request.emit  →  app 监听  →  清身份与缓存 + reLaunch 到绑定页  →  回前台补校（覆盖不发请求的页面）
 * 全是纯静态可判的接线，非常适合门禁。
 *
 * 自证（双向）：拆掉任一环 → 必被抓；源码原样 → 不得误报。
 *
 * 用法：node scripts/check-unbind-route.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function chk(cond, msg) { if (cond) ok(msg); else bad(msg); }

/**
 * 取某个方法/块的花括号配对内容（不含外层括号）；找不到返回 null。
 * ⚠️ 不要用「往后截 N 字符」的近似窗口：`onShow` 后面紧跟的就是 `_recheckAuth` 的
 *    **文档注释 + 定义**，截窗口会把「定义」当成「调用」→ 变异 2（删掉调用）永远查不出来
 *    （本门禁的变异 2 就是这么先假通过一次的）。判据必须严格限定在函数体内部。
 */
function braceBlock(src, from) {
  const s = src.indexOf('{', from);
  if (s < 0) return null;
  let depth = 0;
  for (let i = s; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (!depth) return src.slice(s + 1, i);
    }
  }
  return null;
}
/** 取「名字(参数) { … }」的函数体 */
function bodyOf(src, nameRe) {
  const m = nameRe.exec(src);
  if (!m) return null;
  // ⚠️ -1：让 indexOf 从**开括号本身**开始找。写成 +0 会跳到函数体内部的第一个 `{`
  //    （如 `if (…) {`），于是取到的是「后半截」→ 好样本被误报。
  return braceBlock(src, m.index + m[0].length - 1);
}

/**
 * 纯函数审计（变异自证复用）：吃两份源码文本，吐问题列表。
 * @param {string} req  utils/request.js
 * @param {string} app  app.js
 */
function auditUnbind(reqSrc, appSrc) {
  const p = [];
  const req = strip(reqSrc);
  const app = strip(appSrc);

  // ① 请求层必须仍然上报「需要绑定」
  if (!/errCode\s*===\s*40001\s*\|\|\s*r\.errCode\s*===\s*40002[\s\S]{0,80}emit\(\s*'needBind'/.test(req)) {
    p.push('request.js 不再在 40001/40002 时 emit(\'needBind\')：身份失效没有任何下游信号');
  }

  // ② App 必须真的监听（只 emit 不监听 = 事件蒸发，历史 bug 就是这一条）
  if (!/req\.on\(\s*'needBind'/.test(app)) {
    p.push('app.js 没有监听 needBind：request 发出的事件没人接，解绑后仍要重启小程序');
  }

  // ③ 处理函数必须：清身份 + 清本地缓存 + 回绑定页
  const hBody = bodyOf(app, /_\s*handleUnbound\s*\([^)]*\)\s*\{/);
  if (!hBody) {
    p.push('app.js 缺 _handleUnbound（清身份 + 回绑定页的统一收口）');
  } else {
    if (!/bound\s*=\s*false/.test(hBody) || !/profile\s*=\s*null/.test(hBody)) {
      p.push('_handleUnbound 没有把 bound / profile 置空：首页已按未绑定渲染，但「我的」页仍会读旧 profile');
    }
    if (!/mem\.clear\s*\(/.test(hBody) || !/notice\.invalidate\s*\(/.test(hBody)) {
      p.push('_handleUnbound 没清 mem / notice 缓存：换个人绑定时会看到上一位成员的值日与通知');
    }
    if (!/_\s*goBind\s*\(/.test(hBody)) {
      p.push('_handleUnbound 没有回绑定页（_goBind）');
    }
  }

  // ④ 回前台必须补校身份 —— 课表页不发任何云调用，只靠 needBind 事件会漏掉它
  const onShowBody = bodyOf(app, /onShow\s*\([^)]*\)\s*\{/);
  if (!onShowBody || !/_\s*recheckAuth\s*\(/.test(onShowBody)) {
    p.push('App.onShow 没有调 _recheckAuth：停在纯本地页面（课表）上被解绑时没有任何信号');
  }
  const rBody = bodyOf(app, /_\s*recheckAuth\s*\([^)]*\)\s*\{/);
  if (!rBody) {
    p.push('app.js 缺 _recheckAuth');
  } else {
    if (!/!\s*g\.bound/.test(rBody) || !/_\s*handleUnbound\s*\(/.test(rBody)) {
      p.push('_recheckAuth 没有在「未绑定」时调用 _handleUnbound（补校结果没人用）');
    }
    if (!/_authChecking/.test(rBody)) {
      p.push('_recheckAuth 没有并发去重标志：切前后台会并发打多次 auth.login');
    }
  }
  return p;
}

console.log('── 身份失效 → 自动回绑定页 的四环链路');
const reqSrc = read('miniprogram/utils/request.js');
const appSrc = read('miniprogram/app.js');

const problems = auditUnbind(reqSrc, appSrc);
if (problems.length) {
  problems.forEach(x => bad(x));
} else {
  ok('① request.js 在 40001/40002 时 emit(\'needBind\')');
  ok('② app.js onLaunch 里 req.on(\'needBind\') 真的接了事件');
  ok('③ _handleUnbound：置空 bound/profile + 清 mem/notice 缓存 + 回绑定页');
  ok('④ onShow → _recheckAuth：未绑定即回绑定页，且有并发去重');
}

console.log('\n── 绑定页：口令校验与名单拉取必须并行（v0.7.17 需求①）');
{
  const bind = strip(read('miniprogram/pages/bind/index.js'));
  chk(/_rosterOf\s*\(/.test(bind) && /const rosterP = this\._rosterOf\(token\)/.test(bind),
    '名单请求与 checkToken 同时发起（并行），不再串行等两次云调用');
  chk(/ROSTER_CACHE/.test(bind), '名单有本地缓存：返回上一步 / 重试 / 二次进入同帧出名字');
  chk(/memberList\(\s*\{\s*public:\s*'roster'[^)]*\}\s*,\s*\{\s*toast:\s*false\s*\}\s*\)\.catch\(\(\)\s*=>\s*\{\}\)/s.test(bind)
    || /'__warmup__'/.test(bind),
    '进页面时预热 member 云函数（首次打开小程序时它是冷的）');
}

console.log('\n── 自证：拆掉任一环必被抓（变异必抓 + 好样本不误报）');
{
  chk(auditUnbind(reqSrc, appSrc).length === 0, '好样本：现有源码无问题（不误报）');

  const noListener = appSrc.replace(/req\.on\('needBind'[^\n]*\n/, '');
  chk(noListener !== appSrc && auditUnbind(reqSrc, noListener).length > 0,
    '变异 1：摘掉 needBind 监听（= 历史上的真实故障）→ 被抓住');

  // ⚠️ 变异用「移除调用点」而不是带缩进的字面量替换：源文件是 CRLF，
  //    带 `\n` 的字面量在 Windows 上匹配不到 → 变异静默失败（自证会假通过）。
  const noRecheck = appSrc.replace('this._recheckAuth();', '');
  chk(noRecheck !== appSrc && auditUnbind(reqSrc, noRecheck).length > 0,
    '变异 2：onShow 不再补校身份 → 被抓住');

  const noClear = appSrc.replace('try { mem.clear(); } catch (e) {}', '');
  chk(noClear !== appSrc && auditUnbind(reqSrc, noClear).length > 0,
    '变异 3：解绑时不清缓存 → 被抓住');

  const noEmit = reqSrc.replace("emit('needBind', err)", '');
  chk(noEmit !== reqSrc && auditUnbind(noEmit, appSrc).length > 0,
    '变异 4：request 不再上报 needBind → 被抓住');
}

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 身份失效回退链路体检全部通过'));
process.exit(failed ? 1 : 0);
