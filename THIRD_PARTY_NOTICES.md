# 第三方声明

Gatyusha 原创代码采用 GNU AGPLv3（`AGPL-3.0-only`），见 [LICENSE](LICENSE)。以下第三方依赖、衍生内容和可选组件仍适用其各自许可证；项目级许可不替换这些组件的版权与许可声明。

Gatyusha 的任务编排与业务服务使用 Pi SDK 执行 Agent 会话，并依赖 MCP SDK、Next.js、React、PostgreSQL 等组件。精确依赖和版本见各模块 package-lock.json / go.sum。

- 方法论衍生内容：file/legal/methodology/LICENSE.txt；安装时复制到运行资源的 licenses/methodology。
- Go 模板运行时及 Go 标准库：pihost/src/domains/agents/templates/GO-LICENSE、pihost/vendor/go-template/LICENSE。
- 业务建模衍生内容：pihost/src/domains/modeling/THIRD_PARTY_LICENSE.txt。
- 指纹适配来源及保留声明：pihost/resources/fingerprints/；完整指纹数据不随基础版分发。
- PoC 数据接口及来源说明：pihost/resources/pocs/NOTICE.md；完整数据不随基础版分发。
- 网络组件安装时复制各组件许可证；逆向组件由用户按需安装并适用各自许可。

原始工程来自维护者提供的源码快照。内部交付资料和原始快照清单不作为新项目的安装或运行依据。
# Shadcn CSS

`web/src/styles/vendor/shadcn.css` is copied from shadcn 4.12.0 (MIT).
The original license is included in `web/public/licenses/shadcn.txt`. The development CLI is not a runtime dependency.

