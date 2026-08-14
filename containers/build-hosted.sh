#!/bin/bash
# ──────────────────────────────────────────────────────────────
# 虫洞 Wormhole — 托管镜像构建与导出脚本
#
# 用法（从 src/ 目录执行）：
#   bash containers/build-hosted.sh
#
# 产出：wormhole-hosted.tar.gz（上传到平台）
#
# 前置条件：
#   1. 已构建 wormhole-solver:latest（Dockerfile.solver）
#      bash: docker build -f containers/Dockerfile.solver -t wormhole-solver:latest .
#   2. docker daemon 运行中
#   3. 磁盘空间充足（镜像 ~5-8GB，导出 tar.gz 后 ~2-3GB）
# ──────────────────────────────────────────────────────────────
set -e

cd "$(dirname "$0")/.."  # 切到 src/ 目录（build context）

IMAGE_NAME="wormhole-hosted"
IMAGE_TAG="latest"
TARBALL="wormhole-hosted.tar.gz"

echo "══════════════════════════════════════════════════"
echo "  虫洞 Wormhole — 托管镜像构建"
echo "  镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
echo "  开始: $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════════"

# ── 1. 检查基础镜像 ──
if ! docker image inspect wormhole-solver:latest >/dev/null 2>&1; then
    echo "⚠️  基础镜像 wormhole-solver:latest 不存在，先构建它..."
    docker build -f containers/Dockerfile.solver -t wormhole-solver:latest .
    echo "✅ 基础镜像构建完成"
fi

# ── 2. 构建托管镜像 ──
echo ""
echo "[build] 构建 ${IMAGE_NAME}:${IMAGE_TAG}..."
docker build -f containers/Dockerfile.hosted -t "${IMAGE_NAME}:${IMAGE_TAG}" .

# ── 3. 导出为 tar.gz ──
echo ""
echo "[export] 导出为 ${TARBALL}..."
docker save "${IMAGE_NAME}:${IMAGE_TAG}" | gzip > "${TARBALL}"

# ── 4. 检查大小 ──
SIZE=$(du -h "${TARBALL}" | cut -f1)
echo ""
echo "══════════════════════════════════════════════════"
echo "  ✅ 构建完成"
echo "  文件: ${TARBALL} (${SIZE})"
echo "  结束: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo "  ⚠️  平台限制 3GB。如果超限，考虑："
echo "     - 用 docker history 分析大层"
echo "     - 合并 RUN 指令减少层数"
echo "     - 清理 apt/pip 缓存"
echo "══════════════════════════════════════════════════"
echo ""
echo "下一步：上传 ${TARBALL} 到平台，并配置运行时环境变量："
echo "  ANTHROPIC_AUTH_TOKEN = 你的大模型 API key"
echo "  ANTHROPIC_BASE_URL  = 大模型 API 地址（entrypoint 自动转换网关）"
echo "  ANTHROPIC_MODEL     = 模型名（如 deepseek-v4-pro）"
echo "  BENCHMARK_TOKEN / BENCHMARK_BASE_URL = 平台自动注入，不填"
