#!/usr/bin/env node
/**
 * 导航胶囊避让审计（可复跑门禁）
 * ---------------------------------------------------------------------------
 * 小程序 `navigationStyle: "custom"` 之后，右上角胶囊仍由微信绘制，开发者拿不到它、
 * 也压不住它。凡是把按钮塞进导航栏右侧的页面，都存在「按钮钻进胶囊底下」的风险 ——
 * 风险大小随机型（胶囊 left 不同）和标题长度变化，**必须在多种机型上分别算**，
 * 不能只看自己那台。
 *
 * 本脚本不做截图，只做**几何判决**：把 nav-bar 的布局规则（88rpx 行高、190rpx 标题
 * 内缩、120rpx 侧栏最小宽、padRight 胶囊避让）按真实 CSS 换算成 px，再对每个机型
 * 逐条比较，算出：
 *   ① 右插槽内容是否越界压到胶囊（横向）
 *   ② 标题文字右沿是否被右插槽覆盖（横向）
 *   ③ 导航行是否矮于胶囊（纵向：胶囊会探出导航行下沿）
 *
 * 判据直接来自源码，所以**改了 nav-bar 的常量后本脚本会自动跟着变**（见 NAV 常量表）。
 * 若某个数字被写死在 wxss 里而这里没同步，属于脚本自身失真 —— 发现即在下面 NAV 表更正。
 *
 * 用法：node scripts/check-nav-capsule.js [--json]
 * 退出码：0 全部通过；1 存在冲突（门禁判红）。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

/* ---------------- nav-bar 的布局常量（必须与组件源码一致） ----------------
 * ⚠️ 这些是**缺省值**：main() 会用 nav-bar/index.wxss 的实测值覆盖 sideMinRpx /
 *    titlePadRpx。否则改了 wxss、脚本还按老常量算 ⇒ 判决与真机脱节，
 *    变异自证会变成「拿好样本当坏样本」（本项目踩过这个坑，见 MEMORY 铁律）。
 */
const NAV = {
  bodyHRpx: 88,        // .nav-body 行高
  titlePadRpx: 190,    // .nav-title 左右内缩
  sideMinRpx: 96,      // .nav-side 最小宽（2026-11-14 由 120 收窄，见 nav-bar/index.wxss）
  titleFontRpx: 34,    // .nav-title 字号
  capsuleGapPx: 2,     // padRight 视觉间隙
  capsuleVPadPx: 12,   // 导航行内胶囊上下留白（nav-bar 的 bodyHpx 推导同源）
  padFallbackPx: 99    // 取不到胶囊时的保守避让（app.js navMetrics）
};

/* ---------------- 真实机型胶囊度量（wx.getMenuButtonBoundingClientRect 实测值） ----------------
 * left/right/top/bottom 单位 px。安卓胶囊比 iOS 更宽、更靠内，是压力最大的档。
 */
const DEVICES = [
  { name: 'iPhone SE1 320',   w: 320, h: 568, sb: 20, cap: { left: 223, right: 310, top: 24, bottom: 56 } },
  { name: 'iPhone SE2 375',   w: 375, h: 667, sb: 20, cap: { left: 278, right: 365, top: 26, bottom: 58 } },
  { name: 'iPhone 13 375',    w: 375, h: 812, sb: 44, cap: { left: 278, right: 365, top: 48, bottom: 80 } },
  { name: 'iPhone 15 Pro 393',w: 393, h: 852, sb: 54, cap: { left: 296, right: 383, top: 58, bottom: 90 } },
  { name: 'iPhone ProMax 430',w: 430, h: 932, sb: 59, cap: { left: 333, right: 420, top: 63, bottom: 95 } },
  { name: 'Android 360',      w: 360, h: 780, sb: 24, cap: { left: 264, right: 357, top: 28, bottom: 60 } },
  { name: 'Android 393',      w: 393, h: 851, sb: 32, cap: { left: 293, right: 386, top: 36, bottom: 68 } },
  { name: 'Android 412',      w: 412, h: 915, sb: 28, cap: { left: 312, right: 405, top: 32, bottom: 64 } },
  { name: '折叠屏展开 690',   w: 690, h: 812, sb: 30, cap: { left: 593, right: 680, top: 34, bottom: 66 } },
  { name: 'iPad 768',         w: 768, h: 1024,sb: 24, cap: { left: 671, right: 758, top: 28, bottom: 60 } }
];

/* ---------------- 抓页面：标题 + 右插槽内容 ---------------- */
function listPages() {
  const out = [];
  const pagesDir = path.join(MINI, 'pages');
  for (const d of fs.readdirSync(pagesDir)) {
    const dir = path.join(pagesDir, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.wxml')) continue;
      out.push(path.join(dir, f));
    }
  }
  return out;
}

/** 从 <nav-bar ...> 里取 title / show-back；再取 slot="right" 内部纯文本 */
function parsePage(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const rel = path.relative(MINI, file).replace(/\\/g, '/');
  const bars = [];
  const re = /<nav-bar\b([\s\S]*?)(\/>|>([\s\S]*?)<\/nav-bar>)/g;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    const inner = m[3] || '';
    const tm = /title="([^"]*)"/.exec(attrs);
    const raw = tm ? tm[1] : '';
    // 纯静态标题才算（含 {{}} 的是动态：取最长的静态分支做最坏估计）
    let title = raw;
    if (/\{\{/.test(raw)) {
      const branches = raw.match(/[^{}|]+/g) || [];
      title = branches.map(s => s.trim()).filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || '';
    }
    // 右插槽里的文本（丢掉标签，只留字）
    // ⚠️ 必须从 `slot="right"` 所在元素的 **开标签之后** 开始截，否则属性文本
    //    （`slot="right" class="tt-nav-right"`）会被当成正文词，插槽宽度被算成 300+px。
    let rightText = '';
    if (inner.indexOf('slot="right"') >= 0) {
      const seg = inner.slice(inner.indexOf('slot="right"'));
      const body = seg.slice(seg.indexOf('>') + 1);
      const end = body.search(/<\/(?:view|text)>/);
      const clip = end >= 0 ? body.slice(0, end) : body;
      // {{三元}} 取最长静态分支（最坏宽度），其余表达式按 2 字估
      const txt = clip.replace(/\{\{([^}]*)\}\}/g, (_, e) => {
        const br = (e.match(/'[^']*'|"[^"]*"/g) || []).map(s => s.slice(1, -1))
          .sort((a, b) => b.length - a.length);
        return br.length ? br[0] : '文字';
      });
      const words = txt.replace(/<[^>]*>/g, ' ').match(/[\u4e00-\u9fa5A-Za-z0-9]+/g) || [];
      rightText = words.join('');
    }
    const hasRight = /slot="right"/.test(inner);
    bars.push({ title, rightText: hasRight ? rightText : '', hasRight });
  }
  return { rel, bars };
}

/* ---------------- 几何判决 ---------------- */
const rpx = (v, w) => v * w / 750;

function judge(dev, page) {
  const { w, sb, cap } = dev;
  // nav-bar 的 padRight：右插槽内容整体左移出胶囊区
  const padRight = Math.round(w - cap.left) + NAV.capsuleGapPx;
  const capH = cap.bottom - cap.top;
  // nav-bar 的 bodyHpx 规则：88rpx 与「胶囊高 + 上下各 6px」取大者
  const bodyH = Math.max(rpx(NAV.bodyHRpx, w), capH + NAV.capsuleVPadPx);
  const sideMin = rpx(NAV.sideMinRpx, w);
  const titlePad = rpx(NAV.titlePadRpx, w);

  const res = { vertGap: bodyH - (cap.bottom - sb) };

  if (!page.hasRight) {
    res.slotLeft = null; res.overlapPx = 0; res.capHit = 0;
    return res;
  }

  // 插槽内容宽：状态文字 26rpx / 按钮文字 30rpx + 左右 32rpx padding
  const chars = Array.from(page.rightText).length || 1;
  const fontRpx = 30;
  const contentW = Math.max(sideMin, chars * rpx(fontRpx, w) + rpx(32, w));
  const contentRight = w - padRight;
  const slotLeft = contentRight - contentW;

  // ① 胶囊左沿 = cap.left；插槽内容右边界不得越过它
  const capHit = Math.max(0, contentRight - cap.left);
  // ② 标题文字右沿（居中）
  const titleW = Array.from(page.title).length * rpx(NAV.titleFontRpx, w);
  const titleRight = w / 2 + titleW / 2;
  const overlapPx = Math.max(0, titleRight - slotLeft);

  return Object.assign(res, { slotLeft, contentRight, contentW, titleRight, overlapPx, capHit });
}

function main() {
  const asJson = process.argv.includes('--json');

  /* ---------------- 源码契约（防止「几何算过了但代码改回去了」） ---------------- */
  const navJs = fs.readFileSync(path.join(MINI, 'components/nav-bar/index.js'), 'utf8');
  const navXml = fs.readFileSync(path.join(MINI, 'components/nav-bar/index.wxml'), 'utf8');
  const navWxss = fs.readFileSync(path.join(MINI, 'components/nav-bar/index.wxss'), 'utf8');
  const appJs = fs.readFileSync(path.join(MINI, 'app.js'), 'utf8');

  const contract = [];
  const ck = (name, cond, hint) => contract.push({ name, ok: !!cond, hint });

  ck('nav-bar 按胶囊高度推导导航行高', /capH\s*\+\s*12/.test(navJs) && /bodyHpx/.test(navJs),
    'nav-body 应取 max(88rpx, 胶囊高 + 12px)');
  ck('nav-bar 的 wxml 真的用了 bodyHpx', /bodyHpx\s*\?\s*bodyHpx\s*\+\s*'px'/.test(navXml),
    'wxml 的 height 仍需回落 88rpx，否则大屏会被 px 固化');
  ck('占位块高度与导航行同步', /nav-placeholder[\s\S]{0,200}bodyHpx/.test(navXml),
    '占位块不同步 → 正文被顶错高度');
  ck('.nav-side 最小宽为 ' + NAV.sideMinRpx + 'rpx', new RegExp('min-width:\\s*' + NAV.sideMinRpx + 'rpx').test(navWxss),
    '收窄侧栏是为了给居中标题让位');
  ck('取不到胶囊时 padRight 有兜底（不给 0）', new RegExp('padRight\\s*=\\s*' + NAV.padFallbackPx).test(appJs),
    '0 的语义是「不避让」，会让右插槽直接钻进胶囊');
  ck('兜底值不进缓存（真值仍会重试）', /if\s*\(!valid\)\s*padRight\s*=/.test(appJs) && /if\s*\(valid\)\s*g\._navMetrics\s*=/.test(appJs),
    '把估算值缓存下来会把错误位置锁死一整个生命周期');

  const contractBad = contract.filter(c => !c.ok);

  /* 用 wxss 实测值覆盖缺省常量：改了源码，几何判决立刻跟着变（不让脚本自带一份过时假设） */
  const sideMinM = /\.nav-side\s*\{[^}]*?min-width:\s*([\d.]+)rpx/.exec(navWxss);
  if (sideMinM) NAV.sideMinRpx = parseFloat(sideMinM[1]);
  const titlePadM = /\.nav-title\s*\{[^}]*?padding:\s*0\s+([\d.]+)rpx/.exec(navWxss);
  if (titlePadM) NAV.titlePadRpx = parseFloat(titlePadM[1]);

  const pages = listPages().flatMap(f => parsePage(f).bars.map(b => Object.assign({ file: parsePage(f).rel }, b)));

  /* 右插槽白名单：新增一处必须在这里登记 —— 登记动作本身就是「算过几何」的确认 */
  const RIGHT_SLOT_ALLOW = {
    'pages/timetable/index.wxml': 1
  };
  const used = {};
  for (const p of pages) if (p.hasRight) used[p.file] = (used[p.file] || 0) + 1;
  const unlisted = Object.keys(used).filter(k => !RIGHT_SLOT_ALLOW[k]);
  const overQuota = Object.keys(RIGHT_SLOT_ALLOW).filter(k => (used[k] || 0) > RIGHT_SLOT_ALLOW[k]);

  const rows = [];
  let red = 0;
  for (const p of pages) {
    if (!/pages\//.test(p.file)) continue;
    for (const dev of DEVICES) {
      const r = judge(dev, p);
      const bad = (r.capHit > 0) || (r.overlapPx > 0) || (r.vertGap < 0);
      if (bad) red++;
      rows.push({ page: p.file, title: p.title, right: p.rightText, dev: dev.name, bad, ...r });
    }
  }

  if (asJson) {
    const bad = rows.filter(r => r.bad);
    console.log(JSON.stringify({ total: rows.length, red, contractBad, unlisted, overQuota, bad }, null, 2));
    return process.exit((red || contractBad.length || unlisted.length || overQuota.length) ? 1 : 0);
  }

  // 只打印「有右插槽的页面」和「纵向不适配的机型」，其余静默通过
  const withSlot = rows.filter(r => r.slotLeft !== null);
  if (!withSlot.length) {
    console.log('[nav-capsule] 无页面使用导航右插槽 —— 横向无冲突面');
  } else {
    console.log('[nav-capsule] 右插槽横向判决（负 = 安全余量，正 = 冲突 px）');
    console.log('页面'.padEnd(34) + '机型'.padEnd(18) + '标题'.padEnd(10) + '插槽左沿  标题右沿  胶囊压入  标题重叠');
    for (const r of withSlot) {
      const flag = r.bad ? ' ✗' : '';
      console.log(
        r.page.padEnd(34) + r.dev.padEnd(18) + (r.title || '-').padEnd(10) +
        String(Math.round(r.slotLeft)).padEnd(10) + String(Math.round(r.titleRight)).padEnd(10) +
        String(Math.round(r.capHit)).padEnd(10) + String(Math.round(r.overlapPx)) + flag
      );
    }
  }

  const vt = rows.filter(r => r.vertGap < 0);
  if (vt.length) {
    console.log('\n[nav-capsule] 纵向：导航行矮于胶囊');
    for (const r of vt) console.log('  ' + r.dev + ' 行高缺口=' + Math.round(r.vertGap) + 'px');
  }

  console.log('\n[nav-capsule] 源码契约');
  for (const c of contract) console.log('  ' + (c.ok ? 'OK  ' : 'FAIL') + ' ' + c.name + (c.ok ? '' : '  → ' + c.hint));

  if (unlisted.length) {
    console.log('\n[nav-capsule] ✗ 有页面新增了导航右插槽但未在白名单登记：');
    for (const k of unlisted) console.log('  ' + k + '（' + used[k] + ' 处）—— 先在 RIGHT_SLOT_ALLOW 登记并确认几何判决通过');
  }
  if (overQuota.length) {
    console.log('\n[nav-capsule] ✗ 右插槽数量超过登记值：' + overQuota.join(', '));
  }

  const bad2 = contractBad.length + unlisted.length + overQuota.length;
  console.log('\n[nav-capsule] ' + (red || bad2 ? '✗ ' + (red + bad2) + ' 项问题' : '✓ 全部机型通过')
    + '（共 ' + rows.length + ' 组判决）');
  process.exit((red || bad2) ? 1 : 0);
}

main();
