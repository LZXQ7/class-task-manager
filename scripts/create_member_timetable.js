// 建 member_timetable（个人课表）表 + 索引。TDSQL 一次一条。
const { execSync } = require('child_process');
const fs = require('fs');
const TCBJS = "C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb";
const ENV = "<YOUR_ENV_ID>";
const OUT = __dirname + "/_create_mt.txt";
const log = [];
function L(s) { log.push(s); }
function syncSleep(ms) { const t = Date.now(); while (Date.now() - t < ms) {} }
function exec(sql) {
  for (let a = 1; a <= 4; a++) {
    try {
      const out = execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai -s "' + sql + '"',
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      L('[OK] ' + sql.slice(0, 90) + ' => ' + (out.match(/Affected rows: \d+/) || [''])[0]);
      return out;
    } catch (e) {
      if (a < 4) syncSleep(1500);
      else { const m = String(e.stdout || '') + String(e.stderr || ''); L('[FAIL] ' + sql + '\n' + m); fs.writeFileSync(OUT, log.join('\n'), 'utf8'); throw new Error(m); }
    }
  }
}
function q1(sql) {
  for (let a = 1; a <= 4; a++) {
    try { return execSync('node "' + TCBJS + '" db execute -e ' + ENV + ' -r ap-shanghai --read-only -s "' + sql + '"', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (a < 4) syncSleep(1500); else throw e; }
  }
}

exec("CREATE TABLE member_timetable ("
  + "id INT NOT NULL AUTO_INCREMENT, "
  + "class_id INT NOT NULL DEFAULT 1, "
  + "member_id INT NOT NULL, "
  + "name VARCHAR(64) NOT NULL, "
  + "teacher VARCHAR(32) NULL, "
  + "room VARCHAR(32) NULL, "
  + "day_of_week TINYINT NOT NULL, "
  + "period TINYINT NOT NULL, "
  + "weeks VARCHAR(64) NULL, "
  + "week_rule ENUM('ALL','ODD','EVEN') DEFAULT 'ALL', "
  + "kind ENUM('COURSE','CLEAN') DEFAULT 'COURSE', "
  + "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
  + "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
  + "PRIMARY KEY (id), "
  + "KEY idx_member (member_id, day_of_week, period), "
  + "KEY idx_class (class_id)"
  + ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
L('table created');

// 自证：列存在
const cols = q1("SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='member_timetable' ORDER BY ORDINAl_POSITION");
L('columns:\n' + cols);

fs.writeFileSync(OUT, log.join('\n'), 'utf8');
console.log(log.join('\n'));
