# Creative Agent Studio


## P5 通用版候选交付

本批补齐左侧对话统一确认、文档／表格／批量文件工具、双 API 首次引导和按平台预构建运行包。当前为实施方自验证候选，独立验收结论及实际构建覆盖以 [P5 实施与验证](docs/P5实施与验证.md) 为准；P4 已通过的源码交付不能冒充 P5 运行包开箱验证。

普通用户的目标入口是 GitHub Releases 对应平台的完整 ZIP，解压后保留整个目录，双击 macOS `.app` 或 Windows `Start.vbs`；源码 clone、`Start.command`／`Start.cmd` 继续用于开发和 Codex。首次启动会单独检查并准备兼容的 Python 及所需库，安装在应用数据目录，后续健康时复用，不修改系统默认 Python。首次配置按引导区分对话 API 与图片 API，模型列表检查不会自动付费出图。平台包、签名限制与许可证见 [P5 运行包](docs/P5运行包.md)。


把创作想法变成海报或多页图文的本地工作台，提供独立 Web 工作台和 Codex 两种入口，共用素材、制作单、任务、Canvas、审核与导出。

仓库：[creative-Agent-studio](https://github.com/akechi0819-lgtm/creative-Agent-studio)。下载源码后按下面步骤准备并在自己的电脑上运行；仓库链接本身不是公网服务。

## 下载与首次启动

任选一种方式获取源码：

1. 打开 GitHub 仓库页面，选择 **Code → Download ZIP**，下载后解压。
2. 或在终端克隆仓库：

```sh
git clone https://github.com/akechi0819-lgtm/creative-Agent-studio.git
```

把完整文件夹放在自己有读写权限、之后会保留的目录中。不要直接从 ZIP 预览窗口运行，也不要放进只读目录。

### macOS

在 Finder 中双击 `Start.command`。若 ZIP 解压后的文件没有执行权限，在终端先进入解压目录，再授予这两个入口文件执行权限：

```sh
cd "/替换成你的路径/creative-Agent-studio"
chmod +x Start.command scripts/bootstrap-node.sh
```

路径中有空格时保留引号。然后回到 Finder 双击 `Start.command`。若 macOS 阻止打开，按系统提示在安全设置中允许本次文件；不要关闭全局防护。

### Windows

在文件资源管理器中双击 `Start.cmd`。按屏幕提示等待首次准备完成。

首次准备会依次检查运行环境、安装依赖并构建工作台：

1. 如果系统已有符合要求的 Node.js 版本，会复用它；否则下载固定版本。
2. 安装仓库锁定的 npm 依赖。
3. 准备私有 Python／OCR 依赖和所需模型。
4. 构建工作台和配套服务，自动打开本机网页，并显示维护菜单。

首次准备需要联网，可能需要一些时间；下载好的运行时和依赖会在后续启动中复用。不能假定首次准备可离线完成，也不能据此推断所有设备架构都已验证。

## 独立 Web／DSH 端

双击入口后会自动准备并启动工作台，尝试在浏览器打开本机页面，同时显示维护菜单。若浏览器未弹出，选择 **1 打开工作台** 或复制终端显示的本机地址。端口动态分配，不固定为 `4310`。再次打开入口会复用同一数据目录中已经运行的实例。

这个网页是独立工作台入口，启动器会准备并管理它所需的 DSH、Canvas 和模型来源服务。用户不需要额外安装 DSH，也不需要手动运行上游 CLI。

首次进入后的操作顺序：

1. 等待自动打开本机工作台；需要重新打开时，在菜单选择 **1 打开工作台**。
2. 在网页的 **模型与服务** 页面配置 API。
3. 保存后即可在工作台中开始任务；需要生图或 AI 清洗时，对应 API 必须已配置。
4. 需要手工调整当前任务图片时，在任务中打开 Canvas 页面进行查看和编辑。

两类 API 的用途如下：

| 设置 | 用途 |
| --- | --- |
| 基础 API | 工作台对话、工具、读图和素材 AI 清洗 |
| 生图 API | Canvas 图片生成 |

可以配置自己的 API。各模型来源的实际可用范围、登录要求和上游限制见[模型来源与裁剪](docs/模型来源与裁剪.md)。

保存配置只完成本机设置，不会自动发起创作或验证上游能力。Canvas 会在任务中单独打开，供你查看和人工介入；Canvas 执行绘图与图片操作，不会召唤 Agent。

### 菜单与数据维护

菜单选项如下：

- **0 退出菜单**：退出维护菜单；若未停止，工作台服务继续留在本机。
- **1 打开工作台**：打开浏览器中的本机页面。
- **2 停止服务**：正常关闭工作台和配套服务。
- **3 备份数据**：保存当前用户数据。
- **4 更新当前源码依赖**：备份用户数据，再为当前源码安装依赖并构建。
- **5 恢复备份**：校验备份后恢复用户数据。
- **6 诊断**：检查本机服务状态与准备情况。

备份、恢复和更新会先停止当前数据目录的工作台。更新不会自动下载新源码或执行 `git pull`。

用户数据和源码分开保存。默认数据目录为：

- macOS：`~/Library/Application Support/Creative Agent Studio`
- Windows：`%LOCALAPPDATA%\Creative Agent Studio`
- Linux：`$XDG_DATA_HOME/creative-agent-studio`；未设置时为 `~/.local/share/creative-agent-studio`

备份默认保存在数据目录旁的 `Creative Agent Studio backups` 文件夹中，包含本地 API 配置，应作为私有文件妥善保管，不要上传到 GitHub。更新时先在旧版本菜单选择 **3 备份数据**（会先停机），再下载或切换到新源码，运行新版启动入口；它会检查并准备该版本依赖。菜单 **4** 用于显式备份并重建当前源码，不会自动下载新源码或执行 `git pull`。详细步骤、数据目录和恢复说明见[本地 Web 使用与维护](docs/本地Web交付.md)。

## 在 Codex 中创作

在本机 Codex 中打开已下载的仓库**根目录**，让 Codex 能读取文件并在本机运行命令。只把 GitHub 链接贴到云端对话，不等于打开了本地仓库。

首次使用前，在仓库根目录打开终端并准备依赖：

```sh
# macOS
./Start.command prepare

# Windows PowerShell
.\Start.cmd prepare
```

`prepare` 只准备依赖和构建文件，不会启动 Web 工作台或 DSH。Codex 创作由当前 Codex 会话负责推理，通过仓库中的项目 Skill 和共享 CLI 使用任务 Canvas；该路径不启动 Web DSH。

首次配置 API 可按以下步骤完成：

1. 双击 `Start.command` 或 `Start.cmd`，等待本机工作台打开。
2. 在 **模型与服务** 中至少保存生图 API；需要素材 AI 清洗或 Web 对话时，再配置基础 API。
3. 回到启动菜单选择 **2 停止服务**，之后在 Codex 中创作。

素材 AI 清洗使用产品配置的基础 API；图片生成仍使用产品配置的生图 API。来源限制和登录要求见[模型来源与裁剪](docs/模型来源与裁剪.md)。

在支持 Skill 显式调用的 Codex CLI／IDE 中可以使用 `$creative-studio`。也可以直接用普通自然语言说明需求，例如：

> 请读取仓库根目录的 `AGENTS.md` 和 `.agents/skills/creative-studio/SKILL.md`，按项目流程使用共享 CLI 协助我完成这次创作。

Codex 会按项目 Skill 的创作流程处理需求；用户不必自己编写 JSON。不同 Codex 客户端的界面和 Skill 选择器可能不同，完整入口说明见 [Codex 创作入口](docs/Codex使用.md)；Skill 发现与调用规则已按 [OpenAI 官方文档](https://learn.chatgpt.com/docs/build-skills)核对。

## 可复制的本机部署提示词

可交给 Codex，或交给已登录且确实能访问本机目录和命令行的 WorkBuddy：

> 请把 https://github.com/akechi0819-lgtm/creative-Agent-studio 部署到我的本机。如果当前已打开该仓库就复用，否则在当前可写目录下载或克隆完整仓库。先读 README 和 AGENTS.md，识别系统，使用 Mac 的 Start.command 或 Windows 的 Start.cmd 完成准备并启动工作台；用命令行部署时可运行启动入口的 start --no-open，再把本机网页地址告诉我。若 API 尚未配置，只打开“模型与服务”设置，让我在本机填写。只做部署，不修改业务源码、不触发图片生成或素材 AI 清洗；不要将密钥或 token 输出到聊天或日志。完成后说明启动结果、访问地址及停止方法。

此提示词适用于具备本机文件和命令执行能力的客户端；外部 WorkBuddy 客户端的部署流程尚未实测。

## 验证范围

P4 已按授权范围独立复验：本机隔离运行 229/229、Windows Actions runner 229/229、区域样例 11/11，并通过真实浏览器服务回归。详见 [P4 最终独立复验](docs/P4最终独立复验.md) 和 [Windows Actions run 38872663995](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/38872663995)。

普通用户设备上的双击和系统安全提示体验尚未实测；Windows runner 不等于 Windows 实机，也不代表所有 CPU 架构或离线首次安装均已验证。
