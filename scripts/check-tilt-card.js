#!/usr/bin/env node
/**
 * 门禁：tilt-card 3D 触摸倾斜 / 径向流光 / 弹簧回正（2026-11-14 试点）
 * ============================================================
 * 为什么不能只做静态正则：这个组件的错误形态全是**手感问题**——
 *   · 把 WXS 响应事件写成 bindtouchmove="onMove" → 每帧一次跨线程 setData，跟手变拖影；
 *   · 把弹簧换成指数衰减 / cubic-bezier → 没有过冲，看着就是「啪一下贴回去」；
 *   · 去掉中断守卫 → 回正途中重新按下，两条循环同时写 transform，卡片抖；
 *   · 把阻尼调回 24 → 过冲只剩 0.1%，弹簧手感归零但代码一行不报错。
 * 所以这里用 vm 真加载 index.wxs，造一个假的 ComponentDescriptor（getState /
 * getBoundingClientRect / selectComponent / requestAnimationFrame），手动推进 rAF 帧，
 * 逐帧读回 setStyle 的内容做数值断言。
 *
 * 末尾 7 组变异自证全部在内存字符串里替换、绝不写盘；每组要求对应探针翻红，
 * 且先断言「锚点命中 + 替换生效」，防止拿好样本当坏样本的自欺式假绿。
 *
 * 用法：node scripts/check-tilt-card.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'miniprogram', 'components', 'tilt-card');
const read = p => fs.readFileSync(p, 'utf8');

/**
 * 🔴 一读进来就剥注释（2026-11-14 本门禁第一跑踩了 3 个假阳性）：
 *    wxml 注释里写了反例 bindtouchmove="onMove"、JS 注释里写了「没有任何 setData」、
 *    wxss 注释里写了 radial-gradient —— 全文正则会把**说明文字**当成代码命中。
 *    check-staff-pin.js 当年也被注释里的类名误伤过，是同一个坑。
 *    变异锚点全在代码块里，剥注释不影响任何一组自证。
 */
const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '');

const WXS = stripJs(read(path.join(DIR, 'index.wxs')));
const WXML = stripHtml(read(path.join(DIR, 'index.wxml')));
const WXSS = stripJs(read(path.join(DIR, 'index.wxss')));
const JS = stripJs(read(path.join(DIR, 'index.js')));
const JSON_SRC = read(path.join(DIR, 'index.json'));
const HOME_WXML = stripHtml(read(path.join(ROOT, 'miniprogram', 'pages', 'home', 'index.wxml')));
const HOME_JSON = read(path.join(ROOT, 'miniprogram', 'pages', 'home', 'index.json'));

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

/* 注释剥离已在文件顶部读入时统一完成；下面所有静态断言拿到的都是纯代码。 */

/* ============================================================
 * ① 真加载 WXS（源码是 ES5 CommonJS，vm 里可直接跑）
 * ============================================================ */
function loadWxs(src) {
  const sandbox = { module: { exports: {} }, Math, Number, String, console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.wxs' });
  return sandbox.module.exports;
}

const RECT = { left: 20, top: 100, width: 320, height: 180 };

/** 假的 ComponentDescriptor：把视图层所有副作用记下来，rAF 存队列由 step() 手动推进 */
function harness(opts) {
  opts = opts || {};
  const state = {};
  const h = { state, frames: [], calls: [], styles: [], glareStyles: [] };
  const glare = { setStyle(o) { h.glareStyles.push(Object.assign({}, o)); } };
  h.inst = {
    getState() { return state; },
    getDataset() { return opts.dataset || { max: '7', enabled: '1' }; },
    getBoundingClientRect() { return opts.noRect ? null : RECT; },
    selectComponent(sel) { return (sel === '.tg-glare' && !opts.noGlare) ? glare : null; },
    setStyle(o) { h.styles.push(Object.assign({}, o)); },
    callMethod(name, args) { h.calls.push({ name, args }); },
    requestAnimationFrame(fn) { h.frames.push(fn); }
  };
  /* ownerInstance = WXS 所在组件的实例（2026-11-14 起告警一律走它）。
     ⚠️ 真机上对 event.instance 调 callMethod 会抛
        「Call method on a non-custom component node is invalid」，
        所以探针也必须把 owner 传进去，否则测不到真实的告警路径。 */
  h.owner = { callMethod(name, args) { h.calls.push({ name, args }); } };
  return h;
}

function ev(h, x, y) { return { instance: h.inst, touches: [{ clientX: x, clientY: y }] }; }
function step(h, n) {
  for (let i = 0; i < n; i++) {
    const fn = h.frames.shift();
    if (!fn) break;
    fn();
  }
}
function rotate(style) {
  if (!style || !style.transform) return null;
  const rx = /rotateX\(([-\d.]+)deg\)/.exec(style.transform);
  const ry = /rotateY\(([-\d.]+)deg\)/.exec(style.transform);
  return rx && ry ? { rx: Number(rx[1]), ry: Number(ry[1]) } : null;
}
function glareXY(style) {
  if (!style || !style.transform) return null;
  const m = /translate3d\(([-\d.]+)px,([-\d.]+)px,0\)/.exec(style.transform);
  return m ? { gx: Number(m[1]), gy: Number(m[2]) } : null;
}

/* ============================================================
 * ② 行为探针：每个返回 boolean，变异样本要让指定的那一个翻红
 * ============================================================ */
function behaviorProbes(wxsSrc) {
  const api = loadWxs(wxsSrc);
  const out = {};

  /* pointer-down 即时反馈 + 四角映射 + 流光圆心跟随 */
  {
    const h = harness();
    api.onStart(ev(h, 20, 100), null);                 // 左上 (px=0, py=0)
    const first = rotate(h.styles[0]);
    const g1 = glareXY(h.glareStyles[0]);
    out.instant = !!first && h.glareStyles.length === 1 && Number(h.glareStyles[0].opacity) > 0;
    out.mapping = !!first && first.rx > 6 && first.ry < -6;
    out.glareFollow = !!g1 && g1.gx < 0 && g1.gy < 0;

    api.onMove(ev(h, 340, 280), null);                 // 右下 (px=1, py=1)
    const second = rotate(h.styles[h.styles.length - 1]);
    const g2 = glareXY(h.glareStyles[h.glareStyles.length - 1]);
    out.mapping = out.mapping && !!second && second.rx < -6 && second.ry > 6;
    out.glareFollow = out.glareFollow && !!g2 && g2.gx > 0 && g2.gy > 0;

    api.onMove(ev(h, 180, 190), null);                 // 正中 → 应归零
    const mid = rotate(h.styles[h.styles.length - 1]);
    out.mapping = out.mapping && !!mid && Math.abs(mid.rx) < 0.01 && Math.abs(mid.ry) < 0.01;
  }

  /* 松手：真弹簧必须过冲、必须收敛、流光必须渐隐 */
  {
    const h = harness();
    api.onStart(ev(h, 20, 100), null);
    api.onMove(ev(h, 20, 100), null);                  // 位置不变 → 松手初速度 0，过冲纯由弹簧产生
    const before = h.styles.length;
    const beforeGlare = h.glareStyles.length;
    api.onEnd(ev(h, 20, 100), null);
    step(h, 90);
    const traj = h.styles.slice(before).map(rotate).filter(Boolean);
    const last = rotate(h.styles[h.styles.length - 1]);
    const ops = h.glareStyles.slice(beforeGlare).map(s => Number(s.opacity));
    /* 从 +7° 起跳，轨迹里出现负角 = 欠阻尼过冲；指数衰减/贝塞尔近似永远翻不过 0 */
    out.overshoot = traj.some(p => p.rx < -0.05);
    out.settle = !!last && last.rx === 0 && last.ry === 0;
    out.glareFade = ops.length > 3 && ops[ops.length - 1] === 0 &&
                    ops.some(v => v > 0 && v < 0.61);
  }

  /* 可中断：回正途中重新按住，旧 rAF 循环必须立刻停手 */
  {
    const h = harness();
    api.onStart(ev(h, 20, 100), null);
    api.onEnd(ev(h, 20, 100), null);
    step(h, 5);
    api.onStart(ev(h, 340, 280), null);
    const n = h.styles.length;
    step(h, 8);
    out.interruptible = h.styles.length === n;
  }

  /* enabled=false 完全不响应 */
  {
    const h = harness({ dataset: { max: '7', enabled: '0' } });
    api.onStart(ev(h, 20, 100), null);
    api.onMove(ev(h, 340, 280), null);
    api.onEnd(ev(h, 340, 280), null);
    out.disabled = h.styles.length === 0 && h.glareStyles.length === 0;
  }

  /* maxTilt 上限：外部传 99 也必须被夹到 14 */
  {
    const h = harness({ dataset: { max: '99', enabled: '1' } });
    api.onStart(ev(h, 20, 100), null);
    const r = rotate(h.styles[0]);
    out.clamp = !!r && r.rx === 14;
  }

  /* 降级必须留日志（铁律：空 catch / 静默降级是事故放大器） */
  {
    const h1 = harness({ noRect: true });
    api.onStart(ev(h1, 20, 100), h1.owner);
    out.rectWarn = h1.calls.some(c => c.name === 'onTiltWarn');
    /* 拿不到 glare 节点时必须**降级告警**（流光的逐帧跟随会失效，光效由 CSS 兜底） */
    const h2 = harness({ noGlare: true });
    api.onStart(ev(h2, 20, 100), h2.owner);
    out.glareWarn = h2.calls.some(c => c.name === 'onTiltWarn') && h2.styles.length > 0;
  }

  return out;
}

/* ============================================================
 * ③ 静态探针（变异样本的 wxml / wxss 两组走这里）
 * ============================================================ */
function staticProbes(wxml, wxss, wxs) {
  return {
    wxsBinding: /bindtouchmove="\{\{tilt\.onMove\}\}"/.test(wxml) &&
                !/bindtouchmove="onMove"/.test(wxml),
    reducedMotion: /@media \(prefers-reduced-motion: reduce\)/.test(wxss) &&
                   /transform: none !important/.test(wxss),
    rafSpring: /requestAnimationFrame\(tick\)/.test(wxs) && /var DAMPING = 18;/.test(wxs),
    wxsSyntax: !/\b(Number|String|Boolean)\s*\(/.test(wxs) &&
               !/\b(let|const)\s|=>|`/.test(wxs)
  };
}

function allProbes(wxs, wxml, wxss) {
  return Object.assign({}, behaviorProbes(wxs), staticProbes(wxml, wxss, wxs));
}

/* ============================================================
 * ④ 逐条断言
 * ============================================================ */
console.log('── ① 视图层通道与组件定义（静态）');
check(/<wxs module="tilt" src="\.\/index\.wxs"><\/wxs>/.test(WXML), 'wxml 引入同目录 index.wxs');
['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(t => {
  check(new RegExp('bind' + t + '="\\{\\{tilt\\.on[A-Za-z]+\\}\\}"').test(WXML),
        'bind' + t + ' 走 WXS 响应事件（带花括号，不跨线程）');
});
check(!/bindtouch\w+="on[A-Z]/.test(WXML), '没有退化成逻辑层裸 handler 名');
check(/data-max="\{\{maxTilt\}\}"/.test(WXML) && /data-enabled=/.test(WXML),
      'maxTilt / enabled 通过 dataset 传给 WXS');
check(/<view class="tg-glare"><\/view>/.test(WXML), '流光层在 slot 之前（靠 z-index 盖住内容）');
check(/<slot><\/slot>/.test(WXML), '卡片内容走默认 slot，本体结构不变');
check(/"component"\s*:\s*true/.test(JSON_SRC), 'index.json 声明 component');
check(/onTiltWarn/.test(JS) && /console\.error/.test(JS), '降级上报走 console.error（不静默）');
check(!/setData/.test(JS), '组件 JS 全程零 setData（手势不跨线程）');
check(/radial-gradient/.test(WXSS), '流光是径向渐变');
check(/pointer-events:\s*none/.test(WXSS), '流光层不吃点击');
check(!/transition:\s*all/.test(WXSS), '没有 transition: all');
check(/@media \(prefers-reduced-transparency: reduce\)/.test(WXSS), '降低透明度系统设置下隐藏流光');
/* 🔴 2026-11-14 真编译事故：门禁用 Node vm 全绿，miniprogram-ci 上传却报
 *    `index.wxs:41:37 Unexpected token '('`（-80054）—— WXS 是受限 JS 子集，
 *    不认 Number()/String() 这些全局构造器。离线门禁补一条语法黑名单。 */
check(!/\b(Number|String|Boolean)\s*\(/.test(WXS),
      'WXS 不写 Number()/String() 构造器（真编译会报 Unexpected token）');
check(!/\b(let|const)\s|=>|`/.test(WXS), 'WXS 只用 ES5 语法（无 let/const/箭头/模板串）');

console.log('── ② 首页试点接入（扩到全部 5 张 st-item 卡）');
check(/"tilt-card"\s*:\s*"\.\.\/\.\.\/components\/tilt-card\/index"/.test(HOME_JSON),
      'home/index.json 注册组件');
const opens = (HOME_WXML.match(/<tilt-card\b/g) || []).length;
const closes = (HOME_WXML.match(/<\/tilt-card>/g) || []).length;
check(opens === 5 && closes === 5, '首页恰好包裹 5 张卡且标签闭合（' + opens + '/' + closes + '）');
/* 非贪婪配对取出每个 tilt-card 内部块，逐张核对 st-N 真在里面（顺序与文档一致：1~5） */
const inners = Array.from(HOME_WXML.matchAll(/<tilt-card[^>]*>([\s\S]*?)<\/tilt-card>/g)).map(m => m[1]);
let innerOk = inners.length === 5;
for (let i = 0; i < 5; i++) {
  if (!inners[i] || !new RegExp('\\bst-' + (i + 1) + '\\b').test(inners[i])) innerOk = false;
}
check(innerOk, '五张卡（关注/今日值日/今日课次/明日课次/请假）各自包进 tilt-card');
check(/<tilt-card wx:if="\{\{showPins\}\}">/.test(HOME_WXML), '关注的学生卡已接入');
check(/<tilt-card wx:if="\{\{showLeaveHome\}\}">/.test(HOME_WXML), '首页请假卡已接入');
/* 档位连续：剥注释后只读 class 属性里的 st-N，避免注释里 st-1~st-7 的说明文字干扰 */
const strip = t => t.replace(/<!--[\s\S]*?-->/g, '');
const seq = Array.from(strip(HOME_WXML).matchAll(/class="[^"]*\bst-(\d)\b/g)).map(m => Number(m[1]));
const want = seq.map((_, i) => Math.min(i + 1, 7));
check(seq.length > 0 && JSON.stringify(seq) === JSON.stringify(want),
      '首页 .st-item 档位仍连续（' + seq.join(',') + '），包装层没打乱入场动画');
check(!/class="[^"]*tilt-card[^"]*st-item/.test(HOME_WXML),
      '包装层自己不带 .st-item（否则两层位移叠加）');

console.log('── ③ 视图层行为自证（vm 真跑 + 手动推进 rAF 帧）');
const P = allProbes(WXS, WXML, WXSS);
Object.keys(P).forEach(k => check(P[k] === true, '探针 ' + k));

/* ============================================================
 * ⑤ 变异自证：内存替换，绝不写盘；锚点没命中直接判失败
 * ============================================================ */
console.log('── ④ 变异自证（好样本必须能被改成坏样本并翻红）');
const MUTATIONS = [
  {
    name: 'onStart 不再立即 applyPoint（反馈要等第一次 move）',
    scope: 'wxs', expect: 'instant',
    from: '    state.vy = 0;\n    applyPoint(event, inst, state);\n  },',
    to: '    state.vy = 0;\n  },'
  },
  {
    name: '弹簧换成指数衰减（等价 cubic-bezier 假弹簧，无过冲）',
    scope: 'wxs', expect: 'overshoot',
    from: '    vx = vx + (-STIFFNESS * x - DAMPING * vx) * DT;\n    vy = vy + (-STIFFNESS * y - DAMPING * vy) * DT;\n    x = x + vx * DT;\n    y = y + vy * DT;',
    to: '    x = x * 0.85;\n    y = y * 0.85;\n    vx = 0;\n    vy = 0;'
  },
  {
    name: '去掉中断守卫（重新按下后旧循环继续写 transform）',
    scope: 'wxs', expect: 'interruptible',
    from: '    if (state.token !== token || state.active) return;',
    to: '    /* interruption guard removed */'
  },
  {
    name: '流光亮度恒定（不随回正渐隐）',
    scope: 'wxs', expect: 'glareFade',
    from: '    state.light = state.light * GLARE_FADE;',
    to: '    state.light = GLARE_ON;'
  },
  {
    name: '去掉 maxTilt 夹紧（外部传 99 就倾 99°）',
    scope: 'wxs', expect: 'clamp',
    /* ⚠️ 锚点里的默认值要和 index.js 的 maxTilt.value / WXS 的 num(d.max, N) 同步；
     *    故意不做通配：默认值一改这里立刻翻红，逼着回来复核探针，避免静默漂移。 */
    from: '    state.max = clamp(num(d.max, 9), 1, 14);',
    to: '    state.max = 99;'
  },
  {
    name: 'wxml 绑定退化成逻辑层 handler（跟随手指开始掉帧）',
    scope: 'wxml', expect: 'wxsBinding',
    from: 'bindtouchmove="{{tilt.onMove}}"',
    to: 'bindtouchmove="onMove"'
  },
  {
    name: 'wxss 删掉 reduced-motion 的 !important 压制',
    scope: 'wxss', expect: 'reducedMotion',
    from: '  .tg-surface { transform: none !important; will-change: auto; }',
    to: '  .tg-surface { will-change: auto; }'
  },
  {
    name: 'WXS 写回 Number() 构造器（真编译 -80054，Node vm 却全绿）',
    scope: 'wxs', expect: 'wxsSyntax',
    from: 'function num(v, d) { var n = +v; return n !== n ? d : n; }',
    to: 'function num(v, d) { var n = Number(v); return n !== n ? d : n; }'
  }
];

let mFail = 0;
for (const mu of MUTATIONS) {
  const base = mu.scope === 'wxml' ? WXML : (mu.scope === 'wxss' ? WXSS : WXS);
  if (base.indexOf(mu.from) < 0) { mFail++; bad('变异锚点没命中源码：' + mu.name); continue; }
  const badSrc = base.replace(mu.from, mu.to);
  if (badSrc === base) { mFail++; bad('变异替换未生效：' + mu.name); continue; }
  const p = allProbes(
    mu.scope === 'wxs' ? badSrc : WXS,
    mu.scope === 'wxml' ? badSrc : WXML,
    mu.scope === 'wxss' ? badSrc : WXSS
  );
  if (p[mu.expect] === false) ok('变异被抓：' + mu.name);
  else { mFail++; bad('变异未翻红（假绿）：' + mu.name + ' → ' + mu.expect); }
}
/* bad() 自己已经计过 failed，这里不再 += mFail（否则 1 个问题会显示成 2 项）。
   mFail 只用于上面逐组打印结果，留作阅读用的局部计数。 */
void mFail;

console.log(failed ? '\nFAIL · tilt-card 门禁 ' + failed + ' 项未通过'
                   : '\nOK · tilt-card 3D 倾斜 / 流光 / 弹簧门禁全部通过');
process.exit(failed ? 1 : 0);
