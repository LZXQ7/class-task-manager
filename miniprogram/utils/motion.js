/**
 * 动效内核（v1.0.9.0 · 11 项动效的唯一真源）
 * ============================================================
 * 为什么要有这个文件：本轮 11 项动效横跨 16 个页面 + 8 个组件。若各自写一套
 *   `transition: .24s cubic-bezier(...)`，就必然出现「同一个手势在三处手感不同」
 *   和「改一处漏三处」。所以时长、曲线、弹簧参数、设备降级、逐项开关**只在这里定义**，
 *   页面与组件一律 `require('../../utils/motion')` 取值。
 *
 * 三条纪律（写代码前先读）：
 *   ① **只动 transform / opacity**：位移与缩放交给合成层，不触发布局与重绘。
 *      width/height/top/left 一律不参与补间（唯一的例外是 #1 的 FLIP，因为形态变换
 *      本质就是尺寸变化 —— 但它只在一段 380ms 里跑一次，不是逐帧手势）。
 *   ② **不要用 cubic-bezier 冒充弹簧**：项目早年已定过这条（见 utils/list-transition.js）。
 *      真弹性 = 多段 @keyframes 或逐帧积分（见 components/tilt-card/index.wxs），
 *      曲线只负责「单段进出」。
 *   ③ **逐项可关**：`FLAGS` 里每一项都对应需求里的一条。用户说「第 N 条不满意」时，
 *      把对应 key 置 false 即可整体退化为改动前行为，不需要 revert 代码。
 *      可用远程配置 `motion_flags`（app_config 表）覆盖，免小程序审核。
 */

const theme = require('./theme');

/* ============================================================
 * 1. 时长令牌（ms）
 * ------------------------------------------------------------
 * 全部落在 90~420ms 之间：短于 90ms 人眼读不出「有动」，长于 420ms 会被感知为卡顿。
 * 唯一超出的是 HOLD —— 那是「长按确认」必须按满的时间，不是动画时长。
 * ========================================================== */
const DUR = {
  instant: 90,   // 按下反馈、微状态切换
  fast: 160,     // 小元素进出、图标位移
  base: 240,     // 面板升降、卡片展开（与既有 popup-anim 的 240ms 对齐）
  slow: 320,     // 大块区域、页面级位移
  morph: 380,    // #1 胶囊→面板的形态变换（比常规慢，因为它同时改尺寸+位置+圆角）
  shared: 420,   // #2 / #8 共享元素转场
  hold: 700,     // #9 长按确认需按满的时长
  stagger: 36,   // #5 相邻子项的交错间隔（沿用 v0.7.31 定稿值，勿改成 20，太密看不出层次）
  staggerMax: 8  // #5 参与交错的子项上限：第 9 项起不再叠加延迟
};

/* ============================================================
 * 2. 曲线（单段进出用；弹性不在这里）
 * ------------------------------------------------------------
 * fluid = 「高阻尼流体」：#1 的形态变换用它 —— 起步极快（0.2 的控制点 x），
 *         尾部用 1.12 制造一次极轻的收尾超调（约 1.5%），观感是「啪地长开、微微一颤」，
 *         而不是匀速胀大。
 * ========================================================== */
const EASE = {
  out: 'cubic-bezier(.22,.61,.36,1)',          // 通用缓出（与 app.wxss 的 pa-first 同款）
  inOut: 'cubic-bezier(.65,0,.35,1)',          // 双向对称
  fluid: 'cubic-bezier(.2,1.12,.32,1)',        // 高阻尼流体（形态变换）
  overshoot: 'cubic-bezier(.34,1.4,.64,1)',    // 轻超调（按钮释放、锚点吸附）
  shut: 'cubic-bezier(.4,0,.6,1)',             // 关闭 / 离场：起步慢、尾部快
  linear: 'linear'
};

/* ============================================================
 * 3. 弹簧求解（把物理参数换算成 CSS 能用的「时长 + 曲线」）
 * ------------------------------------------------------------
 * 小程序没有真 spring，逐帧积分只在 WXS 里做（tilt-card 就是这么干的）。
 * 凡是「一次性落位」的弹簧（#6 按钮释放、#3 锚点吸附），用下面的换算：
 *
 *   ω0 = 2π / 响应时间        ζ = 阻尼比
 *   · 临界阻尼（ζ=1）：不过冲，最稳 → 用于面板吸附
 *   · 欠阻尼（ζ<1）：过冲 → 用于按钮释放（ζ≈0.62，过冲约 7%）
 *
 * ⚠️ 时长取「衰减到 1% 以内」的时刻，这是人眼判定「停稳了」的门槛：
 *    · ζ = 1（临界阻尼）：x(t)=1-(1+ω0t)e^(-ω0t) ⇒ 约 6.6/ω0
 *    · ζ < 1（欠阻尼）  ：包络 e^(-ζω0t) ⇒ 约 4.6/(ζω0)
 *    不要用「首次到达目标」的时刻（那是 1.6/ω0，只有 90ms 量级）—— 曲线还没走完就
 *    切回静态，视觉上是「弹到一半被掐断」。这是本文件第一版的真实错误。
 * ========================================================== */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * @param {number} response 响应时间（秒），0.2~0.5 之间是「跟手」
 * @param {number} zeta     阻尼比，1=临界阻尼不过冲，<1 过冲
 * @returns {{ms:number, ease:string, overshoot:number}} overshoot 为估算过冲百分比
 */
function spring(response, zeta) {
  const r = clamp(response || 0.34, 0.16, 0.9);
  const z = clamp(zeta || 1, 0.2, 1.4);
  const w0 = 2 * Math.PI / r;
  const settleSec = z >= 0.98 ? 6.6 / w0 : 4.6 / (z * w0);
  const ms = Math.round(clamp(settleSec * 1000, 130, 420));
  // 过冲百分比：ζ>=1 为 0；ζ<1 按 exp(-πζ/√(1-ζ²)) 估
  const overshoot = z >= 1 ? 0 : Math.round(Math.exp(-Math.PI * z / Math.sqrt(1 - z * z)) * 1000) / 10;
  return { ms, ease: z >= 0.98 ? EASE.out : EASE.overshoot, overshoot };
}

/** 常用档位（页面不要自己 new，从这里挑） */
const SPRING = {
  /** 面板吸附到锚点：临界阻尼，绝不晃（晃 = 用户以为没停稳） */
  detent: spring(0.34, 1),
  /** 按钮释放：欠阻尼，约 7% 超调（响应 0.24s —— 比面板快，按下去的东西该立刻回来） */
  press: spring(0.24, 0.62),
  /** 卡片落位 / 焦点归位 */
  settle: spring(0.3, 0.85)
};

/* ============================================================
 * 4. 设备分级（决定「哪些动效这台机器扛得住」）
 * ------------------------------------------------------------
 * 依据 `wx.getDeviceInfo().benchmarkLevel`（微信给的设备性能等级，1~50，-1=未知）。
 * 为什么需要分级：`backdrop-filter` 与大面积 `filter:blur()` 是**每帧全屏重采样**，
 * 在低端安卓上能把 60fps 直接打到 20fps —— 而这类机器恰好是班上一半同学的机器。
 *
 * ⚠️ benchmarkLevel 为 -1（未知，常见于 iOS）时**不要判为低端**：iOS 的
 *    WKWebView 对 backdrop-filter 有硬件加速，实测比同分数安卓好得多。判中端即可。
 * ========================================================== */
let _profile = null;

function profile() {
  if (_profile) return _profile;
  let bench = -1;
  let platform = 'unknown';
  try {
    const info = (wx.getDeviceInfo && wx.getDeviceInfo()) || {};
    platform = info.platform || 'unknown';
    bench = typeof info.benchmarkLevel === 'number' ? info.benchmarkLevel : -1;
  } catch (e) {
    console.error('[motion] 读设备信息失败，按中端处理', e);
  }
  let level = 'mid';
  if (bench >= 0) {
    if (bench >= 20) level = 'high';
    else if (bench >= 10) level = 'mid';
    else level = 'low';
  } else if (platform === 'ios') {
    level = 'high';
  }
  _profile = {
    level,
    platform,
    bench,
    /** 能不能用 backdrop-filter / 大面积 blur */
    blur: level !== 'low',
    /** 呼吸背光能不能动（低端机只给静态渐变，不动 filter） */
    glow: level !== 'low',
    /** 旋转渐变描边能不能逐帧转（低端机静止） */
    conicSpin: level === 'high',
    /** 能否承受多层同时动画（交错入场 + 模糊背光叠加） */
    multi: level === 'high'
  };
  return _profile;
}

/* ============================================================
 * 5. 功能开关（对应需求 11 条，逐条可关）
 * ------------------------------------------------------------
 * key 与需求编号一一对应，改这里就能整体退回改动前行为：
 *   morph        #1  胶囊 → 面板 流体形态变换
 *   shared       #2  Card → 详情 共享元素转场
 *   detents      #3  底部抽屉三档吸附锚点
 *   aura         #4  旋转渐变描边 + 呼吸弥散背光
 *   stagger      #5  列表交错入场
 *   press        #6  按钮按压压缩 + 释放超调
 *   glass        #7  导航栏液态玻璃
 *   flipDetail   #8  学生 3D 翻转详情
 *   holdConfirm  #9  危险操作长按确认
 *   radial       #10 课程表长按弧形菜单
 *   collapse     #11 搜索栏随滚动收起
 * ========================================================== */
const FLAGS = {
  morph: true,
  shared: true,
  detents: true,
  aura: true,
  stagger: true,
  press: true,
  glass: true,
  flipDetail: true,
  holdConfirm: true,
  radial: true,
  collapse: true
};

/** 远程覆盖（app_config 的 motion_flags，形如 {morph:false}） */
let _remote = null;

/**
 * 某一项动效当前是否生效。
 * 判定顺序：远程覆盖 → 本地 FLAGS → 设备能力 → 系统「减弱动效」
 * @param {string} key FLAGS 的键
 * @returns {boolean}
 */
function on(key) {
  if (_remote && typeof _remote[key] === 'boolean') return _remote[key] && allowed(key);
  if (!FLAGS[key]) return false;
  return allowed(key);
}

/** 设备能力与无障碍偏好的过滤（不改变用户手动开关的语义） */
function allowed(key) {
  const p = profile();
  // 模糊类：低端机整体关（改了也不好看，还卡）
  if ((key === 'glass' || key === 'aura') && !p.blur) return false;
  // 交错：系统开了「减弱动效」就整段关掉，避免"一片一片来"变成折磨
  if (key === 'stagger' && theme.prefersReducedMotion()) return false;
  return true;
}

/**
 * 注入远程开关（由 app.js 在 loadRemoteConfig 之后调一次）。
 * ⚠️ 只接受布尔值，非法键忽略 —— 防止后台填错字把动效全关掉还不知道为什么。
 */
function setRemote(obj) {
  if (!obj || typeof obj !== 'object') return;
  const next = {};
  Object.keys(FLAGS).forEach((k) => {
    if (typeof obj[k] === 'boolean') next[k] = obj[k];
  });
  _remote = next;
}

/* ============================================================
 * 6. 生成内联样式的工具（页面直接用，别再手拼字符串）
 * ========================================================== */

/**
 * 生成一段 transition 声明。
 * @param {string} prop CSS 属性，如 'transform'
 * @param {number} ms   时长
 * @param {string} ease 曲线
 */
function trans(prop, ms, ease) {
  return prop + ' ' + (ms || DUR.base) + 'ms ' + (ease || EASE.out);
}

/** 时长在 reduced-motion 下压到 1/3（保留可感知性，但不让人等） */
function dur(ms) {
  return theme.prefersReducedMotion() ? Math.max(60, Math.round(ms / 3)) : ms;
}

/** #5 交错延迟：第 n 项（从 0 起）的延迟，超过 staggerMax 后不再递增 */
function staggerDelay(n) {
  const i = Math.min(Math.max(0, n | 0), DUR.staggerMax);
  return i * DUR.stagger;
}

/**
 * 当前启用中的动效 class 列表（供 CSS 类动效按 FLAG 开关）。
 * 拼到页面根节点（见 theme.mount 把结果并入 tClass），app.wxss 里用 `.m-xxx …` 作用域。
 * 例：morph/glass 关掉时，对应的 `.m-glass` 类不会出现在根节点，玻璃样式自然失效。
 */
function enabledClassList() {
  return Object.keys(FLAGS).filter((k) => on(k)).map((k) => 'm-' + k);
}
function enabledClasses() {
  return enabledClassList().join(' ');
}

module.exports = {
  DUR,
  EASE,
  SPRING,
  FLAGS,
  spring,
  profile,
  on,
  setRemote,
  trans,
  dur,
  staggerDelay,
  enabledClassList,
  enabledClasses,
  clamp
};
