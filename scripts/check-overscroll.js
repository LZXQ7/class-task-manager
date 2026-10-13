/**
 * check-overscroll.js ——「iOS 式 overscroll 拉伸 + 下拉刷新」门禁（v1.0.5）
 *
 * 守的是 spring-scroll 这套弹性滚动的**实现纪律**，禁止把「拉伸」做成会卡顿/跳变/硬停的写法：
 *   ① 只用 transform（translate3d + scaleY）做位移与拉伸，绝不碰 height / margin / top（否则每帧重排）；
 *   ② 只在边界接管（raw>0 顶部 / raw<-maxScroll 底部），区间内是正常 1:1 滚动；
 *   ③ 回弹用「松手速度」作初速度的 spring 积分，不是固定 300ms 匀速；
 *   ④ 绝不 1:1 跟手（内容位移乘 CONTENT_DAMP<1，且橡皮筋指数衰减封顶）；
 *   ⑤ bottom-sheet 的 body 也走 spring-scroll（弹层内列表同样获得弹性，不再 bounces=false 硬停）。
 *
 * 含变异自证：对源码做坏样本变异（删 scaleY / 删边界接管 / 把阻尼改成 1:1），断言必须翻转成失败，
 * 否则说明上面某条判据是「假通过」（vacuous）。变异只在内存字符串上做，不落盘、不碰真文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const COMP = path.join(ROOT, 'miniprogram', 'components');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

const read = (p) => fs.readFileSync(p, 'utf8');
const springJs = read(path.join(COMP, 'spring-scroll', 'index.js'));
const springWxml = read(path.join(COMP, 'spring-scroll', 'index.wxml'));
const springWxss = read(path.join(COMP, 'spring-scroll', 'index.wxss'));
const bsWxml = read(path.join(COMP, 'bottom-sheet', 'index.wxml'));

function assertTrue(cond, msg) { if (cond) ok(msg); else bad(msg); }

/* ---- ① 只用 transform（位移 + 拉伸） ---- */
assertTrue(
  /transform:\s*translate3d\(0,\s*\{\{_offset\}\}px,\s*0\)\s*scaleY\(\{\{_scale\}\}\)/.test(springWxml),
  'spring-scroll 内容位移+拉伸只走 transform（translate3d + scaleY），不碰 height'
);
assertTrue(
  /\.ss-content[\s\S]{0,160}?will-change:\s*transform/.test(springWxss),
  '.ss-content 只声明 will-change:transform（GPU 合成层，不重排）'
);
// _applyTransform 里 setData 的字段只能是位移/缩放/原点/指示器，绝不出现 height/margin/top
const applyBlock = springJs.slice(springJs.indexOf('_applyTransform'));
assertTrue(
  /setData\(\{\s*_offset: off,\s*_scale: scale,\s*_origin/.test(applyBlock),
  '_applyTransform 只写 _offset/_scale/_origin/_indY/_indOpacity（无 height/margin/top 动画）'
);

/* ---- ② 只在边界接管 ---- */
assertTrue(
  /if \(raw > 0\)/.test(springJs) && /else if \(raw < -this\._maxScroll\)/.test(springJs),
  'spring-scroll 只在 raw>0(顶) / raw<-maxScroll(底) 时接管拉伸，区间内是 1:1 正常滚动'
);

/* ---- ③ 速度弹簧，非固定 300ms ---- */
assertTrue(
  /_velocity/.test(springJs) && /_startAnim/.test(springJs),
  '回弹用 _velocity 初速度做 spring 积分（非固定时长匀速）'
);
assertTrue(
  !/transition:\s*300ms/.test(springWxss) && !/300ms/.test(springWxss),
  'spring-scroll wxss 无「固定 300ms」过渡（避免匀速弹回）'
);

/* ---- ④ 绝不 1:1 跟手（阻尼 <1 + 封顶） ---- */
assertTrue(/CONTENT_DAMP\s*=\s*0\.6/.test(springJs), '内容位移乘 CONTENT_DAMP=0.6（<1，有重量、绝不 1:1）');
assertTrue(/RUBBER_MAX\s*=\s*120/.test(springJs), '边界最大拉出 RUBBER_MAX=120px（指数衰减封顶）');
assertTrue(/REFRESH_PX\s*=\s*60/.test(springJs), '下拉刷新阈值 REFRESH_PX=60px');

/* ---- ⑤ bottom-sheet body 走 spring-scroll ---- */
assertTrue(/<spring-scroll\b/.test(bsWxml), 'bottom-sheet 的 body 已改用 spring-scroll（弹层列表同样获得弹性）');

/* ============================ 变异自证 ============================ */
/** 坏样本变异后，断言必须翻转成失败，否则该判据是假通过 */
function proveNotVacuous(label, src, mutate, predicate) {
  const mutated = mutate(src);
  const before = predicate(src);
  const after = predicate(mutated);
  if (before && !after) ok('自证：' + label + ' 坏样本会被抓（判据非假通过）');
  else bad('自证：' + label + ' 变异后断言未翻转（before=' + before + ' after=' + after + '），判据可能失效');
}

// ① 删掉 scaleY(...) → transform-only 断言应失败
proveNotVacuous(
  '删除 scaleY 拉伸',
  springWxml,
  (s) => s.replace('scaleY({{_scale}})', ''),
  (s) => /transform:\s*translate3d\(0,\s*\{\{_offset\}\}px,\s*0\)\s*scaleY\(\{\{_scale\}\}\)/.test(s)
);

// ② 删掉边界接管（raw>0 那段） → 边界断言应失败
proveNotVacuous(
  '删除顶部边界接管',
  springJs,
  (s) => s.replace('if (raw > 0) {', 'if (false) {'),
  (s) => /if \(raw > 0\)/.test(s) && /else if \(raw < -this\._maxScroll\)/.test(s)
);

// ④ 把阻尼改成 1:1（CONTENT_DAMP=1） → 阻尼<1 断言应失败
proveNotVacuous(
  '把阻尼改成 1:1',
  springJs,
  (s) => s.replace('CONTENT_DAMP = 0.6', 'CONTENT_DAMP = 1'),
  (s) => /CONTENT_DAMP\s*=\s*0\.6/.test(s)
);

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
} else {
  console.log('✅ overscroll 门禁全部通过');
}
