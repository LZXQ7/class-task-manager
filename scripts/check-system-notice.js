#!/usr/bin/env node
/**
 * 门禁：系统事件通知（班费消费 / 请假审批 / 信息页入口）
 * ================================================================
 * 用户口径：
 *   ① 班费登记新消费后写通知；普通成员只看到「新增一笔消费」（无金额），
 *      有班费管理/明细权限者另收含金额与类型的通知（双记录分层）；
 *   ② 请假审批结果通知申请人本人——谁申请、谁收到，不扩散给班委；
 *   ③ 信息页恢复通知入口，本班也带 classId，通知页导航标题用短班名。
 *
 * 用法：node scripts/check-system-notice.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(p, 'utf8');
const stripJs = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripHtml = t => t.replace(/<!--[\s\S]*?-->/g, '');

const SRC = {
  fee: read(path.join(ROOT, 'cloudfunctions/fee/index.js')),
  adjust: read(path.join(ROOT, 'cloudfunctions/adjust/index.js')),
  ciJs: read(path.join(ROOT, 'miniprogram/pages/classinfo/index.js')),
  ciWxml: read(path.join(ROOT, 'miniprogram/pages/classinfo/index.wxml'))
};

function buildProbes(S) {
  const fee = stripJs(S.fee);
  const adjust = stripJs(S.adjust);
  const ciJs = stripJs(S.ciJs);
  const ciWxml = stripHtml(S.ciWxml);
  const p = {};
  p.feeHelper = /async function notifyFeeExpense/.test(fee) &&
    /systemNotice\.writeNotice\(pool/.test(fee) &&
    /await notifyFeeExpense\(pool, ctx, type, amount, note\)/.test(fee);
  p.feeLayered = /scope:\s*'ALL'/.test(fee) &&
    /新增了一笔/.test(fee) &&
    /scope:\s*'PICK'/.test(fee) &&
    /feeManager\(type, m\)/.test(fee) &&
    /¥' \+ amount/.test(fee) &&
    /m\.id !== me\.id/.test(fee);
  p.leaveApprove = /title:\s*'请假已通过'/.test(adjust) &&
    /title:\s*'请假未通过'/.test(adjust) &&
    (adjust.match(/memberIds:\s*\[memberId\]/g) || []).length >= 2;
  p.classinfoEntry = /if \(key === 'notice'\) \{/.test(ciJs) &&
    /&name=' \+ encodeURIComponent\(hit\.short\)/.test(ciJs) &&
    /data-key="notice"/.test(ciWxml) &&
    /通知/.test(ciWxml) &&
    !/ci-item-off/.test(ciWxml) &&
    /noticeUnacked/.test(ciJs) && /noticeUnacked/.test(ciWxml);
  return p;
}

const PROBES = buildProbes(SRC);
let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));

console.log('── ① 系统事件通知契约');
Object.keys(PROBES).forEach(k => check(PROBES[k], '契约 ' + k));

console.log('── ② 变异自证');
function mutate(src, from, to) {
  if (src.indexOf(from) < 0) return null;
  return src.split(from).join(to);
}
const mutants = [
  {
    name: '班费消费不再写通知', expect: 'feeHelper', key: 'fee',
    build: () => mutate(SRC.fee, 'await notifyFeeExpense(pool, ctx, type, amount, note);', '')
  },
  {
    name: '普通成员通知里露出金额（分层失效）', expect: 'feeLayered', key: 'fee',
    build: () => mutate(SRC.fee, "'新增了一笔'", "'新增金额¥'")
  },
  {
    name: '请假审批不再通知申请人', expect: 'leaveApprove', key: 'adjust',
    build: () => mutate(SRC.adjust, "title: '请假已通过'", "title: '审批已记录'")
  },
  {
    name: '信息页通知入口被删', expect: 'classinfoEntry', key: 'ciWxml',
    build: () => mutate(SRC.ciWxml, 'data-key="notice"', 'data-key="noticeOff"')
  },
  {
    name: '信息页通知不再带短班名（导航标题回退全名）', expect: 'classinfoEntry', key: 'ciJs',
    build: () => mutate(SRC.ciJs, "'&name=' + encodeURIComponent(hit.short)", "''")
  }
];

mutants.forEach(mt => {
  const badSrc = mt.build();
  if (badSrc === null) { bad('变异锚点没命中源码：' + mt.name); return; }
  const next = Object.assign({}, SRC);
  next[mt.key] = badSrc;
  const r = buildProbes(next);
  check(r[mt.expect] === false, '变异被抓：' + mt.name);
});

console.log(failed === 0
  ? '\nOK · 系统事件通知（班费分层 / 请假本人 / 信息页入口）门禁通过'
  : '\nFAIL · 系统事件通知门禁 ' + failed + ' 项未通过');
process.exit(failed === 0 ? 0 : 1);
