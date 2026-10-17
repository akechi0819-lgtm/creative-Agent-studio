import { readWorkspaceFile, resolveWorkspaceFile } from './paths.mjs';
import { runOfficeHelper } from './process.mjs';
import { extractFile } from '../assets/cleaner.mjs';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_PDF_TEXT = 50_000;

function extensionOf(relativePath) {
  return path.posix.extname(relativePath).toLowerCase();
}

function compactOcr(result) {
  let remaining = MAX_PDF_TEXT;
  const pages = [];
  for (const page of (Array.isArray(result?.pages) ? result.pages : []).slice(0, MAX_PDF_PAGES)) {
    if (remaining <= 0) break;
    const value = String(page.text || '');
    const text = value.slice(0, remaining);
    remaining -= text.length;
    pages.push({ page: page.page, text, ...(text.length < value.length ? { truncated: true } : {}) });
  }
  const text = pages.map(page => `第 ${page.page} 页\n${page.text}`).join('\n\n').slice(0, MAX_PDF_TEXT);
  return { pages, text, truncated: pages.length < (result.pages?.length || 0) || String(result.text || '').length > MAX_PDF_TEXT };
}

async function tryOcr(relativePath, workspaceRoot, signal, ocrPythonPath, timeoutMs, ocrRunner) {
  if (!ocrPythonPath && typeof ocrRunner !== 'function') return null;
  const target = await resolveWorkspaceFile(workspaceRoot, relativePath);
  try {
    const runner = typeof ocrRunner === 'function' ? ocrRunner : extractFile;
    const result = await runner(target.path, {
      ocrPythonPath,
      ocrTimeoutMs: timeoutMs,
      isolatedEnv: true,
      signal,
    });
    return { ...compactOcr(result), extractor: result.extractor };
  } catch (error) {
    if (signal?.aborted || error?.code === 'ABORTED' || error?.name === 'AbortError') throw signal?.reason || error;
    const code = typeof error?.code === 'string' && /^[A-Z_]{2,48}$/u.test(error.code) ? error.code : 'OCR_FAILED';
    return { pages: [], text: '', truncated: false, error: code };
  }
}

async function readPdf(relativePath, bytes, workspaceRoot, signal, ocrPythonPath, ocrRunner) {
  let loadingTask;
  let pdf;
  try {
    loadingTask = getDocument({ data: new Uint8Array(bytes), verbosity: 0, useSystemFonts: true });
    pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error('PDF 页数超过 200 页上限。');
    const pages = [];
    let textSize = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .filter(item => typeof item.str === 'string')
          .map(item => `${item.str}${item.hasEOL ? '\n' : ' '}`)
          .join('')
          .trim();
        const remaining = Math.max(0, MAX_PDF_TEXT - textSize);
        const clipped = text.slice(0, remaining);
        textSize += clipped.length;
        pages.push({ page: number, text: clipped, ...(clipped.length < text.length ? { truncated: true } : {}) });
      } finally {
        page.cleanup();
      }
      if (textSize >= MAX_PDF_TEXT) break;
    }
    const result = {
      kind: 'pdf',
      pageCount: pdf.numPages,
      pages,
      text: pages.map(page => `第 ${page.page} 页\n${page.text}`).join('\n\n'),
      scannedPdfNote: pages.every(page => !page.text.trim()) ? 'PDF 没有可提取的文字层。' : undefined,
      truncated: pages.length < pdf.numPages || pages.some(page => page.truncated),
    };
    if (pages.every(page => !page.text.trim()) && (ocrPythonPath || typeof ocrRunner === 'function')) {
      const ocr = await tryOcr(relativePath, workspaceRoot, signal, ocrPythonPath, 60_000, ocrRunner);
      if (ocr?.error) result.ocrError = ocr.error;
      else if (ocr) {
        result.pages = ocr.pages;
        result.text = ocr.text;
        result.truncated ||= ocr.truncated;
        delete result.scannedPdfNote;
        result.ocrExtractor = ocr.extractor;
      }
    }
    return result;
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    if (error?.message === 'PDF 页数超过 200 页上限。') throw error;
    throw new Error('无法读取该 PDF；文件可能损坏或格式不受支持。');
  } finally {
    await loadingTask?.destroy();
  }
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('文件不是有效 UTF-8 文本。');
  }
}

export async function readWorkspaceDocument({ workspaceRoot, relativePath, sheetName, startRow = 1, maxRows = 150, pythonPath, ocrPythonPath, ocrRunner, signal }) {
  if (typeof relativePath !== 'string') throw new Error('relativePath 必须是 workspace 相对路径。');
  const extension = extensionOf(relativePath);
  const bytes = await readWorkspaceFile(workspaceRoot, relativePath);
  signal?.throwIfAborted();
  if (extension === '.pdf') {
    if (bytes.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error('PDF 超过 25 MiB 读取上限。');
    return { relativePath, ...(await readPdf(relativePath, bytes, workspaceRoot, signal, ocrPythonPath, ocrRunner)) };
  }
  if (['.xlsx', '.docx', '.csv', '.tsv'].includes(extension)) {
    if (bytes.byteLength > MAX_OFFICE_FILE_BYTES) throw new Error('Office 文件超过 25 MiB 读取上限。');
    const operation = extension === '.xlsx' ? 'read_xlsx' : extension === '.docx' ? 'read_docx' : 'read_csv';
    const result = await runOfficeHelper({
      workspaceRoot,
      pythonPath,
      signal,
      request: { operation, relativePath, ...(extension === '.xlsx' ? { sheetName, startRow, maxRows } : ['.csv', '.tsv'].includes(extension) ? { startRow, maxRows, ...(extension === '.tsv' ? { delimiter: '\t' } : {}) } : {}) },
    });
    return { relativePath, ...result };
  }
  if (['.txt', '.md', '.json', '.tsv'].includes(extension)) {
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES) throw new Error('文本文件超过 2 MiB 读取上限。');
    const text = decodeUtf8(bytes);
    return { relativePath, kind: 'text', text: text.slice(0, MAX_PDF_TEXT), truncated: text.length > MAX_PDF_TEXT };
  }
  throw new Error('可读取格式为 DOCX、PDF、XLSX、CSV、TSV、TXT、MD 或 JSON。');
}

export async function readWorkspaceImageText({ workspaceRoot, relativePath, ocrPythonPath, ocrRunner, signal }) {
  if (!ocrPythonPath && typeof ocrRunner !== 'function') return null;
  await resolveWorkspaceFile(workspaceRoot, relativePath);
  const result = await tryOcr(relativePath, workspaceRoot, signal, ocrPythonPath, 30_000, ocrRunner);
  if (!result) return null;
  return {
    extractor: result.extractor,
    text: result.text,
    ...(result.error ? { error: result.error } : {}),
    truncated: result.truncated,
  };
}
