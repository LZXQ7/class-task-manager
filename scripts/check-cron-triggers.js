#!/usr/bin/env node
/**
 * 回归门禁：cron-weekly 的定时触发器必须与**线上实际**逐字一致，且额度优化开关不能被回退。
 * =================================================================
 * 2026-10-12 用户报障「小程序无法长久发微信通知」时顺带挖出两个坑：
 *
 * ① 🔴 **触发器整体覆盖 + 本地配置漂移**（P0，会静默破坏线上定时任务）
 *    CloudBase 部署云函数时**按 config.json 整体覆盖触发器**（文件头铁律：
 *    「整体覆盖语义，须一次传齐全部」）。而本地 `config.json` 当时只有 4 条、**缺 `remindAM`**，
 *    且 `weekly` 写的是 `0 0 20 * * SUN *`（云端实为 `0 0 20 * * 0 *`）。
 *    ⇒ **下一次部署 cron-weekly 就会把线上的 07:00 提醒悄悄覆盖掉**，且没有任何报错。
 *    本门禁把「线上实际配置」写成期望表逐字比对，杜绝再次漂移。
 *
 * ② 订阅额度优化：21:00 与 07:00 **共用同一个模板**（`TEMPLATE_REMIND`），一次性订阅
 *    一条额度换一条消息 ⇒ 两条一起发 = 每天烧 2 个额度，一学期要 180 次授权（不现实）。
 *    默认只发 21:00（`REMIND_MODE=evening`），额度需求减半。
 *    ⚠️ 优化不能被悄悄回退成「两条都发」——那样等于没优化。
 *
 * 变异自证（3 组）：M1 删掉 remindAM 触发器 / M2 weekly 改回 `SUN` / M3 去掉额度开关。
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const CFG = 'cloudfunctions/cron-weekly/config.json';
const IDX = 'cloudfunctions/cron-weekly/index.js';

/* 线上 cron-weekly 的**实际**触发器（2026-10-12 `tcb fn detail` 实测）。
 * ⚠️ 改这里之前先 `tcb fn detail cron-weekly -e <env>` 查线上真实值，
 *    然后**同时**改云端与本表 —— 只改一边就等于制造下一次覆盖漂移。 */
const EXPECT = {
  weekly: '0 0 20 * * 0 *',
  daily: '0 0 6 * * * *',
  hourly: '0 0 * * * * *',
  remind: '0 0 21 * * * *',
  remindAM: '0 0 7 * * * *'
};

const src = { cfg: read(CFG), idx: read(IDX) };

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

function judge(o) {
  o = o || {};
  const cIdx = strip(o.idx != null ? o.idx : src.idx);
  let n = 0;
  const push = (x) => { if (!x) n += 1; };
  const notes = [];

  /* ① 触发器逐条比对线上事实 */
  let cfg = null;
  try { cfg = JSON.parse(o.cfg != null ? o.cfg : src.cfg); } catch (e) { cfg = null; }
  push(!!cfg);
  if (cfg) {
    const tg = cfg.triggers || [];
    push(tg.length === Object.keys(EXPECT).length);
    if (tg.length !== Object.keys(EXPECT).length) {
      notes.push('triggers 数量=' + tg.length + '（期望 ' + Object.keys(EXPECT).length + '）');
    }
    Object.keys(EXPECT).forEach((name) => {
      const hit = tg.find((t) => t && t.name === name);
      push(!!hit);
      if (!hit) { notes.push('缺触发器 ' + name + ' ⇒ 下次部署会把它从线上覆盖掉'); return; }
      push(String(hit.config) === EXPECT[name]);
      if (String(hit.config) !== EXPECT[name]) {
        notes.push(name + ' cron=' + hit.config + '（线上是 ' + EXPECT[name] + '）');
      }
      push(hit.type === 'timer');
    });
  }

  /* ② dispatch 必须覆盖全部触发器。
   *    ⚠️ `hourly` **故意没有** `trigger === 'hourly'` 分支 —— 它连同「手动触发」一起走
   *    最后那个 else 兜底（跑全部幂等任务）。所以只对**需要单独语义**的 4 个判显式分支，
   *    `hourly` 改判「兜底里确实调了 hourlyJobs」。（2026-10-12 实踩：把 5 个一视同仁地
   *    断言 `trigger === '<name>'`，会让 hourly 永远判红。） */
  ['weekly', 'daily', 'remind', 'remindAM'].forEach((name) => {
    push(new RegExp("trigger === '" + name + "'").test(cIdx));
  });
  push(/hourlyJobs\(pool\)/.test(cIdx));

  /* ③ 额度优化开关：默认 evening，且两条不得被无条件同时发出 */
  push(/const rmode = String\(process\.env\.REMIND_MODE \|\| 'evening'\);/.test(cIdx));
  push(/rmode === 'morning' \|\| rmode === 'both'/.test(cIdx));
  push(/skipped: true, reason: 'REMIND_MODE='/.test(cIdx));
  // ⚠️ 收口判据：remindAM 分支里**必须有**一个受 REMIND_MODE 控制的条件，
  //    否则就是把「无条件发两条」放回来了（优化被回退，判红）。
  const amBranch = /trigger === 'remindAM'\) \{([\s\S]*?)\n    \} else/.exec(cIdx);
  push(!!amBranch);
  if (amBranch) push(/REMIND_MODE/.test(amBranch[1]));

  /* ④ 两条提醒共用同一模板（额度共享是优化的前提，改了就等于前提不成立） */
  push(/const templateId = process\.env\.TEMPLATE_REMIND;/.test(cIdx));

  if (n > 0 && notes.length) notes.forEach((s) => console.log('      · ' + s));
  return n;
}

console.log('── cron-weekly 触发器与额度优化');
const n0 = judge();
console.log(n0 === 0 ? 'PASS  全部判据通过' : 'FAIL  ' + n0 + ' 条判据未通过');
if (n0 !== 0) bad += 1;

console.log('');
console.log('── 变异自证（内存副本，不落盘）');
const MUT = [
  {
    name: 'M1 删掉 remindAM 触发器（**这就是线上即将发生的事**：下次部署会覆盖掉 07:00 提醒）',
    apply: () => {
      const c = JSON.parse(src.cfg);
      c.triggers = c.triggers.filter((t) => t.name !== 'remindAM');
      return { cfg: JSON.stringify(c, null, 2) };
    }
  },
  {
    name: 'M2 weekly 的 cron 写回 `SUN`（本地写法，云端实为 `0`，整体覆盖后可能解析失败）',
    apply: () => ({ cfg: src.cfg.replace('"0 0 20 * * 0 *"', '"0 0 20 * * SUN *"') })
  },
  {
    name: 'M3 去掉额度开关（恢复成两条都发 ⇒ 额度需求回到每天 2 个，优化等于没做）',
    apply: () => ({
      idx: src.idx.replace(
        /const rmode = String\(process\.env\.REMIND_MODE \|\| 'evening'\);\s*\n\s*if \(rmode === 'morning' \|\| rmode === 'both'\) \{\s*\n\s*result\.remindAM = await remindDuty\(pool, 'today'\);\s*\n\s*\} else \{[\s\S]*?\n\s*\}/,
        "result.remindAM = await remindDuty(pool, 'today');"
      )
    })
  }
];

let caught = 0;
MUT.forEach((c) => {
  if (judge() !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0 ⇒ 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  /* 🔴 变异必须真的改到源码：锚点漂移后 replace 找不到会原样返回 ⇒ 测的是原文件 = 假自证 */
  const touched = Object.keys(src).some((k) => over[k] && over[k] !== src[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效）⇒ 先修锚点');
    bad += 1;
    return;
  }
  let n;
  try { n = judge(over); } catch (e) {
    fail('变异「' + c.name + '」跑挂了：' + e.message);
    bad += 1;
    return;
  }
  if (n > 0) { ok('变异「' + c.name + '」被门禁抓到（' + n + ' 条判据翻红）'); caught += 1; }
  else { fail('变异「' + c.name + '」**没被抓到** —— 判据失效'); bad += 1; }
});
if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) { console.log('[FAIL] ' + bad + ' 项未通过'); process.exit(1); }
console.log('[PASS] cron-weekly 触发器 / 额度优化门禁全部通过');