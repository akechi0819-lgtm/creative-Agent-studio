# Creative Agent Studio 内置 Canvas

本目录保留上游 Infinite Canvas 的画布前端，并裁剪为 Creative Agent Studio 使用的纯绘图副本。上游作者为 basketikun；固定基线为 `basketikun/infinite-canvas@3a6b64b602ad062b29fac66902ed18a7ef5fd9dc`。许可证、版本和历史变更见 [LICENSE](LICENSE)、[VERSION](VERSION) 和 [CHANGELOG.md](CHANGELOG.md)。

## 启动

要求 Node.js 22 或更新版本。在仓库根目录运行：

```bash
node scripts/canvas.mjs start
node scripts/canvas.mjs status
node scripts/canvas.mjs stop
```

启动器负责启动画布网页和本机绘图桥接，为每个实例生成并传入 `PORT`、`CANVAS_AGENT_TOKEN`、`CANVAS_AGENT_PROJECT_ID`、`CANVAS_AGENT_INSTANCE_ID`、`CANVAS_AGENT_DATA_DIR`、`CANVAS_AGENT_ORIGIN`。不需要手动启动桥接进程。

## 工具协议

桥接服务使用协议版本 `1`，通过本机 HTTP/SSE 将带有明确 `projectId`、`clientId` 的工具调用转发给对应画布网页。接口、事件、请求示例和图片读取工具见 [Canvas 服务 P0](canvas-agent/docs/Canvas服务P0.md)。

本副本不启动 Agent、Codex 或 Claude，不注册全局 MCP，也不使用 `npx ...@latest` 安装或启动旧服务。
