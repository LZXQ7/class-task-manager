#!/usr/bin/env node
/**
 * 作业模块全链路门禁（2026-10-24，用户要求「上传送审前先测试发布/提交」）
 * ============================================================
 * 打法沿用项目既有两件套：
 *   · check-db-resilience.js  —— eval 生产源码 + 桩依赖
 *   · check-clean-label.js    —— 桩 ./common/db
 * 本门禁用 `Module._load` 钩子加载**生产 handler**（cloudfunctions/homework/index.js）：
 *   - `wx-server-sdk`   → 内存桩（getWXContext 返回可控 OPENID、deleteFile 记录调用）
 *   - `./common/db`     → 内存假库（按 SQL 特征分派，覆盖 handler 全部查询形状）
 * 其余依赖（guard / resp / homework-limit / test-account）全是**真源码**——
 * 验的是生产逻辑，不是复制品。
 *
 * 覆盖场景：
 *   publish  权限拒绝 / 截止必须带时分 / 标题与分组必填 / 附件超限 /
 *            requireType 归一化 / 入库字段逐列核对
 *   list     班委 canReview / 分组可见性（A 不见 B）/ 「仅自己」SELF 仅发布者可见 /
 *            closed 精确到时分 / due DESC 排序
 *   detail   越权拒绝 / 需交成员排除测试账号 / 非班委只见自己 / 附件回显 /
 *            「仅自己」发布者本人进需交名单 + iAmSubmitter
 *   submit   requireType 强制（IMAGE/FILE/EITHER/NONE 四态）/ 大小与格式校验 /
 *            截止拦截 / 打回（REJECT）豁免 / 覆盖重交（旧文件删、记录唯一）
 *   review   权限拒绝 / 状态流转 / 非法状态 / 作业不存在
 *   delete   权限拒绝（非发布者/超管）/ 不存在 / 级联清空 / 云存储删 / 重复删
 *
 * 退出码：全过 0；任一不过 1（由 scripts/run_all_gates.sh 的 glob 自动纳入）。
 */
'use strict';

const path = require('path');
const Module = require('module');
const { isTestNo } = require('../cloudfunctions/homework/common/test-account');

/* ============================================================
 * 1. 内存假库
 * ============================================================ */
const db = {
  seq: {},
  class: [{ id: 1, is_active: 1 }],
  member: [
    // 班委（兼超管）：role=ADMIN + is_super=1 + A 组 ⇒ canReview
    { id: 10, openid: 'oc-committee', class_id: 1, role: 'ADMIN', group_tag: 'A', is_super: 1, status: 'ACTIVE', student_no: '2608010010', name: '张班委', position: '班长兼团支书' },
    // A 组普通学生（提交方）
    { id: 11, openid: 'oc-student-a', class_id: 1, role: 'MEMBER', group_tag: 'A', is_super: 0, status: 'ACTIVE', student_no: '2608010011', name: '李同学', position: '' },
    // B 组普通学生（可见性/越权测试）
    { id: 12, openid: 'oc-student-b', class_id: 1, role: 'MEMBER', group_tag: 'B', is_super: 0, status: 'ACTIVE', student_no: '2608010012', name: '王同学', position: '' },
    // 合成测试账号：detail 的需交成员必须排除它（NOT_TEST 铁律）
    { id: 99, openid: 'oc-test-no', class_id: 1, role: 'MEMBER', group_tag: 'A', is_super: 0, status: 'ACTIVE', student_no: '000000000001', name: '合成测试号', position: '' }
  ],
  impersonation: [],
  homework: [],
  homework_file: [],
  homework_submit: []
};

function nextId(table) {
  db.seq[table] = (db.seq[table] || 0) + 1;
  return db.seq[table];
}

const FIXED_TS = '2026-10-24 12:00:00';

/**
 * 按 SQL 特征分派的假池。⚠️ 未覆盖的查询直接抛错——
 * 宁可门禁红，也不 silently 返回空集造成「假通过」。
 */
function makePool() {
  return {
    async query(sql, args) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      const A = args || [];

      // ---- guard.getContext ----
      if (/^SELECT \* FROM member WHERE openid = \? LIMIT 1$/.test(s)) {
        return [db.member.filter(r => r.openid === A[0]).slice(0, 1)];
      }
      if (/^SELECT member_id FROM impersonation WHERE openid = \? LIMIT 1$/.test(s)) {
        return [db.impersonation.filter(r => r.openid === A[0]).slice(0, 1)];
      }
      // ---- resolveClassId（超管/辅导员跨班校验；本测试不走该分支，仍实现兜底） ----
      if (/^SELECT id FROM `class` WHERE id = \? AND is_active = 1 LIMIT 1$/.test(s)) {
        return [db.class.filter(r => r.id === A[0] && r.is_active === 1).slice(0, 1)];
      }

      // ---- publish：INSERT INTO homework（9 参） ----
      if (/^INSERT INTO homework \(class_id, title, brief, due_date, target_groups, max_images, max_files, require_type, publisher_id\) VALUES/.test(s)) {
        const row = {
          id: nextId('homework'), class_id: A[0], title: A[1], brief: A[2], due_date: A[3],
          target_groups: A[4], max_images: A[5], max_files: A[6], require_type: A[7],
          publisher_id: A[8], purged: 0, created_at: FIXED_TS
        };
        db.homework.push(row);
        return [{ insertId: row.id }];
      }
      // ---- INSERT INTO homework_file：ATTACH 6 参（member_id 为字面 0）/ SUBMIT 7 参 ----
      if (/^INSERT INTO homework_file \(class_id, homework_id, member_id, kind, file_id, name, mime, size\) VALUES/.test(s)) {
        const row = A.length === 6
          ? { id: nextId('homework_file'), class_id: A[0], homework_id: A[1], member_id: 0, kind: 'ATTACH', file_id: A[2], name: A[3], mime: A[4], size: A[5], created_at: FIXED_TS }
          : { id: nextId('homework_file'), class_id: A[0], homework_id: A[1], member_id: A[2], kind: 'SUBMIT', file_id: A[3], name: A[4], mime: A[5], size: A[6], created_at: FIXED_TS };
        db.homework_file.push(row);
        return [{ insertId: row.id }];
      }

      // ---- list ----
      if (/^SELECT \* FROM homework WHERE class_id = \? ORDER BY due_date DESC, id DESC$/.test(s)) {
        return [db.homework.filter(r => r.class_id === A[0])
          .sort((x, y) => (String(y.due_date) < String(x.due_date) ? -1 : String(y.due_date) > String(x.due_date) ? 1 : y.id - x.id))];
      }
      if (/^SELECT \* FROM homework WHERE class_id = \? AND \(?target_groups LIKE/.test(s)) {
        const g = String(A[1] || '');
        const me = Number(A[2]) || 0;
        return [db.homework.filter(r => r.class_id === A[0]
            && (String(r.target_groups).indexOf(g) >= 0
              || (String(r.target_groups).indexOf('SELF') >= 0 && Number(r.publisher_id) === me)))
          .sort((x, y) => (String(y.due_date) < String(x.due_date) ? -1 : String(y.due_date) > String(x.due_date) ? 1 : y.id - x.id))];
      }
      if (/^SELECT homework_id, status, submitted_at FROM homework_submit WHERE class_id = \? AND member_id = \?$/.test(s)) {
        return [db.homework_submit.filter(r => r.class_id === A[0] && r.member_id === A[1])];
      }

      // ---- detail ----
      if (/^SELECT \* FROM homework WHERE id = \? AND class_id = \?$/.test(s)) {
        return [db.homework.filter(r => r.id === A[0] && r.class_id === A[1])];
      }
      if (/^SELECT id, name, mime, size, file_id, created_at FROM homework_file WHERE homework_id = \? AND kind = 'ATTACH' ORDER BY id$/.test(s)) {
        return [db.homework_file.filter(r => r.homework_id === A[0] && r.kind === 'ATTACH').sort((x, y) => x.id - y.id)];
      }
      if (/^SELECT id, name, student_no, group_tag FROM member WHERE class_id = \? AND status = 'ACTIVE' AND /.test(s)) {
        return [db.member.filter(r => r.class_id === A[0] && r.status === 'ACTIVE' && !isTestNo(r.student_no) && r.group_tag !== 'X')];
      }
      if (/^SELECT \* FROM homework_submit WHERE homework_id = \? AND class_id = \?$/.test(s)) {
        return [db.homework_submit.filter(r => r.homework_id === A[0] && r.class_id === A[1])];
      }
      if (/^SELECT id, homework_id, member_id, name, mime, size, file_id, created_at FROM homework_file WHERE homework_id = \? AND kind = 'SUBMIT' ORDER BY id$/.test(s)) {
        return [db.homework_file.filter(r => r.homework_id === A[0] && r.kind === 'SUBMIT').sort((x, y) => x.id - y.id)];
      }

      // ---- submit ----
      if (/^SELECT \* FROM homework WHERE id = \?$/.test(s)) {
        return [db.homework.filter(r => r.id === A[0])];
      }
      if (/^SELECT id, status FROM homework_submit WHERE homework_id = \? AND member_id = \? LIMIT 1$/.test(s)) {
        return [db.homework_submit.filter(r => r.homework_id === A[0] && r.member_id === A[1]).slice(0, 1)];
      }
      if (/^SELECT file_id FROM homework_file WHERE homework_id = \? AND member_id = \? AND kind = 'SUBMIT'$/.test(s)) {
        return [db.homework_file.filter(r => r.homework_id === A[0] && r.member_id === A[1] && r.kind === 'SUBMIT').map(r => ({ file_id: r.file_id }))];
      }
      if (/^DELETE FROM homework_file WHERE homework_id = \? AND member_id = \? AND kind = 'SUBMIT'$/.test(s)) {
        const hit = db.homework_file.filter(r => r.homework_id === A[0] && r.member_id === A[1] && r.kind === 'SUBMIT');
        db.homework_file = db.homework_file.filter(r => !(r.homework_id === A[0] && r.member_id === A[1] && r.kind === 'SUBMIT'));
        return [{ affectedRows: hit.length }];
      }
      if (/^INSERT INTO homework_submit \(class_id, homework_id, member_id, status, remark\) VALUES.*ON DUPLICATE KEY UPDATE/.test(s)) {
        const exist = db.homework_submit.find(r => r.homework_id === A[1] && r.member_id === A[2]);
        if (exist) {
          exist.status = 'PENDING'; exist.remark = ''; exist.updated_at = FIXED_TS;
          return [{ affectedRows: 1 }];
        }
        const row = { id: nextId('homework_submit'), class_id: A[0], homework_id: A[1], member_id: A[2], status: 'PENDING', remark: '', submitted_at: FIXED_TS, updated_at: FIXED_TS };
        db.homework_submit.push(row);
        return [{ insertId: row.id }];
      }

      // ---- delete（侧滑删除，2026-10-24 用户需求）----
      if (/^SELECT file_id FROM homework_file WHERE homework_id = \?$/.test(s)) {
        return [db.homework_file.filter(r => r.homework_id === A[0]).map(r => ({ file_id: r.file_id }))];
      }
      if (/^DELETE FROM homework_file WHERE homework_id = \?$/.test(s)) {
        const hit = db.homework_file.filter(r => r.homework_id === A[0]);
        db.homework_file = db.homework_file.filter(r => r.homework_id !== A[0]);
        return [{ affectedRows: hit.length }];
      }
      if (/^DELETE FROM homework_submit WHERE homework_id = \?$/.test(s)) {
        const hit = db.homework_submit.filter(r => r.homework_id === A[0]);
        db.homework_submit = db.homework_submit.filter(r => r.homework_id !== A[0]);
        return [{ affectedRows: hit.length }];
      }
      if (/^DELETE FROM homework WHERE id = \?$/.test(s)) {
        const before = db.homework.length;
        db.homework = db.homework.filter(r => r.id !== A[0]);
        return [{ affectedRows: before - db.homework.length }];
      }

      // ---- review ----
      if (/^SELECT class_id FROM homework WHERE id = \?$/.test(s)) {
        return [db.homework.filter(r => r.id === A[0]).map(r => ({ class_id: r.class_id }))];
      }
      if (/^UPDATE homework_submit SET status = \?, remark = \?, updated_at = CURRENT_TIMESTAMP WHERE homework_id = \? AND member_id IN/.test(s)) {
        const ids = A.slice(3).map(Number);
        let n = 0;
        db.homework_submit.forEach(r => {
          if (r.homework_id === A[2] && ids.indexOf(Number(r.member_id)) >= 0) {
            r.status = A[0]; r.remark = A[1]; r.updated_at = FIXED_TS; n += 1;
          }
        });
        return [{ affectedRows: n }];
      }

      throw new Error('FAKE_DB 未覆盖的 SQL: ' + s);
    }
  };
}

/* ============================================================
 * 2. wx-server-sdk 内存桩 + Module._load 钩子加载生产 handler
 * ============================================================ */
const sdkState = { openid: '' };
const deleteCalls = [];
const sdkStub = {
  init: () => { /* noop */ },
  DYNAMIC_CURRENT_ENV: 'test-env',
  getWXContext: () => ({ OPENID: sdkState.openid, APPID: '<YOUR_APPID>' }),
  deleteFile: async (opts) => {
    deleteCalls.push((opts && opts.fileList) || []);
    return { fileList: ((opts && opts.fileList) || []).map(() => ({ status: 0 })) };
  }
};

const pool = makePool();
const DB_PATH = path.resolve(__dirname, '../cloudfunctions/homework/common/db.js');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return sdkStub;
  try {
    if (Module._resolveFilename(request, parent, isMain) === DB_PATH) return { getPool: () => pool };
  } catch (e) { /* 解析失败交回原实现 */ }
  return origLoad.apply(this, arguments);
};
const hw = require('../cloudfunctions/homework/index.js');
Module._load = origLoad;

/* ============================================================
 * 3. 断言框架
 * ============================================================ */
let pass = 0;
let fail = 0;
const failed = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('  [OK] ' + name); }
  else { fail += 1; failed.push(name); console.log('  [NG] ' + name + (extra === undefined ? '' : '  => ' + extra)); }
}
async function call(action, payload, openid) {
  sdkState.openid = openid;
  return hw.main({ action, payload: payload || {} });
}
const img = (name, size) => ({ fileId: 'cloud://test-env.hw/' + name, name: name, size: size === undefined ? 2048 : size, kind: 'IMAGE' });
const doc = (name, size) => ({ fileId: 'cloud://test-env.hw/' + name, name: name, size: size === undefined ? 4096 : size, kind: 'FILE' });

const OC_C = 'oc-committee';   // 班委（超管）
const OC_A = 'oc-student-a';   // A 组学生
const OC_B = 'oc-student-b';   // B 组学生

/* ============================================================
 * 4. 全链路场景
 * ============================================================ */
(async () => {
  try {
    /* ---------- S1 publish ---------- */
    console.log('\n== S1 publish 发布 ==');
    let r = await call('publish', { title: '越权发布', dueDate: '2030-06-01 09:30', groups: ['A'] }, OC_A);
    check('S1.1 学生发布被拒（40003 仅班委可发布作业）', r.errCode === 40003 && r.errMsg === '仅班委可发布作业', r.errCode + '/' + r.errMsg);

    r = await call('publish', { title: '缺时分', dueDate: '2030-06-01', groups: ['A'] }, OC_C);
    check('S1.2 截止只给日期被拒（41001 请选择截止日期与时间）', r.errCode === 41001 && r.errMsg === '请选择截止日期与时间', r.errCode + '/' + r.errMsg);

    r = await call('publish', { title: '  ', dueDate: '2030-06-01 09:30', groups: ['A'] }, OC_C);
    check('S1.3 空标题被拒（41001 请填写作业标题）', r.errCode === 41001 && r.errMsg === '请填写作业标题', r.errCode + '/' + r.errMsg);

    r = await call('publish', { title: '无分组', dueDate: '2030-06-01 09:30', groups: [] }, OC_C);
    check('S1.4 无分组被拒（41001 请选择需提交作业的分组）', r.errCode === 41001 && r.errMsg === '请选择需提交作业的分组', r.errCode + '/' + r.errMsg);

    r = await call('publish', {
      title: '附件超限', dueDate: '2030-06-01 09:30', groups: ['A'], maxFiles: 1,
      attaches: [doc('a1.pdf'), doc('a2.pdf')]
    }, OC_C);
    check('S1.5 附件数超 maxFiles 被拒（41001 附件最多 1 个）', r.errCode === 41001 && r.errMsg === '附件最多 1 个', r.errCode + '/' + r.errMsg);

    // hw1：A 组 / IMAGE / 未来截止（主测试作业）
    r = await call('publish', {
      title: '第7周微课设计与制作作业', brief: '按时提交', dueDate: '2030-06-01 09:30',
      groups: ['A'], maxImages: 3, maxFiles: 1, requireType: 'IMAGE'
    }, OC_C);
    const hw1 = r.data && r.data.id;
    check('S1.6 班委合法发布成功', r.errCode === 0 && hw1 > 0, JSON.stringify(r));
    const row1 = db.homework.find(h => h.id === hw1);
    check('S1.7 入库逐列核对（due_date 带时分 / require_type=IMAGE / target_groups=A / publisher_id=10）',
      !!row1 && row1.due_date === '2030-06-01 09:30' && row1.require_type === 'IMAGE'
      && row1.target_groups === 'A' && row1.max_images === 3 && row1.max_files === 1
      && row1.publisher_id === 10 && row1.class_id === 1,
      row1 && JSON.stringify({ d: row1.due_date, rt: row1.require_type, g: row1.target_groups, p: row1.publisher_id }));

    // hw2：A 组 / 非法 requireType 'VIDEO' 应归一化为 NONE（纯文字提交用）
    r = await call('publish', { title: '不要求材料', dueDate: '2030-07-01 10:00', groups: ['A'], requireType: 'VIDEO' }, OC_C);
    const hw2 = r.data && r.data.id;
    check('S1.8 非法 requireType 归一化 NONE 入库', r.errCode === 0 && db.homework.find(h => h.id === hw2).require_type === 'NONE');

    // hw3：A 组 / FILE / 过去截止（截止拦截 + 打回豁免用）
    r = await call('publish', { title: '已截止作业', dueDate: '2020-01-01 08:00', groups: ['A'], requireType: 'FILE' }, OC_C);
    const hw3 = r.data && r.data.id;
    check('S1.9 过去截止作业发布成功（供截止测试）', r.errCode === 0 && hw3 > 0);

    // hw4：B 组 / EITHER（B 组可见性 + 越权测试用）
    r = await call('publish', { title: 'B组作业', dueDate: '2030-08-01 12:00', groups: ['B'], requireType: 'EITHER' }, OC_C);
    const hw4 = r.data && r.data.id;
    check('S1.10 B 组作业发布成功', r.errCode === 0 && hw4 > 0);

    // hw5：A 组 / 带 1 个附件（ATTACH 入库 + 详情回显用）
    r = await call('publish', {
      title: '带附件作业', dueDate: '2030-09-01 12:00', groups: ['A'], requireType: 'NONE',
      attaches: [doc('题目附件.pdf', 2048)]
    }, OC_C);
    const hw5 = r.data && r.data.id;
    check('S1.11 带附件发布成功', r.errCode === 0 && hw5 > 0);
    check('S1.12 附件落 homework_file（kind=ATTACH / member_id=0）',
      db.homework_file.filter(f => f.homework_id === hw5 && f.kind === 'ATTACH').length === 1);

    // hw5b：带 1 个**图片**附件（kind=IMAGE）—— 锁死「附件类型透传」修复：
    // 早年 publish 把 attaches 一律映射 kind:'FILE' ⇒ 图片按文件白名单校验
    // ⇒ 真机「添加图片却报：文件格式不支持，仅支持 pdf/doc/...」（2026-10-24 用户反馈）。
    // 只测 pdf 附件是绿的（pdf 恰在 FILE_EXTS 里），所以这个盲区必须单测。
    r = await call('publish', {
      title: '带图片附件作业', dueDate: '2030-09-15 12:00', groups: ['A'], requireType: 'NONE',
      attaches: [img('题目截图.jpg', 2048)]
    }, OC_C);
    const hw5b = r.data && r.data.id;
    check('S1.13 图片附件（kind=IMAGE）发布成功（附件类型透传，不被文件白名单误杀）',
      r.errCode === 0 && hw5b > 0, r.errCode + '/' + r.errMsg);
    check('S1.14 图片附件落 homework_file（kind=ATTACH / name 原样）',
      db.homework_file.some(f => f.homework_id === hw5b && f.kind === 'ATTACH' && f.name === '题目截图.jpg'));

    // hw6：仅自己（SELF）/ IMAGE —— 班委发给自己自测发布→提交流程（用户 2026-10-24 场景）
    r = await call('publish', {
      title: '仅自己·自测作业', brief: '自己发给自己', dueDate: '2030-10-01 09:30',
      groups: ['SELF'], maxImages: 3, maxFiles: 1, requireType: 'IMAGE'
    }, OC_C);
    const hw6 = r.data && r.data.id;
    check('S1.13 仅自己（SELF）发布成功', r.errCode === 0 && hw6 > 0, JSON.stringify(r));
    check('S1.14 SELF 归一化入库（target_groups=SELF / publisher_id=10）',
      !!db.homework.find(h => h.id === hw6) && db.homework.find(h => h.id === hw6).target_groups === 'SELF'
      && db.homework.find(h => h.id === hw6).publisher_id === 10);

    // hw7：A 组 + 仅自己 组合（多选语义：A 组全员 + 发布者本人）
    r = await call('publish', { title: 'A组加仅自己', dueDate: '2030-11-01 09:30', groups: ['SELF', 'A'], requireType: 'NONE' }, OC_C);
    const hw7 = r.data && r.data.id;
    check('S1.15 A+SELF 组合发布成功且归一化排序为 A,SELF',
      r.errCode === 0 && db.homework.find(h => h.id === hw7).target_groups === 'A,SELF');

    /* ---------- S2 list ---------- */
    console.log('\n== S2 list 列表 ==');
    r = await call('list', {}, OC_C);
    const lc = (r.data && r.data.list) || [];
    check('S2.1 班委 list canReview=true', r.errCode === 0 && r.data.canReview === true);
    check('S2.2 班委看到全部 8 份作业（含仅自己 / 图片附件作业）', lc.length === 8, 'len=' + lc.length);
    const byId = (id) => lc.find(x => x.id === id);
    check('S2.3 hw1 回显全 datetime + requireType + 未截止',
      !!byId(hw1) && byId(hw1).dueDate === '2030-06-01 09:30' && byId(hw1).requireType === 'IMAGE' && byId(hw1).closed === false);
    check('S2.4 hw3（过去截止）closed=true', !!byId(hw3) && byId(hw3).closed === true);
    check('S2.5 按截止 DESC 排序（hw7 最前、hw3 最后）', lc[0].id === hw7 && lc[lc.length - 1].id === hw3,
      lc.map(x => x.id + ':' + x.dueDate).join(' | '));

    r = await call('list', {}, OC_A);
    const la = (r.data && r.data.list) || [];
    check('S2.6 学生A canReview=false', r.errCode === 0 && r.data.canReview === false);
    check('S2.7 学生A 只见 A 组作业（6 份：hw1/2/3/5/5b/7，不含 B 组 hw4 与他人仅自己 hw6）',
      la.length === 6 && !la.some(x => x.id === hw4) && !la.some(x => x.id === hw6),
      la.map(x => x.id).join(','));
    check('S2.8 学生A 未交状态 myStatus=null', la.every(x => x.myStatus === null));

    r = await call('list', {}, OC_B);
    const lb = (r.data && r.data.list) || [];
    check('S2.9 学生B 只见 hw4 且 requireType=EITHER',
      lb.length === 1 && lb[0].id === hw4 && lb[0].requireType === 'EITHER');

    /* ---------- S3 detail ---------- */
    console.log('\n== S3 detail 详情 ==');
    r = await call('detail', { id: hw1 }, OC_C);
    check('S3.1 班委详情：requireType / 全 datetime / canReview',
      r.errCode === 0 && r.data.homework.requireType === 'IMAGE' && r.data.homework.dueDate === '2030-06-01 09:30' && r.data.canReview === true);
    check('S3.2 需交成员=2（班委本人+李同学；合成测试号被 NOT_TEST 排除）',
      r.data.stats.total === 2 && r.data.list.every(x => !isTestNo(x.studentNo)),
      'total=' + r.data.stats.total);

    r = await call('detail', { id: hw1 }, OC_A);
    check('S3.3 学生A 详情：只见自己一条',
      r.errCode === 0 && r.data.list.length === 1 && r.data.list[0].id === 11 && r.data.canReview === false);

    r = await call('detail', { id: hw1 }, OC_B);
    check('S3.4 学生B 看 A 组作业被拒（40003 该作业未要求你所在分组提交）',
      r.errCode === 40003 && r.errMsg === '该作业未要求你所在分组提交', r.errCode + '/' + r.errMsg);

    r = await call('detail', { id: hw5 }, OC_C);
    check('S3.5 详情回显发布附件（1 个）', r.errCode === 0 && r.data.attaches.length === 1 && r.data.attaches[0].name === '题目附件.pdf');

    r = await call('detail', { id: hw6 }, OC_A);
    check('S3.6 学生A 看他人「仅自己」作业被拒（40003）',
      r.errCode === 40003 && r.errMsg === '该作业未要求你所在分组提交', r.errCode + '/' + r.errMsg);

    r = await call('detail', { id: hw6 }, OC_C);
    check('S3.7 发布者本人可看自己的「仅自己」作业（groups 含 SELF）',
      r.errCode === 0 && (r.data.homework.groups || []).indexOf('SELF') >= 0, JSON.stringify(r.data && r.data.homework && r.data.homework.groups));

    r = await call('detail', { id: hw7 }, OC_A);
    check('S3.8 学生A 可看 A+SELF 组合作业（targets 含 A 即放行）',
      r.errCode === 0 && (r.data.homework.groups || []).indexOf('A') >= 0);

    // 「仅自己」作业的发布者本人（班委 id=10）也要进需交名单 + iAmSubmitter：
    // 早年 members 只按 group_tag 过滤 ⇒ SELF 作业滤成空 ⇒ 详情页「该筛选下没有成员」、
    // 发布者自己也无法提交测试（2026-10-24 用户反馈）。
    r = await call('detail', { id: hw6 }, OC_C);
    check('S3.9 「仅自己」详情：发布者本人进需交名单（不再「该筛选下没有成员」）',
      r.errCode === 0 && r.data.stats.total === 1 && r.data.list.length === 1 && r.data.list[0].id === 10,
      'total=' + (r.data && r.data.stats && r.data.stats.total) + ' list=' + JSON.stringify((r.data && r.data.list) || []));
    check('S3.10 「仅自己」详情：iAmSubmitter=true（前端据此给发布者显示提交入口）',
      r.errCode === 0 && r.data.iAmSubmitter === true, String(r.data && r.data.iAmSubmitter));

    /* ---------- S4 submit ---------- */
    console.log('\n== S4 submit 提交 ==');
    r = await call('submit', { homeworkId: hw1, files: [] }, OC_A);
    check('S4.1 IMAGE 要求·空文件被拒（本作业要求至少上传 1 张图片）',
      r.errCode === 41001 && r.errMsg === '本作业要求至少上传 1 张图片', r.errCode + '/' + r.errMsg);

    r = await call('submit', { homeworkId: hw1, files: [doc('只传文件.pdf')] }, OC_A);
    check('S4.2 IMAGE 要求·只传文件被拒', r.errCode === 41001 && r.errMsg === '本作业要求至少上传 1 张图片');

    r = await call('submit', { homeworkId: hw1, files: [img('超大图.jpg', 11 * 1024 * 1024)] }, OC_A);
    check('S4.3 超限图片被拒（单张图片不能超过 10MB）', r.errCode === 41001 && /不能超过 10MB/.test(r.errMsg), r.errMsg);

    r = await call('submit', { homeworkId: hw1, files: [img('伪装图.txt')] }, OC_A);
    check('S4.4 后缀不符被拒（图片格式不支持）', r.errCode === 41001 && /图片格式不支持/.test(r.errMsg), r.errMsg);

    r = await call('submit', { homeworkId: hw1, files: [img('作业图1.jpg')] }, OC_A);
    check('S4.5 学生A 提交 1 张合规图成功', r.errCode === 0 && r.data.ok === true, r.errCode + '/' + r.errMsg);
    let sub = db.homework_submit.find(x => x.homework_id === hw1 && x.member_id === 11);
    check('S4.6 提交记录落库（status=PENDING，一人一条）',
      !!sub && sub.status === 'PENDING' && db.homework_submit.filter(x => x.homework_id === hw1 && x.member_id === 11).length === 1);
    check('S4.7 SUBMIT 文件记录 1 条',
      db.homework_file.filter(f => f.homework_id === hw1 && f.member_id === 11 && f.kind === 'SUBMIT').length === 1);

    // 覆盖重交：旧文件应被 deleteFile 删除，记录仍唯一
    deleteCalls.length = 0;
    const oldFileId = db.homework_file.find(f => f.homework_id === hw1 && f.member_id === 11 && f.kind === 'SUBMIT').file_id;
    r = await call('submit', { homeworkId: hw1, files: [img('作业图2.jpg')] }, OC_A);
    check('S4.8 覆盖重交成功', r.errCode === 0, r.errCode + '/' + r.errMsg);
    check('S4.9 覆盖重交删掉旧云存储文件（deleteFile 命中旧 fileId）',
      deleteCalls.some(list => list.indexOf(oldFileId) >= 0), JSON.stringify(deleteCalls));
    check('S4.10 覆盖重交后文件记录仍唯一、submit 仍一条',
      db.homework_file.filter(f => f.homework_id === hw1 && f.member_id === 11 && f.kind === 'SUBMIT').length === 1
      && db.homework_submit.filter(x => x.homework_id === hw1 && x.member_id === 11).length === 1);

    r = await call('submit', { homeworkId: hw1, files: [img('越组.jpg')] }, OC_B);
    check('S4.11 B 组学生提交 A 组作业被拒（40003）', r.errCode === 40003 && r.errMsg === '该作业未要求你所在分组提交');

    r = await call('submit', { homeworkId: hw3, files: [doc('迟交.pdf')] }, OC_A);
    check('S4.12 已截止作业提交被拒（作业已截止，无法提交）',
      r.errCode === 41001 && r.errMsg === '作业已截止，无法提交', r.errCode + '/' + r.errMsg);

    // 打回豁免：先造一条 REJECT 记录，截止后仍允许重交
    db.homework_submit.push({ id: nextId('homework_submit'), class_id: 1, homework_id: hw3, member_id: 11, status: 'REJECT', remark: '回去重做', submitted_at: FIXED_TS, updated_at: FIXED_TS });
    r = await call('submit', { homeworkId: hw3, files: [doc('返工.pdf')] }, OC_A);
    sub = db.homework_submit.find(x => x.homework_id === hw3 && x.member_id === 11);
    check('S4.13 被打回（REJECT）的作业截止后仍可重交，且状态回 PENDING',
      r.errCode === 0 && sub.status === 'PENDING', r.errCode + '/' + r.errMsg + ' status=' + (sub && sub.status));

    r = await call('submit', { homeworkId: hw2, files: [] }, OC_A);
    check('S4.14 NONE 要求·空文件纯文字提交成功', r.errCode === 0 && !!db.homework_submit.find(x => x.homework_id === hw2 && x.member_id === 11));

    r = await call('submit', { homeworkId: hw1, files: [img('图1.jpg'), img('图2.jpg'), img('图3.jpg'), img('图4.jpg')] }, OC_A);
    check('S4.15 超过 maxImages=3 被拒（最多上传 3 张图片）', r.errCode === 41001 && r.errMsg === '最多上传 3 张图片', r.errMsg);

    // ---- SELF「仅自己」：发布者本人提交（用户自测场景：自己发布→自己提交） ----
    r = await call('submit', { homeworkId: hw6, files: [img('自测图.jpg')] }, OC_A);
    check('S4.16 学生A 提交他人「仅自己」作业被拒（40003）', r.errCode === 40003 && r.errMsg === '该作业未要求你所在分组提交');

    r = await call('submit', { homeworkId: hw6, files: [] }, OC_C);
    check('S4.17 发布者本人·IMAGE 要求·空文件仍被类型校验拦（本作业要求至少上传 1 张图片）',
      r.errCode === 41001 && r.errMsg === '本作业要求至少上传 1 张图片', r.errCode + '/' + r.errMsg);

    r = await call('submit', { homeworkId: hw6, files: [img('自测作业图.jpg')] }, OC_C);
    check('S4.18 发布者本人提交自己的「仅自己」作业成功（自己发布→自己提交闭环）',
      r.errCode === 0 && !!db.homework_submit.find(x => x.homework_id === hw6 && x.member_id === 10),
      r.errCode + '/' + r.errMsg);

    r = await call('submit', { homeworkId: hw7, files: [] }, OC_C);
    check('S4.19 A+SELF 组合作业·发布者本人（A 组）纯文字提交成功',
      r.errCode === 0 && !!db.homework_submit.find(x => x.homework_id === hw7 && x.member_id === 10));

    /* ---------- S5 review ---------- */
    console.log('\n== S5 review 批阅 ==');
    r = await call('review', { homeworkId: hw1, memberIds: [11], status: 'DONE', remark: '很好' }, OC_A);
    check('S5.1 学生批阅被拒（40003 仅班委可批阅作业）', r.errCode === 40003 && r.errMsg === '仅班委可批阅作业');

    r = await call('review', { homeworkId: hw1, memberIds: [11], status: 'DONE', remark: '完成得不错' }, OC_C);
    sub = db.homework_submit.find(x => x.homework_id === hw1 && x.member_id === 11);
    check('S5.2 班委批阅 DONE + remark 落库', r.errCode === 0 && sub.status === 'DONE' && sub.remark === '完成得不错',
      sub && sub.status + '/' + sub.remark);

    r = await call('review', { homeworkId: hw1, memberIds: [11], status: 'MAYBE' }, OC_C);
    check('S5.3 非法批阅状态被拒（未知的批阅状态）', r.errCode === 41001 && r.errMsg === '未知的批阅状态');

    r = await call('review', { homeworkId: 99999, memberIds: [11], status: 'DONE' }, OC_C);
    check('S5.4 批阅不存在的作业被拒（作业不存在）', r.errCode === 41001 && r.errMsg === '作业不存在');

    r = await call('review', { homeworkId: hw2, memberIds: [11], status: 'REJECT', remark: '补图' }, OC_C);
    sub = db.homework_submit.find(x => x.homework_id === hw2 && x.member_id === 11);
    check('S5.5 REJECT 打回状态流转正确', r.errCode === 0 && sub.status === 'REJECT' && sub.remark === '补图');

    r = await call('review', { homeworkId: hw6, memberIds: [10], status: 'DONE', remark: '自测通过' }, OC_C);
    sub = db.homework_submit.find(x => x.homework_id === hw6 && x.member_id === 10);
    check('S5.6 班委批阅自己的「仅自己」提交（自己发布→提交→批阅全闭环）',
      r.errCode === 0 && sub.status === 'DONE' && sub.remark === '自测通过',
      r.errCode + '/' + r.errMsg + ' status=' + (sub && sub.status));

    /* ---------- S6 delete 删除（侧滑删除，2026-10-24 用户需求） ---------- */
    console.log('\n== S6 delete 删除 ==');
    // 权限：普通成员不能删（连别人的作业都看不着）
    r = await call('delete', { homeworkId: hw1 }, OC_A);
    check('S6.1 普通成员删他人作业被拒（40003 只有发布者或超管可以删除作业）',
      r.errCode === 40003 && r.errMsg === '只有发布者或超管可以删除作业', r.errCode + '/' + r.errMsg);

    r = await call('delete', { homeworkId: 99999 }, OC_C);
    check('S6.2 删不存在的作业被拒（41001 作业不存在）',
      r.errCode === 41001 && r.errMsg === '作业不存在', r.errCode + '/' + r.errMsg);

    // hw5（发布者=班委本人，带 1 个 ATTACH）：发布者本人删 → 级联清 + 云存储删
    deleteCalls.length = 0;
    r = await call('delete', { homeworkId: hw5 }, OC_C);
    check('S6.3 发布者删自己的作业成功',
      r.errCode === 0 && r.data && r.data.id === hw5, JSON.stringify(r));
    check('S6.4 级联清空：homework / homework_file / homework_submit 无残留',
      !db.homework.some(h => h.id === hw5)
      && !db.homework_file.some(f => f.homework_id === hw5)
      && !db.homework_submit.some(s => s.homework_id === hw5),
      'hw=' + db.homework.filter(h => h.id === hw5).length
      + ' file=' + db.homework_file.filter(f => f.homework_id === hw5).length
      + ' sub=' + db.homework_submit.filter(s => s.homework_id === hw5).length);
    check('S6.5 云存储文件被删（cloud.deleteFile 收到 fileList）',
      deleteCalls.some(l => l.length >= 1), JSON.stringify(deleteCalls));

    // 删完再删一次 → 作业不存在（幂等语义：第二次走不存在分支）
    r = await call('delete', { homeworkId: hw5 }, OC_C);
    check('S6.6 重复删除被拒（41001 作业不存在）',
      r.errCode === 41001 && r.errMsg === '作业不存在', r.errCode + '/' + r.errMsg);

    /* ---------- 汇总 ---------- */
    console.log('\n==============================');
    console.log('作业全链路（publish/list/detail/submit/review/delete） 通过=' + pass + ' 失败=' + fail);
    if (fail > 0) {
      console.log('失败项: ' + failed.join(' / '));
      process.exit(1);
    }
    console.log('全绿');
    process.exit(0);
  } catch (e) {
    console.error('[check-homework-flow] 运行异常:', e);
    process.exit(1);
  }
})();
