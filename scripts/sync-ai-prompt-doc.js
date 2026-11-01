/**
 * 把 schedule/index.js 里的 DEFAULT_AI_PROMPT 逐字同步进说明文档的 ```text 代码块。
 * 门禁 check-seq-order §5 要求两者逐字一致。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'cloudfunctions/schedule/index.js');
const DOC_PATH = path.join(ROOT, 'docs/AI 一键生成值日表-提示词与配置说明.md');

const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const start = SRC.indexOf('const DEFAULT_AI_PROMPT = [') + 'const DEFAULT_AI_PROMPT = ['.length;
const end = SRC.indexOf("].join('\\n');", start);
if (start < 0 || end < 0) throw new Error('找不到 DEFAULT_AI_PROMPT');
const promptText = SRC.slice(start, end).split('\n')
  .map(x => x.trim()).filter(x => x.startsWith("'"))
  .map(x => x.slice(1, x.lastIndexOf("'"))).join('\n');

const doc = fs.readFileSync(DOC_PATH, 'utf8');
const FENCE = '```text';
const a = doc.indexOf(FENCE);
if (a < 0) throw new Error('文档里没有 ```text 代码块');
const bodyStart = a + FENCE.length;
const b = doc.indexOf('```', bodyStart);
if (b < 0) throw new Error('```text 代码块没有闭合');

const next = doc.slice(0, bodyStart) + '\n' + promptText.trim() + '\n' + doc.slice(b);
fs.writeFileSync(DOC_PATH, next, 'utf8');
console.log('已同步：源码 ' + promptText.trim().length + ' 字');
