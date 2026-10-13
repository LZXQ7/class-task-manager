#!/bin/bash
# 全量门禁 runner（2026-10-06）
# ⚠️ 为什么需要它：Windows 上**连续快速** spawn 大量 node 进程会让个别门禁
#    偶发非 0 退出（同一份代码单跑必绿），实测 check-component-paths /
#    check-timetable-import / check-wxss 三个最易中招 ⇒ 误报会让人以为改坏了。
#    做法：每个门禁**最多重试 3 次**（间隔 1s），全绿才算过；仍红才输出详情。
# 用法：bash scripts/run_all_gates.sh
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
cd "$(dirname "$0")/.." || exit 1

pass=0; fail=0; failed=""
for f in scripts/check-*.js; do
  name=$(basename "$f")
  ok=0
  for try in 1 2 3; do
    if node "$f" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed="$failed $name"
    echo "[FAIL] $name"
  fi
done
echo "=============================="
echo "门禁 通过=$pass 失败=$fail"
if [ -n "$failed" ]; then
  echo "失败项:$failed"
  exit 1
fi
echo "全绿"
