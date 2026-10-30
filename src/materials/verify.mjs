import { createCompanyMaterials } from './client.mjs';
import { readMaterialConfig } from './config.mjs';

function failure(error, status) {
  if (error?.code === 'ERR_COMPANY_TEEDY_LOGIN') return { failedStage: 'login', failureCode: 'login_failed' };
  if (error?.code === 'ERR_MATERIAL_CONFIG_INVALID' || error?.code === 'ERR_MATERIAL_CONFIG_CORRUPT'
    || error?.code === 'ERR_COMPANY_TEEDY_CONFIG') return { failedStage: 'config', failureCode: 'config_invalid' };
  if (status.queryVerified) return { failedStage: 'download', failureCode: 'download_failed' };
  if (status.authenticated) return { failedStage: 'query', failureCode: 'query_failed' };
  return { failedStage: 'login', failureCode: 'login_failed' };
}

/** Verify a real read-only query and a non-empty Teedy attachment without saving its bytes. */
export async function verifyMaterials(input, { root, fetchImpl = globalThis.fetch } = {}) {
  const status = {
    authenticated: false,
    queryVerified: false,
    downloadVerified: false,
    bytes: 0,
    sha256: '',
    failedStage: null,
    failureCode: null,
  };
  try {
    const config = input ?? await readMaterialConfig({ root });
    if (!config) {
      status.failedStage = 'config';
      status.failureCode = 'config_invalid';
      return status;
    }
    const client = createCompanyMaterials({
      root,
      fetchImpl,
      onAuthenticated() { status.authenticated = true; },
      readConfig: async () => ({ teedy: {
        baseUrl: config.baseUrl,
        username: config.username,
        password: config.password,
      } }),
    });
    const result = await client.findDownloadable();
    status.queryVerified = result.queryVerified;
    if (!result.candidate) {
      status.failedStage = 'download';
      status.failureCode = 'no_small_image';
      return status;
    }
    const original = await client.download(result.candidate.fileId);
    status.bytes = original.bytes.length;
    if (status.bytes === 0) {
      status.failedStage = 'download';
      status.failureCode = 'empty_download';
      return status;
    }
    status.downloadVerified = true;
    status.sha256 = original.sha256;
    return status;
  } catch (error) {
    Object.assign(status, failure(error, status));
    return status;
  }
}
