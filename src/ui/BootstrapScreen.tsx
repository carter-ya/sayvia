import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';

export function BootstrapScreen() {
  const [version, setVersion] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);

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
      <p className="muted">翻译功能即将开放。</p>
      <button type="button" onClick={() => void browser.runtime.openOptionsPage()}>
        打开设置
      </button>
      <p className="version" role="status">
        {unavailable ? '连接暂不可用，请重新打开插件。' : version ? `版本 ${version}` : '正在连接…'}
      </p>
    </main>
  );
}
