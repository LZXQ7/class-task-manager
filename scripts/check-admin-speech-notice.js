#!/usr/bin/env node
/**
 * 后台「课前演讲 + 班级通知」两页门禁（2026-11-28）
 * ============================================================
 * 用户诉求：「后台管理页面增加课前演讲页，检查一下小程序有什么可以增加到后台管理查看的。」
 * 经四轮 AskUserQuestion 定口径：
 *   · 演讲页 = 只读 + 后台发布/撤回；通知页 = 只读
 *   · 演讲独立 speech 位（默认学习委员+生活委员+超管）；通知独立 notice 位（默认超管+辅导员）
 *   · 学生标识 = 姓名 + 学号尾 2 位；通知回执只给数字、不列逐人已读
 *   · 发布/撤回必须与小程序 schedule.speechPublish 共用同一套游标快照逻辑（M1 同源漏改高危）
 *
 * 判据全读真实源码；变异自证保证判据不是摆设。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PERMS = read('cloudfunctions/admin-web/lib/perms.js');
const IDX = read('cloudfunctions/admin-web/index.js');
const APP = read('cloudfunctions/admin-web/public/app.js');
const HTML = read('cloudfunctions/admin-web/public/index.html');
const SPEECH_MOD = fs.existsSync(path.join(ROOT, 'cloudfunctions/admin-web/lib/mod-speech.js'))
  ? read('cloudfunctions/admin-web/lib/mod-speech.js') : '';
const NOTICE_MOD = fs.existsSync(path.join(ROOT, 'cloudfunctions/admin-web/lib/mod-notice.js'))
  ? read('cloudfunctions/admin-web/lib/mod-notice.js') : '';
const SPEECH_CORE = read('cloudfunctions/common/speech-core.js');
const SCHEDULE = read('cloudfunctions/schedule/index.js');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

/* ============================================================
 * ① 权限真源：两个新页签 + 模板归属
 * ============================================================ */
section('① 权限真源 perms.js：speech / notice 两个新页签');
check(/\{\s*key:\s*'speech'\s*,\s*label:\s*'课前演讲'/.test(PERMS), 'perms VIEWS 含 speech=课前演讲');
check(/\{\s*key:\s*'notice'\s*,\s*label:\s*'通知'/.test(PERMS), 'perms VIEWS 含 notice=通知');
check(!/SUPER_ONLY\s*=\s*\[[^\]]*'(speech|notice)'/.test(PERMS), 'speech/notice 不是超管专属（按职位模板下发）');

// 职位模板归属：学习委员 + 生活委员有 speech；辅导员有 notice
const tmplLine = (pos) => {
  const m = new RegExp("'" + pos + "':\\s*\\[([^\\]]*)\\]").exec(PERMS);
  return m ? m[1] : '';
};
check(/'speech'/.test(tmplLine('学习委员')), '学习委员模板含 speech（与小程序演讲排班权一致）');
check(/'speech'/.test(tmplLine('生活委员')), '生活委员模板含 speech');
check(/'notice'/.test(tmplLine('辅导员')), '辅导员模板含 notice');
check(!/'notice'/.test(tmplLine('生活委员')), '生活委员默认不含 notice（通知回执只对管理岗开放）');

/* ============================================================
 * ② 前端 VIEWS 注册 + 导航分组
 * ============================================================ */
section('② 前端 app.js VIEWS 注册两个新页 + render 函数');
check(/^\s{4}speech:\s*\{\s*title:\s*'课前演讲',\s*perm:\s*'speech',\s*render:\s*renderSpeech\s*\}/m.test(APP),
  '前端 VIEWS 注册 speech → renderSpeech');
check(/^\s{4}notice:\s*\{\s*title:\s*'通知',\s*perm:\s*'notice',\s*render:\s*renderNotice\s*\}/m.test(APP),
  '前端 VIEWS 注册 notice → renderNotice');
check(/function renderSpeech\(/.test(APP), '前端有 renderSpeech()');
check(/function renderNotice\(/.test(APP), '前端有 renderNotice()');
// NAV_GROUPS 必须覆盖新页，否则分组视图下漏渲染
const navGroupBlock = (APP.match(/var NAV_GROUPS\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
check(/'speech'/.test(navGroupBlock) && /'notice'/.test(navGroupBlock), 'NAV_GROUPS 覆盖 speech 与 notice');

/* ============================================================
 * ③ 后端路由：都挂 requirePerm
 * ============================================================ */
section('③ 后端 index.js 四个路由都挂权限');
const routeRe = /app\.(get|post)\(\s*'(\/api\/speech[^']*|\/api\/notice[^']*)'\s*,\s*([^)]*)/g;
const found = [];
let m;
while ((m = routeRe.exec(IDX))) found.push({ method: m[1].toUpperCase(), path: m[2], guard: m[3].trim() });
const hasRoute = (method, p, perm) => found.some((r) =>
  r.method === method && r.path === p && new RegExp('^requirePerm\\(\'' + perm + '\'').test(r.guard));
check(hasRoute('GET', '/api/speech', 'speech'), 'GET /api/speech 挂 requirePerm(speech)');
check(hasRoute('GET', '/api/notice', 'notice'), 'GET /api/notice 挂 requirePerm(notice)');
check(hasRoute('POST', '/api/speech/publish', 'speech'), 'POST /api/speech/publish 挂 requirePerm(speech)');
check(found.length >= 3, '至少 3 条演讲/通知路由（实得 ' + found.length + '）');

/* ============================================================
 * ④ 演讲模块：名单 SQL / 脱敏 / 发布共用
 * ============================================================ */
section('④ mod-speech.js：名单 SQL、脱敏、发布共用共享层');
check(/module\.exports\s*=\s*\{[^}]*listSpeech/.test(SPEECH_MOD), 'mod-speech 导出 listSpeech');
check(/module\.exports\s*=\s*\{[^}]*publishWeek/.test(SPEECH_MOD), 'mod-speech 导出 publishWeek');
check(/FROM\s+speech\b/.test(SPEECH_MOD) && /speech_publish/.test(SPEECH_MOD),
  '名单读取 speech + speech_publish（草稿/发布态）');
check(/RIGHT\(|SUBSTRING\(|slice\(-2\)|studentNoTail|studentNoLast2/.test(SPEECH_MOD),
  '后台侧只暴露学号尾 2 位（脱敏）');
check(/NOT_TEST\(/.test(SPEECH_MOD), '名单带 NOT_TEST() 过滤测试账号');
// 发布/撤回必须共用共享层，不得自造第二套
check(/require\(['"]\.\/common\/speech-core['"]\)|require\(['"]\.\.\/common\/speech-core['"]\)/.test(SPEECH_MOD),
  'mod-speech 引用 common/speech-core（共用游标逻辑）');
check(!/INSERT INTO speech_cursor|UPDATE speech_cursor/.test(SPEECH_MOD),
  'mod-speech 不自己写 speech_cursor（游标改动只在共享层）');

/* ============================================================
 * ⑤ 共享层：schedule 与 admin-web 同源
 * ============================================================ */
section('⑤ common/speech-core.js 抽出发布/撤回共享函数');
check(/module\.exports\s*=\s*\{[^}]*publishWeek/.test(SPEECH_CORE), 'speech-core 导出 publishWeek');
check(/cursor_snapshot/.test(SPEECH_CORE), '共享层含 cursor_snapshot 撤回回滚');
check(/pending_cursors/.test(SPEECH_CORE), '共享层含旧记录 pending_cursors 兼容');
check(/speech_cursor/.test(SPEECH_CORE), '共享层写 speech_cursor');
// schedule 改为引用共享函数，而不是保留本地副本
check(/speechCore\.publishWeek|publishWeek\s*[,}]/.test(SCHEDULE) && /require\(['"]\.\/common\/speech-core['"]\)/.test(SCHEDULE),
  'schedule 引用共享 publishWeek（不再本地实现发布事务）');
// 关键：schedule 里旧的本地 startCursorsOf / saveSpeechCursors 必须移除（否则两份真源）
check(!/^function startCursorsOf\(/m.test(SCHEDULE), 'schedule 不再本地定义 startCursorsOf');
check(!/^async function saveSpeechCursors\(/m.test(SCHEDULE), 'schedule 不再本地定义 saveSpeechCursors');

/* ============================================================
 * ⑥ 通知模块：只读 + 回执数字 + 演示班过滤
 * ============================================================ */
section('⑥ mod-notice.js：只读、回执数字、演示班过滤');
check(/module\.exports\s*=\s*\{[^}]*listNotice/.test(NOTICE_MOD), 'mod-notice 导出 listNotice');
check(/FROM\s+notice_msg\b/.test(NOTICE_MOD), '通知读取 notice_msg 主表');
check(/COUNT\(/.test(NOTICE_MOD), '回执用 COUNT 聚合（只给数字）');
check(!/\bselect\s+(?:x\.)?(?:xm\.)?member_id\b/i.test(NOTICE_MOD) &&
  !/\breadBy\b|\breadMembers\b|\breadList\b/.test(NOTICE_MOD),
  '不逐人列出已读成员（只给 ackCount/recipientCount）');
check(/module\.exports[\s\S]*$/.test(NOTICE_MOD) && !/module\.exports\s*=\s*\{[^}]*(publish|delete|markRead|add)/.test(NOTICE_MOD),
  '通知模块只读（不导出发布/删除/标记接口）');

/* ============================================================
 * ⑦ 前端脱敏显示：学号尾 2 位
 * ============================================================ */
section('⑦ 前端展示学号尾 2 位');
const speechRenderBlock = (APP.match(/function renderSpeech\([\s\S]*?\n  \}/) || [])[0] || '';
check(/studentNoTail|studentNoLast2|slice\(-2\)|studentNo2/.test(speechRenderBlock) ||
  /尾号|尾 2 位/.test(APP),
  '演讲页前端展示学号尾 2 位');

/* ============================================================
 * ⑧ 变异自证
 * ============================================================ */
section('⑧ 变异自证（改坏 → 判据必须翻红）');

// 8.1 摘掉 speech 权限位 → ① 判据翻红
const permsMut = PERMS.replace(/\{\s*key:\s*'speech'\s*,\s*label:\s*'课前演讲'[^}]*\},?\s*/, '');
check(!/\{\s*key:\s*'speech'\s*,\s*label:\s*'课前演讲'/.test(permsMut),
  '变异被抓：删掉 speech 权限位 → 判据翻红');

// 8.2 后台自造游标写入 → ④ 判据翻红
const modMut = SPEECH_MOD + '\nasync function rogue(){ await db.query("UPDATE speech_cursor SET cursor_val=1"); }';
check(/INSERT INTO speech_cursor|UPDATE speech_cursor/.test(modMut),
  '变异被抓：mod-speech 自写游标 → 判据翻红');

// 8.3 撤回不回滚 → ⑤ 判据翻红
const coreMut = SPEECH_CORE.replace(/cursor_snapshot/g, 'MUTATED_SNAPSHOT');
check(!/cursor_snapshot/.test(coreMut), '变异被抓：共享层去掉快照回滚 → 判据翻红');

// 8.4 通知暴露逐人已读 → ⑥ 判据翻红
const noticeMut = NOTICE_MOD + '\nfunction leaks(){ return readBy; }';
check(/readBy|readMembers/.test(noticeMut), '变异被抓：通知暴露逐人已读 → 判据翻红');

console.log('\n结果：' + (fail ? '失败 ' + fail + ' / 通过 ' + pass : '全部通过（' + pass + ' 项）'));
process.exit(fail ? 1 : 0);
