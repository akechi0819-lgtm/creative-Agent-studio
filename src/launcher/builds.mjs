import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const rootInputs = ['package.json', 'package-lock.json'];

export const buildTargets = Object.freeze([
  {
    id: 'StudioWeb',
    cwd: '.',
    dependency: '.',
    npmArgs: ['run', 'web:build'],
    inputFiles: [...rootInputs, 'scripts/build-web.mjs', 'web/index.html'],
    inputDirs: [{ path: 'web/src' }, { path: 'web/public' }],
    output: {
      directory: 'web/dist',
      requiredFiles: ['web/dist/index.html', 'web/dist/assets/app.js'],
      primaryFiles: ['web/dist/index.html', 'web/dist/assets/app.js'],
      htmlEntry: 'web/dist/index.html',
      primaryAssetPrefix: 'assets/',
    },
  },
  {
    id: 'CanvasAgent',
    cwd: 'third_party/canvas/canvas-agent',
    dependency: 'third_party/canvas/canvas-agent',
    npmArgs: ['run', 'build'],
    inputFiles: [
      'third_party/canvas/canvas-agent/package.json',
      'third_party/canvas/canvas-agent/package-lock.json',
      'third_party/canvas/canvas-agent/tsconfig.json',
    ],
    inputDirs: [{ path: 'third_party/canvas/canvas-agent/src', extensions: ['.ts'], excludeSuffixes: ['.test.ts'] }],
    output: {
      directory: 'third_party/canvas/canvas-agent/dist',
      typescriptSources: 'third_party/canvas/canvas-agent/src',
      typescriptExcludeSuffixes: ['.test.ts', '.d.ts'],
      requiredFiles: [
        'third_party/canvas/canvas-agent/dist/index.js',
        'third_party/canvas/canvas-agent/dist/index.d.ts',
      ],
      primaryFiles: [
        'third_party/canvas/canvas-agent/dist/index.js',
        'third_party/canvas/canvas-agent/dist/index.d.ts',
      ],
    },
  },
  {
    id: 'CanvasWeb',
    cwd: 'third_party/canvas/web',
    dependency: 'third_party/canvas/web',
    npmArgs: ['run', 'build'],
    inputFiles: [
      'third_party/canvas/web/package.json',
      'third_party/canvas/web/package-lock.json',
      'third_party/canvas/web/index.html',
      'third_party/canvas/web/vite.config.ts',
      'third_party/canvas/web/tsconfig.json',
      'third_party/canvas/web/postcss.config.mjs',
      'third_party/canvas/VERSION',
      'third_party/canvas/CHANGELOG.md',
    ],
    inputDirs: [
      { path: 'third_party/canvas/web/src' },
      { path: 'third_party/canvas/web/public' },
    ],
    output: {
      directory: 'third_party/canvas/web/dist',
      requiredFiles: ['third_party/canvas/web/dist/index.html'],
      primaryFiles: ['third_party/canvas/web/dist/index.html'],
      htmlEntry: 'third_party/canvas/web/dist/index.html',
      requireScriptUnder: 'assets/',
      primaryAssetPrefix: 'assets/',
    },
  },
  {
    id: 'DSH',
    cwd: 'adapters/dsh',
    dependency: 'adapters/dsh',
    npmArgs: ['run', 'p0:client:build'],
    inputFiles: [
      'adapters/dsh/package.json',
      'adapters/dsh/package-lock.json',
      'scripts/dsh-p0-build-client.mjs',
    ],
    inputDirs: [{ path: 'adapters/dsh/client' }],
    output: {
      files: ['adapters/dsh/lib/client.js'],
      requiredFiles: ['adapters/dsh/lib/client.js'],
      primaryFiles: ['adapters/dsh/lib/client.js'],
    },
  },
  {
    id: 'WorkBuddy',
    cwd: '.',
    dependency: '.',
    nodeScript: 'scripts/build-workbuddy-plugin.mjs',
    inputFiles: [
      ...rootInputs,
      'scripts/build-workbuddy-plugin.mjs',
      'third_party/our-free-model/workbuddy/upstream-business.mjs',
    ],
    inputDirs: [],
    output: {
      files: ['third_party/our-free-model/workbuddy/runtime.mjs'],
      requiredFiles: ['third_party/our-free-model/workbuddy/runtime.mjs'],
      primaryFiles: ['third_party/our-free-model/workbuddy/runtime.mjs'],
    },
  },
]);

const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const toPosix = value => value.split(path.sep).join('/');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function ignoreDirectory(name) {
  return name === 'node_modules' || name === '.git';
}

async function walkFiles(root, relativeDirectory, output = []) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return output;
    throw error;
  }
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoreDirectory(entry.name)) await walkFiles(root, relative, output);
    } else if (entry.isFile()) {
      output.push(relative);
    }
  }
  return output;
}

function matchesInputDirectory(relativePath, directory) {
  const { extensions, excludeSuffixes = [] } = directory;
  if (excludeSuffixes.some(suffix => relativePath.endsWith(suffix))) return false;
  if (extensions?.length && !extensions.some(extension => relativePath.endsWith(extension))) return false;
  return true;
}

async function inputPaths(root, target) {
  const files = new Set(target.inputFiles ?? []);
  for (const directory of target.inputDirs ?? []) {
    const spec = typeof directory === 'string' ? { path: directory } : directory;
    const directoryPath = path.join(root, spec.path);
    const stat = await lstat(directoryPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isDirectory()) throw new Error(`${target.id} 构建输入目录不存在：${spec.path}`);
    for (const relativePath of await walkFiles(root, spec.path)) {
      if (matchesInputDirectory(toPosix(relativePath), spec)) files.add(toPosix(relativePath));
    }
  }

  const paths = [...files].map(toPosix).sort(comparePaths);
  for (const relativePath of paths) {
    const absolutePath = path.join(root, relativePath);
    const stat = await lstat(absolutePath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile()) throw new Error(`${target.id} 构建输入文件不存在：${relativePath}`);
  }
  return paths;
}

/** Capture only files consumed by the selected builder and its dependency group. */
export async function captureBuildInputs(root, target) {
  root = path.resolve(root);
  const paths = await inputPaths(root, target);
  const files = [];
  let latestInputMtime = null;
  for (const relativePath of paths) {
    const absolutePath = path.join(root, relativePath);
    const [content, stat] = await Promise.all([readFile(absolutePath), lstat(absolutePath)]);
    files.push({
      path: relativePath,
      sha256: sha256(content),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    latestInputMtime = latestInputMtime === null ? stat.mtimeMs : Math.max(latestInputMtime, stat.mtimeMs);
  }
  const fingerprint = sha256(JSON.stringify(files.map(({ path: filePath, sha256: digest }) => [filePath, digest])));
  return { targetId: target.id, files, fingerprint, latestInputMtime };
}

async function outputPaths(root, target) {
  if (target.output?.directory) return walkFiles(root, target.output.directory).then(paths => paths.map(toPosix));
  return [...(target.output?.files ?? [])].map(toPosix).sort(comparePaths);
}

function expectedTypeScriptOutputs(target, sourceFiles) {
  const outputDirectory = target.output.directory;
  const sourceDirectory = target.output.typescriptSources;
  const excluded = target.output.typescriptExcludeSuffixes ?? [];
  const sources = sourceFiles.filter(relativePath => (
    relativePath.startsWith(`${sourceDirectory}/`)
    && relativePath.endsWith('.ts')
    && !excluded.some(suffix => relativePath.endsWith(suffix))
  ));
  return sources.flatMap(sourcePath => {
    const suffix = sourcePath.slice(sourceDirectory.length + 1, -3);
    return [path.posix.join(outputDirectory, `${suffix}.js`), path.posix.join(outputDirectory, `${suffix}.d.ts`)];
  });
}

function htmlTagsAndReferences(html) {
  const references = [];
  const scripts = [];
  const tags = /<(script|link|img|source|video|audio|input|image|object)\b[^>]*>/gi;
  const attributes = /\b(src|href|poster|srcset|xlink:href|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const match of html.matchAll(tags)) {
    const tagName = match[1].toLowerCase();
    for (const attribute of match[0].matchAll(attributes)) {
      const attributeName = attribute[1].toLowerCase();
      const rawValue = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
      const values = attributeName === 'srcset' && !/^data:/i.test(rawValue)
        ? rawValue.split(',').map(candidate => candidate.trim().split(/\s+/)[0]).filter(Boolean)
        : [rawValue.trim()];
      for (const value of values) {
        references.push(value);
        if (tagName === 'script' && attributeName === 'src') scripts.push(value);
      }
    }
  }
  return { references, scripts };
}

function localReferencePath(entryPath, reference) {
  const value = reference.trim();
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return null;
  const clean = value.split(/[?#]/, 1)[0];
  if (!clean) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const relative = decoded.startsWith('/')
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), decoded));
  if (relative === '.' || relative === '' || path.posix.isAbsolute(relative)) return null;
  return relative;
}

async function outputInspectionFiles(root, paths) {
  const files = [];
  for (const relativePath of [...new Set(paths)].sort(comparePaths)) {
    const absolutePath = path.join(root, relativePath);
    const stat = await lstat(absolutePath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile()) continue;
    const content = await readFile(absolutePath);
    files.push({ path: relativePath, sha256: sha256(content), size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

/** Return hashes for every output file and verify the builder's required artifact closure. */
export async function inspectBuildOutputs(root, target) {
  root = path.resolve(root);
  const output = target.output ?? {};
  const paths = await outputPaths(root, target);
  const files = await outputInspectionFiles(root, paths);
  const fileByPath = new Map(files.map(file => [file.path, file]));
  const requiredFiles = [...(output.requiredFiles ?? [])].map(toPosix);
  const sourceFiles = await inputPaths(root, target);
  const typeScriptOutputs = output.typescriptSources
    ? expectedTypeScriptOutputs(target, sourceFiles)
    : [];
  requiredFiles.push(...typeScriptOutputs);
  const missing = requiredFiles.filter(relativePath => !fileByPath.has(relativePath));
  const reasons = [];
  if (!files.length) reasons.push('没有构建产物');
  if (missing.length) reasons.push(`缺少必要产物：${missing.slice(0, 5).join('、')}`);
  const emptyRequired = requiredFiles.filter(relativePath => fileByPath.get(relativePath)?.size === 0);
  if (emptyRequired.length) reasons.push(`必要产物为空：${emptyRequired.slice(0, 5).join('、')}`);

  let primaryPaths = [...(output.primaryFiles ?? [])].map(toPosix);
  if (output.htmlEntry && fileByPath.has(toPosix(output.htmlEntry))) {
    const entryPath = toPosix(output.htmlEntry);
    const html = await readFile(path.join(root, entryPath), 'utf8');
    const { references, scripts } = htmlTagsAndReferences(html);
    const missingReferences = [];
    const emptyReferences = [];
    const referencedAssets = [];
    for (const reference of references) {
      const relative = localReferencePath(path.posix.relative(output.directory, entryPath), reference);
      if (!relative) continue;
      const fullPath = path.posix.join(toPosix(output.directory), relative);
      if (!fileByPath.has(fullPath)) missingReferences.push(fullPath);
      else if (fileByPath.get(fullPath).size === 0) emptyReferences.push(fullPath);
      if (output.primaryAssetPrefix && relative.startsWith(output.primaryAssetPrefix)) referencedAssets.push(fullPath);
    }
    if (missingReferences.length) reasons.push(`HTML 引用的资源缺失：${[...new Set(missingReferences)].slice(0, 5).join('、')}`);
    if (emptyReferences.length) reasons.push(`HTML 引用的资源为空：${[...new Set(emptyReferences)].slice(0, 5).join('、')}`);
    if (output.requireScriptUnder) {
      const matchingScriptPaths = scripts
        .map(reference => localReferencePath(path.posix.relative(output.directory, entryPath), reference))
        .filter(relative => relative && relative.startsWith(output.requireScriptUnder) && /\.(?:js|mjs)$/i.test(relative))
        .map(relative => path.posix.join(toPosix(output.directory), relative));
      if (!matchingScriptPaths.length) reasons.push(`HTML 未引用 ${output.requireScriptUnder} 下的打包脚本`);
      primaryPaths.push(...matchingScriptPaths);
    }
    primaryPaths.push(...referencedAssets);
  } else if (output.htmlEntry) {
    reasons.push(`缺少 HTML 入口：${output.htmlEntry}`);
  }

  primaryPaths = [...new Set(primaryPaths)].map(toPosix);
  const primaryMtimes = primaryPaths.map(relativePath => fileByPath.get(relativePath)?.mtimeMs).filter(Number.isFinite);
  const earliestPrimaryMtime = primaryMtimes.length === primaryPaths.length && primaryMtimes.length
    ? Math.min(...primaryMtimes)
    : null;
  if (earliestPrimaryMtime === null && primaryPaths.length) reasons.push('主产物时间戳不可用');

  return {
    ready: reasons.length === 0,
    reason: reasons.join('；') || null,
    files,
    earliestPrimaryMtime,
  };
}

/** Legacy output may be adopted only when it is complete and no older than its inputs. */
export function canAdoptBuild(inputs, outputs) {
  return Boolean(
    outputs?.ready
    && Number.isFinite(inputs?.latestInputMtime)
    && Number.isFinite(outputs?.earliestPrimaryMtime)
    && outputs.earliestPrimaryMtime >= inputs.latestInputMtime,
  );
}
