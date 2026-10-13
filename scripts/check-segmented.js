#!/usr/bin/env node
/**
 * 离线自检：segmented 组件的**事件契约**
 * ------------------------------------------------------------
 * 起因（2026-09-25 用户反馈）：
 *   「发布通知中点击指定成员没反应，并且再点击全体成员也没反应了。」
 *
 * 根因是**事件字段名对不上**：
 *   · components/segmented/index.js 里 `this.triggerEvent('change', { key })` → emit 的是 `key`；
 *   · 而 pages/home/index.js 的 `onNoticeScope` 读的是 `e.detail.value` → `String(undefined)` = `"undefined"`。
 * 于是 noticeScope 既不是 'ALL' 也不是 'PICK'：
 *   · 名单不展开（`wx:if="{{noticeScope === 'PICK'}}"` 不成立）；
 *   · segmented 自身的高亮也不动（`value === item.key` 永远不等，因为 value 是字符串 "undefined"）；
 *   · 再点「全体成员」同样落进 `String(e.detail.value)` → 还是 `"undefined"` → 看起来彻底点不动。
 * 这类 bug 编译、WXML 检查、WXSS 检查全都发现不了，只能靠「契约一致性」静态检查。
 *
 * 本脚本三查：
 *   ① segmented 组件只 emit `key`（payload 里不得出现 value）；
 *   ② 每个 `<segmented bind:change="X">` 的 X 在对应 page js 里必须读 `e.detail.key`、且**不得**读 `e.detail.value`；
 *   ③ 每个 `<segmented>` 必须挂了 bind:change（否则点了没反应，是死控件）。
 * 末尾带自证：故意造一个读 value 的 handler，必须被抓到。
 *
 * 用法：node scripts/check-segmented.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const COMP = path.join(MINI, 'components', 'segmented');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

function walk(dir, out, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, out, ext);
    } else if (e.name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* ---------------------------------------------------------------- */
/* ① 组件侧：change 事件只允许携带 key                                */
/* ---------------------------------------------------------------- */
console.log('--- ① segmented 组件的事件契约 ---');
const compJs = fs.readFileSync(path.join(COMP, 'index.js'), 'utf8');
const emits = [];
const emitRe = /triggerEvent\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g;
let m;
while ((m = emitRe.exec(compJs))) emits.push({ name: m[1], payload: m[2] });

if (!emits.length) {
  bad('segmented 组件里找不到任何 triggerEvent —— 组件被改坏了？');
} else {
  emits.forEach((e) => {
    const hasKey = /\bkey\b/.test(e.payload);
    const hasValue = /\bvalue\b/.test(e.payload);
    if (e.name === 'change' && hasKey && !hasValue) {
      ok(`emit '${e.name}' payload = {${e.payload.trim()}}（只有 key，符合契约）`);
    } else {
      bad(`emit '${e.name}' payload = {${e.payload.trim()}} —— change 事件必须只带 { key }`);
    }
  });
}
// 组件里若自己定义了 value 属性是**选中值**（正常），但 emit 里不能叫 value（上面已查）

/* ---------------------------------------------------------------- */
/* ② / ③ wxml 侧：每个 segmented 都要挂 bind:change，handler 必须读 key */
/* ---------------------------------------------------------------- */

/**
 * 剥掉 WXML 注释（2026-10-08 补）
 * 起因：roster 页在注释里写了一句「复用全站 `<segmented>`」，标签正则把它当成
 * 真标签扫进去 —— 一次报 4 个 FAIL（2 个「没有 bind:change」+ 2 个「handler 读不到 key」），
 * 全是误报。注释不是标签，扫之前必须先剥掉。
 * ⚠️ 只剥 `<!-- -->`，不动标签内部的字符串。
 */
function stripComments(src) {
  // ⚠️ 用「等长替换」而不是删除：把注释内容换成同样长度的空格（保留换行），
  //    这样标签的 **字符偏移不变**，`where` 里报的行号才和真实文件对得上。
  return String(src || '').replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** 抽出一个 <segmented .../> 或 <segmented ...> 标签的属性串（支持跨行） */
function findSegmentedTags(src) {
  const out = [];
  const re = /<segmented\b([\s\S]*?)\/?>/g;
  const clean = stripComments(src);
  let x;
  while ((x = re.exec(clean))) {
    const attrs = x[1];
    out.push({
      attrs,
      raw: x[0].replace(/\s+/g, ' ').slice(0, 120),
      line: src.slice(0, x.index).split(/\r?\n/).length
    });
  }
  return out;
}

/**
 * 从 page/component 的 js 里抽出一个方法体。
 * 用「大括号配平」而不是正则到行尾 —— 方法体可能很长、含嵌套。
 * 找不到返回 null。
 */
function extractMethodBody(src, name) {
  const re = new RegExp('(^|[^\\w$])' + name.replace(/[$]/g, '\\$&') + '\\s*[:(]');
  const hit = re.exec(src);
  if (!hit) return null;
  let i = src.indexOf('{', hit.index + hit[0].length - 1);
  if (i < 0) {
    // 箭头函数省略大括号：onX: (e) => this.setData(...)
    const end = src.indexOf('\n', hit.index);
    return src.slice(hit.index, end < 0 ? src.length : end);
  }
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  return src.slice(i);
}

const wxmls = walk(MINI, [], '.wxml');
const problemList = [];
let tagCount = 0;

for (const wxml of wxmls) {
  const src = fs.readFileSync(wxml, 'utf8');
  const tags = findSegmentedTags(src);
  if (!tags.length) continue;

  // 同目录下的同名 js / json
  const jsPath = wxml.replace(/\.wxml$/, '.js');
  const pageJs = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';

  for (const t of tags) {
    tagCount += 1;
    const where = rel(wxml) + ':' + t.line;
    const bindM = /bind:change\s*=\s*"([^"]+)"/.exec(t.attrs);
    if (!bindM) {
      problemList.push(`${where}  这个 <segmented> 没有绑 bind:change（点它不会有任何反应）`);
      bad(`${where} 缺 bind:change  →  ${t.raw}`);
      continue;
    }
    const handler = bindM[1].trim();
    const body = extractMethodBody(pageJs, handler);
    if (!body) {
      problemList.push(`${where}  bind:change="${handler}"，但在 ${rel(jsPath)} 里找不到这个方法`);
      bad(`${where} 找不到 handler ${handler}()`);
      continue;
    }
    const readsKey = /\.detail\.key\b/.test(body);
    const readsValue = /\.detail\.value\b/.test(body);
    if (readsKey && !readsValue) {
      ok(`${where}  bind:change="${handler}" → 读 e.detail.key ✔`);
    } else if (readsValue) {
      bad(
        `${where}  bind:change="${handler}" 读了 e.detail.value —— ` +
        `segmented emit 的是 { key }，会拿到字符串 "undefined"（就是「点了没反应」的根因）`
      );
      problemList.push(`${where}  ${handler}() 误读 e.detail.value`);
    } else {
      bad(`${where}  bind:change="${handler}" 里看不到 e.detail.key —— 确认一下它怎么取选中值`);
      problemList.push(`${where}  ${handler}() 未使用 e.detail.key`);
    }
  }
}

if (!tagCount) bad('全项目没有找到任何 <segmented> —— 检查正则是否失效');

/* ---------------------------------------------------------------- */
/* 自证：造一个「读 value」的样本，必须被抓到                          */
/* ---------------------------------------------------------------- */
console.log('\n--- 自证（故意写错必须报警） ---');
const badSample = `
Page({
  onBadScope(e) {
    const scope = String(e.detail.value);
    this.setData({ noticeScope: scope });
  }
});`;
const badBody = extractMethodBody(badSample, 'onBadScope');
if (!badBody) {
  bad('自证失败：extractMethodBody 抽不出方法体');
} else if (/\.detail\.value\b/.test(badBody) && !/\.detail\.key\b/.test(badBody)) {
  ok('自证：误读 e.detail.value 的 handler 会被抓到');
} else {
  bad('自证失败：误读 value 的样本没被判成问题');
}

const goodSample = `
Page({
  onGoodScope(e) {
    const key = String((e.detail && e.detail.key) || '');
  }
});`;
const goodBody = extractMethodBody(goodSample, 'onGoodScope');
if (goodBody && /\.detail\.key\b/.test(goodBody)) {
  ok('自证：读 e.detail.key 的 handler 判为正常');
} else {
  bad('自证失败：读 key 的样本没被识别');
}

/* ---------------------------------------------------------------- */
/* 自证②：注释里的 `<segmented>` 不得被当成真标签                      */
/* ---------------------------------------------------------------- */
const commentOnly = [
  '<!-- 复用全站 `<segmented>`（与值日页同款） -->',
  '<view class="x">hello</view>'
].join('\n');
if (findSegmentedTags(commentOnly).length === 0) {
  ok('自证：注释里提到的 segmented 不会被当成真标签');
} else {
  bad('自证失败：注释里的 <segmented> 仍被扫成标签（stripComments 没生效）');
}
const realTag = [
  '<!-- 说明：下面这个是真的 -->',
  '<segmented items="{{a}}" bind:change="onX" />'
].join('\n');
if (findSegmentedTags(realTag).length === 1) {
  ok('自证：真标签不受 comment stripping 影响（仍扫到 1 处）');
} else {
  bad('自证失败：真标签被误剥了，findSegmentedTags 扫不到它');
}

/* ---------------------------------------------------------------- */
console.log('');
console.log('检查 <segmented> 标签 ' + tagCount + ' 处');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过：');
  problemList.forEach((p) => console.log('   · ' + p));
  process.exit(1);
}
console.log('✅ 全部通过：segmented 的事件契约一致');
