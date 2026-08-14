#!/bin/bash
# ──────────────────────────────────────────────────────────────
# 虫洞 Solver 后台运行脚本
#
# 用法:
#   1. 连上靶场 VPN
#   2. 打开 CMD 或 Git Bash
#   3. cd <本仓库根目录>
#   4. bash solve.sh <TOKEN> <题目代码>
#
# 示例:
#   bash solve.sh <your-token> a-05
#   bash solve.sh <your-token> all       # 跑所有题
#
# 日志写到 solver_runs/solve-<题目>-<时间>.log
# ──────────────────────────────────────────────────────────────

set -e

# ── 参数 ──
TOKEN="${1:?用法: bash solve.sh <TOKEN> <题目代码|all> [BASE_URL]}"
CHALLENGE="${2:?请指定题目代码 (如 a-05) 或 all}"
BASE_URL="${3:-https://tsecbench.zc.tencent.com}"

cd "$(dirname "$0")"

# ── 日志文件 ──
mkdir -p solver_runs
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
if [ "$CHALLENGE" = "all" ]; then
    LOGFILE="solver_runs/solve-all-${TIMESTAMP}.log"
else
    LOGFILE="solver_runs/solve-${CHALLENGE}-${TIMESTAMP}.log"
fi

echo "══════════════════════════════════════════════════"
echo "  虫洞 Solver"
echo "  题目: $CHALLENGE"
echo "  日志: $LOGFILE"
echo "  开始: $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════"

# ── 构建命令 ──
COMMON_ARGS=(
    --base-url "$BASE_URL"
    --token "$TOKEN"
    --task-timeout 600
    --bootstrap-timeout 180
    --max-rounds 20
    --per-challenge-budget 2400
    --max-parallel-explores 3
    -v
)

if [ "$CHALLENGE" = "all" ]; then
    CMD=(.venv/Scripts/python.exe -m wormhole.solver.cli_solve "${COMMON_ARGS[@]}")
else
    CMD=(.venv/Scripts/python.exe -m wormhole.solver.cli_solve "${COMMON_ARGS[@]}" --only "$CHALLENGE")
fi

# ── 运行(tee 同时输出到终端和文件) ──
"${CMD[@]}" 2>&1 | tee "$LOGFILE"
EXIT_CODE=$?

echo ""
echo "══════════════════════════════════════════════════"
echo "  结束: $(date '+%Y-%m-%d %H:%M:%S')  退出码: $EXIT_CODE"
echo "  日志: $LOGFILE"
echo "══════════════════════════════════════════════════"
