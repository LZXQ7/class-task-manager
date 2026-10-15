#!/usr/bin/env node
/**
 * 回归门禁：微信审核「登录受限」（运营规范 3.3.3）整改项 —— 审核体验入口。
 * =================================================================
 * 2026-10-11 用户实拍驳回：「存在登录受限问题…【首页】暂无『无法体验功能』时，
 * 需在首页填写有效账号及密码或上传小程序完整功能截图」。
 *
 * 为什么不是一个「口令输入框」就够：常规绑定是**三步**
 * （班级口令 → 名单选人 → 学号后 4 位，见 auth.bind 与 bind 页 step0/1/2），
 * 审核员手里没有口令、名单里也**根本没有他的名字** ⇒ 给口令也过不了第 2 步。
 * 所以必须是一条**一键直达**的旁路（auth.reviewDemo）。
 *
 * 本门禁钉死的性质（每条都对应一个真实事故方向）：
 *   ① 口令**永不回传前端** —— login 只下发布尔位。回传即等于公开后门。
 *   ② 开关**默认关闭**（DDL DEFAULT 0 / DEFAULT ''），关闭时前端整块不渲染。
 *   ③ 绑定目标必须锁死 `is_super = 1` —— 否则会把「测试成员/测试管理员」也当成演示身份。
 *   ④ **绝不顶掉真人**：当前微信已绑真人时报错要求先解绑，而不是覆盖 openid。
 *   ⑤ 口令恒定时间比较（防时序侧信道）。
 *
 * 变异自证（7 组，每组都必须被抓）：M1 去掉 is_super 锁 / M2 login 回传口令 / M3 前端去掉 wx:if /
 *   M4 顶掉真人绑定 / M5 去掉某函数的演示拦截 / M6 从拒绝清单删一条破坏性动作 / M7 绑定不置演示标记。
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const AUTH = 'cloudfunctions/auth/index.js';
const API = 'miniprogram/utils/api.js';
const BIND_JS = 'miniprogram/pages/bind/index.js';
const BIND_WXML = 'miniprogram/pages/bind/index.wxml';
const BIND_WXSS = 'miniprogram/pages/bind/index.wxss';
const SQL = 'scripts/migrate-review-demo.sql';
/* v1.0.6.8：审核体验入口的**超管开关**搬到「我的」页 —— 新增两处受检文件 */
const MINE_WXML = 'miniprogram/pages/mine/index.wxml';
const MINE_JS = 'miniprogram/pages/mine/index.js';
/* v1.0.6.4：演示身份降权 —— 拦截模块 + 5 个受影响函数 */
const RD = 'cloudfunctions/common/review-demo.js';
const FN_MEMBER = 'cloudfunctions/member/index.js';
const FN_CLASS = 'cloudfunctions/class/index.js';
const FN_MEDIA = 'cloudfunctions/media/index.js';
const FN_COURSE = 'cloudfunctions/course/index.js';

const src = {
  auth: read(AUTH), api: read(API), bindJs: read(BIND_JS), bindWxml: read(BIND_WXML), bindWxss: read(BIND_WXSS), sql: read(SQL),
  rd: read(RD), memberIdx: read(FN_MEMBER), classIdx: read(FN_CLASS), mediaIdx: read(FN_MEDIA), courseIdx: read(FN_COURSE),
  mineWxml: read(MINE_WXML), mineJs: read(MINE_JS)
};

/* 剥注释：只判代码形态，注释里提到不算 */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
const code = {};
Object.keys(src).forEach((k) => { code[k] = strip(src[k]); });

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

function judge(o) {
  o = o || {};
  const c = {};
  Object.keys(src).forEach((k) => { c[k] = strip(o[k] != null ? o[k] : src[k]); });
  let n = 0;
  const push = (x) => { if (!x) n += 1; };

  /* ① 路由存在 + 口令绝不回传 */
  push(/reviewDemo:\s*\{/.test(c.auth));
  push(/async function reviewDemoRow\(pool\)/.test(c.auth));
  /* login 只给布尔位；出现「把口令塞进返回值」的形态就判死 */
  push(/reviewDemo: !!\(await reviewDemoRow\(pool\)\)/.test(c.auth));
  push(!/reviewDemo:\s*[^!]*review_demo_code/.test(c.auth));
  push(!/reviewCode:\s*(row|config)\./.test(c.auth));
  /* reviewDemo 的**返回体**不含口令字段。
   * ⚠️ 判据必须只盯 return 语句，不能对整个 action 体 grep `review_demo_code` ——
   *    action 里**必须读**这一列才能做口令比对（safeEqual(code, row.review_demo_code)），
   *    把「读取」当成「泄露」会把这道闸写成永远判红的假闸（2026-10-11 实踩）。 */
  const rd = /reviewDemo:\s*\{[\s\S]*?\n  \},/.exec(c.auth);
  push(!!rd);
  if (rd) {
    const ret = /return \{[^}]*\};/.exec(rd[0]);
    push(!!ret);
    if (ret) push(!/review_demo_code|reviewCode|\bcode\b/.test(ret[0]));
  }

  /* ② 开关默认关闭 + 开启条件双要素 */
  push(/review_demo_on = 1 AND review_demo_code <> ''/.test(c.auth));
  push(/DEFAULT 0/.test(c.sql) && /DEFAULT ''/.test(c.sql));
  push(/review_demo_on TINYINT NOT NULL DEFAULT 0/.test(c.sql));
  push(!/DEFAULT 1/.test(c.sql));

  /* ③ 绑定目标锁死 is_super = 1（否则会绑到测试成员/测试管理员） */
  push(/IS_TEST\(\)\} AND role = 'ADMIN' AND is_super = 1/.test(c.auth));

  /* ④ 绝不顶掉真人。
   * ⚠️ 判据必须落在 **reviewDemo 自己的块里**，不能对全文件 grep「当前微信已绑定」——
   *    bindStaff 里有一句**完全同名**的报错（`当前微信已绑定「…」，请先在「我的」页解除绑定`），
   *    把 reviewDemo 那份删掉后全文件照样搜得到 ⇒ 判据静默通过（2026-10-11 实踩，
   *    与「变异锚点不唯一 = 假自证」同族）。故用 `mine[0].id` 这个 reviewDemo 独有的形态定位。 */
  push(!!rd);
  if (rd) {
    push(/mine\.length && Number\(mine\[0\]\.id\) !== Number\(t\.id\)/.test(rd[0]));
    push(/当前微信已绑定/.test(rd[0]));
  }
  push(/UPDATE member SET openid = NULL WHERE id = \? AND openid IS NOT NULL AND openid <> \?/.test(c.auth));

  /* ⑤ 恒定时间比较 + 失败计数（防爆破） */
  push(/function safeEqual\(a, b\)/.test(c.auth));
  push(/let diff = 0;/.test(c.auth) && /diff \|= x\[i\] \^ y\[i\]/.test(c.auth));
  push(/safeEqual\(code, String\(row\.review_demo_code/.test(c.auth));
  push(/recordFail\(pool, ctx\.openid\)/.test(c.auth));

  /* 前端：入口受布尔位控制 + 事件齐 + 样式有定义 */
  push(/wx:if="\{\{reviewOn\}\}"/.test(c.bindWxml));
  push(/bindtap="onReviewEnter"/.test(c.bindWxml) && /bindinput="onReviewCodeInput"/.test(c.bindWxml));
  push(/onReviewEnter\(\)\s*\{/.test(c.bindJs));
  push(/onReviewCodeInput\(e\)\s*\{/.test(c.bindJs));
  push(/api\.reviewDemo\(\{ code \}/.test(c.bindJs));
  push(/reviewOn: !!\(c && c\.reviewDemo\)/.test(c.bindJs));
  push(/reviewDemo: C\('auth', 'reviewDemo'\)/.test(c.api));
  push(/\.bind-review\s*\{/.test(c.bindWxss));
  push(/\.bind-review-title\s*\{/.test(c.bindWxss));
  push(/\.bind-input-review\s*\{/.test(c.bindWxss));
  /* 颜色必须走 token（深色模式才能自动翻），不许在本页硬编码 */
  push(/color: var\(--text-1\)/.test(c.bindWxss) && /color: var\(--text-2\)/.test(c.bindWxss));
  push(/background: var\(--bg-fill\)/.test(c.bindWxss));

  /* WXML 注释里禁出现 --（会提前闭合注释、真机编译失败） */
  push(!/<!--[\s\S]*?--[^>]/.test(src.bindWxml.replace(/<!--[\s\S]*?-->/g, '')));

  /* ⑥ 演示身份降权（v1.0.6.4）：破坏性动作拦截闸 —— 降权但不缺功能 */
  push(/const DENY_ACTIONS = \[/.test(c.rd));
  push(/function isReviewDemo\(member\)/.test(c.rd));
  push(/function denyDemo\(member, action\)/.test(c.rd));
  push(/throw new BizError\(40010,/.test(c.rd));
  /* 关键破坏性动作逐条钉死在拒绝清单里（被悄悄删掉一条 = 后门重新打开） */
  [
    'member.setRole', 'member.setPosition', 'member.unbind', 'member.setStatus',
    'member.removeMember', 'member.revertImport', 'member.addStaff', 'member.staffDelete',
    'member.testAccountList', 'class.create', 'class.delete', 'class.setActive',
    'auth.setBindOpen', 'media.clearNotices', 'media.appNoticePublish',
    'course.saveHoliday', 'course.saveShift', 'course.importTimetable', 'course.handleApply'
  ].forEach(function (a) { push(new RegExp("'" + a.replace('.', '\\.') + "'").test(c.rd)); });
  /* 5 个受影响函数的 main 都接了拦截（缺一个 = 该函数整类破坏性动作不受控） */
  ['auth', 'memberIdx', 'classIdx', 'mediaIdx', 'courseIdx'].forEach(function (k) {
    push(/const reviewDemo = require\('\.\/common\/review-demo'\)/.test(c[k]));
    push(/reviewDemo\.denyDemo\(ctx\.member, action\)/.test(c[k]));
  });
  /* DB 列：演示态标记（默认关）+ 绑定成功置 1。
   * ⚠️ 判据必须落在 **reviewDemo 自己的块里**，不能对全文件 grep `is_review_demo = 1` ——
   *    reviewDemoSet 里踢演示身份那条 `WHERE is_review_demo = 1` 也含这个字面量，
   *    全文件 grep 会让「绑定不再置演示标记」这个变异**静默通过**（2026-10-15 实踩，
   *    与「变异锚点不唯一 = 假自证」同族）。 */
  push(/is_review_demo TINYINT NOT NULL DEFAULT 0/.test(c.sql));
  push(!!rd);
  if (rd) push(/is_review_demo = 1/.test(rd[0]));

  /* ⑦ 超管开关（2026-10-15 · v1.0.6.8）：开启即自动生成新口令，不再「我手写 + 用户跑 SQL」 */
  push(/reviewDemoStatus:\s*\{/.test(c.auth));
  push(/reviewDemoSet:\s*\{/.test(c.auth));
  /* 两个新路由都必须声明 needSuper —— 弱化成 needBind = 任何已绑定成员都能开后门 / 读到口令 */
  const rds = /reviewDemoStatus:\s*\{[\s\S]*?\n  \},/.exec(c.auth);
  const rdt = /reviewDemoSet:\s*\{[\s\S]*?\n  \},/.exec(c.auth);
  push(!!rds && /auth:\s*\{\s*needSuper:\s*true\s*\}/.test(rds[0]));
  push(!!rdt && /auth:\s*\{\s*needSuper:\s*true\s*\}/.test(rdt[0]));
  /* 口令必须由 crypto 随机生成：Math.random 可预测、同毫秒还会撞值；写死更不用说 */
  push(/function newReviewCode\(\)/.test(c.auth));
  push(/crypto\.randomInt\(CODE_ALPHABET\.length\)/.test(c.auth));
  push(!/Math\.random/.test(c.auth));
  push(!/return 'LXQ-[A-Z0-9]{4}-/.test(c.auth));
  /* 开启前先把**所有班**的开关清一遍：否则「以为关了，其实别班还开着一道」 */
  push(/UPDATE `class` SET review_demo_on = 0, review_demo_code = ''/.test(c.auth));
  /* 演示身份不得自己开关这道后门（连「只读一下口令」也不给） */
  push(/'auth\.reviewDemoSet'/.test(c.rd));
  push(/'auth\.reviewDemoStatus'/.test(c.rd));
  /* 前端：「我的」页那一行仅超管可见 + handler 齐 + api 声明齐 */
  push(/wx:if="\{\{isSuper\}\}" class="mn-row"[^>]*bindtap="onReviewToggle"/.test(c.mineWxml));
  push(/onReviewToggle\(\)\s*\{/.test(c.mineJs));
  push(/api\.reviewDemoSet\(\{ on \}/.test(c.mineJs));
  push(/reviewDemoStatus: C\('auth', 'reviewDemoStatus'\)/.test(c.api));
  push(/reviewDemoSet: C\('auth', 'reviewDemoSet'\)/.test(c.api));

  return n;
}

console.log('── 审核体验入口：静态判据');
const n0 = judge();
console.log(n0 === 0 ? 'PASS  全部判据通过' : 'FAIL  ' + n0 + ' 条判据未通过');
if (n0 !== 0) bad += 1;

console.log('');
console.log('── 变异自证：改坏一处必须被抓到（内存副本，不落盘）');
const MUT = [
  {
    name: 'M1 去掉 is_super = 1（会把「测试成员/测试管理员」也当成演示身份绑进去）',
    apply: () => ({ auth: src.auth.replace("IS_TEST()} AND role = 'ADMIN' AND is_super = 1", "IS_TEST()} AND role = 'ADMIN'") })
  },
  {
    name: 'M2 login 把口令一起回传前端（布尔位变成明文口令 = 公开后门）',
    apply: () => ({ auth: src.auth.replace('reviewDemo: !!(await reviewDemoRow(pool))', 'reviewDemo: String((await reviewDemoRow(pool) || {}).review_demo_code || \'\')') })
  },
  {
    name: 'M3 前端去掉 wx:if（开关关闭后入口仍渲染，审核员看到的是有后门的页）',
    apply: () => ({ bindWxml: src.bindWxml.replace('<view wx:if="{{reviewOn}}" class="bind-review">', '<view class="bind-review">') })
  },
  {
    name: 'M4 顶掉真人绑定（把「已绑定就报错」改成直接覆盖 openid）',
    apply: () => ({ auth: src.auth.replace(/if \(mine\.length && Number\(mine\[0\]\.id\) !== Number\(t\.id\)\) \{[\s\S]*?\n      \}/, '') })
  },
  {
    name: 'M5 去掉 member 函数 main 里的演示拦截（该函数破坏性动作不再受控）',
    apply: () => ({ memberIdx: src.memberIdx.replace('reviewDemo.denyDemo(ctx.member, action);', '') })
  },
  {
    name: 'M6 从拒绝清单里删掉 member.removeMember（删成员重新变成可执行）',
    apply: () => ({ rd: src.rd.replace("'member.removeMember',", '') })
  },
  {
    /* ⚠️ 锚点必须唯一：只写 `is_review_demo = 1` 会先命中 reviewDemoSet 的
       `WHERE is_review_demo = 1`，改了个不相干的地方 ⇒ 测的还是原文件（假自证）。 */
    name: 'M7 reviewDemo 绑定不再置 is_review_demo=1（演示态失效，拦截永不触发）',
    apply: () => ({ auth: src.auth.replace('is_review_demo = 1 WHERE id = ?', 'is_review_demo = 0 WHERE id = ?') })
  },
  {
    name: 'M8 reviewDemoSet 去掉 needSuper（任何已绑定成员都能开这道后门 / 拿到口令）',
    apply: () => ({ auth: src.auth.replace("  reviewDemoSet: {\n    auth: { needSuper: true },", "  reviewDemoSet: {\n    auth: { needBind: true },") })
  },
  {
    name: 'M9 口令不再随机（固定口令 ⇒ 每次开启都是同一条，等于公开后门）',
    apply: () => ({ auth: src.auth.replace('return \'LXQ-\' + out;', "return 'LXQ-FIXD-FIXD-FIXD-FIXD';") })
  },
  {
    name: 'M10 前端开关行去掉 wx:if isSuper（普通成员也能开后门）',
    apply: () => ({ mineWxml: src.mineWxml.replace('<view wx:if="{{isSuper}}" class="mn-row" hover-class="tap-hover" hover-start-time="0" hover-stay-time="60" bindtap="onReviewToggle">', '<view class="mn-row" hover-class="tap-hover" hover-start-time="0" hover-stay-time="60" bindtap="onReviewToggle">') })
  },
  {
    name: 'M11 从拒绝清单删掉 auth.reviewDemoSet（演示身份可以自己换一条口令出来）',
    apply: () => ({ rd: src.rd.replace("  'auth.reviewDemoSet',\n", '') })
  },
  {
    name: 'M12 口令改用 Math.random（可预测 + 同毫秒撞值，等于口令能猜）',
    apply: () => ({ auth: src.auth.replace(
      'CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]',
      'CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]'
    ) })
  }
];

let caught = 0;
MUT.forEach((c) => {
  const before = judge();
  if (before !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  /* 🔴 变异必须真的改到源码：锚点漂移后 String.replace 找不到会原样返回 ⇒ 测的是原文件 = 假自证 */
  const touched = Object.keys(src).some((k) => over[k] && over[k] !== src[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效：replace 找不到就原样返回）⇒ 门禁测的是原文件。先修锚点。');
    bad += 1;
    return;
  }
  let n;
  try { n = judge(over); } catch (e) {
    fail('变异「' + c.name + '」跑挂了（' + e.message + '）');
    bad += 1;
    return;
  }
  if (n > 0) { ok('变异「' + c.name + '」被门禁抓到（' + n + ' 条判据翻红）'); caught += 1; }
  else { fail('变异「' + c.name + '」**没被抓到** —— 判据失效'); bad += 1; }
});
if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] 审核体验入口门禁全部通过');