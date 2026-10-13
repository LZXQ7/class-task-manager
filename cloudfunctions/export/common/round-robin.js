/**
 * 值日轮转内核 v2 —— 「按序号连续轮转」的唯一实现
 * ============================================================
 * 本文件取代旧版 `schedule-core.js` 的 `rotationPick` + `repairRoundMarks`。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么重写（用户 2026-10-07 第五次反馈「按序号轮转还是不对，我已经提过很多遍」）
 * ────────────────────────────────────────────────────────────
 * 用户口径（原话）：
 *   「目前轮到 a组47、b组48，但并没有按照序号，也就是 a组49、b组50 开始
 *     轮到 56 后再从头 2 号开始轮。并且每一轮都要按序号将 55 个人全部排上，
 *     而不是漏人缺人。」
 *
 * 旧实现的根本缺陷：把「轮转位置」寄存在 `member.duty_count`（每人排过几次）里，
 * 靠 `rotationPick` 的「取 mark 最小档 + 序号升序」**间接**推出游标，
 * 再用 `repairRoundMarks` 的「最长连续段」去猜游标在哪。三条必然失效的路径：
 *
 *   ① duty_count 被压平（全员同值）→ 相对大小丢失 → 退化成 seq 最小优先 → 从 1 号重排。
 *      线上反复出现（2026-09-26 / 09-27 / 10-07 三次）。
 *   ② 「台阶」边界靠 longest-run 猜，猜错就乱序；而台阶本身是 duty_count 的副产品，
 *      换班 / 手动排班 / 删周都会把它弄脏（v0.7.23 起 duty_count 又是「累计次数」，
 *      被统计口径占用，两种语义挤在一列里必然打架）。
 *   ③ 多个课次并发取人时，「次数」这种聚合量无法表达「本轮已经走到 47 号了」。
 *
 * 新实现：**游标就是一个数字**，直接记录「本组本轮已排到哪个序号」。
 *   · A / B 各自一个游标（`class.round_cursor_a` / `round_cursor_b`），互不干扰
 *   · 取人 = 取 `seq > cursor` 里序号最小的，取完把 cursor 挪到它
 *   · 走到末尾（56）→ 回绕到 0 开新一轮
 *   · **回绕前先把本轮漏掉的人补完**（「每一轮都要把 55 个人全部排上」的保障）
 *   · 本函数**不读也不写 duty_count**（那是统计口径，与轮转彻底解耦）
 *
 * ────────────────────────────────────────────────────────────
 * 全体课（group_scope = NULL）怎么办
 * ────────────────────────────────────────────────────────────
 * 本班 13 节全体课（两组混排）。用户 2026-10-07 新口径：「序号小的先排」——
 * 落后组（当前序号小）优先，自动追平 A/B 的序号差，而不是固定 1A+1B 交替
 * （固定交替会让两组序号差越拉越大：B 都排到 16 了、A 才排到 9，却仍各给 1 个）。
 *
 * 口径：**取全局序号最小的两人**，落后组（序号小）自然被多取，直到两组追平；
 * 追平后（序号接近）自然回到 1A+1B。
 *
 * ⚠️ 护栏（防失控，沿用旧教训）：旧版曾按「已用人数/组」追落后组，结果某组回绕后
 *    used 清零、瞬间变"落后"被连续取，把另一组晾住（实测 A 冲到 51、B 停 6）。
 *    本实现改按**游标序号**追平，并加一道硬护栏：**若某一组本周期已回绕**
 *    （wrappedFlag 置位）而另一组还没回绕 ⇒ 两组不在同一轮次，全体课强制退回
 *    1A+1B 严格交替，避免回绕组被连续取。
 *
 * 某组本次取不出（当天都有值日）时由另一组顶上；两组都取不出才报缺口。
 *
 * ⚠️ 本文件是源，改完必须跑 `node scripts/sync-common.js` 再全量重部署。
 */

/**
 * 组装取人状态（调用方在开始排一周之前调一次）。
 * ------------------------------------------------------------
 * 🔴 关键：「游标之前的人算本轮已排」这个语义必须在**初始化时就写进 used**。
 *    否则「补漏优先」会把序号 ≤ cursor 的人误判成「被漏掉了」，一上来就把整组
 *    从头重排一遍（实测症状：cursor=47 时第一节课取出 03、05）。
 *    语义上也没错：cursor=47 表示「本轮已排到 47」，那么 03~47 就是本轮已排过的。
 *
 * 🔴 第二关键：`used` 必须**按组分开**（`{A: Set, B: Set}`）。
 *    早期版本两组共用一个 Set，A 组回绕时的 `clear()` 会把 B 组的「已排」记录
 *    一起抹掉，B 组随即从头重排（实测：B 组第一节课本该 50,52，实得 02,04）。
 *
 * @param {Array}  roster  [{seq, group, ...}]，seq>0 才参与轮转
 * @param {object} cursors {A:number, B:number}  从 class.round_cursor_* 读入
 * @returns {{cursors:{A:number,B:number}, used:{A:Set<number>,B:Set<number>}}}
 *          —— 两个 Set 装的是**序号**（不是 id）：AI 上下文的名册里没有 id 字段，
 *             而序号在两条链路里都有，用序号做键才能两边共用同一份状态。
 */
function buildState(roster, cursors) {
  const c = Object.assign({ A: 0, B: 0 }, cursors || {});
  const used = { A: new Set(), B: new Set() };
  (roster || []).forEach((m) => {
    if (!m || !(Number(m.seq) > 0)) return;
    const g = m.group === 'B' ? 'B' : 'A';
    if (Number(m.seq) <= (Number(c[g]) || 0)) used[g].add(Number(m.seq));
  });
  return { cursors: { A: Number(c.A) || 0, B: Number(c.B) || 0 }, used };
}

/**
 * 轮转取人（新实现）。
 *
 * 规则（严格按用户口径）：
 *   1. **严格按序号递增**：只在 `seq > cursor` 的候选里取，取序号最小的那个。
 *   2. **一轮 = 本组每人恰好一次**：本轮已排过的人（used）不再取。
 *   3. **优先补漏**：`seq > cursor` 没人可取时，先回头看「本轮还有谁没排过」，
 *      按序号从小到大补齐 —— 而不是直接开新一轮去重复用人。
 *      这一条是「每一轮都要把 55 个人全部排上，不能漏人缺人」的保障。
 *      典型场景：49 号当天已有值日被跳过，游标已经推到 51，下一个课次先把 49 补上。
 *   4. **真·新一轮**：只有当**本组全员都排过**时，才清空 used、cursor 归 0。
 *      剩的人只是「这次不可用」（同日冲突 / 本批次已排）时不回绕 —— 他们下一次
 *      仍会被 ③ 补上。回绕与否看的是 used，不是 usable。
 *   5. **同一课次内绝不重复**：chosen 里已有的人本次不再取（localTaken）。
 *
 * 与旧 rotationPick 的关键差异：本函数**不读也不写 mark / duty_count**。
 * 游标由调用方从 `class.round_cursor_a/b` 读入、写回；本函数只做纯计算。
 *
 * @param {Array}  roster  [{seq, group, id?, name?}]，seq>0 才参与轮转
 * @param {string} scope   'A' | 'B'（分组课）| null（全体课，两组交替）
 * @param {number} n       本节需要几人
 * @param {object} state   buildState() 的产物（会被就地修改：游标前进、used 增补）
 * @param {object} [opt]   { avoidSeqs?, busySeqs?, inBatchSeqs?, avoidSameDay?, skipSeqs?, softSeqs? }
 *                         全部按**序号**给出（AI 上下文的名册没有 id）。
 *                         avoidSeqs = 本次绝对不用（如本节已排的人）
 *                         busySeqs  = 当天已值日过（avoidSameDay 时启用）
 *                         inBatchSeqs = 本批次已排过
 *                         skipSeqs  = 本轮整体跳过（AI 路径的 skipSeqs）
 *                         softSeqs  = 软避让（本周已值过日的人）：优先不排，没人时才用
 * @returns {{chosen:Array, cursors:{A,B}, wrapped:boolean, short:number}}
 */
function pickBySeq(roster, scope, n, state, opt) {
  const o = opt || {};
  const avoid = o.avoidSeqs || new Set();
  const busy = o.busySeqs || new Set();
  const inBatch = o.inBatchSeqs || new Set();
  const skipSeqs = o.skipSeqs || null;
  const avoidSameDay = !!o.avoidSameDay;

  if (!state.cursors) state.cursors = { A: 0, B: 0 };
  if (!state.used) state.used = { A: new Set(), B: new Set() };
  // wrapped[g] = 本组本周期（本周生成内）是否已回绕过一次。
  // 全体课护栏靠它判断「两组是否在同一轮次」（详见下方全体课分支）。
  if (!state.wrapped) state.wrapped = { A: false, B: false };

  // 按组切池并升序排好（后面所有 filter[0] 都依赖这个顺序）
  const pools = { A: [], B: [] };
  (roster || []).forEach((m) => {
    if (!m || !(Number(m.seq) > 0)) return;
    if (skipSeqs && skipSeqs.has(Number(m.seq))) return;
    pools[m.group === 'B' ? 'B' : 'A'].push(m);
  });
  ['A', 'B'].forEach((g) => {
    pools[g].sort((a, b) => (a.seq - b.seq) || ((Number(a.id) || 0) - (Number(b.id) || 0)));
  });

  const localTaken = new Set();   // 本次调用内已取 —— 同一节课绝不排同一个人两次
  const soft = o.softSeqs || null;   // 软避让：优先不要，实在没人时才用
  const usable = (m) => !avoid.has(m.seq) && !localTaken.has(m.seq)
    && (!avoidSameDay || (!busy.has(m.seq) && !inBatch.has(m.seq)));
  /* 软避让不能改变「按序号递增」这条主线的单调性，只在**同级候选里挑更靠前**的那个人：
   * 先找「不在软避让名单里且序号最小」的，找不到才退回「序号最小的那个」。
   * 旧版 rotationPick 的四档里 `week`（本周已排）就是这个语义，这里等价保留。 */
  const best = (list) => (soft ? (list.find(m => !soft.has(m.seq)) || list[0]) : list[0]);

  let wrapped = false;

  /**
   * 从指定组取一个人。
   * 优先级：① 补漏（seq ≤ cursor 但本轮未排）→ ② 正常推进（seq > cursor 最小未排）
   *        → ③ 本组排完 → 开新一轮（清 used、cursor=0）从头取
   *        → null（剩下的未排者这次都不可用，等下一节补）
   */
  const takeFrom = (g) => {
    const pool = pools[g];
    const used = state.used[g];
    const okOf = (m) => !used.has(m.seq) && usable(m);
    const cur = Number(state.cursors[g]) || 0;
    // ① 补漏：序号在游标之前、但本轮还没排过的人
    const missed = pool.filter(m => m.seq <= cur && okOf(m));
    if (missed.length) return best(missed);
    // ② 正常推进
    const ahead = pool.filter(m => m.seq > cur && okOf(m));
    if (ahead.length) return best(ahead);
    // ③ 本组全员都排过 → 真·新一轮
    if (pool.length && pool.every(m => used.has(m.seq))) {
      used.clear();
      state.cursors[g] = 0;
      wrapped = true;
      state.wrapped[g] = true;
      return best(pool.filter(usable)) || null;
    }
    return null;
  };

  /* 全体课取人用的「只读窥探」—— 与 takeFrom 选人口径一致，但**不修改状态**：
   *   peekAhead(g) = 本组「正常推进」候选（seq > cursor 的最小可用），null = 本组已到本轮尾
   *   peekWrap(g)  = 本组「本轮已排完要开新一轮」时 takeFrom 会返回的人（全池最小可用），
   *                 用来在「两组都到尾」时比较回绕后谁先取，避免漏触发回绕。
   * 关键点：跨组比较**只用 ahead**，绝不让某组的「古老补漏（小号）」去抢另一组「现成 ahead（大号）」，
   *         否则会出现「A 已排到 55、B 才 54，全体课却把 A 的 3、5、7… 连续取走、B 的 56 晾住」的失衡。
   *         但某组到尾（无 ahead）时其回绕候选（最小可用）仍要被纳入比较，否则两组都到尾会漏触发回绕。 */
  const peekAhead = (g) => {
    const pool = pools[g];
    const used = state.used[g];
    const okOf = (m) => !used.has(m.seq) && usable(m);
    const cur = Number(state.cursors[g]) || 0;
    const ahead = pool.filter(m => m.seq > cur && okOf(m));
    return ahead.length ? best(ahead) : null;
  };
  const peekWrap = (g) => {
    const pool = pools[g];
    if (!pool.length) return null;
    // 取全池最小可用：本轮没排完时是「最小补漏」，本轮排完回绕后就是「新一轮最小号」
    return best(pool.filter(usable)) || null;
  };
  /* takeAhead(g)：优先取本组 ahead（与跨组比较口径一致），无 ahead 时退回 takeFrom 做补漏/回绕。
   * 两种情况下都负责 commit（takeFrom 自身不 commit）。 */
  const takeAhead = (g) => {
    let m = peekAhead(g);
    if (!m) m = takeFrom(g);
    if (m) commit(g, m);
    return m;
  };

  const other = (g) => (g === 'A' ? 'B' : 'A');

  const commit = (g, m) => {
    state.used[g].add(m.seq);
    localTaken.add(m.seq);
    /* ⚠️ 游标只前进不后退：补漏取到的人序号 < cursor 时不能把游标拽回去，
     *    否则「已推进到的位置」丢失，下一个课次会把刚补过的人前面那批重排一遍。 */
    if (m.seq > (Number(state.cursors[g]) || 0)) state.cursors[g] = m.seq;
  };

  const chosen = [];
  if (scope === 'A' || scope === 'B') {
    while (chosen.length < n) {
      const m = takeFrom(scope);
      if (!m) break;
      commit(scope, m);
      chosen.push(m);
    }
  } else {
    /* 全体课：两组混排。
     * ──────────────────────────────────────────────────────────────
     * 默认「取全局序号最小的两人」：每次比较 A/B 各自「下一个可用且序号最小（ahead）」的人，
     * 谁小取谁。落后组（ahead 小）因此自然被多取，自动追平 A/B 的序号差：
     *   · 例① B 游标 16、A 游标 9（A 落后）→ 全体课取 A 的 11、13（2A 追平）
     *   · 例② B 游标 16、A 游标 15（两组接近）→ 全体课取 A17、B18（自然回到 1A+1B）
     * 跨组比较**只用 ahead（seq>cursor）**，绝不让某组的「古老补漏（小号）」去抢另一组
     * 的「现成 ahead（大号）」—— 否则 A 排到 55、B 排到 54 时，A 的 3、5、7… 会被连续取走、
     * B 的 56 被晾住。补漏只在两组都到本轮尾时才参与比较（那时它本身就是回绕候选）。
     * ──────────────────────────────────────────────────────────────
     * ⚠️ 护栏（防失控，沿用旧教训，且**逐槽判定**）：若某一组本周期已回绕（state.wrapped 置位）
     *   而另一组还没回绕 ⇒ 两组不在同一轮次（回绕组游标被清零、序号瞬间变小），
     *   该槽强制退回 1A+1B 严格交替，避免回绕组被连续取而把另一组晾住。
     *   逐槽判定很关键：同一次全体调用内若某组刚回绕，下一槽就得立刻切到护栏，
     *   否则回绕组会在本次调用里就把搭档组 starve。 */
    if (state.allTurn !== 'B') state.allTurn = 'A';
    while (chosen.length < n) {
      const useGuardrail = (state.wrapped.A !== state.wrapped.B);
      let g, m;
      if (useGuardrail) {
        // —— 护栏路径：1A+1B 严格交替 ——
        g = state.allTurn;
        m = takeFrom(g);
        if (!m) { g = other(g); m = takeFrom(g); }
        if (!m) break;                       // 两组都取不出 → 报缺口
        commit(g, m);                        // takeFrom 自身不 commit，这里补上
        state.allTurn = other(g);
      } else {
        // —— 正常路径：跨组只比 ahead；两组都到尾才比回绕候选（peekWrap）——
        const aA = peekAhead('A');
        const bA = peekAhead('B');
        if (aA && bA) {
          g = (aA.seq <= bA.seq) ? 'A' : 'B';          // 两组都有 ahead：ahead 小的组优先（落后组追平）
        } else if (aA) {
          g = 'A';                                     // 仅 A 有 ahead：取 A（B 已到尾，让 A 推进）
        } else if (bA) {
          g = 'B';
        } else {
          const aW = peekWrap('A');                     // 两组都到尾：比回绕候选（最小可用），触发回绕
          const bW = peekWrap('B');
          if (aW && bW) g = (aW.seq <= bW.seq) ? 'A' : 'B';
          else if (aW) g = 'A';
          else if (bW) g = 'B';
          else break;                                  // 两组都取不出 → 报缺口
        }
        m = takeAhead(g);                              // 优先 ahead；无 ahead 时退回补漏/回绕（commit 在其中）
        if (!m) break;
      }
      chosen.push(m);
    }
    // 展示口径统一：全体课的成员按序号升序给出（取用顺序对使用者无意义）
    chosen.sort((a, b) => a.seq - b.seq);
  }

  return {
    chosen,
    cursors: { A: state.cursors.A, B: state.cursors.B },
    wrapped,
    short: Math.max(0, n - chosen.length)
  };
}

/**
 * 从「本轮已排标记」反推游标初值（**仅迁移 / 自愈兜底用**）。
 *
 * `class.round_cursor_*` 是权威值；本函数只在它缺失（0 / NULL / 首次迁移）时兜底。
 * 口径：取本组已排序号里**最靠右的那个连续段**的末尾。
 * 与旧 repairRoundMarks 同思路，但结果只用来初始化一次游标，之后由真实游标接管 ——
 * 所以即使推错，也只影响第一次。
 *
 * @param {Array} roster  [{seq, group, mark? | dutyCountThisRound?}]，mark>0 = 本轮已排
 * @param {string} scope  'A' | 'B'
 * @returns {number}      推断出的游标（0 = 推不出，按「从头开始」处理）
 */
function inferCursor(roster, scope) {
  const pool = (roster || [])
    .filter(m => m && Number(m.seq) > 0 && (!scope || m.group === scope))
    .sort((a, b) => a.seq - b.seq);
  if (!pool.length) return 0;
  const markOf = (m) => Number(m.mark !== undefined ? m.mark : m.dutyCountThisRound) || 0;
  let len = 0, bestLen = 0, bestEnd = 0;
  for (const m of pool) {
    if (markOf(m) > 0) {
      len += 1;
      // 同长取靠右那段（轮转按序号单调往上，真游标必在右段末尾）
      if (len >= bestLen) { bestLen = len; bestEnd = m.seq; }
    } else {
      len = 0;
    }
  }
  // 段长 < 2 不作为依据：手工把某人加进某节课也会让他的 mark 变 1，
  // 拿孤点当游标会把前面的人误判成"已排过"而跳过。
  return bestLen < 2 ? 0 : bestEnd;
}

module.exports = { pickBySeq, inferCursor, buildState };
