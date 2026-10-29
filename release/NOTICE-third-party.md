# 第三方组件与模型 NOTICE

本文件与包内 `THIRD-PARTY-LICENSES.json` 一起记录 Company Lite 成品中可检查的组件许可证信息和定位路径，不构成法律意见。运行依赖的包名、版本、许可证声明、安装路径及许可证文件由打包器从成品 `node_modules` 清点。

## Node.js 与 Canvas

- 成品使用 Node.js v22.23.3 官方平台归档，并保留解压后的 `LICENSE`。上游：[Node.js v22.23.3](https://nodejs.org/dist/v22.23.3/)。
- Canvas Agent 来源于 `third_party/canvas`；保留其 `LICENSE` 和运行时依赖各自随包带入的许可材料。

## 运行边界

- 成品以解压后的能力包根目录作为 WorkBuddy 工作目录，包含固定版本 Node、轻量配置 CLI、Canvas 控制 CLI、本地 Canvas 和对应平台的薄启动包装器；包装器只调用包内 Node，不修改系统 PATH，也不要求员工安装 Node/npm。
- 成品不包含 DSH、独立设置网页、完整 Studio Web 对话、Python/OCR/Office 运行环境或用户配置与任务数据。图像显示与绘制由本地 Canvas 处理，不安装 Python。
- 本清单列明随包文件的可见证据。许可条款、上游组件或分发方式变化时，应重新检查相应材料。
