import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateCompanyServices(value) {
  const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).every(key => allowed.includes(key));
  if (!keys(value, ['schemaVersion', 'teedy', 'canvas']) || value.schemaVersion !== 1
    || !keys(value.teedy, ['baseUrl']) || !keys(value.canvas, ['webUrl'])) throw new Error('公司服务预配文件格式无效');
  function endpoint(text) {
    if (typeof text !== 'string' || text.length > 2000 || /\s/u.test(text)) throw new Error('公司服务预配地址无效');
    let url; try { url = new URL(text); } catch { throw new Error('公司服务预配地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('公司服务必须预配无凭据的远端 HTTPS 地址');
    return url.toString().replace(/\/$/u, '');
  }
  return { schemaVersion: 1, teedy: { baseUrl: endpoint(value.teedy.baseUrl) }, canvas: { webUrl: endpoint(value.canvas.webUrl) } };
}

export async function readCompanyDeployment({ file = process.env.STUDIO_COMPANY_SERVICES_FILE || fileURLToPath(new URL('../../company-services.json', import.meta.url)) } = {}) {
  try {
    const absolute = path.resolve(file);
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('公司服务预配文件必须是普通小型 JSON 文件');
    return { ...validateCompanyServices(JSON.parse(await fs.readFile(absolute, 'utf8'))), configured: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, configured: false, teedy: { baseUrl: '' }, canvas: { webUrl: '' } };
    throw new Error('公司服务预配文件无效，请联系管理员重新提供运行包');
  }
}
