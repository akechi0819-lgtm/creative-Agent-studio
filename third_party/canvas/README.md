# Creative Agent Studio 内置 Canvas

本目录保留上游 Infinite Canvas 的画布前端，并裁剪为 Creative Agent Studio 使用的纯绘图副本。上游作者为 basketikun；当前同步到 `basketikun/infinite-canvas@9cd3deacbcc598361807afc16c059a80dd18b6f9`，本次比较基线为 `3a6b64b602ad062b29fac66902ed18a7ef5fd9dc`。许可证、版本和历史变更见 [LICENSE](LICENSE)、[VERSION](VERSION) 和 [CHANGELOG.md](CHANGELOG.md)。

从比较基线到当前上游提交没有画布或桥接功能变化；差异是 v0.20.0 变更记录的发行标题，以及上游 README 新增的赞助商介绍和对应标志。本副本保留标志资源，不引入赞助展示；Studio 定制仍提供任务隔离的 HTTP/SSE 绘图桥接，并移除 Agent、Codex、Claude、全局 MCP 和代理部署入口。

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
