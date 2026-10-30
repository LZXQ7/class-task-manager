/**
 * 班级通知：视图模型 + 跨页缓存
 * ------------------------------------------------------------
 * 起因（2026-09-25 用户反馈）：「『我的』页面点击通知，打开会很慢，要反应一会才会打开新页面」。
 *
 * 真因不是 navigateTo 慢，而是**新页面的首屏在等网络**：
 * `pages/notice/index` 的 onLoad 立刻 `setData({loading:true})` 然后调 `media.msgList`，
 * 于是用户先看到 2~3 个骨架卡，要等云函数返回才换成真实内容。
 * 而 `media` 这个函数还带着 `music-metadata` 这类重依赖，**冷启动要好几秒** ——
 * 虽然入口页的角标已经拉过一次 `msgList`，但只要用户点得早（请求还在路上），
 * 进通知页仍然要再等一次。
 *
 * 做法：把入口页已经拿到的列表**缓存到 globalData**，通知页 onLoad 先用缓存**同步渲染**，
 * 再在后台静默刷新。这样无论云函数多冷，页面都是「一进去就有内容」。
 *
 * 缓存写入方（v0.7.22 需求④后）：**仅首页**（「我的」页通知入口已下线）。
 * 缓存只在内存里（globalData），不落 storage：通知属于班务数据，不该在小程序本地留副本，
 * 而且冷启动本来就该拿最新的一份。
 */

/** 缓存视为「新鲜」的时长：超过就仍然先渲染缓存、但一定会重新拉一次（反正总会刷）。
 *  v0.7.16（需求④「通知 / 红点不实时」）：60s → 15s —— 首页角标的静默窗随之缩短；
 *  「发布后立即失效」由 invalidate() 负责（发布成功的那一端调用）。 */
const FRESH_MS = 15 * 1000;

/** 「已收到 a/b」里的 b：全体=当前 ACTIVE 人数，指定成员=被选人数 */
function ackText(x) {
  return x.recipientCount ? (x.ackCount + '/' + x.recipientCount) : '—';
}

/* ------------------------------------------------------------
 * 正文折叠（2026-09-26 需求⑥）：正文超过 3 行就折叠，点「展开全文」再看。
 * 行数按**显示宽度**估算（正文字号 27rpx、卡片内容宽 630rpx → 一行约 23 个汉字）：
 *   汉字/全角 = 1，ASCII ≈ 0.55；换行符强制断行。
 * 只做「估多了就折叠」这一个方向 —— 估少了就不折叠（整段照常显示，不会出现
 * 「被截断却点不到展开」的死角），估多了最多多一个无副作用的「展开全文」。
 *
 * v0.7.13（2026-09-26）：阈值 5 行 → **3 行**（5 行太长，折叠与展开几乎看不出差别）；
 * 并新增 `FOLD_H_RPX` —— 折叠态的**固定高度**（行数 × 行高），供页面做 max-height
 * 过渡动画的**起点**用。行高必须与 `pages/notice/index.wxss` 里 `.nt-content` 的
 * line-height 一致（42rpx），否则折叠态会露出半行 / 少半行（改一处忘另一处不报错，
 * 只是静默错位，所以由 check-notice 比对 CSS 与这里的常量）。
 * ------------------------------------------------------------ */
const FOLD_LINES = 3;
const LINE_UNITS = 23;
const LINE_H_RPX = 42;
const FOLD_H_RPX = FOLD_LINES * LINE_H_RPX;

function estimateLines(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 1;
  let lines = 0;
  s.split('\n').forEach((para) => {
    let w = 0;
    for (const ch of para) w += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
    lines += Math.max(1, Math.ceil(w / LINE_UNITS));
  });
  return lines;
}

/**
 * 云函数 `media.msgList` 的原始行 → 列表视图模型。
 * 「我的」页角标与通知页列表**共用这一份**，避免两处各算一遍导致口径漂移。
 */
function toItems(list) {
  return (list || []).map(x => {
    const ackList = (x.ackList || []).map(a => ({ name: a.name, seq: a.seq || 0 }));
    // 确认人序号预览：最多展示前 12 个，多了折叠成「+N」，避免一条通知占半屏
    const seqs = ackList.map(a => a.seq);
    const preview = seqs.slice(0, 12).join('、');
    const more = seqs.length > 12 ? seqs.length - 12 : 0;
    return Object.assign({}, x, {
      ackText: ackText(x),
      // 配图（v0.7.14）：后端已 parse 成数组，这里兜底保证永远是数组，
      // 否则 WXML 里 `item.images.length` 在 undefined 上静默出错
      images: Array.isArray(x.images) ? x.images : [],
      linkLabel: x.linkName || '在线文档',
      // 标题选填（2026-09-25）：没填标题就用内容前 16 字兜底展示
      titleText: String(x.title || '').trim() || String(x.content || '').trim().slice(0, 16) || '班级通知',
      // 回执可见性（需求②）：只有发布人自己或超管能看「多少人确认 + 确认人序号/名字」，
      // 其它班委与普通成员这两项恒为空，前端据此只渲染内容。
      canSeeAck: !!x.canSeeAck,
      ackList,
      ackSeqPreview: preview,
      ackMore: more,
      // 范围文案（2026-09-25 需求③）：COMMITTEE=仅发班委，PICK=指定成员，ALL=全班
      scopeText: x.scope === 'ALL' ? '全班' : (x.scope === 'COMMITTEE' ? '班委' : '指定成员'),
      // 正文折叠（2026-09-26 需求⑥）：超 3 行才允许折叠。
      // clamped = 是否挂 line-clamp（展开动画期间要摘掉，否则内部高度被钉死、动画无从谈起）
      fold: estimateLines(x.content) > FOLD_LINES,
      clamped: true,
      bodyH: FOLD_H_RPX
    });
  });
}

/* ------------------------------------------------------------
 * 角标口径（2026-09-26 需求⑤重定义）：
 *   旧口径 = 「需要我确认、且还没确认」的条数 —— 两个致命问题：
 *     ① 自己发的通知，确认按钮对发布者隐藏（isPublisher），他永远点不了 →
 *        角标**永远消不掉**；
 *     ② 用户要的是「新通知的红点」，看过就该消失，而不是必须先点「确认收到」。
 *   新口径 = 「我还没看过的新通知」条数：
 *     · 排除自己发布的（isPublisher）
 *     · id > 本机记录的最后查看游标（进通知页即推进）
 *   游标存本地 storage、按成员 id 分开（同一台机器切换测试账号互不串味）。
 *
 * 2026-10-24 用户反馈（超管视角）：「超管虽然收到所有通知，但若不是指定成员给
 * 自己的就不用红色提醒。只有和自己相关的才提醒。」
 *   ⇒ 追加 forMe 过滤：后端 msgList 逐行算好「是否与我相关」（全班(我的班)/
 *      指定到我 / 我是班委的班委通知）。超管的**可见性**不变（仍看得到全部），
 *      只是红点不再被别班通知、发给别的成员的通知触发。
 *   ⚠️ `!== false` 而非 `=== true`：后端未部署/旧缓存缺该字段时按老口径计数，
 *      避免部署窗口期角标突然全消（前端先上传也安全）。
 * ------------------------------------------------------------ */
const SEEN_KEY = 'noticeSeen:';

/** 读取「已查看到的最大通知 id」（按成员隔离；未登录/无记录 → 0） */
function seenId(memberId) {
  try {
    return Number(wx.getStorageSync(SEEN_KEY + (Number(memberId) || 0))) || 0;
  } catch (e) {
    return 0;
  }
}

/** 未查看的新通知条数（首页红色角标） */
function unackedCount(list, memberId) {
  const seen = seenId(memberId);
  return (list || []).filter(x => !x.isPublisher && Number(x.id) > seen && x.forMe !== false).length;
}

/**
 * 进入通知页后调用：把游标推到列表里的最大 id（幂等，只前进不后退）。
 * 返回推进后的游标值。
 */
function markSeen(list, memberId) {
  const max = (list || []).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
  if (!max) return seenId(memberId);
  const cur = seenId(memberId);
  if (max <= cur) return cur;
  try { wx.setStorageSync(SEEN_KEY + (Number(memberId) || 0), max); } catch (e) {}
  return max;
}

function slot() {
  const app = typeof getApp === 'function' ? getApp() : null;
  if (!app) return null;
  if (!app.globalData) app.globalData = {};
  if (!app.globalData.noticeCache) app.globalData.noticeCache = { list: null, at: 0, byClass: {} };
  // 老版本写下的对象没有 byClass（热更新时内存里的老对象还在）→ 补上，别让下面取 undefined 崩
  if (!app.globalData.noticeCache.byClass) app.globalData.noticeCache.byClass = {};
  return app.globalData.noticeCache;
}

/**
 * 取某个班对应的缓存槽（2026-10-28）。
 * classId = 0 → 全局槽（= 「我可见的全部通知」，首页角标读的就是它）；
 * classId > 0 → 该班的独立槽（从班级信息页按班进通知页时用）。
 *
 * ⚠️ 为什么必须分开：按班看时列表只有该班的通知，写进全局槽会把首页角标的
 *    计数口径污染成「上一个看过的班」；反过来，全局列表（可能含多个班）也不能
 *    拿来当某个班的列表先渲染 —— 那就是「切了班却看到别的班通知」。
 */
function slotOf(classId, create) {
  const s = slot();
  if (!s) return null;
  const key = Number(classId) || 0;
  if (!key) return s;
  if (!s.byClass[key] && create) s.byClass[key] = { list: null, at: 0 };
  return s.byClass[key];
}

/** 对所有已有内容的槽跑一遍（删除 / 确认后要同步每一份缓存） */
function eachSlot(fn) {
  const s = slot();
  if (!s) return;
  if (s.list) fn(s);
  Object.keys(s.byClass || {}).forEach((k) => {
    const one = s.byClass[k];
    if (one && one.list) fn(one);
  });
}

/** 写入缓存（存**原始行**，视图模型每次现算，避免把派生字段也缓存下来） */
function write(rawList, classId) {
  const s = slotOf(classId, true);
  if (!s) return;
  s.list = rawList || [];
  s.at = Date.now();
}

/**
 * 取缓存里的原始行；没有、或超过 maxAgeMs（默认 FRESH_MS）则返回 null。
 * 传 0 表示不限时间（只判有没有）。第二个参数是班级视角的 classId（0 = 全局）。
 */
function read(maxAgeMs, classId) {
  const s = slotOf(classId, false);
  if (!s || !s.list) return null;
  const maxAge = maxAgeMs === undefined ? FRESH_MS : maxAgeMs;
  if (maxAge > 0 && Date.now() - s.at > maxAge) return null;
  return s.list;
}

/** 确认收到之后就地更新缓存里那一行，避免返回列表页时角标又跳回去 */
function patchAcked(noticeId) {
  eachSlot((s) => {
    s.list = s.list.map(x => (x.id === noticeId ? Object.assign({}, x, {
      acked: true,
      ackCount: (Number(x.ackCount) || 0) + 1,
      canAck: false
    }) : x));
  });
}

/** 从缓存里移除一条（删除自己收到的通知后调用，避免返回列表页它又冒出来） */
function removeFromCache(noticeId) {
  eachSlot((s) => {
    s.list = s.list.filter(x => x.id !== noticeId);
  });
}

/**
 * 清空缓存（v0.7.16 需求④）：发布通知的一端在发布成功后调用 ——
 * 下一次任何人 onShow / 进通知页都会强制重拉，配合各页角标的 SWR 刷新，
 * 把「通知到了但红点不动」的感知延迟压到一次切页以内。
 * 发布到任意班都可能影响任意槽，所以**所有槽一起清**。
 */
function invalidate() {
  const s = slot();
  if (!s) return;
  s.list = null;
  s.at = 0;
  s.byClass = {};
}

module.exports = {
  FRESH_MS, FOLD_LINES, LINE_UNITS, LINE_H_RPX, FOLD_H_RPX,
  toItems, estimateLines,
  unackedCount, seenId, markSeen,
  write, read, patchAcked, removeFromCache, invalidate
};
