# WorkBuddy 入口说明

## 选择能力包目录

在 WorkBuddy 本地任务中，将 Company Lite 能力包根目录选为当前任务工作目录。官方[新建本地任务说明](https://intl.cloud.tencent.com/zh/document/product/1316/84504)将工作目录与已安装 Skill 列为分别设置；工作目录负责给当前对话提供项目文件和命令上下文。

选择工作目录不等于安装 Skill。官方[WorkBuddy 技能说明](https://intl.cloud.tencent.com/zh/document/product/1316/84503)支持在 Skills 页面导入本地 Skill，也提到项目专属 Skill，但没有公布项目目录精确名称。本项目不假设 WorkBuddy 自动发现仓库中的 `.agents/skills/creative-studio/SKILL.md`，不复制到未经证实的 `.workbuddy/skills` 或 `.codebuddy/skills`。

## 首次提示词

选择 Company Lite 根目录后，在 WorkBuddy 发送：

> 请在当前 Company Lite 工作目录读取 README.md、AGENTS.md、docs/代理宿主使用.md、.agents/skills/creative-studio/SKILL.md 和 .agents/skills/creative-studio/references/workbuddy-entry.md。WorkBuddy 对话线程是本次工作的唯一上下文；制作单、用户确认、读图审核和批准都留在当前线程。本机 Canvas/MCP 是跨线程共享工具，可保留和继续历史项目，但不要自动继承其它线程的需求或批准。只在安装、配置或故障修复时读取 setup CLI 并简洁呈现能力包、本机 Canvas/MCP、本人 Teedy MCP、图片 API 和整体就绪五项；自动完成可执行检查，不逐项等待确认。日常创作不重复安装清单。不要要求我把密钥贴进聊天，不要打开独立 setup 网页。所有本地命令都从该工作目录运行。

员工包的 setup 命令为 `Start.cmd status`、`report-workbuddy connected <工具名>`／`failed [工具名]`、`configure-image @JSON --key-from-clipboard` 和 `check-image`；macOS 使用 `./Start.command`。源码开发可从已选工作目录运行 `node scripts/setup.mjs ...`。Studio 服务命令为 `Studio.cmd status|start|open [@JSON]|stop|mcp-config|check-copy @JSON`（macOS 用 `./Studio.command`）；它管理共享 Canvas，不创建任务记录。

需要图片 API Key 时，员工须先在服务页面复制本次 Key，并在当前对话明确说“已复制”。此后才能运行 `configure-image @JSON --key-from-clipboard`；JSON 只含 `expectedRevision`、`image.baseUrl` 和 `image.model`，命令仅读一次本机剪贴板且不回显。Windows 剪贴板能力待实机验证。管理员可改用本机已有、受限权限的私有 JSON。绝不要求用户将 Key 粘贴到对话或普通命令参数，也不自行读取剪贴板。

若脚本返回错误，应先展示真实错误和状态，修正输入或连接后再继续；不得猜测尚未实现的命令或伪造探测结果。

如果 WorkBuddy 无法读取这些文件或无法在该目录执行本机命令，说明当前宿主权限或工作目录问题并暂停相关操作。不要借用另一个 WorkBuddy 线程的需求或批准；Canvas 是跨线程共享的通用工作空间，历史项目仍可按当前用户意图选择。

## 可选：从 Skills 页面导入

员工可选择从 WorkBuddy Skills 页面导入本地 Skill 包，随后在新建任务时选用该 Skill。这个动作与选择 Company Lite 根目录相互独立；导入后的 Skill 仍须要求所有本地命令在用户为当前 WorkBuddy 任务所选的能力包目录中运行，不能由 Skill 安装位置推测包根目录。

本文只记录官方公开的 Skill 与本地任务设置行为，不代表本机 WorkBuddy 已安装、读取或成功运行 Company Lite。WorkBuddy 对话与文件读取行为、MCP 配置、员工账号、Windows 剪贴板及员工设备流程仍待目标设备验证。
