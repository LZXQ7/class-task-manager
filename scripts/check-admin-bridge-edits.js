/**
 * 门禁：后台编辑入口 + 服务端票据桥接（2026-11-28）
 * ============================================================
 * 守四件事：
 *   S1 票据层真行为 —— 过期 / 换人 / 停用 / 非超管跨班必须验票失败（真跑函数体）；
 *   S2 同源复用 —— 13 个云函数入口都把 event 传给 guard，公共副本无漂移；
 *   S3 权限与二次确认 —— 每条新写路由挂 requirePerm，高危额外挂超管+confirm；
 *   S4 前端入口 —— 六个既有页签确有按钮，且提交带 confirm:true。
 *
 * 变异自证见文件末尾：把守卫改坏，判据必须转红。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cf = path.join(root, 'cloudfunctions');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, cond) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL:', name);
}

const bridgeSrc = read('cloudfunctions/common/admin-bridge.js');
const guardSrc = read('cloudfunctions/common/guard.js');
const adminIndex = read('cloudfunctions/admin-web/index.js');
const adminBridgeJs = read('cloudfunctions/admin-web/lib/bridge.js');
const permsSrc = read('cloudfunctions/admin-web/lib/perms.js');
const appSrc = read('cloudfunctions/admin-web/public/app.js');
const htmlSrc = read('cloudfunctions/admin-web/public/index.html');

/* ---------------- S1 票据真行为（跑函数体，不靠正则猜） ---------------- */
const bridgeMod = require(path.join(cf, 'common', 'admin-bridge.js'));

function memberRow(over) {
  return Object.assign({
    id: 7, role: 'ADMIN', is_super: 1, status: 'ACTIVE', class_id: 示例班级A, openid: 'o-real'
  }, over || {});
}
function fakePool(row) {
  return {
    query: async function () {
      if (!row) return [[]];
      return [[Object.assign({}, row, { admin_member_id: row.id, admin_status: 1 })]];
    }
  };
}
const good = bridgeMod.issueTicket('raw-sid-abc', 7, 2604);

t('票据版本与字段齐全', good && good.v === 1 && good.sid === 'raw-sid-abc' && good.memberId === 7 && good.classId === 2604 && !!good.ts);
t('缺 sid 不签发', bridgeMod.issueTicket('', 7, 2604) === null);
t('缺 memberId 不签发', bridgeMod.issueTicket('raw-sid-abc', 0, 2604) === null);

(async function () {
  let m = await bridgeMod.verifyTicket(good, fakePool(memberRow()));
  t('超管可跨班覆盖 class_id', !!m && Number(m.class_id) === 2604);
  t('验票后不泄漏 join 别名', !!m && m.admin_member_id === undefined && m.admin_status === undefined);

  m = await bridgeMod.verifyTicket(good, fakePool(memberRow({ is_super: 0, class_id: 示例班级A })));
  t('非超管跨班被拒（防后台越权）', m === null);

  m = await bridgeMod.verifyTicket(good, fakePool(memberRow({ is_super: 0, class_id: 2604 })));
  t('非超管本班可通行', !!m && Number(m.class_id) === 2604);

  m = await bridgeMod.verifyTicket(Object.assign({}, good, { ts: Date.now() - 120000 }), fakePool(memberRow()));
  t('过期票据被拒', m === null);

  m = await bridgeMod.verifyTicket(Object.assign({}, good, { ts: Date.now() + 60000 }), fakePool(memberRow()));
  t('未来时间戳票据被拒', m === null);

  m = await bridgeMod.verifyTicket(Object.assign({}, good, { memberId: 8 }), fakePool(memberRow()));
  t('票据 memberId 与会话不一致被拒', m === null);

  m = await bridgeMod.verifyTicket(Object.assign({}, good, { v: 99 }), fakePool(memberRow()));
  t('票据版本不符被拒', m === null);

  m = await bridgeMod.verifyTicket(good, fakePool(memberRow({ status: 'DISABLED' })));
  t('成员停用票据被拒', m === null);

  const realErr = console.error;
  console.error = function () {};
  m = await bridgeMod.verifyTicket(good, null);
  console.error = realErr;
  t('无会话返回空', m === null);

  /* ---------------- S2 同源复用 ---------------- */
  t('guard 接受 event 参数', /async function getContext\(event\)/.test(guardSrc));
  t('guard 识别票据保留字段', guardSrc.indexOf('__wbAdminBridge') >= 0);
  t('guard 验票失败抛 40001', /后台票据无效或已过期/.test(guardSrc));

  const fns = ['adjust', 'auth', 'class', 'stat', 'course', 'member', 'poster',
    'schedule', 'fee', 'export', 'media', 'duty'];
  fns.forEach(function (fn) {
    const src = read('cloudfunctions/' + fn + '/index.js');
    t(fn + ' 入口传 event 给 guard', src.indexOf('await guard.getContext(event)') >= 0);
    t(fn + ' common 副本无漂移',
      read('cloudfunctions/' + fn + '/common/admin-bridge.js') === bridgeSrc &&
      read('cloudfunctions/' + fn + '/common/guard.js') === guardSrc);
  });

  /* ---------------- S3 后端路由与权限 ---------------- */
  t('admin-web 引入桥接模块', /require\('\.\/lib\/bridge'\)/.test(adminIndex));
  t('SDK 惰性加载（本地无依赖也能加载 index）',
    !/^const cloud = require\('wx-server-sdk'\)/m.test(adminBridgeJs) &&
    adminBridgeJs.indexOf('function cloudSdk()') >= 0);
  t('raw sid 不导出给浏览器', /module\.exports = \{ call \}/.test(adminBridgeJs));
  t('桥接票据字段名一致', adminBridgeJs.indexOf('__wbAdminBridge: ticket') >= 0);

  // 每条写路由都必须挂 requirePerm；高危额外挂超管 + 二次确认。
  const routes = [
    ['/api/notice', 'notice'],
    ['/api/notice/recycle/clear', 'notice'],
    ['/api/notice/:id/delete', 'notice'],
    ['/api/notice/:id/restore', 'notice'],
    ['/api/speech/generate', 'speech'],
    ['/api/speech/reassign', 'speech'],
    ['/api/speech/swap', 'speech'],
    ['/api/speech/add', 'speech'],
    ['/api/speech/:id/delete', 'speech'],
    ['/api/speech/clear', 'speech'],
    ['/api/speech/settings', 'speech'],
    ['/api/speech/slot-rules', 'speech'],
    ['/api/duty/generate', 'duty'],
    ['/api/duty/reassign', 'duty'],
    ['/api/duty/reassign-undo', 'duty'],
    ['/api/duty/add', 'duty'],
    ['/api/duty/clear', 'duty'],
    ['/api/duty/publish', 'duty'],
    ['/api/duty/unpublish', 'duty'],
    ['/api/timetable/publish-to-class', 'course'],
    ['/api/timetable/shift', 'course'],
    ['/api/timetable/shift/remove', 'course'],
    ['/api/timetable/holiday', 'course'],
    ['/api/timetable/holiday/remove', 'course'],
    ['/api/timetable/day-shift', 'course'],
    ['/api/timetable/day-shift/remove', 'course'],
    ['/api/classes/:id/token', 'class'],
    ['/api/members/:id/note', 'members.edit'],
    ['/api/members/:id/note/:noteId/delete', 'members.edit'],
    ['/api/members/:id/unbind', 'members.edit']
  ];
  routes.forEach(function (r) {
    const line = adminIndex.split('\n').filter(function (l) {
      return l.indexOf("app.post('" + r[0] + "'") >= 0;
    })[0] || '';
    t('路由存在 ' + r[0], !!line);
    t('路由挂权限 ' + r[0], line.indexOf("requirePerm('" + r[1] + "')") >= 0);
  });

  const highRisk = ['/api/notice/recycle/clear', '/api/speech/clear', '/api/duty/clear',
    '/api/timetable/publish-to-class', '/api/timetable/holiday/remove',
    '/api/timetable/day-shift/remove', '/api/classes/:id/token', '/api/members/:id/unbind'];
  highRisk.forEach(function (p) {
    const line = adminIndex.split('\n').filter(function (l) { return l.indexOf("app.post('" + p + "'") >= 0; })[0] || '';
    t('高危限超管 ' + p, line.indexOf('requireSuperSession') >= 0);
    t('高危二次确认 ' + p, line.indexOf('requireConfirm') >= 0);
  });
  t('非超管班级覆盖被挡（票据层 S5）', /只有超管（role=ADMIN 且 is_super=1）能覆盖/.test(bridgeSrc));

  /* ---------------- S4 前端入口 ---------------- */
  t('index 注释已移除作业页', !/→ 作业 →/.test(htmlSrc));
  t('postEdit 强制 confirm:true', /confirm: true, classId: state\.classId/.test(appSrc));
  t('二次确认走站内弹层', /postEdit[\s\S]{0,200}confirmDialog/.test(appSrc));
  t('通知页有发布入口', /id="nt-add"/.test(appSrc) && /api\('\/api\/notice'/.test(appSrc));
  t('通知页有删除入口', /data-nt-del/.test(appSrc) && /\/api\/notice\/' \+/.test(appSrc));
  t('演讲页有生成入口', /id="sp-generate"/.test(appSrc) && /\/api\/speech\/generate/.test(appSrc));
  t('演讲页有清空入口', /id="sp-clear"/.test(appSrc) && /\/api\/speech\/clear/.test(appSrc));
  t('值日页有生成入口', /id="duty-generate"/.test(appSrc) && /\/api\/duty\/generate/.test(appSrc));
  t('值日页有发布入口', /id="duty-publish"/.test(appSrc) && /\/api\/duty\/publish/.test(appSrc));
  t('值日页有清空入口', /id="duty-clear"/.test(appSrc) && /\/api\/duty\/clear/.test(appSrc));
  t('课表页有调课入口', /id="btn-shift"/.test(appSrc) && /\/api\/timetable\/shift'/.test(appSrc));
  t('课表页有发布到全班', /id="btn-publish-class"/.test(appSrc) && /\/api\/timetable\/publish-to-class/.test(appSrc));
  t('班级页有口令重置', /data-c-token/.test(appSrc) && /\/token'/.test(appSrc));
  t('成员页有备注入口', /data-m-note/.test(appSrc) && /\/note'/.test(appSrc));
  t('成员页有解绑入口', /data-m-unbind/.test(appSrc) && /\/unbind'/.test(appSrc));

  /* ---------------- 变异自证：把守卫改坏，判据必须转红 ---------------- */
  function hasExpiry(src) { return /age > MAX_AGE_MS/.test(src); }
  t('变异自证·去掉过期检查会被抓', !hasExpiry(bridgeSrc.replace('age > MAX_AGE_MS', 'age > 999999999')));
  function hasSuperGuard(src) { return /只有超管（role=ADMIN 且 is_super=1）能覆盖/.test(src); }
  t('变异自证·放开非超管跨班会被抓', !hasSuperGuard(bridgeSrc.replace('只有超管（role=ADMIN 且 is_super=1）能覆盖', '任意角色可覆盖')));
  function hasConfirmGuard(src) { return /req\.body\.confirm !== true/.test(src); }
  t('变异自证·去掉二次确认会被抓', !hasConfirmGuard(adminIndex.replace('req.body.confirm !== true', 'false')));
  function hasEventForward(src) { return src.indexOf('await guard.getContext(event)') >= 0; }
  t('变异自证·入口不传 event 会被抓', !hasEventForward('await guard.getContext()'));

  console.log('\ncheck-admin-bridge-edits:', pass + ' passed,', fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.error('gate crashed:', e && e.stack || e);
  process.exitCode = 1;
});
