# 公司版本地Web使用与维护

公司成品下载、平台版本与Mac旧包撤回说明以 [README](../README.md) 为准。个人版成品和源码见 [main](https://github.com/akechi0819-lgtm/creative-Agent-studio/tree/main)，不要把两版数据目录或服务模式混用。

## 成品启动与首次配置

完整解压下载件；Actions外层artifact中另有产品ZIP及校验和。Mac修正版使用自包含 `Creative Agent Studio Company.app`，可以整体移到应用程序目录；Windows保留完整目录并双击 `Start-Company.vbs`。包内已有Node、生产依赖和已构建界面；首次可能联网准备Python、OCR／Office及模型，健康环境复用，不是完全离线包。

启动后默认打开本机4311工作台。员工按引导填写本人Teedy账号密码、对话和生图API；公司服务地址由管理员预配，用户不需要在远端Canvas重复填写模型钥匙。详细职责及边界见 [公司版接入](公司版接入.md)。左侧讨论素材用途和制作方案，右侧预览；确认与导出绑定当前版本和图片SHA。

Mac启动菜单可打开、停止和查看状态；Windows启动窗口可启动或停止。源码维护菜单与成品图形入口不同，不要为成品运行npm安装或源码prepare。

## 源码开发与Codex

公司分支为 `codex/company-edition`。在可写源码目录运行Mac `Start.command` 或Windows `Start.cmd`；`prepare`只准备依赖，`start --no-open`用于命令行启动。源码启动器默认4311，可显式用 `--port`指定隔离测试端口。管理员部署配置从仓库外提供，不能把地址或员工凭据硬编码进公开源码。

Codex使用 [项目Skill](../.agents/skills/creative-studio/SKILL.md) 和 [共享CLI](Codex使用.md)，不启动DSH。图片仍走当前任务Canvas和本机生图API，公司素材通过只读工具检索。旧全局MCP／Skill和旧项目配置不改动。

## 数据与维护

Mac数据目录 `~/Library/Application Support/Creative Agent Studio Company`，Windows为 `%LOCALAPPDATA%/Creative Agent Studio Company`。测试用独立 `STUDIO_DATA_DIR`；不要启动第二套程序同时操作同一目录。

源码维护菜单提供备份、恢复、更新和诊断。更新只准备当前源码版本，不能代替Git获取新源码；备份、恢复前正常停止服务。备份包含个人配置，应私下保存，不上传GitHub。模型、日志和任务写数据目录，不写只读app目录。

本机备份含任务快照、回收图及交付文件；远端Canvas浏览器IndexedDB不属于本机备份，也不是员工间共享数据库。公司桥接token与浏览器资料不打入备份。源码回退与数据恢复是不同操作，见 [Git版本与回滚](Git版本与回滚.md)。

## 构建与验证

公司Canvas需要分别验证local和remote构建：通用本地Canvas浏览器测试要求local dist；公司远端协议检查使用remote profile。构建remote后直接跑local测试会造成票据未消费及连接失败，不应以此改坏产品协议。构建脚本和原生包记录见 [公司版自检](公司版自检.md)。

真实员工登录／ACL、远端升级后的付费任务、普通设备双击和签名范围按报告记录，不能将合成服务或CI通过视为这些全部通过。
