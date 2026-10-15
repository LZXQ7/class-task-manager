#!/bin/bash
# common/* 改动后重部署（iron rule：sync 后必须全量重部署）
#
# ⚠️ 本脚本只覆盖 **12 个「无特殊配置」** 的函数。
#    另有 2 个函数带 common 副本但**不能**走这里（2026-10-15 注明，别顺手加进来）：
#      · admin-web —— 需要 VPC + 环境变量，走 `node scripts/deploy-admin-web.js`
#      · fee       —— 需要 VPC + 5 个 DB_* 环境变量，走 `node scripts/deploy-fee.js`
#    这两个若用下面的 `functions:deploy --dir .` 部署，会因 cloudbaserc.json 里没有对应条目
#    而**丢掉 VPC 与环境变量**（连不上库 / 拿不到配置），属真实故障方向。
#    核对清单：`ls -1d cloudfunctions/*/common | wc -l` 应为 14 = 本脚本 12 + 上面 2。
#    ⚠️ 12 = adjust auth class course cron-weekly duty export media member poster schedule audit-receiver（course 不能漏，否则选修课 action 永远上不了线）。
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
cd "C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy"
TCBJS="C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb"
ENV="<YOUR_ENV_ID>"
FNS="adjust auth class course cron-weekly duty export media member poster schedule audit-receiver"
ok=0; bad=""
for fn in $FNS; do
  cd "C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/cloudfunctions/$fn" || { bad="$bad $fn(cd)"; continue; }
  out=$(printf 'y\n\n\n\n' | node "$TCBJS" functions:deploy "$fn" -e "$ENV" --dir . --deployMode zip 2>&1)
  if echo "$out" | grep -q "deployed successfully"; then
    ok=$((ok+1)); echo "[OK] $fn"
  else
    bad="$bad $fn"; echo "[FAIL] $fn"; echo "$out" | tail -5
  fi
done
echo "=== 部署成功=$ok  失败=$bad ==="
