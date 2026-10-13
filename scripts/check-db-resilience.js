#!/usr/bin/env node
/**
 * 门禁：db.js 连接韧性（v0.7.22 需求①）
 * ============================================================
 * 背景：SCF 冻结容器期间，池里的空闲连接会被 VPC 静默断开 → 下一次调用拿到死连接
 * → 第一条 SQL 抛连接类错误 → 外层 catch 兜成 50000（「服务器开小差了」）。
 * 修复在 `cloudfunctions/common/db.js`：keepalive + pool.query 瞬时错误重试一次 +
 * getConnection 借出前 ping 验活。
 *
 * 本门禁两层：
 *   A. 文本层：源 common/db.js 与各函数副本逐字节一致（sync-common 忘跑就翻红）；
 *      判据先剥注释再断言（本项目已 5 次踩「判据命中注释」）。
 *   B. 行为层（双向自证）：用 `new Function` 抽**生产源码** eval，桩掉 mysql2——
 *      ① 好样本：第一次 query 抛 ECONNRESET → 必须重试且成功（恰好 2 次尝试）；
 *        getConnection 拿到「ping 会死」的连接 → 必须丢弃重借（3 次内成功）；
 *      ② 坏样本：SQL 语义错误（ER_BAD_FIELD_ERROR）→ **绝不重试**（恰好 1 次尝试）；
 *        3 次都死的连接 → 必须抛出最后一个错误（不能吞）；
 *      ③ 变异样本：把源码里的「重试一次」删掉 → 门禁必须翻红（防门禁自己失明）。
 */
const fs = require('fs');
const path = require('path');

const R = path.resolve(__dirname, '..');
const SRC = path.join(R, 'cloudfunctions', 'common', 'db.js');
const FUNCS = fs.readdirSync(path.join(R, 'cloudfunctions'))
  .filter((d) => fs.existsSync(path.join(R, 'cloudfunctions', d, 'common', 'db.js')));

let failed = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failed++; };
const assert = (cond, m) => (cond ? ok(m) : bad(m));

/* ---------- 工具：剥注释（判据命中注释已踩 5 次，文本判据一律先剥） ---------- */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

/* 把 db.js 生产源码 eval 成模块，require('mysql2/promise') 由调用方桩掉 */
function loadDb(src, stubMysql) {
  const module_ = { exports: {} };
  const fn = new Function('require', 'module', 'exports', src);
  fn((p) => (p === 'mysql2/promise' ? stubMysql : require(p)), module_, module_.exports);
  return module_.exports;
}

/* 造一个「按 failPlan 抛错」的可编程桩；pools 收集每次 createPool 的产物 */
function flakyPool(failPlan, pools) {
  let pings = 0, released = 0;
  const makeConn = () => ({
    ping: async () => { pings++; const e = failPlan.ping && failPlan.ping(pings); if (e) throw e; },
    release: () => { released++; }
  });
  const pool = {
    queryCount: 0,
    query: async () => {
      pool.queryCount++;
      const e = failPlan.query && failPlan.query(pool.queryCount);
      if (e) throw e;
      return [[{ ok: 1 }]];
    },
    getConnection: async () => {
      const e = failPlan.getConnection && failPlan.getConnection(1);
      if (e) throw e;
      return makeConn();
    },
    end: async () => {},
    stats: { getPings: () => pings, getReleased: () => released }
  };
  pools.push(pool);
  return pool;
}

async function main() {
  console.log('\n===== check-db-resilience（db.js 连接韧性 · v0.7.22 需求①） =====\n');

  /* ---------- A. 文本层 ---------- */
  const src = fs.readFileSync(SRC, 'utf8');
  const code = stripComments(src);
  assert(FUNCS.length >= 12, 'A1 共 ' + FUNCS.length + ' 个函数带 common/db.js 副本');
  const mismatch = FUNCS.filter((d) => fs.readFileSync(path.join(R, 'cloudfunctions', d, 'common', 'db.js'), 'utf8') !== src);
  assert(!mismatch.length, 'A2 各函数副本与源逐字节一致' + (mismatch.length ? '（失同步：' + mismatch.join(',') + ' → 跑 sync-common.js）' : ''));
  assert(/enableKeepAlive:\s*true/.test(code), 'A3 源码开启 enableKeepAlive（TCP 保活）');
  assert(/isTransientConnError/.test(code) && /PROTOCOL_CONNECTION_LOST/.test(code) && /ER_CON_COUNT_ERROR/.test(code),
    'A4 有「连接类错误才重试」的白名单判定');
  assert(/await conn\.ping\(\)/.test(code), 'A5 getConnection 借出前 ping 验活（事务保护）');
  assert(/attempt < 3/.test(code), 'A6 借连接最多尝试 3 次（不死循环）');
  assert(/dropPool\(\)/.test(code) && /old\.end\(\)/.test(src), 'A7 丢池时对老池做 end 兜底回收');

  /* ---------- B1. 行为：query 瞬时错误 → 丢池重建后重试且成功 ---------- */
  {
    const e = Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
    const pools = [];
    /* ⚠️ 失败计划必须用**跨池全局**计数：db.js 重试时必然重建新池，
       若每个池各自「第一次失败」，重试也会失败，就测不出「重试后成功」这条路径。 */
    let globalQueries = 0;
    const stub = {
      createPool: () => flakyPool({ query: () => (++globalQueries === 1 ? e : null) }, pools)
    };
    const db = loadDb(src, stub);
    const rows = await db.getPool().query('SELECT 1');
    assert(rows[0].length === 1 && pools.length === 2 && pools[1].queryCount === 1,
      'B1 query 第一次 ECONNRESET → 重试成功（重建池 ' + pools.length + ' 个，新池查询 ' + pools[1].queryCount + ' 次成功）');
  }

  /* ---------- B2. 行为：SQL 语义错误 → 绝不重试 ---------- */
  {
    const e = Object.assign(new Error("Unknown column 'x' in 'field list'"), { code: 'ER_BAD_FIELD_ERROR' });
    const pools = [];
    const stub = { createPool: () => flakyPool({ query: () => e }, pools) };
    const db = loadDb(src, stub);
    let threw = false;
    try { await db.getPool().query('SELECT nope'); } catch (err) { threw = err.code === 'ER_BAD_FIELD_ERROR'; }
    assert(threw && pools[0].queryCount === 1 && pools.length === 1,
      'B2 SQL 语义错误原样抛出（尝试 ' + pools[0].queryCount + ' 次、未重建池 ' + pools.length + ' 个）');
  }

  /* ---------- B3. 行为：getConnection 拿到死连接（ping 失败）→ 丢弃重借 ---------- */
  {
    const dead = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const pools = [];
    let calls = 0;
    const stub = { createPool: () => flakyPool({ ping: () => (++calls <= 2 ? dead : null) }, pools) };
    const db = loadDb(src, stub);
    const conn = await db.getPool().getConnection();
    /* ⚠️ 口径：每次 dropPool 后重建新池，ping / release 分散在 3 个池实例上，
       必须跨池汇总，不能只看 pools[0]。 */
    const totalPings = pools.reduce((s, p) => s + p.stats.getPings(), 0);
    const totalReleased = pools.reduce((s, p) => s + p.stats.getReleased(), 0);
    assert(!!conn && pools.length === 3 && totalPings === 3 && totalReleased === 2,
      'B3 死连接被 ping 拦下（重建 ' + pools.length + ' 个池、ping ' + totalPings + ' 次、释放死连接 ' + totalReleased + ' 个后交出活连接）');
  }

  /* ---------- B4. 行为：3 次全死 → 抛最后一个错误（不吞） ---------- */
  {
    const dead = Object.assign(new Error('Connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' });
    const pools = [];
    const stub = { createPool: () => flakyPool({ ping: () => dead }, pools) };
    const db = loadDb(src, stub);
    let threw = false;
    try { await db.getPool().getConnection(); } catch (e) { threw = e.code === 'PROTOCOL_CONNECTION_LOST'; }
    assert(threw, 'B4 连接 3 次全死 → 最终抛出（不吞错）');
  }

  /* ---------- C. 变异自证：删掉重试逻辑 → 门禁必须能识别「无韧性」 ---------- */
  {
    const mutated = src.replace(/dropPool\(\);\s*\n\s*return getRaw\(\)\.query\(sql, args\);/, 'throw e;');
    assert(mutated !== src, 'C1 变异可用（找到重试点并成功改写）');
    const e = Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
    const pools = [];
    const stub = { createPool: () => flakyPool({ query: () => e }, pools) };
    const db = loadDb(mutated, stub);
    let threw = false;
    try { await db.getPool().query('SELECT 1'); } catch (err) { threw = err.code === 'ECONNRESET'; }
    assert(threw && pools[0].queryCount === 1,
      'C2 变异后（无重试）第一次连接错误即抛出 —— 门禁对「无韧性」实现不误报为绿');
  }

  console.log('\n' + (failed === 0
    ? '[PASS] db.js 连接韧性：文本 + 行为双向自证通过'
    : '[FAIL] ' + failed + ' 项未过'));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('[FAIL] 门禁自身异常：', e); process.exit(1); });
