# AGENTS.md

## 当前工作树：公司版

本分支为 `codex/company-edition`，公司能力的当前说明见 `docs/公司版接入.md` 和 `docs/公司版自检.md`。使用Company数据目录与4311；公司服务从仓库外注入，员工只填本人Teedy凭据与两类API。模型钥匙不发送到远端静态站点或浏览器持久化，远端Canvas用匹配的任务桥接协议。公司新增范围的自检不等于员工实机或现网独立验收。Mac使用自包含 `Creative Agent Studio Company.app`；旧company-p5.1 Mac包停止推荐，Windows原包保留。

## 工程约定

- Choose the simplest modular implementation that meets current requirements. Avoid speculative abstractions and throwaway workarounds.
- Build incrementally from the smallest working end-to-end version. Never replace a working product with unfinished complexity.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations to retain them.
- Reuse proven patterns and existing dependencies. Check library documentation and types before reimplementing functionality or adding packages.
- For lasting changes, update the existing project source of truth, record non-obvious rationale, and remove obsolete guidance. Keep Chinese project documentation in Chinese.
- Delegate well-defined, mechanical implementation tasks to Luna subagents at Max reasoning.
- When the current model is unlikely to solve a problem, consult an Astra subagent at Low reasoning for focused guidance.

## 当前产品与分支

- `main`：个人版／通用版，使用本机素材和本地 Canvas。普通用户下载平台成品；源码启动用于开发和 Codex。
- `codex/company-edition`：公司版，独立 Company 数据目录、默认4311、Teedy只读素材和匹配协议的远端 Canvas。公司服务地址从仓库外注入；员工使用本人账号及两类API。
- 共享修复需在适用分支同步并验证；不得把公司默认模式、部署地址或员工数据混入个人版。不要把旧本地历史或全部标签推到公开仓库。
- 当前状态以 `docs/工程进度.md` 为准，产品范围看 PRD，施工顺序看 `开发与施工计划.md`。历史验收按所列提交与范围解释，不能代替最新设备体验。
- P0—P5已按报告所列范围验收；P5之后Mac自包含app／只读启动修复另见 `docs/Mac运行包隔离启动修复.md`。原报错设备、签名／公证和普通员工灰测未通过的内容不得标完成。公司新增能力的实施自检不冒充独立验收。

## 运行与数据边界

- Codex创作读取 `.agents/skills/creative-studio/SKILL.md`，使用共享CLI与Canvas图片API，不启动DSH、不改为宿主内置生图。Canvas只绘图和执行图片工具，不召唤Agent。
- Web保留资料读取和通用文件／脚本工具；左侧讨论与确认，右侧预览，避免同意图重复确认。保留版本／SHA／CAS、陈旧批准失效和防重复扣费机制。
- DNA默认关闭，由用户显式填写、启用及应用；模型来源可用性按实际证据呈现，OpenCode第三方对话限制和WorkBuddy本人账号待验证不能隐去。
- 旧RAG-Yuki、旧Canvas、全局客户端配置只读；不复制员工凭据、虚拟环境、浏览器个人数据或旧运行任务。公司Teedy标签／ACL与服务器不因本地改动而修改。
- 凭据、实例token和用户原件不进入仓库、证据、日志或分发包；备份含本机配置，作为私有资料保存。
- 验证使用隔离目录与夹具，不在实际用户目录重跑安装、修改旧任务或重放历史付费任务。新增真实付费测试需有明确授权及费用说明。
- Mac成品为自包含app，程序目录可只读；任务、配置、Python/OCR与日志写稳定用户数据目录。首次Python联网准备与后续复用分别说明，不宣传完全离线。

## 阶段沟通

新阶段先读PRD、施工计划、工程进度、前阶段验收与代码。用自然语言说明工作和完成后能力，展示整体产品模块图，再按已有授权施工，不增设开工关卡。模块图用绿色已证据完成、橙色本阶段、蓝色下一步、灰色后续，并写文字状态；不编百分比，不将计划当授权。交付说明实际验证、限制及剩余模块，停在授权边界。
