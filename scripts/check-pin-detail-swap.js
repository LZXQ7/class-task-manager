/**
 * 门禁：首页「关注的学生」连续点不同学生不得串档（v1.0.8.41）
 * ============================================================
 * 用户真机症状：先点学生 A 展开卡片、关掉、再点学生 B，卡片展开仍是 A 的数据，
 * 约 500ms 后才刷成 B。根因是组件打开时不清空旧 mDetail（异步 memberList 回来前
 * 一直渲染上一个人）+ 两个 property observer 同批 setData 并发发两次请求 +
 * 没有请求代次守卫（旧回包晚到会覆盖新学生）。
 *
 * 本门禁用 vm 真跑组件源码，把网络请求换成可手动 resolve 的 deferred，
 * 于是「请求还没回来」这一刻是确定性的 —— 不依赖真机 / DevTools / 定时器。
 * 再加静态契约 + 变异自证，确保探针本身不是摆设。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const F = {
  mdJs: 'miniprogram/components/member-detail/index.js',
  mdWxml: 'miniprogram/components/member-detail/index.wxml',
  mdWxss: 'miniprogram/components/member-detail/index.wxss',
  homeJs: 'miniprogram/pages/home/index.js',
  homeWxml: 'miniprogram/pages/home/index.wxml'
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
/** 组件方法缩进 4 空格；结束锚点必须按真实缩进写，否则会吞到后面的方法（假判据） */
function bodyOf(src, name) {
  const re = new RegExp('\\b' + name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n    \\}');
  const m = re.exec(src);
  return m ? m[1] : '';
}

/* ---------------- 静态契约 ---------------- */
function statics(s) {
  const mj = strip(s.mdJs, 'js');
  const mw = strip(s.mdWxml, 'wxml');
  const mc = strip(s.mdWxss, 'css');
  const hj = strip(s.homeJs, 'js');
  const hw = strip(s.homeWxml, 'wxml');
  const onInput = bodyOf(mj, '_onInput');
  const loadBody = bodyOf(mj, '_load');
  const notesBody = bodyOf(mj, '_loadNotes');
  const pinBody = bodyOf(mj, '_loadPinState');
  const clearAt = onInput.indexOf('mDetail: null');
  const closeAt = onInput.indexOf('if (!show) return;');
  const seqSelf = (mj.match(/seq !== self\._reqSeq/g) || []).length;
  const seqThis = (mj.match(/seq !== this\._reqSeq/g) || []).length;

  return {
    // ① 同批 setData 只能触发一次：多字段 observers，不许回到两个 property observer
    multiObserver: /observers:\s*\{\s*'show,\s*memberId,\s*classId'/.test(mj)
      && !/show:\s*\{\s*type:\s*Boolean,\s*value:\s*false,\s*observer/.test(mj)
      && !/memberId:\s*\{\s*type:\s*Number,\s*value:\s*0,\s*observer/.test(mj)
      && /_onInput\(show,\s*memberId,\s*classId\)/.test(mj),
    // ② 打开 / 换人：发请求之前同步清掉上一个人的全部内容
    clearOnOpen: onInput.length > 100 && clearAt >= 0 && closeAt >= 0 && closeAt < clearAt
      && /noteList:\s*\[\]/.test(onInput) && /noteDraft:\s*''/.test(onInput)
      && /pinned:\s*false/.test(onInput) && /loadFailed:\s*false/.test(onInput)
      && /if \(id > 0\) this\._load\(seq, id\);/.test(onInput),
    // ③ 关闭只作废旧请求，保留内容给 bottom-sheet 的 240ms 退出动画
    keepOnClose: /if \(!show\) return;/.test(onInput)
      && !/if \(!show\)\s*\{[\s\S]{0,160}setData/.test(onInput),
    // ④ 每次输入变化递增代次；所有异步回包都校验，含备注与固定态
    reqSeq: /this\._reqSeq\s*=\s*\(this\._reqSeq\s*\|\|\s*0\)\s*\+\s*1/.test(onInput)
      && /_load\(seq,\s*id\)/.test(mj)
      && (loadBody.match(/seq !== self\._reqSeq/g) || []).length >= 2
      && (notesBody.match(/seq !== this\._reqSeq/g) || []).length >= 2
      && (pinBody.match(/seq !== this\._reqSeq/g) || []).length >= 2
      && seqSelf >= 2 && seqThis >= 4
      && /_loadNotes\(seq,\s*memberId\)/.test(mj)
      && /_loadPinState\(seq,\s*memberId\)/.test(mj)
      && /_loadNotes\(this\._reqSeq,\s*m\.id\)/.test(mj),
    // ⑤ 防重复加载：attached 与初始化那次 observers 会撞，必须去重
    dedupe: /if \(key === this\._lastKey\) return;/.test(onInput)
      && /this\._lastKey = key;/.test(onInput),
    // ⑥ 首页把被点学生姓名同步传进来，加载首帧显示的是「本次点的学生」
    nameWired: /memberName:\s*\{\s*type:\s*String/.test(mj)
      && /pinDetailName:\s*''/.test(hj) && /pinDetailName:\s*name/.test(hj)
      && /member-name="\{\{pinDetailName\}\}"/.test(hw)
      && (mw.match(/\{\{memberName/g) || []).length >= 2,
    // ⑦ 加载占位：WXML 真节点 + WXSS 真规则（只写一边 = 真机看不见）
    loadingFace: /wx:if="\{\{!mDetail && !loadFailed\}\}"/.test(mw)
      && (mw.match(/class="md-loading"/g) || []).length >= 2
      && /\.md-loading\s*\{/.test(mc) && /\.md-loading-av\s*\{/.test(mc)
      && /background:\s*var\(--fill-soft\)/.test(mc)
  };
}

/* ---------------- vm 行为探针 ---------------- */
function deferred() {
  let resolve, reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
}
const flush = () => new Promise(r => setImmediate(r));
async function settle() { await flush(); await flush(); }

function makeApi(queue) {
  const push = (kind, extra) => {
    const d = deferred();
    queue.push(Object.assign({ kind, d }, extra || {}));
    return d.p;
  };
  return {
    memberList() { return push('member'); },
    noteList(p) { return push('note', { memberId: p && p.memberId }); },
    pinList() { return Promise.resolve({ list: [] }); },
    pinToggle() { return Promise.resolve({ pinned: true }); },
    updateGroup() { return Promise.resolve({}); },
    noteSave() { return Promise.resolve({}); },
    noteDelete() { return Promise.resolve({}); }
  };
}
const utilStub = {
  toast() {}, confirm() { return Promise.resolve(false); },
  seqOf(v) { return String(v == null ? '' : v); }
};

function loadCfg(src, api) {
  let cfg = null;
  const sandbox = {
    Component(c) { cfg = c; },
    require(p) { return p.indexOf('api') >= 0 ? api : utilStub; },
    getApp() { return { globalData: { profile: null } }; },
    console, Promise, Number, Object, Array, String, JSON, Date, setTimeout, clearTimeout, isFinite
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'member-detail/index.js' });
  return cfg;
}
function makeInst(cfg) {
  const inst = {
    properties: { show: false, memberId: 0, classId: 0, memberName: '' },
    data: Object.assign({}, cfg.data),
    _reqSeq: 0,
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent() {}
  };
  Object.assign(inst, cfg.methods);
  return inst;
}
/** 兼容「多字段 observers」与「property observer」两种写法，变异后也能驱动 */
function fire(inst, cfg, patch) {
  Object.assign(inst.properties, patch);
  if (cfg.observers) {
    const key = Object.keys(cfg.observers).find(k => /\bshow\b/.test(k) && /\bmemberId\b/.test(k));
    if (key) {
      cfg.observers[key].apply(inst, key.split(',').map(f => inst.properties[f.trim()]));
      return;
    }
  }
  Object.keys(patch).forEach(k => {
    const p = cfg.properties[k];
    if (p && typeof p.observer === 'function') p.observer.call(inst, patch[k]);
  });
}
function member(id, name) {
  return { id, name, studentNo: String(id), groupTag: 'A', dutyCount: 0 };
}
function memberReqs(q) { return q.filter(x => x.kind === 'member'); }
function noteReqs(q) { return q.filter(x => x.kind === 'note'); }

/** 用给定源码文本跑四个真实场景，返回探针结果（可作用于变异后的源码） */
/** 变异把组件改到根本不发请求时，等价于所有行为探针翻红，不能让门禁自己崩掉 */
async function behavior(mdJs) {
  try {
    return await behaviorCore(mdJs);
  } catch (e) {
    return {
      noOldOnSwitch: false, showsNew: false, noStaleOverride: false,
      noNoteCarry: false, noStaleNote: false
    };
  }
}

async function behaviorCore(mdJs) {
  const out = {};

  // ① 关掉 A 再点 B，B 的请求未回来时卡面不能还是 A
  {
    const q = [], api = makeApi(q), cfg = loadCfg(mdJs, api), inst = makeInst(cfg);
    fire(inst, cfg, { show: true, memberId: 101, classId: 0, memberName: '宋文霞' });
    memberReqs(q)[0].d.resolve([member(101, '宋文霞')]);
    await settle();
    const aShown = !!(inst.data.mDetail && Number(inst.data.mDetail.id) === 101);
    fire(inst, cfg, { show: false });
    fire(inst, cfg, { show: true, memberId: 102, classId: 0, memberName: '示例成员02' });
    const now = inst.data.mDetail;
    out.noOldOnSwitch = aShown && (now === null || Number(now.id) === 102);
    const last = memberReqs(q).slice(-1)[0];
    last.d.resolve([member(102, '示例成员02')]);
    await settle();
    out.showsNew = !!(inst.data.mDetail && Number(inst.data.mDetail.id) === 102);
  }

  // ② 旧 memberList 晚到，不能覆盖已经显示的新学生
  {
    const q = [], api = makeApi(q), cfg = loadCfg(mdJs, api), inst = makeInst(cfg);
    fire(inst, cfg, { show: true, memberId: 201, classId: 0, memberName: '甲' });
    const oldReq = memberReqs(q)[0];
    fire(inst, cfg, { show: false });
    fire(inst, cfg, { show: true, memberId: 202, classId: 0, memberName: '乙' });
    const newReq = memberReqs(q).slice(-1)[0];
    newReq.d.resolve([member(202, '乙')]);
    await settle();
    oldReq.d.resolve([member(201, '甲')]);
    await settle();
    out.noStaleOverride = !!(inst.data.mDetail && Number(inst.data.mDetail.id) === 202);
  }

  // ③ 备注 / 草稿 / 固定态不串人
  {
    const q = [], api = makeApi(q), cfg = loadCfg(mdJs, api), inst = makeInst(cfg);
    fire(inst, cfg, { show: true, memberId: 301, classId: 0, memberName: '甲' });
    memberReqs(q)[0].d.resolve([member(301, '甲')]);
    await settle();
    inst.setData({ noteList: [{ id: 9, content: '甲的备注' }], noteDraft: '甲的草稿', pinned: true });
    fire(inst, cfg, { show: false });
    fire(inst, cfg, { show: true, memberId: 302, classId: 0, memberName: '乙' });
    out.noNoteCarry = (inst.data.noteList || []).length === 0
      && inst.data.noteDraft === '' && inst.data.pinned === false;
  }

  // ④ 旧备注回包晚到，不能写进新学生的备注列表
  {
    const q = [], api = makeApi(q), cfg = loadCfg(mdJs, api), inst = makeInst(cfg);
    fire(inst, cfg, { show: true, memberId: 401, classId: 0, memberName: '甲' });
    memberReqs(q)[0].d.resolve([member(401, '甲')]);
    await settle();
    const oldNote = noteReqs(q)[0];
    fire(inst, cfg, { show: false });
    fire(inst, cfg, { show: true, memberId: 402, classId: 0, memberName: '乙' });
    memberReqs(q).slice(-1)[0].d.resolve([member(402, '乙')]);
    await settle();
    const newNote = noteReqs(q).slice(-1)[0];
    newNote.d.resolve([{ id: 2, content: '乙的备注' }]);
    await settle();
    oldNote.d.resolve([{ id: 1, content: '甲的备注' }]);
    await settle();
    const list = inst.data.noteList || [];
    out.noStaleNote = list.length === 1 && list[0].content === '乙的备注';
  }
  return out;
}

/* ---------------- 变异自证 ---------------- */
const MUT = [
  { name: '打开时又不清空 mDetail（用户症状本体）', file: 'mdJs', probe: 'clearOnOpen',
    from: '        mDetail: null,\n        mDetailIsSelf: false,',
    to: '        mDetail: this.data.mDetail,\n        mDetailIsSelf: false,', behaviorProbe: 'noOldOnSwitch' },
  { name: '去掉 memberList 的代次守卫', file: 'mdJs', probe: 'reqSeq',
    from: '          if (seq !== self._reqSeq) return;      // 已经关掉 / 换人，旧回包直接丢弃',
    to: '          if (false) return;', behaviorProbe: 'noStaleOverride' },
  { name: '回到两个 property observer（同批并发两次请求）', file: 'mdJs', probe: 'multiObserver',
    from: '  observers: {\n    \'show, memberId, classId\'',
    to: '  observersDisabled: {\n    \'show, memberId, classId\'' },
  { name: '关闭时把内容清空（退出动画变空白卡）', file: 'mdJs', probe: 'keepOnClose',
    from: '      if (!show) return;',
    to: '      if (!show) { this.setData({ mDetail: null, noteList: [] }); return; }' },
  { name: '去掉 attached 与初始化 observers 的去重', file: 'mdJs', probe: 'dedupe',
    from: '      if (key === this._lastKey) return;', to: '' },
  { name: '首页不再传姓名', file: 'homeJs', probe: 'nameWired',
    from: '      pinDetailName: name', to: '      pinDetailName: \'\'' },
  { name: 'WXML 删掉加载占位节点（只留 CSS）', file: 'mdWxml', probe: 'loadingFace',
    from: 'class="md-loading"', to: 'class="md-loading-off"' },
  { name: '备注回包去掉代次守卫', file: 'mdJs', probe: 'reqSeq',
    from: '          if (seq !== this._reqSeq) return;      // 备注也不能串到下一个人',
    to: '          if (false) return;', behaviorProbe: 'noStaleNote' }
];

(async function () {
  console.log('=== v1.0.8.41 关注的学生连续切换不串档门禁 ===');
  const S = statics(SRC);
  const B = await behavior(SRC.mdJs);

  console.log('\n── ① 行为探针（vm 真跑组件，网络延迟可控）');
  check(B.noOldOnSwitch, '关掉 A 再点 B：B 请求未回来时卡面不再是 A');
  check(B.showsNew, 'B 请求回来后正确显示 B');
  check(B.noStaleOverride, '旧 memberList 晚到不覆盖新学生');
  check(B.noNoteCarry, '备注 / 草稿 / 固定态不串人');
  check(B.noStaleNote, '旧备注回包晚到不写进新学生');

  console.log('\n── ② 静态契约');
  check(S.multiObserver, '多字段 observers 一次触发，不回到两个 property observer');
  check(S.clearOnOpen, '打开 / 换人先在发请求前同步清空上一个人的全部内容');
  check(S.keepOnClose, '关闭只作废旧请求，保留内容给 240ms 退出动画');
  check(S.reqSeq, '请求代次递增，成员 / 备注 / 固定态所有异步回包都校验');
  check(S.dedupe, 'attached 与初始化 observers 去重，不重复发请求');
  check(S.nameWired, '首页同步传姓名，加载首帧显示本次点的学生');
  check(S.loadingFace, '加载占位 WXML 节点 + WXSS 规则成对存在');

  console.log('\n── ③ 变异自证（改坏 → 探针必须翻红）');
  for (const mu of MUT) {
    const before = SRC[mu.file];
    if (!before.includes(mu.from)) {
      console.log('  FAIL  变异「' + mu.name + '」锚点没命中'); failed++; continue;
    }
    const next = Object.assign({}, SRC);
    next[mu.file] = before.replace(mu.from, mu.to);
    if (next[mu.file] === before) {
      console.log('  FAIL  变异「' + mu.name + '」替换没生效'); failed++; continue;
    }
    const s2 = statics(next);
    const b2 = await behavior(next.mdJs);
    const staticRed = s2[mu.probe] === false;
    const behaviorRed = mu.behaviorProbe ? b2[mu.behaviorProbe] === false : true;
    check(staticRed && behaviorRed, '变异被抓：' + mu.name
      + (mu.behaviorProbe ? '（静态 + 行为）' : '（静态）'));
  }

  console.log('\n' + (failed ? '❌ ' + failed + ' 项不通过' : '✅ 连续切换不串档检查全部通过'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
