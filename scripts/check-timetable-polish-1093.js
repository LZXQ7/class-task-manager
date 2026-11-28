#!/usr/bin/env node
/**
 * 门禁：1.0.8.93 真机三处 UI 症状回放
 * ============================================================
 * 锁住用户 2026-11-28 第四批截图里的三个具体症状：
 *   ① 长按课程后的「调整课程」四项显示不全，且要能拖到 30% / 50% / 顶部三档弹性吸附；
 *   ② 左下角弧形菜单的「临时调课」被悬浮 tabBar 压住；
 *   ③ 右下角加号不在圆形中心。
 *
 * ① 的吸附语义：bottom-sheet 的 detents 是「面板下移比例」——
 *   可见 30% = 下移 0.7；可见 50% = 下移 0.5；顶部全开 = 0。
 * ② 用真实 radial-menu._open() 回放：给定屏幕 375x667、触点 (320,600)、
 *   radius 140、span -105~5、bottomInset 80，所有按钮下沿必须 <= 667-8-80。
 * ③ 不再依赖全角「＋」的字形重心，必须是两条绝对居中的几何线。
 *
 * 自带变异自证：改坏任一处必须翻红。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const P = {
  ttJs: 'miniprogram/pages/timetable/index.js',
  ttWxml: 'miniprogram/pages/timetable/index.wxml',
  ttWxss: 'miniprogram/pages/timetable/index.wxss',
  radial: 'miniprogram/components/radial-menu/index.js',
  sheet: 'miniprogram/components/bottom-sheet/index.js'
};
const read = (f) => (fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '');

function makeRadial(src, props) {
  let def = null;
  const req = (p) => (p === '../../utils/motion' ? {} : require(p));
  const wx = { getSystemInfoSync: () => ({ windowWidth: 375, windowHeight: 667 }) };
  /* eslint-disable no-new-func */
  new Function('require', 'Component', 'wx', src)(req, (o) => { def = o; }, wx);
  if (!def) throw new Error('radial-menu 没有调用 Component()');
  const properties = {};
  Object.keys(def.properties || {}).forEach((k) => { properties[k] = def.properties[k].value; });
  Object.assign(properties, props || {});
  const data = {};
  Object.keys(def.data || {}).forEach((k) => { data[k] = def.data[k]; });
  const inst = Object.assign({}, def, def.methods || {}, {
    properties,
    data,
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent() {}
  });
  inst._open();
  return inst;
}

function makeSheet(src, detents) {
  let def = null;
  const req = (p) => (p === '../popup-anim' ? {} : require(p));
  /* eslint-disable no-new-func */
  new Function('require', 'Component', src)(req, (o) => { def = o; });
  if (!def) throw new Error('bottom-sheet 没有调用 Component()');
  const properties = {};
  Object.keys(def.properties || {}).forEach((k) => { properties[k] = def.properties[k].value; });
  properties.detents = detents;
  const inst = Object.assign({}, def, def.methods || {}, {
    properties,
    data: {},
    setData() {},
    triggerEvent() {}
  });
  return inst;
}

function run(S, quiet) {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; if (!quiet) console.log('  ✓ ' + msg); }
    else { fail++; if (!quiet) console.log('  ✗ ' + msg); }
  };
  const head = (t) => { if (!quiet) console.log('\n' + t); };

  head('① 调整课程弹层：完整高度 + 30% / 50% / 顶部三档吸附');
  const cellTag = (S.ttWxml.match(/<bottom-sheet[^>]*show="\{\{cellActionShow\}\}"[\s\S]*?>/) || [''])[0];
  ok(/height="\{\{900\}\}"/.test(cellTag), '四项弹层高度提到 900rpx（四项 + 头 + 底栏留白都放得下）→ ' + (cellTag.match(/height="[^"]+"/) || ['无 height'])[0]);
  ok(/detents="\{\{cellActionDetents\}\}"/.test(cellTag), '四项弹层挂了 detents 三档');
  ok(/cellActionDetents:\s*\[\s*0\.5\s*,\s*0\.7\s*\]/.test(S.ttJs), '页面下发 [0.5, 0.7]：可见 50% / 30% / 顶部');
  const sheet = makeSheet(S.sheet, [0.5, 0.7]);
  const rests = sheet._restYs(400).map((x) => Math.round(x));
  ok(JSON.stringify(rests) === '[0,200,280]', '_restYs(400) = [0,200,280] → 顶部/50%/30% → ' + JSON.stringify(rests));
  const picks = [];
  sheet._springTo = (t) => picks.push(t);
  sheet._snapTo(210, 400, 0);
  sheet._snapTo(260, 400, 0);
  sheet._snapTo(390, 400, 0);
  ok(JSON.stringify(picks) === '[200,280,280]', '松手按最近档吸附（210→200 / 260→280 / 390→280）→ ' + JSON.stringify(picks));
  ok(/cubic-bezier\(\.34,\s*1\.4,\s*\.64,\s*1\)/.test(S.sheet), '非顶部档保留 overshoot 弹性曲线（Spring + snap points）');

  head('② 左下角弧形菜单：临时调课不再与 tabBar 重合');
  ok(/bottomInset:\s*\{\s*type:\s*Number/.test(S.radial), 'radial-menu 增加 bottomInset 属性');
  ok(/vh\s*-\s*MARGIN\s*-\s*bottomGuard/.test(S.radial), '下边界按 bottomInset 收紧（整条弧平移，不逐点夹取）');
  ok(/bottom-inset="\{\{tabbarPx\}\}"/.test(S.ttWxml), '课表页把真实 tabbarPx 传给菜单');
  ok(/tabbarPx:\s*\d+/.test(S.ttJs), '课表页持有 tabbarPx 兜底值');
  let radial = null;
  try {
    radial = makeRadial(S.radial, {
      x: 320, y: 600, radius: 140, spanStart: -105, spanEnd: 5,
      bottomInset: 80,
      items: [
        { key: 'ALL', label: '全部' }, { key: 'A', label: 'A 组' },
        { key: 'B', label: 'B 组' }, { key: 'SHIFT', label: '临时调课' }
      ]
    });
  } catch (e) {
    ok(false, 'radial-menu 回放异常：' + e.message);
  }
  if (radial) {
    const HALF = 32, MARGIN = 8, VH = 667, GUARD = 80;
    const bottoms = radial.data.arranged.map((it) => 600 + it.dy + HALF);
    const worst = Math.round(Math.max.apply(null, bottoms));
    ok(worst <= VH - MARGIN - GUARD, '最低按钮下沿 ' + worst + 'px <= 安全下沿 ' + (VH - MARGIN - GUARD) + 'px');
    const gaps = radial.data.arranged.slice(1).map((it, i) => Math.hypot(it.dx - radial.data.arranged[i].dx, it.dy - radial.data.arranged[i].dy));
    ok(Math.max.apply(null, gaps) - Math.min.apply(null, gaps) < 2, '整条弧平移后间距仍一致（最大差 <2px）');
  }

  head('③ 右下角加号：几何居中');
  ok(/<view class="fab-plus-h"><\/view>/.test(S.ttWxml) && /<view class="fab-plus-v"><\/view>/.test(S.ttWxml), '加号改为横竖两条几何线，不再用全角「＋」字形');
  ok(/\.fab-plus\s*\{[\s\S]*?left:\s*50%[\s\S]*?top:\s*50%[\s\S]*?translate\(-50%,\s*-50%\)/.test(S.ttWxss), '.fab-plus 以 left/top 50% + translate(-50%,-50%) 定位到圆心');
  ok(/\.fab-plus-h\s*\{[\s\S]*?top:\s*50%[\s\S]*?translateY\(-50%\)/.test(S.ttWxss), '横线在自身中线居中');
  ok(/\.fab-plus-v\s*\{[\s\S]*?left:\s*50%[\s\S]*?translateX\(-50%\)/.test(S.ttWxss), '竖线在自身中线居中');

  return { pass, fail };
}

const SRC = {
  ttJs: read(P.ttJs), ttWxml: read(P.ttWxml), ttWxss: read(P.ttWxss),
  radial: read(P.radial), sheet: read(P.sheet)
};
const base = run(SRC, false);

console.log('\n变异自证（每组改坏一处，必须翻红）');
const MUTANTS = [
  {
    name: '四项弹层去掉 detents（退回不可吸附）',
    key: 'ttWxml', from: ' detents="{{cellActionDetents}}"', to: ''
  },
  {
    name: 'radial-menu 下边界不再扣 tabBar（临时调课又被遮住）',
    key: 'radial', from: 'vh - MARGIN - bottomGuard', to: 'vh - MARGIN'
  },
  {
    name: '加号退回全角字形（重心偏移）',
    key: 'ttWxml', from: '<view class="fab-plus-h"></view>\n      <view class="fab-plus-v"></view>', to: '<text class="fab-plus">＋</text>'
  }
];
let mPass = 0, mFail = 0;
for (const mu of MUTANTS) {
  if (SRC[mu.key].indexOf(mu.from) < 0) {
    mFail++;
    console.log('  ✗ 变异样本没命中源码：' + mu.name);
    continue;
  }
  const bad = Object.assign({}, SRC);
  bad[mu.key] = SRC[mu.key].split(mu.from).join(mu.to);
  const r = run(bad, true);
  if (r.fail > 0) { mPass++; console.log('  ✓ 抓住 → ' + mu.name + '（翻红 ' + r.fail + ' 项）'); }
  else { mFail++; console.log('  ✗ 漏放 → ' + mu.name + '（改坏了却仍全绿）'); }
}

const pass = base.pass + mPass;
const fail = base.fail + mFail;
console.log('\n通过=' + pass + ' 失败=' + fail);
process.exit(fail ? 1 : 0);
