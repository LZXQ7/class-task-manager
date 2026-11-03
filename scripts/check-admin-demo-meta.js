/**
 * 门禁：后台「演示班」元数据不能丢（2026-11-04）
 * ============================================================
 * 起因（用户提问）：「演示班级为什么是停用状态」。
 * 真相：class.id=104（invite_code=DEMO2605）在库里是 `is_demo=1 + is_active=0` ——
 *   is_active=0 是**刻意**停的（停了它才不出现在真实超管的小程序班级列表里，
 *   见 class/index.js 的 `WHERE is_active = 1`）。不是故障，也不是谁误停。
 *
 * 但后台原先只拿到 is_active，于是一路显示成灰色「停用」，语义错、还诱导人去「修」它。
 * 修法：后端把 `isDemo` 透出到 /api/overview 与 /api/classes，前端据此渲染
 *   「演示 · 不参与统计」，并把演示班从所有合计里排除。
 *
 * 本门禁守三件事，任何一条被改回去都会让「停用」假象复发：
 *   ① maskClass / overview 必须回传 isDemo（boolean）；
 *   ② overview.stats 的合计必须排除演示班（演示数据是虚构的 40 人 / 13 课次 / 288 条值日）；
 *   ③ 假数据里必须真的存在一个 is_demo=1 的班，否则本门禁会「空跑变绿」。
 *
 * 全程离线：用 require.cache 顶掉 common/db，喂固定行，不连生产库、不写数据。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const AW = path.join(ROOT, 'cloudfunctions/admin-web');
const LIB = path.join(AW, 'lib');
const DB = path.join(AW, 'common/db');

let pass = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass += 1; return; }
  fails.push(name + (extra ? ' → ' + extra : ''));
}

// ---- 假数据：真实班（57 人）+ 演示班（40 人，刻意停用）----
const CLASS_ROWS = [
  { id: 1, name: '示例专业B1班', is_active: 1, is_demo: 0, total_weeks: 16,
    term_start: '2026-09-14', memberCnt: 57, boundCnt: 4, sessionCnt: 28, dutyCnt: 112 },
  { id: 104, name: '演示班级', is_active: 0, is_demo: 1, total_weeks: 16,
    term_start: '2026-09-14', memberCnt: 40, boundCnt: 0, sessionCnt: 13, dutyCnt: 288 }
];
const LIST_ROWS = CLASS_ROWS.map((r) => Object.assign({}, r, {
  join_token: '900605', invite_code: 'DEMO2605', bind_open: 1,
  period_time: null, main_room: '412', cnt: r.memberCnt
}));

function poolFor(rows) {
  return {
    query: async (sql) => {
      if (/admin_user/.test(sql)) return [[{ c: 1 }]];
      if (/admin_audit_log/.test(sql)) return [[{ c: 0 }]];
      if (/FROM `class`/.test(sql)) return [rows];
      throw new Error('门禁未预期的 SQL（说明 overview/listClasses 改了查询形状，请同步本门禁）：' + String(sql).slice(0, 70));
    }
  };
}

// 顶掉真实 db：require.cache 注入，避免任何网络/数据库连接
let currentPool = poolFor(CLASS_ROWS);
const dbId = require.resolve(DB);
require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: { getPool: () => currentPool }
};

(async () => {
  const modConfig = require(path.join(LIB, 'mod-config.js'));
  const modClass = require(path.join(LIB, 'mod-class.js'));

  // ---- 副作用前置：假数据必须真有演示班，否则下面全绿毫无意义 ----
  check('假数据里存在 is_demo=1 的班（防空跑变绿）',
    CLASS_ROWS.some((r) => Number(r.is_demo) === 1));

  const ov = await modConfig.overview();
  const demoRow = ov.classes.find((c) => c.id === 104);
  const realRow = ov.classes.find((c) => c.id === 1);

  check('overview 每行都带 isDemo(boolean)',
    ov.classes.every((c) => typeof c.isDemo === 'boolean'));
  check('演示班 isDemo=true', demoRow && demoRow.isDemo === true);
  check('真实班 isDemo=false', realRow && realRow.isDemo === false);
  check('演示班 isActive 仍为 false（刻意停用，不能被「修」成启用）', demoRow && demoRow.isActive === false);

  check('stats.memberCount 排除演示班（57，不是 97）', ov.stats.memberCount === 57, '实际 ' + ov.stats.memberCount);
  check('stats.sessionCount 排除演示班（28，不是 41）', ov.stats.sessionCount === 28, '实际 ' + ov.stats.sessionCount);
  check('stats.classCount 只数启用真实班（1）', ov.stats.classCount === 1, '实际 ' + ov.stats.classCount);

  currentPool = poolFor(LIST_ROWS);
  const list = await modClass.listClasses();
  check('listClasses 每行都带 isDemo(boolean)',
    list.every((c) => typeof c.isDemo === 'boolean'));
  check('listClasses 里演示班 isDemo=true', (list.find((c) => c.id === 104) || {}).isDemo === true);

  // ---- 前端守门：三处渲染必须走 classStatusTag / 「（演示）」后缀 ----
  const appJs = fs.readFileSync(path.join(AW, 'public/app.js'), 'utf8');
  check('前端定义了 classStatusTag', /function classStatusTag\s*\(/.test(appJs));
  check('前端有 tag-demo 文案', /tag tag-demo/.test(appJs));
  check('下拉对演示班显示「（演示）」而非「（停用）」',
    /c\.isDemo\s*\?\s*'（演示）'/.test(appJs));
  check('值日记录合计排除演示班', /c\.isDemo\s*\?\s*n\s*:\s*n\s*\+\s*c\.dutyCount/.test(appJs));
  const css = fs.readFileSync(path.join(AW, 'public/admin.css'), 'utf8');
  check('admin.css 有 .tag-demo 样式', /\.tag-demo\s*\{/.test(css));

  // ---- 变异自证：把断言故意判反，必须变红（证明 check 不是恒真）----
  let mutatedRed = false;
  try {
    const before = fails.length;
    check('【变异自证】演示班 isDemo 应为 false（故意写反）', demoRow && demoRow.isDemo === false);
    mutatedRed = fails.length === before + 1;
    fails.length = before; // 撤销这条故意失败的断言
  } catch (e) { mutatedRed = false; }
  check('变异自证：错误断言能被抓住', mutatedRed);

  if (fails.length) {
    console.error('✗ check-admin-demo-meta 失败 ' + fails.length + ' 项：');
    fails.forEach((s) => console.error('   - ' + s));
    process.exit(1);
  }
  console.log('✓ check-admin-demo-meta 全部通过（' + pass + ' 项）');
})().catch((e) => {
  console.error('✗ check-admin-demo-meta 运行异常：' + (e && e.message));
  process.exit(1);
});
