/**
 * 门禁：首页「关注的学生」就地弹成员详情卡（1.0.8.32）
 * ============================================================
 * 用户口径：「点击学生直接弹出这个卡片，而不是跳转到成员与分组再弹出」；
 * 「上面也不用这个小横线和叉号了，直接点击空白处就可以关掉，要有退出动画」。
 *
 * 钉死四件事：① 不跳页 ② 卡片无 grabber / 无叉号且点遮罩可关
 * ③ 滚动锁覆盖新弹层 ④ 写操作后通知首页刷新关注列表。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const F = {
  homeJs: 'miniprogram/pages/home/index.js',
  homeWxml: 'miniprogram/pages/home/index.wxml',
  homeJson: 'miniprogram/pages/home/index.json',
  rosterWxml: 'miniprogram/pages/roster/index.wxml',
  mdJs: 'miniprogram/components/member-detail/index.js',
  mdWxml: 'miniprogram/components/member-detail/index.wxml',
  mdJson: 'miniprogram/components/member-detail/index.json',
  bsWxss: 'miniprogram/components/bottom-sheet/index.wxss'
};
const SRC = {};
Object.keys(F).forEach(k => { SRC[k] = fs.readFileSync(path.join(ROOT, F[k]), 'utf8'); });

let failed = 0;
function check(ok, name) {
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name);
  if (!ok) failed++;
}
function strip(s, kind) {
  if (kind === 'wxml') return s.replace(/<!--[\s\S]*?-->/g, '');
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function bodyOf(src, name) {
  const re = new RegExp('\\b' + name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}');
  const m = re.exec(src);
  return m ? m[1] : '';
}

function statics(s) {
  const hj = strip(s.homeJs, 'js');
  const hw = strip(s.homeWxml, 'wxml');
  const rw = strip(s.rosterWxml, 'wxml');
  const mj = strip(s.mdJs, 'js');
  const mw = strip(s.mdWxml, 'wxml');
  const css = strip(s.bsWxss, 'css');
  const tap = bodyOf(hj, 'onPinTap');
  return {
    // ① 不跳页
    noNavigate: tap.length > 60 && !/wx\.navigateTo|wx\.redirectTo|openMemberId/.test(tap),
    inlineShow: /pinDetailShow:\s*true/.test(tap) && /pinDetailMemberId:\s*memberId/.test(tap),
    crossClassOnly: /classId && classId !== myClassId/.test(tap),
    dataFields: /pinDetailShow:\s*false/.test(hj) && /pinDetailMemberId:\s*0/.test(hj)
      && /pinDetailClassId:\s*0/.test(hj),
    // ② 卡片接线与关闭方式
    componentWired: /<member-detail[\s\S]*?show="\{\{pinDetailShow\}\}"[\s\S]*?member-id="\{\{pinDetailMemberId\}\}"[\s\S]*?class-id="\{\{pinDetailClassId\}\}"[\s\S]*?bind:close="onPinDetailClose"[\s\S]*?bind:changed="onPinDetailChanged"[\s\S]*?\/>/.test(hw),
    jsonDeclared: /"member-detail":\s*"\.\.\/\.\.\/components\/member-detail\/index"/.test(s.homeJson),
    closeHandler: /onPinDetailClose\(\)\s*\{[\s\S]*?pinDetailShow:\s*false/.test(hj)
      && /onPinDetailChanged\(\)/.test(hj),
    scrollLock: /page-meta[^>]*pinDetailShow/.test(hw),
    noGrabNoClose: /show-grab="\{\{false\}\}"/.test(mw) && /show-close="\{\{false\}\}"/.test(mw)
      && /variant="float"/.test(mw),
    maskClose: /bind:close="onClose"/.test(mw) && !/mask-close="\{\{false\}\}"/.test(mw),
    exitAnim: /\.sheet-root\.float \.sheet-panel\s*\{[^}]*transition:[^}]*\.24s/.test(css),
    rosterBare: /show-grab="\{\{false\}\}"\s+show-close="\{\{false\}\}"/.test(rw),
    // ③ 组件自包含
    emits: /triggerEvent\('close'\)/.test(mj) && /triggerEvent\('changed'\)/.test(mj),
    loadsData: /api\.memberList\(/.test(mj) && /api\.noteList\(/.test(mj) && /api\.pinList\(/.test(mj),
    compJson: /"component":\s*true/.test(s.mdJson)
      && /"bottom-sheet":\s*"\.\.\/bottom-sheet\/index"/.test(s.mdJson)
      && /"avatar-tag":\s*"\.\.\/avatar-tag\/index"/.test(s.mdJson)
  };
}

const S = statics(SRC);
console.log('=== 1.0.8.32 首页就地弹成员详情卡门禁 ===');
console.log('\n── ① 不跳页，首页就地弹');
check(S.noNavigate, 'onPinTap 不再 navigateTo / 不再拼 openMemberId 深链');
check(S.inlineShow && S.dataFields, '同批下发 pinDetailShow + memberId，data 三个字段齐备');
check(S.crossClassOnly, 'classId 仅跨班时带（本班带会把权限收窄）');

console.log('\n── ② 无横线 / 无叉号 / 点空白关 / 有退出动画');
check(S.componentWired && S.jsonDeclared, '首页已声明并挂上 member-detail 组件，四个绑定齐备');
check(S.closeHandler && S.scrollLock, 'close/changed 处理器齐备，page-meta 滚动锁覆盖新弹层');
check(S.noGrabNoClose, '卡面无 grabber 小横线、无关闭叉号，仍是 float 居中卡片');
check(S.maskClose && S.exitAnim, '点遮罩空白处可关，且 float 面板有 .24s 退出动画');
check(S.rosterBare, '成员与分组页的详情卡同步去掉横线与叉号，两处一致');

console.log('\n── ③ 组件自包含');
check(S.emits && S.loadsData, '组件自己拉成员/备注/固定态，并向外发 close / changed');
check(S.compJson, '组件 json 声明 component:true 与两个依赖组件路径');

/* ---------- 变异自证 ---------- */
const MUT = [
  { name: '又跳回成员与分组页', file: 'homeJs', probe: 'noNavigate',
    from: "    this.setData({\n      pinDetailShow: true,",
    to: "    wx.navigateTo({ url: '/pages/roster/index?openMemberId=' + memberId });\n    this.setData({\n      pinDetailShow: true," },
  { name: 'page-meta 漏掉新弹层（背景跟着滚）', file: 'homeWxml', probe: 'scrollLock',
    from: ' || pinDetailShow)', to: ')' },
  { name: '卡片又把 grabber 横线放回来', file: 'mdWxml', probe: 'noGrabNoClose',
    from: 'show-grab="{{false}}"', to: 'show-grab="{{true}}"' },
  { name: '卡片又把关掉叉号放回来', file: 'mdWxml', probe: 'noGrabNoClose',
    from: 'show-close="{{false}}"', to: 'show-close="{{true}}"' },
  { name: '点遮罩不能关', file: 'mdWxml', probe: 'maskClose',
    from: 'bind:close="onClose"', to: 'bind:close="noop"' },
  { name: '写操作后不刷新关注列表', file: 'homeWxml', probe: 'componentWired',
    from: 'bind:changed="onPinDetailChanged"', to: '' },
  { name: '首页没声明组件', file: 'homeJson', probe: 'jsonDeclared',
    from: '"member-detail": "../../components/member-detail/index"', to: '' },
  { name: 'roster 详情卡还留着横线叉号', file: 'rosterWxml', probe: 'rosterBare',
    from: 'show-grab="{{false}}" show-close="{{false}}"', to: '' }
];

console.log('\n── ④ 变异自证（改坏 → 探针必须翻红）');
MUT.forEach(mu => {
  const before = SRC[mu.file];
  if (!before.includes(mu.from)) { console.log('  FAIL  变异「' + mu.name + '」锚点没命中'); failed++; return; }
  const next = Object.assign({}, SRC);
  next[mu.file] = before.replace(mu.from, mu.to);
  if (next[mu.file] === before) { console.log('  FAIL  变异「' + mu.name + '」替换没生效'); failed++; return; }
  check(statics(next)[mu.probe] === false, '变异被抓：' + mu.name);
});

console.log('\n' + (failed ? '❌ ' + failed + ' 项不通过' : '✅ 首页就地弹成员详情卡检查全部通过'));
process.exit(failed ? 1 : 0);
