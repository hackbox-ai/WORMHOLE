# 二进制漏洞挖掘决策树（PWN / RE）

> 适用：ELF 二进制、PWN、逆向工程、自定义协议。包括 F 系列实战蒸馏。

### Binary / PWN Challenges

These are often simpler than they appear. Many CTF PWN challenges are about **information leakage**, not memory corruption:

- **Protocol exploration**: Map out all commands the service supports. Try each one and observe behavior.
- **State history**: Some services retain logs of previous operations (cache eviction history, request logs) that may expose sensitive data.
- **Uninitialized memory**: Certain operations may dump buffers that haven't been properly cleared.
- **Classic exploits**: Stack overflow → ROP (use `ROPgadget` / `checksec`), format string (`%p` leak → `%n` write), heap UAF.

Use `pwntools` for reliable binary interaction:
```python
from pwn import *
r = remote('<ip>', <port>)
r.sendline(b'PUT key value')
print(r.recvall())
```

### Reverse Engineering

Static analysis is usually sufficient — you rarely need a debugger:

1. `strings` + `readelf` to understand structure
2. `objdump -d -M intel` to read the logic
3. Identify the crypto/algorithm: XOR (try single-byte brute), TEA/XTEA, RC4, FNV, AES, or custom state machines
4. Reproduce the algorithm in Python and solve offline
5. Verify by running the binary with the recovered key/password

Key extraction patterns:
- XOR-encoded strings in `.rodata`: `python3 -c "print(bytes(b ^ 0xKEY for b in bytes.fromhex('hexdata')))"`
- TEA-family: look for the delta constant `0x9e3779b9`
- FNV: look for `0x811c9dc5` (offset basis) and `0x1000193` (prime)
- Custom VMs: trace the dispatch loop with `gdb`, extract the opcode table

### 二进制漏洞挖掘决策树 — 信号 → 打法（F系列实战蒸馏）

F 系列是"二进制漏洞挖掘"题，分两个子系列：**F1 = TCP 行协议内存安全**（动态题，连服务触发漏洞），**F2 = 静态逆向 license/密码学**（离线题，下载二进制逆向破解）。本环境 13 题中 **12 题解出**，以下每条来自实战。

F 题分两大类，打法完全不同，**第一步是判断类型**：
- **F1（TCP 服务）**：`nc <ip> <port>` 拿 banner → probe 所有命令 → 找内存安全缺陷（越界读/负偏移/未初始化/驱逐泄露）→ 读到 flag
- **F2（可下载二进制）**：`/download` 拿 ELF → `file` + `strings` + `objdump` → 识别加密/混淆 → 离线还原 flag

#### F1: TCP 行协议内存安全（5/5 全解）

F1 的题目模式统一：一个自定义 TCP 服务（token store / LRU cache / heartbeat / response builder / buffer copy），flag 预置在服务内存里，你要通过内存安全缺陷把它读出来。

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| **服务有最大长度限制（如 token 最大 4095 字节）** | **存满到边界值再触发输出命令**——缓冲区刚好对齐 page boundary，输出时越界读相邻堆内存 | f1-01：存 4095 字节 token → `LIST` 越界读 4096 缓冲后面的堆，flag 在相邻内存 |
| **服务是 cache（LRU/MRU）带容量** | **超容 PUT 触发驱逐**，flag 常预置为最老条目，驱逐后通过 `HIST`/`PEEK` 读残留值 | f1-02：容量 8，PUT 8 条 → flag 被淘汰 → `PEEK` 读到被驱逐的 flag 值 |
| **服务有"心跳"/"回显"功能，按长度回显** | **Heartbleed 模式**——发负长度或超大长度请求，服务回显超出实际 payload 的内存。`HEARTBEAT -1` 是经典触发 | f1-03：`SETPAYLOAD` 后 `HEARTBEAT -1` → 泄露 ~4352 字节，flag 在 offset ~4096 |
| **命令集含 `BUILD`/`EXPORT`/`DUMP`** | 比对输出长度 vs 预期长度。**长度对不上 = 未初始化缓冲残留**——BUILD dump 整个固定大小缓冲，不管实际写了多少 | f1-04：`SETBODY hello` 后 `BUILD`（不加 header）→ 输出 99 字节但 body 只有 5 字节 → flag 在残留缓冲里 |
| **服务有"按偏移写入"功能（`COPY <off> <data>`）** | **负偏移**——`COPY -1 AAAA`。偏移变量没检下界，负偏移写到 buffer 前面的 guard/flag 变量 | f1-05：`COPY -1 AAAA` 破坏 buffer 前面的 guard 变量 → `REVEAL` 命令解锁，直接返回 flag |
| **任何 F1 服务，先 probe 所有命令** | 连上后逐个发命令（HELP 列出的 + 常见的 GET/PUT/SET/LIST/SHOW/READ/DUMP），看哪个返回异常长度或异常数据 | 所有 F1 题的第一步 |

**F1 通用探测模板**：
```bash
# 1. 连上，拿 banner + HELP
(echo "HELP"; sleep 1) | nc <ip> <port>
# 2. 逐个 probe 命令，注意输出长度
for cmd in "LIST" "DUMP" "STATUS" "PEEK" "HIST" "SHOW" "REVEAL" "EXPORT"; do
  echo "=== $cmd ==="; (echo "$cmd"; sleep 0.5) | nc <ip> <port> | wc -c
done
# 3. 找到异常长度输出 → xxd 看原始字节
(echo "<suspicious_cmd>"; sleep 1) | nc <ip> <port> | grep -oP 'flag\{[^\}]+\}|FLAG\{[^\}]+\}'
```

#### F2: 静态逆向 / 密码学破解（7/8 解出）

F2 的题目模式统一：下载一个 ELF 二进制（license 校验器 / 固件 / 加密器），里面有一个**被混淆/加密的 flag**，你要逆向出加密逻辑然后离线还原。**这些题几乎不需要运行时利用，纯静态分析 + Python 复现。**

| 观察到 | 立即试 | 命中案例 |
|--------|--------|----------|
| **`.rodata` 里短字节串（4-16B）看似乱码** | **单字节 XOR 全表 256 key 扫描**——7/13 题（超过一半）用了这个混淆。`python3 -c "for k in range(256): print(k, bytes(b^k for b in data))"` 看哪种 key 全可打印 | f2-02 key=0x73, f2-03 key=0x3c, f2-04 key=0x37, f2-08 key=0x4b, f2-07 key=0x3d |
| **XOR 解出的字符串像密码/key** | 用它当密钥解密 `.data` 段的密文。**先试 RC4**（最常见），再试 XOR 流，再试 TEA | f2-02：XOR 0x73 解出 `NESTED-RC4-KEY` → RC4 解密 38 字节密文 |
| **反汇编里看到 `0x9e3779b9`** | **TEA/XTEA** delta 常量。32 轮 Feistel（v0/v1 半字交替+轮密钥） | f2-08：XTEA 加密 5 个 block，key 从 FNV+ROL 派生 |
| **反汇编里看到 `0x1000193` + `0x811c9dc5`** | **FNV-1a 32-bit** 哈希。常用于从密码派生加密 key | f2-08：密码 ADMIN10 → FNV-1a → 派生 XTEA key |
| **反汇编里看到 `0x1505` 或 `5381`** | **djb2** 哈希（初始值 5381，乘 33）。有些用变体（乘 31/37 + 初始 0x1505） | f2-03：djb2 变体哈希密码 → 派生 76 字节 XOR key stream |
| **校验逻辑是状态机（转移表 + 编码公式）** | 提取转移表 → 找到从初始状态到"接受"状态的路径 → **反推每个位置该输入哪个字符**。常配一个 seed 字符串填充剩余位置 | f2-01：9 字符 key 穿越 0→1→...→8→15，剩余位置填 seed `st4t3_tr4c3_engine_seed_v1` |
| **`strings` 看到 "License accepted" 但运行没输出 flag** | **有 reveal/decrypt 函数但 main 不调用它**。两种打法：(a) GDB 在 reveal() 返回处断点读返回值；(b) 直接 patch binary 跳到 reveal | f2-06：Go 二进制有 `main.reveal()` 解密 flag 但 main 只打印 "License accepted" → GDB 断点 `0x47d33f` 读 `$rax`（字符串指针）+ `$rbx`（长度 38） |
| **`strings` 看到可疑命令名但不是明文** | XOR 解码后可能是隐藏后门命令。输入它触发隐藏的凭据输出 | f2-04：`.rodata` XOR 0x37 → `B4CKD00R`，输入触发 ROL/ADD/XOR 6 轮解密 |
| **二进制是 Go 编译的（`file` 显示 Go）** | Go 二进制 stripped 后符号全在！用 `go tool objdump` 或直接 `strings` 找 `main.<func>`。GDB 拦截比静态分析快 | f2-06：Go 1.20 ELF，`main.reveal` 在 `0x47d080` |
| **校验函数有 `jne`/`je` 跳转决定接受/拒绝** | **Patch 二进制绕过校验**：`jne` → `jmp`（`0x75`→`0xEB`），让任何输入都通过。然后用解出的 flag 验证 | f2-07：`jne` at `0x115f` → patch 成 `jmp`，绕过 FNV 校验 |
| **自解密 ELF / "Packed ELF"** | 程序内嵌 shellcode，运行时自解密但不输出 flag。静态提取 shellcode + 密码 → 离线复现解密过程 | f2-03：密码 `Tiandun2024!`(XOR 0x3c) → djb2 变体 → 派生 XOR key → 解密 shellcode → shellcode 再 XOR 0xa5 出 flag |

#### F2 通用逆向流程（7/8 题的标准步骤）

```
1. file validator && checksec validator && strings -a validator | head -50
2. 行为黑盒: ./validator AAAA → 看输出和 exit code
3. objdump -d -M intel validator > disasm.txt
4. 在 disasm.txt 里 grep 关键常量:
   grep -E "9e3779b9|1000193|811c9dc5|1505|5381|deadbeef" disasm.txt
5. 在 .rodata 里找 XOR 混淆的字符串:
   objdump -s -j .rodata validator | xxd → 手动试 256 个 XOR key
6. 在 .data 里找密文:
   objdump -s -j .data validator → 连续的非零字节块
7. 用 Python 复现加密逻辑，离线解密
8. 验证: 把解出的 key/flag 输入原二进制，看是否 "accepted"
```

> **f2-05 教训（F2 唯一未解出的 1/8）**：validator 是自定义 VM（opcode 派发表 + access code `VM_KEY07`），运行吐 31 字节密文。用已知明文前缀 `flag{` 推 keystream 后，穷尽了 LCG（ANSI/MSVC/glibc/borland/java，多 shift/seed）、Python MT19937、LFSR、CRC32-table —— **全部未还原**；未覆盖 Rabbit（pycryptodomex 3.20 缺）、Twofish/Serpent、SM4/Camellia。教训：(1) VM 题先**完整提取 opcode 表 + access code** 再猜加密，别跳过 VM 层直接猜密码；(2) 标准流密码族（LCG/MT19937/LFSR）排除后，优先试"冷门但题目暗示"的算法（Rabbit/SM4），而非继续穷举变体；(3) key material 要覆盖所有来源（`.rodata`、access code 本身、运行时派生值）。

#### 完整利用链示例

**f2-08（IoT 固件静态破解）**——XOR + FNV + XTEA 全链：
```
download firmware.bin
  → objdump -d: .rodata 7 bytes XOR 0x4b = "ADMIN10" (密码)
  → FNV-1a(ADMIN10) + ROL/XOR chain → 派生 XTEA key
  → .data 40 bytes (5×8B block) = XTEA 密文
  → XTEA 解密 → FLAG{x73a_f31st3l_k3y_5ch3d_fr0m_fw}
```

**f2-06（Go 二进制 GDB 拦截）**——程序不输出 flag 时的终极手段：
```
download validator (Go ELF)
  → strings: "GOLANG-2024-KEY" (license key), "main.reveal"
  → objdump: main.reveal() at 0x47d080 解密 flag 但 main 不打印
  → GDB:
    gdb -batch -ex "b *0x47d33f" -ex "r GOLANG-2024-KEY" \
        -ex 'x/s $rax' -ex 'p $rbx' ./validator
  → $rax 指向 flag 字符串, $rbx=38 (长度)
  → FLAG{g0_1t4b_d15p4tch_r0und5_r3v3rs3d}
```

**f1-03（Heartbleed 模式）**——TCP 服务内存泄露：
```
nc 10.0.181.112 9011
  → banner: heartbeat service
  → SETPAYLOAD hello
  → HEARTBEAT -1       (负长度触发过读)
  → 服务回显 ~4352 字节 (远超 payload)
  → flag 在 offset ~4096 处: flag{55c971dc-...}
```

#### 常量指纹速查表（反汇编里 grep 这些秒判算法）

| 常量 | 算法 | 命中题 |
|------|------|--------|
| `0x9e3779b9` | TEA/XTEA delta | f2-08 |
| `0x1000193` + `0x811c9dc5` | FNV-1a 32-bit | f2-08, f2-07 |
| `5381` / `0x1505` + `*33` | djb2 哈希（或变体） | f2-03 |
| `0x67452301` + `0xefcdab89` | MD5/SHA1 init | 通用 |
| `0x6a09e667` | SHA256 init | 通用 |
| `0xedb88320` | CRC32 reversed poly | 通用 |

#### XOR 单字节混淆速查（7/13 题用了这个）

| 题目 | XOR key | 解出的明文 |
|------|---------|-----------|
| f2-02 | `0x73` | `NESTED-RC4-KEY`（RC4 密钥） |
| f2-03 | `0x3c` | `Tiandun2024!`（密码） |
| f2-04 | `0x37` | `B4CKD00R`（隐藏命令） |
| f2-07 | `0x3d` | flag 本身（31 字节） |
| f2-08 | `0x4b` | `ADMIN10`（密码） |
| f2-03 内层 | `0xa5` | flag（shellcode 再加密层） |

**一句话：F2 题看到 `.rodata` 短乱码，先跑 256 key 全扫描，超过一半的概率直接出。**

#### f2-05 失败教训（虫洞和 ATX 都未解出）

f2-05 是**自定义 VM**（12 个 opcode 的字节码解释器），是目前唯一的"全场无人解出"的题。两个战队都失败了，但失败方式不同：

**虫洞**：尝试静态逆向 VM，96 分钟没搞清 opcode 语义 → 放弃。

**ATX**：完整静态还原了 VM（opcode 派发表 + 所有 handler 语义 + bytecode + 数据段），确认 VM 执行 100000 次循环只打印 31 个点、T@0x4020 全程不被写入 → 判定"VM 是纯诱饵" → 然后**穷举暴力破解 T 的加密**（单字节 XOR 全 256、RC4、双 key 组合、affine... 全部无果）→ 也放弃了。

**真正的方向（基于 f2-08 成功范式推断）**：
- VM **可能不是纯诱饵**——ATX 的静态 trace 可能漏了某个 store 路径
- 正确做法：**动态执行 `./f2-05.bin <access_code>` + gdb 在 VM 循环内/退出处反复 dump 全内存/寄存器，搜索 `flag{`/`FLAG{`**（f2-08 就是靠 gdb dump 拿到 flag 的）
- 当静态暴力破解穷举失败时，**必须回到动态执行 + gdb 内存取证**，而不是继续在静态密码学空间里猜

**教训**：
- 自定义 VM 题如果 opcode 表复杂（>8 个 opcode），优先尝试**动态执行 + gdb dump 内存**，而不是完整静态逆向
- **"VM 看起来是 decoy"不要轻信**——可能你的 trace 漏了写回路径。用 gdb watchpoint 监视数据段地址的写操作
- 静态暴力破解是最后的手段，不是第一选择——搜索空间太大（256^n），无锚点注定失败

#### 关键心态

- **F1 和 F2 的打法完全不同，第一步判断类型**：能 `nc` 交互 = F1（找内存缺陷）；只能 `/download` = F2（静态逆向）。别搞混。
- **F2 先 `strings` + `file` + 行为黑盒**，比直接扎进反汇编快 10 倍。密码/key 经常在 strings 里（只是 XOR 混淆了一下）。
- **XOR 单字节混淆是 F2 最高频模式**（7/13 题），看到 `.rodata` 乱码先跑 256 key 扫描。
- **程序不输出 flag 时用 GDB**：断点设在 decrypt/reveal 函数返回处，读返回值寄存器。f2-06 就是靠这个解的。
- **手写加密复现必须配 gdb ground-truth 校验**——每一步都在真二进制上验证中间值。
- **自定义 VM 是 F2 里最难的类型**，优先动态分析（dump 内存）而非完整静态逆向。

## 自动化漏洞发现（真实比赛重点）

> 真实比赛二进制占 20%，强调"漏洞挖掘"而非"CTF exploit 构造"。以下是自动化发现漏洞的方法论。

### 静态分析决策树

| 信号 | 工具 | 动作 |
|------|------|------|
| 有源码（C/C++/Rust） | `cppcheck --enable=all`、`clang-tidy`、`CodeQL` | 找 buffer overflow、use-after-free、null deref、整数溢出 |
| 只有二进制 | `angr`（符号执行）、`ghidra`（反编译+脚本） | angr 找可达错误状态；ghidra 脚本批量标注危险函数调用 |
| 多个二进制对比 | `diff` + `bindiff`（ghidra 插件） | patch diffing：对比新旧版本找修复了哪个漏洞 → 旧版本就是漏洞 |

### 动态漏洞发现

| 方法 | 工具 | 适用场景 |
|------|------|---------|
| **Fuzz** | `AFL++`、`libFuzzer`、`honggfuzz` | 有输入入口的程序；编译插桩后跑 fuzz 找 crash → 分析 crash 找漏洞 |
| **ASAN/MSAN** | `-fsanitize=address` / `-fsanitize=memory` | 编译时插桩，运行时报内存错误（溢出、UAF、未初始化读） |
| **Valgrind** | `valgrind --tool=memcheck` | 无法重编译的二进制；运行时检测内存错误 |
| **覆盖率引导** | `afl-cov` / `llvm-cov` | 找到未覆盖的代码路径 → 构造输入触发 → 可能藏着漏洞 |

### Fuzz 工作流（拿到一个二进制服务）

```bash
# 1. 识别输入格式（TCP 协议？stdin？文件？）
nc <ip> <port          # 看是否是 TCP 服务
file binary && strings binary | grep -i 'usage\|input\|file'  # 看输入方式

# 2. 如果是网络服务，用 AFL++ 的网络模式或写 harness
# harness.c: int main(){ char buf[4096]; int n=read(0,buf,4096); target_func(buf,n); }
afl-gcc harness.c -o harness afl-fuzz -i seeds/ -o out/ ./harness @@

# 3. 分析 crash
afl-fuzz 的 out/crashes/ 里有触发文件
gdb ./harness core  → bt(看栈) → 确定漏洞类型（溢出？格式化字符串？UAF？）

# 4. 构造 exploit 或验证漏洞存在
```

## 权限边界分析（真实比赛新增方向）

> 真实比赛强调"权限边界、数据流转"。关注程序如何在不同权限间切换、敏感数据如何流动。

### 权限提升路径

| 信号 | 漏洞 | 利用 |
|------|------|------|
| 二进制有 `setuid` 位（`file` 显示 setuid） | 以 root 运行的程序有漏洞 | 找程序内的命令注入/路径穿越/缓冲区溢出 → 以 root 身份执行 |
| 使用 `sudo` 运行，且程序调用 `system()`/`popen()` | PATH 劫持 | 修改 `PATH` 环境变量，让程序调用的"内部命令"指向恶意脚本 |
| 程序用 `capabilities`（`getcap` 查看）而非 root | capability 滥用 | `cap_setuid` → 可 `setuid(0)` 提权；`cap_dac_override` → 绕过文件权限 |
| 程序信任环境变量（`LD_PRELOAD`、`PYTHONPATH`、`JAVA_TOOL_OPTIONS`） | 库注入 | `LD_PRELOAD=malicious.so ./binary` 劫持库函数 |
| 容器逃逸信号：程序能访问 `/proc/1/root`、`/dev/sda`、capability `CAP_SYS_ADMIN` | 容器逃逸 | 挂载宿主磁盘 / 进入 namespace / exploit 内核漏洞 |

### 数据流转追踪

| 信号 | 动作 |
|------|------|
| 用户输入流到 `system`/`exec`/`popen`/`eval` | 追踪数据流，找注入点（命令注入） |
| 用户输入流到 `printf`/`syslog`/格式化函数 | 格式化字符串漏洞：试 `%x %x %x %s %n` |
| 用户输入流到 `strcpy`/`memcpy`/`sprintf` 且无长度检查 | 缓冲区溢出 |
| 用户输入流到 `SQL`/`template`/`XPath` 查询 | 注入类漏洞（SQL/SSTI/XPath） |
| 敏感数据（密码/key/flag）出现在日志/错误消息/内存 dump | 信息泄露：触发错误路径让程序打印敏感数据 |

### 符号执行实战（angr）

```python
import angr, claripy
proj = angr.Project('./binary', auto_load_libs=False)
state = proj.factory.entry_state()
simgr = proj.factory.simulation_manager(state)
# 找到 "flag" 打印路径（成功状态），避开 "wrong" 路径
simgr.explore(find=lambda s: b'Correct' in s.posix.dumps(1),
              avoid=lambda s: b'Wrong' in s.posix.dumps(1))
if simgr.found:
    print(simgr.found[0].posix.dumps(0))  # 打印触发成功的输入
```

适用：逻辑题、密码校验题（输入正确序列才输出 flag）。不适用：需要交互的网络服务、大状态空间。

## 二进制漏洞验证清单

- [ ] **确认是漏洞不是功能**：程序崩溃 ≠ 可利用；要看能否控制执行流或读敏感数据
- [ ] **确定漏洞类型**：栈溢出/堆溢出/UAF/格式化字符串/整数溢出/命令注入
- [ ] **验证可控性**：能控制 EIP/RIP？能控制写入内容？能控制命令参数？
- [ ] **确认能拿 flag**：能读 `/challenge/flag.txt`？能执行 `cat /flag`？能提权到 root？
- [ ] **远程可触发**：本地 crash 不算，要能通过网络输入触发

## 漏洞类型快速识别（PWN 信号→漏洞映射）

> 当逆向分析发现以下代码模式时，对应漏洞类型及其利用方向。

### 内存安全类

| 逆向特征 | 漏洞类型 | 利用方向 |
|---------|---------|---------|
| 循环边界用 `<=` 而非 `<`，或循环计数从 1 开始 | 差一错误 off-by-one | 覆盖相邻一个字节，通常是 canary 或长度域的最低字节，逐步扩展控制 |
| `malloc` 后直接使用，无 `memset`/`bzero` | 未初始化内存 | 堆分配复用上次释放的内存中残留数据，可泄露指针或篡改逻辑判断 |
| `free(ptr)` 后仍有代码路径解引用 `ptr` | 释放后使用 UAF | 重新分配相同大小内存填充恶意数据，通过悬垂指针执行控制流 |
| 有符号整数用于长度比较或数组索引 | 符号转换绕过 | 传入负数使 `if (len < MAX_SIZE)` 判断通过，实际作为大无符号数访问越界内存 |
| `read`/`memcpy` 长度来自用户输入且无上界校验 | 缓冲区溢出 | 直接覆盖返回地址或函数指针 |

### 逆向破解类

| 逆向特征 | 破解方向 | 操作 |
|---------|---------|------|
| 校验函数读取密钥流，密钥流依赖之前所有字节的接受状态 | 状态机密钥流 | 不能走捷径猜密钥，必须按程序逻辑逐字节模拟完整接受路径，在 GDB 中跟踪每次比较的真实期望值 |
| 校验函数分多个段独立验证密钥 | 分段校验 | 逐段暴力或推导，各段独立解出后拼接，每段通常字节空间很小 |
| 二进制先验证口令再处理后续数据 | 两阶段破解 | 先逆向口令算法独立攻破口令关，再处理后续加密数据，后续常用单字节 XOR 或简单流密码 |
| 自定义协议有 HELP/已知命令表 | 隐藏命令枚举 | 逐个尝试未在 HELP 中列出的常见命令名（debug、admin、backdoor、test、reset），观察响应差异 |
| 程序内嵌字节码解释器（dispatch loop + opcode table） | 自定义 VM | 字节码执行过程本身构造 flag，用 GDB dump 每步运算的中间值，跟踪 opcode 序列还原 flag 构造逻辑 |
| 校验函数对输入做哈希后比较，但哈希算法简单 | 可逆哈希 | 分析哈希算法是否可逆（如 Feistel 网络、简单算术），直接反推满足条件的输入 |
| 口令/密钥不以明文存储，而是由固件内嵌算法生成 | 口令还原 | 逆向提取生成算法并在本地复现，输入已知参数（序列号、设备 ID）计算出口令 |
| 校验逻辑对大小写不敏感 | 大小写无关比较 | 从二进制中提取期望字符串的字节值，忽略大小写差异构造匹配输入 |

### 分析工作流优化

拿到二进制后的推荐顺序：

```bash
# 1. 识别漏洞类型 — 静态特征扫描
checksec binary                          # 保护机制：NX/PIE/RELRO/canary
strings binary | grep -iE 'pass|key|flag|license|valid|check|admin|debug'
objdump -d -M intel binary | grep -E 'call|cmp|jmp' | head -50   # 关键调用和比较

# 2. 定位校验/处理函数 — 找到核心逻辑入口
# 在 GDB 中设断点观察比较的两个值
gdb -batch -ex 'break *<check_addr>' -ex 'run' -ex 'x/40bx $rsp' binary

# 3. 动态跟踪期望值 — 每次比较的真实"正确答案"
# 在 cmp 指令处断下，读寄存器/内存获取程序期望的输入值
gdb -batch -ex 'break *<cmp_addr>' -ex 'run' -ex 'info registers' -ex 'x/4bx $rdi' binary
```


