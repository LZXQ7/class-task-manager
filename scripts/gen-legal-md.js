/**
 * 从 miniprogram/data/legal.js 生成可读的 Markdown 版《用户协议》《隐私政策》。
 *
 * 为什么要有这个脚本：正文只允许存在一份（data/legal.js，小程序实际渲染的那份）。
 * 手工再维护一份 Markdown 一定会漂移，所以这里用生成代替手抄。
 *
 *   node scripts/gen-legal-md.js
 *   → docs/用户协议与隐私政策.md
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'miniprogram', 'data', 'legal.js');
const OUT = path.join(ROOT, 'docs', '用户协议与隐私政策.md');

const legal = require(SRC);

function renderDoc(doc) {
  const L = [];
  L.push('## ' + doc.title);
  L.push('');
  L.push('**' + doc.name + '** · 版本 ' + doc.version + ' · 更新日期 ' + doc.updated);
  L.push('');
  (doc.intro || []).forEach(t => { L.push(t); L.push(''); });
  doc.sections.forEach(s => {
    L.push('### ' + s.title);
    L.push('');
    (s.paras || []).forEach(t => { L.push(t); L.push(''); });
    if (s.items && s.items.length) {
      s.items.forEach(t => { L.push('- ' + t); });
      L.push('');
    }
  });
  return L.join('\n');
}

const head = [
  '# 用户协议与隐私政策',
  '',
  '> 本文件由 `scripts/gen-legal-md.js` 从 `miniprogram/data/legal.js` 生成，**请勿手工编辑** —— 改正文请改',
  '> `data/legal.js`（小程序内实际渲染的那份），然后重新运行：`node scripts/gen-legal-md.js`。',
  '>',
  '> 小程序内展示：`pages/doc/index?type=agreement|privacy`，入口 = 我的 →「关于」→ 对应条目。',
  '',
  '---',
  ''
].join('\n');

const md = [
  head,
  renderDoc(legal.USER_AGREEMENT),
  '---',
  '',
  renderDoc(legal.PRIVACY_POLICY)
].join('\n');

fs.writeFileSync(OUT, md, 'utf8');

const stats = [legal.USER_AGREEMENT, legal.PRIVACY_POLICY].map(d => {
  const n = d.intro.join('').length + d.sections.reduce((a, s) =>
    a + s.title.length + (s.paras || []).join('').length + (s.items || []).join('').length, 0);
  return d.title + ' ' + d.sections.length + ' 章 / ' + n + ' 字';
}).join(' · ');

console.log('已生成 ' + path.relative(ROOT, OUT) + '（' + stats + '）');
