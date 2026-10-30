import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Sayvia',
    description: '在网页中阅读与表达，让语言不再成为障碍。',
    minimum_chrome_version: '116',
    permissions: ['storage'],
    incognito: 'not_allowed',
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; worker-src 'self'",
    },
  },
});
