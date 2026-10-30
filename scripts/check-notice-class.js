#!/usr/bin/env node
/**
 * 门禁：通知「按班级归属分别展示」（2026-10-28 需求）
 * ============================================================
 * 需求原话：「教师端的通知目前只有在 3 班时可以点开……请调整通知逻辑，使通知按班级
 * 归属分别展示和管理，让每位辅导员能够查看其负责的所有班级的通知，并正常点开查看详情，
 * 同时确保切换班级时通知内容随之对应变化。」
 *
 * 改造前的事实：`media.msgList` 只有「我的可见性」一个口径 —— 学生看「发给我的」，
 * 辅导员是 counselorOnly（只看见自己发的）。于是班级信息页切到别班只能把通知卡置灰。
 *
 * 这次是**一条链**，任何一环漏了都以「看起来正常、其实错」的方式坏掉：
 *   ① 后端 resolveViewClassId：谁有资格按班看（超管任意活动班 / 辅导员限 staff_class）
 *   ② msgList 双分支：`? <> 0` 班级视角 vs `? = 0` 原口径（后者一个字节都不许改）
 *   ③ msgRead / msgDelete 与 msgList 同口径（否则「看得见删不掉」）
 *   ④ classinfo 通知支路带 classId + 短名（且不再置灰/拦截）
 *   ⑤ 通知页读 options.classId、按班读写缓存、别班视图不推进未读游标
 *   ⑥ 发布页预选该班（否则在 2601 点「发布」会发到主班 示例班级A —— 界面毫无异常）
 *
 * 静态扫描足够：这里锁的都是「结构性事实」（有没有这个分支 / 这个参数），
 * 不像切班那样需要真跑 data。末尾带**六组变异自证**，每组改坏一处必须翻红。
 *
 * 用法：node scripts/check-notice-class.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  media: 'cloudfunctions/media/index.js',
  ntJs: 'miniprogram/pages/notice/index.js',
  ntWxml: 'miniprogram/pages/notice/index.wxml',
  ciJs: 'miniprogram/pages/classinfo/index.js',
  ciWxml: 'miniprogram/pages/classinfo/index.wxml',
  pubJs: 'miniprogram/pages/notice/publish/index.js',
  utilJs: 'miniprogram/utils/notice.js'
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** 剥 JS 注释（只认 // 与 / * * /，留着 URL 里的 //） */
function stripJs(s) {
  return String(s)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
/** 剥 wxml 注释 —— ⚠️ 必须用它，拿 JS 那套剥会把 <!-- --> 原样留着 */
function stripWxml(s) {
  return String(s).replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * 取两个锚点之间的片段。
 * ⚠️ 必须限定在 msgList 段内做断言：classId 的判定逻辑在 resolveViewClassId /
 *    noticeTouchable 里也有一模一样的行，全文搜会让「msgList 根本没调」这种变异
 *    静默漏网（实测漏过一次，所以有了这个函数）。
 */
function section(src, from, to) {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = src.indexOf(to, i + from.length);
  return j < 0 ? src.slice(i) : src.slice(i, j);
}

/**
 * 全部断言。返回失败明细，供主流程与变异自证共用（自证要求 fail>0）。
 */
function audit(S) {
  const media = stripJs(S.media);
  const ntJs = stripJs(S.ntJs);
  const ntWxml = stripWxml(S.ntWxml);
  const ciJs = stripJs(S.ciJs);
  const ciWxml = stripWxml(S.ciWxml);
  const pubJs = stripJs(S.pubJs);
  const utilJs = stripJs(S.utilJs);

  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };

  /* ---------------- ① 后端：谁有资格按班看 ---------------- */
  ok(/async function resolveViewClassId\(pool, ctx, payload\)/.test(media),
    '后端新增 resolveViewClassId（班级视角的唯一入口）');
  ok(/if \(guard\.isSuper\(me\)\)[\s\S]{0,260}?is_active = 1/.test(media),
    '超管：任意**活动**班级（停用班的历史通知不翻出来）');
  ok(/if \(guard\.isCounselor\(me\)\)[\s\S]{0,260}?guard\.staffClassIds/.test(media),
    '辅导员：限 staff_class 绑定范围（不能看别人的班）');
  ok(/if \(guard\.isCounselor\(me\)\)[\s\S]{0,300}?return ids\.includes\(wants\) \? wants : 0;[\s\S]{0,140}?return 0;/.test(media),
    '普通成员 / 学生班委：恒回落 0（没有跨班视角，传别班也只看本班）');

  /* ---------------- ② msgList 双分支 ---------------- */
  const listSeg = section(media, 'msgList: {', 'msgDelete: {');
  ok(!!listSeg, '解析到 msgList 段（解析不到直接判失败，防止判据空转）');
  ok(/resolveViewClassId\(pool, ctx, payload\)/.test(listSeg),
    'msgList 真的调了 resolveViewClassId');
  ok(/\? <> 0 AND \(/.test(listSeg), 'msgList 有「班级视角」分支（? <> 0）');
  ok(/\? = 0 AND \(/.test(listSeg), 'msgList 保留原「我可见的」分支（? = 0，老口径不动）');
  ok(/tm\.class_id = \?/.test(listSeg),
    '非 ALL 通知按「目标成员所在班」归属（否则班委/职位通知在别班视图里永远看不到）');
  ok(/n\.scope <> 'ALL' AND EXISTS/.test(listSeg), '班级视角对 COMMITTEE/POSITION/PICK 也成立');

  /* ---------------- ③ 读写单条：同口径 ---------------- */
  ok(/async function noticeTouchable\(pool, ctx, payload, noticeId\)/.test(media),
    'msgRead / msgDelete 共用 noticeTouchable（消灭双份可见性 SQL）');
  ok((media.match(/noticeTouchable\(/g) || []).length >= 3,
    '两处调用点都真的用了它（定义 1 + 调用 ≥2）');
  ok(/canAck: !!r\.need_ack && !isPublisher && !r\.acked && forMe/.test(media),
    '后端算 canAck（按班管理时看到的别班通知不给「确认收到」按钮）');
  ok(/canSeeAck = \(r\.publisher_id === me\.id\) \|\| isSuper \|\| viewClassId > 0/.test(media),
    '按班管理时能看该班回执（管理端要能催人）');

  /* ---------------- ④ 班级信息页 ---------------- */
  ok(/if \(key === 'notice'\) \{/.test(ciJs), 'classinfo：通知走独立支路（本班也带 classId）');
  ok(/&name=' \+ encodeURIComponent\(hit\.short\)/.test(ciJs), '通知 URL 带短名（导航标题用）');
  ok(!/通知仅显示本人班级/.test(ciJs + ciWxml), '不再弹「通知仅显示本人班级」');
  ok(!/ci-item-off/.test(ciWxml), '通知卡不再随切班置灰');
  ok(/const m = \/\\d\{4\}\\s\*班\/\.exec\(name\)/.test(ciJs), '短名取自班名的「示例班级C」段');

  /* ---------------- ⑤ 通知页 ---------------- */
  ok(/const vc = Number\(q\.classId\) \|\| 0/.test(ntJs), '通知页读 options.classId');
  ok(/api\.msgList\(vc \? \{ classId: vc \} : \{\}/.test(ntJs),
    '请求带 classId；不带时仍是空对象（普通成员 / 老入口零影响）');
  ok(/notice\.write\(list, vc\)/.test(ntJs), '按班写缓存（不污染全局槽）');
  ok(/notice\.read\(0, vc\)/.test(ntJs), '按班读缓存（不会先闪一下别班通知）');
  ok(/_shouldAdvanceSeen\(\)[\s\S]{0,320}?vc === \(Number\(p\.classId\) \|\| 0\)/.test(ntJs),
    '别班视图不推进未读游标（否则红点被别班通知吞掉）');
  ok(/_noticeArg\(id\)[\s\S]{0,220}?arg\.classId = this\._viewClassId/.test(ntJs),
    '确认 / 删除带 classId（否则「列表看得见、点删除报无权」）');
  ok(/navTitle: vn \? vn \+ ' · 通知' : '通知'/.test(ntJs), '导航标题显示当前班');
  ok(/item\.canAck !== false/.test(ntWxml), '确认按钮认 canAck，字段缺失时回退老条件');

  /* ---------------- ⑥ utils/notice 分槽缓存 ---------------- */
  ok(/function slotOf\(classId, create\)/.test(utilJs), '缓存按班级分槽');
  ok(/s\.byClass\[key\] = \{ list: null, at: 0 \}/.test(utilJs), '槽结构 { list, at }');
  ok(/function write\(rawList, classId\) \{[\s\S]{0,90}?slotOf\(classId, true\)/.test(utilJs),
    'write 接受 classId 并写对应槽');
  ok(/function read\(maxAgeMs, classId\) \{[\s\S]{0,90}?slotOf\(classId, false\)/.test(utilJs),
    'read 接受 classId 并读对应槽');
  ok(/function eachSlot/.test(utilJs), 'patchAcked / removeFromCache 遍历所有槽');
  ok(/s\.byClass = \{\};/.test(utilJs), 'invalidate 清所有槽（发完通知别班列表也要失效）');

  /* ---------------- ⑦ 发布预选 ---------------- */
  ok(/this\._presetClassId = Number\(options && options\.classId\) \|\| 0/.test(pubJs),
    '发布页读预选班');
  ok(/noticeClassIds: \[preset \|\| myClassId\]/.test(pubJs),
    '默认发送班级 = 预选班（否则在 2601 点发布会发到 示例班级A）');
  ok(/noticeShowClasses: isCounselor \|\| !!preset/.test(pubJs),
    '带预选班进来时超管也能改「发送班级」');

  return fails;
}

/* ---------------- 主流程 ---------------- */
const S = {};
Object.keys(FILES).forEach((k) => { S[k] = read(FILES[k]); });

console.log('通知按班级归属展示 —— 门禁\n');
const fails = audit(S);
if (fails.length) {
  fails.forEach((m) => console.log('  ✗ ' + m));
} else {
  console.log('  ✓ 结构断言全部成立（后端班级视角 / 前端传参 / 缓存分槽 / 发布预选）');
}

/* ---------------- 变异自证（内存字符串，绝不写盘） ---------------- */
const MUTANTS = [
  {
    name: 'msgList 不调 resolveViewClassId（谁来都能按班看）',
    file: 'media',
    /* 锚点必须带上下一行：`const viewClassId = await resolveViewClassId(...)`
     * 在 noticeTouchable 里也有一份（缩进不同、更靠前），只拿这一行做锚点会
     * 改到 helper 上 —— 变异「假通过」。 */
    from: 'const viewClassId = await resolveViewClassId(pool, ctx, payload);\n      const [rows] = await pool.query(',
    to: 'const viewClassId = Number(payload.classId) || 0;\n      const [rows] = await pool.query('
  },
  {
    name: '去掉班级视角分支（切班后看到的还是「发给我的」）',
    file: 'media',
    from: '            (? <> 0 AND (',
    to: '            (0 AND ('
  },
  {
    name: 'msgDelete 自己再写一套可见性（双份 SQL 漂移）',
    file: 'media',
    from: "if (!(await noticeTouchable(pool, ctx, payload, noticeId))) throw new BizError(41001, '通知不存在或无权删除');",
    to: "const [vis] = await pool.query('SELECT 1'); if (!vis.length) throw new BizError(41001, '通知不存在或无权删除');"
  },
  {
    name: '通知页请求不带 classId（切了班内容不变）',
    file: 'ntJs',
    from: 'api.msgList(vc ? { classId: vc } : {}, { toast: false })',
    to: 'api.msgList({}, { toast: false })'
  },
  {
    name: 'read 忽略 classId（拿全局缓存顶，闪别班通知）',
    file: 'utilJs',
    from: 'const s = slotOf(classId, false);',
    to: 'const s = slot();'
  },
  {
    name: '发布页不用预选班（在 2601 发布会发到 示例班级A）',
    file: 'pubJs',
    from: 'noticeClassIds: [preset || myClassId]',
    to: 'noticeClassIds: [myClassId]'
  },
  {
    name: 'classinfo 通知支路丢掉短名（标题看不出在看哪个班）',
    file: 'ciJs',
    from: "if (hit && hit.short) url += '&name=' + encodeURIComponent(hit.short);",
    to: 'if (hit && hit.short) url += "";'
  }
];

console.log('\n变异自证（每组改坏一处，必须翻红）');
let caught = 0;
MUTANTS.forEach((m) => {
  const copy = Object.assign({}, S);
  if (copy[m.file].indexOf(m.from) < 0) {
    console.log('  ✗ 变异样本没命中源码（替换串对不上）：' + m.name);
    fails.push('mutant anchor missing: ' + m.name);
    return;
  }
  copy[m.file] = copy[m.file].replace(m.from, m.to);
  const f = audit(copy);
  if (f.length) { caught++; console.log('  ✓ 抓住 → ' + m.name + '（翻红 ' + f.length + ' 项）'); }
  else { console.log('  ✗ 漏网 → ' + m.name + '（改坏了却全绿，说明这条判据是空跑）'); fails.push('mutant survived: ' + m.name); }
});

console.log('\n' + (fails.length ? '❌ 失败 ' + fails.length + ' 项' : '✅ 通知按班级归属展示 —— 全部通过（' + caught + '/' + MUTANTS.length + ' 组变异被抓住）'));
process.exit(fails.length ? 1 : 0);
