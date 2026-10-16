import path from 'node:path';
import { stat } from 'node:fs/promises';
import { resolveWorkspaceFile, safeFileName } from './paths.mjs';

const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const CONVERSION_TIMEOUT_MS = 120_000;

function safeEngineError(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9-]{1,64}$/iu.test(error.code)
    ? error.code
    : 'failed';
  return new Error(`Office 文件处理失败（${code}）。`);
}

export async function convertWorkspaceDocument({
  workspaceRoot,
  relativePath,
  fileName,
  format,
  operation = 'convert',
  sheet,
  signal,
  libreOfficeKit,
}) {
  if (!libreOfficeKit || typeof libreOfficeKit.createConverter !== 'function' || !Array.isArray(libreOfficeKit.CONVERSION_FORMATS)) {
    throw new Error('Office 转换引擎未配置。');
  }
  if (!['convert', 'recalculate'].includes(operation)) throw new Error('操作必须是 convert 或 recalculate。');
  signal?.throwIfAborted();

  const source = await resolveWorkspaceFile(workspaceRoot, relativePath);
  const inputFormat = path.extname(source.relativePath).slice(1).toLowerCase();
  if (!inputFormat) throw new Error('输入文件需要 Office 格式扩展名。');
  const inputInfo = await stat(source.path);
  if (inputInfo.size < 1 || inputInfo.size > MAX_INPUT_BYTES) throw new Error('Office 输入文件为空或超过 100 MiB。');

  const outputFormat = typeof format === 'string' ? format.toLowerCase() : '';
  const name = safeFileName(fileName);
  if (name === 'file' || path.posix.extname(name).toLowerCase() !== `.${outputFormat}`) {
    throw new Error('输出文件名扩展名必须与 format 一致。');
  }
  const outputRelativePath = `outputs/${name}`;
  if (source.relativePath === outputRelativePath) throw new Error('输出文件不能覆盖输入文件。');
  const output = await resolveWorkspaceFile(workspaceRoot, outputRelativePath, { allowMissingLeaf: true });
  if (output.exists) throw new Error('outputs/ 中已存在同名文件，请换一个文件名。');

  if (operation === 'convert') {
    const rule = libreOfficeKit.CONVERSION_FORMATS.find(item => item.inputs.includes(inputFormat));
    if (!rule || !rule.outputs.includes(outputFormat)) throw new Error('所选输入与输出格式组合不受支持。');
  } else {
    if (!['xls', 'xlsx', 'ods'].includes(inputFormat) || !['xlsx', 'ods'].includes(outputFormat) || sheet !== undefined) {
      throw new Error('公式重算仅支持 XLS、XLSX、ODS 工作簿另存为 XLSX 或 ODS，且作用于整个工作簿。');
    }
  }
  if (sheet !== undefined && (typeof sheet !== 'string' || !sheet.trim() || sheet.length > 128)) {
    throw new Error('sheet 必须是非空的工作表名，且不超过 128 个字符。');
  }

  let converter;
  try {
    converter = await libreOfficeKit.createConverter({
      timeoutMs: CONVERSION_TIMEOUT_MS,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
      maxUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
      fontMetadataCacheDirectory: false,
    });
    signal?.throwIfAborted();
    const request = {
      inputPath: source.path,
      outputPath: output.path,
      ...(operation === 'convert' && sheet !== undefined ? { sheet: sheet.trim() } : {}),
    };
    const result = await converter[operation](request, signal);
    const saved = await resolveWorkspaceFile(workspaceRoot, outputRelativePath);
    const outputInfo = await stat(saved.path);
    if (outputInfo.size < 1 || outputInfo.size > MAX_OUTPUT_BYTES) throw new Error('转换结果为空或超过 512 MiB。');
    return {
      kind: 'conversion',
      operation,
      format: outputFormat,
      path: outputRelativePath,
      bytes: outputInfo.size,
      backend: converter.backend,
      missingFonts: Array.isArray(result?.missingFonts) ? result.missingFonts : [],
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || new Error('文件处理已取消。');
    if (error?.message === '转换结果为空或超过 512 MiB。') throw error;
    if (error?.message === '文件处理已取消。') throw error;
    throw safeEngineError(error);
  } finally {
    await converter?.dispose().catch(() => {});
  }
}
