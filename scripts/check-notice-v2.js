#!/usr/bin/env node
/**
 * 离线自检：第三批四条反馈
 * ------------------------------------------------------------
 * 起因（2026-09-25 用户反馈）：
 *   ① 切换页面若无变化/新内容则无需重载，确保显示快。
 *   ② 通知可删除（自己收到的历史通知）、占位更小；回执权限化：
 *      仅「发布该通知的班委本人」与「超级管理员」可看多少人确认 + 确认人序号/名字；
 *      其他班委与普通成员仅看内容。
 *   ③ 点击通知到打开通知页很慢，优化。
 *   ④ 学号仅展示末两位（1-9 个位）；发布通知-指定成员用图形网格而非长列表，并一键选 A/B 组。
 *
 * 本脚本把对应不变量全部锁死，防止以后改回去。
 * 用法：node scripts/check-notice-v2.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const CF = path.join(ROOT, 'cloudfunctions');
const SQL = path.join(ROOT, 'scripts');

let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };

const read = (p) => fs.readFileSync(p, 'utf8');
const readMini = (rel) => read(path.join(MINI, rel));
const readCf = (rel) => read(path.join(CF, rel));
const readSql = (rel) => read(path.join(SQL, rel));

function stripComments(src, kind) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, '');
  if (kind === 'wxml') s = s.replace(/<!--[\s\S]*?-->/g, '');
  else if (kind === 'sql') s = s.replace(/--[^\n]*/g, '');
  else s = s.replace(/^\s*\/\/.*$/gm, '');
  return s;
}

/* ------------------------------------------------------------------ */
/* R1  通知可删除（本人收件软删除）                                       */
/* ------------------------------------------------------------------ */
console.log('--- R1 通知可删除（本人收件软删除） ---');
{
  const media = stripComments(readCf('media/index.js'), 'js');
  // 后端必须新增 noticeMsgDelete 动作：校验可见性后写 notice_msg_delete
  if (/msgDelete\s*:\s*\{/.test(media) && /INSERT\s+IGNORE\s+INTO\s+notice_msg_delete/.test(media)) {
    ok('media.msgDelete：写入 notice_msg_delete（软删除，仅对自己生效）');
  } else bad('media 缺少 msgDelete 或没有写 notice_msg_delete');

  /* 越权保护：只能删「我可见的」。
     ⚠️ 2026-09-26：原正则钉的是「scope='ALL' 之后 200 字内有 member_id = ?」，
     多班级改造后这段变成 `EXISTS (SELECT 1 FROM notice_msg_class ...)`，
     于是判据失真、长期假失败。改成按真实实现形态断言：
     msgDelete 里先 SELECT n.id 做可见性校验，查不到就抛「无权删除」。 */
  if (/msgDelete[\s\S]{0,600}?const \[vis\] = await pool\.query\([\s\S]{0,900}?if \(!vis\.length\) throw/.test(media)) {
    ok('msgDelete 仅允许删除「我可见」的通知（防越权标记他人删除）');
  } else bad('msgDelete 缺少可见性校验（可能越权删除他人通知）');

  const api = stripComments(readMini('utils/api.js'), 'js');
  if (/msgDelete:\s*C\('media',\s*'msgDelete'\)/.test(api)) ok('前端 api.msgDelete 已注册');
  else bad('前端 api 缺少 msgDelete 包装');

  const sql = stripComments(readSql('init.sql'), 'sql');
  if (/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+notice_msg_delete/.test(sql)
    && /PRIMARY\s+KEY\s*\(\s*notice_id,\s*member_id\s*\)/.test(sql)) {
    ok('init.sql 已建 notice_msg_delete 表（notice_id, member_id 联合主键）');
  } else bad('init.sql 缺 notice_msg_delete 表或主键不对');
}

/* ------------------------------------------------------------------ */
/* R2  回执权限化（发布人 / 超管可见，其余仅内容）                        */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R2 回执权限化（发布人 / 超管可见，其余仅内容） ---');
{
  const media = stripComments(readCf('media/index.js'), 'js');
  // msgList 必须排除已删除，并带 canSeeAck + ackList
  if (/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+notice_msg_delete/.test(media)) {
    ok('msgList 排除「我删除过的」通知（删除后对自己不再出现）');
  } else bad('msgList 没有排除 notice_msg_delete（删了还会冒出来）');

  // canSeeAck 计算：发布人自己 或 超管
  if (/canSeeAck\s*=\s*\(r\.publisher_id\s*===\s*me\.id\)\s*\|\|/.test(media)
    && /isSuper/.test(media)) {
    ok('canSeeAck = (发布人本人) || 超管（其他班委/普通成员恒为 false）');
  } else bad('msgList 没有计算 canSeeAck（发布人/超管才能看回执）');

  // ackList 仅当 canSeeAck 时回查确认人，带序号
  if (/ackList\s*=/.test(media) && /week\.seqOf/.test(media) && /notice_msg_read/.test(media)) {
    ok('仅当可看时才回查确认人名单，并用 week.seqOf 给出序号（单一真相）');
  } else bad('ackList 没有按权限回查或缺少序号');

  const notice = stripComments(readMini('utils/notice.js'), 'js');
  if (/removeFromCache/.test(notice) && /module\.exports/.test(notice)
    && /removeFromCache/.test(notice.split('module.exports')[1] || '')) {
    ok('utils/notice 导出 removeFromCache（删除后同步清缓存）');
  } else bad('utils/notice 未导出 removeFromCache');

  if (/ackSeqPreview/.test(notice) && /ackMore/.test(notice) && /canSeeAck/.test(notice)) {
    ok('toItems 透传 canSeeAck / ackSeqPreview / ackMore（前端据此渲染）');
  } else bad('toItems 没有透传回执可见字段');

  const pageJs = stripComments(readMini('pages/notice/index.js'), 'js');
  if (/onDelete\s*\(/.test(pageJs) && /api\.msgDelete/.test(pageJs) && /notice\.removeFromCache/.test(pageJs)) {
    ok('通知页 onDelete → api.msgDelete → removeFromCache（删完列表与缓存同步移除）');
  } else bad('通知页缺 onDelete / msgDelete / 缓存移除');

  const pageWxml = stripComments(readMini('pages/notice/index.wxml'), 'wxml');
  if (/nt-del-zone/.test(pageWxml) && /bindtap="onDelete"/.test(pageWxml)) {
    ok('通知卡左滑露出删除区，点击删除（nt-del-zone → onDelete）');
  } else bad('通知卡缺左滑删除区 / onDelete 点击');
  // 左滑手势：卡片本体必须挂 touch 事件，删除区藏在卡片右侧后方
  if (/bindtouchstart="onSwipeStart"/.test(pageWxml) && /bindtouchmove="onSwipeMove"/.test(pageWxml)
      && /bindtouchend="onSwipeEnd"/.test(pageWxml) && /bindtouchcancel="onSwipeEnd"/.test(pageWxml)) {
    ok('卡片本体挂 touch 手势（onSwipeStart/Move/End 实现左滑露出删除区）');
  } else bad('通知卡未挂左滑手势 touch 事件');
  // 删除方式必须是左滑，而不是卡片上的固定删除按钮（旧交互）
  if (/nt-del-zone/.test(pageWxml) && !/nt-head-right[^]*?bindtap="onDelete"/.test(pageWxml)) {
    ok('删除入口已改为左滑（头部不再有固定删除按钮）');
  } else bad('通知卡头部仍残留固定删除按钮（应左滑删除）');
  if (/wx:if="{{item\.canSeeAck}}"/.test(pageWxml) && /nt-acklist/.test(pageWxml)) {
    ok('回执区仅在 canSeeAck 时渲染（其他班委/普通成员看不到确认人数与名单）');
  } else bad('回执区没有按 canSeeAck 门禁（会泄露确认名单）');
  if (/ackSeqPreview/.test(pageWxml) && /wx:if="{{item\.ackMore}}"/.test(pageWxml)) {
    ok('确认人序号预览 + 折叠「+N」（占位置小）');
  } else bad('确认人序号预览/折叠未体现');

  // 2026-09-25 第五批：删除区与卡片要有间距、圆角矩形（不再贴边满高）
  const ntWxss = readMini('pages/notice/index.wxss');
  const zoneMatch = /\.nt-del-zone\s*\{[^}]*\}/.exec(ntWxss);
  if (zoneMatch && /border-radius/.test(zoneMatch[0]) && /top:\s*8px/.test(zoneMatch[0])
      && /right:\s*8px/.test(zoneMatch[0]) && /bottom:\s*8px/.test(zoneMatch[0])) {
    ok('删除区是带间距的圆角矩形（top/right/bottom 8px + border-radius，不再贴边）');
  } else bad('删除区未与卡片留间距 / 未用圆角矩形');
  // 在线文档点击直接跳 web-view，复制只是 webview 页里的失败兜底
  const ntPageJs = readMini('pages/notice/index.js');
  if (/pages\/webview\/index\?url=/.test(ntPageJs) && /navigateTo/.test(ntPageJs)) {
    ok('在线文档点击直接跳 web-view 打开（不再只复制链接）');
  } else bad('在线文档仍是复制落地，未跳 web-view');
  const appJson = JSON.parse(readMini('app.json'));
  if ((appJson.pages || []).indexOf('pages/webview/index') >= 0) {
    ok('web-view 页已注册进 app.json（pages/webview/index）');
  } else bad('pages/webview/index 未注册进 app.json');
  const wvWxml = readMini('pages/webview/index.wxml');
  const wvJs = readMini('pages/webview/index.js');
  if (/<web-view/.test(wvWxml) && /onCopy/.test(wvJs)) {
    ok('web-view 页挂 <web-view>，加载失败时提供复制链接兜底');
  } else bad('webview 页缺 <web-view> 或复制兜底');
}

/* ------------------------------------------------------------------ */
/* R6  第五批反馈：标题选填 + 链接标题自动检测                            */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R6 标题选填 + 在线文档标题自动检测 ---');
{
  // 后端：msgPublish 不再强制标题；订阅消息推送标题回退
  const mediaJs = readCf('media/index.js');
  if (!/请填写通知标题/.test(mediaJs)) {
    ok('msgPublish 不再强制通知标题（标题选填）');
  } else bad('msgPublish 仍强制标题（应改为选填）');
  if (/pushTitle\s*=\s*title \|\|/.test(mediaJs)) {
    ok('订阅消息推送标题为空时回退（内容前 20 字 / 班级通知）');
  } else bad('订阅消息推送没有标题回退（空标题会导致 thing1 为空）');
  // 前端发布表单：标题选填文案（label「标题」+ np-opt「选填」紧跟其后）
  const homeWxml = stripComments(readMini('pages/home/index.wxml'), 'wxml');
  if (/标题\s*<text\s+class="np-opt">\s*选填/.test(homeWxml)) {
    ok('发布通知标题标注「选填」');
  } else bad('发布通知标题未标注「选填」');
  const homeJs = readMini('pages/home/index.js');
  if (!/请填写通知标题/.test(homeJs)) {
    ok('前端发布不再拦截空标题');
  } else bad('前端发布仍拦截空标题');
  // 链接标题自动检测
  const apiJs = readMini('utils/api.js');
  if (/linkTitle:\s*C\('ai-proxy',\s*'title'\)/.test(apiJs)) {
    ok('api.linkTitle 已注册（ai-proxy title）');
  } else bad('api.linkTitle 未注册');
  if (/_onNoticeLinkInput/.test(homeJs) && /api\.linkTitle\(/.test(homeJs) && /setTimeout/.test(homeJs)) {
    ok('链接输入防抖自动检测标题并回填显示名（手填不覆盖）');
  } else bad('发布通知缺链接标题自动检测（防抖 + api.linkTitle）');
  // ai-proxy：title action + SSRF 防护
  const aiProxy = readCf('ai-proxy/index.js');
  if (/action === 'title'/.test(aiProxy) && /assertPublicUrl/.test(aiProxy) && /isPrivateIp/.test(aiProxy)) {
    ok('ai-proxy 提供 title action 且带 SSRF 防护（仅 http/https、拒绝内网）');
  } else bad('ai-proxy 缺 title action 或 SSRF 防护');
  // 源码里的正则字面量是 /<\/title\s*>/i，文件原文即含 "<\/title" 字符串
  if (aiProxy.indexOf('<\\/title') >= 0) {
    ok('标题抓取等到 </title> 闭合标签才停读（流块边界不会截断）');
  } else bad('标题抓取的停读条件有误（可能拿不到闭合标签）');
}

/* ------------------------------------------------------------------ */
/* R3  通知页打开提速（缓存优先 + 启动预热）                             */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R3 通知页打开提速 ---');
{
  const pageJs = stripComments(readMini('pages/notice/index.js'), 'js');
  // onLoad 必须读缓存优先；用 read(0) 不再因 60s 过期退回骨架。
  // ⚠️ 2026-09-26：onLoad 里前置逻辑（身份 / canClear / 未读游标）变多了，
  //    窗口从 260 放宽到 700 字，否则会变成假失败。
  if (/onLoad\s*\(\)\s*\{[\s\S]{0,700}notice\.read\(0\)/.test(pageJs)) {
    ok('通知页 onLoad 用 notice.read(0) 始终先渲染缓存（过期也先出内容）');
  } else if (/notice\.read\(notice\.FRESH_MS\)/.test(pageJs)) {
    bad('通知页仍在用 read(FRESH_MS)，会因 60s 过期退回骨架——打开又变慢');
  } else bad('通知页 onLoad 没有缓存优先渲染');

  const app = stripComments(readMini('app.js'), 'js');
  if (/_prefetchTabs\s*\(\)[\s\S]{0,400}api\.msgList/.test(app) && /notice\.write/.test(app)) {
    ok('app 启动预热拉一次 msgList 写进 notice 缓存（首次点通知即热）');
  } else bad('app 没有预热通知列表（首次打开通知页仍要等 media 冷启动）');
}

/* ------------------------------------------------------------------ */
/* R4  切换页面无变化不重载（Tab 防抖）                                  */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R4 切换页面无变化不重载（Tab 防抖） ---');
{
  ['home', 'duty', 'mine'].forEach((p) => {
    const src = stripComments(readMini('pages/' + p + '/index.js'), 'js');
    const hasConst = /const STALE_MS\s*=/.test(src);
    // load(force) 在新鲜期内直接 return（不发起请求）
    const guards = /!force\s*&&\s*this\._hasData\s*&&\s*this\._lastLoad\s*&&\s*now\s*-\s*this\._lastLoad\s*<\s*STALE_MS\s*\)\s*\{[\s\S]{0,160}?return;/.test(src);
    // v0.7.16 改判：mine 页改为 **SWR**（每次进入后台重拉统计，旧值先显示）——
    // 用户需求③「本学期 / 待值日更新慢」的修复，静默窗被有意移除。
    // 合法形态 = ① 保留 STALE_MS 静默窗（home/duty）② SWR：load 内无条件发起请求。
    const swr = p === 'mine' && /api\.dutyMyStats\(/.test(src) && !guards;
    if (hasConst && guards) ok('pages/' + p + '：load(force) 在 STALE_MS 内直接复用、不重拉');
    else if (swr) ok('pages/' + p + '：SWR —— 每次进入后台重拉（v0.7.16 需求③，静默窗有意移除）');
    else bad('pages/' + p + '：没有 STALE_MS 新鲜度门禁（切回来仍会重载）');

    // 必须记录上次成功拉取时间
    if (/\._lastLoad\s*=\s*Date\.now\(\)/.test(src)) ok('pages/' + p + '：成功拉取后记录 _lastLoad');
    else bad('pages/' + p + '：没有记录 _lastLoad（门禁永远不命中）');
  });

  // home / duty 的显式操作后必须强制刷新（load(true)）
  const duty = stripComments(readMini('pages/duty/index.js'), 'js');
  const forced = (duty.match(/load\(true\)/g) || []).length;
  if (forced >= 5) ok('值日页 5 处写操作 + onReload/onSheetChanged 均走 load(true) 强制刷新');
  else bad('值日页显式写操作没有全部用 load(true)（改完看不到最新名单）：' + forced + ' 处');

  const home = stripComments(readMini('pages/home/index.js'), 'js');
  if (/onReload\s*\(\)\s*\{\s*this\.load\(true\)/.test(home) && /onSheetChanged\(\)\s*\{\s*this\.load\(true\)/.test(home)) {
    ok('首页 onReload / onSheetChanged 强制刷新生效');
  } else bad('首页 onReload / onSheetChanged 没有强制刷新');

  const mine = stripComments(readMini('pages/mine/index.js'), 'js');
  // v0.7.16 改判：mine 的统计改为 **SWR**（每次进入后台重拉，需求③「数字更新慢」）——
  // 旧「新鲜度门禁」与「SWR 无条件重拉」都是合法形态。
  // v0.7.22 需求④后 mine 已无通知角标（_loadNoticeBadge 随入口一起删除），
  // 旧第一分支（_loadNoticeBadge 形态）按点名式判据原则一并移除，不再保留死分支。
  // 窗口 1600：load 体内含 SWR 注释 + 辅导员分支 + 缓存回填（v1.0.6）后才调 dutyMyStats，
  // 实测距离 1137 字符；判据意图是「load 里拉统计」，窗口只兜「函数体相邻」，别再收紧到 400。
  if (/load\(force\)\s*\{[\s\S]{0,1600}api\.dutyMyStats\(/.test(mine)) {
    ok('「我的」页统计已改 SWR（每次进入后台重拉，v0.7.16 需求③）');
  } else {
    bad('「我的」页 load 既无新鲜度门禁也不拉统计');
  }
}

/* ------------------------------------------------------------------ */
/* R5  学号末两位 + 发布通知成员图形网格                                 */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- R5 学号末两位 + 发布通知成员图形网格 ---');
{
  const util = stripComments(readMini('utils/util.js'), 'js');
  if (/seqOf\s*\(studentNo\)/.test(util) && /module\.exports[\s\S]*seqOf/.test(util)) {
    ok('util.seqOf 已导出（学号后两位作数字）');
  } else bad('util 缺少 seqOf 导出');

  // 与后端 week.seqOf 一致：取后两位、转数字（1-9 个位、10-56 两位）
  if (/slice\(-2\)/.test(util) && /parseInt/.test(util)) ok('seqOf 取后两位转数字（与后端 week.seqOf 同一套口径）');
  else bad('seqOf 实现与后端口径不一致');

  const homeJs = stripComments(readMini('pages/home/index.js'), 'js');
  // ⚠️ 2026-09-26：成员筛选条件变多（辅导员 / 测试账号），窗口从 400 放宽到 1400 字
  if (/_loadNoticeMembers[\s\S]{0,1400}seq:\s*util\.seqOf/.test(homeJs)) {
    ok('发布通知成员列表附上 seq（前端按学号后两位算，无需为选择列表多拉序号）');
  } else bad('发布通知成员列表没有附 seq（图形网格会显示空序号）');

  if (/onPickGroup\s*\(/.test(homeJs) && /onClearPick\s*\(/.test(homeJs)) {
    ok('home 提供 onPickGroup / onClearPick（一键选 A/B 组、清空）');
  } else bad('home 缺一键选组 / 清空逻辑');

  const homeWxml = stripComments(readMini('pages/home/index.wxml'), 'wxml');
  if (/np-grid/.test(homeWxml) && /np-cell/.test(homeWxml) && /avatar-tag/.test(homeWxml)) {
    ok('发布通知-指定成员改用图形网格（avatar-tag 显示序号），不再用长列表');
  } else bad('发布通知成员选择仍是长列表（应为 np-grid 图形网格）');
  if (/\.sort\(\(a,\s*b\)\s*=>\s*a\.seq\s*-\s*b\.seq\)/.test(homeJs)) {
    ok('发布通知成员列表按 seq 升序排列（1-56 连续）');
  } else bad('发布通知成员列表未按 1-56 排序');

  if (/onPickGroup[\s\S]{0,500}allSelected/.test(homeJs) && /if\s*\(allSelected\)\s*\{[\s\S]{0,160}delete\s+pick\[id\]/.test(homeJs)) {
    ok('A/B 组按钮为切换：再点一次取消选择');
  } else bad('A/B 组按钮未实现「再点取消」切换');

  if (/data-tag="A"[\s\S]{0,80}onPickGroup/.test(homeWxml) && /data-tag="B"/.test(homeWxml)) {
    ok('网格上方有「A 组 / B 组」一键切换按钮');
  } else bad('发布通知缺一键选 A/B 组按钮');

  /* ⚠️ 2026-09-26：成员与分组已迁到 pages/roster，读取目标随之下移；
     详情里的学号改成三元表达式（辅导员显示「教职工…」），判据同步。 */
  const rosWxml = stripComments(readMini('pages/roster/index.wxml'), 'wxml');
  if (/\{\{item\.seq\}\}\s*号/.test(rosWxml) && /'学号 ' \+ mDetail\.seq \+ ' 号'/.test(rosWxml)) {
    ok('成员列表与详情用 seq（学号仅末两位）展示');
  } else bad('成员列表/详情仍在展示完整学号');
}

/* ------------------------------------------------------------------ */
/* R7  通知配图 fileID 白名单（v0.7.14）                                 */
/* ------------------------------------------------------------------ */
/* 起因（2026-09-26 用户反馈「发布通知添加图片，查看通知里面不显示图片」）：
 * normalizeNoticeImages 的白名单正则写成 /^cloud:\/\/[\w-]+\/\S+$/ —— `[\w-]`
 * **不包含点号**，而真实云存储 fileID 的 host 段是 `<envId>.<bucket>-<uin>`，
 * 必然带点。结果每一张合法图片都被判为非法并**静默丢弃**（images 存库为 NULL），
 * 表现为「发布时有图、查看时无图」，且前后端都不报错。
 * 这条不变量以前没有任何脚本覆盖，所以 32 个门禁全绿也没拦住。 */
console.log('');
console.log('--- R7 通知配图 fileID 白名单 ---');
{
  const mediaSrc = readCf('media/index.js');
  const maxLine = (/const NOTICE_MAX_IMAGES = \d+;/.exec(mediaSrc) || [])[0];
  const reLine = (/const FILEID_RE = [^\n]+;/.exec(mediaSrc) || [])[0];
  const normBody = (/function normalizeNoticeImages[\s\S]*?\n\}/.exec(mediaSrc) || [])[0];
  const parseBody = (/function parseNoticeImages[\s\S]*?\n\}/.exec(mediaSrc) || [])[0];

  if (!maxLine || !reLine || !normBody || !parseBody) {
    bad('没能从 cloudfunctions/media/index.js 抽出 NOTICE_MAX_IMAGES / FILEID_RE / 两个函数');
  } else {
    class BizError extends Error { constructor(c, m) { super(m); this.code = c; } }
    const asrt = (cond, okMsg, badMsg) => (cond ? ok(okMsg) : bad(badMsg));
    const built = new Function(
      'BizError',
      maxLine + '\n' + reLine + '\n' + normBody + '\n' + parseBody +
      '\nreturn { normalizeNoticeImages, parseNoticeImages };'
    )(BizError);

    // 真实 fileID：host 段 = <envId>.<bucket>-<uin>，必须保留（这就是线上那个 bug）
    const REAL = 'cloud://<YOUR_ENV_ID>.636c-<YOUR_ENV_ID>-1306168169/notice/1790367765293-0-6452.jpg';
    const kept = built.normalizeNoticeImages([REAL]);
    if (kept && JSON.parse(kept).length === 1) ok('真实 fileID（host 含 .bucket 段）不再被丢弃');
    else bad('真实 fileID 仍被丢弃（host 段不允许点号 = 线上「有图不显示」的根因）');

    // 外链 / 非 cloud:// 必须仍然被拒（白名单不能因为放宽点号而形同虚设）
    const mixed = built.normalizeNoticeImages(['https://evil.example.com/a.jpg', REAL, 'cloud://x/y/z.jpg']);
    if (mixed && JSON.parse(mixed).length === 2) ok('非 cloud:// 的外链仍被白名单丢弃（3 条只留 2 条合法项）');
    else bad('外链没有被丢弃，白名单形同虚设：' + mixed);

    if (built.normalizeNoticeImages(null) === null) ok('images=null 时存库仍为 null（无图通知不受影响）');
    else bad('images=null 的返回不是 null');
    if (built.normalizeNoticeImages([]) === null) ok('images=[] 时存库为 null（清空配图）');
    else bad('images=[] 的返回不是 null');

    let threw = false;
    try { built.normalizeNoticeImages([REAL, REAL, REAL, REAL]); } catch (e) { threw = true; }
    if (threw) ok('超过 3 张直接报错（不静默截断）');
    else bad('超过 3 张没有报错');

    // 读取侧回环：库里可能是 NULL / JSON 字符串 / mysql2 已解析的数组
    const arr = built.parseNoticeImages(JSON.stringify([REAL]));
    if (arr.length === 1 && arr[0] === REAL) ok('parseNoticeImages 能把存库 JSON 还原成 fileID 数组');
    else bad('parseNoticeImages 还原失败：' + JSON.stringify(arr));
    if (built.parseNoticeImages(null).length === 0 && built.parseNoticeImages('不是 JSON').length === 0) {
      ok('parseNoticeImages 对 NULL / 脏数据返回空数组（不抛错）');
    } else bad('parseNoticeImages 对 NULL / 脏数据没有兜底');
    if (built.parseNoticeImages(['https://evil/a.jpg', REAL]).length === 1) ok('parseNoticeImages 只放行 cloud:// 前缀');
    else bad('parseNoticeImages 放行了非 cloud:// 项');

    // 接线：写入带 images、列表/回收站都回显 images（缺一处就还是「有图不显示」）
    // 抽取用「关键词起、固定长度窗口」——比花括号配平正则稳，避免假阴性
    const blockAfter = (key, len) => {
      const i = mediaSrc.indexOf(key);
      return i < 0 ? '' : mediaSrc.slice(i, i + (len || 1600));
    };
    asrt(/\bimages\b/.test(blockAfter('INSERT INTO notice_msg', 300)),
      'msgPublish 的 INSERT 带 images 列', 'msgPublish 的 INSERT 丢了 images 列');
    asrt(/n\.images/.test(blockAfter('msgList:', 1600)),
      'msgList 的 SELECT 回显 n.images', 'msgList 的 SELECT 没有 n.images');
    asrt(/n\.images/.test(blockAfter('msgRecycleList:', 1600)),
      'msgRecycleList 的 SELECT 回显 n.images', 'msgRecycleList 的 SELECT 没有 n.images');
  }
}

/* ------------------------------------------------------------------ */
/* 自证                                                                */
/* ------------------------------------------------------------------ */
console.log('');
console.log('--- 自证 ---');
{
  const staleBad = 'load() { this.setData({loading:true}); api.x(); }';
  const staleCaught = !/!force\s*&&\s*this\._hasData\s*&&\s*this\._lastLoad\s*&&\s*now\s*-\s*this\._lastLoad\s*<\s*STALE_MS/.test(staleBad);
  if (staleCaught) ok('自证：无条件 load 样本不会被误判为「带门禁」');
  else bad('自证失败：门禁正则误伤无条件 load');

  const permBad = "wx:if=\"{{item.ackCount}}\"";
  if (!/wx:if="{{item\.canSeeAck}}"/.test(permBad)) ok('自证：仅凭 ackCount 渲染回执的样本会被认作未门禁');
  else bad('自证失败：仅凭 ackCount 的样本没被识别为越权');

  const gridBad = 'wx:for="{{noticeMembers}}" class="np-mrow"';
  if (!/np-grid/.test(gridBad)) ok('自证：长列表样本（np-mrow）会被判为未图形化');
  else bad('自证失败：长列表样本没被识别');

  // R6 的负样本：旧正则（不许点号）必须能被判为「会吃掉真实 fileID」
  const oldRe = /^cloud:\/\/[\w-]+\/\S+$/;
  if (!oldRe.test('cloud://env.636c-env-1300000000/notice/a.jpg') && oldRe.test('cloud://env/notice/a.jpg')) {
    ok('自证：旧正则（不许点号）确实会吃掉真实 fileID —— 坏样本可被识别');
  } else bad('自证失败：旧正则样本没被识别为有缺陷');
}

console.log('');
if (failed) {
  console.log('❌ ' + failed + ' 项不通过');
  process.exit(1);
}
console.log('✅ 第三批四条反馈相关不变量检查全部通过');
