/**
 * 使用埋点（2026-10-16）：页面浏览 / 功能入口点击上报。
 *
 * 设计：内存队列 + 防抖批量上报，失败静默丢弃（绝不阻塞主流程）。
 *   - pageView(page)：页面 onShow 时调用，记录「看了哪个页面」。
 *   - action(key, ref)：功能入口被点击时调用，记录「用了哪个功能」。
 * 上报走 api.track（云函数 stat），批量 INSERT 进 usage_event 表。
 */
const api = require('./api');

let queue = [];
let timer = null;
const FLUSH_DELAY = 1500;   // 防抖窗口：1.5s 内合并上报
const MAX_QUEUE = 30;       // 队列上限：达到即立即上报

function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const batch = queue.slice();
  queue = [];
  api.track({ events: batch }, { toast: false, loading: false }).catch(() => {});
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_DELAY);
}

function push(kind, event, ref) {
  if (!event) return;
  queue.push({
    kind,
    event: String(event).slice(0, 64),
    ref: ref ? String(ref).slice(0, 64) : ''
  });
  if (queue.length >= MAX_QUEUE) flush();
  else schedule();
}

function track(kind, event, ref) { push(kind, event, ref); }

module.exports = {
  track,
  pageView: (page) => push('page_view', page),
  action: (key, ref) => push('action', key, ref)
};
