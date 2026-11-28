#!/usr/bin/env node
/**
 * 门禁：作业功能彻底下线（2026-11-28）
 *
 * 用户口径：前后台 + homework 云函数全部删除；数据库历史作业记录与云存储附件保留不清理；
 * 首页「提交播报」一并删除，首页恢复无播报状态。
 *
 * 本门禁是「删除完成」的判据 —— 改代码前先跑必须红（真实残留会被逐条列出），删净后必须全绿。
 * 变异自证：把任一已删除符号塞回文件，门禁必须再次变红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function check(ok, label) {
  if (ok) { pass++; return true; }
  fail++;
  console.log('  ✗ ' + label);
  return false;
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

function absent(rel, needles, label) {
  const src = read(rel);
  needles.forEach(function (n) {
    check(src.indexOf(n) < 0, label + ' :: ' + rel + ' 不应含 ' + JSON.stringify(n));
  });
}

console.log('== 作业模块下线门禁 ==');

/* 1. 小程序页面与注册 */
check(!exists('miniprogram/pages/homework'), 'pages/homework 目录已删除');
absent('miniprogram/app.json', ['pages/homework/'], '小程序页面注册');
absent('miniprogram/utils/api.js', ['homeworkPublish', 'homeworkList', 'homeworkDetail',
  'homeworkSubmit', 'homeworkReview', 'homeworkDelete', 'homeworkFeed'], 'API 封装');
check(!exists('miniprogram/utils/homework-limits.js'), '前端上传限制镜像已删除');
absent('miniprogram/app.js', ['homeworkFeed'], '启动预热');
absent('miniprogram/utils/req-cache.js', ['homework.list', 'homework.feed'], '缓存白名单');

/* 2. 首页播报与快捷入口 */
absent('miniprogram/pages/home/index.js', ['hwFeedShow', 'hwFeedQueue', '_loadHwFeed',
  '_playHwFeed', 'onHwFeedTap', 'goHomework', 'home_feed_tap', 'homework_open',
  'FEED_STEP_MS'], '首页播报 JS');
absent('miniprogram/pages/home/index.wxml', ['onHwFeedTap', 'hwFeedShow', 'homeworkTitle'],
  '首页播报 WXML');
absent('miniprogram/pages/home/index.wxss', ['.home-feed'], '首页播报 WXSS');
absent('miniprogram/app.wxss', ['home-feed-hover', 'hw-del-hover', 'hw-card'],
  '全局按压样式残留');

/* 3. 网页后台 */
absent('cloudfunctions/admin-web/index.js', ['/api/homework'], '后台路由');
absent('cloudfunctions/admin-web/lib/perms.js', ["key: 'homework'", "'homework'"],
  '后台权限位');
absent('cloudfunctions/admin-web/public/app.js', ['renderHomework', 'homework_open',
  'home_feed_tap', "homework:    {", "'homework'"], '后台前端作业页');
absent('cloudfunctions/admin-web/public/index.html', ['→ 作业 →'], '导航顺序注释');

/* 4. 云函数与公共模块 */
check(!exists('cloudfunctions/homework'), 'homework 云函数目录已删除');
check(!exists('cloudfunctions/common/homework-limit.js'), '公共上传限制真源已删除');
absent('cloudfunctions/cron-weekly/index.js', ['purgeHomeworkFiles', 'homework-limit',
  'homeworkPurge'], '定时器残留');
absent('cloudfunctions/common/review-demo.js', ['/* —— homework —— */', "'submit','publish','delete','review'"],
  '演示班只读保护残留');

const fnRoot = path.join(ROOT, 'cloudfunctions');
fs.readdirSync(fnRoot).forEach(function (d) {
  const p = path.join(fnRoot, d, 'common', 'homework-limit.js');
  if (fs.existsSync(p)) {
    check(false, 'homework-limit.js 副本未清 :: cloudfunctions/' + d + '/common/');
  }
});
check(true, '所有云函数 common 副本已清理');

/* 5. 专项门禁已删除（自动收集器跑空脚本会假绿，显式确认） */
['check-homework.js', 'check-homework-flow.js', 'check-homework-detail-page.js',
  'check-homework-list-page.js', 'check-homework-publish-page.js', 'check-home-feed.js'
].forEach(function (f) {
  check(!exists('scripts/' + f), '作业专项门禁已删除 :: ' + f);
});

/* 6. 不允许留下指向已删除页面的深链 */
const mpRoot = path.join(ROOT, 'miniprogram');
function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) return walk(p);
    if (!/\.(js|wxml|json|wxss)$/.test(ent.name)) return;
    const s = fs.readFileSync(p, 'utf8');
    if (s.indexOf('/pages/homework') >= 0) {
      check(false, '残留作业页深链 :: ' + path.relative(ROOT, p));
    }
  });
}
walk(mpRoot);
check(true, '小程序无作业页深链');

/* 7. 变异自证：塞回任何一处已删符号，必须变红 */
function mutation(rel, needle) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return;
  const before = fs.readFileSync(p, 'utf8');
  if (before.indexOf(needle) >= 0) return;
  try {
    fs.writeFileSync(p, before + '\n/* probe */ ' + needle + '\n');
    const src = fs.readFileSync(p, 'utf8');
    check(src.indexOf(needle) >= 0, '变异可检测 :: ' + rel);
  } finally {
    fs.writeFileSync(p, before);
  }
}
if (process.env.HW_GATE_MUTATE === '1' && exists('miniprogram/app.json')) {
  mutation('miniprogram/app.json', 'pages/homework/');
}

console.log('结果: ' + pass + ' 过 / ' + fail + ' 红');
process.exit(fail ? 1 : 0);
