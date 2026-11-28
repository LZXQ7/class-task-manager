/**
 * 课前演讲（模块：speech）· 2026-11-28 新增
 * ============================================================
 * 后台提供两件事：**只读查看** 本周演讲名单/场次/发布态/游标，**发布/撤回**。
 *
 * 一致性铁律（M1 同源漏改）：
 *   · 发布/撤回不在这里自造游标逻辑，统一调 common/speech-core.js 的 publishWeek ——
 *     与小程序 schedule.speechPublish 同一份真源。后台撤回会回滚 speech_cursor、
 *     旧记录兼容 pending_cursors，行为与小程序端逐字一致。
 *   · 名单出场序按 sp.id（轮转序），不按 student_no（回绕场景 56→2 会被翻成 2→56）。
 *   · 学生标识只暴露「姓名 + 学号尾 2 位」，完整学号不下发后台。
 *
 * 后台是管理岗视角：草稿（DRAFT）也可见（小程序端对普通成员隐藏草稿），
 * 这样老师能在发布前核对名单。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { NOT_TEST } = require('../common/test-account');
const week = require('../common/week');
const speechCore = require('../common/speech-core');
const { logAction } = require('./audit');

/** 周几中文（class_date 由 SQL 算 DAYNAME 不稳定，这里用 JS） */
const WD = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 只读：本周演讲名单 + 发布态 + 双游标 + 设置。
 * @param q { classId, week }
 */
async function listSpeech(q) {
  const pool = getPool();
  const classId = Number(q.classId);
  const wk = Number(q.week);
  if (!classId) throw new BizError(40001, '缺少班级');
  if (!wk) throw new BizError(40001, '缺少周次');

  /* ① 发布态 */
  const [pubRows] = await pool.query(
    'SELECT status, published_at, published_by FROM speech_publish WHERE class_id = ? AND week = ?',
    [classId, wk]
  );
  const pub = pubRows[0] || null;
  const published = !!(pub && pub.status === 'PUBLISHED');

  /* ② 本周演讲人（出场序 sp.id，组内不按学号重排）。
   *    学号只取尾 2 位（RIGHT），full student_no 绝不下发。 */
  const [rows] = await pool.query(
    `SELECT sp.id, sp.class_date, sp.slot, sp.scope, sp.member_id, sp.source, sp.status AS sp_status,
            m.name, RIGHT(m.student_no, 2) AS studentNoTail, m.group_tag
       FROM speech sp LEFT JOIN member m ON m.id = sp.member_id
      WHERE sp.class_id = ? AND sp.week = ? AND sp.status <> 'SWAPPED_OUT' AND ` + NOT_TEST('m') + `
      ORDER BY sp.class_date, sp.slot, sp.id`,
    [classId, wk]
  );

  /* ③ 双游标诊断（A/B 当前值） */
  const [curRows] = await pool.query(
    'SELECT grp, cursor_val FROM speech_cursor WHERE class_id = ?', [classId]
  );
  const cursor = { A: 0, B: 0 };
  curRows.forEach((c) => { if (c.grp === 'A' || c.grp === 'B') cursor[c.grp] = Number(c.cursor_val) || 0; });

  /* ④ 设置（每场人数规则，只读展示） */
  const [setRows] = await pool.query(
    'SELECT need_n, start_weekday, start_slot, slot_rules FROM speech_setting WHERE class_id = ?', [classId]
  );
  const setting = setRows[0] || null;

  const items = rows.map((r) => {
    const d = r.class_date ? new Date(r.class_date) : null;
    const scope = r.scope === 'A' ? 'A' : (r.scope === 'B' ? 'B' : 'ALL');
    return {
      id: r.id,
      memberId: r.member_id,
      name: r.name || '—',
      studentNoTail: r.studentNoTail || '',
      groupTag: r.group_tag || '',
      date: r.class_date ? String(r.class_date).slice(0, 10) : '',
      weekday: d ? '周' + WD[d.getDay()] : '',
      slot: r.slot === 'AM' ? 'AM' : 'PM',
      slotText: r.slot === 'AM' ? '上午 · 课前 08:00-08:10' : '下午 · 课前 14:30-14:40',
      scope,
      source: r.source === 'MANUAL' ? 'MANUAL' : 'AUTO',
      status: r.sp_status === 'SWAPPED_OUT' ? 'SWAPPED_OUT' : 'PENDING'
    };
  });

  const people = new Set();
  items.forEach((it) => people.add(it.memberId));
  const sessions = new Set();
  items.forEach((it) => sessions.add(it.date + '|' + it.slot + '|' + it.scope));

  return {
    published,
    publishInfo: pub ? {
      status: pub.status,
      publishedAt: pub.published_at ? String(pub.published_at).slice(0, 16) : '',
      publishedBy: pub.published_by || 0
    } : { status: 'DRAFT', publishedAt: '', publishedBy: 0 },
    cursor,
    setting: setting ? {
      needN: Number(setting.need_n) || 2,
      startWeekday: Number(setting.start_weekday) || 0,
      startSlot: setting.start_slot || '',
      slotRules: setting.slot_rules || ''
    } : null,
    items,
    stats: { total: items.length, people: people.size, sessions: sessions.size }
  };
}

/**
 * 写：发布 / 撤回（共用 speech-core.publishWeek）。
 * @param q { classId, week, status }
 * @param session 后台会话（审计用）
 * @param req Express 请求（IP 审计）
 */
async function publishWeek(q, session, req) {
  const pool = getPool();
  const classId = Number(q.classId);
  const wk = Number(q.week);
  const status = q.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED';
  if (!classId || !wk) throw new BizError(40001, '参数错误');

  const result = await speechCore.publishWeek(pool, {
    classId, week: wk, status,
    actorId: session.memberId,
    now: week.nowStamp
  });

  await logAction(session, {
    module: 'speech',
    action: status === 'PUBLISHED' ? 'publish' : 'withdraw',
    classId,
    summary: (status === 'PUBLISHED' ? '发布' : '撤回') + '第 ' + wk + ' 周课前演讲排班',
    detail: { week: wk, status }
  }, req);

  return result;
}

module.exports = { listSpeech, publishWeek };
