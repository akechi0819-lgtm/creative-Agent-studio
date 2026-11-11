# Creative Agent Studio

在本机完成图文创作、已有图片修改、透明标识适配和独立短视频制作。

## 下载

当前版本：**media-workflow.2**。完整文件与校验值见 [GitHub Release](https://github.com/akechi0819-lgtm/creative-Agent-studio/releases/tag/media-workflow.2)。

| 平台 | 安装包 |
| --- | --- |
| Mac（Apple 芯片） | [下载 Mac 版](https://github.com/akechi0819-lgtm/creative-Agent-studio/releases/download/media-workflow.2/Creative-Agent-Studio-media-workflow.2-macOS-arm64.zip) |
| Windows（64 位） | [下载 Windows 版](https://github.com/akechi0819-lgtm/creative-Agent-studio/releases/download/media-workflow.2/Creative-Agent-Studio-media-workflow.2-Windows-x64.zip) |

安装包尚未签名／公证，系统可能显示安全提示。

## 安装与开始使用

1. 下载并完整解压安装包。
2. Mac 打开 **Creative Agent Studio.app**，可将整个应用拖入“应用程序”；Windows 双击 **Start.vbs**，保留解压后的完整目录。
3. 首次启动可能联网准备 Python、OCR／Office 依赖和模型，后续会复用。
4. 在“模型与服务”选择对话来源、配置图片 API；需要短视频时再配置独立 H3 视频 API。
5. 在工作台描述需求、确认方案，查看生成结果并提出修改，确认成品后下载。

配置、素材和任务保存在本机。API Key 请在设置中填写，不要上传到仓库或发送到普通聊天。当前视频支持 MiniMax H3 独立文生视频，暂未接入参考图输入。

## 选择版本

| 版本 | 适用场景 |
| --- | --- |
| **完整版／个人版**（本分支） | 使用本机素材和自己的模型服务，提供完整创作工作台。 |
| [公司版](https://github.com/akechi0819-lgtm/creative-Agent-studio/tree/codex/company-edition) | 接入公司 Teedy 素材库，员工使用本人账号；提供独立安装包。 |
| [极简版](https://github.com/akechi0819-lgtm/creative-Agent-studio/tree/codex/company-lite) | 由 Codex 等外部宿主主持创作，调用共享 Canvas MCP，按源码安装。 |

## 使用与开发文档

- [在 Codex／代理宿主中使用](docs/代理宿主使用.md)
- [本地工作台使用与维护](docs/本地Web交付.md)
- [模型来源与配置说明](docs/模型来源与裁剪.md)
- [安装包与许可证说明](docs/P5运行包.md)
- [工程进度与验证记录](docs/工程进度.md)
