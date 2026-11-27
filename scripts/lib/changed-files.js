#!/usr/bin/env node
/**
 * 共享原语：改动文件集 / 文件新增行（检测信号源唯一真源，2026-11-27）
 * ============================================================
 * 起因：同一个「表征 ≠ 实体」错误在三个门禁里各犯一次——
 *   ① check-decisions 用 git diff 当信号源，看不见未跟踪的新建页面（11-27 修）；
 *   ② check-no-api-key 用 git ls-files -z，只扫受跟踪文件，新写入未跟踪文件的
 *      硬编码密钥在私有仓门禁假绿（本轮推演发现）；
 *   ③ normalize-eol 在 11-16 已自行补过 --others，但代码重复、无共享实现。
 * 反复发现同一根因 ⇒ 抽成原语，让「改动文件集」只有一个实现、一处可修。
 *
 * 提供四件事：
 *   - changedFiles(root)：三路并集 = 工作区 diff HEAD ∪ HEAD~1..HEAD ∪ 未跟踪文件；
 *   - sourceFiles(root)：受跟踪 + 未跟踪文件（-z 规避中文/空格路径），全量扫描用；
 *   - addedLinesOf(file, root)：已跟踪走 git diff；**未跟踪直接读全文**（新建文件
 *     所有行都是新增，git diff 对未跟踪返回 0 字节——本轮修的判定残留）；
 *   - gitOut(args, root)：统一 git 执行与失败降级（返回 null，不抛）。
 *
 * ⚠️ 判据纪律：门禁不得再各自拼 git 命令。谁要新信号形态，只改这里 + 改自证，
 *    避免 M1 同源多点漏改。本文件自身含 `--others` 等判据字面量，属于基础设施，
 *    不是呈现类改动，不触发 check-decisions 的记录要求。
 *
 * 用法：const cf = require('./lib/changed-files');
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/** 未跟踪文件信号：判据字面量，供门禁源码自读守卫断言在位 */
const UNTRACKED_ARGS = ['ls-files', '--others', '--exclude-standard'];

/** git 执行：失败返回 null（不抛），由调用方决定降级策略 */
function gitOut(args, cwd, encoding) {
  try {
    return cp.execFileSync('git', args, {
      cwd: cwd || ROOT,
      encoding: encoding || 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (e) {
    return null;
  }
}

/** 改动文件：三路并集（去重） */
function changedFiles(root) {
  const cwd = root || ROOT;
  const out = [];
  const cmds = [
    ['diff', '--name-only', 'HEAD'],
    ['diff', '--name-only', 'HEAD~1', 'HEAD'],
    UNTRACKED_ARGS
  ];
  cmds.forEach(args => {
    const txt = gitOut(args, cwd);
    if (txt === null) return;
    txt.split('\n').forEach(f => { if (f && out.indexOf(f) < 0) out.push(f); });
  });
  return out;
}

/** 全量源文件：受跟踪 + 未跟踪（--exclude-standard 自动排除 .gitignore 命中的临时文件） */
function sourceFiles(root) {
  const cwd = root || ROOT;
  const out = [];
  [['ls-files', '-z'], ['ls-files', '-z', '--others', '--exclude-standard']].forEach(args => {
    const txt = gitOut(args, cwd);
    if (txt === null) return;
    txt.split('\0').forEach(f => { if (f && out.indexOf(f) < 0) out.push(f); });
  });
  return out;
}

/** 文件是否未跟踪（精确 pathspec，避免前缀误判） */
function isUntracked(file, root) {
  const txt = gitOut(UNTRACKED_ARGS.concat(['--', file]), root || ROOT);
  return txt !== null && txt.split('\n').some(l => l === file);
}

/**
 * 取文件的新增行（供呈现类 js 判定导航 API 是否新增）。
 * 未跟踪文件 git diff 返回空 ⇒ 直接读全文：新建文件的每一行都是新增。
 */
function addedLinesOf(file, root) {
  const cwd = root || ROOT;
  if (isUntracked(file, cwd)) {
    try { return fs.readFileSync(path.join(cwd, file), 'utf8'); } catch (e) { return ''; }
  }
  const txt = gitOut(['diff', 'HEAD', '--', file], cwd);
  if (txt === null) return '';
  return txt.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1))
    .join('\n');
}

module.exports = { ROOT, UNTRACKED_ARGS, gitOut, changedFiles, sourceFiles, isUntracked, addedLinesOf };
