import { browser } from 'wxt/browser';
import { SnapshotSchema } from '../storage/schema';

const errors: Record<string, string> = {
  CONFLICT: '配置已在其他窗口更新，请重新载入后再保存。',
  NOT_FOUND: '这份配置已被删除，请重新载入。',
  INVALID_REQUEST: '请检查地址、模型和必填信息。',
  CONFIG_UNAVAILABLE: '本机配置暂不可用，原有数据已保留。',
  FORBIDDEN: '请在 Sayvia 设置页操作。',
};

export async function settingsRequest(message: unknown) {
  const response: unknown = await browser.runtime.sendMessage(message);
  if (typeof response !== 'object' || response === null || !('ok' in response)) {
    throw new Error('配置连接暂不可用。');
  }
  if (!response.ok) {
    const code = 'error' in response && typeof response.error === 'string' ? response.error : '';
    throw new Error(errors[code] ?? '配置操作未完成，请重试。');
  }
  return SnapshotSchema.parse('data' in response ? response.data : undefined);
}
