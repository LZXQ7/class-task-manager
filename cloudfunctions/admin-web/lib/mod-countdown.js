/**
 * 倒数日（模块：countdown）· 2026-11-15 新增 · **只读**
 * ============================================================
 * 倒数日是小程序里的「个人本地记录」：`countdown_event` 只绑 member_id，不绑 class_id
 * （历史设计：每个人自己的日子，别人看不见）。
 * 用户诉求是「后台能看见谁添加了什么日子」—— 属于**知情**，不是代管，
 * 所以这里**只提供查询，不提供增删改**（后台改别人的私人日子没有意义，也容易误删）。
 *
 * 按班级过滤要靠 JOIN member 拿 class_id（表本身没有这个列）。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');

async function listCountdown(q) {
  const pool = getPool();
  const classId = Number(q.classId);
  if (!classId) throw new BizError(40001, '缺少班级');

  const where = ['m.class_id = ?'];
  const args = [classId];
  const kw = String(q.keyword || '').trim();
  if (kw) {
    where.push('(ce.name LIKE ? OR m.name LIKE ?)');
    args.push('%' + kw + '%', '%' + kw + '%');
  }
  const W = where.join(' AND ');

  const [rows] = await pool.query(
    'SELECT ce.id, ce.name, ce.target_date, ce.created_at, ce.member_id, ' +
    'm.name AS member_name, m.student_no, m.group_tag, m.position, ' +
    'DATEDIFF(ce.target_date, CURDATE()) AS days_left ' +
    'FROM countdown_event ce JOIN member m ON m.id = ce.member_id ' +
    'WHERE ' + W + ' ORDER BY ce.target_date ASC, ce.id ASC',
    args
  );

  const today = rows.filter((r) => Number(r.days_left) === 0).length;
  const upcoming = rows.filter((r) => Number(r.days_left) > 0).length;

  return {
    total: rows.length,
    todayCount: today,
    upcomingCount: upcoming,
    items: rows.map((r) => ({
      id: r.id,
      name: r.name,
      targetDate: String(r.target_date).slice(0, 10),
      createdAt: r.created_at ? String(r.created_at).slice(0, 16) : '',
      memberId: r.member_id,
      memberName: r.member_name || '—',
      studentNo: r.student_no || '',
      groupTag: r.group_tag || '',
      position: r.position || '',
      daysLeft: Number(r.days_left),
      // 负数 = 已经过去（还留在列表里没删）。前端灰显，不强调。
      past: Number(r.days_left) < 0
    }))
  };
}

module.exports = { listCountdown };
