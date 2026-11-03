import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CaptureSettingsSchema } from '../runtime/caption-protocol';
import type { CaptureSettings } from '../background/caption-access';

export function CaptionsSettings({ revision }: { revision: number }) {
  const [state, setState] = useState<CaptureSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function request(enabled?: boolean) {
    const reply: unknown = await browser.runtime.sendMessage({
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      type: enabled === undefined ? 'captions.settings.read' : 'captions.settings.set',
      ...(enabled === undefined ? {} : { enabled }),
    });
    if (
      !reply ||
      typeof reply !== 'object' ||
      !('ok' in reply) ||
      reply.ok !== true ||
      !('data' in reply)
    )
      throw new Error('字幕设置暂不可用，请重试。');
    return CaptureSettingsSchema.parse(reply.data);
  }
  useEffect(() => {
    let active = true;
    void request().then(
      (next) => {
        if (active) {
          setState(next);
          setError('');
        }
      },
      () => {
        if (active) setError('字幕设置暂不可用，请重试。');
      },
    );
    return () => {
      active = false;
    };
  }, [revision]);
  async function change(enabled: boolean) {
    setBusy(true);
    setError('');
    setState((current) => (current ? { ...current, desiredEnabled: enabled } : current));
    try {
      setState(await request(enabled));
    } catch {
      setError('字幕设置暂不可用，请重试。');
    } finally {
      setBusy(false);
    }
  }
  async function retry() {
    if (state) return change(state.desiredEnabled);
    setBusy(true);
    setError('');
    try {
      setState(await request());
    } catch {
      setError('字幕设置暂不可用，请重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section" aria-label="YouTube 字幕">
      <h2>YouTube 字幕</h2>
      <p>开启后，在 YouTube 页面内临时读取播放器已加载的字幕。字幕不会保存到磁盘。</p>
      <p>
        只有在视频页面主动开启翻译，才会将当前视频的字幕分批发送给所选模型。切换视频后需重新开启。
      </p>
      <label>
        <input
          type="checkbox"
          checked={state?.desiredEnabled ?? false}
          disabled={busy || !state}
          onChange={(event) => void change(event.target.checked)}
        />
        允许在 YouTube 读取字幕
      </label>
      <p aria-live="polite" aria-label="字幕设置状态">
        {busy
          ? '正在更新字幕设置…'
          : error ||
            (state?.error
              ? '设置未完成，字幕读取尚未就绪。请确认 Chrome 已允许 Sayvia 访问 YouTube 后重试。'
              : state?.registered
                ? '字幕读取已开启。已打开的视频可能需要刷新后读取。'
                : state
                  ? '字幕读取已关闭。'
                  : '正在读取设置…')}
      </p>
      {state && state.unconfirmedDocuments > 0 && (
        <p>有 {state.unconfirmedDocuments} 个页面尚未确认状态。请恢复或刷新这些页面后核对。</p>
      )}
      {(error || state?.error || !!state?.unconfirmedDocuments) && (
        <button type="button" disabled={busy} onClick={() => void retry()}>
          重试字幕设置
        </button>
      )}
    </section>
  );
}
