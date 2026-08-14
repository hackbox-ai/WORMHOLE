<!-- 图片待补充：将截图放入 docs/images/ 后自动渲染（banner / webui / gui / 曲线图） -->

<h1 align="center">虫洞 Wormhole</h1>

<h3 align="center">图谱认知渗透智能体 · Graph-Cognition Penetration Agent</h3>

<p align="center">
  <em>Every new Fact is a stepping stone; every Intent is a step into the unknown.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TSec_Benchmark-60%2F74_flags-2b9246?style=flat-square" alt="TSec Benchmark">
  <img src="https://img.shields.io/badge/python-3.12+-3776ab?style=flat-square&logo=python&logoColor=white" alt="Python 3.12+">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square" alt="License">
  <img src="https://img.shields.io/badge/platform-docker%20%7C%20local-2496ed?style=flat-square&logo=docker&logoColor=white" alt="Platform">
</p>

<p align="center">
  <img src="docs/images/banner.png" alt="Wormhole Banner" width="100%">
</p>

---

## What is Wormhole?

真实业务系统中的安全漏洞往往以多阶段、跨边界的链式形态存在——单个注入点可能只是攻击链的入口，后续还需越权访问、凭据提取、横向移动才能触及目标。传统扫描工具依赖规则与签名，无法处理未见过的漏洞模式；通用 LLM Agent 采用线性对话，每轮之间缺乏结构化的知识持久化，长时间任务中丢失上下文、重复探索已排除路径。

虫洞将渗透测试建模为**知识图谱（DAG）的增量构建过程**：

- 每一次侦察发现、漏洞确认、凭据获取、flag 捕获，都以**不可变事实节点**沉淀进图谱
- 每一轮推理在图谱拓扑上决定探索方向，执行结果再次沉淀为事实——**知识跨轮次累积，死胡同被显式标注供后续规避**
- 配合自适应止损调度与跨轮次经验复用，在有限时间预算内对复杂攻击链持续收敛

在 TSec Benchmark（63 题 / 23000 分 / 360 分钟）中，虫洞单次运行捕获 **60 / 74 个 flag**，覆盖全部六大能力域；其中多阶段渗透系列多台靶机达成全 flag（4/4），完整走通「外网门户 → 内网横向 → OA 系统 → 数据库」的全链路攻击路径。

## Wormhole in Action

> **[截图占位] Web UI 实时看板** — `docs/images/webui-dashboard.png`
>
> 左侧题目列表实时显示各题进度与 flag 数量，右侧知识图谱可视化呈现当前题目的完整推理链路：从 origin 侦察节点到 goal 完成节点的有向路径、死胡同标注、经验注入事件。

> **[截图占位] 桌面 GUI 运行看板** — `docs/images/gui-dashboard.png`
>
> 攻击面图谱 + 代理流量面板 + 内置浏览器三视图联动，实时跟踪最新一次运行的数据。

> **[截图占位] CLI 批量解题日志** — `docs/images/cli-solving.png`

<p align="center">
  <img src="docs/images/webui-dashboard.png" alt="WebUI Dashboard" width="100%">
</p>

## How It Works

虫洞采用编排层 / 认知层 / 执行层三层分离设计，层间接口严格解耦——同一套认知逻辑可运行于 Docker 编排模式与单容器本地子进程模式。

```
┌─────────────────────────────────────────────────────────────────┐
│  编排层 Orchestration                                            │
│  Scheduler（多题并发/止损轮转）  BenchmarkClient  ResourceManager │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  认知层 Cognition — Blackboard 知识图谱 (SQLite, append-only)     │
│                                                                 │
│         ┌─────┐        ┌─────┐        ┌─────┐                   │
│   origin┤ f001├────────┤ f002├───┐    ├─f004 │◄ dead-end 标注   │
│         └──┬──┘        └──┬──┘   │    └──────┘                   │
│            └───────┐       │   ┌──▼───────────┐                 │
│                  ┌─▼────┐  │   │     goal     │                 │
│                  │ f003 │──┴──►│   (flag ✓)   │                 │
│                  └──────┘      └──────────────┘                 │
│                                                                 │
│     OODA: Bootstrap → Reason → Explore → Checkpoint ↻           │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│  执行层 Execution — Worker 双后端抽象                             │
│         WORMHOLE_WORKER_BACKEND = docker │ local                │
│   ┌─────────────────────────┐  ┌─────────────────────────┐      │
│   │ Docker Backend（本地）   │  │ Local Backend（托管沙箱） │      │
│   │ Kali 容器 + claude CLI   │  │ subprocess + claude CLI  │      │
│   └─────────────────────────┘  └─────────────────────────┘      │
└─────────────────────────────────────────────────────────────────┘
```

### 图谱基本元素

| 概念 | 含义 |
|------|------|
| **Fact 事实节点** | 不可变知识单元。侦察发现、漏洞确认、凭据获取、flag 捕获均沉淀为事实，一经创建永不修改，推理历史完整可溯 |
| **Intent 探索意图** | 有向边。从已有事实出发的探索假设，推理阶段创建（目标槽位为空），探索完成后关闭并指向产出事实，形成推理链路 |
| **Dead-end 标注** | 死胡同分类。强正面信号（`flag{`、`RCE confirmed`）优先于强否定短语（`ruled out`、`not injectable`），被排除方向在导出快照中以 `dead_end: true` 标记，后续轮次主动规避 |

### OODA 认知循环

| 阶段 | 做什么 | 产出 |
|------|--------|------|
| **Bootstrap** | 初始化侦察，创建 origin 与 goal 节点，注入题型方法论 | 初始图谱 + 经验块（重试时） |
| **Reason** | 读取当前图谱拓扑，决定下一步探索方向 | 探索意图集合 |
| **Explore** | 并发执行工具调用（默认 3 路） | 新事实节点 |
| **Checkpoint** | 比对事实数 / 开放意图数 / 提示数三标量，检测信息增益 | 继续 / 重置假设 / 退出 |

### 核心机制

| 机制 | 解决的问题 |
|------|-----------|
| **自适应止损轮转调度** | 第一阶段统一窗口全题快遍（~90 分钟收割约 80% flag），第二阶段 wall-clock 全窗口刷新预算持续重试困难题——预算自适应流向有产出的方向，而非一题到底 |
| **跨轮次经验复用** | 重试不从空白开始：上一轮图谱提取「已确认发现 + 已排除死路」结构化经验块注入新 origin，第 n 次尝试等效于已完成 n−1 轮探索的研究员 |
| **失效 flag 感知** | 对抗靶场实例轮换导致的 flag 漂移：被拒值进入失效集永不重提，完成判定对失效集作差，杜绝「捕获了 flag 却未得分」的空转重试 |
| **双路提交状态机** | 实时路径（每个事实写入后异步提交）+ 批量路径（题目结束兜底补交）；去重集合仅在提交成功后更新，网络失败时 flag 保持可重试 |
| **三重退出门控** | 预算硬墙 + flag 停滞检测（容忍度随已获 flag 数线性放大）+ 基础设施宕机检测，各自针对不同的预算浪费模式 |
| **题型自适应知识库** | 索引路由 + 七大领域专题决策树（Web / 二进制 / AI 应用 / 区块链 / CVE 利用 / 对抗规避 / 云），按需加载，每层负载均在上下文窗口内 |

## Results

TSec Benchmark v1：63 题，23000 分，360 分钟窗口，并发 3，DeepSeek V4。

| 指标 | 结果 |
|------|------|
| **总 flag 捕获** | **60 / 74**（含多 flag 题） |
| **首轮遍历** | ~180 分钟完成全部 63 题，50 flag / 15550 分（得分率 67.6%） |
| **首个 flag** | 启动后第 7 分钟 |
| **能力域覆盖** | Web 漏洞挖掘 / 二进制漏洞挖掘 / 已知 CVE 利用 / AI 应用安全 / 云攻击 / 对抗规避 —— 全部有产出 |
| **多阶段渗透** | 多台靶机全 flag（4/4），完整走通外网→内网→OA→数据库全链路 |

> **[图占位] flag 累积曲线** — `docs/images/flag-cumulative.png`
>
> 横轴 0–360 分钟，纵轴累积 flag 数。Phase 1 全题快遍在 180 分钟内爬升至 50，Phase 2 wall-clock 重试继续爬升至 60。

<p align="center">
  <img src="docs/images/flag-cumulative.png" alt="Flag Cumulative Curve" width="88%">
</p>

## Getting Started

### Prerequisites

- Python ≥ 3.12，Docker
- 一个 Anthropic 兼容 API（DeepSeek / Kimi / GLM 等均可，通过 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` 三个环境变量配置）
- 执行智能体依赖 [claude code](https://docs.anthropic.com/en/docs/claude-code) CLI（Worker 镜像内已预装）

### Install

```bash
git clone https://github.com/yourname/wormhole.git
cd wormhole

pip install .            # 核心依赖：fastapi + uvicorn
pip install ".[gui]"     # 可选：桌面 GUI（PySide6）
```

### Build Worker Image（本地模式）

```bash
# Worker 容器：Kali + 全套渗透工具（nmap/sqlmap/gdb/pwntools/...）
docker build -f containers/Dockerfile.solver -t wormhole-solver:latest .
```

### Run — 三种模式

**CLI 批量解题**（比赛 / 托管同一路径）：

```bash
export BENCHMARK_TOKEN=<your-token>
export BENCHMARK_BASE_URL=<platform-url>
export ANTHROPIC_BASE_URL=https://api.deepseek.com
export ANTHROPIC_AUTH_TOKEN=<your-key>
export ANTHROPIC_MODEL=deepseek-v4-pro

python -m wormhole.solver.cli_solve --concurrency 3 --wall-clock 350 -v
# 或使用封装脚本：bash solve.sh <TOKEN> all
```

**Web UI 实时看板**：

```bash
python -m wormhole.solver.webui     # http://localhost:8765
```

**桌面 GUI**（运行看板 + 内置浏览器）：

```bash
python -m wormhole.ui.launch
# 代理 / CDP 为可选项：WORMHOLE_GUI_PROXY=1 / WORMHOLE_GUI_CDP=1
```

### Hosted Deployment（单容器托管）

面向只提供单容器、禁用嵌套 Docker 的沙箱平台（如评测托管）：

```bash
docker build -f containers/Dockerfile.slim -t wormhole-hosted:slim .
docker save wormhole-hosted:slim | gzip > wormhole-hosted.tar.gz
```

入口脚本自动完成：大模型网关 URL 转换（`.tsecbench.gw` 后缀）、`IS_SANDBOX=1` root 适配、切换 Local 后端并启动全量解题。详见 [`containers/HOSTED_README.md`](containers/HOSTED_README.md)。

## Repository Layout

```
wormhole/
├── wormhole/
│   ├── solver/                  # 编排 + 认知 + 执行核心
│   │   ├── cli_solve.py         #   CLI 入口 / Scheduler / flag 提交状态机
│   │   ├── dispatcher.py        #   OODA 循环 / 完成与停滞判定
│   │   ├── blackboard.py        #   知识图谱（SQLite DAG，append-only）
│   │   ├── worker.py            #   Worker 双后端抽象（docker / local）
│   │   ├── tasks.py / prompts/  #   任务执行与 Prompt 模板
│   │   ├── webui.py + static/   #   Web 看板（FastAPI，:8765）
│   │   └── skills/              #   方法论知识库（索引路由 + 专题决策树）
│   ├── orchestrator/
│   │   └── benchmark_client.py  # 平台 API 客户端（start/submit/close）
│   └── ui/                      # 桌面 GUI（运行看板 + 内置浏览器）
├── containers/                  # Dockerfile.solver / .slim / .hosted + 入口脚本
├── docs/technical-report.md     # 技术报告（完整架构 / 方法 / 公式推导）
└── solve.sh                     # 本地解题封装脚本
```

## Further Reading

- [技术报告：面向复杂攻击链的图谱认知渗透智能体](docs/technical-report.md) —— 完整架构、调度策略形式化、死胡同分类判定、失效 flag 对抗、提交状态机
- [`wormhole/solver/skills/ctf-solve-strategy/SKILL.md`](wormhole/solver/skills/ctf-solve-strategy/SKILL.md) —— 题型路由索引与七大领域方法论决策树

## ⚠️ Disclaimer

虫洞仅供**授权安全测试**使用——CTF 竞赛、自有靶场、书面授权的渗透测试与安全研究。使用者须自行确保测试行为在授权范围内，并对使用本工具产生的一切后果负责。禁止将本工具用于任何未授权的非法用途。

## ⚖️ License

Apache-2.0. See [LICENSE](LICENSE).

---

<p align="center">
  <em>虫洞：把每一次探索的结论，变成下一次推理的起点。</em>
</p>
