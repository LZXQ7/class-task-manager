#!/usr/bin/env node
/**
 * scripts/_add-pressable.js —— 给**所有可点元素**统一挂上按压反馈标记（一次性工具）
 * ============================================================
 * 需求（2026-11-14 用户原话）：「所有按钮都要有按钮回弹……这些只要能点击打开或
 *   弹出新页面新抽屉的都算按钮啊」。
 *
 * 🔴 设计约束（都是踩出来的）：
 *  ① **绝不改现有 class 字符串** —— 本仓库的门禁大量用**精确正则**匹配 class /
 *     hover-class（如 check-perf 的 `class="mn-row"\s+hover-class="tap-hover"`、
 *     check-committee 的「职位项模板带 locked 类」、check-leave-delete 的
 *     「删除按钮用独立的 lv-del 类」）。一改就把它们全打红。
 *     ⇒ 基态标记用**追加属性** `data-pressable`（WXML 的 data-* 会落到 DOM，
 *       CSS 用属性选择器 `[data-pressable]` 命中），不碰 class。
 *  ② **追加一律放在属性列表末尾** —— 上面那些正则靠 `class="X" hover-class="Y"`
 *     **相邻**匹配，中间插属性就会断链。
 *  ③ 已有 hover-class 的元素**不动它**（tap-hover / press-dim / tab-item-hover…），
 *     它们的按压缩放统一在 app.wxss 里给这些 hover 类补规则；
 *     只有**本来就没有 hover-class** 的元素，才新增 `press-shrink`。
 *  ④ **必须处理自闭合标签** `<button ... />`：不能把结尾的 `/` 拆开，
 *     否则按钮不再是空壳（真机空框事故，见 check-tap-layer-zindex）。
 *  ⑤ 事件绑定有 `bindtap` 和 `bind:tap` 两种写法，都要认。
 *
 * 用法：node scripts/_add-pressable.js            # 改写
 *      node scripts/_add-pressable.js --dry      # 只报告不改
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const DRY = process.argv.indexOf('--dry') >= 0;

/* 原生控件自带按压反馈，且部分控件不接受 transform 缩放 ⇒ 跳过 */
const SKIP_TAGS = new Set([
  'textarea', 'input', 'picker', 'editor', 'slider', 'switch', 'radio', 'checkbox',
  'form', 'label', 'video', 'canvas', 'map', 'camera', 'live-player', 'live-pusher',
  'block', 'wxs', 'import', 'include', 'template', 'slot',
  'button'   /* ⑦ 原生按钮 / 留空点击层：自带按压反馈，缩放会破坏布局 */
]);

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

/**
 * 属性感知的标签扫描器：属性的值可能含 `>`（例如 wx:if="{{a > b}}"），
 * 所以必须跳过引号内的内容。
 */
function scanTags(src) {
  const tags = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const tag = m[1];
    let i = m.index + m[0].length;
    let quote = null;
    while (i < src.length) {
      const c = src[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      i++;
    }
    tags.push({ start: m.index, end: i, tag, attrs: src.slice(m.index + m[0].length, i) });
    re.lastIndex = i;
  }
  return tags;
}

function getAttr(attrs, name) {
  const re = new RegExp('(^|\\s)' + name + '\\s*=\\s*"([^"]*)"');
  const mm = attrs.match(re);
  return mm ? mm[2] : null;
}
function hasAttr(attrs, name) {
  return new RegExp('(^|\\s)' + name + '(\\s|=|$)').test(attrs);
}

const stats = { scanned: 0, touched: 0, already: 0, dynamicHover: 0, skipTag: 0, selfClosed: 0 };
const hoverInventory = new Map();   // hover 类 → 出现次数
const dynList = [];

for (const file of walk(ROOT, [])) {
  const src = fs.readFileSync(file, 'utf8');
  const tags = scanTags(src);
  const edits = [];
  for (const t of tags) {
    if (SKIP_TAGS.has(t.tag)) { stats.skipTag++; continue; }
    const a = t.attrs;
    /* ⑤ 两种事件写法都认：bindtap / catchtap / bind:tap / catch:tap */
    if (!/(^|\s)(bindtap|catchtap|bind:tap|catch:tap)\s*=/.test(a)) continue;
    stats.scanned++;

    let attrs = a;
    /* ④ 自闭合标签：把结尾的 `/` 摘出来，最后再放回去 */
    let selfClose = false;
    const trimmed = attrs.replace(/\s+$/, '');
    if (trimmed.endsWith('/')) { selfClose = true; attrs = trimmed.slice(0, -1); stats.selfClosed++; }

    if (hasAttr(attrs, 'data-pressable')) { stats.already++; continue; }

    const hc = getAttr(attrs, 'hover-class');
    if (hc) {
      const key = hc.indexOf('{{') >= 0 ? '（动态）' : hc;
      hoverInventory.set(key, (hoverInventory.get(key) || 0) + 1);
    }

    let add = '';
    if (hc && hc.indexOf('{{') >= 0) {
      /* 动态 hover-class：不能安全拼接 ⇒ 标记为需人工处理（只加 data-pressable） */
      stats.dynamicHover++;
      dynList.push(path.relative(ROOT, file) + ' :: ' + a.replace(/\s+/g, ' ').slice(0, 110));
    } else if (!hc) {
      /* ③ 本来没有 hover-class 的，才新增 press-shrink */
      add += ' hover-class="press-shrink" hover-start-time="0" hover-stay-time="60"';
    }
    /* ① 基态标记：追加属性，不碰 class */
    add += ' data-pressable';

    /* ⑥ 追加的属性插在**最前面**（见文件头说明 ⑥） */
    edits.push({ start: t.start, end: t.end, text: '<' + t.tag + add + attrs + (selfClose ? ' />' : '>') });
    stats.touched++;
  }
  if (edits.length && !DRY) {
    let out = src;
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      /* ⚠️ e.end 是 '>' **所在下标**（含）⇒ 切片必须 +1 跳过它，否则会多留一个 '>'。 */
      out = out.slice(0, e.start) + e.text + out.slice(e.end + 1);
    }
    fs.writeFileSync(file, out);
  }
}

console.log('可点元素命中：' + stats.scanned);
console.log('已处理：' + stats.touched + (DRY ? '（dry-run，未落盘）' : ''));
console.log('已带 data-pressable：' + stats.already);
console.log('动态 hover-class（需人工处理）：' + stats.dynamicHover);
console.log('原生控件/非元素（跳过）：' + stats.skipTag + '；其中自闭合标签：' + stats.selfClosed);
console.log('\n-- 现有 hover-class 清单（app.wxss 里要逐个补按压缩放）--');
Array.from(hoverInventory.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k + '  ×' + v));
if (dynList.length) {
  console.log('\n-- 动态 hover-class 明细 --');
  dynList.forEach((d) => console.log('  ' + d));
}
