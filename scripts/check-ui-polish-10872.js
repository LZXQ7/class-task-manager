#!/usr/bin/env node
/**
 * 离线自检：v1.0.8.72 界面打磨 + 性能（2026-11-20 用户 7 条诉求）
 * --------------------------------------------------------------------------------
 * 用户诉求：①底栏玻璃太不透明/无折射感 ②鲜艳按钮全改玻璃+按钮左右间距
 *          ③排班方式输入框字错位 ④换人列表一人一行太占空间+排序混乱
 *          ⑤值日详情加载慢 ⑥按住的灰矩形/遮罩生硬 ⑦无用代码拖慢速度
 * 共识口径：
 *   A1 毛玻璃增强（blur 24→38、solid 兜底降低、高光边），放弃真折射（小程序做不到）
 *   A2 主按钮 = 玻璃底 + 品牌蓝字 + 品牌色细边；次按钮 = 灰字玻璃底
 *   A3 遮罩去 press-shrink（灰矩形根因）+ 纯色改柔和径向渐变
 *   B  换人列表 3 列网格；值日候选按学号升序（与演讲一致）
 *   C  duty/detail 独立查询 Promise.all 并行
 *   D  .sp-input 固定 height + 同值 line-height 修贴顶
 *   E  修 app.js _prefetchTabs 的 g 未定义 bug；删空壳孤儿页 my-timetable
 *
 * 用法：node scripts/check-ui-polish-10872.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  appWxss: 'miniprogram/app.wxss',
  tabbarWxss: 'miniprogram/custom-tab-bar/index.wxss',
  sheetWxml: 'miniprogram/components/bottom-sheet/index.wxml',
  sheetWxss: 'miniprogram/components/bottom-sheet/index.wxss',
  candWxml: 'miniprogram/components/duty-sheet/index.wxml',
  candWxss: 'miniprogram/components/duty-sheet/index.wxss',
  dutyWxml: 'miniprogram/pages/duty/index.wxml',
  dutyWxss: 'miniprogram/pages/duty/index.wxss',
  dutyJs: 'miniprogram/pages/duty/index.js',
  appJs: 'miniprogram/app.js',
  adjustJs: 'cloudfunctions/adjust/index.js',
  dutyFn: 'cloudfunctions/duty/index.js'
};
const S = {};
Object.keys(F).forEach((k) => { S[k] = exists(F[k]) ? read(F[k]) : ''; });

function evalAll(s) {
  const app = strip(s.appWxss);
  /* .btn 在文件里有 3 处（两处降级写 backdrop-filter:none + 一处全局定义）——
     取含 var(--glass-blur 令牌的全局那块，避免误取降级块 */
  const btnBlock = (app.match(/\.btn\s*\{[^}]*backdrop-filter:\s*var\(--glass-blur[^}]*\}/) || [''])[0];
  const tabs = strip(s.tabbarWxss);
  const tabBlock = (tabs.match(/\.tabbar\s*\{[^}]*\}/) || [''])[0];
  const sheetCss = s.sheetWxss;
  const maskBlock = (sheetCss.match(/\.sheet-mask\s*\{[^}]*\}/) || [''])[0];
  const candCss = s.candWxss;
  const candGrid = (candCss.match(/\.ds-cand-grid\s*\{[^}]*\}/) || [''])[0];
  const candItem = (candCss.match(/\.ds-cand\s*\{[^}]*\}/) || [''])[0];
  const dutyCss = s.dutyWxss;
  const swapList = (dutyCss.match(/\.sp-swap-list\s*\{[^}]*\}/) || [''])[0];
  const spInput = (dutyCss.match(/\.sp-input\s*\{[^}]*\}/) || [''])[0];
  /* .f-actions 有两处（.sl .f-actions 岗位槽 + 通用操作条）——取含 display:flex 的通用那块 */
  const fActions = (dutyCss.match(/\.f-actions\s*\{[^}]*display:\s*flex[^}]*\}/) || [''])[0];
  const detailFn = (strip(s.dutyFn).match(/detail:\s*\{[\s\S]*?\n  \},/) || [''])[0];
  /* 注释里提到「原写 g.profile」，须 strip 掉注释再判，否则「g 未定义」判据误报 */
  const prefetch = (strip(s.appJs).match(/_prefetchTabs\(\)\s*\{[\s\S]*?\n  \}/) || [''])[0];

  return {
    /* A1/A2 按钮与玻璃 */
    btnNoGradient: !/linear-gradient/.test(btnBlock),
    btnGlass: /backdrop-filter:\s*var\(--glass-blur/.test(btnBlock) && /background:\s*var\(--glass-bg/.test(btnBlock),
    btnBrandText: /color:\s*var\(--brand\)/.test(btnBlock) && /border:\s*1rpx solid var\(--brand-disable\)/.test(btnBlock),
    strongBlurToken: /--glass-blur-strong:\s*blur\(38px\)/.test(app),
    btnFallback: /@supports not \(\(backdrop-filter/.test(app) && /\.btn\s*\{[^}]*background:\s*var\(--brand-light\)/.test(app),
    tabGlass: /backdrop-filter:\s*var\(--glass-blur-strong/.test(tabBlock) && /var\(--tabbar-bg/.test(tabBlock),
    /* A3 遮罩 */
    maskNoPress: !/hover-class="press-shrink"/.test((s.sheetWxml.match(/class="sheet-mask[^"]*"[^>]*>/) || [''])[0])
      && !/data-pressable/.test((s.sheetWxml.match(/<view[^>]*class="sheet-mask[^>]*>/) || [''])[0]),
    maskRadial: /radial-gradient/.test(maskBlock) && /--bg-mask-soft/.test(maskBlock)
      && /\)\s+0rpx,/.test(maskBlock) && /\)\s+1000rpx\)/.test(maskBlock),
    /* 组件渐变色标必须是 rpx（百分比会被真机整条丢弃）；at 50% 是圆心位置、允许百分比 */
    maskToken: /--bg-mask-soft:/.test(app),
    /* A2 按钮间距 */
    fActionsPad: /padding:\s*0 32rpx/.test(fActions),
    /* B 网格 + 排序 */
    dutyGrid: /flex-wrap:\s*wrap/.test(candGrid) && /width:\s*calc\(\(100% - 28rpx\) \/ 3\)/.test(candItem),
    swapGrid: /flex-wrap:\s*wrap/.test(swapList) && /width:\s*calc\(\(100% - 28rpx\) \/ 3\)/.test(dutyCss),
    sortByStudentNo: /ORDER BY student_no/.test(s.adjustJs) && !/ORDER BY duty_count, id/.test(s.adjustJs),
    /* C 并行 */
    detailParallel: /Promise\.all\(\[/.test(detailFn) && /week\.getConfig\(pool, classId\)/.test(detailFn)
      && /week\.loadSessionShifts\(pool, classId\)/.test(detailFn),
    /* D 输入框 */
    inputFixed: /height:\s*68rpx/.test(spInput) && /line-height:\s*68rpx/.test(spInput),
    /* E 预热 bug */
    prefetchFixed: /this\.globalData \|\| \{\}/.test(prefetch) && !/\bg\.profile\b/.test(prefetch),
    orphanGone: !exists(F.appWxss) ? false : !exists('miniprogram/pages/my-timetable/index.js')
  };
}

const A = evalAll(S);

console.log('── ① 按钮玻璃化（A2）');
check(A.btnNoGradient, '全局 .btn 去掉蓝紫粉渐变');
check(A.btnGlass, '.btn 玻璃底 + backdrop 模糊');
check(A.btnBrandText, '.btn 品牌蓝字 + 品牌色细边（主次靠蓝字 vs 灰字）');
check(A.btnFallback, '降级路径里 .btn 有实心兜底（@supports not 双层括号）');

console.log('\n── ② 底栏玻璃增强（A1）');
check(A.strongBlurToken, '新增 --glass-blur-strong: blur(38px) 令牌');
check(A.tabGlass, '底栏用强模糊令牌 + tabbar-bg 玻璃底');

console.log('\n── ③ 遮罩柔化（A3）');
check(A.maskNoPress, '遮罩去掉 press-shrink/data-pressable（灰矩形根因）');
check(A.maskRadial, '遮罩改径向渐变，且色标用 rpx 非百分比（组件渐变铁律）');
check(A.maskToken, '新增 --bg-mask-soft 令牌（深浅各一份）');
check(A.fActionsPad, '.f-actions 补左右 32rpx padding（按钮不再贴边）');

console.log('\n── ④ 换人列表网格 + 排序（B）');
check(A.dutyGrid, '值日换人候选 3 列网格');
check(A.swapGrid, '演讲换人候选 3 列网格');
check(A.sortByStudentNo, '值日候选按学号升序（不再按 duty_count,id）');

console.log('\n── ⑤ 性能（C/E）');
check(A.detailParallel, 'duty/detail 独立查询改 Promise.all 并行');
check(A.prefetchFixed, 'app.js _prefetchTabs 修 g 未定义（改 this.globalData）');
check(A.orphanGone, '删除空壳孤儿页 my-timetable');

console.log('\n── ⑥ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '按钮渐变回来', probe: 'btnNoGradient', file: 'appWxss',
    apply: (x) => x.replace('background: var(--glass-bg-strong);', 'background: linear-gradient(135deg, #7C5CFF 0%, #3370FF 55%, #F472B6 100%);') },
  { name: '遮罩按压态回来（灰矩形）', probe: 'maskNoPress', file: 'sheetWxml',
    apply: (x) => x.replace('<view class="sheet-mask {{active ? \'in\' : \'\'}}"', '<view hover-class="press-shrink" data-pressable class="sheet-mask {{active ? \'in\' : \'\'}}"') },
  { name: '遮罩渐变色标改百分比（真机整条丢弃）', probe: 'maskRadial', file: 'sheetWxss',
    apply: (x) => x.replace('rgba(0,0,0,0.26)) 0rpx, var(--bg-mask, rgba(0,0,0,0.45)) 1000rpx)',
      'rgba(0,0,0,0.26)) 0%, var(--bg-mask, rgba(0,0,0,0.45)) 100%)') },
  { name: '排序退回混乱口径', probe: 'sortByStudentNo', file: 'adjustJs',
    from: 'ORDER BY student_no', to: 'ORDER BY duty_count, id' },
  { name: '详情查询退回串行', probe: 'detailParallel', file: 'dutyFn',
    from: 'await Promise.all([', to: 'await Promise.allSettledMaybe([' },
  { name: '预 bug 复原（g 未定义）', probe: 'prefetchFixed', file: 'appJs',
    from: 'const gd = this.globalData || {};', to: 'const gd = g || {};' },
  { name: '输入框去掉固定行高（又贴顶）', probe: 'inputFixed', file: 'dutyWxss',
    from: 'height: 68rpx; line-height: 68rpx;', to: 'height: auto;' },
  { name: '按钮间距去掉（又贴边）', probe: 'fActionsPad', file: 'dutyWxss',
    from: 'padding: 0 32rpx 20rpx;', to: 'padding: 0;' }
];

MUT.forEach((mu) => {
  const src = S[mu.file];
  const next = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (next === src) { console.log('  ✗ 变异「' + mu.name + '」锚点失配/未改变源码'); failed += 1; return; }
  check(evalAll(Object.assign({}, S, { [mu.file]: next }))[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ v1.0.8.72 界面打磨与性能检查全部通过'));
process.exit(failed ? 1 : 0);
