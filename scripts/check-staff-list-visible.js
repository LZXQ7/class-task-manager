/**
 * 门禁：教职工名册不得被「测试账号」过滤条件整批抹掉（2026-11-11 报障）
 * --------------------------------------------------------------------------
 * 用户症状：班级管理 → 教职工管理，列表里一个教职工都没有，但以前添加过。
 *
 * 根因（生产库只读实测）：
 *   member.staffList 的 SQL 是
 *     SELECT ... FROM member WHERE group_tag='X' AND <NOT_TEST()> AND status!='DISABLED'
 *   NOT_TEST() 展开为 student_no NOT LIKE '0000000000%'。而**在册唯一教职工**
 *   id=72 示例成员57的占位学号恰恰是 0000000000…（历史遗留），于是整表被过滤成 0 行。
 *   更讽刺的是 staffList 上方注释明确写着「单开一路就是为了避免 99 段辅导员
 *   看不见自己」—— 实现与注释从 2026-10-13 初始基线起就自相矛盾。
 *
 * 口径：教职工（X 组）不是学生名册，其占位学号由系统生成（新号前缀 STAFF），
 *   99 段的 4 个合成测试账号全部在 A/B 组。此列表又仅超管可见（requireSuper）。
 *   因此该 SQL **不按 student_no 过滤**，但必须继续排除 DISABLED。
 *   check-test-account-hidden.js 里要为此留一条显式白名单（写清理由），不能靠
 *   「顺手删掉 NOT_TEST 让门禁自己红」。
 *
 * 顺带守住前端放大器：_loadStaff 的空 catch 会让后端任何错误都表现为「列表空」，
 *   与本次症状完全同形，必须打 console.error + 提示，不允许静默。
 *
 * 自证：把下面每一条**真的改坏**一次，确认门禁逐条抓得住；真实源码必须全过。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/** ⚠️ 统一成 LF：本机文件是 CRLF，含 `\n` 的锚点会全部失配（定位不到 = 断言静默失效） */
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '');

const MEMBER = 'cloudfunctions/member/index.js';
const CLASSES = 'miniprogram/pages/classes/index.js';
const GATE = 'scripts/check-test-account-hidden.js';

/** 只取 staffList handler 段：从 `staffList: {` 到下一个同级 `},` */
function staffSeg(src) {
  const s = stripJs(src).replace(/\r\n/g, '\n');
  const at = s.indexOf('staffList: {');
  if (at < 0) return '';
  const end = s.indexOf('\n  },', at);
  return s.slice(at, end > 0 ? end : s.length);
}

/** @returns {string[]} 失败判据名；空数组 = 通过 */
function audit(memberSrc, classesSrc, gateSrc) {
  const fails = [];
  const M = stripJs(memberSrc).replace(/\r\n/g, '\n');
  const C = stripJs(classesSrc).replace(/\r\n/g, '\n');
  const G = gateSrc.replace(/\r\n/g, '\n');
  const seg = staffSeg(M);

  const need = (cond, name) => { if (!cond) fails.push(name); return cond; };

  need(seg.length > 0, 'staffList handler 存在');
  need(/group_tag = 'X'/.test(seg), "staffList 必须限定 group_tag = 'X'");
  need(/status != 'DISABLED'/.test(seg), 'staffList 必须继续排除 DISABLED');
  // 🔴 核心判据：教职工列表若按学号过滤测试账号，99 段占位学号会让列表恒空
  need(!/NOT_TEST\s*\(/.test(seg), 'staffList 不得用 NOT_TEST() 过滤教职工（99 段占位学号会被整批抹掉）');

  // 去掉过滤后，check-test-account-hidden 会把这条判成「未过滤的人员列表」→ 必须显式豁免
  const whitelistBlock = G.slice(G.indexOf('const WHITELIST = ['), G.indexOf('/** 在引号'));
  need(
    /fn:\s*'member'/.test(whitelistBlock) &&
    /find:\s*["']group_tag = 'X' AND /.test(whitelistBlock),
    'check-test-account-hidden 的 WHITELIST 必须有 staffList 的显式豁免条目（fn=member + find 锚点）'
  );

  // 前端：_loadStaff 不允许空 catch（后端报错与「没有教职工」同形）
  // ⚠️ 定位必须找**函数定义**，不能找 `this._loadStaff();` 调用处（会先命中，
  //    往后截 900 字符根本够不到 catch ⇒ 判据永远假红）
  const li = C.indexOf('\n  _loadStaff() {');
  const lc = li >= 0 ? C.slice(li, li + 1400) : '';
  // 允许 `.catch(e => …)` 与 `.catch((e) => …)` 两种写法
  const namedCatch = /catch\s*\(\s*\(?\s*\w+\s*\)?\s*=>/;
  need(li >= 0 && namedCatch.test(lc) && /console\.error/.test(lc),
    '_loadStaff 的 catch 必须具名并 console.error（空 catch 会静默吞掉后端错误）');
  need(li >= 0 && !/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(lc),
    '_loadStaff 不得留空 catch');

  return fails;
}

/* ---------------- 变异自证（全部在内存里改文本，不写盘、不碰生产文件） ---------------- */
const SQL_GOOD = "FROM member WHERE group_tag = 'X' AND status != 'DISABLED' ORDER BY id";
const WL_GOOD = "    fn: 'member',\n    find: \"group_tag = 'X' AND \"";

const MUTANTS = [
  {
    name: '把 NOT_TEST() 加回 staffList（本次 bug 原形）',
    apply: ([m, c, g]) => [m.replace(SQL_GOOD, "FROM member WHERE group_tag = 'X' AND \" + NOT_TEST() + \" AND status != 'DISABLED' ORDER BY id"), c, g]
  },
  {
    name: '删掉测试账号门禁里的白名单豁免（门禁会翻红却没人解释）',
    apply: ([m, c, g]) => [m, c, g.replace(WL_GOOD, "    fn: 'member',\n    find: \"__NOT_THE_STAFF_LIST__\"")]
  },
  {
    name: "staffList 丢了 group_tag = 'X' 限定（会把学生也列进教职工）",
    apply: ([m, c, g]) => [m.replace("group_tag = 'X' AND status != 'DISABLED'", "group_tag = 'A' AND status != 'DISABLED'"), c, g]
  },
  {
    name: 'staffList 丢了 DISABLED 排除（停用的教职工会复活）',
    apply: ([m, c, g]) => [m.replace("group_tag = 'X' AND status != 'DISABLED' ORDER BY id", "group_tag = 'X' ORDER BY id"), c, g]
  },
  {
    name: '_loadStaff 退回空 catch（错误被静默吞掉）',
    apply: ([m, c, g]) => [m,
      c.replace("console.error('[classes] staffList failed', (e && e.stack) || e);", ''), g]
  }
];

function main() {
  const good = [read(MEMBER), read(CLASSES), read(GATE)];
  const base = audit(...good);
  let failed = 0;

  console.log('=== 真实源码 ===');
  if (base.length === 0) console.log('  ✓ 全部通过');
  else { failed++; base.forEach(x => console.log('  ✗ ' + x)); }

  console.log('\n=== 变异自证（坏样本必须被抓） ===');
  MUTANTS.forEach((mu, i) => {
    const bad = mu.apply(good);
    const changed = bad.some((v, k) => v !== good[k]);
    const hits = audit(...bad);
    const caught = changed && hits.length > 0;
    if (!caught) failed++;
    console.log('  ' + (caught ? '✓' : '✗') + ' #' + (i + 1) + ' ' + mu.name +
      (caught ? ' → 抓住：' + hits[0] : (changed ? ' → 漏抓（假绿！）' : ' → 变异未生效（锚点失配！）')));
  });

  console.log('\n' + (failed ? '✗ 门禁未通过（' + failed + ' 项）' : '✓ 教职工列表可见性门禁：好样本全过，' + MUTANTS.length + ' 个坏样本全被抓'));
  process.exit(failed ? 1 : 0);
}

main();
