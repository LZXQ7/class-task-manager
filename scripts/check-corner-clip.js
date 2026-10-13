#!/usr/bin/env node
/**
 * 离线自检：圆角裁切容器一致性（v0.7.24 用户反馈）
 * ------------------------------------------------------------
 * 起因（2026-09-26 真机截图，用户报「收到的通知卡片四个角有灰色」+「回收站图标错位」）：
 *   ① 左滑容器 `.nt-item` / `.cl-swipe` 是 `overflow:hidden` 但**没有 border-radius**，
 *      内层卡片自己带 `border-radius`。两者边界不重合时，「方形裁切区 − 圆角卡片」之间
 *      那圈对角带里残留的是卡片自己的外投影 → 四角各显出一块偏暗的方形色斑。
 *      外投影还会被方形裁切整圈切掉，卡片因此失去「浮在内容之上」的层次。
 *      → 不变量：裁切层必须与卡片**同值圆角**，并由裁切层承担卡片的**外投影**。
 *   ② 左滑露出的删除区永远在卡片**后方**。卡片不透明白时静止态天然看不见它；
 *      换成半透明玻璃后粉底隔着卡片透上来（实拍卡片右三分之一泛粉）。
 *      → 不变量：删除区的可见性必须由「是否已左滑」驱动，静止态整块透明。
 *   ③ 回收站空态的图标 `<app-icon>` 渲染出来是 `display:block` 的 `<image>`，
 *      `text-align:center` **管不了块级子元素**，图标贴在左边距上。
 *      → 不变量：图标容器的水平居中必须由 `display:flex` + `align-items:center` 承担。
 *
 * ⚠️ 这三条都是**纯几何/层叠**问题：WXSS 能编译、门禁能全绿、类型检查一无所知，
 *    只有真机（或浏览器里按真实令牌复刻）才看得见。所以必须显式断言写法本身。
 * 用法：node scripts/check-corner-clip.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

const readMini = (rel) => fs.readFileSync(path.join(MINI, rel), 'utf8');

/** 剥注释：文本级判据一律先剥，否则注释里引用的违禁措辞会自己触发判据 */
function stripCss(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}
function stripWxml(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 取某个单类选择器的规则块。用**花括号配对**，不用「往后截 N 字符」——
 * 截窗口会把紧跟其后的下一条规则当成它的一部分，判据就失真了。
 * 只认「一行/多行选择器里恰好以 `.cls` 结尾或开头」的单类形态，避免命中
 * `.nt-del-zone.on` 这类复合选择器。
 */
function blockOf(css, cls) {
  const re = new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '\\s*\\{', 'g');
  let m;
  while ((m = re.exec(css))) {
    // 选择器必须以 `.cls` 作为独立选择器出现（前面不能是 . - _ 字母数字，也不能是另一个类名的一部分）
    const before = css.slice(Math.max(0, m.index - 1), m.index);
    if (/[A-Za-z0-9_-]/.test(before)) continue;   // 命中 .xxx-cls / .cls2 之类，跳过
    const open = m.index + m[0].length - 1;       // `{` 的下标（不吃掉）
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) return css.slice(open + 1, i);
      }
    }
    return '';
  }
  return '';
}

/** 取 wxml 里某个 class 的开标签整段（到第一个 `>` 为止） */
function tagWith(wxml, cls) {
  const re = new RegExp('<[a-z-]+[^>]*class="[^"]*\\b' + cls.replace(/[-]/g, '\\-') + '\\b[^"]*"[^>]*>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(wxml))) out.push(m[0]);
  return out;
}

const PAGE = {
  noticeWxss: stripCss(readMini('pages/notice/index.wxss')),
  noticeWxml: stripWxml(readMini('pages/notice/index.wxml')),
  classesWxss: stripCss(readMini('pages/classes/index.wxss')),
  classesWxml: stripWxml(readMini('pages/classes/index.wxml')),
  appWxss: stripCss(readMini('app.wxss')),
};

/* ------------------------------------------------------------------ */
/* C1  左滑裁切容器：与卡片同值圆角 + 自己承担外投影                       */
/* ------------------------------------------------------------------ */
console.log('--- C1 左滑裁切容器与卡片圆角一致（通知 / 班级） ---');
{
  const cases = [
    // 通知页卡片挂的是全局玻璃 `.card`（圆角在 app.wxss 里），所以有效圆角要跨文件取
    { name: '通知页', w: PAGE.noticeWxss, wxml: PAGE.noticeWxml, clip: 'nt-item', card: 'nt-card',
      cardGlobal: { css: PAGE.appWxss, cls: 'card' }, shadow: '--glass-shadow' },
    { name: '班级页', w: PAGE.classesWxss, wxml: PAGE.classesWxml, clip: 'cl-swipe', card: 'cl-card',
      cardGlobal: null, shadow: '--shadow-1' },
  ];
  for (const c of cases) {
    const clip = blockOf(c.w, c.clip);
    const card = blockOf(c.w, c.card);
    if (!clip || !card) {
      bad(`${c.name} 抽不出 .${c.clip} / .${c.card} 规则块`);
      continue;
    }
    // 裁切层必须真的在裁
    if (/(^|[;\s])overflow\s*:\s*hidden/.test(clip)) ok(`${c.name} .${c.clip} 仍是裁切层（左滑不会漏出卡片）`);
    else bad(`${c.name} .${c.clip} 不再是 overflow:hidden —— 左滑会漏出整块卡片`);

    // 有效圆角：卡片自己写了就用它，没写（挂全局 .card）就取全局那份
    let cardR = (/border-radius\s*:\s*([^;]+)/.exec(card) || [])[1];
    let src = `.${c.card}`;
    if (!cardR && c.cardGlobal) {
      const g = tagWith(c.wxml, c.card).some((t) => new RegExp('class="[^"]*\\b' + c.cardGlobal.cls + '\\b').test(t));
      if (!g) {
        bad(`${c.name} .${c.card} 没写圆角，也没挂全局 .${c.cardGlobal.cls} —— 取不到有效圆角`);
        continue;
      }
      cardR = (/border-radius\s*:\s*([^;]+)/.exec(blockOf(c.cardGlobal.css, c.cardGlobal.cls)) || [])[1];
      src = `全局 .${c.cardGlobal.cls}（${c.card} 元素实际挂的类）`;
    }
    const clipR = (/border-radius\s*:\s*([^;]+)/.exec(clip) || [])[1];
    if (clipR && cardR && clipR.trim() === cardR.trim()) {
      ok(`${c.name} .${c.clip} 圆角（${clipR.trim()}）= 卡片有效圆角（${cardR.trim()}，来源 ${src}）→ 四角缺口消失`);
    } else {
      bad(`${c.name} .${c.clip} 圆角（${clipR || '无'}）≠ 卡片有效圆角（${cardR || '无'}，来源 ${src}）→ 四角会留灰肩`);
    }

    // 外投影必须在裁切层身上（留在卡片上会被方形裁切整圈切掉）
    if (clip.includes(c.shadow)) ok(`${c.name} .${c.clip} 自己承担外投影（${c.shadow}）`);
    else bad(`${c.name} .${c.clip} 没有外投影 —— 卡片会失去层次`);

    // 卡片本文件里不得再画外投影
    if (!card.includes(c.shadow)) ok(`${c.name} .${c.card} 不再重复画外投影（避免双倍阴影 / 被裁掉后残留）`);
    else bad(`${c.name} .${c.card} 仍画着外投影 ${c.shadow}（会被裁切层切掉并残留在四角）`);
  }
}

/* ------------------------------------------------------------------ */
/* C2  删除区可见性由「是否已左滑」驱动                                    */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- C2 半透明卡片后方的删除区：静止态必须透明 ---');
{
  const cases = [
    { name: '通知页', wxml: PAGE.noticeWxml, css: PAGE.noticeWxss, cls: 'nt-del-zone', key: 'offset' },
    { name: '班级页', wxml: PAGE.classesWxml, css: PAGE.classesWxss, cls: 'cl-del', key: 'offset' },
  ];
  for (const c of cases) {
    const tags = tagWith(c.wxml, c.cls);
    if (!tags.length) { bad(`${c.name} 找不到 .${c.cls} 开标签`); continue; }
    const driven = tags.some((t) => new RegExp('\\{\\{\\s*item\\.' + c.key + '\\s*\\?[^}]*\\}\\}').test(t));
    if (driven) ok(`${c.name} .${c.cls} 的显隐由 item.${c.key} 驱动（静止态不参与渲染）`);
    else bad(`${c.name} .${c.cls} 没有按 item.${c.key} 驱动显隐 —— 半透明卡片会泛出粉底`);

    const base = blockOf(c.css, c.cls);
    if (/opacity\s*:\s*0\s*(;|$)/.test(base)) ok(`${c.name} .${c.cls} 静止态 opacity:0`);
    else bad(`${c.name} .${c.cls} 静止态不透明 —— 粉底会隔着卡片透上来`);

    const on = blockOf(c.css, c.cls + '.on');
    if (/opacity\s*:\s*1/.test(on)) ok(`${c.name} .${c.cls}.on 左滑后恢复不透明`);
    else bad(`${c.name} 缺少 .${c.cls}.on { opacity:1 }（左滑后删除区不显形）`);
  }
}

/* ------------------------------------------------------------------ */
/* C3  回收站空态：块级图标的居中必须由 flex 承担                          */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- C3 回收站空态图标居中（app-icon 是 block 的 image） ---');
{
  const b = blockOf(PAGE.noticeWxss, 'rc-empty');
  if (/display\s*:\s*flex/.test(b) && /align-items\s*:\s*center/.test(b)) {
    ok('.rc-empty 用 flex + align-items:center 承担居中（text-align 管不了块级 <image>）');
  } else {
    bad('.rc-empty 只靠 text-align:center —— block 的 <image> 图标会贴在左侧');
  }
  if (/flex-direction\s*:\s*column/.test(b)) ok('.rc-empty 纵向排列（图标 → 标题 → 副标题）');
  else bad('.rc-empty 未声明 flex-direction:column');
  // 图标确实是块级：app-icon 组件根节点就是 .app-icon{display:block}
  const iconCss = stripCss(readMini('components/app-icon/index.wxss'));
  if (/display\s*:\s*block/.test(blockOf(iconCss, 'app-icon'))) {
    ok('前提复核：.app-icon 是 display:block（所以 text-align:center 对它无效）');
  } else {
    bad('前提变了：.app-icon 不再 display:block，C3 的判据需要重新推导');
  }
}

/* ------------------------------------------------------------------ */
/* 自证：坏样本必须被判据抓住（否则判据只是「恰好通过」）                    */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- 自证（变异样本必须翻红） ---');
{
  // ① 旧写法：裁切层无圆角、无投影、卡片自己画投影
  const oldClip = '.nt-item { position: relative; overflow: hidden; margin: 16rpx 32rpx 0; }';
  const clipR = (/border-radius\s*:\s*([^;]+)/.exec(blockOf(oldClip, 'nt-item')) || [])[1];
  if (!clipR) ok('自证①：旧 .nt-item（无 border-radius）能被判为「圆角不一致」');
  else bad('自证①失败：旧样本被误判为有圆角');

  const oldCardShadow = '.nt-card { padding: 20rpx; box-shadow: var(--glass-shadow), var(--glass-highlight); }';
  if (blockOf(oldCardShadow, 'nt-card').includes('--glass-shadow')) {
    ok('自证②：卡片自带外投影的旧写法能被判为「重复画投影」');
  } else bad('自证②失败：卡片自带投影的样本没被识别');

  // ③ 旧写法：删除区没有按滑动量驱动
  const oldTag = '<view class="nt-del-zone" data-id="{{item.id}}" bindtap="onDelete">';
  const driven = tagWith(oldTag, 'nt-del-zone').some((t) => /\{\{\s*item\.offset\s*\?[^}]*\}\}/.test(t));
  if (!driven) ok('自证③：不带 item.offset 绑定的旧删除区能被判为「静止态会泛粉」');
  else bad('自证③失败：旧删除区样本没被识别');

  // ④ 旧写法：回收站空态只有 padding + text-align
  const oldEmpty = '.rc-empty { padding: 80rpx 32rpx; text-align: center; }';
  const b2 = blockOf(oldEmpty, 'rc-empty');
  if (!/display\s*:\s*flex/.test(b2)) ok('自证④：旧 .rc-empty（无 flex）能被判为「图标不居中」');
  else bad('自证④失败：旧空态样本被误判为已居中');

  // ⑤ 判据不能命中注释（本文件注释里就写着 .nt-del-zone / .rc-empty 这些名字）
  const withComment = '/* .nt-item { border-radius: var(--r-md) } .rc-empty { display:flex } */\n.nt-item { overflow: hidden; }';
  const cleaned = stripCss(withComment);
  if (!/border-radius/.test(cleaned) && !/display\s*:\s*flex/.test(cleaned)) {
    ok('自证⑤：剥注释后，注释里写着的圆角/flex 不会被当成真代码');
  } else bad('自证⑤失败：判据命中了注释内容');
}

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
}
console.log('✅ 圆角裁切容器一致性检查全部通过');
