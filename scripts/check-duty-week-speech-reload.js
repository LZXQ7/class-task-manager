#!/usr/bin/env node
/**
 * 离线自检：换周后「课前演讲」必须跟着换数据（2026-11-17 立规）
 * --------------------------------------------------------------------------------
 * 用户报障（截图 2026-11-23–11-29 · 第 11 周，课前演讲视图）：
 *   切到第 11 周，卡片里仍然是 **2026-11-18 / 11-19 / 11-20**（= 第 10 周的日期）。
 *   用户原话：「第十周排好了，但是切换到下一周和后面的周，都显示第十周的」。
 *
 * 根因：`_applyWeek()` 是**换周唯一入口**（箭头 / 左右滑动 / 周次选择器都走它），
 *   但它只调 `this.load()`（值日那份数据），**从没调 `loadSpeech()`**。
 *   演讲视图与值日共用 `week` 状态：周次变了、标题变了，演讲数据却还是上一次拉的，
 *   于是「周数换了、日期没换」—— 这类 bug 不报错、不 toast，看起来像「排班没生效」。
 *
 * 定规：
 *   ① `_applyWeek` 换周后：值日照旧 `load()`；**演讲视图下必须再 `loadSpeech()`**；
 *   ② 演讲重拉要有 `viewMode === 'speech'` 守卫 —— 值日视图切周不该白打一次演讲请求；
 *   ③ `onShow`（周次被纠回 / 换了查看班级）与 `onDutyClass`（辅导员切班）同理：演讲视图要跟着重拉；
 *   ④ 全站换周仍只有 `_applyWeek` 一条路（别在别处再写一套 `setData({week}) + load`）。
 *
 * 用法：node scripts/check-duty-week-speech-reload.js
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

const FILE = 'miniprogram/pages/duty/index.js';
const SRC = read(FILE);

/** 取页面方法体（锚 `\n  name(`：页内别处有 `this.xxx()` 调用，裸 indexOf 会命中调用点） */
function methodBody(js, name) {
  let i = js.indexOf('\n  ' + name + '(');
  if (i < 0) i = js.indexOf(name + '(');
  if (i < 0) return '';
  const rest = js.slice(i);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 真跑页面上的方法（桩掉 setData / load / loadSpeech），观察它到底调了什么 */
function runApplyWeek(js) {
  const body = methodBody(stripJs(js), '_applyWeek');
  if (!body) return null;
  /* 方法体末尾是 `},`（对象属性分隔符）：转成函数表达式时那个逗号是语法错，
     不裁掉就会 catch 成「函数不存在」，四条判据全假红。 */
  const src = body.replace(/^\s*_applyWeek\s*\(/, 'function (').replace(/,\s*$/, '');
  let fn = null;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('return ' + src)();
  } catch (e) {
    return null;
  }
  return (viewMode, wk) => {
    const calls = [];
    const page = {
      data: { viewMode, week: 1 },
      _hasData: true,
      _weekManual: false,
      setData(patch) { Object.assign(this.data, patch); },
      load() { calls.push('load'); },
      loadSpeech() { calls.push('loadSpeech'); }
    };
    fn.call(page, wk);
    return { calls, week: page.data.week, hasData: page._hasData };
  };
}

function evalAll(js) {
  const j = stripJs(js);
  const show = methodBody(j, 'onShow');
  const cls = methodBody(j, 'onDutyClass');
  const weekChange = methodBody(j, 'onWeekChange');
  const apply = methodBody(j, '_applyWeek');
  const runner = runApplyWeek(js);

  let speechMode = null;
  let dutyMode = null;
  if (runner) {
    speechMode = runner('speech', 11);
    dutyMode = runner('duty', 11);
  }

  return {
    /* ① 演讲视图切周 → 演讲数据必须重拉，且 week 真的变了 */
    applyReloadsSpeech: !!(speechMode
      && speechMode.calls.indexOf('loadSpeech') >= 0
      && speechMode.week === 11),
    /* ① 值日那份不能丢（回归护栏） */
    applyKeepsDutyLoad: !!(speechMode && dutyMode
      && speechMode.calls.indexOf('load') >= 0
      && dutyMode.calls.indexOf('load') >= 0),
    /* ② 值日视图切周不该白打演讲请求 */
    applyGuarded: !!(dutyMode && dutyMode.calls.indexOf('loadSpeech') < 0),
    /* ① 换周必须让「屏幕上这份已过期」的标记复位（否则静默复用旧数据） */
    applyResetsFresh: !!(speechMode && speechMode.hasData === false),
    /* ③ onShow：周次被纠回 / 换班后，演讲视图要跟着重拉 */
    /* ⚠️ 必须判「守卫与 loadSpeech 同行/紧邻」，不能用宽泛的 /viewMode/：
       1.0.8.87 给 onShow 加了按分段上报埋点（也引用 viewMode），宽判据会让
       「删掉演讲重拉」的变异被埋点里的 viewMode 掩盖成假通过。 */
    showReloads: /viewMode\s*===\s*['"]speech['"][^\n]{0,120}loadSpeech\s*\(/.test(show),
    /* ③ 辅导员切班同理 */
    classReloads: /loadSpeech\s*\(/.test(cls),
    /* ④ 换周仍然只有一条路 */
    singlePath: /_applyWeek\s*\(/.test(weekChange) && /this\.loadSpeech\s*\(/.test(weekChange) === false
  };
}

const S = evalAll(SRC);

console.log('── ① 换周唯一入口 _applyWeek（真跑方法体，桩掉网络调用）');
check(S.applyReloadsSpeech, '演讲视图切到第 11 周 → 调用 loadSpeech()，且 data.week = 11');
check(S.applyKeepsDutyLoad, '两种视图下 this.load() 都照旧调用（值日数据不回归）');
check(S.applyGuarded, '值日视图切周**不**调用 loadSpeech()（有 viewMode 守卫，不白打请求）');
check(S.applyResetsFresh, '换周后 _hasData 复位为 false（禁止静默复用上一周）');

console.log('\n── ② 其它「周/班」变更入口');
check(S.showReloads, 'onShow（周次被纠回 / 换了查看班级）在演讲视图下重拉演讲');
check(S.classReloads, 'onDutyClass（辅导员切班）在演讲视图下重拉演讲');
check(S.singlePath, 'onWeekChange 仍只经 _applyWeek 一条路（不在别处另起 setData+load）');

console.log('\n── ③ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '退回旧状：换周只 load() 不 loadSpeech()', probe: 'applyReloadsSpeech', file: 'js',
    apply: (src) => {
      const i = src.indexOf('\n  _applyWeek(');
      if (i < 0) return src;
      const k = src.indexOf('loadSpeech', i);
      if (k < 0) return src;
      const lineStart = src.lastIndexOf('\n', src.lastIndexOf('if (', k)) + 1;
      const lineEnd = src.indexOf('\n', src.indexOf(';', k)) + 1;
      return src.slice(0, lineStart) + src.slice(lineEnd);
    } },
  { name: '去掉 viewMode 守卫（值日视图也白打演讲请求）', probe: 'applyGuarded', file: 'js',
    /* ⚠️ 同一行在 onDutyClass 里也有一份，且它在文件里更靠前 —— replace 首处会打偏 ⇒ 假通过。
       必须限定在 _applyWeek 方法体内改。 */
    apply: (src) => {
      const i = src.indexOf('\n  _applyWeek(');
      if (i < 0) return src;
      const guard = "if (this.data.viewMode === 'speech') this.loadSpeech();";
      const j = src.indexOf(guard, i);
      if (j < 0) return src;
      return src.slice(0, j) + 'this.loadSpeech();' + src.slice(j + guard.length);
    } },
  { name: '换周不再调 load()（值日数据不刷新）', probe: 'applyKeepsDutyLoad', file: 'js',
    from: '    this._hasData = false;\n    this.load();',
    to: '    this._hasData = false;' },
  { name: '换周不动 _hasData（会静默复用上周）', probe: 'applyResetsFresh', file: 'js',
    from: '    this._hasData = false;\n',
    to: '' },
  { name: 'onShow 不再重拉演讲', probe: 'showReloads', file: 'js',
    from: "if (this.data.viewMode === 'speech' && (corrected || needClassReload)) this.loadSpeech();",
    to: "if (false) this.loadSpeech();" },
  { name: '辅导员切班不再重拉演讲', probe: 'classReloads', file: 'js',
    /* ⚠️ 不能按字符串换：`if (this.data.viewMode === 'speech') this.loadSpeech();`
       在 _applyWeek / onDutyClass 里各有一份，replace 首处会打偏（假通过）。
       这里限定在 onDutyClass 方法体内裁掉那一行。 */
    apply: (src) => {
      const i = src.indexOf('\n  onDutyClass(');
      if (i < 0) return src;
      const j = src.indexOf('loadSpeech', i);
      if (j < 0) return src;
      const lineStart = src.lastIndexOf('\n', j) + 1;
      const lineEnd = src.indexOf('\n', j) + 1;
      return src.slice(0, lineStart) + src.slice(lineEnd);
    } }
];

MUT.forEach((mu) => {
  const src = SRC;
  if (!mu.apply && src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const nextSrc = mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to);
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码（锚点命中但替换无效）');
    failed += 1;
    return;
  }
  check(evalAll(nextSrc)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 换周后「演讲跟着换数据」检查全部通过'));
process.exit(failed ? 1 : 0);
