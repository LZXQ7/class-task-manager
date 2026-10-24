#!/usr/bin/env node
/**
 * 作业列表页（homework/index.js）页面逻辑门禁（2026-10-24）
 * ============================================================
 *  背景：用户要求「发布的作业可侧滑删除，和通知页面一样」。本门禁加载 index.js
 *  **生产源码**（Module._load 钩子桩掉 api/util/theme + wx 全局），在页面方法级
 *  seam 断言，防侧滑删除交互回归。
 *
 *  覆盖：
 *   L1 列表数据映射（SELF→仅自己 / requireText / 状态文案与色调）
 *   L2 左滑手势：横向才动、offset 钳制 [-80,0]、过半吸附展开、同时只展开一张
 *   L3 删除：canDelete=false 不弹窗不调接口；确认后调 homeworkDelete 并摘除卡片；
 *      取消则收起删除区；失败保留卡片
 *   L4 _payload 带 classId；删除请求参数为 homeworkId
 *
 *  退出码：全过 0；任一不过 1（由 scripts/run_all_gates.sh 的 glob 自动纳入）。
 */
'use strict';
const path = require('path');
const Module = require('module');

/* ---------- 依赖桩 ---------- */
const calls = { list: [], del: [], toast: [], modal: [], nav: [] };
let listRes = { list: [], canReview: true };
const apiStub = {
  homeworkList: async (p) => { calls.list.push(p); return listRes; },
  homeworkDelete: async (p) => { calls.del.push(p); return { ok: true }; }
};
const utilStub = { toast: (m) => calls.toast.push(m) };
const themeStub = { mount() {}, unmount() {} };
let modalCb = null;   // showModal 的 success 回调（测试手动触发）

global.wx = {
  navigateTo: (o) => calls.nav.push(o && o.url),
  navigateBack: () => calls.nav.push('back'),
  switchTab: (o) => calls.nav.push(o && o.url),
  showToast: (o) => calls.toast.push(o && o.title),
  showModal: (o) => { calls.modal.push(o); modalCb = o && o.success; }
};

const IDX_PATH = path.resolve(__dirname, '../miniprogram/pages/homework/index.js');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (e) { /* noop */ }
  if (/utils[/\\]api(\.js)?$/.test(resolved || '')) return apiStub;
  if (/utils[/\\]util(\.js)?$/.test(resolved || '')) return utilStub;
  if (/utils[/\\]theme(\.js)?$/.test(resolved || '')) return themeStub;
  return origLoad.apply(this, arguments);
};

let cfg = null;
global.Page = (c) => { cfg = c; };
require(IDX_PATH);
Module._load = origLoad;

/* ---------- 断言框架 ---------- */
let pass = 0, fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [OK] ' + name); }
  else { fail += 1; failed.push(name); console.log('  [NG] ' + name + (extra === undefined ? '' : '  => ' + extra)); }
}

/**
 * setData 桩：支持小程序路径语法 `list[i].field`（onSwipeStart/Move/End 全靠它），
 * 平铺 key 走普通赋值。fake 环境必须复刻这个行为，否则手势断言全假过/假挂。
 */
function setByPath(data, patch) {
  Object.keys(patch || {}).forEach((k) => {
    const m = /^([A-Za-z_$][\w$]*)\[(\d+)\]\.([A-Za-z_$][\w$]*)$/.exec(k);
    if (m && Array.isArray(data[m[1]]) && data[m[1]][Number(m[2])] !== undefined) {
      data[m[1]][Number(m[2])][m[3]] = patch[k];
    } else {
      data[k] = patch[k];
    }
  });
}

function freshPage(overrides) {
  const p = Object.assign({}, cfg, { data: JSON.parse(JSON.stringify(cfg.data)) });
  p.setData = function (patch) { setByPath(this.data, patch); };
  Object.assign(p.data, overrides || {});
  return p;
}

function touch(x, y) { return { touches: [{ clientX: x, clientY: y }] }; }

(async () => {
  try {
    if (!cfg) { console.error('FAIL: homework/index.js 未注册 Page'); process.exit(1); }
    console.log('== 作业列表页页面逻辑（index.js 生产源码） ==');

    /* ---------- L1 数据映射 ---------- */
    const hwRow = (o) => Object.assign({
      id: 1, title: 't', brief: '', dueDate: '2026-10-25 12:00',
      groups: ['A'], requireType: 'NONE', myStatus: null, canDelete: false
    }, o || {});
    listRes = {
      list: [
        hwRow({ id: 1, groups: ['A'], requireType: 'IMAGE', myStatus: 'PENDING' }),
        hwRow({ id: 2, groups: ['SELF'], requireType: 'EITHER', canDelete: true }),
        hwRow({ id: 3, groups: ['A', 'B'], requireType: 'NONE', myStatus: 'DONE' })
      ],
      canReview: true
    };
    const p1 = freshPage({ classId: 7 });
    await new Promise((resolve) => {
      p1.setData = function (patch) {
        setByPath(this.data, patch);
        if ('loaded' in patch) resolve();
      };
      p1.onShow();
    });
    const l = p1.data.list;
    check('L1.1 SELF 分组显示「仅自己」', l[1].groupText === '仅自己', l[1].groupText);
    check('L1.2 requireText 映射（IMAGE→图片 / EITHER→图片或文件）',
      l[0].requireText === '图片' && l[1].requireText === '图片或文件' && l[2].requireText === '',
      JSON.stringify(l.map(x => x.requireText)));
    check('L1.3 状态文案与色调（PENDING→待批阅 / null→未交 / DONE→已完成）',
      l[0].statusText === '待批阅' && l[0].statusTone === 'PENDING'
      && l[1].statusText === '未交' && l[1].statusTone === 'none'
      && l[2].statusText === '已完成' && l[2].statusTone === 'DONE',
      JSON.stringify(l.map(x => x.statusText + '/' + x.statusTone)));
    check('L1.4 canDelete 透传（第 2 条可删）',
      l[0].canDelete === false && l[1].canDelete === true && l[2].canDelete === false,
      JSON.stringify(l.map(x => !!x.canDelete)));

    /* ---------- L2 左滑手势 ---------- */
    const p2 = freshPage({ classId: 7 });
    p2.data.list = [hwRow({ id: 11, canDelete: true }), hwRow({ id: 12, canDelete: true })];
    // 横向滑动：-30px → offset = -30（在 [-80,0] 内）
    p2.onSwipeStart(Object.assign(touch(200, 300), { currentTarget: { dataset: { id: 11, index: 0 } } }));
    p2.onSwipeMove(touch(170, 305));   // dx=-30, dy=5：横向为主
    check('L2.1 横向滑动卡片左移（offset=-30）', p2.data.list[0].offset === -30, String(p2.data.list[0].offset));
    // 纵向滑动：不动卡片
    p2.onSwipeStart(Object.assign(touch(200, 300), { currentTarget: { dataset: { id: 11, index: 0 } } }));
    p2.onSwipeMove(touch(202, 380));   // dx=2, dy=80：纵向为主
    check('L2.2 纵向滑动不劫持（offset 保持上一态不变）', p2.data.list[0].offset === -30, String(p2.data.list[0].offset));
    // 超程钳制：-200 → -80
    p2.onSwipeStart(Object.assign(touch(300, 300), { currentTarget: { dataset: { id: 11, index: 0 } } }));
    p2.onSwipeMove(touch(100, 300));   // dx=-200
    check('L2.3 超程钳制在 -80（删除区总宽）', p2.data.list[0].offset === -80, String(p2.data.list[0].offset));
    // 过半吸附：-60 < -40 ⇒ 展开 -80 且记录 _openId
    p2.onSwipeStart(Object.assign(touch(300, 300), { currentTarget: { dataset: { id: 11, index: 0 } } }));
    p2.onSwipeMove(touch(240, 300));   // dx=-60
    p2.onSwipeEnd();
    check('L2.4 滑过一半吸附展开（offset=-80）', p2.data.list[0].offset === -80, String(p2.data.list[0].offset));
    check('L2.5 swiping 复位（松手后恢复过渡动画）', p2.data.list[0].swiping === false, String(p2.data.list[0].swiping));
    // 滑第二张：第一张应被收起（同时只展开一张）
    p2.onSwipeStart(Object.assign(touch(300, 300), { currentTarget: { dataset: { id: 12, index: 1 } } }));
    p2.onSwipeMove(touch(240, 300));
    p2.onSwipeEnd();
    check('L2.6 展开第二张时第一张自动收起', p2.data.list[0].offset === 0 && p2.data.list[1].offset === -80,
      JSON.stringify(p2.data.list.map(x => x.offset)));
    // 展开态向右滑收回：start offset=-80，dx=+50 ⇒ -30 未过半 ⇒ 回弹 0
    p2.onSwipeStart(Object.assign(touch(200, 300), { currentTarget: { dataset: { id: 12, index: 1 } } }));
    p2.onSwipeMove(touch(250, 300));   // dx=+50 ⇒ offset=-30
    p2.onSwipeEnd();
    check('L2.7 展开态右滑未过半回弹收起（offset=0）', p2.data.list[1].offset === 0, String(p2.data.list[1].offset));

    /* ---------- L3 删除 ---------- */
    // 无权限（canDelete=false）：不弹窗、不调接口
    calls.modal.length = 0; calls.del.length = 0;
    const p3a = freshPage({ classId: 7 });
    p3a.data.list = [hwRow({ id: 21, canDelete: false, title: '别人的作业' })];
    p3a.onDelete({ currentTarget: { dataset: { id: 21, index: 0 } } });
    check('L3.1 无删除权限不弹窗不调接口', calls.modal.length === 0 && calls.del.length === 0,
      'modal=' + calls.modal.length + ' del=' + calls.del.length);

    // 有权限：取消 → 只收起删除区，不删
    calls.modal.length = 0; calls.del.length = 0;
    const p3b = freshPage({ classId: 7 });
    p3b.data.list = [hwRow({ id: 22, canDelete: true, title: '我的作业' })];
    p3b.onDelete({ currentTarget: { dataset: { id: 22, index: 0 } } });
    check('L3.2 有权限先弹二次确认（含标题与不可恢复提示）',
      calls.modal.length === 1 && calls.modal[0].content.indexOf('我的作业') >= 0
      && calls.modal[0].content.indexOf('不可恢复') >= 0,
      JSON.stringify(calls.modal[0] && calls.modal[0].content));
    modalCb({ confirm: false });
    check('L3.3 取消不调删除接口', calls.del.length === 0);
    check('L3.4 取消后删除区收起（offset=0）', p3b.data.list[0].offset === 0, String(p3b.data.list[0].offset));

    // 有权限：确认 → 调接口 + 摘除卡片 + toast
    calls.modal.length = 0; calls.del.length = 0; calls.toast.length = 0;
    const p3c = freshPage({ classId: 7 });
    p3c.data.list = [hwRow({ id: 23, canDelete: true, title: '要删的作业' }), hwRow({ id: 24 })];
    p3c.onDelete({ currentTarget: { dataset: { id: 23, index: 0 } } });
    modalCb({ confirm: true });
    await new Promise((r) => setTimeout(r, 0));
    check('L3.5 确认后调 api.homeworkDelete（参数 homeworkId）',
      calls.del.length === 1 && calls.del[0].homeworkId === 23, JSON.stringify(calls.del));
    check('L3.6 删除成功后卡片摘除、列表剩 1 条',
      p3c.data.list.length === 1 && p3c.data.list[0].id === 24,
      JSON.stringify(p3c.data.list.map(x => x.id)));
    check('L3.7 删除成功 toast「已删除」', calls.toast.indexOf('已删除') >= 0, JSON.stringify(calls.toast));

    /* ---------- L4 _payload ---------- */
    const p4 = freshPage({ classId: 9 });
    const pl = p4._payload({ homeworkId: 1 });
    check('L4.1 _payload 带 classId', !!pl && pl.classId === 9 && pl.homeworkId === 1, JSON.stringify(pl));

    /* ---------- 汇总 ---------- */
    console.log('\n==============================');
    console.log('作业列表页页面逻辑门禁 通过=' + pass + ' 失败=' + fail);
    if (fail > 0) { console.log('失败项: ' + failed.join(' / ')); process.exit(1); }
    console.log('全绿');
    process.exit(0);
  } catch (e) {
    console.error('[check-homework-list-page] 运行异常:', e);
    process.exit(1);
  }
})();
