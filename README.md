# Creative Agent Studio

把想法变成单张海报或多页图文的本地创作工作台。提供独立 Web 助手与 Codex 两个入口，共用素材、制作单、任务、Canvas、审核和素材包导出。Canvas 只执行绘图与原像素操作。

## 独立工作台

macOS 打开 `Start.command`，Windows 打开 `Start.cmd`。入口自动准备固定依赖、构建并打开本机网页，提供停止、备份、更新、恢复和诊断菜单。首次需要联网；在设置页配置自己的基础／生图 API。详细操作、数据位置与故障恢复见 [本地 Web 使用与维护](docs/本地Web交付.md)。

## Codex 使用

在 Codex 中打开本仓库，准备依赖后按项目 [创作 Skill](.agents/skills/creative-studio/SKILL.md) 调用 `node scripts/studio.mjs`。该入口使用任务 Canvas，不启动 Web DSH。见 [Codex 使用](docs/Codex使用.md)。

## 实现与验证状态

P0—P3 已按各自范围独立验收或复验，P3 仅覆盖源码及当时本机集成。P4 本轮实现与验证、Windows CI 和普通用户双击体验的边界分别记录在 [P4实施与验证](docs/P4实施与验证.md)；施工自验不能替代主审独立验收，也不承诺全部上游模型效果。当前模块状态见 [工程进度](docs/工程进度.md)。

产品范围见 [PRD](Creative_Agent_Studio_PRD.md)，施工顺序见 [开发与施工计划](开发与施工计划.md)，源码回滚见 [Git版本与回滚](docs/Git版本与回滚.md)。用户需求与来源、制作单和最终成品的明确人工确认继续保留。

## 模型 API 与来源

Studio 只有两类模型 API：基础 API 用于 DSH 对话、工具调用、读图和 Web／CLI 素材清洗；生图 API 由 Canvas 用于图片生成。Codex 推理仍由宿主 Codex 会话承担，不切换到 Studio 的基础模型。详细来源与裁剪边界见 [模型来源与裁剪](docs/模型来源与裁剪.md)。

基础 API 可选择 OpenCode、Kilo、WorkBuddy 国内版（buddy）或国际版（workbuddy），也可继续使用自定义 API。OpenCode 与 Kilo 不要求用户粘贴免费来源密钥；WorkBuddy 必须由用户本人登录，当前真实账号和实际能力尚未验证。OpenCode 可返回模型列表，但 chat 请求被平台限制；Studio 会标记为不可用并推荐 Kilo，不绕过该限制。来源详情和 Kilo 能力证据见 [模型来源与裁剪](docs/模型来源与裁剪.md)。服务在本机 `127.0.0.1` 的动态端口运行，并使用本机随机 token。平台提供的额度、速率和可用性由平台决定，Studio 不保证免费额度。设置页将自用 API 入口置顶，并在托管来源旁显示“使用自己的 API”。本地集成按 P3 授权范围独立复验通过，不能据此推断所有上游能力均已验证。

## P0 框架技术验证

`adapters/dsh` 使用固定 DSH 依赖与配置 patch。P0 框架验证使用 `npm ci --prefix adapters/dsh --ignore-scripts`、`npm run p0:client:build --prefix adapters/dsh`，再按 [技术验证文档](docs/技术验证.md) 运行相应检查。这部分是上游框架验证，不是普通用户交付入口；P3 工作台与 DSH 创作链路的独立复验结论见 [P3最终独立复验](docs/P3最终独立复验.md)。

[上游来源与许可证](docs/上游来源.md) · [固定依赖](docs/固定依赖清单.json) · [真实测试图片](docs/evidence/p0/gpt-image-2.png)

当前 Web 外观采用冰蓝主题与带画笔鲸鱼娘头像；[主题设计、来源及渲染证据](docs/design/鲸鱼主题与素材来源.md)。三栏工作台与既有交互保持；P3 按授权范围通过独立复验。
