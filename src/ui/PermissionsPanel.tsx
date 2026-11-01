import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
export function PermissionsPanel({
  busy,
  onClear,
}: {
  busy: boolean;
  onClear(revoke: boolean): void;
}) {
  const [origins, setOrigins] = useState<string[]>([]);
  const [site, setSite] = useState('');
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
  function grant() {
    try {
      const url = new URL(site);
      if (
        url.username ||
        url.password ||
        (url.protocol !== 'https:' &&
          !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
      )
        throw new Error();
      setPending(true);
      void browser.permissions
        .request({ origins: [`${url.protocol}//${url.hostname}/*`] })
        .then(
          async (granted) => {
            setMessage(
              granted ? `${url.hostname} 已获授权。` : '未获得授权，该网站的自动入口暂不可用。',
            );
            await refresh();
          },
          () => setMessage('授权未完成，请重试。'),
        )
        .finally(() => setPending(false));
    } catch {
      setMessage('请输入 HTTPS 网站地址；本地测试可使用 localhost 或 127.0.0.1。');
    }
  }
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
      <section className="settings-card">
        <h2>网站与 API 授权</h2>
        <p className="muted">
          授权按主机生效。相同主机可能同时用于网页和模型服务；撤销后会影响相应功能。
        </p>
        <label>
          网站地址
          <input
            type="url"
            value={site}
            placeholder="https://github.com"
            disabled={pending}
            onChange={(event) => {
              setSite(event.target.value);
              setMessage('');
            }}
          />
        </label>
        <button
          className="secondary"
          type="button"
          disabled={pending || busy || !site.trim()}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) grant();
          }}
        >
          授权此网站
        </button>
        <p className="field-help">授权后仍由你主动发起翻译。页面路径和端口不形成独立授权。</p>
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
            disabled={busy}
            onChange={(event) => setRevoke(event.target.checked)}
          />
          同时撤销已授权主机
        </label>
        <button
          type="button"
          className="danger-button"
          disabled={busy}
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
