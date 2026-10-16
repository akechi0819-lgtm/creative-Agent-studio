# P4 Windows runner 验证

`.github/workflows/windows-ci.yml` 在 GitHub Actions 的 `windows-latest` 真 Windows runner 上执行锁定依赖安装、Web 构建、运行时准备、Node 测试、区域检测图片样例和浏览器服务回归。工作流支持 push、pull request 和手动触发，纯 Markdown 变更不会触发 push／pull request 回归。本地验证通过不等于 Windows runner 已通过；云端结论只在工作流实际运行后记录。

工作流使用 Node.js 22.23.3，与根 `package.json` 声明的 Node 22 引擎范围兼容。`verify-p4-tests.mjs` 从 `tests/` 递归枚举 `.test.mjs` 文件并直接调用 Node test runner，避免依赖 Windows shell 对 POSIX glob 的展开；它会强制使用项目私有 `.venv-ocr` Python，因此两页扫描 PDF OCR 与无字图片回归不会因运行时缺失而静默跳过。`verify-p4-python.mjs` 检查固定版本、四个依赖导入、私有模型缓存和实际 RapidOCR no-text／文字样例。`verify-p4-images.mjs` 单独运行 PNG/JPEG 条码、文字、矩形和无目标样例，便于在完整测试之外看清区域检测回归结果。

首次准备会下载固定校验和的 uv、项目私有 Python 3.12.15、哈希锁定的 OCR 依赖和 RapidOCR 模型。运行时、模型和下载缓存写入 `.studio-runtime/`，虚拟环境写入 `.venv-ocr/`；后续准备按源码与依赖指纹检查并复用。首次下载总量随操作系统、CPU 架构和可用 wheel 变化，受网络速度影响可能需要一段时间；Actions 会缓存这些项目私有目录，避免每次运行重新下载。

`verify-p4-service.mjs` 使用临时 `STUDIO_DATA_DIR` 和动态端口，验证重复启动保留同一实例、保存虚构基础／生图配置且不做连接测试、创建合成任务并附加本地图片、用机械 Canvas import 导入原图，以及关闭首个 Canvas 浏览器 context 后由新 context 恢复同任务节点和图片原始字节。关闭首个 context 前会从服务端 `app_state` 确认当前项目已保存导入节点，并确认图片原字节已写入；不会把工具调用返回当作自动保存完成。脚本还检查浏览器异常和跨源请求，只记录并允许本任务的 workbench、Canvas 与 bridge loopback 起源，以及固定提示词目录的精确只读 `GET`（`raw.githubusercontent.com/yukkcat/image-prompts/main/dist/sources/*.json`），并拒绝其他外部请求或非 `GET` 请求。测试只用合成配置和图片，不调用付费模型，也不复用用户服务或任务数据。

Windows runner 经 `cmd /c Start.cmd prepare` 进入正式 Windows 薄入口；它会复用 Actions 已安装的合格 Node，并通过共享 launcher 准备固定 npm 依赖、构建 Web／Canvas／DSH 和 WorkBuddy 模块、准备私有 OCR Python。之后 workflow 会临时清除 Node 所在 PATH，再运行 `cmd /c Start.cmd status`，验证 Windows PowerShell Node 私有下载分支；Playwright Chromium 和回归脚本随后单独执行。`bootstrap-node.ps1` 对固定 Node 压缩包使用 .NET `System.Security.Cryptography.SHA256` 计算文件哈希，并在解压前逐字节比较平台对应的固定 SHA-256；通过 `System.IO.Compression.ZipFile` 解压，避免依赖 PowerShell 哈希和压缩模块自动导入。

在已安装固定依赖、且 Playwright Chromium 已就绪的本机隔离源码副本中，可运行：

```text
npm ci
npm run web:build
node scripts/prepare.mjs
npx playwright install chromium
node scripts/verify-p4-python.mjs
node scripts/verify-p4-tests.mjs
node scripts/verify-p4-images.mjs
node scripts/verify-p4-service.mjs
```

若在 Windows 隔离源码副本中验证用户入口，可用 `cmd /c Start.cmd prepare` 替代直接调用 `node scripts/prepare.mjs`；仅当系统没有合格 Node.js 时，薄入口才会下载项目私有固定版本。

每个验证脚本均可使用 `--root <隔离仓库路径>` 或 `STUDIO_REPO_ROOT` 指定源码副本。浏览器脚本独立创建临时数据目录和动态端口；如果在本机回归，应在复制的源码目录中构建，以免覆盖正在使用的 `web/dist`。

证据记录：

| 证据 | 当前状态 |
| --- | --- |
| 本机隔离源码／集成回归 | macOS 隔离副本首次准备、更新和构建通过；Node 测试 219/219、0 跳过，区域图片样例 9/9，Python 3.12.15／uv 0.12.24 与固定 OCR 导入、模型 warm-up 检查通过。服务回归验证合成图导入、新浏览器 context 恢复原图、真实二维码合成独立解码、框外 610,199 像素不变和正常停机。日志位于本机忽略目录 `docs/evidence/p4/`。 |
| GitHub Actions Windows runner | run `38841324019` 的依赖准备、构建和 OCR 准备通过；无系统 Node 分支因 Windows PowerShell 5 找不到 `Get-FileHash` 失败。现已改用 .NET SHA-256 实现，等待修复提交后的 runner 重跑；完整 Windows workflow 尚未通过。 |
| Windows 实机与普通用户 `.cmd` 双击体验 | 未验证；与 CI 分开记录 |

本机隔离回归包含扫描 PDF OCR、无字图片和中英文识别样例；编码测试还用 `cp1252` 子进程验证中文识别结果仍可输出为 UTF-8 JSON。以上仅证明当前 macOS 隔离运行结果，不代表 Windows runner 或普通用户设备验证。
