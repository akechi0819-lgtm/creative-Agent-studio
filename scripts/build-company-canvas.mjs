#!/usr/bin/env node

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'third_party', 'canvas', 'web');
const runtimeRoot = join(root, '.studio-runtime', 'company-canvas');
const outputRoot = join(runtimeRoot, 'web');
const zipPath = join(runtimeRoot, 'company-canvas-remote.zip');
const readmePath = join(runtimeRoot, 'README.md');
const viteEntry = join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js');

const readme = `# Creative Agent Studio 公司版 Canvas 静态构建

此包是公司版远端 Canvas 的静态前端，基于随仓库维护的 \`third_party/canvas/web\` 源码构建。它使用浏览器 IndexedDB 保存画布数据，沿用数据库 \`infinite-canvas\` 和上游 store 名称。

## 更新部署

1. 解压 \`company-canvas-remote.zip\`。
2. 将压缩包内 \`web/\` 的全部内容上传到远端静态站点根目录。
3. 站点必须通过 HTTPS 提供，并为前端路由配置 SPA 回退：未知页面路径返回 \`index.html\`，静态资源仍按原路径返回。
4. 在本机工作台“公司连接”中填写该 HTTPS 站点地址，任务工具桥接会自动只允许该站点的准确 Origin（协议和主机/端口）。
5. 更新仅替换 Canvas 前端资源；保留现有 Teedy 的反向代理站点、容器外部网络、数据卷及员工权限。不要用本包覆盖整份 Caddy／Compose 配置。

## 数据与接口

- 这是浏览器前端，不是多人协作服务或服务端数据库。画布数据保存在访问该 Origin 的浏览器 IndexedDB 中；换浏览器、浏览器配置文件或 Origin 后数据相互隔离。
- 本构建与静态 ZIP 均不包含公司模型 API 密钥，也不提供 Canvas bridge。生图 API 配置由使用者在远端 Canvas 本人的浏览器中填写，并保存在该浏览器本地；不会发送给静态站点或同步到其他员工浏览器。图像模型 API 的跨域规则、代理与访问策略由原模型服务端处理。
- 公司 bridge 的连接票据只用于短时浏览器授权。静态站点应使用 HTTPS；不要把 bridge token、连接票据或 API 密钥写进部署环境变量、文件或日志。
- 静态部署不会启动本地 Canvas Web 服务，也不会建立共享数据库。

## 构建来源

使用仓库根目录的 \`node scripts/build-company-canvas.mjs\`。该脚本选择 remote build profile，并输出 \`.studio-runtime/company-canvas/web/\`、\`.studio-runtime/company-canvas/README.md\` 和 \`.studio-runtime/company-canvas/company-canvas-remote.zip\`。运行前需要已准备的 \`third_party/canvas/web/node_modules\`；脚本不会安装或更新依赖。
`;

async function collectFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await collectFiles(absolutePath));
        else if (entry.isFile()) files.push(absolutePath);
    }
    return files;
}

async function build() {
    try {
        await stat(viteEntry);
    } catch {
        throw new Error('Canvas Web dependencies are not prepared. Run the repository setup first; this script never runs npm install.');
    }

    await mkdir(runtimeRoot, { recursive: true });
    await rm(outputRoot, { recursive: true, force: true });
    await rm(zipPath, { force: true });
    await rm(readmePath, { force: true });

    const childEnv = { ...process.env, VITE_STUDIO_CANVAS_DEPLOYMENT: 'remote', VITE_BASE: '/' };
    // Keep the build profile explicit and avoid inheriting credentials or arbitrary VITE_ values.
    for (const name of Object.keys(childEnv)) {
        if (name.startsWith('VITE_') && name !== 'VITE_STUDIO_CANVAS_DEPLOYMENT' && name !== 'VITE_BASE') {
            delete childEnv[name];
        }
    }

    const result = spawnSync(process.execPath, [viteEntry, 'build', '--outDir', outputRoot, '--emptyOutDir'], {
        cwd: webRoot,
        env: childEnv,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Remote Canvas build failed with exit code ${result.status ?? 'unknown'}.`);

    await writeFile(readmePath, readme, { mode: 0o600 });
    const zipEntries = {
        'README.md': new TextEncoder().encode(readme),
        'LICENSES/Infinite-Canvas-MIT.txt': new Uint8Array(await readFile(join(root, 'third_party', 'canvas', 'LICENSE'))),
    };
    for (const filePath of await collectFiles(outputRoot)) {
        const archivePath = `web/${relative(outputRoot, filePath).split(sep).join('/')}`;
        zipEntries[archivePath] = new Uint8Array(await readFile(filePath));
    }
    const manifest = Object.entries(zipEntries).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
    zipEntries['manifest.json'] = new TextEncoder().encode(JSON.stringify({ deployment: 'remote', files: manifest }, null, 2));
    const archive = zipSync(zipEntries, { level: 6 });
    await writeFile(zipPath, archive, { mode: 0o600 });
    await writeFile(`${zipPath}.sha256`, `${createHash('sha256').update(archive).digest('hex')}  company-canvas-remote.zip\n`, { mode: 0o600 });

    console.log(`Remote Canvas files: ${outputRoot}`);
    console.log(`Deployment README: ${readmePath}`);
    console.log(`Static update archive: ${zipPath}`);
}

build().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Remote Canvas build failed.');
    process.exitCode = 1;
});
