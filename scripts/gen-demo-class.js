#!/usr/bin/env node
/**
 * 生成「虚拟班级」全套演示数据的 SQL（不直连数据库，交给 run_sql_file.sh 灌）。
 * ============================================================
 * 背景（2026-10-28）：录制演示视频 / 对外演示时不能出现真实同学姓名与学号。
 * 故建一个独立班级，**所有数据全部虚构**：40 名虚构成员、8 门虚构课程、
 * 7 周值日轮转、3 条通知、班费 280 元与两笔支出。
 *
 * 设计要点：
 *  - invite_code = DEMO2605（独立口令，真实学生拿不到 → 不会误入）
 *  - 成员 #1「赵子涵」is_super = 1、role = ADMIN → 用他绑定即获得完整管理视角
 *  - 学号 0000000005xx 与真实班级的 0000000003xx 不重叠（student_no 全局唯一）
 *  - term_start 与真实班级一致（2026-09-14）→ 周次/日期与线上同频，值日页当天有数据
 *  - 只写 7 周值日（覆盖到当前周），不铺满 16 周——演示用不到，也省 DB 写入
 *
 * 用法：
 *   node scripts/gen-demo-class.js
 *   bash scripts/run_sql_file.sh scripts/demo-class.sql
 * 回滚：
 *   bash scripts/run_sql_file.sh scripts/demo-class-rollback.sql
 */
const fs = require('fs');
const path = require('path');

const INVITE = 'DEMO2605';
const JOIN_TOKEN = '900605';
const CLASS_NAME = '示例专业2605班（演示）';
const TERM_START = '2026-09-14';
const TOTAL_WEEKS = 16;
const MAIN_ROOM = '412';
const WEEKS_TO_SEED = 7;
const TODAY = '2026-10-28';

/* ---------------- 40 名虚构成员 ---------------- */
const NAMES = [
  '赵子涵', '钱雨桐', '孙嘉禾', '李思远', '周语嫣', '吴柏舟', '郑亦航', '王梓萱',
  '冯书言', '陈慕青', '褚星野', '卫清瑶', '蒋南栀', '沈亦舟', '韩知遥', '杨念初',
  '朱弈尘', '秦楚月', '尤见山', '许棠棠', '何绾绾', '吕照野', '施鹿鸣', '张听澜',
  '孔令仪', '曹望舒', '严既明', '华栖梧', '金砚舟', '魏澜清', '陶知夏', '姜屿白',
  '戚弦歌', '谢临川', '邹雁回', '喻观澜', '裴予安', '水云舒', '窦星阑', '章南风',
];
const STUDENT_PREFIX = '0000000005';

/** 角色：1 号真超管（演示用），2 号班长，3/7 号班委 */
const ROLE_OF = { 1: 'ADMIN', 2: 'MONITOR', 3: 'ADMIN', 7: 'ADMIN' };
const SUPER_SEQ = 1;

const members = NAMES.map((name, i) => {
  const seq = i + 1;
  return {
    seq,
    name,
    studentNo: STUDENT_PREFIX + String(seq).padStart(2, '0'),
    group: seq % 2 === 1 ? 'A' : 'B',
    role: ROLE_OF[seq] || 'MEMBER',
    isSuper: seq === SUPER_SEQ ? 1 : 0,
  };
});

/* ---------------- 8 门课程（教师姓名全虚构） ---------------- */
const COURSES = [
  { name: '小学语文教学法', teacher: '沈清和', room: '412', type: 'ALL', duty: 2 },
  { name: '教育心理学', teacher: '顾若宁', room: '412', type: 'ALL', duty: 2 },
  { name: '现代教育技术', teacher: '陆铭远', room: '机房302', type: 'ALL', duty: 2 },
  { name: '高等数学', teacher: '唐允之', room: '412', type: 'ALL', duty: 2 },
  { name: '大学英语', teacher: '温书瑶', room: '412', type: 'ALL', duty: 2 },
  { name: '教师口语训练', teacher: '白鹭', room: '微格205', type: 'GROUP', duty: 2 },
  { name: '三笔字训练', teacher: '江砚秋', room: '书法室', type: 'GROUP', duty: 2 },
  { name: '班级管理实务', teacher: '邵怀安', room: '412', type: 'ALL', duty: 2 },
  /* 保洁课次的宿主课程：session.course_id 是 NOT NULL，CLEAN 课次必须挂在它下面 */
  { name: '打扫412', teacher: null, room: '412', type: 'ALL', duty: 2, cleanHost: true },
];

const periodWeeks = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1).join(',');

/* 课次：{ day, period, course, group }  group = null 表示合班 */
const SESSIONS = [
  { day: 1, period: 1, course: '大学英语', group: null },
  { day: 1, period: 2, course: '小学语文教学法', group: null },
  { day: 1, period: 4, course: '教师口语训练', group: 'A' },
  { day: 1, period: 4, course: '教师口语训练', group: 'B' },
  { day: 2, period: 1, course: '教育心理学', group: null },
  { day: 2, period: 3, course: '三笔字训练', group: 'A' },
  { day: 2, period: 3, course: '三笔字训练', group: 'B' },
  { day: 2, period: 5, course: '班级管理实务', group: null },
  { day: 3, period: 2, course: '现代教育技术', group: null },
  { day: 3, period: 4, course: '高等数学', group: null },
  { day: 4, period: 1, course: '小学语文教学法', group: null },
  { day: 4, period: 3, course: '教师口语训练', group: 'A' },
  { day: 4, period: 3, course: '教师口语训练', group: 'B' },
  { day: 4, period: 5, course: '现代教育技术', group: null },
  { day: 5, period: 2, course: '班级管理实务', group: null },
  { day: 5, period: 4, course: '高等数学', group: null },
];

/* 每工作日一个「保洁课次」（CLEAN）＝ 18:10 打扫主教室 */
const CLEAN_DAYS = [1, 2, 3, 4, 5];

/* ---------------- 工具 ---------------- */
const DAY_MS = 86400000;
function classDate(week, day) {
  const base = new Date(TERM_START + 'T00:00:00+08:00').getTime();
  const ms = base + ((week - 1) * 7 + (day - 1)) * DAY_MS;
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const CLASS_ID = `(SELECT id FROM \`class\` WHERE invite_code = ${q(INVITE)} LIMIT 1)`;
const MEMBER_ID = (seq) => {
  const m = members[seq - 1];
  return `(SELECT id FROM member WHERE student_no = ${q(m.studentNo)} LIMIT 1)`;
};
const COURSE_ID = (name) =>
  `(SELECT id FROM course WHERE class_id = ${CLASS_ID} AND name = ${q(name)} LIMIT 1)`;

const out = [];
const push = (s) => out.push(s.replace(/\s+/g, ' ').trim());

/* ================= 0. 清理旧数据（可重复执行） ================= */
const cleanupStmts = [
  `DELETE FROM duty WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM session WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM course WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM duty_slot WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM schedule_rules WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM duty_week_cursor WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM notice_msg_read WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM notice_msg_target WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM notice_msg_class WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM notice_msg WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM class_fund_record WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM class_fund WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM member WHERE class_id = ${CLASS_ID}`,
  `DELETE FROM \`class\` WHERE invite_code = ${q(INVITE)}`,
];
push(`-- ===== 0. 清理旧的演示班（重复执行安全） =====`);
cleanupStmts.forEach(push);

/* ================= 1. 班级 ================= */
const PERIOD_TIME =
  '[{"period":1,"start":"08:10","end":"09:50"},{"period":2,"start":"10:10","end":"11:50"},' +
  '{"period":3,"start":"14:40","end":"16:20"},{"period":4,"start":"16:30","end":"18:10"},' +
  '{"period":5,"start":"19:00","end":"20:40"}]';

push(`-- ===== 1. 虚拟班级 =====`);
push(
  `INSERT INTO \`class\` (name, invite_code, join_token, term_start, total_weeks, main_room, ` +
    `bind_open, is_active, period_time, round_cursor_a, round_cursor_b, created_at) VALUES (` +
    `${q(CLASS_NAME)}, ${q(INVITE)}, ${q(JOIN_TOKEN)}, ${q(TERM_START)}, ${TOTAL_WEEKS}, ${q(MAIN_ROOM)}, ` +
    `1, 1, ${q(PERIOD_TIME)}, 0, 0, '2026-10-28 09:00:00')`
);

/* ================= 2. 40 名虚构成员 ================= */
push(`-- ===== 2. 40 名虚构成员（学号 ${STUDENT_PREFIX}01–40） =====`);
const memberRows = members.map(
  (m) =>
    `(${CLASS_ID}, ${q(m.name)}, ${q(m.studentNo)}, ${q(m.group)}, ${q(m.role)}, 'ACTIVE', ${m.isSuper}, 0, '2026-10-28 09:00:00')`
);
push(
  `INSERT INTO member (class_id, name, student_no, group_tag, role, status, is_super, duty_count, created_at) VALUES ` +
    memberRows.join(', ')
);

/* ================= 3. 课程 ================= */
push(`-- ===== 3. ${COURSES.length} 门课程（教师姓名全虚构，含保洁宿主课） =====`);
const courseRows = COURSES.map(
  (c) =>
    `(${CLASS_ID}, ${q(c.name)}, ${c.teacher ? q(c.teacher) : 'NULL'}, ${q(c.room)}, ${q(c.type)}, ${c.duty}, ${MEMBER_ID(SUPER_SEQ)})`
);
push(
  `INSERT INTO course (class_id, name, teacher, room, course_type, duty_count, created_by) VALUES ` +
    courseRows.join(', ')
);

/* ================= 4. 课次（含每日保洁课次） ================= */
push(`-- ===== 4. 课次：16 个课程课次 + 5 个保洁课次（18:10 打扫 412） =====`);
const sessionRows = SESSIONS.map(
  (s) =>
    `(${CLASS_ID}, ${COURSE_ID(s.course)}, 'COURSE', 'ALL', ${q(periodWeeks)}, ${s.day}, ${s.period}, ` +
    `${s.group ? q(s.group) : 'NULL'}, 2, '')`
);
const cleanRows = CLEAN_DAYS.map(
  (d) => `(${CLASS_ID}, ${COURSE_ID('打扫412')}, 'CLEAN', 'ALL', '', ${d}, 4, NULL, 2, ${q('打扫主教室 ' + MAIN_ROOM)})`
);
push(
  `INSERT INTO session (class_id, course_id, kind, week_rule, weeks, day_of_week, period, group_scope, duty_count, note) VALUES ` +
    sessionRows.concat(cleanRows).join(', ')
);

/* ================= 5. 值日岗位 ================= */
push(`-- ===== 5. 值日岗位：每工作日 5 个课程岗 + 1 个保洁岗 =====`);
const slotRows = [];
CLEAN_DAYS.forEach((d) => {
  slotRows.push(`(${CLASS_ID}, ${d}, NULL, 2, NULL, 'CLEAN', ${d * 10})`);
  for (let p = 1; p <= 5; p++) {
    slotRows.push(`(${CLASS_ID}, ${d}, ${p}, 2, NULL, 'NORMAL', ${d * 10 + p})`);
  }
});
push(
  `INSERT INTO duty_slot (class_id, weekday, period, need_n, fixed_seq, kind, sort_order) VALUES ` +
    slotRows.join(', ')
);

/* ================= 6. 轮转规则 / 游标 ================= */
push(`-- ===== 6. 排班规则 + 轮转游标 =====`);
push(
  `INSERT INTO schedule_rules (class_id, sort_by_count, avoid_same_day, avoid_back_to_back, ` +
    `cron_enabled, cron_weekday, cron_hour, makeup_days, updated_at) VALUES (` +
    `${CLASS_ID}, 1, 1, 0, 1, 5, 20, 3, '2026-10-28 09:00:00')`
);
push(
  `INSERT INTO duty_week_cursor (class_id, week, start_a, start_b, end_a, end_b) VALUES (${CLASS_ID}, ${WEEKS_TO_SEED}, 0, 0, 0, 0)`
);

/* ================= 7. 值日轮转（1–7 周） ================= */
/** 与云端 schedule.rotationPick 同口径的简化版：按 (已排次数, 学号序号) 取人，当日不重复 */
const counter = new Map(members.map((m) => [m.seq, 0]));
const dutyPlan = []; // { session, week, date, member }

for (let w = 1; w <= WEEKS_TO_SEED; w++) {
  for (let d = 1; d <= 5; d++) {
    const date = classDate(w, d);
    const usedToday = new Set();
    const daySessions = SESSIONS.filter((s) => s.day === d).sort((a, b) => a.period - b.period);
    const slots = daySessions
      .map((s) => ({ ...s, kind: 'COURSE' }))
      .concat([{ day: d, period: 4, course: null, group: null, kind: 'CLEAN' }]);

    for (const slot of slots) {
      const pool = members.filter((m) =>
        slot.kind === 'CLEAN' || !slot.group ? true : m.group === slot.group
      );
      const picked = pool
        .filter((m) => !usedToday.has(m.seq))
        .sort((a, b) => counter.get(a.seq) - counter.get(b.seq) || a.seq - b.seq)
        .slice(0, 2);
      // 当日剩余人不够时（理论上不会）允许重人，避免排空
      if (picked.length < 2) {
        pool
          .sort((a, b) => counter.get(a.seq) - counter.get(b.seq) || a.seq - b.seq)
          .forEach((m) => {
            if (picked.length < 2 && !picked.some((p) => p.seq === m.seq)) picked.push(m);
          });
      }
      picked.forEach((m) => {
        usedToday.add(m.seq);
        counter.set(m.seq, counter.get(m.seq) + 1);
        dutyPlan.push({ slot, week: w, date, member: m });
      });
    }
  }
}

const statusOf = (date) => (date < TODAY ? 'DONE' : date === TODAY ? 'ONGOING' : 'PENDING');

push(`-- ===== 7. 值日轮转：1–${WEEKS_TO_SEED} 周，共 ${dutyPlan.length} 条 =====`);
/* 按「课次」聚合成一条 INSERT…SELECT：课次用 (day, period, kind, group, course) 定位，
   人名用派生表列出本周该课次的 2 个人 —— 这样不必先知道任何自增 id。 */
const bySession = new Map();
dutyPlan.forEach((row) => {
  const s = row.slot;
  const key = [s.day, s.period, s.kind, s.group || 'ALL', s.course || '_CLEAN'].join('|');
  if (!bySession.has(key)) bySession.set(key, { slot: s, rows: [] });
  bySession.get(key).rows.push(row);
});

for (const { slot, rows } of bySession.values()) {
  const cond =
    slot.kind === 'CLEAN'
      ? `s.kind = 'CLEAN' AND s.day_of_week = ${slot.day}`
      : `s.kind = 'COURSE' AND s.day_of_week = ${slot.day} AND s.period = ${slot.period} AND ` +
        (slot.group ? `s.group_scope = ${q(slot.group)}` : `s.group_scope IS NULL`) +
        ` AND s.course_id = (SELECT id FROM course WHERE class_id = ${CLASS_ID} AND name = ${q(slot.course)} LIMIT 1)`;

  const values = rows
    .map((r) => {
      const st = statusOf(r.date);
      const done = st === 'DONE' ? q(r.date + ' 20:00:00') : 'NULL';
      return `SELECT ${r.week} AS wk, ${q(r.date)} AS dt, ${q(r.member.studentNo)} AS sno, ` +
        `${q(st)} AS st, ${done} AS done_at`;
    })
    .join(' UNION ALL ');

  push(
    `INSERT INTO duty (class_id, session_id, week, class_date, member_id, status, source, done_at) ` +
      `SELECT s.class_id, s.id, v.wk, v.dt, m.id, v.st, 'AUTO', v.done_at ` +
      `FROM session s ` +
      `JOIN (${values}) v ON 1 = 1 ` +
      `JOIN member m ON m.class_id = s.class_id AND m.student_no = v.sno ` +
      `WHERE s.class_id = ${CLASS_ID} AND ${cond}`
  );
}

/* ================= 8. 通知 ================= */
push(`-- ===== 8. 三条通知（其中两条需要确认收到） =====`);
const notices = [
  {
    title: '本周五班会改到 412 教室',
    content:
      '因多媒体教室检修，本周五第 2 节的班会课改到 412 教室，内容为学期中段小结与评优推荐。请提前 5 分钟到，带好笔记本。',
    needAck: 1,
    popup: 0,
    created: '2026-10-27 19:20:00',
  },
  {
    title: '运动会志愿者报名今晚截止',
    content:
      '校运会志愿者还缺 6 人，负责检录与器材搬运，服务时长可计入实践学分。请在今晚 22:00 前回复「姓名 + 岗位」。',
    needAck: 0,
    popup: 0,
    created: '2026-10-26 20:05:00',
  },
  {
    title: '班费缴纳与报销说明',
    content:
      '本学期班费每人 50 元，已收齐共 280 元。购买打印纸与清洁用品共支出 6.1 元，凭证已上传。报销请把票据拍照发给生活委员。',
    needAck: 1,
    popup: 0,
    created: '2026-10-24 18:40:00',
  },
];
notices.forEach((n) => {
  push(
    `INSERT INTO notice_msg (class_id, publisher_id, title, content, images, link_url, link_name, ` +
      `scope, need_ack, popup, week, created_at) VALUES (` +
      `${CLASS_ID}, ${MEMBER_ID(SUPER_SEQ)}, ${q(n.title)}, ${q(n.content)}, '[]', NULL, NULL, ` +
      `'ALL', ${n.needAck}, ${n.popup}, ${WEEKS_TO_SEED}, ${q(n.created)})`
  );
  push(
    `INSERT INTO notice_msg_class (notice_id, class_id) SELECT id, class_id FROM notice_msg ` +
      `WHERE class_id = ${CLASS_ID} AND title = ${q(n.title)}`
  );
  if (n.needAck) {
    /* 前 15 人已确认，形成 15/40 的回执进度（看起来像真的在推进） */
    const seqs = members.slice(0, 15).map((m) => m.studentNo);
    push(
      `INSERT INTO notice_msg_read (notice_id, class_id, member_id, read_at) ` +
        `SELECT n.id, n.class_id, m.id, ${q(n.created)} FROM notice_msg n ` +
        `JOIN member m ON m.class_id = n.class_id AND m.student_no IN (${seqs.map(q).join(', ')}) ` +
        `WHERE n.class_id = ${CLASS_ID} AND n.title = ${q(n.title)}`
    );
  }
});

/* ================= 9. 班费 ================= */
push(`-- ===== 9. 班费：总额 280，两笔支出 6.1，余额 273.9 =====`);
push(`INSERT INTO class_fund (class_id, type, total, updated_at) VALUES (${CLASS_ID}, 'class', 280.00, '2026-10-24 18:30:00')`);
const fundRecords = [
  { amount: '3.50', note: '打印纸一包（班级资料复印）', created: '2026-10-20 15:10:00' },
  { amount: '2.60', note: '教室清洁用品（抹布、清洁剂）', created: '2026-10-23 17:35:00' },
];
fundRecords.forEach((r) => {
  push(
    `INSERT INTO class_fund_record (class_id, type, amount, note, images, operator_id, operator_name, created_at) VALUES (` +
      `${CLASS_ID}, 'class', ${r.amount}, ${q(r.note)}, '[]', ${MEMBER_ID(SUPER_SEQ)}, ${q(members[SUPER_SEQ - 1].name)}, ${q(r.created)})`
  );
});

/* ================= 10. 回写每人值日次数 ================= */
push(`-- ===== 10. 回写 member.duty_count（值日页的完成数口径） =====`);
push(
  `UPDATE member SET duty_count = (SELECT COUNT(*) FROM duty d WHERE d.member_id = member.id AND d.status = 'DONE') ` +
    `WHERE class_id = ${CLASS_ID}`
);

/* ================= 11. 自检 ================= */
push(`-- ===== 11. 自检（执行后看这几行输出） =====`);
push(`SELECT id, name, invite_code, join_token, term_start, total_weeks, main_room FROM \`class\` WHERE invite_code = ${q(INVITE)}`);
push(`SELECT COUNT(*) AS members, SUM(group_tag = 'A') AS grp_a, SUM(group_tag = 'B') AS grp_b FROM member WHERE class_id = ${CLASS_ID}`);
push(`SELECT (SELECT COUNT(*) FROM course WHERE class_id = ${CLASS_ID}) AS courses, (SELECT COUNT(*) FROM session WHERE class_id = ${CLASS_ID}) AS sessions, (SELECT COUNT(*) FROM duty WHERE class_id = ${CLASS_ID}) AS duties, (SELECT COUNT(*) FROM duty_slot WHERE class_id = ${CLASS_ID}) AS slots`);
push(`SELECT status, COUNT(*) AS n FROM duty WHERE class_id = ${CLASS_ID} GROUP BY status`);
push(`SELECT MIN(class_date) AS first_date, MAX(class_date) AS last_date FROM duty WHERE class_id = ${CLASS_ID}`);
push(`SELECT SUM(amount) AS expense, (SELECT total FROM class_fund WHERE class_id = ${CLASS_ID} AND type = 'class') - SUM(amount) AS balance FROM class_fund_record WHERE class_id = ${CLASS_ID} AND type = 'class'`);

/* ---------------- 写出 ---------------- */
const header = `-- 虚拟演示班（${CLASS_NAME}）全套数据
-- 生成器：scripts/gen-demo-class.js（改数据请改生成器，不要手改本文件）
-- 执行：bash scripts/run_sql_file.sh scripts/demo-class.sql
-- 回滚：bash scripts/run_sql_file.sh scripts/demo-class-rollback.sql
-- 成员 ${members.length} 人 / 课程 ${COURSES.length} 门 / 课次 ${SESSIONS.length + CLEAN_DAYS.length} 个 / 值日 ${dutyPlan.length} 条
`;
const sqlPath = path.join(__dirname, 'demo-class.sql');
fs.writeFileSync(sqlPath, header + out.join(';\n') + ';\n', 'utf8');

/* 回滚文件：与第 0 段完全同一批语句，另附一条确认查询 */
const rb = [
  `-- 删除虚拟演示班（invite_code = ${INVITE}）的全部数据`,
  ...cleanupStmts,
  `SELECT COUNT(*) AS remaining_classes FROM \`class\` WHERE invite_code = ${q(INVITE)}`,
];
fs.writeFileSync(path.join(__dirname, 'demo-class-rollback.sql'), rb.join(';\n') + ';\n', 'utf8');

console.log('已生成 scripts/demo-class.sql');
console.log(`  成员 ${members.length} 人 / 课程 ${COURSES.length} 门 / 课次 ${SESSIONS.length + CLEAN_DAYS.length} 个`);
console.log(`  值日 ${dutyPlan.length} 条（1–${WEEKS_TO_SEED} 周，DONE ${dutyPlan.filter((r) => statusOf(r.date) === 'DONE').length} / ONGOING ${dutyPlan.filter((r) => statusOf(r.date) === 'ONGOING').length} / PENDING ${dutyPlan.filter((r) => statusOf(r.date) === 'PENDING').length}）`);
console.log(`  SQL 语句 ${out.length + 1} 条`);
