/**
 * 名单解析器（后台版）· 2026-11-16
 * ============================================================
 * 与小程序 `cloudfunctions/member/index.js` 的 parseLine / parseRoster **同口径**，
 * 并额外兼容三种它在小程序侧没覆盖的常见写法（用户口径「甚至适配更多格式」）：
 *
 *   ① 单空格分隔：`000000000301 张三`（原实现只认逗号/制表符/竖线/两个以上空格，
 *      单空格会把整行当一个字段 ⇒ 解析失败，而中文 Excel「另存为 txt」恰好就是这种）；
 *   ② 学号与姓名**粘在一起**：`000000000301张三` / `张三000000000301`；
 *   ③ 字母数字混合学号 / 工号：`STAFFV7E9FS`（教职工用占位学号，见 member 的 loadSeqPrefix 注释）。
 *   另外表头词做了黑名单（「姓名」「学号」这类词本身像中文姓名，不加黑名单会被误当成员）。
 *
 * 判定原则始终是**看这一格像什么**，不看它在第几列 —— 所以
 * `姓名,学号` / `学号,姓名` / `班级,学号,姓名,性别,指导员` 都能吃。
 *
 * ⚠️ 纯函数，不碰数据库：预览与正式导入都调它，保证「看到的」和「写进去的是同一份」。
 */

/* ---------------- 字段识别规则（与小程序逐字一致，改动两边同步） ---------------- */

const GENDER = ['男', '女', '男性', '女性', '男生', '女生'];
const NAME_RE = /^[\u4e00-\u9fa5a-zA-Z·]{1,16}$/;
const DIGIT_NO_RE = /^\d{4,}$/;
/** 字母数字混合且至少含一个数字（STAFFV7E9FS 这类工号）；纯字母不认，那是姓名 */
const MIX_NO_RE = /^(?=.*\d)[A-Za-z0-9]{4,32}$/;

/** 表头/非人名列的词：命中就不当姓名（否则「姓名」两个字会被读成一个人） */
const HEADER_WORDS = [
  '姓名', '名字', '学生', '学生姓名', '学号', '学籍号', '班级', '专业', '性别',
  '序号', '编号', '行号', '指导员', '辅导员', '备注', '电话', '手机号', '联系方式',
  '组别', '分组', '职位', '职务', '宿舍', '签名'
];

/** 像「班级」的字样：`班` 只认结尾（否则「班超」这类姓氏会被误判），专升本/专业 任意位置都算 */
function looksLikeClass(s) {
  const t = String(s || '');
  if (/专升本/.test(t) || /专业/.test(t)) return true;
  return /班$/.test(t);
}

function looksLikeName(s) {
  const t = String(s || '');
  if (!NAME_RE.test(t)) return false;
  if (GENDER.indexOf(t) >= 0) return false;
  if (HEADER_WORDS.indexOf(t) >= 0) return false;
  if (looksLikeClass(t)) return false;
  return true;
}

/** 像「名册序号」的小整数（1~999，容忍 Excel 的 1.0） */
function looksLikeSeq(s) {
  const t = String(s == null ? '' : s).trim();
  if (!/^\d{1,3}(?:\.0+)?$/.test(t)) return false;
  const n = parseInt(t, 10);
  return n >= 1 && n <= 999;
}

/* ---------------- 一行 → 一条记录 ---------------- */

/**
 * 切分一行。
 * 顺序：先按「明确分隔符」，切不出多段再按单空格 —— 反过来会把
 * `阿依古丽 买买提` 这类带空格的姓名拆碎。
 */
function splitFields(line) {
  const s = String(line || '').trim();
  if (!s) return [];
  let parts = s.split(/[,，\t|;；]+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 1) {
    // ① 单空格：`000000000301 张三`
    const bySpace = s.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    if (bySpace.length > 1) parts = bySpace;
  }
  // ② 粘在一起：`000000000301张三` / `张三000000000301`
  //    同时把 Excel 另存 CSV 常见的整数值 `000000000301.0` 还原成整数
  //    （不还原的话它既不是 DIGIT_NO_RE 也不是 looksLikeSeq，整行被判失败）。
  const glued = [];
  parts.map((p) => p.replace(/^(\d{4,})\.0+$/, '$1')).forEach((p) => {
    const m1 = /^(\d{4,})([\u4e00-\u9fa5·]{2,16})$/.exec(p);
    const m2 = /^([\u4e00-\u9fa5·]{2,16})(\d{4,})$/.exec(p);
    if (m1) { glued.push(m1[1], m1[2]); return; }
    if (m2) { glued.push(m2[2], m2[1]); return; }
    glued.push(p);
  });
  return glued;
}

/**
 * 一行 → { name, studentNo, seq, label }；识别不出返回 null。
 * 有姓名、且有「学号 或 序号」才算可用（只有序号时由上层按班级学号前缀补全）。
 */
function parseLine(line) {
  const parts = splitFields(line);
  if (!parts.length) return null;
  let studentNo = '';
  let name = '';
  let label = '';
  let seq = 0;
  for (const p of parts) {
    // 学号优先级：纯数字 > 字母数字混合（工号）
    if (!studentNo && DIGIT_NO_RE.test(p)) { studentNo = p; continue; }
    if (!label && looksLikeClass(p)) { label = p; continue; }
    if (!name && looksLikeName(p)) { name = p; continue; }
    if (!studentNo && MIX_NO_RE.test(p)) { studentNo = p; continue; }
    if (!seq && looksLikeSeq(p)) { seq = parseInt(p, 10); continue; }
  }
  if (!name) return null;
  if (!studentNo && !seq) return null;
  return { name, studentNo, label, seq };
}

/** 整段文本 → { rows, failed }；自动跳过表头行与空行 */
function parseRoster(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  const failed = [];
  lines.forEach((line, i) => {
    // 表头行：含「学号/姓名/班级/专业」等字样**且没有 4 位以上数字** → 当表头跳过，不算失败
    const hasDigits = /\d{4,}/.test(line.replace(/[^\d,，\t|;；\s]/g, ''));
    if (!hasDigits && /学号|姓名|班级|专业|性别|指导员|辅导员|序号|编号/.test(line)) return;
    const r = parseLine(line);
    if (!r) {
      failed.push({ line: i + 1, reason: '缺少姓名，或既没有学号也没有序号', raw: line.slice(0, 40) });
      return;
    }
    rows.push(Object.assign({ line: i + 1 }, r));
  });
  return { rows, failed };
}

/** 学号末位奇偶分组：奇 A 偶 B（与小程序 groupOf 同口径） */
function groupOf(studentNo) {
  const last = parseInt(String(studentNo).slice(-1), 10);
  return last % 2 === 0 ? 'B' : 'A';
}

/** 只有序号时的学号补全：前缀 + 两位序号（prefix 来自该班存量学号，见 mod-roster） */
function studentNoFromSeq(seq, prefix, width) {
  const w = width || 2;
  return String(prefix || '') + String(seq).padStart(w, '0');
}

module.exports = {
  GENDER, NAME_RE, DIGIT_NO_RE, MIX_NO_RE, HEADER_WORDS,
  looksLikeClass, looksLikeName, looksLikeSeq,
  splitFields, parseLine, parseRoster, groupOf, studentNoFromSeq
};
