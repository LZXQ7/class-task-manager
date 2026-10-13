#!/usr/bin/env node
/**
 * 离线自检：WXSS 语法体检
 * ------------------------------------------------------------
 * 起因（2026-09-25）：`pages/home/index.wxss` 多了一个孤立的 `}`，
 * 开发者工具直接报「编译 .WXSS 文件错误，错误信息如上」+ 整页样式失效，
 * 而 WXML/JS 侧一切正常 —— 只跑 check-wxml 是发现不了的。
 *
 * 本脚本只做**不需要编译器**就能抓的硬错误：
 *   ① 大括号不配平（孤立 `}` / 未闭合 `{`）—— 就是上面那个坑；
 *   ② 出现「没有选择器的规则块」（`{` 前面没有选择器文本）；
 *   ③ 属性行缺少冒号 / 缺少分号（只查明显可疑的）；
 *   ④ 非 ASCII 空格（全角空格、NBSP、零宽字符）——从网页/文档粘样式时常见，
 *      看着像普通空格，编译器有时报「error at token」。
 * 注释里的 {} 会被跳过；字符串（content:"{}"）里的也会跳过。
 *
 * 用法：node scripts/check-wxss.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

/**
 * 自证用的临时 wxss 写在 `.workbuddy/tmp/`，**绝不写进 `miniprogram/`**。
 * 起因（2026-09-26）：原先写在项目里，运行被中途打断（例如输出被 `| head` 关掉管道）
 * 就会残留 `miniprogram/__wxss_selftest__.wxss`；而 `check-wxss-compile` 会把
 * 项目里每个 wxss 都拿去真编译 → 对着一个临时文件报出很迷惑的 FAIL。
 */
const SELFTEST_TMP = path.join(ROOT, '.workbuddy', 'tmp', '__wxss_selftest__.wxss');
try { fs.mkdirSync(path.dirname(SELFTEST_TMP), { recursive: true }); } catch (e) {}

/** 自证临时文件清理：安全删除垫片偶发 ETIMEDOUT / 锁超时（2026-10-12 实踩：
 *  unlinkSync 被垫片 spawnSync node 超时直接打崩整个门禁，② 段 class 检查都没跑到），
 *  清理失败**不能**判死门禁 —— 开头已有一次统一清理兜底残留。 */
function cleanupTmp(p) {
  try { fs.unlinkSync(p); } catch (e) { /* 清理失败不阻断，开头统一清 */ }
}


let failed = 0;
const ok = (m) => console.log('PASS  ' + m);
const bad = (m) => { failed += 1; console.log('FAIL  ' + m); };
const chk = (c, m) => (c ? ok(m) : bad(m));

/* ---------- 收集所有 .wxss ---------- */
function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') return;
      walk(p, out);
    } else if (e.name.endsWith('.wxss')) {
      // 排除自检临时文件：上次运行异常中断时它可能残留，不该被当真实文件扫
      if (e.name === '__wxss_selftest__.wxss') return;
      out.push(p);
    }
  });
  return out;
}
// 开场先清掉可能残留的自检临时文件（幂等）：保证「扫描计数」与「本轮自检」互不污染
try { fs.unlinkSync(path.join(MINI, '__wxss_selftest__.wxss')); } catch (e) {}
const files = walk(MINI, []);
console.log(`扫描 ${files.length} 个 .wxss\n`);

/* ---------- 逐文件检查 ---------- */
const WEIRD = /[\u00A0\u2000-\u200D\u2028\u2029\u3000\uFEFF]/;

/**
 * 把 `/* … *\/` 块注释整段挖空（替换成等长空格、**保留行号**），专供下面的**文本判据**使用。
 * ⚠️ 判据必须跑在「没有注释的代码」上 —— 项目里踩过三次同一个坑：
 *   ① 类名用 `indexOf('foo')` 命中了注释里的 foo；
 *   ② `COUNT(*)` 正则命中注释里的「COUNT(*) 会把它们算进 total」；
 *   ③ 本函数的调用点：注释里写 `` `overflow:hidden` 裁不住 backdrop-filter `` 时，
 *      「属性名:属性值」的形状被当成了「漏写分号的属性行」→ 明明合法的样式挂掉门禁。
 *   所以：**凡按文本形状判断代码的判据，先挖掉注释**。
 */
function blankBlockComments(src) {
  const out = [];
  let inC = false;
  for (const line of src.split(/\r?\n/)) {
    let res = '';
    for (let j = 0; j < line.length; j += 1) {
      const c = line[j];
      const nxt = line[j + 1];
      if (inC) {
        if (c === '*' && nxt === '/') { inC = false; j += 1; res += '  '; }
        else res += ' ';
        continue;
      }
      if (c === '/' && nxt === '*') { inC = true; j += 1; res += '  '; continue; }
      res += c;
    }
    out.push(res);
  }
  return out;
}

/**
 * ⑤ 声明形状：把规则体按 `;` 切开后，**每一段都必须含冒号**。
 * ------------------------------------------------------------
 * 起因（2026-09-26 v0.7.18 真事故）：批量换色脚本用 `#FFF` 做备选做前缀匹配，
 * 把 `background: #FFF1F2;` 改成了 `background: rgba(255,255,255,.55);1F2;` ——
 * 多出来的 `1F2` 是一段「没有冒号的残留」，真编译器直接
 * `unexpected '1'` → IDE 报「编译 .wxss 文件错误」，而**按行看的判据全绿**
 * （那一行以 `;` 收尾，格式上完全合法）。
 * 这条判据是「文本层」的兜底：`check-wxss-compile`（真编译器）才是权威，
 * 但它依赖开发者工具存在；两者互补，缺一不可。
 * ⚠️ 前提：wxss 里不能出现 `data:` / `url(...;...)` 这类**值里带分号**的写法
 * （本项目全部 wxss 已确认没有）。
 */
function declShapeProblems(src) {
  const problems = [];
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  noComment.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body) => {
    body.split(';').map((x) => x.trim()).filter(Boolean).forEach((seg) => {
      if (seg.indexOf(':') < 0) {
        problems.push(`规则 \`${sel.trim().slice(0, 40)}\` 里有一段「没有冒号的残留」：\`${seg.slice(0, 40)}\``
          + '（典型成因：批量替换时别名/前缀匹配吃掉了长值的一部分，真编译器会 fatal）');
      }
    });
    return '';
  });
  return problems;
}

function checkFile(file, quiet) {  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  /** 与 lines 等长、但块注释已被挖空的副本（文本判据一律用它，绝不用 lines） */
  const codeLines = blankBlockComments(src);

  let depth = 0;                 // 大括号深度
  let inComment = false;
  let blockStartLine = 0;        // 当前最外层块的起始行
  let buf = '';                  // 从上一个 `{`/`}` 之后累积的「选择器文本」
  const problems = [];

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];

    /* ④ 非 ASCII 空格 / 零宽字符 */
    if (WEIRD.test(line)) {
      problems.push(`第 ${i + 1} 行含非 ASCII 空白字符（全角空格 / NBSP / 零宽），请替换为普通空格`);
    }

    /* 逐字符扫，跳过注释与字符串 */
    for (let j = 0; j < line.length; j += 1) {
      const c = line[j];
      const nxt = line[j + 1];

      if (inComment) {
        if (c === '*' && nxt === '/') { inComment = false; j += 1; }
        continue;
      }
      if (c === '/' && nxt === '*') { inComment = true; j += 1; continue; }
      if (c === '"' || c === "'") {          // 吃掉整个字符串
        const q = c; j += 1;
        while (j < line.length && line[j] !== q) { if (line[j] === '\\') j += 1; j += 1; }
        continue;
      }

      if (c === '{') {
        if (depth === 0) {
          blockStartLine = i + 1;
          if (!buf.trim()) {
            problems.push(`第 ${i + 1} 行出现「没有选择器的 {」（大括号前为空）`);
          }
        }
        depth += 1;
        buf = '';
      } else if (c === '}') {
        depth -= 1;
        buf = '';
        if (depth < 0) {
          problems.push(`第 ${i + 1} 行出现**孤立的 } **（大括号不配平，多了一个闭合括号）`);
          depth = 0;                          // 复位，继续找别的问题
        }
      } else if (depth === 0) {
        buf += c;
      }
    }
    /* 行内注释 // 形式（wxss 支持）——不参与括号统计。
       ⚠️ 基准是 codeLines（块注释已挖空），不是 lines —— 见 blankBlockComments 的说明。 */
    const codePart = codeLines[i].replace(/\/\/.*$/, '');
    if (depth > 0 && /:\s*$/.test(codePart.trim()) === false
        && /[;{}]\s*$/.test(codePart.trim()) === false) {
      // 属性行既不以 : 结尾，也不以 ; { } 收尾 —— 常见于「漏了分号，下一行被吞」
      if (/[a-zA-Z-]+\s*:\s*[^;{}]+$/.test(codePart.trim())
          && !/^\s*(\/|\*)/.test(codePart)) {
        problems.push(`第 ${i + 1} 行疑似**漏了分号**（属性未结束就换行）：${codePart.trim().slice(0, 60)}`);
      }
    }
  }

  if (depth !== 0) {
    problems.push(`文件结束时仍有 ${depth} 个未闭合的 {（从第 ${blockStartLine} 行开始）`);
  }

  declShapeProblems(src).forEach((p) => problems.push(p));

  if (problems.length) {
    if (!quiet) {
      bad(`${rel}`);
      problems.slice(0, 8).forEach((p) => console.log('        · ' + p));
    }
    return false;
  }
  return true;
}

let good = 0;
files.forEach((f) => { if (checkFile(f)) good += 1; });
if (good === files.length) ok(`全部 ${files.length} 个 .wxss 大括号配平、无异常空白、无孤立 }`);

/* ---------- 反向校验：本脚本自己得能抓到那个坑 ---------- */
console.log('\n── 自证：故意构造一个多 `}` 的文件，脚本必须报错');
{
  const tmp = SELFTEST_TMP;
  fs.writeFileSync(tmp, '.a { color: #000; }\n\n}\n\n.b { color: #111; }\n');
  const caught = !checkFile(tmp, true);
  cleanupTmp(tmp);
  chk(caught, '孤立 } 能被抓到（回归保护）');
}

/* ---------- 自证：「漏分号」判据的双向验证 ----------
 * 起因（v0.7.17）：注释里写了 `` `overflow:hidden` 裁不住 backdrop-filter ``，
 * 这个「属性名:属性值」的形状被判据当成漏写分号 → 合法的样式被门禁拦住。
 * 双向都要证：坏样本必抓 + 好样本不误报。 */
console.log('\n── 自证：「漏分号」判据不得命中注释（坏样本必抓 + 好样本不误报）');
{
  const tmp = SELFTEST_TMP;

  // 坏样本：真的漏了分号（下一行被吞），必须报错
  fs.writeFileSync(tmp, '.a {\n  color: #000\n  background: #fff;\n}\n');
  const caughtBad = !checkFile(tmp, true);

  // 好样本：注释里出现「属性名:属性值」的形状，不得误报
  fs.writeFileSync(tmp, '.a {\n  /* 注意 overflow:hidden 裁不住 backdrop-filter，圆角要自己写 */\n  color: #000;\n}\n');
  const falseAlarm = !checkFile(tmp, true);

  cleanupTmp(tmp);
  chk(caughtBad, '真·漏分号仍能被抓到');
  chk(!falseAlarm, '块注释里的 `overflow:hidden` 不再被误判成漏分号');
}

/* ---------- 自证：「声明形状」判据（残留 hex 尾巴）双向验证 ----------
 * v0.7.18 真事故：`background: #FFF1F2;` 被前缀匹配改成 `rgba(...);1F2;`，
 * 真编译器 fatal，而按行判据全绿。 */
console.log('\n── 自证：声明里的「无冒号残留段」必被抓（坏样本 + 好样本）');
{
  const tmp2 = SELFTEST_TMP;
  const badSrc = '.a {\n  color: #E11D48;\n  background: rgba(255, 255, 255, 0.55);1F2;\n}\n';
  const goodSrc = '.a {\n  color: #E11D48;\n  background: rgba(255, 255, 255, 0.55);\n  border-radius: 24rpx;\n}\n';
  const caughtShape = declShapeProblems(badSrc).length > 0;
  const noFalse = declShapeProblems(goodSrc).length === 0;
  // 再走一遍完整 checkFile，确认它在真实入口里真的会被调用（不只是函数自测通过）
  fs.writeFileSync(tmp2, badSrc);
  const caughtByFile = !checkFile(tmp2, true);
  cleanupTmp(tmp2);
  chk(caughtShape, '残留 hex 尾巴被 declShapeProblems 判死');
  chk(caughtByFile, '同一个坏样本走 checkFile 入口也会被判死（判据真的接进主流程）');
  chk(noFalse, '正常声明不误报');
}

/* ============================================================
 * ② 每个页面的 wxml 里用到、但 wxss（含 app.wxss）里没定义的 class
 * ------------------------------------------------------------
 * 起因（2026-09-25）：`pages/home/index.wxss` 被整段覆盖，
 * `.wrap` / `.hero` 等**用了但没定义** → 页面能编译、不报错，只是默默变样
 * （卡片满宽贴边、Hero 退化成一行纯文字）。括号配平查不出这种问题。
 * ============================================================ */
console.log('\n── ② wxml 用到的 class 必须在 wxss（或 app.wxss）里有定义');

const appWxss = fs.readFileSync(path.join(MINI, 'app.wxss'), 'utf8');

/** 从 wxss 源码里抽所有被定义的 class 名（只看 `{` 之前的选择器文本） */
function definedClasses(src) {
  const set = new Set();
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  noComment.split('{').slice(0, -1).forEach((chunk) => {
    // 选择器文本 = 上一个 `}` 之后到本 `{` 之前
    const sel = chunk.slice(Math.max(chunk.lastIndexOf('}'), chunk.lastIndexOf(';')) + 1);
    sel.split(',').forEach((one) => {
      const m = one.match(/\.[A-Za-z_][A-Za-z0-9_-]*/g);
      if (m) m.forEach((c) => set.add(c.slice(1)));
    });
  });
  return set;
}

/**
 * 抽 wxml 里用到的 class token。
 *   · 静态部分按空格切；
 *   · `{{ }}` 里只取**引号中的字符串**（如 `{{a ? 'plain small' : 'x'}}`）；
 *     `=== 'A'` / `!== 'OFF'` / `=== 'DISABLED'` 这类**比较值不是 class**，要排除；
 *   · `placeholder-class="f-ph"` 也算（它同样要有一条 `.f-ph` 规则，否则 placeholder 用默认灰）。
 *     ⚠️ 注意不能简单用 /class="/ 匹配 —— 那样 `placeholder-class=` 会被误当成 `class=`。
 */
function usedClasses(src) {
  const set = new Set();
  const re = /(?:^|[\s"'])class\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1];
    const expanded = raw.replace(/\{\{([\s\S]*?)\}\}/g, (_all, expr) => {
      const lits = [];
      const lre = /'([^']*)'|"([^"]*)"/g;
      let lm;
      while ((lm = lre.exec(expr))) {
        const before = expr.slice(Math.max(0, lm.index - 4), lm.index);
        if (/[=!]\s*$/.test(before)) continue;   // === / !== / == / != 右边是比较值
        lits.push(lm[1] !== undefined ? lm[1] : lm[2]);
      }
      return ' ' + lits.join(' ') + ' ';
    });
    expanded.split(/\s+/).forEach((t) => {
      if (!t) return;
      if (t.includes('{') || t.includes('}') || t.includes('(') || t.includes('.')) return;
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(t)) return;
      set.add(t);
    });
  }
  const pre = /placeholder-class\s*=\s*"([^"]*)"/g;
  while ((m = pre.exec(src))) {
    m[1].split(/\s+/).forEach((t) => { if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(t)) set.add(t); });
  }
  return set;
}

const pageDirs = fs.readdirSync(path.join(MINI, 'pages'));

/**
 * 「用了但没有样式规则」的**钩子类**白名单。
 * 这三种在 wxml 里出现但全项目从未定义过规则（`home`/`ps` 是页面根节点的第二个类，
 * `roster-group` 是分组容器、分隔靠 `.roster-group-title` 的底色）—— 属于历史遗留的
 * 空钩子，加规则反而会凭空造样式。除白名单外的「缺失 class」一律算错误。
 */
const HOOK_ALLOWLIST = new Set(['home', 'ps', 'roster-group']);

let classFail = 0;
pageDirs.forEach((p) => {
  const wxmlPath = path.join(MINI, 'pages', p, 'index.wxml');
  const wxssPath = path.join(MINI, 'pages', p, 'index.wxss');
  if (!fs.existsSync(wxmlPath) || !fs.existsSync(wxssPath)) return;
  const used = usedClasses(fs.readFileSync(wxmlPath, 'utf8'));
  const def = definedClasses(fs.readFileSync(wxssPath, 'utf8'));
  definedClasses(appWxss).forEach((c) => def.add(c));
  const missing = [...used].filter((c) => !def.has(c) && !HOOK_ALLOWLIST.has(c)).sort();
  if (missing.length) {
    classFail += 1;
    bad(`pages/${p}/index.wxml 用了但没定义的 class：${missing.join(' / ')}`);
  } else {
    ok(`pages/${p}：${used.size} 个 class 全部有定义`);
  }
});
if (classFail === 0) ok('全部页面无「用了但没定义」的 class');

/* ---------- ③ WXSS 选择器合法性：通用兄弟选择器 `~` 是 fatal ---------- */
/*
 * ⚠️ 2026-09-26 事故（本门禁的由来）：`app.wxss` 里用 `.st-item ~ .st-item` 做错峰，
 *    真机编译直接报 `app.wxss(248:31): unexpected token ~` —— WXSS **不支持通用兄弟
 *    选择器 `~`**，结果是**整个 app.wxss 编译失败 → 全站样式丢失**（不只是那一条规则失效）。
 *    当时 32 个离线门禁全绿：它们只做文本检查，**跑不了真正的 WCSS 编译器**。
 *    「门禁绿」≠「能编译」—— 所以这条必须静态拦。
 * ⚠️ 只拦 `~`：`+`（相邻兄弟）项目里大量在用且线上正常（doc / poster / roster / home /
 *    mine / classes / timetable），误拦会造成大面积假阳性。
 */
function squiggleSelectors(src) {
  // 整块剥注释（跨行），用等长空白替换以保住行号；否则注释里的「周一 ~ 周五」会误报
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const hits = [];
  stripped.split('\n').forEach((line, i) => {
    if (/\s~\s/.test(line) && !/~=/.test(line)) hits.push((i + 1) + ': ' + line.trim());
  });
  return hits;
}
let sqFail = 0;
files.forEach((f) => {
  const hits = squiggleSelectors(fs.readFileSync(f, 'utf8'));
  if (hits.length) {
    sqFail += 1;
    bad(`${path.relative(ROOT, f).replace(/\\/g, '/')} 出现通用兄弟选择器 \`~\`（WXSS 不支持，真机 fatal 编译失败）：${hits.join(' | ')}`);
  }
});
if (!sqFail) ok(`${files.length} 个 wxss 均无通用兄弟选择器 \`~\`（WXSS 不支持，会出现全站样式丢失）`);

/* ---------- 自证 ③：`~` 必须被抓，`+` 与 `~=` 不得误报 ---------- */
{
  chk(squiggleSelectors('.a ~ .b { color: red; }').length === 1, '自证：`~` 选择器会被抓住（真机编译 fatal）');
  chk(squiggleSelectors('.a + .b { color: red; }').length === 0, '自证：`+` 相邻兄弟不误报（项目大量在用）');
  chk(squiggleSelectors('.a[data-x~="y"] { color: red; }').length === 0, '自证：属性选择器 `~=` 不误报');
  chk(squiggleSelectors('/*\n * 周一 ~ 周五\n */\n.a { color: red; }').length === 0, '自证：跨行注释里的 `~` 不算数');
}

/* ---------- 自证 ②：抽一个页面把样式清空，必须被判定为「缺定义」 ---------- */
{
  const wxml = path.join(MINI, 'pages', 'home', 'index.wxml');
  if (fs.existsSync(wxml)) {
    const used = usedClasses(fs.readFileSync(wxml, 'utf8'));
    const def = definedClasses(appWxss);
    const fakeMissing = [...used].filter((c) => !def.has(c));
    chk(fakeMissing.length > 0, '整页样式丢失时能列出缺失的 class（回归保护）');
  }
}

console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ WXSS 体检全部通过'));
process.exit(failed ? 1 : 0);
