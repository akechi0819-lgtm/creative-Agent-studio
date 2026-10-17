# Creative Agent Studio 公司版

基于已独立复验的 P5 桌面工作台，提供对话创作、公司历史素材参考、图文制作、文件处理、审核与素材包导出。Web／DSH 与 Codex 共用任务核心；Canvas 只执行绘图和图片工具。

公司版预配公司 Teedy 和新版远端 Canvas 地址。每位同事首次使用填写自己的素材库账号密码，以及基础／生图两类 API；模型配置保存本机，不需要到远端 Canvas 再填写一次。素材访问继续受 Teedy 账号及 ACL 控制，包内没有共享账号、密码或模型钥匙。

## 普通同事使用

获取公司版对应平台的成品 ZIP，完整解压到可写目录：

- Apple 芯片 Mac：双击公司版 `.app`。
- Windows 64 位：双击 `Start-Company.vbs`。

运行包携带 Node、生产依赖与已构建 Web／DSH／Canvas 文件，无需员工运行 npm 安装或编译。首次启动会独立检查 Python、OCR／Office 依赖和模型，缺少时可能联网准备；已有健康环境复用。继承 P5 的这项交付边界，不宣传为完全离线安装包。

按首次引导填写个人账号和两类 API，保存后在左侧讨论需求、选择参考并确认方案。右侧展示参考原图与成品。明确确认执行／交付继续绑定当前版本和图片 SHA，保留人工最终判断。

公司数据使用独立 `Creative Agent Studio Company` 目录，默认本机端口 4311。素材库只读检索，人工保留后才下载原件并冻结正文、附件顺序和 SHA-256。远端画布存储仍在员工浏览器 IndexedDB，任务回收图与导出在本机公司数据目录。

## 管理员与开发者

公司分支为 `codex/company-edition`。公司部署 JSON 从源码外注入运行包，不写公开仓库；只有 Teedy 与 Canvas 地址，不允许员工接口改写。配置格式、构建与验证边界见 [公司版接入](docs/公司版接入.md)。远端 Canvas 前端需与本分支任务桥接协议一致，前端更新不覆盖原 Teedy 挂靠、反向代理、网络、数据卷或 ACL。

源码开发入口仍为 `Start.command`／`Start.cmd`，与普通同事成品包入口分开。Codex 使用 [项目 Skill](.agents/skills/creative-studio/SKILL.md) 和 [共享 CLI](docs/Codex使用.md)，不启动 DSH；公司素材搜索用 `node scripts/company.mjs search @payload.json`。

P5 通用版基线通过范围见 [最终独立复验](docs/P5最终独立复验.md)。公司新增范围的进度与证据见 [工程进度](docs/工程进度.md)和[公司版自检](docs/公司版自检.md)，不把通用版通过冒充公司现网或员工设备验证。未签名提示与普通设备双击体验按实际证据记录。
