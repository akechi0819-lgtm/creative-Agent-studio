---
name: creative-studio
description: 在本仓库使用共享 CLI 完成经用户确认的单张海报或多页图文任务；当前阶段与版本边界以工程进度为准；设备体验和上游模型能力按证据范围记录。
---

当前为公司版，先读 `docs/公司版接入.md`。公司素材检索使用 `node scripts/company.mjs search @payload.json`，含 taskId、expectedRevision、query 及明确标签／必需条件；候选进入待选区，不代表人工保留。用户保留时通过共享 `studio set-references` 下载本次原件并冻结来源。公司库未配置、无权限、无结果时如实说明，不拿本机结果替代。只有用户明确选择本机素材才用 assets CLI。连接配置使用 company CLI 的 config-show/config-save，凭据输入保存在仓库外，不读取或覆盖旧全局凭据。Canvas 采用新版协议，用户负责更新远端；不适配旧 npm bridge。基础／生图 API 均在本机公司工作台配置；远端 Canvas 通过任务内存配置与本机受限图片代理访问模型，不让员工去远端重复填写，也不把钥匙发送或持久化到远端。词库辅助检查使用 `company check-copy`，命中逐项交由用户判断，不自动批准。


先读 `docs/Codex使用.md`，阶段状态与版本差异见 `docs/工程进度.md`。P0—P5主体按各报告范围验收，后续Mac隔离启动修复及普通设备待测单独记录；不把历史测试扩张成所有模型或账号能力。首次准备使用 `node scripts/prepare.mjs`，不启动DSH。Codex使用公司远端新版Canvas与本机已保存图片API，不调用宿主内置生图、不调用 `codex exec`，也不召唤第二个Agent。

Codex 入口的所有任务操作使用 `node scripts/studio.mjs`。输入通过 `@payload.json` 文件提供，不要把 JSON 内嵌到 shell 命令。先用 `list` 或 `show TASK_ID` 恢复任务；确认成功后再执行状态变更。基本链路为：

1. `create` 创建任务，以 `set-brief` 和 `set-sources` 保存需求及来源决定。
2. 用户明确确认需求和来源后，读取最新 revision，运行 `confirm-inputs`；再生成制作单、读取当前版本，由用户明确确认后运行 `confirm-sheet`。
3. 用户授权生成后先运行 `canvas-open TASK_ID` 准备并打开任务专属 Canvas，再运行 `execute`。`execute`、`resume`、`edit-pages` 和 `select-image` 使用该任务的远端 Canvas 目标与本机公司工作台已保存的图片配置；CLI 会在启动 Canvas 前核对 revision 和制作单授权。中断后用同一版本调用 `resume`，只查询并续接原节点；不得自动重发状态未知的收费请求。只有确认页面失败时才显式传 `retryPage`。
4. 用实际读图工具打开当前成品，逐页检查准确文案、手机可读性、品牌一致性、主题对应和修改位置，然后运行 `record-review`。用户修改或 `select-image` 更新当前文件后，必须重新打开并审核；修改和选图会使旧审核与最终确认失效。
5. 等用户明确确认最终成品后才运行 `approve-final`，再运行 `export`。

## 状态变更版本与人工确认合同

### 已有图片的局部修改

用户明确要求修改已有图片时，使用 `edit-pages TASK_ID @payload.json`，不重写全量制作单、不重置素材决定、不要求再次完整确认。payload 为 `{expectedRevision,requestId,instruction:用户本次明确修改原话,edits:[{page,instruction,copy?,stylePages?:[page]}]}`。原图和指定风格页由共享核心实际读图校验并传入 Canvas；未改页的成品与审核保留。仅讨论方案或询问能力时不得调用。

上传已有图片改图时可传 `mode:'uploaded-images'`，条目为 `{page,image:{sourceId,fileOrder},instruction,styleImages?:[{sourceId,fileOrder}],copy?}`，只使用用户实际上传且未排除的本任务图片；不伪造生成历史、不自动确认来源或入库。`restore-page TASK_ID @payload.json` 接收 `{expectedRevision,page}`，恢复本页旧图与文案，不发起生图。

这些操作保留后台派生版本和用户指令，`sheetConfirmation` 不伪造成全量人工确认；后续仍需实际查看修改后的图片、审核并由用户最终批准。完整新创作继续遵守以下确认合同。具体边界见 `docs/P3对话局部改图.md`。

除新建任务的 `create` 外，所有修改已有任务 JSON 的公开状态命令都必须在 payload 中携带从最新 `show TASK_ID` 读取的正整数 `expectedRevision`。`confirm-inputs` 使用必填正整数 `revision` 作为同一 CAS 版本比较值；不允许省略，也不允许 CLI 自动读取最新值补全。每次修改任务 JSON 前读取完整任务快照，用该快照构造 payload。若版本过期，停止并重新 `show`，先核对 brief、sources、确认、制作单和成品状态发生的变化，再重新准备内容并在必要时取得用户确认；不能只替换 revision 后重发旧 payload。`unlock` 仅维护独立锁记录，不修改任务 JSON，是该版本 CAS 合同的例外；它只带 `deadPid`，并核对锁所有者及 PID 已退出。

`set-sheet` 除 `expectedRevision` 外还必须提供 `inputRevision`，其值等于准备制作单时快照中的 `task.inputConfirmation.revision`。需求或来源状态变化后，旧制作单 payload 必须拒绝；重新读取快照、重新准备制作单，并在需要时重新确认输入。

`approve-final` 除 `expectedRevision`、确认版本和人工确认信息外，还必须提交 `images` 数组，例如 `[ {"page":1,"sha256":"<第1页 SHA-256>"}, {"page":2,"sha256":"<第2页 SHA-256>"} ]`。哈希必须逐页对应用户当时实际查看的全部成品；批准清单作为持久批准对象记录。页面变化、选图、改图或其他 revision 变化后，旧批准 payload 必须拒绝。

需求与来源确认、制作单确认、最终确认都必须在用户直接表达同意后执行。确认 payload 的 `by`、`revision` 或 `version`、`note` 都要显式填写；本对话用户直接确认时 `by` 可写 `用户`。CLI 是本地可信入口，不是用户身份认证系统；宿主必须核对用户直接表达的确认，不得仅凭 payload 中的 `by` 字段认定授权。不得代其他人签名，也不得把助手的建议、制作单草稿、Canvas 已生成或审核通过当成人工批准。已完成的 P1 样例授权只覆盖对应任务，不沿用于任何新任务。图片读图审核只能在实际打开当前图片后记录，不能只根据节点存在或生成状态填 `pass`。

执行会通过 Canvas 本地图片导入入口保存参考图，并回读校验 SHA-256 后再生成；不要把参考图 data URL 写入任务或日志。收到 SIGINT／SIGTERM 时停止等待；不要声称上游生成已撤销。恢复时先检查原任务和 Canvas 状态。只有 Canvas 明确报告页面失败才允许 `retryPage`，其他未知状态不重放。

任务锁异常时先运行 `lock-status TASK_ID`，人工核实显示的锁所有者 PID 已退出后，才可用仅含同一 `deadPid` 的 payload 调用 `unlock`；CLI 会再次验证锁记录与 PID。进程仍运行或状态不明时不清锁。

`scripts/canvas.mjs` 只用于 P0 技术诊断。创作任务不得通过它绕过需求／来源、制作单、读图和最终成品确认。不要输出凭据、实例 token、锁 token 或浏览器个人数据；出现错误只传达 CLI 的固定提示，不展示异常对象、cause 或配置。

## Codex 任务 Canvas 机械命令

使用 `canvas-state TASK_ID @payload.json` 读取节点清单，payload 为 `{"expectedRevision":当前任务revision}`。节点状态仅返回 `idle/loading/success/error` 枚举，缺失或非法值为 `null`；不会返回原始错误详情、配置或节点元数据。`canvas-read-image` 使用 `{"nodeId":"当前任务图片节点ID","expectedRevision":当前任务revision}`，返回带 SHA-256 的本机临时 `filePath`；用宿主读图工具打开真实图片，不打印 base64。`canvas-detect-regions` 接收同样字段，可选 `kinds:["text","barcode","rectangle"]`，结果中的来源 SHA 要随操作一起核对。

`canvas-operation TASK_ID @payload.json` 只接受共享 Canvas manager 的 `import`、`stitch`、`compose`、`crop`、`split`、`resample`、`move`、`resize` 枚举字段。除操作参数外必须带当前 `expectedRevision`、三个新的 UUID（`operationId`、`requestId`、`callId`）和用户本次原话 `userText`；用区域检测结果进行像素操作时附带 `expectedSourceHashes`。源图变化、跨任务节点、旧 revision 或未知结果会被拒绝。未知结果先重新读取状态，不要自动重提或另建 ID 重放。

这些命令调用 `src/web/canvas.mjs` 的任务隔离实现；不经 `scripts/canvas.mjs` 透传低层工具。机械操作不会调用生图，也不自动替换成品、复审或批准。读状态／读图／检测虽不改任务 JSON，仍要使用最新 revision。`canvas-open` 输出不包含一次性浏览器连接地址或实例 token。

## P2 素材与 DNA

素材使用 `scripts/assets.mjs`，操作格式见 `docs/素材库使用.md`。只把人工确认入库的素材作为正式候选；AI 清洗产生自由标签，待用户微调确认，不复制旧业务标签或凭据。不把素材库入库确认当作某项创作的保留决定。任务来源引用通过 `studio set-asset-sources` 保存版本与原件，仍需逐项保留／排除和需求确认。

DNA 见 `docs/DNA使用.md`，默认关闭，不自动编辑／保存。任务 `show` 中的 `dna` 是本次有效内容；据它整理需求、制作单和读图审核。全局新版不会影响旧任务。用户明确要求后才用 `apply-dna`，再确认输入并准备新制作单。与本次需求矛盾时先说明冲突，由用户决定。DNA 不参与素材事实清洗。

## 独立 Web 入口

DSH与Codex共用来源、版本、真实用户确认和实际读图合同。Web左侧讨论需求、参考用途和制作／交付确认，右侧主要预览；明确文字确认或按钮由宿主绑定实际展示版本处理，模型不能替用户批准。

DSH同时保留任务workspace中的Word／PDF／Excel／图片读取、Python／JavaScript、批处理及文件交付工具；普通资料任务不强制套海报制作单。它们按当前系统用户权限执行受信任务，不宣称OS沙箱，不新增同意图重复确认。机械图片任务优先用已有Canvas像素工具。Web与Codex的聊天历史不承诺互通，同一任务同时只由一个入口推进。
