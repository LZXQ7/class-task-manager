#!/usr/bin/env node
/**
 * 离线自检：演讲排班页 + 更多页入口 + 课前演讲点人名动作菜单（1.0.8.67）
 * --------------------------------------------------------------------------------
 * 用户四条诉求中的 ③④：
 *   ③ 更多页「手动排班」→「值日排班」，黄色标签「排班」→「手动」，下方新增「演讲排班」入口；
 *   ④ 课前演讲页点人名 → 取消 / 换人；新增演讲排班页 → 增加 / 取消 / 修改排班。
 *
 * 判据（真扫源码 + 变异自证）：
 *   ① 更多页文案 + 新入口（canSpeech 显隐 + goSpeech 跳 pages/speech）；
 *   ② 演讲排班页存在且注册：speechBoard 读 + speechAdd/Remove/Reassign/Publish 写；
 *   ③ 课前演讲页点人名先弹站内动作菜单（取消 / 换人），走 speechRemove / 换人弹层；
 *   ④ app.json 注册 pages/speech/index。
 *
 * 用法：node scripts/check-speech-board-page.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const stripXml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  mineW: 'miniprogram/pages/mine/index.wxml',
  mineJ: 'miniprogram/pages/mine/index.js',
  dutyW: 'miniprogram/pages/duty/index.wxml',
  dutyJ: 'miniprogram/pages/duty/index.js',
  speechW: 'miniprogram/pages/speech/index.wxml',
  speechJ: 'miniprogram/pages/speech/index.js',
  appJson: 'miniprogram/app.json'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = exists(F[k]) ? read(F[k]) : ''; });

function evalAll(s) {
  const mw = stripXml(s.mineW);
  const dw = stripXml(s.dutyW);
  const sw = stripXml(s.speechW);
  const aj = s.appJson;

  /* ③ 更多页文案 + 新入口 */
  const mineValueDuty = /<text class="mn-row-text">值日排班<\/text>/.test(mw);
  const mineTagManual = /bindtap="onMoreManual"[\s\S]{0,200}?<view class="mn-mini-tag super">手动<\/view>/.test(mw);
  const mineSpeechEntry = /bindtap="onMoreSpeech"[\s\S]{0,200}?<text class="mn-row-text">演讲排班<\/text>/.test(mw)
    && /wx:if="\{\{canSpeech\}\}"[^>]*bindtap="onMoreSpeech"/.test(mw);
  const mineGoSpeech = /goSpeech\(\)\s*\{/.test(s.mineJ)
    && /url: '\/pages\/speech\/index'/.test(s.mineJ)
    && /app\.canSpeech && app\.canSpeech\(\)/.test(s.mineJ);
  const mineCanSpeechData = /canSpeech:\s*false/.test(s.mineJ)
    && /canSpeech:\s*!!\(app(?:\s*&&\s*app)?\.canSpeech && app\.canSpeech\(\)\)/.test(s.mineJ);

  /* ④ 课前演讲点人名动作菜单 */
  const dutyActionData = /spActionShow:\s*false/.test(s.dutyJ) && /spActionTarget:\s*null/.test(s.dutyJ);
  const dutyTapOpensAction = /onSpSwapTap\(e\)[\s\S]{0,220}?spActionShow:\s*true/.test(s.dutyJ);
  const dutyActionMethods = /onSpActionRemove\(\)[\s\S]{0,320}?api\.speechRemove\(/.test(s.dutyJ)
    && /onSpActionReassign\(\)[\s\S]{0,200}?spSwapShow:\s*true/.test(s.dutyJ);
  const dutyActionSheetW = /show="\{\{spActionShow\}\}"[\s\S]{0,600}?onSpActionReassign/.test(dw)
    && /bindtap="onSpActionRemove"/.test(dw);
  /* 只看真实调用，剥掉注释（注释里解释「不用 showActionSheet」不该判死） */
  const dutyJsNoComment = s.dutyJ.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const dutyNoNativeSheet = !/wx\.showActionSheet\s*\(/.test(dutyJsNoComment);

  /* 演讲排班页：读写接口 */
  const spReadBoard = /api\.speechBoard\(/.test(s.speechJ);
  const spWrites = /api\.speechAdd\(/.test(s.speechJ) && /api\.speechRemove\(/.test(s.speechJ)
    && /api\.speechReassign\(/.test(s.speechJ) && /api\.speechPublish\(/.test(s.speechJ);
  const spAddRemove = /onAdd\(/.test(s.speechJ) && /_removeSpeech\(/.test(s.speechJ);
  const spWxmlOps = /bindtap="onAdd"/.test(sw) && /bindtap="onMemberTap"/.test(sw)
    && /bindtap="onPublish"/.test(sw) && /bindtap="onUnpublish"/.test(sw);
  const registered = /"pages\/speech\/index"/.test(aj);

  return {
    mineValueDuty, mineTagManual, mineSpeechEntry, mineGoSpeech, mineCanSpeechData,
    dutyActionData, dutyTapOpensAction, dutyActionMethods, dutyActionSheetW, dutyNoNativeSheet,
    spReadBoard, spWrites, spAddRemove, spWxmlOps, registered
  };
}

const S = evalAll(SRC);

console.log('── ① 更多页文案与演讲排班入口');
check(S.mineValueDuty, '「手动排班」文案已改为「值日排班」');
check(S.mineTagManual, '黄色小标签「排班」已改为「手动」');
check(S.mineSpeechEntry, '新增「演讲排班」入口，按 canSpeech 显隐');
check(S.mineGoSpeech, 'goSpeech() 跳 /pages/speech/index，判 app.canSpeech()');
check(S.mineCanSpeechData, 'mine.js 有 canSpeech data 位且多处补算');

console.log('\n── ② 课前演讲点人名：动作菜单（取消 / 换人）');
check(S.dutyActionData, 'duty.js 有 spActionShow / spActionTarget 状态');
check(S.dutyTapOpensAction, '点人名先弹动作菜单（onSpSwapTap → spActionShow=true）');
check(S.dutyActionMethods, '取消走 api.speechRemove；换人重开换人名册');
check(S.dutyActionSheetW, '动作菜单弹层有「换人 / 取消该场」两项');
check(S.dutyNoNativeSheet, 'duty.js 未引入原生 showActionSheet（守深色）');

console.log('\n── ③ 演讲排班页读写与注册');
check(S.spReadBoard, '演讲排班页用 api.speechBoard 读全部场次（含空场）');
check(S.spWrites, '写操作接 speechAdd / speechRemove / speechReassign / speechPublish');
check(S.spAddRemove, '有 onAdd / _removeSpeech 增删处理');
check(S.spWxmlOps, '页面有添加 / 成员 / 发布 / 撤回按钮');
check(S.registered, 'app.json 注册 pages/speech/index');

console.log('\n── ④ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '更多页文案退回「手动排班」', probe: 'mineValueDuty', file: 'mineW',
    from: '<text class="mn-row-text">值日排班</text>', to: '<text class="mn-row-text">手动排班</text>' },
  { name: '演讲排班入口按 canSchedule 显隐（学习委员看不到）', probe: 'mineSpeechEntry', file: 'mineW',
    from: 'wx:if="{{canSpeech}}" class="mn-row" hover-class="tap-hover" hover-start-time="0" hover-stay-time="60" bindtap="onMoreSpeech"',
    to: 'class="mn-row" hover-class="tap-hover" hover-start-time="0" hover-stay-time="60" bindtap="onMoreSpeech"' },
  { name: '点人名退回直接换人（跳过动作菜单）', probe: 'dutyTapOpensAction', file: 'dutyJ',
    from: 'this.setData({ spActionShow: true, spActionTarget: { id: d.id, name: d.name } });',
    to: 'this.setData({ spSwapShow: true, spSwapTarget: { id: d.id, name: d.name } });' },
  { name: '取消演讲改成原生 showActionSheet', probe: 'dutyNoNativeSheet', file: 'dutyJ',
    from: 'onSpActionRemove() {', to: 'onSpActionRemove() { wx.showActionSheet({itemList:[]});' },
  { name: '演讲排班页去掉 speechBoard（列不出空场次）', probe: 'spReadBoard', file: 'speechJ',
    from: 'api.speechBoard({ week: this.data.week }', to: 'api.speechList({ week: this.data.week }' },
  { name: '演讲排班页去掉 speechAdd（无法加人）', probe: 'spWrites', file: 'speechJ',
    from: 'api.speechAdd({ week: this.data.week, sessionId: session.sessionId, memberId })',
    to: 'Promise.resolve()' },
  { name: 'app.json 删掉演讲排班页注册', probe: 'registered', file: 'appJson',
    from: '"pages/speech/index",\n    ', to: '' }
];

MUT.forEach((mu) => {
  const src = SRC[mu.file];
  if (src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const nextSrc = src.replace(mu.from, mu.to);
  if (nextSrc === src) {
    console.log('  ✗ 变异「' + mu.name + '」未改变源码');
    failed += 1;
    return;
  }
  const next = Object.assign({}, SRC, { [mu.file]: nextSrc });
  check(evalAll(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 演讲排班页 / 更多页入口 / 点人名菜单检查全部通过'));
process.exit(failed ? 1 : 0);
