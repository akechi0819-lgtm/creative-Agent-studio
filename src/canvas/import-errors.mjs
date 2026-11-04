const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const canvasImportErrorCodes = Object.freeze({
  unsupportedFile: 'ERR_CANVAS_IMPORT_UNSUPPORTED_FILE',
  fileMissing: 'ERR_CANVAS_IMPORT_FILE_MISSING',
  fileUnreadable: 'ERR_CANVAS_IMPORT_FILE_UNREADABLE',
  notFile: 'ERR_CANVAS_IMPORT_NOT_FILE',
  fileTooLarge: 'ERR_CANVAS_IMPORT_FILE_TOO_LARGE',
  invalidImage: 'ERR_CANVAS_IMPORT_INVALID_IMAGE',
  invalidArguments: 'ERR_CANVAS_IMPORT_INVALID_ARGUMENTS',
  disconnected: 'ERR_CANVAS_IMPORT_DISCONNECTED',
  statePending: 'ERR_CANVAS_IMPORT_STATE_PENDING',
  selectTarget: 'ERR_CANVAS_IMPORT_SELECT_TARGET',
  resultUnknown: 'ERR_CANVAS_IMPORT_RESULT_UNKNOWN',
  bridgeUnavailable: 'ERR_CANVAS_IMPORT_BRIDGE_UNAVAILABLE',
  invalidConnection: 'ERR_CANVAS_IMPORT_INVALID_CONNECTION',
  payloadTooLarge: 'ERR_CANVAS_IMPORT_PAYLOAD_TOO_LARGE',
});

const messages = new Map([
  [canvasImportErrorCodes.unsupportedFile, () => '导入失败：文件格式不支持。请选择 PNG、JPEG 或 WebP 文件，再调用 canvas_import_file。'],
  [canvasImportErrorCodes.fileMissing, () => '导入失败：找不到指定本机文件。请检查路径和文件名后重试。'],
  [canvasImportErrorCodes.fileUnreadable, () => '导入失败：无法读取本机文件。请检查文件是否存在及当前账号的读取权限。'],
  [canvasImportErrorCodes.notFile, () => '导入失败：指定路径不是文件。请选择一个图像文件。'],
  [canvasImportErrorCodes.fileTooLarge, () => '导入失败：文件超过 20 MiB。请压缩或选择更小的文件后重试。'],
  [canvasImportErrorCodes.invalidImage, () => '导入失败：图片无法解码。请用图片查看器确认原件可正常打开，再选择有效的 PNG、JPEG 或 WebP 文件重试。'],
  [canvasImportErrorCodes.invalidArguments, () => '导入请求参数无效。请检查 title、nodeId 和图片 dataUrl 格式后重试。'],
  [canvasImportErrorCodes.disconnected, () => '导入尚未开始：目标 Canvas 页面未连接。请打开目标画布，查看 canvas_status 中的连接状态后重试。'],
  [canvasImportErrorCodes.statePending, () => '导入尚未开始：Canvas 页面还未同步画布状态。请等待 canvas_status 显示目标页面已连接后重试。'],
  [canvasImportErrorCodes.selectTarget, () => '导入尚未开始：有多个 Canvas 页面连接。请根据 canvas_status 返回的 projectId 和 clientId 指定目标后重试。'],
  [canvasImportErrorCodes.resultUnknown, () => '导入结果未知。请先调用 canvas_status 和 canvas_get_state 检查目标画布，再确认是否已出现导入节点；确认未导入后再重试。'],
  [canvasImportErrorCodes.bridgeUnavailable, () => '本机 Canvas 连接不可用。请调用 canvas_status，打开目标画布并确认连接后重试。'],
  [canvasImportErrorCodes.invalidConnection, () => 'Canvas 连接凭证无效。请调用 canvas_status 确认当前 Company Lite 画布连接，再重试导入。'],
  [canvasImportErrorCodes.payloadTooLarge, () => '导入图片数据超过本地桥接上限。请通过 canvas_import_file 选择不超过 20 MiB 的 PNG、JPEG 或 WebP 文件。'],
]);

export function createCanvasImportError(code, { requestId, status } = {}) {
  const error = new Error(code);
  error.code = code;
  if (Number.isInteger(status)) {
    error.status = status;
    if (requestIdPattern.test(requestId || '')) error.requestId = requestId;
  }
  return error;
}

/** Turn import failures into fixed host instructions without forwarding bridge or browser text. */
export function canvasImportFailureText(error) {
  const message = messages.get(error?.code);
  const requestId = messages.has(error?.code) && Number.isInteger(error?.status) && requestIdPattern.test(error?.requestId || '')
    ? error.requestId
    : null;
  if (!message) {
    const text = '画布导入失败，原因未识别。请先调用 canvas_status 和 canvas_get_state 检查导入是否已完成，确认未导入后再重试。';
    return requestId
      ? `${text} 诊断编号 ${requestId}。`
      : `${text} 请查看发生时间附近的本机脱敏 Canvas 日志。`;
  }
  if (requestId) return `${message()} 诊断编号 ${requestId}。`;
  if ([canvasImportErrorCodes.resultUnknown, canvasImportErrorCodes.bridgeUnavailable, canvasImportErrorCodes.invalidConnection].includes(error.code)) {
    return `${message()} 如需排查，请提供发生时间附近的本机脱敏 Canvas 日志。`;
  }
  return message();
}

export function isCanvasImportError(error) {
  return messages.has(error?.code);
}

