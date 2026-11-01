import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { SitePanel } from './SitePanel';
import type { ConfigSnapshot } from '../storage/schema';
export function PermissionsPanel({
  busy,
  snapshot,
  onSnapshot,
  onClear,
}: {
  busy: boolean;
  snapshot: ConfigSnapshot;
  onSnapshot(next: ConfigSnapshot): void;
  onClear(revoke: boolean): void;
}) {
  const [origins, setOrigins] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [revoke, setRevoke] = useState(true);
  async function refresh() {
    try {
      setOrigins((await browser.permissions.getAll()).origins ?? []);
    } catch {
      setMessage('暂时无法读取授权，请在 Chrome 扩展详情中检查。');
    }
  }
  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    browser.permissions.onAdded.addListener(changed);
    browser.permissions.onRemoved.addListener(changed);
    return () => {
      browser.permissions.onAdded.removeListener(changed);
      browser.permissions.onRemoved.removeListener(changed);
    };
  }, []);
  async function remove(origin: string) {
    setPending(true);
    try {
      const removed = await browser.permissions.remove({ origins: [origin] });
      setMessage(
        removed
          ? '已撤销授权，相关进行中任务将取消。'
          : '此授权暂不能撤销，请在 Chrome 扩展详情中检查。',
      );
      await refresh();
    } catch {
      setMessage('撤销未完成，请重试。');
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <SitePanel snapshot={snapshot} busy={busy} onSnapshot={onSnapshot} />
      <section className="settings-card">
        <h2>网站与 API 授权</h2>
        <p className="muted">
          授权按主机生效。相同主机可能同时用于网页和模型服务；撤销后会影响相应功能。
        </p>
        <ul className="permission-list">
          {origins.map((origin) => (
            <li key={origin}>
              <code>{origin}</code>
              <button
                className="text-button"
                disabled={busy || pending}
                type="button"
                aria-label={`撤销 ${origin}`}
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted) void remove(origin);
                }}
              >
                撤销
              </button>
            </li>
          ))}
        </ul>
        {!origins.length && (
          <p className="empty-note">尚未授予长期主机权限。工具栏点击仍可临时开启当前页翻译。</p>
        )}
        {message && (
          <p role="note" className="notice">
            {message}
          </p>
        )}
      </section>
      <section className="settings-card danger-card">
        <span className="eyebrow">本机数据</span>
        <h2>清除后，从头开始</h2>
        <p className="muted">
          删除所有模型配置、API Key、偏好、会话草稿和译文，并取消进行中的任务。之后需要重新配置。
        </p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={revoke}
            disabled={busy || pending}
            onChange={(event) => setRevoke(event.target.checked)}
          />
          同时撤销已授权主机
        </label>
        <button
          type="button"
          className="danger-button"
          disabled={busy || pending}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) onClear(revoke);
          }}
        >
          清除全部本地数据
        </button>
      </section>
    </>
  );
}
