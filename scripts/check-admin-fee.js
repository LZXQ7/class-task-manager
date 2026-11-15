#!/usr/bin/env node
/**
 * 离线自检：后台「班费 / 团费」与「请假代登记 / 删除」（2026-11-15 新增）
 * --------------------------------------------------------------------------------
 * 这两块是**直接改生产库**的入口，写错了比小程序里出错更严重，所以单独上门禁。
 *
 * 守的几条硬规则：
 *
 *  ① **余额不落库**。余额 = 总额 − SUM(amount)，运行时算。如果谁改成往表里存余额，
 *     两边（小程序 / 后台）就会各算一套、迟早对不上，而且删记录后余额不会自己回来。
 *     ⇒ 断言源码里没有 `SET balance` / 不往 class_fund 写非 total 的列。
 *
 *  ② **后台删除不删云存储凭证图**。小程序删除会 `cloud.deleteFile` 连带删图，
 *     删完不可恢复（2026-11-15 已真实误删过一次，两张图救不回来）。
 *     后台没有 tcb SDK，也不该删 —— 审计里要保留 fileID 作为证据。
 *     ⇒ 反向断言 mod-fee 里不出现 deleteFile。
 *
 *  ③ **fileID → 公网 URL 的换算必须正确**。存储桶是「所有用户可读」，
 *     所以 `cloud://<env>.<bucket>/<path>` → `https://<bucket>.tcb.qcloud.la/<path>`。
 *     换算写错就是满屏裂图，而且只在真机上才看得出。
 *     ⇒ 真跑 fileUrl() 验算三种输入。
 *
 *  ④ **每个写操作都要写审计**。后台是多人共用账号，没有审计就查不出是谁改的。
 *     ⇒ 断言 saveTotal / addRecord / updateRecord / deleteRecord / removeImage /
 *        createLeave / deleteLeave 里都调了 logAction。
 *
 *  ⑤ **请假代登记必须校验成员属于该班**。否则会给 A 班成员在 B 班记一条请假，
 *     而列表按 member.class_id 过滤 ⇒ 变成「谁都看不见」的幽灵数据。
 *
 *  ⑥ 前端入口齐全：页签、VIEWS 注册、渲染函数、确认文案（删除不可恢复）。
 *
 * 用法：node scripts/check-admin-fee.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const stripHtml = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) failed += 1;
}

const F = {
  fee: 'cloudfunctions/admin-web/lib/mod-fee.js',
  leave: 'cloudfunctions/admin-web/lib/mod-leave.js',
  index: 'cloudfunctions/admin-web/index.js',
  html: 'cloudfunctions/admin-web/public/index.html',
  app: 'cloudfunctions/admin-web/public/app.js',
  css: 'cloudfunctions/admin-web/public/admin.css'
};
const SRC = {};
Object.keys(F).forEach((k) => { SRC[k] = read(F[k]); });

const FEE = stripJs(SRC.fee);
const LEAVE = stripJs(SRC.leave);
const INDEX = stripJs(SRC.index);
const APP = stripJs(SRC.app);
const HTML = stripHtml(SRC.html);

/** 取某个 async function 的方法体（从名字到下一个顶层 async function） */
function bodyOf(src, name) {
  const i = src.indexOf('async function ' + name);
  if (i < 0) return '';
  const rest = src.slice(i + 15);
  const next = rest.search(/\nasync function |\nfunction |\nmodule\.exports/);
  return next < 0 ? rest : rest.slice(0, next);
}

console.log('── ① 余额不落库（= 总额 − 已消费，运行时算）');
check(!/SET\s+balance/i.test(FEE), 'mod-fee 里没有 `SET balance`（余额不入库）');
check(/spent/.test(FEE) && /balance\s*=/.test(FEE), '余额是 getFund 里现算出来的');
check(/ON DUPLICATE KEY UPDATE total = \?/.test(FEE), '总额用 upsert 写 class_fund.total');

console.log('\n── ② 后台删除不碰云存储（小程序才会连带删图）');
check(!/deleteFile/.test(FEE), 'mod-fee 里没有 cloud.deleteFile（凭证图保留）');
check(/imagesKept/.test(FEE), '删除审计里保留了原图 fileID（imagesKept）');

console.log('\n── ③ fileID → 公网 URL 换算（真跑）');
const sandbox = {
  module: { exports: {} }, require: () => ({ getPool: () => ({}), BizError: class {}, logAction: () => {} }),
  console, String, Number, Array, Object, JSON, Date, isFinite, Math, RegExp, Error
};
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);
try {
  vm.runInContext(SRC.fee, sandbox, { filename: 'mod-fee.js' });
} catch (e) {
  console.log('    （vm 加载失败：' + e.message + '）');
}
const fileUrl = sandbox.module.exports && sandbox.module.exports.fileUrl;
if (typeof fileUrl === 'function') {
  const cases = [
    ['cloud://cloudbase-x.636c-cloudbase-x-1306168169/fee/1-0-1.jpg',
      'https://636c-cloudbase-x-1306168169.tcb.qcloud.la/fee/1-0-1.jpg'],
    ['cloud://env-only/fee/a.jpg', 'https://env-only.tcb.qcloud.la/fee/a.jpg'],
    ['', '']
  ];
  cases.forEach(([inp, want]) => {
    const got = fileUrl(inp);
    check(got === want, '「' + (inp || '(空)') + '」→「' + got + '」' + (got === want ? '' : '（应为「' + want + '」）'));
  });
} else {
  check(false, 'mod-fee 没导出 fileUrl（前端拿不到公网 URL ⇒ 满屏裂图）');
}

console.log('\n── ④ 写操作都留审计');
[['saveTotal', FEE], ['addRecord', FEE], ['updateRecord', FEE], ['deleteRecord', FEE], ['removeImage', FEE],
  ['createLeave', LEAVE], ['deleteLeave', LEAVE]].forEach(([n, src]) => {
  const body = bodyOf(src, n);
  check(body.length > 0 && /logAction\(/.test(body), n + ' 里调用了 logAction');
});

console.log('\n── ⑤ 请假代登记校验成员属于该班');
const createBody = bodyOf(LEAVE, 'createLeave');
check(/member\s+WHERE\s+id\s*=\s*\?/i.test(createBody), 'createLeave 回查成员');
check(/!==\s*classId/.test(createBody), 'createLeave 校验 member.class_id === 传入班级');
check(/resyncDutiesForMember/.test(createBody), 'createLeave 后重算值勤「请假」标记');
check(/resyncDutiesForMember/.test(bodyOf(LEAVE, 'deleteLeave')), 'deleteLeave 后重算值勤「请假」标记');

console.log('\n── ⑥ 路由与前端入口');
[
  ['/api/fee', 'GET 班费总览'],
  ['/api/fee/total', 'POST 设置总额'],
  ['/api/fee/record', 'POST 登记消费'],
  ['/api/fee/record/:id', 'POST 修改消费'],
  ['/api/fee/record/:id/delete', 'POST 删除消费'],
  ['/api/fee/record/:id/image/remove', 'POST 移除单张凭证']
].forEach(([p, desc]) => {
  check(INDEX.indexOf(p) >= 0, '路由已注册：' + desc);
});
check(/app\.post\('\/api\/leave',/.test(INDEX), '路由已注册：POST 后台代登记请假');
check(/app\.post\('\/api\/leave\/:id\/delete'/.test(INDEX), '路由已注册：POST 删除请假');

/* 侧栏导航 2026-11-15 起由 renderNav() 按账号权限动态生成，
   不再在 index.html 里写死 <button data-view="fee">，所以断言移到 VIEWS 注册 + renderNav。 */
check(/function renderNav\(/.test(APP) && /data-view="' \+ k \+ '"/.test(APP),
  '侧栏导航按权限动态渲染（含「班费」页签）');
check(/fee:\s*\{\s*title:\s*'班费'[^}]*render:\s*renderFee/.test(APP), 'VIEWS 注册了 fee → renderFee');
check(/function renderFee/.test(APP), '前端有 renderFee');
check(/function openFeeTotalDialog/.test(APP) && /function openFeeRecordDialog/.test(APP), '前端有总额 / 消费 编辑弹层');
check(/不可恢复/.test(APP) && /凭证图片/.test(APP), '删除前的确认文案写明了「不可恢复」与「凭证图片」');
check(/function openLeaveCreateDialog/.test(APP) && /function deleteLeave/.test(APP), '前端有请假「代登记 / 删除」');
check(/lv-add/.test(APP) && /data-del-leave/.test(APP), '请假页工具栏与操作列都接上了新入口');
check(/\.fee-thumb\s*\{/.test(stripJs(SRC.css)), 'admin.css 有凭证缩略图样式');

console.log('\n── ⑦ 变异自证（改坏 → 判据必须翻红）');
const MUT = [
  { name: '把余额改成落库（SET balance）', file: 'fee', probe: () => /SET\s+balance/i.test(stripJs(SRC.fee)),
    from: 'const pool = getPool();', to: 'const pool = getPool(); await pool.query("UPDATE class_fund SET balance = 1");', want: true },
  { name: '后台删除改成连带删凭证图', file: 'fee', probe: () => !/deleteFile/.test(stripJs(SRC.fee)),
    from: 'await pool.query(\'DELETE FROM class_fund_record WHERE id = ?\', [id]);',
    to: 'await pool.query(\'DELETE FROM class_fund_record WHERE id = ?\', [id]); await cloud.deleteFile({ fileList: imgs });', want: false },
  { name: '请假代登记去掉「成员属于本班」校验', file: 'leave', probe: () => /!==\s*classId/.test(stripJs(SRC.leave)),
    from: "if (Number(m[0].class_id) !== classId) throw new BizError(40001, '该成员不属于所选班级');", to: '', want: false },
  { name: '前端删掉 VIEWS 里的 fee 注册', file: 'app', probe: () => /fee:\s*\{\s*title:\s*'班费'[^}]*render:\s*renderFee/.test(stripJs(SRC.app)),
    from: "fee:       { title: '班费',     perm: 'fee',       render: renderFee },", to: '', want: false }
];
MUT.forEach((mu) => {
  const src = SRC[mu.file];
  if (src.indexOf(mu.from) < 0) {
    console.log('  ✗ 变异「' + mu.name + '」锚点没命中');
    failed += 1;
    return;
  }
  const backup = SRC[mu.file];
  SRC[mu.file] = src.replace(mu.from, mu.to);
  const got = mu.probe();
  SRC[mu.file] = backup;
  check(got === mu.want, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '✗ ' + failed + ' 项未通过' : '✓ 后台班费 / 请假管理检查全部通过'));
process.exit(failed ? 1 : 0);
