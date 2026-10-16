# DSH P0 技术验证

验证日期：2026-10-14。范围仅为 P0 的本地技术验证，不接入产品主启动流程，不修改根 `package.json`、全局设置或旧项目。工程、浏览器 UI 与单次真实模型工具轮次分别验证并分别留存证据。

## 验收结论

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 固定版本与隔离 | 通过 | `.research/dsh` 的 `HEAD` 是 `d743267388641bc76f17c45ce8b4c231aed1d32c`（detached）；该提交 `apps/cli/package.json`、独立安装的 `@deepseek-ai/dsh` 和 CLI `--version` 均为 `0.2.1-alpha.2`。独立依赖目录为 `adapters/dsh`。 |
| 最小官方配置 | 通过 | `web --dump-config` 检查 5 个组件行：JSONL session persistence、filesystem Skill、tool-skill、tools、Chat UI；全部存在。运行时 profile 使用项目内 patch 加载验证插件。 |
| Skill 发现和加载 | 通过 | `creative-studio` 从项目 `.agents/skills` 被 filesystem provider 发现并读取，来源为 `custom`；关闭默认根扫描和文件监视，不触碰全局 Skill。 |
| 工具注册与执行 | 通过 | DSH registry 实际注册 `studio_canvas_create_text_node`，再经 `ctx.tools.execute` 管线调用共享 `callCanvasTool`，在独立 Canvas 创建一个纯文本节点；工具 `isError=false`，后续 `canvas_get_state` 确认 marker 存在。没有调用图像生成。 |
| 会话写入与恢复 | 通过 | DSH JSONL persistence 写入 5 个事件，第二个 CLI 进程重新读取并重放；存储前缀逐事件匹配，DSH 在重放 seed 末尾添加标准 `session/end-seed` 边界。 |
| 业务 UI 扩展 | 浏览器实测通过 | 以独立 `dsh.client` 包进入 DSH 启动 graph，浏览器加载并实例化 bundle；实际注册 Conversation Definition、Chat View 与 keyed renderer。探针事件进入 snapshot 后，经 `uiWorkspace.openSession()` 进入官方 ChatFlow/ChatNodeSeat，页面显示自定义业务节点。截图与逐项回执见 [dsh-ui-report.json](evidence/p0/dsh-ui-report.json) 与 [dsh-ui-probe.png](evidence/p0/dsh-ui-probe.png)。 |
| 实际模型与工具轮次 | 补充实测通过 | 单独的真实 agent 轮次把已有 PNG 作为 DSH user image attachment，模型返回一条工具调用，工具通过共享 Canvas adapter 创建文本节点，随后模型回复完成。DSH durable session 记录 1 次 tool call、1 个成功结果；详见 [dsh-live-report.json](evidence/p0/dsh-live-report.json)。 |

完整汇总见 [dsh-report.json](evidence/p0/dsh-report.json)，精简成功回执见 [dsh-report.log](evidence/p0/dsh-report.log)。UI 独立回执与截图分别保存在 `docs/evidence/p0/dsh-ui-report.json`、`dsh-ui-probe.png`；真实模型轮次单独记录于 `dsh-live-report.json`。日志不含 Canvas 凭据、模型密钥或 API endpoint；模型内部引擎身份不能仅凭 provider 返回标签独立验证。初次纯工程验证本身未发起模型请求；后续真实模型测试作为独立补充，不混写成无凭据时的工程结果。

## 固定来源、版本与许可证

源码仓库固定为 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c)，checkout 精确提交 `d743267388641bc76f17c45ce8b4c231aed1d32c`。该提交 `apps/cli/package.json` 声明 `0.2.1-alpha.2`，与 npm CLI 包和运行时版本一致。直接依赖固定在 [adapters/dsh/package.json](../adapters/dsh/package.json) 和 [package-lock.json](../adapters/dsh/package-lock.json)；registry tarball URL、SHA-512 integrity 与许可证记录在 [dsh-report.json](evidence/p0/dsh-report.json)。

来源提交的 [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE) 为 MIT；锁文件中本次直接使用的 DSH 包也标记 MIT。已检查固定提交的架构说明、扩展 cookbook、工具扩展、Skill filesystem、session persistence 和 Conversation 类型／扩展文档。npm registry 未提供 `gitHead` 元数据，所以这里能确认“Git 提交固定、发布包版本相同、tarball integrity 固定”，不能进一步声称 npm tarball 可由该 Git SHA 逐字节构建。

独立适配器直接使用的 DSH 包固定为 `0.2.1-alpha.2`，Cordis 固定为 `4.0.5-alpha.1`；传递依赖由锁文件固定。实际执行 `npm ci --ignore-scripts --no-audit --no-fund` 成功（565 个包），随后在该干净安装上重跑浏览器验证并通过。该命令不运行依赖安装脚本；主 `package.json` 未修改。完整依赖清单由 `scripts/dependency-manifest.mjs` 从锁文件生成。

## 复查命令

在仓库根目录执行：

```bash
cd adapters/dsh
npm ci --ignore-scripts --no-audit --no-fund
npm run p0:ui:verify
cd ../..
STUDIO_DATA_DIR="$PWD/.p0-state/runtime" node scripts/dsh-p0-verify.mjs
```

`p0:ui:verify` 使用隔离 DSH Web profile 与临时本地端口，不发起模型或 Canvas 请求；它会编译插件、检查浏览器启动 graph、snapshot、slot 注册和实际 renderer。Canvas 工具验证需要独立 Canvas bridge 与一个已连接的编辑页；脚本只创建纯文本节点，并在结束时写入 `.p0-state/runtime/dsh-tool-complete`。如果没有编辑页，脚本会报告 `目标 Canvas 编辑页尚未连接` 并失败，不会生成备用节点或声称工具通过。最小 profile 检查也可独立复查：

```bash
DSH_HOME="$PWD/.research/dsh/.p0-evidence/profile-home" \
  node adapters/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config
```

检查 npm 发布工件元数据的命令：

```bash
npm view @deepseek-ai/dsh@0.2.1-alpha.2 version dist.tarball dist.integrity --json
```

## 接入边界

业务 UI 探针只验证纯文本节点的事件、snapshot、slot 与实际页面渲染；未接入主启动流程。真实模型补测使用 `@deepseek-ai/dsh-llm-pi-ai` 的 `openai-completions` adapter，DSH 记录请求模型 `grok-4.7`，provider 返回标签为 `grok-4.7-build`；不能据此独立确认 provider 内部引擎身份。模型 endpoint 与 API key 均未写入证据。图像来源是已有的 GPT Image 2 PNG，当前模型补测只读取图片并附加到 user message，没有再次生成图像。Canvas 生命周期仍由共享 Canvas bridge 管理。
