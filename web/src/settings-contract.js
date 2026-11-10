export function videoChannelForSave(video, { savedApiKeyConfigured = false, clearKey = false } = {}) {
  const baseUrl = typeof video?.baseUrl === 'string' ? video.baseUrl : '';
  const apiKey = typeof video?.apiKey === 'string' ? video.apiKey : '';
  const retainedKey = savedApiKeyConfigured && !clearKey && !apiKey.trim();
  const hasKey = Boolean(apiKey.trim() || retainedKey);
  if (hasKey && !baseUrl.trim()) throw new Error('保留或填写视频 API Key 时，必须同时填写视频服务地址。');
  return {
    ...video,
    model: baseUrl.trim() || hasKey ? 'minimax_h3' : '',
    apiFormat: 'openai',
  };
}
