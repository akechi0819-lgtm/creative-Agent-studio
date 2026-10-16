# 本地 Web 使用与维护

P4 施工交付说明，2026-10-16。最终测试和未验证项见 [P4实施与验证](P4实施与验证.md)。产品运行在本机浏览器；公开源码仓库不等于部署公网服务。

## 独立工作台

下载完整仓库并解压到可写目录。macOS 双击 `Start.command`，Windows 双击 `Start.cmd`。首次运行需要联网下载固定 Node（系统已有合格版本时复用）、固定 npm 依赖、私有 Python／OCR 依赖与模型，然后构建产品；无需手动分别启动 Canvas、模型插件和 DSH。不要将目录放到只读位置；路径可以包含空格和中文。macOS 从 ZIP 解压后如入口没有执行权限，可在终端执行 `chmod +x Start.command scripts/bootstrap-node.sh`；系统安全提示和 Windows SmartScreen 的普通用户体验须单独实测，不能用 CI 替代。

打开后进入本地 Web 工作台，首次在“模型与服务”配置基础 API 和生图 API。基础 API 用于独立工作台对话、工具和读图；生图 API 用于 Canvas。可以使用自己的 API。OpenCode 的上游限制、Kilo 已验证范围及 WorkBuddy 本人登录待验证范围见 [模型来源与裁剪](模型来源与裁剪.md)。保存配置不代表已经向上游发起创作或验证全部能力。

启动窗口保留简短中文维护菜单：打开工作台、停止、备份、更新、恢复和诊断。退出菜单会让本机服务继续运行；停止操作会通过本机身份校验接口正常关闭工作台、当前任务 Canvas 和模型插件。再次双击会复用同数据目录已经健康运行的实例，使用其现有地址。端口默认动态分配，不抢占 4310。

Canvas 按任务打开，执行绘图和原像素工具，不召唤 Agent。制作单、参考与最终成品的人工作用及版本规则继续保留；未知图片请求恢复时只查询，不自动重复付费。

## Codex 入口

在 Codex 打开仓库，按项目 Skill 使用共享 CLI。首次也需准备依赖，可以用入口菜单先准备工作台再停止，或执行 `node scripts/prepare.mjs`。之后 Codex 调用 `node scripts/studio.mjs`，按任务启动 Canvas，**不启动独立 Web DSH**。完整合同见 [Codex使用](Codex使用.md)。准备命令只安装依赖、构建文件，不运行 DSH Agent。

## 数据、备份与恢复

默认用户数据目录：macOS 为 `~/Library/Application Support/Creative Agent Studio`；Windows 为 `%LOCALAPPDATA%\Creative Agent Studio`；Linux 为 `$XDG_DATA_HOME/creative-agent-studio`，未设置时为 `~/.local/share/creative-agent-studio`。可以用 `STUDIO_DATA_DIR` 指定独立目录。

任务、素材、来源、审核、导出、DNA 和本地 API 配置存于用户数据目录。P4 新增任务 Canvas 本地持久化：画布记录与原图存入各任务 Canvas 的 `storage/`，纳入停机备份。浏览器个人资料、旧版 IndexedDB 和全局配置不复制；旧浏览器中尚未写入本地持久化的数据不自动迁移。不要清理旧浏览器来测试恢复。

菜单中的备份／恢复／更新先正常停止本数据目录工作台。另一个 Codex CLI、独立 Canvas 或清洗仍运行时，维护会提示先退出，避免混合写入。备份默认为用户数据目录旁的 `Creative Agent Studio backups/时间-随机号/`，包含 `manifest.json` 和 `data/`，逐文件记录 SHA-256；临时实例 token、运行锁和服务日志不纳入。备份包含用户 API 配置，须按私有文件保管，不上传 GitHub。Git 只保护源码。

恢复先校验清单、路径与所有文件哈希，再完整替换数据目录；当前数据保存在旁边的 `.before-restore-随机号` 目录，不覆盖或删除它。损坏备份直接拒绝。恢复成功后重新打开入口，核对任务与成品。维护期间请关闭 Canvas 网页；服务停止后页面无法继续保存编辑。

## 更新与失败恢复

从确定版本下载新源码，或由维护者切换已核对的本地 Git 版本；不需要普通用户修改源码。入口“更新”先停机并备份用户数据，再按当前源码锁文件安装与构建；不自动选择远端、拉取分支或覆盖用户配置。更新失败保留备份和失败状态，下次更新可重试。源码回滚见 [Git版本与回滚](Git版本与回滚.md)；切换源码后重新准备依赖，数据恢复使用上面的独立备份。

正在使用同一源码目录的工作台未退出时，不重建覆盖其构建产物。可以把新源码放另一个目录验证；使用不同 `STUDIO_DATA_DIR`，避免连接真实任务。不同源码版本不要同时推进同一任务。

## 诊断与开发命令

在仓库目录运行（普通用户也可使用菜单）：

```sh
node scripts/launcher.mjs start --no-open --port 0
node scripts/launcher.mjs status
node scripts/launcher.mjs stop
node scripts/launcher.mjs doctor
node scripts/launcher.mjs backup --destination /absolute/private-backup
node scripts/launcher.mjs restore --from /absolute/private-backup
node scripts/launcher.mjs update
```

Windows 路径有空格时加双引号。`start` 最后一行返回本机地址与实例状态；`status`、`doctor` 不输出 API Key。详细日志在用户数据目录的 `web/service.log`，首次准备失败状态在源码 `.studio-runtime/prepare-state.json`。先检查网络是否可访问 Node 官方下载站、GitHub 官方运行时发布、npm／PyPI 及 OCR 模型源，再重试准备；没有健康就绪时不会将旧项目当成当前服务。

服务崩溃后，再次启动会核对锁 PID 是否仍活着；已退出的残留锁可恢复。进程仍活着但身份健康检查失败时不会按 PID 强杀，先查看诊断。上游生成请求未知时不要重复点击收费重试，按任务恢复说明查询结果。
