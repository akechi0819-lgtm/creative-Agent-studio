# 宿主入口

在宿主中打开克隆后的 Company Lite 仓库根目录。不要假定 `.agents/skills` 会自动发现；首次使用时让智能体从该源码根目录读取 README、AGENTS、宿主使用说明、工程进度和创作 Skill。命令始终从当前打开的仓库根目录运行。

首次使用可发送：

> 请先阅读当前源码根目录中的 README、AGENTS、宿主使用说明、工程进度和创作 Skill。按说明检查 Git、Node.js、npm 和当前宿主工具；自动准备依赖、Canvas 与可执行的连接检查，并简洁报告五步进度。仅在确需本人登录、输入凭据或宿主审批时等待，不逐步向我确认。所有命令从当前仓库根目录运行；密钥不要放进普通对话或日志。

必要提示：Git、Node.js 和 npm 是源码准备的前提；以 `node scripts/prepare.mjs` 为准备入口。PowerShell 如遇 npm 脚本执行策略阻止，检查 npm 可用性时使用 `npm.cmd --version`，不要要求更改执行策略。Teedy 账号、MCP URL／登录地址和服务要求的 Key 依实际状态及服务方说明配置；缺少信息时向管理员索取。新宿主或新会话要实际调用 `canvas_status`，旧探测结果不代表当前宿主已连接。
