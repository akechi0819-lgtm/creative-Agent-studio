import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { test } from 'node:test';
import { cleanMaterial, CLEANER_PROMPT_VERSION } from '../src/assets/cleaner.mjs';
import { saveConfig } from '../src/web/config.mjs';

function successResponse({ summary = '根据内容生成的摘要', tags = ['主题词'] } = {}) {
  return {
    choices: [{
      finish_reason: 'stop',
      message: { content: JSON.stringify({ summary, tags }) },
    }],
  };
}

async function fakeModel(handler = () => successResponse()) {
  const requests = [];
  let received;
  const gotRequest = new Promise((resolve) => { received = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ payload, headers: request.headers });
    received?.();
    received = undefined;
    const result = await handler(payload, request, response);
    if (result === 'hang') return;
    if (result === 'body-hang') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{"choices":');
      return;
    }
    if (response.destroyed) return;
    response.writeHead(result?.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result?.body ?? result ?? successResponse()));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    requests,
    gotRequest,
    config: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'local-test-model',
      apiKey: 'local-only-secret',
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function makeJpeg(text) {
  const width = 1400;
  const height = 300;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  context.font = 'bold 92px Arial';
  context.fillText(text, 55, 190);
  return canvas.toBuffer('image/jpeg', 0.98);
}

function makeBlankJpeg() {
  const canvas = createCanvas(800, 260);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 800, 260);
  return canvas.toBuffer('image/jpeg', 0.98);
}

function makeScannedPdf(pageLabels) {
  const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary');
  const objects = new Map();
  const kids = [];
  pageLabels.forEach((label, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    kids.push(`${pageId} 0 R`);
    const jpeg = makeJpeg(label);
    const width = 700;
    const height = 150;
    objects.set(pageId, Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
      + `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    ));
    objects.set(imageId, Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1400 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      Buffer.from('\nendstream'),
    ]));
    const content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`);
    objects.set(contentId, Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('\nendstream'),
    ]));
  });
  objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
  objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`));

  const chunks = [header];
  const offsets = [0];
  let length = header.length;
  for (let id = 1; id <= 2 + pageLabels.length * 3; id += 1) {
    const object = Buffer.concat([
      Buffer.from(`${id} 0 obj\n`),
      objects.get(id),
      Buffer.from('\nendobj\n'),
    ]);
    offsets[id] = length;
    chunks.push(object);
    length += object.length;
  }
  const xrefOffset = length;
  const xref = [`xref\n0 ${offsets.length}\n`, '0000000000 65535 f \n'];
  for (let id = 1; id < offsets.length; id += 1) {
    xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  xref.push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  chunks.push(Buffer.from(xref.join('')));
  return Buffer.concat(chunks);
}

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), 'studio-cleaner-'));
}

function runCli(inputPath, env) {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const script = path.join(projectRoot, 'scripts', 'clean-materials.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, `@${inputPath}`], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

test('model receives complete body and extracted file text without a fixed tag taxonomy', async (t) => {
  const dir = await temporaryDirectory();
  const file = path.join(dir, 'notes.txt');
  const longBody = `BODY_START ${'long body content '.repeat(3000)} BODY_END`;
  const fileBody = `FILE_START ${'complete source text '.repeat(2000)} FILE_END`;
  await writeFile(file, fileBody, 'utf8');
  const server = await fakeModel(() => successResponse({ summary: '完整摘要', tags: ['用户内容标签', '自由主题'] }));
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const result = await cleanMaterial({ title: '用户标题', body: longBody, files: [file] }, { config: server.config });
  assert.equal(result.body, longBody);
  assert.equal(result.fileResults[0].text, fileBody);
  assert.deepEqual(result.tags, ['用户内容标签', '自由主题']);
  assert.equal(result.promptVersion, CLEANER_PROMPT_VERSION);
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.authorization, 'Bearer local-only-secret');
  const prompt = server.requests[0].payload.messages[1].content;
  assert.ok(prompt.includes('BODY_START'));
  assert.ok(prompt.includes('BODY_END'));
  assert.ok(prompt.includes('FILE_START'));
  assert.ok(prompt.includes('FILE_END'));
  assert.ok(prompt.length > 90_000);
});

test('empty model config makes no request and does not install a default endpoint', async () => {
  await assert.rejects(
    cleanMaterial({ title: 't', body: 'b', files: [] }),
    (error) => error.code === 'MODEL_NOT_CONFIGURED' && /未发送网络请求/.test(error.message),
  );
});

test('invalid or incomplete model responses are rejected', async (t) => {
  const invalidServer = await fakeModel(() => successResponse({ summary: '', tags: ['x'] }));
  t.after(() => invalidServer.close());
  await assert.rejects(
    cleanMaterial({ title: '', body: '', files: [] }, { config: invalidServer.config }),
    (error) => error.code === 'MODEL_OUTPUT_INVALID',
  );

  const truncatedServer = await fakeModel(() => ({
    choices: [{ finish_reason: 'length', message: { content: '{"summary":"truncated' } }],
  }));
  t.after(() => truncatedServer.close());
  await assert.rejects(
    cleanMaterial({ title: '', body: '', files: [] }, { config: truncatedServer.config }),
    (error) => error.code === 'MODEL_RESPONSE_INCOMPLETE',
  );
});

test('model timeout and cancellation errors do not expose service URL or API key', async (t) => {
  const timeoutServer = await fakeModel(() => 'hang');
  t.after(() => timeoutServer.close());
  await assert.rejects(
    cleanMaterial({ title: '', body: '', files: [] }, { config: timeoutServer.config, timeoutMs: 80 }),
    (error) => error.code === 'MODEL_TIMEOUT'
      && !error.message.includes(timeoutServer.config.apiKey)
      && !error.message.includes(timeoutServer.config.baseUrl),
  );

  const bodyTimeoutServer = await fakeModel(() => 'body-hang');
  t.after(() => bodyTimeoutServer.close());
  await assert.rejects(
    cleanMaterial({ title: '', body: '', files: [] }, { config: bodyTimeoutServer.config, timeoutMs: 80 }),
    (error) => error.code === 'MODEL_TIMEOUT' && !error.message.includes(bodyTimeoutServer.config.apiKey),
  );

  const abortServer = await fakeModel(() => 'hang');
  t.after(() => abortServer.close());
  const controller = new AbortController();
  const pending = cleanMaterial(
    { title: '', body: '', files: [] },
    { config: abortServer.config, signal: controller.signal, timeoutMs: 10_000 },
  );
  await abortServer.gotRequest;
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.code === 'ABORTED'
      && !error.message.includes(abortServer.config.apiKey)
      && !error.message.includes(abortServer.config.baseUrl),
  );
});

test('standalone CLI reads shared basic config and redacts provider-reflected credentials', async (t) => {
  const dir = await temporaryDirectory();
  const dataDir = path.join(dir, 'app-data');
  const inputPath = path.join(dir, 'input.json');
  await writeFile(inputPath, JSON.stringify({ title: 'title', body: 'body', files: [] }), 'utf8');
  const server = await fakeModel(() => successResponse({
    summary: 'provider echoed local-only-secret',
    tags: ['local-only-secret', 'Bearer abcdefghijklmnop', 'OPENAI_API_KEY=qrstuvwxyz123456'],
  }));
  await saveConfig({ expectedRevision: 1, base: server.config }, { root: dataDir });
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const result = await runCli(inputPath, {
    ...process.env,
    STUDIO_DATA_DIR: dataDir,
    STUDIO_TEXT_BASE_URL: 'http://127.0.0.1:1/v1',
    STUDIO_TEXT_MODEL: 'legacy-environment-model',
    STUDIO_TEXT_API_KEY: 'legacy-environment-test-key',
  });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].headers.authorization, `Bearer ${server.config.apiKey}`);
  assert.equal(server.requests[0].payload.model, server.config.model);
  assert.ok(!result.stdout.includes(server.config.apiKey));
  assert.ok(!result.stdout.includes('abcdefghijklmnop'));
  assert.ok(!result.stdout.includes('qrstuvwxyz123456'));
  assert.ok(result.stdout.includes('[已隐藏凭据]'));
});

test('OCR helper emits parseable UTF-8 JSON with Chinese text under a cp1252 stdout encoding', {
  skip: !process.env.STUDIO_OCR_PYTHON && !existsSync(path.resolve('.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    ? 'Prepare the private OCR runtime to run the helper encoding regression'
    : false,
}, async (t) => {
  const dir = await temporaryDirectory();
  const inputPath = path.join(dir, 'fake.png');
  const fakeModulePath = path.join(dir, 'rapidocr.py');
  const python = process.env.STUDIO_OCR_PYTHON
    || path.resolve('.venv-ocr', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const helperPath = path.resolve('scripts/ocr_materials.py');
  await writeFile(inputPath, 'fake image');
  await writeFile(fakeModulePath, [
    'import os',
    'class Result:',
    '    txts = ["中文识别结果"]',
    'class RapidOCR:',
    '    def __init__(self, params=None):',
    '        assert params["Global.model_root_dir"] == os.environ["STUDIO_RAPIDOCR_MODEL_DIR"]',
    '    def __call__(self, image):',
    '        return Result()',
  ].join('\n'), 'utf8');
  t.after(() => rm(dir, { recursive: true, force: true }));

  const result = await new Promise((resolve, reject) => {
    const child = spawn(python, [helperPath, 'image', inputPath], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PYTHONIOENCODING: 'cp1252',
        STUDIO_RAPIDOCR_MODEL_DIR: path.join(dir, 'model-cache'),
        PYTHONPATH: [dir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.every((byte) => byte < 0x80), 'JSON escapes keep stdout writable in cp1252');
  const parsed = JSON.parse(result.stdout.toString('utf8'));
  assert.equal(parsed.pages[0].text, '中文识别结果');
});

test('real RapidOCR helper OCRs every page of a local scanned PDF', {
  skip: !process.env.STUDIO_OCR_PYTHON && !existsSync(path.resolve('.venv-ocr/bin/python'))
    ? 'Prepare the independent OCR environment to run the local RapidOCR integration sample'
    : false,
}, async (t) => {
  const dir = await temporaryDirectory();
  const file = path.join(dir, 'scanned.pdf');
  await writeFile(file, makeScannedPdf(['SAMPLE OCR PAGE ONE', 'SAMPLE OCR PAGE TWO']));
  const server = await fakeModel();
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const python = process.env.STUDIO_OCR_PYTHON || path.resolve('.venv-ocr/bin/python');
  const result = await cleanMaterial(
    { title: 'scan', body: 'all page source', files: [file] },
    { config: server.config, ocrPythonPath: python, ocrTimeoutMs: 300_000 },
  );
  const record = result.fileResults[0];
  assert.equal(record.kind, 'pdf');
  assert.equal(record.extractor, 'pdfjs-dist+RapidOCR');
  assert.equal(record.pages.length, 2);
  assert.ok(record.pages.every((page) => page.nativeText === ''));
  assert.match(record.pages[0].ocrText.toUpperCase(), /SAMPLE.*ONE/);
  assert.match(record.pages[1].ocrText.toUpperCase(), /SAMPLE.*TWO/);
  assert.ok(server.requests[0].payload.messages[1].content.includes('SAMPLE OCR PAGE ONE'));
  assert.ok(server.requests[0].payload.messages[1].content.includes('SAMPLE OCR PAGE TWO'));

  const blankImage = path.join(dir, 'blank.jpg');
  await writeFile(blankImage, makeBlankJpeg());
  const emptyTextResult = await cleanMaterial(
    { title: '无字图片', body: '用户补充的品牌描述', files: [blankImage] },
    { config: server.config, ocrPythonPath: python, ocrTimeoutMs: 300_000 },
  );
  assert.equal(emptyTextResult.fileResults[0].text, '');
  assert.deepEqual(emptyTextResult.fileResults[0].warnings, ['no_text']);
  assert.equal(emptyTextResult.summary, '根据内容生成的摘要');
});

test('missing OCR runtime fails explicitly and never calls the model', async (t) => {
  const dir = await temporaryDirectory();
  const file = path.join(dir, 'sample.png');
  await writeFile(file, makeJpeg('OCR SAMPLE'));
  const server = await fakeModel();
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    cleanMaterial(
      { title: 'scan', body: '', files: [file] },
      { config: server.config, ocrPythonPath: path.join(dir, 'missing-python') },
    ),
    (error) => error.code === 'OCR_RUNTIME_MISSING' && /Start\.command \/ Start\.cmd/.test(error.message) && /scripts\/prepare\.mjs/.test(error.message),
  );
  assert.equal(server.requests.length, 0);
});

test('original paths must be absolute and unsupported formats are explicit', async (t) => {
  await assert.rejects(
    cleanMaterial({ title: '', body: '', files: ['relative.pdf'] }, { config: { baseUrl: 'http://127.0.0.1', model: 'm', apiKey: 'k' } }),
    (error) => error.code === 'INVALID_INPUT',
  );
  const dir = await temporaryDirectory();
  const file = path.join(dir, 'unsupported.docx');
  await writeFile(file, 'bytes');
  const server = await fakeModel();
  t.after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    cleanMaterial({ title: '', body: '', files: [file] }, { config: server.config }),
    (error) => error.code === 'UNSUPPORTED_FILE_TYPE',
  );
  assert.equal(server.requests.length, 0);
});

test('accepts one complete JSON code block and rejects extra prose around results', async t => {
  const fenced = await fakeModel(() => ({choices:[{finish_reason:'stop',message:{content:'```json\n{"summary":"内容摘要","tags":["自由标签"]}\n```'}}]}));
  t.after(()=>fenced.close());
  const result=await cleanMaterial({title:'材料',body:'正文',files:[]},{config:fenced.config});
  assert.deepEqual(result.tags,['自由标签']);
  const prose=await fakeModel(()=>({choices:[{finish_reason:'stop',message:{content:'说明文字 {"summary":"摘要","tags":["标签"]}'}}]}));
  t.after(()=>prose.close());
  await assert.rejects(cleanMaterial({title:'材料',body:'正文',files:[]},{config:prose.config}),e=>e.code==='MODEL_OUTPUT_INVALID');
});
