import { execFileSync } from 'node:child_process';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAC_APP_NAME = 'Creative Agent Studio.app';

function platformOf(target) {
  if (typeof target === 'string') return target.startsWith('darwin-') ? 'darwin' : target.split('-')[0];
  return target?.platform;
}

export function resolveRuntimeRoot(stage, target) {
  const root = path.resolve(stage);
  return platformOf(target) === 'darwin'
    ? path.join(root, MAC_APP_NAME, 'Contents', 'Resources', 'studio')
    : root;
}

function nodeDirectoryName(target) {
  return path.posix.basename(path.posix.dirname(path.posix.dirname(target.nodeRelative)));
}

function assertCompiledLauncher(source, target) {
  const requiredParts = [
    '/Contents/Resources/studio',
    '/.studio-runtime/node/',
    nodeDirectoryName(target),
    '/bin/node',
    '/release/launcher.mjs',
  ];
  if (source.includes('__NODE_DIRECTORY__') || requiredParts.some(part => !source.includes(part))) {
    throw new Error('编译后的 macOS 图形启动器没有指向 app 内部随包 Node 与 launcher。');
  }
}

export async function verifyMacAppBundle(bundle, target) {
  const infoPlist = path.join(bundle, 'Contents/Info.plist');
  const compiledScript = path.join(bundle, 'Contents/Resources/Scripts/main.scpt');
  await access(infoPlist);
  await access(compiledScript);
  const source = execFileSync('osadecompile', [compiledScript], { encoding: 'utf8' });
  assertCompiledLauncher(source, target);
  return source;
}

export function verifyMacAppSeal(bundle) {
  execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
}

export function sealMacAppBundle(bundle) {
  // Sign only the outer app seal; --deep would rewrite bundled third-party code signatures.
  execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' });
  verifyMacAppSeal(bundle);
}

/** Move every staged payload item into the app so the .app remains complete when Gatekeeper relocates it. */
export async function moveMacPayloadIntoBundle(stage, bundle = path.join(stage, MAC_APP_NAME)) {
  const absoluteStage = path.resolve(stage);
  const absoluteBundle = path.resolve(bundle);
  if (path.dirname(absoluteBundle) !== absoluteStage || path.basename(absoluteBundle) !== MAC_APP_NAME) {
    throw new Error('macOS app bundle 必须是 staging 根目录下的 Creative Agent Studio.app。');
  }
  const runtimeRoot = path.join(absoluteBundle, 'Contents/Resources/studio');
  await mkdir(runtimeRoot, { recursive: true });
  // The old manifest describes the flat layout and cannot be carried into the app.
  await rm(path.join(absoluteStage, 'release-manifest.json'), { force: true });
  for (const entry of await readdir(absoluteStage, { withFileTypes: true })) {
    if (entry.name === MAC_APP_NAME) continue;
    await rename(path.join(absoluteStage, entry.name), path.join(runtimeRoot, entry.name));
  }
  return runtimeRoot;
}

export async function assembleMacApp(stage, target) {
  if (platformOf(target) !== 'darwin' || !target.nodeRelative) {
    throw new Error('macOS app 组装需要 darwin 目标及随包 Node 相对路径。');
  }
  const absoluteStage = path.resolve(stage);
  const bundle = path.join(absoluteStage, MAC_APP_NAME);
  const sourcePath = path.join(absoluteStage, 'release/macos-launcher.applescript');
  const source = await readFile(sourcePath, 'utf8');
  const marker = '__NODE_DIRECTORY__';
  if (!source.includes(marker)) throw new Error('macOS 启动脚本缺少 Node 目录占位符。');
  const compiledSource = path.join(absoluteStage, '.studio-runtime/macos-launcher.applescript');
  await mkdir(path.dirname(compiledSource), { recursive: true });
  await rm(bundle, { recursive: true, force: true });
  await writeFile(compiledSource, source.replaceAll(marker, nodeDirectoryName(target)));
  try {
    execFileSync('osacompile', ['-o', bundle, compiledSource], { stdio: 'pipe' });
    await verifyMacAppBundle(bundle, target);
  } catch (error) {
    throw new Error(`编译或检查 macOS 图形启动器失败：${error.message}`, { cause: error });
  } finally {
    await rm(compiledSource, { force: true });
  }
  return moveMacPayloadIntoBundle(absoluteStage, bundle);
}
