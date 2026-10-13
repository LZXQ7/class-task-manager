/**
 * 在线实测 AI 排班（需要网络 + DEEPSEEK_API_KEY）
 * ------------------------------------------------------------
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/probe-ai-prompt.js
 *   DEEPSEEK_API_KEY=sk-xxx node scripts/probe-ai-prompt.js "自定义的自然语言"
 *   # 复现线上事故（推理模型 + 小预算 ⇒ content 空）：
 *   DS_MODEL=deepseek-flash DS_MAX_TOKENS=2000 DEEPSEEK_API_KEY=sk-xxx node scripts/probe-ai-prompt.js
 *
 * ⚠️ DS_MAX_TOKENS 默认 8000，**与生产 callAi 同源**。别为了"快"改回 2000：
 * reasoning 模型的 thinking 计入 max_tokens，预算被吃光会得到
 * finish_reason='length' + content 空（2026-10-07 线上事故的根因）。
 *
 * 它做的事：
 *   ① 从 cloudfunctions/schedule/index.js 里**原样抽出** DEFAULT_AI_PROMPT 与 validatePlan；
 *   ② 按真实第 2 周（2026-09-21 ~ 09-24）造一份上下文，与 buildAiContext 输出结构一致；
 *   ③ 组装成与 aiPlan 完全相同的 user 消息，真实调用 DeepSeek；
 *   ④ 打印耗时、模型原始返回、validatePlan 之后的计划与告警。
 *
 * 为什么要有它：MCP invokeFunction 没有 WX 上下文，aiPlan 是 needSuper 路由，
 * 没法在本地直接调；而提示词的效果只有真打一次模型才知道。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/schedule/index.js'), 'utf8');

/* ---------------- 从源码抽函数 / 常量 ---------------- */
function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('找不到函数 ' + name);
  const end = SRC.indexOf('\n}', start);
  if (end < 0) throw new Error('找不到函数 ' + name + ' 的结尾');
  return SRC.slice(start, end + 2);
}
function extractPrompt() {
  const start = SRC.indexOf('const DEFAULT_AI_PROMPT');
  const end = SRC.indexOf('].join(\'\\n\');', start);
  if (start < 0 || end < 0) throw new Error('找不到 DEFAULT_AI_PROMPT');
  return new Function(SRC.slice(start, end + '].join(\'\\n\');'.length) + ' return DEFAULT_AI_PROMPT;')();
}
const validatePlan = new Function(extractFn('validatePlan') + '\n return validatePlan;')();
const DEFAULT_AI_PROMPT = extractPrompt();

/* ---------------- 真实第 2 周上下文 ---------------- */
const TERM_START = '2026-09-14';
function pad(n) { return n < 10 ? '0' + n : String(n); }
function dateOf(wk, dow) {
  const d = new Date(2026, 8, 14);
  d.setDate(d.getDate() + (wk - 1) * 7 + (dow - 1));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// 库内 session（只列第 2 周会上的 12 个）
const RAW = [
  { id: 2, day: 1, period: 2, course: '微课设计与制作', room: '3号楼109', group: 'A', duty: 2 },
  { id: 5, day: 1, period: 3, course: '习近平新时代中国特色社会主义思想概论', room: '3号楼213', group: null, duty: 2 },
  { id: 3, day: 1, period: 4, course: '微课设计与制作', room: '3号楼109', group: 'B', duty: 2 },
  { id: 8, day: 2, period: 1, course: '小学人工智能教育', room: '3号楼110', group: 'A', duty: 2 },
  { id: 10, day: 2, period: 2, course: '小学数学课程与教学论', room: '3号楼305', group: null, duty: 2 },
  { id: 22, day: 2, period: 5, course: '三笔字', room: '3号楼111', group: 'A', duty: 2 },
  { id: 9, day: 3, period: 1, course: '小学人工智能教育', room: '3号楼110', group: 'B', duty: 2 },
  { id: 13, day: 3, period: 3, course: '小学生心理健康指导', room: '3号楼121', group: 'A', duty: 2 },
  { id: 14, day: 3, period: 4, course: '小学生心理健康指导', room: '3号楼123', group: 'B', duty: 2 },
  { id: 15, day: 3, period: 5, course: '音乐基础', room: '二区302', group: 'A', duty: 2 },
  { id: 17, day: 4, period: 2, course: '小学语文课程与教学论', room: '3号楼303', group: null, duty: 2 },
  { id: 16, day: 4, period: 5, course: '音乐基础', room: '二区302', group: 'B', duty: 2 }
];

// 库内第 2 周已排的真实人员（与 duty_count 一致）
const DUTY = {
  2: [1, 3], 5: [2, 4], 3: [6, 8],
  8: [9, 11], 10: [10, 12], 22: [13, 15],
  9: [14, 16], 13: [17, 19], 14: [18, 20], 15: [21, 23],
  17: [22, 24], 16: [26, 28]
};

const DAY_TEXT = ['一', '二', '三', '四', '五', '六', '日'];
const byDate = {};
RAW.forEach(r => {
  const date = dateOf(2, r.day);
  (byDate[date] = byDate[date] || []).push(r);
});

const sessions = RAW.map(r => {
  const date = dateOf(2, r.day);
  const sameDay = byDate[date].reduce((acc, x) => acc.concat(DUTY[x.id] || []), []);
  return {
    sessionId: r.id,
    date,
    dayOfWeek: r.day,
    dayText: '周' + DAY_TEXT[r.day - 1],
    period: r.period,
    course: r.course,
    room: r.room,
    groupScope: r.group,
    dutyCount: r.duty,
    existingDutySeqs: (DUTY[r.id] || []).slice(),
    busySameDaySeqs: sameDay.slice(),
    onLeaveSeqs: []
  };
});

// 名册：56 人，奇=A 偶=B；本轮已排 = 01–24 + 26、28（与库内 duty_count 一致）
const DONE = {};
for (let i = 1; i <= 24; i++) DONE[i] = 1;
DONE[26] = 1; DONE[28] = 1;

const roster = [];
const idBySeq = new Map();
const seqById = new Map();
for (let seq = 1; seq <= 56; seq++) {
  const id = 100 + seq;
  idBySeq.set(seq, id);
  seqById.set(id, seq);
  roster.push({
    seq,
    name: '学生' + seq,
    group: seq % 2 === 1 ? 'A' : 'B',
    dutyCountThisRound: DONE[seq] || 0,
    lastDutyAt: DONE[seq] ? '2026-09-24' : null
  });
}

const ctx = {
  cfg: { termStart: TERM_START, totalWeeks: 16 },
  roster, sessions, seqById, idBySeq,
  weekStart: dateOf(2, 1)
};

/* ---------------- 调用 DeepSeek ---------------- */
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) {
  console.error('缺少 DEEPSEEK_API_KEY 环境变量');
  process.exit(1);
}

const TEXT = process.argv.slice(2).join(' ') ||
  'a组23号之前全部排过了，b组20号之前全部排过了。从周四，第二节开始排';

async function ask(text) {
  const modelPayload = {
    week: 2,
    weekStart: ctx.weekStart,
    sessions: ctx.sessions,
    roster: ctx.roster.map(r => ({ seq: r.seq, group: r.group, dutyCountThisRound: r.dutyCountThisRound }))
  };
  const userMsg = [
    '【使用者要求】',
    text,
    '',
    '【本周上下文 JSON】',
    JSON.stringify(modelPayload),
    '',
    '请只回复符合上述结构的 JSON，不要输出任何其他文字。'
  ].join('\n');

  const t0 = Date.now();
  /*
   * ⚠️ token 预算与生产同源（原先写死 2000 + 模型写死 deepseek-chat）：
   * 2026-10-07 线上事故的根因就是「2000 对推理模型不够」——thinking 计入 max_tokens，
   * 预算被吃光 ⇒ finish_reason='length'、content 空 ⇒ 报「返回内容为空」。
   * 本探针若还用 2000，去测 deepseek-flash 会**复现失败并得出错误结论**。
   * 现在与 schedule.callAi 一致：模型可由命令行覆盖（默认 deepseek-chat），预算 8000。
   */
  const model = process.env.DS_MODEL || 'deepseek-chat';
  const maxTokens = Number(process.env.DS_MAX_TOKENS || 8000);
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DEFAULT_AI_PROMPT },
        { role: 'user', content: userMsg }
      ]
    })
  });
  const json = await res.json();
  const ms = Date.now() - t0;
  if (!res.ok) {
    console.error('HTTP ' + res.status, JSON.stringify(json).slice(0, 400));
    return;
  }
  const choice = (json.choices && json.choices[0]) || null;
  const content = choice && choice.message && choice.message.content;
  console.log('── 耗时 ──');
  console.log(ms + ' ms   model=' + model + ' max_tokens=' + maxTokens
    + '   tokens: ' + JSON.stringify(json.usage));
  console.log('finish_reason: ' + String((choice && choice.finish_reason) || '(none)'));
  if (!content) {
    // 与生产同款归因，避免探针自己变成「无信息量报错」的受害者
    const fr = String((choice && choice.finish_reason) || '');
    const rt = json.usage && json.usage.completion_tokens_details && json.usage.completion_tokens_details.reasoning_tokens;
    console.error('\n!! content 为空 —— ' + (fr === 'length'
      ? '输出被 max_tokens=' + maxTokens + ' 截断（推理模型的思考吃满了预算），请调大 DS_MAX_TOKENS'
      : (fr === 'content_filter' ? '内容被安全策略拦截'
        : (rt ? '只回了思考没有正文（思考 ' + rt + ' token）' : '上游未给出任何内容'))));
    return;
  }
  console.log('\n── 模型原始返回 ──');
  console.log(content);

  let raw;
  try { raw = JSON.parse(content); } catch (e) {
    console.log('\n!! 不是合法 JSON，parseJsonLoose 也救不回来');
    return;
  }
  const v = validatePlan(ctx, raw);
  console.log('\n── 校验后计划（这就是前端预览要显示的东西） ──');
  v.plan.forEach(p => {
    console.log(
      (p.dayText + ' 第' + p.period + '节').padEnd(12) +
      (p.course || '').slice(0, 12).padEnd(14) +
      ('【' + (p.groupScope || '全体') + '】').padEnd(8) +
      p.memberSeqs.map(s => s + '号').join('、').padEnd(20) +
      (p.kept ? '（保持原样）' : '')
    );
  });
  console.log('\n── 告警 ──');
  console.log(v.warnings.length ? v.warnings.join('\n') : '（无）');
  console.log('\n── AI 说明 ──');
  console.log(v.notes || '（无）');
  console.log('\n── 汇总 ──');
  console.log('unchanged: ' + JSON.stringify(raw.unchanged || []));
  console.log('skipSeqs : ' + JSON.stringify(v.skipSeqs));
  console.log('重排课次 : ' + v.plan.filter(p => !p.kept).length + ' / 保持原样: ' + v.plan.filter(p => p.kept).length);
}

ask(TEXT).catch(e => console.error('失败：', e));
