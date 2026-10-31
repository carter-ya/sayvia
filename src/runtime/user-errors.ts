const messages: Record<string, string> = {
  CONFIG_REQUIRED: '请先在插件设置中保存模型和 API Key。',
  PERMISSION_DENIED: '请在插件设置中授权当前 API 主机。',
  AUTH_FAILED: 'API Key 验证未通过，请检查设置。',
  RATE_LIMITED: '服务暂时限流，请稍后手动重试。',
  QUOTA_EXCEEDED: '服务额度不足，请检查账户。',
  MODEL_UNAVAILABLE: '模型不可用，请检查模型名称。',
  NETWORK_ERROR: '网络请求失败，请检查连接后手动重试。',
  TIMEOUT: '翻译超时，请稍后手动重试。',
  CANCELED: '翻译已取消。',
  TASK_BUSY: '当前已有翻译正在处理，请等待或取消后再试。',
  CONTEXT_LOST: '翻译已中断，请重新选择原文。',
  SOURCE_CHANGED: '原稿已修改，仅可复制译文。',
  COMPOSING: '请先完成输入法组词，再进行操作。',
  UNSUPPORTED: '当前编辑框无法安全替换，请使用复制。',
  WRITE_REJECTED: '网页未接受此次替换，请复制译文后手动修改。',
  FORMAT_INVALID: '译文格式校验未通过，请手动重试。',
  UNSUPPORTED_RESPONSE: '服务返回的结果不受支持。',
  EMPTY_SOURCE: '请先输入或选择需要翻译的内容。',
  SOURCE_TOO_LONG: '原文超过 12,000 字符，请缩小范围。',
  SELECTION_LOST: '选区已变化，请重新选择原文。',
  UNSUPPORTED_SELECTION: '此选区暂不支持，请调整范围后重选。',
};
export function userError(error: unknown) {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return messages[code] ?? '操作未完成，请重新打开面板后重试。';
}
