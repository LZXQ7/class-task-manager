/**
 * 线上真机验证：点登录按钮真的能登录吗
 * ==========================================
 * ⚠️ 这个脚本存在的理由（2026-10-10 事故教训）：
 *    当时的 43 项 e2e 全绿，线上却**完全点不动** —— 因为 e2e 跑 127.0.0.1 根路径，
 *    测的不是线上这套路径形态。**本地绿 ≠ 线上可用**。
 *    所以后台每次部署后必须跑一次本脚本，按真实线上地址 + 真实点击走一遍。
 *
 * 用法：ADMIN_PASS=<口令> node scripts/verify-admin-web-online.js
 * 不传 ADMIN_PASS 时只跑「静态资源与登录页渲染」检查，不做真实登录。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/PC/.dsh/skills/dashi-ppt/project/node_modules/playwright-core');

const CHROME = 'C:/Users/PC/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';
const URL_BASE = 'https://<YOUR_ENV_ID>-1306168169.ap-shanghai.app.tcloudbase.com/admin';
const SHOTS = path.join(__dirname, '..', 'outputs', 'admin-web-online');

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fails.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}

/** CloudBase 测试域名会拦一层「风险提醒」页（3s 倒计时 + 确定访问按钮） */
async function passRiskGate(page) {
  const btn = await page.$('button:has-text("确定访问")');
  if (!btn) return false;
  for (let i = 0; i < 12; i++) {
    const t = ((await btn.textContent()) || '').trim();
    if (!/[（(]\d/.test(t)) { await btn.click({ force: true }); return true; }
    await page.waitForTimeout(1000);
  }
  return false;
}

(async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrs = [];
  const apiHits = [];
  page.on('pageerror', (e) => consoleErrs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text()); });
  page.on('response', (r) => {
    const u = r.url();
    if (/\/api\//.test(u)) apiHits.push(r.status() + ' ' + r.request().method() + ' ' + u.replace(/^https?:\/\/[^/]+/, ''));
    else if (/\.(js|css)$/.test(u)) apiHits.push(r.status() + ' GET ' + u.replace(/^https?:\/\/[^/]+/, ''));
  });

  console.log('[线上] 打开 ' + URL_BASE);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 40000 });
  if (!/风险提醒/.test(await page.title())) {
    // 没有拦截页也要保证落到真页面
  } else {
    ok('穿过风险提示页', await passRiskGate(page));
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  }

  console.log('\n[1] 静态资源');
  const html = await page.content();
  ok('页面标题正确', /班级任务管理/.test(await page.title()), '实际: ' + await page.title());
  const cssOk = await page.evaluate(() => {
    const s = document.querySelector('link[rel=stylesheet]');
    return !!s && !!(s.sheet && s.sheet.cssRules && s.sheet.cssRules.length);
  });
  ok('admin.css 真的加载并生效（有 cssRules）', cssOk);

  // ⭐ 课表 HTML 解析器是**浏览器侧**的新静态资源，且必须走 /admin 前缀。
  //    这一层本地 e2e 永远测不到（本地没网关前缀这层），只有部署后才存在：
  //    静态兜底若没排除带扩展名的请求，这里会拿到 index.html ⇒ 页面报
  //    「Unexpected token '<'」，而解析器静默不可用。必须逐条验响应体。
  const parserUrl = URL_BASE + '/timetable-html.js';
  const pr = await page.request.get(parserUrl);
  const pbody = await pr.text();
  ok('/admin/timetable-html.js 返回 200', pr.status() === 200, 'status=' + pr.status());
  ok('响应体是 JS 而不是 SPA 兜底的 index.html',
    !/^\s*<!DOCTYPE|<html/i.test(pbody) && /text\/javascript|application\/javascript/i.test(
      pr.headers()['content-type'] || ''),
    'content-type=' + (pr.headers()['content-type'] || '空'));
  ok('响应体确实是解析器本体', /window\.TimetableHtml/.test(pbody) && /parsePrintLayout/.test(pbody),
    '大小=' + pbody.length);
  const noPrefix = await page.request.get(
    URL_BASE.replace(/\/admin$/, '') + '/timetable-html.js');
  ok('不带 /admin 前缀应当 404（证明网关只转发 /admin，没被兜底吃掉）',
    noPrefix.status() === 404, 'status=' + noPrefix.status());

  console.log('\n[2] 登录页渲染');
  await page.waitForSelector('#login-view:not([hidden])', { timeout: 15000 });
  ok('登录框可见', await page.isVisible('#login-username'));
  ok('登录按钮可见', await page.isVisible('#login-btn'));

  // ⭐ 核心回归断言：app.js 必须真的执行了。
  // 判据不能靠「页面看起来正常」——app.js 挂掉时页面**照样渲染得一模一样**，
  // 只有事件绑没绑上这种「行为」差异。要用「点一下有没有发请求」来判。
  console.log('\n[3] ⭐ 点击登录真的发出请求（app.js 是否执行）');
  await page.fill('#login-username', 'wrong-user-probe');
  await page.fill('#login-password', 'wrong-pass-probe');
  const before = apiHits.length;
  await page.click('#login-btn');
  await page.waitForTimeout(4000);
  const after = apiHits.slice(before);
  ok('点击后发出了 /api/auth/login 请求',
    after.some(x => /\/admin\/api\/auth\/login/.test(x)),
    '实际请求: ' + JSON.stringify(after));
  ok('URL 没被拼上口令（说明不是原生表单提交）',
    !/password=/.test(page.url()), 'url=' + page.url());
  const errVisible = await page.evaluate(() => {
    const el = document.querySelector('#login-err');
    return el ? !el.hidden : false;
  });
  ok('错误口令显示了中文提示', errVisible);
  await page.screenshot({ path: path.join(SHOTS, 'online-01-login.png') });

  const pass_ = process.env.ADMIN_PASS;
  if (pass_) {
    console.log('\n[4] 真实登录');
    await page.fill('#login-username', process.env.ADMIN_USER || 'admin');
    await page.fill('#login-password', pass_);
    await page.click('#login-btn');
    await page.waitForSelector('#main-view:not([hidden])', { timeout: 20000 });
    ok('登录成功进入主界面', await page.isVisible('#main-view'));
    const who = await page.textContent('#who');
    ok('顶栏显示当前超管（' + who.trim() + '）', (who || '').length > 0);
    await page.waitForTimeout(2500);
    ok('概览接口 200', apiHits.some(x => /^200 GET \/admin\/api\/overview/.test(x)),
      JSON.stringify(apiHits.slice(-8)));
    await page.screenshot({ path: path.join(SHOTS, 'online-02-main.png'), fullPage: true });
    console.log('\n  ⛔ 用完请登出（本脚本不留会话）');
    await page.click('#logout-btn').catch(() => {});
  } else {
    console.log('\n[4] 真实登录 —— 跳过（未传 ADMIN_PASS）');
    console.log('  要跑真登录：ADMIN_PASS=<口令> node scripts/verify-admin-web-online.js');
  }

  console.log('\n[5] 前端无错误');
  // ⚠️ 判据坑：不能把「console 里出现 error」等同于「JS 运行时错误」。
  //    浏览器把**预期内的 HTTP 4xx 也记成 console error**：
  //    · 401 = 未登录时前端主动探 /api/me（设计如此，登录页就靠它出现）
  //    · 404 = favicon.ico（本项目没有，也不打算加）
  //    这些都和 JS 是否正常执行无关。真正要抓的是 pageerror（未捕获异常）
  //    与非 HTTP 类错误。抓错会把「线上一切正常」误判成失败。
  const realErrs = consoleErrs.filter((e) => {
    if (/favicon/i.test(e)) return false;
    if (/status of (401|403)/.test(e)) return false; // 未登录探测，设计如此
    if (/status of 404/.test(e)) return false;     // favicon 等
    return true;
  });
  ok('无 JS 运行时错误（4xx 预期态已排除）', realErrs.length === 0, JSON.stringify(realErrs.slice(0, 3)));
  ok('确实发生过预期的 401（证明登录门禁在工作）', consoleErrs.some(e => /status of 401/.test(e)));

  await browser.close();
  console.log('\n==============================');
  if (fails.length) {
    console.log('线上验证 失败：通过=' + pass + ' 失败=' + fails.length);
    fails.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('线上验证 通过=' + pass + ' 失败=0');
  console.log('截图：' + SHOTS);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
