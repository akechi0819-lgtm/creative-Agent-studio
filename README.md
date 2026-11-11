# Creative Agent Studio — Company Lite

Company Lite 是供外部宿主智能体使用的本地创作工作区。宿主在当前对话中负责需求、文案、确认和审核；本机共享 Canvas/MCP 保存项目历史并执行图像操作；只读素材 MCP 可连接公司 Teedy。

本仓库不包含聊天或推理平台，也不建立任务或审批账本。当前支持 Windows 和 macOS；Linux 未适配。详细产品边界见[产品说明](Creative_Agent_Studio_PRD.md)。

## 能力

- 共享 Canvas：查找并继续历史作品，导入素材、生成和编辑图片、排版及导出。
- Teedy 素材：通过当前宿主的只读 MCP 搜索；选定后实际下载原件再用于创作。
- 透明标识：可对已有透明 Logo 换色、描边或添加底板；不自动去除不透明背景。
- 可选 H3 视频：仅在用户明确提出并授权后使用；当前为纯文生视频，不接入声音控制或本地参考素材。

新创作应准确呈现用户文案并按指定审美组织构图、字体层级、色彩和质感。修改现有图片时只依据本次指令、当前底图和明确指定的风格页；不累加历史提示词。没有替换文案时保留原图文字。

## 快速安装

宿主需要能读取项目说明、从仓库根运行本地命令、配置 stdio MCP，并实际查看 MCP 返回的图片。各宿主是否兼容仍需分别验证；不能实际读图的宿主不能完成图像审核。

源码准备需要 Git、Node.js 22.19+（22.x）或 24+、npm。首次安装可先复制[员工安装提示词](docs/员工安装提示词.md)，由宿主按提示执行；已有正确仓库时直接打开复用。

```sh
git --version
node --version
npm --version
git clone --branch codex/company-lite https://github.com/akechi0819-lgtm/creative-Agent-studio.git "Company Lite"
cd "Company Lite"
node scripts/setup.mjs status
node scripts/prepare.mjs
node scripts/setup.mjs status
```

所有命令由宿主从克隆后的仓库根目录运行，员工无需手动操作终端。安装就绪还需要当前宿主实际接通 Canvas 和素材 MCP，完成 Teedy 查询／下载验证，并通过宿主 Canvas MCP 生成、保存、读图和重开一张安装测试图；单独的 API 连接检查不能替代这项验收。宿主使用说明包含目录选择、准备步骤和各凭据输入方法。

## 日常使用

在当前宿主对话中说明创作目标、受众、规格、文案和品牌要求。智能体搜索素材并展示候选；用户选定后下载原件，再确认文案与制作单。获得授权后在 Canvas 生成或编辑，实际查看成品并由用户批准后导出。状态未知时先查询原状态，不重复提交可能收费的请求。

宿主通过项目内的[创作 Skill](.agents/skills/creative-studio/SKILL.md) 使用共享 Canvas/MCP。项目历史和图片 API 配置跨线程共用，但其他线程的需求、来源和批准不会自动沿用。

## 凭据与边界

Teedy 密码只在本机一次性登录表单输入。图片和视频 API Key 由宿主使用可用的安全凭据入口导入本机私有配置；不要放进普通对话、仓库、命令参数或日志。仓库中的 `company-defaults.json` 仅提供非秘密默认地址和模型。

Canvas 使用共享项目历史，不是任务隔离或审批系统。H3 视频为可选功能；上游输出尺寸和时长可能与请求档位有差异。完整工具参数、安装与 MCP 配置方法见[宿主使用说明](docs/代理宿主使用.md)；验证记录和待验证范围见[工程进度](docs/工程进度.md)。
