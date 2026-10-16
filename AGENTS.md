# AGENTS.md

**2026-10-16 P4 最终独立复验通过：跨平台本地 Web 源码交付、macOS 隔离运行和 Windows Actions 按授权范围通过。** 两项首轮必修已关闭，229/229 测试、真实浏览器及用户数据完整性核对通过；普通设备双击体验与既有上游限制单独记录。最新结论见 [P4最终独立复验](docs/P4最终独立复验.md)。

- Choose the simplest modular implementation that meets current requirements. Avoid speculative abstractions and throwaway workarounds.
- Build incrementally from the smallest working end-to-end version. Never replace a working product with unfinished complexity.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations to retain them.
- Reuse proven patterns and existing dependencies. Check library documentation and types before reimplementing functionality or adding packages; prefer well-maintained libraries when they reduce complexity or improve reliability.
- For lasting changes, update the existing project source of truth, record non-obvious rationale, and remove obsolete guidance. Sync only affected documentation and downstream consumers; keep Chinese project documentation in Chinese.
- Delegate well-defined, mechanical implementation tasks to Luna subagents at Max reasoning.
- When the current model is unlikely to solve a problem, consult an Astra subagent at Low reasoning for focused guidance, or delegate the difficult part to it.

## 本仓库边界

产品范围以 PRD 为准，施工顺序以开发与施工计划为准。P0 已独立验收通过；P1 返工后已独立复验通过，按阶段范围验收通过；P2 已于 2026-10-14 获用户明确施工批准并按阶段范围独立复验通过，范围为总库自由标签、模型清洗后人工微调确认入库、默认关闭的全局 DNA；原标签清洗竞态及最新结果见 `docs/P2独立验收.md`。P3 于 2026-10-16 按已授权源码及本机集成范围独立复验通过。主审独立重跑 206 项测试、原两种审核顺序恢复案例及归档正确预期流程；CUA 隔离点验关闭版 DNA 应用、无重复草稿确认、已选参考时一次继续、Job 运行中可编辑本地草稿但不能发送。在线 HTTP JavaScript 哈希 `d250bb…` 与 349,851 字节验证构建一致。361 个受保护文件中 359 个未变；变化限 `conversation.json` 和 `operations.json`。85 份旧源、9 张历史图及现存 ZIP 的 24 个 CRC 和 23 个 manifest 文件哈希已核对。首次审查与返工历史保留，最新结论见 `docs/P3最终独立复验.md`。远端 AI 改图效果与 WorkBuddy 实际能力等历史限制未验证或未通过，不作为已通过项；DNA 草稿整理可能覆盖编辑区为非阻断体验观察，见最终报告，不新增阶段门槛。用户已于 2026-10-16 授权启动 P4；P4 已按跨平台本地 Web 交付范围独立复验通过，两项首轮必修已关闭，目标为 GitHub 仓库内跨平台本地 Web 交付，不要求 macOS 原生 App、DMG 或 PKG。Mac `.command` 与 Windows `.cmd` 为共享逻辑的薄入口；P4 还覆盖首次依赖准备、构建、Canvas／插件服务管理、首次配置、备份更新、跨平台区域检测及 Windows Actions 真 runner 回归。CI 不等于 Windows 实机或普通用户双击体验验证。不能把 P3 通过当作完整首版交付；阶段状态和进度见 `docs/工程进度.md` 与 `开发与施工计划.md`。

P4 边界：只替换 Swift／Vision 区域检测依赖，保留现有跨平台浏览器裁切、分割、拼贴等像素工具；候选库先经代表性样例精度核验再选。Windows 设备暂不可用不阻断其他施工，也不宣称实机通过。WorkBuddy 可辅助部署诊断，不要求用户自行改源码。Web DSH 与 Codex CLI／Skill 分离，Codex 不启动 DSH，Canvas 不召唤 Agent；避免重复确认和过量护栏。旧 RAG-Yuki、旧 Canvas、全局客户端配置只读。用户已于本轮明确授权使用 GitHub 账号创建公开仓库 `creative-Agent-studio`，检查源码与历史后上传并运行 Windows CI；这只授权公开源码，不部署公网服务。验证优先使用隔离夹具和已有证据，不重放历史付费任务；若确需新增真实付费验证，先说明测试内容和成本，不以此阻断无关施工。

用户提出创作需求时使用 `.agents/skills/creative-studio/SKILL.md` 和共享 CLI；Codex 创作路径不启动 DSH。修改产品源码时按当前阶段施工。

旧 RAG-Yuki、旧 Canvas 与全局客户端配置只读；不复制员工凭据、运行数据或虚拟环境。新 Canvas 只能绘图执行，不召唤 Agent。凭据、实例 token、浏览器个人数据不写入证据、日志、导出或版本库。

## 模型来源附属模块（2026-10-15）

用户已授权统一基础／生图两类 API 和集成来源插件。本机来源适配与基础配置集成按 P3 范围独立复验通过；Web 与 CLI 素材清洗共用基础配置，自用 API 仍保留。插件固定上游提交并只开放 OpenCode、Kilo、WorkBuddy 国内／国际来源。Kilo 文本、工具和读图实测通过；OpenCode 上游拒绝第三方调用，已明确标注，不按可用免费额度宣传；WorkBuddy 真实账号和实际能力仍待本人登录验证，不作为 P3 已通过能力。证据见 `docs/模型来源与裁剪.md`、`docs/evidence/model-plugin/verification.json` 和 `docs/P3最终独立复验.md`。P4 已获授权施工；模型来源模块的 P3 验收范围与上游限制不变。

## 阶段沟通与工程进度

- 每次新阶段线程先读取 PRD、施工计划、工程进度、上一阶段验收与相关代码，再开始施工。
- 读完先用简单直白的自然语言说明：本阶段要做什么、为什么做、完成后整个产品会具备哪些能力。说明不作为额外审批关卡，已有阶段授权即可继续施工。
- 开工说明和阶段交付都展示整体产品模块进度图，不能只展示用户使用流程。更新 `docs/工程进度.md`，保持模块名称与产品架构一致。
- 图中绿色表示已有证据的阶段工作已完成，橙色表示本阶段正在推进，蓝色表示下一阶段计划，灰色表示更后续工作；每个节点还必须写文字状态，不能只靠颜色。
- 模块只有部分能力完成时拆分或注明范围；P0 的技术基础通过不能涂成整个 Canvas 或独立应用产品已完成。不编百分比、不提前标完成、不把下一阶段计划当授权。
- 阶段交付用自然语言说明全项目已完成什么、仍缺什么、下一阶段将做哪些模块；附验证证据和进度图，完成后停在已授权阶段边界。
