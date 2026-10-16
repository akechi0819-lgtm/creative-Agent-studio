# P3 Canvas 工具接入清单

更新：2026-10-15。用户要求把现有 Canvas 能力开放给对话 Agent，由模型选择机械工具，不把通用能力做成二维码专用流程。此处区分手动 UI、Canvas 桥接、Web DSH 和 Codex CLI 四层；按钮存在不等于对话已接入，也不等于该功能真正实现。

## 当前实现与建议

| 功能 | Canvas 实际能力／已有桥接 | Web／Codex 接入与取舍 |
| --- | --- | --- |
| 读取任务、参考、成品预览 | 实际图片读取、任务状态已具备 | 已接入任务／来源／成品读图；Canvas 节点索引本轮补接 |
| Codex CLI 任务 Canvas | Web 有任务隔离实例、保存图片配置和受控 Canvas manager | 新增 `canvas-open`、状态／读图／区域检测／机械操作命令；执行、恢复、局部改图和选图注入任务级执行选项 |
| 图片生成、已有图修改 | 有实际生成与图生图执行 | 已经通过制作单和局部修改工具接入，不另开绕过任务授权的通用生图入口 |
| 裁切 | UI 使用浏览器 Canvas 处理真实像素，保留原图 | 本轮补桥接及对话路径，结果作为图片附件回收 |
| 分割图片 | UI 可按行列或自定义切线生成多张图 | 本轮补行列分割，最多25张；自定义切线保留手动，尚未开放参数 |
| 像素缩放／普通放大 | 真实重采样，nearest／bilinear／high，长边最多4096 | 本轮补对话 `resample`；插值放大不宣称生成新细节 |
| 节点移动 | 已有 `canvas_move_nodes`，改变 position | 本轮补对话 `move`；不改变图片内部像素 |
| 节点显示尺寸 | 已有 `canvas_resize_node`，改变 width／height | 本轮补对话 `resize`；明确与图片重采样不同 |
| 节点复制／复制粘贴 | UI 复制节点、引用与位置；没有专用复制桥接命令，可用低层操作间接做 | 值得后续开放受限的复制工具；当前未开放低层任意 metadata 写入，也不冒充像素贴图 |
| 创建／编辑独立文字节点、字号 | UI 和部分文本桥接已实现 | 值得后续接入；只会改变独立文字节点，不能机械修改已经烘焙在图片里的文字 |
| 上传／替换图片节点 | Canvas UI 有；Web 已有聊天附件上传 | 本轮补 `import` 将本任务附件原图放入 Canvas；替换元素用合成新图保留原图，不直接覆盖旧节点 |
| 节点选择、视口、定位 | 桥接有选择／视口接口，UI 有聚焦 | 后续可补定位辅助；鼠标、缩放、选区日常操作适合手动，不必逐按钮暴露 |
| 连线／断开引用 | 低层桥接可连线；UI 可断开 | 不直接向模型暴露任意连线，避免把辅助图误接成制作单参考；需要时做有任务语义的接口 |
| 组合／解组 | UI 组合节点、显示边界 | 当前保留手动；组合不是合并输出图片，接入优先级低于像素操作 |
| 单图下载、机械图片下载 | Canvas 可下载原始图片文件 | 机械结果本轮回收到聊天附件，提供预览与下载 |
| 制作任务审核、批准、ZIP | Studio 已有逐页复审、整套批准、哈希绑定导出 | 继续走既有交付链路；机械辅助制品不自动变成已批准成品 |
| 画布项目导出 | `exportCurrentProject` 调用项目包导出 | 保留手动；项目备份不是合并海报图片，也不代替已批准的素材包 |
| 遮罩局部修改 | UI 会创建 mask／底图并调用 `requestEdit` | 需要模型；当前局部改图有普通底图／风格图路径，尚未开放明确 mask 参数；值得后续补接，不能计为无生图操作 |
| 视角变换 | UI 的 `generateAngleNode` 实际调用 `requestEdit` | 需要模型；不作为本轮机械工具开放，不能称为普通像素旋转 |
| 超分辨率 | UI 弹窗内容为 `notImplemented` | 功能本身未实现，不能靠开放调用路径获得 |
| 提示词复制／反推 | UI 能复制提示词；反推会创建文本推理流程 | 复制可用对话文本完成；读图已有宿主视觉入口，暂不增加重复推理链路 |
| 保存到 Canvas 素材 | UI 能存入自己的素材区 | 不等于 Studio 人工确认总库；暂不自动同步，以免绕过总库清洗和确认 |
| 撤销／重做 | UI 有完整编辑历史；bridge context 有单次 undo 能力但无公共工具命令 | 当前保留手动；后续工具撤销需绑定具体操作，不能无条件撤销用户最近手动操作 |
| 删除节点／清空／删除项目 | UI／部分桥接有 | 不向日常创作 Agent 直接开放整项目破坏性操作；用户明确要求时再设计受限路径 |
| 多图像素拼接、粘贴、叠加、区域覆盖 | 本轮新增真实像素拼接与多层合成，支持保持比例、透明叠图及先清除旧区域再贴图 | 对话接入 `stitch`／`compose`；使用通用合成替换二维码等图片元素，不做场景专用工具 |
| 批量模板变量替换 | 可多次组合已有导入／合成工具，保留每次输出；没有独立的模板批次管理器 | 不将多层合成冒充完整的模板变量／批次产品；本轮验证通用工具调用 |
| 视频／音频生成、视频截帧 | Canvas 有媒体节点、生成与截帧相关 UI／部分桥接 | 当前产品主线是海报／图文，不直接扩大对话任务和审核导出语义；需要媒体任务范围后再接 |
| 主题、背景、工具栏设置、全屏、侧栏 | Canvas UI 现有体验 | 保留用户手动设置；不需要模型代操作 |

## 调用和结果边界

Web 对话通过 `studio_canvas_state` 读取真实节点，使用 `studio_canvas_operation` 的枚举操作调用宿主。模型不传任务标识、版本、请求身份、任意文件路径或 metadata。宿主固定 project／instance／client，并检查目标节点、版本和源图；纯 Canvas 不启动 Agent。

像素结果保留原图，作为当前任务机械辅助制品保存，并以聊天附件提供预览和下载。布局操作不伪造成新图片。通过 `import` 放入本任务附件，`studio_canvas_read_image` 向模型提供真实图像块和原始尺寸用于定位／复核。此路径不会调用图片模型、不会自动覆盖制作单成品，也不自动改变审核或最终批准。未知执行状态不自动重复提交。

实现接点：`adapters/dsh/runtime.mjs`、`src/web/canvas.mjs`、`src/creative/canvas-operations.mjs`、`src/web/server.mjs`、Canvas `canvas-agent/src/canvas/schemas.ts`／`session.ts`、Web `canvas-tool-panel.tsx`／`use-agent-bridge.ts`／`canvas-image-data.ts`。遮罩／视角／超分占位／复制／项目导出的事实来自 `third_party/canvas/web/src/pages/canvas/project.tsx`。

## Codex CLI 受控接入

`node scripts/studio.mjs canvas-open TASK_ID` 调用共享 `createCanvasManager.ensure`，为任务创建或复用独立 supervisor、同步本机已保存的图片配置，并通过系统浏览器打开 Canvas。一次性 bootstrap 地址只传给浏览器，CLI 只输出公开 `webUrl`、项目 ID 和连接状态。CLI supervisor 以 detached 方式运行，单次命令结束不会调用 manager 的 `stop`，也不会停止已有任务 Canvas。

`canvas-state`、`canvas-read-image`、`canvas-detect-regions` 和 `canvas-operation` 均复用 `src/web/canvas.mjs` 的 `agentState`、`agentImage`、`agentRegions`、`mechanicalOperation`。状态摘要中的节点状态仅允许 `idle/loading/success/error` 枚举；缺失或非法值为 `null`，不返回原始错误详情、配置或节点元数据。每条命令使用用户从最新 `show` 读取的 `expectedRevision`；机械操作另外要求唯一 `operationId`、`requestId`、`callId` 和用户原话。读图结果写入本机权限受限的临时文件，只返回 `filePath`、MIME、尺寸及 SHA-256，不返回 base64、Canvas token 或配置。区域检测的返回内容继承 Web 核心边界，不含识别出的文字或条码载荷。

`execute`、`resume`、`edit-pages`、`select-image` 通过同一 manager 的 `executionOptions` 绑定任务实例和固定客户端，并使用本机保存的图片配置；revision、授权版本和显式失败页检查会在获取可能启动 Canvas 的执行选项之前完成。状态未知时 CLI 不自动重放；先读取 Canvas 状态并依据原操作账本核对。

执行引用图使用 Canvas 的 `canvas_import_image` 浏览器本地图片导入路径，按原始 SHA-256 回读核验后再连接生成节点；任务记录和 Canvas 节点元数据不保存 base64 data URL，已失败页显式重试时复用原持久图片节点。

本轮仍在 P3 已授权范围，P4 未启动。以下验证为实施自验，不代表 P3 独立验收。首轮五项操作的历史证据与后续像素拼接／合成的证据分开记录。


## 桥接注册表逐项对照

当前 `toolNames` 共 40 项；以下按实际命令名完整列出。新增的三项为附件导入、拼接和合成；只给模型开放任务受控工具，不透传任意命令。

| 接入情况／取舍 | 注册命令 |
| --- | --- |
| 对话可读取节点、选中项和真实图片预览 | `canvas_get_state`、`canvas_get_selection`、`canvas_read_image` |
| 本轮接入：像素操作 | `canvas_crop_image`、`canvas_split_image`、`canvas_resample_image`、`canvas_stitch_images`、`canvas_compose_images` |
| 本轮接入：节点布局 | `canvas_move_nodes`、`canvas_resize_node` |
| 新增：任务附件受控导入Canvas，不让模型传文件字节或URL | `canvas_import_image` |
| 既有共享执行／回收使用；模型不直传 | `canvas_apply_ops`、`canvas_run_generation`、`generation_get_status` |
| 有重复能力，由既有生成／配置链路承担，不单独暴露 | `canvas_export_snapshot`、`canvas_create_config_node`、`canvas_create_image_prompt_flow`、`canvas_create_generation_flow`、`canvas_generate_image`、`workbench_image_get_config`、`workbench_image_generate` |
| 项目／页面导航：宿主负责，不交给模型切换 | `site_navigate`、`canvas_list_projects` |
| 值得后续补受限文字／复制／图片放置；不开放任意字段写入 | `canvas_create_node`、`canvas_create_text_node`、`canvas_create_text_nodes`、`canvas_update_node`、`canvas_update_node_text` |
| 选择／视口可后续补；删除与连线需有任务语义，不直透 | `canvas_delete_nodes`、`canvas_connect_nodes`、`canvas_select_nodes`、`canvas_set_viewport` |
| 文本推理由宿主承担；媒体生成不在当前海报图文任务范围 | `canvas_generate_text`、`canvas_generate_video`、`canvas_generate_audio`、`workbench_video_get_config`、`workbench_video_generate` |
| Canvas素材与提示词非Studio总库，避免并行真相源 | `prompts_search`、`assets_list`、`assets_add` |


## 首轮五项操作实施验证

- 全仓 **178/178** 测试通过：[日志](evidence/p3-canvas-operations/contract-tests.log)。覆盖工具选择、宿主版本／请求身份、同轮多次操作附件持久化、幂等与未知结果、跨任务拒绝、分割数量和布局尺寸异常回读。
- Canvas bridge **15/15** 测试通过：[日志](evidence/p3-canvas-operations/canvas-bridge-tests.log)。Canvas TypeScript 类型检查与构建、Studio Web 构建通过。
- 真实 Web／Canvas 与本地替身图片服务 **26 项浏览器检查通过**：[完整回执](evidence/p3-page-edits/verification.json)、[机械操作摘录](evidence/p3-canvas-operations/browser-verification.json)。在同一轮对话执行裁切、2×2分割、512→256最近邻缩放、移动、显示缩放；六张 PNG 刷新后可见并可下载，裁切／分割／缩放逐像素匹配，未增加图片模型请求，原成品哈希、制作单、审核与批准状态不变。
- 真实基础模型在隔离任务中自主读取 Canvas 节点并调用裁切，选择正确节点和左上四分之一区域：[回执](evidence/p3-canvas-operations/real-model-tool-selection.json)。该项的图片执行回调为替身，未调用图片模型，也未操作用户真实任务；真实像素处理由上一项浏览器验证覆盖。
- 测试中曾遇到助手消息选择器与读取像素 context 不一致；校正测试后完整重跑通过。缩放参考统一为浏览器默认 Canvas 2D 绘制／读取设置，最近邻逐通道误差为0；没有为通过测试放宽像素断言或修改产品缩放算法。
- 重复任务浮窗已移除，主对话进度和停止按钮保留；逐页“通过／需要修改”点击直接持久化，单次 POST、无额外弹窗，“提交本页复审”和“对话修改第N页”已删除，整套最终人工批准保留。

本机服务已重启加载新工具。刷新 Web UI，并从工作台重新打开当前任务 Canvas 后，可继续在原聊天提出机械处理要求。辅助图片结果回到对话附件，不自动替换或批准原成品。


## 通用拼接、贴图与区域定位补充

新增三项 Canvas 桥接命令，当前共40项；主对话通过同一个受控操作工具选择 `import`、`stitch`、`compose`。像素计算由 Canvas 2D 完成，不调用生图服务；原图、制作单、批准与审核均保留。输出保存为当前任务辅助制品并在聊天中预览、下载，刷新后仍可读取。附件不能来自其他任务，源图变化会拒绝执行；多层合成最多20层，来源账本允许底图加20个独立贴图，共21个来源。

仅让模型看预览并估算坐标不够可靠：首次真实自然语言替换测试选对合成工具，但估算区域偏移，未通过覆盖检查。因此补充通用 `studio_canvas_detect_regions`：在本机检测文字、条码和矩形的像素边界，返回置信度及向外扩2像素的建议框，不回传文字内容或条码载荷。检测结果绑定源图哈希，随后合成前重新检查。区域模糊或存在多个目标时需要简短追问，不能承诺任意图片都可自动准确定位。

P3 历史实现依赖 macOS Vision 和本机 Swift；P4 已将此路径替换为跨平台本地方案，当前范围为 PNG／JPEG 的二维码、文字行与矩形定位，详见 [P4区域检测](P4区域检测.md)。其他格式明确报错，不静默改为生图；原 P3 记录不作为 P4 跨平台验收证据。一次检测最多返回100个区域，并明确总数及截断状态。

确定性浏览器验证35项通过，见 [回执](evidence/p3-image-composition/verify-web-page-edits-2026-10-15T13-43-01-365Z-f9144fbb/verification.json)：横拼、竖拼和多层合成逐像素误差为0，透明清除及图层顺序正确，替换框外像素不变，最终二维码仅识别到新测试码。没有增加生图请求，原成品和批准状态保持，下载／刷新持久化与跨任务隔离通过。

后续真实模型验证独立记录。旧重采样的浏览器与CPU逐像素参考存在运行间差异；真实模型专项保留测量但明确跳过该旧门槛，不通过放宽误差来算通过。拼接／合成像素和新旧码识别仍为硬断言。

补充合同测试全仓 **192/192** 通过，见 [日志](evidence/p3-image-composition/contract-tests.log)；含PNG／JPEG原生区域检测、检测输出限额、工具发现、真实图像块、区域框合成、检测后源图变化拒绝、来源哈希完整性及聊天附件持久化。Canvas bridge **15/15** 通过，见 [日志](evidence/p3-image-composition/canvas-bridge-tests.log)；Studio Web 构建通过。

真实模型区域检测专项的第一轮已自主调用检测、裁切和合成，但验证脚本强制要求最后贴图必须直接引用原附件节点，且错误地从导入摘要读取不存在的SHA，未能走到最终像素核对。该 [失败回执](evidence/p3-image-composition/verify-web-page-edits-2026-10-15T14-05-37-002Z-dfc16a31/verification.json)保留。后续验证改为核对裁切来源链、读取实际贴图字节，仍要求旧码完整清除、新码识别唯一、框外像素不变；不以调用步骤完全一致代替结果正确。

最终自然语言专项输入仅为“把海报右下角旧二维码换成新上传那张，其他内容保持”，无工具名或坐标。真实配置的基础模型自主执行 state → import两图 → read_image → detect_regions → compose → read_image，没有调用生图工具。该运行的确定性部分36项通过；专项后处理异常导致 [原报告](evidence/p3-image-composition/verify-web-page-edits-2026-10-15T14-15-49-268Z-2bb2bdcc/verification.json)仍为failed，不能作为整轮浏览器通过。

利用已保存的输入、真实贴图回读字节和成功合成回执，Chrome Canvas2D离线重放得到的PNG与真实工具回执的SHA、7738字节长度完全相同。对此相同字节图像核验：新码可识别，旧码消失，框外像素差0，4538个旧码暗像素全部位于清除框内，见 [离线精确哈希补证](evidence/p3-image-composition/verify-web-page-edits-2026-10-15T14-15-49-268Z-2bb2bdcc/offline-recovery.json)及 [产物](evidence/p3-image-composition/verify-web-page-edits-2026-10-15T14-15-49-268Z-2bb2bdcc/real-model-poster-new-qr-offline-recovered.png)。这证明该次真实工具调用的输出正确；失败运行后的源附件完整性与聊天刷新状态未独立核实，相关行为由此前确定性浏览器测试覆盖。原失败记录保留，不将其改写为整轮通过。

本机服务已重启，HTTP200。刷新Web UI并从任务重新打开Canvas可使用新增工具。以上属于P3实施自验与限定补证，仍待用户复测及独立验收，P4未授权。
