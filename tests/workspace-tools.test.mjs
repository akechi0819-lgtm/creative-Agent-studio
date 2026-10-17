import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { createWorkspaceToolDefinitions, readWorkspaceArtifact, listWorkspaceArtifacts } from '../adapters/dsh/workspace-tools.mjs';
import { defaultPythonPath } from '../src/workspace/process.mjs';
import { readWorkspaceDocument, readWorkspaceImageText } from '../src/workspace/documents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures/workspace');

function findPythonRuntime() {
  const candidates = [process.env.STUDIO_OCR_PYTHON, process.env.PYTHON, defaultPythonPath()];
  const locator = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['python3', 'python']) {
    const located = spawnSync(locator, [name], { encoding: 'utf8' });
    if (located.status === 0) candidates.push(located.stdout.split(/\r?\n/u).find(Boolean));
  }
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const probe = spawnSync(candidate, ['-I', '-X', 'utf8', '-c', 'print("中文")'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim() === '中文') return candidate;
  }
  return null;
}

function findOfficePython() {
  const candidates = [process.env.STUDIO_OCR_PYTHON, process.env.PYTHON, defaultPythonPath()];
  const locator = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['python3', 'python']) {
    const located = spawnSync(locator, [name], { encoding: 'utf8' });
    if (located.status === 0) candidates.push(located.stdout.split(/\r?\n/u).find(Boolean));
  }
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const probe = spawnSync(candidate, ['-I', '-c', 'import openpyxl, docx'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const PYTHON = findOfficePython();
const PYTHON_RUNTIME = findPythonRuntime();

async function fixtureSources() {
  const names = new Map([
    ['documents:1', 'roster.xlsx'],
    ['documents:2', 'brief.docx'],
    ['documents:3', 'brief.pdf'],
    ['photos:1', 'S-001.jpg'],
    ['photos:2', 'S-002.jpg'],
    ['photos:3', 'S-003.jpg'],
    ['photos:4', 'S-003-copy.jpg'],
  ]);
  const bytesByName = new Map();
  for (const name of new Set(names.values())) bytesByName.set(name, await readFile(path.join(FIXTURES, name)));
  return async ({ sourceId, fileOrder }) => {
    const name = names.get(`${sourceId}:${fileOrder}`);
    if (!name) throw new Error('Unknown synthetic fixture source');
    const bytes = bytesByName.get(name);
    return {
      name,
      mimeType: name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  };
}

test('workspace tools import frozen roster/photos, filter and dedupe, batch images, write XLSX, zip and expose verified artifacts', { skip: PYTHON ? false : 'Python environment with locked openpyxl/python-docx dependencies is unavailable.' }, async t => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-workspace-e2e-'));
  const workspaceRoot = path.join(taskRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const progress = [];
  const sourceReader = await fixtureSources();
  const definitions = createWorkspaceToolDefinitions({
    workspaceRoot,
    pythonPath: PYTHON,
    readFrozenSource: sourceReader,
    onProgress: async description => progress.push(description),
    attachments: {
      async saveImage({ data, mediaType, name }) { return { id: `preview-${name}`, bytes: data.byteLength, mediaType, name }; },
    },
    withProtectedState: async run => run(),
  });
  const tools = new Map(definitions.map(definition => [definition.name, definition]));
  const execute = async (name, args = {}) => {
    const definition = tools.get(name);
    assert.ok(definition, `missing tool ${name}`);
    return definition.execute(args, { signal: new AbortController().signal });
  };

  assert.deepEqual([...tools.keys()], [
    'studio_workspace_list_files',
    'studio_workspace_import_source',
    'studio_workspace_read_document',
    'studio_workspace_convert_document',
    'studio_workspace_read_image',
    'studio_workspace_write_text',
    'studio_workspace_write_workbook',
    'studio_workspace_batch_images',
    'studio_workspace_create_zip',
    'studio_workspace_run_script',
  ]);

  const roster = await execute('studio_workspace_import_source', { sourceId: 'documents', fileOrder: 1 });
  const brief = await execute('studio_workspace_import_source', { sourceId: 'documents', fileOrder: 2 });
  const pdf = await execute('studio_workspace_import_source', { sourceId: 'documents', fileOrder: 3 });
  const photos = [];
  for (let fileOrder = 1; fileOrder <= 4; fileOrder += 1) {
    photos.push(await execute('studio_workspace_import_source', { sourceId: 'photos', fileOrder }));
  }

  const listing = await execute('studio_workspace_list_files');
  assert.equal(listing.files.length, 7);
  assert.equal(listing.files.some(file => file.path.startsWith('/')), false);

  const rosterData = await execute('studio_workspace_read_document', { relativePath: roster.path, sheetName: 'Roster' });
  assert.equal(rosterData.kind, 'workbook');
  assert.equal(rosterData.sheets[0].rows.length, 5);
  assert.deepEqual(rosterData.sheets[0].rows[1].values, ['S-001', 'Sample A', 'North', 'yes']);
  const docxData = await execute('studio_workspace_read_document', { relativePath: brief.path });
  assert.match(docxData.text, /Synthetic Batch Brief/u);
  assert.match(docxData.text, /Approved unique IDs only/u);
  const pdfData = await execute('studio_workspace_read_document', { relativePath: pdf.path });
  assert.match(pdfData.text, /Synthetic roster PDF fixture/u);

  const image = await execute('studio_workspace_read_image', { relativePath: photos[0].path });
  assert.equal(image.width, 240);
  assert.equal(image.height, 320);
  assert.equal(image.ocr, undefined);
  const imageRender = tools.get('studio_workspace_read_image').output.render({}, image);
  assert.equal(imageRender[1].type, 'image');

  const approvedScript = `import json\nfrom openpyxl import load_workbook\nbook = load_workbook(${JSON.stringify(roster.path)}, read_only=True, data_only=True)\nrows = list(book['Roster'].iter_rows(values_only=True))\nseen = set()\napproved = []\nfor row in rows[1:]:\n    photo_id, display_name, group, status = row\n    if status != 'yes' or photo_id in seen:\n        continue\n    seen.add(photo_id)\n    approved.append([photo_id, display_name, group])\nprint(json.dumps({'approved': approved}, ensure_ascii=False))\n`;
  const scriptResult = await execute('studio_workspace_run_script', { language: 'python', code: approvedScript, timeoutSeconds: 10 });
  assert.equal(scriptResult.exitCode, 0, scriptResult.stderr);
  const approved = JSON.parse(scriptResult.stdout).approved;
  assert.deepEqual(approved.map(row => row[0]), ['S-001', 'S-003']);

  const selectedPhotos = photos.filter(photo => ['S-001.jpg', 'S-003.jpg'].some(name => photo.name === name));
  const batch = await execute('studio_workspace_batch_images', {
    relativePaths: selectedPhotos.map(photo => photo.path),
    maxLongEdge: 160,
    format: 'jpeg',
  });
  assert.equal(batch.processedCount, 2);
  assert.ok(batch.outputs.every(output => output.width <= 160 && output.height <= 160));

  const workbook = await execute('studio_workspace_write_workbook', {
    fileName: 'approved-results.xlsx',
    sheets: [{ name: 'Approved', rows: [['PhotoID', 'DisplayName', 'Group'], ...approved] }],
  });
  assert.equal(workbook.kind, 'workbook');
  assert.ok(workbook.bytes > 0);
  const checkWorkbook = await execute('studio_workspace_read_document', { relativePath: workbook.relativePath || workbook.path });
  assert.deepEqual(checkWorkbook.sheets[0].rows[1].values, ['S-001', 'Sample A', 'North']);

  const zip = await execute('studio_workspace_create_zip', {
    fileName: 'approved-delivery.zip',
    relativePaths: [...batch.outputs.map(output => output.path), workbook.relativePath || workbook.path],
  });
  const zipped = unzipSync(new Uint8Array(await readFile(path.join(workspaceRoot, zip.path))));
  assert.deepEqual(Object.keys(zipped).sort(), ['approved-results.xlsx', ...batch.outputs.map(output => path.posix.basename(output.path))].sort());

  const artifacts = await listWorkspaceArtifacts(workspaceRoot);
  assert.equal(artifacts.artifacts.length, 4);
  const artifact = await readWorkspaceArtifact(workspaceRoot, workbook.relativePath || workbook.path);
  assert.equal(artifact.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(artifact.sha256, createHash('sha256').update(artifact.bytes).digest('hex'));
  assert.ok(progress.length >= 12);
});

test('Python helper preserves Chinese through JSON stdin and stdout', { skip: PYTHON_RUNTIME ? false : 'Python runtime is unavailable.' }, async t => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-workspace-utf8-'));
  const workspaceRoot = path.join(taskRoot, 'workspace');
  await mkdir(path.join(workspaceRoot, 'inputs'), { recursive: true });
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const relativePath = 'inputs/花名册.csv';
  await writeFile(path.join(workspaceRoot, relativePath), '姓名,审核\n张三,通过\n', 'utf8');
  const result = await readWorkspaceDocument({
    workspaceRoot,
    relativePath,
    pythonPath: PYTHON_RUNTIME,
  });
  assert.equal(result.kind, 'table');
  assert.equal(result.relativePath, relativePath);
  assert.deepEqual(result.rows[1].values, ['张三', '通过']);
});

test('generic Office conversion reuses LibreOffice kit for PDF, CSV and workbook recalculation', async t => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-workspace-convert-'));
  const workspaceRoot = path.join(taskRoot, 'workspace');
  await mkdir(path.join(workspaceRoot, 'inputs'), { recursive: true });
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, 'inputs/brief.docx'), await readFile(path.join(FIXTURES, 'brief.docx')));
  await writeFile(path.join(workspaceRoot, 'inputs/roster.xlsx'), await readFile(path.join(FIXTURES, 'roster.xlsx')));
  const definitions = createWorkspaceToolDefinitions({ workspaceRoot });
  const tool = definitions.find(definition => definition.name === 'studio_workspace_convert_document');
  const execute = args => tool.execute(args, { signal: new AbortController().signal });

  let pdf;
  try {
    pdf = await execute({ relativePath: 'inputs/brief.docx', operation: 'convert', format: 'pdf', fileName: 'brief.pdf' });
  } catch (error) {
    if (/Office 文件处理失败（unavailable）/u.test(error.message)) {
      t.skip('LibreOffice kit engine is not installed for this test platform.');
      return;
    }
    throw error;
  }
  assert.equal(pdf.path, 'outputs/brief.pdf');
  assert.ok(pdf.bytes > 0);
  assert.ok(['native', 'wasm'].includes(pdf.backend));
  assert.deepEqual((await readFile(path.join(workspaceRoot, pdf.path))).subarray(0, 5), Buffer.from('%PDF-'));

  const csv = await execute({ relativePath: 'inputs/roster.xlsx', operation: 'convert', format: 'csv', fileName: 'roster.csv', sheet: 'Roster' });
  const csvText = await readFile(path.join(workspaceRoot, csv.path), 'utf8');
  assert.match(csvText, /S-001,Sample A,North,yes/u);

  const recalculated = await execute({ relativePath: 'inputs/roster.xlsx', operation: 'recalculate', format: 'xlsx', fileName: 'recalculated.xlsx' });
  assert.equal(recalculated.operation, 'recalculate');
  assert.equal(recalculated.format, 'xlsx');
  assert.ok(unzipSync(new Uint8Array(await readFile(path.join(workspaceRoot, recalculated.path))))['[Content_Types].xml']);
  await assert.rejects(execute({ relativePath: 'inputs/roster.xlsx', operation: 'recalculate', format: 'csv', fileName: 'bad.csv' }));
  await assert.rejects(execute({ relativePath: 'inputs/brief.docx', operation: 'convert', format: 'xlsx', fileName: 'bad.xlsx' }));
});

test('OCR runner injection verifies PDF truncation and image OCR error reporting without platform shell stubs', async t => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-workspace-ocr-'));
  const workspaceRoot = path.join(taskRoot, 'workspace');
  await mkdir(path.join(workspaceRoot, 'inputs'), { recursive: true });
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const scannedPdf = await readFile(path.join(FIXTURES, 'scanned.pdf'));
  await writeFile(path.join(workspaceRoot, 'inputs/scanned.pdf'), scannedPdf);
  await writeFile(path.join(workspaceRoot, 'inputs/S-001.jpg'), await readFile(path.join(FIXTURES, 'S-001.jpg')));
  const longText = 'Synthetic OCR text '.repeat(3000);
  const result = await readWorkspaceDocument({
    workspaceRoot,
    relativePath: 'inputs/scanned.pdf',
    ocrRunner: async (filePath, options) => {
      assert.equal(path.basename(filePath), 'scanned.pdf');
      assert.equal(options.ocrTimeoutMs, 60_000);
      assert.equal(options.isolatedEnv, true);
      return { extractor: 'fixture OCR runner', pages: [{ page: 1, text: longText }], text: longText };
    },
  });
  assert.equal(result.ocrExtractor, 'fixture OCR runner');
  assert.equal(result.pages[0].text.length, 50_000);
  assert.equal(result.truncated, true);
  assert.equal(JSON.stringify(result).includes(taskRoot), false);

  const image = await readWorkspaceImageText({
    workspaceRoot,
    relativePath: 'inputs/S-001.jpg',
    ocrRunner: async () => { throw Object.assign(new Error(`fixture failure at ${taskRoot}`), { code: 'FIXTURE_OCR_FAILURE' }); },
  });
  assert.equal(image.error, 'FIXTURE_OCR_FAILURE');
  assert.equal(image.text, '');
  assert.equal(JSON.stringify(image).includes(taskRoot), false);
});

test('workspace boundary rejects absolute/traversal/symlink paths; scripts run with bounded timeout and protected-state hook', async t => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-workspace-boundary-'));
  const workspaceRoot = path.join(taskRoot, 'workspace');
  await mkdir(path.join(workspaceRoot, 'inputs'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'outputs'), { recursive: true });
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const outsidePath = path.join(taskRoot, 'outside.txt');
  await writeFile(outsidePath, 'private fixture');
  await symlink(outsidePath, path.join(workspaceRoot, 'inputs/outside.txt'));
  const protectedPath = path.join(taskRoot, 'task.json');
  await writeFile(protectedPath, '{"revision":1}');
  const onProgress = [];
  const definitions = createWorkspaceToolDefinitions({
    workspaceRoot,
    pythonPath: PYTHON_RUNTIME || defaultPythonPath(),
    onProgress: async text => onProgress.push(text),
    withProtectedState: async run => {
      const before = createHash('sha256').update(await readFile(protectedPath)).digest('hex');
      const result = await run();
      const after = createHash('sha256').update(await readFile(protectedPath)).digest('hex');
      if (before !== after) throw Object.assign(new Error('protected task state changed during script execution'), { code: 'ERR_SCRIPT_STATE_CONFLICT' });
      return result;
    },
  });
  const tools = new Map(definitions.map(definition => [definition.name, definition]));
  const execute = async (name, args = {}) => tools.get(name).execute(args, { signal: new AbortController().signal });
  assert.equal(tools.get('studio_workspace_list_files').parameters.additionalProperties, false);
  await assert.rejects(execute('studio_workspace_read_document', { relativePath: '../../outside.txt' }));
  await assert.rejects(execute('studio_workspace_read_document', { relativePath: 'inputs/outside.txt' }), /符号链接/u);
  await assert.rejects(execute('studio_workspace_create_zip', { fileName: 'leak.zip', relativePaths: ['inputs/outside.txt'] }), /outputs/u);

  const result = await execute('studio_workspace_run_script', {
    language: 'javascript',
    code: 'console.log(process.cwd()); console.log(process.env.API_KEY || "no-secret-env")',
    timeoutSeconds: 3,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /no-secret-env/u);
  assert.equal(result.stdout.split(/\r?\n/u)[0], await realpath(workspaceRoot));
  assert.ok(onProgress.some(text => text.includes('简单 Python 或 JavaScript')));

  const pythonOutput = await execute('studio_workspace_run_script', {
    language: 'python',
    code: 'print("脚本中文输出")',
    timeoutSeconds: 3,
  });
  assert.equal(pythonOutput.exitCode, 0, pythonOutput.stderr);
  assert.equal(pythonOutput.stdout.trim(), '脚本中文输出');

  await writeFile(protectedPath, '{"revision":1}');
  await assert.rejects(execute('studio_workspace_run_script', {
    language: 'python',
    code: `open(${JSON.stringify(path.relative(workspaceRoot, protectedPath))}, 'w').write('altered')`,
    timeoutSeconds: 3,
  }), error => error.code === 'ERR_SCRIPT_STATE_CONFLICT');
  assert.equal(await readFile(protectedPath, 'utf8'), 'altered');
});

test('Python and JavaScript scripts report timeout and output truncation under the configured limits', async t => {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-workspace-script-bounds-'));
  const workspaceRoot = path.join(taskRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  t.after(() => rm(taskRoot, { recursive: true, force: true }));
  const definitions = createWorkspaceToolDefinitions({ workspaceRoot, pythonPath: PYTHON || defaultPythonPath() });
  const tool = definitions.find(definition => definition.name === 'studio_workspace_run_script');
  const execute = args => tool.execute(args, { signal: new AbortController().signal });
  const timeout = await execute({ language: 'javascript', code: 'while (true) {}', timeoutSeconds: 1 });
  assert.equal(timeout.timedOut, true);
  const output = await execute({ language: 'javascript', code: 'console.log("x".repeat(40000))', timeoutSeconds: 3 });
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.stdout, 'utf8') <= 32 * 1024);
});
