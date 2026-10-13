#!/usr/bin/env node
/**
 * 离线自检：通知页动效（2026-09-26 / v0.7.13）
 * ------------------------------------------------------------
 * 需求② 回收站：左滑删除后卡片**沿曲线**飞向右下角回收站图标，
 *              缩小、旋转后进入；回收站可查看、可一键恢复。
 * 需求③ 堆叠：通知过多时，划过顶部的卡片逐层压成一摞，层级和大小表示浏览进度。
 *
 * 这两个动效的**失败模式几乎全是静默的** —— 代码能跑、不报错，只是效果不对：
 *   · 曲线没了：X 与 Y 放在同一个元素上，只能共用一条 timing-function → 变成直线；
 *   · 动画没了：把「挂过渡」和「给目标位移」塞进同一次 setData → 根本不会起过渡（瞬移）；
 *   · 时长对不上：CSS .52s 与 JS FLY_MS 不一致 → 卡片还没飞完就被摘掉（或反过来）；
 *   · 堆错位：量位置时直接拿 rect.top + scrollTop → 卡片被 sticky 钉住后这个值是假的；
 *   · 露不出层：忘了 transform-origin: 50% 0 → 缩小时往中间缩，上面那层被盖死。
 *
 * 用法：node scripts/check-notice-motion.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (rel) => fs.readFileSync(path.join(MINI, rel), 'utf8');
const readCf = (rel) => fs.readFileSync(path.join(ROOT, 'cloudfunctions', rel), 'utf8');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : bad(m));

const num = (src, re) => { const m = re.exec(src); return m ? Number(m[1]) : NaN; };
const durMs = (src, re) => { const m = re.exec(src); return m ? Number('0.' + m[1]) * 1000 : NaN; };

const ntJs = read('pages/notice/index.js');
const ntWxml = read('pages/notice/index.wxml');
const ntWxss = read('pages/notice/index.wxss');
const media = readCf('media/index.js');
const apiJs = read('utils/api.js');

/* ================================================================== */
console.log('── 需求② 回收站：后端能列出 / 能恢复');
/* ================================================================== */
{
  chk(/msgRecycleList:\s*C\('media',\s*'msgRecycleList'\)/.test(apiJs)
    && /msgRestore:\s*C\('media',\s*'msgRestore'\)/.test(apiJs),
    'api.js 注册 msgRecycleList / msgRestore');

  const rl = /msgRecycleList:\s*\{[\s\S]*?\n  \},/.exec(media);
  const rs = /msgRestore:\s*\{[\s\S]*?\n  \},/.exec(media);
  chk(!!rl && /needBind:\s*true/.test(rl[0]), 'media.msgRecycleList 需要已绑定');
  chk(!!rs && /needBind:\s*true/.test(rs[0]), 'media.msgRestore 需要已绑定');
  chk(!!rl && /FROM notice_msg_delete[\s\S]{0,200}WHERE d\.member_id = \?/.test(rl[0]),
    '回收站 = 反查 notice_msg_delete（软删除那张表，不额外建表）');
  chk(!!rl && /JOIN notice_msg n ON n\.id = d\.notice_id/.test(rl[0]),
    '回收站列表带出通知正文 / 发布人（否则弹层里只剩一个 id）');
  chk(!!rs && /DELETE FROM notice_msg_delete WHERE notice_id = \? AND member_id = \?/.test(rs[0]),
    '恢复 = 删掉 notice_msg_delete 那一行（只影响自己）');
  chk(!!rs && /if \(!r\.affectedRows\) throw/.test(rs[0]),
    '恢复一条不在回收站里的通知会报错（防越权 / 防重复点击误判成功）');
}

/* ================================================================== */
console.log('\n── 需求② 回收站入口：右下角 + 角标');
/* ================================================================== */
{
  chk(/class="nt-trash/.test(ntWxml) && /bindtap="onTrashOpen"/.test(ntWxml),
    '通知页右下角有回收站入口（.nt-trash → onTrashOpen）');
  chk(/nt-trash-badge/.test(ntWxml) && /recycleCount/.test(ntJs),
    '回收站有角标（显示可回收条数，否则用户不知道里面有没有东西）');
  const fab = /\.nt-trash\s*\{([^}]*)\}/.exec(ntWxss);
  chk(!!fab && /position:\s*fixed/.test(fab[1]), '回收站是 fixed（贴在视口右下角）');
  const fabZ = num(ntWxss, /\.nt-trash\s*\{[^}]*z-index:\s*(\d+)/);
  const flyZ = num(ntJs, /z-index:(\d+)'\s*\],\s*\n?\s*\}\)/) || num(ntJs, /'z-index:(\d+)'/);
  chk(fabZ > (flyZ || 0), '回收站层级（' + fabZ + '）高于飞行卡片（' + flyZ
    + '）→ 卡片是「钻进」垃圾桶，而不是盖在它上面');
  chk(fabZ < 900, '回收站层级低于 tabBar（900），不会挡住底部导航');
  chk(/\.nt-trash\.on\s*\{[^}]*transform:\s*scale/.test(ntWxss)
    && /trashPulse/.test(ntJs),
    '卡片飞进来时垃圾桶「接一下」（缩放脉冲），让落点看得见');
}

/* ================================================================== */
console.log('\n── 需求② 曲线飞入：两层不同时序（这是「曲线」的关键）');
/* ================================================================== */
{
  const fx = (/\.nt-fly-x\s*\{([^}]*)\}/.exec(ntWxss) || [])[1] || '';
  const fy = (/\.nt-fly-y\s*\{([^}]*)\}/.exec(ntWxss) || [])[1] || '';
  chk(!!fx && !!fy, '有 .nt-fly-x（横向）与 .nt-fly-y（纵向）两条规则');
  chk(/transition:[^;]*transform\s*\.52s\s*linear/.test(fx),
    '横向是 **linear**（匀速）');
  chk(/transition:[^;]*transform\s*\.52s\s*cubic-bezier/.test(fy),
    '纵向是 **cubic-bezier**（越走越快）—— 两条曲线不同才合成得出弧线');
  chk(fx !== fy, '两条规则的时序曲线确实不同（若相同 → 合成出来是直线，不是曲线）');

  /* 两层必须挂在**不同元素**上：同一个元素上 X 与 Y 只能共用一条 timing-function */
  chk(/class="nt-wrap[^"]*nt-fly-x/.test(ntWxml) || /nt-fly-x/.test(ntWxml),
    '.nt-fly-x 挂在外层 .nt-wrap');
  chk(/class="nt-item[^"]*nt-fly-y/.test(ntWxml), '.nt-fly-y 挂在内层 .nt-item');
  const wrapHasY = /class="nt-wrap[^"]*nt-fly-y/.test(ntWxml);
  const itemHasX = /class="nt-item[^"]*nt-fly-x/.test(ntWxml);
  chk(!wrapHasY && !itemHasX, '两条 class 分别挂在不同层（挂在同一层 = 退化成直线）');

  const FLY_MS = num(ntJs, /const\s+FLY_MS\s*=\s*(\d+)/);
  chk(durMs(ntWxss, /\.nt-fly-x\s*\{[^}]*transition:\s*transform\s*\.(\d+)s/) === FLY_MS,
    '.nt-fly-x 时长 == JS FLY_MS（' + FLY_MS + 'ms）');
  chk(durMs(ntWxss, /\.nt-fly-y\s*\{[^}]*transition:\s*transform\s*\.(\d+)s/) === FLY_MS,
    '.nt-fly-y 时长 == JS FLY_MS（' + FLY_MS + 'ms）');

  /* 缩小 + 旋转 + 淡出，且起点是「卡片当前位置」 */
  chk(/scale\(\.14\)\s*rotate\(26deg\)/.test(ntJs) && /opacity:0/.test(ntJs),
    '终点是「缩小 + 旋转 + 淡出」（scale .14 / rotate 26deg / opacity 0）');
  chk(/selectAll\('\.nt-card'\)\.boundingClientRect/.test(ntJs)
    && /select\('\.nt-trash'\)\.boundingClientRect/.test(ntJs),
    '起点按**卡片当前实际位置**算、终点按回收站图标位置算（不写死坐标，换机型也对）');
}

/* ================================================================== */
console.log('\n── 需求② 两拍 setData（不然过渡根本不会起）');
/* ================================================================== */
{
  const body = (/_flyToTrash\(index, done\) \{[\s\S]*?\n  \},/.exec(ntJs) || [])[0] || '';
  chk(!!body, '页面有 _flyToTrash');
  /* 第 1 拍 setData 带回调，回调里再来一次 setData 给目标位移 */
  chk(/this\.setData\(\{[\s\S]*?\},\s*\(\)\s*=>\s*\{[\s\S]*?this\.setData\(\{/.test(body),
    '过渡 class 与「目标位移」分两拍 setData（同一拍 → before-change 样式里没有 transition → 瞬移）');
  chk(/flying'\]\s*:\s*true/.test(body) && /translateX\(/.test(body) && /translateY\(/.test(body),
    '第 1 拍只挂 flying（此时无位移），第 2 拍才给 X/Y 目标值');

  /* 动画播完才把卡片从数据源摘掉 */
  chk(/Promise\.all\(\[[\s\S]{0,80}req[\s\S]{0,200}_flyToTrash/.test(ntJs),
    '等「动画播完」+「删除请求回来」两件事都完成才移除卡片（动画没播完就摘 = 卡片凭空消失）');
  chk(/_flyBack\s*\(/.test(ntJs) && /删除失败/.test(ntJs),
    '删除失败会把卡片飞回原位（不是留一个洞，也不是硬弹）');
}

/* ================================================================== */
console.log('\n── 需求② 回收站弹层：可查看 + 可恢复');
/* ================================================================== */
{
  chk(/<bottom-sheet[^>]*show="\{\{recycleShow\}\}"/.test(ntWxml), '回收站是一个 bottom-sheet 弹层');
  chk(/onRestore/.test(ntWxml) && /api\.msgRestore\(/.test(ntJs), '弹层里可一键恢复（onRestore → msgRestore）');
  chk(/rc-empty/.test(ntWxml), '回收站为空时有空态说明（告诉用户东西是怎么进来的）');
  // 滚动穿透防护：弹层（回收站 / 图片查看器）打开时锁页面滚动。
  // 表达式可写成 `recycleShow ? ...`（旧）或 `(recycleShow || viewerShow) ? ...`（v0.7.14 加了图片查看器），
  // 只要引用了 recycleShow 且会置 overflow:hidden 即判通过。
  chk(/<page-meta[^>]*page-style="\{\{(?:\(recycleShow[^}]*\)|recycleShow)[^}]*?\? 'overflow:hidden' : ''\}\}"/.test(ntWxml),
    '弹层打开时锁页面滚动（page-meta，滚动穿透防护）');
  chk(/this\.load\(\);\s*\/\/.*恢复/.test(ntJs) || /已恢复[\s\S]{0,200}this\.load\(\)/.test(ntJs),
    '恢复后主列表重新拉一次（否则恢复完在列表里看不见）');
  chk(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nt-fly-x[\s\S]*?\.nt-fly-y/.test(ntWxss),
    '开启「减少动态效果」时飞行退化为瞬时（无障碍兜底）');
}

/* ================================================================== */
console.log('\n── 需求③ 卡片堆叠（渐进增强：不改列表结构）');
/* ================================================================== */
{
  const STACK_MIN = num(ntJs, /const\s+STACK_MIN\s*=\s*(\d+)/);
  const MAX_STACK = num(ntJs, /const\s+MAX_STACK\s*=\s*(\d+)/);
  const TOP = num(ntJs, /const\s+STACK_TOP_RPX\s*=\s*(\d+)/);
  const STEP = num(ntJs, /const\s+STACK_STEP_RPX\s*=\s*(\d+)/);

  chk(STACK_MIN > 0 && MAX_STACK > 1, '堆叠参数齐全（STACK_MIN=' + STACK_MIN + ' / MAX_STACK=' + MAX_STACK + '）');
  chk(/list\.length > STACK_MIN/.test(ntJs),
    '只有「通知过多」时才堆（短列表堆起来反而挡视线）');
  chk(/onPageScroll\s*\(e\)/.test(ntJs) && /this\._applyPile\(st\)/.test(ntJs),
    '堆叠由页面滚动驱动（onPageScroll → _applyPile）');
  chk(/if \(passed === this\._passed\) return;/.test(ntJs),
    '只有「堆的张数变了」才 setData（每帧都 setData 会把滚动拖垮）');

  const ap = (/_applyPile\(scrollTop\) \{[\s\S]*?\n  \},/.exec(ntJs) || [])[0] || '';
  chk(/position:sticky/.test(ap), '堆里的卡片用 sticky 钉住（这才叫「到顶层后停留」）');
  chk(/top:' \+ \(STACK_TOP_RPX - d \* STACK_STEP_RPX\)/.test(ap),
    '越深的层钉得越高（逐层往上错开，露得出下面那摞）');
  chk(/z-index:' \+ \(MAX_STACK - d\)/.test(ap),
    '越深的层层级越低（最新的那张在最上面）');
  chk(/scale\(' \+ \(1 - d \* STACK_SCALE\)/.test(ap) && /opacity:' \+ \(1 - d \* STACK_DIM\)/.test(ap),
    '越深的层越小越暗（层级和大小表示浏览进度）');
  chk(/transform-origin:50% 0/.test(ap),
    'transform-origin: 50% 0 —— 缩小时贴着顶边缩，上面那层才露得出来（用默认中心点会被盖死）');
  chk(/if \(list\[i\]\.flying\) continue;/.test(ap),
    '正在飞向回收站的卡片不参与堆叠（否则两个 transform 会互相覆盖）');

  chk(TOP - (MAX_STACK - 1) * STEP >= 0,
    '最深那层也钉在屏幕内（top ' + (TOP - (MAX_STACK - 1) * STEP) + 'rpx >= 0）—— 负的会被切掉');
  const wrapZ = num(ntWxss, /\.nt-wrap\s*\{[^}]*z-index:\s*(\d+)/);
  chk(wrapZ > MAX_STACK,
    '没进堆的卡片层级（' + wrapZ + '）高于堆里的最大层级（' + MAX_STACK
    + '）→ 后面的卡是「压上来」而不是从堆底钻过去');

  /* 量位置的坑：钉住之后 rect.top 是假的 */
  chk(/if \(!this\._passed\) this\._baseTop = rects\[0\]\.top \+ st;/.test(ntJs),
    '只在「一张都没钉住」时记录首卡自然位置（钉住后 rect.top 是钉住位置，不是自然位置）');
  chk(/acc \+= \(rects\[i\]\.height \|\| 0\) \+ gap;/.test(ntJs),
    '其余位置用「上一张 + 高度 + 间距」往下推（高度不受 sticky 影响，滚到一半也量得准）');
  chk(/_restackSoon\(\)/.test(ntJs) && /_restack\(\)/.test(ntJs),
    '展开 / 收起正文后重新量一次（卡片高度变了，堆的位置要跟着变）');
}

/* ================================================================== */
console.log('\n── 双向自证');
/* ================================================================== */
{
  const sameCurve = '.nt-fly-x { transition: transform .52s linear; }\n'
    + '.nt-fly-y { transition: transform .52s linear; }';
  const fx0 = (/\.nt-fly-x\s*\{([^}]*)\}/.exec(sameCurve) || [])[1];
  const fy0 = (/\.nt-fly-y\s*\{([^}]*)\}/.exec(sameCurve) || [])[1];
  chk(fx0 === fy0, '自证：两条曲线写成一样的样本会被判「退化成直线」');

  const oneShot = 'this.setData({ a: 1, b: 2 });';
  chk(!/\},\s*\(\)\s*=>\s*\{[\s\S]*?this\.setData\(\{/.test(oneShot),
    '自证：一次性 setData（无回调）不会被误判成「分两拍」');

  const noOrigin = 'position:sticky;top:40rpx;z-index:3;transform:scale(.92)';
  chk(!/transform-origin:50% 0/.test(noOrigin), '自证：漏了 transform-origin 的样本会被抓到');

  const deep = { TOP: 40, STEP: 16, MAX: 5 };
  chk(deep.TOP - (deep.MAX - 1) * deep.STEP < 0,
    '自证：层数过多把最深那层顶到屏幕外的参数组合会被抓到');
}

console.log('');
if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
console.log('✅ 通知页动效（回收站 / 曲线飞入 / 卡片堆叠）校验通过');
