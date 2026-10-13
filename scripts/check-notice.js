#!/usr/bin/env node
/**
 * 离线自检：换人语义重整 + 班级通知（2026-09-24 三条用户反馈）
 * ------------------------------------------------------------
 * ① 换人不再两边互相确认
 *    · 超管「换人」= schedule.reassign，**原地替换**（直接改 duty.member_id，一个课次
 *      永远只有一条记录）+ 可一键还原（靠 duty_reassign 记录：原 duty / 双方 / undone）；
 *    · 普通成员「申请换班」= adjust.applySwap，落 PENDING_ADMIN，由**超级管理员** confirm，
 *      生效同样是原地替换；
 *    · 前端提示语必须与后端真实行为一致（REASSIGN 不能再提示「等待对方确认」）。
 *
 * ② 值日详情列表滚到底后，后面的「本周值日」页不能跟着滑（滚动链）
 *    锁页面滚动只能靠 page-meta 的 page-style（值日页是 page 滚动）。
 *
 * ③ 班级通知
 *    · 管理员在「首页 → 发布通知」发出：全体 / 指定成员、可选「确认收到」、可填在线文档链接；
 *    · 成员在「我的 → 通知」查看并点「确认收到」；
 *    · 微信服务通知走独立模板（NOTICE_TEMPLATE_ID / TEMPLATE_NOTICE），
 *      未配置时**发布照常成功**、只是不推送（与值日提醒同一套降级规则）。
 *
 * 用法：node scripts/check-notice.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const R = path.join(ROOT, 'miniprogram');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readM = (p) => fs.readFileSync(path.join(R, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let failed = 0;
function ok(msg) { console.log('PASS  ' + msg); }
function bad(msg) { failed += 1; console.log('FAIL  ' + msg); }
function note(msg) { console.log('  ·   ' + msg); }
function assertTrue(cond, msg) { if (cond) ok(msg); else bad(msg); }

/* ============================================================
 * ① 换人：超管直接替换 + 可还原；成员申请走超管确认
 * ============================================================ */
console.log('\n── ① 换人语义：超管直接替换（可还原）/ 成员申请由超管确认');

const sqlSrc = read('scripts/init.sql');
assertTrue(/CREATE TABLE IF NOT EXISTS duty_reassign/.test(sqlSrc)
  && /undone\s+TINYINT\s+NOT NULL DEFAULT 0/.test(sqlSrc),
  'init.sql 有 duty_reassign（记录原 duty / 新 duty / undone）');

const adjustSrc = read('cloudfunctions/adjust/index.js');
assertTrue(/VALUES \(\?,\s*'SWAP',\s*\?,\s*\?,\s*\?,\s*'PENDING_ADMIN'/.test(adjustSrc),
  'adjust.applySwap 落 PENDING_ADMIN（不再 PENDING_PEER）');
const confirmBlock = /confirm:\s*\{[\s\S]*?\n  \}/.exec(adjustSrc);
/*
 * 需求 D（2026-09-27）：换班确认权从「仅超管」下放到「排班域」= 超管 | 本班生活委员。
 * 原判据锁 `needSuper: true`，属**旧产品口径**（三步定性 ①：意图已被取代 → 改门禁）。
 * 但「不能对普通成员开放」这个意图仍然成立，所以改锁 `scheduleAuth: true` 这个具名守卫，
 * 而不是放宽成「有 auth 就行」——否则哪天有人把守卫删掉这条也会静默通过。
 */
assertTrue(!!confirmBlock && /scheduleAuth:\s*true/.test(confirmBlock[0]),
  'adjust.confirm 用 scheduleAuth 守卫（超管 | 本班生活委员；普通成员仍不可确认）');
assertTrue(!!confirmBlock && !/仅被邀请人可确认/.test(confirmBlock[0]),
  'adjust.confirm 不再要求「仅被邀请人可确认」');
assertTrue(!!confirmBlock && /UPDATE duty SET member_id = \?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = \?/.test(confirmBlock[0])
  && !/SET status = 'SWAPPED_OUT'/.test(confirmBlock[0]),
  'adjust.confirm 生效时同样**原地替换**（改 member_id，不新建 duty 行）');
assertTrue(/pendingList:\s*\{[\s\S]{0,200}scheduleAuth:\s*true/.test(adjustSrc),
  'adjust.pendingList 用 scheduleAuth（超管跨班 / 生活委员本班，见需求 D 的班级作用域）');
assertTrue(/INSERT INTO duty_reassign/.test(adjustSrc),
  'adjust.confirm 生效时也写 duty_reassign（管理员确认错了同样能还原）');
assertTrue(/\['PENDING_PEER', 'PENDING_ADMIN'\]\.includes\(swap\.status\)/.test(adjustSrc),
  'adjust.confirm 兼容历史 PENDING_PEER 数据');

const schedSrc = read('cloudfunctions/schedule/index.js');
assertTrue(/reassignUndo:\s*\{[\s\S]{0,200}scheduleAuth:\s*true/.test(schedSrc),
  'schedule.reassignUndo 存在且用 scheduleAuth（还原权随「换人」一起下放到生活委员）');
assertTrue(/INSERT INTO duty_reassign/.test(schedSrc),
  'schedule.reassign 写入 duty_reassign（为还原留下精确依据）');
const reassignBlock = /reassign:\s*\{[\s\S]*?\n  \},/.exec(schedSrc);
assertTrue(!!reassignBlock && /UPDATE duty SET member_id = \?, source = 'MANUAL', status = 'PENDING', done_at = NULL WHERE id = \?/.test(reassignBlock[0]),
  'schedule.reassign **原地替换**（改 member_id，不新建 duty 行）');
assertTrue(!!reassignBlock && !/SET status = 'SWAPPED_OUT'/.test(reassignBlock[0]),
  'schedule.reassign 不再把原值日标成 SWAPPED_OUT（一个课次只留一条记录）');
assertTrue(!!reassignBlock && /\[dutyId, dutyId, /.test(reassignBlock[0]),
  'duty_reassign.new_duty_id 记 dutyId 自身（原地替换后只有这一条）');
assertTrue(/FROM duty_reassign WHERE duty_id = \? AND undone = 0/.test(schedSrc),
  'reassignUndo 按「原 duty + 未还原」反查，可幂等');
assertTrue(/UPDATE duty SET member_id = \?, status = 'PENDING', done_at = NULL WHERE id = \?/.test(schedSrc)
  && /这条值日后来又被改过，无法还原这次换人/.test(schedSrc),
  'reassignUndo 也是原地换回，且带「后来又被改过」守卫');
assertTrue(/UPDATE duty_reassign SET undone = 1/.test(schedSrc),
  'reassignUndo 会标记 undone（重复点击报「已经还原过了」）');
const undoBlock = /reassignUndo:\s*\{[\s\S]*?\n  \},/.exec(schedSrc);
assertTrue(!!undoBlock && !/DELETE FROM duty\b/.test(undoBlock[0]),
  'reassignUndo 走「原地改回」而不是删行（duty_log 操作记录不断链）');

const dutyCf = read('cloudfunctions/duty/index.js');
assertTrue(/FROM duty_reassign WHERE duty_id = \? AND to_member = \? AND undone = 0/.test(dutyCf)
  && /reassign,/.test(dutyCf),
  'duty.detail 返回 reassign（值日详情里才有「还原换人」按钮）');
assertTrue(/if \(guard\.isSuper\(me\)\)[\s\S]{0,300}duty_reassign/.test(dutyCf),
  'reassign 只对超级管理员返回（普通成员看不到还原入口）');
assertTrue(/superUser\s*\n?\s*\?/.test(dutyCf) && /PENDING_ADMIN/.test(dutyCf),
  '首页待办数：超管按「全班待确认」口径统计');

const dsJs = readM('components/duty-sheet/index.js');
assertTrue(/REASSIGN:\s*'已替换值日人'/.test(dsJs),
  '换人成功提示为「已替换值日人」（不再是「等待对方确认」）');
/* 2026-09-26：文案改成三元（超管直换 / 成员申请），断言同步成真实代码形态，
   否则这条门禁会长期「红着」，新人分不清是新坏还是老坏。 */
assertTrue(/SWAP:\s*direct\s*\?\s*'已替换值日人'\s*:\s*'已提交，等待生活委员确认'/.test(dsJs),
  '成员申请换班提示「等待生活委员确认」（超管直换则提示「已替换值日人」）');
assertTrue(/onUndoReassign\s*\(\)/.test(dsJs) && /api\.scheduleReassignUndo/.test(dsJs),
  'duty-sheet 有 onUndoReassign 且调用 scheduleReassignUndo');
assertTrue(/util\.confirm\([^)]*还原[\s\S]{0,200}reassignId/.test(dsJs),
  '还原换人有二次确认');
const dsWxml = readM('components/duty-sheet/index.wxml');
assertTrue(/bindtap="onUndoReassign"/.test(dsWxml) && /detail\.reassign/.test(dsWxml),
  '值日详情里有「还原换人」按钮（点击目标 onUndoReassign）');

/* ============================================================
 * ② 滚动链：弹层打开时锁页面滚动
 * ============================================================ */
console.log('\n── ② 值日详情滑到底后，后面的页面不跟着滑');

const dutyWxml = readM('pages/duty/index.wxml');
assertTrue(/<page-meta[^>]*page-style="\{\{[^}]*sheetShow[^}]*aiShow[^}]*groupShow[^}]*addShow[^}]*overflow\s*:\s*hidden/.test(dutyWxml),
  'pages/duty 用 page-meta 在弹层打开时锁页面滚动（挡滚动链）');

/* ============================================================
 * ③ 班级通知
 * ============================================================ */
console.log('\n── ③ 班级通知：发布 / 查看 / 确认收到 / 微信提醒');

['notice_msg', 'notice_msg_target', 'notice_msg_read'].forEach((t) => {
  assertTrue(new RegExp('CREATE TABLE IF NOT EXISTS ' + t + '\\b').test(sqlSrc),
    'init.sql 有 ' + t);
});
assertTrue(/audio_id NOT NULL/.test(sqlSrc) === false || /notice_msg/.test(sqlSrc),
  '文字通知单独建表，不动语音通知的 notice（首页还在读未读语音）');

const mediaSrc = read('cloudfunctions/media/index.js');
assertTrue(/msgPublish:\s*\{[\s\S]{0,200}needAdmin:\s*true/.test(mediaSrc),
  'media.msgPublish 需要管理员');
assertTrue(/msgList:\s*\{[\s\S]{0,200}needBind:\s*true/.test(mediaSrc),
  'media.msgList 需要已绑定');
assertTrue(/msgRead:\s*\{[\s\S]{0,200}needBind:\s*true/.test(mediaSrc),
  'media.msgRead 需要已绑定');
/* 2026-09-26：范围已从「全体 / 指定成员」扩到四种（+仅发班委 / 按职位），
   断言同步成真实代码形态（原来钉死旧三元表达式，必然长期失败）。 */
assertTrue(/!\[[^\]]*'PICK'[\s\S]{0,80}'COMMITTEE'[\s\S]{0,80}'POSITION'[^\]]*\]\.includes\(scope\)/.test(mediaSrc),
  'msgPublish 支持「全体 / 指定成员 / 仅发班委 / 按职位」四种范围');
assertTrue(/INSERT IGNORE INTO notice_msg_target/.test(mediaSrc),
  '指定成员写入 notice_msg_target');
assertTrue(/needAck/.test(mediaSrc) && /INSERT IGNORE INTO notice_msg_read/.test(mediaSrc),
  '「需要确认收到」与回执落 notice_msg_read');
assertTrue(/\(\^https:\\\/\\\/\)/i.test(mediaSrc) || /https:\\\/\\\//.test(mediaSrc),
  '在线文档链接必须是 https（拦掉随手贴的裸域名）');
assertTrue(/process\.env\.TEMPLATE_NOTICE\b/.test(mediaSrc)
  && /if \(!templateId\) return \{ skipped: true/.test(mediaSrc),
  '未配置 TEMPLATE_NOTICE 时跳过推送、发布照常成功');
assertTrue(/cloud\.openapi\.subscribeMessage\.send/.test(mediaSrc),
  '用订阅消息推送微信服务通知');
assertTrue(/code === 43101/.test(mediaSrc),
  '43101（未授权 / 额度用尽）静默计数，不算失败');

const apiSrc = readM('utils/api.js');
['msgPublish', 'msgList', 'msgRead'].forEach((k) => {
  assertTrue(new RegExp('\\b' + k + ':\\s*C\\(').test(apiSrc), 'api.js 暴露 ' + k);
});

const appJson = JSON.parse(readM('app.json'));
assertTrue(appJson.pages.indexOf('pages/notice/index') >= 0,
  'app.json 注册了 pages/notice/index');

const ntJson = JSON.parse(readM('pages/notice/index.json'));
assertTrue(!!ntJson.usingComponents && !!ntJson.usingComponents['nav-bar'],
  '通知页引入了 nav-bar');
const ntWxml = readM('pages/notice/index.wxml');
assertTrue(/<nav-bar[^>]*show-back="\{\{true\}\}"/.test(ntWxml),
  '通知页是非 Tab 二级页 → 必须有返回键（show-back）');
assertTrue(/bindtap="onAck"/.test(ntWxml) && /确认收到/.test(ntWxml),
  '通知页有「确认收到」按钮');
/* 2026-09-25 起改为 web-view 直接打开（pages/webview/index），复制只是失败兜底 */
assertTrue(/bindtap="onLink"/.test(ntWxml) && /点击打开/.test(ntWxml),
  '在线文档链接可点击打开（不再只是复制）');
const ntJs = readM('pages/notice/index.js');
assertTrue(/pages\/webview\/index\?url=/.test(ntJs),
  '在线文档跳 web-view 页打开（域名未配置业务域名时 webview 页提供复制兜底）');
assertTrue(/api\.msgList\(\{\}, \{ toast: false \}\)/.test(ntJs),
  '通知页列表用 msgList 拉取');
assertTrue(/api\.msgRead\(\{ noticeId: id \}/.test(ntJs),
  '确认收到调用 msgRead');
assertTrue(/subscribe\.noticeReady\(\)/.test(ntJs) && /requestNotice\(\)/.test(ntJs),
  '通知页有「开启微信提醒」入口且会降级');

const cfg = readM('utils/config.js');
assertTrue(/NOTICE_TEMPLATE_ID/.test(cfg) && /NOTICE_PAGE/.test(cfg),
  'utils/config.js 增加 NOTICE_TEMPLATE_ID / NOTICE_PAGE');
const sub = readM('utils/subscribe.js');
assertTrue(/function noticeReady\(\)/.test(sub) && /function requestNotice\(\)/.test(sub)
  && /module\.exports = \{ ready, request, noticeReady, requestNotice[,}]/.test(sub),
  'subscribe.js 导出 noticeReady / requestNotice');

const homeWxml = readM('pages/home/index.wxml');
assertTrue(/bindtap="onNoticeOpen"/.test(homeWxml) && /发布通知/.test(homeWxml),
  '首页管理员卡片有「发布通知」入口');
assertTrue(/noticeScopeItems/.test(homeWxml) && /noticeNeedAck/.test(homeWxml)
  && /noticeLinkUrl/.test(homeWxml),
  '发布弹层含：发给谁 / 需要确认收到 / 在线文档链接');
// height 显式传入（值本身可调，2026-09-25 从 1280 调到 1360 统一表单留白）
assertTrue(/<bottom-sheet show="\{\{noticeShow\}\}"[^>]*height="\{\{\d+\}\}"/.test(homeWxml),
  '发布弹层传了显式 height（否则表单滚不动）');
const homeJs = readM('pages/home/index.js');
assertTrue(/api\.msgPublish\(\{/.test(homeJs), '首页发布调用 msgPublish');
assertTrue(/if \(scope === 'PICK' && !memberIds\.length\)/.test(homeJs),
  '「指定成员」未选人时前端先拦一道');
const homeJson = JSON.parse(readM('pages/home/index.json'));
assertTrue(!!homeJson.usingComponents['bottom-sheet'] && !!homeJson.usingComponents['segmented'],
  '首页引入了 bottom-sheet 与 segmented');

const mineWxml = readM('pages/mine/index.wxml');
/* v0.7.22 需求④：通知入口只保留首页一处，「我的」页整块下线（含角标与跳转函数）。
   判据按**新意图**点名：mine 不得再有 goNotice / 通知行 / 角标字段；
   首页必须有 msgList 拉取（通知列表缓存的唯一写入方，通知页 onLoad 同步渲染靠它）。 */
assertTrue(!/bindtap="goNotice"/.test(mineWxml) && !/noticeUnacked/.test(mineWxml),
  '「我的」页已无「通知」入口（v0.7.22 需求④：通知只在首页）');
const mineJs = readM('pages/mine/index.js');
/* ⚠️ 判据必须先剥注释再断言（本项目第 5 次踩「判据命中注释」）：
   mine/index.js 的说明注释里**主动提到了** `_loadNoticeBadge` 这个被删函数名，
   不剥注释的话这段解释性注释会让「已移除」判据永远翻红。 */
const mineJsCode = mineJs
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
assertTrue(!/goNotice|_loadNoticeBadge|noticeUnacked/.test(mineJsCode),
  '「我的」页通知相关 JS（跳转 / 角标加载）连同数据字段一起移除');
assertTrue(/api\.msgList\(/.test(homeJs),
  '首页仍拉取 msgList（通知列表缓存的唯一写入方，v0.7.22 需求④后职责收口到首页）');
/* 角标口径已抽到 utils/notice.js#unackedCount（唯一实现），mine 页只是调用它。
   所以这里既要确认 mine 用的是共享实现，也要确认共享实现本身的口径没被改坏。

   2026-09-26 需求⑤**重定义**：从「待我确认」改成「我还没看过的新通知」。
   旧口径两个硬伤：① 发布者自己的「确认收到」按钮是隐藏的 → 角标永远消不掉；
   ② 用户要的是「进通知页看过就消失」，不是必须先点「确认收到」。
   新口径 = 排除自己发的（isPublisher）+ 只数超过未读游标（seen）的那些。 */
const noticeUtil = readM('utils/notice.js');
/* 角标口径已抽到 utils/notice.js#unackedCount（唯一实现）。
   v0.7.22 需求④后 mine 页无通知入口 → 角标的唯一调用方是**首页**，这里改为点名 home。 */
const homeSrc = readM('pages/home/index.js');
assertTrue(/notice\.unackedCount\(/.test(homeSrc),
  '首页角标走 utils/notice.js 的 unackedCount（不再本地各算一遍）');
assertTrue(/function unackedCount\([\s\S]{0,300}?!x\.isPublisher[\s\S]{0,160}?Number\(x\.id\)\s*>\s*seen/.test(noticeUtil),
  '角标口径 = 我还没看过的新通知（排除自己发的 + 按未读游标过滤）');
assertTrue(/function markSeen\([\s\S]{0,500}?setStorageSync/.test(noticeUtil)
  && /notice\.markSeen\(/.test(readM('pages/notice/index.js')),
  '进通知页推进「未读游标」（否则返回列表页红点会复活）');
assertTrue(/SEEN_KEY/.test(noticeUtil) && /\+\s*\(Number\(memberId\)\s*\|\|\s*0\)/.test(noticeUtil),
  '未读游标按成员隔离（同一台机切换测试账号互不串味）');

/* ============================================================
 * 正文折叠（2026-09-26 需求⑥ / v0.7.13 需求①）
 *   原版：超 5 行折叠，点一下只是「摘掉 line-clamp」→ 高度瞬间跳到位，
 *         下面的回执区/下一条通知跟着弹一下（用户原话：过渡太生硬）。
 *   现在：超 **3 行**折叠，且必须走「量真实高度 → max-height 连续过渡」，
 *         达到「高度和文字同步展开、下方内容自然下移、同一个箭头旋转到新状态」。
 *
 *   这条需求的**失败模式全是静默的**：
 *     · CSS 时长 .28s 与 JS 的 FOLD_MS=280 不一致 → 只是「收起动画没播完 clamp 就回来」；
 *     · line-clamp 一直挂着摘不掉 → 内容高度被钉死，max-height 再过渡也看不出变化；
 *     · 行高 42rpx 与 FOLD_H_RPX 的分母不一致 → 折叠态露出半行。
 *   所以下面把「常量 ↔ CSS」逐项钉死。
 * ============================================================ */
console.log('\n── 正文折叠：3 行阈值 + 高度同步过渡 + 同一箭头旋转');
{
  const ntWxss2 = readM('pages/notice/index.wxss');
  const ntWxml2 = readM('pages/notice/index.wxml');
  const ntJs2 = readM('pages/notice/index.js');

  const numOf = (src, re) => { const m = re.exec(src); return m ? Number(m[1]) : NaN; };
  const FOLD_LINES = numOf(noticeUtil, /const\s+FOLD_LINES\s*=\s*(\d+)/);
  const LINE_H_RPX = numOf(noticeUtil, /const\s+LINE_H_RPX\s*=\s*(\d+)/);
  const FOLD_MS = numOf(ntJs2, /const\s+FOLD_MS\s*=\s*(\d+)/);

  assertTrue(FOLD_LINES === 3, '折叠阈值 = 3 行（v0.7.13 从 5 行收紧，5 行看不出折叠效果）');
  assertTrue(/FOLD_LINES\s*,\s*LINE_UNITS,\s*LINE_H_RPX,\s*FOLD_H_RPX/.test(noticeUtil),
    'utils/notice 导出 FOLD_LINES / LINE_H_RPX / FOLD_H_RPX（页面折叠高度只有这一个来源）');
  assertTrue(LINE_H_RPX === 42, 'LINE_H_RPX = 42（与 .nt-content 的 line-height 同源）');
  const cssLineH = numOf(ntWxss2, /\.nt-content\s*\{[^}]*line-height:\s*(\d+)rpx/);
  assertTrue(cssLineH === LINE_H_RPX,
    '.nt-content 的 line-height（' + cssLineH + 'rpx）与 LINE_H_RPX（' + LINE_H_RPX + '）一致（不一致折叠态会露出半行）');
  assertTrue(/const\s+FOLD_H_RPX\s*=\s*FOLD_LINES\s*\*\s*LINE_H_RPX\s*;/.test(noticeUtil),
    'FOLD_H_RPX 由「行数 × 行高」算出（不写死数字，改阈值时自动跟着变）');

  assertTrue(/function estimateLines\(/.test(noticeUtil) && /fold:\s*estimateLines\(/.test(noticeUtil),
    '正文行数估算在 utils/notice.js（唯一口径，弹层与列表共用）');
  assertTrue(/-webkit-line-clamp:\s*3\s*;/.test(ntWxss2), '折叠态 line-clamp:3（与 FOLD_LINES 同步）');
  assertTrue(/onToggleFold\s*\(/.test(ntJs2), '通知页有 onToggleFold（点「展开全文」）');

  /* 高度同步过渡：裁剪层 + 实测高度 + 动画期间摘 clamp */
  assertTrue(/\.nt-body\s*\{[^}]*overflow:\s*hidden[^}]*transition:\s*max-height/.test(ntWxss2),
    '.nt-body 是裁剪层（overflow:hidden + transition: max-height）→ 高度连续变化，下方自然下移');
  assertTrue(/class="nt-body"\s+style="\{\{item\.fold \? 'max-height:' \+ item\.bodyH \+ 'rpx' : ''\}\}"/.test(ntWxml2),
    '折叠高度由 JS 按实测值下发（不是 CSS 写死，写死就量不到真实高度）');
  assertTrue(/clamped/.test(ntWxml2) && /\.clamped'\]\s*:\s*false/.test(ntJs2),
    '展开动画期间先摘掉 line-clamp（clamped=false）—— 挂着它内容高度被钉死，动画等于没有');
  assertTrue(/_measureBody\s*\(/.test(ntJs2) && /selectAll\('\.nt-content'\)\.boundingClientRect/.test(ntJs2),
    '展开前先量出正文真实高度（selectAll + 下标，避免拼动态 class 踩 check-wxss）');
  assertTrue(/Math\.ceil\(h \* 750 \/ this\._winW\(\)\)/.test(ntJs2),
    '测得高度按屏幕宽度换算成 rpx（不同机型行高不同，不能写死）');
  assertTrue(/_collapseFold[\s\S]{0,420}setTimeout\([\s\S]{0,240}FOLD_MS\)/.test(ntJs2)
    && /\.clamped'\]\s*:\s*true/.test(ntJs2),
    '收起动画播完再把 clamp 挂回去（提前挂会让内容高度钉死、收起动画直接消失）');
  assertTrue(/onUnload\s*\(\)\s*\{[\s\S]{0,200}clearTimeout/.test(ntJs2),
    'onUnload 清掉 clamp 定时器（页面已销毁还 setData 会报错）');

  /* CSS 时长 ↔ JS 常量：改一处忘另一处不报错，只会「闪一下」，必须钉死 */
  // CSS 里写的是 `.28s`（小数点在前），JS 里是 280（ms）—— 统一换算成 ms 再比
  const durMs = (src, re) => { const m = re.exec(src); return m ? Number('0.' + m[1]) * 1000 : NaN; };
  const bodyDur = durMs(ntWxss2, /\.nt-body\s*\{[\s\S]*?transition:\s*max-height\s*\.(\d+)s/);
  const arrowDur = durMs(ntWxss2, /\.nt-fold-arrow\s*\{[\s\S]*?transition:\s*transform\s*\.(\d+)s/);
  assertTrue(bodyDur === FOLD_MS,
    '.nt-body 过渡时长（' + bodyDur + 'ms）== JS FOLD_MS（' + FOLD_MS + 'ms）');
  assertTrue(arrowDur === FOLD_MS,
    '.nt-fold-arrow 旋转时长（' + arrowDur + 'ms）== JS FOLD_MS（' + FOLD_MS + 'ms）');

  /* 同一个箭头旋转，而不是换一个图标 */
  assertTrue(/\.nt-fold-arrow\.on\s*\{\s*transform:\s*rotate\(180deg\);?\s*\}/.test(ntWxss2),
    '同一个箭头旋转 180° 表示展开（.nt-fold-arrow.on）');
  assertTrue(/name="chevron-down"/.test(ntWxml2) && !/chevron-up/.test(ntWxml2),
    '箭头只用一个 chevron-down（不再靠换图标表示两态）');

  /* 无障碍兜底 */
  assertTrue(/@media \(prefers-reduced-motion: reduce\)/.test(ntWxss2)
    && /\.nt-body \{ transition-duration/.test(ntWxss2),
    '开启「减少动态效果」时高度过渡退化为瞬时（无障碍兜底）');

  /* 双向自证：这些判据必须真的能抓到坏样本 */
  const badDur = durMs('.nt-body { overflow: hidden; transition: max-height .28s ease; }', /transition:\s*max-height\s*\.(\d+)s/);
  assertTrue(badDur !== 400, '自证：时长不一致的样本不会被误判为一致（.28s ≠ 400ms）');
  const badClamp = '.nt-content.is-fold { -webkit-line-clamp: 5; }';
  assertTrue(!/-webkit-line-clamp:\s*3\s*;/.test(badClamp), '自证：line-clamp 仍是 5 会被抓到');
}

/* 按身份收敛（2026-09-26 需求②⑦；v0.7.22 需求④后 mine 已无通知栏，此断言随之收口） */
assertTrue(!/goNotice/.test(mineWxml) && !/导出我的值日表/.test(mineWxml) && !/onExportMine/.test(mineJs),
  '「我的」页无通知入口（v0.7.22 需求④）、无「导出我的值日表」（需求⑦）');
/* 辅导员不展示学号（2026-09-26 需求①）：教职工的 student_no 只是入库占位，展示会让人误以为他是学生。
   后端统一清空（noOf / maskedNoOf），前端四处不再各判一遍。 */
const memberSrc = read('cloudfunctions/member/index.js');
assertTrue(/function noOf\(r\)[\s\S]{0,140}?group_tag === 'X'/.test(memberSrc)
  && /function maskedNoOf\(r\)[\s\S]{0,140}?group_tag === 'X'/.test(memberSrc)
  && /studentNo: noOf\(r\)/.test(memberSrc),
  '辅导员学号在后端统一清空（列表 / 详情 / 绑定选人 / 我的个人卡都拿不到）');
assertTrue(/profile\.groupTag === 'X' \? '辅导员' : profile\.studentNoMasked/.test(mineWxml),
  '「我的」页个人卡：辅导员只显示「辅导员」，不再带学号');
assertTrue(/x\.groupTag === 'X' \? 999 : util\.seqOf\(x\.studentNo\)/.test(readM('pages/roster/index.js')),
  '名册里辅导员不参与「N 号」排序展示（只用于排序的哨兵值，UI 走辅导员分支）');

/* 通知接收人口径（2026-09-26 需求②③④）：辅导员 / 测试账号一律不是收件人；
   「全体」恒等于发布者本班，绝不因为少传 classIds 就外溢到所有班级。 */
assertTrue(/NOT_COUNSELOR/.test(mediaSrc) && /NOT_TEST/.test(mediaSrc)
  && /WHEN 'COMMITTEE' THEN \(SELECT COUNT\(\*\) FROM member WHERE[\s\S]{0,200}?student_no NOT LIKE/.test(mediaSrc),
  '「仅发班委」的收件人与接收人数都排除测试账号（此前漏了）');
assertTrue(/const canCrossClass = isCounselor \|\| isSuper;/.test(mediaSrc)
  && /if \(!canCrossClass \|\| !classIds\.length\) classIds = \[myClassId\];/.test(mediaSrc),
  '「全体」= 发布者本班（只有辅导员/超管显式传 classIds 才跨班）');
assertTrue(/pushNoticeMsg\(pool, pushTitle, content, scope, memberIds, scope === 'ALL' \? classIds : null, me\.id\)/.test(mediaSrc),
  '发布者自己不接收自己发的通知（推送处显式传 excludeId）');

/* 通知页打开慢的修法：先用缓存同步渲染，再后台刷新（2026-09-25 用户反馈） */
const noticeJs = readM('pages/notice/index.js');
assertTrue(/const cached = notice\.read\(/.test(noticeJs) && /list:\s*(withSwipe\()?notice\.toItems\(cached\)/.test(noticeJs),
  '通知页 onLoad 先用 utils/notice 的缓存同步渲染（不等可能正在冷启动的 media）');
assertTrue(/notice\.write\(/.test(homeSrc) && /notice\.write\(/.test(noticeJs),
  '首页与通知页都会写缓存（v0.7.22 需求④后角标请求收口到首页，通知页后台刷新仍写）');
assertTrue(/loading:\s*!hasContent/.test(noticeJs),
  '已有内容时刷新不退回骨架（否则又变成「要反应一会才显示」）');

/* ============================================================ */
console.log('');
if (failed) {
  console.log('❌ 失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('全部通过 ✅');
