# Creative Agent Studio — Company Lite

`codex/company-lite` 是面向公司员工的 WorkBuddy 创作能力包。WorkBuddy 承担全部对话、推理、制作单确认和工具调度；Company Lite 提供纯 CLI 安装状态、本机共享 Canvas/MCP 绘图工具和导出能力。

**状态：施工中，WorkBuddy、Teedy 员工账号和员工设备仍待验收。** 已完成一次经本地 Canvas MCP 发起的真实图片请求：上游 HTTP 200，耗时 20.198 秒，本地图片完整保存耗时 25.892 秒；MCP 准备画布耗时 1.051 秒。主代理已实际打开检查验收图，图像内容正确且没有生成文字。该单次结果不是约 20 秒的普遍时延承诺，也不代表目标设备验收。

## 当前产品边界

- WorkBuddy 是唯一对话、推理和任务上下文宿主。一个 WorkBuddy 对话线程承载一项创作工作；不建立独立任务管理、审批或确认账本。
- 本机 Canvas 是跨线程共享的持续工作空间，保留历史项目、生成图片和排版编辑状态，员工可查找并继续旧作品。图片 API 配置和绘图连接跨任务复用，不要求每项工作重复配置。
- 用户在 WorkBuddy 对话中澄清需求、选择参考资料、确认制作单、审核实际成品并批准导出。Canvas/MCP 执行绘图及像素操作；不能将 Canvas 历史项目当作另一项工作的需求或批准依据。
- WorkBuddy 通过公司现有云端 Teedy MCP 搜索并实际下载用户选定的材料。不修改 Teedy 内容、标签或 ACL；材料来源和用途留在当前 WorkBuddy 对话上下文中。
- Canvas 本机服务直接调用员工已配置的图片 API。Company Lite 不带独立聊天、设置网页、DSH、基础对话 API、全局素材库或全局 DNA。
- Company Lite 使用独立本机运行数据目录保存共用配置、Canvas 历史和服务状态；不迁移旧版任务系统或其他版本的 Canvas 数据。

## WorkBuddy 安装与运行

WorkBuddy 主界面是安装、配置和创作入口。员工包目标提供 `Studio.command`／`Studio.cmd` 及 `Start.command`／`Start.cmd` 包装器，均使用包内 Node；`Start status` 返回 setup 状态，包装器不打开浏览器。Canvas 是唯一浏览器界面，可查看和继续历史作品，也可由 WorkBuddy 在确认制作单后打开。正式员工包包含必要生产依赖和预编译 Canvas；员工无需安装 Git、npm、Python 或编译工具。员工包及目标设备体验仍待验证。

在 WorkBuddy 本地任务中把 Company Lite 根目录选为工作目录，再显式要求读取本文件、[AGENTS](AGENTS.md)、[代理宿主使用说明](docs/代理宿主使用.md)和创作 Skill。员工包用 `Start.cmd status`／`./Start.command status`（包内 Node）；源码开发可运行 `node scripts/setup.mjs status`。首次安装、配置及故障修复时，Agent 简洁展示以下五项真实状态：

1. 能力包就绪。
2. Canvas 组件就绪，且 WorkBuddy 已实际调用共享 Canvas MCP 的 `canvas_status`。
3. WorkBuddy 使用现有只读 Teedy MCP 完成实际探测并记录工具名；此状态来自宿主报告，不是安装包独立验证。
4. 图片 API 已配置并通过非生图连接检查。
5. 当前整体就绪状态和待处理操作。

Agent 自动推进已有可执行的检查，只在需要本人登录、添加 WorkBuddy MCP、员工复制图片 API Key 或宿主审批时等待；不要求每步另发命令或重复确认。日常创作不重复展示安装清单。Canvas 第 2 步未就绪时，运行 `Studio.cmd mcp-config`／`./Studio.command mcp-config`，将生成的无密钥 stdio 配置通过 WorkBuddy 官方 MCP 界面添加，然后实际调用 `canvas_status`。官方界面入口为“插件 → MCP 服务器 → 配置 MCP”；不自动猜测或写入 WorkBuddy 配置路径。[WorkBuddy MCP 说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)

Teedy 检查须先实际调用一个现有只读工具，再由 Agent 使用 `Start.cmd report-workbuddy connected <工具名>`／`./Start.command report-workbuddy connected <工具名>` 记录结果。图片服务配置优先走本机剪贴板入口：员工在服务页面复制 Key 并在 WorkBuddy 明确说“已复制”后，Agent 运行 `Start.cmd configure-image @image-config.json --key-from-clipboard`／`./Start.command configure-image @image-config.json --key-from-clipboard`，其中 JSON 只含 `expectedRevision`、`image.baseUrl`、`image.model`；随后调用 `Start check-image`。命令读取一次本机剪贴板，不显示或写入 Key。Windows 剪贴板能力仍待设备验证。管理员也可使用本机受限权限私有 JSON。不得让员工把 API Key 粘贴到 WorkBuddy 对话、命令行或仓库。

`Studio status`／`start`／`open @JSON`／`stop`／`mcp-config` 是共享 Canvas 服务命令；WorkBuddy 创作时优先调用 MCP `canvas_open`（`mode` 为 `recent`、`new` 或 `choose`，也可指定现有 `projectId`）。`canvas_status`、`canvas_list_projects`、`canvas_run_generation`、`generation_get_status`、`canvas_read_image`、`canvas_import_file`、`canvas_save_image` 和像素工具由同一个本机 Canvas MCP 提供。

图片 Key 不进入 WorkBuddy 对话、命令参数或安装日志。Agent 只能在员工明确说明已复制当前 Key 后调用剪贴板配置命令一次；不得自行读取剪贴板。管理员私有 JSON 路径仅用于本机已有受限配置。

## 一次创作的宿主流程

1. 在当前 WorkBuddy 线程中收集需求、受众、规格和本次明确提供的品牌要求；对关键缺口直接向用户询问。
2. 通过现有 Teedy MCP 搜索材料，展示候选并由用户选用。需要作参考的材料必须实际下载；不把搜索摘要或 URL 当作原件。保持材料出处和用途可在当前线程追溯。
3. WorkBuddy 在对话中整理文案和制作单，取得用户对准确当前版本的明确确认。确认存在 WorkBuddy 对话中，不写入独立任务账本。
4. 制作单确认且用户授权出图后，调用 `canvas_open` 按用户意图新建或继续历史项目；只有 Teedy 原件已实际下载后才用 `canvas_import_file` 导入。出图用 `canvas_run_generation`，它应立即返回 `submitted` 和 `nodeId`；之后用 `generation_get_status` 读取异步结果。未知状态时先查状态，不重复提交收费请求。
5. 用 `canvas_read_image` 返回的实际图片内容进行读图，核对准确文案、手机可读性、品牌表达、主题和修改位置。修改后重新读图；用户在对话中查看最终成品并明确批准后再调用 `canvas_save_image` 导出。

配置检查不触发生图。生成状态未知时，先通过 MCP 查询当前节点，不重复提交可能收费的请求。

## 在 WorkBuddy 中首次打开能力包

WorkBuddy 本地工作目录选择与 Skills 页面导入是两项操作。官方[新建本地任务说明](https://intl.cloud.tencent.com/zh/document/product/1316/84504)列出工作目录和技能选择；官方[技能说明](https://intl.cloud.tencent.com/zh/document/product/1316/84503)支持本地 Skill 导入，但未公布项目 Skill 目录的精确路径。本仓库不假设 `.agents/skills` 会自动发现，也不复制到未经证实的 `.workbuddy` 或 `.codebuddy` 路径。

首次使用时，先将 Company Lite 根目录选为本地任务工作目录，再发送：

> 请从当前 Company Lite 工作目录读取 README.md、AGENTS.md、docs/代理宿主使用.md、.agents/skills/creative-studio/SKILL.md 和对应 reference。员工包通过 Start/Studio 包装器读取真实 setup 状态；源码开发才直接用 Node。仅在首次安装、配置或故障修复时展示五项 setup 状态，自动完成可执行检查，不逐项等待确认。缺少 Canvas MCP 时，用 Studio mcp-config 生成配置并通过 WorkBuddy 官方 MCP 界面添加，再实际调用 canvas_status。Teedy 状态须来自实际只读工具探测。配置图片 API 时，只有在我明确说已复制服务 Key 后，才运行 configure-image 的 --key-from-clipboard 一次；不要自行读剪贴板，也不要让我把 Key 粘贴到聊天。制作单、用户确认和批准留在本 WorkBuddy 线程；绘图使用跨线程共享的本机 Canvas/MCP。出图返回 submitted/nodeId 后用 generation_get_status 追踪，不重复提交未知状态的请求。所有本地命令从当前能力包工作目录运行。

如果 WorkBuddy 无法读取当前能力包或无法调用 setup／Canvas MCP 工具，应如实说明并停止相关操作；不借用其他对话线程的需求或批准。Canvas 历史项目仍可按当前用户意图选择。员工包、WorkBuddy 登录、Teedy 公司账号、Windows 设备和 Canvas 目标设备实测均待验证；已成功的单次图片生成仅证明当次请求与本机保存。

## 文档入口

- [Company Lite PRD](Creative_Agent_Studio_PRD.md)：当前产品边界和主流程。
- [开发与施工计划](开发与施工计划.md)：当前施工与验证节点。
- [工程进度](docs/工程进度.md)：真实状态与证据边界。
- [代理宿主使用](docs/代理宿主使用.md)：WorkBuddy、Teedy、共享 Canvas/MCP 使用流程。
- [创作 Skill](.agents/skills/creative-studio/SKILL.md)：宿主执行规则。
- [文档导航](docs/README.md)：当前说明与旧版历史证据的区分。
