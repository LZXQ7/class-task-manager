#!/usr/bin/env node
/**
 * 离线自检：危险按钮必须二次确认（1.0.8.85）
 * ============================================================
 * 用户口径：「值日和课前演讲页，清空按钮这种危险按钮要增加二次确认，
 *            小程序所有危险按钮都要二次确认」。
 *
 * 判据：
 *   ① 值日页四处危险操作（清空值日 / 清空演讲 / 撤回值日发布 / 撤回演讲发布）
 *      统一走站内 <dialog>：handler 只 onDanger 开弹窗，不发请求；
 *      请求只在 onDangerConfirm → DANGER_ACTIONS[x].run 里。
 *   ② 原生 wx.showModal 不在值日页危险 handler 里（深色白板，项目已弃用）。
 *   ③ 弹层文案讲清后果（不可恢复 / 全班可见性 / 进度回滚），不是干巴巴「确定吗」。
 *   ④ 全站危险操作清单：每个 handler 都必须有确认（站内 dialog / util.confirm /
 *      confirmStrict / wx.showModal 任一）—— 揪出「直接发请求」的裸奔入口。
 *
 * 变异自证：把确认拿掉 / 请求搬到 handler / 文案删空 → 对应判据翻红。
 *
 * 用法：node scripts/check-danger-confirm.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  dutyJs: 'miniprogram/pages/duty/index.js',
  dutyWxml: 'miniprogram/pages/duty/index.wxml',
  dutyJson: 'miniprogram/pages/duty/index.json'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

function methodBody(js, name) {
  const re = new RegExp('\\n  ' + name + '\\(');
  const hm = re.exec(js);
  if (!hm) return '';
  const rest = js.slice(hm.index);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 危险操作 × handler 清单（值日页 4 处 + 其它页已确认的对照样本） */
const DUTY_ACTS = [
  { handler: 'onClear', act: 'clearDuty' },
  { handler: 'onSpClear', act: 'clearSpeech' },
  { handler: 'onUnpublish', act: 'unpublishDuty' },
  { handler: 'onSpUnpublish', act: 'unpublishSpeech' }
];

function evalAll(s) {
  const j = stripJs(s.dutyJs);
  const w = stripXml(s.dutyWxml);
  const json = s.dutyJson;

  /* ① 四处 handler 只开弹窗 */
  const handlersOk = DUTY_ACTS.every((x) => {
    const body = methodBody(j, x.handler);
    if (!body) return false;
    const opens = /this\.onDanger\(/.test(body) && new RegExp("act:\\s*'" + x.act + "'").test(body);
    const noApi = !/api\.(scheduleClear|speechClear|scheduleUnpublish|speechPublish)\s*\(/.test(body);
    const noNative = !/wx\.showModal|confirmStrict|util\.confirm\(/.test(body);
    return opens && noApi && noNative;
  });

  /* ② DANGER_ACTIONS 四个条目齐备，且请求只在 run 里 */
  const cfgBlock = j.slice(j.indexOf('DANGER_ACTIONS:'), j.indexOf('  onDanger(e)'));
  const cfgOk = DUTY_ACTS.every((x) => new RegExp('(^|\\n)\\s{4}' + x.act + ':\\s*\\{').test(cfgBlock));
  const runHasApi =
    /clearDuty:[\s\S]*?run\(that\)[\s\S]*?api\.scheduleClear\s*\(/.test(cfgBlock) &&
    /clearSpeech:[\s\S]*?run\(that\)[\s\S]*?api\.speechClear\s*\(/.test(cfgBlock) &&
    /unpublishDuty:[\s\S]*?run\(that\)[\s\S]*?api\.scheduleUnpublish\s*\(/.test(cfgBlock) &&
    /unpublishSpeech:[\s\S]*?run\(that\)[\s\S]*?api\.speechPublish\s*\(/.test(cfgBlock);

  /* ③ 文案讲清后果 */
  const textOk =
    /删除后不可恢复/.test(cfgBlock) &&
    /全班将看不到/.test(cfgBlock) &&
    /进度会回滚/.test(cfgBlock);

  /* ④ wxml dialog 绑定 + json 注册 */
  const dialogBind = /<dialog[\s\S]*?show="\{\{dangerShow\}\}"[\s\S]*?bind:confirm="onDangerConfirm"[\s\S]*?bind:cancel="onDangerCancel"/.test(w);
  const registered = /"dialog"\s*:\s*"\.\.\/\.\.\/components\/dialog\/index"/.test(json);
  const confirmRoutes = /onDangerConfirm\(\)\s*\{[\s\S]*?this\.DANGER_ACTIONS\[act\][\s\S]*?cfg\.run\(this\)/.test(j);

  /* ⑤ 全站裸奔扫描：危险 handler 直接发请求且无任何确认 → 红 */
  const pagesRoot = path.join(ROOT, 'miniprogram/pages');
  const bare = [];
  const CONFIRM = /onDanger|confirmStrict|util\.confirm\(|wx\.showModal|Show\s*:\s*true|show\s*=\s*\{\{/;
  const DANGEROUS_NAME = /^(onClear|onDelete|onDeleteClass|onDeleteCourse|onDeleteElective|onUnbind|onStaffUnbind|onStaffDelete|onRemoveMember|onToggleStatus|onUnpublish|onSpUnpublish|onFeeDeleteConfirm|onHolidayDel|onWithdraw|onReject|onSwapCancel|onRecycleClear|onClearAll|onRevertTap|onLeaveCancelTap|onHistDelete|onPendingAgree|onPendingReject|onSwapAgree|onSwapReject)$/;
  fs.readdirSync(pagesRoot).forEach((d) => {
    const dir = path.join(pagesRoot, d);
    if (!fs.statSync(dir).isDirectory()) return;
    const jp = path.join(dir, 'index.js');
    if (!fs.existsSync(jp)) return;
    const src = stripJs(fs.readFileSync(jp, 'utf8'));
    const re = /\n  ([a-zA-Z_$][\w$]*)\(/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (!DANGEROUS_NAME.test(name)) continue;
      /* 确认回调本身（xxxConfirm）不算裸奔——它前面已有 xxxTap 开弹窗 */
      if (/Confirm$/.test(name)) continue;
      const rest = src.slice(m.index);
      const nx = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*\(/);
      const body = nx < 0 ? rest : rest.slice(0, nx + 1);
      /* 只看真正发请求的；带确认的放行 */
      if (/api\.[a-zA-Z]+\s*\(/.test(body) && !CONFIRM.test(body)) bare.push(d + '.' + name);
    }
  });

  return {
    handlersOk,
    cfgOk,
    runHasApi,
    textOk,
    dialogBind,
    registered,
    confirmRoutes,
    noBare: bare.length === 0,
    bare: bare
  };
}

const S = evalAll(SRC);

console.log('\n── ① 值日页四处危险 handler');
check(S.handlersOk, '清空/撤回四处 handler 只开弹窗、不直接发请求、不用原生弹窗');
check(S.cfgOk, 'DANGER_ACTIONS 四个动作条目齐备');
check(S.runHasApi, '真实请求只在确认后的 run 里执行');

console.log('\n── ② 文案与接线');
check(S.textOk, '文案讲清不可恢复 / 全班可见性 / 进度回滚');
check(S.dialogBind, 'wxml 站内 dialog 绑定 confirm/cancel');
check(S.registered, 'duty/index.json 注册 dialog 组件');
check(S.confirmRoutes, 'onDangerConfirm 按 act 分派');

console.log('\n── ③ 全站裸奔扫描');
check(S.noBare, '无「危险 handler 直接发请求且无确认」的入口' + (S.bare.length ? '：' + S.bare.join(', ') : ''));

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '清空值日直接发请求（绕过确认）', probe: 'handlersOk', file: 'dutyJs',
    from: "  onClear() { this.onDanger({ currentTarget: { dataset: { act: 'clearDuty' } } }); },",
    to: "  onClear() { api.scheduleClear({ week: this.data.week }); }," },
  { name: '撤回演讲发布直接发请求', probe: 'handlersOk', file: 'dutyJs',
    from: "  onSpUnpublish() { this.onDanger({ currentTarget: { dataset: { act: 'unpublishSpeech' } } }); },",
    to: "  onSpUnpublish() { api.speechPublish({ week: this.data.week, status: 'DRAFT' }); }," },
  { name: '删掉清空值日的 DANGER_ACTIONS 条目', probe: 'cfgOk', file: 'dutyJs',
    from: '    clearDuty: {', to: '    _clearDuty: {' },
  { name: '文案删空（用户看不懂后果）', probe: 'textOk', file: 'dutyJs',
    apply: (src) => src.replace(/删除后不可恢复/g, '确定吗') },
  { name: 'wxml 去掉 dialog 绑定', probe: 'dialogBind', file: 'dutyWxml',
    from: 'bind:confirm="onDangerConfirm"', to: 'bind:confirm="noop"' },
  { name: 'json 反注册 dialog', probe: 'registered', file: 'dutyJson',
    from: '"dialog": "../../components/dialog/index",', to: '' },
  { name: '确认回调不分派 act', probe: 'confirmRoutes', file: 'dutyJs',
    from: '    if (cfg && cfg.run) cfg.run(this);', to: '    /* dropped */' }
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

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 危险按钮二次确认检查全部通过'));
process.exit(failed ? 1 : 0);
