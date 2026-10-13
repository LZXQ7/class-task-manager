#!/bin/bash
# common/guard.js 改动后全 12 函数重部署（iron rule：sync 后必须全量重部署）
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
cd "C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy"
TCBJS="C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb"
ENV="<YOUR_ENV_ID>"
FNS="adjust auth class cron-weekly duty export media member poster schedule audit-receiver"
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
