# 本地 Web 交付与维护

Creative Agent Studio 运行在本机浏览器，不会因为下载源码或成品包而部署到公网。个人版当前下载入口、临时 artifact 和到期时间见 [README](../README.md)；目前没有正式 GitHub Release。

## 成品包与源码入口

| 用途 | Mac | Windows |
| --- | --- | --- |
| 个人版成品包 | 双击 Creative Agent Studio.app；它自包含，可整体移到“应用程序” | 在完整解压目录中双击 Start.vbs；必须保留同目录的运行文件 |
| 源码开发／Codex | 仓库根目录运行 Start.command | 仓库根目录运行 Start.cmd |

成品包和源码目录的启动方式不同。成品包已带 Node、前端、Canvas、DSH 和 Node 依赖，不需要安装 npm 或自行构建。源码入口会准备源码运行时与依赖；Mac 使用 Start.command，Windows 使用 Start.cmd。源码首次准备需要联网，可在仓库根目录运行 Start.command prepare 或 Start.cmd prepare；prepare 只准备依赖和构建文件，不启动 Web 工作台。

个人版 P5 源码位于 main 分支；公司版位于 codex/company-edition 分支。两者的素材来源和 Canvas 接入方式不同，不要把公司版入口当成个人版运行包。

## 首次启动和 API 设置

成品包首次启动会检查并准备 Python 3.12、OCR／Office 依赖及 OCR 模型。主包没有捆绑这套 Python 环境；首次准备需要联网，文件保存在本机应用数据目录，不修改系统默认 Python。准备完成后会打开本机工作台。

成品包默认监听 127.0.0.1:4310。若该端口已经被其他程序占用，先停止占用端口的本机工作台再启动。源码启动器默认动态选择可用端口，实际地址以启动器显示为准；不要把源码入口的端口行为套到成品包上。

在“模型与服务”中分别设置：

- 基础 API：Web 对话、工具、读图和素材 AI 清洗。
- 生图 API：当前任务 Canvas 的图片生成。

同一服务商可以复用地址和密钥，但需要选择对应模型。保存设置不等于已经实测完整的上游能力；设置页面的连接或模型列表检查不会自动发起图片生成。

## 启动、停止与备份

成品包的图形入口只负责基本运行控制：Mac 对话框可启动／打开、停止和查看状态；Windows 的 Start.vbs 可启动／打开或停止。成品包没有源码维护菜单中的备份、恢复和依赖重建操作。

源码入口不带参数时会先启动工作台，再显示维护菜单。菜单提供打开、停止、备份、更新当前源码依赖、恢复和诊断。源码“更新”只备份并准备当前已有源码，不会自动下载新版本或执行 git pull。

停止工作台后可复制整个用户数据目录作为备份。配置内含 API 密钥，备份属于私密文件。默认数据目录为：

- Mac：~/Library/Application Support/Creative Agent Studio
- Windows：%LOCALAPPDATA%\Creative Agent Studio
- Linux：$XDG_DATA_HOME/creative-agent-studio；未设置时为 ~/.local/share/creative-agent-studio

不要让成品包、源码工作台或 Codex 同时写入同一个用户数据目录。切换到另一个版本前先停止当前工作台；恢复前保留现有数据目录副本。

## 当前验证范围

P5 通用版已按源码、隔离桌面交互、Mac 包本机点验及双平台原生 Actions 包构建的范围完成独立复验。后续发现的 Mac AppTranslocation 缺陷已修复，并通过只读磁盘、搬移与包内文件完整性检查；原报错 Mac 设备的实际双击复测仍待完成。

Windows 原生 Actions runner 已检查包内启动和服务控制；这不代表普通 Windows 电脑实测。Mac 与 Windows 均未完成面向用户的系统签名（Mac 也未公证）。详细证据见 [P5 最终独立复验](P5最终独立复验.md) 和 [Mac 隔离启动修复记录](Mac运行包隔离启动修复.md)。
