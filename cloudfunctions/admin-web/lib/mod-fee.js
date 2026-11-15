/**
 * 班费 / 团费（模块：fee）· 2026-11-15 新增
 * ============================================================
 * 与小程序 `cloudfunctions/fee` 共用同一套表与同一套口径：
 *   · `class_fund`        每班每类一行：total（总额）
 *   · `class_fund_record` 消费流水：amount / note / images(JSON fileID 数组) / operator / created_at
 *   · **余额不落库**：balance = total − SUM(amount)，运行时算 —— 所以「改/删一条记录」立即反映到余额，
 *     不需要任何补偿写。这一点必须与小程序保持一致，否则两边显示的余额会不一样。
 *
 * 与小程序**故意不同的一处**：后台删除只删数据库行，**不删云存储里的凭证图**。
 *   小程序删除会 `cloud.deleteFile` 连带删图，删完无法恢复（2026-11-15 已发生过一次误删，
 *   两张凭证救不回来）。后台是管理视角、且这里没有 tcb SDK 调不了删除接口，
 *   所以留图当作证据；真要清理由运维按 fileID 处理。
 *   审计 detail 里会记下这条记录原本有几张图、fileID 是什么。
 *
 * 凭证图怎么在网页里显示：存储桶 ACL = 所有用户可读（2026-11-15 实测），
 *   所以 `cloud://<env>.<bucket>/<path>` 可以直接换算成
 *   `https://<bucket>.tcb.qcloud.la/<path>` 用 <img> 打开，**不需要 tcb SDK、不需要签名**。
 *   ⚠️ 若将来把桶改成私有读，这里会全部裂图 —— 那时只能加 SDK 换临时 URL。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { logAction } = require('./audit');

const TYPES = ['class', 'league'];
const MAX_IMAGES = 9;
const MAX_NOTE = 200;
const MAX_AMOUNT = 1000000;   // 与 cloudfunctions/fee 的 MAX_AMOUNT 保持一致

/** fileID → 公网可访问 URL（存储桶为「所有用户可读」时成立，见文件头注释） */
function fileUrl(fid) {
  const s = String(fid || '');
  const m = /^cloud:\/\/([^/]+)\/(.+)$/.exec(s);
  if (!m) return '';
  const seg = m[1].split('.');
  const bucket = seg.length > 1 ? seg[seg.length - 1] : seg[0];
  return 'https://' + bucket + '.tcb.qcloud.la/' + m[2];
}

/** images 列是 JSON，mysql2 可能给字符串、数组或 null —— 三种都要认 */
function normImages(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x);
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : [];
  } catch (e) {
    return [];
  }
}

function toStr(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate()) +
      ' ' + p(v.getHours()) + ':' + p(v.getMinutes()) + ':' + p(v.getSeconds());
  }
  return String(v).slice(0, 19).replace('T', ' ');
}

function normType(t) {
  const s = String(t || '');
  if (TYPES.indexOf(s) < 0) throw new BizError(40001, '经费类型必须是 class 或 league');
  return s;
}

function normAmount(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) throw new BizError(40001, '金额须大于 0');
  if (n > MAX_AMOUNT) throw new BizError(40001, '金额过大');
  return Math.round(n * 100) / 100;
}

/**
 * 班费 / 团费总览：两类各自的总额、已消费、余额，以及最近 200 条流水。
 * @param {{classId:number}} q
 */
async function getFund(q = {}) {
  const classId = Number(q.classId);
  if (!classId) throw new BizError(40001, '缺少班级');
  const pool = getPool();

  const [funds] = await pool.query(
    'SELECT type, total FROM class_fund WHERE class_id = ?', [classId]
  );
  const totalOf = {};
  funds.forEach((f) => { totalOf[f.type] = Number(f.total) || 0; });

  // ⚠️ 用 class_id + type 精确取，并显式 ORDER BY 时间倒序 —— 与小程序 loadRecords 同口径，
  //    否则两边列表顺序不一致（小程序按 created_at DESC, id DESC）。
  const [rows] = await pool.query(
    'SELECT id, type, amount, note, images, operator_id, operator_name, created_at ' +
    'FROM class_fund_record WHERE class_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
    [classId]
  );

  const out = {};
  TYPES.forEach((t) => { out[t] = { type: t, total: totalOf[t] || 0, spent: 0, balance: 0, records: [] }; });
  rows.forEach((r) => {
    const t = TYPES.indexOf(r.type) >= 0 ? r.type : 'class';
    const imgs = normImages(r.images);
    const amount = Number(r.amount) || 0;
    out[t].records.push({
      id: Number(r.id),
      amount,
      note: r.note || '',
      images: imgs.map((fid) => ({ fid, url: fileUrl(fid) })),
      imageCount: imgs.length,
      operatorId: Number(r.operator_id) || 0,
      operatorName: r.operator_name || '',
      createdAt: toStr(r.created_at)
    });
    out[t].spent += amount;
  });
  TYPES.forEach((t) => {
    out[t].spent = Math.round(out[t].spent * 100) / 100;
    out[t].balance = Math.round((out[t].total - out[t].spent) * 100) / 100;
  });

  return { classId, funds: out, maxAmount: MAX_AMOUNT, maxImages: MAX_IMAGES };
}

/** 设置总额（余额自动联动，因为余额是算出来的） */
async function saveTotal(payload, session, req) {
  const classId = Number(payload.classId);
  if (!classId) throw new BizError(40001, '缺少班级');
  const type = normType(payload.type);
  const total = Number(payload.total);
  if (!isFinite(total) || total < 0) throw new BizError(40001, '总额须为不小于 0 的数字');
  if (total > MAX_AMOUNT) throw new BizError(40001, '总额过大');

  const pool = getPool();
  const [old] = await pool.query('SELECT total FROM class_fund WHERE class_id = ? AND type = ?', [classId, type]);
  const before = old[0] ? Number(old[0].total) : 0;

  await pool.query(
    'INSERT INTO class_fund (class_id, type, total) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE total = ?',
    [classId, type, total, total]
  );

  await logAction(session, {
    module: 'fee',
    action: 'fee.setTotal',
    classId,
    summary: (type === 'league' ? '团费' : '班费') + '总额 ' + before + ' → ' + total,
    detail: { classId, type, before, after: total }
  }, req);

  return { classId, type, total };
}

/** 新增一条消费（后台代登记；凭证图需在小程序里追加，这里只记文字/金额） */
async function addRecord(payload, session, req) {
  const classId = Number(payload.classId);
  if (!classId) throw new BizError(40001, '缺少班级');
  const type = normType(payload.type);
  const amount = normAmount(payload.amount);
  const note = String(payload.note || '').slice(0, MAX_NOTE);
  const createdAt = String(payload.createdAt || '').trim();
  if (createdAt && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(createdAt)) {
    throw new BizError(40001, '时间格式应为 YYYY-MM-DD HH:MM');
  }

  const pool = getPool();
  const operatorId = Number((session && session.memberId) || 0) || 0;
  const operatorName = String((session && session.memberName) || '网页后台').slice(0, 60);

  const [r] = await pool.query(
    'INSERT INTO class_fund_record (class_id, type, amount, note, images, operator_id, operator_name, created_at) ' +
    'VALUES (?, ?, ?, ?, JSON_ARRAY(), ?, ?, ' + (createdAt ? '?' : 'NOW()') + ')',
    createdAt
      ? [classId, type, amount, note, operatorId, operatorName, createdAt.length === 10 ? createdAt + ' 00:00:00' : (createdAt.length === 16 ? createdAt + ':00' : createdAt)]
      : [classId, type, amount, note, operatorId, operatorName]
  );

  await logAction(session, {
    module: 'fee',
    action: 'fee.addRecord',
    classId,
    summary: '后台登记' + (type === 'league' ? '团费' : '班费') + '消费 ¥' + amount + (note ? '（' + note + '）' : ''),
    detail: { classId, type, id: r.insertId, amount, note, createdAt: createdAt || '(服务器当前时间)' }
  }, req);

  return { id: r.insertId };
}

/** 修改一条消费（金额 / 备注 / 时间）—— 余额是算出来的，改完立即联动 */
async function updateRecord(payload, session, req) {
  const id = Number(payload.id);
  if (!id) throw new BizError(40001, '缺少记录 id');
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT id, class_id, type, amount, note, created_at FROM class_fund_record WHERE id = ?', [id]
  );
  if (!rows[0]) throw new BizError(40404, '消费记录不存在');
  const old = rows[0];

  const amount = payload.amount === undefined ? Number(old.amount) : normAmount(payload.amount);
  const note = payload.note === undefined ? String(old.note || '') : String(payload.note || '').slice(0, MAX_NOTE);
  let createdAt = old.created_at;
  if (payload.createdAt !== undefined) {
    const s = String(payload.createdAt || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(s)) throw new BizError(40001, '时间格式应为 YYYY-MM-DD HH:MM');
    createdAt = s.length === 10 ? s + ' 00:00:00' : (s.length === 16 ? s + ':00' : s);
  }

  await pool.query(
    'UPDATE class_fund_record SET amount = ?, note = ?, created_at = ? WHERE id = ?',
    [amount, note, createdAt, id]
  );

  await logAction(session, {
    module: 'fee',
    action: 'fee.updateRecord',
    classId: Number(old.class_id),
    summary: '修改消费记录 #' + id + '（¥' + Number(old.amount) + ' → ¥' + amount + '）',
    detail: {
      id,
      classId: Number(old.class_id),
      before: { amount: Number(old.amount), note: old.note, createdAt: toStr(old.created_at) },
      after: { amount, note, createdAt: toStr(createdAt) }
    }
  }, req);

  return { id, amount, note };
}

/**
 * 删除一条消费。**只删数据库行，不动云存储**（见文件头）。
 * 审计里保留原图 fileID 列表 —— 万一以后要找回来，至少还有线索。
 */
async function deleteRecord(payload, session, req) {
  const id = Number(payload.id);
  if (!id) throw new BizError(40001, '缺少记录 id');
  const pool = getPool();
  const [rows] = await pool.query(
    'SELECT id, class_id, type, amount, note, images, operator_name, created_at FROM class_fund_record WHERE id = ?', [id]
  );
  if (!rows[0]) throw new BizError(40404, '消费记录不存在');
  const old = rows[0];
  const imgs = normImages(old.images);

  await pool.query('DELETE FROM class_fund_record WHERE id = ?', [id]);

  await logAction(session, {
    module: 'fee',
    action: 'fee.deleteRecord',
    classId: Number(old.class_id),
    summary: '删除' + (old.type === 'league' ? '团费' : '班费') + '消费 #' + id +
      '（¥' + Number(old.amount) + (old.note ? '，' + old.note : '') + '）',
    detail: {
      id,
      classId: Number(old.class_id),
      type: old.type,
      amount: Number(old.amount),
      note: old.note,
      createdAt: toStr(old.created_at),
      // 关键：这些图**仍然在云存储里**（后台不删文件），记下来便于事后核对
      imagesKept: imgs
    }
  }, req);

  return { id, imageCount: imgs.length, imagesKept: imgs };
}

/** 从某条记录里摘掉一张凭证图（只改数据库数组，文件仍留在云存储） */
async function removeImage(payload, session, req) {
  const id = Number(payload.id);
  const fid = String(payload.fid || '');
  if (!id || !fid) throw new BizError(40001, '参数不完整');
  const pool = getPool();
  const [rows] = await pool.query('SELECT id, class_id, images FROM class_fund_record WHERE id = ?', [id]);
  if (!rows[0]) throw new BizError(40404, '消费记录不存在');
  const list = normImages(rows[0].images);
  const next = list.filter((x) => x !== fid);
  if (next.length === list.length) throw new BizError(40001, '该记录里没有这张图');

  await pool.query('UPDATE class_fund_record SET images = ? WHERE id = ?', [JSON.stringify(next), id]);

  await logAction(session, {
    module: 'fee',
    action: 'fee.removeImage',
    classId: Number(rows[0].class_id),
    summary: '从消费 #' + id + ' 移除 1 张凭证图（' + list.length + ' → ' + next.length + '）',
    detail: { id, fid, kept: next.length }
  }, req);

  return { id, kept: next.length };
}

module.exports = { getFund, saveTotal, addRecord, updateRecord, deleteRecord, removeImage, fileUrl };
