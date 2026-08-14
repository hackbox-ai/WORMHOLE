# 虫洞 Wormhole — 托管模式部署指南

## 概览

托管模式下，平台在隔离沙箱里拉起你的 Docker 镜像并自动运行。虫洞的托管镜像把**编排器（agent）和 claude CLI 合并到单个容器**，不需要嵌套 docker。

```
平台沙箱容器（wormhole-hosted）
├── entrypoint-hosted.sh        ← 启动脚本（网关转换 + 启动 solver）
├── python -m wormhole.solver.cli_solve   ← 编排器进程
│   └── claude CLI（直接 subprocess 调用，不再 docker exec）
├── /home/kali/workspace/       ← 工作目录（claude 在这里跑工具）
│   └── .claude/skills/         ← 内置技能（ctf-solve-strategy 等）
└── Kali 全套工具 + PWN 工具    ← 靶场攻击工具
```

## 1. 构建镜像

两种镜像，按用途选择：

| 镜像 | Dockerfile | 大小 | 用途 |
|------|-----------|------|------|
| `wormhole-hosted:slim` | `Dockerfile.slim` | 2.5GB（tar.gz ≈550MB） | **平台上传**。基于 kali-rolling 精简构建，含核心工具 + claude CLI + 全量 skill |
| `wormhole-hosted:latest` | `Dockerfile.hosted` | ~7GB | 本地验证。基于完整 solver 镜像，全套 Kali 工具 |

```bash
cd src/

# 方式一：精简镜像（推荐，平台上传用）
docker build -f containers/Dockerfile.slim -t wormhole-hosted:slim .
docker save wormhole-hosted:slim | gzip > wormhole-hosted.tar.gz

# 方式二：完整镜像（一键构建 + 导出，本地验证用）
bash containers/build-hosted.sh
```

## 2. 本地测试镜像

```bash
docker run --rm \
  -e BENCHMARK_TOKEN=你的token \
  -e BENCHMARK_BASE_URL=https://tsecbench.zc.tencent.com \
  -e ANTHROPIC_AUTH_TOKEN=你的大模型key \
  -e ANTHROPIC_BASE_URL=https://api.deepseek.com \
  -e ANTHROPIC_MODEL=deepseek-v4-pro \
  wormhole-hosted:latest
```

> 注意：本地测试时 `ANTHROPIC_BASE_URL` 用原始地址（不需要手动加 `.tsecbench.gw`），entrypoint 会自动转换。但如果本地测试想直连大模型（不走平台网关），设 `ANTHROPIC_BASE_URL` 时保持 https 即可——entrypoint 的转换逻辑只在 URL 不含 `.tsecbench.gw` 时触发。如果本地不想被转换，可以先设好带后缀的地址。

## 3. 平台配置

### 上传镜像
在平台「制作并上传 Docker 镜像」处上传 `wormhole-hosted.tar.gz`。

### 运行时环境变量

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `ANTHROPIC_AUTH_TOKEN` | 你的大模型 API key | **必填**。DeepSeek / GLM 等的 key |
| `ANTHROPIC_BASE_URL` | 大模型 API 地址 | **必填**。entrypoint 自动转换成网关地址 |
| `ANTHROPIC_MODEL` | 模型名 | 默认 `glm-5.2`。可选 `deepseek-v4-pro` 等 |
| `BENCHMARK_TOKEN` | （平台自动注入） | 不填，平台运行时分发 |
| `BENCHMARK_BASE_URL` | （平台自动注入） | 不填，平台运行时分发 |

### 大模型网关转换规则（entrypoint 自动处理）

平台规则：原域名加 `.tsecbench.gw` 后缀 + https 改 http。

| 大模型 | 原始 URL（你填的） | 转换后（entrypoint 自动做） |
|--------|-------------------|--------------------------|
| DeepSeek | `https://api.deepseek.com` | `http://api.deepseek.com.tsecbench.gw` |
| GLM (智谱) | `https://open.bigmodel.cn/api/anthropic` | `http://open.bigmodel.cn.tsecbench.gw/api/anthropic` |
| Kimi | `https://api.moonshot.cn` | `http://api.moonshot.cn.tsecbench.gw` |

你只需填原始 URL，entrypoint 脚本会自动转换。

## 4. 架构说明

### 为什么是单容器（合并架构）？

本地模式：agent 进程（宿主机）+ worker 容器（docker）双容器架构，通过 `docker exec` 调 claude。

托管模式：沙箱禁用嵌套 docker，所以虫洞用 **LocalWorker** 后端——`claude` 直接以 subprocess 方式跑在 agent 同一容器里。通过环境变量 `WORMHOLE_WORKER_BACKEND=local` 切换（entrypoint 自动设置）。

### 关键文件

| 文件 | 作用 |
|------|------|
| `containers/Dockerfile.slim` | 精简托管镜像（kali-rolling 基础，2.5GB，上传用） |
| `containers/Dockerfile.hosted` | 完整托管镜像（基于 wormhole-solver，本地验证用） |
| `containers/entrypoint-hosted.sh` | 启动脚本（网关转换 + 启动 solver） |
| `containers/build-hosted.sh` | 一键构建 + 导出脚本 |
| `solver/worker.py:LocalWorker` | 无 docker 的 claude 驱动（与 ClaudeCodeWorker 同接口） |
| `solver/worker.py:make_worker` | 工厂函数，按 `WORMHOLE_WORKER_BACKEND` 选后端 |

### 并发配置

- `concurrency=3`：同时跑 3 道题（各占 1 个靶场容器）
- `max_parallel_explores=3`：每题内最多 3 个并发 explore
- 平台给 8核16G，这个配置下最多 3×3=9 个 claude 进程

## 5. 故障排查

### claude 认证失败
日志里看到 `claude auth failure`：
- 检查 `ANTHROPIC_AUTH_TOKEN` 是否正确注入
- 检查 `ANTHROPIC_BASE_URL` 是否在白名单（见平台文档）
- entrypoint 的网关转换是否正确（看启动日志的 `[gateway]` 行）

### 靶场不可达
日志里看到 `connection refused` / `unreachable`：
- 确认 VPN/网络配置（平台沙箱应自动路由到靶场）
- 托管模式下 `detect_external_ip` 可能失败（沙箱无公网出口），这不影响解题，只影响反连类挑战
