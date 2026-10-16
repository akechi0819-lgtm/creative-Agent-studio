import { z } from "zod";

const recordSchema = z.record(z.unknown());
const positionSchema = z.object({ x: z.number(), y: z.number() });
const viewportSchema = z.object({ x: z.number(), y: z.number(), k: z.number() });
const nodeTypeSchema = z.enum(["image", "text", "config", "video", "audio"]);
const generationModeSchema = z.enum(["text", "image", "video", "audio"]);

/** 绘图桥接对外提供的工具名称。 */
export const toolNames = [
    "site_navigate",
    "canvas_list_projects",
    "canvas_read_image",
    "canvas_crop_image",
    "canvas_split_image",
    "canvas_resample_image",
    "canvas_stitch_images",
    "canvas_compose_images",
    "canvas_import_image",
    "canvas_get_state",
    "canvas_get_selection",
    "canvas_export_snapshot",
    "canvas_apply_ops",
    "canvas_create_node",
    "canvas_create_text_node",
    "canvas_create_text_nodes",
    "canvas_create_config_node",
    "canvas_create_image_prompt_flow",
    "canvas_create_generation_flow",
    "canvas_generate_text",
    "canvas_generate_image",
    "canvas_generate_video",
    "canvas_generate_audio",
    "canvas_update_node",
    "canvas_update_node_text",
    "canvas_move_nodes",
    "canvas_resize_node",
    "canvas_delete_nodes",
    "canvas_connect_nodes",
    "canvas_select_nodes",
    "canvas_set_viewport",
    "canvas_run_generation",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "prompts_search",
    "assets_list",
    "assets_add",
] as const;
export type ToolName = (typeof toolNames)[number];

export const canvasOpSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("add_node"), nodeType: nodeTypeSchema.optional(), id: z.string().optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), position: positionSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
    z.object({ type: z.literal("update_node"), id: z.string(), patch: recordSchema.optional(), metadata: recordSchema.optional() }).passthrough(),
    z.object({ type: z.literal("delete_node"), id: z.string().optional(), ids: z.array(z.string()).optional() }).passthrough(),
    z.object({ type: z.literal("delete_connections"), id: z.string().optional(), ids: z.array(z.string()).optional(), all: z.boolean().optional() }).passthrough(),
    z.object({ type: z.literal("connect_nodes"), id: z.string().optional(), fromNodeId: z.string(), toNodeId: z.string() }).passthrough(),
    z.object({ type: z.literal("set_viewport"), viewport: viewportSchema }).passthrough(),
    z.object({ type: z.literal("select_nodes"), ids: z.array(z.string()) }).passthrough(),
    z.object({ type: z.literal("run_generation"), nodeId: z.string(), mode: generationModeSchema.optional(), prompt: z.string().optional() }).passthrough(),
]);

const textNodeSchema = z.object({
    text: z.string(),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
});

const generationOptionsSchema = z.object({
    model: z.string().optional(),
    size: z.string().optional(),
    quality: z.string().optional(),
    count: z.number().optional(),
    seconds: z.string().optional(),
    vquality: z.string().optional(),
    generateAudio: z.string().optional(),
    watermark: z.string().optional(),
    videoMode: z.string().optional(),
    audioVoice: z.string().optional(),
    audioFormat: z.string().optional(),
    audioSpeed: z.string().optional(),
    audioInstructions: z.string().optional(),
});

const generationFlowSchema = z.object({
    prompt: z.string(),
    title: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    referenceNodeIds: z.array(z.string()).optional(),
});

const normalizedCropSchema = z.object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().gt(0).max(1),
    height: z.number().finite().gt(0).max(1),
}).refine((crop) => crop.x + crop.width <= 1 && crop.y + crop.height <= 1, {
    message: "裁切区域必须完全位于图片范围内",
});

const nodeIdSchema = z.string().trim().min(1);
const pixelColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, "颜色必须是 #RRGGBB 或 #RRGGBBAA");
const pixelCoordinateSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pixelSizeSchema = z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER);
const pixelRectSchema = z.object({
    nodeId: nodeIdSchema,
    x: pixelCoordinateSchema,
    y: pixelCoordinateSchema,
    width: pixelSizeSchema,
    height: pixelSizeSchema,
    fit: z.enum(["contain", "cover", "stretch"]).optional(),
    clear: pixelColorSchema.optional(),
    smoothing: z.enum(["nearest", "smooth"]).optional(),
});

const importDataUrlSchema = z.string().regex(/^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "仅允许非空 PNG、JPEG 或 WebP 的 base64 data URL");

export const toolInputSchemas = {
    site_navigate: z.object({ path: z.string() }),
    canvas_list_projects: z.object({ keyword: z.string().optional(), page: z.number().optional(), pageSize: z.number().optional() }),
    canvas_read_image: z.object({ nodeId: z.string() }),
    canvas_crop_image: z.object({ nodeId: z.string(), crop: normalizedCropSchema }),
    canvas_split_image: z.object({ nodeId: z.string(), rows: z.number().int().positive(), columns: z.number().int().positive() }).refine(({ rows, columns }) => rows * columns <= 25, { message: "分割总格数不能超过 25" }),
    canvas_resample_image: z.object({ nodeId: z.string(), targetLongEdge: z.number().finite().gt(0).max(4096), algorithm: z.enum(["nearest", "bilinear", "high"]) }),
    canvas_stitch_images: z.object({
        nodeIds: z.array(nodeIdSchema).min(2).max(20),
        direction: z.enum(["horizontal", "vertical"]),
        gap: pixelCoordinateSchema.optional(),
        background: pixelColorSchema.optional(),
    }),
    canvas_compose_images: z.object({
        nodeId: nodeIdSchema,
        layers: z.array(pixelRectSchema).min(1).max(20),
    }),
    canvas_import_image: z.object({ nodeId: nodeIdSchema, title: z.string().trim().min(1), dataUrl: importDataUrlSchema }),
    canvas_get_state: z.object({}).passthrough(),
    canvas_get_selection: z.object({}).passthrough(),
    canvas_export_snapshot: z.object({}).passthrough(),
    canvas_apply_ops: z.object({ ops: z.array(canvasOpSchema) }),
    canvas_create_node: z.object({ nodeType: nodeTypeSchema, title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), metadata: recordSchema.optional() }),
    canvas_create_text_node: z.object({ text: z.string().optional(), x: z.number().optional(), y: z.number().optional(), title: z.string().optional(), width: z.number().optional(), height: z.number().optional() }),
    canvas_create_text_nodes: z.object({ items: z.array(textNodeSchema).min(1), x: z.number().optional(), y: z.number().optional(), gap: z.number().optional(), direction: z.enum(["row", "column"]).optional() }),
    canvas_create_config_node: z.object({ prompt: z.string().optional(), mode: generationModeSchema.optional(), title: z.string().optional(), x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), autoRun: z.boolean().optional() }).merge(generationOptionsSchema),
    canvas_create_image_prompt_flow: z.object({ prompt: z.string(), x: z.number().optional(), y: z.number().optional(), autoRun: z.boolean().optional() }).merge(generationOptionsSchema),
    canvas_create_generation_flow: generationFlowSchema.extend({ mode: generationModeSchema.optional(), autoRun: z.boolean().optional() }).merge(generationOptionsSchema),
    canvas_generate_text: generationFlowSchema.merge(generationOptionsSchema),
    canvas_generate_image: generationFlowSchema.merge(generationOptionsSchema),
    canvas_generate_video: generationFlowSchema.merge(generationOptionsSchema),
    canvas_generate_audio: generationFlowSchema.merge(generationOptionsSchema),
    canvas_update_node: z.object({ id: z.string(), patch: recordSchema.optional(), metadata: recordSchema.optional() }),
    canvas_update_node_text: z.object({ id: z.string(), text: z.string(), title: z.string().optional() }),
    canvas_move_nodes: z.object({ items: z.array(z.object({ id: z.string(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() })).min(1) }),
    canvas_resize_node: z.object({ id: z.string(), width: z.number(), height: z.number(), freeResize: z.boolean().optional() }),
    canvas_delete_nodes: z.object({ ids: z.array(z.string()).min(1) }),
    canvas_connect_nodes: z.object({ connections: z.array(z.object({ fromNodeId: z.string(), toNodeId: z.string() })).min(1) }),
    canvas_select_nodes: z.object({ ids: z.array(z.string()) }),
    canvas_set_viewport: z.object({ viewport: viewportSchema }),
    canvas_run_generation: z.object({ nodeId: z.string(), mode: generationModeSchema.optional(), prompt: z.string().optional() }),
    generation_get_status: z.object({ scope: z.enum(["all", "canvas", "image", "video"]).optional(), taskId: z.string().optional(), nodeIds: z.array(z.string()).optional(), limit: z.number().optional() }),
    workbench_image_get_config: z.object({}).passthrough(),
    workbench_image_generate: z.object({ prompt: z.string(), model: z.string().optional(), quality: z.string().optional(), size: z.string().optional(), count: z.number().optional(), run: z.boolean().optional() }),
    workbench_video_get_config: z.object({}).passthrough(),
    workbench_video_generate: z.object({ prompt: z.string(), model: z.string().optional(), size: z.string().optional(), seconds: z.string().optional(), resolution: z.string().optional(), generateAudio: z.boolean().optional(), watermark: z.boolean().optional(), mode: z.enum(["frames", "reference"]).optional(), run: z.boolean().optional() }),
    prompts_search: z.object({ keyword: z.string().optional(), category: z.string().optional(), tags: z.array(z.string()).optional(), page: z.number().optional(), pageSize: z.number().optional() }),
    assets_list: z.object({ kind: z.enum(["all", "text", "image", "video"]).optional(), keyword: z.string().optional(), page: z.number().optional(), pageSize: z.number().optional() }),
    assets_add: z.object({ kind: z.enum(["text", "image"]), title: z.string(), content: z.string().optional(), imageUrl: z.string().optional(), tags: z.array(z.string()).optional(), source: z.string().optional(), note: z.string().optional() }),
} satisfies Record<ToolName, z.ZodTypeAny>;

export const toolDescriptions: Record<ToolName, string> = {
    site_navigate: "跳转网站页面。path 可为 / (首页)、/canvas (我的画布)、/canvas/:id (指定画布)、/image (生图工作台)、/video (视频创作台)、/prompts (提示词库)、/assets (我的素材)、/config (配置)。操作画布前若不在画布页，先用本工具打开画布。",
    canvas_list_projects: "列出用户全部画布（仅标题、创建/更新时间、节点数、连线数，不含完整数据），支持 keyword 搜索和 page/pageSize 分页。返回的 id 可配合 site_navigate 跳转到 /canvas/:id 打开对应画布。",
    canvas_read_image: "读取指定图片节点的实际图片数据和原始尺寸。",
    canvas_crop_image: "按归一化 0..1 坐标裁切指定图片，并在画布创建结果子节点。",
    canvas_split_image: "将指定图片均匀分割为 rows×columns 个子图（总格数最多 25），并在画布创建结果子节点。",
    canvas_resample_image: "按指定算法调整图片长边像素数（最多 4096），并在画布创建结果子节点。",
    canvas_stitch_images: "按原始像素尺寸和给定顺序横向或纵向拼接 2–20 个图片节点，不缩放，输出一张 PNG。",
    canvas_compose_images: "复制底图原始像素，按顺序在指定像素矩形内贴入 1–20 张图片；支持 contain、cover、stretch、可选区域清除色和 nearest、smooth 插值。",
    canvas_import_image: "将宿主提供的 nodeId、标题和 PNG/JPEG/WebP base64 data URL 导入当前画布，不调用 AI；同 ID 仅在已有图片字节完全相同时复用。",
    canvas_get_state: "读取当前网页画布的节点、连线、选区和视口。",
    canvas_get_selection: "读取当前网页画布选中的节点。",
    canvas_export_snapshot: "导出当前画布快照，用于理解布局。",
    canvas_apply_ops: "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。",
    canvas_create_node: "创建任意类型节点：text、image、config、video、audio。适合创建占位图、媒体占位、配置节点或自定义 metadata 节点。",
    canvas_create_text_node: "在当前画布创建单个文本节点。",
    canvas_create_text_nodes: "批量创建文本节点，适合生成标题、段落、脚本、说明等内容块。",
    canvas_create_config_node: "创建生成配置节点，可指定 text/image/video/audio 模式和生成参数，可选择立即触发生成。",
    canvas_create_image_prompt_flow: "创建提示词文本节点和图片生成配置节点，并自动连线，可选择立即触发生图。",
    canvas_create_generation_flow: "创建通用生成流程：提示词文本节点、生成配置节点、参考节点连线，可用于文案、生图、视频或音频。",
    canvas_generate_text: "创建通用文本生成流程并立即触发生成。",
    canvas_generate_image: "创建通用图片生成流程并立即触发生成。",
    canvas_generate_video: "创建通用视频生成流程并立即触发生成。",
    canvas_generate_audio: "创建通用音频生成流程并立即触发生成。",
    canvas_update_node: "更新节点基础字段或 metadata。",
    canvas_update_node_text: "更新文本节点内容和标题。",
    canvas_move_nodes: "移动一个或多个节点，支持绝对坐标或 dx/dy 偏移。",
    canvas_resize_node: "调整节点尺寸。",
    canvas_delete_nodes: "删除指定节点及相关连线。",
    canvas_connect_nodes: "批量连接节点。",
    canvas_select_nodes: "设置当前选中节点。",
    canvas_set_viewport: "调整画布视口。",
    canvas_run_generation: "触发指定节点生成，通常用于配置节点或文本/图片/视频/音频节点。",
    generation_get_status: "查询当前活动网页的生成任务状态。默认返回画布、生图工作台和视频工作台最近任务；可用 scope 过滤来源，用 taskId 查询工作台任务，用 nodeIds 查询画布节点。",
    workbench_image_get_config: "读取生图工作台的当前参数和可选项（可用模型、质量、分辨率 1k/2k/4k/auto、宽高比、张数范围），在调用 workbench_image_generate 前先了解可选值。",
    workbench_image_generate: "在生图工作台填入提示词并按需设置 model、quality、size（如 16:9 或 2048x1152）、count，run 默认 true 会自动点击生成按钮。会自动跳转到生图工作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
    workbench_video_get_config: "读取视频创作台的当前参数和可选项（可用模型、清晰度 480/720/1080、比例 1:1/3:4/4:3/16:9/9:16/21:9/auto、时长 4–30 秒、首尾帧或全能参考模式、是否生成声音与水印）。",
    workbench_video_generate: "在视频创作台填入提示词并按需设置 model、size（1:1、3:4、4:3、16:9、9:16、21:9、auto 或 1280x720）、seconds（4–30）、resolution（480/720/1080）、generateAudio、watermark、mode（frames 首尾帧 / reference 全能参考），run 默认 true 会自动点击生成按钮。会自动跳转到视频创作台。生成为异步过程，提交后返回 taskId，可用 generation_get_status 查询状态。",
    prompts_search: "搜索提示词库（第三方提示词合集），支持 keyword、category、tags 过滤和 page/pageSize 分页，返回标题、提示词、分类、标签、封面等。",
    assets_list: "列出用户「我的素材」，支持 kind（text/image/video）过滤、keyword 搜索和 page/pageSize 分页。为控制体积不返回图片/视频原始 data，仅返回封面与元信息。",
    assets_add: "向「我的素材」新增素材。kind=text 时用 content 传文本内容；kind=image 时用 imageUrl 传图片地址或 dataURL。可附带 title、tags、source、note。",
};
