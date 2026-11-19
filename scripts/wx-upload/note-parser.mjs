/**
 * 项目备注（mp 后台「版本管理」备注列）的纯文本解析器。
 *
 * 口径（用户 2026-11-19 定）：项目备注**只写简短更新说明，面向开发者** ——
 * 取 outputs/v<版本>-更新说明.md 的「## 一句话」+「## 改了什么」表格，
 * 不转录「需求口径 / 前端 / 门禁 / 升级后生效条件」这些长篇内部细节
 * （旧版取「版本 B」整段，500 字上限会被截断，备注列只能看到半句）。
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

/**
 * @param {string} text 更新说明 markdown 全文
 * @returns {string|null} 简短备注；没有一句话也没有有效表格行时返回 null（由调用方回退）
 */
export function parseShortNote(text) {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);
  const one = section(lines, /^##\s*一句话/).filter(l => l && !l.startsWith('>')).map(clean).join('\n');

  const rows = section(lines, /^##\s*改了什么/);
  const changes = [];
  rows.forEach((line) => {
    if (!line.startsWith('|')) return;
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
    if (cells.length < 3) return;
    if (/^[-:]+$/.test(cells[0]) || cells[0] === '位置' || !cells[0]) return;
    changes.push(cells[0] + '：' + cells[1] + ' → ' + cells[2]);
  });

  if (!one && !changes.length) return null;
  return [one, changes.join('\n')].filter(Boolean).join('\n\n');
}
