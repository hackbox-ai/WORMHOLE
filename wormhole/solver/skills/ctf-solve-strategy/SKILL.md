---
name: ctf-solve-strategy
description: Authorized CTF and penetration-testing methodology. Use when testing, probing, scanning, or hunting vulnerabilities in any target — web apps, APIs, binary services, AI platforms, cloud infrastructure, blockchain, or multi-stage networks. Covers recon, exploitation, privilege escalation, and flag capture.
---

# Penetration Testing & CTF Methodology

A systematic approach to authorized security challenges. The goal is always the same: understand the target, find a way in, escalate, and capture every flag.

## 本文件是路由索引

这个 skill 按**题型拆分**为多个参考文件。本主文件提供：
1. 解题心法（Mindset）和通用流程
2. **题型路由表** — 看到什么题型/信号，去哪个文件找打法
3. **信号速查表** — 按观察到的特征快速定位
4. 跨题型的通用环节（侦察、拿 flag、多 flag、卡住时、环境笔记）

**解题时先读本文件的路由表，定位到对应参考文件，再深入具体打法。**

## 题型路由表

| 题型 / 技术栈 | 占比(真实比赛) | 参考文件 | 说明 |
|--------------|---------------|---------|------|
| **Web 漏洞挖掘** | 67% | [`references/web-deep.md`](references/web-deep.md) | 业务系统/Web应用/数据库/中间件/供应链；业务漏洞链、越权、注入、文件读 |
| **已知软件/CVE** | (并入Web/Binary) | [`references/cve-products.md`](references/cve-products.md) | 识别出具体产品后查 CVE；OFBiz/Fastjson/HugeGraph/Log4j 等产品 playbook |
| **AI 漏洞挖掘** | 7% | [`references/ai-vuln.md`](references/ai-vuln.md) | LLM应用/Agent架构/RAG/多模态；prompt injection、工具滥用、平台 CVE |
| **二进制漏洞挖掘** | 20% | [`references/binary-pwn.md`](references/binary-pwn.md) | 软件组件/运行环境/系统边界；PWN、逆向、fuzz、权限边界、符号执行 |
| **区块链漏洞挖掘** | 6% | [`references/blockchain.md`](references/blockchain.md) | 智能合约/链上交互/资产流转；重入、闪电贷、访问控制、Foundry 工作流 |
| **对抗规避** | (通用技巧) | [`references/evasion.md`](references/evasion.md) | WAF绕过、沙箱逃逸、特征检测/制品构造；通用绕过原语 |
| **云攻击 / 多阶段** | (通用技巧) | [`references/cloud-multi.md`](references/cloud-multi.md) | 云元数据、内网横向、多阶段渗透链；D系列+B系列实战 |

## 信号速查表

> 看到左边的信号，去右边的文件/章节找打法。

| 观察到 | 去看 |
|--------|------|
| 登录页 / 测试凭据可见 | `web-deep.md` → 认证 |
| JS 里藏 base64 / API key / token | `web-deep.md` → 认证 |
| 文件下载 / `?file=` / `?id=` 参数 | `web-deep.md` → 文件读 |
| 命令注入 / SSTI / 反序列化 | `web-deep.md` → 命令注入 |
| 越权 / IDOR / mass assignment | `web-deep.md` → 逻辑漏洞 |
| JWT（`eyJ`）/ `kid` 字段 | `web-deep.md` → 鉴权 |
| SSRF / `?url=` / webhook 配置 | `web-deep.md` → 业务漏洞链·链路2 |
| GraphQL `/graphql` 端点 | `web-deep.md` → 业务漏洞链·链路4 |
| 识别出具体软件（Dify/HugeGraph/OFBiz...） | `cve-products.md` → 对应产品 |
| Java 服务 5005 端口 / `JAVA_OPTS` 含 `-agentlib:jdwp` | `cve-products.md` → JDWP debug port |
| Log4j / Fastjson / Spring / Shiro | `web-deep.md` → 供应链·CVE速查 |
| Dify / Langflow / ComfyUI / Ollama / n8n | `ai-vuln.md` → 已知平台 |
| 聊天框 / LLM 交互 | `ai-vuln.md` → LLM应用层 |
| Agent 暴露工具（exec/read_file/http） | `ai-vuln.md` → Agent架构 |
| 上传知识库 / RAG 入口 | `ai-vuln.md` → RAG |
| 上传图片 / OCR / 多模态 | `ai-vuln.md` → 多模态 |
| ELF + `checksec` / `file` 显示二进制 | `binary-pwn.md` → 漏洞模式 |
| TCP 自定义协议 / `nc ip port` | `binary-pwn.md` → 自定义协议fuzz |
| 下载二进制做 license 破解 | `binary-pwn.md` → F系列·静态逆向 |
| setuid / sudo / capabilities | `binary-pwn.md` → 权限边界 |
| 需要 fuzz 找 crash | `binary-pwn.md` → 自动化漏洞发现 |
| Solidity / EVM / 合约地址 / Foundry | `blockchain.md` |
| 重入 / 闪电贷 / 预言机 / delegatecall | `blockchain.md` → B节 |
| 只有字节码（无源码） | `blockchain.md` → D节 |
| WAF 拦截 payload | `evasion.md` → E1·WAF绕过 |
| Python/JS 沙箱逃逸 | `evasion.md` → E2·沙箱逃逸 |
| pickle 反序列化沙箱 | `evasion.md` → E2·pickle白名单绕过 |
| 特征检测 / 需构造 polyglot 制品 | `evasion.md` → E3 |
| 云环境 / 169.254.169.254 / metadata | `cloud-multi.md` → 云元数据 |
| 内网 / 多阶段 / 需要横向移动 | `cloud-multi.md` → 多阶段渗透 |
| webshell/凭据突然失效、容器 IP 或 flag 值变了 | `cloud-multi.md` → §0 环境轮换 |

---

## Mindset

Think like a security researcher, not a script kiddie. Every target tells a story — through its HTTP headers, its error messages, its file structure, its binary layout. Your job is to read that story carefully and find the chapter where someone made a mistake.

**Move fast on recon, slow on exploitation.** Spend the first few minutes mapping the entire attack surface (every port, every endpoint, every parameter). Then pick the most promising lead and dig deep. Don't scatter-shot — commit to a hypothesis, test it rigorously, and pivot cleanly when it fails.

**Submit early, submit often.** If you see something that looks like a flag, submit it immediately. Wrong guesses are free. The platform's response tells you how many flags exist, which narrows your search dramatically.

**优先打确定性漏洞。** AI 壳下面的传统漏洞（SSRF、路径穿越、反序列化、未授权）常常比 AI 逻辑本身脆。识别出软件指纹先查 CVE，比从头分析快。

## Phase 1: Reconnaissance

### HTTP Services

Start with the basics, then go deeper:

```bash
# Identify the stack
curl -s -i -m 15 http://<target>/ | head -80
whatweb -a 3 http://<target>/ 2>/dev/null

# If curl gets reset (WAF/proxy), try alternatives:
curl --http1.0 -s -i http://<target>/          # some WAFs only block HTTP/1.1
printf 'GET / HTTP/1.1\r\nHost: <ip>\r\n\r\n' | nc <ip> <port>  # raw socket
curl --tlsv1.2 -sk https://<target>/            # force TLS version
```

Then enumerate:
```bash
# Directory discovery (use auto-calibration against catch-all 200s)
ffuf -w <wordlist> -u http://<target>/FUZZ -e .php,.bak,.zip,.sql -ac -t 40
feroxbuster -u http://<target>/ -w raft-medium-directories.txt -t 40

# Quick check of high-value paths
for p in robots.txt admin login api .git/config .env config.php.bak backup; do
  curl -s -o /dev/null -w "%{http_code} %{size_download} $p\n" http://<target>/$p
done
```

**Read the frontend code.** JavaScript files are a goldmine — they contain hardcoded credentials (sometimes base64-encoded), API endpoint paths, debug flags, and version strings:
```bash
curl -s http://<target>/js/login.js
curl -s http://<target>/js/main.js | grep -oE '"/api/[^"]*"|version|password|key|token'
```

### Binary / TCP Services

```bash
nc -vz <ip> <port>                     # connectivity
echo "HELP" | nc <ip> <port>           # many custom protocols respond to HELP
echo "" | nc <ip> <port> | xxd         # raw bytes tell you the protocol
```

For downloadable binaries:
```bash
curl -o binary http://<target>/download
file binary && checksec binary
strings -a binary | grep -iE 'flag|pass|key|version|usage'
readelf -hSW binary
objdump -d -M intel binary | head -200
```

### 区块链服务侦察

```bash
# 如果题目是区块链，拿到 RPC/Setup 地址后先跑：
export RPC="http://<host>:<port>/<uuid>" SETUP="0x..." PK="0x..."
cast chain-id --rpc-url $RPC
cast block-number --rpc-url $RPC
cast call $SETUP "isSolved()(bool)"
cast call $SETUP "TARGET()(address)" 2>/dev/null
cast storage $SETUP 0 --rpc-url $RPC
slither . 2>/dev/null    # 有源码则静态扫
```

## Phase 2: Vulnerability Discovery（按题型路由）

识别出题型/技术栈后，**跳到对应的参考文件**深入打法：

- 看到 Web 服务 → [`references/web-deep.md`](references/web-deep.md)
- 识别出具体产品 → [`references/cve-products.md`](references/cve-products.md)
- 看到 AI/LLM 应用 → [`references/ai-vuln.md`](references/ai-vuln.md)
- 看到二进制/ELF/PWN → [`references/binary-pwn.md`](references/binary-pwn.md)
- 看到区块链/合约 → [`references/blockchain.md`](references/blockchain.md)
- 遇到 WAF/沙箱/特征检测 → [`references/evasion.md`](references/evasion.md)
- 云环境/内网/多阶段 → [`references/cloud-multi.md`](references/cloud-multi.md)

**不确定题型时**，先做通用侦察（上面的 Phase 1），根据响应特征（HTTP头、端口、协议指纹）判断。

## Phase 3: Post-Exploitation & Flag Capture

Once you have access, find every flag:

```bash
# Common flag locations
find / -name "flag*" -o -name "*.flag" 2>/dev/null
grep -ri "flag{" / 2>/dev/null
cat /challenge/flag*.txt 2>/dev/null
env | grep -i flag
# Database
mysql -u <user> -p<pass> -e "SELECT * FROM flags"
redis-cli -h <ip> -a <pass> KEYS '*'
```

**Flag formats vary**: `flag{uuid}`, `FLAG{leetspeak}`, `Flag{...}` — try different cases.

## Environment Notes

- Use `/usr/bin/python3` explicitly (some environments have a broken default python3 symlink)
- Wordlists may not be at the expected path — search with `find / -name '*.txt' -path '*wordlist*'`
- `ffuf -x` is a proxy flag, not extension; use `-e` for extensions
- Port scanners may report false positives behind NAT — verify with direct TCP connections
- Internet access may be restricted — rely on local PoC/knowledge repositories at `/home/kali/pocs/`, `/home/kali/knowledges/`
- Raw sockets (`ping`, `nmap -sS`) may be disabled — use TCP connect scans (`nmap -sT`)
- **`/usr/local/bin/python3` 可能是坏 shim**——如果 `python3` 报 `not found`，改用 `/usr/bin/python3`
- **端口全"OPEN"但 curl reset** = K8s sidecar/Istio 透明代理假阳性——必须用 `curl -sv` 二次验证
- **K8s 环境**：Istio sidecar 端口 15010/15014/15021/15090/19090 是环境噪声
- **TLS 服务 curl reset 时**：试 `openssl s_client -tls1_2 -connect <ip>:<port>`，读证书 CN/O/OU

## Phase 4: Multi-Flag Targets

When a challenge has MORE THAN ONE flag, finding one is only ~25% of the work. After each flag, run this **flag-hunt checklist**:

1. **Re-enumerate the attack surface with the new privilege level.** A flag often unlocks a foothold that reveals MORE attack surface invisible earlier. Re-run directory bruteforce, port scan, and API enumeration as the new user.
2. **Where do flags hide? Check ALL of these:**
   - Filesystem: `/challenge/flag*.txt`, `/flag*`, `/home/*/flag*`, `/var/*/flag*`, `/tmp/*`
   - Database: `SELECT * FROM flags`, every table's columns
   - Environment: `env | grep -i flag`, `/proc/self/environ`, `/proc/1/environ`
   - Response artifacts: HTTP headers, cookies, hidden form fields, JS bundles, source maps
   - Network: other ports on the same host, internal hosts reachable after pivoting
   - Service-specific: Redis `KEYS '*'`, MySQL `SHOW DATABASES`, config files
3. **After a flag, immediately pivot — don't deep-dive the same vector.** If flag-1 came from SQLi, the other 3 flags are probably NOT more SQLi. Force a new hypothesis.
4. **Re-read the challenge description between flags.** It often describes N distinct systems; each system tends to hold one flag.
5. **Coordinate with peers.** Write each confirmed flag to `team/findings/flag-N.txt`.

The biggest multi-flag failure mode is **tunnel vision**: spending 90% of the budget deepening the first successful vector while 3 other attack surfaces sit unexplored. Resist this.

## When Stuck

1. Re-read the challenge description — it often hints at the vulnerability class
2. Check what other endpoints/files you haven't tried
3. Switch encoding/protocol (HTTP/1.0, different TLS version, raw socket)
4. Try the same attack with different parameters, methods (PUT/DELETE/PATCH), or content types
5. Look at error messages carefully — they reveal the backend stack and file structure
6. If WAF blocks your payload, study what specifically triggers it (character-level differential testing)
7. Search for writeups of similar challenges or the same product
8. **重新查题型路由表** — 可能归类错了，换个参考文件的角度看
9. When all else fails: `grep -ri "flag{" / 2>/dev/null`
