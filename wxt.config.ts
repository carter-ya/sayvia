import { defineConfig } from 'wxt';
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
    description: '在网页中阅读与表达，让语言不再成为障碍。',
    minimum_chrome_version: '116',
    permissions: ['storage', 'offscreen'],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    incognito: 'not_allowed',
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; worker-src 'self'",
    },
  },
});
