import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const files=['package-lock.json','third_party/canvas/web/package-lock.json','third_party/canvas/canvas-agent/package-lock.json','adapters/dsh/package-lock.json'];
const manifests=[];
for(const file of files) {
  const bytes=await readFile(file);
  const lock=JSON.parse(bytes);
  const deps={...lock.packages[''].dependencies,...lock.packages[''].devDependencies};
  manifests.push({file,sha256:createHash('sha256').update(bytes).digest('hex'),directDependencies:Object.fromEntries(Object.keys(deps).map(name=>[name,{requested:deps[name],version:lock.packages['node_modules/'+name]?.version,integrity:lock.packages['node_modules/'+name]?.integrity}]))});
}
await writeFile('docs/固定依赖清单.json',JSON.stringify({node:'^22.19.0 || >=24',testedNode:process.version,manifests},null,2));
console.log('Fixed dependency manifest written');
