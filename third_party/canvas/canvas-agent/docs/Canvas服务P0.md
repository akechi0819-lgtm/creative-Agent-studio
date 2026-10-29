# 共享本机 Canvas 桥接服务

本文是当前桥接服务合同。早期 P0 文档描述的“每个服务实例绑定一个 `CANVAS_AGENT_PROJECT_ID`”已废弃；当前服务不读取该环境变量，也不把项目 ID 写进启动配置。

Canvas Agent 通过同一个本机服务连接多个实际 Canvas 项目。每个网页 SSE 连接用 `(projectId, clientId)` 标识；项目归属来自网页当前实际项目。服务只负责按目标转发工具和结果，不保存项目历史。项目、节点和图片由 Canvas 网页通过 Studio 本机存储持久化，因此多个项目共用同一个 Studio 数据目录，无需任务账本。

## 启动配置

服务只监听 `127.0.0.1`。启动器为共享实例提供：

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | 本机监听端口，取值为 1–65535 的整数 |
| `CANVAS_AGENT_TOKEN` | 当前实例访问令牌，不落盘、不写入日志 |
| `CANVAS_AGENT_INSTANCE_ID` | 服务实例标识，用于识别和诊断 |
| `CANVAS_AGENT_DATA_DIR` | 本机实例锁目录 |
| `CANVAS_AGENT_ORIGIN` | 唯一允许跨域访问的完整 HTTP(S) origin，不含路径 |

缺少上述变量、端口无效或 origin 含路径时，服务拒绝启动。同一数据目录已有活动实例时，新的启动会被拒绝；收到 `SIGINT` 或 `SIGTERM` 时服务关闭 SSE 连接并释放锁。

## HTTP 接口

`GET /health` 和 `GET /config` 不要求桥接令牌。其他接口使用 `x-canvas-agent-token`；SSE 的 `EventSource` 使用 `token` 查询参数。若请求带 `Origin`，必须与 `CANVAS_AGENT_ORIGIN` 完全一致。JSON 请求体最大 30 MB。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /health` | 返回实例状态及每个已连接 `(projectId, clientId)` 的画布状态和激活状态 |
| `GET /config` | 返回本机 URL、实例 ID 和 `hasToken`，不返回令牌或项目 ID |
| `GET /events?projectId=…&clientId=…&token=…` | 为指定实际项目建立 SSE 工具通道；未提供 `clientId` 时服务生成并在 `hello` 中返回 |
| `POST /canvas/state?projectId=…&clientId=…` | 更新该连接的画布快照；body 的 `projectId` 必须与查询参数一致，若 body 有 `clientId` 也必须一致 |
| `POST /canvas/activate?projectId=…&clientId=…` | 显式激活当前连接 |
| `POST /canvas/result?projectId=…&clientId=…` | 返回此项目和客户端的工具结果 |
| `POST /api/tools` | 按 body 的 `projectId` 与 `clientId` 向精确的网页连接派发工具 |

`/health` 示例：

```json
{
  "ok": true,
  "protocolVersion": 1,
  "instanceId": "本机实例 ID",
  "hasCanvas": true,
  "clients": 2,
  "targets": [
    { "projectId": "project-a", "clientId": "browser-a", "hasCanvas": true, "active": false },
    { "projectId": "project-b", "clientId": "browser-b", "hasCanvas": true, "active": true }
  ]
}
```

服务不把工具请求改派给其他项目或客户端。请求指定的二元组未连接时返回冲突；多个连接同时存在时，调用方必须明确目标。相同 `clientId` 可以出现在不同项目中，它们的状态与待处理请求彼此隔离。对同一二元组重连会关闭旧 SSE、清除旧状态并拒绝旧待处理请求；旧连接迟到的关闭或结果事件不会影响新连接。断开当前激活目标后，不会自动切换到其他项目。

SSE 建立后发送 `hello`（包含 `ok`、`instanceId`、实际 `projectId` 与 `clientId`），并每 15 秒发送 `ping`。工具事件包含 `requestId`、`name` 与校验过的 `input`。浏览器须以相同的查询参数向 `/canvas/result` 回传 `{ "requestId", "result" }` 或 `{ "requestId", "error" }`。工具调用等待上限为 30 秒；超时不会自动重试。

只有 `site_navigate` 与 `canvas_list_projects` 可以在目标连接尚未上报画布快照时使用，例如没有当前画布状态的素材库页面。其他画布工具需要同一目标的状态快照。未连接目标、错配项目或客户端不会回退到任意活动标签页。

## 图片工具边界

`canvas_read_image` 从指定网页的图片节点读取实际数据并返回 Data URL 与尺寸。它不生成图片，也不调用模型服务。`canvas_import_image` 把宿主提供的 PNG/JPEG/WebP 数据导入本机 Canvas。

- `canvas_crop_image`、`canvas_split_image`、`canvas_resample_image`、`canvas_stitch_images` 与 `canvas_compose_images` 由 Canvas 网页在浏览器中处理像素；服务只校验并转交参数及结果。
- 拼图按节点给定顺序使用原始像素尺寸，不缩放；合成结果限制长边不超过 16384 像素、总像素不超过 32×1024×1024。
- 直接像素工具不调用收费生成 API。图片生成是另一项明确工具操作，不属于这些像素工具。

## 本地验证

```bash
npm test
npm run build
```

Canvas Agent 测试使用本地连接夹具，覆盖多项目隔离、精确目标派发、重连清理、空状态素材库导航/项目列表、HTTP 鉴权与直接像素工具；这些测试不触发真实图片或视频生成。

仓库集成测试 `tests/shared-canvas.test.mjs` 使用临时 `STUDIO_DATA_DIR`、Playwright 本机浏览器和浏览器生成的 PNG 夹具，验证多个项目共享存储、服务重启后历史/节点/图片恢复，以及 MCP stdio 的读写工具。测试会拦截所有非本机网页 origin 的请求，不配置或调用真实图片 API。它验证源码工作区里的本机流程，不代表员工设备、打包运行环境或外部模型服务已验收。
