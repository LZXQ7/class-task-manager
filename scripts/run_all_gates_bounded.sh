#!/bin/bash
# 带 per-gate 超时的门禁批跑（一条命令看总数）
#
# ⚠️ 2026-10-15 重写：原来的 shell `for` 循环在本机会**挂死** —— 现象是 bash 进程还在、
#    却**再也不启动 node**，stdout 停在 0 字节、一个门禁都没跑完（实测 16 分钟零输出，
#    而同样的门禁用 Node 派生的跑法 3 分钟全过）。根因是 Windows 上 shell 连续 spawn
#    80+ 次 node 的稳定性问题，**不是门禁本身慢**（别据此去改门禁）。
#    现在把循环整体交给 `scripts/run-gates-chunk.js`（Node 的 spawnSync 逐个派生），
#    对外保持同样的输出约定与退出码：`check_closeout.sh` 的 D4 与既有文档都不用改。
#
# 单段排查（知道大概在哪一段时比全量快）：
#   node scripts/run-gates-chunk.js 0 30     # 只跑第 1~30 个
#   PER=30 node scripts/run-gates-chunk.js   # 收紧单门禁超时
export PATH="/c/Program Files/Git/usr/bin:/c/Program Files/Git/bin:$PATH"
export USERPROFILE="C:\Users\PC"
cd "C:/Users/PC/WorkBuddy/LZXQ-WorkBuddy" || exit 1

exec node scripts/run-gates-chunk.js "$@"
