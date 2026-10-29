---
name: creative-studio
description: 在 Company Lite 中由 WorkBuddy 对话线程主持创作，使用现有 Teedy MCP 和跨线程共享的本机 Canvas/MCP。
---

# 使用边界

先阅读能力包根目录的 `README.md`、`AGENTS.md`、`docs/代理宿主使用.md` 和 `docs/工程进度.md`。命令从当前 WorkBuddy 任务明确选定的 Company Lite 根目录运行。

WorkBuddy 对话线程是本次工作的唯一上下文，负责需求、材料用途、品牌要求、文案、制作单、确认、读图和批准。Canvas 是跨线程共享的通用工具，保留历史项目、生成图片、排版状态、图片 API 配置和绘图连接；可按当前用户意图找回或继续项目，但不能自动继承旧线程的要求或批准。不建立任务 ID、任务账本或独立审批系统。

# 安装状态与凭据

员工包用 `Start.cmd status`／`./Start.command status` 查看状态（包内 Node）；源码开发可运行 `node scripts/setup.mjs status`。只在首次安装、配置或故障修复时简洁展示五项：能力包、本机 Canvas 组件及 MCP 实际连通、WorkBuddy 对现有 Teedy 只读 MCP 的实际探测报告、图片 API 配置及连接检查、总体就绪。日常创作不重复安装清单；宿主报告不是安装包独立验证。

若 Canvas MCP 尚未接通，运行 `Studio.cmd mcp-config`／`./Studio.command mcp-config`，将无密钥的 stdio 配置通过 WorkBuddy 官方界面“插件 → MCP 服务器 → 配置 MCP”添加；再实际调用 `canvas_status`。该调用自动保存不含密钥的检查记录，无需额外确认。不猜测或写入 WorkBuddy 配置路径。

Teedy 状态只在 WorkBuddy 实际调用公司现有只读工具后记录：`Start.cmd report-workbuddy connected <工具名>` 或 `failed [工具名]`。不得从 Teedy 搜索摘要推断原件已下载。

图片 API Key 用剪贴板路径：先等员工本人从服务页面复制 Key 并在当前对话明确说“已复制”；随后准备只含 `expectedRevision`、`image.baseUrl`、`image.model` 的 JSON，再运行 `Start.cmd configure-image @image-config.json --key-from-clipboard`（macOS 使用 `./Start.command`）。此命令只读取一次本机剪贴板，禁止自行读取或回显 Key。Windows 剪贴板能力待设备验证。已有本机私有配置可用 `configure-image @私有JSON文件`；不得将 Key 放入聊天、命令参数、仓库或日志。最后运行 `Start check-image`；它不发出图片生成请求。

# WorkBuddy 线程内的创作

1. 在当前对话收集目标、受众、规格、品牌要求和文案边界；对会改变产出的关键缺口提问，不从其他线程推断。
2. 需要 Teedy 参考时，使用现有云端只读 MCP 搜索并展示候选。用户选择后用 MCP 实际下载原件，将来源、用途和事实边界留在当前对话；不得修改 Teedy 内容、标签或 ACL。
3. 在当前对话整理文案和制作单，展示准确版本并取得用户明确确认。影响文案、来源或版式的修改需重新确认。
4. 制作单已确认且需要绘图时，用 `canvas_open` 按用户意图选择 `recent`、`new`、`choose` 或一个指定历史 `projectId`。只有已实际下载的 Teedy 原件才可用 `canvas_import_file` 加入当前画布。
5. 用户明确授权收费出图后调用 `canvas_run_generation`。它应快速返回 `{submitted, nodeId}`，实际生成异步继续；用 `generation_get_status` 查询该节点的进度和最终状态。状态未知时先查询，不重复提交收费请求；失败后只有用户在当前对话再次明确授权，才重试。
6. 用 `canvas_read_image` 返回的实际图片内容读图，核对文字、移动端可读性、品牌表达和修改位置。用户要求局部修改时只改指定内容并重新读图。缩略图或生成状态不算读图。
7. 用户在当前 WorkBuddy 对话查看并明确批准最终成品后，才调用 `canvas_save_image` 导出。

Canvas MCP 还提供创建与修改节点，以及裁切、分割、重采样、拼贴导入、拼接、组合等像素操作；使用现有功能，不把它们说成新能力。Canvas 中的历史记录不代表当前线程的素材来源、确认或批准。

# 当前验证边界

一次本地 Canvas MCP 真实图片生成已成功：上游 API HTTP 200，单次请求 20.198 秒，本地完整保存 25.892 秒，准备画布 1.051 秒；主代理已实际打开检查验收图，确认图像正确且没有生成文字。这只是一个样本，不承诺普遍 20 秒时延，也不代表 WorkBuddy 员工设备验收。未知状态时先查状态，不重提收费请求。WorkBuddy 登录、Teedy 公司账号、员工包、Windows 剪贴板和目标设备体验待验证。

# WorkBuddy 工作目录和 Skill

WorkBuddy 本地任务先选择 Company Lite 根目录，并通过首次提示词显式读取本 Skill 与项目说明。官方[本地任务说明](https://intl.cloud.tencent.com/zh/document/product/1316/84504)把工作目录和 Skill 选择分列；官方[技能说明](https://intl.cloud.tencent.com/zh/document/product/1316/84503)支持上传本地 Skill，也提及项目专属 Skill，但没有公开项目目录精确名称。因此不假设 `.agents/skills` 自动发现，也不复制到未经证实的路径。即使从 Skills 页面上传 Skill，命令仍须从用户选定的 Company Lite 工作目录执行，不能从 Skill 安装路径猜包根。
