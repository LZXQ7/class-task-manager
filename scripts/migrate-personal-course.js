// 建 personal_course（个人选修课）表 + 索引。幂等：已存在则跳过。
// 与 member_timetable / session 完全隔离 —— 个人选修课不驱动值日、不影响全班课表。
const { execSync } = require('child_process');
const fs = require('fs');
const TCBJS = "C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb";
const ENV = "<YOUR_ENV_ID>";
const REGION = "ap-shanghai";
const OUT = __dirname + "/_migrate_personal_course.txt";
const log = [];
function L(s) { log.push(s); }
function syncSleep(ms) { const t = Date.now(); while (Date.now() - t < ms) {} }
function exec(sql) {
  for (let a = 1; a <= 4; a++) {
    try {
      const out = execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ' + REGION + ' -s "' + sql + '"',
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      L('[OK] ' + sql.slice(0, 100) + ' => ' + (out.match(/Affected rows: \d+/) || [''])[0]);
      return out;
    } catch (e) {
      if (a < 4) syncSleep(1500);
      else { const m = String(e.stdout || '') + String(e.stderr || ''); L('[FAIL] ' + sql + '\n' + m); fs.writeFileSync(OUT, log.join('\n'), 'utf8'); throw new Error(m); }
    }
  }
}
function q1(sql) {
  for (let a = 1; a <= 4; a++) {
    try { return execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ' + REGION + ' --read-only -s "' + sql + '"', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (a < 4) syncSleep(1500); else throw e; }
  }
}

// 幂等建表
exec("CREATE TABLE IF NOT EXISTS personal_course ("
  + "id INT UNSIGNED NOT NULL AUTO_INCREMENT, "
  + "class_id INT UNSIGNED NOT NULL, "
  + "member_id INT UNSIGNED NOT NULL, "
  + "name VARCHAR(64) NOT NULL, "
  + "teacher VARCHAR(32) NOT NULL DEFAULT '', "
  + "room VARCHAR(32) NOT NULL DEFAULT '', "
  + "day_of_week TINYINT UNSIGNED NOT NULL, "
  + "period TINYINT UNSIGNED NOT NULL, "
  + "weeks VARCHAR(256) NOT NULL DEFAULT '', "
  + "week_rule ENUM('ALL','ODD','EVEN') NOT NULL DEFAULT 'ALL', "
  + "created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "
  + "updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, "
  + "PRIMARY KEY (id), "
  + "KEY idx_pc_member (class_id, member_id, day_of_week, period)"
  + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

// 自证：表 + 列存在
const cols = q1("SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='personal_course' ORDER BY ORDINAL_POSITION");
L('personal_course columns:\n' + cols);

fs.writeFileSync(OUT, log.join('\n'), 'utf8');
console.log(log.join('\n'));
