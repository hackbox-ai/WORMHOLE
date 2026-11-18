# Go 模板编解码执行器

该目录将 Go 标准库 text/template 和 JSON 编解码封装为独立命令，供通知与 Webhook 使用，提供 validate、render 和 wire 操作。wire 保留重复 JSON 键、数字字面量及精度。

业务编排、渠道管理、投递与网络请求由 TypeScript 宿主负责；编解码器不包含 Agent 运行时。

在本目录使用 Go 1.26 构建：

```sh
GATYUSHA_TEMPLATE_GO=go sh build.sh
```

compiler.txt 记录实际编译器版本，codec.sha256 记录 Linux/Windows amd64 产物散列。修改源码后必须重新构建，宿主加载时验证散列。其他平台需要另行构建和验证。

Node 通过单并发队列启动编解码器，以 JSON stdin/stdout 交互，不提供模板宿主方法或扩展 IO 函数。单次执行上限为 5 秒；取消会终止并等待子进程退出。这些限制不等于操作系统进程沙箱。

Go 标准库许可证保留在 LICENSE。通知与 Webhook 测试覆盖模板渲染、非法字段与语法、重复 JSON 键、数值边界、递归和实际 HTTP 字节。
