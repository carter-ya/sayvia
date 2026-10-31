import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

export function BootstrapScreen() {
  const [version, setVersion] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [pageStatus, setPageStatus] = useState('');
  const [busy, setBusy] = useState(false);
  async function openPage(mode: 'read' | 'write') {
    if (busy) return;
    setBusy(true);
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) throw new Error('NO_TAB');
      const response = (await browser.runtime.sendMessage({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        type: 'page.open',
        payload: { tabId: tab.id, mode },
      })) as { ok?: boolean };
      if (!response?.ok) throw new Error('UNAVAILABLE');
      window.close();
    } catch {
      setPageStatus('当前页面无法打开翻译，请在普通网页中点击插件后重试。');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    void browser.runtime.sendMessage({ type: 'app.get-status' }).then(
      (result: unknown) => {
        if (
          active &&
          typeof result === 'object' &&
          result !== null &&
          'version' in result &&
          typeof result.version === 'string'
        ) {
          setVersion(result.version);
        }
      },
      () => {
        if (active) setUnavailable(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="popup">
      <div className="wordmark">Sayvia</div>
      <h1>用自己的语言，参与世界的讨论。</h1>
      <p>阅读、表达，从容跨越语言。</p>
      <p className="muted">在网页中先选中文字，或将光标放入评论框。</p>
      <div className="popup-actions">
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void openPage('read');
          }}
        >
          翻译网页选区
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) void openPage('write');
          }}
        >
          翻译当前输入
        </button>
      </div>
      {pageStatus && <p role="alert">{pageStatus}</p>}
      <button type="button" onClick={() => void browser.runtime.openOptionsPage()}>
        打开设置
      </button>
      <p className="version" role="status">
        {unavailable ? '连接暂不可用，请重新打开插件。' : version ? `版本 ${version}` : '正在连接…'}
      </p>
    </main>
  );
}
