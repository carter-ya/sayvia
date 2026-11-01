import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { SitesView, siteOrigin } from '../runtime/site-access';
import { SnapshotSchema, type ConfigSnapshot } from '../storage/schema';

export function SitePanel({
  snapshot,
  busy,
  onSnapshot,
}: {
  snapshot: ConfigSnapshot;
  busy: boolean;
  onSnapshot(next: ConfigSnapshot): void;
}) {
  const [site, setSite] = useState('');
  const [sites, setSites] = useState<{ origin: string; active: boolean }[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function request(message: unknown) {
    const reply = (await browser.runtime.sendMessage(message)) as {
      ok?: boolean;
      error?: string;
      data?: unknown;
      config?: unknown;
    };
    if (!reply?.ok)
      throw new Error(
        reply?.error === 'CONFLICT'
          ? '设置已在其他窗口修改，请重新载入后重试。'
          : '网站入口未能更新，请重新载入后检查启用状态。',
      );
    setSites(SitesView.parse(reply.data).sites);
    onSnapshot(SnapshotSchema.parse(reply.config));
  }
  useEffect(() => {
    const refresh = () => {
      void request({ type: 'settings.sites.read' }).catch(() =>
        setMessage('暂时无法读取网站入口，请重新载入。'),
      );
    };
    refresh();
    browser.permissions.onRemoved.addListener(refresh);
    return () => browser.permissions.onRemoved.removeListener(refresh);
  }, [snapshot.revision]);
  function enable(value: string) {
    let origin: string;
    try {
      origin = siteOrigin(value);
    } catch {
      setMessage('请输入 HTTPS 网站地址；本地测试可使用 localhost 或 127.0.0.1。');
      return;
    }
    setPending(true);
    setMessage('');
    // Keep request directly inside the trusted click, before any await.
    void browser.permissions
      .request({ origins: [`${origin}/*`] })
      .catch(() => {
        throw new Error('授权未完成，请重试。');
      })
      .then(async (granted) => {
        if (!granted) {
          setMessage('未获得授权，该网站的自动入口暂不可用。');
          return;
        }
        await request({
          type: 'settings.sites.set',
          payload: { origin, enabled: true, expectedRevision: snapshot.revision },
        });
        setMessage('已启用网站入口。选中文字后，点击页面内的 Sayvia 图标翻译。');
        setSite('');
      })
      .catch((error) => setMessage(error instanceof Error ? error.message : '授权未完成，请重试。'))
      .finally(() => setPending(false));
  }
  async function disable(origin: string) {
    setPending(true);
    try {
      await request({
        type: 'settings.sites.set',
        payload: { origin, enabled: false, expectedRevision: snapshot.revision },
      });
      setMessage('已停用网站自动入口，模型 API 主机权限保留。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '停用未完成。');
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="settings-card">
      <span className="eyebrow">在页面内翻译</span>
      <h2>选中，点击，就能读懂</h2>
      <p className="muted">
        只在你启用的网站显示选区入口。选中文字不会调用模型，点击翻译才会发送所选内容。
      </p>
      <div className="actions">
        {['https://github.com', 'https://www.producthunt.com'].map((origin) => (
          <button
            key={origin}
            type="button"
            className="secondary"
            disabled={
              busy || pending || sites.some((item) => item.origin === origin && item.active)
            }
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) enable(origin);
            }}
          >
            启用 {new URL(origin).hostname}
          </button>
        ))}
      </div>
      <label>
        网站地址
        <input
          type="url"
          value={site}
          placeholder="https://github.com"
          disabled={busy || pending}
          onChange={(event) => {
            setSite(event.target.value);
            setMessage('');
          }}
        />
      </label>
      <button
        className="secondary"
        type="button"
        disabled={busy || pending || !site.trim()}
        onClick={(event) => {
          if (event.nativeEvent.isTrusted) enable(site);
        }}
      >
        授权此网站
      </button>
      <p className="field-help">授权按主机生效，覆盖所有页面路径和端口；其他子域名需单独启用。</p>
      <ul className="permission-list">
        {sites.map((item) => (
          <li key={item.origin}>
            <span>
              <code>{item.origin}</code>
              <small>{item.active ? '入口已启用' : '入口未就绪，请停用后重试'}</small>
            </span>
            <button
              className="text-button"
              type="button"
              disabled={busy || pending}
              aria-label={`停用 ${item.origin}`}
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) void disable(item.origin);
              }}
            >
              停用入口
            </button>
          </li>
        ))}
      </ul>
      {message && (
        <p role="note" className="notice">
          {message}
        </p>
      )}
    </section>
  );
}
