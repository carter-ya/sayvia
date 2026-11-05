// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('wxt/browser', () => ({ browser: { runtime: { sendMessage: send } } }));
import { CaptionsSettings } from '../../src/ui/CaptionsSettings';
it('retries a failed initial read without mutating an unknown saved capture preference', async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  send.mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValueOnce({
    ok: true,
    data: { desiredEnabled: true, registered: true, error: false, unconfirmedDocuments: 0 },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(CaptionsSettings, { revision: 0 })));
    expect(container.textContent).toContain('字幕设置暂不可用');
    await act(async () => container.querySelector('button')!.click());
    expect(send.mock.calls.map(([message]) => message.type)).toEqual([
      'captions.settings.read',
      'captions.settings.read',
    ]);
    expect(container.querySelector('input')!.checked).toBe(true);
    expect(container.textContent).toContain('字幕读取已开启');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
