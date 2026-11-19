#!/usr/bin/env node
/**
 * 离线自检：演讲单条增删两路由（1.0.8.67）
 * --------------------------------------------------------------------------------
 * 背景：演讲排班页要 1:1 复刻值日排班页的「添加 / 取消 / 换人」，但后端此前只有
 *   speechReassign（换人）与 speechClear（整周清空），缺单条增删。本门禁守住新增的：
 *     · speechAdd({week, sessionId, memberId})   单场加人
 *     · speechRemove({id})                       单场取消（真删一行）
 * 两条都是 speechAuth（不能退回 scheduleAuth，否则把值日权给学习委员），派发器已通用接线。
 *
 * 关键口径（变异自证覆盖）：
 *   ① speechAdd 必须用 loadSpeechSessions 解析场次 ⇒ 与生成同源，调课/放假自动对齐；
 *   ② 写入 slot/scope 由 session 推导（scope: A/B/ALL），不动游标；
 *   ③ 同一人同一场去重（uq_speech 唯一键 + 友好文案）；
 *   ④ speechRemove 按 id + class_id 删，不动游标/发布态；
 *   ⑤ api.js 暴露两个方法；前端演讲排班页确实调用它们。
 *
 * 用法：node scripts/check-speech-add-remove.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  sch: 'cloudfunctions/schedule/index.js',
  api: 'miniprogram/utils/api.js',
  speechPage: 'miniprogram/pages/speech/index.js'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = fs.existsSync(path.join(ROOT, F[k])) ? read(F[k]) : ''; });

/** 抽路由块：从 `\n  <name>: {` 到下一个同级路由 */
function routeBlock(src, name) {
  const start = src.indexOf('\n  ' + name + ': {');
  if (start < 0) return '';
  const re = /\n  [A-Za-z_$][\w$]*:\s*\{/g;
  re.lastIndex = start + 1;
  const m = re.exec(src);
  return m ? src.slice(start, m.index) : src.slice(start);
}

function evalAll(s) {
  const add = routeBlock(s.sch, 'speechAdd');
  const rem = routeBlock(s.sch, 'speechRemove');
  return {
    addFound: !!add,
    remFound: !!rem,
    addAuth: /auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(add)
      && !/auth:\s*\{\s*scheduleAuth/.test(add),
    remAuth: /auth:\s*\{\s*speechAuth:\s*true\s*\}/.test(rem)
      && !/auth:\s*\{\s*scheduleAuth/.test(rem),
    /* ① 与生成同源解析场次 */
    addUsesSessions: /loadSpeechSessions\(pool,\s*classId,\s*wk\)/.test(add)
      && /\.find\(s\s*=>\s*s\.id\s*===\s*sessionId\)/.test(add),
    /* ② slot/scope 由 session 推导；scope 三值齐全 */
    addScope: /sl\.period\s*===\s*speechCore\.AM_PERIOD\s*\?\s*'AM'\s*:\s*'PM'/.test(add)
      && /sl\.group_scope\s*===\s*'A'\s*\?\s*'A'\s*:\s*\(sl\.group_scope\s*===\s*'B'\s*\?\s*'B'\s*:\s*'ALL'\)/.test(add),
    /* ③ 去重 + MANUAL 源 */
    addDedup: /status <> 'SWAPPED_OUT'/.test(add)
      && /41007/.test(add) && /'MANUAL', 'PENDING'/.test(add),
    /* ④ remove 按 id+class_id 删，不动游标 */
    remDelete: /DELETE FROM speech WHERE id = \? AND class_id = \?/.test(rem)
      && /SELECT id, member_id FROM speech WHERE id = \? AND class_id = \?/.test(rem),
    remNoCursor: !/speech_cursor|saveSpeechCursors|base_cursors/.test(rem.replace(/\/\*[\s\S]*?\*\//g, '')),
    /* ⑤ api + 前端调用 */
    apiMethods: /speechAdd:\s*C\('schedule',\s*'speechAdd'\)/.test(s.api)
      && /speechRemove:\s*C\('schedule',\s*'speechRemove'\)/.test(s.api),
    pageUses: /api\.speechAdd\(/.test(s.speechPage) && /api\.speechRemove\(/.test(s.speechPage)
  };
}

const S = evalAll(SRC);

console.log('── ① 两条路由存在且挂 speechAuth');
check(S.addFound, 'schedule 有 speechAdd 路由');
check(S.remFound, 'schedule 有 speechRemove 路由');
check(S.addAuth, 'speechAdd 挂 speechAuth（学习委员可加人，不串值日权）');
check(S.remAuth, 'speechRemove 挂 speechAuth');

console.log('\n── ② speechAdd 场次解析与写入口径');
check(S.addUsesSessions, 'speechAdd 用 loadSpeechSessions 解析本周场次（与生成同源，调课/放假对齐）');
check(S.addScope, 'slot/scope 由 session 推导（A/B/ALL），写进 speech 行');
check(S.addDedup, '同一人同一场去重（41007）+ source=MANUAL/PENDING');

console.log('\n── ③ speechRemove 删除口径');
check(S.remDelete, 'speechRemove 按 id + class_id 精确删本班那一行');
check(S.remNoCursor, 'speechRemove 不动游标/发布态（避免取消后再生成跳人）');

console.log('\n── ④ 前端接线');
check(S.apiMethods, 'api.js 暴露 speechAdd / speechRemove 两个方法');
check(S.pageUses, '演讲排班页调用 api.speechAdd / api.speechRemove');

console.log('\n── ⑤ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: 'speechAdd 退回 scheduleAuth（学习委员加不了人）', probe: 'addAuth', file: 'sch',
    apply: (src) => {
      const b = routeBlock(src, 'speechAdd');
      return b ? src.replace(b, b.replace('auth: { speechAuth: true }', 'auth: { scheduleAuth: true }')) : src;
    } },
  { name: 'speechAdd 不解析场次（写死 scope=ALL）', probe: 'addUsesSessions', file: 'sch',
    from: "const sl = slots.find(s => s.id === sessionId);", to: "const sl = { class_date: '', period: 1, group_scope: null };" },
  { name: 'speechAdd 去掉同场去重', probe: 'addDedup', file: 'sch',
    from: "if (dup.length) throw new BizError(41007, '该同学已在这场演讲名单里');", to: '' },
  { name: 'speechRemove 去掉 class_id 隔离（可跨班删）', probe: 'remDelete', file: 'sch',
    from: 'DELETE FROM speech WHERE id = ? AND class_id = ?', to: 'DELETE FROM speech WHERE id = ?' },
  { name: 'speechRemove 误加游标推进', probe: 'remNoCursor', file: 'sch',
    apply: (src) => {
      const b = routeBlock(src, 'speechRemove');
      return b ? src.replace(b, b.replace('return {};', 'await saveSpeechCursors(pool, classId, { A: 0, B: 0 });\n      return {};')) : src;
    } },
  { name: 'api.js 删掉 speechAdd', probe: 'apiMethods', file: 'api',
    from: "speechAdd: C('schedule', 'speechAdd'),", to: '' }
];

MUT.forEach((mu) => {
  const src = SRC[mu.file];
  if (!mu.apply && src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const nextSrc = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [mu.file]: nextSrc });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲单条增删接口检查全部通过'));
process.exit(failed ? 1 : 0);
