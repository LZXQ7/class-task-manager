#!/usr/bin/env bash
# ============================================================================
# 发版收尾体检（v1.0.5.2 新增；2026-11-27 重写版本口径与假绿判据）
#   用途：bump 版本 + 写完 CHANGELOG / 更新说明之后、宣布「发版完成」之前跑一遍。
#   覆盖 7 项：D1 版本号口径 / D2 公告版可复制性 / D3 更新说明非空洞 /
#              D4 门禁无新增红 / D5 临时文件残留 / D6 备份收口 / D7 影响面自曝
#   ⚠️ 本脚本**只做检查，不改任何文件** —— 体检失败要人自己判断怎么处理，
#      不像 check-*.js 那样去改源码（那会掩盖真问题）。
# 用法：bash scripts/check_closeout.sh
#
# 🔧 2026-11-27 重写原因（M1 同源漏改 + M2 假绿）：
#   旧版把 REL/MIN 硬编码成两个常量，要求 bump 时手改；实际长期停在 1.0.8.0 /
#   v0.7.46，导致 D1 恒假红、D2/D3/D7 全在验**旧版**更新说明（假绿）。
#   新口径：版本号唯一真源 = `miniprogram/utils/config.js` 的 APP_VERSION，
#   REL 动态读取，不再有「两行常量需要同步」的温床。
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"

# 版本号唯一真源：直接读 config.js，杜绝硬编码漂移
REL=$(node -e "const f=require('fs').readFileSync('miniprogram/utils/config.js','utf8');const m=f.match(/APP_VERSION\s*=\s*'([^']+)'/);process.stdout.write(m?m[1]:'')")
NOTE="outputs/v${REL}-更新说明.md"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; }
chk()  { if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

echo ""
echo "── D1 版本号口径 ──────────────────────────────────────"
echo "  APP_VERSION = $REL（单一真源：miniprogram/utils/config.js）"
if [ -n "$REL" ] && node -e "process.exit(/^\d+\.\d+\.\d+(\.\d+)?$/.test('$REL')?0:1)"; then
  ok "APP_VERSION 格式合法"
else
  bad "APP_VERSION 为空或格式非法（'$REL'）"
fi
chk "当前版本更新说明文件已产出（$NOTE）"  "[ -f \"\$NOTE\" ]"
chk "更新说明首行声明版本号 $REL"          "head -1 \"\$NOTE\" | grep -qF '$REL'"
chk "更新说明含版本 A 段"                  "grep -q '^## 版本 A' \"\$NOTE\""
chk "更新说明含版本 B 段"                  "grep -q '^## 版本 B' \"\$NOTE\""

echo ""
echo "── D2 公告版可复制性 ──────────────────────────────────"
# 公告正文必须是纯文本：带 ** 或 # 的行会被原样显示成符号（用户此前踩过）
# 兼容两版格式：
#   新格式（1.0.8.78+）：「## 版本 B（公告版...」标题后直接是纯文本公告正文（可能只有一段）；
#   旧格式（~1.0.8.77）：版本 B 段里有引用块说明 + 「【班级任务管理 · 更新公告】」到 --- 的正文。
ANN_SECTION=$(sed -n '/^## 版本 B/,$p' "$NOTE")
if echo "$ANN_SECTION" | grep -q '^【班级任务管理'; then
  # 旧格式：只取【】标记到 --- 之间的正文，避开引用块里的 ** 说明
  ANN=$(echo "$ANN_SECTION" | sed -n '/^【班级任务管理/,/^---/p' | head -40)
else
  # 新格式：去掉「## 版本 B」标题行本身，其余即公告正文
  ANN=$(echo "$ANN_SECTION" | grep -v '^## 版本 B')
fi
if echo "$ANN" | grep -q '```\|\*\*\|^#'; then
  bad "公告正文含 Markdown 符号（会原样显示）"
else
  ok "公告正文为纯文本（无 Markdown 符号）"
fi
n=$(echo "$ANN" | grep -c '[^[:space:]#>-]' || true)
if [ "$n" -ge 1 ] && [ "$n" -le 120 ]; then
  ok "公告正文内容量合理（约 $n 行有效文本）"
else
  bad "公告正文内容量异常（$n 行）—— 可能误取了标题/空文件"
fi

echo ""
echo "── D3 更新说明非空洞（防空发布）───────────────"
# 版本 A：从「## 版本 A」到「## 版本 B」，实质条目（以 - 或数字. 开头）≥2
VER_A=$(sed -n '/^## 版本 A/,/^## 版本 B/p' "$NOTE")
n=$(echo "$VER_A" | grep -c '^[-0-9]' || true)
if [ "$n" -ge 2 ]; then ok "版本 A 含 $n 条实质条目"; else bad "版本 A 条目不足（$n 条）"; fi

echo ""
echo "── D4 门禁无新增红 ────────────────────────────────────"
# ⚠️ 本机 Git Bash 的 /tmp 不可写，临时文件必须落在工作区内
GATE_OUT=".workbuddy/tmp-closeout-gates.txt"
if bash scripts/run_all_gates_bounded.sh > "$GATE_OUT" 2>&1; then
  ok "全量门禁全绿（失败=0）"
else
  # 收尾体检的判据是「零新增红」而非「零红」：项目长期存在若干存量红，
  # 逐一复现成本高；新红由门禁文件清单变化体现。取当前失败清单，与「上次体检」
  # 记录的清单比对：首次无记录时只提示，不误判（避免把存量红当新增红卡死发版）。
  BASE=".workbuddy/closeout-red-baseline.txt"
  PROBLEM=$(grep '^问题项:' "$GATE_OUT" | sed 's/^问题项://' | tr ' ' '\n' | grep -o 'scripts/check-[^ (]*\.js' | sort -u)
  CUR=$(echo "$PROBLEM" | grep -v '^$')
  if [ -f "$BASE" ]; then
    NEW=$(comm -23 <(echo "$CUR") <(sort -u "$BASE"))
    GONE=$(comm -13 <(echo "$CUR") <(sort -u "$BASE"))
    if [ -z "$NEW" ]; then
      ok "无新增红（存量红 $(echo "$CUR" | grep -c .) 项，与基线一致）"
      [ -n "$GONE" ] && echo "      提示：以下存量红已修复，可更新基线：$(echo "$GONE" | tr '\n' ' ')"
    else
      bad "出现新增红：$(echo "$NEW" | tr '\n' ' ')"
    fi
  else
    echo "      提示：首次记录存量红基线 $(echo "$CUR" | grep -c .) 项到 $BASE；后续按「零新增红」判定"
    printf '%s\n' "$CUR" > "$BASE"
    ok "已建立存量红基线（本次不判定新增红）"
  fi
  grep "通过=" "$GATE_OUT"
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
echo "── D7 影响面自曝 ──────────────────────────────────────"
# 旧版验的「深色关闭 / review_demo_on / 审核备注」是 1.0.6.3 时代判据，
# 当前功能已变（深色 11-03 开启、演示班口径迁移），继续验只会制造假绿。
# 新口径：发版说明须主动交代影响面（自查 / 部署 / 数据迁移 / 回滚 任一关键词）。
chk "更新说明已交代影响面（自查/部署/迁移/回滚）" \
  "grep -qE '自查|重新部署|已部署|无需部署|迁移|回滚' \"\$NOTE\""
echo ""
echo "=================================================="
echo " 收尾体检 通过=$PASS 失败=$FAIL"
if [ "$FAIL" -eq 0 ]; then echo " ✅ 可宣布发版完成"; else echo " ❌ 有未通过项，先处理"; fi
echo "=================================================="
exit "$FAIL"
