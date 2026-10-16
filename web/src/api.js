const jsonHeaders = { 'content-type': 'application/json' };

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: options.body instanceof FormData
      ? options.headers
      : { ...jsonHeaders, ...options.headers },
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === 'string' ? body : body?.error?.message || `请求失败（${response.status}）`;
    const error = new Error(message);
    error.status = response.status;
    error.code = body?.error?.code || body?.code;
    error.details = body?.error?.details || body?.details;
    throw error;
  }
  return body;
}

const json = (method, value) => ({ method, body: JSON.stringify(value) });
const idPath = (id) => encodeURIComponent(id);

export const api = {
  bootstrap: () => request('/api/bootstrap'),
  task: (id) => request(`/api/tasks/${idPath(id)}`),
  createTask: (value) => request('/api/tasks', json('POST', value)),
  taskAction: (id, action, payload) => request(`/api/tasks/${idPath(id)}/${action}`, json('POST', payload)),
  setReferences: (id, payload) => request(`/api/tasks/${idPath(id)}/references`, json('POST', payload)),
  attachTaskFiles: (id, formData) => request(`/api/tasks/${idPath(id)}/attachments`, { method: 'POST', body: formData }),
  chat: (id, text, expectedRevision, requestId = crypto.randomUUID(), options = {}) => request(`/api/tasks/${idPath(id)}/chat`, json('POST', {
    text,
    expectedRevision,
    requestId,
    ...(typeof options.model === 'string' && options.model.trim() ? { model: options.model.trim() } : {}),
    ...(options.answers ? { answers: options.answers } : {}),
    ...(Array.isArray(options.attachmentSourceIds) && options.attachmentSourceIds.length ? { attachmentSourceIds: options.attachmentSourceIds } : {}),
  })),
  canvasOpen: (id) => request(`/api/tasks/${idPath(id)}/canvas/open`, json('POST', {})),
  reconcileCanvas: (id, payload) => request(`/api/tasks/${idPath(id)}/reconcile-canvas`, json('POST', payload)),
  job: (id) => request(`/api/jobs/${idPath(id)}`),
  cancelJob: (id) => request(`/api/jobs/${idPath(id)}`, { method: 'DELETE' }),

  assets: (filters = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value != null && String(value).trim()) query.set(key, String(value).trim());
    }
    return request(`/api/assets${query.size ? `?${query}` : ''}`);
  },
  asset: (id) => request(`/api/assets/${idPath(id)}`),
  importAssets: (formData) => request('/api/assets', { method: 'POST', body: formData }),
  importFolderAssets: (formData) => request('/api/assets/import-folder', { method: 'POST', body: formData }),
  cleanAsset: (id, payload) => request(`/api/assets/${idPath(id)}/clean`, json('POST', payload)),
  editAsset: (id, payload) => request(`/api/assets/${idPath(id)}`, json('PUT', payload)),
  confirmAsset: (id, payload) => request(`/api/assets/${idPath(id)}/confirm`, json('POST', payload)),
  replaceAssetFiles: (id, formData) => request(`/api/assets/${idPath(id)}/replace-files`, { method: 'POST', body: formData }),
  deleteAsset: (id, payload) => request(`/api/assets/${idPath(id)}`, json('DELETE', payload)),
  tags: () => request('/api/tags'),
  renameTag: (payload) => request('/api/tags/rename', json('POST', payload)),
  deleteTag: (payload) => request('/api/tags/delete', json('POST', payload)),

  dna: () => request('/api/dna'),
  saveDna: (payload) => request('/api/dna', json('POST', payload)),
  organizeDna: (payload) => request('/api/dna/organize', json('POST', payload)),

  config: () => request('/api/config'),
  saveConfig: (payload) => request('/api/config', json('POST', payload)),
  checkConfig: (payload) => request('/api/config/check', json('POST', payload)),
  models: (payload) => request('/api/config/models', json('POST', payload)),
  modelPlugin: () => request('/api/model-plugin'),
  loginModelPlugin: (payload) => request('/api/model-plugin/login', json('POST', payload)),
  logoutModelPlugin: (payload) => request('/api/model-plugin/logout', json('POST', payload)),
  cancelModelPlugin: () => request('/api/model-plugin/cancel', json('POST', {})),
};

export function jobFromResponse(value) {
  return value?.job && typeof value.job === 'object' ? value.job : null;
}

export function imageUrl(file) {
  return typeof file?.imageUrl === 'string' && file.imageUrl ? file.imageUrl : null;
}
