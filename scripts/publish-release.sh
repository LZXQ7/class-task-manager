#!/usr/bin/env bash
# ============================================================================
# scripts/publish-release.sh —— 双仓库一键发版（私有完整 + 公开脱敏）
#
# 当用户说「要上传更新版本了」，跑本脚本即可同时更新两个 GitHub 仓库：
#   ① 私有  class-task-manager-template  —— 完整真实数据，commit + tag + push
#   ② 公开  class-task-manager           —— 从私有导出 → 全量脱敏 → 自检 → push
#
# 用法：
#   GH_PAT=ghp_xxx  ./scripts/publish-release.sh  v1.0.6.6  "版本说明"
#   （GH_PAT 可选：不设则按 tokenless remote 推送，需本机已配凭据；本机未装 GCM，
#     通常需临时 export GH_PAT=旧令牌 再跑。令牌永不进本脚本 / 不进任何仓库。）
#
# 环境变量（均可选，用来覆盖默认路径）：
#   PUBLIC_REPO_DIR  公开仓库本地目录（默认 C:/Users/PC/WorkBuddy/class-task-manager-public）
#   SCRUB_JS         脱敏脚本路径（默认 C:/Users/PC/WorkBuddy/_scrub_tmp/scrub.js）
#   XLSX 风险：scripts/fixtures/*.xlsx 含真实课表/名单（学号+姓名+教师），
#     脱敏脚本只扫文本不扫二进制，故导出时通过负 pathspec 直接排除，绝不进公开仓库。
# ============================================================================
set -euo pipefail

VERSION="${1:-}"
NOTE="${2:-发版 $VERSION}"
if [ -z "$VERSION" ]; then
  echo "用法: $0 <版本号 vX.Y.Z> [版本说明]" >&2
  exit 1
fi

PRIVATE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC_DIR="${PUBLIC_REPO_DIR:-C:/Users/PC/WorkBuddy/class-task-manager-public}"
SCRUB_JS="${SCRUB_JS:-C:/Users/PC/WorkBuddy/_scrub_tmp/scrub.js}"
PRIV_REPO="class-task-manager-template"
PUB_REPO="class-task-manager"
# 导出到公开仓时的排除项（负 pathspec）：只留在私有仓、不进开源仓
PUBLIC_EXCLUDE=(
  ":!scripts/fixtures/*.xlsx"   # 真实 PII 夹具（学号+姓名+教师），脱敏脚本不扫二进制
  ":!HANDOFF.md"                # 内部状态交接件（含运营细节）
  ":!CHANGELOG-DETAIL.md"       # 内部详细改动史（含未公开排查过程）
  ":!outputs"                   # 内部产出目录（设计稿/诊断报告/参赛与提交材料）
)

# 临时注入 / 去除 remote 令牌（仅本进程内生效，不落盘）
set_remote() {   # $1=dir $2=repo $3=token
  local tok="${3:-}"
  if [ -n "$tok" ]; then
    git -C "$1" remote set-url origin "https://${tok}@github.com/LZXQ7/${2}.git"
  else
    git -C "$1" remote set-url origin "https://github.com/LZXQ7/${2}.git"
  fi
}

echo "==> [1/6] 私有仓库：提交 + 打 tag $VERSION + 推送"
cd "$PRIVATE_DIR"
# ⚠️ 2026-11-14：同一工作区常有并行会话留下的未提交文件，`git add -A` 会把它们
#    混进发版 commit（曾误带 nav-bar 胶囊适配的 6 个文件）。若调用方已自行精确
#    add/commit/push 本轮文件，用 PRIVATE_ADD_MODE=none 跳过 add -A，只打 tag + push；
#    公开仓导出走 `git archive HEAD`，同样不会带上工作区里那些文件。
if [ "${PRIVATE_ADD_MODE:-all}" = "none" ]; then
  echo "    (PRIVATE_ADD_MODE=none：跳过 git add -A，调用方已精确提交)"
else
  git add -A
fi
# 判断「有没有要提交的东西」看**暂存区**，不能看工作区状态：
# none 模式下工作区仍可能有别人的改动，但它们不该进发版 commit。
if [ -n "$(git diff --cached --name-only)" ]; then
  git commit -q -m "$NOTE"
  echo "    已提交"
else
  echo "    (私有仓库暂存区无改动，跳过 commit)"
fi
if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "    (tag $VERSION 已存在，跳过)"
else
  git tag -a "$VERSION" -m "$NOTE"
  echo "    已打 tag $VERSION"
fi
set_remote "$PRIVATE_DIR" "$PRIV_REPO" "${GH_PAT:-}"
git push origin main --tags
set_remote "$PRIVATE_DIR" "$PRIV_REPO" ""
echo "    ✓ 私有仓库已推送"

echo "==> [2/6] 从私有 HEAD 导出受跟踪树 → 公开目录（排除 .xlsx PII 夹具）"
# 确保公开目录是 git 仓库；清空其工作树（保留 .git），再解包导出树
if [ ! -d "$PUBLIC_DIR" ]; then mkdir -p "$PUBLIC_DIR"; fi
cd "$PUBLIC_DIR"
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git init -b main
fi
git rm -r --cached -q . 2>/dev/null || true
git clean -fd -q   # 移除未跟踪（保留 node_modules/outputs 等被忽略目录；git clean 不碰 .git）
git -C "$PRIVATE_DIR" archive --format=tar HEAD -- "${PUBLIC_EXCLUDE[@]}" | tar -x -C "$PUBLIC_DIR"
echo "    已导出 $(find "$PUBLIC_DIR" -type f -not -path '*/.git/*' | wc -l) 个文件（已排除 PII 夹具与内部文件）"

echo "==> [3/6] 全量脱敏（scrub.js 不在任何仓库内，含原始词搜索串，严禁进库）"
if [ ! -f "$SCRUB_JS" ]; then
  echo "❌ 缺少脱敏脚本：$SCRUB_JS" >&2
  exit 1
fi
node "$SCRUB_JS" "$PUBLIC_DIR"
echo "    脱敏完成"

echo "==> [4/6] 自检：公开树不得含原始 PII / .xlsx（不通过则中止推送）"
# 4a 任何二进制表格
if git -C "$PUBLIC_DIR" ls-files | grep -iqE '\.(xlsx|xls)$'; then
  echo "❌ 公开树仍含 .xlsx/.xls（PII 风险），已中止" >&2
  exit 1
fi
# 4b 原始令牌 / AppID / 姓名 / 学号 / 班级名 / 教师名 / ICP / 品牌
if grep -rI -n -E \
  "<YOUR_ENV_ID>|<YOUR_APPID>|<TENCENT_DOCS_APPID>|0000000000|0000000003|0000000002|0000000001|00000000|209903030101|209903020101|示例成员57|示例成员01|<INVITE_CODE>|<INVITE_CODE>|<INVITE_CODE>|admin|班级任务管理|<ICP_NO>|示例老师01|示例老师02|示例老师04|示例老师05|示例老师07|示例老师08|示例老师09|示例老师10|示例老师11|示例老师12|示例老师06|示例老师03|示例专业|示例专业简称|示例班级A|示例班级B|示例班级C" \
  "$PUBLIC_DIR" --exclude-dir=.git >/dev/null 2>&1; then
  echo "❌ 公开树命中原始 PII 词，已中止（请检查 scrub.js 规则是否覆盖新增 PII）" >&2
  exit 1
fi
# 4b-2 形状兜底：任何残留的微信 AppID 一律拦截（防止以后新增 AppID 漏进脱敏词表）。
#       ⚠️ 本行必须留在 .sh 文件里执行：把 {16} 直接塞进交互式命令行会被转义层吃掉，
#          正则静默退化成假阴性（2026-11-14 实测）。占位符 <YOUR_APPID> 不含 wx+16 位，不误报。
if grep -rI -n -E 'wx[0-9a-f]{16}' "$PUBLIC_DIR" --exclude-dir=.git >/dev/null 2>&1; then
  echo "❌ 公开树仍含微信 AppID 形状的原始值，已中止（检查 scrub.js 的 SIMPLE 规则）" >&2
  exit 1
fi
# 4c 疑似真实学号（12 位、260 开头；示例/伪化均为 10 位或 8 位，不会命中）
if grep -rI -n -E "\b260[0-9]{9}\b" "$PUBLIC_DIR" --exclude-dir=.git >/dev/null 2>&1; then
  echo "❌ 公开树疑似含真实学号(12 位 260 开头)，已中止" >&2
  exit 1
fi
# 4d 内部文件不得进公开树（防止排除项被误删后静默回灌）
for internal in HANDOFF.md CHANGELOG-DETAIL.md outputs; do
  if git -C "$PUBLIC_DIR" ls-files | grep -qx "$internal" || git -C "$PUBLIC_DIR" ls-files | grep -q "^$internal/"; then
    echo "❌ 公开树含内部文件 $internal（导出排除项失效），已中止" >&2
    exit 1
  fi
done
echo "    ✓ 自检通过（0 命中原始 PII，无 .xlsx，无内部文件）"

echo "==> [5/6] 公开仓库：提交 + 推送"
cd "$PUBLIC_DIR"
git add -A
if [ -n "$(git status --porcelain)" ]; then
  git commit -q -m "$NOTE（开源脱敏模板）"
  echo "    已提交"
else
  echo "    (公开树无变化，跳过 commit)"
fi
set_remote "$PUBLIC_DIR" "$PUB_REPO" "${GH_PAT:-}"
git push origin main
set_remote "$PUBLIC_DIR" "$PUB_REPO" ""
echo "    ✓ 公开仓库已推送"

echo "==> [6/6] 完成 ✅"
echo "私有（完整）： https://github.com/LZXQ7/class-task-manager-template"
echo "公开（脱敏）： https://github.com/LZXQ7/class-task-manager"
echo "提示：公开仓库的脱敏依赖 scrub.js 的静态词表；若未来新增真实姓名/学号/班级，"
echo "      须同步更新 _scrub_tmp/scrub.js 的 REAL_NAMES / SIMPLE / CLASSES / TEACHERS 规则，否则会漏脱敏。"
