/**
 * 视觉门禁 · 变异注入验收用例
 * ═══════════════════════════════════════════════════════════════════════════
 * 目的：验证门禁「改坏了会红」，**且**「没坏不会乱红」。
 *
 * 跑的是**真实的** scripts/check-admin-css-tokens.js（复制到临时目录 + 注入变异）。
 *
 * 两类用例，缺一不可：
 *   A 类「必须翻红」—— 注入了真实违规，门禁必须抓到（抓不到 = 假绿）
 *   B 类「必须保持绿」—— 注入的是无害改动，门禁不该报（报出来 = 误报）
 *   只测 A 类会漏掉"误报"这一半；只测 B 类会漏掉"假绿"这一半。
 *
 * ⚠️⚠️ 三个必须知道的坑（本文件作者都踩过）：
 *
 *  坑① **变异必须插在规则块的最后**。
 *       CSS 层叠是「后写覆盖先写」，门禁的 declOf() 也实现 last-wins
 *       ⇒ 插在已有声明**之前**等于没改 ⇒ 变异会「假漏」。
 *       本文件用 appendToBlock() 强制追加到块尾。
 *
 *  坑② **harness 本身必须自检**。
 *       否则「全都漏掉」和「harness 没生效」分不清 ⇒ 结论不可信。
 *       本文件先注入一个 §① 必定抓到的违规（未定义变量），必须翻红才算 harness 有效。
 *
 *  坑③ **A 类与 B 类的期望相反**，别写混。
 *       本文件用 expect: 'red' | 'green' 显式区分。
 *
 * 退出码：0 = 全部用例符合预期；1 = 有用例不符合预期。
 *
 * 落位说明（2026-11-16）：本文件原在 outputs/，靠人手跑。门禁 runner
 * （scripts/run_all_gates.sh）只自动发现 scripts/check-*.js ⇒ 未搬进来之前它
 * 等于不存在：改坏了 CSS 没人会记得手动跑这份验收。现搬到 scripts/ 并改名 check-*，
 * 进入全量门禁。产物只在系统临时目录（os.tmpdir()），不污染工作区。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_CSS = path.join(ROOT, 'cloudfunctions/admin-web/public/admin.css');
const SRC_GATE = path.join(ROOT, 'scripts/check-admin-css-tokens.js');

/* 临时目录建在**工作区内**（.wb_tmp/，已 gitignore），不用 os.tmpdir()。
   🔴 2026-11-16 实测：原来用 os.tmpdir()（= %TEMP%），单跑必绿，但经
   scripts/run_all_gates.sh 连续 spawn 大量 node 后 mkdtempSync 会拿不到可写目录
   （沙箱对临时目录的授权与普通调用不同）⇒ 本门禁**稳定报红**，
   13 次嵌套调用全废、A 类全「未跑成」，把真实回归淹掉。
   与项目里「Git Bash 的 /tmp 不可写，临时目录建在工作区」是同一条经验。 */
const tmpRoot = path.join(ROOT, '.wb_tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(tmpRoot, 'cssgate-'));
const tmpPublic = path.join(tmp, 'cloudfunctions/admin-web/public');
const tmpScripts = path.join(tmp, 'scripts');
fs.mkdirSync(tmpPublic, { recursive: true });
fs.mkdirSync(tmpScripts, { recursive: true });
fs.copyFileSync(SRC_CSS, path.join(tmpPublic, 'admin.css'));
fs.copyFileSync(SRC_GATE, path.join(tmpScripts, 'check-admin-css-tokens.js'));

const SPAWN_FAIL = -99;   // 单独一档：区分「门禁报错(1)」与「进程根本没起来」
function runGate(css) {
  fs.writeFileSync(path.join(tmpPublic, 'admin.css'), css);
  /* ⚠️ 用 process.execPath 而不是字符串 'node'（2026-11-16 实测）：
     全量门禁在 Windows 上连续快速 spawn 大量 node 进程，靠 PATH 解析的 'node'
     偶发起不来（ENOENT/EPERM）⇒ 本文件 13 次嵌套调用全废 ⇒ 每条用例都拿到
     非 0 退出码 ⇒ A 类全「翻红」、B 类全「误报」⇒ 整道门禁固定报红。
     换成当前解释器的绝对路径，不依赖 PATH，也不依赖 PATHEXT。 */
  try {
    const out = execFileSync(process.execPath, [path.join(tmpScripts, 'check-admin-css-tokens.js')],
      { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    if (e.status === undefined || e.status === null) {
      return { code: SPAWN_FAIL, out: String(e.message || e) };
    }
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const base = fs.readFileSync(SRC_CSS, 'utf8');

function appendToBlock(css, selector, decl) {
  const re = new RegExp('(' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{)([^}]*)(\\})');
  if (!re.test(css)) throw new Error('未找到规则块：' + selector);
  return css.replace(re, (s, a, body, c) => a + body + '\n  ' + decl + '\n' + c);
}
function replaceInBlock(css, selector, from, to) {
  const re = new RegExp('(' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{)([^}]*)(\\})');
  if (!re.test(css)) throw new Error('未找到规则块：' + selector);
  if (css.indexOf(from) < 0) throw new Error('未找到待替换文本：' + from);
  return css.replace(re, (s, a, body, c) => a + body.replace(from, to) + c);
}

// ═════════ A 类：注入违规 ⇒ 必须翻红 ═════════
const MUST_RED = [
  { id: 'A1', type: '类型① 饱和主色当文字色',
    desc: 'color: var(--brand) —— 本轮真实发生 8 处的那一类。⚠️ 本例依赖【T7 父级背景】：.dry-warn 自身无背景（继承自 .dry-box）⇒ 未解 T7 前必漏',
    css: appendToBlock(base, '.dry-warn', 'color: var(--brand);') },
  { id: 'A2', type: '类型② 饱和底 + 白字',
    desc: 'color:#fff + background:var(--brand) —— 门禁 §⑦ 已覆盖',
    css: appendToBlock(base, '.dry-warn', 'color: #fff;\n  background: var(--brand);') },
  { id: 'A3', type: '类型③ 跨规则继承',
    desc: '.cmp-tag 基础类给 color:#fff + .cmp-tag-a 修饰类给 background',
    css: appendToBlock(appendToBlock(base, '.cmp-tag-a', 'background: var(--chart-1);'), '.cmp-tag', 'color: #fff;') },
  { id: 'A4', type: '层叠：重复定义同一选择器',
    desc: '后写的生效值违规（.metric-chip.active 追加一条 color）',
    css: appendToBlock(base, '.metric-chip.active', 'color: var(--ok);') },
  { id: 'A5', type: '阈值分档：大字豁免失效',
    desc: '字号降到 12px 后 --brand 不再适用大字 3:1 豁免（同样依赖 T7）',
    css: appendToBlock(base, '.fee-sum-bal', 'color: var(--brand);\n  font-size: 12px;') },
  { id: 'A6', type: 'T8 alpha 合成',
    desc: '--side-hover 的 alpha 改成 1（不透明）⇒ 合成结果变了',
    css: replaceInBlock(base, ':root', 'rgba(51, 112, 255, .07)', 'rgba(51, 112, 255, 1)') },
  { id: 'A7', type: 'T9 渐变取最差端点',
    desc: '.btn-primary 渐变一个 stop 改成低对比色',
    css: replaceInBlock(base, '.btn-primary', 'var(--brand-strong) 0%', 'var(--brand-soft) 0%') },
  { id: 'A8', type: 'T10 修饰类的背景',
    desc: '.cmp-tag-b 的背景改回饱和主色档',
    css: appendToBlock(base, '.cmp-tag-b', 'background: var(--chart-1);') }
];

// ═════════ B 类：注入无害改动 ⇒ 必须保持绿 ═════════
const MUST_GREEN = [
  { id: 'B1', type: '注释里的 hex 不得被当成真实声明',
    desc: '把注释里提到的旧色值写进注释 —— 门禁必须无视它（防误报）',
    css: base.replace('/* A/B 图例与数据点必须用', '/* 旧值 #F2F3F5 #FF7D00 #00A870 已废弃 */\n/* A/B 图例与数据点必须用') },
  { id: 'B2', type: '令牌改名但值不变 ⇒ 关系断言自动跟随',
    desc: '把 --brand-soft-2 改名为 --brand-soft-b（全站同步替换，值不变）',
    css: base.split('--brand-soft-2').join('--brand-soft-b') },
  { id: 'B3', type: '重复定义但生效值仍合规',
    desc: '.cmp-tag-a 再定义一次 background，值与生效值相同',
    css: appendToBlock(base, '.cmp-tag-a', 'background: var(--series-a);') },
  { id: 'B4', type: '字号变化但对比度仍达标',
    desc: '.fee-sum-bal 字号改 24px（真大字），颜色仍 --brand-ink',
    css: appendToBlock(base, '.fee-sum-bal', 'font-size: 24px;') }
];

// ═══ 跑 ═══
console.log('═══ harness 自检（注入未定义变量，§① 必定抓到）═══');
const rs = runGate(appendToBlock(base, '.dry-warn', 'color: var(--totally-undefined-var);'));
if (rs.code === SPAWN_FAIL) {
  console.log('  ❌ 子进程根本没起来（' + rs.out.split('\n')[0].slice(0, 80) + '）');
  console.log('     ⇒ 本轮所有用例的退出码都不可信，直接判红，别当成「变异被抓到」');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
if (rs.code === 0) {
  console.log('  ❌ harness 无效（自检未翻红）⇒ 本次结果不可信，退出');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}
console.log('  → 退出码 ' + rs.code + ' ✅ harness 有效');

console.log('\n═══ 基线（未改动）═══');
const rb = runGate(base);
console.log('  → 退出码 ' + rb.code + (rb.code === 0 ? '（全绿）' : '（红）← 基线就红，先修基线'));

console.log('\n═══ A 类：注入违规 ⇒ 必须翻红 ═══\n');
const failedRed = [];
for (const c of MUST_RED) {
  let css;
  try { css = c.css; } catch (e) { console.log('  ? ' + c.id + ' 构造失败：' + e.message); failedRed.push(c.id); continue; }
  const res = runGate(css);
  // 进程没起来时非 0 退出码是假信号 ⇒ 必须单独判红，不能算「翻红成功」
  const ok = res.code !== 0 && res.code !== SPAWN_FAIL;
  if (!ok) failedRed.push(c.id + ' · ' + c.type + (res.code === SPAWN_FAIL ? '（子进程未起来）' : ''));
  console.log((ok ? '  ✅ 翻红  ' : '  ❌ 漏掉  ') + c.id.padEnd(4) + c.type);
  console.log('        ' + c.desc);
  if (ok) {
    const line = (res.out.split('\n').find(l => l.indexOf('✗') >= 0) || '').trim();
    if (line) console.log('        门禁报：' + line.slice(0, 92));
  }
}

console.log('\n═══ B 类：注入无害改动 ⇒ 必须保持绿 ═══\n');
const failedGreen = [];
for (const c of MUST_GREEN) {
  let css;
  try { css = c.css; } catch (e) { console.log('  ? ' + c.id + ' 构造失败：' + e.message); failedGreen.push(c.id); continue; }
  const res = runGate(css);
  const ok = res.code === 0;
  const spawnDead = res.code === SPAWN_FAIL;
  if (!ok) failedGreen.push(c.id + ' · ' + c.type + (spawnDead ? '（子进程未起来 ⇒ 非门禁判定）' : ''));
  console.log((ok ? '  ✅ 保持绿  ' : (spawnDead ? '  ❌ 未跑成  ' : '  ❌ 误报  ')) + c.id.padEnd(4) + c.type);
  console.log('        ' + c.desc);
  if (!ok) {
    const line = (res.out.split('\n').find(l => l.indexOf('✗') >= 0) || '').trim();
    if (line) console.log('        门禁误报：' + line.slice(0, 92));
  }
}

console.log('\n═══ 结论 ═══');
console.log('  A 类（必须翻红）  ' + (MUST_RED.length - failedRed.length) + ' / ' + MUST_RED.length);
console.log('  B 类（必须保持绿）' + (MUST_GREEN.length - failedGreen.length) + ' / ' + MUST_GREEN.length);
if (failedRed.length) {
  console.log('\n  ⚠️ 假绿缺口（改坏了仍报全绿）：');
  failedRed.forEach(m => console.log('    · ' + m));
}
if (failedGreen.length) {
  console.log('\n  ⚠️ 误报（没坏却报红）：');
  failedGreen.forEach(m => console.log('    · ' + m));
}
if (!failedRed.length && !failedGreen.length) console.log('\n  ✅ 门禁的「改坏了会红 / 没坏不乱红」双向已被证明');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit((failedRed.length || failedGreen.length) ? 1 : 0);
