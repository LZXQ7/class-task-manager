/**
 * 门禁：AI 排课的 token 预算与「空返回」可诊断性
 * =========================================================================
 * 起因（2026-10-07线上事故「[40010] DeepSeek 返回内容为空」）：
 *   schedule.callAi 对所有模型一律max_tokens: 2000，注释写「值日表 JSON 实测
 *   ~150 token，2000 足够宽松」—— 这个估算**只对非推理模型成立**。
 *   库里配的模型是 deepseek-flash（reasoning 模型），thinking 计入 max_tokens：
 *   实测线上真实上下文（20 课次 + 55 人名册 ≈ 3.6k prompt tokens）
 *     flash + 2000 → finish_reason='length'，completion_tokens=2000 里 reasoning 占 2000（100%），
 *                   content 空 → 上游仍 HTTP 200 + 合法 JSON ⇒ 本地报「返回内容为空」
 *     flash + 8000 → finish_reason='stop'，reasoning 3126 + 正文 327（16s）
 *     chat  + 2000 → 正常（1.4s，completion_tokens仅 340）
 *   即预算被思考吃光，一个字都不留给正文。
 *
 * 本门禁钉住三件事：
 *   ① 预算不得低于 8000（AI_MAX_TOKENS），且ai-proxy 的兜底值同样 ≥ 8000；
 *   ② 空返回必须**按 finish_reason 归因**，不许再回退到「返回内容为空」这种
 *      排查黑洞（这正是本次事故难查的根因）；
 *   ③ aiCheck 自检显示的 model 必须是**实际会用的模型**（读库），不是常量
 *      AI_MODEL —— 否则排障时被显示值带偏（截图里显示 deepseek-chat，实发 flash）。
 *
 * 判据一律**剥注释**后匹配（stripComments）：本文件与被测源码里都有大段解释
 * 「原来 2000 不对」的注释，不剥会全部命中注释（本仓库已有5 次「判据命中注释」的失效记录）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHED = path.join(ROOT, 'cloudfunctions/schedule/index.js');
const PROXY = path.join(ROOT, 'cloudfunctions/ai-proxy/index.js');
const schedSrc = fs.readFileSync(SCHED, 'utf8');
const proxySrc = fs.readFileSync(PROXY, 'utf8');

/* ---- 剥注释（判据前必做）：去// 行注释与 /* *\/ 块注释，保留字符串字面量 ---- */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src.substr(i, 2);
    if (c2 === '/*') {
      i += 2;
      while (i < n && src.substr(i, 2) !== '*/') i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c2 === '//') {
      // 避开字符串里的 //
      let inStr = false, q = '';
      for (let j = i - 1; j >= 0; j--) {
        const p = src[j];
        if (inStr) { if (p === q && src[j - 1] !== '\\') inStr = false; continue; }
        if (p === '"' || p === "'" || p === '`') { inStr = true; q = p; }
      }
      if (inStr) { out += c; i++; continue; }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src.substr(i, 2); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const schedCode = stripComments(schedSrc);
const proxyCode = stripComments(proxySrc);

let fail = 0;
function check(label, cond, extra) {
  const okFlag = !!cond;
  if (!okFlag) fail++;
  console.log((okFlag ? 'PASS  ' : 'FAIL  ') + label + (extra ? '   → ' + extra : ''));
}

/* ========== ① token 预算 ========== */
const ANCHOR_BUDGET = 'const AI_MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 8000);';
check('锚点存在：AI_MAX_TOKENS 常量声明（防漂移）', schedCode.indexOf(ANCHOR_BUDGET) >= 0,
  schedCode.indexOf(ANCHOR_BUDGET) >= 0 ? '' : '实际声明：' +
  ((schedCode.match(/const AI_MAX_TOKENS[^\n]*/) || ['(未找到)'])[0]));

const mBudget = schedCode.match(/DEEPSEEK_MAX_TOKENS\s*\|\|\s*(\d+)/);
const budget = mBudget ? Number(mBudget[1]) : 0;
check('schedule 侧默认预算 ≥ 8000（实测 flash 思考需3126，须留余量）', budget >= 8000, '实际 ' + budget);

check('callAi 确实用的是该常量（不是又写死数字）',
  /max_tokens:\s*AI_MAX_TOKENS/.test(schedCode));

// ai-proxy 的兜底值：调用方漏传时用的那个
const mProxy = proxyCode.match(/Object\.assign\(\{\s*max_tokens:\s*(\d+)\s*\}/);
const pBudget = mProxy ? Number(mProxy[1]) : 0;
check('ai-proxy 兜底 max_tokens ≥ 8000（漏传时不能退回小预算）', pBudget >= 8000, '实际 ' + pBudget);

// 变异自证：把预算改回 2000，判据必须翻红
const MUT = schedCode.replace(ANCHOR_BUDGET, 'const AI_MAX_TOKENS = Number(process.env.DEEPSEEK_MAX_TOKENS || 2000);');
check('自证：变异真的发生了', MUT !== schedCode);
const mutBudget = Number(((MUT.match(/DEEPSEEK_MAX_TOKENS\s*\|\|\s*(\d+)/) || [])[1]) || 0);
check('自证：预算改回 2000 ⇒ 判据抓得住', mutBudget >= 8000 ? false : true, '变异后预算 ' + mutBudget);

/* ========== ② 空返回必须归因（不许黑洞报错） ========== */
/* 真实事故形态：HTTP 200 + 合法 JSON + finish_reason='length' + content 空 */
function makeEmptyResp(finishReason, withReasoning) {
  return {
    choices: [{ finish_reason: finishReason, message: { content: '', reasoning_content: '思考…' } }],
    usage: {
      completion_tokens: 2000,
      completion_tokens_details: withReasoning ? { reasoning_tokens: 2000 } : undefined
    }
  };
}

/* --- 抽 ai-proxy 的解析分支做运行时判定（不联网） --- */
/* 判据用「必须出现的三类归因文案 + 不能再出现裸的原始报错」双向夹逼 */
const WHY_KEYS = [
  { key: 'length', re: /fr === 'length'|finish_reason===\s*'length'|===\s*'length'/ },
  { key: 'content_filter', re: /content_filter/ },
  { key: 'reasoning-only', re: /reasoning_content|reasoning_tokens/ }
];
WHY_KEYS.forEach(w => {
  check('ai-proxy 空返回按 ' + w.key + ' 归因', w.re.test(proxyCode));
});
check('ai-proxy 空返回日志带usage（便于事后归因）',
  /empty content[\s\S]{0,200}usage=/.test(proxyCode));
check('ai-proxy 不再出现裸的「DeepSeek 返回内容为空」（必须带归因后缀）',
  proxyCode.indexOf("fail(40010, 'DeepSeek 返回内容为空')") < 0);
check('schedule 直连路径同样带归因（与代理一致）',
  /fr === 'length'/.test(schedCode) && /content_filter/.test(schedCode));

/* fail() 必须支持第 3 个诊断参数，否则 finishReason 会被静默丢弃 */
check('ai-proxy 的 fail() 接受第 3 个诊断参数（否则归因信息传不出去）',
  /function fail\(errCode,\s*errMsg,\s*data\)/.test(proxyCode));
check('空返回确实把 finishReason/reasoningTokens 放进 data',
  /finishReason:\s*fr/.test(proxyCode) && /reasoningTokens:\s*rt/.test(proxyCode));
check('schedule 侧把代理的诊断拼进异常信息（不吞掉）',
  /d0\.finishReason/.test(schedCode) && /finish_reason=/.test(schedCode));

/* 运行时行为验证：把 ai-proxy 的解析块抽出来喂三种空返回，断言文案不同 */
const parseStart = proxyCode.indexOf('const choice =');
const parseEnd = proxyCode.indexOf("return ok({ content, usage:", parseStart);
check('锚点存在：ai-proxy 解析块（防漂移）', parseStart >= 0 && parseEnd > parseStart);
if (parseStart >= 0 && parseEnd > parseStart) {
  const block = proxyCode.slice(parseStart, parseEnd);
  const console_ = console.error;
  console.error = () => {};                    // 别把预期中的错误日志喷到门禁输出
  /* 注入 fail：抽出的块里会调 fail(...)，不注入就是 ReferenceError（判据自身报错，
   * 而不是给出 PASS/FAIL —— 门禁必须能对「任何」被测代码给出结论）。 */
  const fail = (errCode, errMsg, data) => ({ errCode, errMsg, data: data === undefined ? null : data });
  const judge = new Function('data', 'body', 'fail', block);
  const msgs = {};
  [['length', true], ['content_filter', true], ['stop', true], ['', false]].forEach(([fr, rw]) => {
    const r = judge(makeEmptyResp(fr, rw), { model: 'm' }, fail);
    msgs[fr || '(empty)'] = (r && r.errMsg) || '';
  });
  console.error = console_;
  const u = msgs['length'], cf = msgs['content_filter'], st = msgs['stop'];
  check('运行时：finish_reason=length ⇒ 文案点名「截断/max_tokens」',
    /截断|max_tokens/.test(u), u);
  check('运行时：finish_reason=content_filter ⇒ 文案点名「安全策略」',
    /安全策略|拦截/.test(cf), cf);
  check('运行时：只回思考无正文 ⇒ 文案点名「思考」',
    /思考/.test(st), st);
  check('运行时：三类成因给出三种**不同**文案（不是同一句套话）',
    new Set([u, cf, st]).size === 3, [u, cf, st].join(' ||| '));
  check('运行时：文案不再是无信息量的「返回内容为空」结尾',
    ![u, cf, st].some(m => /DeepSeek 返回内容为空$/.test(m)));
  /* 诊断字段必须真的落到 data 上 —— 少传一个，schedule 侧就拿不到 finish_reason */
  const dLength = judge(makeEmptyResp('length', true), { model: 'm' }, fail);
  check('运行时：data 里带得出 finishReason + reasoningTokens',
    dLength && dLength.data && dLength.data.finishReason === 'length' && dLength.data.reasoningTokens === 2000,
    JSON.stringify(dLength && dLength.data));
}

/* ========== ③ aiCheck 显示实际模型 ========== */
check('aiCheck 用 resolveAiCfg 读库拿真实模型', /aiCfg = await resolveAiCfg/.test(schedCode));
check('aiCheck 把真实模型写进 out.model', /out\.model = aiCfg\.model/.test(schedCode));
check('aiCheck 标注模型来源（便于分辨是库配还是默认）', /modelSource/.test(schedCode));
/* ⚠️ 只能判aiCheck 这一段，不能全文件 indexOf —— aiShiftPlan（另一个路由）
 * 合法地自己读一次库（那里没有可复用的 aiCfg）。 */
const aiCheckSeg = (() => {
  const a = schedCode.indexOf('aiCheck: {');
  const b = schedCode.indexOf('aiPrompt: {', a);
  return a >= 0 ? schedCode.slice(a, b > a ? b : undefined) : '';
})();
check('锚点存在：aiCheck 路由段（防漂移）', aiCheckSeg.length > 0);
check('aiCheck 不再重复读库（probe 分支复用已读的 aiCfg）',
  /\]\s*,\s*45000,\s*aiCfg\)/.test(aiCheckSeg) &&
  aiCheckSeg.indexOf('45000, await resolveAiCfg') < 0,
  aiCheckSeg.match(/45000[^\n]*/g) || '(无)');

/* ========== ④ 把「为什么必须是非推理模型」固化成断言 ========== */
/*
 *🔴 这段结论**被实测推翻了两次**，务必留住最终版（2026-10-07）：
 *
 * 第 1 版结论（错）：「flash+8000 成功、reasoning 3126、16s ⇒ 8000 留 2.5倍余量，够用」。
 *   —— 那是**单次抽样**。端到端复验时 flash+8000 直接空（reasoning=8000 占满、35s）。
 * 第 2 版结论（也错）：「16000 总能收尾吧」。实测 flash+16000 → reasoning=13531、
 *   **耗时 60.7s**，而 schedule→ai-proxy 链路超时是 55s、ai-proxy 自身 45s ⇒ 必然超时。
 * 最终结论（实测三次，5倍方差）：
 *   flash   reasoning = 2779 / 4410 / 13531，耗时 8.8s~ 60.7s，**失败率约 1/3**
 *   v4-pro  reasoning = 4208 / 5266 / 7890，耗时 **48.5~92.3s**，第一次就length 截断（249字，非法 JSON）
 *   chat    无 reasoning，completion ≈ 330，耗时 **1.2~1.6s，3/3 稳定**
 *
 * ⇒ 推理模型的思考长度**不可控**，而本架构的函数间调用超时是**硬上限**。
 *   给小预算 → 思考吃光 → content 空；给大预算 → 撞超时。**没有任何 token 预算能让推理模型可靠工作**，
 *   这是架构约束而非参数问题 ⇒ 唯一正解是把 ai_setting.model 配成非推理模型（已改库为 deepseek-chat）。
 *
 * 门禁不该联网，所以这里断言的是**代码里写下的结论**与上述实测一致，
 * 防止后人①把预算改回 2000 ②看到 8000 能跑就以为推理模型也能用 ③再拿单次抽样下结论。
 */
const probe = {
  // 推理模型：思考长度区间（5 倍方差）与耗时上限（撞 55s 链路超时）
  flash: { reasoning: [2779, 4410, 13531], maxMs: 60700, emptyRate: '1/3' },
  v4pro: { reasoning: [4208, 5266, 7890], maxMs: 92300, emptyRate: '1/3(且首跑 length 截断成非法 JSON)' },
  chat:  { reasoning: null, maxMs: 1600, ok: '3/3' },
  linkTimeoutMs: 55000
};
check('实测：推理模型思考长度方差极大（flash 5 倍 / v4-pro 近 2 倍）',
  Math.max(...probe.flash.reasoning) / Math.min(...probe.flash.reasoning) >= 4);
check('实测：推理模型存在把预算吃光的情况（content 空）',
  probe.flash.emptyRate !== '0' && probe.v4pro.emptyRate !== '0');
check('实测：推理模型最慢耗时超过链路超时 55s ⇒ 大预算也救不了',
  probe.flash.maxMs > probe.linkTimeoutMs && probe.v4pro.maxMs > probe.linkTimeoutMs,
  'flash ' + probe.flash.maxMs + 'ms / v4-pro ' + probe.v4pro.maxMs + 'ms vs 链路 ' + probe.linkTimeoutMs + 'ms');
check('实测：非推理模型无思考、耗时 1~2s、稳定 3/3',
  probe.chat.reasoning === null && probe.chat.maxMs < 3000 && probe.chat.ok === '3/3');
check('预算 ≥ 8000 仍必要（但**只是必要条件**，不构成「推理模型可用」的结论）',
  budget >= 8000,
  '实际 ' + budget + '；推理模型可用性由模型选择决定，见下方文案断言');

/* 归因文案必须明确劝退推理模型（这是用户能看到的唯一指引） */
check('空返回文案劝「改用非推理模型」而非只说调大预算',
  /改用非推理模型/.test(proxyCode) && /改用非推理模型/.test(schedCode));
check('代码注释写明「推理模型在本架构不可用」的实测依据',
  /60\.7s|13531/.test(schedSrc) || /60\.7s|13531/.test(proxySrc),
  '防止后人仅凭单次抽样就下「8000 够用」的结论');

/* ---- 推理模型守卫：选到推理模型时要当场说人话，而不是等排课失败 ---- */
check('存在推理模型识别函数 looksReasoning（保守匹配）',
  /function looksReasoning\(/.test(schedCode)&&
  /flash|pro|reason|r1|think/i.test(schedCode));
check('callAi 命中推理模型 + length 时给出「换模型」的可执行建议',
  /looksReasoning\(model\)/.test(schedCode) && /deepseek-chat（非推理模型/.test(schedCode));
check('aiCheck 选到推理模型时**当场**告警（out.reasoningModel）',
  /out\.reasoningModel = looksReasoning\(out\.model\)/.test(schedCode));
/* ⚠️ 这条是本轮真踩的坑：ping 分支原本 `out.error = d.error || ''` 会**覆盖**掉
 * 上面写好的推理模型警告 —— 而出口 ping 一切正常恰恰是推理模型场景的常态，
 * 于是又变成「自检全绿但排课失败」。判据钉死必须用累加。 */
const aiCheckPingSeg = (() => {
  const a = schedCode.indexOf("out.httpStatus = d.httpStatus || 0;");
  return a >= 0 ? schedCode.slice(a, a + 400) : '';
})();
check('aiCheck 的 ping 分支用累加而非覆盖（推理模型警告不会被抹掉）',
  /out\.error = \[out\.error, d\.error \|\| ''\]/.test(aiCheckPingSeg),
  aiCheckPingSeg.match(/out\.error =[^\n]*/g) || '(未找到)');

/* 变异自证：把累加改回覆盖，判据必须翻红（证明上面那条不是恒真） */
if (aiCheckPingSeg) {
  const segMUT = aiCheckPingSeg.replace(
    /out\.error = \[out\.error, d\.error \|\| ''\]\.filter\(Boolean\)\.join\(' \| '\)/,
    "out.error = d.error || ''");
  check('自证：ping 覆盖式赋值 ⇒ 守卫判据抓得住',
    /out\.error = \[out\.error, d\.error \|\| ''\]/.test(segMUT) ? false : true,
    '变异后为覆盖式');
}

console.log('\n' + (fail === 0 ? '全部通过 ✅' : fail + ' 项失败 ❌'));
process.exit(fail === 0 ? 0 : 1);
