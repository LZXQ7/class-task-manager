#!/usr/bin/env node
/**
 * 后台演讲页「缺少周次」bug 反馈回路（2026-11-28 · 1.0.8.96 真机反馈）
 * ============================================================
 * 症状：首次进入「课前演讲」页即报「加载失败 / 缺少周次」，名单出不来。
 * 根因：前端 renderSpeech 首次 state.spWeek=0 → 拼 query 时省掉 &week= →
 *       后端 mod-speech.listSpeech 的 `if (!wk) throw 缺少周次` 直接拒绝。
 *
 * 回路真跑后端 listSpeech 函数体（vm + mock pool），断言：
 *   A 缺省 week 不抛「缺少周次」、返回有效 week（前端 placeholder「本周」的语义）
 *   B 显式 week 仍被尊重（不被兜底覆盖）
 *   C 前端把后端回传的 week 回填 state.spWeek（否则发布按钮仍拦「请先填写周次」）
 *   D 变异自证：把兜底改回 throw → A 必须翻红
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MOD = read('cloudfunctions/admin-web/lib/mod-speech.js');
const APP = read('cloudfunctions/admin-web/public/app.js');

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

/** 提取 listSpeech 函数体（从声明到下一个 async function） */
function listSpeechSource(src) {
  const start = src.indexOf('async function listSpeech(');
  const end = src.indexOf('\nasync function publishWeek(', start);
  if (start < 0 || end < 0) throw new Error('listSpeech 函数边界没找到');
  return src.slice(start, end);
}

/** 真跑 listSpeech，mock pool 与依赖；returns { threw, errMsg, data } */
function runList(src, q) {
  // 用真实 week 模块替掉 stub：这样 getConfig 的驼峰字段 vs currentWeek 的下划线字段
  // 契约错配会被真跑抓出（传错 → term_start=undefined → NaN 周次 → 判据翻红）。
  const realWeek = require(path.join(ROOT, 'cloudfunctions/admin-web/common/week.js'));
  // DB 里 class 表是下划线列；getConfig 会转成驼峰 termStart/totalWeeks 返回。
  const dbRow = { term_start: '2026-09-14', total_weeks: 16, name: '测试班' };
  const weekStub = {
    getConfig: (pool, cid) => realWeek.getConfig(pool, cid),
    currentWeek: (cfg) => realWeek.currentWeek(cfg),
    nowStamp: () => '2026-11-28 12:00:00'
  };
  class BizError extends Error {
    constructor(code, msg) { super(msg); this.code = code; this.errMsg = msg; }
  }
  const pool = {
    query: async (sql) => {
      if (/FROM\s+speech_publish/.test(sql)) return [[], []];
      if (/FROM\s+speech\b/.test(sql)) return [[], []];
      if (/FROM\s+speech_cursor/.test(sql)) return [[], []];
      if (/FROM\s+speech_setting/.test(sql)) return [[], []];
      if (/FROM\s+`class`/.test(sql)) return [[dbRow], []];
      return [[], []];
    }
  };
  const ctx = {
    getPool: () => pool,
    BizError,
    NOT_TEST: () => '1=1',
    week: weekStub,
    speechCore: { publishWeek: async () => ({}) },
    logAction: async () => {},
    console,
    Number, Math, Date, String, Array, Object, Set, Promise, RegExp
  };
  vm.createContext(ctx);
  vm.runInContext(listSpeechSource(src) + '\n;globalThis.__run = listSpeech;', ctx);
  return ctx.__run(q).then(
    (data) => ({ threw: false, data }),
    (e) => ({ threw: true, errMsg: e.errMsg || e.message })
  );
}

(async () => {
  console.log('\n== A 缺省 week 不抛「缺少周次」 ==');
  const a = await runList(MOD, { classId: 3 });
  check(!a.threw, '缺省 week 调用不抛错（实际：' + (a.threw ? a.errMsg : 'ok') + '）');
  const aw = a.data && a.data.week;
  check(Number.isFinite(Number(aw)) && Number(aw) >= 1 && Number(aw) <= 16,
    '缺省 week 返回有效周次（非 NaN，1..16；实际：' + aw + '）');

  // 契约错配哨兵：若把 getConfig 返回的整 cfg 直接传 currentWeek（而不映射字段名），
  // term_start=undefined → NaN。此断言确保代码里显式做了 termStart→term_start 映射。
  check(/term_start:\s*cfg\.termStart/.test(MOD) && /total_weeks:\s*cfg\.totalWeeks/.test(MOD),
    'getConfig 驼峰字段显式映射为 currentWeek 下划线字段（防 NaN 周次）');

  console.log('\n== B 显式 week 仍被尊重 ==');
  const b = await runList(MOD, { classId: 3, week: 8 });
  check(!b.threw && b.data && Number(b.data.week) === 8,
    '显式 week=8 不被兜底覆盖（实际：' + (b.data && b.data.week) + '）');

  console.log('\n== C 前端回填后端周次 ==');
  check(/if\s*\(!state\.spWeek\s*&&\s*v\.week\)\s*state\.spWeek\s*=\s*v\.week/.test(APP),
    '前端 load() 把后端回传 week 回填 state.spWeek（发布按钮才不会拦）');

  console.log('\n== D 变异自证 ==');
  const mut = MOD.replace(
    /let wk = Number\(q\.week\);/,
    'let wk = Number(q.week);\n  if (!wk) throw new BizError(40001, "缺少周次");'
  );
  const d = await runList(mut, { classId: 3 });
  check(d.threw && /缺少周次/.test(d.errMsg),
    '变异被抓：把兜底改回 throw → 缺省 week 再次抛「缺少周次」');

  // 变异：把字段映射删掉、直接传整 cfg → currentWeek 读到 undefined → NaN → 判据翻红
  const mut2 = MOD.replace(
    /wk = week\.currentWeek\(\{ term_start: cfg\.termStart, total_weeks: cfg\.totalWeeks \}\);/,
    'wk = week.currentWeek(cfg);'
  );
  check(!/term_start:\s*cfg\.termStart/.test(mut2),
    '变异被抓：字段映射改回传整 cfg → 契约错配判据翻红');

  console.log('\n结果：' + (fail ? '失败 ' + fail + ' / 通过 ' + pass : '全部通过（' + pass + ' 项）'));
  process.exit(fail ? 1 : 0);
})();
