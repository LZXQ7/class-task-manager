/**
 * 门禁：测试账号在任何人员列表里都不得展示（2026-10-08 用户定）
 * ===================================================================
 * 需求原话：「不显示测试账号，所有人员列表都不显示测试账号，
 *          包括后面如果增加新功能需要人员列表也不展示」
 *
 * 为什么要有这道门禁（这是本脚本存在的唯一理由）：
 *   「所有人员列表不显示测试账号」是一条**面向未来**的规则。以后每加一个人
 *   员列表都会新增一条 `FROM member` 的 SQL —— 而「作者忘了写 NOT_TEST」
 *   是 100% 会发生的事，且测试账号是合成数据，第一次漏出来往往没人注意。
 *   光靠 code review 拦不住 ⇒ 必须机器拦。
 *
 * ── 判据（核心：SQL 的**驱动表**是不是 member）────────────────────────
 *   把每条查询 member 表的 SQL 抠出来，按驱动表分三类：
 *
 *   ① WRITE  写操作（INSERT/UPDATE/DELETE member）  → 不判
 *   ② POINT  点查单个成员：驱动表是 member，但 WHERE 全是唯一键等值
 *            （id / staff_code / student_no / openid），最多 LIMIT 1
 *            → 不判。它只会返回一个人，「不显示」无从谈起；
 *              反而拦了会打断鉴权、绑定、改角色这类正常操作。
 *   ③ FACT   业务记录带出成员属性：member 是 JOIN 进来的（驱动表是 duty /
 *            notice / swap_request…）→ 不判。成员名是**历史事实**的一部分
 *            （这条值日记录确实是那个人值的），抹掉名字会让记录残缺。
 *   ④ LIST   **人员列表 / 人员统计**：驱动表是 member，且不是点查
 *            （按 class_id 枚举、GROUP BY、COUNT、子查询范围…）
 *            → 必须能看到 NOT_TEST / IS_TEST 的痕迹，否则 FAIL。
 *
 *   只有 ④ 才是需求要管的东西。①②③ 不是「不严谨」，是压根不同类。
 *
 *   ⚠️ SQL 通过变量拼接时（let sql = '…' ; sql += ' AND ' + NOT_TEST ;
 *      pool.query(sql, args)），实参里看不到过滤痕迹 —— 本脚本会向前扩行
 *      把 sql 的赋值链一并纳入片段，否则这类正确写法会被误判。
 *
 * ⚠️ 判据极性：mutate 成「去掉 NOT_TEST 的版本」时，本门禁**必须 FAIL**。
 *    （自证见文件末尾 runMutations()，用真实 fs 改写跑真文件，不靠 sed。）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = [
  'auth', 'schedule', 'adjust', 'member', 'class', 'course',
  'duty', 'export', 'media', 'cron-weekly', 'audit-receiver', 'poster'
];

/**
 * 有意放行测试账号的位置（每条都必须用**源码里一定存在的片段**做锚点，
 * 锚点变了门禁就会失配 → 所以别写中文说明当锚点）。
 * 绝大多数情况不需要白名单：①③ 已被判据自动豁免，进来的都是真·人员列表。
 */
const WHITELIST = [
  {
    fn: 'auth',
    find: "IS_TEST()} AND role = 'ADMIN' AND is_super = 1",
    reason: '「审核体验入口」（auth.reviewDemo，2026-10-11）：微信审核驳回 3.3.3「登录受限」后新增的旁路，' +
      '凭审核口令把身份绑到**99 段测试超管**（库里唯一那条 role=ADMIN + is_super=1 的测试账号，id=69）。' +
      '这是**唯一一条按测试段反查身份**的 SQL，与 switchAccount 的 JS 侧 isTestNo 同源；' +
      '它取的是「我自己要冒充的那个账号」，不是给用户看的**人员列表** ⇒ 不违反铁律。' +
      '注意别写成 role 任意 —— 必须锁死 is_super = 1，否则会把测试成员/测试管理员也当成演示身份。'
  },
  {
    fn: 'schedule',
    find: "TEST_NO_PREFIX + '%')",
    reason: '超管手动排班的名册需要能看到测试账号（需求④：把测试账号排进课次后登进去换班，' +
      '验证主账号能否收到换班通知）。这是「操作候选池」不是「人员展示」，且该 SQL 用 ' +
      'IS_TEST 显式反向放行，口径自洽。注意：**只有超管手动这一条**看得见测试账号，' +
      '自动生成排班（423/969/1517）与 cron（70）都必须在白名单之外、都得过滤。'
  },
  {
    fn: 'member',
    // 锚点只取「按学号批量查」这一段，两处形态（loadExisting / 导入后回填 idMap）都覆盖
    find: 'FROM member WHERE student_no IN (',
    reason: '导入链路的「按学号批量查」（loadExisting + 导入后回填 idMap）：只为建 map，' +
      '不返回给前端。测试账号就是靠这个流程导入进来的，加了 NOT_TEST 会让' +
      '「重复学号」检测失效（同一批里第二个测试号会被当成新号再插一条）。'
  },
  {
    fn: 'member',
    find: "role = 'ADMIN' AND is_super = 1",
    reason: '「不能取消唯一超管」的保护性计数。测试账号的 role 恒为 MEMBER，不影响判定，' +
      '且过滤掉只会让这条保护逻辑在极端情况下失准。'
  },
  {
    fn: 'media',
    find: 'SELECT openid FROM member WHERE status',
    reason: 'pushNoticeMsg 的推送对象查询：sql 在 if/else 两个分支里各拼一次（' +
      'ALL 分支拼 NOT_TEST，PICK/COMMITTEE/POSITION 分支拼 id IN (…) 或各自的 NOT_TEST），' +
      '门禁的语句切片读到第一个 return 就断了，看不到 else 分支里的过滤。' +
      '这条的口径由同文件另两处**无分支**的 COMMITTEE（464 行）与 POSITION（479 行）SQL 保证 —— ' +
      '那两处门禁在判、失败就会红；这里放行的是同一个 pushNoticeMsg 的第一段。'
  }
];

/** 在引号/反引号外做括号配对，返回 query(…) 实参的完整文本（含字符串内部） */
function callArg(src, openIdx) {
  let i = openIdx + 1;
  let depth = 1;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
    i++;
  }
  return src.slice(openIdx + 1);
}

function lineStart(src, idx) {
  let i = idx;
  while (i > 0 && src[i - 1] !== '\n') i--;
  return i;
}

function lineEnd(src, idx) {
  let i = idx;
  while (i < src.length && src[i] !== '\n') i++;
  return i;
}

/**
 * SQL 骨架 = 把片段里所有「字符串字面量」按出现顺序拼起来。
 * 为什么要抽出来：pool.query('SELECT … WHERE id = ?', [memberId]) 里，
 * 参数数组会被 WHERE 的正则误当成条件残留，把点查错判成列表；
 * 而 NOT_TEST 这类过滤痕迹是**变量**不在字面量里，所以结构分析用骨架、
 * 过滤痕迹仍看整段。
 */
function sqlSkeleton(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) break;
        j++;
      }
      out += ' ' + text.slice(i + 1, j) + ' ';
      i = j + 1;
    } else i++;
  }
  return out || text;
}

/**
 * 收集某文件里所有查询 member 表的 SQL 片段。
 *
 * 片段的边界不能只靠 query( —— helper 里的 SQL 常常是**先赋值再执行**：
 *    let sql = "SELECT … FROM member …";      ← 锚点在这一行
  console.log("      sql = 'SELECT ... FROM member WHERE class_id = ? AND ' + NOT_TEST();");
 *    pool.query(sql, args);                    ← 执行点也在锚点之后
 * 所以取「从锚点所在行往前到最近的语句边界」+「往后到 pool.query( 结束」，
 * 整段一起看，才不会把已过滤的 SQL 误判成未过滤。
 */
function memberQueries(src) {
  const out = [];
  const seen = new Set();
  const re = /(?:FROM|JOIN)\s+`?member`?\b/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 往前：到最近的「另起一句」边界。**不能借用前一句的过滤痕迹** ——
    //   上一条 SQL 若带 NOT_TEST，本条漏写也会绿（变异自证实测过这个洞）。
    let start = lineStart(src, m.index);
    for (let i = start - 1; i > Math.max(0, start - 3000); i--) {
      if (src[i] !== '\n') continue;
      let j = i - 1;
      while (j > 0 && src[j] !== '\n') j--;
      const line = src.slice(j + 1, i);
      // 语句边界：空行 / 注释 / 结构行 / 独立语句（await / return / 声明 / 控制流）
      if (!line.trim() || /^\s*(\/\/|\/\*|\*)/.test(line) ||
          /^\s*(await\s|return\s|const\s|let\s|var\s|if\s*\(|for\s*\(|throw\s)/.test(line)) {
        start = i + 1;
        break;
      }
      // 上一个执行点 = 本条 SQL 的起点就在这里（或之后）
      if (/^\s*(?:const|let|var)\s*[\w[\]{}]*\s*=\s*await\s+[\w.]*\.?query\s*\(/.test(line) ||
          /^\s*(?:\w+\.)?(?:query|exec)\s*\(/.test(line)) {
        start = i + 1;
        break;
      }
      // 上一个 SQL 字面量赋值行 = 上一条语句，本条是新的
      if (/\b(?:sql|query|stmt|q)\w*\s*=\s*['"`]/.test(line)) {
        start = i + 1;
        break;
      }
    }
    // 往后：SQL 常在锚点**之后**继续拼接
    //   sql = 'SELECT … FROM member …';   args = [id];   sql += ' AND ' + NOT_TEST();   pool.query(sql, args);
    // 所以要一直盖到「执行这条 SQL 的那一行」。停点有两个，且**顺序有讲究**：
    //   ① 本行还在拼这条 SQL（含 += / 拼接字面量）→ 继续
    //   ② 本行是别的语句（新的执行点 / 新声明 / 对象字面量 / 控制流收尾）→ 停
    // ⚠️ 不能拿「行尾有分号」当停点：`const args = [id];` 带分号但 SQL 还没拼完。
    let end = lineEnd(src, m.index);
    for (let guard = 0; end < src.length && guard < 30; guard++) {
      const next = lineEnd(src, end + 1);          // end 已是行尾，+1 才是下一行行首
      if (next <= end) break;
      const line = src.slice(end + 1, next);
      end = next;
      // if (…) { / else { 是分支容器，里面的 sql += 可能就是过滤条件（media.pushNoticeMsg）
      if (/^\s*(?:if|else if|for|while|try|switch)\b[\s\S]*\{\s*$/.test(line)) continue;
      if (/^\s*\}\s*(?:else|else if)?\s*(?:\{)?\s*$/.test(line)) continue;
      // 仍在拼这条 SQL：变量 += / 变量 = / 配套的参数准备（args.push / const args = [...]）
      if (/\b(?:sql|query|stmt|q)\w*\s*\+=/.test(line)) continue;
      if (/^\s*(?:args|params|paramValues)\b[\s\S]*\.(?:push|concat)\b/.test(line)) continue;
      if (/^\s*(?:const|let|var)\s+(?:args|params)\s*=\s*\[/.test(line)) continue;
      // 下面才是真停点
      if (/[{[]\s*$/.test(line.trim())) break;                        // 对象字面量/数组
      if (/^\s*(?:const|let|var)\s+[\w[\]{}]*\s*=\s*await\s+[\w.]*\.?query\s*\(/.test(line)) break;
      if (/^\s*(?:\w+\.)?(?:query|exec)\s*\(/.test(line)) break;
      if (/^\s*(?:const|let|var)\s/.test(line) && !/\b(?:sql|query|stmt|q)\w*\s*(?:\+=|=)/.test(line)) break;
      if (/;\s*$/.test(line)) break;
    }
    if (seen.has(start)) continue;
    seen.add(start);
    const text = src.slice(start, end);
    if (text.trim()) out.push({ text, line: src.slice(0, start).split('\n').length });
  }
  return out;
}

/**
 * 驱动表名 —— SQL 里**第一个不是子查询的 FROM**。
 * ⚠️ 子查询藏在 SELECT 列表里是常态：
 *    SELECT m.*, (SELECT COUNT(*) FROM duty d WHERE …) AS live_duty FROM member m WHERE class_id = ?
 *                ^^^^^^ 这个 duty 不是驱动表，member 才是
 * 所以要把配对括号内的 FROM 整段挖掉再看，否则会把成员列表错判成「业务记录 JOIN」。
 */
function driverTable(text) {
  // 挖掉所有 (...) 内的内容（含引号里的括号不算）
  let masked = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      let j = i + 1;
      while (j < text.length && text[j] !== q) j++;
      masked += text.slice(i, j + 1);          // 引号内容原样保留（WHERE 'X' 里的值不算结构）
      i = j + 1;
      continue;
    }
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        j++;
      }
      masked += ' (SUBQ) ';
      i = j;
      continue;
    }
    masked += c;
    i++;
  }
  const re = /\bFROM\s+/gi;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let rest = masked.slice(m.index + m[0].length);
    if (/^\(/.test(rest) || /^\(SUBQ\)/.test(rest)) continue;
    const name = /^[`"]?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
    return name ? name[1].toLowerCase() : '';
  }
  return '';
}

/** 唯一的等值条件键（全部 AND 串联、无集合/范围/否定时才成立） */
function pointLookupKeys(text) {
  const w = /\bWHERE\b([\s\S]*?)(\bGROUP BY\b|\bORDER BY\b|\bLIMIT\b|$)/i.exec(text);
  if (!w) return null;
  let body = w[1];
  // 去掉子查询（内部条件不算外层的）
  let guard = 0;
  while (guard++ < 12) {
    const before = body;
    body = body.replace(/\(\s*SELECT\b[\s\S]*?\)/gi, ' (SUBQ) ');
    if (body === before) break;
  }
  if (/\b(?:IN\s*\(|BETWEEN|LIKE|IS\s+NOT|IS\s+NULL|NOT\s+IN|>=|<=|<>|!=|NOT\s+LIKE)\b/i.test(body)) return null;
  const conds = body.match(/[A-Za-z_][A-Za-z0-9_.]*\s*(?:=)\s*(?:\?|:[A-Za-z_]|\d+|NULL|'[^']*')/gi) || [];
  if (!conds.length) return null;
  const keys = [];
  for (const c of conds) {
    const col = c.split(/\s*=|\s*=/)[0].trim().toLowerCase();
    if (/\(/.test(col)) return null;              // 条件里有函数调用 → 不是简单点查
    keys.push(col);
  }
  // 非条件残留（AND/OR 之外的裸词）→ 结构复杂，交给人判断
  const residue = body.replace(/[A-Za-z_][A-Za-z0-9_.]*\s*=\s*(?:\?|:[A-Za-z_]|\d+|NULL|'[^']*')/gi, '')
    .replace(/[\s(),]*\b(?:AND|OR|NOT)\b[\s(),]*/gi, '')
    .replace(/[\s(),]/g, '');
  if (residue) return null;
  return keys;
}

const UNIQUE_KEYS = new Set(['id', 'member_id', 'staff_code', 'student_no', 'openid']);

/** 这条 SQL 有「测试账号过滤」的痕迹（任一形态都算） */
function hasFilter(text) {
  return /NOT_TEST|IS_TEST|notTest|TEST_NO_PREFIX|test-account|0000000000/.test(text);
}

/** 括号/花括号是否配平（判断上一行是不是个还没关掉的 if 头） */
function balanced(s) {
  const st = [];
  const open = { '(': ')', '[': ']', '{': '}' };
  for (const ch of s) {
    if (open[ch]) st.push(open[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') { if (st.pop() !== ch) return true; }
  }
  return st.length > 0;
}

/**
 * 过滤是**无条件**的吗？返回被守卫的 NOT_TEST 位置，没有则返回 -1。
 *
 * 为什么要多这一条：铁律是「一律不显示（含超管）」，而
 *     if (!isSuperNow) sql += ' AND ' + NOT_TEST();   ← 1.0.5 的老口径，超管照样看得见
 * 形式上「有 NOT_TEST」，实质上给破例留了口子。光判 hasFilter 会把它放过去，
 * 而这正是历史上真出现过的写法，所以必须连守卫一起判。
 *
 * 判法（保守，宁可漏也不错杀）：只认两种明显形态 ——
 *   ① NOT_TEST 与 if(...) 在**同一行**，if 在前；
 *   ② NOT_TEST 上一行是**还没闭合的** if 头（`if (cond) {`）。
 * 跨多行的 if 块不在覆盖范围 —— 那种形态在真源码里不存在，硬收紧只会制造噪声。
 */
function conditionalFilter(text) {
  const re = /\b(?:NOT_TEST|IS_TEST|notTest)\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ls = text.lastIndexOf('\n', m.index) + 1;
    if (/\bif\s*\(/.test(text.slice(ls, m.index))) return m.index;
    if (ls > 0) {
      const ps = text.lastIndexOf('\n', ls - 1) + 1;
      const prev = text.slice(ps, ls);
      if (/^\s*if\s*\(/.test(prev) && balanced(prev)) return m.index;
    }
  }
  return -1;
}

/** 分类：WRITE / POINT / FACT / LIST。骨架用于结构分析，text 用于找过滤痕迹 */
function classify(text) {
  if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+`?member`?\b/i.test(text)) return 'WRITE';
  const sk = sqlSkeleton(text);
  if (driverTable(sk) !== 'member') return 'FACT';
  // 点查 = 至少含一个**全局唯一**键（id / 学号 / 工号 / openid）等值。
  // 其余条件（class_id / group_tag / status）只是把范围收窄，改不了「最多一行」这个事实 ——
  //   `WHERE id = ? AND class_id = ?` 仍然只可能返回一个人。
  const keys = pointLookupKeys(sk);
  if (keys && keys.some(k => UNIQUE_KEYS.has(k))) return 'POINT';
  return 'LIST';
}

function whitelisted(fn, text) {
  for (const w of WHITELIST) {
    if (w.fn === fn && text.indexOf(w.find) >= 0) return w;
  }
  return null;
}

/* ================= 跑门禁 ================= */
function run(verbose) {
  const fails = [];
  const counts = { LIST: 0, POINT: 0, FACT: 0, WRITE: 0 };
  const whitelistHits = [];

  FUNCTIONS.forEach((fn) => {
    const f = path.join(ROOT, 'cloudfunctions', fn, 'index.js');
    if (!fs.existsSync(f)) return;
    const src = fs.readFileSync(f, 'utf8');
    memberQueries(src).forEach((q) => {
      const kind = classify(q.text);
      counts[kind]++;
      if (kind !== 'LIST') return;
      const w = whitelisted(fn, q.text);
      if (w) { whitelistHits.push({ fn, line: q.line, reason: w.reason }); return; }
      if (hasFilter(q.text)) {
        const at = conditionalFilter(q.text);
        if (at >= 0) {
          fails.push({
            file: fn + '/index.js',
            line: q.line,
            text: '【过滤被 if 守卫 = 有条件放行】' + q.text.replace(/\s+/g, ' ').slice(0, 100)
          });
        }
        return;
      }
      fails.push({
        file: fn + '/index.js',
        line: q.line,
        text: q.text.replace(/\s+/g, ' ').slice(0, 110)
      });
    });
  });

  if (verbose) {
    console.log('  · 分类：人员列表/统计 ' + counts.LIST + ' · 点查 ' + counts.POINT +
      ' · 业务记录 JOIN ' + counts.FACT + ' · 写操作 ' + counts.WRITE);
    whitelistHits.forEach((w) => console.log('  · 白名单放行 ' + w.fn + '/index.js:' + w.line + '  ' + w.reason));
  }
  if (!fails.length) {
    console.log('  ✓ 测试账号门禁：' + counts.LIST + ' 条人员列表/统计 SQL 全部已过滤（点查 ' +
      counts.POINT + ' / 业务记录 ' + counts.FACT + ' / 写操作 ' + counts.WRITE + ' 不在规则内）');
    return true;
  }
console.log('  ✗ 有 ' + fails.length + ' 条人员列表/统计 SQL 没按铁律过滤测试账号（2026-10-08：所有人员列表一律不展示，含超管）：');
  fails.forEach((f) => console.log('    · ' + f.file + ':' + f.line + '  ' + f.text));
  console.log('');
  console.log('    修法：改用 common 单一真源（不要再各抄一份 TEST_NO_PREFIX）——');
  console.log("      const { NOT_TEST } = require('./common/test-account');");
  console.log("      sql = 'SELECT ... FROM member WHERE class_id = ? AND ' + NOT_TEST;");
  console.log('    JOIN 有别名时用 NOT_TEST(\'m\')。');
  console.log('    ⚠️ 不许写在 if (!isSuper) 之类的守卫里 —— 铁律是无条件，一律不显示（含超管）。');
  console.log('    确实需要放行就加进本脚本的 WHITELIST 并写理由。');
  return false;
}

/* ================= 变异自证（证明判据不是摆设） =================
 * 铁律：绝不用 sed -i（本机 /tmp 不可写 ⇒ 变异静默失败 ⇒ 假通过）。
 * 这里用 fs 直接改真文件、跑完恢复。
 *
 * 每个变异都必须**跑到**（anchor 命中不到就整体判负）——「跳过」不是放过，
 * 是自证失效：锚点漂移说明门禁已经不再盯着那条 SQL 了。 */
const MUTATIONS = [
  {
    file: 'member',
    name: 'manage 列表的 NOT_TEST 整行删掉（最典型的漏写）',
    anchor: "        sql += ' AND ' + NOT_TEST();\n",
    to: ''
  },
  {
    file: 'member',
    name: 'manage 列表退回 1.0.5 的「仅非超管才过滤」口径',
    anchor: "        sql += ' AND ' + NOT_TEST();\n",
    to: "        if (!isSuperNow) sql += ' AND ' + NOT_TEST();\n"
  },
  {
    file: 'member',
    name: 'manage 列表改成「仅超管才过滤」（漏名单里的另一半人被看见）',
    anchor: "        sql += ' AND ' + NOT_TEST();\n",
    to: "        if (isSuperNow) sql += ' AND ' + NOT_TEST();\n"
  },
  {
    file: 'class',
    name: '班级人数统计去掉 NOT_TEST（列表没了、数字还在 ⇒ 同源铁律破）',
    anchor: "'SELECT COUNT(*) AS c FROM member WHERE class_id = ? AND ' + NOT_TEST()",
    to: "'SELECT COUNT(*) AS c FROM member WHERE class_id = ?'"
  },
  {
    file: 'schedule',
    name: 'cron 自动生成轮转名册去掉 NOT_TEST（无人值守 ⇒ 测试账号会被真排进去）',
    anchor: "\"SELECT id, student_no, group_tag, duty_count FROM member WHERE class_id = ? AND status = 'ACTIVE' AND \" + NOT_TEST() + \" AND group_tag <> 'X' AND duty_off = 0\", [classId]",
    to: "\"SELECT id, student_no, group_tag, duty_count FROM member WHERE class_id = ? AND status = 'ACTIVE' AND group_tag <> 'X' AND duty_off = 0\", [classId]"
  },
  {
    file: 'adjust',
    name: '换班候选池去掉 NOT_TEST（测试账号会出现在「找谁换班」里）',
    anchor: "let sql = 'SELECT id, name, group_tag, duty_count, last_duty_at, student_no FROM member WHERE status = ? AND class_id = ? AND id != ? AND duty_off = 0 AND ' + notTest();",
    to: "let sql = 'SELECT id, name, group_tag, duty_count, last_duty_at, student_no FROM member WHERE status = ? AND class_id = ? AND id != ? AND duty_off = 0';"
  }
];

function runMutations() {
  let allCaught = true;
  for (const c of MUTATIONS) {
    const target = path.join(ROOT, 'cloudfunctions', c.file, 'index.js');
    const original = fs.readFileSync(target, 'utf8');
    if (original.indexOf(c.anchor) === -1) {
      console.log('  ✗ 变异「' + c.name + '」锚点已漂移 —— 自证失效，需同步更新锚点');
      allCaught = false;
      continue;
    }
    fs.writeFileSync(target, original.split(c.anchor).join(c.to), 'utf8');
    const caught = !run(false);
    fs.writeFileSync(target, original, 'utf8');
    if (caught) console.log('  ✓ 变异「' + c.name + '」被门禁抓到');
    else { console.log('  ✗ 变异「' + c.name + '」未被抓到 —— 判据失效！'); allCaught = false; }
  }
  return allCaught;
}

const ok = run(process.env.VERBOSE !== '0');
if (process.env.MUTATE === '1') process.exit(runMutations() ? 0 : 1);
process.exit(ok ? 0 : 1);
