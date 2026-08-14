#!/bin/bash
# ──────────────────────────────────────────────────────────────
# 虫洞 Wormhole — 托管模式入口脚本
#
# 平台拉起这个容器后会自动注入：
#   BENCHMARK_TOKEN     — 答题 API 认证
#   BENCHMARK_BASE_URL  — 答题 API 地址
#   ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL — LLM 配置
#
# 本脚本职责：
#   1. 应用大模型网关转换（https → http + .tsecbench.gw 后缀）
#   2. 切到 LocalWorker 后端（容器内直接跑 claude，不用嵌套 docker）
#   3. 启动 solver，跑完所有题目后容器自动退出
# ──────────────────────────────────────────────────────────────
set -e

echo "══════════════════════════════════════════════════"
echo "  虫洞 Wormhole — 托管模式启动"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════"

# ── 1. 大模型网关转换 ──
# 规则（来自平台文档）：
#   - 原域名加 .tsecbench.gw 后缀
#   - https 改成 http
# 示例：https://api.deepseek.com/v1 → http://api.deepseek.com.tsecbench.gw/v1
if [ -n "$ANTHROPIC_BASE_URL" ] && [[ "$ANTHROPIC_BASE_URL" != *.tsecbench.gw* ]]; then
    # 先 https→http，再在域名（第一个 / 之前）后加 .tsecbench.gw
    ORIGINAL_URL="$ANTHROPIC_BASE_URL"
    export ANTHROPIC_BASE_URL="$(
        echo "$ANTHROPIC_BASE_URL" \
        | sed 's|^https://|http://|' \
        | sed 's|^\(http://[^/]*\)|\1.tsecbench.gw|'
    )"
    echo "[gateway] LLM URL 转换:"
    echo "  原始: $ORIGINAL_URL"
    echo "  转换: $ANTHROPIC_BASE_URL"
else
    echo "[gateway] ANTHROPIC_BASE_URL 未设或已含 .tsecbench.gw，跳过转换"
fi

# ── 2. 切换到 LocalWorker 后端 ──
# 容器内直接跑 claude CLI，不依赖嵌套 docker（托管沙箱禁用 DinD）
export WORMHOLE_WORKER_BACKEND=local
echo "[backend] WORMHOLE_WORKER_BACKEND=local (claude 直接 subprocess)"

# ── 2.5 允许 root 下运行 --dangerously-skip-permissions ──
# claude CLI 默认拒绝 root + skip-permissions 组合（安全检查），
# 平台一次性沙箱内以 root 跑渗透工具（nmap SYN 扫描等）是预期行为，
# 官方逃生口：IS_SANDBOX=1 跳过该检查（cli.js: getuid()===0 && IS_SANDBOX!=="1"）
export IS_SANDBOX=1
echo "[sandbox] IS_SANDBOX=1 (允许 root 运行 claude)"

# ── 3. 校验必要环境变量 ──
if [ -z "$BENCHMARK_TOKEN" ] || [ -z "$BENCHMARK_BASE_URL" ]; then
    echo "ERROR: BENCHMARK_TOKEN 和 BENCHMARK_BASE_URL 必须由平台注入"
    exit 1
fi
if [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
    echo "ERROR: ANTHROPIC_AUTH_TOKEN 未配置（运行时环境变量）"
    exit 1
fi

echo "[config] BENCHMARK_BASE_URL=$BENCHMARK_BASE_URL"
echo "[config] ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-glm-5.2}"
echo "[config] ANTHROPIC_AUTH_TOKEN=***${ANTHROPIC_AUTH_TOKEN: -4}"

# ── 4. 准备工作目录 ──
WORKDIR="/home/kali/workspace"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# ── 5. 启动 solver ──
# concurrency=3（平台 8核16G，同时 3 题各 1 个靶场容器）
# task-timeout=600（每轮 explore/reason 10 分钟上限）
# wall-clock=350（350 分钟总窗口，启用 wall-clock 重试 + hint 门控）
# 答题 API 地址/token 由平台注入，不传 --base-url/--token，让 CLI 从环境变量读
echo ""
echo "[solver] 启动 wormhole-solve..."
exec python3 -m wormhole.solver.cli_solve \
    --concurrency 3 \
    --task-timeout 600 \
    --bootstrap-timeout 180 \
    --max-rounds 20 \
    --per-challenge-budget 2400 \
    --max-parallel-explores 3 \
    --wall-clock 350 \
    --runs-dir /tmp/solver_runs \
    -v
