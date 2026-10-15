/**
 * 静态校验：WXML 事件处理器 + setData 字段 + 模板语法
 * - 检查 bindtap/catchtap/bind:xxx 指向的方法是否在同目录 index.js 的 Page/Component methods 中定义
 * - 检查 <template> wx:for 与 wx:if 同标签共存（小程序禁止语义，需拆 block）
 * - 检查标签闭合是否平衡
 */
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'miniprogram');

const VOID = new Set(['image', 'input', 'icon', 'import', 'include', 'open-data', 'web-view']);

function methodsOf(js) {
  const s = fs.readFileSync(js, 'utf8');
  const names = new Set();
  let m;
  const re = /^\s{2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = re.exec(s))) names.add(m[1]);
  // 组件 methods 块缩进 4
  const re2 = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm;
  while ((m = re2.exec(s))) names.add(m[1]);
  return names;
}

const problems = [];

function checkDir(dir) {
  const wxml = path.join(dir, 'index.wxml');
  const js = path.join(dir, 'index.js');
  if (!fs.existsSync(wxml)) return;
  // 先去注释再解析：注释里出现 <scroll-view> 之类的字样会被标签栈当成真标签（历史误报来源），
  // 注释掉的 bindtap 也不该算「事件未定义」。
  const t = fs.readFileSync(wxml, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const methods = fs.existsSync(js) ? methodsOf(js) : new Set();

  // 事件处理器
  let m;
  const reEvt = /(?:bind|catch|capture-bind|capture-catch):?([a-zA-Z:]+)\s*=\s*"([A-Za-z_$][\w$]*)"/g;
  while ((m = reEvt.exec(t))) {
    const handler = m[2];
    if (/^(true|false)$/.test(handler)) continue;
    if (!methods.has(handler)) problems.push(`${wxml}: 事件 ${m[1]}="${handler}" 未定义`);
  }

  // wx:for + wx:if 同标签
  const reBoth = /<([a-zA-Z-]+)\b[^>]*\bwx:for\b[^>]*\bwx:if\b[^>]*>/g;
  while ((m = reBoth.exec(t))) {
    if (!/<block/.test(m[0])) problems.push(`${wxml}: <${m[1]}> 同时存在 wx:for 与 wx:if`);
  }
  const reBoth2 = /<([a-zA-Z-]+)\b[^>]*\bwx:if\b[^>]*\bwx:for\b[^>]*>/g;
  while ((m = reBoth2.exec(t))) {
    if (!/<block/.test(m[0])) problems.push(`${wxml}: <${m[1]}> 同时存在 wx:if 与 wx:for`);
  }

  // 标签闭合
  // ⚠️ 剥注释必须**成对**且从最外层开始。
  //
  // 🔴 **WXML 注释里绝不能出现注释的结束标记 `-->`**（2026-10-09 实踩，真机编译报错）：
  //    注释用 `<!-- -->` 成对闭合，注释体内再写一个结束标记就会**提前闭合**，
  //    后面的文字全部变成真实标记 ⇒ 真机 DevTools 报「文件解析编译错误」+ 定位到
  //    后面某一行的普通标签（报错位置与真正的原因隔了几十行，极难定位）。
  //    本轮就是这样：在注释里举例写「WXML 注释用 `<!-- -->` 成对闭合」，
  //    结果那个 `-->` 把注释截断了。
  //    ✅ 纪律：**注释里要提到结束标记时，用中文说法（如「注释结束标记」）代替符号本身。**
  //
  // ⚠️ 反过来，**注释里可以有插值花括号**（真机正常，bottom-sheet / home / mine /
  //    roster 的既有注释里都写着 `{{...}}` 示例）。所以**不要**把「注释含插值」
  //    判成失败—— 那是本门禁曾经的一个错误结论（已撤销）。
  const stack = [];
  const reTag = /<\/?([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let r;
  while ((r = reTag.exec(t))) {
    const raw = r[0];
    const tag = r[1];
    const closing = raw.startsWith('</');
    const selfClose = r[3] === '/' || VOID.has(tag);
    if (closing) {
      if (stack[stack.length - 1] !== tag) {
        problems.push(`${wxml}: 标签失配，期望 </${stack[stack.length - 1] || '空'}> 实际 </${tag}>`);
      } else stack.pop();
    } else if (!selfClose) {
      stack.push(tag);
    }
  }
  if (stack.length) problems.push(`${wxml}: 未闭合标签 ${stack.join(',')}`);
}

/* ---------- WXML 表达式里禁止方法调用 ----------
 * 小程序 WXML 的 `{{ }}` 只支持「属性访问 / 运算符 / 三元 / 字面量」，
 * **不支持方法调用**：`{{ arr.indexOf(x) >= 0 }}` 不会报错，但**恒为假**（静默失效）。
 * 历史坑（v0.7.7）：通知面板「发送班级」用 `noticeClassIds.indexOf(item.id) >= 0` 决定 chip 高亮，
 * 结果「已选 2 个班级」但一个 chip 都不亮（现象：选了班级没高亮）。
 * 正确做法：在 JS 里预先算好查表对象（`{id: true}`），WXML 只做属性访问。
 */
function walkWxml(dir, out) {
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((n) => {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkWxml(p, out);
    else if (n.endsWith('.wxml')) out.push(p);
  });
  return out;
}

function checkExprCalls(file, raw, sink) {
  const out = sink || problems;
  const t = raw.replace(/<!--[\s\S]*?-->/g, '');
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(t))) {
    const expr = m[1];
    const call = /[A-Za-z_$][\w$]*\s*\(/.exec(expr);
    if (!call) continue;
    const line = t.slice(0, m.index).split('\n').length;
    out.push(
      `${file.replace(/\\/g, '/')}:${line}: WXML 表达式不支持方法调用 → "{{${expr.trim()}}}"` +
      `（含 ${call[0].trim()}，运行期静默失效）→ 请在 JS 里算好查表对象再绑`
    );
  }
}

/**
 * 🔴 **wx:key 不得写 `{{ }}` 表达式**（2026-10-16 新增，真机渲染层报错后立的铁律）。
 *
 * 现象（DevTools 控制台）：
 *   `[渲染层错误] Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': missing ) after argument list`
 *   `[渲染层错误] Framework inner error (expect FLOW_INITIAL_CREATION end but got FLOW_CREATE_NODE)`
 * 根因：`wx:key` 的值是**属性名**，框架内部做 `item[key]` 取值；
 *   写成 `wx:key="{{item.a ? 'x' : 'y'}}"` 属于全仓唯一的例外形态 ⇒ 渲染层编译/创建节点时报语法错误。
 *   （排查时会误以为「括号不配平」—— 实测所有 `{{}}` 的括号、引号、mustache 全配平，不在表达式本身。）
 *
 * 正确做法：**派生值在 JS 里算好**，wxml 只写裸属性名（如 `wx:key="key"`），
 *   与项目既有铁律「WXML 不做逻辑，派生值一律 JS 预计算」一致。
 *   全仓既有的 wx:key 写法（`id` / `*this` / `key` / `leaveId` …）都是裸属性名，照抄即可。
 *
 * 判据：`wx:key="…"` 的属性值里出现 `{{` 即判死。`*this` / `index` 等保留写法不受影响。
 */
function checkWxKeyAttr(file, raw, sink) {
  const out = sink || problems;
  const t = String(raw).replace(/<!--[\s\S]*?-->/g, '');
  const re = /wx:key\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(t))) {
    if (!/\{\{/.test(m[1])) continue;
    const line = t.slice(0, m.index).split('\n').length;
    out.push(
      `${file.replace(/\\/g, '/')}:${line}: wx:key 不得写表达式 → wx:key="${m[1]}"`
      + `（wx:key 只接受**属性名**，框架内部做 item[key]；写表达式会让渲染层报`
      + ` missing ) after argument list / FLOW_INITIAL_CREATION 框架内部错误）`
      + ` ⇒ 请在 JS 里算好唯一字段（前缀区分 id 空间）再绑 wx:key="key"`
    );
  }
}

/**
 * 🔴 **注释提前闭合**扫描（2026-10-09 真机编译失败后新增）。
 *
 * 判据：把文件里`<!--` 与 `-->` 按出现位置扫出来，**必须严格交替**
 *（O C O C …）。任何连续两个 `C`（即`-->` 紧跟 `-->`）都说明某处注释被
 * 提前闭合了 —— 真机会把两个结束标记之间的文字当真实标记解析并报错。
 *
 * ⚠️ 为什么不用正则 `/<!--[\s\S]*?-->/g` 判：那正是**被这个坑影响的那个逻辑** ——
 *    提前闭合时它会把「注释体 + 后面一段真实标记」整段吃掉，于是「标签失配」
 *    报在离真正原因很远的地方（2026-10-09 那次报在第 181行的普通 `<text>` 上，
 *    而真凶在第 169 行的注释里）。这个函数只看**标记顺序**，不受影响。
 *
 * ⚠️ 注释里**含插值花括号是合法的**（真机正常，既有代码到处都在写），
 *    这里**不**检查它—— 那是本门禁曾经的一个错误结论。
 */
function checkCommentNest(file, raw, sink) {
  const out = sink || problems;
  const t = String(raw).replace(/\r\n/g, '\n');
  const marks = [];
  let i = 0;
  while (i < t.length) {
    const o = t.indexOf('<!--', i);
    const c = t.indexOf('-->', i);
    if (o < 0 && c < 0) break;
    if (o >= 0 && (c < 0 || o < c)) {
      marks.push({ k: 'O', at: o });
      i = o + 4;
    } else {
      marks.push({ k: 'C', at: c });
      i = c + 3;
    }
  }
  for (let k = 1; k < marks.length; k++) {
    if (marks[k].k === marks[k - 1].k) {
      const line = t.slice(0, marks[k].at).split('\n').length;
      out.push(
        `${file.replace(/\\/g, '/')}:${line}: 注释**提前闭合**（连续两个结束标记）`
        + ` ⇒ 注释体内写了结束标记，真机直接编译失败（报错位置会落在后面某行的普通标签上）`
        + ` ⇒ 提到结束标记时请用中文说法代替符号本身`
      );
      return;
    }
  }
}

['pages', 'components', 'custom-tab-bar'].forEach((base) => {
  const b = path.join(R, base);
  if (!fs.existsSync(b)) return;
  fs.readdirSync(b).forEach((n) => {
    const p = path.join(b, n);
    if (fs.statSync(p).isDirectory()) checkDir(p);
  });
});

/* 表达式方法调用：扫全部 wxml（含组件内 wxml 等非 index.wxml 文件） */
const allWxml = [];
['pages', 'components', 'custom-tab-bar'].forEach((base) => walkWxml(path.join(R, base), allWxml));
allWxml.forEach((f) => checkExprCalls(f, fs.readFileSync(f, 'utf8')));

/* 注释提前闭合：同样扫全部 wxml（2026-10-09 新增，真机编译失败换来的） */
allWxml.forEach((f) => checkCommentNest(f, fs.readFileSync(f, 'utf8')));

/* wx:key 禁表达式：同样扫全部 wxml（2026-10-16 新增，渲染层 SyntaxError 换来的） */
allWxml.forEach((f) => checkWxKeyAttr(f, fs.readFileSync(f, 'utf8')));

/* 自证：两个方向都要过 —— 坏样本必须被抓到，好样本不得被误报 */
{
  const bad = [];
  checkExprCalls('__selfcheck__.wxml', `<view class="{{ a.indexOf(b) >= 0 ? 'on' : '' }}">x</view>`, bad);
  if (!bad.length) problems.push('check-wxml 自证失败：`arr.indexOf(x)` 这类方法调用没被抓到');
  const good = [];
  checkExprCalls('__selfcheck__.wxml', `<view class="{{ picked[item.id] ? 'on' : '' }}">{{ item.name }}</view>`, good);
  if (good.length) problems.push('check-wxml 自证失败：合法属性访问被误报 → ' + good[0]);

  /* 自证：注释提前闭合 —— 坏样本必抓、好样本（注释里含插值）不得误报 */
  const badNest = [];
  // 坏样本 = 本轮真凶的**真实形状**：注释体内**多写了一个**结束标记
  //（第一对O..C 是注释本体，紧跟着的第二个 C 是注释体内多写的那个）
  //⇒ 标记序列 O C C：连续两个 C ⇒ 判死。
  checkCommentNest('__selfcheck__.wxml',
    '<!-- 说明：注释用 <!-- --> 这种成对写法 -->' + '\n<view>x</view>', badNest);
  if (!badNest.length) problems.push('check-wxml 自证失败：注释提前闭合没被抓到（本轮真机编译失败就是它）');
  const goodNest = [];
  // 好样本 ①：注释里**含插值花括号**是合法的（真机正常，既有代码到处都写）
  checkCommentNest('__selfcheck__.wxml',
    `<!-- 直接写 wx:if="{{show}}" + {{show?'in':''}} 会瞬间打开 -->\n<view>x</view>`, goodNest);
  if (goodNest.length) problems.push('check-wxml 自证失败：注释内含插值被误报 → ' + goodNest[0]);
  const goodNest2 = [];
  // 好样本 ②：正文里的 `-->` 不存在、多个正常注释交替
  checkCommentNest('__selfcheck__.wxml',
    '<!-- 一 -->\n<view>x</view>\n<!-- 二 -->\n<view>y</view>', goodNest2);
  if (goodNest2.length) problems.push('check-wxml 自证失败：正常多注释被误报 → ' + goodNest2[0]);

  /* 自证：wx:key 禁表达式 —— 坏样本（本轮真实报错形状）必抓、裸属性名不得误报 */
  const badKey = [];
  checkWxKeyAttr('__selfcheck__.wxml',
    `<view wx:for="{{sessions}}" wx:key="{{item.isPersonal ? 'pid' : 'sessionId'}}">x</view>`, badKey);
  if (!badKey.length) problems.push('check-wxml 自证失败：wx:key 里的表达式没被抓到（本轮渲染层 SyntaxError 就是它）');
  const badKey2 = [];
  checkWxKeyAttr('__selfcheck__.wxml',
    `<view wx:for="{{list}}" wx:key="{{item.id}}">x</view>`, badKey2);
  if (!badKey2.length) problems.push('check-wxml 自证失败：wx:key="{item.id}" 这种简写也没被抓到');
  const goodKey = [];
  checkWxKeyAttr('__selfcheck__.wxml',
    `<view wx:for="{{sessions}}" wx:key="key">x</view>`
    + `<view wx:for="{{list}}" wx:key="*this">y</view>`
    + `<view wx:for="{{list}}" wx:key="id">z</view>`, goodKey);
  if (goodKey.length) problems.push('check-wxml 自证失败：裸属性名 wx:key 被误报 → ' + goodKey[0]);
  const goodKeyComment = [];
  // 注释里提到 wx:key 写法是合法的（既有注释到处在讲口径），不得误报
  checkWxKeyAttr('__selfcheck__.wxml',
    `<!-- 口径：wx:key="{{item.a ? 'x' : 'y'}}" 这种写法已废弃 -->\n<view wx:key="key">x</view>`, goodKeyComment);
  if (goodKeyComment.length) problems.push('check-wxml 自证失败：注释里的 wx:key 被误报 → ' + goodKeyComment[0]);
}

/* ---------- 非 Tab 二级页必须有返回键 ----------
 * Tab 页底部有 tabBar 兜底，不需要返回键；其余页面（bind / manual / poster）都是
 * 用 navigateTo / reLaunch 打开的二级页，左上角必须能返回，否则用户只能靠系统手势。
 * 历史坑：poster 页写了 custom-back + bind:back 处理器，却漏了 show-back，
 * 于是返回箭头根本没渲染，处理器成了死代码。 */
const appJsonPath = path.join(R, 'app.json');
if (fs.existsSync(appJsonPath)) {
  const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
  const tabPaths = new Set(((appJson.tabBar && appJson.tabBar.list) || []).map(x => x.pagePath));
  (appJson.pages || []).forEach((p) => {
    if (tabPaths.has(p)) return;
    /* 页面 JSON 里声明 navigationStyle=default 的页用**原生导航栏**（系统自带返回键），
     * 不需要自定义 nav-bar。典型：pages/webview —— web-view 是原生组件会盖住自定义导航栏，
     * 只能靠系统返回键返回。 */
    const pj = path.join(R, p + '.json');
    if (fs.existsSync(pj)) {
      try {
        if (JSON.parse(fs.readFileSync(pj, 'utf8')).navigationStyle === 'default') return;
      } catch (e) { /* JSON 坏了按缺返回键处理 */ }
    }
    const wxml = path.join(R, p + '.wxml');
    if (!fs.existsSync(wxml)) return;
    const t = fs.readFileSync(wxml, 'utf8');
    if (!/show-back\s*=\s*"\{\{\s*true\s*\}\}"/.test(t)) {
      problems.push(`${p}.wxml: 非 Tab 二级页缺少返回键（需 <nav-bar show-back="{{true}}" …>，或页面 json 声明 navigationStyle=default 用原生导航栏）`);
    }
  });
}

if (!problems.length) console.log('OK · WXML 事件与结构校验通过');
else { problems.forEach((p) => console.log('X ' + p)); process.exitCode = 1; }
