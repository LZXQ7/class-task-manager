/**
 * 门禁：体验版「演示态不跨进程留存 → 冷启动回口令页」（2026-10-29 需求②）
 * ------------------------------------------------------------
 * 用户口径：「点『返回登录页』，或退出小程序后重新进入 → 默认回口令页，
 *   不得自动落回演示班」。所以：
 *   · 启动**不得**自动调 reviewDemo（否则一进体验版就是演示态）；
 *   · 冷启动若仍是演示身份，必须清 impersonation（switchAccount memberId:0）后回登录态；
 *   · 未绑定仍走 _goBind()（回口令页）。进入演示只能由口令页「一键体验」显式触发。
 *
 * 变异自证（改坏必须被抓）：塞回自动进演示 / 删掉演示态判定 / 清演示改错 memberId。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.js'), 'utf8');

/** 剥注释（只判代码形态；注释里提到不算） */
const strip = (s) => String(s || '')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

function judge(src) {
  const s = strip(src);
  const p = [];
  if (/api\.reviewDemo\(\s*\{\s*quick:\s*true\s*\}/.test(s)) {
    p.push('A app 启动仍会自动进演示（应删除，改为口令页 + 手动一键体验）');
  }
  if (!/_isTrial\(\)\s*&&\s*[A-Za-z_]\.demo/.test(s)) {
    p.push('B 缺「体验版 + 演示态」判定（冷启动应清演示留存在口令页）');
  }
  if (!/switchAccount\(\s*\{\s*memberId:\s*0\s*\}/.test(s)) {
    p.push('C 冷启动未清 impersonation（switchAccount memberId:0）');
  }
  if (!/_goBind\(\)/.test(s)) {
    p.push('D 缺 _goBind（未绑定应回口令页）');
  }
  return p;
}

let bad = 0;
const probs = judge(APP);
if (probs.length) { probs.forEach((x) => { console.log('FAIL  ' + x); bad += 1; }); }
else console.log('PASS  A 不自动进演示 / B 体验版冷启动清演示 / C 清 impersonation / D 未绑定回口令页');

/** 变异：改源码副本后重判，必须翻红 */
function mut(label, mutate, predicate) {
  const before = predicate(APP);
  const after = mutate(APP);
  if (after === APP) { console.log('FAIL  变异「' + label + '」没改到源码（锚点失效）'); bad += 1; return; }
  const a = predicate(after);
  if (before === true && a === false) console.log('PASS  变异「' + label + '」被抓');
  else { console.log('FAIL  变异「' + label + '」未被抓（before=' + before + ' after=' + a + '）'); bad += 1; }
}

mut('启动塞回自动进演示',
  (s) => s.replace('      if (this._isTrial() && g.demo) {',
    '      if (false) { await api.reviewDemo({ quick: true }, { toast: false }); }\n      if (this._isTrial() && g.demo) {'),
  (s) => !/api\.reviewDemo\(\s*\{\s*quick:\s*true\s*\}/.test(strip(s)));

mut('删掉冷启动清演示判定',
  (s) => s.replace('this._isTrial() && g.demo', 'false'),
  (s) => /_isTrial\(\)\s*&&\s*[A-Za-z_]\.demo/.test(strip(s)));

mut('清演示改用错的 memberId',
  (s) => s.replace('api.switchAccount({ memberId: 0 }, { toast: false })', 'api.switchAccount({ memberId: 9 }, { toast: false })'),
  (s) => /switchAccount\(\s*\{\s*memberId:\s*0\s*\}/.test(strip(s)));

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未过'); process.exit(1); }
console.log('[PASS] 体验版演示态留存门禁全过');
