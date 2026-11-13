#!/usr/bin/env node
/**
 * 生成「导航栏 × 胶囊」多机型对比图（改前 / 改后），供人工核对布局。
 * 只读几何、不改源码；输出 outputs/nav-capsule/preview.html，再用 Chrome 无头截图。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs', 'nav-capsule');
fs.mkdirSync(OUT, { recursive: true });

/* 与 scripts/check-nav-capsule.js 同一份机型表 */
const DEVICES = [
  { name: 'iPhone SE1 320', w: 320, sb: 20, cap: { left: 223, right: 310, top: 24, bottom: 56 } },
  { name: 'iPhone 13 375', w: 375, sb: 44, cap: { left: 278, right: 365, top: 48, bottom: 80 } },
  { name: 'Android 360', w: 360, sb: 24, cap: { left: 264, right: 357, top: 28, bottom: 60 } },
  { name: 'iPhone ProMax 430', w: 430, sb: 59, cap: { left: 333, right: 420, top: 63, bottom: 95 } }
];

const CASES = [
  { page: '手动排班页', title: '手动排班', right: '已发布', fontRpx: 26, padRpx: 32 },
  { page: '课表适配申请页', title: '课表适配申请', right: '刷新', fontRpx: 30, padRpx: 32 },
  { page: '课表页', title: '课表', right: '校历', fontRpx: 30, padRpx: 32 }
];

/* 改前 / 改后两套常量 */
const BEFORE = { sideMinRpx: 120, titlePadRpx: 190, capVPad: 0, hasRight: () => true };
const AFTER = { sideMinRpx: 96, titlePadRpx: 190, capVPad: 12, hasRight: (c) => c.page === '课表页' };

const rpx = (v, w) => v * w / 750;

function geo(dev, c, cfg) {
  const { w, sb, cap } = dev;
  const padRight = Math.round(w - cap.left) + 2;
  const capH = cap.bottom - cap.top;
  const base = Math.round(rpx(88, w));
  const bodyH = cfg.capVPad ? Math.max(base, capH + cfg.capVPad) : base;
  const titlePad = rpx(cfg.titlePadRpx, w);
  const hasRight = cfg.hasRight(c);
  const chars = Array.from(c.right).length;
  const contentW = Math.max(rpx(cfg.sideMinRpx, w), chars * rpx(c.fontRpx, w) + rpx(c.padRpx, w));
  const contentRight = w - padRight;
  const slotLeft = contentRight - contentW;
  const titleW = Array.from(c.title).length * rpx(34, w);
  const titleRight = w / 2 + titleW / 2;
  const overlap = hasRight ? Math.max(0, titleRight - slotLeft) : 0;
  return { padRight, bodyH, titlePad, hasRight, contentW, contentRight, slotLeft, overlap, titleW, capH };
}

function bar(dev, c, cfg, tag) {
  const g = geo(dev, c, cfg);
  const { w, sb, cap } = dev;
  const capTop = cap.top - sb;
  const rows = [];
  rows.push('<div class="bar" style="width:' + w + 'px">');
  rows.push('<div class="sb" style="height:' + sb + 'px"><span>' + tag + ' · ' + dev.name + ' ' + w + '×</span></div>');
  rows.push('<div class="nav" style="height:' + g.bodyH + 'px">');
  rows.push('<div class="back"></div>');
  rows.push('<div class="title" style="left:' + g.titlePad + 'px;right:' + g.titlePad + 'px;font-size:' + rpx(34, w) + 'px">' + c.title + '</div>');
  if (g.hasRight) {
    const bad = g.overlap > 0;
    rows.push('<div class="slot' + (bad ? ' bad' : '') + '" style="right:' + g.padRight + 'px;width:' + g.contentW + 'px;font-size:' + rpx(c.fontRpx, w) + 'px">' + c.right + '</div>');
    if (bad) rows.push('<div class="tag" style="right:' + (g.padRight + 4) + 'px">压住标题 ' + Math.round(g.overlap) + 'px</div>');
  }
  // 微信胶囊（系统绘制，我们压不住）
  rows.push('<div class="cap" style="right:' + (w - cap.right) + 'px;top:' + capTop + 'px;width:' + (cap.right - cap.left) + 'px;height:' + g.capH + 'px"></div>');
  rows.push('</div></div>');
  return rows.join('');
}

const sections = CASES.map((c) => {
  const lines = [];
  lines.push('<h2>' + c.page + '</h2>');
  lines.push('<div class="pair"><div class="col"><h3>改前</h3>' + DEVICES.map((d) => bar(d, c, BEFORE, '改前')).join('') + '</div>');
  lines.push('<div class="col"><h3>改后</h3>' + DEVICES.map((d) => bar(d, c, AFTER, '改后')).join('') + '</div></div>');
  return lines.join('');
}).join('');

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:28px 32px 40px; background:#0E1116; color:#E6EAF2;
         font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:#8C93A3; margin-bottom:24px; font-size:12px; }
  h2 { font-size:14px; margin:26px 0 10px; color:#9FB4D8; font-weight:600; }
  h3 { font-size:12px; margin:0 0 8px; color:#7A8296; font-weight:500; }
  .pair { display:flex; gap:28px; align-items:flex-start; flex-wrap:wrap; }
  .col { }
  .bar { margin:0 0 10px; border-radius:10px; overflow:hidden; background:#171B22;
         border:1px solid #232832; }
  .sb { display:flex; align-items:center; padding-left:10px; color:#5E6678; font-size:10px;
        background:#12151B; }
  .nav { position:relative; background:rgba(255,255,255,0.055); }
  .back { position:absolute; left:16px; top:50%; width:22px; height:22px; margin-top:-11px;
          border-radius:11px; background:rgba(255,255,255,0.10); }
  .title { position:absolute; top:0; bottom:0; display:flex; align-items:center;
           justify-content:center; font-weight:600; color:#F2F5FA; }
  .slot { position:absolute; top:0; bottom:0; display:flex; align-items:center;
          justify-content:flex-end; color:#7FB0FF; white-space:nowrap; }
  .slot.bad { outline:2px solid #FF5A5F; outline-offset:-2px; border-radius:6px;
              background:rgba(255,90,95,0.16); }
  .cap { position:absolute; border-radius:16px; background:rgba(255,255,255,0.16);
         border:1px solid rgba(255,255,255,0.35); box-sizing:border-box; }
  .cap::after { content:"⋯ ⊙"; position:absolute; inset:0; display:flex; align-items:center;
                justify-content:center; font-size:11px; color:#DCE3F0; letter-spacing:2px; }
  .tag { position:absolute; top:-9px; font-size:9px; color:#FF8A8D; background:#0E1116;
         padding:0 4px; }
  .legend { margin-top:22px; font-size:11px; color:#7A8296; }
  .legend b { color:#B6C0D4; font-weight:600; }
</style></head><body>
<h1>导航栏 × 微信胶囊 · 多机型对照</h1>
<div class="sub">灰圆角块 = 系统胶囊（开发者压不住，只能避让）；蓝字 = 页面自定义右插槽；红框 = 与标题发生重叠</div>
${sections}
<div class="legend">
  <b>改前</b>：侧栏最小宽 120rpx、导航行恒为 88rpx、避让失败时 padRight 回落 0。<br>
  <b>改后</b>：侧栏 96rpx、导航行取 max(88rpx, 胶囊高+12px)、避让恒有兜底；手动排班/课表适配申请两页的右上元素已下移到页内。
</div>
</body></html>`;

fs.writeFileSync(path.join(OUT, 'preview.html'), html, 'utf8');
console.log('written ' + path.join(OUT, 'preview.html'));
