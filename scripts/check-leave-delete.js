#!/usr/bin/env node
/**
 * 第 70 个门禁：删除已撤销的请假记录
 * =================================================================
 * 2026-10-09 需求：「请假登记中增加可以删除已撤销的历史」（用户截图红框那条）。
 *
 * ⚠️ 这个需求**上一轮被取消过一次**（当时是「假条历史左滑删除」），本轮改回来做，
 *    但形态换了：**行尾显式「删除」按钮**（左滑手势与弹层内 spring-scroll 的竖向
 *    滚动容易打架）。
 *
 * 五条用户已定的决策（2026-10-09 grill）：
 *   ① **物理删除**，不可恢复（不是「隐藏」—— 那需要改 schema 加列，且「已删除」
 *      与「已撤销」两个状态共存更让人困惑）；
 *   ② 行尾显式「删除」按钮（不是左滑）；
 *   ③ 连带删除云存储里的假条文件（否则云存储只涨不减）；
 *   ④ 权限 = **超管 + 班委**（复用 `requireLeaveRegister`，与 `cancelLeave` 同一套，
 *      不另造 —— 另造必然与撤销权限漂移）；辅导员只有只读权，不给；
 *   ⑤ **只有 `CANCELLED` 能删**，ONGOING / ENDED / UPCOMING 一律拒。
 *
 * 🔴 本门禁钉的主要性质（都是「不报错、只是错」那一类）：
 *   · **权限口径不许放宽**：万一改成 requireLeaveView，辅导员就能删 ⇒ 数据被破坏。
 *   · **状态判据不许放宽**：写成 `status !== 'APPROVED'` 的话，**进行中**的记录也能删
 *     ⇒ 用户可能把「正在生效的请假」删掉，值日就再也不会标记。
 *   · **必须班级隔离**：跨班传 id 能删到别班的记录 = 越权。
 *   · **前端必须双保险**：光靠后端拒 ⇒ 用户点了「没反应」会以为功能坏了。
 *   · **假条文件必须一并删**：留着就是纯垃圾（且已过归档期，永远不会被清）。
 *
 * 变异自证（9 组）：M1 权限放宽到 requireLeaveView / M2 状态判据反了（成
 *   「非已撤销才能删」）/ M3 去掉班级隔离 / M4 不删假条文件 / M5 前端不校验状态 /
 *   M6 不用 confirmStrict（无二次确认）/ M7 删完不重拉（组头人数与行数不符）/
 *   M8 按钮给所有状态 / M9 传假条按钮被改成互斥（已撤销行就传不了假条）
 *
 * 退出码 0 = 过；非 0 = 有问题。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let bad = 0;
const ok = (m) => console.log('PASS  ' + m);
const fail = (m) => { bad += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : fail(m));

const ADJUST = 'cloudfunctions/adjust/index.js';
const ROSTER_JS = 'miniprogram/pages/roster/index.js';
const ROSTER_WXML = 'miniprogram/pages/roster/index.wxml';
const ROSTER_WXSS = 'miniprogram/pages/roster/index.wxss';
const API = 'miniprogram/utils/api.js';

const adjust = read(ADJUST);
const js = read(ROSTER_JS);
const wxml = read(ROSTER_WXML);
const wxss = read(ROSTER_WXSS);
const api = read(API);

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
const adjustCode = strip(adjust);
const jsCode = strip(js);
const wxmlCode = strip(wxml);

/* ------------------------------------------------------------------ */
console.log('── ① 后端 action：存在 + 五条硬约束');

const fn = /leaveDelete:\s*\{([\s\S]*?)\n  \}\n\};/.exec(adjust);
chk(!!fn, '能定位 leaveDelete action');
if (fn) {
  const b = fn[1];
  // 判据要剥注释再判：`status !== 'CANCELLED'` 这类字面量在注释里也出现过
  const bc = strip(fn[1]);

  chk(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(b),
    'action 声明 needBind');

  // 🔴 权限：必须 requireLeaveRegister（超管 + 班委），不得放宽
  chk(/guard\.requireLeaveRegister\(ctx\)/.test(bc),
    '🔴⚠️⚠️ 权限 = requireLeaveRegister（超管+班委，与 cancelLeave 同一套）');
  chk(!/requireLeaveView|requireBind\(ctx\)\s*;?\s*$/m.test(bc.split('const leaveId')[0] || ''),
    '🔴⚠️ 不许放宽到 requireLeaveView（那会让**辅导员**也能删 ⇒ 数据被破坏）');
  chk(!/guard\.requireSuper\(ctx\)/.test(bc),
    '🔴 未改成 requireSuper（用户 2026-10-09 明确选了「超管 + 班委」同撤销权限）');

  chk(/const leaveId = Number\(payload\.leaveId\);/.test(bc) && /if \(!leaveId\) throw new BizError/.test(bc),
    '参数校验 leaveId');

  // 🔴 班级隔离：SELECT 与 DELETE 都要带 class_id
  chk(/SELECT id, member_id, status, leave_image FROM leave_request WHERE id = \? AND class_id = \?/.test(bc),
    '🔴⚠️ SELECT 带 class_id（跨班传 id 一律「记录不存在」= 越权防护）');
  chk(/DELETE FROM leave_request WHERE id = \? AND class_id = \?/.test(bc),
    '🔴⚠️ DELETE 带 class_id（**光 SELECT 校验不够**，竞态下会删到别班）');

  // 🔴 状态判据：只有 CANCELLED 能删
  chk(/if \(row\.status !== 'CANCELLED'\) throw new BizError\(41001, '只能删除已撤销的请假记录'\);/.test(bc),
    '🔴⚠️⚠️ **只有 CANCELLED 能删**（写成 !== APPROVED 会让**进行中**的记录也能删 ⇒ 值日不再标记）');

  // 🔴 假条文件一并删
  chk(/const fileId = row\.leave_image \|\| '';/.test(bc) && /cloud\.deleteFile\(\{ fileList: \[fileId\] \}\)/.test(bc),
    '🔴⚠️⚠️ 连带删云存储假条文件（已过归档期，留着就是纯垃圾）');
  chk(/try \{ await cloud\.deleteFile/.test(bc),
    '⚠️ 删文件包在 try 里（删不掉不应让「记录已删」变成失败）');
  chk(/if \(fileId\) \{/.test(bc),
    '⚠️ 只在有图时调 deleteFile（空 fileID 不该发请求）');

  chk(/console\.log\(JSON\.stringify\(\{/.test(bc) && /action: 'leaveDelete'/.test(bc),
    '有操作日志（与其他 action 同口径，便于事后追溯谁删的）');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ② 前端：api + handler + UI');

chk(/leaveDelete: C\('adjust', 'leaveDelete'\)/.test(api),
  '🔴⚠️ api.leaveDelete 已注册（后端 action 改了，前端不注册 = 点了报「未知 action」）');

const h = /onHistDelete\(e\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!h, '能定位 onHistDelete');
if (h) {
  const b = h[1];
  // 🔴 前端双保险：不靠后端拒
  chk(/if \(row\.state !== 'CANCELLED'\) \{ util\.toast/.test(b),
    '🔴⚠️⚠️ 前端也校验「只有已撤销能删」（光靠后端 ⇒ 用户点了没反应会以为功能坏了）');
  // 🔴 二次确认
  chk(/util\.confirmStrict\(/.test(b),
    '🔴⚠️⚠️ 走 util.confirmStrict 二次确认（不可恢复的破坏性操作）');
  chk(/confirmStrict\([\s\S]*?,\s*\n\s*'删除已撤销的请假'\s*\n\s*\)\.then/.test(b),
    '⚠️ confirmStrict 按 (content, title) 传参并用 .then 接（**它返回 Promise、不是回调**）');
  chk(/if \(r === 'confirm'\) this\._doHistDelete\(id\);/.test(b),
    '⚠️ 只在 confirm 时才真删（cancel/fail 都不动）');
  chk(/row\.hasImage \? '[^']*假条照片会一并删除/.test(b),
    '⚠️ 有假条时在确认文案里说明「照片一并删除」');
  chk(/const id = Number\(e\.currentTarget\.dataset\.id\);/.test(b), '从 dataset 取 leaveId');
  chk(/if \(!id\) return;/.test(b), 'id 为空直接返回（不弹确认）');
}

const dh = /_doHistDelete\(id\)\s*\{([\s\S]*?)\n  \},/.exec(js);
chk(!!dh, '能定位 _doHistDelete');
if (dh) {
  const b = dh[1];
  chk(/api\.leaveDelete\(\{ leaveId: id \}/.test(b), '调 api.leaveDelete');
  // 🔴 成功 / 失败**分别**判：只判「函数体里有」会被另一分支蒙过去（本轮 M7 就这么溜了）
  const thenPart = (b.split('.catch')[0] || '');
  const catchPart = (b.split('.catch')[1] || '');
  chk(/this\._loadLeaveHistory\(false\)/.test(thenPart),
    '🔴⚠️⚠️ 删除成功后**重拉历史**（组头人数/空组/筛选都由 `_applyHistoryFilter` 算，本地 splice 会漂移）');
  chk(/const row = \(this\.data\.leaveHistory \|\| \[\]\)\.find/.test(b),
    '⚠️ 在**重拉之前**先把 image 取出来（重拉后 leaveHistory 已被替换，那时找不到了）');
  chk(/delete urls\[img\];/.test(b) && /leaveImgUrls/.test(b),
    '⚠️ 清临时链接缓存用 `leaveImgUrls`（今日名单与历史**共用同一份**，别自造 histImgUrls）');
  chk(/this\._loadLeaveHistory\(false\)/.test(catchPart),
    '⚠️ **失败也重拉**（后端可能已删成功但响应丢了 ⇒ 让列表回到真实状态）');
}

/* UI：按钮 */
chk(/catchtap="onHistDelete"/.test(wxmlCode), '删除按钮绑了 onHistDelete');
chk(/wx:if="\{\{canLeave && item\.state === 'CANCELLED'\}\}"/.test(wxmlCode),
  '🔴⚠️⚠️ 删除按钮只给**已撤销**的行（不是所有状态都给）');
// ⚠️ 传假条按钮要排除已撤销。⚠️ 这里**wx:if 与 wx:elif 都算对** ——
//    它的上一节是缩略图 `wx:if`，所以写成 `wx:elif` 才正确（同一个 wx:if 链上不能有两个
//    wx:if）；判据只认 wx:if 会把正确实现判死（本轮踩了）。
const upImg = /wx:if="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(wxmlCode)
  || /wx:elif="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(wxmlCode);
chk(upImg, '⚠️ 传假条按钮**排除**已撤销（已撤销的不该再传假条；与删除按钮并存）');
//    （那边没有 state 概念、也不该有删除按钮）。本轮第一版写的是「全站禁止裸写法」
//    ⇒ 判死了 397/428 两处正确代码（假失败）。教训：这类"写法禁令"必须**限定作用域**。
const histBlock = /wx:for="\{\{grp\.items\}\}"[\s\S]*?<\/view>\s*<\/view>/.exec(wxml) || { 0: '' };
const histCode = strip(histBlock[0]);
chk(!/wx:elif="\{\{canLeave\}\}"/.test(histCode),
  '🔴⚠️ 历史区不存在裸的 `wx:elif="{{canLeave}}"`（否则已撤销行也渲染「传假条」，与删除按钮冲突）');
chk(/wx:if="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(histCode)
  || /wx:elif="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(histCode),
  '⚠️⚠️ 历史区的传假条判据带 state 条件（限定在历史区判，别全站一刀切）');
chk(/class="lv-del"/.test(wxmlCode), '删除按钮用独立的 lv-del 类（不复用主色按钮）');
chk(/data-id="\{\{item\.leaveId\}\}"/.test(wxmlCode), '按钮带 data-id');

/* 样式：用 danger token，深色模式自动兼容 */
const del = /\.lv-del\s*\{([^}]*)\}/.exec(wxss);
chk(!!del, 'wxss 有 .lv-del 规则');
if (del) {
  const b = del[1];
  chk(/flex-shrink:\s*0/.test(b), 'flex-shrink:0（与同行缩略图一致，防止被压扁）');
  chk(/color:\s*var\(--danger\)/.test(b) && /background:\s*var\(--danger-bg\)/.test(b),
    '🔴 用 danger token（写死色值会在深色模式下瞎眼；app.wxss:169-170 有对应深色值）');
  chk(/height:\s*56rpx/.test(b),
    '⚠️ 高 56rpx，与 `.lv-btn.ghost` 同高（同一条行里两个按钮不齐会显得歪）');
}

/* ------------------------------------------------------------------ */
console.log('');
console.log('── ③ 变异自证：改坏一处必须被抓到（内存副本，不落盘）');

function judge(o) {
  o = o || {};
  const vAdjust = o.adjust || adjust;
  const vJs = o.js || js;
  const vWxml = o.wxml || wxml;
  const vWxss = o.wxss || wxss;
  const vApi = o.api || api;
  let n = 0;
  const push = (x) => { if (!x) n += 1; };

  const f = /leaveDelete:\s*\{([\s\S]*?)\n  \}\n\};/.exec(vAdjust);
  push(!!f);
  if (f) {
    const b = strip(f[1]);
    push(/auth:\s*\{\s*needBind:\s*true\s*\}/.test(f[1]));
    push(/guard\.requireLeaveRegister\(ctx\)/.test(b));
    push(!/guard\.requireLeaveView\(ctx\)/.test(b));
    push(!/guard\.requireSuper\(ctx\)/.test(b));
    push(/const leaveId = Number\(payload\.leaveId\);/.test(b) && /if \(!leaveId\) throw new BizError/.test(b));
    push(/SELECT id, member_id, status, leave_image FROM leave_request WHERE id = \? AND class_id = \?/.test(b));
    push(/DELETE FROM leave_request WHERE id = \? AND class_id = \?/.test(b));
    push(/if \(row\.status !== 'CANCELLED'\) throw new BizError\(41001, '只能删除已撤销的请假记录'\);/.test(b));
    push(/const fileId = row\.leave_image \|\| '';/.test(b) && /cloud\.deleteFile\(\{ fileList: \[fileId\] \}\)/.test(b));
    push(/try \{ await cloud\.deleteFile/.test(b));
    push(/if \(fileId\) \{/.test(b));
    push(/action: 'leaveDelete'/.test(b));
  }

  push(/leaveDelete: C\('adjust', 'leaveDelete'\)/.test(vApi));

  const c1 = strip(vJs);
  const c2 = strip(vWxml);
  const hf = /onHistDelete\(e\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!hf);
  if (hf) {
    const b = hf[1];
    push(/if \(row\.state !== 'CANCELLED'\) \{ util\.toast/.test(b));
    push(/util\.confirmStrict\(/.test(b));
    push(/confirmStrict\([\s\S]*?,\s*\n\s*'删除已撤销的请假'\s*\n\s*\)\.then/.test(b));
    push(/if \(r === 'confirm'\) this\._doHistDelete\(id\);/.test(b));
    push(/row\.hasImage \? '[^']*假条照片会一并删除/.test(b));
    push(/const id = Number\(e\.currentTarget\.dataset\.id\);/.test(b));
    push(/if \(!id\) return;/.test(b));
  }
  const df = /_doHistDelete\(id\)\s*\{([\s\S]*?)\n  \},/.exec(vJs);
  push(!!df);
  if (df) {
    const b = df[1];
    // 🔴 必须**分别**判成功与失败两处：只判「函数体里有 `_loadLeaveHistory`」太宽 ——
    //   失败分支里那处会让删掉成功分支的重拉照样通过（M7 变异就是这么溜过去的）。
    const thenPart = (b.split('.catch')[0] || '');
    const catchPart = (b.split('.catch')[1] || '');
    push(/api\.leaveDelete\(\{ leaveId: id \}/.test(b));
    push(/this\._loadLeaveHistory\(false\)/.test(thenPart),
      '🔴⚠️⚠️ 删除**成功**后重拉历史（只判函数体里有会被失败分支那处蒙过去）');
    push(/const row = \(this\.data\.leaveHistory \|\| \[\]\)\.find/.test(b));
    push(/delete urls\[img\];/.test(b) && /leaveImgUrls/.test(b));
    push(/this\._loadLeaveHistory\(false\)/.test(catchPart),
      '⚠️ **失败也重拉**（后端可能已删成功但响应丢了 ⇒ 让列表回到真实状态）');
  }
  push(/catchtap="onHistDelete"/.test(c2));
  push(/wx:if="\{\{canLeave && item\.state === 'CANCELLED'\}\}"/.test(c2));
  push(/wx:if="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(c2)
    || /wx:elif="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(c2));
  // ⚠️ 只扫历史区：今日名单里的裸 `{{canLeave}}` 是正确的（全站一刀切会判死它）
  const hb = /wx:for="\{\{grp\.items\}\}"[\s\S]*?<\/view>\s*<\/view>/.exec(vWxml) || { 0: '' };
  const hc = strip(hb[0]);
  push(!/wx:elif="\{\{canLeave\}\}"/.test(hc));
  push(/wx:if="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(hc)
    || /wx:elif="\{\{canLeave && item\.state !== 'CANCELLED'\}\}"/.test(hc));
  push(/class="lv-del"/.test(c2));
  push(/data-id="\{\{item\.leaveId\}\}"/.test(c2));
  const dl = /\.lv-del\s*\{([^}]*)\}/.exec(vWxss);
  push(!!dl);
  if (dl) {
    const b = dl[1];
    push(/flex-shrink:\s*0/.test(b));
    push(/color:\s*var\(--danger\)/.test(b) && /background:\s*var\(--danger-bg\)/.test(b));
    push(/height:\s*56rpx/.test(b));
  }
  return n;
}

const MUT = [
  {
    name: 'M1 权限放宽到 requireLeaveView（**辅导员也能删** ⇒ 数据可被破坏）',
    apply: () => ({ adjust: adjust.replace('guard.requireLeaveRegister(ctx);\n      const classId = guard.classIdOf(ctx);\n      const leaveId = Number(payload.leaveId);\n      if (!leaveId) throw new BizError(41001, \'参数错误\');\n      const pool = getPool();\n      const [lr] = await pool.query(\n        \'SELECT id, member_id, status, leave_image FROM leave_request WHERE id = ? AND class_id = ?\',',
      'guard.requireLeaveView(ctx);\n      const classId = guard.classIdOf(ctx);\n      const leaveId = Number(payload.leaveId);\n      if (!leaveId) throw new BizError(41001, \'参数错误\');\n      const pool = getPool();\n      const [lr] = await pool.query(\n        \'SELECT id, member_id, status, leave_image FROM leave_request WHERE id = ? AND class_id = ?\',') })
  },
  {
    // 极性反转：写成 status !== 'APPROVED' ⇒ 进行中的记录也能删 ⇒ 值日不再标记
    name: 'M2 状态判据写成 `!== APPROVED`（**进行中/已结束的也能删** ⇒ 删掉生效中的请假）',
    apply: () => ({
      adjust: adjust.replace("if (row.status !== 'CANCELLED') throw new BizError(41001, '只能删除已撤销的请假记录');",
        "if (row.status !== 'APPROVED') throw new BizError(41001, '只能删除已撤销的请假记录');")
    })
  },
  {
    name: 'M3 去掉 DELETE 的班级隔离（竞态下能删到别班的记录 = 越权）',
    apply: () => ({
      adjust: adjust.replace("await pool.query('DELETE FROM leave_request WHERE id = ? AND class_id = ?', [leaveId, classId]);",
        "await pool.query('DELETE FROM leave_request WHERE id = ?', [leaveId]);")
    })
  },
  {
    name: 'M4 不删假条文件（云存储只涨不减，且已过归档期永远不会被清）',
    apply: () => ({
      adjust: adjust.replace('if (fileId) {\n        try { await cloud.deleteFile({ fileList: [fileId] }); } catch (e) { /* 删不掉不影响记录已删 */ }\n      }', '')
    })
  },
  {
    name: 'M5 前端不校验状态（光靠后端拒 ⇒ 用户点了「没反应」会以为功能坏了）',
    apply: () => ({
      js: js.replace("if (row.state !== 'CANCELLED') { util.toast('只能删除已撤销的记录'); return; }", '')
    })
  },
  {
    name: 'M6 去掉二次确认（不可恢复的破坏性操作一点保护都没有）',
    apply: () => ({
      js: js.replace(/util\.confirmStrict\([\s\S]*?\)\.then\(\(r\) => \{ if \(r === 'confirm'\) this\._doHistDelete\(id\); \}\);/,
        "this._doHistDelete(id);")
    })
  },
  {
    // ⚠️ 锚点用**唯一**的一行：成功回调末尾那处 `_loadLeaveHistory(false)`。
    //    （`.then(() => {` 这种锚点随代码微调就失配 ⇒ replace 静默不生效 ⇒ 假通过。）
    //    目标形态：删完只 setData 清缓存、不重拉 ⇒ 组头人数与实际行数不符。
    name: 'M7 删完不重拉历史（组头人数/空组/筛选都是前端算的 ⇒ 数字与行数不符）',
    apply: () => ({
      js: js.replace(`          this.setData({ leaveImgUrls: urls });
        }
        this._loadLeaveHistory(false);`,
        `          this.setData({ leaveImgUrls: urls });
        }`)
    })
  },
  {
    name: 'M8 删除按钮给所有状态（进行中的也能删）',
    apply: () => ({
      wxml: wxml.replace("wx:if=\"{{canLeave && item.state === 'CANCELLED'}}\"", 'wx:if="{{canLeave}}"')
    })
  },
  {
    name: 'M9 历史区传假条退回裸写法（已撤销行也渲染「传假条」，与删除按钮冲突）',
    apply: () => ({
      wxml: wxml.replace("wx:elif=\"{{canLeave && item.state !== 'CANCELLED'}}\"", 'wx:elif="{{canLeave}}"')
    })
  }
];

let caught = 0;
MUT.forEach((c) => {
  const before = judge();
  if (before !== 0) {
    fail('变异「' + c.name + '」跑之前基线就不为 0（' + before + ' 条）—— 判据与实现已漂移，先修判据');
    bad += 1;
    return;
  }
  let over = {};
  try { over = c.apply(); } catch (e) {
    fail('变异「' + c.name + '」构造失败：' + e.message);
    bad += 1;
    return;
  }
  // 🔴 变异必须真的改到源码（锚点失效 ⇒ replace 原样返回 ⇒ 假通过）
  const orig = { adjust, js, wxml, wxss, api };
  const touched = ['adjust', 'js', 'wxml', 'wxss', 'api'].some((k) => over[k] && over[k] !== orig[k]);
  if (!touched) {
    fail('变异「' + c.name + '」**没有真的改到源码**（锚点失效：replace 找不到就原样返回）⇒ 门禁测的是原文件。**先修锚点。**');
    bad += 1;
    return;
  }
  let n;
  try { n = judge(over); } catch (e) {
    fail('变异「' + c.name + '」跑挂了（' + e.message + '）—— 变异体必须能真跑');
    bad += 1;
    return;
  }
  if (n > 0) { ok('变异「' + c.name + '」被门禁抓到（' + n + ' 条判据翻红）'); caught += 1; }
  else { fail('变异「' + c.name + '」**没被抓到** —— 判据失效'); bad += 1; }
});
if (caught === MUT.length) ok(MUT.length + '/' + MUT.length + ' 条变异全部被抓');

console.log('');
if (bad) {
  console.log('[FAIL] ' + bad + ' 项未通过');
  process.exit(1);
}
console.log('[PASS] 删除已撤销请假记录体检全部通过');