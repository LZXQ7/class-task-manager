/**
 * 项目备注（mp 后台「版本管理」备注列）的纯文本解析器。
 *
 * 口径（用户 2026-11-19 定）：项目备注**只写简短更新说明，面向开发者** ——
 * 取 outputs/v<版本>-更新说明.md 的「## 一句话」+「## 改了什么」表格，
 * 不转录「需求口径 / 前端 / 门禁 / 升级后生效条件」这些长篇内部细节
 * （旧版取「版本 B」整段会被截断，备注列只能看到半句）。
 * 2026-11-26 起备注硬上限 200 字（NOTE_MAX），并按行/句读边界安全截断。
 *
 * 本文件是纯函数、无 fs / 无副作用，便于门禁 new Function 直接载入做变异自证。
 */

/** 取一个二级标题下的原始行（到下一个 ## 或 --- 为止） */
function section(lines, re) {
  const i = lines.findIndex(l => re.test(l));
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (/^##\s/.test(t) || /^---\s*$/.test(t)) break;
    out.push(t);
  }
  return out;
}

function clean(s) {
  return String(s || '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

/** mp 后台备注字数上限（用户 2026-11-26 定：不超过 200 字） */
export const NOTE_MAX = 200;

/**
 * 安全截断：优先在换行 / 句读边界收尾，避免切出半句话；省略号算 1 字。
 * 纯函数，门禁可直接载入做变异自证。
 */
export function clampNote(text, max) {
  const lim = Math.max(1, Number(max) || NOTE_MAX);
  const s = String(text || '');
  if (s.length <= lim) return s;
  if (lim === 1) return '…';
  const head = s.slice(0, lim - 1);
  const cut = Math.max(
    head.lastIndexOf('\n'), head.lastIndexOf('。'),
    head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；')
  );
  // 边界太靠前（前半段全丢）就宁可硬切，保住信息量
  const keep = cut >= Math.floor(head.length * 0.6) ? cut + 1 : head.length;
  return head.slice(0, keep).replace(/\s+$/, '') + '…';
}

/**
 * @param {string} text 更新说明 markdown 全文
 * @param {number} [max] 备注字数上限，默认 NOTE_MAX = 200
 * @returns {string|null} 简短备注；没有一句话也没有有效表格行时返回 null（由调用方回退）
 */
export function parseShortNote(text, max) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  const one = section(lines, /^##\s*一句话/).filter(l => l && !l.startsWith('>')).map(clean).join('\n');

  const rows = section(lines, /^##\s*改了什么/);
  const changes = [];
  rows.forEach((line) => {
    if (!line.startsWith('|')) return;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
    if (cells.length < 3) return;
    if (/^[-:]+$/.test(cells[0]) || cells[0] === '位置' || (cells[1] === '改前' && cells[2] === '改后') || !cells[0]) return;
    changes.push(cells[0] + '：' + cells[1] + ' → ' + cells[2]);
  });

  if (!one && !changes.length) return null;
  const full = [one, changes.join('\n')].filter(Boolean).join('\n\n');
  return clampNote(full, max);
}
