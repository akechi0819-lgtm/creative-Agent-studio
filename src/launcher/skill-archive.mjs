import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';

const SKILL_FILES = Object.freeze([
  ['creative-studio/SKILL.md', '.agents/skills/creative-studio/SKILL.md'],
  ['creative-studio/references/workbuddy-entry.md', '.agents/skills/creative-studio/references/workbuddy-entry.md'],
]);

/** Build the optional WorkBuddy skill package without copying product runtimes. */
export async function createSkillArchive(sourceRoot) {
  const inputs = new Map();
  for (const [archivePath, sourcePath] of SKILL_FILES) {
    inputs.set(archivePath, await readFile(path.join(sourceRoot, sourcePath)));
  }
  const entries = Object.fromEntries([...inputs].map(([name, contents]) => [
    name,
    [new Uint8Array(contents), { mtime: new Date('1980-01-01T00:00:00Z') }],
  ]));
  const archive = zipSync(entries, { level: 9 });
  const extracted = unzipSync(archive);
  if (Object.keys(extracted).sort().join('\0') !== [...inputs.keys()].sort().join('\0')) {
    throw new Error('Skill ZIP 解压后文件清单不完整。');
  }
  for (const [name, original] of inputs) {
    if (!Buffer.from(extracted[name]).equals(original)) throw new Error(`Skill ZIP 内容校验失败：${name}`);
  }
  return { archive, files: [...inputs.keys()] };
}
