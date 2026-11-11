/**
 * 门禁：后台「使用统计」三项报障（2026-11-11）
 *
 * 守什么：
 *  ① 总览数字卡（总浏览/点击 + 总使用人数）必须排在最上面，即「访问实时数据」之前；
 *  ② 「访问来源 Top10」与「功能使用情况排行」同源（同一份 rows），后者必须删干净，
 *     连同 maxPv / kindLabel 死代码与陈旧文案一起清掉；
 *  ③ 手机端 / 电脑端版式按**设备 UA** 切换，不再按窗口宽度：
 *     · index.html 在 <head>、样式表之前按 UA 给 <html> 打 ua-mobile / ua-desktop；
 *     · app.js 用 isMobileDevice()，禁用 innerWidth / matchMedia 做版式判定；
 *     · admin.css 不允许任何 @media (max-width: ...) 版式分支，手机版规则统一挂 .ua-mobile。
 *
 * 承重方式：真实源码静态断言 + 内存变异自证（每条判据都能被对应的坏样本抓红）。
 * 跑法：node scripts/check-admin-usage-layout.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const FILES = {
  html: 'cloudfunctions/admin-web/public/index.html',
  app: 'cloudfunctions/admin-web/public/app.js',
  css: 'cloudfunctions/admin-web/public/admin.css'
};
const S = {};
for (const k of Object.keys(FILES)) S[k] = fs.readFileSync(path.join(ROOT, FILES[k]), 'utf8');

function has(s, x) { return String(s).indexOf(x) >= 0; }

/** 抠出 host.innerHTML = ...; 这一条拼接语句，用它判板块顺序（真 DOM 顺序，不是变量声明顺序） */
function insertStmt(app) {
  // ⚠️ 必须锚到 tipHtml + toolbar：文件里还有一处 `host.innerHTML = '<div class="loading">…';`，
  //    只写 /host\.innerHTML =[\s\S]*?;\n/ 会抠到那句加载态，板块顺序判据全成假绿。
  const m = /host\.innerHTML = tipHtml \+ toolbar \+[\s\S]*?;\n/.exec(app);
  return m ? m[0] : '';
}

function audit(X) {
  const bad = [];
  function need(name, cond) { if (!cond) bad.push(name); }
  const H = X.html, A = X.app, C = X.css;

  /* ① 设备形态真源 = UA */
  need('uaBootInHead', /navigator\.userAgent\b/.test(H) &&
    H.indexOf('navigator.userAgent') < H.indexOf('<body'));
  need('uaBootBeforeCss', /navigator\.userAgent\b/.test(H) &&
    H.indexOf('navigator.userAgent') < H.indexOf('/admin/admin.css'));
  need('uaClassOnHtml', has(H, "classList.add(mobile ? 'ua-mobile' : 'ua-desktop')"));
  need('uaDataMobile', has(H, 'userAgentData') && has(H, 'ud.mobile === true'));
  need('uaIpadFallback', has(H, 'navigator.maxTouchPoints > 1') && has(H, '/Macintosh/.test(ua)'));
  need('uaFlagExported', has(H, 'window.__DEVICE_MOBILE__'));

  /* ② JS 侧不许再按窗口宽度切版式 */
  need('appIsMobileHelper', has(A, 'function isMobileDevice()') &&
    has(A.replace('function isMobileDevice()', ''), 'isMobileDevice()'));
  need('appNoWidthSwitch', !/window\.innerWidth\s*>\s*900/.test(A) && !/matchMedia\(/.test(A));
  need('appResizeUa', has(A, 'if (!isMobileDevice()) closeDrawer();'));
  need('appCardTblUa', has(A, "if (card && isMobileDevice()) card.classList.add('card-tbl');"));

  /* ③ CSS 侧不许再按窗口宽度切版式 */
  need('cssNoWidthMedia', !/@media\s*\(max-width\s*:/.test(C));
  need('cssUaMobileRules', has(C, '.ua-mobile .side {') && has(C, '.ua-mobile .tbl thead') &&
    has(C, '.ua-mobile .metric-grid') && has(C, '.ua-mobile .card-hd-action'));
  need('cssUaMobileCount', (C.match(/\.ua-mobile /g) || []).length >= 30);
  need('cssDesktopRulesIntact', has(C, '.insight-grid {') && has(C, '.tbl-wrap {'));

  /* ④ 总览数字卡置顶 */
  const stmt = insertStmt(A);
  need('stmtFound', stmt.length > 0);
  need('totalOnTop', /host\.innerHTML = tipHtml \+ toolbar \+\s*totalHtml \+/.test(stmt));
  need('totalNotInUsageTop', !/<div class="usage-top">[^;]*totalHtml/.test(stmt));
  need('realtimeAfterTotal', has(stmt, 'totalHtml') && has(stmt, 'realtimeHtml') &&
    stmt.indexOf('totalHtml') < stmt.indexOf('realtimeHtml'));

  /* ⑤ 重复的「功能使用情况排行」必须删净（含死代码与陈旧文案） */
  need('noDupRankCard', !has(A, '功能使用情况排行'));
  need('noRankTblVar', !/var tbl = '<div class="card">/.test(A));
  need('noRankDeadCode', !/var maxPv = rows\.reduce/.test(A) && !/var kindLabel = \{/.test(A));
  need('dailyStillInUsageTop', has(A, "'<div class=\"usage-top\">' + dailyHtml + '</div>'"));
  need('cmpNoteUpdated', !has(A, '功能排行与成员明细'));

  return bad;
}

/** 坏样本：每条都要被 audit 抓红，否则判据是假绿 */
const MUTANTS = [
  { key: 'uaBootInHead', file: 'html', from: 'navigator.userAgent ||', to: 'navigator.platform ||' },
  { key: 'uaBootBeforeCss', file: 'html', from: '/admin/admin.css', to: '/admin/admin-x.css' },
  { key: 'uaClassOnHtml', file: 'html', from: "classList.add(mobile ? 'ua-mobile' : 'ua-desktop')", to: "classList.add('ua-desktop')" },
  { key: 'uaDataMobile', file: 'html', from: 'ud.mobile === true', to: 'ud.mobile === false' },
  { key: 'uaIpadFallback', file: 'html', from: 'navigator.maxTouchPoints > 1', to: 'false' },
  { key: 'uaFlagExported', file: 'html', from: 'window.__DEVICE_MOBILE__ = !!mobile;', to: 'window.__DEVICE_FLAG__ = !!mobile;' },
  { key: 'appIsMobileHelper', file: 'app', from: 'function isMobileDevice()', to: 'function isMobileDeviceX()' },
  { key: 'appNoWidthSwitch', file: 'app', from: 'if (!isMobileDevice()) closeDrawer();', to: 'if (window.innerWidth > 900) closeDrawer();' },
  { key: 'appCardTblUa', file: 'app', from: "if (card && isMobileDevice()) card.classList.add('card-tbl');", to: "if (card) card.classList.add('card-tbl');" },
  { key: 'cssNoWidthMedia', file: 'css', from: '.ua-mobile .side {', to: '@media (max-width: 900px) { .side {' },
  { key: 'cssUaMobileRules', file: 'css', from: '.ua-mobile .tbl thead', to: '.tbl thead' },
  { key: 'cssUaMobileCount', file: 'css', from: '.ua-mobile ', to: '' },
  { key: 'totalOnTop', file: 'app', from: 'tipHtml + toolbar +\n        totalHtml +', to: 'tipHtml + toolbar +' },
  { key: 'totalNotInUsageTop', file: 'app', from: "'<div class=\"usage-top\">' + dailyHtml + '</div>'", to: "'<div class=\"usage-top\">' + totalHtml + dailyHtml + '</div>'" },
  { key: 'noDupRankCard', file: 'app', from: "'<div class=\"usage-top\">' + dailyHtml + '</div>'", to: "'<div class=\"usage-top\">' + '<div class=\"card\"><div class=\"card-hd\">功能使用情况排行（按次数）</div></div>' + dailyHtml + '</div>'" },
  { key: 'noRankDeadCode', file: 'app', from: 'var rows = o.rows || [];', to: 'var rows = o.rows || [];\n      var maxPv = rows.reduce(function (m, r) { return Math.max(m, r.pv); }, 1);' },
  { key: 'cmpNoteUpdated', file: 'app', from: '访问来源与成员明细仍按上方', to: '功能排行与成员明细仍按上方' }
];

(function main() {
  const bad = audit(S);
  if (bad.length) {
    console.log('✗ 主线源码审计未通过：' + bad.length + ' 项');
    bad.forEach((k) => console.log('  ✗ ' + k));
    process.exit(1);
  }
  console.log('✓ 主线源码审计通过（使用统计置顶 / 去重复排行 / UA 版式）');

  let caught = 0;
  for (const mu of MUTANTS) {
    const src = S[mu.file];
    if (!has(src, mu.from)) {
      console.log('  ✗ 变异锚点失效（判据已漂移）: ' + mu.key);
      process.exit(1);
    }
    const X = Object.assign({}, S, { [mu.file]: src.split(mu.from).join(mu.to) });
    let red = [];
    try { red = audit(X); } catch (e) { red = ['throw:' + e.message]; }
    if (!red.length) {
      console.log('  ✗ 变异未被抓到（门禁形同虚设）: ' + mu.key);
      process.exit(1);
    }
    caught++;
    console.log('  ✓ 变异 ' + mu.key + ' → 抓到 ' + red.slice(0, 3).join(','));
  }
  console.log('✓ 变异自证 ' + caught + '/' + MUTANTS.length + ' 全部抓到');
})();
