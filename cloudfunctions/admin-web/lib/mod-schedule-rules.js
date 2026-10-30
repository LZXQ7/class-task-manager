/**
 * 排班规则（模块：schedule-rules）
 * 每班一行 schedule_rules（uk_class 唯一索引，按 class_id upsert）。
 * 这里管的是「超管想远程调、不想改代码 / 送审小程序」的排班参数：
 *   makeupDays      补录窗口天数（原 duty 写死 3 天，已迁此，可远程改）
 *   avoidSameDay    同一人同一天不重复排（算法已生效）
 *   cronEnabled     定时自动排班开关（cron-weekly 读它）
 *   cronWeekday     周几（0=周日 … 6=周六）
 *   cronHour        几点
 * avoidBackToBack 列已存在但算法尚未接入，暂不在此暴露。
 *
 * ⚠️ 与小程序排班算法同源：schedule / cron-weekly / duty 三处都读 schedule_rules，
 *   此处只是给超管一个免代码的修改入口（改 admin-web 不用送审小程序）。
 */
const { getPool } = require('../common/db');
const { BizError } = require('../common/resp');
const { logAction } = require('./audit');

function defaultRules() {
  return {
    avoidSameDay: false,
    cronEnabled: false,
    cronWeekday: 0,
    cronHour: 20,
    makeupDays: 3
  };
}

async function getScheduleRules(pool, classId) {
  const [rows] = await pool.query(
    'SELECT avoid_same_day, cron_enabled, cron_weekday, cron_hour, makeup_days FROM schedule_rules WHERE class_id = ?',
    [Number(classId) || 1]
  );
  const r = rows[0];
  if (!r) return defaultRules();
  return {
    avoidSameDay: !!r.avoid_same_day,
    cronEnabled: !!r.cron_enabled,
    cronWeekday: Number(r.cron_weekday) || 0,
    cronHour: Number(r.cron_hour) || 20,
    makeupDays: (r.makeup_days === undefined || r.makeup_days === null) ? 3 : Number(r.makeup_days)
  };
}

/** 保存当前班的排班规则。入参来自后台表单，逐字段强校验 + 钳制，防止脏值进库。 */
async function saveScheduleRules(pool, classId, patch, session) {
  if (!patch || typeof patch !== 'object') throw new BizError(40001, '缺少规则数据');
  const b = (v) => (v === true || v === 1 || v === '1') ? 1 : 0;
  const wd = Number(patch.cronWeekday);
  const hr = Number(patch.cronHour);
  const md = Number(patch.makeupDays);
  const cronWeekday = (wd >= 0 && wd <= 6) ? wd : 0;
  const cronHour = (hr >= 0 && hr <= 23) ? hr : 20;
  const makeupDays = (md >= 0 && md <= 60) ? md : 3;
  await pool.query(
    `INSERT INTO schedule_rules (class_id, avoid_same_day, cron_enabled, cron_weekday, cron_hour, makeup_days)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE avoid_same_day=VALUES(avoid_same_day), cron_enabled=VALUES(cron_enabled),
       cron_weekday=VALUES(cron_weekday), cron_hour=VALUES(cron_hour), makeup_days=VALUES(makeup_days)`,
    [Number(classId) || 1, b(patch.avoidSameDay), b(patch.cronEnabled), cronWeekday, cronHour, makeupDays]
  );
  await logAction(session, {
    module: 'schedule_rules',
    action: 'save',
    classId: Number(classId) || 1,
    detail: JSON.stringify({ avoidSameDay: !!patch.avoidSameDay, cronEnabled: !!patch.cronEnabled, cronWeekday, cronHour, makeupDays })
  });
  return getScheduleRules(pool, classId);
}

module.exports = { getScheduleRules, saveScheduleRules };
