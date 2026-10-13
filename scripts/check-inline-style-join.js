#!/usr/bin/env node
/**
 * 第 48 个门禁：WXML 内联 style 的**插值拼接必须带分隔符**
 * ============================================================
 * 起因（2026-09-29，1.0.5 需求②「添加值日页面无法上下滑动」）：
 *   `components/bottom-sheet/index.wxml` 的面板写法是
 *     style="border-radius:…;{{height ? 'height:' + height + 'rpx' : ''}}{{capStyle}}"
 *   1.0.4.4 给 capStyle（胶囊安全上限，值形如 `max-height:calc(100vh - 68px);`）
 *   时**漏了中间的 `;`** ⇒ 传了 height 的弹层拼出
 *     `height:1040rpxmax-height:calc(100vh - 68px);`
 *   —— 长度值非法，**整条声明连同 max-height 一起被丢弃** ⇒ 面板固定高度失效
 *   ⇒ 长列表（手动排班「添加值日」59 人）滚不动、面板高度失控。
 *   受影响的是**四个传 height 的弹层**：添加值日 1040 / AI 生成 1280 / 导入 1180 / 加值日生 1240。
 *   诡异的点：**面板看起来还在**（还有 wxss 的 max-height 78vh 兜着），只是高度不对 ——
 *   编译器不会报错、文本式门禁也看不见，只能靠这条「拼接规则」拦。
 *
 * 判据（锁规则，不锁具体值）：
 *   ① 全仓 WXML 的 `style="…"` 里，**三元表达式以 '' 收尾后紧接另一个插值**（`'}}{{`）一律判死 ——
 *      那必然把上一条声明的值粘进下一条声明的属性名。
 *   ② bottom-sheet 的 sheet-panel：`{{capStyle}}` 前**必须**紧邻一个 `;`（点名式断言，
 *      锚在真实的 style 属性上，不看注释）。
 *   ③ 自证：内存变异（把 `;` 删掉）必须被判死；正常写法不得误报；注释里的坏样本不被误判。
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad++; console.log('FAIL  ' + m); };

/* ---------------- 工具 ---------------- */
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f, out); }
    else if (e.name.endsWith('.wxml')) out.push(f);
  });
  return out;
}
const read = (p) => fs.readFileSync(p, 'utf8');

/** 取出一个字符串里所有 `style="…"` 的属性值（含引号内的全部内容） */
function styleAttrs(src) {
  const out = [];
  const re = /style\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/* ---------------- ① 三元以 '' 收尾后紧接插值（缺分隔符） ---------------- */
console.log('── ① 全仓 WXML：`\'}}{{` 形态（三元空串收尾 + 紧接插值 = 缺分隔符）');
const BAD_JOIN = /'?\s*\}\}\s*\{\{/;
const files = walk(MINI, []).filter(f => fs.existsSync(f));
let scanned = 0;
const hits = [];
files.forEach((f) => {
  styleAttrs(read(f)).forEach((v) => {
    scanned++;
    // 只在「前一个插值确实以字符串 '' 收尾」时才判死（`'}}`），
    // 单纯的 `}}` + `{{`（例如 width:{{a}};height:{{b}} 之间本来就有 ;）不算。
    if (/'?\}\}\{\{/.test(v) || /''\}\}\s*\{\{/.test(v)) hits.push(path.relative(ROOT, f) + ' → ' + v);
  });
});
if (!scanned) fail('没有扫到任何 style 属性 —— 文件遍历或正则有误（防空转）');
else if (hits.length) hits.forEach(h => fail('内联 style 拼接缺分隔符：' + h));
else ok('扫过 ' + scanned + ' 个内联 style，未发现 `\'}}{{` 形态');

/* ---------------- ② bottom-sheet 的 {{capStyle}} 前必须有 ; ---------------- */
console.log('\n── ② bottom-sheet：{{capStyle}} 前必须紧邻 `;`');
const SHEET = path.join(MINI, 'components', 'bottom-sheet', 'index.wxml');
const sheetSrc = read(SHEET);
const panel = /class="sheet-panel[^"]*"\s+style="([^"]*)"/.exec(sheetSrc);
if (!panel) fail('没找到 sheet-panel 的 style 属性（正则失配）');
else {
  const v = panel[1];
  if (!/\{\{capStyle\}\}/.test(v)) fail('sheet-panel 的 style 里没有 {{capStyle}}（胶囊上限丢了？）');
  else if (/;\s*\{\{capStyle\}\}/.test(v)) ok('{{capStyle}} 前有 `;`（height 与 max-height 不会粘连）');
  else fail('{{capStyle}} 前缺少 `;` —— 会拼成 `height:1040rpxmax-height:…`，整条声明被丢弃');
  if (!/\{\{height\s*\?/.test(v)) fail('sheet-panel 的 style 里没有 height 插值（模板被改写？）');
}

/* ---------------- ③ 自证 ---------------- */
console.log('\n── ③ 自证（内存变异 + 好样本 + 注释不误判）');
// 变异：删掉分号
const mutated = sheetSrc.replace(/;\s*\{\{capStyle\}\}/, '{{capStyle}}');
const mv = /class="sheet-panel[^"]*"\s+style="([^"]*)"/.exec(mutated);
if (mv && !/;\s*\{\{capStyle\}\}/.test(mv[1])) ok('变异（删掉 `;`）→ ② 的判据会判死');
else fail('变异自证失败：删掉 `;` 后判据仍然放行（判据被削弱）');
// 好样本
const good = 'style="border-radius:24rpx;{{a ? \'x:1px;\' : \'\'}};{{b}}"';
if (!/'?\}\}\{\{/.test(styleAttrs(good)[0]) && /;\s*\{\{b\}\}/.test(styleAttrs(good)[0])) ok('好样本（有分隔符）→ 不误报');
else fail('好样本被误报');
// 注释里的坏样本不得被当作 style 命中
const withComment = '<!-- height:1040rpxmax-height:calc(100vh - 68px); -->\n<view style="width:{{w}}rpx"></view>';
if (styleAttrs(withComment).length === 1 && !/'?\}\}\{\{/.test(styleAttrs(withComment)[0])) ok('注释里的坏样本不被误判（只扫 style 属性）');
else fail('注释内容被当成 style 属性扫描了');

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 内联 style 拼接体检通过');
