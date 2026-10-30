#!/usr/bin/env node
/**
 * 普通成员只读视角门禁（2026-10-28）
 * ============================================================
 * 背景（真机故障，不是设计洁癖）：
 *   示例班级A 50 名 MEMBER 从「班级信息 → 班级成员」进去**名单空白**。
 *   根因：roster 页恒调 member.list({public:'manage'})，而 manage 的鉴权是
 *   `guard.requireAdmin`（role ∈ ADMIN/MONITOR）⇒ MEMBER 一律 40003，
 *   前端 `catch` 静默 ⇒ 用户看到「空白、无任何提示」。
 *   同一批人看「班级概况」三个数字也是「—」，因为 member.stats 当时要 needAdmin。
 *
 * 本门禁守四件事（任一条被改回，这套故障立刻复发）：
 *   ① member.list 必须有 public='read' 只读分支，且**不走** requireAdmin
 *   ② read 分支**绝不外泄**学号 / 微信绑定态 / role / isSuper（姓名+组别+职务足够）
 *   ③ read 分支**锁死本班**（classIdOf），不接受 payload.classId 跨班查
 *   ④ roster 前端按身份选 public；member.stats 不得退回 needAdmin
 *   ⑤ 班级信息页课程表摘要：保洁课次不算“课”，无组身份不数 A/B 分组课（否则节数翻倍）
 *
 * 为什么这些必须是门禁而不是注释：它们都是「静默失败」—— 403 被 catch 吞掉、
 * 字段缺失渲染成空字符串、节数翻倍只是数字变大。没有任何报错会提醒后来者改错了。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log('PASS  ' + msg); }
  else { fail += 1; console.log('FAIL  ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
/** 去注释（等长替换，保住行号），判据只扫代码 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let q = null;
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '\\') { i += 2; continue; }
      if (c === q) q = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out[i] = ' '; i += 1; }
      if (i < src.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    i += 1;
  }
  return out.join('');
}
/** 取两个锚点之间的源码（左闭右开） */
function between(src, from, to) {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = src.indexOf(to, i);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

const memberSrc = stripComments(read('cloudfunctions/member/index.js'));
const rosterJs = stripComments(read('miniprogram/pages/roster/index.js'));
const classinfoJs = stripComments(read('miniprogram/pages/classinfo/index.js'));

/* ---------- ① read 分支存在且不用 requireAdmin ---------- */
const readBlk = between(memberSrc, "payload.public === 'read'", "payload.public === 'manage'");
ok(readBlk.length > 0, '① member.list 存在 public=\'read\' 只读分支');
ok(/guard\.requireBind\(ctx\)/.test(readBlk),
  '① read 分支起手 guard.requireBind（未绑定必须挡掉）');
ok(!/requireAdmin/.test(readBlk),
  '① read 分支**不得**调 requireAdmin —— 那正是普通成员 403 的根因');

/* ---------- ② 脱敏：不外泄学号 / 绑定态 / 权限字段 ---------- */
/* SELECT 只允许取 student_no 用于**排序**，不允许把 openid 读出来；
 * 返回体只允许 id / name / group_tag / position。 */
ok(!/SELECT[^;]*openid/i.test(readBlk),
  '② read 分支的 SELECT 不读 openid（绑定态不外泄）');
ok(!/studentNo\s*:/.test(readBlk) && !/bound\s*:/.test(readBlk),
  '② read 分支不回传 studentNo / bound（这两项只给管理视图）');
ok(!/\brole\s*:/.test(readBlk) && !/isSuper\s*:/.test(readBlk),
  '② read 分支不回传 role / isSuper（权限字段不进入公共名单）');
ok(/readOnly\s*:\s*true/.test(readBlk),
  '② read 分支带 readOnly 标记（前端据此隐藏学号列与管理动作）');
ok(/position\s*:\s*r\.position/.test(readBlk),
  '② read 分支回传 position（职务是公开信息，前端用它出「班长/生活委员」标签）');

/* ---------- ③ 锁死本班 ---------- */
ok(/guard\.classIdOf\(ctx\)/.test(readBlk),
  '③ read 分支用 guard.classIdOf(ctx) 锁定本班');
ok(!/payload\.classId/.test(readBlk),
  '③ read 分支不接受 payload.classId（普通成员没有跨班查名单的场景）');

/* ---------- ④ 前端按身份选档位 + stats 不再要求管理员 ---------- */
ok(/public:\s*readOnly\s*\?\s*'read'\s*:\s*'manage'/.test(rosterJs),
  '④ roster 按 canManage 选 public（只读身份走 read，管理员走 manage）');
ok(/const readOnly = !this\.data\.canManage/.test(rosterJs),
  '④ roster 的只读判定来自 canManage（单一真源，不另起一套身份判断）');
const statsAuth = between(memberSrc, '  stats: {', '  importCsv: {');
ok(statsAuth.length > 0 && !/needAdmin/.test(statsAuth),
  '④ member.stats 不再要求 needAdmin —— 否则普通成员看「班级概况」是 — — —');
ok(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(statsAuth),
  '④ member.stats 收敛到 needBind（跨班仍由 targetClassId 内部拦）');

/* ---------- ⑤ 班级信息页：课程表子卡已下线（2026-10-28 用户要求） ----------
 * 原委：那张卡 bindtap → wx.switchTab('/pages/timetable/index')，也就是切到
 * 底部导航本来就有的第二个 tab —— 点完画面还是原来那个位置，用户的原话是
 * 「点击后仅跳转到一个无意义的页面」。删入口 + 连带清死代码，断言钉死不许回潮。 */
const ciWxmlRaw = read('miniprogram/pages/classinfo/index.wxml');
/* ⚠️ 这里必须单独剥 **HTML 注释**：本脚本的 stripComments 是按 JS 语法写的
 * （只认 // 和 星号块注释），喂 wxml 的 `<!-- -->` 会原样留着 ——
 * 「课程表」三个字一出现在注释里，断言就误判成「卡片还在」。
 * （踩过一次：注释里写「「课程表」已下线」直接把这条门禁打成恒假。） */
const ciWxml = ciWxmlRaw.replace(/<!--[\s\S]*?-->/g, '');
ok(!/data-key=["']timetable["']/.test(ciWxml) && !/课程表/.test(ciWxml),
  '⑤ 课程表子卡已移除（它只是 switchTab 到 tabBar 已有的课表 tab，点了画面不变）');
ok(!/timetable/i.test(classinfoJs) && !/ttConf|ttSub/.test(classinfoJs),
  '⑤ 课程表相关的死代码一并清掉（不再 require data/timetable、不再拉 courseAllSessions）');
/* 删卡后入场动画档位必须重排：hero=st-1，子卡 st-2..st-5，不许留 st-6 断档
 * （断档本身不报错，只会让「第 6 块」的延迟白等一格，属于看不见的债）。 */
ok(/st-5/.test(ciWxml) && !/st-6/.test(ciWxml),
  '⑤ 删卡后档位仍是 st-1~st-5 连续（hero + 4 张子卡）');
ok(!/tt\.setClass/.test(classinfoJs),
  '⑤ 班级信息页不得调 tt.setClass（全局课表单例，改它会让课程表 tab 串班）');

/* ---------- ⑥ 变异自证：把 read 分支换成 requireAdmin，①必须翻转 ---------- */
const MUT_A = memberSrc.replace("payload.public === 'read'", "payload.public === 'readX'");
ok(readBlk.length > 0 && MUT_A.indexOf("payload.public === 'read'") < 0,
  '⑥ 自证：改掉 read 分支名后定位失效（判据锚在真实分支上，不是恒真空串）');
const MUT_B = readBlk.replace('guard.requireBind(ctx)', 'guard.requireAdmin(ctx)');
ok(/requireAdmin/.test(MUT_B),
  '⑥ 自证：把 read 的 requireBind 换成 requireAdmin 后会被「不得 requireAdmin」抓住');

console.log('');
console.log('通过=' + pass + ' 失败=' + fail);
if (fail) process.exit(1);
