#!/usr/bin/env node
/**
 * 改动前备份 / 回滚
 * ------------------------------------------------------------
 * 起因（2026-09-25）：本项目**不是 git 仓库**，改坏了只能靠人肉回忆。
 * 真出过事故：给「发布通知」加样式时把新样式插到了 `pages/home/index.wxss`
 * **文件开头**而不是末尾，整段页面骨架（.wrap / .hero* / .mt16 / .nav-*）
 * 被顶掉 —— 编译不报错、整页静默变样，最后只能照着设计文档 + 旧截图反推还原。
 *
 * 纪律：**每次动手改代码之前，先跑一次 `node scripts/backup.js <本次要做什么>`。**
 * 备份是整目录快照，体积很小（排除 node_modules 后约 2.3MB / 336 文件），
 * 一份成本可忽略，默认保留最近 30 份。
 *
 * 用法：
 *   node scripts/backup.js                            # 建一份备份（无标签）
 *   node scripts/backup.js 修首页hero样式              # 建一份带标签的备份（推荐）
 *   node scripts/backup.js --list                     # 列出全部备份
 *   node scripts/backup.js --diff                     # 对比「最近一份备份 vs 当前工作区」
 *   node scripts/backup.js --diff <id>                # 同上，指定基准备份
 *   node scripts/backup.js --diff <idA> <idB>         # 对比两份备份
 *   node scripts/backup.js --restore <id>             # 回滚（默认只覆盖，不删多余文件）
 *   node scripts/backup.js --restore <id> --prune     # 回滚并删除备份里没有的文件
 *
 * 回滚是**可逆的**：restore 会先把「当前状态」另存一份 `<时间>-restore-before`，
 * 所以回滚本身也能再回滚回去。
 *
 * 选项：
 *   --keep=N    保留最近 N 份（默认 30）
 *   --note=xxx  给备份写一句备注（等同位置参数，二者可同时用）
 *   --quiet     只打印结果行
 *
 * 备份位置：`.workbuddy/backups/<YYYYMMDD-HHmmss>[-<标签>]/`
 * 备份内容：miniprogram/ cloudfunctions/（排除 node_modules）scripts/ docs/ preview/
 *          .workbuddy/memory/ project.config.json schedule_solver.py
 * 明确不备份：node_modules、__pycache__、_verify（线上包 diff 临时目录）、
 *            根目录截图与一次性产物（c1~c4.png / p2check.png / schedule_report.html /
 *            schedule_result.json）、以及 .workbuddy/backups 自身（防递归）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_ROOT = path.join(ROOT, '.workbuddy', 'backups');
const MANIFEST = '_manifest.json';

/* 备份白名单：目录 + 单文件 */
const DIRS = ['miniprogram', 'cloudfunctions', 'scripts', 'docs', 'preview', '.workbuddy/memory'];
/* 根目录单文件。注意：非 git 仓库下备份是唯一退路，
   所以发版必改的 CHANGELOG 两份也必须进来（此前漏收，改了没有任何快照）；
   HANDOFF.md（跨 session 交接件）同理 —— 它是「继续」的唯一准星，
   漏收的后果是 `--restore` 之后接手方拿不到主线状态（v0.7.21 补收）。 */
const FILES = ['project.config.json', 'schedule_solver.py', 'CHANGELOG.md', 'CHANGELOG-DETAIL.md', 'HANDOFF.md'];

/* 目录名黑名单（出现在路径任意一层即跳过） */
const SKIP_DIRS = new Set(['node_modules', '__pycache__', '_verify', 'backups', '.git']);

const DEFAULT_KEEP = 30;

/* ---------------------------------------------------------------- */
/* 工具                                                              */
/* ---------------------------------------------------------------- */

const pad = (n, w) => String(n).padStart(w || 2, '0');

function stamp(d) {
  const t = d || new Date();
  return (
    t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate()) +
    '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds())
  );
}

function human(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  return (bytes / 1024 / 1024).toFixed(2) + 'M';
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

/* 收集一个目录下所有文件（相对 ROOT 的路径），跳过黑名单目录 */
function walk(absDir, out) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(rel(p));
    }
  }
  return out;
}

function collectSourceFiles() {
  const out = [];
  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    walk(abs, out);
  }
  for (const f of FILES) {
    if (fs.existsSync(path.join(ROOT, f))) out.push(f);
  }
  out.sort();
  return out;
}

function isSkipped(relPath) {
  return relPath.split('/').some((seg) => SKIP_DIRS.has(seg));
}

/* ---------------------------------------------------------------- */
/* 备份                                                              */
/* ---------------------------------------------------------------- */

function listBackups() {
  if (!fs.existsSync(BACKUP_ROOT)) return [];
  return fs
    .readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((id) => {
      const dir = path.join(BACKUP_ROOT, id);
      const mf = path.join(dir, MANIFEST);
      let meta = null;
      if (fs.existsSync(mf)) {
        try {
          meta = JSON.parse(fs.readFileSync(mf, 'utf8'));
        } catch (e) {
          meta = null;
        }
      }
      let bytes = 0;
      if (meta) bytes = meta.totalBytes;
      return {
        id,
        dir,
        tag: meta ? meta.tag || '' : '',
        note: meta ? meta.note || '' : '',
        createdAt: meta ? meta.createdAt : '',
        fileCount: meta ? meta.fileCount : 0,
        totalBytes: bytes,
        broken: !meta,
      };
    });
}

function snapshot(tag, note) {
  const now = new Date();
  const base = stamp(now);
  let id = base;
  if (tag) {
    const safe = String(tag).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (safe) id = base + '-' + safe;
  }
  const dest = path.join(BACKUP_ROOT, id);

  const files = collectSourceFiles();
  const map = {};
  let total = 0;

  for (const r of files) {
    const src = path.join(ROOT, r);
    const dst = path.join(dest, r);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
    map[r] = { size: st.size, md5: md5(src) };
    total += st.size;
  }

  const manifest = {
    id,
    tag: tag || '',
    note: note || '',
    createdAt: now.toISOString(),
    createdAtLocal:
      now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
      ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds()),
    roots: DIRS.concat(FILES),
    fileCount: files.length,
    totalBytes: total,
    files: map,
  };
  fs.writeFileSync(path.join(dest, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return { manifest, dest };
}

/* 保留最近 keep 份，删除更早的 */
function prune(keep) {
  const all = listBackups();
  if (all.length <= keep) return [];
  const removed = all.slice(0, all.length - keep);
  for (const b of removed) {
    fs.rmSync(b.dir, { recursive: true, force: true });
  }
  return removed.map((b) => b.id);
}

/* ---------------------------------------------------------------- */
/* 对比                                                              */
/* ---------------------------------------------------------------- */

function readManifestOf(id) {
  const mf = path.join(BACKUP_ROOT, id, MANIFEST);
  if (!fs.existsSync(mf)) return null;
  try {
    return JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch (e) {
    return null;
  }
}

function diffManifests(a, b, labelA, labelB) {
  const fa = a.files || {};
  const fb = b.files || {};
  const added = [];
  const removed = [];
  const changed = [];
  for (const k of Object.keys(fb)) {
    if (!fa[k]) added.push(k);
    else if (fa[k].md5 !== fb[k].md5) changed.push(k);
  }
  for (const k of Object.keys(fa)) {
    if (!fb[k]) removed.push(k);
  }
  added.sort(); removed.sort(); changed.sort();

  console.log('');
  console.log('  基准  ' + labelA + '  (' + Object.keys(fa).length + ' 文件)');
  console.log('  对比  ' + labelB + '  (' + Object.keys(fb).length + ' 文件)');
  console.log('');
  if (!added.length && !removed.length && !changed.length) {
    console.log('  ✅ 完全一致，没有差异');
    return { added, removed, changed };
  }
  const show = (title, arr) => {
    if (!arr.length) return;
    console.log('  ' + title + '  (' + arr.length + ')');
    arr.forEach((f) => console.log('    ' + f));
    console.log('');
  };
  show('修改 M', changed);
  show('新增 A', added);
  show('删除 D', removed);
  console.log('  合计：修改 ' + changed.length + ' / 新增 ' + added.length + ' / 删除 ' + removed.length);
  return { added, removed, changed };
}

function diffCurrent(id) {
  const a = readManifestOf(id);
  if (!a) {
    console.log('❌ 找不到备份 ' + id + ' 的清单（--list 看看有哪些）');
    process.exit(1);
  }
  const now = { files: {} };
  for (const r of collectSourceFiles()) {
    now.files[r] = { md5: md5(path.join(ROOT, r)) };
  }
  diffManifests(a, now, id, '当前工作区');
}

function diffTwo(idA, idB) {
  const a = readManifestOf(idA);
  const b = readManifestOf(idB);
  if (!a || !b) {
    console.log('❌ 备份清单缺失：' + (!a ? idA : idB));
    process.exit(1);
  }
  diffManifests(a, b, idA, idB);
}

/* ---------------------------------------------------------------- */
/* 回滚                                                              */
/* ---------------------------------------------------------------- */

function restore(id, doPrune) {
  const src = path.join(BACKUP_ROOT, id);
  const mf = readManifestOf(id);
  if (!mf) {
    console.log('❌ 找不到备份 ' + id + '（--list 看看有哪些）');
    process.exit(1);
  }

  /* 回滚前先把当前状态存一份，保证回滚本身可逆 */
  const pre = snapshot('restore-before', '回滚到 ' + id + ' 之前的现场状态');
  console.log('  已存当前现场 → ' + rel(pre.dest));

  let copied = 0;
  const restored = [];
  for (const r of Object.keys(mf.files)) {
    const s = path.join(src, r);
    const d = path.join(ROOT, r);
    if (!fs.existsSync(s)) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    copied += 1;
    restored.push(r);
  }

  /* 备份里没有、本地却存在的文件（只报告；--prune 才删） */
  const extras = collectSourceFiles().filter((r) => !mf.files[r] && !isSkipped(r));
  let removed = 0;
  if (doPrune && extras.length) {
    for (const r of extras) {
      const p = path.join(ROOT, r);
      try {
        fs.rmSync(p, { force: true });
        removed += 1;
      } catch (e) {
        console.log('  ⚠️ 删不掉（先关掉开发者工具？）：' + r);
      }
    }
  }

  console.log('');
  console.log('  ✅ 已回滚 ' + copied + ' 个文件 ← ' + id + (mf.tag ? ' (' + mf.tag + ')' : ''));
  if (extras.length) {
    if (doPrune) {
      console.log('  🗑  删除备份里没有的文件 ' + removed + ' / ' + extras.length + ' 个');
    } else {
      console.log('  ⚠️ 有 ' + extras.length + ' 个文件「备份里没有、本地存在」（未删，如需清理加 --prune）：');
      extras.slice(0, 30).forEach((f) => console.log('      ' + f));
      if (extras.length > 30) console.log('      … 还有 ' + (extras.length - 30) + ' 个');
    }
  }
  console.log('');
  console.log('  后悔了可以再回滚这次现场：node scripts/backup.js --restore ' + pre.manifest.id);
}

/* ---------------------------------------------------------------- */
/* 入口                                                              */
/* ---------------------------------------------------------------- */

function main() {
  const argv = process.argv.slice(2);
  const flags = argv.filter((a) => a.startsWith('--'));
  const pos = argv.filter((a) => !a.startsWith('--'));

  const getFlag = (name) => flags.find((f) => f === '--' + name) || flags.find((f) => f.startsWith('--' + name + '='));
  const flagVal = (name) => {
    const f = getFlag(name);
    if (!f) return null;
    const i = f.indexOf('=');
    return i < 0 ? true : f.slice(i + 1);
  };
  const quiet = !!getFlag('quiet');
  const log = (m) => { if (!quiet) console.log(m); };

  let keep = DEFAULT_KEEP;
  const kv = flagVal('keep');
  if (typeof kv === 'string' && /^\d+$/.test(kv)) keep = parseInt(kv, 10);

  /* ---- --list ---- */
  if (getFlag('list')) {
    const all = listBackups();
    if (!all.length) {
      console.log('（还没有任何备份）');
      return;
    }
    console.log('共 ' + all.length + ' 份备份 @ ' + rel(BACKUP_ROOT));
    console.log('');
    console.log('  ' + 'ID'.padEnd(44) + '文件数'.padStart(7) + '  体积'.padStart(8) + '  说明');
    console.log('  ' + '-'.repeat(90));
    all.slice().reverse().forEach((b) => {
      const desc = [b.tag, b.note].filter(Boolean).join(' · ') || (b.broken ? '(清单损坏)' : '');
      console.log(
        '  ' + b.id.padEnd(44) +
        String(b.fileCount || '-').padStart(7) +
        ('  ' + (b.totalBytes ? human(b.totalBytes) : '-')).padStart(8) +
        '  ' + desc
      );
    });
    console.log('');
    console.log('  回滚：node scripts/backup.js --restore <ID>');
    return;
  }

  /* ---- --diff ---- */
  if (getFlag('diff')) {
    if (pos.length >= 2) diffTwo(pos[0], pos[1]);
    else {
      const base = pos[0] || (listBackups().slice(-1)[0] || {}).id;
      if (!base) {
        console.log('（还没有备份，先跑 node scripts/backup.js）');
        return;
      }
      diffCurrent(base);
    }
    return;
  }

  /* ---- --restore ---- */
  if (getFlag('restore')) {
    const id = flagVal('restore');
    const target = typeof id === 'string' ? id : pos[0];
    if (!target) {
      console.log('❌ 用法：node scripts/backup.js --restore <ID>   （--list 看 ID）');
      process.exit(1);
    }
    log('回滚 ← ' + target + '   （会先把当前现场另存一份）');
    restore(target, !!getFlag('prune'));
    return;
  }

  /* ---- 默认：建备份 ---- */
  /* 第 1 个位置参数 = 标签；其余位置参数拼成备注（也可以直接用 --note=） */
  const tag = pos[0] || '';
  const noteFlag = flagVal('note');
  const note = (typeof noteFlag === 'string' ? noteFlag : '') || pos.slice(1).join(' ');
  log('备份源文件 → ' + rel(BACKUP_ROOT));

  const { manifest, dest } = snapshot(tag, note);
  log('');
  log('  ✅ ' + manifest.fileCount + ' 个文件 / ' + human(manifest.totalBytes) + '  →  ' + rel(dest));
  if (manifest.tag) log('     标签：' + manifest.tag);
  if (manifest.note) log('     备注：' + manifest.note);

  const dropped = prune(keep);
  if (dropped.length) {
    log('');
    log('  🗑  超出保留上限（' + keep + ' 份），已清理最早 ' + dropped.length + ' 份：' + dropped.join(', '));
  }
  const all = listBackups();
  log('     现有 ' + all.length + ' 份备份');

  /* 结果行放最后，便于管道/肉眼抓取 */
  console.log('BACKUP_ID=' + manifest.id);
  console.log('回滚：node scripts/backup.js --restore ' + manifest.id);
  console.log('看改了啥：node scripts/backup.js --diff ' + manifest.id);
}

main();
