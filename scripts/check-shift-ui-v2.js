#!/usr/bin/env node
/**
 * 门禁：调课交互 v2（2026-11-28 用户四项改造口径）
 * ================================================================
 * 用户口径：
 *   ① 课程长按不再出三项弧形菜单，一步进入四项玻璃弹层：
 *      仅本周调 / 多个周次 / 本周不上 / 编辑课程；
 *   ② 单周次只给五大节 1~5，不出现开始节次 / 结束节次 / 调课原因；
 *   ③ 临时调课选择课次默认「全部」，可筛 A / B；全班课（空 group_scope）
 *      在三种筛选下都显示；独立 A/B session 仍独立调；
 *   ④ 左下角 FAB 的弧形菜单行为保持不变（不能被本轮顺手删掉）。
 *
 * 判据落在两个 seam：
 *   - 页面源码契约（wxml/js/wxss）：结构、接线、玻璃令牌、无旧菜单残留；
 *   - `_syncShiftSessions()` 真实函数体 harness：用三条 session 跑三种筛选，
 *     断言全班课不丢、A/B 独立课不串。
 * 末尾做变异自证：每个关键判据必须有对应坏样本能翻红。
 *
 * 用法：node scripts/check-shift-ui-v2.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS_PATH = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.js');
const WXML_PATH = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.wxml');
const WXSS_PATH = path.join(ROOT, 'miniprogram', 'pages', 'timetable', 'index.wxss');

const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function methodBody(js, name) {
  const re = new RegExp('\\n  ' + name + '\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = re.exec(js);
  return m ? m[2] : '';
}

function abFilterBehavior(js) {
  const body = methodBody(js, '_syncShiftSessions');
  if (!body) return false;
  let fn;
  try {
    fn = new Function('util', 'return function(){' + body + '};')({
      weekdayShort: d => ({ 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' })[d] || String(d)
    });
  } catch (e) {
    return false;
  }
  const sessions = [
    { sessionId: 11, dayOfWeek: 1, period: 1, name: '儿童文学', groupScope: 'A', movedOut: false, movedIn: false },
    { sessionId: 12, dayOfWeek: 2, period: 2, name: '微课设计', groupScope: 'B', movedOut: false, movedIn: false },
    { sessionId: 13, dayOfWeek: 3, period: 3, name: '大学语文', groupScope: '', movedOut: false, movedIn: false },
    { sessionId: 14, dayOfWeek: 4, period: 4, name: '已调出', groupScope: 'A', movedOut: true, movedIn: false }
  ];
  const run = filter => {
    let out = null;
    const inst = {
      _courses: sessions,
      data: { shiftGroupFilter: filter, shiftSessionIndex: 0 },
      setData(p) { out = p; }
    };
    fn.call(inst);
    return out || {};
  };
  const all = run('all');
  const a = run('A');
  const b = run('B');
  const labels = x => x.shiftSessionLabels || [];
  return labels(all).length === 3 &&
    labels(a).length === 2 && labels(a).some(t => t.indexOf('大学语文') >= 0) && labels(a).some(t => t.indexOf('儿童文学') >= 0) && !labels(a).some(t => t.indexOf('微课设计') >= 0) &&
    labels(b).length === 2 && labels(b).some(t => t.indexOf('大学语文') >= 0) && labels(b).some(t => t.indexOf('微课设计') >= 0) && !labels(b).some(t => t.indexOf('儿童文学') >= 0);
}

function buildProbes(raw) {
  const js = stripJs(raw.js);
  const wxml = stripHtml(raw.wxml);
  const wxss = stripJs(raw.wxss);
  const cellBody = methodBody(js, 'onCellLongPress');
  const actionBody = methodBody(js, 'onCellAction');
  const pageMeta = (wxml.match(/<page-meta[^>]*>/) || [''])[0];
  const itemBlock = (/\.cell-act-item\s*\{([\s\S]*?)\}/.exec(wxss) || ['', ''])[1];
  const actions = [
    ['week', '仅本周调'],
    ['multi', '多个周次'],
    ['off', '本周不上'],
    ['edit', '编辑课程']
  ];

  const p = {};
  p.longPressDirect = !!cellBody &&
    /cellActionShow:\s*true/.test(cellBody) &&
    !/rmShow:\s*true/.test(cellBody) &&
    /cellActionSid/.test(cellBody);
  p.cellActionSheet = /<bottom-sheet[^>]*show="\{\{cellActionShow\}\}"/.test(wxml) &&
    /bind:close="onCellActionClose"/.test(wxml);
  p.fourActions = actions.every(a =>
    new RegExp('data-key="' + a[0] + '"').test(wxml) && wxml.indexOf(a[1]) >= 0) &&
    !!actionBody && actions.every(a => actionBody.indexOf("key === '" + a[0] + "'") >= 0);
  p.cellRadialRemoved = !/id="rm-cell"/.test(wxml) &&
    !/onCellTouch(?:Start|Move|End)/.test(js) &&
    !/onCellTouch(?:Start|Move|End)/.test(wxml) &&
    !/\brmShow\b/.test(js) && !/\brmShow\b/.test(wxml);
  p.fabRadialKept = /id="rm-fab"/.test(wxml) &&
    /bindlongpress="onFabRadial"/.test(wxml) &&
    /selectComponent\('#rm-fab'\)/.test(js);
  p.pageMetaLock = /cellActionShow/.test(pageMeta);
  p.glassStyle = /var\(--glass-bg-strong/.test(itemBlock) &&
    /var\(--glass-edge/.test(itemBlock) &&
    /var\(--glass-shadow/.test(itemBlock) &&
    !/background:\s*#fff/i.test(itemBlock);
  p.fivePeriodsOnly = /shiftPeriodChips:\s*\[1,\s*2,\s*3,\s*4,\s*5\]/.test(js) &&
    /wx:for="\{\{shiftPeriodChips\}\}"/.test(wxml) &&
    !/调课原因|开始节次|结束节次/.test(wxml);
  p.abFilterUi = /shiftGroupFilter:\s*'all'/.test(js) &&
    /shiftGroupFilters/.test(wxml) &&
    /bindtap="onShiftGroupFilter"/.test(wxml) &&
    /onShiftGroupFilter\s*\(/.test(js);
  p.abFilterBehavior = abFilterBehavior(js);
  return p;
}

const raw = {
  js: fs.readFileSync(JS_PATH, 'utf8'),
  wxml: fs.readFileSync(WXML_PATH, 'utf8'),
  wxss: fs.readFileSync(WXSS_PATH, 'utf8')
};

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

console.log('── ① 课表长按四项玻璃弹层');
const probes = buildProbes(raw);
Object.keys(probes).forEach(k => check(probes[k], '契约 ' + k));

console.log('── ② 变异自证（坏样本必须翻红）');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
const mutants = [
  {
    name: '长按又退回弧形菜单（先弹菜单再点）',
    expect: 'longPressDirect',
    build: () => {
      const js = mutate(raw.js, 'cellActionShow: true', 'rmShow: true');
      return js === null ? null : Object.assign({}, raw, { js });
    }
  },
  {
    name: '四项动作删掉「编辑课程」按钮',
    expect: 'fourActions',
    build: () => {
      const wxml = mutate(raw.wxml, 'data-key="edit"', 'data-key="off"');
      return wxml === null ? null : Object.assign({}, raw, { wxml });
    }
  },
  {
    name: '四项弹层退回白底（丢玻璃令牌）',
    expect: 'glassStyle',
    build: () => {
      const wxss = mutate(raw.wxss, 'background: var(--glass-bg-strong);', 'background: #ffffff;');
      return wxss === null ? null : Object.assign({}, raw, { wxss });
    }
  },
  {
    name: '课程格子又把弧形菜单 id 接回来',
    expect: 'cellRadialRemoved',
    build: () => {
      const wxml = mutate(raw.wxml, 'id="rm-fab"', 'id="rm-cell" id="rm-fab"');
      return wxml === null ? null : Object.assign({}, raw, { wxml });
    }
  },
  {
    name: '单周次表单又加回调课原因',
    expect: 'fivePeriodsOnly',
    build: () => {
      const wxml = mutate(raw.wxml, '也可以直接在课表上长按某一格，自动选中那节课',
        '也可以直接在课表上长按某一格，自动选中那节课<text>调课原因</text>');
      return wxml === null ? null : Object.assign({}, raw, { wxml });
    }
  },
  {
    name: 'A/B 筛选 chip 不再派发事件',
    expect: 'abFilterUi',
    build: () => {
      const wxml = mutate(raw.wxml, 'bindtap="onShiftGroupFilter"', '');
      return wxml === null ? null : Object.assign({}, raw, { wxml });
    }
  },
  {
    name: '全班课在筛选里被当普通 A/B 课过滤掉',
    expect: 'abFilterBehavior',
    build: () => {
      const js = mutate(raw.js, "!c.groupScope || c.groupScope === 'ALL' || ", '');
      return js === null ? null : Object.assign({}, raw, { js });
    }
  },
  {
    name: '四项弹层打开时页面滚动未锁',
    expect: 'pageMetaLock',
    build: () => {
      const wxml = mutate(raw.wxml, 'cellActionShow) ?', 'cellActionLock) ?');
      return wxml === null ? null : Object.assign({}, raw, { wxml });
    }
  }
];

mutants.forEach(mt => {
  const badRaw = mt.build();
  if (!badRaw) { bad('变异锚点没命中源码：' + mt.name); return; }
  const changed = Object.keys(badRaw).some(k => badRaw[k] !== raw[k]);
  if (!changed) { bad('变异替换没生效：' + mt.name); return; }
  const r = buildProbes(badRaw);
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0
  ? '\nOK · 调课交互 v2（四项玻璃弹层 / 五大节 / A-B 筛选 / FAB 不变）门禁通过'
  : '\nFAIL · 调课交互 v2 门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
