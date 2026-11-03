#!/usr/bin/env node
/**
 * 离线调查：页面 / 组件 wxss 里写死的浅色裸 hex（深色模式「白岛」根因）。
 * 只统计、绝不写盘。输出：每个属性维度下，裸 hex 的出现次数与所在文件清单。
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(process.cwd());
const MINI = path.join(ROOT, 'miniprogram');
const TARGETS = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.wxss')) {
      const rel = path.relative(MINI, p).replace(/\\/g, '/');
      if (rel === 'app.wxss') continue; // 令牌源，不动
      TARGETS.push(rel);
    }
  }
}
walk(path.join(MINI, 'pages'));
walk(path.join(MINI, 'components'));
walk(path.join(MINI, 'custom-tab-bar'));

const PROPS = ['background', 'background-color', 'color', 'border-color', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right'];
// 只匹配「属性值恰好是一个裸 hex」（排除渐变 / rgba / transparent / var / url / none / 多值）
const HEX = /#([0-9a-fA-F]{3,8})\b/g;

const tally = {}; // prop -> hex(小写) -> {count, files:Set}
for (const prop of PROPS) tally[prop] = {};

for (const rel of TARGETS) {
  const full = path.join(MINI, rel);
  const raw = fs.readFileSync(full, 'utf8');
  // 剥 /* */ 与 <!-- --> 注释，避免注释里的字面量干扰
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  // 逐行找 `prop:` 声明
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const prop of PROPS) {
      // 匹配 "background: #fff;" 形式（属性名独立成词）
      const re = new RegExp('(^|[^\\w-])' + prop.replace('-', '\\-') + '\\s*:\\s*([^;{}]+)\\s*;', 'g');
      let m;
      while ((m = re.exec(line))) {
        const val = m[2].trim();
        // 只处理「纯 hex」（可能带 !important，去掉）
        const clean = val.replace(/\s*!important\s*$/i, '').trim();
        if (!/^#[0-9a-fA-F]{3,8}$/i.test(clean)) continue;
        const hex = clean.toLowerCase();
        const slot = tally[prop];
        if (!slot[hex]) slot[hex] = { count: 0, files: new Set() };
        slot[hex].count += 1;
        slot[hex].files.add(rel);
      }
    }
  }
}

const fileCount = (set) => set.size;
console.log('扫了 ' + TARGETS.length + ' 个 wxss 文件（不含 app.wxss）\n');
for (const prop of PROPS) {
  const slot = tally[prop];
  const hexes = Object.keys(slot).sort((a, b) => slot[b].count - slot[a].count);
  if (!hexes.length) continue;
  console.log('── ' + prop + ' ──');
  for (const h of hexes) {
    const info = slot[h];
    console.log('  ' + h + '  ×' + info.count + '  出现在 ' + fileCount(info.files) + ' 个文件');
  }
  console.log('');
}
