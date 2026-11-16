/**
 * 值日页 / 全站前端「漏分号吞调用」守门（2026-11-16 事故后新增）
 * ═══════════════════════════════════════════════════════════════════════════
 * 事故：renderDuty() 里构造 qs 的最后一行漏了分号 ——
 *
 *     var qs = 'classId=' + ... + '&pageSize=' + state.dutyPageSize +
 *     api('/api/duty?' + qs).then(...)        ← 被 `+` 吞进 qs 的初始化表达式
 *
 * 调用时 qs 还没赋值完，是 undefined ⇒ 请求发成 /api/duty?undefined
 * ⇒ 后端 mod-duty.js 收不到 classId ⇒ 抛「缺少班级」⇒ 页面「加载失败」。
 *
 * 🔴 为什么 node --check 和现有门禁都没抓到：
 *   `'字符串' + api(...).then(...)` 是**完全合法的 JS 语法**（只是语义错了）。
 *   node --check 只查语法；门禁只查字符串/结构，没人断言「qs 拼完必须有分号」。
 *   结果：这是一个 100% 语法正确、100% 功能错误、一路绿灯上线的 bug。
 *
 * 本门禁两道判据：
 *   ① 精确：renderDuty 的 qs 拼接结束行必须以分号收尾，api('/api/duty?' + qs)
 *      必须是**独立语句**（前面不是 `+` 续行）。
 *   ② 通用：全 app.js 扫「上一行以 `+` 结尾、下一行是 api(/fetch( 调用」的形状。
 *      这类形状几乎必然是漏分号（正常续行不会把函数调用另起一行当字符串操作数）。
 *   ③ 变异自证：把修复后的分号故意去掉，两道判据都必须翻红；正常源码保持绿。
 *
 * 退出码：0 = 通过；1 = 有回归或自证失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'cloudfunctions/admin-web/public/app.js');
const SRC = fs.readFileSync(APP, 'utf8');
const LINES = SRC.split(/\r?\n/);

let bad = 0;
function check(ok, msg) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + msg);
  if (!ok) bad++;
}

/** 扫描文本里「行尾 + 续行 →（跳过注释）→ api(/fetch( 调用」的漏分号形状 */
function findSwallowedCalls(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  // 先把注释抹成空行（保留行数），否则一段 /* ... */ 注释会把 `+` 和 api() 隔开，
  // 判据就漏了 —— 本文件的修复注释恰好就是这个形状，变异自证实测踩到。
  const flat = [];
  let inBlock = false;
  for (const line of lines) {
    let s = line;
    let out = '';
    let i = 0;
    while (i < s.length) {
      if (inBlock) {
        const end = s.indexOf('*/', i);
        if (end < 0) { i = s.length; break; }
        inBlock = false; i = end + 2;
      } else {
        const bs = s.indexOf('/*', i);
        const ls = s.indexOf('//', i);
        const start = ls >= 0 && (bs < 0 || ls < bs) ? ls : bs;
        if (start < 0) { out += s.slice(i); break; }
        out += s.slice(i, start);
        if (start === ls) break; // 行注释吃掉余下行
        inBlock = true; i = start + 2;
      }
    }
    flat.push(out.trim());
  }
  for (let i = 0; i < flat.length - 1; i++) {
    if (!/\+\s*$/.test(flat[i])) continue;
    // 往后找首个非空行（跳过整行注释留下的空行）
    for (let j = i + 1; j < flat.length && j <= i + 12; j++) {
      if (!flat[j]) continue;
      if (/^(api|fetch)\s*\(/.test(flat[j])) {
        hits.push({ line: j + 1, prev: flat[i].slice(0, 70), call: flat[j].slice(0, 70) });
      }
      break; // 首个非空行不是调用 ⇒ 不是漏分号形状
    }
  }
  return hits;
}

console.log('\n── ① renderDuty 的 qs 与 api 调用必须分离');
const dutyStart = SRC.indexOf('function renderDuty(');
const dutySlice = dutyStart >= 0 ? SRC.slice(dutyStart, dutyStart + 2200) : '';
const dutyPair = /('&page='\s*\+\s*state\.dutyPage\s*\+\s*'&pageSize='\s*\+\s*state\.dutyPageSize)\s*;\s*(?:\/\*[\s\S]*?\*\/\s*)?api\('\/api\/duty\?'/.exec(dutySlice);
check(!!dutyPair,
  'renderDuty 的 qs 拼接以分号收尾，且 api("/api/duty?" + qs) 是独立语句' +
  (dutyPair ? '' : '  ← 漏分号会把 API 调用吞进 qs，请求变成 /api/duty?undefined'));

console.log('\n── ② 全 app.js 不得出现「+ 续行吞掉 api 调用」');
const hits = findSwallowedCalls(SRC);
check(hits.length === 0,
  '没有漏分号吞调用的形状' + (hits.length ? '（命中 ' + hits.length + ' 处）' : ''));
hits.forEach((h) => console.log('      第 ' + h.line + ' 行: ' + h.prev + ' ↵ ' + h.call));

console.log('\n── ③ 变异自证：故意去掉分号，两道判据都必须翻红');
/* 真实 bug 形状：分号被写成续行符 `+`（不是简单删掉），
   于是 api() 被当成字符串拼接的下一个操作数吞进去。 */
const mutated = SRC.replace(
  /('&page='\s*\+\s*state\.dutyPage\s*\+\s*'&pageSize='\s*\+\s*state\.dutyPageSize)\s*;/,
  '$1 +'
);
check(mutated !== SRC, '变异注入成功（分号改成续行符 +）');
const mutDuty = /('&page='\s*\+\s*state\.dutyPage\s*\+\s*'&pageSize='\s*\+\s*state\.dutyPageSize)\s*;\s*(?:\/\*[\s\S]*?\*\/\s*)?api\('\/api\/duty\?'/
  .exec(mutated.slice(mutated.indexOf('function renderDuty('), mutated.indexOf('function renderDuty(') + 2200));
check(!mutDuty, '判据①在变异体上翻红（qs 与 api 不再分离）');
const mutHits = findSwallowedCalls(mutated);
check(mutHits.length > 0, '判据②在变异体上翻红（命中 ' + mutHits.length + ' 处漏分号形状）');

console.log('\n' + (bad === 0
  ? '✓ 无漏分号吞调用；变异自证 3/3 通过'
  : '✗ 失败 ' + bad + ' 项'));
process.exit(bad === 0 ? 0 : 1);
