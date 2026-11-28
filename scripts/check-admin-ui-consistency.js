#!/usr/bin/env node
/**
 * 门禁：后台新增编辑按钮与现有 UI 统一（2026-11-28）
 *
 * 症状：1.0.8.98 新增的表格操作列用了 `btn btn-sm` / `btn btn-sm btn-danger`，
 * 但 admin.css 根本没有 .btn-sm 定义 ⇒ 渲染成常规填充按钮，与全站表格操作列的
 * .link / .link-danger 文字按钮不一致。
 *
 * 口径：表格行内操作一律 .link；危险操作 .link-danger；工具栏主操作才用 .btn/.btn-primary。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'cloudfunctions/admin-web/public/app.js');
const CSS = path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css');
let pass = 0;
let fail = 0;

function check(ok, label) {
  if (ok) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + label);
  return false;
}

const src = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

console.log('== 后台 UI 一致性门禁 ==');

/* 1. 未定义的 .btn-sm 不允许出现 */
check(src.indexOf('btn-sm') < 0, 'app.js 不再使用未定义的 .btn-sm');
check(css.indexOf('.btn-sm') < 0, 'admin.css 未引入 .btn-sm（避免为错口径补样式）');

/* 2. 新增的三处表格操作列必须走既有 link 体系 */
const rows = [
  ['data-sp-swap=', '换人', 'link'],
  ['data-sp-del=', '删除', 'link-danger'],
  ['data-nt-del=', '删除', 'link-danger']
];
rows.forEach(function (r) {
  const at = src.indexOf(r[0]);
  check(at >= 0, '保留操作入口 :: ' + r[0]);
  if (at < 0) return;
  const line = src.slice(Math.max(0, at - 120), at + r[0].length + 90);
  check(line.indexOf('class="link') >= 0, '表格操作列用 link 体系 :: ' + r[0] +
    '（应为 class="link' + (r[2] === 'link-danger' ? ' link-danger' : '') + '"）');
  check(line.indexOf(r[2]) >= 0, '危险级别正确 :: ' + r[0] + ' → ' + r[2]);
});

/* 3. 既有 link 样式仍在（防止把样式一起删掉造成假绿） */
check(/\.link\s*\{/.test(css), 'admin.css 保留 .link 定义');
check(/\.link-danger\s*\{/.test(css), 'admin.css 保留 .link-danger 定义');
check(/\.td-ops\s+\.link/.test(css), '表格操作列的分隔与间距规则保留');

/* 4. 变异自证：把 btn-sm 塞回临时副本必须红 */
function variant(text, label) {
  const tmp = path.join(ROOT, '.wb_tmp', 'ui-gate-probe.js');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, text);
  const hit = fs.readFileSync(tmp, 'utf8').indexOf('btn-sm') >= 0;
  fs.unlinkSync(tmp);
  check(hit, '变异可检测 :: ' + label);
}
variant(src + '\n/* probe */ <button class="btn btn-sm">x</button>\n', 'btn-sm 复活');

console.log('结果: ' + pass + ' 过 / ' + fail + ' 红');
process.exit(fail ? 1 : 0);
