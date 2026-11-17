#!/usr/bin/env node
/**
 * 离线自检：课前演讲「每场人数规则」必须持久生效（2026-11-17 用户口径）
 * --------------------------------------------------------------------------------
 * 用户原话：「课前演讲设置规则，每周五下午的儿童文学只安排一个人课前演讲」。
 *
 * 现状：`course_need` 只活在**智能排班那一次指令**里（AI 解析 → 本次 override），
 *       一键生成 / 下周再排就回到每场 2 人 —— 不是"规则"，是一次性指令。
 *
 * 定规（v3）：
 *   ① 规则持久化在 `speech_setting.slot_rules`（TEXT，JSON：`[{"sid":339,"need":1}]`），
 *      **只存 need=1 的场次**（2 人 = 默认，不落库，避免一堆无用行）；
 *   ② 三处口径统一：`speechList`（设置页展示）、`speechGenerate`（一键生成）、
 *      `speechAiParse`（智能排班预览）都读同一份规则；
 *   ③ 智能排班那句话里的「某课 1 人」**临时覆盖**规则（本次指令优先），但不写回规则；
 *   ④ 落库前校验：session 必须属于本班、need 只能是 1/2（越权/脏值静默丢弃）；
 *   ⑤ 脏 JSON / 列缺失一律当「没有规则」，不能拖垮整周排班。
 *
 * 用法：node scripts/check-speech-need-rule.js
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
  mig: 'scripts/migrate-speech-slot-rules.sql',
  api: 'miniprogram/utils/api.js',
  pwxml: 'miniprogram/pages/duty/index.wxml',
  pjs: 'miniprogram/pages/duty/index.js',
  pwxss: 'miniprogram/pages/duty/index.wxss'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = fs.existsSync(path.join(ROOT, F[k])) ? read(F[k]) : ''; });

/** 抽顶层 `function name(...) {...}` 整段（按花括号配对） */
function fnSource(js, name) {
  const i = js.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0;
  let started = false;
  for (let k = i; k < js.length; k += 1) {
    if (js[k] === '{') { d += 1; started = true; }
    else if (js[k] === '}') { d -= 1; if (started && !d) return js.slice(i, k + 1); }
  }
  return '';
}

/** 抽路由对象里 `name: { ... }` 整段（到下一个同缩进的路由键为止） */
function routeBody(js, name) {
  const anchor = '\n  ' + name + ': {';
  const i = js.indexOf(anchor);
  if (i < 0) return '';
  const rest = js.slice(i + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*: \{/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function evalAll(s) {
  const js = stripJs(s.js);
  /* parseSlotRules 真跑：它是纯函数，变异改的是内存里的字符串 */
  const src = fnSource(js, 'parseSlotRules');
  let parse = null;
  try {
    // eslint-disable-next-line no-new-func
    parse = src ? new Function(src + '\nreturn parseSlotRules;')() : null;
  } catch (e) { parse = null; }

  let pOne = null;
  let pTwo = null;
  let pDirty = null;
  let pStr = null;
  if (parse) {
    try {
      pOne = parse('[{"sid":339,"need":1}]');
      pTwo = parse('[{"sid":339,"need":2},{"sid":401,"need":1}]');
      pDirty = parse('{not json');
      pStr = parse([{ sid: '339', need: '1' }]);
    } catch (e) { pOne = null; }
  }
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : '<throw>');

  const gen = routeBody(js, 'speechGenerate');
  const ai = routeBody(js, 'speechAiParse');
  const list = routeBody(js, 'speechList');
  const setRoute = routeBody(js, 'speechSetSlotRules');
  const mig = s.mig || '';

  return {
    /* ① 迁移：列存在 */
    migCol: /ALTER\s+TABLE\s+speech_setting\s+ADD\s+COLUMN\s+slot_rules/i.test(mig),
    /* ② 纯函数行为 */
    fnOk: !!parse,
    oneKept: keys(pOne) === '339' && pOne[339] === 1,
    twoDropped: keys(pTwo) === '401' && pTwo[401] === 1,
    dirtySafe: !!(pDirty && typeof pDirty === 'object' && Object.keys(pDirty).length === 0),
    strCoerce: !!(pStr && pStr[339] === 1),
    /* ③ 读库 helper */
    reader: /SELECT\s+slot_rules\s+FROM\s+speech_setting/i.test(js) && /loadSlotRules\s*\(\s*db/.test(js),
    /* ④ 写库路由：挂 speechAuth */
    routeExists: !!setRoute && /speechSetSlotRules/.test(js),
    routeAuth: /auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(setRoute),
    /* ⑤ 落库校验：本班 session + need 只认 1/2 */
    ownCheck: /FROM\s+session\s+WHERE\s+class_id\s*=\s*\?/i.test(setRoute) && /ownSet\.has\(\s*sid\s*\)/.test(setRoute),
    needGuard: /n\s*!==\s*1\s*&&\s*n\s*!==\s*2/.test(setRoute) || /n\s*===\s*1\s*\|\|\s*n\s*===\s*2/.test(setRoute),
    /* ⑥ 一键生成用规则 */
    genWired: /loadSlotRules\s*\(/.test(gen) && /override/.test(gen) && /buildSlots\([^)]*override/.test(gen),
    /* ⑦ 智能排班以规则为底、AI 再覆盖 */
    aiWired: /loadSlotRules\s*\(/.test(ai) && /Object\.assign\(\s*\{\}\s*,\s*await\s+loadSlotRules/.test(ai),
    /* ⑧ 设置页能拿到场次 + 规则 */
    listWired: /\n\s*slotRules,/.test(list) && /loadSpeechSessions\s*\(/.test(list) && /loadSlotRules\s*\(/.test(list),
    /* ⑨ 前端接线 */
    apiWired: /speechSetSlotRules\s*:/.test(s.api),
    feState: /spSlotRules\s*:/.test(s.pjs) && /spRuleEdit/.test(s.pjs),
    feUi: /onSpRuleNeed/.test(s.pwxml) && /sp-need/.test(s.pwxml) && /data-need/.test(s.pwxml),
    feSave: /speechSetSlotRules\(\s*\{[^}]*rules/.test(s.pjs),
    feCss: /\.sp-need-seg\s*\{/.test(s.pwxss) && /\.sp-need-opt\s*\{/.test(s.pwxss) && /\.sp-need-opt\.on\s*\{/.test(s.pwxss)
  };
}

const S = evalAll(SRC);

console.log('── ① 持久化与读库');
check(S.migCol, '迁移脚本给 speech_setting 加 slot_rules 列');
check(S.reader, 'loadSlotRules() 从 speech_setting 读 slot_rules');
check(S.fnOk, 'parseSlotRules() 可执行');
check(S.oneKept, '只存 need=1：「周五下午儿童文学 1 人」能读回来');
check(S.twoDropped, 'need=2 视为默认、不落库（只有 need=1 的场次留在规则里）');
check(S.dirtySafe, '脏 JSON 当「没有规则」，不抛错（不能拖垮整周排班）');
check(S.strCoerce, '字符串 sid/need（JSON 往返）也能正确转数字');

console.log('\n── ② 后端三处口径统一');
check(S.routeExists, '新增 speechSetSlotRules 路由');
check(S.routeAuth, 'speechSetSlotRules 挂 speechAuth（与其它演讲写接口一致）');
check(S.ownCheck, '落库前校验 session 属于本班（防越权写别人的课次）');
check(S.needGuard, 'need 只接受 1/2，其它值丢弃');
check(S.genWired, '一键生成把规则作为 override 交给 buildSlots');
check(S.aiWired, '智能排班以已保存规则为底，本次指令再覆盖');
check(S.listWired, 'speechList 下发本周场次 + 每场 need（设置页要显示）');

console.log('\n── ③ 小程序设置页');
check(S.apiWired, 'api.js 增加 speechSetSlotRules 封装');
check(S.feState, '页面 data 有 spSlotRules / spRuleEdit（编辑副本，取消不写回）');
check(S.feUi, '设置弹层里每场一个「1人 / 2人」切换（data-need 接线）');
check(S.feSave, '保存时把规则一起提交给 speechSetSlotRules');
check(S.feCss, '.sp-need-seg / .sp-need-opt / .sp-need-opt.on 样式齐备');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: 'need=2 也当成规则存下来', probe: 'twoDropped', file: 'js',
    from: 'if (sid > 0 && n === 1) map[sid] = 1;', to: 'if (sid > 0 && n >= 1) map[sid] = 1;' },
  { name: '脏 JSON 直接抛（设置坏了整周排不了）', probe: 'dirtySafe', file: 'js',
    from: 'try { arr = JSON.parse(raw); } catch (e) { return map; }', to: 'arr = JSON.parse(raw);' },
  { name: '落库不校验是否本班课次（可写别人班级）', probe: 'ownCheck', file: 'js',
    apply: (src) => src.replace('if (!ownSet.has(sid) || (n !== 1 && n !== 2)) return;', 'if (n !== 1 && n !== 2) return;') },
  { name: '一键生成不读规则（每场又回到 2 人）', probe: 'genWired', file: 'js',
    apply: (src) => src.replace(/const ruleMap = await loadSlotRules\(conn, classId\);\s*\n\s*const slots = speechCore\.buildSlots\(sessions, wk, \{ override: ruleMap \}, week\);/,
      'const slots = speechCore.buildSlots(sessions, wk, {}, week);') },
  { name: '智能排班不认已保存规则', probe: 'aiWired', file: 'js',
    from: 'const override = Object.assign({}, await loadSlotRules(pool, classId));', to: 'const override = {};' },
  { name: '设置页拿不到每场人数', probe: 'listWired', file: 'js',
    apply: (src) => src.replace(/\n\s*slotRules,/, '') },
  { name: 'speechSetSlotRules 不挂演讲权限', probe: 'routeAuth', file: 'js',
    apply: (src) => src.replace(/(speechSetSlotRules: \{\s*\n\s*auth: \{ )speechAuth: true/, '$1needBind: true') },
  { name: '保存时漏掉规则（只存游标）', probe: 'feSave', file: 'pjs',
    from: "api.speechSetSlotRules({ rules: rules }, { toast: false })", to: 'Promise.resolve({})' },
  { name: '切换按钮没接线', probe: 'feUi', file: 'pwxml',
    /* 两个按钮各一处：只 replace 首处另一处还在 ⇒ 判据仍绿 ⇒ 假通过 */
    apply: (src) => src.split('bindtap="onSpRuleNeed"').join('bindtap=""') }
];

MUT.forEach((mu) => {
  const file = mu.file || 'js';
  const src = SRC[file];
  const nextSrc = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (!src) { console.log('  ✗ 变异「' + mu.name + '」源文件不存在'); failed += 1; return; }
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码（锚点失配）');
    failed += 1;
    return;
  }
  check(evalAll(Object.assign({}, SRC, { [file]: nextSrc }))[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲「每场人数规则」检查全部通过'));
process.exit(failed ? 1 : 0);
