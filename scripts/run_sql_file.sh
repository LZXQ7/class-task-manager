#!/bin/bash
# 把 .sql 文件按分号逐条灌进 tcb db execute。
# ⚠️ 不能用 node execSync 拼 SQL —— Windows 下双引号/反引号层层转义会把语句改形。
# 用法：bash scripts/run_sql_file.sh scripts/xxx.sql
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
TCBJS="C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb"
ENV="<YOUR_ENV_ID>"
SQLFILE="$1"
[ -z "$SQLFILE" ] && { echo "usage: run_sql_file.sh <file.sql>"; exit 2; }
WORKDIR="C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy/.sqlrun"
# ⚠️ 临时目录必须落工作区：本机 Git Bash 的 /tmp 不可写，mktemp -d 会失败，
#    而 for 循环在目录为空时**静默空跑**并打印假的 [OK]（2026-10-10 实踩）。
mkdir -p "$WORKDIR"
WORK="$(mktemp -d "$WORKDIR/sqlrun.XXXXXX")" || { echo "无法创建临时目录"; exit 2; }
node -e '
const fs=require("fs");
const raw=fs.readFileSync(process.argv[1],"utf8");
const body=raw.split("\n").filter(l=>!/^\s*--/.test(l)).join("\n");
const arr=body.split(";").map(s=>s.trim()).filter(Boolean);
fs.mkdirSync(process.argv[2],{recursive:true});
arr.forEach((s,i)=>fs.writeFileSync(process.argv[2]+"/"+String(i).padStart(2,"0")+".sql",s+";"));
console.log(arr.length);
' "$SQLFILE" "$WORK"
ok=0; bad=0
n=$(ls -1 "$WORK"/*.sql 2>/dev/null | wc -l)
echo "=== 待执行语句 $n 条 ==="
[ "$n" -eq 0 ] && { echo "拆句结果为空，疑似脚本被注释吞掉，中止"; exit 2; }
for f in "$WORK"/*.sql; do
  label=$(head -c 200 "$f" | tr -d '\n' | sed 's/CREATE TABLE IF NOT EXISTS//; s/`//g' | cut -c1-60)
  out=$(node "$TCBJS" db execute -e "$ENV" --sql "$(cat "$f")" 2>&1)
  if echo "$out" | grep -qi "error"; then
    echo "[FAIL] $label"; echo "$out" | head -8; bad=$((bad+1))
  else
    echo "[OK]   $label"; ok=$((ok+1))
  fi
done
echo "=== 成功 $ok 失败 $bad ==="
rm -rf "$WORK"
[ "$bad" -gt 0 ] && exit 1 || exit 0