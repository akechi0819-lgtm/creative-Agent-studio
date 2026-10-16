import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';

const moduleRequire = createRequire(import.meta.url);
const NATIVE_RUNTIME_PROBES = new Set(['@napi-rs/canvas', 'canvas', 'sharp', 'esbuild']);

function ready(reason = 'locked dependency tree is ready') {
  return { ready: true, reason };
}

function notReady(reason) {
  return { ready: false, reason };
}

function npmCliCandidates(nodePath) {
  const directories = new Set([
    path.dirname(nodePath),
    path.dirname(process.execPath),
  ]);
  const candidates = [];
  for (const directory of directories) {
    if (process.platform === 'win32') {
      candidates.push(path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    } else {
      candidates.push(
        path.resolve(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
        path.resolve(directory, '../node_modules/npm/bin/npm-cli.js'),
      );
    }
  }
  return candidates;
}

function loadNpmInternals({ npmPath, nodePath }) {
  const npmCli = npmPath && path.basename(npmPath).toLowerCase() === 'npm-cli.js'
    ? path.resolve(npmPath)
    : npmCliCandidates(nodePath).find((candidate) => {
      try {
        moduleRequire('node:fs').accessSync(candidate);
        return true;
      } catch {
        return false;
      }
    });
  if (!npmCli) throw new Error('could not locate the npm CLI bundled with this Node runtime');

  const npmRequire = createRequire(npmCli);
  return {
    Arborist: npmRequire('@npmcli/arborist'),
    checkPlatform: npmRequire('npm-install-checks').checkPlatform,
  };
}

function platformExcluded(node, checkPlatform) {
  if (!node?.optional) return false;
  try {
    checkPlatform(node.package);
    return false;
  } catch (error) {
    return error?.code === 'EBADPLATFORM';
  }
}

function omittedByPlatformParent(node, virtualTree, actualTree, checkPlatform) {
  let location = node.location;
  while (location.includes('/node_modules/')) {
    location = location.slice(0, location.lastIndexOf('/node_modules/'));
    const ancestor = virtualTree.inventory.get(location);
    if (ancestor && !actualTree.inventory.has(location) && platformExcluded(ancestor, checkPlatform)) {
      return true;
    }
  }
  return false;
}

function packageMatchesLock(lockedNode, installedNode) {
  if (!installedNode) return false;
  if (lockedNode.name !== installedNode.name || lockedNode.version !== installedNode.version) return false;
  if (lockedNode.isLink !== installedNode.isLink) return false;
  if (lockedNode.isLink) return lockedNode.realpath === installedNode.realpath;

  // Arborist gets these values from npm's hidden node_modules lockfile when one
  // exists. Compare provenance when available, while allowing installations
  // created without that optional metadata file to be checked by their actual tree.
  return !(lockedNode.resolved && installedNode.resolved && lockedNode.resolved !== installedNode.resolved)
    && !(lockedNode.integrity && installedNode.integrity && lockedNode.integrity !== installedNode.integrity);
}

function edgeTargetMatches(lockedNode, installedNode, actualTree) {
  for (const [name, lockedEdge] of lockedNode.edgesOut) {
    if (lockedEdge.type === 'peer') continue;
    const installedEdge = installedNode.edgesOut.get(name);
    if (!lockedEdge.to) {
      if (!lockedEdge.optional && !lockedEdge.peerOptional && !installedEdge?.optional) {
        return `unresolved locked dependency ${name} from ${lockedNode.location || '.'}`;
      }
      continue;
    }

    const installedTarget = actualTree.inventory.get(lockedEdge.to.location);
    if (!installedTarget) {
      // Missing compatible packages are handled by the package inventory pass;
      // platform-excluded optional targets are intentionally absent on this host.
      continue;
    }
    if (!installedEdge?.to || installedEdge.to.location !== lockedEdge.to.location) {
      return `dependency ${name} from ${lockedNode.location || '.'} resolves outside the locked tree`;
    }
  }
  return null;
}

async function installedManifest(node) {
  const manifestPath = path.join(node.realpath ?? node.path, 'package.json');
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

function packageAssetCandidates(packageRoot, target, extensions = []) {
  if (typeof target !== 'string' || !target || target.includes('*')) return [];
  const base = path.resolve(packageRoot, target.startsWith('./') ? target : `./${target}`);
  if (base !== packageRoot && !base.startsWith(`${packageRoot}${path.sep}`)) return [];
  const candidates = [base];
  if (!path.extname(base)) {
    candidates.push(...extensions.map((extension) => `${base}${extension}`));
    candidates.push(...extensions.map((extension) => path.join(base, `index${extension}`)));
  }
  return [...new Set(candidates)];
}

async function hasPackageAsset(packageRoot, target, extensions = []) {
  for (const candidate of packageAssetCandidates(packageRoot, target, extensions)) {
    try {
      if ((await stat(candidate)).isFile()) return true;
    } catch {
      // Try the next declared-file resolution candidate.
    }
  }
  return false;
}

function hasRuntimeCondition(value) {
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return value.some(hasRuntimeCondition);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([condition, target]) => {
    if (!['default', 'import', 'require', 'node', 'node-addons'].includes(condition)) return false;
    return hasRuntimeCondition(target);
  });
}

function runtimeSpecifiers(packageName, packageJson) {
  const exportsField = packageJson.exports;
  if (exportsField !== undefined) {
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
      return hasRuntimeCondition(exportsField) ? [packageName] : [];
    }
    if (!exportsField || typeof exportsField !== 'object') return [];

    const keys = Object.keys(exportsField);
    const subpathMap = keys.some((key) => key.startsWith('.'));
    const rootExport = subpathMap ? exportsField['.'] : exportsField;
    return hasRuntimeCondition(rootExport) ? [packageName] : [];
  }

  if ((typeof packageJson.main === 'string' && packageJson.main.trim())
      || (typeof packageJson.module === 'string' && packageJson.module.trim())) {
    return [packageName];
  }
  // A types-only, stylesheet-only, or bin-only package does not expose a Node
  // runtime entry. Packages with no such declarations use Node's index fallback.
  if (packageJson.types || packageJson.typings || packageJson.style || packageJson.bin) return [];
  return [packageName];
}

function exportedAssets(exportsField, conditionName) {
  const targets = [];
  const visit = (value, conditional = false) => {
    if (typeof value === 'string') {
      if (conditional && value.startsWith('./') && !value.includes('*')) targets.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, conditional);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      visit(item, conditional || key === conditionName);
    }
  };
  visit(exportsField);
  return [...new Set(targets)];
}

async function verifyDeclaredAssets(packageRoot, packageJson, packageName) {
  const declared = [];
  for (const field of ['types', 'typings', 'style']) {
    if (typeof packageJson[field] === 'string') declared.push({ field, target: packageJson[field] });
  }
  if (packageJson.exports !== undefined) {
    const exportsField = packageJson.exports;
    const isSubpathMap = exportsField && typeof exportsField === 'object'
      && Object.keys(exportsField).some((key) => key.startsWith('.'));
    const rootExport = isSubpathMap ? exportsField['.'] : exportsField;
    for (const field of ['types', 'typings', 'style']) {
      for (const target of exportedAssets(rootExport, field)) declared.push({ field, target });
    }
  }
  for (const { field, target } of declared) {
    const extensions = field === 'style' ? [] : ['.d.ts', '.d.mts', '.d.cts'];
    if (!await hasPackageAsset(packageRoot, target, extensions)) {
      return `root dependency ${packageName} is missing its declared ${field} entry`;
    }
  }
  return null;
}

async function verifyDirectEntrypoints(lockedRoot, actualTree, checkPlatform) {
  const requiredRuntimeSpecifiers = [];
  for (const edge of lockedRoot.edgesOut.values()) {
    if (edge.type === 'peer') continue;
    if (!edge.to) {
      if (edge.optional || edge.peerOptional) continue;
      return { failure: `root dependency ${edge.name} has no locked target` };
    }
    const installedNode = actualTree.inventory.get(edge.to.location);
    if (!installedNode) {
      if (platformExcluded(edge.to, checkPlatform)) continue;
      return { failure: `root dependency ${edge.name} is missing` };
    }
    let packageJson;
    try {
      packageJson = await installedManifest(installedNode);
    } catch {
      return { failure: `root dependency ${edge.name} is missing its package manifest` };
    }

    const packageRoot = path.resolve(installedNode.realpath ?? installedNode.path);
    const assetsFailure = await verifyDeclaredAssets(packageRoot, packageJson, edge.name);
    if (assetsFailure) return { failure: assetsFailure };

    const bins = typeof packageJson.bin === 'string'
      ? [packageJson.bin]
      : Object.values(packageJson.bin ?? {});
    for (const bin of bins) {
      if (!await hasPackageAsset(packageRoot, bin)) {
        return { failure: `root dependency ${edge.name} is missing its declared bin entry` };
      }
    }
    requiredRuntimeSpecifiers.push(...runtimeSpecifiers(edge.name, packageJson));
  }
  return { runtimeSpecifiers: [...new Set(requiredRuntimeSpecifiers)] };
}

function verifyNodeRuntimeEntries({ nodePath, cwd, specifiers }) {
  if (!specifiers.length) return null;
  const resolverProbe = String.raw`
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { statSync } from 'node:fs';
const specs = JSON.parse(process.env.STUDIO_DEPENDENCY_RUNTIME_SPECS || '[]');
const requireFromRoot = createRequire(pathToFileURL(process.cwd() + '/package.json'));
for (const specifier of specs) {
  const resolved = new Set();
  try { resolved.add(import.meta.resolve(specifier)); } catch {}
  try { resolved.add(pathToFileURL(requireFromRoot.resolve(specifier)).href); } catch {}
  if (resolved.size === 0) throw new Error('Node cannot resolve runtime entry for ' + specifier);
  for (const url of resolved) {
    if (!url.startsWith('file:')) throw new Error('Node resolved a non-file runtime entry for ' + specifier);
    let file;
    try { file = url.startsWith('file:///') || url.startsWith('file://') ? fileURLToPath(url) : url; }
    catch { throw new Error('Node resolved an invalid runtime entry for ' + specifier); }
    try { if (!statSync(file).isFile()) throw new Error(); }
    catch { throw new Error('Node runtime entry is missing for ' + specifier); }
  }
}
`;
  const result = spawnSync(nodePath, ['--input-type=module', '--eval', resolverProbe], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, STUDIO_DEPENDENCY_RUNTIME_SPECS: JSON.stringify(specifiers) },
  });
  if (result.error || result.status !== 0) {
    const detail = result.stderr?.match(/Error: ([^\n]+)/)?.[1];
    return detail || 'Node could not resolve a locked runtime entry';
  }
  return null;
}

async function nativeModuleEntries(actualTree) {
  const entries = [];
  for (const node of actualTree.inventory.values()) {
    if (node.isRoot || node.isLink || !NATIVE_RUNTIME_PROBES.has(node.name)) continue;
    let packageJson;
    try {
      packageJson = await installedManifest(node);
    } catch {
      continue;
    }
    const requireFromPackage = createRequire(path.join(node.realpath ?? node.path, 'package.json'));
    let entry;
    try {
      entry = requireFromPackage.resolve('.');
    } catch {
      const candidate = packageJson.module ?? packageJson.main;
      if (typeof candidate === 'string') entry = path.resolve(node.realpath ?? node.path, candidate);
    }
    if (entry) entries.push({ name: node.name, entry, path: node.realpath ?? node.path });
  }
  return entries;
}

async function esbuildBinaries(actualTree) {
  const bins = [];
  for (const node of actualTree.inventory.values()) {
    if (node.isRoot || node.isLink || node.name !== 'esbuild' || node.location !== 'node_modules/esbuild') continue;
    let packageJson;
    try {
      packageJson = await installedManifest(node);
    } catch {
      continue;
    }
    const bin = typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin?.esbuild;
    if (typeof bin === 'string') bins.push(path.resolve(node.realpath ?? node.path, bin));
  }
  return bins;
}

function runRuntimeProbes({ nodePath, cwd, nativeEntries, esbuildPaths }) {
  if (!nativeEntries.length && !esbuildPaths.length) return null;
  const nativeProbe = String.raw`
import { pathToFileURL } from 'node:url';
const entries = JSON.parse(process.env.STUDIO_DEPENDENCY_NATIVE_ENTRIES || '[]');
for (const entry of entries) {
  const module = await import(pathToFileURL(entry.entry).href);
  if (entry.name === '@napi-rs/canvas') {
    const createCanvas = module.createCanvas ?? module.default?.createCanvas;
    if (typeof createCanvas !== 'function') throw new Error('canvas API unavailable');
    const context = createCanvas(1, 1).getContext('2d');
    context.fillRect(0, 0, 1, 1);
    context.getImageData(0, 0, 1, 1);
  }
  if (entry.name === 'esbuild') {
    const transformSync = module.transformSync ?? module.default?.transformSync;
    if (typeof transformSync !== 'function') throw new Error('esbuild transformSync API unavailable');
    const result = transformSync('const x=1');
    if (!result.code?.includes('const x')) throw new Error('esbuild transformSync returned invalid output');
  }
}
`;
  const native = spawnSync(nodePath, ['--input-type=module', '--eval', nativeProbe], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...process.env, STUDIO_DEPENDENCY_NATIVE_ENTRIES: JSON.stringify(nativeEntries) },
  });
  if (native.error || native.status !== 0) {
    const names = nativeEntries.map((entry) => entry.name).join(', ');
    return `native runtime probe failed for ${names || 'a locked native dependency'}`;
  }

  for (const binary of esbuildPaths) {
    const executable = process.platform === 'win32' ? `${binary}.exe` : binary;
    const result = spawnSync(executable, ['--version'], {
      cwd,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return 'the locked esbuild executable is unavailable';
  }
  return null;
}

/** Read-only readiness check for one npm lockfile group. */
export async function checkDependencyGroup({ cwd, root, nodePath = process.execPath, npmPath } = {}) {
  const dependencyRoot = path.resolve(cwd ?? root ?? process.cwd());
  nodePath = path.resolve(nodePath);

  try {
    const [packageJson, lockfile] = await Promise.all([
      readFile(path.join(dependencyRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(dependencyRoot, 'package-lock.json'), 'utf8').then(JSON.parse),
    ]);
    if (lockfile.lockfileVersion !== 3) {
      return { ...notReady('package-lock.json must use lockfileVersion 3'), repairable: false };
    }
    const modulesPath = path.join(dependencyRoot, 'node_modules');
    const modulesStat = await stat(modulesPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!modulesStat?.isDirectory()) return notReady('node_modules is missing');

    const { Arborist, checkPlatform } = loadNpmInternals({ npmPath, nodePath });
    const virtualTree = await new Arborist({ path: dependencyRoot }).loadVirtual();
    const actualTree = await new Arborist({ path: dependencyRoot }).loadActual();
    const lockedRoot = virtualTree.inventory.get('');
    const installedRoot = actualTree.inventory.get('');
    if (!lockedRoot || !installedRoot) return notReady('npm could not load both lock and installed roots');
    if (lockedRoot.version !== installedRoot.version) return notReady('installed project root does not match package.json');

    for (const lockedNode of virtualTree.inventory.values()) {
      if (lockedNode.isRoot) continue;
      const installedNode = actualTree.inventory.get(lockedNode.location);
      if (!installedNode) {
        if (platformExcluded(lockedNode, checkPlatform)
            || omittedByPlatformParent(lockedNode, virtualTree, actualTree, checkPlatform)) {
          continue;
        }
        return notReady(`locked package is missing: ${lockedNode.name}@${lockedNode.version}`);
      }
      if (!packageMatchesLock(lockedNode, installedNode)) {
        return notReady(`installed package does not match the lock: ${lockedNode.name}@${lockedNode.version}`);
      }
      const edgeFailure = edgeTargetMatches(lockedNode, installedNode, actualTree);
      if (edgeFailure) return notReady(edgeFailure);
    }

    const entrypoints = await verifyDirectEntrypoints(lockedRoot, actualTree, checkPlatform);
    if (entrypoints.failure) return notReady(entrypoints.failure);
    const runtimeEntryFailure = verifyNodeRuntimeEntries({
      nodePath,
      cwd: dependencyRoot,
      specifiers: entrypoints.runtimeSpecifiers,
    });
    if (runtimeEntryFailure) return notReady(runtimeEntryFailure);

    const probeFailure = runRuntimeProbes({
      nodePath,
      cwd: dependencyRoot,
      nativeEntries: await nativeModuleEntries(actualTree),
      esbuildPaths: await esbuildBinaries(actualTree),
    });
    if (probeFailure) return notReady(probeFailure);

    return ready();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...notReady(`could not verify the locked npm dependency tree: ${detail}`), repairable: false };
  }
}
