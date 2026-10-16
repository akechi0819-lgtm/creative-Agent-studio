# AGENTS.md

## 裁剪边界

- 本目录是 Creative Agent Studio 内置的 Canvas 纯绘图副本，保留画布前端和 `canvas-agent` HTTP/SSE 工具桥接。
- 唯一启动入口是仓库根目录的 `node scripts/canvas.mjs`；启动器为每个实例提供独立 token、项目 ID、实例 ID、数据目录和允许的网页 Origin。
- 工具调用必须校验显式 `projectId` 和目标 `clientId`，不得回退到其他项目或标签页。不得读写 `~/.infinite-canvas`。
- 不得恢复 Agent、Codex、Claude 启动路由或实现、全局 MCP 注册、旧代理包及其 `npx ...@latest` 启动路径。
- 运行环境要求 Node.js 22 或更新版本。桥接依赖使用 `canvas-agent/package-lock.json` 固定；依赖变更后使用 `npm ci`，P0 工作按需运行 `npm test` 和 `npm run build`。
- 保留上游许可证、作者信息、版本号及已发布的变更记录；新增项目文档使用中文并保持简单。
