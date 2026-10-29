# AGENTS.md

## 工程约定

- Choose the simplest modular implementation that meets current requirements. Avoid speculative abstractions and throwaway workarounds.
- Build incrementally from the smallest working end-to-end version. Never replace a working product with unfinished complexity.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations to retain them.
- Reuse proven patterns and existing dependencies. Check library documentation and types before reimplementing functionality or adding packages.
- For lasting changes, update the existing project source of truth, record non-obvious rationale, and remove obsolete guidance. Keep Chinese project documentation in Chinese.
- Delegate well-defined, mechanical implementation tasks to Luna subagents at Max reasoning.
- When the current model is unlikely to solve a problem, consult an Astra subagent at Low reasoning.

## 当前产品与分支

- `codex/company-lite` 是公司 WorkBuddy 创作能力包。WorkBuddy 对话线程是唯一创作工作边界，负责需求、制作单、确认和审核；Company Lite 提供纯 CLI setup 与本机共享 Canvas/MCP，不创建任务账本或任务专属 Canvas 系统。
- 当前产品说明以 [README](README.md)、[PRD](Creative_Agent_Studio_PRD.md)、[开发与施工计划](开发与施工计划.md)、[工程进度](docs/工程进度.md)、[代理宿主使用](docs/代理宿主使用.md) 和 [创作 Skill](.agents/skills/creative-studio/SKILL.md) 为准。旧 P0—P5 和其他分支文档只作历史证据，不是当前需求或员工操作指南。
- WorkBuddy 通过公司现有云端 Teedy MCP 查询和实际下载用户选定的材料。保持 Teedy 内容、标签和 ACL 不变；出处与用途留在当前 WorkBuddy 对话上下文中。
- WorkBuddy 真实登录、员工 Windows 使用、Teedy 实际权限和目标设备体验仍待验证。一次本机 Canvas MCP 图片请求已成功（上游 HTTP 200、20.198 秒，完整本地保存 25.892 秒）；这是单次样本，不是普遍时延承诺或员工验收。

## 运行与数据边界

- WorkBuddy 主界面负责安装、配置和创作。员工包用 `Start.cmd status`／`./Start.command status`，源码开发可用 `node scripts/setup.mjs status`。仅首次安装、配置或故障修复时简洁呈现包、本机 Canvas MCP、Teedy MCP 探测报告、图片 API 和整体就绪五项状态；自动推进可执行检查，只在本人登录、WorkBuddy MCP 审批或员工输入凭据时等待，不增加逐步确认。日常创作不重复安装清单。`Start status` 返回 setup 状态，包装器不启动浏览器。
- Canvas 是跨线程共享的持续本机工作空间，保留历史项目、生成图片和排版编辑状态；允许查找、重开并继续旧作品。绘图连接、图片 API 配置和 Canvas 项目历史跨线程共用。WorkBuddy 当前对话线程负责区分本次需求和批准；Canvas 项目不承载任务审批或跨线程确认。
- 按 Skill 与 WorkBuddy 当前线程组织品牌规则、文案、制作单、用户确认和复审；不添加任务 ID 绑定或任务／审批账本作为主工作流。`Studio` CLI 仅管理共享 Canvas 服务及检查文案，不是任务管理入口。
- 使用现有云端 Teedy MCP 的真实查询与下载能力；不能把搜索结果或链接本身说成已下载原件。使用 WorkBuddy 当前显示的本机 Canvas MCP 工具绘图和执行既有像素操作；不要虚构 MCP 工具名或改用任务外图片脚本、其他部署 Canvas、WorkBuddy 自带生图。
- 需求澄清、制作单确认、失败重试和最终批准必须来自当前 WorkBuddy 对话中的用户直接表达。成品必须由 WorkBuddy 实际打开读图后才能进入审核；用户明确批准后再导出。Canvas 状态或付费请求结果不明时先查现有状态，不自动重发。
- 独立 CompanyLite 数据根用于本机共享 Canvas 历史、共用配置和运行状态，不是另一套任务或审批系统；不导入旧版数据。
- API Key 等个人凭据不得粘贴到 WorkBuddy 对话、普通命令参数、任务来源或日志。员工在服务页面复制 Key 并明确说“已复制”后，才能运行 `Start configure-image @JSON --key-from-clipboard`，只读取一次本机剪贴板；不得自行读剪贴板。Windows 剪贴板待实机验证。管理员已有 Key 可用本机受限权限私有 JSON。不得写入真实公司服务地址、员工账号或原件到公开仓库。

## WorkBuddy 工作目录与 Skill

- 先在 WorkBuddy 当前任务中显式选择 Company Lite 能力包根目录，再从该目录读取 README、AGENTS、使用说明和 Skill。打开工作目录与在 WorkBuddy Skills 页面导入／启用 Skill 是两项独立操作。
- 官方 WorkBuddy 文档支持上传本地 Skill 包及项目内 Skill，但没有公开项目 Skill 目录的精确路径。本分支不声称 WorkBuddy 自动发现 .agents/skills，不复制到未经证实的 .workbuddy 或 .codebuddy 路径；按使用说明中的首次提示词显式读取 Skill。
- 若使用 WorkBuddy Skills 页面导入的用户级 Skill，命令也必须在用户为当前任务选定的 Company Lite 根目录执行。不得依据已安装 Skill 的文件路径向上猜测源码根目录。

## 阶段沟通

新阶段先读当前 PRD、施工计划、工程进度、使用说明、创作 Skill 和相关代码。已有施工授权直接执行，不增加开工确认。进度图用绿色标注有历史实现证据的模块、橙色标注当前施工、蓝色标注待设备验证、灰色标注已移除范围；同时写明文字状态。历史实现证据不等于当前分支验收。交付说明实际验证、限制和剩余模块；没有证据时不宣称通过。
