# Canvas 绘图桥接服务

本目录提供连接单个 Infinite Canvas 项目网页的本机 HTTP/SSE 工具服务，不启动 Agent、Codex、Claude 或 MCP。

Node.js 需为 22 或更新版本。由项目启动器提供实例环境变量；HTTP 接口和事件格式见 [Canvas 服务 P0](docs/Canvas服务P0.md)。

开发验证：

```bash
npm ci
npm test
npm run build
```
