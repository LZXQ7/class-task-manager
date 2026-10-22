/**
 * 云函数：auth —— 无感登录与身份绑定（开发文档 8.2 #1 / 第 9 章）
 * action: login / checkToken / bind / bindStaff / reviewDemo / reviewDemoStatus /
 *         reviewDemoSet / unbind / resolveScene
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
/* 体验口令的随机源（2026-10-15）：**必须**用 crypto，不能用 Math.random ——
   后者可预测，且同一毫秒内多次调用会撞值；口令是公网后门，撞不得。 */
const crypto = require('crypto');

const { getPool } = require('./common/db');
const guard = require('./common/guard');
const reviewDemo = require('./common/review-demo');
const week = require('./common/week');
const { BizError, ok, fail } = require('./common/resp');
/* 测试账号唯一真源（见 common/test-account.js）。
 * ⚠️ auth 是**唯一**允许出现测试账号的地方 —— 登录身份解析 + 「切换测试账号」调试入口。
 *    任何人员列表都不许在这里出现（由 scripts/check-test-account-hidden.js 兜住）。 */
const { isTestNo, IS_TEST } = require('./common/test-account');

const TOKEN_MAX_FAIL = 5;  // 口令错误 5 次锁 10 分钟
const TOKEN_LOCK_MIN = 10;
const BIND_MAX_FAIL = 5;   // 学号错误 5 次锁 30 分钟
const BIND_LOCK_MIN = 30;

/* ── 防爆破第二层：bind_fail_log 失败日志（2026-09-25） ──
 * bind_attempt 按 openid 计数挡不住「换微信号」攻击：4 位学号空间只有 10^4，
 * 攻击者开 N 个微信各试 5 次就能集中爆破某个学号。所以再加两层：
 * ① 按目标（memberId）限流：同一学号 60 分钟内被任意 openid 试错 ≥ TARGET_MAX_FAIL 次
 *    → 拒绝该学号验证 60 分钟（换多少微信号都一样）。
 * ② 全局熔断：60 分钟内全部失败 ≥ GLOBAL_MAX_FAIL → 所有验证类请求暂停 10 分钟
 *    （窗口自然过期，无需额外解锁动作）。
 * 日志表每次落一条 fail，24h 前的旧记录在写入时顺手清理。 */
const TARGET_MAX_FAIL = 8;     // 同一学号 60 分钟内最多被试错 8 次
const GLOBAL_MAX_FAIL = 300;   // 全局 60 分钟内失败上限
const LOG_WINDOW_MIN = 60;     // 统计窗口
/* 学号后 4 位是连续的（1 号=0301、2 号=0302…），破解一个即可推算全部 ——
 * 按目标限流只能拖慢，防不住「推出规律」。终极防线：24h 累计失败 ≥ 500 次
 * 自动关闭绑定入口（bind_open=0），由超管在「我的」页手动重新开启。 */
const AUTO_CLOSE_FAIL = 500;   // 24h 累计失败自动关绑定阈值

function maskNo(no) {
  const s = String(no || '');
  return s.length <= 4 ? '****' : s.slice(0, s.length - 4) + '****';
}

/** 记一条失败日志 + 清理 24h 前旧记录 */
async function logFail(pool, openid, kind, target) {
  try {
    await pool.query('INSERT INTO bind_fail_log (openid, kind, target) VALUES (?, ?, ?)', [openid, kind, String(target || '')]);
    await pool.query('DELETE FROM bind_fail_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)');
  } catch (e) {
    // 日志失败不阻断主流程（bind_attempt 计数仍在）
    console.error('[auth] bind_fail_log insert failed', e && e.message);
  }
}

/**
 * 多班级（§43）：口令/邀请码 → 班级。
 * 返回 { id, name, join_token, invite_code, bind_open }；找不到或绑定关闭时抛错。
 */
async function resolveClassByToken(pool, token, opts) {
  const o = opts || {};
  const [rows] = await pool.query(
    'SELECT id, name, join_token, invite_code, bind_open, is_active FROM `class` WHERE join_token = ? OR invite_code = ? LIMIT 1',
    [token, token]
  );
  const c = rows[0];
  if (!c) throw new BizError(o.notFoundCode || 40004, o.notFoundMsg || '口令不正确，请重新输入');
  if (c.is_active !== 1) throw new BizError(40009, '该班级已停用');
  if (o.checkBindOpen && !c.bind_open) throw new BizError(40009, '班级绑定暂未开放，请联系管理员开启');
  return c;
}

/** 绑定入口开关：关闭后所有验证类请求一律拒绝（login/unbind 不受影响）。
 *  绑定未关联班级（bind/checkToken 传 token 时）用 resolveClassByToken 里 checkBindOpen 校验，
 *  此函数仅服务「无 token 的全局开关」旧路径，保留向后兼容。 */

/** 全局熔断：60 分钟内全部失败 ≥ GLOBAL_MAX_FAIL → 暂停验证；
 *  24h 累计 ≥ AUTO_CLOSE_FAIL → 自动关闭绑定入口（学号可推算，必须一次性终结攻击窗） */
async function assertGlobalOk(pool) {
  const [win] = await pool.query('SELECT COUNT(*) AS n FROM bind_fail_log WHERE created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)', [LOG_WINDOW_MIN]);
  if ((Number(win[0] && win[0].n) || 0) >= GLOBAL_MAX_FAIL) {
    throw new BizError(40008, '当前验证请求过于频繁，请 10 分钟后再试');
  }
  const [day] = await pool.query('SELECT COUNT(*) AS n FROM bind_fail_log WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)');
  if ((Number(day[0] && day[0].n) || 0) >= AUTO_CLOSE_FAIL) {
    // 多班级：自动关闭全部班级的绑定入口（学号可推算，必须一次性终结攻击窗）
    await pool.query('UPDATE `class` SET bind_open = 0 WHERE is_active = 1');
    console.error('[auth] ALERT: 24h bind failures >= ' + AUTO_CLOSE_FAIL + ', binding auto-closed (all classes)');
    throw new BizError(40009, '检测到异常尝试，班级绑定已自动关闭，请联系管理员');
  }
}

/** 按目标限流：同一学号 60 分钟内被任意 openid 试错 ≥ TARGET_MAX_FAIL → 锁该学号 */
async function assertTargetOk(pool, memberId) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS n FROM bind_fail_log WHERE kind = \'student\' AND target = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)',
    [String(memberId), LOG_WINDOW_MIN]
  );
  if ((Number(rows[0] && rows[0].n) || 0) >= TARGET_MAX_FAIL) {
    throw new BizError(40007, '该学号验证次数过多已被临时锁定，请 1 小时后再试或联系管理员');
  }
}

async function assertNotLocked(pool, openid) {
  const [rows] = await pool.query('SELECT fail_count, locked_until FROM bind_attempt WHERE openid = ?', [openid]);
  const r = rows[0];
  if (r && r.locked_until && String(r.locked_until).replace('T', ' ') > week.nowStamp()) {
    throw new BizError(40005, '尝试次数过多，已临时锁定，请稍后再试');
  }
  return r ? r.fail_count : 0;
}

async function recordFail(pool, openid) {
  await pool.query(
    `INSERT INTO bind_attempt (openid, fail_count) VALUES (?, 1)
     ON DUPLICATE KEY UPDATE fail_count = fail_count + 1`,
    [openid]
  );
  const [rows] = await pool.query('SELECT fail_count FROM bind_attempt WHERE openid = ?', [openid]);
  return rows[0] ? rows[0].fail_count : 1;
}

async function lockFor(pool, openid, minutes) {
  await pool.query('UPDATE bind_attempt SET fail_count = 0, locked_until = ? WHERE openid = ?', [week.addMinutes(minutes), openid]);
}

async function clearFails(pool, openid) {
  await pool.query('DELETE FROM bind_attempt WHERE openid = ?', [openid]);
}

/* ── 审核体验入口（2026-10-11，v1.0.6.3） ──────────────────────────────────
 * 微信审核驳回「存在登录受限问题」（运营规范 3.3.3）：本小程序常规绑定是**三步**
 * （班级口令 → 名单选人 → 学号后 4 位），审核员没有口令、名单里也没有他的名字，
 * **光给口令也过不了第 2 步**。因此在首页旁挂一条「审核体验」一键直达通道。
 *
 * 口令存 `class.review_demo_code`、开关存 `class.review_demo_on`（默认 0 = 关闭）：
 *   · 放在 DB 而非环境变量 —— 审核通过后一条 UPDATE 就能关掉后门，**不必重新部署**；
 *   · 放在 DB 而非代码里 —— 代码随包可被反解，DB 只有超管能读。
 * ⚠️ 口令**永不回传前端**：前端只拿 `reviewDemo` 布尔位决定要不要渲染入口，
 *    真实口令由超管填进 mp 后台的「审核备注」，审核员在小程序里手输。
 */

/** 取已开启体验入口的那一行配置；没有 ⇒ 未开放（前端不渲染、后端直接拒） */
async function reviewDemoRow(pool) {
  const [rows] = await pool.query(
    "SELECT review_demo_on, review_demo_code FROM `class` WHERE review_demo_on = 1 AND review_demo_code <> '' LIMIT 1"
  );
  return rows[0] || null;
}

/** 恒定时间字符串比较：按字节全量比对，不按前缀早退（避免时序侧信道泄露口令前缀） */
function safeEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a), 'utf8');
  const y = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * 生成一条**新的**体验口令：`LXQ-XXXX-XXXX-XXXX-XXXX`（4 组 × 4 位）。
 * -----------------------------------------------------------------------------
 * 为什么由后端自动生成而不是超管手填（2026-10-15）：
 *   老流程是「我在更新说明里手写一条 → 用户跑 UPDATE 写库」，每个版本提审都要来一遍，
 *   且手写口令存在「复用旧口令 / 抄错 / 泄漏在仓库里」三个方向的风险。
 *   现在改成**每次开启自动生成一条**，旧口令当场作废 ⇒ 「每次提审都是新口令」这件事
 *   由代码保证，不靠人记。
 *
 * ⚠️ 字符表**刻意去掉 0/O/1/I**：口令要被审核员手抄进小程序，这 4 个字形最容易看错，
 *    抄错 = 白跑一趟审核。
 * ⚠️ 随机源用 `crypto.randomInt`（密码学安全），**不要**改成 `Math.random` ——
 *    可预测 + 同毫秒撞值，口令是公网后门，撞不得。门禁 check-review-demo 已钉死这一点。
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReviewCode() {
  let out = '';
  for (let g = 0; g < 4; g++) {
    if (g) out += '-';
    for (let i = 0; i < 4; i++) out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return 'LXQ-' + out;
}

const routes = {
  /** 无感登录主入口：openid 即身份，无绑定记录则 bound=false */
  login: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      const m = ctx.member;
      const classId = m ? (Number(m.class_id) || 1) : 1;
      const cfg = await week.getConfig(pool, classId);
      return {
        bound: !!m,
        // 超管「切换测试账号」模拟态标记：true 时前端显示「恢复本人」入口
        switched: !!ctx.impersonated,
        role: m ? m.role : null,
        classId,
        member: m ? {
          id: m.id,
          name: m.name,
          studentNoMasked: maskNo(m.student_no),
          groupTag: m.group_tag,
          role: m.role,
          isSuper: !!m.is_super,
          // 99 段测试账号标记（学号已打码前端无法自查）：清空通知等测试工具入口只对测试超管开放
          test: isTestNo(m.student_no),
          status: m.status,
          position: m.position || '',
          /*
           * 需求 D：权限下放 —— 三个能力位由 guard 统一判定后下发，前端**直接用**，
           * 不再自己比对 position 字面量（判定式若散落两处必然漂移）。
           *   canSchedule     排班域：超管（可跨班）或本班生活委员
           *   canRosterEdit   名册录入（增改不含删）：超管 / 辅导员 / 本班班长
           *   canGrantPosition 授予生活委员/班长：仅超管
           *   canLeave        请假登记（1.0.5 需求④）：超管 / 本班**学生班委**
           *                   （role ∈ {ADMIN,MONITOR} 且 group_tag<>'X'；教职工不算）
           * 注意：这三个是**入口可见性**依据，真正拦截一律在云函数侧（前端可伪造）。
           */
          canSchedule: !!(guard.isSuper(m) || guard.isDutyAdmin(m)),
          canRosterEdit: !!(guard.isSuper(m) || guard.isCounselor(m) || guard.isMonitor(m)),
          canGrantPosition: !!guard.isSuper(m),
          canLeave: !!(guard.isSuper(m) || guard.isCommittee(m)),
          avatarUrl: m.avatar_url || '',
          // 微信提醒「额度耗尽」标记（v0.7.15）：cron 发订阅消息 43101 时置 1。
          // 「我的」页据此把提醒行改成「额度已用完 · 点此重新开启」。
          remindBlock: Number(m.remind_block) === 1,
          classId: Number(m.class_id) || 1
        } : null,
        config: {
          classId,
          name: cfg.name,
          termStart: cfg.termStart,
          totalWeeks: cfg.totalWeeks,
          periodTime: cfg.periodTime,
          bindOpen: cfg.bindOpen !== false,
          // 审核体验入口是否开放（2026-10-11）：只给**布尔位**，口令永不回传。
          // 前端拿它决定 bind 首页要不要渲染「审核体验」区块 —— 关闭时前端根本不画，
          // 审核员看到的就是一个干净的口令页。
          reviewDemo: !!(await reviewDemoRow(pool)),
          currentWeek: week.currentWeek({ term_start: cfg.termStart, total_weeks: cfg.totalWeeks })
        }
      };
    }
  },

  /** 校验口令（不落库），错误按 openid 计数 */
  checkToken: {
    auth: null,
    handler: async (payload, ctx) => {
      const token = String(payload.token || '').trim();
      if (!token) throw new BizError(41001, '请输入班级口令');
      const pool = getPool();
      await assertGlobalOk(pool);
      await assertNotLocked(pool, ctx.openid);
      // 多班级：口令与邀请码等价入场，按 class 表解析（含 bind_open 校验）
      let cls;
      try {
        cls = await resolveClassByToken(pool, token, { checkBindOpen: true });
      } catch (e) {
        if (e && e.errCode === 40004) {
          await logFail(pool, ctx.openid, 'token', '');
          const fails = await recordFail(pool, ctx.openid);
          if (fails >= TOKEN_MAX_FAIL) {
            await lockFor(pool, ctx.openid, TOKEN_LOCK_MIN);
            throw new BizError(40005, '口令错误次数过多，已锁定 ' + TOKEN_LOCK_MIN + ' 分钟');
          }
          throw new BizError(40004, '口令不正确，请重新输入');
        }
        throw e;
      }
      await clearFails(pool, ctx.openid);
      // 返回规范口令 + 班级信息：邀请码入场后前端统一改用 join_token，后续 roster/bind 无需感知邀请码
      return { ok: true, token: cls.join_token, classId: cls.id, className: cls.name };
    }
  },

  /** 绑定：口令 + 名单选人 + 学号后 4 位（服务端比对） */
  bind: {
    auth: null,
    handler: async (payload, ctx) => {
      const token = String(payload.token || '').trim();
      const memberId = Number(payload.memberId);
      const last4 = String(payload.studentNoLast4 || '').trim();
      if (!token || !memberId || !/^\d{4}$/.test(last4)) throw new BizError(41001, '参数错误');
      const pool = getPool();
      await assertGlobalOk(pool);
      await assertNotLocked(pool, ctx.openid);
      // 多班级：口令/邀请码 → 班级（含 bind_open 校验）
      let cls;
      try {
        cls = await resolveClassByToken(pool, token, { checkBindOpen: true });
      } catch (e) {
        if (e && e.errCode === 40004) {
          await logFail(pool, ctx.openid, 'token', '');
          throw new BizError(40004, '口令不正确，请返回上一步');
        }
        throw e;
      }

      const [mRows] = await pool.query('SELECT * FROM member WHERE id = ? LIMIT 1', [memberId]);
      const member = mRows[0];
      if (!member) throw new BizError(41001, '成员不存在');
      // 多班级隔离：成员必须属于口令对应的班级，防止跨班绑定
      if (Number(member.class_id) !== Number(cls.id)) throw new BizError(40006, '该成员不属于此班级');
      if (member.openid && member.openid !== ctx.openid) throw new BizError(40006, '该成员已被其他微信绑定');
      if (member.status === 'DISABLED') throw new BizError(40006, '该成员已停用，请联系管理员');

      // 按目标限流：这个学号最近被试错太多（换微信号也一样计入）→ 直接拒绝
      await assertTargetOk(pool, memberId);
      if (String(member.student_no).slice(-4) !== last4) {
        await logFail(pool, ctx.openid, 'student', memberId);
        const fails = await recordFail(pool, ctx.openid);
        if (fails >= BIND_MAX_FAIL) {
          await lockFor(pool, ctx.openid, BIND_LOCK_MIN);
          throw new BizError(40005, '验证次数过多，已锁定 ' + BIND_LOCK_MIN + ' 分钟');
        }
        throw new BizError(40004, '学号后 4 位不匹配', { remainAttempts: Math.max(BIND_MAX_FAIL - fails, 0) });
      }

      await pool.query(
        'UPDATE member SET openid = ?, bind_time = NOW() WHERE id = ? AND (openid IS NULL OR openid = ?)',
        [ctx.openid, memberId, ctx.openid]
      );
      const [chk] = await pool.query('SELECT openid FROM member WHERE id = ?', [memberId]);
      if (!chk.length || chk[0].openid !== ctx.openid) throw new BizError(40006, '该成员已被其他微信绑定');
      // 微信头像（可选）：绑定成功后落库，成员列表/我的页展示；取不到不阻断绑定
      const avatarUrl = String(payload.avatarUrl || '').trim();
      if (/^https?:\/\//.test(avatarUrl)) {
        await pool.query('UPDATE member SET avatar_url = ? WHERE id = ?', [avatarUrl.slice(0, 512), memberId]);
      }
      await clearFails(pool, ctx.openid);
      console.log(JSON.stringify({ fn: 'auth', action: 'bind', memberId, openid: ctx.openid, hasAvatar: !!avatarUrl }));
      return { memberId, name: member.name, groupTag: member.group_tag };
    }
  },

  /**
   * 教职工一次性绑定码绑定（2026-09-26）。
   * action: login / checkToken / bind / bindStaff / reviewDemo / unbind / resolveScene
   *
   * 辅导员 / 老师没有班级、没有学号 —— 原有链路（口令 → 名单选人 → 学号后 4 位）三重都不适用：
   *   ① 名单里没有他的条目；
   *   ② 教职工不在 A/B 分组，按名字选人对不上；
   *   ③ 没有学号，后 4 位无从验证。
   * 因此给一条独立入口：管理员在班级管理页现场发码（member.addStaff / member.staffCode），
   * 本人在绑定页输入 8 位码即完成绑定。
   *
   * 与 bind 的三处刻意差异：
   *   · **不校验学号**、**不查名单** —— 码本身就是凭证；
   *   · **不调 assertGlobalOk**：全局熔断是为了终止「4 位学号可推算」的爆破（会顺手关掉
   *     所有班级的绑定入口）。教职工码是 32^8 ≈ 1.1e12 的高熵串，且 5 次就锁 30 分钟，
   *     不该让几条瞎试的教职工码把学生的入班通道一起关掉；
   *   · **不检查班级 bind_open**：码是管理员现场发的，与「班级绑定入口开没开」无关。
   */
  bindStaff: {
    auth: null,
    handler: async (payload, ctx) => {
      const code = String(payload.staffCode || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{6,16}$/.test(code)) throw new BizError(41001, '请输入 8 位绑定码');
      const pool = getPool();
      await assertNotLocked(pool, ctx.openid);

      /* 同一码试错也计入 openid 失败计数（5 次锁 30 分钟），与 bind 同一道闸 */
      const deny = async (msg) => {
        await logFail(pool, ctx.openid, 'staff', code.slice(0, 3));
        const fails = await recordFail(pool, ctx.openid);
        if (fails >= BIND_MAX_FAIL) {
          await lockFor(pool, ctx.openid, BIND_LOCK_MIN);
          throw new BizError(40005, '尝试次数过多，已锁定 ' + BIND_LOCK_MIN + ' 分钟');
        }
        throw new BizError(40004, msg);
      };

      const [rows] = await pool.query('SELECT * FROM member WHERE staff_code = ? LIMIT 1', [code]);
      const t = rows[0];
      if (!t) return deny('绑定码无效，请向管理员确认');
      if (!t.staff_code_expire || String(t.staff_code_expire).replace('T', ' ') <= week.nowStamp()) {
        return deny('绑定码已过期，请让管理员重新生成');
      }
      if (t.openid && t.openid !== ctx.openid) return deny('该绑定码已被使用，请让管理员重新生成');
      if (t.status === 'DISABLED') throw new BizError(40006, '该账号已停用，请联系管理员');
      // 一个微信只能对应一个身份（member.openid 是 UNIQUE，先给出可读的报错而不是撞唯一键）
      const [mineRows] = await pool.query('SELECT id, name FROM member WHERE openid = ? LIMIT 1', [ctx.openid]);
      if (mineRows.length && mineRows[0].id !== t.id) {
        throw new BizError(40006, '当前微信已绑定「' + mineRows[0].name + '」，请先在「我的」页解除绑定');
      }

      // 一次性：绑成功的同时把码作废（同一条 UPDATE，防并发双绑）
      await pool.query(
        'UPDATE member SET openid = ?, bind_time = NOW(), staff_code = NULL, staff_code_expire = NULL' +
        ' WHERE id = ? AND (openid IS NULL OR openid = ?)',
        [ctx.openid, t.id, ctx.openid]
      );
      const [chk] = await pool.query('SELECT openid, staff_code FROM member WHERE id = ?', [t.id]);
      if (!chk.length || chk[0].openid !== ctx.openid) throw new BizError(40006, '该绑定码已被使用，请让管理员重新生成');

      const avatarUrl = String(payload.avatarUrl || '').trim();
      if (/^https?:\/\//.test(avatarUrl)) {
        await pool.query('UPDATE member SET avatar_url = ? WHERE id = ?', [avatarUrl.slice(0, 512), t.id]);
      }
      await clearFails(pool, ctx.openid);
      console.log(JSON.stringify({ fn: 'auth', action: 'bindStaff', memberId: t.id, openid: ctx.openid }));
      return { memberId: t.id, name: t.name, groupTag: 'X', isStaff: true };
    }
  },

  /**
   * 审核体验入口（2026-10-11，v1.0.6.3）—— 见上方「审核体验入口」注释块。
   * 绑定目标是 **99 段测试超管**（测试账号唯一真源 common/test-account.js）。
   *
   * 与 bind / bindStaff 的四处刻意差异：
   *   · **不校验学号、不查名单** —— 口令本身就是凭证（审核员不在任何名单里）；
   *   · **不调 assertGlobalOk** —— 学生爆破的失败计数不该把审核旁路一起熔断；
   *   · 失败仍计入 openid 计数并可锁 30 分钟（复用 bind_attempt，防口令爆破）；
   *   · 口令恒定时间比较，且**永不回传前端**。
   */
  reviewDemo: {
    auth: null,
    handler: async (payload, ctx) => {
      const pool = getPool();
      await assertNotLocked(pool, ctx.openid);
      const row = await reviewDemoRow(pool);
      if (!row) throw new BizError(40009, '体验入口未开放');
      const code = String(payload.code || '').trim();
      if (!safeEqual(code, String(row.review_demo_code || '').trim())) {
        await logFail(pool, ctx.openid, 'review', '');
        const fails = await recordFail(pool, ctx.openid);
        if (fails >= BIND_MAX_FAIL) await lockFor(pool, ctx.openid, BIND_LOCK_MIN);
        throw new BizError(40004, '体验口令不正确');
      }
      const [rows] = await pool.query(
        `SELECT id, name, class_id FROM member
          WHERE ${IS_TEST()} AND role = 'ADMIN' AND is_super = 1 AND status <> 'DISABLED'
          ORDER BY id LIMIT 1`
      );
      const t = rows[0];
      if (!t) throw new BizError(40009, '演示账号未就绪，请联系管理员');
      /*
       * 🔴 一个微信只能对应一个身份：已绑真人时**要求先解绑**，绝不自动顶掉。
       *   真人被顶掉 = 该同学当场掉线、且可能被冒用 —— 这是绝对不能发生的方向。
       */
      const [mine] = await pool.query('SELECT id, name FROM member WHERE openid = ? LIMIT 1', [ctx.openid]);
      if (mine.length && Number(mine[0].id) !== Number(t.id)) {
        throw new BizError(40006, '当前微信已绑定「' + mine[0].name + '」，请先在「我的」页解除绑定');
      }
      // 演示身份是共享的：被上一个体验者占用时直接顶掉（它本就是测试账号，不涉及真人）
      await pool.query(
        'UPDATE member SET openid = NULL WHERE id = ? AND openid IS NOT NULL AND openid <> ?',
        [t.id, ctx.openid]
      );
      // 绑定成功即打「演示态」标记（v1.0.6.4）：此后该身份调用破坏性动作会被
      // common/review-demo 的 denyDemo 拦下（抛 40010）。关闭脚本会把它与 openid 一起清零。
      await pool.query('UPDATE member SET openid = ?, bind_time = NOW(), is_review_demo = 1 WHERE id = ?', [ctx.openid, t.id]);
      await clearFails(pool, ctx.openid);
      console.log(JSON.stringify({ fn: 'auth', action: 'reviewDemo', memberId: Number(t.id), demo: true }));
      return { memberId: Number(t.id), name: t.name, demo: true };
    }
  },

  /**
   * 审核体验入口 · 状态查询（仅超管，2026-10-15 · v1.0.6.8）。
   * 「我的 → 管理 → 审核体验入口」那行要知道当前是开还是关；开启期间还要能**再看一次**口令 ——
   *   超管填 mp 后台审核备注时可能已经关掉了弹层，不必为了再看一眼就重开一次
   *   （重开会换口令、并把正在体验的审核员踢下线）。
   *
   * ⚠️ 与「口令永不回传前端」那条铁律的关系：铁律约束的是 **login 下发给所有人**的布尔位，
   *   以及 **reviewDemo（面向未绑定的审核员）** 的返回体 —— 那里带口令等于公开后门。
   *   本路由声明 `needSuper`，口令只回给**本人就是超管**的调用者。
   */
  reviewDemoStatus: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const row = await reviewDemoRow(pool);
      return { on: !!row, code: row ? String(row.review_demo_code || '') : '' };
    }
  },

  /**
   * 审核体验入口 · 开关（仅超管，2026-10-15 · v1.0.6.8）。
   *   on = true  ⇒ **自动生成一条新口令**（旧口令当场作废），只回显给超管本人；
   *   on = false ⇒ 口令作废 + 把正在体验的演示身份踢下线。
   *
   * 为什么开启时**先把所有班的开关清一遍**再写自己班：
   *   `reviewDemoRow` 是**全表扫描**取第一条开着的（`WHERE review_demo_on = 1 ... LIMIT 1`）。
   *   历史上只在 id=3 这一行开过，但只要别班残留一行开着的，就会出现
   *   「我以为关掉了，其实另一道后门还开着」—— 关不干净比不关更危险。
   *
   * 为什么开启也要踢演示身份：换口令 = 换会话，旧会话不该继续持有超管身份。
   */
  reviewDemoSet: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      const kickDemo = async () => {
        // 先取要踢的演示 openid——UPDATE 清空后就再也找不回来了。
        // 顺带删掉演示期间的埋点：只清 member 会让 usage_event 变成 JOIN 不到人的
        // 「（未绑定）」孤儿行，污染使用统计（2026-10-22 实锤：审核员 4 条浏览成了孤儿）。
        const [demo] = await pool.query(
          "SELECT openid FROM member WHERE is_review_demo = 1 AND openid IS NOT NULL AND openid <> ''"
        );
        const openids = demo.map((r) => r.openid);
        await pool.query('UPDATE member SET openid = NULL, is_review_demo = 0 WHERE is_review_demo = 1');
        if (openids.length) {
          await pool.query('DELETE FROM usage_event WHERE openid IN (?)', [openids]);
        }
      };
      const closeAll = () =>
        pool.query("UPDATE `class` SET review_demo_on = 0, review_demo_code = ''");

      if (!payload.on) {
        await kickDemo();
        await closeAll();
        console.log(JSON.stringify({ fn: 'auth', action: 'reviewDemoSet', on: false, by: ctx.member.id }));
        return { on: false, code: '' };
      }
      // 先自检再动手：拿不到班级就别踢人、也别清表（否则会留下「人已下线但后门还开着」的中间态）
      const classId = Number(ctx.member && ctx.member.class_id) || 0;
      if (!classId) throw new BizError(40009, '无法确定所属班级');
      const code = newReviewCode();
      await kickDemo();
      await closeAll();
      await pool.query('UPDATE `class` SET review_demo_on = 1, review_demo_code = ? WHERE id = ?', [code, classId]);
      console.log(JSON.stringify({ fn: 'auth', action: 'reviewDemoSet', on: true, classId, by: ctx.member.id }));
      return { on: true, code };
    }
  },

  /** 自助解绑：清 openid，历史数据保留 */
  unbind: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const pool = getPool();
      await pool.query('UPDATE member SET openid = NULL WHERE openid = ?', [ctx.openid]);
      console.log(JSON.stringify({ fn: 'auth', action: 'unbind', member: ctx.member.id }));
      return {};
    }
  },

  /**
   * 更新自己的微信头像（我的页点头像触发；chooseAvatar 面板选择后上传云存储）。
   * 仅能改自己的 avatar_url；存 cloud:// 文件 ID（image 组件直接显示）或 https URL；
   * 传空串视为清除（回落姓氏色块）。
   */
  updateAvatar: {
    auth: { needBind: true },
    handler: async (payload, ctx) => {
      const avatarUrl = String(payload.avatarUrl || '').trim();
      if (avatarUrl && !/^(cloud:\/\/|https?:\/\/)/.test(avatarUrl)) throw new BizError(41001, '头像地址无效');
      const pool = getPool();
      await pool.query('UPDATE member SET avatar_url = ? WHERE id = ?', [avatarUrl ? avatarUrl.slice(0, 512) : null, ctx.member.id]);
      console.log(JSON.stringify({ fn: 'auth', action: 'updateAvatar', member: ctx.member.id, hasAvatar: !!avatarUrl }));
      return { avatarUrl: avatarUrl || '' };
    }
  },

  /**
   * 超管「切换测试账号」（仅 99 段测试账号）。
   * 鉴权用 realMember（openid 真实身份）而非生效身份 —— 切换成测试成员后仍能切回，
   * 否则会被模拟身份的权限锁死。memberId 传 0/空 = 恢复本人。
   */
  switchAccount: {
    auth: null,
    handler: async (payload, ctx) => {
      const me = ctx.realMember;
      if (!me || !guard.isSuper(me)) throw new BizError(40003, '仅超级管理员可切换测试账号');
      const memberId = Number(payload.memberId || 0);
      const pool = getPool();
      if (!memberId) {
        await pool.query('DELETE FROM impersonation WHERE openid = ?', [ctx.openid]);
        console.log(JSON.stringify({ fn: 'auth', action: 'switchAccount', back: true, member: me.id }));
        return { switched: false };
      }
      const [rows] = await pool.query('SELECT * FROM member WHERE id = ? LIMIT 1', [memberId]);
      const t = rows[0];
      if (!t) throw new BizError(41001, '目标账号不存在');
      // 只允许切到测试段账号（学号 0000000000xx：测试超管/测试管理员/测试成员/辅导员）
      if (!isTestNo(t.student_no)) throw new BizError(41001, '仅允许切换到测试账号');
      await pool.query(
        'INSERT INTO impersonation (openid, member_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE member_id = VALUES(member_id)',
        [ctx.openid, memberId]
      );
      console.log(JSON.stringify({ fn: 'auth', action: 'switchAccount', from: me.id, to: memberId }));
      return { switched: true, memberId, name: t.name };
    }
  },

  /** 入班码 scene → 口令；口令与邀请码都可作 scene（等价入场）。无效返回 40004 防枚举；绑定关闭时同样拒绝 */
  resolveScene: {
    auth: null,
    handler: async (payload, ctx) => {
      const scene = String(payload.scene || '').trim();
      if (!scene) throw new BizError(40004, '邀请码无效');
      const pool = getPool();
      const [rows] = await pool.query(
        'SELECT join_token, invite_code, id, bind_open, is_active FROM `class` WHERE invite_code = ? OR join_token = ? LIMIT 1',
        [scene, scene]
      );
      const c = rows[0];
      if (!c || c.is_active !== 1) throw new BizError(40004, '邀请码无效');
      if (!c.bind_open) throw new BizError(40009, '班级绑定暂未开放，请联系管理员开启');
      return { token: c.join_token, classId: c.id };
    }
  },

  /** 绑定入口开关（仅超管）：关 = 拒绝一切绑定/口令验证；开 = 恢复正常。
   *  多班级：优先操作 class 表（按 classId，缺省 1）；class_config 仅作 id=1 兜底。 */
  setBindOpen: {
    auth: { needSuper: true },
    handler: async (payload, ctx) => {
      const open = payload.open ? 1 : 0;
      const classId = Number(payload.classId) || 1;
      const pool = getPool();
      const [r] = await pool.query('UPDATE `class` SET bind_open = ? WHERE id = ?', [open, classId]);
      if (!r || !r.affectedRows) {
        if (classId === 1) await pool.query('UPDATE class_config SET bind_open = ? WHERE id = 1', [open]);
      }
      console.log(JSON.stringify({ fn: 'auth', action: 'setBindOpen', open, classId, member: ctx.member.id }));
      return { bindOpen: !!open };
    }
  }
};

exports.main = async (event) => {
  let action;
  try {
    action = event && event.action;
    const route = routes[action];
    if (!route) return fail(41001, '未知操作');
    const payload = (event && event.payload) || {};
    const ctx = await guard.getContext();
    reviewDemo.denyDemo(ctx.member, action);   // 演示态：拦截破坏性动作（v1.0.6.4）
    if (route.auth && route.auth.needBind) guard.requireBind(ctx);
    if (route.auth && route.auth.needAdmin) guard.requireAdmin(ctx);
    if (route.auth && route.auth.needSuper) guard.requireSuper(ctx);
    const data = await route.handler(payload, ctx);
    return ok(data);
  } catch (e) {
    if (e && e.errCode) return fail(e.errCode, e.errMsg, e.data);
    console.error('[auth] unhandled', action, e);
    return fail(50000, '服务开小差了，请稍后重试');
  }
};
