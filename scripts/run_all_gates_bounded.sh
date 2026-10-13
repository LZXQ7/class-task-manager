#!/bin/bash
# 带 per-gate 超时的门禁批跑（定位「哪个门禁卡死」用）
# 为什么要它：scripts/run_all_gates.sh 的 `node "$f"` **没有 timeout**，
# 一旦某个门禁卡死（等网络 / 等 DB / 等子进程），整轮 runner 会**无限等待**
# ⇒ 表现为整条命令被 SIGTERM、且日志停在 0 字节（stdout 缓冲没 flush）。
# 这里给每个门禁套 `timeout 60`，卡死的记为 TIMEOUT 并继续往下跑。
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
cd "C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy" || exit 1

PER="${PER:-60}"
pass=0; fail=0; slow=""
for f in scripts/check-*.js; do
  name=$(basename "$f")
  ok=0
  for try in 1 2 3; do
    if timeout "$PER" node "$f" >/dev/null 2>&1; then ok=1; break; fi
  done
  if [ "$ok" = "1" ]; then
    pass=$((pass+1))
  else
    # 判一次到底是「红」还是「卡死」：单跑计时
    t0=$(date +%s)
    timeout "$PER" node "$f" >/dev/null 2>&1
    rc=$?
    t1=$(date +%s)
    if [ "$rc" = "124" ]; then
      fail=$((fail+1)); slow="$slow $name(卡死>${PER}s)"
      echo "[卡死] $name"
    else
      dt=$((t1-t0))
      fail=$((fail+1)); slow="$slow $name(红,${dt}s)"
      echo "[红] $name (${dt}s)"
    fi
  fi
done
echo "=============================="
echo "门禁 通过=$pass 失败=$fail"
[ -n "$slow" ] && echo "问题项:$slow"
[ "$fail" -eq 0 ] && echo "全绿"
exit "$fail"