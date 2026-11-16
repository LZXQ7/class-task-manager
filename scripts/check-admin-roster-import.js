#!/usr/bin/env node
/**
 * 名单导入门禁（2026-11-16）
 * ============================================================
 * 用户口径：「账号班级增加可添加班级、上传成员名单等功能，和小程序上传成员名单规则一样
 *   甚至适配更多格式。自适应格式最好，智能识别自动识别。字段识别，一般情况一行里面包含
 *   学号和姓名，只是有的学号在前面姓名在后面、有的学号在后面姓名在前面等多种样子。」
 *
 * 挡五类事故：
 *   ① 解析器退回「按列下标取」：换个列序就整份名单读不出来（小程序侧踩过的同款）；
 *   ② 只认逗号/制表符：中文 Excel「另存为 txt」是**单空格**分隔，整份名单会被判 0 行；
 *   ③ 学号与姓名连写（`000000000301张三`）读不出 —— 从教务系统导出的名单常见这种；
 *   ④ 把别的班的学生「导入」过来（member.student_no 全库 UNIQUE，硬插会 1062，
 *      软迁会把值日/请假历史挂错班）；
 *   ⑤ 预览与写入各解析一遍、结果不一致（预览说新增 3 人，实际写进去 30 人）。
 *
 * 用法：node scripts/check-admin-roster-import.js [--self-test]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'cloudfunctions/admin-web');
const MINI = path.join(ROOT, 'cloudfunctions/member');
const read = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const readMini = (p) => fs.readFileSync(path.join(MINI, p), 'utf8');

const R = require(path.join(DIR, 'common/roster-parse.js'));

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

const PARSER = read('common/roster-parse.js');
const ROSTER = read('lib/mod-roster.js');
const IDX = read('index.js');

/* ============================================================
 * ① 与小程序同口径（常量逐字一致，改动两边同步）
 * ============================================================ */
section('① 规则与小程序同源（不是另写一套）');

const MINI_SRC = readMini('index.js');
['const GENDER =', 'const NAME_RE =', 'const DIGIT_NO_RE ='].forEach((k) => {
  const line = MINI_SRC.split('\n').filter((l) => l.trim().indexOf(k) === 0)[0] || '';
  const inBackend = PARSER.indexOf(line.trim()) >= 0;
  check(!!line && inBackend, '常量与小程序逐字一致：' + line.trim().slice(0, 56));
});
check(/function looksLikeClass\(/.test(PARSER) && /班\$/.test(PARSER),
  '班级判定仍是「班」只认结尾（否则「班超」这类姓氏会被当班级）');
check(/function groupOf\(/.test(PARSER) && /% 2 === 0 \? 'B' : 'A'/.test(PARSER),
  '分组沿用「学号末位奇偶」（与小程序 groupOf 一致）');

/* ============================================================
 * ② 真跑 15 种写法（顺序自适应 / 分隔符 / 粘连 / 工号）
 * ============================================================ */
section('② 真跑解析器：学号姓名顺序、分隔符、粘连、表头');

const cases = [
  ['逗号·学号在前', '000000000301,张三', '张三', '000000000301'],
  ['逗号·姓名在前', '张三,000000000301', '张三', '000000000301'],
  ['全角逗号', '张三，000000000301', '张三', '000000000301'],
  ['制表符', '000000000301\t张三', '张三', '000000000301'],
  ['竖线', '张三|000000000301', '张三', '000000000301'],
  ['分号', '张三;000000000301', '张三', '000000000301'],
  ['单空格·学号在前', '000000000301 张三', '张三', '000000000301'],
  ['单空格·姓名在前', '张三 000000000301', '张三', '000000000301'],
  ['多列（含性别指导员）', '000000000301,张三,A组,男,李指导', '张三', '000000000301'],
  ['班级列在前', '小教（专升本）示例班级A,000000000301,张三', '张三', '000000000301'],
  ['粘连·学号+姓名', '000000000301张三', '张三', '000000000301'],
  ['粘连·姓名+学号', '张三000000000301', '张三', '000000000301'],
  ['Excel 整数值 .0', '000000000301.0,张三', '张三', '000000000301'],
  ['字母数字工号', 'STAFFV7E9FS,陈慧芳', '陈慧芳', 'STAFFV7E9FS'],
  ['少数民族姓名', '000000000301,阿依古丽·买买提', '阿依古丽·买买提', '000000000301']
];
cases.forEach(([label, line, name, no]) => {
  const r = R.parseLine(line);
  check(!!r && r.name === name && r.studentNo === no, label + ' → ' + name + ' / ' + no);
});

const roster = R.parseRoster('姓名\t学号\t班级\n000000000301\t张三\n\n张三 000000000302');
check(roster.rows.length === 2 && roster.failed.length === 0,
  '表头行与空行被跳过、且不会算成失败（实测 rows=' + roster.rows.length + '）');
check(R.parseLine('姓名') === null, '只有表头词「姓名」不会被当成一个人');
check(R.groupOf('000000000301') === 'A' && R.groupOf('000000000302') === 'B', '奇偶分组 A/B');
check(R.studentNoFromSeq(7, '0000000003', 2) === '000000000307', '只有序号时按前缀补学号');

/* ============================================================
 * ③ 写库契约
 * ============================================================ */
section('③ 写库：预览=写入同一份解析，不跨界搬人');

check(/function prepare\(/.test(ROSTER) && /previewRoster/.test(ROSTER) && /commitRoster/.test(ROSTER),
  'previewRoster 与 commitRoster 共用 prepare()（同一份解析结果）');
check(/commitRoster[\s\S]{0,400}?await prepare\(p, classId\)/.test(ROSTER),
  'commit 重新解析（不信任前端回传的行，防篡改学号）');
check(/Number\(e\.class_id\) !== Number\(classId\)[\s\S]{0,160}?'conflict'/.test(ROSTER),
  '学号已属别的班 → conflict，不搬人');
check(/beginTransaction\(\)/.test(ROSTER) && /rollback\(\)/.test(ROSTER),
  '写入走事务，失败整批回滚');
check(/UPDATE member SET name = \? WHERE id = \?/.test(ROSTER),
  '已存在成员只更新姓名（不覆盖分组/职位/角色/状态）');
check(/action: 'member\.import'/.test(ROSTER), '导入写审计（member.import）');
check(/MAX_ROWS/.test(ROSTER) && /一次最多导入/.test(ROSTER), '有单次行数上限（防云函数超时）');
check(/TextDecoder\('gbk'\)/.test(ROSTER), '文本文件遇 UTF-8 替换符时回落 GBK（中文 CSV 常见）');
check(/不支持旧版 \.xls/.test(ROSTER), '明确拒绝 .xls 并提示另存（xlsx-lite 只吃 zip）');

/* xlsx 解析器是副本：两边代码必须一致（只允许注释不同 —— 后台副本多一段「为什么复制」的说明） */
const norm = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
check(norm(read('common/xlsx-lite.js')) === norm(readMini('xlsx-lite.js')),
  'common/xlsx-lite.js 与小程序 member/xlsx-lite.js 代码一致（副本未漂移）');

/* 路由权限 */
check(/app\.post\('\/api\/classes\/:id\/roster', requirePerm\('members\.import'\)/.test(IDX),
  '正式导入挂 members.import');
check(/app\.post\('\/api\/classes\/:id\/roster\/preview', requirePerm\('members\.import'\)/.test(IDX),
  '预览也挂 members.import');

/* 建班 */
const CLASS = read('lib/mod-class.js');
check(/async function createClass\(/.test(CLASS), 'mod-class 有 createClass');
check(/is_demo, review_demo_on\)[\s\S]{0,80}?0, 0\)/.test(CLASS) || /VALUES \(\?, \?, \?, \?, \?, 1, \?, 1, 0, 0\)/.test(CLASS),
  '新班建出来恒为 is_demo=0 / review_demo_on=0（演示班只能由脚本建）');
check(/nextJoinToken/.test(CLASS) && /nextInviteCode/.test(CLASS), '加入口令与邀请码自动生成且查重');
check(/thisMonday\(\)/.test(CLASS), '学期第一周默认本周一（东八区，不用容器 UTC）');

/* ============================================================
 * ④ 前端入口
 * ============================================================ */
section('④ 前端：账号班级可建班、可导入名单');
const APP = read('public/app.js');
check(/function openRosterDialog\(/.test(APP) && /function openCreateClassDialog\(/.test(APP),
  '有导入名单与新增班级两个弹层');
check(/data-c-import=/.test(APP) && /id="c-add"/.test(APP), '账号班级页有「新增班级」与每行「导入名单」');
check(/id="btn-import"/.test(APP), '成员页也有导入入口（当前选中班级）');
check(/roster\/preview/.test(APP) && /'\/api\/classes\/' \+ classId \+ '\/roster'/.test(APP),
  '前端先预览再提交（两个接口分开）');
check(/resetPreview/.test(APP) && /btn\.disabled = true/.test(APP),
  '输入一变就重置预览并禁用提交（防止改完直接提交）');

/* ============================================================
 * ⑤ 变异自证
 * ============================================================ */
function selfTest() {
  let bad = 0;
  function mut(label, ok) {
    if (ok) console.log('SELFTEST PASS 抓红：' + label);
    else { console.log('SELFTEST FAIL 漏抓：' + label); bad += 1; }
  }
  function loadParser(src) {
    const module2 = { exports: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('module', 'exports', src);
    fn(module2, module2.exports);
    return module2.exports;
  }

  // 5.1 去掉单空格兜底 → 单空格用例必须读不出来
  mut('去掉单空格兜底（中文 Excel 另存 txt 的形态）', (function () {
    const src = PARSER.replace(/if \(bySpace\.length > 1\) parts = bySpace;/, '');
    if (src === PARSER) return false;
    const p2 = loadParser(src);
    return p2.parseLine('000000000301 张三') === null;
  })());

  // 5.2 去掉粘连拆分 → 粘连用例必须读不出来
  mut('去掉学号姓名粘连拆分', (function () {
    const src = PARSER.replace(/const m1 = [\s\S]*?if \(m2\) \{ glued\.push\(m2\[2\], m2\[1\]\); return; \}/, '');
    if (src === PARSER) return false;
    try {
      const p2 = loadParser(src);
      return p2.parseLine('000000000301张三') === null;
    } catch (e) { return true; }
  })());

  // 5.3 跨班冲突改成「直接更新」→ 静态契约必须翻红
  mut('跨班同学号改成直接更新（会把别人班的人搬过来）', (function () {
    const src = ROSTER.replace(
      /if \(Number\(e\.class_id\) !== Number\(classId\)\) \{[\s\S]*?\n    \}/,
      ''
    );
    if (src === ROSTER) return false;
    return !/Number\(e\.class_id\) !== Number\(classId\)[\s\S]{0,160}?'conflict'/.test(src);
  })());

  return bad;
}

if (require.main === module) {
  if (process.argv.indexOf('--self-test') >= 0) {
    console.log('── 变异自证（每条都应被抓）');
    const bad = selfTest();
    console.log('');
    if (bad) { console.log('[FAIL] ' + bad + ' 条自证异常'); process.exit(1); }
    console.log('[PASS] 变异自证全部被抓');
    process.exit(0);
  }
  console.log('\n── 汇总');
  if (fail) { console.log('结果：失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'); process.exit(1); }
  console.log('结果：全部通过（' + pass + ' 项）');
}
