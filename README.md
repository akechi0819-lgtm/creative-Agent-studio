# Creative Agent Studio — Company Lite

`codex/company-lite` 是面向外部宿主智能体的源码能力包：宿主当前对话线程主持创作并调用工具；本机 Canvas/MCP 保存跨线程共享的项目历史、图片与排版状态；公司现有云端 Teedy 只读 MCP 提供远端素材。本仓库不包含聊天或推理平台，也不另建任务账本。

## 源码快速开始

源码分支 `codex/company-lite` 已推送到 [GitHub 仓库](https://github.com/akechi0819-lgtm/creative-Agent-studio)。

```sh
git --version
node --version
npm --version
git clone --branch codex/company-lite https://github.com/akechi0819-lgtm/creative-Agent-studio.git CompanyLite
cd CompanyLite
node scripts/setup.mjs status
node scripts/prepare.mjs
node scripts/setup.mjs status
```

本地准备需要 Git、Node.js 22.19+（22.x）或 24+，以及 npm；执行 Node 脚本前由宿主先检查它们是否可用。在 PowerShell 中如 `npm` 命令被策略阻止，可用 `npm.cmd --version` 检查，不要求更改执行策略。`node scripts/prepare.mjs` 按仓库锁定清单安装或复用依赖并编译 Canvas；`npm run prepare:dev` 是等价开发别名。员工无需另装 Python、Office 或系统编译器。缺少 Git、Node.js 或 npm 时，宿主应说明缺项，并按当前系统官方安装说明协助用户；不得擅自改动系统策略、权限或 PATH。

命令从克隆后的源码根目录运行。Canvas 通过本机默认浏览器打开，需要可用的桌面浏览器。宿主须能读取该目录的项目规则、运行本地命令、连接标准 stdio MCP、实际查看 MCP 返回的图片，并在当前对话线程取得用户确认和必要审批；缺少能力时说明并暂停相关步骤，不宣称无条件兼容。

## 安装与连接

首次安装、配置或故障修复时，先运行 `node scripts/setup.mjs status` 并简洁展示五项真实进度，再按状态自动运行耗时的 `node scripts/prepare.mjs`；准备完成后重新读取状态。不要在展示初始状态前开始构建。日常创作不重复安装清单。自动推进可执行检查，仅在本人登录、输入凭据或需要宿主审批时等待，不要求逐项确认。

1. 源码根目录及 Git、Node.js、npm 运行依赖。
2. Canvas 构建状态，以及当前宿主实际调用 `canvas_status` 后的连接结果。
3. 本人公司 Teedy 账号、服务提供的 MCP URL／登录地址与只读工具实际调用结果。
4. 图片 API 地址、模型和 Key 的配置及非生图连接检查。
5. 当前整体就绪状态和下一步操作。

新宿主或首次进入新会话时，确认当前实际可用的 Canvas MCP 工具并调用 `canvas_status`；保存的探测结果只代表上次实际调用。Teedy 同样需用当前宿主现有 MCP 实际探测。不要因旧报告推断新宿主已接通，也不建立宿主注册或迁移系统。

若本地 Canvas MCP 尚未接入，从源码根运行：

```sh
node scripts/studio.mjs mcp-config
```

根据输出中的 `command` 和 `args`，按当前宿主实际接受的 stdio MCP 格式配置服务，再调用 `canvas_status`。输出 JSON 外层的 `mcpServers` 只是交换示例，并非每个宿主通用的配置文件。本机 MCP SDK stdio 已通过测试，不代表任何具体宿主客户端已验收。

Teedy 的账号、只读权限、MCP URL、登录地址和可能需要的 API Key 按 setup 状态及服务方实际说明，在当前宿主支持的安全入口配置；不猜测传输方式、字段或权限。公司尚未提供连接信息时，先向管理员索取。只在宿主实际调用只读工具后记录结果：

```sh
node scripts/setup.mjs report-host connected <工具名>
node scripts/setup.mjs report-host failed [工具名]
```

该记录是宿主报告，不是 CLI 对 Teedy 的独立连接验证。凭据不进入仓库、日志或普通对话消息。

图片 API 配置需要 `expectedRevision`、`image.baseUrl` 和 `image.model`。员工复制 Key 并在当前对话明确说“已复制”后，宿主才可运行：

```sh
node scripts/setup.mjs configure-image @image-config.json --key-from-clipboard
node scripts/setup.mjs check-image
```

命令仅读取一次本机剪贴板，把 Key 写入本机私有配置，不回显或写入日志；JSON 不含 Key。若剪贴板入口不可用，可按[宿主使用说明](docs/代理宿主使用.md)改用仓库外的私有 JSON 文件。不得要求用户把 Key 粘贴到对话或普通命令参数。`check-image` 只检查 API 连接，不发起生成请求。

配置模板和 revision 由宿主根据当前 setup 状态生成，员工无需创建或理解 JSON。备用文件也由宿主准备，员工只在本机编辑器中填写 Key；详细操作见[宿主使用说明](docs/代理宿主使用.md)。

管理员提供的非敏感图片地址／模型及素材 MCP 默认值示例，以及如何对每次 setup 调用指定外置 defaults 文件，见[宿主使用说明中的管理员默认值小节](docs/代理宿主使用.md#管理员提供的公共默认值)。

共享 Canvas 服务可从源码根分别通过 `node scripts/studio.mjs status`、`node scripts/studio.mjs open @JSON` 和 `node scripts/studio.mjs mcp-config` 查看、打开或配置。宿主日常绘图优先直接调用 Canvas MCP；创作时使用 `canvas_open` 选择新项目、最近项目或历史项目。Canvas 历史和图片 API 配置跨线程共用，其他线程的需求、来源和批准不会自动沿用。

## 宿主线程创作流程

1. 在当前对话收集目标、受众、规格、文案和品牌要求；关键缺口由智能体直接向用户询问。
2. 使用当前宿主现有 Teedy 只读 MCP 搜索并展示候选。用户选择后实际下载原件；搜索摘要和 URL 不代表原件已下载。记录当前线程里的来源、用途和事实边界，不修改 Teedy 内容、标签或 ACL。
3. 在当前对话整理并展示文案和制作单，取得用户确认。修改影响文案、来源或版式时再次确认。
4. 制作单确认且用户需要画布操作时调用 `canvas_open`。已下载的远端原件才可通过 `canvas_import_file` 导入。
5. 按当前用户授权调用 `canvas_run_generation`；它返回 `{submitted, nodeId}` 后，以 `generation_get_status` 查询异步结果。明确失败且仍在原授权和费用范围内时可继续处理；超范围或授权不明时先询问。状态未知先查，不重复提交收费请求。
6. 用 `canvas_read_image` 返回的实际图片内容检查成品，局部修改后重新读图。宿主无法实际查看图片时，不声称完成图像审核。用户在当前对话明确批准后，才调用 `canvas_save_image` 导出。

Canvas 继续支持手动绘图和既有像素操作，包括导入、拼贴、拼接、组合、裁切、分割、重采样、移动和缩放；这些不是新发明的能力。

## 当前证据与边界

- 源码根回归 38/38、Canvas bridge 23/23 均通过，0 失败、0 跳过；Canvas web typecheck/build 通过。
- Mac 本机全新浅克隆起始没有 `node_modules` 和构建产物；`node scripts/prepare.mjs` 完成三组依赖安装及 Canvas Agent/Web 构建。随后 setup 正确报告本地源码与 Canvas 就绪、仍等待当前宿主 MCP。克隆目录中的共享 Canvas 集成 1/1 通过（4.6 秒），覆盖多项目、裁切拼接、历史重启恢复及 MCP stdio 图片读写，未请求生图。
- 隔离临时配置下的真实图片服务 `GET /v1/models` 返回 HTTP 200 并列出配置模型；未进行生图，源配置未更改，临时 Key 目录已删除。另一次真实 Canvas MCP 单张生成样本上游 HTTP 200，用时 20.198 秒，本机完整保存用时 25.892 秒，准备画布用时 1.051 秒；请求计数为 1。主代理已实际打开检查验收图。这些都是本机样本，不是普遍时延或宿主验收承诺。
- 源码提交 `5fbf1bd` 的 Windows/macOS/Linux GitHub Actions 已全部通过；CI 覆盖源码构建和集成，员工交互桌面仍待实测。具体宿主的本地命令、MCP 配置和图片读取能力，以及 Teedy 账号和只读权限仍需目标环境验证。

## 初次使用提示

在宿主中打开源码根目录，简短提示智能体：

> 请先从当前源码根目录读取 README、AGENTS、宿主使用说明和创作 Skill；按文档检查当前可用工具与状态，自动完成可执行准备。所有本地命令从该根目录运行，日常创作不重复安装清单。
