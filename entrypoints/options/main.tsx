import { createRoot } from 'react-dom/client';
import '../../src/ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <main className="settings">
    <a className="wordmark" href="./popup.html">
      Sayvia
    </a>
    <h1>模型设置</h1>
    <p>配置你的翻译服务，开始跨语言阅读与表达。</p>
    <p className="muted">暂未配置翻译服务。</p>
  </main>,
);
