# Canvas 服务 P0

本服务把工具调用转发到一个明确项目的浏览器标签页，再把浏览器结果返回给 HTTP 调用方。Node.js 最低版本为 22。工具参数沿用 `src/canvas/schemas.ts`，常见画布动作沿用 `src/canvas/operations.ts`。

服务只监听 `127.0.0.1`。进程不读取或写入 `~/.infinite-canvas`，不启动 Agent/Codex/Claude，不注册全局 MCP。服务数据目录只存放单实例锁文件 `canvas-agent.lock`；收到 `SIGINT` 或 `SIGTERM` 时会关闭现有 HTTP/SSE 连接并释放本实例锁。若持锁进程已结束，下一次启动会清理过期锁。

## 启动环境

项目启动器为每个画布项目传入以下环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | 本机监听端口，取值为 1–65535 的整数 |
| `CANVAS_AGENT_TOKEN` | 当前实例的访问令牌，不落盘、不写入日志 |
| `CANVAS_AGENT_PROJECT_ID` | 此实例唯一允许访问的画布项目 ID |
| `CANVAS_AGENT_INSTANCE_ID` | 服务实例标识，用于锁和状态识别 |
| `CANVAS_AGENT_DATA_DIR` | 此实例独立的数据目录，用于单实例锁 |
| `CANVAS_AGENT_ORIGIN` | 唯一允许跨域访问的完整 HTTP(S) origin，不含路径 |

缺少任一变量、端口无效或 origin 含路径时，服务拒绝启动。相同数据目录中的第二个活动实例会被拒绝；监听失败也会释放锁。

## HTTP 接口

除 `/health`、`/config` 外，接口必须携带 `x-canvas-agent-token` 请求头。SSE 的 `EventSource` 使用 `token` 查询参数。浏览器的 Origin 必须与 `CANVAS_AGENT_ORIGIN` 完全一致。请求体使用 JSON，最大 30 MB。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 查看协议版本、实例和项目 ID、连接数量及每个已连接客户端的项目、画布和激活状态 |
| `GET /config` | 返回本机 URL、项目/实例 ID 和 `hasToken`，不返回令牌 |
| `GET /events?projectId=…&clientId=…&token=…` | 建立 SSE 工具事件通道；未提供 clientId 时由服务生成，并通过 hello 返回 |
| `POST /canvas/state?projectId=…&clientId=…` | 上报画布状态；JSON body 必须带相同的 `projectId` |
| `POST /canvas/activate?projectId=…&clientId=…` | 将客户端标记为当前激活目标 |
| `POST /canvas/result?projectId=…&clientId=…` | 返回浏览器处理的工具结果 |
| `POST /api/tools` | 校验工具参数并向指定浏览器客户端派发调用 |

所有画布状态、SSE 和工具操作都会检查 projectId 是否等于 `CANVAS_AGENT_PROJECT_ID`。状态、激活、结果和工具调用还要提供当前 SSE 连接的 clientId；缺失或失效时返回错误，不会切换到其他标签页。

`/api/tools` body 格式：

```json
{
  "name": "canvas_create_text_node",
  "input": { "text": "画布内容" },
  "projectId": "当前项目 ID",
  "clientId": "SSE hello 返回的客户端 ID"
}
```

成功时响应 `{ "ok": true, "result": ... }`。工具调用会在指定 SSE 通道发出 `tool_call` 事件，事件包含 `requestId`、`name` 和已校验的 `input`。浏览器应使用相同的 projectId/clientId 向 `/canvas/result` 回传 `{ "requestId", "result" }`；发生错误时回传 `{ "requestId", "error" }`。请求等待上限沿用上游的 30 秒。

### 图片读取工具

`canvas_read_image` 的输入为 `{ "nodeId": "图片节点 ID" }`。服务把工具名和输入原样发送给指定浏览器，浏览器从节点存储读取图片并回传实际图片 Data URL 及 `naturalWidth`、`naturalHeight`。服务只转交结果，不生成图片、不调用收费生成 API。

### 像素合成与宿主图片导入

- `canvas_stitch_images` 接收 2–20 个图片节点 ID 和横向/纵向方向，按列表顺序使用原始像素尺寸拼接，不缩放；`gap` 默认为 0，背景默认为透明。输出为一张 PNG。
- `canvas_compose_images` 接收底图和 1–20 个贴图层。每层指定图片节点 ID 和完整落在底图内的整数像素矩形；默认 `fit=contain`、`smoothing=nearest`。可选 `clear` 先清除完整目标矩形再填充 `#RRGGBB` 或 `#RRGGBBAA`，随后按图层顺序贴图。
- 两种合成都拒绝长边超过 16384 像素或总像素超过 32×1024×1024 的结果，不会自动缩小。浏览器在处理前后核对源节点仍存在、元数据未变且图片字节一致；只有校验通过后才上传结果、添加新节点并连回去重后的源节点。失败时清理本次上传的结果图。
- `canvas_import_image` 接收宿主生成的 `nodeId`、标题和 PNG/JPEG/WebP base64 data URL，在浏览器本地上传并添加图片节点，不调用 AI。若 ID 已存在，只在图片字节完全一致时复用；不一致或节点类型不同则拒绝。

合成工具回传 `operation`、`sourceNodeId`、去重后的 `sourceNodeIds` 和输出节点的 ID/像素尺寸；导入工具回传 `operation=import`、源节点 ID 和图片节点像素尺寸。结果不携带图片 URL 或令牌。

## SSE

连接后服务发送 `hello` 事件，data 只有 `ok`、`instanceId`、`projectId`、`clientId`。之后每 15 秒发送一次 `ping`。浏览器执行工具后使用 `tool_call` 事件处理，并用 `/canvas/result` 返回结果。

## 验证

```bash
npm ci
npm test
npm run build
```

测试覆盖 env 校验、项目与客户端隔离、HTTP token、画布状态及工具结果往返；不触发图像或视频生成。
