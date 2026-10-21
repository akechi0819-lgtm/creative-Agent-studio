# 公司 Windows 原包首次安装与控制台闪窗修复

2026-10-21，用户授权直接修复公司原包，版本目标 `company-p5.1.4`。使用隔离工作树，未合入原公司工作区尚未提交的素材改动，不复制员工运行数据。

## 已确认的问题

员工日志显示 Python 3.12 安装用时约16秒；随后 OCR 固定依赖仍陆续完成下载，但达到30分钟命令总超时后被终止。期间再次启动3次，新增准备进程每500ms等待安装锁，15分钟后分别失败。旧 Windows 窗口只在进程结束后读取输出，用户看不到实际下载进展。

原包还存在多个日常子进程未设置 Windows 隐藏窗口的调用，涉及 OCR、Canvas、模型插件和浏览器打开。不能将员工观察到的全部闪窗归因于 WorkBuddy，也不能仅凭此日志认定下载慢的底层原因。

## 修复

- 正式启动器在准备 Python 前取得按数据目录隔离的原子启动锁。重复启动立即提示；已退出进程的有效锁可回收，释放时核对本人 token。
- Python 准备输出同时写私有日志并实时显示，失败展示本次具体错误和日志路径，不混入之前失败的尾部。
- Windows 界面显示滚动输出、实际耗时和打开日志按钮；GUI 使用按产品和数据目录隔离的非阻塞互斥，空行也能正常显示。完整错误保留供查看，不显示虚构百分比。
- OCR依赖同步由固定30分钟总时限改为30分钟无输出时限和2小时总上限；有实际进展会刷新无输出计时。uv缓存、已有解释器和未完成stage继续复用，不清空用户数据，不更换依赖源、不降低哈希或导入验证。
- 补齐项目自有子进程的 `windowsHide`。WorkBuddy内嵌登录浏览器通过现有构建变换补同一选项，固定上游输入不变。
- 成品仍用 `Start-Company.vbs`，不要求用户补 npm 或开发依赖；正式入口只检查准备 Python。素材账号、模型配置、公司数据目录及本地 Canvas 不变。

## 验证

### 源码与回归

公司版本机 Node 回归为 354 项，353 项通过、1 项 Windows PowerShell 专属测试跳过；公司分支 Windows 源码 CI [run 39565191148](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39565191148) 为 352 项通过、2 项平台专属测试跳过。个人版本机回归为 317 项，316 项通过、1 项 Windows 专属测试跳过；个人版 Windows 源码 CI [run 39567504298](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39567504298) 首次 Office recalculation 校验失败后只重跑一次并成功，最终 316 项通过、1 项跳过；新增修复用例没有失败。首次失败与单次重跑均保留在 CI 历史中，不将重跑结果写成首次运行即通过。

### 双平台原生包与文件校验

个人版和公司版的 Mac、Windows native build 均成功，产品包已下载并核验 artifact digest、产品 ZIP CRC、sidecar SHA-256 与 manifest 文件 SHA-256。

| 版本 | 平台 | Actions artifact | 产品 ZIP SHA-256 | manifest 文件 | 到期时间（北京时间） |
| --- | --- | --- | --- | ---: | --- |
| company-p5.1.4 | macOS arm64 | [12330321033](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39565191478/artifacts/12330321033) | 026704ab119b41d105a8c8b4f0a544ec4da5b6559f8cfd2774d366014c8babf0 | 76,730 | 2026-11-04 15:59:52 |
| company-p5.1.4 | Windows x64 | [12329329237](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39565191478/artifacts/12329329237) | d98b7daeedd319ff70595a2fbef383138fef60cfc72b97746fee336b60ca30ce | 74,000 | 2026-11-04 16:02:51 |

公司双平台 native build 来自 [run 39565191478](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39565191478)，Personal 成品见其 README。Artifact 是有保留期的 Actions 候选包，不代表长期 Release。

### 用户实际路径与剩余边界

最终成品包通过 Windows 2025 GUI 上的真实 VBS 入口完成冷启动、首次配置、停止与重启流程。[最终验证工作流 run 39575253721](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39575253721) 的 Company 与 General 两个 job 均成功：

| 版本 | Job | GUI证据 artifact |
| --- | --- | --- |
| Company | 119139075265 | [12334481482](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39575253721/artifacts/12334481482) |
| General | 119139075613 | [12334007380](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39575253721/artifacts/12334007380) |

测试覆盖首次冷启动准备进度与重复启动拦截；在真实工作台 UI 中分别保存基础 API 与生图 API 地址、模型和合成密钥，验证 Kilo 无密钥也能保存；刷新后不重复展示配置引导，并可打开本地 Canvas。停止服务再启动后，已保存配置仍在，热启动时追加一条准备入口日志，Python、依赖和模型仍处于 ready 状态；解释器路径、依赖指纹及模型文件 SHA 保持一致。公司包 74,000 项、个人包 73,986 项 manifest 文件均逐项保持不变。

被测公司版与个人版产品源码提交分别为 41cf82b 和 a3de7a9；GUI 驱动／验证源码提交为 f4b8535。本轮没有修改成品包，所以原生下载包的 artifact、产品 ZIP SHA-256 与 manifest 数量仍是前表所列，不把 GUI 证据 artifact 当成新的产品包。

模型列表请求使用本机 fixture，未调用图片生成；Teedy 请求数为 0，未连接真实公司素材服务。控制台窗口通过窗口 class 与轮询监控，配置阶段采样约 100ms，启动器 UIA 采样间隔为数秒。本轮未观察到新增可见控制台；该观察不代表所有设备、路径和时序下都不会闪窗，原报错员工电脑尚未复测。

### GUI验证历史

| 工作流 | 结果 |
| --- | --- |
| [39571640875](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39571640875) | 测试驱动 Drawing 引用编译失败，产品未启动。 |
| [39572355102](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39572355102) | 真实 VBS 界面及重复启动拦截成功；驱动因 UIA 快照排除 RichEdit 正文而误判日志路径断言。 |
| [39574096076](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39574096076) | Windows PowerShell 5 按默认 ANSI 编码读取 UTF-8 中文日志，导致“prepare记录数应为1、实际为0”的断言失败。 |
| [39574962710](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39574962710) | 为修正热启动采样和空行断言而提前取消，未作为产品验证结果。 |
| [39575253721](https://github.com/akechi0819-lgtm/creative-Agent-studio/actions/runs/39575253721) | Company 与 General 两个最终用户路径 job 均成功。 |

原报错员工电脑与 Mac 尚未复测；真实员工 Teedy 登录、ACL 和付费图片生成未验证。Mac 未完成 Developer ID 签名与公证，Windows 未完成 Authenticode 签名。CI 结果不扩张到这些设备、账号和上游能力。
