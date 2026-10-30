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

- `codex/company-lite` 是面向外部宿主智能体的本地创作能力包。宿主当前对话线程负责需求、制作单、确认和审核；Company Lite 提供纯 CLI setup 与本机共享 Canvas/MCP，不创建任务账本或任务专属 Canvas 系统。
- 当前产品说明以 [README](README.md)、[PRD](Creative_Agent_Studio_PRD.md)、[开发与施工计划](开发与施工计划.md)、[工程进度](docs/工程进度.md)、[代理宿主使用](docs/代理宿主使用.md) 和 [创作 Skill](.agents/skills/creative-studio/SKILL.md) 为准。旧 P0—P5 和其他分支文档只作历史证据，不是当前需求或员工操作指南。
- 宿主智能体通过本机只读素材 MCP 连接公司远端 Teedy 查询和实际下载用户选定的材料。保持 Teedy 内容、标签和 ACL 不变；出处与用途留在当前宿主对话上下文中。
- 具体宿主的登录、MCP 和本地命令能力、Teedy 实际权限及目标系统体验仍待验证。一次本机 Canvas MCP 图片请求已成功（上游 HTTP 200、20.198 秒，完整本地保存 25.892 秒）；这是单次样本，不是普遍时延承诺或宿主验收。

## 运行与数据边界

- 本仓库按源码运行：执行 Node 脚本前先检查 Git、Node.js 22.19+（22.x）或 24+ 和 npm；从仓库根运行 `node scripts/prepare.mjs` 安装锁定依赖并构建 Canvas，`npm run prepare:dev` 是等价开发别名。PowerShell 中如 `npm` 被策略阻止，可用 `npm.cmd --version` 检查，不要求更改执行策略。无需 Python、Office 或系统编译器。缺少基础工具时说明缺项，按当前系统官方说明协助用户安装；不擅自修改系统策略、权限或 PATH。
- 宿主智能体负责安装、配置和创作。从源码根运行 `node scripts/setup.mjs status`。仅首次安装、配置或故障修复时简洁呈现源码与依赖、本机 Canvas MCP、Teedy MCP 实际探测、图片 API 和整体就绪五项状态；自动推进可执行检查，只在本人登录、宿主 MCP 审批或用户输入凭据时等待，不增加逐步确认。日常创作不重复安装清单。
- Canvas 是跨宿主线程共享的持续本机工作空间，保留历史项目、生成图片和排版编辑状态；允许查找、重开并继续旧作品。绘图连接、图片 API 配置和 Canvas 项目历史跨线程共用。当前宿主对话线程负责区分本次需求和批准；Canvas 项目不承载任务审批或跨线程确认。
- 按 Skill 与当前宿主线程组织品牌规则、文案、制作单、用户确认和复审；不添加任务 ID 绑定或任务／审批账本作为主工作流。`node scripts/studio.mjs` 管理共享 Canvas 服务、输出 MCP 配置示例并检查文案；宿主也可直接使用 Canvas MCP。
- 宿主必须能读取所选 Company Lite 工作目录的项目规则、从该目录运行本地命令、连接标准 stdio MCP，并把 MCP 返回的图片内容交给智能体实际查看。具体宿主还须在当前对话中取得用户确认；不能声称任意宿主自动兼容。使用本机素材 MCP 对远端 Teedy 的真实查询与下载能力；不能把搜索结果或链接本身说成已下载原件。不要虚构 MCP 工具名或改用任务外图片脚本、其他部署 Canvas或宿主自带生图。
- 切换宿主或首次进入新会话时，先确认当前宿主实际提供的 Canvas MCP 工具并调用 `canvas_status`；已保存探测仅代表上次调用，不证明新宿主已接通。Teedy 也以当前宿主现有 MCP 的实际调用为准。不要建立宿主注册、迁移或适配系统。
- `node scripts/studio.mjs mcp-config` 的 `command`／`args` 是 stdio 配置参数；外层 JSON 只是示例，不保证任意宿主接受相同格式。按宿主实际入口和格式配置，不猜测固定菜单或目录。本机 MCP SDK stdio 验证不等于客户端兼容验证。
- 需求澄清、制作单确认和最终批准必须来自当前宿主对话中的用户直接表达。已有用户授权范围内的明确失败可按原授权和费用范围处理；超出范围或授权含义不清时先询问。状态未知时先查现有状态，不自动重发。成品必须由宿主实际读图后才能进入审核；用户明确批准后再导出。
- 独立 CompanyLite 数据根用于本机共享 Canvas 历史、共用配置和运行状态，不是另一套任务或审批系统；不导入旧版数据。
- Teedy 认证已查明为用户名密码登录远端 `/api/user/login` 后使用 Cookie；本机 Node stdio 素材 MCP 复用只读访问逻辑，不是远端 OAuth MCP。公司提供 `materials.baseUrl`，宿主运行 `node scripts/setup.mjs login-materials` 并打开一次性本机登录页；员工仅在表单输入账号密码，自动验证登录、查询和实际原件下载。随后宿主按 `node scripts/materials.mjs mcp-config` 接入，并真实查询、下载后报告两项结果。空库、无权限、下载失败或仅浏览器登录均不能标记就绪。安装授权包含验证下载，验证后删除测试原件；日常创作仍先选素材再下载。所有命令由宿主执行，员工不操作终端。不得把真实地址、员工账号、密码或原件提交公开仓库。
- 员工复制图片 API Key 并明确说“已复制”后，才能运行 `node scripts/setup.mjs configure-image @JSON --key-from-clipboard`，仅读一次本机剪贴板并将 Key 写入本机私有配置；不得自行读、回显或记入日志。剪贴板不可用时，宿主生成仓库外仅本人可读写的私有 JSON 模板，用户在本机编辑器填入 Key 后再由 CLI 导入；文件内容不读回、不记录并在导入成功后删除。普通问答框不作为秘密输入入口。


## 宿主工作目录与 Skill

- 在宿主中显式打开克隆的 Company Lite 仓库根目录，再从该目录读取 README、AGENTS、宿主使用说明和 Skill。不假定宿主自动发现 `.agents/skills`；首次提示词要求智能体从已打开的仓库显式读取 Skill。
- 所有本地命令都从当前打开的仓库根目录执行。不得依据 Skill 文件路径猜测源码根目录。

## 阶段沟通

新阶段先读当前 PRD、施工计划、工程进度、使用说明、创作 Skill 和相关代码。已有施工授权直接执行，不增加开工确认。进度图用绿色标注有历史实现证据的模块、橙色标注当前施工、蓝色标注待设备验证、灰色标注已移除范围；同时写明文字状态。历史实现证据不等于当前分支验收。交付说明实际验证、限制和剩余模块；没有证据时不宣称通过。
