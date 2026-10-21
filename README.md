# Creative Agent Studio

把创作需求变成海报、多页图文和可交付文件的本机工作台。它运行在你的电脑上；GitHub 仓库不是在线服务。

## 选择版本

**个人版（P5 通用版）**面向个人电脑，使用本机素材与自己配置的 API。当前源码在仓库默认的 [main 分支](https://github.com/akechi0819-lgtm/creative-Agent-studio/tree/main)。共享修复与公司版按产品边界同步，当前进度见 [工程进度](docs/工程进度.md)。

**公司版**面向公司授权员工，使用公司现有 Teedy 素材库和与个人版相同的本地 Canvas，属于独立配置与接入路径。入口见 [codex/company-edition 分支](https://github.com/akechi0819-lgtm/creative-Agent-studio/tree/codex/company-edition)。公司版不是下方个人版成品包。

## 个人版成品下载

首次安装进度、防重复启动及控制台闪窗修正版 `p5-startup.1` 构建中；[修复记录](docs/Windows首次启动修复.md)。下表为上一轮成品。

目前没有正式 GitHub Release。下方是 2026-10-17 生成的 GitHub Actions 临时成品，来自 P5 Pull Request #1 的 run 39013487213。请下载对应平台的 artifact；artifact 容器内有产品 ZIP 和校验文件。它不是长期下载地址，GitHub 标示的到期时间如下：

| 平台 | Actions 成品 | 当前到期时间（北京时间） |
| --- | --- | --- |
| Apple 芯片 Mac（arm64） | [下载 Mac artifact](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39013487213/artifacts/12093554430) | 2026-10-31 15:30:50 |
| Windows 64 位（x64） | [下载 Windows artifact](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39013487213/artifacts/12094521018) | 2026-10-31 15:41:03 |

Mac artifact 已包含 AppTranslocation 隔离启动修复；旧 Mac 包有启动缺陷，请勿用旧包作为当前版本。修正版通过了自包含、只读磁盘启动和完整性检查，但原先报错的 Mac 设备仍待实际双击复测。当前包未完成 Developer ID 签名与公证，macOS 可能显示系统安全提示。

Windows 包由 Windows Actions runner 构建并完成包内启动检查；尚未在普通 Windows 设备上复测，也没有 Authenticode 签名。成品包的验证边界见 [P5 最终独立复验](docs/P5最终独立复验.md) 与 [Mac 隔离启动修复记录](docs/Mac运行包隔离启动修复.md)。

## 安装并首次启动成品包

先下载 Actions artifact 并解压 artifact 容器，再解压里面对应平台的产品 ZIP。

- **Mac：**打开 Creative Agent Studio.app。应用包含自己的运行文件，可以把整个 .app 拖到“应用程序”文件夹。不要只移动应用内部的文件。
- **Windows：**在解压出的完整产品目录中双击 Start.vbs。请保留整个目录，不要单独移动 Start.vbs。

成品包已包含 Node、网页、Canvas、DSH 和 Node 依赖，无需手动安装 npm 或编译。首次启动需要联网检查并准备 Python、OCR／Office 依赖及 OCR 模型；这些文件放在用户数据目录，不会修改系统默认 Python。首次准备可能需要一些时间。工作台在本机浏览器运行，成品包默认使用 http://127.0.0.1:4310。

## 配置两类 API

首次进入工作台后打开“模型与服务”：

| 设置 | 用途 |
| --- | --- |
| 基础 API | Web 对话、工具、读图和素材 AI 清洗 |
| 生图 API | Canvas 图片生成 |

如果同一家服务提供两种能力，可以复用服务地址和密钥，并分别选择适用的模型。连接或模型列表检查不会自动生成图片；保存配置也不等于已经验证所有上游能力。API 设置保存在本机，请勿上传配置或备份到公开仓库。

## 在 Codex 中创作

Codex 入口需要本机源码目录，不是上面的预构建成品包。先克隆个人版分支，再在本机 Codex 中打开仓库根目录：

    git clone --branch main --single-branch https://github.com/akechi0819-lgtm/creative-Agent-studio.git

准备依赖：

- Mac：在仓库根目录运行 ./Start.command prepare
- Windows PowerShell：运行 .\Start.cmd prepare

首次准备需要联网。它准备源码所需依赖和构建文件，不会启动 Web 工作台或 DSH。

Codex 会话负责对话与推理，项目共享工具按任务打开 Canvas；图片生成使用保存在 Creative Agent Studio 本机设置中的生图 API。Codex 路径不启动 Web DSH，也不切换到 Codex 自带的图片服务。只有在 Codex 任务中显式使用素材 AI 清洗时，才需要基础 API。

还没有设置图片 API 时，可先运行个人版工作台，在“模型与服务”保存设置，然后停止工作台服务，再回到 Codex。可通过项目 Skill 调用，也可以直接告诉 Codex：

> 请读取 AGENTS.md 和 .agents/skills/creative-studio/SKILL.md，使用本项目共享 CLI 帮我完成这次创作。我使用 Codex 入口，图片通过本机已保存的生图 API 和任务 Canvas 执行；不要启动 Web DSH。

更多入口与维护说明见 [Codex 创作入口](docs/Codex使用.md) 和 [本地 Web 交付与维护](docs/本地Web交付.md)。模型来源的实测范围与上游限制见 [模型来源与裁剪](docs/模型来源与裁剪.md)。
