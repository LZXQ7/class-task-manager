/**
 * 门禁：ai-proxy「自定义接口地址」三道闸（需求 D，2026-09-27）
 * ------------------------------------------------------------
 * 背景：ai-proxy 是全环境**唯一不绑 VPC、有公网出口**的函数。需求 D 允许各班
 * 自带大模型密钥与接口地址后，它就从「只访问官方 DeepSeek」变成了
 * 「可被配置成访问任意地址」—— 一旦防护有缺口，就是一条**可被借道的内网探测通道**：
 *   ① SSRF：填内网地址（含 169.254.169.254 元数据）→ 直连内网；
 *   ② 密钥进日志：地址带 `?key=…` → fetch 失败时 Node 把完整 URL 写进 error.message，
 *      本函数又会把 e.message 打进日志 ⇒ 密钥落日志；
 *   ③ 内容回显：把自定义地址的响应原文回传给调用方 ⇒ 任意地址请求 + 内容回显。
 * 另有「跟随跳转」绕过 ①（可 302 到内网），也必须堵。
 *
 * 判据分两层：**A 文本层**（闸的实现在源码里）+ **B 行为层**（抽生产源码 eval 真跑），
 * 并带**变异自证**：故意改坏每一条，门禁必须翻红。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
const ok = m => console.log('  ✓ ' + m);
const bad = m => { failed++; console.log('  ✗ ' + m); };
const has = (s, re, msg) => (re.test(s) ? ok(msg) : bad(msg));

const SRC = read('cloudfunctions/ai-proxy/index.js');
const SCHED = read('cloudfunctions/schedule/index.js');
const MEMBER = read('cloudfunctions/member/index.js');
const SQLSRC = read('scripts/migrate-ai-setting.sql');

/** 取某个具名块的正文（`  xxx: {` 起，花括号配对） */
function blockOf(src, name) {
  const anchor = '\n  ' + name + ': {';
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const open = i + anchor.length - 1;   // ⚠️ -1：起点必须落在 anchor 自己的 { 上
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(open, k + 1); }
  }
  return '';
}

/* ============================================================
 * A 文本层：三道闸 + 禁跳转 都在源码里
 * ============================================================ */
console.log('── A 文本层：闸的实现存在');
has(SRC, /async function resolveEndpoint\(raw\)/, '有 resolveEndpoint（统一入口）');
has(SRC, /if \(\/\[\?#\]\/\.test\(s\)\) throw/, '闸②：禁止地址带 ? 或 #（防密钥进日志）');
has(SRC, /const u = await assertPublicUrl\(s\);/, '闸①：自定义地址过 assertPublicUrl');
has(SRC, /if \(!ALLOWED_PORTS\.has\(u\.port\)\) throw/, '闸①b：端口白名单');
has(SRC, /redirect: ep\.custom \? 'manual' : 'follow'/, '禁跳转：自定义地址不跟随 3xx（防 302 绕 SSRF）');
has(SRC, /if \(ep\.custom && res\.status >= 300 && res\.status < 400\)/, '自定义地址遇到 3xx 直接报错而非跟随');
// 闸③：自定义分支的错误返回**不得**包含响应体（text.slice）
const CUSTOM_ERR = /if \(ep\.custom\) \{\s*console\.error\('\[ai-proxy\] upstream\(custom\)', res\.status[\s\S]{0,300}?return fail\(40010, '接口返回 HTTP ' \+ res\.status[^;]*?\);\s*\}/.exec(SRC);
if (CUSTOM_ERR && !/text\.slice/.test(CUSTOM_ERR[0])) ok('闸③：自定义地址出错不回显响应体');
else bad('闸③：自定义地址的错误分支回显了响应体（= 内网探测通道）或未找到该分支');
has(SRC, /const apiKey = String\(\(event && event\.apiKey\) \|\| ''\)\.trim\(\) \|\| process\.env\.DEEPSEEK_API_KEY \|\| ''/,
  '密钥：班级自带优先，缺省回落平台密钥');
has(SRC, /ping\(event && event\.baseUrl, event && event\.apiKey\)/, 'ping 也支持带自定义地址与密钥（连通性测试）');

/* ============================================================
 * B 行为层：抽生产源码 eval，真跑 resolveEndpoint
 * ============================================================ */
console.log('\n── B 行为层：真跑一遍');

/** 抽出 resolveEndpoint / assertPublicUrl（生产源码，不写副本） */
function load(src) {
  const body = String(src).replace(/exports\.main[\s\S]*$/, '');
  const factory = new Function('require', 'process',
    body + '\nreturn { resolveEndpoint, assertPublicUrl, isPrivateIp, DEFAULT_BASE, ALLOWED_PORTS };');
  return factory(require, { env: { DEEPSEEK_BASE_URL: 'https://api.deepseek.com', AI_TIMEOUT_MS: '45000' } });
}

let mod;
try {
  mod = load(SRC);
  ok('生产源码可加载（require / process 桩化）');
} catch (e) {
  bad('生产源码加载失败：' + String((e && e.message) || e));
}

const CASES = [
  ['官方默认（留空）', '', false, 'https://api.deepseek.com'],
  ['自定义官方域名', 'https://api.deepseek.com', true, 'https://api.deepseek.com'],
  ['自定义带路径', 'https://api.deepseek.com/v1/', true, 'https://api.deepseek.com/v1'],
  ['闸② 带 query', 'https://api.deepseek.com/v1?key=sk-xxx', null, null],
  ['闸② 带 hash', 'https://api.deepseek.com/v1#a', null, null],
  ['闸① 回环', 'http://127.0.0.1:8080', null, null],
  ['闸① 内网 10 段', 'http://10.0.0.5/v1', null, null],
  ['闸① 元数据 169.254', 'http://169.254.169.254/latest/meta-data', null, null],
  ['闸① 172.16 段', 'http://172.16.0.1', null, null],
  ['闸① localhost', 'http://localhost:11434', null, null],
  ['闸① 非 http 协议', 'ftp://api.deepseek.com', null, null],
  // 端口闸必须用**可解析**的域名：用不存在的域名会在端口检查之前就因 DNS 失败被拒，
  // 那样门禁绿了但**根本没测到端口闸**（2026-09-27 实测踩到）。
  ['闸①b 非常规端口', 'https://api.deepseek.com:9999', null, null],
];

(async () => {
  if (mod) {
    for (const [label, input, wantCustom, wantBase] of CASES) {
      let got = null;
      try { got = await mod.resolveEndpoint(input); } catch (e) { got = { threw: String((e && e.message) || e) }; }
      if (wantCustom === null) {
        if (got && got.threw) ok(label + ' → 已拒绝（' + got.threw.slice(0, 40) + '）');
        else bad(label + ' **竟被放行** → ' + JSON.stringify(got));
      } else if (got && !got.threw && got.custom === wantCustom && got.base === wantBase) {
        ok(label + ' → 放行，base=' + got.base);
      } else {
        bad(label + ' → 结果不符：实得 ' + JSON.stringify(got) + '，期望 {custom:' + wantCustom + ', base:' + wantBase + '}');
      }
    }
  }

  /* ============================================================
   * C 变异自证：把每条闸改坏，门禁必须翻红
   * ============================================================ */
  console.log('\n── C 变异自证');
  /**
   * ⚠️ 变异必须**全量替换**：`String.replace(from, to)` 只换第一处。
   * `redirect: ep.custom ? 'manual' : 'follow'` 在 ping 与 chat 里各出现一次且逐字相同，
   * 只换一处 → 另一处仍在 → 判据照样匹配 → 变异「没翻红」其实是**假通过**
   * （与 check-duty-marker-symmetry 的 `- (ownAuto.get(…))` 是同一族坑，2026-09-27 又踩到）。
   */
  const mut = (from, to) => (SRC.indexOf(from) < 0 ? null : SRC.split(from).join(to));
  const MUT = [
    ['闸② 放开 query/hash', mut("if (/[?#]/.test(s)) throw", "if (false) throw"),
      s => !/if \(\/\[\?#\]\/\.test\(s\)\) throw/.test(s)],
    ['闸① 跳过公网校验', mut('const u = await assertPublicUrl(s);', 'const u = new URL(s);'),
      s => !/const u = await assertPublicUrl\(s\);/.test(s)],
    ['闸①b 放开端口', mut('if (!ALLOWED_PORTS.has(u.port)) throw', 'if (false) throw'),
      s => !/if \(!ALLOWED_PORTS\.has\(u\.port\)\) throw/.test(s)],
    ['恢复跟随跳转（302 绕 SSRF）', mut("redirect: ep.custom ? 'manual' : 'follow'", "redirect: 'follow'"),
      s => !/redirect: ep\.custom \? 'manual' : 'follow'/.test(s)],
    ['闸③ 回显响应体', mut("return fail(40010, '接口返回 HTTP ' + res.status + '（自定义地址不回显响应内容，请核对地址与密钥）');",
      "return fail(40010, '接口返回 HTTP ' + res.status + '：' + text.slice(0, 180));"),
      s => {
        const m = /if \(ep\.custom\) \{\s*console\.error\('\[ai-proxy\] upstream\(custom\)'[\s\S]{0,300}?return fail\(40010, '接口返回 HTTP ' \+ res\.status[^;]*?\);\s*\}/.exec(s);
        return !m || /text\.slice/.test(m[0]);
      }],
  ];
  MUT.forEach(([label, mutated, judge]) => {
    if (mutated === null) { bad('自证：[' + label + '] 变异锚点未命中（源码已变，需同步判据）'); return; }
    if (judge(mutated)) ok('自证：' + label + ' → 翻红 ✓');
    else bad('自证：' + label + ' 竟未翻红（判据抓不到）');
  });
  // 好样本：真实源码必须全绿
  const good = /if \(\/\[\?#\]\/\.test\(s\)\) throw/.test(SRC)
    && /const u = await assertPublicUrl\(s\);/.test(SRC)
    && /if \(!ALLOWED_PORTS\.has\(u\.port\)\) throw/.test(SRC)
    && /redirect: ep\.custom \? 'manual' : 'follow'/.test(SRC);
  if (good) ok('真实源码零失败（好样本不误报）');
  else bad('真实源码被判红 → 判据写错了');

  /* ============================================================
   * D 口径：密钥「只回掩码」与「撤职不清」两条生命周期规则
   * ============================================================ */
  console.log('\n── D AI 设置口径（跟随本人 / 只回掩码 / 撤职不清）');
  has(SQLSRC, /member_id\s+INT\s+NOT\s+NULL/, '表按 member_id（跟随本人，不是班）');
  has(SQLSRC, /UNIQUE KEY uk_member \(member_id\)/, '一人一条（uk_member 唯一键）');
  has(SCHED, /async function loadAiSetting\(pool, memberId\)/, 'loadAiSetting 按 member_id 取');

  // 只回掩码：aiSettingGet 的返回体里**不得**出现 api_key
  const getBlk = blockOf(SCHED, 'aiSettingGet');
  if (!getBlk) bad('找不到 aiSettingGet 路由');
  else {
    /*
     * 逐处检查 `s.api_key` 的出现点：处在 `maskKey(` 或 `!!(` 之内才算安全。
     *   · `configured: !!(s && s.api_key)`  只判断有没有填 → 安全；
     *   · `keyMask: maskKey(s && s.api_key)` 传给掩码函数 → 安全；
     *   · `apiKey: s.api_key` / `apiKey: (s && s.api_key) || ''` → **泄露**，必翻红。
     * ⚠️ 前两版判据都栽在「正则只认紧邻的 `: `」：
     *    第一版禁止出现 api_key 一词 → 把上面两种合法的也打成红（过粗）；
     *    第二版要求 `s.api_key` 后紧接 `,` 或 `}` → 漏掉 `(s && s.api_key) || ''`
     *    这种加了括号与兜底值的写法（**过窄 = 假通过**，2026-09-27 实测）。
     *    所以改成「按出现点判上下文」，不看它是不是紧跟冒号。
     */
    const leaks = [];
    const reKey = /s\.api_key/g;
    let mm;
    while ((mm = reKey.exec(getBlk))) {
      const before = getBlk.slice(Math.max(0, mm.index - 40), mm.index);
      const safe = /maskKey\([^()]*$/.test(before) || /!!\([^()]*$/.test(before);
      if (!safe) leaks.push(getBlk.slice(Math.max(0, mm.index - 28), mm.index + 16).replace(/\s+/g, ' '));
    }
    if (leaks.length) bad('aiSettingGet 的返回里有 api_key 明文外泄 → ' + leaks.join(' | '));
    else ok('aiSettingGet 只回掩码（每处 api_key 都在 maskKey / 布尔判断内）');
  }
  has(SCHED, /keyMask: maskKey\(/, 'aiSettingGet 回 keyMask');
  has(SCHED, /function maskKey\(key\)/, 'maskKey 存在（掩码函数）');

  // 平台密钥仅超管兜底
  has(SCHED, /if \(!key && !guard\.isSuper\(me\)\)[\s\S]{0,120}?平台密钥仅超级管理员可用/,
    '无自带密钥时仅超管可回落平台密钥');
  has(SCHED, /if \(!apiKey && !guard\.isSuper\(me\)\)/, '保存时同样卡「非超管必须自带密钥」');

  // 生命周期：清行只在「删人」处，**不得**出现在 setPosition（撤职不清）
  const clearHits = (MEMBER.match(/DELETE FROM ai_setting/g) || []).length;
  if (clearHits >= 2) ok('member 侧在删人路径清理 ai_setting（' + clearHits + ' 处）');
  else bad('member 删人时未清理 ai_setting（会留孤儿钥匙行）');
  const setPosBlk = blockOf(MEMBER, 'setPosition');
  if (setPosBlk && /ai_setting/.test(setPosBlk)) bad('setPosition 里出现了 ai_setting → 撤职会清密钥（**不可逆**，违反定案）');
  else ok('setPosition 不碰 ai_setting（撤销职位保留密钥）');

  console.log('');
  if (failed) { console.log('❌ 失败 ' + failed + ' 项'); process.exit(1); }
  console.log('OK · ai-proxy 自定义地址三道闸校验通过');
})();
