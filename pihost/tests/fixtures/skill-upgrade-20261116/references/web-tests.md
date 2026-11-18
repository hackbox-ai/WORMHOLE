# 专项测试索引

按当前入口特征加载匹配方法，不一次读取整套。每项执行正常基线、单变量实验、负对照和实际效果核验；同接口不同筛选参数/位置/操作分别记录。

| 触发特征 | 方法 | 核心验证 |
| --- | --- | --- |
| SPA/chunk/sign/加密ID | [JS 接口与签名](${SKILL_DIR}/references/js-recon.md) | 合法签名与接口清单 |
| 用户/租户/订单/附件ID | [对象授权矩阵](${SKILL_DIR}/references/object-authz.md) | A/B/匿名 × OA/OB/OX |
| role/owner/tenant/price字段 | [批量赋值](${SKILL_DIR}/references/mass-assignment.md) | 复读持久状态与真实权限 |
| 登录/改密/绑定/2FA | [认证与会话](${SKILL_DIR}/references/auth-session.md) | 前置证明与最终状态 |
| 401/403/400/405、路径变体 | [过滤层与控制器](${SKILL_DIR}/references/filter-gateway.md) | 合法体、SPA排除、有序变体 |
| 查询/排序/过滤JSON | [查询注入](${SKILL_DIR}/references/query-injection.md) | 真/假条件与canary |
| 模板/EL/系统命令 | [模板与命令](${SKILL_DIR}/references/template-command.md) | 实际无害求值/执行 |
| URL/预览/回调/JWKS | [SSRF](${SKILL_DIR}/references/ssrf.md) | DNS/HTTP归因及影响边界 |
| HTML/DOM/富文本 | [XSS](${SKILL_DIR}/references/xss.md) | 上下文与浏览器真实执行 |
| 上传/下载/STS/预签名 | [文件与对象存储](${SKILL_DIR}/references/files-storage.md) | 完整链与归属/路径边界 |
| JWT/OAuth/OIDC/SAML | [身份协议](${SKILL_DIR}/references/identity-protocols.md) | 签名与用途/会话绑定 |
| FIDO/Passkey | [WebAuthn/FIDO](${SKILL_DIR}/references/webauthn.md) | challenge/RP/账号绑定 |
| SMS/email/Magic Link | [消息与一次性凭据](${SKILL_DIR}/references/messages.md) | 送达、绑定与最终认证 |
| 订单/券/积分/审批 | [业务不变量](${SKILL_DIR}/references/business-logic.md) | 服务端结算与状态链 |
| 一次性/幂等/TOCTOU | [竞态](${SKILL_DIR}/references/race.md) | 串行→小并发→最终账本 |
| GraphQL/WebSocket | [查询与实时协议](${SKILL_DIR}/references/graphql-websocket.md) | resolver/消息逐项授权 |
| CORS/CSRF/Host/redirect | [浏览器信任边界](${SKILL_DIR}/references/browser-trust.md) | 真实跨站读写 |
| CDN/cache/HTTP2/framing | [缓存与解析](${SKILL_DIR}/references/cache-http.md) | 干净独立请求复现 |
| XML/XSLT/序列化/深合并 | [解析器](${SKILL_DIR}/references/parsers.md) | 输入可达到sink和实际效果 |
| SCM/密钥/CVE/DNS | [暴露与组件](${SKILL_DIR}/references/exposure-components.md) | 内容/作用域/部署前提 |
| 云助手/执行工具 | [Agent执行边界](${SKILL_DIR}/references/agent-execution.md) | 真实执行与独立隔离影响 |

## 覆盖与停止

NEW未测；TESTING验证中；DONE有正常基线、适用实验与对照；BLOCKED缺身份/工具/前置；DEFERRED超预算或低优先级。抓流量、读JS和一个接口200不等于整类DONE。两轮无增益停止同一假设，保留其他适用类型，不把整个任务限定三次请求。

## 实验交接

每个结果保存主体/角色/租户、对象归属、方法/参数位置、正常请求、唯一改动、负对照、实际私有标记/最终状态、恢复、预算与未测边界。枚举、认证、对象授权、持久写、执行、影响是不同结论。没有匹配业务特征不强行勾专项。
