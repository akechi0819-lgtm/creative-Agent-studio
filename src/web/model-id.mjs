const MODEL_ID = /^[A-Za-z0-9_][A-Za-z0-9._:/-]{0,199}$/;
const CREDENTIAL_ID = /(?:^|[^A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,})/i;
const CREDENTIAL_FIELD = /(?:^|[._:/-])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|authorization|bearer)(?:$|[._:/-])/i;

function invalidModelId() {
  const error = new Error('模型 ID 格式无效');
  error.code = 'ERR_MODEL_ID_INVALID';
  error.statusCode = 400;
  return error;
}

/** Validate a provider model identifier before it reaches jobs, storage, or DSH. */
export function validateModelId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200
    || value.trim() !== value || !MODEL_ID.test(value) || CREDENTIAL_ID.test(value) || CREDENTIAL_FIELD.test(value)) {
    throw invalidModelId();
  }
  return value;
}
