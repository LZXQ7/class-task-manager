#!/usr/bin/env node
/**
 * 门禁：有 tag 就必须有 outputs/v<版本>-更新说明.md（2026-11-14）
 * ============================================================
 * 起因（真实漏项）：1.0.8.31 / 32 / 33 三个版本的**代码与 tag 都同步到了 GitHub**，
 *   但 CHANGELOG 与更新说明一处都没写 —— 直到用户问「每个小版本都同步更新 github 了吧」
 *   才发现：代码有版本控制兜底，文档没有。漏了不会报错、不会崩，只会静默缺失。
 *
 * 判据（两条，都对「发版必备」这条既有约定）：
 *   ① 本地每个 `v*` tag，必须存在 `outputs/v<去掉 v 的版本>-更新说明.md`；
 *   ② 该文件必须同时含「版本 A」（提审版，贴 mp 后台）与「版本 B」（公告版，发群），
 *      —— CHANGELOG 头部把这两版写成发版必备，只有个空文件等于没写。
 *
 * 为什么以 **git tag** 为真源，而不是维护一份「已发布版本清单」：
 *   清单会漂移（bump 时忘登记就永久漏），而 tag 是发版流程的必然产物，绕不过去。
 *   只要版本号 bump 了、tag 打了，这条门禁就一定看得见。
 *
 * 为什么没有白名单：加它的当天就把历史缺的 3 个版本（1.0.8.25/26/27）补齐了 ——
 *   白名单一旦开了口子，下一个「先欠着」就会进来。**没有例外才守得住。**
 *
 * 自证（3 组，全部内存里做，不碰真文件）：见文件末尾 runMutations()。
 *
 * 用法：node scripts/check-release-docs.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'outputs');

/**
 * 纯函数审计（自证复用）。
 * @param {string[]} tags 形如 ['v1.0.8.32', ...]
 * @param {{exists:(v:string)=>boolean, read:(v:string)=>string|null}} io
 * @returns {string[]} 问题列表（空 = 通过）
 */
function audit(tags, io) {
  const probs = [];
  const seen = new Set();
  (tags || []).forEach((tag) => {
    const raw = String(tag || '').trim();
    if (!raw) return;
    if (seen.has(raw)) return;
    seen.add(raw);
    const ver = raw.replace(/^v/, '');
    if (!/^\d+\.\d+(\.\d+)*$/.test(ver)) {
      // 非版本号形态的 tag（如 v-final、打包标记）不在本门禁职责内，跳过但不静默
      return;
    }
    if (!io.exists(ver)) {
      probs.push(raw + '：缺 outputs/v' + ver + '-更新说明.md（每个 tag 都必须有对外更新说明）');
      return;
    }
    const text = io.read(ver) || '';
    const hasA = text.indexOf('版本 A') >= 0;
    const hasB = text.indexOf('版本 B') >= 0;
    if (!hasA || !hasB) {
      const miss = [];
      if (!hasA) miss.push('版本 A（提审版）');
      if (!hasB) miss.push('版本 B（公告版）');
      probs.push(raw + '：更新说明里缺 ' + miss.join(' 与 ') + '（空壳文件等于没写）');
    }
  });
  return probs;
}

/** 真实 IO：outputs/v<ver>-更新说明.md */
const REAL_IO = {
  exists: (ver) => fs.existsSync(path.join(OUT_DIR, 'v' + ver + '-更新说明.md')),
  read: (ver) => {
    const f = path.join(OUT_DIR, 'v' + ver + '-更新说明.md');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  }
};

/** 本地全部 tag（git 不可用时返回 null，交由主流程提示 SKIP，而不是假装通过） */
function listTags() {
  const r = spawnSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/* ================= 跑门禁 ================= */
const TAGS = listTags();
if (!TAGS) {
  console.log('  ⚠ SKIP：读不到 git tag（非 git 环境？）—— 本门禁无法判定，按失败处理');
  process.exit(1);
}

const problems = audit(TAGS, REAL_IO);
if (!problems.length) {
  console.log('  ✓ 发版文档：' + TAGS.length + ' 个 tag 全部有对应的 outputs/v<版本>-更新说明.md（且含版本 A / 版本 B）');
} else {
  console.log('  ✗ 有 ' + problems.length + ' 个 tag 缺对外更新说明：');
  problems.forEach((p) => console.log('    · ' + p));
  console.log('');
  console.log('    修法：在 outputs/ 下补 v<版本>-更新说明.md，按既有格式写两版 ——');
  console.log('      版本 A 提审版（功能枚举，贴 mp 后台「版本描述」）');
  console.log('      版本 B 公告版（纯文本、只列标题，用于「发送更新公告」或发群）');
  console.log('    格式样例：outputs/v1.0.8.30-更新说明.md');
}

/* ================= 自证：判据不是摆设 ================= */
function runMutations() {
  const okTags = ['v9.8.7'];
  const fake = (hasFile, body) => ({
    exists: () => hasFile,
    read: () => body
  });
  let pass = 0, fail = 0;
  const chk = (cond, name) => {
    if (cond) { pass++; console.log('  ✓ 抓住 → ' + name); }
    else { fail++; console.log('  ✗ 漏放 → ' + name); }
  };

  // 好样本不误报（它不是「变异」，别用「抓住」的措辞）
  const good = audit(okTags, fake(true, '# x\n## 版本 A：提审版\n## 版本 B：公告版\n'));
  if (good.length === 0) { pass++; console.log('  ✓ 好样本不误报（文件齐全 + 两版都在）'); }
  else { fail++; console.log('  ✗ 好样本被误报：' + good.join(' | ')); }

  // 变异 1：缺文件
  const m1 = audit(okTags, fake(false, null));
  chk(m1.length === 1 && /更新说明/.test(m1[0]), '变异 1：没有更新说明文件 → 必红');

  // 变异 2：有文件但只有版本 A（空壳）
  const m2 = audit(okTags, fake(true, '# x\n## 版本 A：提审版\n'));
  chk(m2.length === 1 && /版本 B/.test(m2[0]), '变异 2：只有提审版、没有公告版 → 必红');

  // 变异 3：多 tag 时只缺其中一个
  const m3 = audit(['v9.8.7', 'v9.8.8'], {
    exists: (v) => v === '9.8.7',
    read: () => '# x\n版本 A\n版本 B\n'
  });
  chk(m3.length === 1 && /v9\.8\.8/.test(m3[0]), '变异 3：多版本里只缺一个 → 精确指出是哪一版');

  return { pass, fail };
}

console.log('\n── 自证（改坏一处必须翻红）');
const m = runMutations();
console.log('\n通过=' + m.pass + ' 失败=' + (m.fail + problems.length));
process.exit(problems.length || m.fail ? 1 : 0);
