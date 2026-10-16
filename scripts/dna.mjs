import fs from 'node:fs/promises';
import { readDna, saveDna, unlockDna, DNA_TEMPLATE } from '../src/dna/profile.mjs';
try {
  const [action, input, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error();
  let result;
  if (action === 'show' && !input) result = await readDna();
  else if (action === 'template' && !input) result = {template:DNA_TEMPLATE};
  else if (action === 'save' && input?.startsWith('@')) result = await saveDna(JSON.parse(await fs.readFile(input.slice(1), 'utf8')));
  else if (action === 'unlock' && input?.startsWith('@')) result = await unlockDna(JSON.parse(await fs.readFile(input.slice(1), 'utf8')));
  else throw new Error();
  console.log(JSON.stringify(result, null, 2));
} catch { console.error('DNA 操作未完成；请核对输入、人工保存依据及版本。'); process.exitCode = 1; }
