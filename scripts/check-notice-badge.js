#!/usr/bin/env node
/**
 * 通知红色角标「只提醒与自己相关的」门禁（2026-10-24 用户真机反馈）
 * ============================================================
 *  反馈原话：「超管虽然收到所有通知，但若不是指定成员给自己的就不用红色提醒。
 *  只有和自己相关的才提醒。」
 *
 *  现状：media.msgList 的可见性对超管短路（`? = 1` 恒真）⇒ 超管看得到**全部**通知
 *  （含发往别班的、PICK 给别的成员的）—— 这本身是产品口径（超管 oversight），不变。
 *  但首页红点角标（utils/notice.unackedCount）只排除「自己发的」，于是别班通知 /
 *  发给张三的通知也在超管首页亮红点 —— 用户明确要求：只有**与自己相关**的才提醒。
 *
 *  口径（新增 forMe 字段，后端逐行算、前端角标过滤）：
 *    scope=ALL      我的班命中（单班 class_id=我的班，或跨班 class_id=0 且
 *                   notice_msg_class 含我的班）
 *    scope=COMMITTEE  我是班委（role=ADMIN、非超管、非辅导员）或我在 notice_msg_target
 *    scope=PICK/POSITION  我在 notice_msg_target
 *
 *  本门禁两段：
 *    ① 行为式：Module._load 钩子加载**生产** cloudfunctions/media/index.js
 *       （wx-server-sdk / music-metadata / ./common/db 全桩，guard/week/review-demo/
 *       audit/resp 用真源码），msgList 输出必须逐行带 forMe —— 3 个身份 × 9 种
 *       通知形状（本班/别班/跨班含我/跨班不含我/PICK 别人/PICK 我/班委/职位/多选）全网格。
 *    ② 前端单测：加载**生产** miniprogram/utils/notice.js（wx storage 桩），
 *       unackedCount 必须按 forMe !== false 过滤，且 seen 游标 / isPublisher 口径不回归。
 *
 *  退出码：全过 0；任一不过 1（由 scripts/run_all_gates.sh 的 glob 自动纳入）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const MEDIA_PATH = path.join(ROOT, 'cloudfunctions', 'media', 'index.js');
const NOTICE_UTIL = path.join(ROOT, 'miniprogram', 'utils', 'notice.js');

/* ============================================================
 * 1. 内存假库（通知形状的测试矩阵数据）
 * ============================================================ */
const db = {
  member: [
    // 超管：is_super=1 ⇒ msgList 可见性短路，看得到全部（产品口径不变）
    { id: 10, openid: 'oc-super', class_id: 1, role: 'ADMIN', is_super: 1, group_tag: 'A', status: 'ACTIVE', student_no: '2608010010', name: '张超管', position: '' },
    // 班委：meIsCommittee = role=ADMIN 且 is_super≠1 且 group_tag≠'X'
    { id: 11, openid: 'oc-committee', class_id: 1, role: 'ADMIN', is_super: 0, group_tag: 'A', status: 'ACTIVE', student_no: '2608010011', name: '李班委', position: '班长' },
    // 普通成员（B 组）
    { id: 12, openid: 'oc-member', class_id: 1, role: 'MEMBER', is_super: 0, group_tag: 'B', status: 'ACTIVE', student_no: '2608010012', name: '王同学', position: '' },
    // 别班普通成员（class_id=2）
    { id: 20, openid: 'oc-other', class_id: 2, role: 'MEMBER', is_super: 0, group_tag: 'A', status: 'ACTIVE', student_no: '2608020020', name: '别班同学', position: '' }
  ],
  impersonation: [],
  // msgList 主查询的罐头行（可见性过滤是 DB 的活、本 patch 不动它，故对每个调用方
  // 原样返回全量 9 条 —— forMe 必须独立于可见性正确计算）
  notice: [],
  target: [],   // notice_msg_target(notice_id, member_id)
  class: []     // notice_msg_class(notice_id, class_id)
};

function noticeRow(id, scope, classId, publisherId) {
  return {
    id, title: '通知' + id, content: '内容' + id, images: null,
    link_url: '', link_name: '', scope, need_ack: 0, popup: 0,
    created_at: '2026-10-24 10:00:00', class_id: classId, publisher_id: publisherId,
    publisherName: '发布者', acked: 0, popupSeen: 0, ackCount: 0, recipientCount: 0
  };
}
// 10 种形状（publisher=99，任何受测身份都不是发布者）
db.notice = [
  noticeRow(1, 'ALL', 1, 99),        // 本班全体
  noticeRow(2, 'ALL', 2, 99),        // 别班全体
  noticeRow(3, 'ALL', 0, 99),        // 跨班全体：notice_msg_class = {1,2}（含我班）
  noticeRow(4, 'ALL', 0, 99),        // 跨班全体：notice_msg_class = {2}（不含我班）
  noticeRow(5, 'PICK', 0, 99),       // 指定给 12
  noticeRow(6, 'PICK', 0, 99),       // 指定给超管 10 自己
  noticeRow(7, 'COMMITTEE', 1, 99),  // 仅发班委：target = {11}
  noticeRow(8, 'POSITION', 1, 99),   // 按职位：target = {11}
  noticeRow(9, 'PICK', 0, 99),       // 多选：target = {10, 12}
  noticeRow(10, 'COMMITTEE', 1, 99)  // 历史班委通知：无 target 行（靠 meIsCommittee 兜底，
                                     // 与可见性 SQL 的班委兜底同口径）
];
db.class = [
  { notice_id: 3, class_id: 1 }, { notice_id: 3, class_id: 2 },
  { notice_id: 4, class_id: 2 }
];
db.target = [
  { notice_id: 5, member_id: 12 },
  { notice_id: 6, member_id: 10 },
  { notice_id: 7, member_id: 11 },
  { notice_id: 8, member_id: 11 },
  { notice_id: 9, member_id: 10 }, { notice_id: 9, member_id: 12 }
];

/** 期望矩阵：forMe[noticeId] */
const EXPECT = {
  'oc-super':     { 1: true, 2: false, 3: true, 4: false, 5: false, 6: true, 7: false, 8: false, 9: true, 10: false },
  'oc-committee': { 1: true, 2: false, 3: true, 4: false, 5: false, 6: false, 7: true, 8: true, 9: false, 10: true },
  'oc-member':    { 1: true, 2: false, 3: true, 4: false, 5: true, 6: false, 7: false, 8: false, 9: true, 10: false }
};

/* ---------- 依赖桩 ---------- */
let currentOpenid = '';
const cloudStub = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init: () => {},
  getWXContext: () => ({ OPENID: currentOpenid, APPID: '' }),
  downloadFile: async () => ({ fileContent: Buffer.alloc(0) }),
  getTempFileURL: async () => ({ fileList: [] })
};
const mmStub = { parseBuffer: async () => ({ format: {} }) };

function makePool() {
  return {
    async query(sql, args) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      const A = args || [];
      if (/^SELECT \* FROM member WHERE openid = \? LIMIT 1$/.test(s)) {
        return [db.member.filter(r => r.openid === A[0]).slice(0, 1)];
      }
      if (/^SELECT member_id FROM impersonation WHERE openid = \? LIMIT 1$/.test(s)) {
        return [db.impersonation.filter(r => r.openid === A[0]).slice(0, 1)];
      }
      // msgList 主查询（含回执分子分母那段巨型 SELECT）
      if (/^SELECT n\.id, n\.title/.test(s) && /FROM notice_msg n/.test(s)) {
        return [db.notice.map(r => Object.assign({}, r))];
      }
      // 回执名单（canSeeAck 时逐条跑）
      if (/^SELECT mm\.name, mm\.student_no/.test(s)) return [[]];
      // 本次新增的两条轻查询
      if (/^SELECT notice_id FROM notice_msg_target WHERE member_id = \?$/.test(s)) {
        return [db.target.filter(r => r.member_id === A[0])];
      }
      if (/^SELECT notice_id FROM notice_msg_class WHERE class_id = \?$/.test(s)) {
        return [db.class.filter(r => r.class_id === A[0])];
      }
      // 2026-10-29：main 主链路新增演示态判定 guard.isDemoMember → 查演示班 id；
      // 本用例没有演示班 ⇒ 回空数组，isDemoMember 判 false（放行）。
      if (/^SELECT id FROM `class` WHERE is_demo = 1$/.test(s)) return [[]];
      throw new Error('FAKE-DB 未覆盖的查询: ' + s.slice(0, 140));
    }
  };
}

const pool = makePool();
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return cloudStub;
  if (request === 'music-metadata') return mmStub;
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (e) { /* noop */ }
  if (/media[/\\]common[/\\]db(\.js)?$/.test(resolved || '')) return { getPool: () => pool };
  return origLoad.apply(this, arguments);
};

let main = null;
try {
  main = require(MEDIA_PATH).main;
} finally {
  Module._load = origLoad;
}

/* ============================================================
 * 2. 断言框架
 * ============================================================ */
let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [OK] ' + name); }
  else { fail += 1; failed.push(name); console.log('  [NG] ' + name + (extra === undefined ? '' : '  => ' + extra)); }
}

(async () => {
  try {
    if (typeof main !== 'function') { console.error('FAIL: media/index.js 未导出 main'); process.exit(1); }
    console.log('== 通知角标「只提醒与自己相关的」（media.msgList 生产源码 + notice.js 生产源码） ==');

    /* ---------- ① 后端 forMe 全网格 ---------- */
    for (const openid of Object.keys(EXPECT)) {
      currentOpenid = openid;
      const res = await main({ action: 'msgList', payload: {} });
      const list = (res && res.data) || [];
      check('① ' + openid + ' msgList 返回 10 行', list.length === 10, 'len=' + list.length);
      const got = {};
      list.forEach(r => { got[r.id] = r.forMe; });
      const exp = EXPECT[openid];
      for (const id of Object.keys(exp)) {
        check('① ' + openid + ' 通知' + id + ' forMe=' + exp[id],
          got[id] === exp[id], '实际=' + got[id]);
      }
    }

    /* ---------- ② 前端 unackedCount 过滤 ---------- */
    // wx storage 内存桩（按 key 隔离，模拟按成员分开的 seen 游标）
    const store = {};
    global.wx = {
      getStorageSync: (k) => (k in store ? store[k] : ''),
      setStorageSync: (k, v) => { store[k] = v; }
    };
    const notice = require(NOTICE_UTIL);

    const list = [
      { id: 5, isPublisher: false, forMe: true },   // 与我相关的新通知 → 计
      { id: 6, isPublisher: false, forMe: false },  // 别班/别人类的 → 不计（本 bug 回归判据）
      { id: 7, isPublisher: true, forMe: true },    // 自己发的 → 不计
      { id: 8, isPublisher: false, forMe: true },   // 与我相关的新通知 → 计
      { id: 9, isPublisher: false }                 // 旧后端缺 forMe → 兼容计数
    ];
    check('②.1 forMe=false 的行不进角标（超管不该被别班/别人的通知亮红点）',
      notice.unackedCount(list, 10) === 3, 'count=' + notice.unackedCount(list, 10));
    check('②.2 缺 forMe 字段按老口径计数（部署窗口期兼容，不突变全消）',
      notice.unackedCount([{ id: 20, isPublisher: false }], 10) === 1);
    store['noticeSeen:10'] = 8;
    check('②.3 seen 游标仍生效（id≤seen 不计）',
      notice.unackedCount(list, 10) === 1, 'count=' + notice.unackedCount(list, 10));
    check('②.4 游标按成员隔离（成员 11 不受 10 的游标影响）',
      notice.unackedCount(list, 11) === 3, 'count=' + notice.unackedCount(list, 11));
    store['noticeSeen:10'] = 0;
    const after = notice.markSeen(list, 10);
    check('②.5 markSeen 推进到列表最大 id 且幂等（推进后角标清零）',
      after === 9 && notice.markSeen(list, 10) === 9 && notice.unackedCount(list, 10) === 0,
      'after=' + after);

    /* ---------- ③ 静态：可见性口径不能被动（超管仍看得到全部） ---------- */
    const mediaSrc = fs.readFileSync(MEDIA_PATH, 'utf8');
    check('③.1 msgList 可见性仍保留超管短路（(? = 1)，超管看得到全部不变）',
      /\(\? = 1\)\s*\n\s*OR n\.publisher_id = \?/.test(mediaSrc));

    /* ---------- 汇总 ---------- */
    console.log('\n==============================');
    console.log('通知角标门禁 通过=' + pass + ' 失败=' + fail);
    if (fail > 0) { console.log('失败项: ' + failed.join(' / ')); process.exit(1); }
    console.log('全绿');
    process.exit(0);
  } catch (e) {
    console.error('[check-notice-badge] 运行异常:', e);
    process.exit(1);
  }
})();
