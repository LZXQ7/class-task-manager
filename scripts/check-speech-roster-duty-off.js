#!/usr/bin/env node
/**
 * 离线自检：member.duty_off（不排值日）只管值日/卫生，不得连课前演讲一起排除（2026-11-17 用户报）
 * --------------------------------------------------------------------------------
 * 用户原话：「为什么没有 1 号示例成员01，不排值日只是卫生，不包括课前演讲」。
 *
 * 复现（生产库 class_id=3 实测）：
 *   member id=13 示例成员01 student_no 000000000301（1 号）duty_off = 1
 *   ⇒ speechGenerate / speechList / speechReassign / speechAiParse 四处的名册 SQL 里
 *     都硬带着 `AND duty_off = 0`，于是演讲轮转名册里根本没有这个人。
 *   这条 SQL 是从值日那份**整段复制**过来的，语义被一起带过来了。
 *
 * 定规：
 *   ① 四个演讲路由的 SQL 里**不许出现 duty_off**（演讲与值日解耦）；
 *   ② 值日那四处（dutyList / autoGenerate / 检查 / 定时）**必须保留** duty_off 过滤，
 *      否则不值日的人又会被排进卫生；
 *   ③ 演讲名册仍然要排除教职工（group_tag <> 'X'）、测试号（NOT_TEST()），
 *      仍要求 status = 'ACTIVE'，且 seq > 0（学号后两位取不到的人不进轮转）；
 *   ④ 换人（speechReassign）仍要拒绝「不可排演讲」的人（41006）。
 *
 * 用法：node scripts/check-speech-roster-duty-off.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  js: 'cloudfunctions/schedule/index.js',
  adm: 'cloudfunctions/admin-web/public/app.js'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = fs.existsSync(path.join(ROOT, F[k])) ? read(F[k]) : ''; });

/** 抽路由对象里 `name: { ... }` 整段（到下一个同缩进的路由键为止） */
function routeBody(js, name) {
  const anchor = '\n  ' + name + ': {';
  const i = js.indexOf(anchor);
  if (i < 0) return '';
  const rest = js.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const SPEECH_ROUTES = ['speechList', 'speechGenerate', 'speechReassign', 'speechAiParse'];

function collect(js) {
  const src = stripJs(js);
  const bodies = {};
  SPEECH_ROUTES.forEach((n) => { bodies[n] = routeBody(src, n); });
  const gen = bodies.speechGenerate;
  const list = bodies.speechList;
  const swp = bodies.speechReassign;
  const ai = bodies.speechAiParse;

  /* 演讲四块里谁还在读 duty_off */
  const dirty = SPEECH_ROUTES.filter((n) => /duty_off/.test(bodies[n]));
  /* 全文还剩几处值日过滤（演讲块内已排除，所以剩下的都是值日） */
  const dutyHits = (src.match(/AND\s+duty_off\s*=\s*0/g) || []).length;

  return {
    routesFound: SPEECH_ROUTES.every((n) => bodies[n]),
    missing: SPEECH_ROUTES.filter((n) => !bodies[n]),
    speechClean: dirty.length === 0 && SPEECH_ROUTES.every((n) => bodies[n]),
    dirty,
    dutyHits,

    genKeepActive: /status = 'ACTIVE'/.test(gen),
    genKeepTest: /NOT_TEST\(\)/.test(gen),
    genKeepStaff: /group_tag\s*<>\s*'X'/.test(gen),
    genFilterSeq: /\.filter\(m => m\.seq > 0\)/.test(gen),
    listKeepStaff: /group_tag\s*<>\s*'X'/.test(list),
    aiKeepStaff: /group_tag\s*<>\s*'X'/.test(ai),
    aiFilterSeq: /\.filter\(m => m\.seq > 0\)/.test(ai),
    reassignKeepStaff: /group_tag\s*<>\s*'X'/.test(swp),
    reassignKeepActive: /status = 'ACTIVE'/.test(swp),
    reassignRejects: /BizError\(41006/.test(swp)
  };
}

const S = collect(SRC.js);

console.log('── ① 演讲名册与 duty_off 解耦');
check(S.routesFound, '四个演讲路由都能定位（' + SPEECH_ROUTES.join(' / ') + '）'
  + (S.missing.length ? '，缺：' + S.missing.join(',') : ''));
check(S.speechClean, '演讲路由 SQL 里不再出现 duty_off'
  + (S.dirty.length ? '（仍在读：' + S.dirty.join(',') + '）' : ''));

console.log('\n── ② 值日仍然排除「不排值日」的人');
check(S.dutyHits >= 4, '值日路径仍保留 duty_off = 0 过滤（实测 ' + S.dutyHits + ' 处，需 ≥ 4）');

console.log('\n── ③ 演讲名册其它过滤没被顺手删掉');
check(S.genKeepActive && S.genKeepTest && S.genKeepStaff, 'speechGenerate 仍要求 ACTIVE + 非测试号 + 非教职工');
check(S.genFilterSeq, 'speechGenerate 仍过滤 seq > 0（学号取不到的人不进轮转）');
check(S.listKeepStaff, 'speechList 换人候选仍排除教职工');
check(S.aiKeepStaff, 'speechAiParse 名册仍排除教职工');
check(S.aiFilterSeq, 'speechAiParse 仍过滤 seq > 0');
check(S.reassignKeepActive && S.reassignKeepStaff, 'speechReassign 目标人仍要求 ACTIVE + 非教职工');

console.log('\n── ④ 换人仍拒绝不可排的人');
check(S.reassignRejects, 'speechReassign 仍以 41006 拒绝不可排演讲的同学');

console.log('\n── ⑤ 后台文案（说清「只管值日」）');
check(/不排值日/.test(SRC.adm), '后台仍保留「不排值日」入口');
check(/只管值日|只影响值日|不影响(课前)?演讲|演讲照常/.test(SRC.adm),
  '后台文案已注明「不排值日」只影响值日，不影响课前演讲');

/* ── 变异自证：改坏 → 判据必须翻红 ─────────────────────────────────────── */
function mutateLine(s, anchor, fn) {
  const i = s.indexOf(anchor);
  if (i < 0) return s;
  const end = s.indexOf('\n', i);
  return s.slice(0, i) + fn(s.slice(i, end)) + s.slice(end);
}

/** 在指定行的组别条件后面追加 ` AND duty_off = 0`（锚点 = 该行 SELECT 的前缀，唯一） */
function addDutyOff(s, anchor) {
  return mutateLine(s, anchor, (line) => line.replace("AND group_tag <> 'X'", "AND group_tag <> 'X' AND duty_off = 0"));
}

const MUTS = [
  { name: 'speechGenerate 名册又加回 duty_off = 0', file: 'js', probe: 'speechClean',
    apply: (s) => addDutyOff(s, '"SELECT id, student_no, group_tag FROM member WHERE class_id') },
  { name: 'speechList 换人候选又加回 duty_off = 0', file: 'js', probe: 'speechClean',
    apply: (s) => addDutyOff(s, '"SELECT id, name, student_no FROM member WHERE class_id') },
  { name: 'speechAiParse 名册又加回 duty_off = 0', file: 'js', probe: 'speechClean',
    apply: (s) => addDutyOff(s, '"SELECT id, student_no, group_tag, name FROM member WHERE class_id') },
  { name: 'speechReassign 目标校验又加回 duty_off = 0', file: 'js', probe: 'speechClean',
    apply: (s) => addDutyOff(s, '"SELECT id, group_tag FROM member WHERE id = ?') },
  { name: '值日四处过滤被一并删掉（不值日的人又被排卫生）', file: 'js', probe: 'dutyHits',
    apply: (s) => s.split('AND duty_off = 0').join('AND 1 = 1') },
  { name: '演讲名册不再排除测试号', file: 'js', probe: 'genKeepTest',
    apply: (s) => mutateLine(s, '"SELECT id, student_no, group_tag FROM member WHERE class_id',
      (line) => line.replace('NOT_TEST()', "'1 = 1'")) },
  { name: '换人不再排除教职工', file: 'js', probe: 'reassignKeepStaff',
    apply: (s) => mutateLine(s, '"SELECT id, group_tag FROM member WHERE id = ?',
      (line) => line.replace("AND group_tag <> 'X'", 'AND 1 = 1')) },
  { name: '换人不再拒绝不可排的人', file: 'js', probe: 'reassignRejects',
    apply: (s) => s.replace("if (!m.length) throw new BizError(41006, '所选同学不可排演讲');",
      'if (!m.length) { /* noop */ }') },
  { name: '生成不再过滤 seq > 0', file: 'js', probe: 'genFilterSeq',
    apply: (s) => s.replace('group: m.group_tag }))\n          .filter(m => m.seq > 0).sort',
      'group: m.group_tag }))\n          .sort') },
  { name: '后台文案回退成不解释（用户又会以为演讲也不排）', file: 'adm', probe: 'admCopy',
    apply: (s) => s.replace('不影响课前演讲', '').replace('只管值日/卫生，课前演讲照常参加', '').replace('（只影响卫生）', '') }
];

console.log('\n── ⑥ 变异自证（改坏 → 判据必须翻红）');
MUTS.forEach((m) => {
  const before = SRC[m.file];
  const after = m.apply(before);
  if (after === before) {
    console.log('  ✗ 变异未生效（锚点失配）：' + m.name);
    failed += 1;
    return;
  }
  let caught;
  if (m.probe === 'admCopy') {
    caught = !/只管值日|只影响值日|不影响(课前)?演讲|演讲照常/.test(after);
  } else {
    const R = collect(m.file === 'js' ? after : SRC.js);
    caught = m.probe === 'dutyHits' ? !(R.dutyHits >= 4) : !R[m.probe];
  }
  console.log((caught ? '  ✓ 抓住 ' : '  ✗ 漏网 ') + m.name);
  if (!caught) failed += 1;
});

console.log('\n' + (failed ? '✗ 失败 ' + failed + ' 项' : '✓ 全部通过'));
process.exit(failed ? 1 : 0);
