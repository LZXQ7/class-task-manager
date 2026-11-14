#!/usr/bin/env node
/**
 * scripts/_collect-press-hosts.js —— 抽取「按压反馈宿主类」清单（一次性工具）
 *
 * 目的：#6 按钮按压要改成小程序原生 hover-class 机制（.tap-hover / .press-dim），
 *   但释放时的「超调回弹」过渡必须挂在**基态**元素上，而基态类名分散在各页 wxml。
 *   这个脚本把「哪些元素的 class 里带了 hover-class」精确抽出来，生成 CSS 选择器清单。
 *
 * 用法：node scripts/_collect-press-hosts.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'miniprogram');
const HOVERS = ['tap-hover', 'press-dim'];

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.wxml')) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []);
const hosts = new Map();   // class -> Set(file)
const noHover = [];

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  // 逐个标签（含跨行）：<view ... > / <text ...>
  const tagRe = /<(view|text|image|button|scroll-view|navigator)\b([\s\S]*?)>/g;
  let m;
  while ((m = tagRe.exec(text))) {
    const attrs = m[2];
    const hc = HOVERS.find((h) => attrs.indexOf('hover-class="' + h + '"') >= 0);
    const cm = attrs.match(/\bclass="([^"]*)"/);
    const base = cm ? cm[1] : '';
    // 去掉插值 {{...}}，只留静态类名
    const statics = base
      .replace(/\{\{[\s\S]*?\}\}/g, ' ')
      .split(/\s+/)
      .filter((s) => s && s.indexOf('{') < 0);
    if (!hc) {
      // 记一下「可点但没有 hover-class」的候选（只统计带 bindtap 的）
      if (/bindtap|catchtap/.test(attrs) && statics.length) {
        noHover.push({ file: path.relative(ROOT, f), cls: statics.join(' ') });
      }
      continue;
    }
    for (const s of statics) {
      if (!hosts.has(s)) hosts.set(s, new Set());
      hosts.get(s).add(path.relative(ROOT, f));
    }
  }
}

const list = Array.from(hosts.keys()).sort();
console.log('== 按压反馈宿主静态类名（' + list.length + ' 个） ==');
console.log(list.join(', '));
console.log('');
console.log('== 各类出现的文件 ==');
for (const k of list) {
  console.log('  .' + k + '  →  ' + Array.from(hosts.get(k)).join(' | '));
}
console.log('');
console.log('== 带 bindtap 但无 hover-class 的元素（' + noHover.length + ' 处，供后续补 hover-class） ==');
for (const n of noHover) console.log('  ' + n.file + '  .' + n.cls);
