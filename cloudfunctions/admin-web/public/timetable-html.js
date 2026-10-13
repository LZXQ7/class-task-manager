/**
 * 青果教务系统「课表页 HTML」解析器（自研，零依赖）
 * ============================================================
 * 为什么自己写而没有直接搬 Dawn-Course 的 kingosoft.js：
 *   那个仓库是 **GPL-3.0**，且解析器文件里没有任何 SPDX 头或例外条款。
 *   抄进来 = 本项目整体受 GPL 传染。本文件从零实现，只借鉴了他们踩出来的
 *   **行为规格**（写在下面各函数的注释里），不含其源码。
 *
 * 借鉴来的行为规格（每一条都是真实踩过的坑，别删）：
 *   · 周次文本里的**节次括号组必须先剥掉**再按 '-' 拆区间。
 *     否则 "9周(1-2节)" 会被拼成 "91-2" → 解析成第 2~51 周 / 或直接吞掉单周课。
 *   · 单/双周标记必须**带边界**（括号包裹 或 后面紧跟「周」）。
 *     否则 "1-16周 双创楼" 里的「双」会被当成双周标记，整门课只上偶数周。
 *   · 周次上限钳到 53；区间写反（"16-9周"）要自动交换而不是判空。
 *   · 星期列用**反向索引**映射：行首常有「节次/时间」列导致列数不齐，
 *     正向映射会把星期整体串位。
 *   · 只上一周的课程（"9周"）必须正常输出，不能被当畸形丢弃。
 *
 * 四种版面（依次降级，谁先产出非空结果就用谁）：
 *   list   列表式表格（表头含「课程」+ 周次/星期/节次）
 *   print  「全校课表(按班级)」打印版：表头两行 + colspan ⇒ 列位置即 (星期, 大节)，
 *          单元格是 &ensp; 分隔的扁平文本，末尾那个数字是上课人数要剥掉。
 *          ⚠️ 必须排在 grid 前面：它的表头第一行同样是「星期X」，
 *          被 grid 的反向索引吃到会整体错位（列数差了 5 倍）。
 *   grid   常见网格表（行首节次列 + 星期表头，用反向索引映射）
 *   legacy 旧版 td.td 兜底
 *
 * 输出契约：与 admin-web/public/app.js buildTimetableFromSheets 完全一致
 *   { courses:[{name,teacher,room}], sessions:[{name,teacher,room,dayOfWeek,period,weeks}],
 *     warnings:[string], stats:{parsed,dropped,deduped}, layout:'list'|'print'|'grid'|'legacy' }
 *
 * 双出口：浏览器挂 window.TimetableHtml；Node 下 module.exports（给门禁测试用）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TimetableHtml = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_WEEK = 53;
  var MAX_PERIOD = 5;
  var DAY_WORDS = [
    ['星期一', 1], ['星期一', 1], ['周一', 1],
    ['星期二', 2], ['周二', 2],
    ['星期三', 3], ['周三', 3],
    ['星期四', 4], ['周四', 4],
    ['星期五', 5], ['周五', 5],
    ['星期六', 6], ['周六', 6],
    ['星期日', 7], ['星期天', 7], ['周日', 7], ['周天', 7]
  ];

  /* ---------------- 文本清洗 ---------------- */

  function decodeEntities(text) {
    var s = String(text == null ? '' : text);
    s = s.replace(/&nbsp;|&ensp;|&emsp;|&#13;|&#10;/gi, ' ')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
    s = s.replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
    s = s.replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); });
    return s.replace(/&amp;/gi, '&');
  }

  /** 去标签 + 实体还原 + 空白归一；返回纯文本 */
  function stripTags(html) {
    var s = String(html == null ? '' : html);
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    var prev;
    do { prev = s; s = s.replace(/<[^>]*>/g, ' '); } while (s !== prev);
    return decodeEntities(s).replace(/\s+/g, ' ').trim();
  }

  /** 按 <br> 切行，逐行去标签 */
  function cellLines(html) {
    return String(html == null ? '' : html)
      .split(/<br\s*\/?>/gi)
      .map(stripTags)
      .filter(function (x) { return !!x; });
  }

  function cleanDoc(html) {
    return String(html == null ? '' : html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/[\r\n]+/g, '');
  }

  function rowsOf(doc) {
    var out = [], re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, m;
    while ((m = re.exec(doc)) !== null) out.push(m[1]);
    return out;
  }

  function cellsOf(rowHtml) {
    var out = [], re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi, m;
    while ((m = re.exec(rowHtml)) !== null) out.push(m[2]);
    return out;
  }

  /* ---------------- 周次解析 ---------------- */

  /**
   * 单/双周标记识别。三种合法形态（真实青果页面三种都出现过）：
   *   ① 括号包裹：(单) / （双） / [单]      例 "1-16周(单)"
   *   ② 后面紧跟「周」：单周 / 双周          例 "双周上课"
   *   ③ **独立成词**（青果网页课表的标准写法）例 "5-12 双 [1-2]"
   *
   * ③ 的边界是硬要求：必须前后都是空白/标点/括号/串首尾。
   *   没有这条边界，"1-16周 双创楼" 的「双」会被当成双周标记，
   *   整门课只剩偶数周（上游 issue #109 review 阶段真踩过）。
   */
  function detectParity(text) {
    var t = String(text || '');
    var found = '';
    var m;
    var reBracket = /[（(\[|/／｜]\s*([单双])\s*周?\s*[）)\]]/g;
    var reSuffix = /([单双])周/g;
    var reStandalone = /(?:^|[\s,，;（(])([单双])(?=$|[\s,，;）)\]\[(（])/g;
    while ((m = reBracket.exec(t)) !== null) found = m[1] || m[2] || found;
    while ((m = reSuffix.exec(t)) !== null) found = m[1] || found;
    while ((m = reStandalone.exec(t)) !== null) found = m[1] || found;
    return found === '单' ? 'ODD' : (found === '双' ? 'EVEN' : 'ALL');
  }

  /** 剥掉挂在周次后面的节次括号组，如 "[1-2]" / "（1-2节）" */
  function withoutBracketGroups(text) {
    return String(text || '').replace(/[\[（(]\s*[0-9][^\]\)）]{0,20}[\]）)]/g, ' ');
  }

  function normDash(s) { return String(s || '').replace(/[至~～—–－]/g, '-'); }

  function pushWeek(arr, w, parity) {
    if (isNaN(w) || w < 1 || w > MAX_WEEK) return;
    if (parity === 'ODD' && w % 2 === 0) return;
    if (parity === 'EVEN' && w % 2 === 1) return;
    arr.push(w);
  }

  function dedupeSort(arr) {
    var seen = {}, out = [];
    for (var i = 0; i < arr.length; i++) if (!seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /** 把「周次片段」解析成周号数组（parity 由外部检测后以标记回传） */
  function parseWeeks(input) {
    var raw = String(input == null ? '' : input);
    if (!raw.trim()) return [];
    var parity = detectParity(raw);
    var cleaned = normDash(raw)
      // 先把「节次括号组」整块剥掉（"13[5-6]" / "1-12,14-16 单 [5-6]"）。
      // 必须在去噪之前做：否则括号里的 5-6 会和前面的周次粘连成 "14-165-6"，
      // 区间直接错位（真实样本上表现为第 14、15 周凭空消失）。
      .replace(/[\[（(]\s*[0-9][^\]\)）]{0,20}[\]）)]/g, '')
      .replace(/[（(\[][^）)\]]*节[^）)\]]*[）)\]]/g, '')
      .replace(/第/g, '')
      .replace(/周\s*[数次]\s*[:：]?/g, '')
      .replace(/共\s*\d+\s*[周次节]/g, '')
      .replace(/[^0-9,，、;\-]/g, '');
    var parts = cleaned.split(/[,，、;]/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      if (m) {
        var a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        if (isNaN(a) || isNaN(b)) continue;
        if (a > b) { var t = a; a = b; b = t; }
        for (var w = a; w <= b; w++) pushWeek(out, w, parity);
      } else {
        pushWeek(out, parseInt(p, 10), parity);
      }
    }
    return dedupeSort(out);
  }

  // 一个「周次列表」片段：13 / 5-12 / 1,3,5 / 1-12,14-16 都能吃下
  var WEEK_LIST = '[0-9]{1,2}(?:\\s*[-~～—]\\s*[0-9]{1,2})?' +
    '(?:\\s*[,，]\\s*[0-9]{1,2}(?:\\s*[-~～—]\\s*[0-9]{1,2})?)*';

  /**
   * 从一段文本里挑出「周次子串」；返回带单双标记的文本，交给 parseWeeks。
   *
   * 优先级按「信号强度」排（真实青果页面形态，缺一条就有课解析不出来）：
   *   ① **紧贴节次括号**前面那一段 —— 网页上恒定写作 "5-12 双 [1-2]" / "13[5-6]"，
   *      括号是最强锚点，必须放在最前面，否则 "13" 这种单周课会被整条丢掉。
   *   ② 带「周次/周数」标签
   *   ③ 以「周」收尾的列表
   *   ④ 裸区间 "1-16"
   *   ⑤ 整串就是一个数字
   */
  function weekField(text) {
    var raw = String(text || '');
    var parity = detectParity(raw);
    var token = '', m;
    var reBeforeBracket = new RegExp('(' + WEEK_LIST + ')\\s*(?:[单双]\\s*)?[（(\\[]');
    if ((m = reBeforeBracket.exec(raw))) {
      token = m[1];
    } else {
      var t = withoutBracketGroups(raw);
      if ((m = new RegExp('周\\s*[数次]\\s*[:：]?\\s*(' + WEEK_LIST + ')').exec(t))) token = m[1];
      else if ((m = new RegExp('(' + WEEK_LIST + ')\\s*周(?![次数])').exec(t))) token = m[1];
      else if ((m = /(^|[\s(（\[])([0-9]{1,2}\s*[-~～—]\s*[0-9]{1,2})(?![\d-])/.exec(t))) token = m[2];
      else if ((m = /^\s*([0-9]{1,2})\s*$/.exec(t))) token = m[1];
    }
    if (!token) return '';
    return token + (parity === 'ODD' ? '(单)' : parity === 'EVEN' ? '(双)' : '');
  }

  /* ---------------- 节次解析 ---------------- */

  function expandRange(a, b) {
    var out = [], lo = Math.min(a, b), hi = Math.max(a, b);
    for (var i = lo; i <= hi; i++) out.push(i);
    return out;
  }

  /** "1-2节" / "[1-2]" / "1,2节" → [1,2]（小节粒度） */
  function parseSections(input) {
    var raw = normDash(String(input == null ? '' : input));
    var m = /(\d+)\s*-\s*(\d+)/.exec(raw);
    if (m) return expandRange(parseInt(m[1], 10), parseInt(m[2], 10));
    if (/,/.test(raw)) {
      var out = [];
      raw.split(',').forEach(function (x) {
        var n = parseInt(x, 10);
        if (!isNaN(n)) out.push(n);
      });
      return out;
    }
    var solo = /(\d+)/.exec(raw);
    return solo ? [parseInt(solo[1], 10)] : [];
  }

  /** 从文本里挑节次：优先 "[1-2]" / "节次:1-2" / "第1-2节" / "1-2节" */
  function sectionField(text) {
    var m = /[\[（(]\s*([0-9]{1,2}\s*[-~～—]\s*[0-9]{1,2})\s*[\]）)]/.exec(text);
    if (m) return m[1];
    m = /节\s*次\s*[:：]?\s*([0-9]{1,2}\s*[-~～—]\s*[0-9]{1,2})/.exec(text);
    if (m) return m[1];
    m = /第?\s*([0-9]{1,2}\s*[-~～—]\s*[0-9]{1,2})\s*节/.exec(text);
    if (m) return m[1];
    m = /第?\s*([0-9]{1,2})\s*节/.exec(text);
    if (m) return m[1];
    return '';
  }

  /** 小节 → 本仓的大节 period（1..5）；跨大节会返回多个 period */
  function toPeriods(sections) {
    if (!sections || !sections.length) return [];
    var lo = Math.min.apply(null, sections), hi = Math.max.apply(null, sections);
    var ps = Math.ceil(lo / 2), pe = Math.floor(hi / 2);
    if (!(ps >= 1 && pe >= ps)) return [];
    var out = [];
    for (var p = ps; p <= pe && p <= MAX_PERIOD; p++) out.push(p);
    return out;
  }

  /** 带 colspan/rowspan 的单元格信息（全校课表按班级的打印版靠 colspan 定位大节） */
  function cellInfo(rowHtml) {
    var out = [], re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi, m;
    while ((m = re.exec(rowHtml)) !== null) {
      var attrs = m[1] || '';
      var cs = /colspan\s*=\s*["']?(\d+)/i.exec(attrs);
      var rs = /rowspan\s*=\s*["']?(\d+)/i.exec(attrs);
      out.push({
        html: m[2],
        colspan: cs ? parseInt(cs[1], 10) : 1,
        rowspan: rs ? parseInt(rs[1], 10) : 1
      });
    }
    return out;
  }

  /**
   * 「全校课表(按班级)」打印版的一行文本 → 一门课。
   * 网页写法（&ensp; 分隔，没有 font/div）：
   *   课程名 教师 [5-12]周 双周 1-2节 3号教学楼208 112
   * 末尾那个数字是**上课人数**，要剥掉，否则会被当成教室号的一部分。
   */
  function parseFlatCourse(line) {
    var m = /^(.+?)\s+([^\s\[\]]+)\s*\[([^\]]+)\]周?\s*(单周|双周)?\s*(\d+)\s*[-~～—]\s*(\d+)\s*节\s*(.*)$/
      .exec(String(line || '').trim());
    if (!m) return null;
    var mark = m[4] === '单周' ? '(单)' : (m[4] === '双周' ? '(双)' : '');
    var weeks = parseWeeks(m[3] + mark);
    var periods = toPeriods(expandRange(parseInt(m[5], 10), parseInt(m[6], 10)));
    if (!weeks.length || !periods.length) return null;
    var room = String(m[7] || '').replace(/\s+\d+\s*$/, '').trim();
    return {
      name: String(m[1]).trim(),
      teacher: String(m[2]).trim(),
      room: room,
      weeks: weeks,
      periods: periods
    };
  }

  /**
   * ④ 打印版「全校课表(按班级)」：表头两行 ——
   *     第一行：班级(列0) + 7 个 colspan=5 的星期格；
   *     第二行：每天按 上午(2列) 下午(2列) 晚上(1列) 展开 ⇒ 第 N 列就是第 N 大节。
   *   列位置即 (星期, 大节)，单元格文本是扁平的一行。
   *
   * ⚠️ 这一页可以同时查出**多个行政班级**（页面顶部写「共N个行政班级」），
   *    混着导会把别班的课写进本班 ⇒ 多于一个班直接报错，让操作者重新只选一个班。
   */
  function parsePrintLayout(rows) {
    var h1 = -1, h2 = -1, i, c;
    for (i = 0; i < rows.length - 1; i++) {
      var head = cellInfo(rows[i]);
      var dayCount = 0;
      for (c = 0; c < head.length; c++) if (dayFromText(stripTags(head[c].html))) dayCount++;
      if (dayCount < 2) continue;
      var sub = cellInfo(rows[i + 1]);
      var slotCount = 0;
      for (c = 0; c < sub.length; c++) if (/上午|下午|晚上/.test(stripTags(sub[c].html))) slotCount++;
      if (slotCount < 3) continue;
      h1 = i; h2 = i + 1; break;
    }
    if (h1 < 0) return [];

    // 列 → 星期（按 colspan 展开）
    var dayByCol = [], col = 0;
    var row1 = cellInfo(rows[h1]);
    for (c = 0; c < row1.length; c++) {
      var d = dayFromText(stripTags(row1[c].html));
      for (var k = 0; k < (row1[c].colspan || 1); k++) dayByCol[col++] = d || 0;
    }
    // 列 → 大节（第二行从列 1 开始，班级列被 rowspan 占了列 0）
    var periodByCol = [], col2 = 1, perDay = {};
    var row2 = cellInfo(rows[h2]);
    for (c = 0; c < row2.length; c++) {
      for (var k2 = 0; k2 < (row2[c].colspan || 1); k2++) {
        var dd = dayByCol[col2];
        if (dd) { perDay[dd] = (perDay[dd] || 0) + 1; periodByCol[col2] = perDay[dd]; }
        col2++;
      }
    }

    // 正文：一班一行，首格是「班级名(人数)」
    var classRows = [];
    for (var r = h2 + 1; r < rows.length; r++) {
      var rc = cellInfo(rows[r]);
      if (!rc.length) continue;
      var label = stripTags(rc[0].html);
      if (!label || !/班/.test(label)) continue;
      classRows.push({ label: label, cells: rc });
    }
    if (!classRows.length) return [];
    if (classRows.length > 1) {
      throw new Error('这一页里有 ' + classRows.length + ' 个行政班级（' +
        classRows.map(function (x) { return x.label; }).join('、') +
        '）—— 一次只能导入一个班。请回到查询页只勾选一个行政班级，再复制源码。');
    }

    var out = [];
    var row = classRows[0];
    var c3 = 0;
    for (var cc = 0; cc < row.cells.length; cc++) {
      var day = dayByCol[c3], period = periodByCol[c3];
      if (c3 > 0 && day && period) {
        var lines = cellLines(row.cells[cc].html);
        for (var li = 0; li < lines.length; li++) {
          var one = parseFlatCourse(lines[li]);
          if (!one) continue;
          for (var p = 0; p < one.periods.length; p++) {
            out.push({
              name: one.name, teacher: one.teacher, room: one.room,
              day: day, weeks: one.weeks, period: one.periods[p]
            });
          }
        }
      }
      c3 += row.cells[cc].colspan || 1;
    }
    if (!out.length) return [];
    out.className = row.label.replace(/\s*\(\d+\)\s*$/, '');
    return out;
  }

  /* ---------------- 单元格课程提取 ---------------- */

  function valueOfTitle(html, title) {
    var re = new RegExp('title=["\']?\\s*' + title + '\\s*["\']?[^>]*>([\\s\\S]*?)</', 'i');
    var m = re.exec(String(html || ''));
    return m ? stripTags(m[1]).replace(/^[^:：]*[:：]/, '').trim() : '';
  }

  function pickName(html, lines) {
    var m = /<font[^>]*>([\s\S]*?)<\/font>/i.exec(String(html || ''));
    if (m && stripTags(m[1])) return stripTags(m[1]);
    m = /<([a-z]+)[^>]*class=["']?[^"']*title[^"']*["']?[^>]*>([\s\S]*?)<\/\1>/i.exec(String(html || ''));
    if (m && stripTags(m[2])) return stripTags(m[2]);
    m = /<u\b[^>]*>([\s\S]*?)<\/u>/i.exec(String(html || ''));
    if (m && stripTags(m[1])) return stripTags(m[1]);
    var titled = valueOfTitle(html, '课程(名称)?');
    if (titled) return titled;
    return lines && lines.length ? lines[0] : '';
  }

  var LOC_WORDS = /楼|室|馆|区|号|座|园|部|场|中心|机房|实验室/;

  /**
   * 解析一个单元格 → 0..n 门课。rowPeriodHint 是行首「第1-2节」给的小节提示，
   * 单元格自身没写节次时用它兜底（网页网格常见：节次只在行首出现）。
   */
  function parseCell(html, day, rowPeriodHint, diag) {
    var out = [];
    if (!html || !/[^\s]/.test(stripTags(html))) return out;

    var blocks = [];
    if (/<div\b/i.test(html)) {
      var re = /<div[^>]*>([\s\S]*?)<\/div>/gi, m;
      while ((m = re.exec(html)) !== null) blocks.push(m[1]);
    }
    if (!blocks.length) blocks = [html];

    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (/nokb/i.test(block)) continue;
      var lines = cellLines(block);
      if (!lines.length) continue;

      var name = pickName(block, lines);
      if (!name) continue;

      var teacher = valueOfTitle(block, '(任课)?教师');
      var location = valueOfTitle(block, '(上课)?地点|教室');
      var weeks = [], periods = [];
      var wf = weekField(lines.join(' ')), sf = sectionField(lines.join(' '));

      var rest = lines.filter(function (l) { return l !== name; });
      var leftovers = [];
      for (var j = 0; j < rest.length; j++) {
        var line = rest[j];
        // 含「数字-数字」或方括号的行 = 周次/节次，不是人也不是地点
        if (/[0-9]\s*[-~～—]\s*[0-9]|[\[（(]\s*[0-9]/.test(line)) continue;
        if (!location && LOC_WORDS.test(line)) { location = line; continue; }
        if (!teacher && !/[0-9]/.test(line)) { teacher = line; continue; }
        leftovers.push(line);
      }
      // 地点兜底：像「线上教学」这种不含 楼/室/馆 的地名，前两条规则都吃不下，
      // 此时把最后一条没人认领的文本当地点，别让教室空着。
      if (!location && leftovers.length) location = leftovers[leftovers.length - 1];

      if (wf) weeks = parseWeeks(wf);
      var rawSections = sf ? parseSections(sf) : (rowPeriodHint || []);
      periods = toPeriods(rawSections);

      if (!weeks.length) { diag.drop('no_weeks'); continue; }
      if (!periods.length) { diag.drop('no_sections'); continue; }
      for (var k = 0; k < periods.length; k++) {
        out.push({
          name: name, teacher: teacher, room: location,
          day: day, weeks: weeks, period: periods[k]
        });
      }
    }
    return out;
  }

  /* ---------------- 三种版面 ---------------- */

  function dayFromText(text) {
    var t = String(text || '').replace(/\s+/g, '');
    if (!t) return 0;
    for (var i = 0; i < DAY_WORDS.length; i++) {
      if (t.indexOf(DAY_WORDS[i][0]) !== -1) return DAY_WORDS[i][1];
    }
    if (/^[1-7]$/.test(t)) return parseInt(t, 10);
    return 0;
  }

  /**
   * 行暗示节次：从「星期列之前」的那几个首格里找 "[1-2]" / "第1-2节" / "1-2节"。
   * 扫多个首格而不是只看第一格 —— 真实页面常在节次前面再插一列「序号」，
   * 只看 cells[0] 会拿到 "1" 这种序号，反而丢掉真正的节次。
   */
  function rowPeriodHint(cells, dayMap) {
    if (!cells || !cells.length) return [];
    for (var i = 0; i < cells.length; i++) {
      if (dayMap && dayMap[cells.length - 1 - i]) break;   // 已到星期列，停
      var text = stripTags(cells[i]);
      if (!text) continue;
      var m = /([0-9]{1,2}\s*[-~～—]\s*[0-9]{1,2})/.exec(text);
      if (m) return parseSections(m[1]);
    }
    return [];
  }

  /** ① 列表式表格：表头含「课程」且含 周次/星期/节次/上课 之一 */
  function parseListLayout(rows, diag) {
    var headerIdx = -1, headerCells = null;
    for (var i = 0; i < rows.length; i++) {
      var cells = cellsOf(rows[i]);
      if (!cells.length) continue;
      var head = stripTags(cells.join(' '));
      if (/课程|科目/.test(head) && /周次|周数|星期|节次|上课/.test(head)) {
        headerIdx = i; headerCells = cells; break;
      }
    }
    if (headerIdx < 0) return [];

    var col = { name: -1, teacher: -1, room: -1, weeks: -1, sections: -1, day: -1 };
    for (var c = 0; c < headerCells.length; c++) {
      var h = stripTags(headerCells[c]).replace(/\s+/g, '');
      if (col.name < 0 && /课程|科目/.test(h)) col.name = c;
      if (col.teacher < 0 && /教师|任课|讲师|老师/.test(h)) col.teacher = c;
      if (col.room < 0 && /地点|教室|校区|班级/.test(h)) col.room = c;
      if (col.weeks < 0 && /周次|周数|上课周/.test(h)) col.weeks = c;
      if (col.sections < 0 && /节次|节数|大节|第几节/.test(h)) col.sections = c;
      if (col.day < 0 && /星期|周几|星期几|上课日/.test(h)) col.day = c;
    }
    if (col.name < 0) return [];

    var out = [];
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var rc = cellsOf(rows[r]);
      if (!rc.length) continue;
      var name = col.name >= 0 ? stripTags(rc[col.name] || '') : '';
      if (!name) continue;
      var rowText = stripTags(rc.join(' '));
      // 表头**声明过**的列就只信那一列：某些页面的其他单元格里也有形如 1-2 的
      // 数字，一旦回退到整行文本，空周次会被误填成形似值，脏数据就进了库。
      // 没声明列的版面才用整行文本兜底。
      var wf = col.weeks >= 0 ? stripTags(rc[col.weeks] || '') : weekField(rowText);
      var st = col.sections >= 0 ? stripTags(rc[col.sections] || '') : sectionField(rowText);
      var day = dayFromText(col.day >= 0 ? stripTags(rc[col.day] || '') : rowText);
      if (!day) { diag.drop('no_day'); continue; }
      var weeks = parseWeeks(wf);
      var periods = toPeriods(parseSections(st));
      if (!weeks.length) { diag.drop('no_weeks'); continue; }
      if (!periods.length) { diag.drop('no_sections'); continue; }
      for (var p = 0; p < periods.length; p++) {
        out.push({
          name: name,
          teacher: (col.teacher >= 0 ? stripTags(rc[col.teacher] || '') : '') || '',
          room: (col.room >= 0 ? stripTags(rc[col.room] || '') : '') || '',
          day: day, weeks: weeks, period: periods[p]
        });
      }
    }
    return out;
  }

  /**
   * ② 网格表：找含「星期X」的表头行，用**反向索引**建 列→星期 映射。
   * 反向的原因：行首常有「节次 / 时间」列，各行列数不一致时正向映射会整体串位。
   */
  function parseGridLayout(rows, diag) {
    var dayMap = null, headerIdx = -1;
    for (var i = 0; i < rows.length; i++) {
      var cells = cellsOf(rows[i]);
      if (cells.length < 3) continue;
      var map = {}, found = 0;
      for (var c = 0; c < cells.length; c++) {
        var d = dayFromText(stripTags(cells[c]));
        if (!d) continue;
        var reverseIdx = cells.length - 1 - c;
        if (!map[reverseIdx]) { map[reverseIdx] = d; found++; }
      }
      if (found >= 2) { dayMap = map; headerIdx = i; break; }
    }
    if (!dayMap) return [];

    var out = [];
    for (var r = headerIdx + 1; r < rows.length; r++) {
      var rc = cellsOf(rows[r]);
      if (!rc.length) continue;
      var hint = rowPeriodHint(rc, dayMap);
      for (var c2 = 0; c2 < rc.length; c2++) {
        var day = dayMap[rc.length - 1 - c2];
        if (!day) continue;
        var got = parseCell(rc[c2], day, hint, diag);
        for (var g = 0; g < got.length; g++) out.push(got[g]);
      }
    }
    return out;
  }

  /** ③ 兜底：没找到星期表头时，扫 class="td" 的单元格，一行里第 N 个 = 星期 N */
  function parseLegacyLayout(rows, diag) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var re = /<td[^>]*\bclass=["']?[^"']*\btd\b[^"']*["']?[^>]*>([\s\S]*?)<\/td>/gi, m, count = 0;
      while ((m = re.exec(rows[i])) !== null) {
        var got = parseCell(m[1], (count % 7) + 1, [], diag);
        count++;
        for (var g = 0; g < got.length; g++) out.push(got[g]);
      }
    }
    return out;
  }

  /**
   * 「外层框架页」识别与指引。
   *
   * 真实踩坑（2026-10-10 用户提供样本）：青果登录后停在的是 **desk 外壳页**，
   * 课表渲染在 <iframe id="frmDesk"> 里，而 iframe 的 src 是 JS 动态赋的 ——
   * 对外层页面右键「查看网页源代码」拿到的 HTML 里**一行课表都没有**。
   * 这时不能只报「没解析出课次」，否则用户只会以为解析器坏了。
   * 命中后返回可执行的取源码指引（给 UI 直接 toast 出去）。
   */
  var SHELL_MARK = /frmDesk|index-left-panel|KINGOSOFT/i;

  function shellHint(doc) {
    if (!/<iframe/i.test(doc) || !SHELL_MARK.test(doc)) return '';
    return '这是青果的外层框架页 —— 课表渲染在 id="frmDesk" 的 iframe 里，' +
      '这一层源码里根本没有课表。请先进到「教学安排 → 我的课表」页面，' +
      '再取 iframe 里的源码：按 F12 打开控制台，执行 ' +
      'copy(document.querySelector("#frmDesk").contentDocument.documentElement.outerHTML)，' +
      '（或右键 iframe 空白处选「查看框架源代码」）把结果粘回来。';
  }

  /**
   * 抽取页面顶部的「学籍信息条」：学号 / 所在班级 / 课程门数。
   * 课程门数用来跟解析结果**自动对账** —— 解析少了就是漏课，必须大声说出来，
   * 而不是让操作者拿一份残缺的课表去覆盖全班。
   */
  function extractMeta(doc) {
    var text = stripTags(doc);
    var meta = {};
    var m = /学号\s*[:：]\s*([0-9A-Za-z]{4,20})/.exec(text);
    if (m) meta.studentNo = m[1];
    m = /姓名\s*[:：]\s*([^\s0-9]{2,6})/.exec(text);
    if (m) meta.studentName = m[1];
    m = /所在班级\s*[:：]\s*([^\s]{2,30}班)/.exec(text);
    if (m) meta.className = m[1];
    m = /课程门数\s*[:：]\s*(\d+)/.exec(text);
    if (m) meta.declaredCourseCount = parseInt(m[1], 10);
    return meta;
  }

  /* ---------------- 组装输出 ---------------- */

  function toOutput(courses, layout, diag, meta) {
    var list = [], courseMap = {}, seenSession = {}, count = 0, dup = 0;
    for (var i = 0; i < courses.length; i++) {
      var it = courses[i];
      var key = it.name + '|' + it.teacher;
      if (!courseMap[key]) courseMap[key] = { name: it.name, teacher: it.teacher, room: it.room || '' };
      else if (!courseMap[key].room && it.room) courseMap[key].room = it.room;
      // 打印版页面会把同一条课次重复渲染两次（title 与正文各一次）——
      // 完全相同的一条课次只写一次，否则值日/课表都会莫名多一份。
      var skey = [it.name, it.teacher, it.room || '', it.day, it.period, it.weeks.join(',')].join('|');
      if (seenSession[skey]) { dup++; continue; }
      seenSession[skey] = 1;
      list.push({
        name: it.name, teacher: it.teacher, room: it.room || '',
        dayOfWeek: it.day, period: it.period, weeks: it.weeks.join(',')
      });
      count++;
    }
    var courseList = [];
    for (var k in courseMap) if (Object.prototype.hasOwnProperty.call(courseMap, k)) courseList.push(courseMap[k]);
    var warnings = [];
    if (diag.count.no_weeks) warnings.push('有 ' + diag.count.no_weeks + ' 条记录因缺少周次被跳过');
    if (diag.count.no_sections) warnings.push('有 ' + diag.count.no_sections + ' 条记录因缺少节次被跳过');
    if (diag.count.no_day) warnings.push('有 ' + diag.count.no_day + ' 条记录因缺少星期被跳过');
    meta = meta || {};
    // 与页面顶部「课程门数」对账：少了就是漏课，必须拦住
    if (meta.declaredCourseCount && courseList.length !== meta.declaredCourseCount) {
      warnings.push('⚠ 页面顶部写着 ' + meta.declaredCourseCount + ' 门课，本次只解析出 ' +
        courseList.length + ' 门 —— 可能漏课了，请先核对再导入');
    }
    return {
      layout: layout,
      courses: courseList,
      sessions: list,
      warnings: warnings,
      meta: meta,
      stats: { parsed: count, dropped: diag.count, deduped: dup }
    };
  }

  function parse(html, opts) {
    opts = opts || {};
    var doc = cleanDoc(html);
    var meta = extractMeta(doc);
    var diag = {
      count: { no_weeks: 0, no_sections: 0, no_day: 0 },
      drop: function (reason) { this.count[reason] = (this.count[reason] || 0) + 1; }
    };
    var rows = rowsOf(doc);
    if (!rows.length) {
      throw new Error(shellHint(doc) ||
        '没有识别到表格行，请确认粘贴的是课表页面（不是登录页 / 首页）的完整源码');
    }

    var got = [], layout = '';
    // 顺序：列表式 → 打印版(全校课表按班级) → 网格 → 旧版兜底。
    // 打印版必须在网格之前：它的表头第一行也是「星期X」，
    // 被网格用反向索引吃到会得到一堆错位的星期（列数差了 5 倍）。
    var strategies = [
      ['list', parseListLayout],
      ['print', parsePrintLayout],
      ['grid', parseGridLayout],
      ['legacy', parseLegacyLayout]
    ];
    for (var i = 0; i < strategies.length && !got.length; i++) {
      got = strategies[i][1](rows, diag);
      if (got.length) layout = strategies[i][0];
    }
    if (got.length && got.className && !meta.className) meta.className = got.className;
    if (!got.length) {
      throw new Error(shellHint(doc) ||
        '未能从页面中解析出任何课次，请确认已进入「我的课表」页面再查看源码');
    }
    return toOutput(got, layout, diag, meta);
  }

  return {
    parse: parse,
    parseWeeks: parseWeeks,
    weekField: weekField,
    parseSections: parseSections,
    sectionField: sectionField,
    toPeriods: toPeriods,
    detectParity: detectParity,
    parseFlatCourse: parseFlatCourse,
    stripTags: stripTags,
    dayFromText: dayFromText
  };
});
