#!/usr/bin/env node
/**
 * 门禁：值日页「液态玻璃按钮 + 视图切换淡入上浮」（2026-11-17 用户两条需求）
 * ------------------------------------------------------------
 * ① 分段控件（值日 / 课前演讲）与操作按钮排改成和底部导航栏同款玻璃：
 *    · 轨道 / 按钮底走 `var(--tabbar-bg, …)` + backdrop-filter + `var(--tabbar-edge)`；
 *    · 选中胶囊走 `var(--tab-ind, …)`（浅蓝 tint / 深色亮蓝），文字走 `var(--brand)`；
 *      旧写法 `background: var(--brand)` 实底蓝必须去掉，否则深色下是一块死蓝。
 *    · 不支持模糊 / 系统降低透明度两条降级路径必须把新选择器也覆盖到。
 * ② 值日 ↔ 课前演讲 切换加淡入 + 轻微上浮（不是瞬间硬切）：
 *    · 两个分支各包一层 `.dt-vp`，CSS 动画 `dtViewIn`（opacity 0→1 / translateY 16rpx→0）；
 *    · ≤300ms、ease-out、尊重 prefers-reduced-motion。
 * ③ 点击反馈：分段标签补 `data-pressable` + `hover-class="press-dim"`，
 *    复用全局 #6 按压超调（app.wxss .m-press），不另起一套。
 *
 * 自证：把玻璃令牌 / 动画 / hover 任一处改回旧写法，必须红。
 * 用法：node scripts/check-duty-glass-view.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failed += 1; console.log('  ✗ ' + m); };
const chk = (c, m) => (c ? ok(m) : bad(m));

/** 取选择器精确规则体（不含嵌套 at-rule），避免 CRLF 多行锚点失配 */
function rule(css, sel) {
  const re = new RegExp('(?:^|\\})[^{}]*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^{}]*)\\}', 'g');
  const out = [];
  let m;
  while ((m = re.exec(css))) out.push(m[1]);
  return out;
}
/** 剥掉所有 at-rule 块（@supports/@media/@keyframes），只留顶层规则——
 *  否则 `.dt-admin-btn` 会先抓到降级块里的 var(--tabbar-solid)，把好样本误判红。 */
function stripAtRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const s = css.indexOf('@', i);
    if (s < 0) { out += css.slice(i); break; }
    out += css.slice(i, s);
    const ob = css.indexOf('{', s);
    if (ob < 0) { out += css.slice(s); break; }
    let depth = 0;
    let j = ob;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') { depth -= 1; if (!depth) { j += 1; break; } }
    }
    i = j;
  }
  return out;
}

/** 取出 `@supports …` / `@media …` 之后第一个配对块内容 */
function atBlock(css, marker) {
  const i = css.indexOf(marker);
  if (i < 0) return null;
  const s = css.indexOf('{', i);
  if (s < 0) return null;
  let depth = 0;
  for (let j = s; j < css.length; j += 1) {
    if (css[j] === '{') depth += 1;
    else if (css[j] === '}') { depth -= 1; if (!depth) return css.slice(s + 1, j); }
  }
  return null;
}

/** 纯函数审计：吃 wxml / wxss 文本，吐问题列表（变异自证复用同一份判据） */
function audit(wxmlRaw, wxssRaw) {
  const wxml = stripXml(wxmlRaw);
  const wxss = stripCss(wxssRaw);
  const base = stripAtRules(wxss);   // 顶层规则（不含 at-rule 块），供 rule() 提取
  const out = [];

  /* ---- ① 玻璃材质 ---- */
  const track = rule(base, '.dt-view-tabs')[0] || '';
  if (!/var\(--tabbar-bg/.test(track)) out.push('.dt-view-tabs 底色未走 var(--tabbar-bg)');
  if (!/backdrop-filter\s*:/.test(track)) out.push('.dt-view-tabs 缺 backdrop-filter（不是玻璃）');
  if (!/var\(--tabbar-edge/.test(track)) out.push('.dt-view-tabs 缺亮边 var(--tabbar-edge)');

  const on = rule(base, '.dt-view-tab.on')[0] || '';
  if (!/var\(--tab-ind/.test(on)) out.push('选中胶囊未走 var(--tab-ind) 品牌 tint');
  if (!/var\(--brand/.test(on)) out.push('选中胶囊文字未走 var(--brand)');
  if (/background\s*:\s*var\(--brand\b/.test(on)) out.push('选中胶囊回退成实底蓝 var(--brand)（旧写法）');

  const btn = rule(base, '.dt-admin-btn')[0] || '';
  if (!/var\(--tabbar-bg/.test(btn)) out.push('.dt-admin-btn 底色未走 var(--tabbar-bg)');
  if (!/backdrop-filter\s*:/.test(btn)) out.push('.dt-admin-btn 缺 backdrop-filter');
  if (!/var\(--tabbar-edge/.test(btn)) out.push('.dt-admin-btn 缺亮边 var(--tabbar-edge)');

  ['ghost', 'danger', 'primary'].forEach((k) => {
    const b = rule(base, '.dt-admin-btn.' + k)[0] || '';
    if (/background\s*:\s*var\(--(?:bg-fill|brand|danger-bg)\b/.test(b)) {
      out.push('.dt-admin-btn.' + k + ' 仍是旧实底（应只改文字色，底交给玻璃基类）');
    }
  });
  const hist = rule(base, '.dt-hist')[0] || '';
  if (/background\s*:\s*var\(--bg-fill\b/.test(hist)) out.push('.dt-hist 仍是旧实底 var(--bg-fill)');

  const supports = atBlock(wxss, '@supports not') || '';
  const reducedT = atBlock(wxss, 'prefers-reduced-transparency') || '';
  ['.dt-view-tabs', '.dt-admin-btn'].forEach((sel) => {
    if (supports.indexOf(sel) < 0) out.push('@supports not 降级未覆盖 ' + sel);
    if (reducedT.indexOf(sel) < 0) out.push('prefers-reduced-transparency 降级未覆盖 ' + sel);
  });

  /* ---- ② 视图切换动画 ---- */
  const kf = atBlock(wxss, '@keyframes dtViewIn') || '';
  if (!/opacity\s*:\s*0\b/.test(kf) || !/opacity\s*:\s*1\b/.test(kf)) out.push('dtViewIn 缺 opacity 0→1');
  if (!/translateY\(\s*0?\.?\d+rpx\s*\)/.test(kf)) out.push('dtViewIn 缺 translateY 位移（要轻微上浮）');
  const vp = rule(base, '.dt-vp.vp-anim')[0] || rule(base, '.dt-vp')[0] || '';
  if (!/animation\s*:\s*dtViewIn/.test(vp)) out.push('.dt-vp 未挂 dtViewIn 动画');
  const dur = /animation\s*:\s*dtViewIn\s+([\d.]+)s/.exec(vp);
  if (!dur || Number(dur[1]) > 0.3) out.push('dtViewIn 时长缺失或 >300ms');
  if (!/cubic-bezier/.test(vp)) out.push('dtViewIn 用缓动曲线而非生硬 linear/default');
  const reducedM = atBlock(wxss, 'prefers-reduced-motion') || '';
  if (!/\.dt-vp[\s\S]{0,120}animation\s*:\s*none/.test(reducedM)) out.push('减弱动效下未关掉 .dt-vp 动画');

  // 两个分支都要包一层 .dt-vp（wx:if 切换时新节点插入 → 动画重播）
  const vpNodes = (wxml.match(/class="dt-vp \{\{viewAnim\}\}"/g) || []).length;
  if (vpNodes < 2) out.push('两个视图分支未各包一层 .dt-vp（实测 ' + vpNodes + ' 个）');
  if (!/wx:if="\{\{viewMode === 'duty'\}\}"/.test(wxml)) out.push('值日分支 wx:if 丢失');
  if (!/wx:else>/.test(wxml)) out.push('演讲分支 wx:else 丢失');

  /* ---- ④ 智能排班弹窗：内容左右留白 + 按钮玻璃化（中间按钮不许彩色渐变） ---- */
  /* 2026-11-17 用户口径：截图里「用一句话描述排班」几乎贴左边、按钮还是 .btn 自带的
     紫→蓝→粉渐变。现在要求：内容左右留白拉到 ≥24rpx，三个按钮统一底栏同款液态玻璃，
     中间「解析预览」只是玻璃 + 文字色，不得再叠任何 linear-gradient。
     ⚠️ `.sp-form` 是本页两个弹层共用的表单容器，留白改一处两边都对齐。 */
  const form = rule(base, '.sp-form')[0] || '';
  const pad = /padding\s*:\s*([\d.]+)rpx\s+([\d.]+)rpx/.exec(form);
  if (!pad) out.push('.sp-form 未声明 padding，弹窗内容会贴边');
  else if (Number(pad[2]) < 24) out.push('.sp-form 左右留白只有 ' + pad[2] + 'rpx（<24rpx，内容贴边）');

  if (wxml.indexOf('class="f-actions sp-ai-actions"') < 0) {
    out.push('智能排班操作条缺 sp-ai-actions（玻璃样式落不上）');
  }
  const aiBtn = rule(base, '.sp-ai-actions .btn')[0] || '';
  if (!/var\(--tabbar-bg/.test(aiBtn)) out.push('.sp-ai-actions .btn 底色未走 var(--tabbar-bg)');
  if (!/backdrop-filter\s*:/.test(aiBtn)) out.push('.sp-ai-actions .btn 缺 backdrop-filter（不是玻璃）');
  if (!/var\(--tabbar-edge/.test(aiBtn)) out.push('.sp-ai-actions .btn 缺亮边 var(--tabbar-edge)');
  const aiPrimary = rule(base, '.sp-ai-actions .btn.f-save')[0] || '';
  if (!/var\(--brand/.test(aiPrimary)) out.push('确认排班未用 var(--brand) 文字色区分主操作');
  /* 整段 `.sp-ai-actions` 作用域里不许出现渐变 —— 中间按钮原来的彩色渐变就来自
     `.btn` 的 linear-gradient，覆盖时没写死底就会被它透上来。 */
  const aiScope = (base.match(/\.sp-ai-actions[^{}]*\{[^{}]*\}/g) || []).join(' ');
  if (/linear-gradient/.test(aiScope)) out.push('智能排班按钮仍叠彩色渐变（应纯玻璃）');
  const aiFallback = (atBlock(wxss, '@supports not') || '') + (atBlock(wxss, 'prefers-reduced-transparency') || '');
  if (aiFallback.indexOf('.sp-ai-actions') < 0) out.push('弹窗按钮缺两条降级路径（不支持模糊 / 降低透明度）');

  /* ---- ③ 点击反馈 ---- */
  const tabLines = wxml.split('\n').filter((l) => /class="dt-view-tab(?: |\{\{)/.test(l));
  if (tabLines.length < 2) out.push('分段控件标签不足 2 个');
  tabLines.forEach((l) => {
    if (l.indexOf('data-pressable') < 0) out.push('分段标签缺 data-pressable：' + l.trim().slice(0, 60));
    if (l.indexOf('hover-class="press-dim"') < 0) out.push('分段标签缺 hover-class="press-dim"：' + l.trim().slice(0, 60));
  });

  return out;
}

console.log('── ① 好样本：当前值日页源码');
const WXML = 'miniprogram/pages/duty/index.wxml';
const WXSS = 'miniprogram/pages/duty/index.wxss';
const good = audit(read(WXML), read(WXSS));
good.forEach((p) => bad(p));
if (!good.length) ok('玻璃按钮 + 视图切换动画 + 点击反馈判据全过');

console.log('\n── ② 变异自证：改回旧写法必须被抓');
const wxmlGood = read(WXML);
const wxssGood = read(WXSS);
function mutant(name, wxml, wxss, needle) {
  const changed = wxml !== wxmlGood || wxss !== wxssGood;
  if (!changed) { bad(name + '：变异没生效（别拿好样本当坏样本）'); return; }
  const problems = audit(wxml, wxss);
  chk(problems.some((p) => p.indexOf(needle) >= 0), name + ' → 被抓住');
}
mutant('变异1：轨道底色换回 --bg-fill', wxmlGood,
  wxssGood.replace(/(\.dt-view-tabs\s*\{[\s\S]{0,200}?)var\(--tabbar-bg/, '$1var(--bg-fill'),
  '.dt-view-tabs 底色未走 var(--tabbar-bg)');
mutant('变异2：选中胶囊换回实底蓝', wxmlGood,
  wxssGood.replace(/background:\s*var\(--tab-ind,[^;]*;/, 'background: var(--brand);'),
  '选中胶囊回退成实底蓝');
mutant('变异3：删掉 dtViewIn 动画', wxmlGood,
  wxssGood.replace(/animation\s*:\s*dtViewIn[^;]*;/, ''),
  '.dt-vp 未挂 dtViewIn 动画');
mutant('变异4：删掉分段标签的 hover-class', wxmlGood.replace(/ hover-class="press-dim"/g, ''), wxssGood,
  '分段标签缺 hover-class');
mutant('变异5：删掉操作按钮的 backdrop-filter', wxmlGood,
  (() => {
    const i = wxssGood.indexOf('/* 玻璃按钮（2026-11-17）');
    const s = wxssGood.slice(0, i);
    const tail = wxssGood.slice(i).replace(/-?webkit-?backdrop-filter\s*:[^;]*;/g, '').replace(/backdrop-filter\s*:[^;]*;/, '');
    return s + tail;
  })(),
  '.dt-admin-btn 缺 backdrop-filter');
mutant('变异6：@supports 降级漏掉按钮', wxmlGood,
  wxssGood.replace(/(\.dt-admin-btn\s*\{[^}]*var\(--tabbar-solid[^}]*\})/, ''),
  '@supports not 降级未覆盖 .dt-admin-btn');
mutant('变异7：弹窗内容留白退回 8rpx', wxmlGood,
  wxssGood.replace(/\.sp-form\s*\{[^}]*\}/, '.sp-form { padding: 8rpx 8rpx 20rpx; }'),
  '.sp-form 左右留白只有');
mutant('变异8：删掉弹窗按钮的 backdrop-filter', wxmlGood,
  (() => {
    /* ⚠️ 必须 lastIndexOf：文件顶部 `@supports not` 降级块里也有 `.sp-ai-actions .btn {`，
       用 indexOf 会改到降级块（那一段本来就被 stripAtRules 剥掉）→ 变异不生效、假通过。 */
    const i = wxssGood.lastIndexOf('.sp-ai-actions .btn {');
    if (i < 0) return wxssGood;
    const s = wxssGood.slice(0, i);
    const tail = wxssGood.slice(i).replace(/-?webkit-?backdrop-filter\s*:[^;]*;\s*/g, '').replace(/backdrop-filter\s*:[^;]*;\s*/, '');
    return s + tail;
  })(),
  '.sp-ai-actions .btn 缺 backdrop-filter');
mutant('变异9：弹窗按钮叠回彩色渐变', wxmlGood,
  (() => {
    const i = wxssGood.lastIndexOf('.sp-ai-actions .btn {');
    if (i < 0) return wxssGood;
    const at = wxssGood.indexOf('{', i) + 1;
    return wxssGood.slice(0, at) + '\n  background: linear-gradient(135deg, #7C5CFF 0%, #3370FF 100%);'
      + wxssGood.slice(at);
  })(),
  '仍叠彩色渐变');
mutant('变异10：弹窗操作条丢掉 sp-ai-actions 类',
  wxmlGood.replace('class="f-actions sp-ai-actions"', 'class="f-actions"'), wxssGood,
  '缺 sp-ai-actions');

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 值日页玻璃按钮与视图动画体检全部通过'));
process.exit(failed ? 1 : 0);
