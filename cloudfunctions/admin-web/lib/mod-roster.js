/**
 * 成员名单导入（模块：roster）· 2026-11-16
 * ============================================================
 * 用户口径：「账号班级增加可添加班级、上传成员名单等功能，和小程序上传成员名单规则一样
 *   甚至适配更多格式。自适应格式最好，智能识别自动识别。字段识别，一般情况一行里面包含
 *   学号和姓名，只是有的学号在前面姓名在后面、有的学号在后面姓名在前面等多种样子。」
 *
 * 与小程序的分工：
 *   · 解析规则**同一套**（学号/姓名按内容识别，不看列序），见 common/roster-parse.js；
 *   · 小程序只能传单个表格 + 全站分流（按班级标签自动分到各班），
 *     后台是**先选定班级再导入**，所以不做班级分流，只吃学号/姓名/序号；
 *   · 后台额外支持：多工作表 xlsx、CSV/TXT（UTF-8 或 GBK）、直接粘贴文本、单空格分隔、
 *     学号与姓名粘连、字母数字混合工号 —— 都写在 roster-parse.js 的注释里。
 *
 * 🔴 两条硬约束（改之前先读）：
 *   ① **预览与写入必须用同一份解析结果**：commit 不信任前端回传的行，
 *      自己重新解码 + 重新解析 —— 否则前端可以塞一个不在名单里的学号进来。
 *   ② 跨班同学号一律拒绝（member.student_no 全库 UNIQUE）：
 *      绝不允许「导入把别的班的人悄悄搬过来」，那会让值日与请假历史挂错班。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { NOT_TEST } = require('../common/test-account');
const { logAction } = require('./audit');
const R = require('../common/roster-parse');
const { parseXlsx, sheetToText } = require('../common/xlsx-lite');

/** 原始文件上限：4MB（base64 后约 5.4MB，仍低于 express.json 的 4mb 之外的网关限制） */
const MAX_FILE = 4 * 1024 * 1024;
/** 单次写入上限：防一次导入把云函数拖到超时（20s） */
const MAX_ROWS = 800;

/**
 * 从请求体取出名单文本。
 * 支持三种入参（优先级从高到低）：
 *   { text }                      直接粘贴 / 前端已解出的文本
 *   { base64, filename }          浏览器 FileReader 的 dataURL 或裸 base64
 * @returns {{text:string, source:string, sheets?:number}}
 */
function textFromPayload(p) {
  const body = p || {};
  if (typeof body.text === 'string' && body.text.trim()) {
    return { text: body.text, source: 'text' };
  }
  const raw = String(body.base64 || body.dataUrl || '');
  if (!raw) throw new BizError(40001, '没有要导入的内容：请选择文件或粘贴名单');
  const b64 = raw.replace(/^data:[^,]*;base64,/, '');
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (e) { throw new BizError(40001, '文件内容无法解码，请重新选择文件'); }
  if (!buf.length) throw new BizError(40001, '文件是空的');
  if (buf.length > MAX_FILE) throw new BizError(40001, '文件过大（上限 4MB），请拆成多个文件导入');

  const filename = String(body.filename || '');
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;   // xlsx 是 zip，'PK'
  if (isZip || /\.(xlsx|xlsm)$/i.test(filename)) {
    let sheets;
    try {
      sheets = parseXlsx(buf);
    } catch (e) {
      throw new BizError(41002, '表格解析失败：' + String((e && e.message) || e).slice(0, 80) +
        '（请在 Excel 里另存为 .xlsx 或 .csv 再试）');
    }
    const texts = sheets.map((s) => sheetToText(s)).filter(Boolean);
    if (!texts.length) throw new BizError(41002, '表格里没有可读内容（是否只有一个空工作表？）');
    // 多工作表按顺序拼起来：一个班一个 sheet 的名单也能一次吃完
    return { text: texts.join('\n'), source: 'xlsx', sheets: texts.length };
  }
  if (/\.xls$/i.test(filename)) {
    throw new BizError(41002, '不支持旧版 .xls，请在 Excel 里「另存为 .xlsx 或 .csv」后再导入');
  }
  // 文本类：先按 UTF-8 解；出现替换符（U+FFFD）说明是 GBK 存量文件，再用 gbk 解一次
  let text = buf.toString('utf8');
  if (text.indexOf('\uFFFD') >= 0) {
    try {
      text = new TextDecoder('gbk').decode(buf);
    } catch (e) {
      console.error('[roster] gbk decode failed, keep utf8', e && e.message);
    }
  }
  return { text: text.replace(/^\uFEFF/, ''), source: 'text' };
}

/**
 * 各班可推导的学号前缀（只有序号、没有学号的名册用）。
 * 规则与小程序 `member.loadSeqPrefix` 完全一致：存量成员学号长度一致、前 N-2 位一致、末两位是数字。
 * ⚠️ 必须排除 X 组（教职工占位学号 STAFF…），否则前缀种类被顶成 2 → 整班判「不可推导」。
 * @returns {Map<number,{prefix:string,width:number}>}
 */
async function loadSeqPrefix(pool) {
  const map = new Map();
  const [rows] = await pool.query(
    'SELECT class_id, MIN(student_no) AS mn, COUNT(*) AS n, ' +
    'COUNT(DISTINCT LEFT(student_no,10)) AS pfx, COUNT(DISTINCT LENGTH(student_no)) AS lens ' +
    'FROM member WHERE ' + NOT_TEST('member') + " AND group_tag <> 'X' GROUP BY class_id"
  );
  rows.forEach((r) => {
    const mn = String(r.mn || '');
    if (Number(r.pfx) === 1 && Number(r.lens) === 1 && mn.length >= 5 && /^\d+$/.test(mn)) {
      map.set(Number(r.class_id), { prefix: mn.slice(0, mn.length - 2), width: 2 });
    }
  });
  return map;
}

/** 分批按学号取已存在成员（含跨班，用于判「已属别的班」） */
async function loadExisting(pool, studentNos) {
  const map = new Map();
  const list = studentNos.filter(Boolean);
  for (let i = 0; i < list.length; i += 400) {
    const chunk = list.slice(i, i + 400);
    if (!chunk.length) continue;
    const [rows] = await pool.query(
      'SELECT id, name, student_no, group_tag, class_id, status FROM member WHERE student_no IN (' +
      chunk.map(() => '?').join(',') + ')',
      chunk
    );
    rows.forEach((r) => map.set(String(r.student_no), r));
  }
  return map;
}

/**
 * 逐行判定「会新增 / 会改名 / 冲突 / 重复 / 缺学号」。
 * 判定全在内存里做完，预览与写入共用，所以预览看到的就是写入会做的。
 */
function classify(rows, existing, classId, seqPrefix) {
  const items = [];
  const seen = new Set();
  rows.forEach((r) => {
    let no = String(r.studentNo || '').trim();
    if (!no) {
      if (r.seq && seqPrefix) {
        no = R.studentNoFromSeq(r.seq, seqPrefix.prefix, seqPrefix.width);
      } else {
        items.push(Object.assign({}, r, {
          studentNo: '', op: 'need_no',
          reason: '只有序号、没有学号' + (seqPrefix ? '' : '（该班还没有可推导的学号前缀）')
        }));
        return;
      }
    }
    if (seen.has(no)) {
      items.push(Object.assign({}, r, { studentNo: no, op: 'dup', reason: '文件里学号重复，只处理第一条' }));
      return;
    }
    seen.add(no);
    const e = existing.get(no);
    if (!e) {
      items.push(Object.assign({}, r, { studentNo: no, op: 'create', groupTag: R.groupOf(no) }));
      return;
    }
    if (Number(e.class_id) !== Number(classId)) {
      items.push(Object.assign({}, r, {
        studentNo: no, op: 'conflict',
        reason: '该学号已属于其他班级（class ' + e.class_id + '：' + e.name + '）'
      }));
      return;
    }
    if (String(e.name) === String(r.name)) {
      items.push(Object.assign({}, r, { studentNo: no, op: 'same', memberId: e.id, reason: '姓名一致，无需改动' }));
      return;
    }
    items.push(Object.assign({}, r, {
      studentNo: no, op: 'update', memberId: e.id, oldName: e.name,
      reason: '改名：' + e.name + ' → ' + r.name
    }));
  });
  const summary = { create: 0, update: 0, same: 0, conflict: 0, dup: 0, need_no: 0 };
  items.forEach((it) => { summary[it.op] = (summary[it.op] || 0) + 1; });
  return { items, summary };
}

async function prepare(p, classId) {
  const pool = getPool();
  if (!classId) throw new BizError(40001, '缺少班级');
  const [cs] = await pool.query('SELECT id, name FROM `class` WHERE id = ? LIMIT 1', [classId]);
  if (!cs[0]) throw new BizError(40404, '班级不存在');

  const src = textFromPayload(p);
  const parsed = R.parseRoster(src.text);
  if (!parsed.rows.length) {
    return {
      classId, className: cs[0].name, source: src.source, sheets: src.sheets || 1,
      total: 0, items: [], failed: parsed.failed,
      summary: { create: 0, update: 0, same: 0, conflict: 0, dup: 0, need_no: 0 },
      hint: parsed.failed.length ? '没有解析出任何成员，请看下方失败行' : '文件里没有可识别的名单行（需要「学号 + 姓名」，或「序号 + 姓名」）'
    };
  }
  if (parsed.rows.length > MAX_ROWS) {
    throw new BizError(40001, '一次最多导入 ' + MAX_ROWS + ' 人（当前 ' + parsed.rows.length + ' 行），请拆分后重试');
  }
  const existing = await loadExisting(pool, parsed.rows.map((r) => r.studentNo).filter(Boolean));
  const prefixes = await loadSeqPrefix(pool);
  const seqPrefix = prefixes.get(Number(classId)) || null;
  const { items, summary } = classify(parsed.rows, existing, classId, seqPrefix);

  return {
    classId, className: cs[0].name,
    source: src.source, sheets: src.sheets || 1,
    total: parsed.rows.length,
    items,
    failed: parsed.failed,
    summary,
    seqPrefix: seqPrefix ? seqPrefix.prefix + '**' : ''
  };
}

/** 预览：只解析 + 判定，一个字都不写库 */
async function previewRoster(p) {
  return prepare(p, Number(p && p.classId));
}

/**
 * 正式导入：重新解析（不信任前端回传的行）→ 单事务写入 → 审计。
 * 只写 create（新增）与 update（改名）；same 跳过、conflict / dup / need_no 一律不动。
 */
async function commitRoster(p, session, req) {
  const classId = Number(p && p.classId);
  const plan = await prepare(p, classId);
  const todo = plan.items.filter((it) => it.op === 'create' || it.op === 'update');
  if (!todo.length) {
    return {
      created: 0, updated: 0,
      skipped: plan.items.length,
      summary: plan.summary, failed: plan.failed,
      message: '没有需要写入的成员（全部已存在或存在冲突）'
    };
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  let created = 0;
  let updated = 0;
  try {
    await conn.beginTransaction();
    for (const it of todo) {
      if (it.op === 'create') {
        await conn.query(
          'INSERT INTO member (class_id, name, student_no, group_tag, role, status) VALUES (?, ?, ?, ?, ?, ?)',
          [classId, it.name, it.studentNo, it.groupTag || R.groupOf(it.studentNo), 'MEMBER', 'ACTIVE']
        );
        created += 1;
      } else {
        // 只改姓名：分组、职位、角色、状态都是班里后来人工调过的，导入不该覆盖
        await conn.query('UPDATE member SET name = ? WHERE id = ?', [it.name, it.memberId]);
        updated += 1;
      }
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (e2) { console.error('[roster] rollback failed', e2 && e2.message); }
    throw new BizError(50001, '导入失败，已回滚：' + String((e && e.message) || e).slice(0, 120));
  } finally {
    try { conn.release(); } catch (e) { /* 连接已回收：忽略 */ }
  }

  await logAction(session, {
    module: 'member',
    action: 'member.import',
    classId,
    summary: '导入名单到 ' + plan.className + '：新增 ' + created + ' 人、改名 ' + updated +
      ' 人、跳过 ' + (plan.items.length - todo.length) + ' 行',
    // 只留足够复盘的信息，不把整份名单（含全部学号姓名）塞进审计
    detail: {
      className: plan.className, source: plan.source, sheets: plan.sheets,
      total: plan.total, created, updated,
      summary: plan.summary,
      failedCount: (plan.failed || []).length,
      createdNos: todo.filter((x) => x.op === 'create').slice(0, 20).map((x) => x.studentNo),
      updatedIds: todo.filter((x) => x.op === 'update').slice(0, 20).map((x) => x.memberId)
    }
  }, req);

  return {
    created, updated,
    skipped: plan.items.length - todo.length,
    summary: plan.summary,
    failed: plan.failed
  };
}

module.exports = { previewRoster, commitRoster, textFromPayload, loadSeqPrefix, classify };
