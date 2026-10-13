/**
 * 离线复刻 schedule.generate 的「按序号连续轮转」算法，为第 2 周生成值日 SQL。
 * ⚠️ 线上已有 UI「一键生成」（schedule.generate），本脚本仅作兜底 / 回溯校验用。
 * 规则（与 cloudfunctions/schedule/index.js 的 rotationPick 一致）：
 *  - 序号 = 学号后两位；A组课排奇数号、B组课排偶数号、全体课跨组按序号合并轮转
 *  - 排序 = (本轮已排次数 ASC, 序号 ASC)；排完最大序号后自动开新一轮（标记清零）
 *  - 当日不重复；法定假日当天不上课，不排值日
 *  - 2026-09-25 起为中秋节法定假期 → 第 2 周周五不上课
 */
const fs = require('fs');

const week = 2;
const termStart = '2026-09-14';
const DAY_MS = 86400000;
const HOLIDAYS = ['2026-09-25', '2026-09-26', '2026-09-27'];

function classDateOf(dow) {
  const base = new Date(termStart + 'T00:00:00+08:00').getTime();
  const ms = base + ((week - 1) * 7 + (dow - 1)) * DAY_MS;
  // 与云函数 week.fmtDate 一致：+8h 抵消 toISOString 的 UTC 回拨，避免少一天
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const isHoliday = d => HOLIDAYS.indexOf(d) >= 0;

// 56 名 ACTIVE 成员（id = 12 + 序号，tail = 学号后两位 = 名册序号）
const members = [];
for (let seq = 1; seq <= 56; seq++) {
  members.push({ id: 12 + seq, seq, tail: seq, g: seq % 2 === 1 ? 'A' : 'B', mark: 0 });
}
// 用户指定：本轮跳过 05 示例成员05 / 07 示例成员07
[5, 7].forEach(seq => { members[seq - 1].mark = 1; });

// 第 2 周生效的课次（已按更正后的课表；周五为中秋假期，整日不上课）
const sessions = [
  { id: 2, dow: 1, per: 2, grp: 'A' },    // 微课 示例老师02 a组（周一第二节）
  { id: 5, dow: 1, per: 3, grp: null },   // 习思想 示例老师03 全体
  { id: 3, dow: 1, per: 4, grp: 'B' },    // 微课 示例老师02 1-8周 b组
  { id: 8, dow: 2, per: 1, grp: 'A' },    // 小学AI 示例老师05 a组
  { id: 10, dow: 2, per: 2, grp: null },  // 数学 示例老师06 1-4周 全体
  { id: 22, dow: 2, per: 5, grp: 'A' },   // 三笔字 示例老师07 a组
  { id: 9, dow: 3, per: 1, grp: 'B' },    // 小学AI 示例老师05 b组
  { id: 13, dow: 3, per: 3, grp: 'A' },   // 心理 示例老师08 双周 a组
  { id: 14, dow: 3, per: 4, grp: 'B' },   // 心理 示例老师08 双周 b组（周三第四节）
  { id: 15, dow: 3, per: 5, grp: 'A' },   // 音乐 示例老师09 a组
  { id: 17, dow: 4, per: 2, grp: null },  // 语文 示例老师06 1-4周 全体
  { id: 16, dow: 4, per: 5, grp: 'B' }    // 音乐 示例老师09 b组
].sort((a, b) => a.dow - b.dow || a.per - b.per);

const duties = [];
const byDate = {};

for (const s of sessions) {
  const cd = classDateOf(s.dow);
  if (isHoliday(cd)) continue;
  const busy = byDate[cd] || new Set();
  const ok = m => (!s.grp || m.g === s.grp) && !busy.has(m.id);
  let avail = members.filter(ok).sort((a, b) => (a.mark - b.mark) || (a.seq - b.seq));
  if (avail.filter(m => m.mark === 0).length < 2 && members.some(m => m.mark > 0)) {
    members.forEach(m => { m.mark = 0; });
    avail = members.filter(ok).sort((a, b) => (a.mark - b.mark) || (a.seq - b.seq));
  }
  const chosen = avail.slice(0, 2);
  chosen.forEach(m => { m.mark += 1; busy.add(m.id); });
  byDate[cd] = busy;
  chosen.forEach(m => duties.push({ session_id: s.id, week, class_date: cd, member_id: m.id }));
}

const rows = duties.map(d => `(${d.session_id}, ${d.week}, '${d.class_date}', ${d.member_id}, 'PENDING', 'MANUAL')`).join(',\n');
const dutySql = `INSERT INTO duty (session_id, week, class_date, member_id, status, source) VALUES\n${rows};`;

const cases = members.map(m => `WHEN ${m.id} THEN ${m.mark}`).join(' ');
const ids = members.map(m => m.id).join(', ');
const updSql = `UPDATE member SET duty_count = CASE id ${cases} END WHERE id IN (${ids});`;

fs.writeFileSync('scripts/week2-duty.sql', dutySql + '\n\n' + updSql + '\n');

console.log('week2 duties:', duties.length, '（第 2 周周五 2026-09-25 中秋节放假，不上课）');
console.log('by date:');
const out = {};
duties.forEach(d => { (out[d.class_date] = out[d.class_date] || []).push(d.member_id); });
Object.keys(out).sort().forEach(d => console.log(' ', d, '->', out[d].join(',')));
