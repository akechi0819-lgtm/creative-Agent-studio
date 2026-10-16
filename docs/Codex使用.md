# Codex 创作入口

首次准备使用 `node scripts/prepare.mjs` 或双平台入口菜单；该命令只准备依赖与构建，不启动 Web DSH。数据和维护见 [本地 Web 使用与维护](本地Web交付.md)。

2026-10-15 新增受限局部修改入口：用户明确要求修改已有图片时，调用 `edit-pages TASK_ID @payload.json`，不重新走完整素材与制作单确认；恢复单页使用 `restore-page`。首轮完整创作仍按原确认流程。参数、真实原图传递、审核与授权边界见 [对话局部改图](P3对话局部改图.md) 及项目 Skill。

**当前状态：P1 返工后已独立复验通过，按阶段范围验收通过。** 返工合同测试 32/32 通过，历史完整性核验确认 19 个原文件哈希一致；未发起收费请求，未修改真实任务或两份历史 ZIP。见 [返工合同测试日志](evidence/p1-rework/contract-tests.log)、[历史完整性回执](evidence/p1-rework/history-integrity.json)、[实施线程记录](P1验收.md) 与 [独立验收记录](P1独立验收.md)。

这不代表完整首版或独立 Studio 已交付。P2 本地素材库与 DNA 共享核心及标签清洗冲突修复已独立复验通过（59/59 测试、四种额外并发夹具、206 文件完整性未变），按阶段范围验收，见 [P2独立验收](P2独立验收.md)；P3 Web UI 与创作链路已完成实施自验，仍待独立验收；P4 macOS 安装与完整验收尚未授权。每项新创作仍须取得用户对需求与来源、制作单版本及最终成品的明确确认；本次验收的批准不适用于后续任务。

## 运行边界与数据位置

在仓库根目录运行 `node scripts/studio.mjs`。Codex 创作路径使用本地 Canvas 和共享任务核心，不启动 DSH，也不运行 `codex exec`。首次使用按项目准备说明安装固定依赖并准备本产品的独立 Canvas 实例；不得连接旧 Canvas 实例。

任务保存在系统用户数据目录下的 `tasks/`：macOS 为 `~/Library/Application Support/Creative Agent Studio/tasks/`；Windows 为 `%LOCALAPPDATA%\Creative Agent Studio\tasks\`；Linux 为 `$XDG_DATA_HOME/creative-agent-studio/tasks/`，未设置时为 `~/.local/share/creative-agent-studio/tasks/`。源码目录与任务数据分开。

隔离开发或无收费 smoke 时，可以仅为该次 CLI 进程设置项目已有的 `STUDIO_DATA_DIR` 指向临时目录；未设置时始终使用上述系统目录。不要在该临时目录保存正式任务。

所有写入命令从 JSON 文件读取输入，不把 JSON 内嵌在 shell 命令中。格式为 `node scripts/studio.mjs ACTION TASK_ID @payload.json`。`create` 不带任务 ID；`list`、`show` 和 `lock-status` 不需要 payload。除新建任务的 `create` 外，所有修改已有任务 JSON 的公开状态命令都必须带从 `show` 读取的正整数 `expectedRevision`；`confirm-inputs` 使用正整数 `revision` 作为该命令的版本比较值。命令不得缺省版本，也不得由 CLI 自动读取最新版本来补字段。`unlock` 仅维护独立锁记录，不修改任务 JSON，属于例外：只要求 `deadPid`，并由 CLI 核对锁所有者和 PID 已退出，不做 task revision CAS。命令输出只显示任务信息或结果摘要；错误提示不包含底层异常或配置内容，常见凭据字段和令牌会在输出中隐藏。

## 命令与 payload

| 命令 | JSON 文件内容 |
| --- | --- |
| `create @payload.json` | `{"title":"任务标题","brief":"制作需求"}` |
| `set-brief TASK_ID @payload.json` | `{"brief":"更新后的制作需求","expectedRevision":1}` |
| `set-sources TASK_ID @payload.json` | `{"sources":[{"id":"source-1","decision":"retained","title":"来源名称"}],"expectedRevision":2}`；每项最终须为 `retained` 或 `excluded` |
| `confirm-inputs TASK_ID @payload.json` | `{"revision":3,"by":"人工确认人","note":"确认需求与来源"}`；`revision`、`by`、`note` 必须显式提供，`revision` 是当前 CAS 版本 |
| `set-sheet TASK_ID @payload.json` | `{"sheet":{"title":"制作单标题","pages":[{"page":1,"copy":"准确文案","prompt":"绘图指令","size":"3:4"}]},"expectedRevision":4,"inputRevision":3}`；支持 1—5 页（含两张海报），形式与张数由需求和制作单确定；`inputRevision` 必须等于准备制作单时任务中的 `inputConfirmation.revision` |
| `confirm-sheet TASK_ID @payload.json` | `{"version":1,"by":"人工确认人","note":"确认制作单版本","expectedRevision":5}` |
| `execute TASK_ID @payload.json` | `{"version":1,"expectedRevision":6}`；可选传入 `"model":"模型名"` |
| `resume TASK_ID @payload.json` | `{"version":1,"expectedRevision":7}`；只有已核实页面失败后才可显式加 `"retryPage":2` |
| `select-image TASK_ID @payload.json` | `{"version":1,"page":1,"nodeId":"Canvas 图片节点 ID","expectedRevision":8}` |
| `canvas-open TASK_ID` | 不需要 payload；准备该任务的 Canvas 并在系统浏览器打开，输出只含公开 `webUrl`、项目 ID 和连接状态 |
| `canvas-state TASK_ID @payload.json` | `{"expectedRevision":8}`；返回当前任务 Canvas 的图片／文字节点、位置、尺寸、选中项及枚举化状态（`idle/loading/success/error`；缺失或非法状态为 `null`），不返回原始错误详情或配置 |
| `canvas-read-image TASK_ID @payload.json` | `{"nodeId":"当前任务图片节点 ID","expectedRevision":8}`；返回本机临时文件 `filePath`、类型、尺寸和 SHA-256，不返回 base64 |
| `canvas-detect-regions TASK_ID @payload.json` | `{"nodeId":"当前任务图片节点 ID","kinds":["text","barcode","rectangle"],"expectedRevision":8}`；`kinds` 可省略，结果含来源 SHA-256、区域框和截断信息 |
| `canvas-operation TASK_ID @payload.json` | `{"operation":"move","nodeId":"当前任务文字节点 ID","x":150,"y":80,"expectedRevision":8,"operationId":"每次新生成的 UUID","requestId":"每次新生成的 UUID","callId":"每次新生成的 UUID","userText":"用户提出的原话"}`；另支持受控 `import`、`stitch`、`compose`、`crop`、`split`、`resample`、`resize`，字段沿用 Web 共享 Canvas 实现；区域检测后的像素操作可传 `expectedSourceHashes:[{"nodeId":"来源节点 ID","sha256":"检测返回的 SHA-256"}]` |
| `record-review TASK_ID @payload.json` | `{"page":1,"sha256":"当前图片的 SHA-256","decision":"pass","reviewer":"实际读图者","notes":{"文字准确":"...","手机可读":"...","品牌一致":"...","主题对应":"...","修改位置":"无"},"expectedRevision":9}` |
| `approve-final TASK_ID @payload.json` | `{"version":1,"by":"用户","note":"确认最终成品","images":[{"page":1,"sha256":"用户当时实际查看的图片 SHA-256"}],"expectedRevision":10}`；多页任务须为用户当时实际查看的每一页提交对应哈希，批准对象会持久保存该页面清单 |
| `export TASK_ID @payload.json` | `{"expectedRevision":11}` |
| `unlock TASK_ID @payload.json` | `{"deadPid":12345}`；锁维护例外，不修改任务 JSON；只用于人工核实已退出的锁进程 |

`list` 读取默认数据目录中的任务并显示基本状态；`show TASK_ID` 查看完整任务快照，包括当前 `revision`、需求与来源、输入确认、制作单版本、页面文件哈希、执行、审核、最终批准和导出记录。每次修改任务 JSON 前重新 `show`，按该快照构造 payload。若版本过期，命令必须拒绝：重新读取并核对发生了什么，再据最新需求／来源重新准备或重新确认；不能只替换 `expectedRevision` 或 `revision` 后重发原 payload。所有 task revision 都必须是正整数。

`canvas-open` 通过 Web 共享 Canvas manager 准备任务专属实例并同步已保存的图片配置；一次性浏览器连接地址只传给系统浏览器，不写入 CLI 输出。首次打开后等待页面连上，再读取 `show` 的最新 revision 并调用 Canvas 命令。`execute`、`resume`、`edit-pages` 和 `select-image` 都使用同一任务 Canvas 的固定实例／客户端及其图片回收配置；过期 revision、未授权版本或未确认失败的 `retryPage` 会在 Canvas 启动前拒绝。

Canvas 状态、读图和区域检测即使不修改任务 JSON，也必须传从最新 `show` 读取的 `expectedRevision`。`canvas-read-image` 输出的 `filePath` 是宿主可读取的本机临时图片路径，可用宿主实际读图工具打开；不要复制或打印图片数据。`canvas-operation` 会改变当前任务 Canvas 并写入操作账本，三个身份字段每次都须使用新 UUID，`userText` 须保留用户本次原话。遇到执行结果未知时先运行 `canvas-state` 核对，不能用新 ID 重提；源图在检测后变化时共享核心会拒绝旧 `expectedSourceHashes`。

CLI 记录 payload 中声明的确认人和确认内容，但它不是身份认证系统。宿主必须根据用户直接表达的同意核对人工确认；`by: "用户"` 字段本身不能证明用户授权。

## 完成一项创作

1. 用 `create` 建立任务，再用 `set-brief` 和 `set-sources` 保存需求与来源候选。每项来源都由用户决定保留或排除；没有参考时可确认空来源清单。
2. 每次准备写入或确认前用 `show` 读取完整任务快照。`set-brief`、`set-sources` 等变更已存在任务的命令提交当前正整数 `expectedRevision`；需求和来源定稿后，只有用户明确确认才运行 `confirm-inputs`，其 `revision` 必须等于该快照的 revision。本对话用户直接确认时，`by` 可记为 `用户`；不得代另一位确认人签名，也不得用模型判断替代确认。`note` 必须显式填写并写明直接确认依据。
3. 据已确认需求、来源与完整快照准备制作单，`set-sheet` 同时提交快照的 `expectedRevision` 和已确认输入的 `inputRevision`（即 `task.inputConfirmation.revision`）。再用 `show` 读取新建的 `sheetVersion` 和当前 revision；用户明确确认该版本后才运行带 `expectedRevision` 的 `confirm-sheet`。若快照过期，核对更新后的完整任务；需要时重新准备制作单并让用户重新确认，不能只更新 revision 重发旧内容。
4. 用户授权执行后先 `show`，再以该 revision 和确认的 `version` 运行 `execute`。参考图经 Canvas 图片导入入口保存到浏览器本地图片库，回读校验原始 SHA-256 后才连入生成节点；任务记录和 Canvas 元数据不留参考图 data URL，后续明确失败页重试仍可恢复引用。中断后重新 `show`，使用最新 revision 和同一版本运行 `resume`；恢复会检查原 Canvas 节点并继续等待已有结果，不会自动重发状态未知的收费生成。只有已确认失败的页面才可用 `retryPage` 重新生成。未知状态先核对 Canvas，不要重试。SIGINT／SIGTERM 会停止等待；已提交给 Canvas 的生成不保证撤销。
5. 对每张当前成品实际打开图片并读图，检查文字、手机可读性、品牌一致性、主题对应和需修改的位置。只有基于真实图片完成检查后才记录 `record-review`，并提交刚读取的 `expectedRevision`。用户在 Canvas 修改或重新选图后，先 `show`，再以最新 revision 运行 `select-image` 更新当前文件，然后实际打开并重新审核；修改和选图都会使该页旧审核及最终确认失效。
6. 所有页面均有针对当前文件哈希的 `pass` 审核后，用户实际查看每页当前成品并明确确认；`approve-final` 必须提交最新 `expectedRevision`、版本、人工确认信息及 `images` 中每页的 SHA-256。该页面／哈希清单作为持久批准对象，换图、改图或任务状态变化后的旧批准 payload 必须拒绝。随后用最新 revision 运行 `export` 生成素材包。新导出编号同时避开已有目录、ZIP 文件及任务导出记录；原 P1 两份 ZIP 继续作为不可改写的历史案例，不重新导出。

`unlock` 只用于锁所有者已经退出的任务。先运行 `lock-status TASK_ID` 查看锁所有者和 PID，并通过系统进程查看方式人工核实该 PID 已结束；再在 payload 中填写同一个 `deadPid`。CLI 会再次核对锁记录和 PID。该操作不修改任务 JSON，因此不携带 `expectedRevision`；进程仍在、PID 不匹配或锁信息不完整时不要清理锁。

## 边界

产品创作路径必须通过本 CLI 和任务确认合同。`scripts/canvas.mjs` 保留给 P0 Canvas 技术诊断；不要用低层工具调用绕过需求／来源确认、制作单确认、实际读图审核、最终人工批准或素材包导出。凭据、实例 token 和浏览器个人数据不得写入任务、日志或导出。工具异常只按 CLI 的固定提示处理，不要打印错误对象、配置文件或锁 token。

## P2 素材与 DNA 入口

素材导入、显式 AI 清洗、人工微调并确认入库及标签检索见 [素材库使用](素材库使用.md)。全局 DNA 默认关闭，显式保存和任务版本绑定见 [DNA使用](DNA使用.md)。这些操作不启动 DSH。Codex 推理继续由宿主 Codex 会话承担；CLI 素材清洗读取 Studio 私有配置中的基础 API，不读取 `STUDIO_TEXT_*`，也不改变宿主的推理模型。模型来源范围见 [模型来源与裁剪](模型来源与裁剪.md)。

任务创建时保存有效 DNA 快照。`apply-dna TASK_ID @payload.json` 需要 `dnaRevision` 和 `expectedRevision`，显式应用全局版本后原输入与制作单确认失效。宿主展示任务实际采用的内容后重新取得确认。

引用库素材使用 `set-asset-sources TASK_ID @payload.json`，payload 为 `{"expectedRevision":当前任务revision,"selections":[{"assetId":"素材UUID","assetRevision":已查看素材revision,"decision":"retained或excluded或pending","purpose":"借鉴用途","factBoundary":"事实适用边界"}]}`。该命令替换当前来源清单；先展示来源并取得真实人工决定，不把入库确认当作创作保留决定。命令冻结正文、提取结果、摘要、标签、版本和原件到任务，仍须 `confirm-inputs`。导出核验并包含任务自己的来源原件，不再查询库的最新版本。

## P3 混合参考与当前资料

`set-references TASK_ID @payload.json` 一次 CAS 保存混合参考清单：payload 包含 `expectedRevision` 与 `items`。新增素材库引用为 `{kind:"asset",assetId,assetRevision,decision,purpose,factBoundary}`；新增外部正文／链接为 `{kind:"external",title,body或url,decision,purpose,factBoundary}`；已有任何来源统一为 `{kind:"existing",id,decision,purpose,factBoundary}`，由核心保存完整内部文件快照，不从公开 Web 数据重建隐藏路径。

`attach-files TASK_ID @payload.json` 接收 `expectedRevision` 和 `files:[{name,path,mimeType}]`，把明确由用户上传的当前资料复制到任务来源目录，保留顺序与哈希；可提供 `title`、`purpose`、`factBoundary` 与 `extractions`。它不把附件自动入总库、不代决定保留，也不自动进行模型提取。Codex 宿主须实际读取原件后再填写提取记录；独立 Web 上传路径复用已有提取器并显示成功／失败／待核。添加或更新参考、上传当前资料会撤销下游确认，需重新人工确认。

Web 的在途操作会持有任务入口记录，跨进程阻止 Codex 同时写入；Codex 的长时执行仍使用核心执行锁，Web 不能并发推进。异常退出后优先重新启动工作台恢复中断 Job，已有生图只查状态。需要在 Codex 解除已退出的 Web 入口时先运行 `entry-status TASK_ID` 核对 PID 与 `alive:false`，再用 `release-entry TASK_ID @payload.json`（仅 `{"deadPid":核对过的PID}`）解除入口记录；存活或不匹配的 PID 会被拒绝。它不修改任务 JSON，也不替代 P1 的执行锁 `unlock`。
