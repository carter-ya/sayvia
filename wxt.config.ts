import { defineConfig } from 'wxt';
import { EXTENSION_PUBLIC_KEY } from './config/extension-identity';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  vite: () => ({
    resolve: {
      alias: {
        // The default export uses a character table; the browser export requires document.
        'decode-named-character-reference': require.resolve('decode-named-character-reference'),
      },
    },
  }),
  manifest: {
    name: 'Sayvia',
    key: EXTENSION_PUBLIC_KEY,
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Sayvia',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    description: '在网页中阅读与表达，让语言不再成为障碍。',
    minimum_chrome_version: '116',
    permissions: [
      'storage',
      'offscreen',
      'activeTab',
      'scripting',
      'clipboardWrite',
      'contextMenus',
      'tts',
      'alarms',
    ],
    host_permissions: ['https://*/*', 'http://*/*'],
    commands: {
      'translate-selection': {
        suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
        description: 'Sayvia：翻译当前正文选区',
      },
      'translate-editor': { description: 'Sayvia：打开当前编辑框翻译' },
    },
    incognito: 'not_allowed',
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; worker-src 'self'",
    },
  },
});
