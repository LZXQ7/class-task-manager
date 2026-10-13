#!/usr/bin/env bash
# 网页管理后台（admin-web）端到端验证
# ============================================================
# 为什么不并进 run_all_gates.sh 的 check-* 循环：
#   ① 那个循环是「3 次重试仍红才报错」，为的是抗偶发非 0；
#      而 e2e 靠 Playwright + 本机 Chromium，**跑不起来就是真红**（路径/依赖问题），
#      重试 3 次只是浪费时间并掩盖「环境没配好」这个真实原因。
#   ② e2e 要起 HTTP 服务、开无头浏览器，单次 ~20s，混进快速门禁会拖慢日常。
#
# 用法：bash scripts/run_admin_web_e2e.sh
# 依赖：本机存在 playwright-core 与 chrome-headless-shell（路径见 verify-admin-web.js 顶部）
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
cd "$(dirname "$0")/.." || exit 1

node --check scripts/verify-admin-web.js || exit 1
node scripts/verify-admin-web.js
rc=$?
if [ "$rc" != "0" ]; then
  echo "[FAIL] verify-admin-web（e2e）"
  exit 1
fi
echo "e2e 全绿"
