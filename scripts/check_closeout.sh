#!/usr/bin/env bash
# ============================================================================
# 发版收尾体检（v1.0.5.2 新增；版本口径随发版同步 —— 由下方 REL/MIN 两个变量统一指定）
#   用途：bump 版本 + 写完 CHANGELOG / 更新说明之后、宣布「发版完成」之前跑一遍。
#   覆盖 7 项：D1 版本号口径 / D2 CHANGELOG 节 / D3 更新说明两版 /
#              D4 门禁全绿 / D5 临时文件残留 / D6 备份收口 / D7 遗留自曝
#   ⚠️ 本脚本**只做检查，不改任何文件** —— 体检失败要人自己判断怎么处理，
#      不像 check-*.js 那样去改源码（那会掩盖真问题）。
# 用法：bash scripts/check_closeout.sh
#
# 🔧 bump 版本时**只需改下面两行**（2026-10-14 起从散落硬编码改为集中声明）：
#   REL = 对外版本号（config.js 的 APP_VERSION，outputs 里的更新说明文件名也用它）
#   MIN = 内部迭代号（CHANGELOG 的 ## 小节标题）
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"

REL="1.0.7.1"
MIN="v0.7.45"
NOTE="outputs/v${REL}-更新说明.md"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
chk()  { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo ""
echo "── D1 版本号口径 ──────────────────────────────────────"
# ⚠️ 本机 Git Bash 会把 sed/cut 里的单引号先吃掉。取版本号直接交给 node 读文件。
APP_VER=$(node -e "const f=require('fs').readFileSync('miniprogram/utils/config.js','utf8');const m=f.match(/APP_VERSION\s*=\s*'([^']+)'/);process.stdout.write(m?m[1]:'')")
echo "  APP_VERSION = $APP_VER"
if [ "$APP_VER" = "$REL" ]; then ok "APP_VERSION 是 $REL"; else bad "APP_VERSION 不是 $REL（实际读到 '$APP_VER'）"; fi
chk "CHANGELOG 有 $MIN 节"               "grep -q '^## $MIN' CHANGELOG.md"
chk "CHANGELOG 该节声明对外 $REL"        "sed -n \"/^## $MIN/,/^## /p\" CHANGELOG.md | grep -q '$REL'"
chk "更新说明文件已产出"                 "[ -f \"\$NOTE\" ]"
chk "更新说明含版本 A 提审版"            "grep -q '版本 A' \"\$NOTE\""
chk "更新说明含版本 B 公告版"            "grep -q '版本 B' \"\$NOTE\""

echo ""
echo "── D2 公告版可复制性 ──────────────────────────────────"
# 公告正文必须是纯文本：带 ** 或 # 的行会被原样显示成符号（用户此前踩过）
ANN=$(sed -n '/^【班级任务管理/,/^---/p' "$NOTE" | head -40)
if echo "$ANN" | grep -q '```\|\*\*\|^#'; then
  bad "公告正文含 Markdown 符号（会原样显示）"
else
  ok "公告正文为纯文本（无 Markdown 符号）"
fi
chk "公告条目数在 3~30 条之间" 'n=$(echo "$ANN" | grep -c "^[^-]"); [ "$n" -ge 3 ] && [ "$n" -le 30 ]'

echo ""
echo "── D3 更新说明非空洞（防空发布）───────────────"
# 1.0.6.3 含 4 条（1 条整改 + 3 条热修）；此处验「版本 A 至少含 2 条修复」
VER_A=$(sed -n '/^## 版本 A/,/^## 版本 B/p' "$NOTE")
n=$(echo "$VER_A" | grep -c '^[0-9]')
if [ "$n" -ge 2 ]; then ok "版本 A 至少含 $n 条修复"; else bad "版本 A 条目不足（$n 条）"; fi

echo ""
echo "── D4 门禁全绿 ────────────────────────────────────────"
# ⚠️ 本机 Git Bash 的 /tmp 不可写（safe-delete / 权限），临时文件必须落在工作区内
GATE_OUT=".workbuddy/tmp-closeout-gates.txt"
if bash scripts/run_all_gates_bounded.sh > "$GATE_OUT" 2>&1 && grep -q "失败=0" "$GATE_OUT"; then
  ok "全量门禁 失败=0"
  grep "通过=" "$GATE_OUT"
else
  bad "全量门禁有失败项 —— 见下"
  tail -8 "$GATE_OUT"
fi
rm -f "$GATE_OUT"

echo ""
echo "── D5 临时文件残留 ────────────────────────────────────"
LEFT=$(ls tmp_*.js tmp_mut_* 2>/dev/null | head -5)
if [ -z "$LEFT" ]; then ok "无 tmp_* / tmp_mut_* 残留"; else bad "有临时文件残留：$LEFT"; fi

echo ""
echo "── D6 备份收口 ────────────────────────────────────────"
chk "备份目录存在且有 20 份以上" '[ "$(ls -d .workbuddy/backups/*/ 2>/dev/null | wc -l)" -ge 20 ]'
if [ -f .workbuddy/memory/$(date +%Y-%m-%d).md ]; then
  ok "今日记忆日志已存在"
else
  bad "今日记忆日志缺失（.workbuddy/memory/$(date +%Y-%m-%d).md）"
fi

echo ""
echo "── D7 遗留自曝 ────────────────────────────────────────"
# 深色模式当前是关闭状态，CHANGELOG 必须写明，否则有人会以为漏发
chk "CHANGELOG 已自曝深色模式处于关闭状态" "sed -n \"/^## $MIN/,/^## /p\" CHANGELOG.md | grep -q \"DARK_MODE_ENABLED\""
# ⚠️ 1.0.6.3 起本项改了口径：那一版**确实要重部署 auth**（不是「无需重部署」），
#    所以自曝项换成「审核体验入口这个后门必须有关闭手段」——不留关闭脚本等于埋雷。
chk "更新说明已给出审核体验入口的关闭方式"   'grep -q "review_demo_on = 0" "$NOTE"'
chk "更新说明已给出提审要填的审核备注"       'grep -q "审核备注" "$NOTE"'
echo ""
echo "=================================================="
echo " 收尾体检 通过=$PASS 失败=$FAIL"
if [ "$FAIL" -eq 0 ]; then echo " ✅ 可宣布发版完成"; else echo " ❌ 有未通过项，先处理"; fi
echo "=================================================="
exit "$FAIL"
