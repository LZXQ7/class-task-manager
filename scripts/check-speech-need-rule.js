#!/usr/bin/env node
/**
 * 离线自检：课前演讲「排班方式 · 每场人数」必须持久生效（v4，2026-11-20）
 * --------------------------------------------------------------------------------
 * 用户原话（v3）：「每周五下午的儿童文学只安排一个人课前演讲」
 * 用户口径（v4）：「像值日排班一样设置排班方式，可单独设置周几的上午或下午
 *                  安排几个人，默认2人最多2人；一键生成和智能排班合并为一键生成」
 *
 * 定规（v4）：
 *   ① 规则持久化在 `speech_setting.slot_rules`（TEXT，JSON：`[{"day":5,"slot":"PM","need":1}]`），
 *      **只存 need=1 的格子**（2 人 = 默认，不落库）；维度是「周几 × 上午/下午」10 格，
 *      命中该时段**所有**课次（调课后仍跟周几时段走）。兼容旧 {sid,need:1}：借 sessions 反查格子。
 *   ② 三处口径统一：speechList / speechBoard / speechGenerate / speechAiParse 都读同一份规则；
 *      格子经 gridToSidMap 展开成 sid override 交给 buildSlots。
 *   ③ 智能排班那句话里的「某课 1 人」临时覆盖规则（本次指令优先），但不写回规则；
 *   ④ 落库前校验：day 1-5 / slot AM|PM / need 1|2（脏值静默丢弃）；
 *   ⑤ 脏 JSON / 列缺失一律当「没有规则」，不能拖垮整周排班。
 *   ⑥ 前端：「一键生成」合并入口 + 排班方式弹层 5 行×2 列 10 格，每格 1人/2人。
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
  /* parseSlotRules / gridToSidMap 真跑：纯函数，注入 speechCore 桩（AM=1 / PM=3） */
  const parseSrc = fnSource(js, 'parseSlotRules');
  const gridSrc = fnSource(js, 'gridToSidMap');
  const STUB = 'const speechCore = { AM_PERIOD: 1, PM_PERIOD: 3 };\n';
  let parse = null;
  let grid = null;
  try {
    parse = parseSrc ? new Function(STUB + parseSrc + '\nreturn parseSlotRules;')() : null;
    grid = gridSrc ? new Function(STUB + gridSrc + '\nreturn gridToSidMap;')() : null;
  } catch (e) { parse = null; grid = null; }

  const sessions = [
    { id: 339, day_of_week: 5, period: 3, courseName: '儿童文学' },
    { id: 401, day_of_week: 5, period: 3, courseName: '体育' },
    { id: 210, day_of_week: 1, period: 1, courseName: '语文' }
  ];
  let cNew = null;   // 新格式 {day,slot,need:1} → 周五下午格
  let cLegacy = null; // 旧格式 {sid:339,need:1} → 借 session 反查成周五下午格
  let cTwo = null;   // need=2 不落库
  let cDirty = null; // 脏 JSON
  let cStr = null;   // 字符串字段
  let sidMap = null; // 格子展开成 sid override（周五下午命中 339+401）
  if (parse) {
    try {
      cNew = parse('[{"day":5,"slot":"PM","need":1}]', sessions);
      cLegacy = parse('[{"sid":339,"need":1}]', sessions);
      cTwo = parse('[{"day":5,"slot":"PM","need":2}]', sessions);
      cDirty = parse('{not json', sessions);
      cStr = parse([{ day: '5', slot: 'PM', need: '1' }], sessions);
      sidMap = grid ? grid(cNew, sessions) : null;
    } catch (e) { cNew = null; }
  }
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : '<throw>');

  const gen = routeBody(js, 'speechGenerate');
  const ai = routeBody(js, 'speechAiParse');
  const list = routeBody(js, 'speechList');
  const board = routeBody(js, 'speechBoard');
  const setRoute = routeBody(js, 'speechSetSlotRules');
  const mig = s.mig || '';

  return {
    /* ① 持久化与纯函数 */
    migCol: /ALTER\s+TABLE\s+speech_setting\s+ADD\s+COLUMN\s+slot_rules/i.test(mig),
    fnOk: !!parse && !!grid,
    newCellOk: keys(cNew) === '5|PM' && cNew['5|PM'] === 1,
    legacyOk: keys(cLegacy) === '5|PM' && cLegacy['5|PM'] === 1,
    twoDropped: !!(cTwo && Object.keys(cTwo).length === 0),
    dirtySafe: !!(cDirty && typeof cDirty === 'object' && Object.keys(cDirty).length === 0),
    strCoerce: !!(cStr && cStr['5|PM'] === 1),
    gridExpand: !!(sidMap && sidMap[339] === 1 && sidMap[401] === 1 && sidMap[210] === undefined),
    /* ② 读库 helper */
    reader: /SELECT\s+slot_rules\s+FROM\s+speech_setting/i.test(js) && /loadSlotRules\s*\(\s*db/.test(js),
    /* ③ 写库路由：挂 speechAuth + 格子校验 */
    routeExists: !!setRoute && /speechSetSlotRules/.test(js),
    routeAuth: /auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(setRoute),
    dayGuard: /day\s*>=\s*1\s*&&\s*day\s*<=\s*5/.test(setRoute),
    slotGuard: /slot.*AM.*PM/.test(setRoute) || /'AM'/.test(setRoute) && /'PM'/.test(setRoute),
    needGuard: /n\s*!==\s*1\s*&&\s*n\s*!==\s*2/.test(setRoute),
    keptCell: /kept\.push\(\s*\{\s*day,\s*slot,\s*need:\s*1\s*\}\s*\)/.test(setRoute),
    /* ④ 四处口径统一：都 loadSlotRules + gridToSidMap */
    genWired: /loadSlotRules\s*\(/.test(gen) && /gridToSidMap\s*\(/.test(gen) && /buildSlots\([^)]*override/.test(gen),
    aiWired: /loadSlotRules\s*\(/.test(ai) && /gridToSidMap\s*\(/.test(ai),
    listWired: /loadSlotRules\s*\(/.test(list) && /d\s*<=\s*5/.test(list) && /\['AM',\s*'PM'\]/.test(list),
    boardWired: /loadSlotRules\s*\(/.test(board) && /gridToSidMap\s*\(/.test(board),
    /* ⑤ 前端接线：合并入口 + 10 格网格 */
    apiWired: /speechSetSlotRules\s*:/.test(s.api),
    feState: /spGridRows\s*:/.test(s.pjs) && /spGridSummaryOf/.test(s.pjs),
    feGridRows: /for\s*\(let d = 1; d <= 5/.test(s.pjs) && /am:\s*am/.test(s.pjs) && /pm:\s*pm/.test(s.pjs),
    feUi: /data-day=/.test(s.pwxml) && /data-slot=/.test(s.pwxml) && /onSpRuleNeed/.test(s.pwxml),
    feTenCells: /spGridRows/.test(s.pwxml) && /sp-need-seg/.test(s.pwxml) && /wx:for="\{\{spGridRows\}\}"/.test(s.pwxml),
    feMerge: /bindtap="onSpGenOpen"/.test(s.pwxml) && !/bindtap="onSpAiOpen"/.test(s.pwxml)
      && /bindtap="onSpGenerate"/.test(s.pwxml) && /bindtap="onSpAiParse"/.test(s.pwxml),
    feSave: /speechSetSlotRules\(\s*\{\s*rules:\s*rules/.test(s.pjs) && /day:\s*r\.day,\s*slot:\s*'AM'/.test(s.pjs),
    feCss: /\.sp-grid-row\s*\{/.test(s.pwxss) && /\.sp-grid-cell\s*\{/.test(s.pwxss) && /\.sp-seg-compact\s*\{/.test(s.pwxss)
  };
}

const S = evalAll(SRC);

console.log('── ① 持久化与纯函数（格子维度 + 旧格式兼容）');
check(S.migCol, '迁移脚本给 speech_setting 加 slot_rules 列');
check(S.fnOk, 'parseSlotRules() / gridToSidMap() 可执行');
check(S.newCellOk, '新格式 {day:5,slot:PM,need:1} 读成「5|PM」格');
check(S.legacyOk, '旧格式 {sid:339,need:1} 借 session 反查成同一格（升级不失效）');
check(S.twoDropped, 'need=2 视为默认、不落库');
check(S.dirtySafe, '脏 JSON 当「没有规则」，不抛错');
check(S.strCoerce, '字符串 day/slot/need（JSON 往返）也能正确转数字');
check(S.gridExpand, '格子展开 override：周五下午命中该时段所有课次（339+401），其它时段不受影响');

console.log('\n── ② 后端四处口径统一');
check(S.routeExists, 'speechSetSlotRules 路由存在');
check(S.routeAuth, 'speechSetSlotRules 挂 speechAuth');
check(S.dayGuard && S.slotGuard, '落库校验 day 1-5 / slot AM|PM');
check(S.needGuard && S.keptCell, 'need 只接受 1/2，只留 need=1 的格子');
check(S.genWired, '一键生成：格子规则展开后交给 buildSlots');
check(S.aiWired, '智能排班：格子规则展开成 override 为底，AI 再覆盖');
check(S.listWired, 'speechList 下发固定 10 格（1-5 × AM/PM）');
check(S.boardWired, 'speechBoard 场次 need 按格子取');

console.log('\n── ③ 小程序：合并入口 + 排班方式 10 格');
check(S.apiWired, 'api.js 有 speechSetSlotRules 封装');
check(S.feState && S.feGridRows, '页面 data 有 spGridRows / spGridSummaryOf，10 格按 1-5×AM/PM 构建');
check(S.feUi && S.feTenCells, '排班方式弹层 5 行×2 列，每格 data-day/data-slot 接线');
check(S.feMerge, '顶部只留单个「一键生成」入口（onSpGenOpen），弹层内选轮转/智能排班');
check(S.feSave, '保存时提交格子规则 [{day,slot,need:1}]');
check(S.feCss, '.sp-grid-row / .sp-grid-cell / .sp-seg-compact 样式齐备');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: 'need=2 也当成规则存下来', probe: 'twoDropped', file: 'js',
    from: 'if (!it || Number(it.need) !== 1) return;', to: 'if (!it || Number(it.need) < 1) return;' },
  { name: '脏 JSON 直接抛（设置坏了整周排不了）', probe: 'dirtySafe', file: 'js',
    from: 'try { arr = JSON.parse(raw); } catch (e) { return cells; }', to: 'arr = JSON.parse(raw);' },
  { name: '格子展开丢掉同格另一门课（只认单门）', probe: 'gridExpand', file: 'js',
    from: "if (d >= 1 && d <= 5 && sl && cells[d + '|' + sl] === 1) map[s.id] = 1;",
    to: "if (d >= 1 && d <= 5 && sl && cells[d + '|' + sl] === 1 && s.id === 339) map[s.id] = 1;" },
  { name: '落库不校验 day 范围（可写越界格子）', probe: 'dayGuard', file: 'js',
    from: 'if (!(day >= 1 && day <= 5) || !slot || (n !== 1 && n !== 2)) return;',
    to: 'if (!slot || (n !== 1 && n !== 2)) return;' },
  { name: '一键生成不读规则（每场又回到 2 人）', probe: 'genWired', file: 'js',
    apply: (src) => src.replace(/const cellMap = await loadSlotRules\(conn, classId, sessions\);\s*\n\s*const ruleMap = gridToSidMap\(cellMap, sessions\);\s*\n\s*const slots = speechCore\.buildSlots\(sessions, wk, \{ override: ruleMap \}, week\);/,
      'const slots = speechCore.buildSlots(sessions, wk, {}, week);') },
  { name: '智能排班不认已保存规则', probe: 'aiWired', file: 'js',
    from: 'const override = gridToSidMap(cellMap, sessions);', to: 'const override = {};' },
  { name: '设置页下发不再固定 10 格', probe: 'listWired', file: 'js',
    apply: (src) => src.replace(/for \(let d = 1; d <= 5; d \+= 1\) \{\s*\n\s*\['AM', 'PM'\]\.forEach\(\(sl\) => \{[\s\S]*?\n\s*\}\);\s*\n\s*\}/, '') },
  { name: 'speechSetSlotRules 不挂演讲权限', probe: 'routeAuth', file: 'js',
    apply: (src) => src.replace(/(speechSetSlotRules: \{\s*\n\s*auth: \{ )speechAuth: true/, '$1needBind: true') },
  { name: '保存时漏掉规则（只存游标）', probe: 'feSave', file: 'pjs',
    from: "api.speechSetSlotRules({ rules: rules }, { toast: false })", to: 'Promise.resolve({})' },
  { name: '切回独立的「智能排班」按钮（没合并）', probe: 'feMerge', file: 'pwxml',
    apply: (src) => src.replace('bindtap="onSpGenOpen"', 'bindtap="onSpAiOpen"') }
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

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲「排班方式（周几×上下午）+ 一键生成合并」检查全部通过'));
process.exit(failed ? 1 : 0);
