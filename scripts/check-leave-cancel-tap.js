#!/usr/bin/env node
/**
 * 离线自检：请假「撤销」必须**点一下就有反应**（2026-11-17 立规）
 * --------------------------------------------------------------------------------
 * 事故现场（用户原话「请假撤销点了没用」）：
 *
 *   1.0.9.0 把撤销改成 `<hold-confirm bare id="{{item.leaveId}}">` 长按 700ms，
 *   业务主键走**组件属性 `id`** 回传。但微信官方文档《组件属性》明确写着：
 *
 *     「id class style slot 是 WXML 保留属性，虽然可以设为组件属性，
 *       但**无法在 WXML 中对它们赋值**」
 *
 *   ⇒ 父级传的 `id="{{item.leaveId}}"` 永远进不去 properties，组件里
 *     `this.properties.id === ''`，confirm 事件回传 `{ id: '' }`，
 *     页面 `Number('') = 0` → `if (!leaveId) return;` → **长按走满也不撤销**。
 *     现象就是「点了（按了）没用」，而且日志里连一条失败都没有（静默 return）。
 *
 *   顺带还有第二个缺陷：`.hc-btn { overflow: hidden }` 没在 bare 模式复位，
 *   `::after` 进度条画在 `bottom: -6rpx` 被裁掉 ⇒ 按住时**零反馈**，
 *   用户更确信「按钮是坏的」。
 *
 * 定规：
 *   ① 撤销 = 点一下 → confirmStrict 二次确认 → api.leaveCancel（撤销会恢复值日，
 *      属危险操作，确认这一步不能省；但**触发必须是 tap，不能靠长按**）；
 *   ② 业务 id 只走 `data-id`（页面自己的 dataset）+ 事件，不经组件属性；
 *   ③ 任何组件都**不要**声明名为 `id` 的 property —— 那是 WXML 保留属性，
 *      父级赋值静默失效，是最难查的一类 bug（无报错、无日志）。
 *
 * 用法：node scripts/check-leave-cancel-tap.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  wxml: 'miniprogram/pages/roster/index.wxml',
  js: 'miniprogram/pages/roster/index.js',
  json: 'miniprogram/pages/roster/index.json',
  hold: 'miniprogram/components/hold-confirm/index.js'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

/** 全站自有组件的 js（用于「禁止 property 名为 id」这条全局判据） */
const COMP_DIR = path.join(ROOT, 'miniprogram/components');
const COMP_JS = fs.readdirSync(COMP_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(COMP_DIR, d.name, 'index.js')))
  .map((d) => ({ name: d.name, file: 'miniprogram/components/' + d.name + '/index.js' }));

/* 组件源码也进 SRC（键 = `comp:<名字>`）：变异自证要能改组件、判据必须跟着读改后的副本，
   否则 evalAll 直接读盘 ⇒ 变异改了内存里的字符串而判据仍看原文件 →「变异没生效却假通过」。 */
COMP_JS.forEach((c) => { SRC['comp:' + c.name] = read(c.file); });

/** 取对象字面量块（从 `key: {` 起配对花括号），用于只扫 properties 内部 */
function blockAt(src, key) {
  const i = src.indexOf(key + ': {');
  if (i < 0) return '';
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k += 1) {
    if (src[k] === '{') d += 1;
    else if (src[k] === '}') {
      d -= 1;
      if (!d) return src.slice(i, k + 1);
    }
  }
  return src.slice(i);
}

/** 取页面方法体（从 `name(` 到下一个同缩进顶层方法） */
function methodBody(js, name) {
  const i = js.indexOf(name + '(');
  if (i < 0) return '';
  const rest = js.slice(i);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z_$][\w$]*\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** 纯函数契约评估（变异自证复用） */
function evalAll(s) {
  const w = stripXml(s.wxml);
  const j = stripJs(s.js);

  /* ① A/B 两组名单的撤销都必须是 tap 入口，且自己带 data-id */
  const tapTags = w.match(/<view[^>]*bindtap="onLeaveCancelTap"[^>]*>/g) || [];
  const tapHasId = tapTags.filter((t) => /data-id="\{\{item\.leaveId\}\}"/.test(t));

  /* ③ 撤销链路：confirmStrict 二次确认 → api.leaveCancel */
  const body = methodBody(j, 'onLeaveCancelTap');

  /* ⑥ 组件层雷区：任何组件 properties 里都不许出现 id 键 */
  const idPropComps = COMP_JS.filter((c) => {
    const src = stripJs(s['comp:' + c.name] || '');
    return /(^|[\s{,])id\s*:\s*\{\s*type\s*:/.test(blockAt(src, 'properties'));
  });

  return {
    /* 今日名单（A/B 两组）各一个撤销入口，都是 tap */
    tapEntry: tapTags.length === 2,
    /* 业务 id 走 data-id，绝不靠组件属性 */
    tapHasId: tapHasId.length === 2,
    /* 点击有按压反馈（不然「点了没反应」的手感依旧） */
    tapPress: tapTags.length === 2
      && tapTags.every((t) => /hover-class="press-shrink"/.test(t)),
    /* 反向：名单里不许再出现长按确认组件 */
    noHoldWrap: !/<hold-confirm[\s>]/.test(w),
    /* 二次确认不能省（撤销会恢复值日，属危险操作） */
    confirmsFirst: /util\.confirmStrict\s*\(/.test(body),
    /* 真正撤销只在这里发生 */
    cancelInBody: /api\.leaveCancel\s*\(/.test(body),
    /* 全站只有一条撤销链路（多一条就是两套逻辑各说各话） */
    singlePath: (j.match(/api\.leaveCancel\s*\(/g) || []).length === 1
      && j.indexOf('onLeaveCancelHold') < 0,
    /* 撤销成功后两个列表都要刷新（今日名单 + 历史） */
    refreshBoth: /_loadLeaveBoard\s*\(/.test(body) && /_loadLeaveHistory\s*\(/.test(body),
    /* 组件里 id / class / style / slot 都不能当 property */
    compNoIdProp: idPropComps.length === 0,
    idPropComps: idPropComps.map((c) => c.name)
  };
}

const S = evalAll(SRC);

console.log('── ① 撤销入口 = 点一下（A/B 两组各一个）');
check(S.tapEntry, '今日名单 A/B 两组的「撤销」都绑 bindtap="onLeaveCancelTap"（各 1 处，共 2 处）');
check(S.tapHasId, '两处撤销都自带 data-id="{{item.leaveId}}"（业务 id 走 dataset，不经组件属性）');
check(S.tapPress, '两处撤销都有 hover-class="press-shrink" 按压反馈');
check(S.noHoldWrap, '名单里没有 <hold-confirm>（长按确认已按事故移除）');

console.log('\n── ② 撤销链路 = 二次确认 → 真撤销 → 刷新');
check(S.confirmsFirst, 'onLeaveCancelTap 先走 util.confirmStrict 二次确认（撤销会恢复值日，不能一点就删）');
check(S.cancelInBody, 'api.leaveCancel 出现在 onLeaveCancelTap 内');
check(S.refreshBoth, '撤销成功后同时刷新今日名单与历史（_loadLeaveBoard + _loadLeaveHistory）');
check(S.singlePath, '全站只有一条撤销链路（没有残留的 onLeaveCancelHold / 第二处 leaveCancel）');

console.log('\n── ③ 组件层：禁止把 id 当 property（WXML 保留属性，父级赋值静默失效）');
check(S.compNoIdProp, '没有组件声明 id 属性' + (S.compNoIdProp ? '' : '（违规：' + S.idPropComps.join(', ') + '）'));

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '撤销改回 hold-confirm 长按包裹', probe: 'tapEntry', file: 'wxml',
    from: '<view hover-class="press-shrink" hover-start-time="0" hover-stay-time="60" data-pressable\n              class="lv-cancel {{leaveBusy ? \'busy\' : \'\'}}"\n              data-id="{{item.leaveId}}"\n              bindtap="onLeaveCancelTap"\n            >撤销</view>',
    to: '<hold-confirm bare id="{{item.leaveId}}" bind:confirm="onLeaveCancelHold">\n              <view class="lv-cancel">撤销</view>\n            </hold-confirm>' },
  { name: '撤销按钮丢掉 data-id', probe: 'tapHasId', file: 'wxml',
    from: 'data-id="{{item.leaveId}}"\n              bindtap="onLeaveCancelTap"',
    to: 'bindtap="onLeaveCancelTap"' },
  /* ⚠️ 必须**只改 onLeaveCancelTap 方法体内**那一处：roster 页其它方法（删成员等）
     也在用 util.confirmStrict，全局 replace 首个会把变异打偏 → 假通过。 */
  { name: '去掉二次确认（点了直接就撤销）', probe: 'confirmsFirst', file: 'js',
    apply: (src) => {
      const i = src.indexOf('onLeaveCancelTap(');
      if (i < 0) return src;
      const k = src.indexOf('util.confirmStrict(', i);
      if (k < 0) return src;
      return src.slice(0, k) + 'util.noConfirm(' + src.slice(k + 'util.confirmStrict('.length);
    } },
  { name: '又加回一条 onLeaveCancelHold 旧链路', probe: 'singlePath', file: 'js',
    from: 'onLeaveCancelTap(e) {',
    to: 'onLeaveCancelHold(e) {}\n  onLeaveCancelTap(e) {' },
  { name: '组件又把业务主键写成 id 属性', probe: 'compNoIdProp', file: 'comp:hold-confirm',
    from: 'properties: {\n    label:',
    to: 'properties: {\n    id: { type: String, value: \'\' },\n    label:' }
];

MUT.forEach((mu) => {
  const file = mu.file || 'js';
  const src = SRC[file];
  if (!mu.apply && src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [file]: mu.apply ? mu.apply(src) : src.replace(mu.from, mu.to) });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 请假撤销「点一下就生效」检查全部通过'));
process.exit(failed ? 1 : 0);
