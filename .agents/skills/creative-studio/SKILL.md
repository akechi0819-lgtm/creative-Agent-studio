---
name: creative-studio
description: 在 Company Lite 源码目录中主持当前宿主对话线程的创作，使用现有 Teedy MCP 和跨线程共享的本机 Canvas/MCP。
---

# 入口与宿主边界

从用户打开的 Company Lite Git 仓库根目录读取 `README.md`、`AGENTS.md`、`docs/代理宿主使用.md`、`docs/工程进度.md` 和本 Skill。不要假定宿主自动发现 `.agents/skills`；首次使用时从打开的仓库目录显式读取。所有命令都从此源码根目录运行，不从 Skill 文件位置猜项目根目录。

完整流程要求宿主能读取项目规则、从仓库根执行本地命令、使用 stdio MCP、实际查看 MCP 返回的图片，并在当前对话线程保留需求、确认和批准。先按实际能力验证；缺少能力时说明具体缺项并暂停相关步骤，不承诺任意宿主自动兼容。

宿主当前对话线程承载本次需求、材料用途、品牌要求、文案、制作单、确认、读图与批准。本机 Canvas 是跨线程共享工作空间，可依用户当前意图查找、打开或继续历史项目；其他线程的要求、素材来源与批准不自动沿用。不建立任务 ID、任务账本或独立审批系统。

# 源码准备与状态

执行 Node 脚本前，先检查 Git、Node.js 22.19+（22.x）或 24+ 和 npm。可运行 `git --version`、`node --version` 与 `npm --version`；PowerShell 中如 `npm` 命令被策略阻止，用 `npm.cmd --version` 检查，不要求更改执行策略。缺少基础工具时说明缺项，按当前系统官方安装说明协助用户，不改系统策略、权限或 PATH。无需 Python、Office 或系统编译器。

首次准备先运行 `node scripts/setup.mjs status`，按实际结果简洁展示五步进度；然后从源码根自动运行耗时的 `node scripts/prepare.mjs` 安装固定依赖并构建 Canvas，完成后重新读取 setup 状态。不要在展示初始状态前开始构建。`npm run prepare:dev` 是等价开发别名。宿主自动推进可执行步骤；仅在本人登录、私密凭据输入或必要审批时等待。

只在首次准备、配置或故障修复时简洁显示五步状态：环境与依赖 → 本地 Canvas/MCP → 素材库 Teedy MCP → 图片 API → 完成。日常创作不重复安装清单。状态必须来自实际检查或当前宿主工具调用；阻塞时只告诉员工需要做的下一步。

新宿主或首次进入新会话时，确认当前实际提供的 Canvas MCP 并调用 `canvas_status`。保存的检查只代表上次调用，不代表当前会话接通。Teedy 也需按当前宿主现有 MCP 实际探测。Teedy 探测后运行 `node scripts/setup.mjs report-host connected <工具名>` 或 `failed [工具名]` 留存宿主报告；该记录不是 CLI 独立验证，不建立宿主注册、迁移或适配系统。

若需添加 Canvas MCP，从源码根运行 `node scripts/studio.mjs mcp-config`。按当前宿主实际接受的格式配置输出中的 `command` 和 `args`；JSON 外层 `mcpServers` 是交换示例，不是通用客户端配置。添加后实际调用 `canvas_status`。本机 MCP SDK stdio 测试不代表各宿主客户端已验收。

# 账号与密钥

setup 状态会显示公司提供的素材 MCP URL、登录地址或缺失信息。Teedy 使用员工本人公司账号和只读权限；服务要求的 API Key、URL 或其他凭据按公司／服务方说明，在当前宿主支持的安全入口配置。不要猜测传输方式、认证字段或权限；缺少连接信息时向管理员索取。不要将个人凭据放入普通对话、源码、普通参数或日志。Teedy 配置后需实际调用一个只读工具，再报告连接结果。

图片 API 地址、模型、Key 和 `expectedRevision` 由宿主读取当前 setup 状态后生成参数模板，员工无需创建或理解 JSON。员工复制 Key 并在当前对话明确说“已复制”后，才可运行 `node scripts/setup.mjs configure-image @image-config.json --key-from-clipboard`。命令仅读取一次本机剪贴板，把 Key 写入本机私有配置，不回显或写日志。剪贴板不可用时按宿主使用说明使用仓库外私有 JSON：宿主生成模板并限制为本人可读写，员工只在本机编辑器填写 Key，之后由 CLI 导入并删除临时文件。不得自行读取剪贴板，也不得要求用户将 Key 粘贴到对话或普通命令参数。随后运行 `node scripts/setup.mjs check-image`；该命令只检查 API 连接，不发生图像生成。

# 当前对话创作

1. 在当前对话收集目标、受众、规格、文案和品牌要求；关键缺口由智能体直接向用户询问，不从其他线程推断。
2. 需要远端参考时，用当前宿主的 Teedy 只读 MCP 搜索并展示候选。用户选定后实际下载原件，把来源、用途和事实边界留在当前对话。搜索摘要或 URL 不是原件；不得修改 Teedy 内容、标签或 ACL。
3. 在当前对话整理文案，使用 `company_check_copy`（输入 `{text}`）检查词表命中，再复核命中和建议；也可从源码根运行 `node scripts/studio.mjs check-copy @JSON`，JSON 中包含 `text`。该检查只提供词表提示，不核验事实、不替代法律审查，也不自动批准或阻止文案。修改文案后重新检查，再展示准确文案和制作单并取得用户确认。影响文案、来源或版式的修改需重新确认。
4. 确认制作单后，按用户意图调用 `canvas_open` 新建、打开最近项目、选择项目或指定历史 `projectId`。只有已实际下载的原件才可用 `canvas_import_file` 导入。
5. 在用户授权范围内调用 `canvas_run_generation`。用 `generation_get_status` 查询 `{submitted, nodeId}` 的异步结果；明确失败且仍在原授权与费用范围内时可继续处理，超范围或授权不明时先询问。状态未知先查询，不重复提交收费请求。
6. 用 `canvas_read_image` 返回的实际图片内容读图；缩略图、生成状态或文本描述不能代替读图。局部修改后重新读图。宿主不能实际查看图片时，不得声称完成图像审核。
7. 用户在当前对话明确批准成品后，才用 `canvas_save_image` 导出。

多页任务的“页码 → 图片节点 ID”对应关系保留在当前宿主线程，并随制作单、审核和局部修改更新。只修改某一页时只操作该页节点；保留原图，改版作为另一个节点记录。交付时提供定稿文案与各页图片；如用户需要 ZIP，使用宿主已有的普通文件/压缩能力整理已导出的文件。当前 Canvas MCP 不提供 ZIP 导出工具，不新建导出平台。

Canvas 保留共享历史、手动绘图和现有像素操作，包括导入、拼贴、拼接、组合、裁切、分割、重采样、移动和缩放。历史作品不会自动成为当前线程的需求、素材来源或批准。

# 验证边界

源码根回归 38/38、Canvas bridge 23/23 通过，0 失败、0 跳过；Canvas web typecheck/build 通过。Mac 本机全新浅克隆初始无依赖和构建产物，`node scripts/prepare.mjs` 完成三个依赖组安装与 Canvas Agent/Web 构建；克隆目录共享 Canvas 集成 1/1 通过（4.6 秒），覆盖多项目、裁切拼接、历史重启恢复和 MCP stdio 图片读写，未请求生图。setup 报告本地源码与 Canvas 就绪、等待当前宿主 MCP。

隔离临时配置下图片服务 `GET /v1/models` 返回 HTTP 200 并列出配置模型；未生图，源配置未改，临时 Key 目录已删除。另一次真实 Canvas MCP 单张生成样本上游 HTTP 200、用时 20.198 秒，本机完整保存 25.892 秒，准备画布 1.051 秒；主代理已实际打开检查验收图。这只是单次样本，不是普遍时延或具体宿主验收承诺。源码提交 `5fbf1bd` 的 Windows/macOS/Linux GitHub Actions 已全部通过。具体宿主命令、MCP 图片读取及 Teedy 账号权限仍需目标环境验证。
