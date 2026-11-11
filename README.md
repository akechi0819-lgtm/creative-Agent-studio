# Creative Agent Studio 公司版

面向公司员工的本机创作工作台，可讨论并制作图文、适配透明标识、生成独立短视频、处理文件、审核和导出成品。GitHub 仓库不是在线工作台。

## 下载与安装

当前版本：**company-media.2**。完整文件与校验值见 [GitHub Release](https://github.com/akechi0819-lgtm/creative-Agent-studio/releases/tag/company-media.2)。

| 平台 | 下载 |
| --- | --- |
| Apple 芯片 Mac | [Creative Agent Studio Company（macOS arm64）](https://github.com/akechi0819-lgtm/creative-Agent-studio/releases/download/company-media.2/Creative-Agent-Studio-Company-company-media.2-macOS-arm64.zip) |
| Windows 64 位 | [Creative Agent Studio Company（Windows x64）](https://github.com/akechi0819-lgtm/creative-Agent-studio/releases/download/company-media.2/Creative-Agent-Studio-Company-company-media.2-Windows-x64.zip) |

下载对应平台的 ZIP 并完整解压到本机目录：

- **Mac：**打开 `Creative Agent Studio Company.app`。
- **Windows：**在解压后的完整目录中打开 `Start-Company.vbs`。请保留该目录中的其他文件。

运行包不要求安装 npm 或编译。当前 Mac 包未做 Developer ID 签名与公证，Windows 包未做 Authenticode 签名，系统可能显示安全提示；请按公司 IT 的分发流程处理。首次启动可能需要联网准备 Python、OCR／Office 依赖及模型文件，可能比之后启动更久；本产品不是完全离线安装包。

工作台在本机浏览器打开，默认地址为 `127.0.0.1:4311`。公司版使用独立本机数据目录：Mac 为 `~/Library/Application Support/Creative Agent Studio Company`，Windows 为 `%LOCALAPPDATA%/Creative Agent Studio Company`。请勿与个人版混用数据目录。

## 首次配置与使用

1. 按引导填写**本人**的 Teedy 账号和密码。公司素材库地址已由管理员预置，素材检索为只读，实际访问仍受个人账号和 ACL 限制。
2. 按管理员提供的接入方式选择对话服务，并单独配置图片生成服务。若需要填写 API 密钥，请只使用获准的个人或公司凭据；配置保存在本机，不要分享配置文件、日志或备份。
3. 可选配置独立的 MiniMax H3 视频服务。它用于从文字生成独立短视频；当前不支持把已有图片作为视频参考来生成。
4. 在左侧讨论需求、选择并确认参考与方案；在右侧查看结果。确认后可审核并导出交付文件。

从 Teedy 检索到的候选不会自动用于创作；只有选择保留后，原件才会下载并冻结到该任务。任务、原图、生成结果和导出保存在本机公司数据目录。备份也可能包含个人配置，请作为私密文件保存。Logo 变体会进入本机素材库草稿，清洗并经人工确认后才可作为正式素材使用；不会写回 Teedy。

## 使用说明

- [公司版接入与首次配置](docs/公司版接入.md)：员工配置、素材权限与管理员服务预配。
- [本地 Web 使用与维护](docs/本地Web交付.md)：启动、备份、更新与维护。
- [代理宿主创作入口](docs/代理宿主使用.md)：在 Codex 等代理宿主中使用共享 CLI 与本地 Canvas。
- [全部文档导航](docs/README.md)：其他用户说明与项目资料。
